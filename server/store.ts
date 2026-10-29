import type { Db } from "./db.ts";
import { createCallRepo } from "./repos/calls.ts";
import { createCommunityRepo } from "./repos/communities.ts";
import { createConversationRepo } from "./repos/conversations.ts";
import { createMediaRepo } from "./repos/media.ts";
import { createMessageRepo } from "./repos/messages.ts";
import { createUserRepo } from "./repos/users.ts";

/** The data layer, with the database handle closed over so nothing else needs it. */
export function createStore(db: Db) {
  const conversations = createConversationRepo(db);
  return {
    db,
    users: createUserRepo(db),
    conversations,
    messages: createMessageRepo(db),
    media: createMediaRepo(db),
    // Communities render their channels as the viewer sees them, so the repo borrows
    // the conversation view rather than duplicating that query.
    communities: createCommunityRepo(db, conversations.view),
    calls: createCallRepo(db),
  };
}

export type Store = ReturnType<typeof createStore>;
