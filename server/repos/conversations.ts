import type { Db } from "../db.ts";
import type { BurnMode, Conversation, ConversationMember, PostPolicy, PresenceState } from "../../shared/protocol.ts";
import { dmPairKey, newId } from "../core/ids.ts";
import { now } from "../core/time.ts";

type ConversationRow = {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  created_by: string;
  created_at: number;
  default_ttl_seconds: number;
  default_burn_mode: BurnMode;
  last_activity_at: number;
  community_id: string | null;
  post_policy: PostPolicy;
};

type MemberRow = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  public_key: string;
  last_seen_at: number | null;
  role: "admin" | "member";
  joined_at: number;
};

export type MemberKey = {
  userId: string;
  wrappedKey: string;
};

type ConversationDefaults = {
  defaultTtlSeconds: number;
  defaultBurnMode: BurnMode;
};

type ConversationPatch = {
  name?: string;
  defaultTtlSeconds?: number;
  defaultBurnMode?: BurnMode;
};

/** Resolves live presence for a user id; injected so the repo stays free of socket state. */
export type PresenceLookup = (userId: string) => PresenceState;

export function createConversationRepo(db: Db) {
  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, kind, name, created_by, created_at, default_ttl_seconds,
                               default_burn_mode, dm_pair_key, last_activity_at, community_id, post_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO members (conversation_id, user_id, role, wrapped_key, wrapped_by, joined_at, last_read_at)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `);
  const byId = db.prepare("SELECT * FROM conversations WHERE id = ?");
  const byDmPair = db.prepare("SELECT * FROM conversations WHERE dm_pair_key = ?");
  const idsForUser = db.prepare(`
    SELECT c.id FROM conversations c
    JOIN members m ON m.conversation_id = c.id
    WHERE m.user_id = ?
    ORDER BY c.last_activity_at DESC
  `);
  const membersOf = db.prepare(`
    SELECT m.user_id, m.role, m.joined_at,
           u.username, u.display_name, u.avatar_hue, u.public_key, u.last_seen_at
    FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ?
    ORDER BY m.joined_at
  `);
  const memberIdsOf = db.prepare("SELECT user_id FROM members WHERE conversation_id = ?");
  const peerIdsOf = db.prepare(`
    SELECT DISTINCT peer.user_id FROM members mine
    JOIN members peer ON peer.conversation_id = mine.conversation_id
    WHERE mine.user_id = ? AND peer.user_id != ?
  `);
  const memberRow = db.prepare(`
    SELECT m.role, m.wrapped_key, m.last_read_at, w.public_key AS wrapped_by_public_key
    FROM members m JOIN users w ON w.id = m.wrapped_by
    WHERE m.conversation_id = ? AND m.user_id = ?
  `);
  const dropMember = db.prepare("DELETE FROM members WHERE conversation_id = ? AND user_id = ?");
  const touch = db.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?");
  const setLastRead = db.prepare("UPDATE members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?");
  const unread = db.prepare(`
    SELECT count(*) AS count FROM messages
    WHERE conversation_id = ? AND sender_id != ? AND sent_at > ?
      AND (expires_at IS NULL OR expires_at > ?) AND hard_expires_at > ?
  `);
  const patchStatements = {
    name: db.prepare("UPDATE conversations SET name = ? WHERE id = ?"),
    defaultTtlSeconds: db.prepare("UPDATE conversations SET default_ttl_seconds = ? WHERE id = ?"),
    defaultBurnMode: db.prepare("UPDATE conversations SET default_burn_mode = ? WHERE id = ?"),
  };

  const hydrate = (row: ConversationRow, viewerId: string, presenceOf: PresenceLookup): Conversation | null => {
    const viewer = memberRow.get(row.id, viewerId) as unknown as
      | { role: "admin" | "member"; wrapped_key: string; wrapped_by_public_key: string; last_read_at: number }
      | undefined;
    if (viewer === undefined) return null;

    const at = now();
    const members = (membersOf.all(row.id) as unknown as MemberRow[]).map(
      (member): ConversationMember => ({
        id: member.user_id,
        username: member.username,
        displayName: member.display_name,
        avatarHue: member.avatar_hue,
        publicKey: member.public_key,
        lastSeenAt: member.last_seen_at,
        role: member.role,
        joinedAt: member.joined_at,
        presence: presenceOf(member.user_id),
      }),
    );
    const counted = unread.get(row.id, viewerId, viewer.last_read_at, at, at) as unknown as { count: number };

    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      defaultTtlSeconds: row.default_ttl_seconds,
      defaultBurnMode: row.default_burn_mode,
      wrappedKey: viewer.wrapped_key,
      wrappedByPublicKey: viewer.wrapped_by_public_key,
      members,
      lastActivityAt: row.last_activity_at,
      unreadCount: counted.count,
      communityId: row.community_id,
      postPolicy: row.post_policy,
    };
  };

  return {
    /** Creates a DM, or returns the existing one for the pair. Idempotent by design. */
    createDm(creatorId: string, peerId: string, keys: readonly MemberKey[], defaults: ConversationDefaults): string {
      const pair = dmPairKey(creatorId, peerId);
      const existing = byDmPair.get(pair) as unknown as ConversationRow | undefined;
      if (existing !== undefined) return existing.id;

      const id = newId();
      const at = now();
      insertConversation.run(
        id,
        "dm",
        null,
        creatorId,
        at,
        defaults.defaultTtlSeconds,
        defaults.defaultBurnMode,
        pair,
        at,
        null,
        "all",
      );
      for (const key of keys) {
        insertMember.run(id, key.userId, key.userId === creatorId ? "admin" : "member", key.wrappedKey, creatorId, at);
      }
      return id;
    },

    createGroup(
      creatorId: string,
      name: string,
      keys: readonly MemberKey[],
      defaults: ConversationDefaults,
      channel?: { communityId: string; postPolicy: PostPolicy },
    ): string {
      const id = newId();
      const at = now();
      insertConversation.run(
        id,
        "group",
        name,
        creatorId,
        at,
        defaults.defaultTtlSeconds,
        defaults.defaultBurnMode,
        null,
        at,
        channel?.communityId ?? null,
        channel?.postPolicy ?? "all",
      );
      for (const key of keys) {
        insertMember.run(id, key.userId, key.userId === creatorId ? "admin" : "member", key.wrappedKey, creatorId, at);
      }
      return id;
    },

    /** Community id and posting policy for a conversation, or null if it does not exist. */
    policyOf(conversationId: string): { communityId: string | null; postPolicy: PostPolicy } | null {
      const row = byId.get(conversationId) as unknown as ConversationRow | undefined;
      if (row === undefined) return null;
      return { communityId: row.community_id, postPolicy: row.post_policy };
    },

    exists(conversationId: string): boolean {
      return byId.get(conversationId) !== undefined;
    },

    /** Returns the conversation as the viewer sees it, or null if they are not a member. */
    view(conversationId: string, viewerId: string, presenceOf: PresenceLookup): Conversation | null {
      const row = byId.get(conversationId) as unknown as ConversationRow | undefined;
      return row === undefined ? null : hydrate(row, viewerId, presenceOf);
    },

    listFor(viewerId: string, presenceOf: PresenceLookup): Conversation[] {
      const ids = idsForUser.all(viewerId) as unknown as { id: string }[];
      const out: Conversation[] = [];
      for (const { id } of ids) {
        const row = byId.get(id) as unknown as ConversationRow | undefined;
        const view = row === undefined ? null : hydrate(row, viewerId, presenceOf);
        if (view !== null) out.push(view);
      }
      return out;
    },

    roleOf(conversationId: string, userId: string): "admin" | "member" | null {
      const row = memberRow.get(conversationId, userId) as unknown as { role: "admin" | "member" } | undefined;
      return row?.role ?? null;
    },

    memberIds(conversationId: string): string[] {
      const rows = memberIdsOf.all(conversationId) as unknown as { user_id: string }[];
      return rows.map((row) => row.user_id);
    },

    /** Everyone who shares at least one conversation with this user. Presence audience. */
    peerIds(userId: string): string[] {
      const rows = peerIdsOf.all(userId, userId) as unknown as { user_id: string }[];
      return rows.map((row) => row.user_id);
    },

    addMember(conversationId: string, userId: string, wrappedKey: string, wrappedBy: string): void {
      insertMember.run(conversationId, userId, "member", wrappedKey, wrappedBy, now());
    },

    removeMember(conversationId: string, userId: string): void {
      dropMember.run(conversationId, userId);
    },

    patch(conversationId: string, changes: ConversationPatch): void {
      if (changes.name !== undefined) patchStatements.name.run(changes.name, conversationId);
      if (changes.defaultTtlSeconds !== undefined) {
        patchStatements.defaultTtlSeconds.run(changes.defaultTtlSeconds, conversationId);
      }
      if (changes.defaultBurnMode !== undefined) {
        patchStatements.defaultBurnMode.run(changes.defaultBurnMode, conversationId);
      }
    },

    touchActivity(conversationId: string, at: number): void {
      touch.run(at, conversationId);
    },

    markRead(conversationId: string, userId: string, at: number): void {
      setLastRead.run(at, conversationId, userId);
    },
  };
}
