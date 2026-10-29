import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createDm, messageBody, registerUser, startTestServer, type TestServer, type TestUser } from "./harness.ts";
import type { Community, Conversation, Message, MessagePage } from "../../shared/protocol.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

const createCommunity = async (owner: TestUser, maxTtlSeconds = 3_600): Promise<Community> => {
  const response = await call(server, owner, "POST", "/communities", {
    name: "Project Phoenix",
    description: "Incident coordination",
    maxTtlSeconds,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Community;
};

const addChannel = (owner: TestUser, community: Community, body: Record<string, unknown>) =>
  call(server, owner, "POST", `/communities/${community.id}/channels`, {
    name: "general",
    postPolicy: "all",
    keys: [{ userId: owner.id, wrappedKey: btoa("k1") }],
    defaultTtlSeconds: 3_600,
    defaultBurnMode: "absolute",
    ...body,
  });

describe("communities", () => {
  it("creates a community with the owner as admin", async () => {
    const owner = await registerUser(server);
    const community = await createCommunity(owner);

    expect(community).toMatchObject({ name: "Project Phoenix", role: "admin", memberCount: 1 });
    expect(community.channels).toEqual([]);
    expect(community.members.map((member) => member.id)).toEqual([owner.id]);
  });

  it("hides a community from people who are not members", async () => {
    const owner = await registerUser(server);
    const outsider = await registerUser(server);
    const community = await createCommunity(owner);

    expect((await call(server, outsider, "GET", `/communities/${community.id}`)).status).toBe(404);
    expect((await (await call(server, outsider, "GET", "/communities")).json()) as Community[]).toEqual([]);
  });

  it("lets an admin add members and a member leave", async () => {
    const owner = await registerUser(server);
    const analyst = await registerUser(server);
    const community = await createCommunity(owner);

    const added = await call(server, owner, "POST", `/communities/${community.id}/members`, {
      userId: analyst.id,
      role: "member",
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as Community).memberCount).toBe(2);

    // A plain member cannot add anyone else.
    const third = await registerUser(server);
    expect(
      (await call(server, analyst, "POST", `/communities/${community.id}/members`, {
        userId: third.id,
        role: "member",
      })).status,
    ).toBe(403);

    expect(
      (await call(server, analyst, "DELETE", `/communities/${community.id}/members/${analyst.id}`)).status,
    ).toBe(204);
    expect((await call(server, analyst, "GET", `/communities/${community.id}`)).status).toBe(404);
  });

  it("creates channels that belong to the community", async () => {
    const owner = await registerUser(server);
    const community = await createCommunity(owner);

    const created = await addChannel(owner, community, {});
    const channel = (await created.json()) as Conversation;
    expect(created.status).toBe(201);
    expect(channel).toMatchObject({ kind: "group", communityId: community.id, postPolicy: "all" });

    const refreshed = (await (await call(server, owner, "GET", `/communities/${community.id}`)).json()) as Community;
    expect(refreshed.channels.map((item) => item.id)).toEqual([channel.id]);
  });

  it("refuses a channel member who is not in the community", async () => {
    const owner = await registerUser(server);
    const outsider = await registerUser(server);
    const community = await createCommunity(owner);

    const response = await addChannel(owner, community, {
      keys: [
        { userId: owner.id, wrappedKey: btoa("k1") },
        { userId: outsider.id, wrappedKey: btoa("k2") },
      ],
    });
    expect(response.status).toBe(400);
  });
});

describe("retention ceiling", () => {
  it("clamps a channel's default lifespan to the community policy", async () => {
    const owner = await registerUser(server);
    const community = await createCommunity(owner, 300);

    const channel = (await (await addChannel(owner, community, { defaultTtlSeconds: 604_800 })).json()) as Conversation;
    expect(channel.defaultTtlSeconds).toBe(300);
  });

  it("clamps a message no matter what lifespan the client asks for", async () => {
    const owner = await registerUser(server);
    const community = await createCommunity(owner, 300);
    const channel = (await (await addChannel(owner, community, {})).json()) as Conversation;

    const sent = (await (
      await call(server, owner, "POST", `/conversations/${channel.id}/messages`, messageBody({ ttlSeconds: 604_800 }))
    ).json()) as Message;

    expect(sent.ttlSeconds).toBe(300);
    expect(sent.expiresAt).toBeLessThanOrEqual(sent.sentAt + 300_000);
  });

  it("leaves conversations outside a community alone", async () => {
    const owner = await registerUser(server);
    const peer = await registerUser(server);
    await createCommunity(owner, 300);
    const dm = await createDm(server, owner, peer);

    const sent = (await (
      await call(server, owner, "POST", `/conversations/${dm}/messages`, messageBody({ ttlSeconds: 86_400 }))
    ).json()) as Message;
    expect(sent.ttlSeconds).toBe(86_400);
  });

  it("applies a lowered ceiling to new messages only", async () => {
    const owner = await registerUser(server);
    const community = await createCommunity(owner, 86_400);
    const channel = (await (await addChannel(owner, community, { defaultTtlSeconds: 86_400 })).json()) as Conversation;

    const before = (await (
      await call(server, owner, "POST", `/conversations/${channel.id}/messages`, messageBody({ ttlSeconds: 86_400 }))
    ).json()) as Message;

    await call(server, owner, "PATCH", `/communities/${community.id}`, { maxTtlSeconds: 300 });

    const after = (await (
      await call(server, owner, "POST", `/conversations/${channel.id}/messages`, messageBody({ ttlSeconds: 86_400 }))
    ).json()) as Message;

    // The earlier message keeps the lifespan its sender was promised.
    expect(before.ttlSeconds).toBe(86_400);
    expect(after.ttlSeconds).toBe(300);
  });
});

describe("announcement channels", () => {
  it("accepts posts from admins and refuses them from members", async () => {
    const owner = await registerUser(server);
    const analyst = await registerUser(server);
    const community = await createCommunity(owner);
    await call(server, owner, "POST", `/communities/${community.id}/members`, { userId: analyst.id, role: "member" });

    const channel = (await (
      await addChannel(owner, community, {
        name: "announcements",
        postPolicy: "admins",
        keys: [
          { userId: owner.id, wrappedKey: btoa("k1") },
          { userId: analyst.id, wrappedKey: btoa("k2") },
        ],
      })
    ).json()) as Conversation;

    expect(
      (await call(server, owner, "POST", `/conversations/${channel.id}/messages`, messageBody())).status,
    ).toBe(201);
    expect(
      (await call(server, analyst, "POST", `/conversations/${channel.id}/messages`, messageBody())).status,
    ).toBe(403);

    // The member can still read it.
    const page = (await (await call(server, analyst, "GET", `/conversations/${channel.id}/messages`)).json()) as MessagePage;
    expect(page.messages).toHaveLength(1);
  });
});
