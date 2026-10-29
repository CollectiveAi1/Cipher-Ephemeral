import { Router } from "express";
import type { Store } from "../../store.ts";
import { authOf } from "../middleware.ts";

/** How many recent calls the history returns. Expired records are already gone. */
const HISTORY_LIMIT = 100;

export function callRoutes(store: Store): Router {
  const router = Router();

  /**
   * Recent calls the caller took part in. There is no archive behind this: a record
   * that has burned is not returned, because it no longer exists.
   */
  router.get("/", (req, res) => {
    const { user } = authOf(req);
    res.json(store.calls.historyFor(user.id, HISTORY_LIMIT));
  });

  return router;
}
