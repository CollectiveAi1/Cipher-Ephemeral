import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../../server/db.ts";
import { createStore, type Store } from "../../server/store.ts";
import { createHub, type Hub } from "../../server/realtime/hub.ts";
import { createApp } from "../../server/http/app.ts";
import { startReaper } from "../../server/core/reaper.ts";

export type TestServer = {
  url: string;
  store: Store;
  hub: Hub;
  /** Runs one reaper pass synchronously and returns how many messages were destroyed. */
  sweep: () => number;
  close: () => Promise<void>;
};

/** Boots the real app against an in-memory database on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
  const db = openDatabase(":memory:");
  const store = createStore(db);
  const hub = createHub(store);
  const server: Server = createServer(createApp(store, hub));

  hub.attach(server);
  const reaper = startReaper(store, hub);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    store,
    hub,
    sweep: reaper.sweep,
    close: async () => {
      reaper.stop();
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

export type TestUser = {
  id: string;
  username: string;
  token: string;
};

let sequence = 0;

/**
 * Registers an account. Key material is opaque to the server, so the tests send
 * placeholder base64 rather than performing real crypto.
 */
export async function registerUser(server: TestServer, username?: string): Promise<TestUser> {
  sequence += 1;
  const name = username ?? `tester${sequence}`;
  const response = await fetch(`${server.url}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: name,
      displayName: `Tester ${sequence}`,
      password: "a-sufficiently-long-password",
      publicKey: btoa(`public-key-${name}`),
      wrappedPrivateKey: btoa(`wrapped-private-${name}`),
      keySalt: btoa("salt-sixteen-byt"),
    }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status}`);

  const session = (await response.json()) as { token: string; user: { id: string } };
  return { id: session.user.id, username: name, token: session.token };
}

/** Authenticated JSON request helper. */
export async function call(
  server: TestServer,
  user: TestUser | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (user !== null) headers["authorization"] = `Bearer ${user.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  return fetch(`${server.url}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Creates a DM between two users with placeholder wrapped keys. */
export async function createDm(server: TestServer, from: TestUser, to: TestUser): Promise<string> {
  const response = await call(server, from, "POST", "/conversations", {
    kind: "dm",
    keys: [
      { userId: from.id, wrappedKey: btoa("wrapped-for-self") },
      { userId: to.id, wrappedKey: btoa("wrapped-for-peer") },
    ],
    defaultTtlSeconds: 3_600,
    defaultBurnMode: "absolute",
  });
  if (!response.ok) throw new Error(`createDm failed: ${response.status}`);
  const conversation = (await response.json()) as { id: string };
  return conversation.id;
}

export function messageBody(overrides: Record<string, unknown> = {}) {
  return {
    ciphertext: btoa("ciphertext-payload"),
    iv: btoa("twelve-byte!"),
    mediaId: null,
    replyToId: null,
    ttlSeconds: 3_600,
    burnMode: "absolute",
    ...overrides,
  };
}
