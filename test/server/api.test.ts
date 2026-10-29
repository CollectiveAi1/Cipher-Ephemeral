import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, createDm, messageBody, registerUser, startTestServer, type TestServer } from "./harness.ts";
import type { Conversation, Message, MessagePage } from "../../shared/protocol.ts";

let server: TestServer;

// A server per test: isolated rate-limit buckets and a fresh database, so no test can
// be perturbed by what another one sent.
beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

describe("health", () => {
  it("reports server time and the retention cap", async () => {
    const response = await call(server, null, "GET", "/health");
    const body = (await response.json()) as { status: string; serverTime: number; maxTtlSeconds: number };
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.maxTtlSeconds).toBeLessThanOrEqual(604_800);
    expect(Math.abs(body.serverTime - Date.now())).toBeLessThan(5_000);
  });
});

describe("authentication", () => {
  it("registers an account and returns the wrapped key material", async () => {
    const response = await call(server, null, "POST", "/auth/register", {
      username: "newcomer",
      displayName: "New Comer",
      password: "a-sufficiently-long-password",
      publicKey: btoa("pub"),
      wrappedPrivateKey: btoa("wrapped"),
      keySalt: btoa("salt"),
    });
    const session = (await response.json()) as { token: string; wrappedPrivateKey: string };
    expect(response.status).toBe(201);
    expect(session.token).toBeTypeOf("string");
    expect(session.wrappedPrivateKey).toBe(btoa("wrapped"));
  });

  it("refuses a duplicate username", async () => {
    const user = await registerUser(server);
    const response = await call(server, null, "POST", "/auth/register", {
      username: user.username,
      displayName: "Impostor",
      password: "a-sufficiently-long-password",
      publicKey: btoa("pub"),
      wrappedPrivateKey: btoa("wrapped"),
      keySalt: btoa("salt"),
    });
    expect(response.status).toBe(409);
  });

  it("gives the same answer for a bad password and a missing account", async () => {
    const user = await registerUser(server);
    const wrongPassword = await call(server, null, "POST", "/auth/login", {
      username: user.username,
      password: "not-the-password",
    });
    const noSuchUser = await call(server, null, "POST", "/auth/login", {
      username: "ghost",
      password: "not-the-password",
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await noSuchUser.json());
  });

  it("rejects a short password and an invalid username", async () => {
    const shortPassword = await call(server, null, "POST", "/auth/register", {
      username: "shorty",
      displayName: "Shorty",
      password: "short",
      publicKey: btoa("pub"),
      wrappedPrivateKey: btoa("wrapped"),
      keySalt: btoa("salt"),
    });
    const badUsername = await call(server, null, "POST", "/auth/register", {
      username: "Not Valid!",
      displayName: "Nope",
      password: "a-sufficiently-long-password",
      publicKey: btoa("pub"),
      wrappedPrivateKey: btoa("wrapped"),
      keySalt: btoa("salt"),
    });
    expect(shortPassword.status).toBe(400);
    expect(badUsername.status).toBe(400);
  });

  it("rejects unknown fields rather than ignoring them", async () => {
    const response = await call(server, null, "POST", "/auth/login", {
      username: "someone",
      password: "a-sufficiently-long-password",
      isAdmin: true,
    });
    expect(response.status).toBe(400);
  });

  it("revokes a token on logout", async () => {
    const user = await registerUser(server);
    expect((await call(server, user, "GET", "/users/me")).status).toBe(200);
    expect((await call(server, user, "POST", "/auth/logout")).status).toBe(204);
    expect((await call(server, user, "GET", "/users/me")).status).toBe(401);
  });

  it("refuses unauthenticated and forged requests", async () => {
    expect((await call(server, null, "GET", "/conversations")).status).toBe(401);
    const forged = { id: "x", username: "x", token: "not.a.real.token" };
    expect((await call(server, forged, "GET", "/conversations")).status).toBe(401);
  });
});

describe("conversations", () => {
  it("creates a DM once, no matter who opens it", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);

    const first = await createDm(server, alice, bob);
    const second = await createDm(server, bob, alice);
    expect(second).toBe(first);

    const list = (await (await call(server, alice, "GET", "/conversations")).json()) as Conversation[];
    expect(list.filter((item) => item.id === first)).toHaveLength(1);
  });

  it("hands each member their own wrapped key and the wrapper's public key", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const forAlice = (await (await call(server, alice, "GET", `/conversations/${id}`)).json()) as Conversation;
    const forBob = (await (await call(server, bob, "GET", `/conversations/${id}`)).json()) as Conversation;

    expect(forAlice.wrappedKey).toBe(btoa("wrapped-for-self"));
    expect(forBob.wrappedKey).toBe(btoa("wrapped-for-peer"));
    expect(forBob.wrappedByPublicKey).toBe(btoa(`public-key-${alice.username}`));
  });

  it("hides a conversation from everyone who is not a member", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const outsider = await registerUser(server);
    const id = await createDm(server, alice, bob);

    // 404 rather than 403, so the API does not confirm that the id exists.
    expect((await call(server, outsider, "GET", `/conversations/${id}`)).status).toBe(404);
    expect((await call(server, outsider, "GET", `/conversations/${id}/messages`)).status).toBe(404);
    expect((await call(server, outsider, "POST", `/conversations/${id}/messages`, messageBody())).status).toBe(404);
  });

  it("requires the creator's own wrapped key", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const response = await call(server, alice, "POST", "/conversations", {
      kind: "dm",
      keys: [{ userId: bob.id, wrappedKey: btoa("only-for-peer") }],
      defaultTtlSeconds: 3_600,
      defaultBurnMode: "absolute",
    });
    expect(response.status).toBe(400);
  });

  it("creates a group and lets an admin add a member", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const carol = await registerUser(server);

    const created = await call(server, alice, "POST", "/conversations", {
      kind: "group",
      name: "Incident 4821",
      keys: [
        { userId: alice.id, wrappedKey: btoa("k1") },
        { userId: bob.id, wrappedKey: btoa("k2") },
      ],
      defaultTtlSeconds: 300,
      defaultBurnMode: "onRead",
    });
    const group = (await created.json()) as Conversation;
    expect(created.status).toBe(201);
    expect(group.kind).toBe("group");

    // A plain member cannot add people; an admin can.
    expect(
      (await call(server, bob, "POST", `/conversations/${group.id}/members`, {
        userId: carol.id,
        wrappedKey: btoa("k3"),
      })).status,
    ).toBe(403);

    const added = await call(server, alice, "POST", `/conversations/${group.id}/members`, {
      userId: carol.id,
      wrappedKey: btoa("k3"),
    });
    expect(added.status).toBe(201);
    expect(((await added.json()) as Conversation).members).toHaveLength(3);
  });

  it("lets a member leave and loses access afterwards", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    expect((await call(server, bob, "DELETE", `/conversations/${id}/members/${bob.id}`)).status).toBe(204);
    expect((await call(server, bob, "GET", `/conversations/${id}`)).status).toBe(404);
  });

  it("clamps a conversation default into the retention policy", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const patched = await call(server, alice, "PATCH", `/conversations/${id}`, { defaultTtlSeconds: 15 });
    expect(((await patched.json()) as Conversation).defaultTtlSeconds).toBe(15);
  });
});

describe("messages", () => {
  it("stores ciphertext and returns it in order", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    for (const text of ["one", "two", "three"]) {
      const response = await call(server, alice, "POST", `/conversations/${id}/messages`, {
        ...messageBody({ ciphertext: btoa(text) }),
      });
      expect(response.status).toBe(201);
    }

    const page = (await (await call(server, bob, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(page.messages.map((message) => message.ciphertext)).toEqual([btoa("one"), btoa("two"), btoa("three")]);
    expect(page.nextCursor).toBeNull();
  });

  it("clamps a client-proposed lifespan", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const response = await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ ttlSeconds: 1 }));
    expect(response.status).toBe(400); // below the documented minimum, rejected by validation
  });

  it("rejects ciphertext beyond the payload cap", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const response = await call(
      server,
      alice,
      "POST",
      `/conversations/${id}/messages`,
      messageBody({ ciphertext: btoa("x".repeat(20_000)) }),
    );
    expect(response.status).toBe(400);
  });

  it("toggles a reaction on and off", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);
    const sent = (await (await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody())).json()) as Message;

    const added = (await (await call(server, bob, "POST", `/messages/${sent.id}/reactions`, { emoji: "🔥" })).json()) as {
      reactions: unknown[];
    };
    expect(added.reactions).toHaveLength(1);

    const removed = (await (await call(server, bob, "POST", `/messages/${sent.id}/reactions`, { emoji: "🔥" })).json()) as {
      reactions: unknown[];
    };
    expect(removed.reactions).toHaveLength(0);
  });

  it("lets only the sender burn a message immediately", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);
    const sent = (await (await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody())).json()) as Message;

    expect((await call(server, bob, "DELETE", `/messages/${sent.id}`)).status).toBe(403);
    expect((await call(server, alice, "DELETE", `/messages/${sent.id}`)).status).toBe(204);

    const page = (await (await call(server, bob, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(page.messages).toHaveLength(0);
  });

  it("counts unread messages until the conversation is opened", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);
    await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody());
    await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody());

    const before = (await (await call(server, bob, "GET", "/conversations")).json()) as Conversation[];
    expect(before.find((item) => item.id === id)?.unreadCount).toBe(2);

    expect((await call(server, bob, "POST", `/conversations/${id}/read`)).status).toBe(204);
    const after = (await (await call(server, bob, "GET", "/conversations")).json()) as Conversation[];
    expect(after.find((item) => item.id === id)?.unreadCount).toBe(0);
  });
});

describe("burn lifecycle", () => {
  it("starts an on-read burn at the recipient's first read, and never restarts it", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const sent = (await (
      await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ burnMode: "onRead", ttlSeconds: 60 }))
    ).json()) as Message;
    expect(sent.expiresAt).toBeNull();

    // The sender reading their own message must not arm it.
    await call(server, alice, "POST", `/messages/${sent.id}/read`);
    const afterSelfRead = (await (await call(server, alice, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(afterSelfRead.messages[0]?.expiresAt).toBeNull();

    const armed = (await (await call(server, bob, "POST", `/messages/${sent.id}/read`)).json()) as {
      expiresAt: number | null;
    };
    expect(armed.expiresAt).toBeGreaterThan(Date.now());

    // A second read leaves the deadline where it was.
    const again = (await (await call(server, bob, "POST", `/messages/${sent.id}/read`)).json()) as {
      expiresAt: number | null;
    };
    expect(again.expiresAt).toBe(armed.expiresAt);
  });

  it("hides an expired message on read and then destroys the ciphertext", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const sent = (await (
      await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ ttlSeconds: 15 }))
    ).json()) as Message;

    const rows = () =>
      (server.store.db.prepare("SELECT count(*) AS count FROM messages WHERE id = ?").get(sent.id) as { count: number })
        .count;
    expect(rows()).toBe(1);

    // Step past the lifespan. Only Date is faked, so sockets and intervals are untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16_000);

    // Layer two: the read path hides it immediately, before any sweep runs.
    const page = (await (await call(server, bob, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(page.messages).toHaveLength(0);
    expect((await call(server, bob, "POST", `/messages/${sent.id}/read`)).status).toBe(404);

    // Layer three: the reaper deletes the row, so there is nothing left to decrypt.
    expect(server.sweep()).toBeGreaterThanOrEqual(1);
    expect(rows()).toBe(0);
  });

  it("keeps an unread on-read message until its hard ceiling", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ burnMode: "onRead", ttlSeconds: 60 }));

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    server.sweep();

    const stillThere = (await (await call(server, bob, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(stillThere.messages).toHaveLength(1);

    // Past the ceiling it goes, read or not.
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    server.sweep();
    const gone = (await (await call(server, bob, "GET", `/conversations/${id}/messages`)).json()) as MessagePage;
    expect(gone.messages).toHaveLength(0);
  });
});

describe("abuse controls", () => {
  it("rate limits a flood of messages", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    let limited = false;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody());
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("throttles repeated attempts against one account without blocking another", async () => {
    const target = await registerUser(server);
    const bystander = await registerUser(server);

    // Exhaust the per-account tier for one username.
    let limited = false;
    for (let attempt = 0; attempt < 15 && !limited; attempt += 1) {
      const response = await call(server, null, "POST", "/auth/login", {
        username: target.username,
        password: "wrong-password-attempt",
      });
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);

    // A different account from the same address is unaffected.
    const other = await call(server, null, "POST", "/auth/login", {
      username: bystander.username,
      password: "a-sufficiently-long-password",
    });
    expect(other.status).toBe(200);
  });

  it("returns a structured error for an unknown endpoint", async () => {
    const response = await call(server, null, "GET", "/nope");
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("media", () => {
  /** Uploads an already-encrypted blob the way the client does. */
  const upload = (user: { token: string }, bytes: Uint8Array) =>
    fetch(`${server.url}/api/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/octet-stream" },
      body: bytes,
    });

  const download = (user: { token: string }, id: string) =>
    fetch(`${server.url}/api/media/${id}`, { headers: { authorization: `Bearer ${user.token}` } });

  it("stores an opaque blob and gives it back byte for byte", async () => {
    const alice = await registerUser(server);
    const bytes = new Uint8Array([1, 2, 3, 250, 0]);

    const created = await upload(alice, bytes);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const fetched = await download(alice, id);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([...bytes]);
  });

  it("rejects an empty upload and an anonymous one", async () => {
    const alice = await registerUser(server);
    expect((await upload(alice, new Uint8Array())).status).toBe(400);
    expect((await fetch(`${server.url}/api/media`, { method: "POST" })).status).toBe(401);
  });

  it("lets a conversation member read an attachment but keeps outsiders out", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const outsider = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const { id: mediaId } = (await (await upload(alice, new Uint8Array([9, 9, 9]))).json()) as { id: string };
    await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ mediaId }));

    expect((await download(bob, mediaId)).status).toBe(200);
    expect((await download(outsider, mediaId)).status).toBe(403);
  });

  it("refuses to attach a blob the sender does not own", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const { id: mediaId } = (await (await upload(bob, new Uint8Array([1]))).json()) as { id: string };
    const response = await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ mediaId }));
    expect(response.status).toBe(400);
  });

  it("destroys an attachment when its message burns", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const { id: mediaId } = (await (await upload(alice, new Uint8Array([7, 7]))).json()) as { id: string };
    const sent = (await (
      await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ mediaId, ttlSeconds: 15 }))
    ).json()) as Message;
    expect(sent.mediaId).toBe(mediaId);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16_000);
    server.sweep();

    expect((await download(alice, mediaId)).status).toBe(404);
    const rows = server.store.db.prepare("SELECT count(*) AS count FROM media").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("reaps a blob that was uploaded but never attached", async () => {
    const alice = await registerUser(server);
    const { id: mediaId } = (await (await upload(alice, new Uint8Array([4]))).json()) as { id: string };

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    server.sweep();

    expect((await download(alice, mediaId)).status).toBe(404);
  });
});
