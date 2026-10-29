import type { Db } from "../db.ts";
import { newId } from "../core/ids.ts";
import { now } from "../core/time.ts";

/**
 * How long an uploaded blob survives if it is never attached to a message. Prevents
 * orphaned uploads from accumulating.
 */
const UPLOAD_GRACE_MS = 60 * 60 * 1000;

type MediaBlob = {
  id: string;
  ownerId: string;
  byteSize: number;
  bytes: Uint8Array;
};

export function createMediaRepo(db: Db) {
  const insert = db.prepare(
    "INSERT INTO media (id, owner_id, byte_size, blob, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const byId = db.prepare("SELECT id, owner_id, byte_size, blob FROM media WHERE id = ? AND expires_at > ?");
  const reapOrphans = db.prepare("DELETE FROM media WHERE expires_at <= ?");
  const ownerOf = db.prepare(`
    SELECT m.conversation_id FROM messages m WHERE m.media_id = ?
  `);

  return {
    create(ownerId: string, bytes: Uint8Array): string {
      const id = newId();
      const at = now();
      insert.run(id, ownerId, bytes.byteLength, bytes, at, at + UPLOAD_GRACE_MS);
      return id;
    },

    find(id: string): MediaBlob | null {
      const row = byId.get(id, now()) as unknown as
        | { id: string; owner_id: string; byte_size: number; blob: Uint8Array }
        | undefined;
      if (row === undefined) return null;
      return { id: row.id, ownerId: row.owner_id, byteSize: row.byte_size, bytes: row.blob };
    },

    /** The conversation a blob belongs to once attached, used to authorize downloads. */
    conversationOf(mediaId: string): string | null {
      const row = ownerOf.get(mediaId) as unknown as { conversation_id: string } | undefined;
      return row?.conversation_id ?? null;
    },

    reapOrphans(): void {
      reapOrphans.run(now());
    },
  };
}
