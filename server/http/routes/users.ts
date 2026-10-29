import { Router } from "express";
import type { Store } from "../../store.ts";
import { toPublicUser } from "../../repos/users.ts";
import { authOf } from "../middleware.ts";

export function userRoutes(store: Store): Router {
  const router = Router();

  router.get("/me", (req, res) => {
    res.json(toPublicUser(authOf(req).user));
  });

  /** Directory used to start a conversation. Returns public key material by design. */
  router.get("/", (req, res) => {
    const { user } = authOf(req);
    const query = typeof req.query["q"] === "string" ? req.query["q"].slice(0, 48) : "";
    res.json(store.users.directory(query, user.id));
  });

  return router;
}
