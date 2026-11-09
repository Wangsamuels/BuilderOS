import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { ChallengeQuery, VerifyBody, env, HttpError } from "@builderos/shared";
import { authChallenges, authSessions, eq, getDb, inArray, plans } from "@builderos/db";
import {
  companyCreateFunding,
  resolveLoginAccountId,
  sendNear,
  serviceAccount,
  verifyNep413Flexible,
  viewAccount,
  yoctoToNear,
} from "@builderos/near";
import { COOKIE, cookieOptions, issueSession, requireAccount, visibleCompanies } from "../auth.js";
import { originAllowed, parse } from "../app.js";

/** One successful drip per account per process window (Heroku restart clears). */
const fundedOnce = new Set<string>();

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

function normalizePublicKey(pk: string): string {
  const s = pk.trim();
  if (s.startsWith("ed25519:")) return s;
  return `ed25519:${s}`;
}

/**
 * Sign-in: NEP-413 challenge → verify → session cookie + Bearer token.
 * Privy email/Google: identity is the signing key's implicit hex account (synthetic bos-*.testnet ids are remapped).
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const ipLimit = { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: (req: { ip: string }) => req.ip } };

  app.get("/challenge", { config: ipLimit }, async (req) => {
    const { accountId } = parse(ChallengeQuery, req.query);
    const nonce = randomBytes(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const recipient = challengeRecipient(req);
    const message = `Sign in to BuilderOS\nAccount: ${accountId}\nRecipient: ${recipient}\nExpires: ${expiresAt.toISOString()}`;
    await getDb().insert(authChallenges).values({ nonce: nonce.toString("base64"), accountId, message, expiresAt });
    return { message, recipient, nonce: nonce.toString("base64"), expiresAt };
  });

  app.post("/verify", { config: ipLimit }, async (req, reply) => {
    const raw = parse(VerifyBody, { ...(req.body as object), publicKey: normalizePublicKey(String((req.body as any)?.publicKey ?? "")) });
    const body = raw;
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

    const accountId = await resolveLoginAccountId(body.accountId, body.publicKey, req.log);
    await db.update(authChallenges).set({ usedAt: new Date() }).where(eq(authChallenges.nonce, body.nonce));
    const { token, expiresAt } = await issueSession(reply, accountId, body.publicKey);
    return { accountId, token, expiresAt };
  });

  app.post("/logout", async (req, reply) => {
    if (req.sessionHash) await getDb().delete(authSessions).where(eq(authSessions.tokenHash, req.sessionHash));
    const { maxAge: _m, ...opts } = cookieOptions();
    reply.clearCookie(COOKIE, opts);
    return { ok: true };
  });

  /**
   * Session + setup progress for dashboard banner / Describe funding CTA.
   * Sign-in alone creates the account — Describe is not part of auth.
   */
  async function buildSetup(account: string) {
    const companies = await visibleCompanies(account);
    const funding = companyCreateFunding(3);
    const bal = await viewAccount(account).catch(() => ({
      exists: false,
      availableYocto: "0",
      amountYocto: "0",
      lockedYocto: "0",
    }));
    const available = BigInt(bal.availableYocto);
    const need = BigInt(funding.recommendedYocto);
    const hasCompany = companies.length > 0;
    const fundedEnough = hasCompany || available >= need;

    let hasPlan = false;
    if (companies.length) {
      const rows = await getDb().select({ id: plans.id }).from(plans).where(inArray(plans.companyId, companies)).limit(1);
      hasPlan = rows.length > 0;
    }

    const steps = [
      { id: "account", done: true as const, label: "Account created" },
      {
        id: "fund",
        done: fundedEnough,
        label: hasCompany ? "Wallet funded" : `Add ~${funding.recommendedNear} testnet NEAR`,
        requiredNear: funding.recommendedNear,
      },
      { id: "company", done: hasCompany, label: "Create your company" },
      { id: "describe", done: hasPlan, label: "Describe your product" },
    ];
    const completed = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done)?.id ?? null;

    return {
      accountId: account,
      companies,
      balance: {
        exists: bal.exists,
        availableYocto: bal.availableYocto,
        availableNear: yoctoToNear(available),
        amountYocto: bal.amountYocto,
        lockedYocto: bal.lockedYocto,
      },
      funding,
      setup: {
        steps,
        completed,
        total: steps.length,
        next,
        /** Soft banner on dashboard when setup incomplete — FE owns copy. */
        showBanner: next !== null,
      },
    };
  }

  const me = async (req: FastifyRequest) => buildSetup(requireAccount(req));
  app.get("/me", me);
  /** Alias for FE contract draft that expected /v1/auth/session */
  app.get("/session", me);
  /** Explicit setup payload (same as /me) for dashboard progress + Describe deposit CTA. */
  app.get("/setup", async (req) => buildSetup(requireAccount(req)));

  /**
   * Testnet-only: drip recommendedNear from TESTNET_SPONSOR_* to the signed-in account.
   * Also creates the implicit account on first transfer (near-faucet.io rejects brand-new Privy ids).
   * FE: "Add testnet NEAR for me" when funding.autoFundAvailable.
   */
  app.post("/fund-testnet", { config: ipLimit }, async (req) => {
    const account = requireAccount(req);
    const e = env();
    if (e.NETWORK !== "testnet") throw new HttpError(400, "fund-testnet is testnet only", "wrong_network");
    if (!e.TESTNET_SPONSOR_ACCOUNT_ID || !e.TESTNET_SPONSOR_PRIVATE_KEY) {
      throw new HttpError(503, "testnet sponsor not configured", "sponsor_unavailable");
    }
    const funding = companyCreateFunding(3);
    const need = BigInt(e.TESTNET_SPONSOR_AMOUNT_YOCTO ?? funding.recommendedYocto);
    const bal = await viewAccount(account).catch(() => ({ availableYocto: "0", exists: false }));
    if (BigInt(bal.availableYocto) >= need) {
      return { ok: true, skipped: true, reason: "already_funded", balanceYocto: bal.availableYocto };
    }
    if (fundedOnce.has(account)) {
      throw new HttpError(429, "already requested a drip this session — wait or refresh balance", "fund_rate_limited");
    }
    const sponsor = await serviceAccount(e.TESTNET_SPONSOR_ACCOUNT_ID, e.TESTNET_SPONSOR_PRIVATE_KEY);
    const { txHash } = await sendNear(sponsor, account, need);
    fundedOnce.add(account);
    req.log.info({ account, txHash, amount: need.toString() }, "testnet sponsor drip");
    return { ok: true, txHash, amountYocto: need.toString(), amountNear: yoctoToNear(need) };
  });
};
