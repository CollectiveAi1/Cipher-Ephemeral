import { Router } from "express";
import { BURN_MODES } from "../../../shared/protocol.ts";
import { MAX_TTL_SECONDS, MIN_TTL_SECONDS } from "../../../shared/burn-scale.ts";
import type { Store } from "../../store.ts";
import type { Hub } from "../../realtime/hub.ts";
import { clampTtlSeconds } from "../../core/burn.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { authOf, param } from "../middleware.ts";
import { array, base64, fields, int, nested, oneOf, optionalInt, optionalStr, str } from "../validate.ts";

const WRAPPED_KEY_BYTES = 1_024;
const MAX_CHANNEL_MEMBERS = 256;

/** Reads the caller's community role, 404-ing rather than confirming the id exists. */
function assertCommunityMember(store: Store, communityId: string, userId: string): "admin" | "member" {
  const role = store.communities.roleOf(communityId, userId);
  if (role === null) throw notFound("Community not found");
  return role;
}

function assertCommunityAdmin(store: Store, communityId: string, userId: string): void {
  if (assertCommunityMember(store, communityId, userId) !== "admin") {
    throw forbidden("Only a community admin can do that");
  }
}

export function communityRoutes(store: Store, hub: Hub): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const { user } = authOf(req);
    res.json(store.communities.listFor(user.id, hub.presenceOf));
  });

  router.post("/", (req, res) => {
    const { user } = authOf(req);
    const body = fields(req.body, ["name", "description", "maxTtlSeconds"]);
    const name = str(body, "name", { min: 1, max: 64 });
    const description = optionalStr(body, "description", { min: 0, max: 280 }) ?? "";
    const maxTtlSeconds = clampTtlSeconds(int(body, "maxTtlSeconds", { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS }));

    const id = store.communities.create(user.id, { name, description, maxTtlSeconds });
    const view = store.communities.view(id, user.id, hub.presenceOf);
    if (view === null) throw notFound("Community not found");

    res.status(201).json(view);
  });

  router.get("/:id", (req, res) => {
    const { user } = authOf(req);
    const communityId = param(req, "id");
    assertCommunityMember(store, communityId, user.id);

    const view = store.communities.view(communityId, user.id, hub.presenceOf);
    if (view === null) throw notFound("Community not found");
    res.json(view);
  });

  router.patch("/:id", (req, res) => {
    const { user } = authOf(req);
    const communityId = param(req, "id");
    assertCommunityAdmin(store, communityId, user.id);

    const body = fields(req.body, ["name", "description", "maxTtlSeconds"]);
    const name = optionalStr(body, "name", { min: 1, max: 64 });
    const description = optionalStr(body, "description", { min: 0, max: 280 });
    const maxTtlSeconds = optionalInt(body, "maxTtlSeconds", { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS });

    store.communities.patch(communityId, {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      // Lowering the ceiling binds every future message; messages already sent keep the
      // lifespan their sender was promised.
      ...(maxTtlSeconds === undefined ? {} : { maxTtlSeconds: clampTtlSeconds(maxTtlSeconds) }),
    });

    hub.publishCommunity(communityId);
    res.json(store.communities.view(communityId, user.id, hub.presenceOf));
  });

  router.post("/:id/members", (req, res) => {
    const { user } = authOf(req);
    const communityId = param(req, "id");
    assertCommunityAdmin(store, communityId, user.id);

    const body = fields(req.body, ["userId", "role"]);
    const userId = str(body, "userId", { min: 1, max: 64 });
    const role = oneOf(body, "role", ["admin", "member"] as const);

    if (store.users.findById(userId) === null) throw badRequest("Unknown user");
    if (store.communities.roleOf(communityId, userId) !== null) throw conflict("Already a member");

    store.communities.addMember(communityId, userId, role);
    hub.publishCommunity(communityId);
    res.status(201).json(store.communities.view(communityId, user.id, hub.presenceOf));
  });

  router.delete("/:id/members/:userId", (req, res) => {
    const { user } = authOf(req);
    const communityId = param(req, "id");
    const targetId = param(req, "userId");
    const role = assertCommunityMember(store, communityId, user.id);

    if (targetId !== user.id && role !== "admin") throw forbidden("Only an admin can remove another member");
    if (store.communities.roleOf(communityId, targetId) === null) throw notFound("Not a member");

    store.communities.removeMember(communityId, targetId);
    hub.publishCommunity(communityId);
    res.status(204).end();
  });

  /**
   * Creates a channel inside the community. The channel is a group conversation, so it
   * carries its own conversation key wrapped per member exactly like any other.
   */
  router.post("/:id/channels", (req, res) => {
    const { user } = authOf(req);
    const communityId = param(req, "id");
    assertCommunityAdmin(store, communityId, user.id);

    const body = fields(req.body, ["name", "postPolicy", "keys", "defaultTtlSeconds", "defaultBurnMode"]);
    const name = str(body, "name", { min: 1, max: 64 });
    const postPolicy = oneOf(body, "postPolicy", ["all", "admins"] as const);
    const defaultBurnMode = oneOf(body, "defaultBurnMode", BURN_MODES);
    const requestedTtl = int(body, "defaultTtlSeconds", { min: MIN_TTL_SECONDS, max: MAX_TTL_SECONDS });

    const ceiling = store.communities.ceilingOf(communityId);
    if (ceiling === null) throw notFound("Community not found");
    const defaultTtlSeconds = clampTtlSeconds(Math.min(ceiling, requestedTtl));

    const raw = array(body, "keys", MAX_CHANNEL_MEMBERS);
    const seen = new Set<string>();
    const keys = raw.map((entry) => {
      const item = nested(entry, ["userId", "wrappedKey"]);
      const userId = str(item, "userId", { min: 1, max: 64 });
      const wrappedKey = base64(item, "wrappedKey", WRAPPED_KEY_BYTES);
      if (seen.has(userId)) throw badRequest("Duplicate member in keys");
      seen.add(userId);
      if (store.communities.roleOf(communityId, userId) === null) {
        throw badRequest("Every channel member must belong to the community");
      }
      return { userId, wrappedKey };
    });

    if (!keys.some((key) => key.userId === user.id)) {
      throw badRequest("keys must include a wrapped key for the creator");
    }

    const channelId = store.conversations.createGroup(
      user.id,
      name,
      keys,
      { defaultTtlSeconds, defaultBurnMode },
      { communityId, postPolicy },
    );

    hub.publishConversation(channelId, store.conversations.memberIds(channelId), true);
    hub.publishCommunity(communityId);
    res.status(201).json(store.conversations.view(channelId, user.id, hub.presenceOf));
  });

  return router;
}
