import { pino } from "pino";
import { env } from "./config.js";

export * from "./config.js";
export * from "./events.js";
export * from "./api.js";

const REDACT = [
  "req.headers.cookie",
  "req.headers.authorization",
  "*.privateKey",
  "*.private_key",
  "*.secret",
  "*.prompt",
  "*.ciphertext",
  "*.apiKey",
];

export function createLogger(service: string) {
  return pino({
    name: service,
    level: env().LOG_LEVEL,
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { service, network: env().NETWORK },
  });
}
export type Logger = ReturnType<typeof createLogger>;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential backoff (cap 30 min, matching "Chain Signatures down"). */
export async function withBackoff<T>(fn: () => Promise<T>, opts: { tries?: number; baseMs?: number; maxMs?: number } = {}): Promise<T> {
  const { tries = 6, baseMs = 500, maxMs = 30 * 60_000 } = opts;
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await sleep(Math.min(maxMs, baseMs * 2 ** i));
    }
  }
  throw err;
}

/** Amounts are always integer strings in a token's smallest unit. */
export const toBig = (v: string | number | bigint | null | undefined) => BigInt(v ?? 0);
