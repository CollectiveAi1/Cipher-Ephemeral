/**
 * Structured JSON logging. Deliberately has no path for message content, ciphertext,
 * or tokens — the only fields it emits are the ones named here.
 */

type Fields = Record<string, string | number | boolean | null>;

/** Tests assert on behaviour, not output, so only failures are worth printing there. */
const quiet = () => process.env["NODE_ENV"] === "test";

const emit = (level: "info" | "warn" | "error", message: string, fields: Fields = {}) => {
  if (level !== "error" && quiet()) return;
  const line = JSON.stringify({ level, message, at: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

export const logger = {
  info: (message: string, fields?: Fields) => emit("info", message, fields),
  warn: (message: string, fields?: Fields) => emit("warn", message, fields),
  error: (message: string, fields?: Fields) => emit("error", message, fields),
  request: (fields: Fields) => emit("info", "request", fields),
};
