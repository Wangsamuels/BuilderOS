import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { ChallengeQuery, VerifyBody, env, HttpError } from "@builderos/shared";
import { authChallenges, authSessions, eq, getDb } from "@builderos/db";
import { isFullAccessKey, verifyNep413Flexible } from "@builderos/near";
import { COOKIE, cookieOptions, issueSession, requireAccount, visibleCompanies } from "../auth.js";
import { originAllowed, parse } from "../app.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Prefer the browser Origin host (FE NEP-413 recipient) when CORS-allowed; else AUTH_RECIPIENT. */
function challengeRecipient(req: FastifyRequest): string {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    try {
      return new URL(origin).host; // e.g. builder-os-mu.vercel.app
    } catch {
      /* fall through */
    }
  }
  return env().AUTH_RECIPIENT;
}

/**
 * Sign-in: the browser signs a challenge (nonce + expiry) with its NEAR key via NEP-413 `signMessage`;
 * we verify the signature and that the key is a full-access key on the account (RPC), then issue an
 * HTTP-only session cookie (24h, rotated). The token is also returned for the Authorization: Bearer fallback.
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const ipLimit = { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req: { ip: string }) => req.ip } };

  app.get("/challenge", { config: ipLimit }, async (req) => {
    const { accountId } = parse(ChallengeQuery, req.query);
    const nonce = randomBytes(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const recipient = challengeRecipient(req);
    const message = `Sign in to BuilderOS\nAccount: ${accountId}\nRecipient: ${recipient}\nExpires: ${expiresAt.toISOString()}`;
    await getDb().insert(authChallenges).values({ nonce: nonce.toString("base64"), accountId, message, expiresAt });
    // Pass these straight to wallet.signMessage({ message, recipient, nonce: Buffer.from(nonce, "base64") })
    return { message, recipient, nonce: nonce.toString("base64"), expiresAt };
  });

  app.post("/verify", { config: ipLimit }, async (req, reply) => {
    const body = parse(VerifyBody, req.body);
    const db = getDb();
    const [ch] = await db.select().from(authChallenges).where(eq(authChallenges.nonce, body.nonce));
    if (!ch || ch.usedAt || ch.expiresAt < new Date() || ch.accountId !== body.accountId || ch.message !== body.message)
      throw new HttpError(401, "challenge invalid or expired", "bad_challenge");

    const fromMessage = /^Recipient: (.+)$/m.exec(body.message)?.[1]?.trim();
    const fromOrigin = (() => {
      const o = req.headers.origin;
      if (!o || !originAllowed(o)) return undefined;
      try {
        return new URL(o).host;
      } catch {
        return undefined;
      }
    })();
    const recipients = [fromMessage, fromOrigin, env().AUTH_RECIPIENT, "builderos"].filter((x): x is string => Boolean(x));
    // Also accept full origin URL as recipient (some wallets use that).
    if (req.headers.origin && originAllowed(req.headers.origin)) recipients.push(req.headers.origin);

    const ok = verifyNep413Flexible({
      publicKey: body.publicKey,
      signature: body.signature,
      message: body.message,
      nonce: Buffer.from(body.nonce, "base64"),
      recipients,
      callbackUrl: body.callbackUrl,
    });
    if (!ok) {
      req.log.warn({ accountId: body.accountId, recipients }, "auth verify bad_signature");
      throw new HttpError(401, "bad signature — sign with challenge.recipient and the exact challenge.message", "bad_signature");
    }
    if (!(await isFullAccessKey(body.accountId, body.publicKey))) throw new HttpError(401, "key is not a full-access key on this account", "bad_key");

    await db.update(authChallenges).set({ usedAt: new Date() }).where(eq(authChallenges.nonce, body.nonce));
    const { token, expiresAt } = await issueSession(reply, body.accountId, body.publicKey);
    return { accountId: body.accountId, token, expiresAt };
  });

  app.post("/logout", async (req, reply) => {
    if (req.sessionHash) await getDb().delete(authSessions).where(eq(authSessions.tokenHash, req.sessionHash));
    const { maxAge: _m, ...opts } = cookieOptions();
    reply.clearCookie(COOKIE, opts);
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const account = requireAccount(req);
    return { accountId: account, companies: await visibleCompanies(account) };
  });
};
