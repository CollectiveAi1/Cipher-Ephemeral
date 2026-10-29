import { describe, expect, it } from "vitest";
import { initialState, reducer, type CipherState, type LocalMessage } from "../../web/lib/reducer.ts";
import type { Call, Community, Conversation, Message } from "../../shared/protocol.ts";

const member = (id: string): Conversation["members"][number] => ({
  id,
  username: id,
  displayName: id.toUpperCase(),
  avatarHue: 200,
  publicKey: "pub",
  lastSeenAt: null,
  role: "member",
  joinedAt: 0,
  presence: "offline",
});

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  kind: "dm",
  name: null,
  createdBy: "u1",
  createdAt: 1_000,
  defaultTtlSeconds: 3_600,
  defaultBurnMode: "absolute",
  wrappedKey: "wrapped",
  wrappedByPublicKey: "pub",
  members: [],
  lastActivityAt: 1_000,
  unreadCount: 0,
  communityId: null,
  postPolicy: "all",
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "m1",
  conversationId: "c1",
  senderId: "u2",
  ciphertext: "ct",
  iv: "iv",
  mediaId: null,
  replyToId: null,
  ttlSeconds: 60,
  burnMode: "absolute",
  sentAt: 2_000,
  expiresAt: 62_000,
  firstReadAt: null,
  reactions: [],
  readBy: 0,
  ...overrides,
});

const withConversation = (): CipherState =>
  reducer(initialState, { type: "conversation", conversation: conversation() });

describe("conversations", () => {
  it("orders by most recent activity", () => {
    let state = reducer(initialState, {
      type: "conversations",
      conversations: [
        conversation({ id: "old", lastActivityAt: 10 }),
        conversation({ id: "new", lastActivityAt: 99 }),
      ],
    });
    expect(state.conversations.map((item) => item.id)).toEqual(["new", "old"]);

    state = reducer(state, { type: "conversation", conversation: conversation({ id: "old", lastActivityAt: 500 }) });
    expect(state.conversations.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("replaces rather than duplicates on update", () => {
    let state = withConversation();
    state = reducer(state, { type: "conversation", conversation: conversation({ name: "Renamed" }) });
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]?.name).toBe("Renamed");
  });

  it("clears the badge when opened and drops everything when removed", () => {
    let state = reducer(initialState, {
      type: "conversation",
      conversation: conversation({ unreadCount: 7 }),
    });
    state = reducer(state, { type: "message", message: message() });
    state = reducer(state, { type: "body", messageId: "m1", body: { text: "hi", attachment: null } });

    state = reducer(state, { type: "active", conversationId: "c1" });
    expect(state.conversations[0]?.unreadCount).toBe(0);

    state = reducer(state, { type: "conversation/remove", conversationId: "c1" });
    expect(state.conversations).toHaveLength(0);
    expect(state.activeId).toBeNull();
    expect(state.messages["c1"]).toBeUndefined();
    // Leaving releases the decrypted plaintext too.
    expect(state.bodies["m1"]).toBeUndefined();
  });
});

describe("messages", () => {
  it("keeps the list ordered by send time", () => {
    let state = withConversation();
    for (const sentAt of [3_000, 1_000, 2_000]) {
      state = reducer(state, { type: "message", message: message({ id: `m${sentAt}`, sentAt }) });
    }
    expect(state.messages["c1"]?.map((item) => item.sentAt)).toEqual([1_000, 2_000, 3_000]);
  });

  it("is idempotent, so an at-least-once delivery cannot duplicate a message", () => {
    let state = withConversation();
    state = reducer(state, { type: "message", message: message() });
    state = reducer(state, { type: "message", message: message() });
    expect(state.messages["c1"]).toHaveLength(1);
  });

  it("counts unread only while the conversation is closed", () => {
    let state = withConversation();
    state = reducer(state, { type: "message", message: message({ id: "a" }) });
    expect(state.conversations[0]?.unreadCount).toBe(1);

    state = reducer(state, { type: "active", conversationId: "c1" });
    state = reducer(state, { type: "message", message: message({ id: "b" }) });
    expect(state.conversations[0]?.unreadCount).toBe(0);
  });

  it("swaps a pending message for the confirmed one, carrying the plaintext over", () => {
    let state = withConversation();
    const pending: LocalMessage = { ...message({ id: "pending:1" }), pending: true };
    state = reducer(state, { type: "message/pending", message: pending });
    state = reducer(state, { type: "body", messageId: "pending:1", body: { text: "sent", attachment: null } });

    state = reducer(state, { type: "message/confirm", pendingId: "pending:1", message: message({ id: "real" }) });

    expect(state.messages["c1"]).toHaveLength(1);
    expect(state.messages["c1"]?.[0]?.id).toBe("real");
    expect(state.messages["c1"]?.[0]?.pending).toBe(false);
    expect(state.bodies["real"]).toEqual({ text: "sent", attachment: null });
    expect(state.bodies["pending:1"]).toBeUndefined();
  });

  it("removes a failed send and explains why", () => {
    let state = withConversation();
    state = reducer(state, {
      type: "message/pending",
      message: { ...message({ id: "pending:1" }), pending: true },
    });
    state = reducer(state, { type: "message/fail", pendingId: "pending:1" });

    expect(state.messages["c1"]).toHaveLength(0);
    expect(state.notice).not.toBeNull();
  });

  it("purges expired messages together with their plaintext", () => {
    let state = withConversation();
    state = reducer(state, { type: "message", message: message({ id: "a" }) });
    state = reducer(state, { type: "message", message: message({ id: "b" }) });
    state = reducer(state, { type: "body", messageId: "a", body: { text: "secret", attachment: null } });

    state = reducer(state, { type: "message/expired", conversationId: "c1", messageIds: ["a"] });

    expect(state.messages["c1"]?.map((item) => item.id)).toEqual(["b"]);
    expect(state.bodies["a"]).toBeUndefined();
  });

  it("arms an on-read message when the read frame arrives", () => {
    let state = withConversation();
    state = reducer(state, { type: "message", message: message({ burnMode: "onRead", expiresAt: null }) });
    expect(state.messages["c1"]?.[0]?.expiresAt).toBeNull();

    state = reducer(state, { type: "message/read", conversationId: "c1", messageId: "m1", expiresAt: 99_000 });
    expect(state.messages["c1"]?.[0]?.expiresAt).toBe(99_000);
  });

  it("applies reactions from the server", () => {
    let state = withConversation();
    state = reducer(state, { type: "message", message: message() });
    state = reducer(state, {
      type: "message/reactions",
      conversationId: "c1",
      messageId: "m1",
      reactions: [{ userId: "u2", emoji: "🔥" }],
    });
    expect(state.messages["c1"]?.[0]?.reactions).toEqual([{ userId: "u2", emoji: "🔥" }]);
  });
});

describe("history paging", () => {
  it("prepends an older page without duplicating what is already loaded", () => {
    let state = withConversation();
    state = reducer(state, {
      type: "history",
      conversationId: "c1",
      messages: [message({ id: "b", sentAt: 2_000 })],
      nextCursor: "cursor-1",
    });
    state = reducer(state, {
      type: "history/older",
      conversationId: "c1",
      messages: [message({ id: "a", sentAt: 1_000 }), message({ id: "b", sentAt: 2_000 })],
      nextCursor: null,
    });

    expect(state.messages["c1"]?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(state.cursors["c1"]).toBeNull();
  });
});

describe("typing indicators", () => {
  it("expires an indicator once its window passes", () => {
    let state = reducer(initialState, { type: "typing", conversationId: "c1", userId: "u2", until: 5_000 });
    expect(state.typing["c1"]?.["u2"]).toBe(5_000);

    state = reducer(state, { type: "typing/sweep", at: 4_000 });
    expect(state.typing["c1"]?.["u2"]).toBe(5_000);

    state = reducer(state, { type: "typing/sweep", at: 6_000 });
    expect(state.typing["c1"]).toBeUndefined();
  });
});

describe("presence", () => {
  it("patches a member in place without touching other conversations", () => {
    let state = reducer(initialState, {
      type: "conversations",
      conversations: [
        conversation({ id: "c1", members: [member("u2")] }),
        conversation({ id: "c2", members: [member("u3")] }),
      ],
    });

    state = reducer(state, { type: "presence", userId: "u2", state: "online", lastSeenAt: null });

    expect(state.conversations.find((c) => c.id === "c1")?.members[0]?.presence).toBe("online");
    expect(state.conversations.find((c) => c.id === "c2")?.members[0]?.presence).toBe("offline");
  });

  it("records last seen when someone goes offline", () => {
    let state = reducer(initialState, {
      type: "conversation",
      conversation: conversation({ members: [member("u2")] }),
    });
    state = reducer(state, { type: "presence", userId: "u2", state: "offline", lastSeenAt: 4_242 });

    expect(state.conversations[0]?.members[0]).toMatchObject({ presence: "offline", lastSeenAt: 4_242 });
  });

  it("ignores someone who is not a member of anything loaded", () => {
    const state = reducer(initialState, { type: "presence", userId: "ghost", state: "online", lastSeenAt: null });
    expect(state.conversations).toEqual([]);
  });
});

describe("connection", () => {
  it("tracks socket state and the measured clock offset", () => {
    let state = reducer(initialState, { type: "connection", state: "online" });
    state = reducer(state, { type: "clock", offsetMs: -250 });
    expect(state.connection).toBe("online");
    expect(state.clockOffsetMs).toBe(-250);
  });

  it("dismisses a notice", () => {
    let state = reducer(initialState, { type: "notice", message: "boom" });
    state = reducer(state, { type: "notice", message: null });
    expect(state.notice).toBeNull();
  });
});

const community = (overrides: Partial<Community> = {}): Community => ({
  id: "com1",
  name: "Project Phoenix",
  description: "",
  createdBy: "u1",
  createdAt: 0,
  avatarHue: 200,
  maxTtlSeconds: 3_600,
  role: "admin",
  memberCount: 1,
  members: [],
  channels: [],
  ...overrides,
});

const callRecord = (overrides: Partial<Call> = {}): Call => ({
  id: "call1",
  conversationId: "c1",
  initiatorId: "u1",
  kind: "audio",
  status: "ringing",
  startedAt: 1_000,
  answeredAt: null,
  endedAt: null,
  expiresAt: 100_000,
  participants: [],
  ...overrides,
});

describe("navigation", () => {
  it("switches sections", () => {
    expect(initialState.tab).toBe("chats");
    expect(reducer(initialState, { type: "tab", tab: "calls" }).tab).toBe("calls");
  });
});

describe("communities", () => {
  it("replaces a community rather than duplicating it", () => {
    let state = reducer(initialState, { type: "community", community: community() });
    state = reducer(state, { type: "community", community: community({ name: "Renamed" }) });

    expect(state.communities).toHaveLength(1);
    expect(state.communities[0]?.name).toBe("Renamed");
  });

  it("drops a community on leaving", () => {
    let state = reducer(initialState, { type: "communities", communities: [community(), community({ id: "com2" })] });
    state = reducer(state, { type: "community/remove", communityId: "com1" });

    expect(state.communities.map((item) => item.id)).toEqual(["com2"]);
  });
});

describe("calls", () => {
  it("tracks a ringing call as the active one", () => {
    const state = reducer(initialState, { type: "call", call: callRecord() });
    expect(state.activeCall?.id).toBe("call1");
    expect(state.calls).toHaveLength(1);
  });

  it("keeps the record but clears the active call once it ends", () => {
    let state = reducer(initialState, { type: "call", call: callRecord() });
    state = reducer(state, { type: "call", call: callRecord({ status: "ended", endedAt: 5_000 }) });

    expect(state.activeCall).toBeNull();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.status).toBe("ended");
  });

  it("does not clear an unrelated active call", () => {
    let state = reducer(initialState, { type: "call", call: callRecord() });
    state = reducer(state, { type: "call", call: callRecord({ id: "other", status: "missed" }) });

    expect(state.activeCall?.id).toBe("call1");
    expect(state.calls).toHaveLength(2);
  });

  it("purges call records once they burn", () => {
    let state = reducer(initialState, {
      type: "calls",
      calls: [callRecord({ id: "fresh", expiresAt: 100_000 }), callRecord({ id: "stale", expiresAt: 10 })],
    });
    state = reducer(state, { type: "call/expire", at: 50_000 });

    expect(state.calls.map((item) => item.id)).toEqual(["fresh"]);
  });
});

describe("retention policy", () => {
  it("records the workspace cap reported by the server", () => {
    expect(reducer(initialState, { type: "policy", maxTtlSeconds: 3_600 }).maxTtlSeconds).toBe(3_600);
  });
});
