import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerFrame } from "../../shared/protocol.ts";
import { call, createDm, messageBody, registerUser, startTestServer, type TestServer, type TestUser } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

/** Opens a socket and collects every frame it receives. */
function connect(target: TestServer): { socket: WebSocket; frames: ServerFrame[]; opened: Promise<void> } {
  const socket = new WebSocket(`${target.url.replace("http", "ws")}/ws`);
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  const opened = new Promise<void>((resolve) => socket.once("open", () => resolve()));
  return { socket, frames, opened };
}

/**
 * Waits for a frame of the given type, optionally narrowed by a predicate. The live
 * array is polled rather than a copy, so frames that arrive during the wait are seen.
 */
async function waitForFrame<T extends ServerFrame["type"]>(
  frames: ServerFrame[],
  type: T,
  match: (frame: Extract<ServerFrame, { type: T }>) => boolean = () => true,
  timeoutMs = 2_000,
): Promise<Extract<ServerFrame, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(
      (frame): frame is Extract<ServerFrame, { type: T }> =>
        frame.type === type && match(frame as Extract<ServerFrame, { type: T }>),
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for "${type}". Received: ${frames.map((f) => f.type).join(", ") || "nothing"}`);
}

async function authenticate(target: TestServer, user: TestUser) {
  const connection = connect(target);
  await connection.opened;
  connection.socket.send(JSON.stringify({ type: "auth", token: user.token }));
  await waitForFrame(connection.frames, "ready");
  return connection;
}

describe("realtime gateway", () => {
  it("refuses frames before authentication", async () => {
    const connection = connect(server);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "typing", conversationId: "anything" }));

    const error = await waitForFrame(connection.frames, "error");
    expect(error.code).toBe("unauthorized");
    connection.socket.close();
  });

  it("closes a socket that presents an invalid token", async () => {
    const connection = connect(server);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "auth", token: "not.a.token" }));

    const closed = await new Promise<number>((resolve) => connection.socket.once("close", resolve));
    expect(closed).toBe(4001);
  });

  it("reports a malformed frame instead of dropping the connection", async () => {
    const connection = connect(server);
    await connection.opened;
    connection.socket.send("{not json");

    const error = await waitForFrame(connection.frames, "error");
    expect(error.code).toBe("bad_frame");
    connection.socket.close();
  });

  it("delivers a new message to the other member and records delivery", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const bobSocket = await authenticate(server, bob);
    await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody({ ciphertext: btoa("hello") }));

    const frame = await waitForFrame(bobSocket.frames, "message.new");
    expect(frame.message.ciphertext).toBe(btoa("hello"));

    const receipts = server.store.db
      .prepare("SELECT count(*) AS count FROM receipts WHERE user_id = ? AND delivered_at IS NOT NULL")
      .get(bob.id) as { count: number };
    expect(receipts.count).toBe(1);

    bobSocket.socket.close();
  });

  it("answers a ping with the server's clock", async () => {
    const alice = await registerUser(server);
    const connection = await authenticate(server, alice);
    connection.socket.send(JSON.stringify({ type: "ping" }));

    const pong = await waitForFrame(connection.frames, "pong");
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(5_000);
    connection.socket.close();
  });

  it("relays typing only to other members", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const aliceSocket = await authenticate(server, alice);
    const bobSocket = await authenticate(server, bob);
    aliceSocket.socket.send(JSON.stringify({ type: "typing", conversationId: id }));

    const typing = await waitForFrame(bobSocket.frames, "typing");
    expect(typing.userId).toBe(alice.id);
    // The sender never sees their own indicator.
    expect(aliceSocket.frames.some((frame) => frame.type === "typing")).toBe(false);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  it("relays the very first typing frame, however young the process is", async () => {
    // Regression: "never relayed" was stored as 0, which reads as a real timestamp
    // moments after start-up and swallowed the first indicator.
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const aliceSocket = await authenticate(server, alice);
    const bobSocket = await authenticate(server, bob);
    aliceSocket.socket.send(JSON.stringify({ type: "typing", conversationId: id }));

    const typing = await waitForFrame(bobSocket.frames, "typing");
    expect(typing.conversationId).toBe(id);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  it("throttles a burst of typing frames to one relay", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const aliceSocket = await authenticate(server, alice);
    const bobSocket = await authenticate(server, bob);
    for (let i = 0; i < 5; i += 1) {
      aliceSocket.socket.send(JSON.stringify({ type: "typing", conversationId: id }));
    }

    await waitForFrame(bobSocket.frames, "typing");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bobSocket.frames.filter((frame) => frame.type === "typing")).toHaveLength(1);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  it("ignores typing for a conversation the sender is not in", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const outsider = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const bobSocket = await authenticate(server, bob);
    const outsiderSocket = await authenticate(server, outsider);
    outsiderSocket.socket.send(JSON.stringify({ type: "typing", conversationId: id }));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bobSocket.frames.some((frame) => frame.type === "typing")).toBe(false);

    bobSocket.socket.close();
    outsiderSocket.socket.close();
  });

  it("announces presence to people who share a conversation", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    await createDm(server, alice, bob);

    const bobSocket = await authenticate(server, bob);
    const aliceSocket = await authenticate(server, alice);

    const online = await waitForFrame(bobSocket.frames, "presence", (frame) => frame.state === "online");
    expect(online).toMatchObject({ userId: alice.id, state: "online" });

    aliceSocket.socket.close();
    const offline = await waitForFrame(bobSocket.frames, "presence", (frame) => frame.state === "offline");
    expect(offline).toMatchObject({ userId: alice.id, state: "offline" });
    expect(offline.lastSeenAt).toBeTypeOf("number");

    bobSocket.socket.close();
  });

  it("tells members when a message is burned", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);
    const id = await createDm(server, alice, bob);

    const bobSocket = await authenticate(server, bob);
    const sent = (await (
      await call(server, alice, "POST", `/conversations/${id}/messages`, messageBody())
    ).json()) as { id: string };

    await call(server, alice, "DELETE", `/messages/${sent.id}`);

    const expired = await waitForFrame(bobSocket.frames, "message.expired");
    expect(expired.messageIds).toContain(sent.id);
    bobSocket.socket.close();
  });

  it("announces a new conversation to its members", async () => {
    const alice = await registerUser(server);
    const bob = await registerUser(server);

    const bobSocket = await authenticate(server, bob);
    await createDm(server, alice, bob);

    const frame = await waitForFrame(bobSocket.frames, "conversation.new");
    // Each member is sent their own view, carrying the key wrapped for them.
    expect(frame.conversation.wrappedKey).toBe(btoa("wrapped-for-peer"));
    bobSocket.socket.close();
  });
});
