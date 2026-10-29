import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each suite opens its own in-memory database and port, so they stay isolated.
    env: { NODE_ENV: "test", CIPHER_TOKEN_SECRET: "test-secret-at-least-32-characters-long" },
  },
});
