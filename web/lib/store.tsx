import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  BurnMode,
  CallKind,
  Community,
  Conversation,
  PostPolicy,
  PublicUser,
  ServerFrame,
} from "../../shared/protocol.ts";
import { TYPING_TTL_MS } from "../../shared/protocol.ts";
import { createApi, ApiError, type ConversationPatchInput } from "./api.ts";
import { createSocket, type Socket } from "./socket.ts";
import { decodeBody, encodeBody, type MessageBody } from "./envelope.ts";
import { initialState, reducer, type CipherState, type LocalMessage, type Tab } from "./reducer.ts";
import { createPeer, type CallPeer, type SignalMessage } from "./webrtc.ts";
import {
  exportPublicKey,
  generateConversationKey,
  generateIdentity,
  importPublicKey,
  newKeySalt,
  openAttachment,
  openMessage,
  openSignal,
  sealAttachment,
  sealMessage,
  sealSignal,
  unwrapConversationKey,
  unwrapPrivateKey,
  wrapConversationKey,
  wrapPrivateKey,
} from "./crypto.ts";

const STORAGE_KEY = "cipher.session";
/** How often the client drops messages whose countdown reached zero. */
const PURGE_INTERVAL_MS = 1_000;

type AuthStatus = "anonymous" | "locked" | "ready";

/**
 * What survives a reload: the session token and the *wrapped* identity key. The
 * unwrapped key is memory-only, which is why reopening the app asks for the password.
 */
type StoredSession = {
  token: string;
  user: PublicUser;
  wrappedPrivateKey: string;
  keySalt: string;
};

type SendOptions = {
  text: string;
  ttlSeconds: number;
  burnMode: BurnMode;
  replyToId: string | null;
  file: File | null;
};

type OpenedAttachment = {
  url: string;
  name: string;
  mime: string;
};

/** Everything the call UI needs that is not already on `state.activeCall`. */
type CallMedia = {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connection: RTCPeerConnectionState;
  muted: boolean;
  cameraOff: boolean;
};

const idleCallMedia: CallMedia = {
  localStream: null,
  remoteStream: null,
  connection: "new",
  muted: false,
  cameraOff: false,
};

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.wrappedPrivateKey !== "string" ||
      typeof parsed.keySalt !== "string" ||
      typeof parsed.user !== "object" ||
      parsed.user === null
    ) {
      return null;
    }
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "OperationError") return "Incorrect password.";
  return error instanceof Error ? error.message : "Something went wrong.";
}

type CipherContextValue = {
  status: AuthStatus;
  user: PublicUser | null;
  state: CipherState;
  busy: boolean;
  authError: string | null;
  activeConversation: Conversation | null;
  register: (username: string, displayName: string, password: string) => Promise<void>;
  signIn: (username: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  forgetSession: () => void;
  openConversation: (conversationId: string) => void;
  closeConversation: () => void;
  setTab: (tab: Tab) => void;
  createCommunity: (name: string, description: string, maxTtlSeconds: number) => Promise<void>;
  updateCommunity: (communityId: string, patch: { name?: string; maxTtlSeconds?: number }) => Promise<void>;
  addCommunityMember: (communityId: string, peer: PublicUser) => Promise<void>;
  leaveCommunity: (communityId: string) => Promise<void>;
  createChannel: (community: Community, name: string, postPolicy: PostPolicy) => Promise<void>;
  callMedia: CallMedia;
  startCall: (conversationId: string, kind: CallKind) => void;
  acceptCall: () => void;
  declineCall: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  loadOlder: (conversationId: string) => Promise<void>;
  send: (options: SendOptions) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  burn: (messageId: string) => Promise<void>;
  startDm: (peer: PublicUser) => Promise<void>;
  startGroup: (name: string, peers: PublicUser[]) => Promise<void>;
  addMember: (conversationId: string, peer: PublicUser) => Promise<void>;
  leave: (conversationId: string) => Promise<void>;
  updateConversation: (conversationId: string, patch: ConversationPatchInput) => Promise<void>;
  notifyTyping: (conversationId: string) => void;
  openAttachmentFor: (messageId: string) => Promise<OpenedAttachment | null>;
  searchDirectory: (query: string) => Promise<PublicUser[]>;
  dismissNotice: () => void;
};

const CipherContext = createContext<CipherContextValue | null>(null);

export function CipherProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [stored, setStored] = useState<StoredSession | null>(readStoredSession);
  const [status, setStatus] = useState<AuthStatus>(() => (readStoredSession() === null ? "anonymous" : "locked"));
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  /** The unwrapped identity key. Memory only, by design. */
  const identity = useRef<CryptoKey | null>(null);
  const conversationKeys = useRef(new Map<string, CryptoKey>());
  const decrypting = useRef(new Set<string>());
  const acknowledged = useRef(new Set<string>());
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<CallPeer | null>(null);
  /** Lets the socket frame handler reach the newest signal handler without re-subscribing. */
  const handleSignalRef = useRef<(callId: string, fromUserId: string, payload: string, iv: string) => Promise<void>>(
    async () => undefined,
  );
  const iceServers = useRef<string[]>([]);
  const [callMedia, setCallMedia] = useState<CallMedia>(idleCallMedia);

  /**
   * Mirrors the latest state for callbacks that must read it without being rebuilt on
   * every change. Written in an effect, never during render.
   */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const token = stored?.token ?? null;
  // Rebuilt when the token changes, so requests always carry the live session.
  const api = useMemo(() => createApi(() => token), [token]);

  const persist = useCallback((session: StoredSession | null) => {
    setStored(session);
    if (session === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, []);

  const resetLocalSecrets = useCallback(() => {
    identity.current = null;
    conversationKeys.current.clear();
    decrypting.current.clear();
    acknowledged.current.clear();
    // Signing out has to stop the camera and microphone too; leaving capture running
    // after the keys are gone would be exactly the wrong failure for this product.
    peerRef.current?.close();
    peerRef.current = null;
    setCallMedia(idleCallMedia);
  }, []);

  // Closing the tab or unmounting the provider releases capture devices as well.
  useEffect(
    () => () => {
      peerRef.current?.close();
      peerRef.current = null;
    },
    [],
  );

  // --- key access ------------------------------------------------------------------

  const conversationKey = useCallback(async (conversation: Conversation): Promise<CryptoKey> => {
    const cached = conversationKeys.current.get(conversation.id);
    if (cached !== undefined) return cached;

    const privateKey = identity.current;
    if (privateKey === null) throw new Error("Identity key is locked");

    const key = await unwrapConversationKey(
      conversation.wrappedKey,
      privateKey,
      await importPublicKey(conversation.wrappedByPublicKey),
    );
    conversationKeys.current.set(conversation.id, key);
    return key;
  }, []);

  // --- realtime --------------------------------------------------------------------

  const handleFrame = useCallback((frame: ServerFrame) => {
    switch (frame.type) {
      case "message.new":
        dispatch({ type: "message", message: frame.message });
        break;
      case "message.expired":
        dispatch({ type: "message/expired", conversationId: frame.conversationId, messageIds: frame.messageIds });
        break;
      case "message.read":
        dispatch({
          type: "message/read",
          conversationId: frame.conversationId,
          messageId: frame.messageId,
          expiresAt: frame.expiresAt,
        });
        break;
      case "reaction.new":
        dispatch({
          type: "message/reactions",
          conversationId: frame.conversationId,
          messageId: frame.messageId,
          reactions: frame.reactions,
        });
        break;
      case "conversation.new":
      case "conversation.updated":
        dispatch({ type: "conversation", conversation: frame.conversation });
        break;
      case "typing":
        dispatch({
          type: "typing",
          conversationId: frame.conversationId,
          userId: frame.userId,
          until: Date.now() + TYPING_TTL_MS,
        });
        break;
      case "community.updated":
        dispatch({ type: "community", community: frame.community });
        break;
      case "call.incoming":
      case "call.updated":
        dispatch({ type: "call", call: frame.call });
        break;
      case "call.signal":
        void handleSignalRef.current(frame.callId, frame.fromUserId, frame.payload, frame.iv);
        break;
      case "presence":
        dispatch({
          type: "presence",
          userId: frame.userId,
          state: frame.state,
          lastSeenAt: frame.lastSeenAt,
        });
        break;
      case "ready":
      case "pong":
      case "error":
        break;
    }
  }, []);

  useEffect(() => {
    if (status !== "ready" || token === null) return undefined;

    const socket = createSocket(() => token, {
      onFrame: handleFrame,
      onState: (connection) => dispatch({ type: "connection", state: connection }),
      onClockOffset: (offsetMs) => dispatch({ type: "clock", offsetMs }),
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [status, token, handleFrame]);

  // --- authentication --------------------------------------------------------------

  /**
   * Loads every section for a freshly authenticated session.
   *
   * Takes the token explicitly rather than reusing the memoized client: sign-in sets
   * the session with `setStored`, which does not apply until the next render, so the
   * memoized client would still be carrying the previous token on this tick.
   */
  const bootstrap = useCallback(async (authToken: string) => {
    const client = createApi(() => authToken);
    const [conversations, communities, calls, health] = await Promise.all([
      client.conversations(),
      client.communities(),
      client.calls(),
      client.health().catch(() => null),
    ]);
    dispatch({ type: "conversations", conversations });
    dispatch({ type: "communities", communities });
    dispatch({ type: "calls", calls });
    iceServers.current = health?.iceServers ?? [];
    if (health !== null) dispatch({ type: "policy", maxTtlSeconds: health.maxTtlSeconds });
  }, []);

  const register = useCallback(
    async (username: string, displayName: string, password: string) => {
      setBusy(true);
      setAuthError(null);
      try {
        const keys = await generateIdentity();
        const keySalt = newKeySalt();
        const session = await api.register({
          username,
          displayName,
          password,
          publicKey: await exportPublicKey(keys.publicKey),
          wrappedPrivateKey: await wrapPrivateKey(keys.privateKey, password, keySalt),
          keySalt,
        });

        identity.current = keys.privateKey;
        persist({
          token: session.token,
          user: session.user,
          wrappedPrivateKey: session.wrappedPrivateKey,
          keySalt: session.keySalt,
        });
        setStatus("ready");
        await bootstrap(session.token);
      } catch (error) {
        setAuthError(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [api, bootstrap, persist],
  );

  const signIn = useCallback(
    async (username: string, password: string) => {
      setBusy(true);
      setAuthError(null);
      try {
        const session = await api.login(username, password);
        identity.current = await unwrapPrivateKey(session.wrappedPrivateKey, password, session.keySalt);
        persist({
          token: session.token,
          user: session.user,
          wrappedPrivateKey: session.wrappedPrivateKey,
          keySalt: session.keySalt,
        });
        setStatus("ready");
        await bootstrap(session.token);
      } catch (error) {
        setAuthError(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [api, bootstrap, persist],
  );

  const unlock = useCallback(
    async (password: string) => {
      if (stored === null) return;
      setBusy(true);
      setAuthError(null);
      try {
        identity.current = await unwrapPrivateKey(stored.wrappedPrivateKey, password, stored.keySalt);
        // Confirms the stored token is still valid before trusting the unlocked state.
        await api.me();
        setStatus("ready");
        await bootstrap(stored.token);
      } catch (error) {
        resetLocalSecrets();
        if (error instanceof ApiError && error.status === 401) {
          persist(null);
          setStatus("anonymous");
          setAuthError("That session expired. Sign in again.");
        } else {
          setAuthError(describeError(error));
        }
      } finally {
        setBusy(false);
      }
    },
    [api, bootstrap, persist, resetLocalSecrets, stored],
  );

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    resetLocalSecrets();
    persist(null);
    setStatus("anonymous");
    dispatch({ type: "conversations", conversations: [] });
    dispatch({ type: "active", conversationId: null });
  }, [api, persist, resetLocalSecrets]);

  const forgetSession = useCallback(() => {
    resetLocalSecrets();
    persist(null);
    setStatus("anonymous");
    setAuthError(null);
  }, [persist, resetLocalSecrets]);

  // --- conversations ---------------------------------------------------------------

  const openConversation = useCallback(
    (conversationId: string) => {
      dispatch({ type: "active", conversationId });
      void api.markConversationRead(conversationId).catch(() => undefined);
      void api
        .messages(conversationId, null)
        .then((page) =>
          dispatch({
            type: "history",
            conversationId,
            messages: page.messages,
            nextCursor: page.nextCursor,
          }),
        )
        .catch((error: unknown) => dispatch({ type: "notice", message: describeError(error) }));
    },
    [api],
  );

  const closeConversation = useCallback(() => dispatch({ type: "active", conversationId: null }), []);

  const loadOlder = useCallback(
    async (conversationId: string) => {
      const cursor = stateRef.current.cursors[conversationId];
      if (cursor === null || cursor === undefined) return;

      const page = await api.messages(conversationId, cursor);
      dispatch({
        type: "history/older",
        conversationId,
        messages: page.messages,
        nextCursor: page.nextCursor,
      });
    },
    [api],
  );

  const createConversation = useCallback(
    async (kind: "dm" | "group", name: string | null, peers: PublicUser[]) => {
      const privateKey = identity.current;
      const self = stored?.user;
      if (privateKey === null || self === undefined) throw new Error("Identity key is locked");

      const key = await generateConversationKey();
      const everyone = [{ id: self.id, publicKey: self.publicKey }, ...peers];
      const keys = await Promise.all(
        everyone.map(async (member) => ({
          userId: member.id,
          wrappedKey: await wrapConversationKey(key, privateKey, await importPublicKey(member.publicKey)),
        })),
      );

      const conversation = await api.createConversation({
        kind,
        ...(name === null ? {} : { name }),
        keys,
        defaultTtlSeconds: 3_600,
        defaultBurnMode: "absolute",
      });

      // Deliberately not cached here. Creating a DM is idempotent, so the server may
      // return a conversation that already existed — with its original key, not the one
      // just generated. The authoritative wrapped key is unwrapped lazily instead.
      dispatch({ type: "conversation", conversation });
      openConversation(conversation.id);
    },
    [api, openConversation, stored],
  );

  const startDm = useCallback(
    async (peer: PublicUser) => {
      const existing = stateRef.current.conversations.find(
        (conversation) =>
          conversation.kind === "dm" && conversation.members.some((member) => member.id === peer.id),
      );
      if (existing !== undefined) {
        openConversation(existing.id);
        return;
      }
      await createConversation("dm", null, [peer]);
    },
    [createConversation, openConversation],
  );

  const startGroup = useCallback(
    async (name: string, peers: PublicUser[]) => {
      await createConversation("group", name, peers);
    },
    [createConversation],
  );

  const addMember = useCallback(
    async (conversationId: string, peer: PublicUser) => {
      const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
      const privateKey = identity.current;
      if (conversation === undefined || privateKey === null) return;

      const key = await conversationKey(conversation);
      const wrappedKey = await wrapConversationKey(key, privateKey, await importPublicKey(peer.publicKey));
      const updated = await api.addMember(conversationId, { userId: peer.id, wrappedKey });
      dispatch({ type: "conversation", conversation: updated });
    },
    [api, conversationKey],
  );

  const leave = useCallback(
    async (conversationId: string) => {
      const self = stored?.user;
      if (self === undefined) return;

      await api.leaveConversation(conversationId, self.id);
      conversationKeys.current.delete(conversationId);
      dispatch({ type: "conversation/remove", conversationId });
    },
    [api, stored],
  );

  const updateConversation = useCallback(
    async (conversationId: string, patch: ConversationPatchInput) => {
      const updated = await api.patchConversation(conversationId, patch);
      dispatch({ type: "conversation", conversation: updated });
    },
    [api],
  );

  // --- sending ---------------------------------------------------------------------

  const send = useCallback(
    async ({ text, ttlSeconds, burnMode, replyToId, file }: SendOptions) => {
      const conversationId = stateRef.current.activeId;
      const self = stored?.user;
      if (conversationId === null || self === undefined) return;

      const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
      if (conversation === undefined) return;

      const pendingId = `pending:${crypto.randomUUID()}`;
      let body: MessageBody = { text, attachment: null };

      try {
        const key = await conversationKey(conversation);

        let mediaId: string | null = null;
        if (file !== null) {
          const sealedFile = await sealAttachment(new Uint8Array(await file.arrayBuffer()));
          const upload = await api.uploadMedia(sealedFile.bytes);
          mediaId = upload.id;
          body = {
            text,
            attachment: {
              mediaId: upload.id,
              key: sealedFile.key,
              iv: sealedFile.iv,
              name: file.name,
              mime: file.type === "" ? "application/octet-stream" : file.type,
              size: file.size,
            },
          };
        }

        // Shown immediately with the plaintext already known locally.
        const optimistic: LocalMessage = {
          id: pendingId,
          conversationId,
          senderId: self.id,
          ciphertext: "",
          iv: "",
          mediaId,
          replyToId,
          ttlSeconds,
          burnMode,
          sentAt: Date.now() + stateRef.current.clockOffsetMs,
          expiresAt: burnMode === "absolute" ? Date.now() + ttlSeconds * 1_000 : null,
          firstReadAt: null,
          reactions: [],
          readBy: 0,
          pending: true,
        };
        dispatch({ type: "message/pending", message: optimistic });
        dispatch({ type: "body", messageId: pendingId, body });

        const sealed = await sealMessage(key, encodeBody(body), {
          conversationId,
          senderId: self.id,
          ttlSeconds,
        });

        const message = await api.sendMessage(conversationId, {
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          mediaId,
          replyToId,
          ttlSeconds,
          burnMode,
        });
        dispatch({ type: "message/confirm", pendingId, message });
      } catch (error) {
        dispatch({ type: "message/fail", pendingId });
        dispatch({ type: "notice", message: describeError(error) });
      }
    },
    [api, conversationKey, stored],
  );

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      await api.react(messageId, emoji).catch(() => undefined);
    },
    [api],
  );

  const burn = useCallback(
    async (messageId: string) => {
      await api.burnMessage(messageId).catch((error: unknown) => {
        dispatch({ type: "notice", message: describeError(error) });
      });
    },
    [api],
  );

  const notifyTyping = useCallback((conversationId: string) => {
    socketRef.current?.send({ type: "typing", conversationId });
  }, []);

  const openAttachmentFor = useCallback(
    async (messageId: string): Promise<OpenedAttachment | null> => {
      const body = stateRef.current.bodies[messageId];
      if (body?.attachment == null) return null;

      const { mediaId, key, iv, name, mime } = body.attachment;
      const sealedBytes = await api.downloadMedia(mediaId);
      const bytes = await openAttachment(sealedBytes, key, iv);
      return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), name, mime };
    },
    [api],
  );

  const searchDirectory = useCallback((query: string) => api.directory(query), [api]);

  const dismissNotice = useCallback(() => dispatch({ type: "notice", message: null }), []);


  // --- calls -----------------------------------------------------------------------

  /**
   * Signals are relayed through the server but sealed under the conversation key, so
   * the SDP and ICE candidates — which carry network addresses — stay unreadable to it.
   */
  const sendSignal = useCallback(
    async (callId: string, conversationId: string, signal: SignalMessage) => {
      const self = stored?.user;
      const conversation = stateRef.current.conversations.find((item) => item.id === conversationId);
      if (self === undefined || conversation === undefined) return;

      const key = await conversationKey(conversation);
      const sealed = await sealSignal(key, signal, { callId, senderId: self.id });
      socketRef.current?.send({ type: "call.signal", callId, payload: sealed.ciphertext, iv: sealed.iv });
    },
    [conversationKey, stored],
  );

  const teardownCall = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    setCallMedia(idleCallMedia);
  }, []);

  /** Builds the peer connection for a call and starts capturing local media. */
  const openPeer = useCallback(
    async (callId: string, conversationId: string, kind: CallKind, polite: boolean) => {
      const peer = createPeer(iceServers.current, {
        onSignal: (signal) => void sendSignal(callId, conversationId, signal),
        onRemoteStream: (remoteStream) => setCallMedia((current) => ({ ...current, remoteStream })),
        onConnectionState: (connection) => setCallMedia((current) => ({ ...current, connection })),
      });
      peerRef.current = peer;

      try {
        const localStream = await peer.open(kind, polite);
        setCallMedia((current) => ({ ...current, localStream }));
      } catch {
        // No microphone or camera, or permission refused. The call cannot proceed, and
        // the overlay is about to close — so the reason goes to the notice toast, which
        // outlives it. Silently dropping the call would leave no explanation at all.
        const reason =
          kind === "video"
            ? "Cipher could not reach your camera or microphone, so the call ended."
            : "Cipher could not reach your microphone, so the call ended.";
        dispatch({ type: "notice", message: reason });
        socketRef.current?.send({ type: "call.end", callId });
        teardownCall();
      }
    },
    [sendSignal, teardownCall],
  );

  const handleSignal = useCallback(
    async (callId: string, fromUserId: string, payload: string, iv: string) => {
      const active = stateRef.current.activeCall;
      const peer = peerRef.current;
      if (active === null || active.id !== callId || peer === null) return;

      const conversation = stateRef.current.conversations.find((item) => item.id === active.conversationId);
      if (conversation === undefined) return;

      try {
        const key = await conversationKey(conversation);
        const signal = (await openSignal(key, { ciphertext: payload, iv }, { callId, senderId: fromUserId })) as
          | SignalMessage
          | null;
        if (signal !== null) await peer.accept(signal);
      } catch {
        // An unreadable or out-of-order signal is dropped; renegotiation recovers.
      }
    },
    [conversationKey],
  );

  // Published to the ref in an effect, never during render, so the socket's frame
  // handler always calls the newest closure without resubscribing.
  useEffect(() => {
    handleSignalRef.current = handleSignal;
  }, [handleSignal]);

  const startCall = useCallback((conversationId: string, kind: CallKind) => {
    socketRef.current?.send({ type: "call.invite", conversationId, kind });
  }, []);

  const acceptCall = useCallback(() => {
    const active = stateRef.current.activeCall;
    if (active === null) return;
    socketRef.current?.send({ type: "call.accept", callId: active.id });
  }, []);

  const declineCall = useCallback(() => {
    const active = stateRef.current.activeCall;
    if (active === null) return;
    socketRef.current?.send({ type: "call.decline", callId: active.id });
    teardownCall();
  }, [teardownCall]);

  const hangUp = useCallback(() => {
    const active = stateRef.current.activeCall;
    if (active !== null) socketRef.current?.send({ type: "call.end", callId: active.id });
    teardownCall();
  }, [teardownCall]);

  const toggleMute = useCallback(() => {
    setCallMedia((current) => {
      const muted = !current.muted;
      peerRef.current?.setMuted(muted);
      return { ...current, muted };
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCallMedia((current) => {
      const cameraOff = !current.cameraOff;
      peerRef.current?.setCameraOff(cameraOff);
      return { ...current, cameraOff };
    });
  }, []);

  // --- communities -----------------------------------------------------------------

  const createCommunity = useCallback(
    async (name: string, description: string, maxTtlSeconds: number) => {
      const community = await api.createCommunity({ name, description, maxTtlSeconds });
      dispatch({ type: "community", community });
    },
    [api],
  );

  const updateCommunity = useCallback(
    async (communityId: string, patch: { name?: string; maxTtlSeconds?: number }) => {
      const community = await api.patchCommunity(communityId, patch);
      dispatch({ type: "community", community });
    },
    [api],
  );

  /**
   * Adds someone to a community and hands them the key to each existing channel the
   * caller can open. Without the second step they would join a community and see
   * nothing, since a channel key is wrapped per member at creation time.
   *
   * They gain the history in those channels that has not yet expired — the same trade
   * as adding a member to any group.
   */
  const addCommunityMember = useCallback(
    async (communityId: string, peer: PublicUser) => {
      const existing = stateRef.current.communities.find((item) => item.id === communityId);
      const privateKey = identity.current;

      let community = await api.addCommunityMember(communityId, peer.id, "member");

      if (existing !== undefined && privateKey !== null) {
        let granted = false;

        // Granting is best-effort and never undoes the join: an unusable peer key or a
        // channel this admin cannot open leaves the membership standing.
        try {
          const peerPublicKey = await importPublicKey(peer.publicKey);

          for (const channel of existing.channels) {
            try {
              const key = await conversationKey(channel);
              const wrappedKey = await wrapConversationKey(key, privateKey, peerPublicKey);
              await api.addMember(channel.id, { userId: peer.id, wrappedKey });
              granted = true;
            } catch {
              // A channel this admin cannot open, or one they do not administer.
            }
          }
        } catch {
          // The peer's published key could not be imported, so no channel can be
          // wrapped for them. They are in the community; channels stay closed.
        }

        if (granted) {
          const refreshed = await api.communities();
          community = refreshed.find((item) => item.id === communityId) ?? community;
          dispatch({ type: "communities", communities: refreshed });
          const conversations = await api.conversations();
          dispatch({ type: "conversations", conversations });
        }
      }

      dispatch({ type: "community", community });
    },
    [api, conversationKey],
  );

  const leaveCommunity = useCallback(
    async (communityId: string) => {
      const self = stored?.user;
      if (self === undefined) return;
      await api.leaveCommunity(communityId, self.id);
      dispatch({ type: "community/remove", communityId });
    },
    [api, stored],
  );

  /**
   * Creates a channel. Every community member gets the channel key wrapped for them,
   * which is why this needs their public keys rather than just their ids.
   */
  const createChannel = useCallback(
    async (community: Community, name: string, postPolicy: PostPolicy) => {
      const privateKey = identity.current;
      const self = stored?.user;
      if (privateKey === null || self === undefined) return;

      // Every community member gets the channel key wrapped for them, so joining the
      // community is what grants access rather than a separate invitation per channel.
      const key = await generateConversationKey();
      const keys = await Promise.all(
        community.members.map(async (member) => ({
          userId: member.id,
          wrappedKey: await wrapConversationKey(key, privateKey, await importPublicKey(member.publicKey)),
        })),
      );

      const channel = await api.createChannel(community.id, {
        name,
        postPolicy,
        keys,
        defaultTtlSeconds: community.maxTtlSeconds,
        defaultBurnMode: "absolute",
      });

      dispatch({ type: "conversation", conversation: channel });
      const refreshed = await api.communities();
      dispatch({ type: "communities", communities: refreshed });
    },
    [api, stored],
  );

  const setTab = useCallback((tab: Tab) => dispatch({ type: "tab", tab }), []);

  /**
   * Both parties build their peer connection when the call turns active, so neither
   * sends an offer to someone who has not answered yet. The caller is the impolite
   * side of perfect negotiation.
   */
  useEffect(() => {
    const call = state.activeCall;
    const self = stored?.user;

    if (call === null || self === undefined) {
      if (peerRef.current !== null) teardownCall();
      return;
    }
    if (call.status !== "active" || peerRef.current !== null) return;

    void openPeer(call.id, call.conversationId, call.kind, call.initiatorId !== self.id);
  }, [openPeer, state.activeCall, stored, teardownCall]);

  // --- decryption, receipts, and local purge ---------------------------------------

  useEffect(() => {
    if (status !== "ready") return;

    const conversationId = state.activeId;
    if (conversationId === null) return;

    const conversation = state.conversations.find((item) => item.id === conversationId);
    const pending = (state.messages[conversationId] ?? []).filter(
      (message) => !message.pending && state.bodies[message.id] === undefined && !decrypting.current.has(message.id),
    );
    if (conversation === undefined || pending.length === 0) return;

    for (const message of pending) decrypting.current.add(message.id);

    void (async () => {
      const key = await conversationKey(conversation).catch(() => null);
      if (key === null) return;

      for (const message of pending) {
        try {
          const raw = await openMessage(
            key,
            { ciphertext: message.ciphertext, iv: message.iv },
            {
              conversationId: message.conversationId,
              senderId: message.senderId,
              ttlSeconds: message.ttlSeconds,
            },
          );
          dispatch({ type: "body", messageId: message.id, body: decodeBody(raw) });

          // Decrypted and on screen is what "read" means, and it is what starts an
          // on-read burn — so it is acknowledged explicitly, once.
          if (message.senderId !== stored?.user.id && !acknowledged.current.has(message.id)) {
            acknowledged.current.add(message.id);
            void api.markMessageRead(message.id).catch(() => undefined);
          }
        } catch {
          dispatch({
            type: "body",
            messageId: message.id,
            body: { text: "", attachment: null },
          });
        } finally {
          decrypting.current.delete(message.id);
        }
      }
    })();
  }, [api, conversationKey, state.activeId, state.bodies, state.conversations, state.messages, status, stored]);

  useEffect(() => {
    if (status !== "ready") return undefined;

    const timer = window.setInterval(() => {
      const current = stateRef.current;
      const serverNow = Date.now() + current.clockOffsetMs;

      for (const [conversationId, messages] of Object.entries(current.messages)) {
        const expired = messages
          .filter((message) => message.expiresAt !== null && message.expiresAt <= serverNow)
          .map((message) => message.id);
        if (expired.length === 0) continue;
        for (const id of expired) acknowledged.current.delete(id);
        dispatch({ type: "message/expired", conversationId, messageIds: expired });
      }
      dispatch({ type: "typing/sweep", at: Date.now() });
      // Call records burn on the server; drop them locally on the same schedule.
      dispatch({ type: "call/expire", at: serverNow });
    }, PURGE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [status]);

  const activeConversation = useMemo(
    () => state.conversations.find((item) => item.id === state.activeId) ?? null,
    [state.activeId, state.conversations],
  );

  const value = useMemo<CipherContextValue>(
    () => ({
      status,
      user: stored?.user ?? null,
      state,
      busy,
      authError,
      activeConversation,
      register,
      signIn,
      unlock,
      signOut,
      forgetSession,
      openConversation,
      closeConversation,
      setTab,
      createCommunity,
      updateCommunity,
      addCommunityMember,
      leaveCommunity,
      createChannel,
      callMedia,
      startCall,
      acceptCall,
      declineCall,
      hangUp,
      toggleMute,
      toggleCamera,
      loadOlder,
      send,
      toggleReaction,
      burn,
      startDm,
      startGroup,
      addMember,
      leave,
      updateConversation,
      notifyTyping,
      openAttachmentFor,
      searchDirectory,
      dismissNotice,
    }),
    [
      acceptCall,
      activeConversation,
      addCommunityMember,
      addMember,
      authError,
      burn,
      busy,
      callMedia,
      closeConversation,
      createChannel,
      createCommunity,
      declineCall,
      dismissNotice,
      hangUp,
      leaveCommunity,
      setTab,
      startCall,
      toggleCamera,
      toggleMute,
      updateCommunity,
      forgetSession,
      leave,
      loadOlder,
      notifyTyping,
      openAttachmentFor,
      openConversation,
      register,
      searchDirectory,
      send,
      signIn,
      signOut,
      startDm,
      startGroup,
      state,
      status,
      stored,
      toggleReaction,
      unlock,
      updateConversation,
    ],
  );

  return <CipherContext.Provider value={value}>{children}</CipherContext.Provider>;
}

export function useCipher(): CipherContextValue {
  const value = useContext(CipherContext);
  if (value === null) throw new Error("useCipher must be used inside CipherProvider");
  return value;
}
