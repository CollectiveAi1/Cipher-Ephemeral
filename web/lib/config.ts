/**
 * Where the API lives.
 *
 * Empty means same-origin, which is how the single-process deployment runs. When the
 * UI is hosted separately (Vercel) from the server (a host that can run a persistent
 * process), `VITE_API_ORIGIN` points the client at that server. It is read at build
 * time, so changing it means rebuilding the UI.
 */
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");

/** Absolute URL for an API path. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api${path}`;
}

/** WebSocket URL for the realtime gateway, matching the API origin. */
export function socketUrl(): string {
  const base = API_ORIGIN === "" ? window.location.href : API_ORIGIN;
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
