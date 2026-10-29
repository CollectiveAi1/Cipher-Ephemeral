import { Router } from "express";
import { BURN_MODES, CONVERSATION_KINDS, MAX_CIPHERTEXT_BYTES } from "../../../shared/protocol.ts";
import { MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../../../shared/burn-scale.ts";
import type { MemberKey } from "../../repos/conversations.ts";
import type { Store } from "../../store.ts";
import type { Hub } from "../../realtime/hub.ts";
import { clampTtlSeconds } from "../../core/burn.ts";
import { now } from "../../core/time.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { assertAdmin, assertMember } from "../guards.ts";
import { authOf, param, rateLimit } from "../middleware.ts";
import {
  array,
  base64,
  fields,
  int,
  nested,
  nullableId,
  oneOf,
  optionalInt,
  optionalOneOf,
  optionalStr,
  str,
} from "../validate.ts";

const WRAPPED_KEY_BYTES = 1_024;
const MAX_GROUP_MEMBERS = 256;
const PAGE_LIMIT = 50;

/** Parses the per-member wrapped keys a conversation is created with. */
function parseMemberKeys(body: Record<string, unknown>, store: Store): MemberKey[] {
  const raw = array(body, "keys", MAX_GROUP_MEMBERS);
  const seen = new Set<string>();
  return raw.map((entry) => {
    const item = nested(entry, ["userId", "wrappedKey"]);
    const userId = str(item, "userId", { min: 1, max: 64 });
    const wrappedKey = base64(item, "wrappedKey", WRAPPED_KEY_BYTES);
    if (seen.has(userId)) throw badRequest("Duplicate member in keys");
    seen.add(userId);
    if (store.users.findById(userId) === null) throw badRequest(`Unknown member: ${userId}`);
    return { userId, wrappedKey };
  });
}

export function conversationRoutes(store: Store, hub: Hub): Router {
  const router = Router();

  // 30 messages per 10s per account: comfortable for a fast conversation, hostile to a
  // flood. Keyed by account rather than address so a shared NAT is not punished.
  const sendLimit = rateLimit({
    capacity: 30,
    refillPerSecond: 3,
    keyOf: (req) => `send:${req.auth?.user.id ?? "anonymous"}`,
  });

  router.get("/", (req, res) => {
    const { user } = authOf(req);
    res.json(store.conversations.listFor(user.id, hub.presenceOf));
  });

  router.post("/", (req, res) => {
    const { user } = authOf(req);
    const body = fields(req.body, ["kind", "name", "keys", "defaultTtlSeconds", "defaultBurnMode"]);
    const kind = oneOf(body, "kind", CONVERSATION_KINDS);
    const name = optionalStr(body, "name", { min: 1, max: 64 });
    const defaults = {
      defaultTtlSeconds: clampTtlSeconds(int(body, "defaultTtlSeconds", { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS })),
      defaultBurnMode: oneOf(body, "defaultBurnMode", BURN_MODES),
    };
    const keys = parseMemberKeys(body, store);

    if (!keys.some((key) => key.userId === user.id)) {
      throw badRequest("keys must include a wrapped key for the creator");
    }

    let conversationId: string;
    if (kind === "dm") {
      if (keys.length !== 2) throw badRequest("A direct message needs exactly two members");
      const peer = keys.find((key) => key.userId !== user.id);
      if (peer === undefined) throw badRequest("A direct message needs a second member");
      conversationId = store.conversations.createDm(user.id, peer.userId, keys, defaults);
    } else {
      if (name === undefined) throw badRequest("A group needs a name");
      if (keys.length < 2) throw badRequest("A group needs at least two members");
      conversationId = store.conversations.createGroup(user.id, name, keys, defaults);
    }

    const view = store.conversations.view(conversationId, user.id, hub.presenceOf);
    if (view === null) throw notFound("Conversation not found");

    hub.publishConversation(conversationId, store.conversations.memberIds(conversationId), true);
    res.status(201).json(view);
  });

  router.get("/:id", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    assertMember(store, conversationId, user.id);

    const view = store.conversations.view(conversationId, user.id, hub.presenceOf);
    if (view === null) throw notFound("Conversation not found");
    res.json(view);
  });

  router.patch("/:id", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    const role = assertMember(store, conversationId, user.id);

    const body = fields(req.body, ["name", "defaultTtlSeconds", "defaultBurnMode"]);
    const name = optionalStr(body, "name", { min: 1, max: 64 });
    const defaultTtlSeconds = optionalInt(body, "defaultTtlSeconds", {
      min: MIN_TTL_SECONDS,
      max: MAX_TTL_SECONDS,
    });
    const defaultBurnMode = optionalOneOf(body, "defaultBurnMode", BURN_MODES);

    if (name !== undefined && role !== "admin") throw forbidden("Only an admin can rename a conversation");

    store.conversations.patch(conversationId, {
      ...(name === undefined ? {} : { name }),
      ...(defaultTtlSeconds === undefined ? {} : { defaultTtlSeconds: clampTtlSeconds(defaultTtlSeconds) }),
      ...(defaultBurnMode === undefined ? {} : { defaultBurnMode }),
    });

    const view = store.conversations.view(conversationId, user.id, hub.presenceOf);
    if (view === null) throw notFound("Conversation not found");

    hub.publishConversation(conversationId, store.conversations.memberIds(conversationId), false);
    res.json(view);
  });

  router.post("/:id/members", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    assertAdmin(store, conversationId, user.id);

    const body = fields(req.body, ["userId", "wrappedKey"]);
    const userId = str(body, "userId", { min: 1, max: 64 });
    const wrappedKey = base64(body, "wrappedKey", WRAPPED_KEY_BYTES);

    const view = store.conversations.view(conversationId, user.id, hub.presenceOf);
    if (view === null) throw notFound("Conversation not found");
    if (view.kind === "dm") throw badRequest("A direct message cannot take more members");
    if (store.users.findById(userId) === null) throw badRequest("Unknown user");
    if (store.conversations.roleOf(conversationId, userId) !== null) throw conflict("Already a member");

    store.conversations.addMember(conversationId, userId, wrappedKey, user.id);

    const members = store.conversations.memberIds(conversationId);
    hub.publishConversation(conversationId, [userId], true);
    hub.publishConversation(
      conversationId,
      members.filter((id) => id !== userId),
      false,
    );

    // A channel's membership changed, so every community member's view of its channel
    // list is now stale — including the person who was just let in.
    if (view.communityId !== null) hub.publishCommunity(view.communityId);
    res.status(201).json(store.conversations.view(conversationId, user.id, hub.presenceOf));
  });

  router.delete("/:id/members/:userId", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    const targetId = param(req, "userId");
    const role = assertMember(store, conversationId, user.id);

    if (targetId !== user.id && role !== "admin") throw forbidden("Only an admin can remove another member");
    if (store.conversations.roleOf(conversationId, targetId) === null) throw notFound("Not a member");

    store.conversations.removeMember(conversationId, targetId);
    const remaining = store.conversations.memberIds(conversationId);
    if (remaining.length > 0) hub.publishConversation(conversationId, remaining, false);
    res.status(204).end();
  });

  router.get("/:id/messages", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    assertMember(store, conversationId, user.id);

    const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
    res.json(store.messages.page(conversationId, PAGE_LIMIT, cursor));
  });

  router.post("/:id/messages", sendLimit, (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    assertMember(store, conversationId, user.id);

    const body = fields(req.body, ["ciphertext", "iv", "mediaId", "replyToId", "ttlSeconds", "burnMode"]);
    const ciphertext = base64(body, "ciphertext", MAX_CIPHERTEXT_BYTES);
    const iv = base64(body, "iv", 32);
    const mediaId = nullableId(body, "mediaId");
    const replyToId = nullableId(body, "replyToId");
    const requestedTtl = int(body, "ttlSeconds", { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS });
    const burnMode = oneOf(body, "burnMode", BURN_MODES);

    const policy = store.conversations.policyOf(conversationId);
    if (policy !== null && policy.postPolicy === "admins" && policy.communityId !== null) {
      if (store.communities.roleOf(policy.communityId, user.id) !== "admin") {
        throw forbidden("Only community admins can post in this channel");
      }
    }

    // A community's retention ceiling wins over whatever the client asked for, so the
    // policy holds no matter which client sent the message.
    const ceiling = policy?.communityId == null ? null : store.communities.ceilingOf(policy.communityId);
    const ttlSeconds = clampTtlSeconds(ceiling === null ? requestedTtl : Math.min(ceiling, requestedTtl));

    if (mediaId !== null) {
      const blob = store.media.find(mediaId);
      if (blob === null || blob.ownerId !== user.id) throw badRequest("Unknown attachment");
    }

    const message = store.messages.create({
      conversationId,
      senderId: user.id,
      ciphertext,
      iv,
      mediaId,
      replyToId,
      ttlSeconds,
      burnMode,
    });

    store.conversations.touchActivity(conversationId, message.sentAt);
    hub.publishMessage(message, store.conversations.memberIds(conversationId));
    res.status(201).json(message);
  });

  /** Clears the unread badge. Distinct from a per-message read receipt. */
  router.post("/:id/read", (req, res) => {
    const { user } = authOf(req);
    const conversationId = param(req, "id");
    assertMember(store, conversationId, user.id);

    store.conversations.markRead(conversationId, user.id, now());
    res.status(204).end();
  });

  return router;
}
