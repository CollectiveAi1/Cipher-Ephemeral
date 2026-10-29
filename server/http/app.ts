import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HealthReport } from "../../shared/protocol.ts";
import type { Store } from "../store.ts";
import type { Hub } from "../realtime/hub.ts";
import { env } from "../env.ts";
import { now } from "../core/time.ts";
import { notFound } from "./errors.ts";
import { clientIp, errorHandler, rateLimit, requestLogger, requireAuth } from "./middleware.ts";
import { authRoutes } from "./routes/auth.ts";
import { callRoutes } from "./routes/calls.ts";
import { communityRoutes } from "./routes/communities.ts";
import { conversationRoutes } from "./routes/conversations.ts";
import { mediaRoutes } from "./routes/media.ts";
import { messageRoutes } from "./routes/messages.ts";
import { userRoutes } from "./routes/users.ts";

const STATIC_ROOT = resolve(import.meta.dirname, "../../dist");

export function createApp(store: Store, hub: Hub): Express {
  const app = express();
  app.disable("x-powered-by");
  if (env.trustProxy) app.set("trust proxy", true);
  app.use(requestLogger());

  // 120 requests per 10s. Keyed by account once authenticated, address before that.
  const generalLimit = rateLimit({
    capacity: 120,
    refillPerSecond: 12,
    keyOf: (req) => `api:${req.auth?.user.id ?? clientIp(req)}`,
  });

  app.get("/api/health", (_req, res) => {
    const report: HealthReport = {
      status: "ok",
      serverTime: now(),
      maxTtlSeconds: env.maxTtlSeconds,
      iceServers: [...env.iceServers],
    };
    res.json(report);
  });

  const authed = [requireAuth(store), generalLimit];

  // Mounted before the JSON parser so an encrypted blob is never buffered as text.
  app.use("/api/media", authed, mediaRoutes(store));

  app.use(express.json({ limit: "256kb" }));
  app.use("/api/auth", authRoutes(store));
  app.use("/api/users", authed, userRoutes(store));
  app.use("/api/conversations", authed, conversationRoutes(store, hub));
  app.use("/api/messages", authed, messageRoutes(store, hub));
  app.use("/api/communities", authed, communityRoutes(store, hub));
  app.use("/api/calls", authed, callRoutes(store));

  app.use("/api", (_req, _res, next) => next(notFound("No such endpoint")));

  if (env.serveStatic && existsSync(STATIC_ROOT)) {
    app.use(express.static(STATIC_ROOT));
    // Client-side routing: any other GET renders the app shell. Written as middleware
    // rather than a wildcard route because a wildcard pattern does not match "/".
    app.use((req, res, next) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      res.sendFile(resolve(STATIC_ROOT, "index.html"));
    });
  }

  app.use(errorHandler());
  return app;
}
