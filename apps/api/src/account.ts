import { randomInt } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { env, HttpError } from "@builderos/shared";
import { accountEmails, accountPrefs, emailVerifications, eq, getDb } from "@builderos/db";
import { deserialize, hmacHex, openString, seal, serialize, serverKey, sha256Hex } from "@builderos/crypto";
import { sendEmail } from "@builderos/notify";

/** "ada.lovelace@example.com" → "a•••e@example.com" (enough for the person to recognise it, nothing more). */
export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  const u = user.length <= 2 ? `${user[0] ?? ""}•` : `${user[0]}•••${user[user.length - 1]}`;
  return `${u}@${domain}`;
}

export const emailHash = (email: string) => hmacHex(env().SESSION_SECRET, email.trim().toLowerCase());
const sealEmail = async (email: string) => serialize(await seal(email, serverKey(env().SESSION_SECRET), 0, "email"));
export async function openEmail(ciphertext: string) {
  const key = serverKey(env().SESSION_SECRET);
  const sealed = deserialize(ciphertext);
  // Older rows were sealed without the "email" AAD.
  return openString(sealed, key, "email").catch(() => openString(sealed, key));
}

export type EmailStatus = { address: string | null; verified: boolean; source: string | null; pending: string | null };

/** The account's email as the person may see it (masked). Only a verified address counts. */
export async function emailStatus(account: string): Promise<EmailStatus> {
  const db = getDb();
  const [row] = await db.select().from(accountEmails).where(eq(accountEmails.account, account));
  const [pending] = await db.select().from(emailVerifications).where(eq(emailVerifications.account, account));
  const address = row ? await openEmail(row.emailCiphertext).catch(() => null) : null;
  const pendingAddr = pending && pending.expiresAt > new Date() ? await openEmail(pending.emailCiphertext).catch(() => null) : null;
  return {
    address: address ? maskEmail(address) : null,
    verified: Boolean(row?.verifiedAt),
    source: row?.source ?? null,
    pending: pendingAddr ? maskEmail(pendingAddr) : null,
  };
}

export async function hasVerifiedEmail(account: string) {
  const [row] = await getDb().select({ v: accountEmails.verifiedAt }).from(accountEmails).where(eq(accountEmails.account, account));
  return Boolean(row?.v);
}

export async function verifiedEmailHash(account: string): Promise<string | null> {
  const [row] = await getDb().select().from(accountEmails).where(eq(accountEmails.account, account));
  return row?.verifiedAt ? row.emailHash : null;
}

export async function saveVerifiedEmail(account: string, email: string, source: "code" | "privy") {
  const now = new Date();
  const values = { emailCiphertext: await sealEmail(email), emailHash: emailHash(email), verifiedAt: now, source, updatedAt: now };
  await getDb()
    .insert(accountEmails)
    .values({ account, ...values })
    .onConflictDoUpdate({ target: accountEmails.account, set: values });
  await getDb().delete(emailVerifications).where(eq(emailVerifications.account, account));
}

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

/** Start an email check: store a hashed 6-digit code and send it. Dev/test may echo the code instead. */
export async function startEmailVerification(account: string, email: string, log: FastifyBaseLogger) {
  const e = env();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = {
    emailCiphertext: await sealEmail(email),
    emailHash: emailHash(email),
    codeHash: sha256Hex(`${account}:${code}`),
    attempts: 0,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  };
  const emailConfigured = Boolean((e.NEAR_EMAIL_URL && e.NEAR_EMAIL_PAYMENT_KEY) || e.STABLE_EMAIL_URL);
  const devEcho = e.NODE_ENV !== "production" && e.EMAIL_DEV_ECHO;
  if (!emailConfigured && !devEcho) throw new HttpError(503, "Email isn't set up on this server yet, so we can't send a code.", "email_unavailable");

  await getDb().insert(emailVerifications).values({ account, ...row }).onConflictDoUpdate({ target: emailVerifications.account, set: row });
  if (emailConfigured) {
    try {
      await sendEmail(email, "Your BuilderOS code", `Your BuilderOS verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for it, ignore this email.`, log as any);
    } catch (err: any) {
      log.warn({ err: err?.message }, "verification email failed");
      if (!devEcho) throw new HttpError(503, "We couldn't send the email. Try again in a minute.", "email_unavailable");
    }
  }
  return { sentTo: maskEmail(email), expiresAt: row.expiresAt, ...(devEcho ? { devCode: code } : {}) };
}

export async function confirmEmailCode(account: string, code: string) {
  const db = getDb();
  const [v] = await db.select().from(emailVerifications).where(eq(emailVerifications.account, account));
  if (!v) throw new HttpError(404, "No code was sent to this account. Ask for a new one.", "not_found");
  if (v.expiresAt < new Date()) throw new HttpError(410, "That code expired. Ask for a new one.", "code_expired");
  if (v.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "Too many wrong codes. Ask for a new one.", "too_many_attempts");
  if (sha256Hex(`${account}:${code}`) !== v.codeHash) {
    await db.update(emailVerifications).set({ attempts: v.attempts + 1 }).where(eq(emailVerifications.account, account));
    throw new HttpError(400, `Wrong code. ${MAX_ATTEMPTS - v.attempts - 1} tries left.`, "wrong_code");
  }
  const email = await openEmail(v.emailCiphertext);
  await saveVerifiedEmail(account, email, "code");
  return email;
}

// ---------- preferences ----------
export async function getPrefs(account: string): Promise<Record<string, any>> {
  const [row] = await getDb().select().from(accountPrefs).where(eq(accountPrefs.account, account));
  return (row?.data as Record<string, any>) ?? {};
}
export async function setPrefs(account: string, patch: Record<string, unknown>) {
  const data = { ...(await getPrefs(account)), ...patch };
  for (const [k, v] of Object.entries(data)) if (v === undefined) delete data[k];
  await getDb()
    .insert(accountPrefs)
    .values({ account, data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: accountPrefs.account, set: { data, updatedAt: new Date() } });
  return data;
}

/** Founders need a verified email before creating a company (Privy sign-ins get it from Privy). */
export async function requireVerifiedEmail(account: string) {
  if (await hasVerifiedEmail(account))
    return;
  throw new HttpError(403, "Add and verify your email before creating a company. We use it for approvals and security alerts.", "email_required", {
    next: ["POST /v1/account/email { email }", "POST /v1/account/email/verify { code }"],
    privy: "POST /v1/account/email/privy { identityToken }",
  });
}
