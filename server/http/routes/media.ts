import { Router, raw } from "express";
import { MAX_MEDIA_BYTES } from "../../../shared/protocol.ts";
import type { Store } from "../../store.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { authOf, param } from "../middleware.ts";

export function mediaRoutes(store: Store): Router {
  const router = Router();

  /**
   * Accepts an already-encrypted blob. The server is told nothing about it beyond its
   * length — no filename, no content type — because it cannot verify either and storing
   * them would leak what the attachment is.
   */
  router.post("/", raw({ type: "application/octet-stream", limit: MAX_MEDIA_BYTES }), (req, res) => {
    const { user } = authOf(req);
    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      throw badRequest("Attachment body must be a non-empty octet stream");
    }
    res.status(201).json({ id: store.media.create(user.id, req.body) });
  });

  router.get("/:id", (req, res) => {
    const { user } = authOf(req);
    const blob = store.media.find(param(req, "id"));
    if (blob === null) throw notFound("Attachment not found or expired");

    // Readable by the uploader, or by a member of the conversation it was sent to.
    const conversationId = store.media.conversationOf(blob.id);
    const permitted =
      blob.ownerId === user.id ||
      (conversationId !== null && store.conversations.roleOf(conversationId, user.id) !== null);
    if (!permitted) throw forbidden("Not permitted");

    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(blob.byteSize));
    res.setHeader("cache-control", "no-store");
    res.end(blob.bytes);
  });

  return router;
}
