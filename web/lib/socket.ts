import type { ClientFrame, ServerFrame } from "../../shared/protocol.ts";
import type { ConnectionState } from "./reducer.ts";

const PING_INTERVAL_MS = 25_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/** Round trips used to calibrate the server clock at connect. */
const CLOCK_SAMPLES = 3;

type SocketHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onState: (state: ConnectionState) => void;
  /** Reports the measured `serverTime - clientTime` offset in milliseconds. */
  onClockOffset: (offsetMs: number) => void;
};

/**
 * A WebSocket that re-establishes itself. History is re-fetched over HTTP on reconnect,
 * so dropped frames are a latency problem rather than a correctness one.
 */
export function createSocket(tokenSource: () => string | null, handlers: SocketHandlers) {
  let socket: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let pingTimer: number | null = null;
  let retryTimer: number | null = null;
  let pendingSamples: { sentAt: number }[] = [];
  let offsets: number[] = [];

  const clearTimers = () => {
    if (pingTimer !== null) window.clearInterval(pingTimer);
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    pingTimer = null;
    retryTimer = null;
  };

  const sample = () => {
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    pendingSamples.push({ sentAt: Date.now() });
    socket.send(JSON.stringify({ type: "ping" } satisfies ClientFrame));
  };

  /**
   * Offset from one round trip, assuming symmetric latency. The median of several
   * samples is used so a single slow trip cannot skew every countdown on screen.
   */
  const recordOffset = (serverTime: number) => {
    const sent = pendingSamples.shift();
    if (sent === undefined) return;

    const receivedAt = Date.now();
    offsets.push(serverTime - (sent.sentAt + (receivedAt - sent.sentAt) / 2));
    if (offsets.length < CLOCK_SAMPLES) {
      sample();
      return;
    }

    const sorted = [...offsets].sort((a, b) => a - b);
    handlers.onClockOffset(sorted[Math.floor(sorted.length / 2)] ?? 0);
    offsets = [];
  };

  const scheduleRetry = () => {
    if (closed) return;
    attempts += 1;
    const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    // Jitter keeps a fleet of reconnecting clients from arriving in lockstep.
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    retryTimer = window.setTimeout(connect, delay);
  };

  function connect(): void {
    const token = tokenSource();
    if (closed || token === null) return;

    clearTimers();
    handlers.onState("connecting");

    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const next = new WebSocket(url);
    socket = next;

    next.addEventListener("open", () => {
      // The token goes in the first frame, not the URL, so it stays out of access logs.
      next.send(JSON.stringify({ type: "auth", token } satisfies ClientFrame));
    });

    next.addEventListener("message", (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }

      if (frame.type === "ready") {
        attempts = 0;
        handlers.onState("online");
        pendingSamples = [];
        offsets = [];
        sample();
        pingTimer = window.setInterval(sample, PING_INTERVAL_MS);
      }
      if (frame.type === "pong") {
        recordOffset(frame.serverTime);
        return;
      }

      handlers.onFrame(frame);
    });

    next.addEventListener("close", () => {
      if (socket === next) socket = null;
      clearTimers();
      handlers.onState("offline");
      scheduleRetry();
    });

    next.addEventListener("error", () => next.close());
  }

  return {
    connect,

    send(frame: ClientFrame): void {
      if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    },

    close(): void {
      closed = true;
      clearTimers();
      socket?.close();
      socket = null;
    },
  };
}

export type Socket = ReturnType<typeof createSocket>;
