import type { Db } from "../db.ts";
import type { BurnMode, Message, MessagePage, Reaction } from "../../shared/protocol.ts";
import { newId } from "../core/ids.ts";
import { now } from "../core/time.ts";
import { scheduleBurn, startOnReadBurn } from "../core/burn.ts";

/** A message is readable only while both its effective and hard expiry are in the future. */
const ALIVE = "(expires_at IS NULL OR expires_at > ?) AND hard_expires_at > ?";

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  media_id: string | null;
  reply_to_id: string | null;
  ttl_seconds: number;
  burn_mode: BurnMode;
  sent_at: number;
  expires_at: number | null;
  hard_expires_at: number;
  first_read_at: number | null;
};

type NewMessage = {
  conversationId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  mediaId: string | null;
  replyToId: string | null;
  ttlSeconds: number;
  burnMode: BurnMode;
};

type ExpiredBatch = {
  conversationId: string;
  messageIds: string[];
};

const encodeCursor = (row: MessageRow) => `${row.sent_at}:${row.id}`;

function decodeCursor(cursor: string): { sentAt: number; id: string } | null {
  const split = cursor.indexOf(":");
  if (split <= 0) return null;
  const sentAt = Number(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  return Number.isFinite(sentAt) && id !== "" ? { sentAt, id } : null;
}

export function createMessageRepo(db: Db) {
  const insert = db.prepare(`
    INSERT INTO messages (id, conversation_id, sender_id, ciphertext, iv, media_id, reply_to_id,
                          ttl_seconds, burn_mode, sent_at, expires_at, hard_expires_at, first_read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const byId = db.prepare(`SELECT * FROM messages WHERE id = ? AND ${ALIVE}`);
  const firstPage = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND ${ALIVE}
    ORDER BY sent_at DESC, id DESC LIMIT ?
  `);
  const olderPage = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND ${ALIVE} AND (sent_at, id) < (?, ?)
    ORDER BY sent_at DESC, id DESC LIMIT ?
  `);

  const upsertDelivered = db.prepare(`
    INSERT INTO receipts (message_id, user_id, delivered_at, read_at) VALUES (?, ?, ?, NULL)
    ON CONFLICT (message_id, user_id) DO UPDATE SET delivered_at = COALESCE(delivered_at, excluded.delivered_at)
  `);
  const upsertRead = db.prepare(`
    INSERT INTO receipts (message_id, user_id, delivered_at, read_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (message_id, user_id) DO UPDATE SET
      delivered_at = COALESCE(delivered_at, excluded.delivered_at),
      read_at      = COALESCE(read_at, excluded.read_at)
  `);
  const startBurn = db.prepare("UPDATE messages SET first_read_at = ?, expires_at = ? WHERE id = ?");

  const reactionsFor = db.prepare("SELECT user_id AS userId, emoji FROM reactions WHERE message_id = ?");
  const hasReaction = db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?");
  const addReaction = db.prepare("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)");
  const dropReaction = db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?");
  const readCount = db.prepare(`
    SELECT count(*) AS count FROM receipts r
    JOIN messages m ON m.id = r.message_id
    WHERE r.message_id = ? AND r.read_at IS NOT NULL AND r.user_id != m.sender_id
  `);

  const expiredRows = db.prepare(`
    SELECT id, conversation_id, media_id FROM messages
    WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR hard_expires_at <= ?
  `);
  const deleteMessage = db.prepare("DELETE FROM messages WHERE id = ?");
  const deleteMedia = db.prepare("DELETE FROM media WHERE id = ?");
  const mediaOf = db.prepare("SELECT media_id FROM messages WHERE id = ?");
  const bindMedia = db.prepare("UPDATE media SET expires_at = ? WHERE id = ?");

  const hydrate = (row: MessageRow): Message => {
    const reactions = reactionsFor.all(row.id) as unknown as Reaction[];
    const counted = readCount.get(row.id) as unknown as { count: number };
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      ciphertext: row.ciphertext,
      iv: row.iv,
      mediaId: row.media_id,
      replyToId: row.reply_to_id,
      ttlSeconds: row.ttl_seconds,
      burnMode: row.burn_mode,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
      firstReadAt: row.first_read_at,
      reactions,
      readBy: counted.count,
    };
  };

  return {
    create(input: NewMessage): Message {
      const sentAt = now();
      const id = newId();
      const burn = scheduleBurn(sentAt, input.ttlSeconds, input.burnMode);
      insert.run(
        id,
        input.conversationId,
        input.senderId,
        input.ciphertext,
        input.iv,
        input.mediaId,
        input.replyToId,
        input.ttlSeconds,
        input.burnMode,
        sentAt,
        burn.expiresAt,
        burn.hardExpiresAt,
      );
      // Attached media adopts the message's ceiling, replacing its upload grace window.
      if (input.mediaId !== null) bindMedia.run(burn.hardExpiresAt, input.mediaId);
      return hydrate(byId.get(id, sentAt, sentAt) as unknown as MessageRow);
    },

    findAlive(id: string): Message | null {
      const at = now();
      const row = byId.get(id, at, at) as unknown as MessageRow | undefined;
      return row === undefined ? null : hydrate(row);
    },

    /** Newest-first page, returned oldest-first for rendering. */
    page(conversationId: string, limit: number, cursor: string | null): MessagePage {
      const at = now();
      const decoded = cursor === null ? null : decodeCursor(cursor);
      const rows = (
        decoded === null
          ? firstPage.all(conversationId, at, at, limit + 1)
          : olderPage.all(conversationId, at, at, decoded.sentAt, decoded.id, limit + 1)
      ) as unknown as MessageRow[];

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        messages: page.map(hydrate).reverse(),
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
    },

    markDelivered(messageId: string, userIds: readonly string[]): void {
      const at = now();
      for (const userId of userIds) upsertDelivered.run(messageId, userId, at);
    },

    /**
     * Records a read receipt. The first read by someone other than the sender starts an
     * on-read burn; later reads never move an expiry that is already fixed.
     */
    markRead(messageId: string, userId: string): { expiresAt: number | null } | null {
      const at = now();
      const row = byId.get(messageId, at, at) as unknown as MessageRow | undefined;
      if (row === undefined) return null;

      upsertRead.run(messageId, userId, at, at);

      const startsBurn = row.burn_mode === "onRead" && row.first_read_at === null && row.sender_id !== userId;
      if (!startsBurn) return { expiresAt: row.expires_at };

      const expiresAt = startOnReadBurn(at, row.ttl_seconds, row.hard_expires_at);
      startBurn.run(at, expiresAt, messageId);
      return { expiresAt };
    },

    /** Adds a reaction, or removes it when the user already reacted with that emoji. */
    toggleReaction(messageId: string, userId: string, emoji: string): Reaction[] {
      const existing = hasReaction.get(messageId, userId, emoji);
      if (existing === undefined) addReaction.run(messageId, userId, emoji);
      else dropReaction.run(messageId, userId, emoji);
      return reactionsFor.all(messageId) as unknown as Reaction[];
    },

    /** Immediate burn, used when a sender destroys their own message. */
    destroy(id: string): void {
      const row = mediaOf.get(id) as unknown as { media_id: string | null } | undefined;
      deleteMessage.run(id);
      if (row?.media_id != null) deleteMedia.run(row.media_id);
    },

    /**
     * Hard-deletes everything past expiry and reports what went, grouped by conversation.
     * Receipts and reactions follow by cascade; attached media is deleted explicitly.
     */
    reap(): ExpiredBatch[] {
      const at = now();
      const rows = expiredRows.all(at, at) as unknown as {
        id: string;
        conversation_id: string;
        media_id: string | null;
      }[];
      if (rows.length === 0) return [];

      const grouped = new Map<string, string[]>();
      for (const row of rows) {
        deleteMessage.run(row.id);
        if (row.media_id !== null) deleteMedia.run(row.media_id);
        const bucket = grouped.get(row.conversation_id);
        if (bucket === undefined) grouped.set(row.conversation_id, [row.id]);
        else bucket.push(row.id);
      }
      return [...grouped].map(([conversationId, messageIds]) => ({ conversationId, messageIds }));
    },
  };
}
