import type { Store } from "../store.ts";
import type { Hub } from "../realtime/hub.ts";
import { logger } from "../logger.ts";

const SWEEP_INTERVAL_MS = 15_000;
const VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard-deletes expired content and tells live clients to purge it. The read path
 * already hides expired messages, so this is about destroying the ciphertext rather
 * than about correctness of reads.
 */
export function startReaper(store: Store, hub: Hub): { sweep: () => number; stop: () => void } {
  let sinceVacuum = 0;

  const sweep = (): number => {
    const batches = store.messages.reap();
    for (const batch of batches) {
      hub.publishExpired(
        batch.conversationId,
        batch.messageIds,
        store.conversations.memberIds(batch.conversationId),
      );
    }

    store.media.reapOrphans();
    store.users.sessions.pruneExpired();
    // Call records burn like messages; clients purge their own history from expiresAt.
    store.calls.reap();

    const destroyed = batches.reduce((total, batch) => total + batch.messageIds.length, 0);
    if (destroyed > 0) logger.info("reaped expired messages", { count: destroyed });

    sinceVacuum += SWEEP_INTERVAL_MS;
    if (sinceVacuum >= VACUUM_INTERVAL_MS) {
      sinceVacuum = 0;
      // Returns the freed pages to the filesystem, so deleted ciphertext is not merely
      // unlinked inside the database file.
      store.db.exec("VACUUM");
    }

    return destroyed;
  };

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();

  return { sweep, stop: () => clearInterval(timer) };
}
