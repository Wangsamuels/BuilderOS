import type { FastifyPluginAsync } from "fastify";
import { EmailBody, EmailCodeBody, HttpError, PreferencesBody, PrivyEmailBody } from "@builderos/shared";
import { publicKeyToImplicitAccountId, normalizeCompanyId } from "@builderos/near";
import { accessFor, requireAccount } from "../auth.js";
import { parse } from "../app.js";
import { confirmEmailCode, emailStatus, getPrefs, maskEmail, saveVerifiedEmail, setPrefs, startEmailVerification } from "../account.js";
import { privyWalletMatches, verifyPrivyIdentityToken } from "../privy.js";

/** How old a Privy token may be when a NEAR wallet session uses it to confirm an email (seconds). */
const WALLET_EMAIL_TOKEN_MAX_AGE = 300;

/**
 * Verify a Privy identity token and keep its email for this account.
 *
 * Privy sign-ins: the token must list the wallet that signed in, so one person's Privy token can't attach
 * their email to someone else's account.
 *
 * NEAR wallet sign-ins (`walletSession`): the wallet is not a Privy wallet, so it can't be in the token. Here
 * Privy is used only as the email verifier (it sends and checks the one-time code). The session proves the
 * account, the token proves the address, and the token must have been issued in the last few minutes, i.e.
 * during this confirmation, so an old or copied token can't be replayed later.
 */
export async function attachPrivyEmail(account: string, publicKey: string | null, token: string, opts: { walletSession?: boolean } = {}) {
  const id = await verifyPrivyIdentityToken(token);
  if (!id.email) throw new HttpError(409, "This Privy login has no email. Add one with a code instead.", "privy_no_email");
  let hex: string | null = null;
  try {
    hex = publicKey ? publicKeyToImplicitAccountId(publicKey) : null;
  } catch {
    hex = null;
  }
  if (!privyWalletMatches(id, account, publicKey, hex)) {
    if (!opts.walletSession) throw new HttpError(409, "This Privy token belongs to a different wallet than the one signed in.", "privy_wallet_mismatch");
    const age = id.issuedAt === null ? Infinity : Math.floor(Date.now() / 1000) - id.issuedAt;
    if (age > WALLET_EMAIL_TOKEN_MAX_AGE || age < -60) throw new HttpError(401, "This email confirmation is too old. Confirm your email again.", "bad_privy_token");
  }
  await saveVerifiedEmail(account, id.email, "privy");
  return id.email;
}

/** The signed-in account: email (masked), sign-in method and preferences. No company needed. */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  const perAccount = (max: number, timeWindow: string) => ({
    rateLimit: { max, timeWindow, keyGenerator: (req: { account?: string; ip: string }) => `${req.account ?? req.ip}:email` },
  });

  app.get("/account", async (req) => {
    const account = requireAccount(req);
    const [email, prefs] = await Promise.all([emailStatus(account), getPrefs(account)]);
    return { accountId: account, loginMethod: req.loginMethod ?? null, email, needsEmailForCompany: !email.verified, preferences: prefs };
  });

  /** Send a 6-digit code to the address (NEAR wallet sign-ups; Privy users usually have one already). */
  const startEmail = async (req: any) => {
    const account = requireAccount(req);
    const { email } = parse(EmailBody, req.body);
    return { ok: true, ...(await startEmailVerification(account, email, req.log)) };
  };
  app.post("/account/email", { config: perAccount(5, "1 hour") }, startEmail);
  /** Old route name: now starts the same verified flow (an unverified address is never stored). */
  app.post("/me/email", { config: perAccount(5, "1 hour") }, startEmail);

  app.post("/account/email/verify", { config: perAccount(20, "1 hour") }, async (req) => {
    const account = requireAccount(req);
    const { code } = parse(EmailCodeBody, req.body);
    const email = await confirmEmailCode(account, code);
    return { ok: true, email: { address: maskEmail(email), verified: true, source: "code" } };
  });

  /** Verify the email from a Privy identity token. Privy sign-ins: also done at sign-in. NEAR wallet sign-ins: Privy is the email verifier. */
  app.post("/account/email/privy", { config: perAccount(20, "1 hour") }, async (req) => {
    const account = requireAccount(req);
    const { identityToken } = parse(PrivyEmailBody, req.body);
    // A NEAR wallet session may confirm an email with a fresh Privy token that doesn't list its wallet (see attachPrivyEmail).
    const email = await attachPrivyEmail(account, req.sessionPublicKey ?? null, identityToken, { walletSession: req.loginMethod !== "privy" });
    return { ok: true, email: { address: maskEmail(email), verified: true, source: "privy" } };
  });

  app.get("/account/preferences", async (req) => ({ preferences: await getPrefs(requireAccount(req)) }));

  app.patch("/account/preferences", async (req) => {
    const account = requireAccount(req);
    const b = parse(PreferencesBody, req.body);
    const patch: Record<string, unknown> = {};
    if (b.lastCompanyId !== undefined) {
      if (b.lastCompanyId === null) patch.lastCompanyId = undefined;
      else {
        // Only remember companies the account can open (checked on chain); it's a convenience, never access.
        const id = normalizeCompanyId(b.lastCompanyId);
        if (!(await accessFor(account, id).catch(() => null))) throw new HttpError(403, "You don't have access to this company.", "forbidden");
        patch.lastCompanyId = id;
      }
    }
    if (b.dismissed) patch.dismissed = [...new Set(b.dismissed)];
    return { preferences: await setPrefs(account, patch) };
  });
};
