import { views } from "@builderos/near";

/**
 * Live team numbers read from the team contracts, cached for a few seconds so the home screen (which reads
 * every company) doesn't hammer the RPC. Money is always read from chain; this only bounds how often.
 */
type Team = {
  name: string;
  departmentId: string;
  budget: string;
  spent: string;
  reserved: string;
  available: string;
  perTxLimit: string | null;
  frozen: boolean | null;
  paymentAddress: string | null;
  chainReadOk: boolean;
};
type Company = { name: string | null; founder: string | null; frozen: boolean; dailyCap: string; spentToday: string; codeKeyVersion: number | null; chainReadOk: boolean };

const TTL_MS = 8_000;
const teamCache = new Map<string, { at: number; v: Promise<Team[]> }>();
const companyCache = new Map<string, { at: number; v: Promise<Company> }>();

export function companySnapshot(companyId: string): Promise<Company> {
  const hit = companyCache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = views
    .getCompany(companyId)
    .then((c) => ({
      name: c?.name ?? null,
      founder: c?.founder ?? null,
      frozen: Boolean(c?.frozen),
      dailyCap: c?.daily_cap ?? "0",
      spentToday: c?.spent_today ?? "0",
      codeKeyVersion: c?.code_key_version ?? null,
      chainReadOk: Boolean(c),
    }))
    .catch(() => ({ name: null, founder: null, frozen: false, dailyCap: "0", spentToday: "0", codeKeyVersion: null, chainReadOk: false }));
  companyCache.set(companyId, { at: Date.now(), v });
  return v;
}

export function teamSnapshot(companyId: string): Promise<Team[]> {
  const hit = teamCache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = (async () => {
    const list = await views.getDepartments(companyId).catch(() => []);
    return Promise.all(
      (list ?? []).map(async (d) => {
        const t = await views.getDepartment(d.department_id).catch(() => null);
        const budget = BigInt(t?.budget ?? "0");
        const spent = BigInt(t?.spent ?? "0");
        const reserved = BigInt(t?.reserved ?? "0");
        const left = budget - spent - reserved;
        return {
          name: d.name,
          departmentId: d.department_id,
          budget: budget.toString(),
          spent: spent.toString(),
          reserved: reserved.toString(),
          available: (left > 0n ? left : 0n).toString(),
          perTxLimit: t?.per_tx_limit ?? null,
          frozen: t ? Boolean(t.frozen) : null,
          paymentAddress: t?.base_address ?? null,
          chainReadOk: t !== null,
        };
      }),
    );
  })();
  teamCache.set(companyId, { at: Date.now(), v });
  return v;
}

/** After a write the person signed, the next read should be fresh. */
export function forgetSnapshot(companyId: string) {
  teamCache.delete(companyId);
  companyCache.delete(companyId);
}
