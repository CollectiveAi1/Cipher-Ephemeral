import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Call, CallKind, Message, PresenceState, Reaction, ServerFrame } from "../../shared/protocol.ts";
import {
  CALL_KINDS,
  CALL_RING_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_SIGNAL_BYTES,
  TYPING_TTL_MS,
} from "../../shared/protocol.ts";
import type { Store } from "../store.ts";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { monotonicMs, now } from "../core/time.ts";
import { hashToken, verifyToken } from "../core/tokens.ts";

/** Window in which an unauthenticated socket must send its `auth` frame. */
const AUTH_GRACE_MS = 10_000;

type Connection = {
  socket: WebSocket;
  userId: string | null;
  lastSeenMonotonic: number;
  lastTypingByConversation: Map<string, number>;
};

export function createHub(store: Store) {
  const connections = new Map<WebSocket, Connection>();
  /** userId -> live sockets, so one account can hold several tabs or devices. */
  const byUser = new Map<string, Set<WebSocket>>();
  /** Calls still ringing, so an unanswered one can be closed out as missed. */
  const ringTimers = new Map<string, NodeJS.Timeout>();
  /** userId -> calls they are party to, so dropping offline can end them. */
  const callsByUser = new Map<string, Set<string>>();

  const send = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  const presenceOf = (userId: string): PresenceState => (byUser.has(userId) ? "online" : "offline");

  /** Sends a frame to every live socket of each listed user. Returns who was reached. */
  const fanOut = (userIds: Iterable<string>, frame: ServerFrame): string[] => {
    const reached: string[] = [];
    for (const userId of userIds) {
      const sockets = byUser.get(userId);
      if (sockets === undefined) continue;
      for (const socket of sockets) send(socket, frame);
      reached.push(userId);
    }
    return reached;
  };

  const announcePresence = (userId: string, state: PresenceState) => {
    let lastSeenAt: number | null = null;
    if (state === "offline") {
      lastSeenAt = now();
      store.users.touchLastSeen(userId, lastSeenAt);
    }
    fanOut(store.conversations.peerIds(userId), { type: "presence", userId, state, lastSeenAt });
  };

  const bind = (socket: WebSocket, userId: string) => {
    const connection = connections.get(socket);
    if (connection === undefined) return;

    connection.userId = userId;
    const existing = byUser.get(userId);
    if (existing === undefined) {
      byUser.set(userId, new Set([socket]));
      announcePresence(userId, "online");
    } else {
      existing.add(socket);
    }
    send(socket, { type: "ready", userId, serverTime: now() });
  };

  const release = (socket: WebSocket) => {
    const connection = connections.get(socket);
    connections.delete(socket);
    if (connection?.userId == null) return;

    const sockets = byUser.get(connection.userId);
    sockets?.delete(socket);
    if (sockets === undefined || sockets.size > 0) return;

    byUser.delete(connection.userId);

    // Losing every socket ends any call this user was in; the peer should not be left
    // listening to a connection that is never coming back. Copied first, because
    // settling a call mutates the very set being walked.
    for (const callId of [...(callsByUser.get(connection.userId) ?? [])]) settleCall(callId, "missed");
    // Settling cannot clean up a record that already burned, so drop the account's
    // tracking outright rather than leaving an entry nothing will ever remove.
    callsByUser.delete(connection.userId);

    announcePresence(connection.userId, "offline");
  };

  const trackCall = (call: Call) => {
    for (const participant of call.participants) {
      const existing = callsByUser.get(participant.userId);
      if (existing === undefined) callsByUser.set(participant.userId, new Set([call.id]));
      else existing.add(call.id);
    }
  };

  const untrackCall = (call: Call) => {
    for (const participant of call.participants) {
      const existing = callsByUser.get(participant.userId);
      existing?.delete(call.id);
      if (existing !== undefined && existing.size === 0) callsByUser.delete(participant.userId);
    }
    const timer = ringTimers.get(call.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      ringTimers.delete(call.id);
    }
  };

  const publishCall = (call: Call, frame: "call.incoming" | "call.updated", to?: readonly string[]) => {
    const audience = to ?? call.participants.map((participant) => participant.userId);
    fanOut(audience, frame === "call.incoming" ? { type: "call.incoming", call } : { type: "call.updated", call });
  };

  /** Closes a call out and tells everyone who was party to it. */
  const settleCall = (callId: string, status: "ended" | "missed") => {
    const settled = store.calls.end(callId, status);
    if (settled === null) return;
    untrackCall(settled);
    publishCall(settled, "call.updated");
  };

  const startCall = (socket: WebSocket, userId: string, conversationId: string, kind: CallKind) => {
    if (store.conversations.roleOf(conversationId, userId) === null) {
      send(socket, { type: "error", code: "not_found", message: "Conversation not found" });
      return;
    }

    const memberIds = store.conversations.memberIds(conversationId);
    // One-to-one only for now: a mesh call needs per-peer connections that this
    // signalling path does not yet model, and a half-working group call is worse
    // than an honest "not yet".
    if (memberIds.length !== 2) {
      send(socket, { type: "error", code: "unsupported", message: "Calls are one-to-one for now" });
      return;
    }
    if (store.calls.activeIn(conversationId) !== null) {
      send(socket, { type: "error", code: "conflict", message: "A call is already in progress" });
      return;
    }

    const call = store.calls.start(conversationId, userId, kind, memberIds);
    trackCall(call);

    const peers = memberIds.filter((id) => id !== userId);
    publishCall(call, "call.incoming", peers);
    publishCall(call, "call.updated", [userId]);

    const timer = setTimeout(() => {
      ringTimers.delete(call.id);
      settleCall(call.id, "missed");
    }, CALL_RING_TIMEOUT_MS);
    timer.unref();
    ringTimers.set(call.id, timer);
  };

  /** Confirms the user is party to the call and that it is still live. */
  const callFor = (callId: string, userId: string): Call | null => {
    const call = store.calls.find(callId);
    if (call === null) return null;
    return call.participants.some((participant) => participant.userId === userId) ? call : null;
  };

  const handleFrame = (socket: WebSocket, raw: string) => {
    const connection = connections.get(socket);
    if (connection === undefined) return;

    let frame: {
      type?: unknown;
      token?: unknown;
      conversationId?: unknown;
      callId?: unknown;
      kind?: unknown;
      payload?: unknown;
      iv?: unknown;
    };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      send(socket, { type: "error", code: "bad_frame", message: "Frame was not valid JSON" });
      return;
    }

    connection.lastSeenMonotonic = monotonicMs();

    if (frame.type === "auth") {
      if (typeof frame.token !== "string") {
        send(socket, { type: "error", code: "bad_frame", message: "auth requires a token" });
        return;
      }
      const claims = verifyToken(frame.token);
      const userId = claims === null ? null : store.users.sessions.findUserId(hashToken(frame.token));
      if (userId === null) {
        send(socket, { type: "error", code: "unauthorized", message: "Token is not valid" });
        socket.close(4001, "unauthorized");
        return;
      }
      bind(socket, userId);
      return;
    }

    if (connection.userId === null) {
      send(socket, { type: "error", code: "unauthorized", message: "Send an auth frame first" });
      return;
    }

    if (frame.type === "ping") {
      send(socket, { type: "pong", serverTime: now() });
      return;
    }

    if (frame.type === "typing") {
      if (typeof frame.conversationId !== "string") return;
      if (store.conversations.roleOf(frame.conversationId, connection.userId) === null) return;

      // Throttled to one relay per TTL window, so a fast typist is not a broadcast
      // storm. "Never relayed" is absence, not zero — zero is a real timestamp early in
      // the process's life and would swallow the first indicator.
      const last = connection.lastTypingByConversation.get(frame.conversationId);
      const elapsed = monotonicMs();
      if (last !== undefined && elapsed - last < TYPING_TTL_MS / 2) return;
      connection.lastTypingByConversation.set(frame.conversationId, elapsed);

      const audience = store.conversations
        .memberIds(frame.conversationId)
        .filter((id) => id !== connection.userId);
      fanOut(audience, { type: "typing", conversationId: frame.conversationId, userId: connection.userId });
      return;
    }

    if (frame.type === "call.invite") {
      if (typeof frame.conversationId !== "string") return;
      const kind = CALL_KINDS.find((candidate) => candidate === frame.kind);
      if (kind === undefined) {
        send(socket, { type: "error", code: "bad_frame", message: "call.invite needs a kind" });
        return;
      }
      startCall(socket, connection.userId, frame.conversationId, kind);
      return;
    }

    if (
      frame.type === "call.accept" ||
      frame.type === "call.decline" ||
      frame.type === "call.end" ||
      frame.type === "call.signal"
    ) {
      if (typeof frame.callId !== "string") return;

      const call = callFor(frame.callId, connection.userId);
      if (call === null) {
        send(socket, { type: "error", code: "not_found", message: "Call not found" });
        return;
      }

      if (frame.type === "call.signal") {
        // Opaque relay: the payload is sealed under the conversation key, so the
        // server forwards network candidates it cannot read.
        if (typeof frame.payload !== "string" || typeof frame.iv !== "string") return;
        if (frame.payload.length > MAX_SIGNAL_BYTES) {
          send(socket, { type: "error", code: "payload_too_large", message: "Signal is too large" });
          return;
        }
        const peers = call.participants
          .map((participant) => participant.userId)
          .filter((userId) => userId !== connection.userId);
        fanOut(peers, {
          type: "call.signal",
          callId: call.id,
          fromUserId: connection.userId,
          payload: frame.payload,
          iv: frame.iv,
        });
        return;
      }

      if (frame.type === "call.accept") {
        const timer = ringTimers.get(call.id);
        if (timer !== undefined) {
          clearTimeout(timer);
          ringTimers.delete(call.id);
        }
        const answered = store.calls.answer(call.id, connection.userId);
        if (answered !== null) publishCall(answered, "call.updated");
        return;
      }

      if (frame.type === "call.decline") {
        const declined = store.calls.decline(call.id, connection.userId);
        if (declined !== null) {
          untrackCall(declined);
          publishCall(declined, "call.updated");
        }
        return;
      }

      store.calls.leave(call.id, connection.userId);
      settleCall(call.id, "missed");
      return;
    }

    send(socket, { type: "error", code: "unknown_frame", message: "Unsupported frame type" });
  };

  let heartbeat: NodeJS.Timeout | null = null;

  return {
    presenceOf,

    attach(server: Server): void {
      const wss = new WebSocketServer({
        server,
        path: "/ws",
        maxPayload: 64 * 1024,
        /**
         * Mirrors the HTTP allowlist. A socket carries no cookie — the token arrives in
         * the first frame — so this is not what stops hijacking; it is here so the
         * realtime surface is not broader than the one the API already permits.
         */
        verifyClient: ({ origin, req }: { origin: string | undefined; req: IncomingMessage }) => {
          if (env.allowedOrigins.length === 0) return true;
          if (origin === undefined || origin === "") return true; // non-browser client
          const normalized = origin.replace(/\/$/, "");
          return normalized.endsWith(req.headers.host ?? "\u0000") || env.allowedOrigins.includes(normalized);
        },
      });

      wss.on("connection", (socket) => {
        connections.set(socket, {
          socket,
          userId: null,
          lastSeenMonotonic: monotonicMs(),
          lastTypingByConversation: new Map(),
        });

        const authDeadline = setTimeout(() => {
          if (connections.get(socket)?.userId == null) socket.close(4001, "auth timeout");
        }, AUTH_GRACE_MS);

        socket.on("message", (data) => handleFrame(socket, data.toString()));
        socket.on("pong", () => {
          const connection = connections.get(socket);
          if (connection !== undefined) connection.lastSeenMonotonic = monotonicMs();
        });
        socket.on("close", () => {
          clearTimeout(authDeadline);
          release(socket);
        });
        socket.on("error", () => socket.terminate());
      });

      heartbeat = setInterval(() => {
        const cutoff = monotonicMs() - HEARTBEAT_TIMEOUT_MS;
        for (const [socket, connection] of connections) {
          if (connection.lastSeenMonotonic < cutoff) {
            socket.terminate();
            release(socket);
            continue;
          }
          if (socket.readyState === socket.OPEN) socket.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      logger.info("realtime gateway attached", { path: "/ws" });
    },

    /** Fans a new message out to members and records delivery for everyone reached. */
    publishMessage(message: Message, memberIds: readonly string[]): void {
      const reached = fanOut(memberIds, { type: "message.new", message });
      const recipients = reached.filter((id) => id !== message.senderId);
      if (recipients.length > 0) store.messages.markDelivered(message.id, recipients);
    },

    publishExpired(conversationId: string, messageIds: string[], memberIds: readonly string[]): void {
      fanOut(memberIds, { type: "message.expired", conversationId, messageIds });
    },

    publishRead(
      conversationId: string,
      messageId: string,
      userId: string,
      expiresAt: number | null,
      memberIds: readonly string[],
    ): void {
      fanOut(memberIds, { type: "message.read", conversationId, messageId, userId, expiresAt });
    },

    publishReactions(
      conversationId: string,
      messageId: string,
      reactions: Reaction[],
      memberIds: readonly string[],
    ): void {
      fanOut(memberIds, { type: "reaction.new", conversationId, messageId, reactions });
    },

    /**
     * Announces a conversation to each member. The payload is per-viewer because the
     * wrapped key and unread count differ for every member.
     */
    publishConversation(conversationId: string, memberIds: readonly string[], created: boolean): void {
      for (const userId of memberIds) {
        const view = store.conversations.view(conversationId, userId, presenceOf);
        if (view === null) continue;
        fanOut([userId], {
          type: created ? "conversation.new" : "conversation.updated",
          conversation: view,
        });
      }
    },

    /**
     * Re-sends a community to every member, each getting their own view. Channels are
     * listed per viewer, so anything that changes channel membership has to republish —
     * otherwise a member who was just granted a channel never sees it appear.
     */
    publishCommunity(communityId: string): void {
      for (const userId of store.communities.memberIds(communityId)) {
        const view = store.communities.view(communityId, userId, presenceOf);
        if (view !== null) fanOut([userId], { type: "community.updated", community: view });
      }
    },

    close(): void {
      for (const timer of ringTimers.values()) clearTimeout(timer);
      ringTimers.clear();
      callsByUser.clear();
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const socket of connections.keys()) socket.terminate();
      connections.clear();
      byUser.clear();
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
