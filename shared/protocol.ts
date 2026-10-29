/**
 * The wire contract between client and server. Binary fields (ciphertext, IVs, keys)
 * travel as base64. The server never receives a field it could decrypt.
 */

export const BURN_MODES = ["absolute", "onRead"] as const;
export type BurnMode = (typeof BURN_MODES)[number];

export const CONVERSATION_KINDS = ["dm", "group"] as const;
type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export type PresenceState = "online" | "offline";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  /** Deterministic hue (0-359) for the generated avatar, so clients agree on colour. */
  avatarHue: number;
  publicKey: string;
  lastSeenAt: number | null;
};

export type ConversationMember = PublicUser & {
  role: "admin" | "member";
  joinedAt: number;
  presence: PresenceState;
};

export const CALL_KINDS = ["audio", "video"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined";

/** How a channel decides who may post. */
export type PostPolicy = "all" | "admins";

export type Community = {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: number;
  avatarHue: number;
  /**
   * The retention ceiling. Every channel in this community clamps its Burn Dial to
   * this value, enforced server-side regardless of what a client asks for.
   */
  maxTtlSeconds: number;
  role: "admin" | "member";
  memberCount: number;
  members: CommunityMember[];
  /** Channels the requesting user can see, most recently active first. */
  channels: Conversation[];
};

export type CommunityMember = PublicUser & {
  role: "admin" | "member";
  joinedAt: number;
};

export type CallParticipant = {
  userId: string;
  state: "invited" | "joined" | "left" | "declined";
};

export type Call = {
  id: string;
  conversationId: string;
  initiatorId: string;
  kind: CallKind;
  status: CallStatus;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  /** Call records burn like messages; this is when this record disappears. */
  expiresAt: number;
  participants: CallParticipant[];
};

export type Conversation = {
  id: string;
  kind: ConversationKind;
  /** Null for DMs, which are titled from the peer on the client. */
  name: string | null;
  createdBy: string;
  createdAt: number;
  defaultTtlSeconds: number;
  defaultBurnMode: BurnMode;
  /** The conversation key, wrapped for the requesting user. */
  wrappedKey: string;
  /**
   * Public key of whoever wrapped it. The recipient derives the same ECDH secret from
   * this, which is not always the creator's key once members are added — and is needed
   * even if the wrapper has since left.
   */
  wrappedByPublicKey: string;
  members: ConversationMember[];
  lastActivityAt: number;
  unreadCount: number;
  /** Set when this conversation is a channel inside a community. */
  communityId: string | null;
  postPolicy: PostPolicy;
};

export type Reaction = {
  userId: string;
  emoji: string;
};

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  mediaId: string | null;
  replyToId: string | null;
  ttlSeconds: number;
  burnMode: BurnMode;
  sentAt: number;
  /** Null while an on-read message is still unread by every recipient. */
  expiresAt: number | null;
  firstReadAt: number | null;
  reactions: Reaction[];
  /** Count of recipients who have read it, excluding the sender. */
  readBy: number;
};

export type MessagePage = {
  messages: Message[];
  /** Cursor for the next older page, or null when the history is exhausted. */
  nextCursor: string | null;
};

export type AuthSession = {
  token: string;
  expiresAt: number;
  user: PublicUser;
  /** The caller's identity key, encrypted under their password. Unwrapped client-side. */
  wrappedPrivateKey: string;
  keySalt: string;
};

export type HealthReport = {
  status: "ok";
  serverTime: number;
  maxTtlSeconds: number;
  /** STUN/TURN URLs the client should use for calls. Empty means local network only. */
  iceServers: string[];
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

/** Frames the client sends. */
export type ClientFrame =
  | { type: "auth"; token: string }
  | { type: "typing"; conversationId: string }
  | { type: "ping" }
  | { type: "call.invite"; conversationId: string; kind: CallKind }
  | { type: "call.accept"; callId: string }
  | { type: "call.decline"; callId: string }
  | { type: "call.end"; callId: string }
  /**
   * WebRTC signalling. `payload` is the SDP or ICE candidate already encrypted under
   * the conversation key, so the server relays network candidates it cannot read.
   */
  | { type: "call.signal"; callId: string; payload: string; iv: string };

/** Frames the server sends. */
export type ServerFrame =
  | { type: "ready"; userId: string; serverTime: number }
  | { type: "message.new"; message: Message }
  | { type: "message.expired"; conversationId: string; messageIds: string[] }
  | { type: "message.read"; conversationId: string; messageId: string; userId: string; expiresAt: number | null }
  | { type: "reaction.new"; conversationId: string; messageId: string; reactions: Reaction[] }
  | { type: "conversation.new"; conversation: Conversation }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "presence"; userId: string; state: PresenceState; lastSeenAt: number | null }
  | { type: "typing"; conversationId: string; userId: string }
  | { type: "pong"; serverTime: number }
  | { type: "community.updated"; community: Community }
  | { type: "call.incoming"; call: Call }
  | { type: "call.updated"; call: Call }
  | { type: "call.signal"; callId: string; fromUserId: string; payload: string; iv: string }
  | { type: "error"; code: string; message: string };

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const TYPING_TTL_MS = 4_000;
export const MAX_CIPHERTEXT_BYTES = 16_384;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** How long a call record survives before it burns with everything else. */
export const CALL_LOG_TTL_SECONDS = 86_400;
/** A call nobody answers stops ringing and is recorded as missed. */
export const CALL_RING_TIMEOUT_MS = 45_000;
export const MAX_SIGNAL_BYTES = 16_384;
