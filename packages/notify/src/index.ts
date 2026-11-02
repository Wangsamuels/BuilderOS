import webpush from "web-push";
import { env, type Logger } from "@builderos/shared";
import { accountEmails, and, companies, eq, getDb, membersCache, notifications, pushSubscriptions, sql } from "@builderos/db";

/**
 * Notification service: web push (VAPID), email via near-email (Payment Key mode, content over HTTPS,
 * never on chain), StableEmail fallback after one retry, and in-app via SSE (the events stream).
 */

export type Alert = {
  kind: "approval" | "daily_cap" | "seller_choice" | "blocked_attack" | "paused" | "invite" | "rotate_code_key" | "info";
  companyId: string | null;
  title: string;
  body: string;
  url?: string;
  urgent?: boolean;
  to?: string[]; // explicit recipients (accounts); default = founder + approvers
  email?: { to: string; subject: string; text: string }; // direct email (invites)
};

let vapidReady = false;
function initVapid() {
  const e = env();
  if (vapidReady || !e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return vapidReady;
  webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

async function recipients(companyId: string): Promise<string[]> {
  const db = getDb();
  const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
  const approvers = await db
    .select({ account: membersCache.accountId })
    .from(membersCache)
    .where(and(eq(membersCache.companyId, companyId), eq(membersCache.revoked, false), sql`${membersCache.scopes} ?| array['approve','admin']`));
  return [...new Set([c?.founderAccount, ...approvers.map((a) => a.account)].filter(Boolean) as string[])];
}

/** The daily-cap card is debounced to one notification per company per day; urgent alerts skip it. */
async function debounced(account: string, a: Alert) {
  if (a.urgent || a.kind !== "daily_cap" || !a.companyId) return false;
  const r = await getDb().execute(
    sql`select 1 from notifications where account = ${account} and company_id = ${a.companyId} and kind = 'daily_cap' and created_at > date_trunc('day', now()) limit 1`,
  );
  return r.rows.length > 0;
}

export async function sendEmail(to: string, subject: string, text: string, log: Logger): Promise<"near-email" | "stable-email"> {
  const e = env();
  const attempt = async () => {
    if (!e.NEAR_EMAIL_URL || !e.NEAR_EMAIL_PAYMENT_KEY) throw new Error("near-email not configured");
    const res = await fetch(e.NEAR_EMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.NEAR_EMAIL_PAYMENT_KEY}` },
      body: JSON.stringify({ to, subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`near-email ${res.status}`);
  };
  try {
    await attempt().catch(async () => attempt()); // one retry
    return "near-email";
  } catch (err: any) {
    log.warn({ err: err?.message }, "near-email failed, falling back to StableEmail");
    if (!e.STABLE_EMAIL_URL) throw new Error("no email channel configured");
    // StableEmail is an x402 seller on Base; in hosted mode the ops agent's builderFetch is injected via setPaidFetch.
    const res = await (paidFetch ?? fetch)(e.STABLE_EMAIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, subject, text }),
    });
    if (!res.ok) throw new Error(`stable-email ${res.status}`);
    return "stable-email";
  }
}

let paidFetch: typeof fetch | undefined;
export const setPaidFetch = (f: typeof fetch) => (paidFetch = f);

export async function notify(a: Alert, log: Logger) {
  const db = getDb();
  if (a.email) {
    const ch = await sendEmail(a.email.to, a.email.subject, a.email.text, log).catch((e) => {
      log.error({ err: e?.message }, "direct email failed");
      return null;
    });
    await db.insert(notifications).values({ account: a.email.to.split("@")[1] ? "email" : a.email.to, companyId: a.companyId, kind: a.kind, channel: ch ?? "email-failed", payload: { title: a.title }, sentAt: ch ? new Date() : null });
  }
  const accounts = a.to ?? (a.companyId ? await recipients(a.companyId) : []);
  for (const account of accounts) {
    if (await debounced(account, a)) continue;
    const payload = { title: a.title, body: a.body, url: a.url, kind: a.kind };

    // In-app (persisted; the SSE stream also carries the underlying event)
    await db.insert(notifications).values({ account, companyId: a.companyId, kind: a.kind, channel: "in-app", payload, sentAt: new Date() });

    // Web push
    if (initVapid()) {
      const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.account, account));
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: a.urgent ? "high" : "normal" });
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
          else log.warn({ err: err?.message }, "web push failed");
        }
      }
    }

    // Email: short alert + link only
    const [em] = await db.select().from(accountEmails).where(eq(accountEmails.account, account));
    if (em) {
      try {
        const { deserialize, openString, serverKey } = await import("@builderos/crypto");
        const to = await openString(deserialize(em.emailCiphertext), serverKey(env().SESSION_SECRET));
        const ch = await sendEmail(to, `BuilderOS: ${a.title}`, `${a.body}\n\n${a.url ?? ""}`, log);
        await db.insert(notifications).values({ account, companyId: a.companyId, kind: a.kind, channel: ch, payload, sentAt: new Date() });
      } catch (err: any) {
        await db.insert(notifications).values({ account, companyId: a.companyId, kind: a.kind, channel: "email", payload, error: err?.message });
      }
    }
  }
}

/** Map indexed events to alerts. */
export function alertFor(event: string, d: Record<string, any>, companyId: string | null, webOrigin: string): Alert | null {
  const link = (p: string) => `${webOrigin.split(",")[0]}${p}`;
  switch (event) {
    case "purchase_yielded":
      if (d.reason === "daily_cap")
        return { kind: "daily_cap", companyId, title: "Daily spending cap reached", body: "New purchases are waiting on today's card.", url: link("/approvals") };
      if (d.reason === "seller_choice") return { kind: "seller_choice", companyId, title: "Pick a seller", body: `A task needs a ${d.service ?? "service"} seller.`, url: link("/approvals") };
      return { kind: "approval", companyId, title: "Approval needed", body: `A purchase of ${d.amount ?? "?"} needs your approval.`, url: link("/approvals") };
    case "purchase_rejected":
      if (d.reason === "attack" || d.blocked) return { kind: "blocked_attack", companyId, title: "Blocked a purchase", body: `Reason: ${d.reason}`, url: link("/audit"), urgent: true };
      return null;
    case "frozen":
      return { kind: "paused", companyId, title: "Spending paused", body: "All spending is paused.", url: link("/"), urgent: true };
    case "grant_revoked":
      return companyId ? { kind: "rotate_code_key", companyId, title: "Rotate the code key?", body: `${d.account_id} was removed. Rotate the code key so they can't read new code.`, url: link("/settings/keys"), urgent: true } : null;
    default:
      return null;
  }
}
