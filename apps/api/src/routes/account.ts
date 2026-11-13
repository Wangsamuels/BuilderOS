import type { FastifyPluginAsync } from "fastify";
import { EmailBody, EmailCodeBody, HttpError, PreferencesBody, PrivyEmailBody } from "@builderos/shared";
import { publicKeyToImplicitAccountId, normalizeCompanyId } from "@builderos/near";
import { accessFor, requireAccount } from "../auth.js";
import { parse } from "../app.js";
import { confirmEmailCode, emailStatus, getPrefs, maskEmail, saveVerifiedEmail, setPrefs, startEmailVerification } from "../account.js";
import { privyWalletMatches, verifyPrivyIdentityToken } from "../privy.js";

/**
 * Verify a Privy identity token and keep its email for this account. The token must list the wallet that
 * signed in, so one person's Privy token can't attach their email to someone else's account.
 */
export async function attachPrivyEmail(account: string, publicKey: string | null, token: string) {
  const id = await verifyPrivyIdentityToken(token);
  if (!id.email) throw new HttpError(409, "This Privy login has no email. Add one with a code instead.", "privy_no_email");
  let hex: string | null = null;
  try {
    hex = publicKey ? publicKeyToImplicitAccountId(publicKey) : null;
  } catch {
    hex = null;
  }
  if (!privyWalletMatches(id, account, publicKey, hex))
    throw new HttpError(409, "This Privy token belongs to a different wallet than the one signed in.", "privy_wallet_mismatch");
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

  /** Privy sign-ins: verify the email from the Privy identity token (also done at sign-in when the token is sent). */
  app.post("/account/email/privy", { config: perAccount(20, "1 hour") }, async (req) => {
    const account = requireAccount(req);
    const { identityToken } = parse(PrivyEmailBody, req.body);
    const email = await attachPrivyEmail(account, req.sessionPublicKey ?? null, identityToken);
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
