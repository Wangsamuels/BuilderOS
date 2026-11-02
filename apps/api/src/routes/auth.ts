import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { ChallengeQuery, VerifyBody, env, HttpError } from "@builderos/shared";
import { authChallenges, authSessions, eq, getDb } from "@builderos/db";
import { isFullAccessKey, verifyNep413 } from "@builderos/near";
import { COOKIE, cookieOptions, issueSession, requireAccount, visibleCompanies } from "../auth.js";
import { parse } from "../app.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

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
    const message = `Sign in to BuilderOS\nAccount: ${accountId}\nExpires: ${expiresAt.toISOString()}`;
    await getDb().insert(authChallenges).values({ nonce: nonce.toString("base64"), accountId, message, expiresAt });
    // Pass these straight to wallet.signMessage({ message, recipient, nonce: Buffer.from(nonce, "base64") })
    return { message, recipient: env().AUTH_RECIPIENT, nonce: nonce.toString("base64"), expiresAt };
  });

  app.post("/verify", { config: ipLimit }, async (req, reply) => {
    const body = parse(VerifyBody, req.body);
    const db = getDb();
    const [ch] = await db.select().from(authChallenges).where(eq(authChallenges.nonce, body.nonce));
    if (!ch || ch.usedAt || ch.expiresAt < new Date() || ch.accountId !== body.accountId || ch.message !== body.message)
      throw new HttpError(401, "challenge invalid or expired", "bad_challenge");
    await db.update(authChallenges).set({ usedAt: new Date() }).where(eq(authChallenges.nonce, body.nonce));

    const ok = verifyNep413({
      publicKey: body.publicKey,
      signature: body.signature,
      message: body.message,
      nonce: Buffer.from(body.nonce, "base64"),
      recipient: env().AUTH_RECIPIENT,
      callbackUrl: body.callbackUrl,
    });
    if (!ok) throw new HttpError(401, "bad signature", "bad_signature");
    if (!(await isFullAccessKey(body.accountId, body.publicKey))) throw new HttpError(401, "key is not a full-access key on this account", "bad_key");

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
