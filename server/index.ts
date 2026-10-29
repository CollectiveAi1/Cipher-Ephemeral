import { createServer } from "node:http";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { openDatabase } from "./db.ts";
import { createStore } from "./store.ts";
import { createHub } from "./realtime/hub.ts";
import { createApp } from "./http/app.ts";
import { startReaper } from "./core/reaper.ts";

const db = openDatabase(env.dbPath);
const store = createStore(db);
const hub = createHub(store);
const app = createApp(store, hub);
const server = createServer(app);

hub.attach(server);
const reaper = startReaper(store, hub);

server.listen(env.port, () => {
  logger.info("cipher server listening", {
    port: env.port,
    db: env.dbPath,
    maxTtlSeconds: env.maxTtlSeconds,
  });
});

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  logger.info("shutting down", { signal });

  reaper.stop();
  hub.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Don't let a lingering keep-alive socket hold the process open indefinitely.
  setTimeout(() => process.exit(0), 5_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
