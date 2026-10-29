import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiErrorBody } from "../../shared/protocol.ts";
import type { Store } from "../store.ts";
import type { UserRow } from "../repos/users.ts";
import { logger } from "../logger.ts";
import { monotonicMs } from "../core/time.ts";
import { hashToken, verifyToken } from "../core/tokens.ts";
import { HttpError, badRequest, tooLarge, tooManyRequests, unauthorized } from "./errors.ts";

type AuthContext = {
  user: UserRow;
  tokenHash: string;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Reads a route parameter as a string. Express types a param as a union because a
 * wildcard segment can repeat, so this narrows it in one place.
 */
export function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== "string" || value === "") throw badRequest(`Missing "${key}" in path`);
  return value;
}

/** Reads the auth context a `requireAuth`-guarded route is guaranteed to have. */
export function authOf(req: Request): AuthContext {
  if (req.auth === undefined) throw unauthorized();
  return req.auth;
}

export function requireAuth(store: Store): RequestHandler {
  return (req, _res, next) => {
    const header = req.get("authorization");
    if (header === undefined || !header.startsWith("Bearer ")) throw unauthorized();

    const token = header.slice("Bearer ".length).trim();
    const claims = verifyToken(token);
    if (claims === null) throw unauthorized("Session token is invalid or expired");

    const tokenHash = hashToken(token);
    const userId = store.users.sessions.findUserId(tokenHash);
    if (userId === null || userId !== claims.sub) throw unauthorized("Session has been revoked");

    const user = store.users.findById(userId);
    if (user === null) throw unauthorized("Account no longer exists");

    req.auth = { user, tokenHash };
    next();
  };
}

type Bucket = {
  tokens: number;
  updatedAt: number;
};

type RateLimitOptions = {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  /** Identity the limit applies to. */
  keyOf: (req: Request) => string;
};

/** Keys tracked before idle buckets are swept, bounding memory under key churn. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Token-bucket limiter on a monotonic clock, so a system clock change cannot widen the
 * window.
 *
 * A bucket that has refilled to capacity is indistinguishable from a brand-new one, so
 * those are evicted once the map grows large. Without that, a stream of distinct keys —
 * one per attempted username, say — would grow the map without limit.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();

  const refilledTokens = (bucket: Bucket, at: number) =>
    Math.min(options.capacity, bucket.tokens + ((at - bucket.updatedAt) / 1000) * options.refillPerSecond);

  const evictIdle = (at: number) => {
    for (const [key, bucket] of buckets) {
      if (refilledTokens(bucket, at) >= options.capacity) buckets.delete(key);
    }
  };

  return (req, _res, next) => {
    const key = options.keyOf(req);
    const at = monotonicMs();
    if (buckets.size > MAX_TRACKED_KEYS) evictIdle(at);

    const bucket = buckets.get(key) ?? { tokens: options.capacity, updatedAt: at };

    bucket.tokens = refilledTokens(bucket, at);
    bucket.updatedAt = at;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      throw tooManyRequests();
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}

export const clientIp = (req: Request): string => req.ip ?? "unknown";

export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = monotonicMs();
    res.on("finish", () => {
      logger.request({
        method: req.method,
        // The routed pattern, never the full URL, so ids stay out of logs.
        route: req.route?.path ?? req.path,
        status: res.statusCode,
        ms: Math.round(monotonicMs() - started),
      });
    });
    next();
  };
}

function translateBodyParserError(error: unknown): HttpError | null {
  if (typeof error !== "object" || error === null || !("type" in error)) return null;
  const type = (error as { type: unknown }).type;
  if (type === "entity.parse.failed") return badRequest("Request body was not valid JSON");
  if (type === "entity.too.large") return tooLarge("Request body is too large");
  return null;
}

/** Terminal error handler. Unexpected failures are logged but never echoed to clients. */
export function errorHandler(): (error: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    // Body-parser rejections arrive as generic errors; translate them before the
    // catch-all turns a client mistake into a 500.
    const parsed = translateBodyParserError(error);
    if (parsed !== null) {
      const body: ApiErrorBody = { error: { code: parsed.code, message: parsed.message } };
      res.status(parsed.status).json(body);
      return;
    }

    if (error instanceof HttpError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
      res.status(error.status).json(body);
      return;
    }

    logger.error("unhandled request failure", {
      detail: error instanceof Error ? error.message : String(error),
    });
    const body: ApiErrorBody = { error: { code: "internal", message: "Something went wrong" } };
    res.status(500).json(body);
  };
}
