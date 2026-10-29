#!/usr/bin/env node
/**
 * Runs the API and the Vite dev server together. Vite proxies /api and /ws to the API,
 * so the browser talks to one origin in development as it does in production.
 */
import { spawn } from "node:child_process";

const children = [];

const run = (label, command, args) => {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${label} exited with ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
};

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", process.execPath, ["--watch", "--env-file-if-exists=.env", "server/index.ts"]);
run("web", "npx", ["vite"]);
