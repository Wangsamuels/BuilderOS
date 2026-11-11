import { HttpError } from "@builderos/shared";
import { and, eq, getDb, keyAccessLog, notifications, sql, wrappedKeys } from "@builderos/db";
import { isFounder, views, type Grant } from "@builderos/near";

/**
 * Key service: stores wrapped keys and hands them out only after an on-chain grant check.
 * It never sees a plaintext key — keys are wrapped in the founder's browser to each member's x25519 view key.
 */

export type KeyKind = "code" | "log";

function teamGrant(g: Grant | null, companyId: string, departmentId?: string | null): Grant | null {
  if (!g || !departmentId) return g;
  const companyWide = !g.department_id || g.department_id === companyId || g.scopes.includes("admin");
  return companyWide || g.department_id === departmentId ? g : null;
}

function grantAllows(g: Grant | null, kind: KeyKind) {
  if (!g) return "no grant";
  if (g.revoked) return "revoked";
  if (g.expires_at_ms && g.expires_at_ms < Date.now()) return "expired";
  const need = kind === "code" ? ["code", "admin"] : ["view", "code", "approve", "admin"];
  if (!g.scopes.some((s) => need.includes(s))) return `missing scope ${kind}`;
  return null;
}

async function logAccess(accountId: string, companyId: string, kind: string, allowed: boolean, reason?: string) {
  await getDb().insert(keyAccessLog).values({ accountId, companyId, kind, allowed, reason });
}

/** Founder (or rotation flow) uploads wrapped keys. Refuses a version the contract hasn't recorded. */
export async function uploadWrapped(p: {
  caller: string;
  companyId: string;
  kind: KeyKind;
  departmentId?: string | null;
  version: number;
  keys: Array<{ memberAccount: string; ciphertext: string }>;
}) {
  if (!(await isFounder(p.companyId, p.caller))) {
    if (p.kind === "code") throw new HttpError(403, "only the founder can upload code keys", "forbidden");
    // Grants live on the company contract; a team-limited grant only covers its own team.
    const g = teamGrant(await views.getGrant(p.companyId, p.caller).catch(() => null), p.companyId, p.departmentId);
    if (grantAllows(g, "code")) throw new HttpError(403, "not allowed", "forbidden");
  }
  if (p.kind === "code") {
    // A rotate signed a moment ago may not be final yet: wait up to ~8 s for the contract to show it.
    let onChain: number | undefined;
    for (let i = 0; i < 5; i++) {
      onChain = (await views.getCompany(p.companyId).catch(() => null))?.code_key_version;
      if (onChain === p.version || (onChain !== undefined && onChain > p.version)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (onChain !== p.version)
      throw new HttpError(409, `contract has code key version ${onChain}, not ${p.version}`, "version_conflict", { currentVersion: onChain ?? null, requested: p.version });
  }
  const db = getDb();
  for (const k of p.keys) {
    await db
      .insert(wrappedKeys)
      .values({ companyId: p.companyId, kind: p.kind, departmentId: p.departmentId ?? null, version: p.version, memberAccount: k.memberAccount, ciphertext: k.ciphertext })
      .onConflictDoUpdate({
        target: [wrappedKeys.companyId, wrappedKeys.kind, wrappedKeys.departmentId, wrappedKeys.version, wrappedKeys.memberAccount],
        set: { ciphertext: k.ciphertext },
      });
  }
  return { stored: p.keys.length };
}

/** Release check on every request: get_grant(account) on chain → scope, expiry, revocation. */
export async function releaseWrapped(p: { caller: string; companyId: string; kind: KeyKind; departmentId?: string | null; version?: number }) {
  const founder = await isFounder(p.companyId, p.caller);
  if (!founder) {
    // Grants live on the company contract; a team-limited grant only covers its own team.
    const g = teamGrant(await views.getGrant(p.companyId, p.caller).catch(() => null), p.companyId, p.departmentId);
    const deny = grantAllows(g, p.kind);
    if (deny) {
      await logAccess(p.caller, p.companyId, p.kind, false, deny);
      throw new HttpError(403, `key release refused: ${deny}`, "grant_check_failed");
    }
  }
  const db = getDb();
  const rows = await db
    .select()
    .from(wrappedKeys)
    .where(
      and(
        eq(wrappedKeys.companyId, p.companyId),
        eq(wrappedKeys.kind, p.kind),
        eq(wrappedKeys.memberAccount, p.caller),
        p.departmentId ? eq(wrappedKeys.departmentId, p.departmentId) : sql`true`,
        p.version ? eq(wrappedKeys.version, p.version) : sql`true`,
      ),
    )
    .orderBy(sql`${wrappedKeys.version} desc`)
    .limit(1);
  await logAccess(p.caller, p.companyId, p.kind, !!rows[0], rows[0] ? undefined : "no wrapped key");
  if (!rows[0]) throw new HttpError(404, "no wrapped key for this account", "not_found");
  return { version: rows[0].version, ciphertext: rows[0].ciphertext };
}

/** On grant_revoked: delete that member's wrapped copies at once and prompt the founder to rotate. */
export async function onGrantRevoked(p: { companyId: string; account: string; founder?: string }) {
  const db = getDb();
  const del = await db.delete(wrappedKeys).where(and(eq(wrappedKeys.companyId, p.companyId), eq(wrappedKeys.memberAccount, p.account))).returning({ id: wrappedKeys.id });
  if (p.founder) {
    await db.insert(notifications).values({
      account: p.founder,
      companyId: p.companyId,
      kind: "rotate_code_key",
      channel: "in-app",
      payload: { title: "Rotate the code key?", body: `${p.account} was removed.` },
      sentAt: new Date(),
    });
  }
  return { deleted: del.length };
}
