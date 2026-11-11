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

/** Default machine-readable code per HTTP status, used when a route doesn't name a more specific one. */
export const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthenticated",
  402: "insufficient_funds",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  501: "not_implemented",
  503: "unavailable",
};

export class HttpError extends Error {
  details?: unknown;
  public code: string;
  constructor(public status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.code = code ?? DEFAULT_ERROR_CODES[status] ?? "error";
    this.details = details;
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
