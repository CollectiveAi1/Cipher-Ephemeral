import type {
  Call,
  Community,
  Conversation,
  Message,
  PresenceState,
  Reaction,
} from "../../shared/protocol.ts";
import type { MessageBody } from "./envelope.ts";

/** Live state of the realtime connection, surfaced in the UI. */
export type ConnectionState = "connecting" | "online" | "offline";

/** The sections in the navigation rail. */
export const TABS = ["chats", "calls", "communities", "settings"] as const;
export type Tab = (typeof TABS)[number];

/** A message plus the local-only flag for one that has not been acknowledged yet. */
export type LocalMessage = Message & { pending: boolean };

export type CipherState = {
  tab: Tab;
  conversations: Conversation[];
  communities: Community[];
  /** Recent calls, newest first. Records burn, so this list shrinks on its own. */
  calls: Call[];
  /** The call currently ringing or connected, if any. */
  activeCall: Call | null;
  activeId: string | null;
  /** Messages per conversation, ascending by send time. */
  messages: Record<string, LocalMessage[]>;
  /** Pagination cursor per conversation; null means the history is exhausted. */
  cursors: Record<string, string | null>;
  /** Decrypted bodies, keyed by message id. Never persisted. */
  bodies: Record<string, MessageBody>;
  /** conversationId -> userId -> moment the indicator should disappear. */
  typing: Record<string, Record<string, number>>;
  connection: ConnectionState;
  /** Measured `serverTime - clientTime`, applied when rendering countdowns. */
  clockOffsetMs: number;
  /** Workspace-wide retention cap reported by the server. */
  maxTtlSeconds: number;
  notice: string | null;
};

export const initialState: CipherState = {
  tab: "chats",
  conversations: [],
  communities: [],
  calls: [],
  activeCall: null,
  activeId: null,
  messages: {},
  cursors: {},
  bodies: {},
  typing: {},
  connection: "connecting",
  clockOffsetMs: 0,
  maxTtlSeconds: 604_800,
  notice: null,
};

type CipherAction =
  | { type: "tab"; tab: Tab }
  | { type: "communities"; communities: Community[] }
  | { type: "community"; community: Community }
  | { type: "community/remove"; communityId: string }
  | { type: "calls"; calls: Call[] }
  | { type: "call"; call: Call }
  | { type: "call/expire"; at: number }
  | { type: "connection"; state: ConnectionState }
  | { type: "clock"; offsetMs: number }
  | { type: "policy"; maxTtlSeconds: number }
  | { type: "notice"; message: string | null }
  | { type: "conversations"; conversations: Conversation[] }
  | { type: "conversation"; conversation: Conversation }
  | { type: "conversation/remove"; conversationId: string }
  | { type: "active"; conversationId: string | null }
  | { type: "history"; conversationId: string; messages: Message[]; nextCursor: string | null }
  | { type: "history/older"; conversationId: string; messages: Message[]; nextCursor: string | null }
  | { type: "message"; message: Message }
  | { type: "message/pending"; message: LocalMessage }
  | { type: "message/confirm"; pendingId: string; message: Message }
  | { type: "message/fail"; pendingId: string }
  | { type: "message/expired"; conversationId: string; messageIds: string[] }
  | { type: "message/read"; conversationId: string; messageId: string; expiresAt: number | null }
  | { type: "message/reactions"; conversationId: string; messageId: string; reactions: Reaction[] }
  | { type: "body"; messageId: string; body: MessageBody }
  | { type: "presence"; userId: string; state: PresenceState; lastSeenAt: number | null }
  | { type: "typing"; conversationId: string; userId: string; until: number }
  | { type: "typing/sweep"; at: number };

const byTime = (a: LocalMessage, b: LocalMessage) => a.sentAt - b.sentAt || a.id.localeCompare(b.id);

/** Inserts or replaces a message by id, keeping the list ordered. */
function upsert(list: readonly LocalMessage[], message: LocalMessage): LocalMessage[] {
  const index = list.findIndex((existing) => existing.id === message.id);
  const next = index === -1 ? [...list, message] : list.with(index, message);
  return next.sort(byTime);
}

function mapMessages(
  state: CipherState,
  conversationId: string,
  change: (list: readonly LocalMessage[]) => LocalMessage[],
): CipherState {
  const current = state.messages[conversationId] ?? [];
  return { ...state, messages: { ...state.messages, [conversationId]: change(current) } };
}

function patchMessage(
  state: CipherState,
  conversationId: string,
  messageId: string,
  patch: Partial<LocalMessage>,
): CipherState {
  return mapMessages(state, conversationId, (list) =>
    list.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
  );
}

/** Drops decrypted bodies for messages that no longer exist. */
function forgetBodies(bodies: CipherState["bodies"], messageIds: readonly string[]): CipherState["bodies"] {
  const next = { ...bodies };
  for (const id of messageIds) delete next[id];
  return next;
}

function upsertConversation(list: readonly Conversation[], conversation: Conversation): Conversation[] {
  const index = list.findIndex((existing) => existing.id === conversation.id);
  const next = index === -1 ? [...list, conversation] : list.with(index, conversation);
  return next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function reducer(state: CipherState, action: CipherAction): CipherState {
  switch (action.type) {
    case "tab":
      return { ...state, tab: action.tab };

    case "communities":
      return { ...state, communities: action.communities };

    case "community": {
      const index = state.communities.findIndex((item) => item.id === action.community.id);
      return {
        ...state,
        communities:
          index === -1
            ? [...state.communities, action.community]
            : state.communities.with(index, action.community),
      };
    }

    case "community/remove":
      return { ...state, communities: state.communities.filter((item) => item.id !== action.communityId) };

    case "calls":
      return { ...state, calls: action.calls };

    case "call": {
      const index = state.calls.findIndex((item) => item.id === action.call.id);
      const calls =
        index === -1 ? [action.call, ...state.calls] : state.calls.with(index, action.call);
      // A call stays "active" in the UI only while it is ringing or connected.
      const live = action.call.status === "ringing" || action.call.status === "active";
      const stillOurs = state.activeCall?.id === action.call.id;
      return {
        ...state,
        calls,
        activeCall: live ? action.call : stillOurs ? null : state.activeCall,
      };
    }

    case "call/expire":
      return { ...state, calls: state.calls.filter((item) => item.expiresAt > action.at) };

    case "connection":
      return { ...state, connection: action.state };

    case "clock":
      return { ...state, clockOffsetMs: action.offsetMs };

    case "policy":
      return { ...state, maxTtlSeconds: action.maxTtlSeconds };

    case "notice":
      return { ...state, notice: action.message };

    case "conversations":
      return {
        ...state,
        conversations: [...action.conversations].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
      };

    case "conversation":
      return { ...state, conversations: upsertConversation(state.conversations, action.conversation) };

    case "conversation/remove": {
      const messages = { ...state.messages };
      const expired = messages[action.conversationId] ?? [];
      delete messages[action.conversationId];
      return {
        ...state,
        conversations: state.conversations.filter((item) => item.id !== action.conversationId),
        activeId: state.activeId === action.conversationId ? null : state.activeId,
        messages,
        bodies: forgetBodies(
          state.bodies,
          expired.map((message) => message.id),
        ),
      };
    }

    case "active":
      return {
        ...state,
        activeId: action.conversationId,
        // Opening a conversation clears its badge; the server is told separately.
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId ? { ...conversation, unreadCount: 0 } : conversation,
        ),
      };

    case "history":
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.conversationId]: action.messages.map((message) => ({ ...message, pending: false })),
        },
        cursors: { ...state.cursors, [action.conversationId]: action.nextCursor },
      };

    case "history/older": {
      const existing = state.messages[action.conversationId] ?? [];
      const known = new Set(existing.map((message) => message.id));
      const older = action.messages
        .filter((message) => !known.has(message.id))
        .map((message) => ({ ...message, pending: false }));
      return {
        ...state,
        messages: { ...state.messages, [action.conversationId]: [...older, ...existing].sort(byTime) },
        cursors: { ...state.cursors, [action.conversationId]: action.nextCursor },
      };
    }

    case "message": {
      const next = mapMessages(state, action.message.conversationId, (list) =>
        upsert(list, { ...action.message, pending: false }),
      );
      const isActive = state.activeId === action.message.conversationId;
      return {
        ...next,
        conversations: next.conversations.map((conversation) =>
          conversation.id === action.message.conversationId
            ? {
                ...conversation,
                lastActivityAt: action.message.sentAt,
                unreadCount: isActive ? 0 : conversation.unreadCount + 1,
              }
            : conversation,
        ),
      };
    }

    case "message/pending":
      return mapMessages(state, action.message.conversationId, (list) => upsert(list, action.message));

    case "message/confirm": {
      const body = state.bodies[action.pendingId];
      const withoutPending = mapMessages(state, action.message.conversationId, (list) =>
        list.filter((message) => message.id !== action.pendingId),
      );
      const confirmed = mapMessages(withoutPending, action.message.conversationId, (list) =>
        upsert(list, { ...action.message, pending: false }),
      );
      // Carry the locally known plaintext across, so a sent message never needs decrypting.
      const bodies = forgetBodies(confirmed.bodies, [action.pendingId]);
      return {
        ...confirmed,
        bodies: body === undefined ? bodies : { ...bodies, [action.message.id]: body },
      };
    }

    case "message/fail":
      return {
        ...state,
        messages: Object.fromEntries(
          Object.entries(state.messages).map(([conversationId, list]) => [
            conversationId,
            list.filter((message) => message.id !== action.pendingId),
          ]),
        ),
        bodies: forgetBodies(state.bodies, [action.pendingId]),
        notice: "That message could not be sent.",
      };

    case "message/expired": {
      const gone = new Set(action.messageIds);
      const next = mapMessages(state, action.conversationId, (list) =>
        list.filter((message) => !gone.has(message.id)),
      );
      return { ...next, bodies: forgetBodies(next.bodies, action.messageIds) };
    }

    case "message/read":
      return patchMessage(state, action.conversationId, action.messageId, {
        ...(action.expiresAt === null ? {} : { expiresAt: action.expiresAt }),
      });

    case "message/reactions":
      return patchMessage(state, action.conversationId, action.messageId, { reactions: action.reactions });

    case "presence":
      return {
        ...state,
        // Presence lives on the member rows, so patch it in place rather than
        // refetching every conversation each time somebody connects.
        conversations: state.conversations.map((conversation) => {
          if (!conversation.members.some((member) => member.id === action.userId)) return conversation;
          return {
            ...conversation,
            members: conversation.members.map((member) =>
              member.id === action.userId
                ? { ...member, presence: action.state, lastSeenAt: action.lastSeenAt ?? member.lastSeenAt }
                : member,
            ),
          };
        }),
      };

    case "body":
      return { ...state, bodies: { ...state.bodies, [action.messageId]: action.body } };

    case "typing":
      return {
        ...state,
        typing: {
          ...state.typing,
          [action.conversationId]: {
            ...(state.typing[action.conversationId] ?? {}),
            [action.userId]: action.until,
          },
        },
      };

    case "typing/sweep": {
      const typing: CipherState["typing"] = {};
      for (const [conversationId, people] of Object.entries(state.typing)) {
        const live = Object.entries(people).filter(([, until]) => until > action.at);
        if (live.length > 0) typing[conversationId] = Object.fromEntries(live);
      }
      return { ...state, typing };
    }

    default:
      return state;
  }
}
