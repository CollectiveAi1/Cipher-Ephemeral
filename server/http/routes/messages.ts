import { Router } from "express";
import type { Store } from "../../store.ts";
import type { Hub } from "../../realtime/hub.ts";
import { forbidden, notFound } from "../errors.ts";
import { assertMember } from "../guards.ts";
import { authOf, param } from "../middleware.ts";
import { fields, str } from "../validate.ts";

/** Emoji are short; the cap keeps a reaction from becoming a second message body. */
const MAX_EMOJI_LENGTH = 16;

export function messageRoutes(store: Store, hub: Hub): Router {
  const router = Router();

  /**
   * Acknowledges that the client decrypted and displayed a message. This is what starts
   * an on-read burn, so it is an explicit call rather than something inferred from a fetch.
   */
  router.post("/:id/read", (req, res) => {
    const { user } = authOf(req);
    const message = store.messages.findAlive(param(req, "id"));
    if (message === null) throw notFound("Message not found");
    assertMember(store, message.conversationId, user.id);

    const result = store.messages.markRead(message.id, user.id);
    if (result === null) throw notFound("Message not found");

    hub.publishRead(
      message.conversationId,
      message.id,
      user.id,
      result.expiresAt,
      store.conversations.memberIds(message.conversationId),
    );
    res.json({ expiresAt: result.expiresAt });
  });

  router.post("/:id/reactions", (req, res) => {
    const { user } = authOf(req);
    const message = store.messages.findAlive(param(req, "id"));
    if (message === null) throw notFound("Message not found");
    assertMember(store, message.conversationId, user.id);

    const body = fields(req.body, ["emoji"]);
    const emoji = str(body, "emoji", { min: 1, max: MAX_EMOJI_LENGTH });

    const reactions = store.messages.toggleReaction(message.id, user.id, emoji);
    hub.publishReactions(
      message.conversationId,
      message.id,
      reactions,
      store.conversations.memberIds(message.conversationId),
    );
    res.json({ reactions });
  });

  /** Immediate burn by the sender. Everyone's copy goes, not just the sender's view. */
  router.delete("/:id", (req, res) => {
    const { user } = authOf(req);
    const message = store.messages.findAlive(param(req, "id"));
    if (message === null) throw notFound("Message not found");
    if (message.senderId !== user.id) throw forbidden("Only the sender can burn a message");

    const members = store.conversations.memberIds(message.conversationId);
    store.messages.destroy(message.id);
    hub.publishExpired(message.conversationId, [message.id], members);
    res.status(204).end();
  });

  return router;
}
