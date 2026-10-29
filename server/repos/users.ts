import { createHash } from "node:crypto";
import type { Db } from "../db.ts";
import type { PublicUser } from "../../shared/protocol.ts";
import { newId } from "../core/ids.ts";
import { now } from "../core/time.ts";

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  avatar_hue: number;
  password_hash: string;
  password_salt: string;
  public_key: string;
  wrapped_private_key: string;
  key_salt: string;
  created_at: number;
  last_seen_at: number | null;
};

type NewUser = {
  username: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  publicKey: string;
  wrappedPrivateKey: string;
  keySalt: string;
};

/** Deterministic avatar hue, so every client renders the same colour for a user. */
function hueFor(username: string): number {
  const digest = createHash("sha256").update(username).digest();
  return ((digest[0]! << 8) | digest[1]!) % 360;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarHue: row.avatar_hue,
    publicKey: row.public_key,
    lastSeenAt: row.last_seen_at,
  };
}

export function createUserRepo(db: Db) {
  const insert = db.prepare(`
    INSERT INTO users (id, username, display_name, avatar_hue, password_hash, password_salt,
                       public_key, wrapped_private_key, key_salt, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const byId = db.prepare("SELECT * FROM users WHERE id = ?");
  const byUsername = db.prepare("SELECT * FROM users WHERE username = ?");
  const directoryQuery = db.prepare(`
    SELECT * FROM users
    WHERE id != ? AND (username LIKE ? OR lower(display_name) LIKE ?)
    ORDER BY username
    LIMIT ?
  `);
  const touch = db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?");

  const issueSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  );
  const findSession = db.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?");
  const revokeSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const pruneSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  return {
    create(input: NewUser): UserRow {
      const id = newId();
      insert.run(
        id,
        input.username,
        input.displayName,
        hueFor(input.username),
        input.passwordHash,
        input.passwordSalt,
        input.publicKey,
        input.wrappedPrivateKey,
        input.keySalt,
        now(),
      );
      return byId.get(id) as unknown as UserRow;
    },

    findById(id: string): UserRow | null {
      return (byId.get(id) as unknown as UserRow | undefined) ?? null;
    },

    findByUsername(username: string): UserRow | null {
      return (byUsername.get(username) as unknown as UserRow | undefined) ?? null;
    },

    /** Directory search for starting a conversation. Prefix match on either name. */
    directory(query: string, excludeUserId: string, limit = 25): PublicUser[] {
      const pattern = `${query.toLowerCase()}%`;
      const rows = directoryQuery.all(excludeUserId, pattern, pattern, limit) as unknown as UserRow[];
      return rows.map(toPublicUser);
    },

    touchLastSeen(id: string, at: number): void {
      touch.run(at, id);
    },

    sessions: {
      issue(tokenHash: string, userId: string, expiresAt: number): void {
        issueSession.run(tokenHash, userId, now(), expiresAt);
      },
      findUserId(tokenHash: string): string | null {
        const row = findSession.get(tokenHash, now()) as unknown as { user_id: string } | undefined;
        return row?.user_id ?? null;
      },
      revoke(tokenHash: string): void {
        revokeSession.run(tokenHash);
      },
      pruneExpired(): void {
        pruneSessions.run(now());
      },
    },
  };
}
