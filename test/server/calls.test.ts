import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Call, ServerFrame } from "../../shared/protocol.ts";
import { call, createDm, registerUser, startTestServer, type TestServer, type TestUser } from "./harness.ts";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

type Connection = { socket: WebSocket; frames: ServerFrame[] };

async function authenticate(user: TestUser): Promise<Connection> {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}/ws`);
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(JSON.stringify({ type: "auth", token: user.token }));
  await waitFor(frames, "ready");
  return { socket, frames };
}

async function waitFor<T extends ServerFrame["type"]>(
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

/** Sets up a DM with both parties connected and the caller ringing. */
async function ringing() {
  const caller = await registerUser(server);
  const callee = await registerUser(server);
  const conversationId = await createDm(server, caller, callee);

  const callerSocket = await authenticate(caller);
  const calleeSocket = await authenticate(callee);
  callerSocket.socket.send(JSON.stringify({ type: "call.invite", conversationId, kind: "audio" }));

  const incoming = await waitFor(calleeSocket.frames, "call.incoming");
  return { caller, callee, conversationId, callerSocket, calleeSocket, call: incoming.call };
}

describe("call signalling", () => {
  it("rings the other party and reports the call to the caller", async () => {
    const session = await ringing();

    expect(session.call).toMatchObject({ status: "ringing", kind: "audio", initiatorId: session.caller.id });
    expect(session.call.participants).toHaveLength(2);

    const mine = await waitFor(session.callerSocket.frames, "call.updated");
    expect(mine.call.id).toBe(session.call.id);

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("connects when the callee accepts", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.accept", callId: session.call.id }));

    const active = await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.status === "active");
    expect(active.call.answeredAt).toBeTypeOf("number");
    expect(active.call.participants.every((p) => p.state === "joined")).toBe(true);

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("relays a sealed signal to the peer without the server reading it", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.accept", callId: session.call.id }));
    await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.status === "active");

    session.callerSocket.socket.send(
      JSON.stringify({ type: "call.signal", callId: session.call.id, payload: btoa("sealed-sdp"), iv: btoa("iv") }),
    );

    const relayed = await waitFor(session.calleeSocket.frames, "call.signal");
    expect(relayed).toMatchObject({ fromUserId: session.caller.id, payload: btoa("sealed-sdp") });
    // The sender never receives their own signal back.
    expect(session.callerSocket.frames.some((frame) => frame.type === "call.signal")).toBe(false);

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("records a decline", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.decline", callId: session.call.id }));

    const declined = await waitFor(
      session.callerSocket.frames,
      "call.updated",
      (frame) => frame.call.status === "declined",
    );
    expect(declined.call.endedAt).toBeTypeOf("number");

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("marks an unanswered call missed when the caller gives up", async () => {
    const session = await ringing();
    session.callerSocket.socket.send(JSON.stringify({ type: "call.end", callId: session.call.id }));

    const missed = await waitFor(session.calleeSocket.frames, "call.updated", (frame) => frame.call.status === "missed");
    expect(missed.call.answeredAt).toBeNull();

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("ends a connected call rather than marking it missed", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.accept", callId: session.call.id }));
    await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.status === "active");

    session.callerSocket.socket.send(JSON.stringify({ type: "call.end", callId: session.call.id }));
    const ended = await waitFor(session.calleeSocket.frames, "call.updated", (frame) => frame.call.status === "ended");
    expect(ended.call.answeredAt).toBeTypeOf("number");

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("refuses a second call in the same conversation", async () => {
    const session = await ringing();
    session.callerSocket.socket.send(
      JSON.stringify({ type: "call.invite", conversationId: session.conversationId, kind: "video" }),
    );

    const error = await waitFor(session.callerSocket.frames, "error");
    expect(error.code).toBe("conflict");

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("refuses to call a conversation the caller is not in", async () => {
    const outsider = await registerUser(server);
    const a = await registerUser(server);
    const b = await registerUser(server);
    const conversationId = await createDm(server, a, b);

    const socket = await authenticate(outsider);
    socket.socket.send(JSON.stringify({ type: "call.invite", conversationId, kind: "audio" }));

    const error = await waitFor(socket.frames, "error");
    expect(error.code).toBe("not_found");
    socket.socket.close();
  });

  it("refuses to relay a signal for a call the sender is not party to", async () => {
    const session = await ringing();
    const outsider = await registerUser(server);
    const outsiderSocket = await authenticate(outsider);

    outsiderSocket.socket.send(
      JSON.stringify({ type: "call.signal", callId: session.call.id, payload: btoa("x"), iv: btoa("iv") }),
    );
    const error = await waitFor(outsiderSocket.frames, "error");
    expect(error.code).toBe("not_found");

    outsiderSocket.socket.close();
    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("ends a call when a party drops offline", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.accept", callId: session.call.id }));
    await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.status === "active");

    session.calleeSocket.socket.close();
    const ended = await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.endedAt !== null);
    expect(ended.call.status).toBe("ended");

    session.callerSocket.socket.close();
  });
});

describe("call history", () => {
  it("lists calls the user took part in", async () => {
    const session = await ringing();
    session.calleeSocket.socket.send(JSON.stringify({ type: "call.accept", callId: session.call.id }));
    await waitFor(session.callerSocket.frames, "call.updated", (frame) => frame.call.status === "active");

    const history = (await (await call(server, session.callee, "GET", "/calls")).json()) as Call[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: session.call.id, status: "active" });

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("keeps a call record out of an unrelated user's history", async () => {
    const session = await ringing();
    const outsider = await registerUser(server);

    const history = (await (await call(server, outsider, "GET", "/calls")).json()) as Call[];
    expect(history).toEqual([]);

    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();
  });

  it("burns the call record once its lifespan passes", async () => {
    const session = await ringing();
    session.callerSocket.socket.close();
    session.calleeSocket.socket.close();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);

    // Gone from the read path immediately, and physically deleted by the sweep.
    expect((await (await call(server, session.callee, "GET", "/calls")).json()) as Call[]).toEqual([]);
    server.sweep();
    const rows = server.store.db.prepare("SELECT count(*) AS count FROM calls").get() as { count: number };
    expect(rows.count).toBe(0);
  });
});
