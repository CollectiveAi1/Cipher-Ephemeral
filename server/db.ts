import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

/**
 * Forward-only migrations, tracked by SQLite's `user_version`. Each entry's index + 1
 * is its version; never edit a shipped entry, append a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    display_name        TEXT NOT NULL,
    avatar_hue          INTEGER NOT NULL,
    password_hash       TEXT NOT NULL,
    password_salt       TEXT NOT NULL,
    public_key          TEXT NOT NULL,
    wrapped_private_key TEXT NOT NULL,
    key_salt            TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    last_seen_at        INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE conversations (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
    name                TEXT,
    created_by          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at          INTEGER NOT NULL,
    default_ttl_seconds INTEGER NOT NULL,
    default_burn_mode   TEXT NOT NULL CHECK (default_burn_mode IN ('absolute', 'onRead')),
    dm_pair_key         TEXT UNIQUE,
    last_activity_at    INTEGER NOT NULL
  );

  CREATE TABLE members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    wrapped_key     TEXT NOT NULL,
    wrapped_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       INTEGER NOT NULL,
    last_read_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX idx_members_user ON members(user_id);

  CREATE TABLE media (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    byte_size  INTEGER NOT NULL,
    blob       BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_media_expires ON media(expires_at);

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ciphertext      TEXT NOT NULL,
    iv              TEXT NOT NULL,
    media_id        TEXT REFERENCES media(id) ON DELETE SET NULL,
    reply_to_id     TEXT,
    ttl_seconds     INTEGER NOT NULL,
    burn_mode       TEXT NOT NULL CHECK (burn_mode IN ('absolute', 'onRead')),
    sent_at         INTEGER NOT NULL,
    expires_at      INTEGER,
    hard_expires_at INTEGER NOT NULL,
    first_read_at   INTEGER
  );
  CREATE INDEX idx_messages_feed ON messages(conversation_id, sent_at);
  CREATE INDEX idx_messages_expires ON messages(expires_at);
  CREATE INDEX idx_messages_hard_expires ON messages(hard_expires_at);

  CREATE TABLE receipts (
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at INTEGER,
    read_at      INTEGER,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  `,
  `
  CREATE TABLE communities (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      INTEGER NOT NULL,
    avatar_hue      INTEGER NOT NULL,
    -- The retention ceiling. Every channel in this community clamps its Burn Dial to
    -- this, so a community can guarantee nothing inside it outlives the policy.
    max_ttl_seconds INTEGER NOT NULL
  );

  CREATE TABLE community_members (
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    joined_at    INTEGER NOT NULL,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE INDEX idx_community_members_user ON community_members(user_id);

  -- A channel is a group conversation that belongs to a community.
  ALTER TABLE conversations ADD COLUMN community_id TEXT REFERENCES communities(id) ON DELETE CASCADE;
  -- Announcement channels accept posts from community admins only.
  ALTER TABLE conversations ADD COLUMN post_policy TEXT NOT NULL DEFAULT 'all'
    CHECK (post_policy IN ('all', 'admins'));
  CREATE INDEX idx_conversations_community ON conversations(community_id);

  -- Call records are ephemeral like everything else: they carry an expiry and the
  -- reaper deletes them, so a missed call does not outlive the conversation it was in.
  CREATE TABLE calls (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    initiator_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
    status          TEXT NOT NULL CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined')),
    started_at      INTEGER NOT NULL,
    answered_at     INTEGER,
    ended_at        INTEGER,
    ttl_seconds     INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  );
  CREATE INDEX idx_calls_conversation ON calls(conversation_id, started_at);
  CREATE INDEX idx_calls_expires ON calls(expires_at);

  CREATE TABLE call_participants (
    call_id   TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state     TEXT NOT NULL CHECK (state IN ('invited', 'joined', 'left', 'declined')),
    joined_at INTEGER,
    left_at   INTEGER,
    PRIMARY KEY (call_id, user_id)
  );
  CREATE INDEX idx_call_participants_user ON call_participants(user_id);
  `,
];

/** Opens a database, applies any outstanding migrations, and returns the handle. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${version + 1} failed`, { cause });
    }
  }

  return db;
}
