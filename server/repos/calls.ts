import type { Call, CallKind, CallParticipant, CallStatus } from "../../shared/protocol.ts";
import { CALL_LOG_TTL_SECONDS } from "../../shared/protocol.ts";
import type { Db } from "../db.ts";
import { newId } from "../core/ids.ts";
import { now } from "../core/time.ts";
import { clampTtlSeconds } from "../core/burn.ts";

type CallRow = {
  id: string;
  conversation_id: string;
  initiator_id: string;
  kind: CallKind;
  status: CallStatus;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  ttl_seconds: number;
  expires_at: number;
};

/** A call record is readable only until it burns, like every other record here. */
const ALIVE = "expires_at > ?";

export function createCallRepo(db: Db) {
  const insert = db.prepare(`
    INSERT INTO calls (id, conversation_id, initiator_id, kind, status, started_at,
                       answered_at, ended_at, ttl_seconds, expires_at)
    VALUES (?, ?, ?, ?, 'ringing', ?, NULL, NULL, ?, ?)
  `);
  const insertParticipant = db.prepare(
    "INSERT INTO call_participants (call_id, user_id, state, joined_at, left_at) VALUES (?, ?, ?, NULL, NULL)",
  );
  const byId = db.prepare(`SELECT * FROM calls WHERE id = ? AND ${ALIVE}`);
  const participantsOf = db.prepare(
    "SELECT user_id AS userId, state FROM call_participants WHERE call_id = ? ORDER BY rowid",
  );
  const setStatus = db.prepare("UPDATE calls SET status = ?, answered_at = ?, ended_at = ? WHERE id = ?");
  const setParticipant = db.prepare(
    "UPDATE call_participants SET state = ?, joined_at = ?, left_at = ? WHERE call_id = ? AND user_id = ?",
  );
  const ringingIn = db.prepare(
    `SELECT * FROM calls WHERE conversation_id = ? AND status IN ('ringing', 'active') AND ${ALIVE} LIMIT 1`,
  );
  const historyFor = db.prepare(`
    SELECT c.* FROM calls c
    JOIN call_participants p ON p.call_id = c.id
    WHERE p.user_id = ? AND c.${ALIVE}
    ORDER BY c.started_at DESC
    LIMIT ?
  `);
  const expiredRows = db.prepare("SELECT id FROM calls WHERE expires_at <= ?");
  const deleteCall = db.prepare("DELETE FROM calls WHERE id = ?");

  const hydrate = (row: CallRow): Call => ({
    id: row.id,
    conversationId: row.conversation_id,
    initiatorId: row.initiator_id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
    participants: participantsOf.all(row.id) as unknown as CallParticipant[],
  });

  const read = (id: string): Call | null => {
    const row = byId.get(id, now()) as unknown as CallRow | undefined;
    return row === undefined ? null : hydrate(row);
  };

  return {
    /** Starts a ringing call. Participants other than the caller begin as `invited`. */
    start(conversationId: string, initiatorId: string, kind: CallKind, memberIds: readonly string[]): Call {
      const id = newId();
      const at = now();
      const ttlSeconds = clampTtlSeconds(CALL_LOG_TTL_SECONDS);

      insert.run(id, conversationId, initiatorId, kind, at, ttlSeconds, at + ttlSeconds * 1_000);
      for (const userId of memberIds) {
        insertParticipant.run(id, userId, userId === initiatorId ? "joined" : "invited");
      }
      return hydrate(byId.get(id, at) as unknown as CallRow);
    },

    find: read,

    /** The call currently ringing or connected in a conversation, if any. */
    activeIn(conversationId: string): Call | null {
      const row = ringingIn.get(conversationId, now()) as unknown as CallRow | undefined;
      return row === undefined ? null : hydrate(row);
    },

    /** Recent calls the user took part in. Expired records are already gone. */
    historyFor(userId: string, limit: number): Call[] {
      const rows = historyFor.all(userId, now(), limit) as unknown as CallRow[];
      return rows.map(hydrate);
    },

    answer(callId: string, userId: string): Call | null {
      const at = now();
      const existing = read(callId);
      if (existing === null) return null;

      setParticipant.run("joined", at, null, callId, userId);
      if (existing.status === "ringing") setStatus.run("active", at, null, callId);
      return read(callId);
    },

    decline(callId: string, userId: string): Call | null {
      const at = now();
      const existing = read(callId);
      if (existing === null) return null;

      setParticipant.run("declined", null, at, callId, userId);
      // A 1:1 call with nobody left to answer is over.
      if (existing.status === "ringing") setStatus.run("declined", null, at, callId);
      return read(callId);
    },

    /**
     * Ends a call. One that was never answered is recorded as missed rather than ended,
     * so the history distinguishes "we spoke" from "you were not there".
     */
    end(callId: string, status: Extract<CallStatus, "ended" | "missed">): Call | null {
      const at = now();
      const existing = read(callId);
      if (existing === null) return null;
      if (existing.status === "ended" || existing.status === "missed" || existing.status === "declined") {
        return existing;
      }

      const resolved = existing.answeredAt === null ? status : "ended";
      setStatus.run(resolved, existing.answeredAt, at, callId);
      return read(callId);
    },

    leave(callId: string, userId: string): void {
      setParticipant.run("left", null, now(), callId, userId);
    },

    /** Hard-deletes expired call records and reports how many went. */
    reap(): number {
      const rows = expiredRows.all(now()) as unknown as { id: string }[];
      for (const row of rows) deleteCall.run(row.id);
      return rows.length;
    },
  };
}
