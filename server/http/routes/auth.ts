import { Router } from "express";
import type { AuthSession } from "../../../shared/protocol.ts";
import type { Store } from "../../store.ts";
import { hashPassword, newSalt, verifyPassword } from "../../core/passwords.ts";
import { hashToken, issueToken } from "../../core/tokens.ts";
import { toPublicUser } from "../../repos/users.ts";
import { conflict, unauthorized } from "../errors.ts";
import { authOf, clientIp, rateLimit, requireAuth } from "../middleware.ts";
import { base64, fields, secret, str } from "../validate.ts";

const USERNAME = /^[a-z0-9._]+$/;
const KEY_BYTES = 4_096;

export function authRoutes(store: Store): Router {
  const router = Router();

  /**
   * Two tiers. The tight one is keyed by the account being targeted, so brute force
   * against a single login is throttled without one person's typo locking out everyone
   * else behind the same address. The loose one caps an address overall, which is what
   * stops enumeration and bulk signup.
   */
  const perAccount = rateLimit({
    capacity: 10,
    refillPerSecond: 10 / 300,
    keyOf: (req) => {
      const body = req.body as { username?: unknown };
      const username = typeof body?.username === "string" ? body.username.toLowerCase() : "unknown";
      return `auth:${username}`;
    },
  });
  const perAddress = rateLimit({ capacity: 50, refillPerSecond: 50 / 300, keyOf: (req) => `auth:${clientIp(req)}` });

  const sessionFor = (user: ReturnType<typeof store.users.create>): AuthSession => {
    const { token, expiresAt } = issueToken(user.id);
    store.users.sessions.issue(hashToken(token), user.id, expiresAt);
    return {
      token,
      expiresAt,
      user: toPublicUser(user),
      wrappedPrivateKey: user.wrapped_private_key,
      keySalt: user.key_salt,
    };
  };

  router.post("/register", perAddress, perAccount, async (req, res) => {
    const body = fields(req.body, [
      "username",
      "displayName",
      "password",
      "publicKey",
      "wrappedPrivateKey",
      "keySalt",
    ]);
    const username = str(body, "username", { min: 3, max: 24, pattern: USERNAME }).toLowerCase();
    const displayName = str(body, "displayName", { min: 1, max: 48 });
    const password = secret(body, "password", { min: 10, max: 200 });
    const publicKey = base64(body, "publicKey", KEY_BYTES);
    const wrappedPrivateKey = base64(body, "wrappedPrivateKey", KEY_BYTES);
    const keySalt = base64(body, "keySalt", 64);

    if (store.users.findByUsername(username) !== null) throw conflict("That username is taken");

    const passwordSalt = newSalt();
    const user = store.users.create({
      username,
      displayName,
      passwordHash: await hashPassword(password, passwordSalt),
      passwordSalt,
      publicKey,
      wrappedPrivateKey,
      keySalt,
    });

    res.status(201).json(sessionFor(user));
  });

  router.post("/login", perAddress, perAccount, async (req, res) => {
    const body = fields(req.body, ["username", "password"]);
    const username = str(body, "username", { min: 3, max: 24 }).toLowerCase();
    const password = secret(body, "password", { min: 1, max: 200 });

    const user = store.users.findByUsername(username);
    // Same message and comparable cost either way, so the response cannot be used to
    // discover which usernames exist.
    const ok = user !== null && (await verifyPassword(password, user.password_salt, user.password_hash));
    if (user === null || !ok) throw unauthorized("Incorrect username or password");

    res.json(sessionFor(user));
  });

  router.post("/logout", requireAuth(store), (req, res) => {
    store.users.sessions.revoke(authOf(req).tokenHash);
    res.status(204).end();
  });

  return router;
}
