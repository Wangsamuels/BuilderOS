import type { FastifyReply, FastifyRequest } from "fastify";
import { env, HttpError } from "@builderos/shared";
import { authSessions, eq, getDb, sql } from "@builderos/db";
import { sha256Hex, randomToken } from "@builderos/crypto";
import { views, isFounder, type Grant } from "@builderos/near";

export const COOKIE = "bos_session";
export const SESSION_MS = 24 * 60 * 60_000;
const ROTATE_AFTER_MS = 12 * 60 * 60_000;

declare module "fastify" {
  interface FastifyRequest {
    account?: string;
    sessionHash?: string;
  }
}

/**
 * Cookie options for the Vercel ↔ Heroku split:
 *  - same parent domain (app.example.com + api.example.com): COOKIE_DOMAIN=.example.com, SameSite=Lax
 *  - different sites (*.vercel.app + *.herokuapp.com): SameSite=None; Secure; Partitioned (CHIPS),
 *    plus the bearer-token fallback for browsers that block third-party cookies (Safari).
 */
export function cookieOptions() {
  const e = env();
  const prod = e.NODE_ENV === "production";
  const crossSite = prod && !e.COOKIE_DOMAIN;
  return {
    httpOnly: true,
    secure: prod,
    sameSite: crossSite ? ("none" as const) : ("lax" as const),
    partitioned: crossSite || undefined,
    domain: e.COOKIE_DOMAIN,
    path: "/",
    maxAge: SESSION_MS / 1000,
  };
}

export async function issueSession(reply: FastifyReply, accountId: string, publicKey: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await getDb().insert(authSessions).values({ tokenHash: sha256Hex(token), accountId, publicKey, expiresAt });
  reply.setCookie(COOKIE, token, cookieOptions());
  return { token, expiresAt };
}

function tokenFrom(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const c = req.cookies?.[COOKIE];
  if (c) return c;
  // EventSource can't set headers; allow ?token= on the stream only.
  if (req.url.startsWith("/v1/stream")) return (req.query as any)?.token;
  return undefined;
}

/** onRequest hook: attach req.account if a valid session is present; rotate cookies older than 12h. */
export async function loadSession(req: FastifyRequest, reply: FastifyReply) {
  const token = tokenFrom(req);
  if (!token) return;
  const hash = sha256Hex(token);
  const [s] = await getDb().select().from(authSessions).where(eq(authSessions.tokenHash, hash));
  if (!s || s.expiresAt < new Date()) return;
  req.account = s.accountId;
  req.sessionHash = hash;
  const age = Date.now() - (s.rotatedAt ?? s.createdAt).getTime();
  if (age > ROTATE_AFTER_MS && req.cookies?.[COOKIE] === token) {
    await getDb().delete(authSessions).where(eq(authSessions.tokenHash, hash));
    await issueSession(reply, s.accountId, s.publicKey);
  }
}

export function requireAccount(req: FastifyRequest): string {
  if (!req.account) throw new HttpError(401, "sign in required", "unauthenticated");
  return req.account;
}

export type Scope = "view" | "approve" | "code" | "builder" | "admin";

/**
 * Re-check on chain before building any transaction: founder, or a live grant with the scope.
 * `target` is the company or department contract the grant lives on.
 */
export async function authorize(account: string, companyId: string, scopes: Scope[], target?: string): Promise<{ founder: boolean; grant: Grant | null }> {
  if (await isFounder(companyId, account)) return { founder: true, grant: null };
  const grant = await views.getGrant(target ?? companyId, account).catch(() => null);
  const ok =
    grant &&
    !grant.revoked &&
    (!grant.expires_at_ms || grant.expires_at_ms > Date.now()) &&
    grant.scopes.some((s) => s === "admin" || scopes.includes(s as Scope));
  if (!ok) throw new HttpError(403, "no grant for this action", "forbidden");
  return { founder: false, grant };
}

export async function requireFounder(account: string, companyId: string) {
  if (!(await isFounder(companyId, account))) throw new HttpError(403, "founder only", "forbidden");
}

/** Companies the account can see (cache; used for list views and SSE filtering, never for money). */
export async function visibleCompanies(account: string): Promise<string[]> {
  const r = await getDb().execute<{ id: string }>(sql`
    select id from companies where founder_account = ${account}
    union
    select distinct company_id as id from members_cache where account_id = ${account} and not revoked and company_id is not null
      and (expires_at is null or expires_at > now())`);
  return r.rows.map((x) => x.id);
}
