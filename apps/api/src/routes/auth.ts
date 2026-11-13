import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { ChallengeQuery, VerifyBody, env, network, HttpError } from "@builderos/shared";
import { authChallenges, authSessions, desc, eq, getDb, inArray, isNotNull, plans, testnetDrips } from "@builderos/db";
import {
  companyCreateFunding,
  resolveLoginAccountId,
  sendNear,
  serviceAccount,
  verifyNep413Flexible,
  viewAccount,
  views,
  yoctoToNear,
} from "@builderos/near";
import { COOKIE, cookieOptions, issueSession, requireAccount, visibleCompanies, companiesFor } from "../auth.js";
import { originAllowed, parse } from "../app.js";
import { and, isNull } from "@builderos/db";
import { emailStatus, getPrefs } from "../account.js";
import { attachPrivyEmail } from "./account.js";

/** Stored as the challenge's account when the client didn't name one (prefetched challenge). */
const ANY_ACCOUNT = "*";

/** Accounts that must never be used as the testnet sponsor (their NEAR backs storage + refunds). */
function sponsorIsProtected(id: string) {
  const n = network();
  const e = env();
  return [n.factory, n.registry, e.WORKER_ACCOUNT_ID, e.VERIFIER_ACCOUNT_ID].includes(id);
}
const DRIP_HEADROOM_YOCTO = 500_000_000_000_000_000_000_000n; // +0.5 NEAR for gas on the create txs

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

  /**
   * NEP-413 challenge. No RPC, so it answers in a few ms. `accountId` is optional: the web app can prefetch a
   * challenge on page load and sign it with whichever wallet the person picks (identity comes from the key).
   */
  app.get("/challenge", { config: ipLimit }, async (req) => {
    const { accountId } = parse(ChallengeQuery, req.query);
    const nonce = randomBytes(32);
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    const recipient = challengeRecipient(req);
    const message = `Sign in to BuilderOS\nAccount: ${accountId ?? "(the signing wallet)"}\nRecipient: ${recipient}\nExpires: ${expiresAt.toISOString()}`;
    await getDb().insert(authChallenges).values({ nonce: nonce.toString("base64"), accountId: accountId ?? ANY_ACCOUNT, message, expiresAt });
    return { message, recipient, nonce: nonce.toString("base64"), expiresAt, accountBound: Boolean(accountId) };
  });

  app.post("/verify", { config: ipLimit }, async (req, reply) => {
    const raw = parse(VerifyBody, { ...(req.body as object), publicKey: normalizePublicKey(String((req.body as any)?.publicKey ?? "")) });
    const body = raw;
    const db = getDb();
    const [ch] = await db.select().from(authChallenges).where(eq(authChallenges.nonce, body.nonce));
    if (!ch || ch.usedAt || ch.expiresAt < new Date() || (ch.accountId !== ANY_ACCOUNT && ch.accountId !== body.accountId) || ch.message !== body.message)
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

    // Single use: claim the challenge atomically so two parallel verifies can't both get a session.
    const claimed = await db
      .update(authChallenges)
      .set({ usedAt: new Date() })
      .where(and(eq(authChallenges.nonce, body.nonce), isNull(authChallenges.usedAt)))
      .returning({ nonce: authChallenges.nonce });
    if (!claimed.length) throw new HttpError(401, "challenge invalid or expired", "bad_challenge");
    const accountId = await resolveLoginAccountId(body.accountId, body.publicKey, req.log);
    const loginMethod = body.loginMethod ?? (body.privyIdentityToken ? "privy" : null);
    const { token, expiresAt } = await issueSession(reply, accountId, body.publicKey, loginMethod);

    // Privy: verify the person's email in the same step (never blocks sign-in).
    let email: Awaited<ReturnType<typeof emailStatus>> | null = null;
    let emailError: string | null = null;
    if (body.privyIdentityToken) {
      try {
        await attachPrivyEmail(accountId, body.publicKey, body.privyIdentityToken);
      } catch (e: any) {
        emailError = e?.code ?? "privy_email_failed";
        req.log.warn({ err: e?.message }, "privy email not attached at sign-in");
      }
    }
    email = await emailStatus(accountId).catch(() => null);
    return { accountId, token, expiresAt, loginMethod, email, ...(emailError ? { emailError } : {}) };
  });

  app.post("/logout", async (req, reply) => {
    if (req.sessionHash) await getDb().delete(authSessions).where(eq(authSessions.tokenHash, req.sessionHash));
    const { maxAge: _m, ...opts } = cookieOptions();
    reply.clearCookie(COOKIE, opts);
    return { ok: true };
  });

  /**
   * Who is signed in, which companies they can open (each re-checked on chain), their drafts, email status and
   * setup progress. Signing in never requires a company: the home screen works with zero companies.
   */
  async function buildSetup(account: string, req: FastifyRequest) {
    const memberships = await companiesFor(account); // each one re-checked on chain
    const companies = memberships.map((m) => m.companyId);
    const founded = memberships.filter((m) => m.isFounder).map((m) => m.companyId);
    const funding = companyCreateFunding(3);
    const bal = await viewAccount(account).catch(() => ({
      exists: false,
      availableYocto: "0",
      amountYocto: "0",
      lockedYocto: "0",
    }));
    const available = BigInt(bal.availableYocto);
    const need = BigInt(funding.recommendedYocto);
    const hasCompany = founded.length > 0;
    const fundedEnough = hasCompany || available >= need;

    const db = getDb();
    const draftRows = await db
      .select({ id: plans.id, title: plans.title, createdAt: plans.createdAt, companyId: plans.companyId })
      .from(plans)
      .where(eq(plans.createdBy, account))
      .orderBy(desc(plans.updatedAt))
      .limit(50);
    const drafts = draftRows.filter((p) => !p.companyId);
    let approved = false;
    if (founded.length) {
      const rows = await db.select({ id: plans.id }).from(plans).where(and(inArray(plans.companyId, founded), isNotNull(plans.approvedAt))).limit(1);
      approved = rows.length > 0;
    }
    const hasPlan = draftRows.length > 0 || approved;

    const [pendingRefund, email, prefs] = await Promise.all([
      views.getPendingRefund(account).then((v) => BigInt(v ?? "0")).catch(() => 0n),
      emailStatus(account),
      getPrefs(account),
    ]);

    const steps = [
      { id: "account", done: true as const, label: "Signed in" },
      { id: "email", done: email.verified, label: "Verify your email", requiredFor: "launch" },
      { id: "describe", done: hasPlan, label: "Describe your product" },
      {
        id: "fund",
        done: fundedEnough,
        label: hasCompany ? "Wallet funded" : `Add ~${funding.recommendedNear} testnet NEAR`,
        requiredNear: funding.recommendedNear,
      },
      { id: "launch", done: hasCompany, label: "Launch your company" },
      { id: "approve", done: approved, label: "Approve the plan so agents start" },
    ];
    const completed = steps.filter((s) => s.done).length;
    const next = steps.find((s) => !s.done)?.id ?? null;
    // Last company the person opened, if they can still open it; else the first one.
    const last = typeof prefs.lastCompanyId === "string" && companies.includes(prefs.lastCompanyId) ? prefs.lastCompanyId : null;

    return {
      accountId: account,
      loginMethod: req.loginMethod ?? null,
      email,
      /** Founders need a verified email before launching a company. */
      needsEmailForCompany: !email.verified,
      /** Companies this account can open: { companyId, slug, name, isFounder, admin, scopes, departmentId }. */
      companies: memberships,
      /** Same list as plain ids (older clients). */
      companyIds: companies,
      drafts: drafts.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt })),
      home: {
        /** welcome = no companies yet (show Describe + drafts + demo); overview = portfolio across companies. */
        view: companies.length ? "overview" : "welcome",
        openCompanyId: last ?? companies[0] ?? null,
        demo: env().DEMO_ENABLED ? "/v1/demo" : null,
      },
      balance: {
        exists: bal.exists,
        availableYocto: bal.availableYocto,
        availableNear: yoctoToNear(available),
        amountYocto: bal.amountYocto,
        lockedYocto: bal.lockedYocto,
      },
      funding,
      /** A failed create the factory couldn't refund at once → POST /v1/companies/claim-refund. */
      pendingRefund: { yocto: pendingRefund.toString(), near: yoctoToNear(pendingRefund) },
      setup: {
        steps,
        completed,
        total: steps.length,
        next,
        /** Progress card on the home screen while setup is incomplete — never a gate. */
        showBanner: next !== null,
      },
    };
  }

  const me = async (req: FastifyRequest) => buildSetup(requireAccount(req), req);
  app.get("/me", me);
  /** Aliases (same payload). */
  app.get("/session", me);
  app.get("/setup", me);

  /**
   * Testnet-only: drip recommendedNear from TESTNET_SPONSOR_* to the signed-in account.
   * Also creates the implicit account on first transfer (near-faucet.io rejects brand-new Privy ids).
   * FE: "Add testnet NEAR for me" when funding.autoFundAvailable.
   */
  app.post("/fund-testnet", { config: { rateLimit: { max: 3, timeWindow: "1 hour", keyGenerator: (r: { ip: string }) => r.ip } } }, async (req) => {
    const account = requireAccount(req);
    const e = env();
    if (e.NETWORK !== "testnet") throw new HttpError(400, "fund-testnet is testnet only", "wrong_network");
    if (!e.TESTNET_SPONSOR_ACCOUNT_ID || !e.TESTNET_SPONSOR_PRIVATE_KEY) {
      throw new HttpError(503, "testnet sponsor not configured", "sponsor_unavailable");
    }
    if (sponsorIsProtected(e.TESTNET_SPONSOR_ACCOUNT_ID)) {
      req.log.error({ sponsor: e.TESTNET_SPONSOR_ACCOUNT_ID }, "TESTNET_SPONSOR_ACCOUNT_ID is the factory/registry/worker/verifier — refusing to drip");
      throw new HttpError(503, "testnet sponsor misconfigured", "sponsor_unavailable");
    }
    const funding = companyCreateFunding(3);
    const target = BigInt(e.TESTNET_SPONSOR_AMOUNT_YOCTO ?? funding.recommendedYocto);
    const bal = await viewAccount(account).catch(() => ({ availableYocto: "0", exists: false }));
    const have = BigInt(bal.availableYocto);
    if (have >= target) {
      return { ok: true, skipped: true, reason: "already_funded", balanceYocto: bal.availableYocto };
    }
    // One drip per account, ever (persisted — survives dyno restarts).
    const db = getDb();
    const [prior] = await db.select().from(testnetDrips).where(eq(testnetDrips.account, account));
    if (prior) throw new HttpError(429, "this account already received testnet NEAR — use the faucet for more", "fund_rate_limited");
    // Send only the shortfall (plus a little gas headroom), never the full amount.
    const need = target - have + DRIP_HEADROOM_YOCTO;
    const sponsor = await serviceAccount(e.TESTNET_SPONSOR_ACCOUNT_ID, e.TESTNET_SPONSOR_PRIVATE_KEY);
    // Reserve the row first so two parallel requests can't both drip.
    const reserved = await db
      .insert(testnetDrips)
      .values({ account, amount: need.toString(), txHash: "pending", ip: req.ip })
      .onConflictDoNothing()
      .returning({ account: testnetDrips.account });
    if (!reserved.length) throw new HttpError(429, "this account already received testnet NEAR", "fund_rate_limited");
    try {
      const { txHash } = await sendNear(sponsor, account, need);
      await db.update(testnetDrips).set({ txHash }).where(eq(testnetDrips.account, account));
      req.log.info({ account, txHash, amount: need.toString() }, "testnet sponsor drip");
      return { ok: true, txHash, amountYocto: need.toString(), amountNear: yoctoToNear(need) };
    } catch (err) {
      await db.delete(testnetDrips).where(eq(testnetDrips.account, account));
      throw err;
    }
  });
};
