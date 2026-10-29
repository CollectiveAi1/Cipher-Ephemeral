import { createHash } from "node:crypto";
import type { Community, CommunityMember, Conversation } from "../../shared/protocol.ts";
import type { Db } from "../db.ts";
import type { PresenceLookup } from "./conversations.ts";
import { newId } from "../core/ids.ts";
import { now } from "../core/time.ts";

type CommunityRow = {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  avatar_hue: number;
  max_ttl_seconds: number;
};

type NewCommunity = {
  name: string;
  description: string;
  maxTtlSeconds: number;
};

type CommunityPatch = {
  name?: string;
  description?: string;
  maxTtlSeconds?: number;
};

/** Resolves a channel to the view a particular member sees. */
type ChannelView = (conversationId: string, viewerId: string, presenceOf: PresenceLookup) => Conversation | null;

export function createCommunityRepo(db: Db, channelView: ChannelView) {
  const insert = db.prepare(`
    INSERT INTO communities (id, name, description, created_by, created_at, avatar_hue, max_ttl_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(
    "INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
  );
  const byId = db.prepare("SELECT * FROM communities WHERE id = ?");
  const idsForUser = db.prepare(`
    SELECT c.id FROM communities c
    JOIN community_members m ON m.community_id = c.id
    WHERE m.user_id = ?
    ORDER BY c.created_at
  `);
  const memberRow = db.prepare("SELECT role FROM community_members WHERE community_id = ? AND user_id = ?");
  const memberIdsOf = db.prepare("SELECT user_id FROM community_members WHERE community_id = ?");
  const countMembers = db.prepare("SELECT count(*) AS count FROM community_members WHERE community_id = ?");
  const membersOf = db.prepare(`
    SELECT m.user_id, m.role, m.joined_at,
           u.username, u.display_name, u.avatar_hue, u.public_key, u.last_seen_at
    FROM community_members m JOIN users u ON u.id = m.user_id
    WHERE m.community_id = ?
    ORDER BY m.joined_at
  `);
  const dropMember = db.prepare("DELETE FROM community_members WHERE community_id = ? AND user_id = ?");
  const channelIds = db.prepare(`
    SELECT id FROM conversations WHERE community_id = ? ORDER BY last_activity_at DESC
  `);
  const patchStatements = {
    name: db.prepare("UPDATE communities SET name = ? WHERE id = ?"),
    description: db.prepare("UPDATE communities SET description = ? WHERE id = ?"),
    maxTtlSeconds: db.prepare("UPDATE communities SET max_ttl_seconds = ? WHERE id = ?"),
  };

  const hueFor = (seed: string) => {
    const digest = createHash("sha256").update(seed).digest();
    return ((digest[0]! << 8) | digest[1]!) % 360;
  };

  const hydrate = (row: CommunityRow, viewerId: string, presenceOf: PresenceLookup): Community | null => {
    const membership = memberRow.get(row.id, viewerId) as unknown as { role: "admin" | "member" } | undefined;
    if (membership === undefined) return null;

    // Only channels the viewer actually belongs to; community membership does not by
    // itself grant the conversation key for every channel.
    const channels = (channelIds.all(row.id) as unknown as { id: string }[])
      .map(({ id }) => channelView(id, viewerId, presenceOf))
      .filter((channel): channel is Conversation => channel !== null);

    const counted = countMembers.get(row.id) as unknown as { count: number };
    const memberRows = membersOf.all(row.id) as unknown as {
      user_id: string;
      role: "admin" | "member";
      joined_at: number;
      username: string;
      display_name: string;
      avatar_hue: number;
      public_key: string;
      last_seen_at: number | null;
    }[];

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdBy: row.created_by,
      createdAt: row.created_at,
      avatarHue: row.avatar_hue,
      maxTtlSeconds: row.max_ttl_seconds,
      role: membership.role,
      memberCount: counted.count,
      members: memberRows.map(
        (member): CommunityMember => ({
          id: member.user_id,
          username: member.username,
          displayName: member.display_name,
          avatarHue: member.avatar_hue,
          publicKey: member.public_key,
          lastSeenAt: member.last_seen_at,
          role: member.role,
          joinedAt: member.joined_at,
        }),
      ),
      channels,
    };
  };

  return {
    create(creatorId: string, input: NewCommunity): string {
      const id = newId();
      const at = now();
      insert.run(id, input.name, input.description, creatorId, at, hueFor(id), input.maxTtlSeconds);
      insertMember.run(id, creatorId, "admin", at);
      return id;
    },

    view(communityId: string, viewerId: string, presenceOf: PresenceLookup): Community | null {
      const row = byId.get(communityId) as unknown as CommunityRow | undefined;
      return row === undefined ? null : hydrate(row, viewerId, presenceOf);
    },

    listFor(viewerId: string, presenceOf: PresenceLookup): Community[] {
      const ids = idsForUser.all(viewerId) as unknown as { id: string }[];
      const out: Community[] = [];
      for (const { id } of ids) {
        const row = byId.get(id) as unknown as CommunityRow | undefined;
        const view = row === undefined ? null : hydrate(row, viewerId, presenceOf);
        if (view !== null) out.push(view);
      }
      return out;
    },

    roleOf(communityId: string, userId: string): "admin" | "member" | null {
      const row = memberRow.get(communityId, userId) as unknown as { role: "admin" | "member" } | undefined;
      return row?.role ?? null;
    },

    /** The retention ceiling, or null when the community does not exist. */
    ceilingOf(communityId: string): number | null {
      const row = byId.get(communityId) as unknown as CommunityRow | undefined;
      return row?.max_ttl_seconds ?? null;
    },

    memberIds(communityId: string): string[] {
      const rows = memberIdsOf.all(communityId) as unknown as { user_id: string }[];
      return rows.map((row) => row.user_id);
    },

    addMember(communityId: string, userId: string, role: "admin" | "member"): void {
      insertMember.run(communityId, userId, role, now());
    },

    removeMember(communityId: string, userId: string): void {
      dropMember.run(communityId, userId);
    },

    patch(communityId: string, changes: CommunityPatch): void {
      if (changes.name !== undefined) patchStatements.name.run(changes.name, communityId);
      if (changes.description !== undefined) patchStatements.description.run(changes.description, communityId);
      if (changes.maxTtlSeconds !== undefined) {
        patchStatements.maxTtlSeconds.run(changes.maxTtlSeconds, communityId);
      }
    },
  };
}
