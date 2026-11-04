import { createHash } from "node:crypto";
import { env, network, type Logger } from "@builderos/shared";
import { getDb, leaderboardStats, modelCalls, and, eq } from "@builderos/db";
import type { BuilderFetch } from "@builderos/fetch";
import catalog from "./models.json" with { type: "json" };

export type Tier = "economy" | "standard" | "premium" | "private";
export type Offer = { rail: string; sellerId: string; url: string; inPer1k: number; outPer1k: number };
export type Model = { id: string; lab: string; tiers: string[]; tags: string[]; quality: number; latencyMs: number; offers: Offer[] };

export const MODELS: Model[] = catalog.models as Model[];
export const modelsHash = () => createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

const SIZE_TOKENS: Record<string, { in: number; out: number; calls: number }> = {
  xs: { in: 4_000, out: 1_500, calls: 2 },
  s: { in: 10_000, out: 3_000, calls: 4 },
  m: { in: 25_000, out: 6_000, calls: 8 },
  l: { in: 60_000, out: 15_000, calls: 14 },
  xl: { in: 120_000, out: 30_000, calls: 24 },
};

const TAG_RULES: Array<[RegExp, string]> = [
  // Strong niche only — ordinary "compliance checklist in code" stays security/backend.
  [/\b(llc formation|incorporation|articles of organization|sales tax nexus|hipaa ba+a|pci[\s-]?dss|soc\s?2 type|trademark filing|patent filing|ad\s?buy|programmatic media|media buy|kyc\/aml)\b/i, "niche"],
  [/\b(contract|near|rust|wasm|solidity)\b/i, "contract"],
  [/\b(auth|security|vuln|audit|xss|csrf|secret)\b/i, "security"],
  [/\b(deploy|ci|docker|infra|dns|domain|hosting)\b/i, "devops"],
  [/\b(test|spec|e2e|vitest|jest)\b/i, "test"],
  [/\b(ui|page|component|css|react|next|landing)\b/i, "frontend"],
  [/\b(api|endpoint|database|db|server|queue)\b/i, "backend"],
  [/\b(design|logo|brand|figma)\b/i, "design"],
  [/\b(readme|docs?|guide)\b/i, "docs"],
  [/\b(seo|marketing|launch|growth|email campaign)\b/i, "growth"],
];
export function classifyTag(text: string): string {
  for (const [re, tag] of TAG_RULES) if (re.test(text)) return tag;
  return "backend";
}

export function offerCost(o: Offer, tokensIn: number, tokensOut: number) {
  return BigInt(Math.ceil((tokensIn / 1000) * o.inPer1k + (tokensOut / 1000) * o.outPer1k));
}

/** p50 / p90 estimate for a task tag and size within a tier; cap = p90 × 1.5. */
export function estimate(tag: string, size: string, tier: Tier) {
  const t = SIZE_TOKENS[size] ?? SIZE_TOKENS.m;
  const candidates = MODELS.filter((m) => m.tiers.includes(tier) && m.tags.includes(tag));
  const pool = candidates.length ? candidates : MODELS.filter((m) => m.tiers.includes(tier));
  const costs = pool
    .map((m) => m.offers.map((o) => offerCost(o, t.in * t.calls, t.out * t.calls)).reduce((a, b) => (a < b ? a : b)))
    .sort((a, b) => (a < b ? -1 : 1));
  const p50 = costs[Math.floor(costs.length / 2)] ?? 0n;
  // Review + one retry dominate the tail.
  const p90 = ((costs[costs.length - 1] ?? 0n) * 18n) / 10n;
  const cap = (p90 * 3n) / 2n;
  return { tag, size, tier, p50: p50.toString(), p90: p90.toString(), cap: cap.toString(), models: pool.map((m) => m.id) };
}

export type Choice = { model: Model; offer: Offer; score: number; expectedCost: bigint };

/**
 * Shortlist models in the chosen tier, score quality + own-receipts pass rate − cost − latency,
 * and for the chosen model pay the cheaper rail. Never moves up a tier.
 */
export async function chooseModels(p: { tag: string; tier: Tier; size: string; pinnedModel?: string | null; exclude?: string[] }): Promise<Choice[]> {
  const t = SIZE_TOKENS[p.size] ?? SIZE_TOKENS.m;
  let pool = MODELS.filter((m) => m.tiers.includes(p.tier) && !(p.exclude ?? []).includes(m.id));
  // A tier with a single lab can't give a cross-lab reviewer; fall back rather than fail.
  if (!pool.length) pool = MODELS.filter((m) => m.tiers.includes(p.tier));
  if (p.pinnedModel) pool = pool.filter((m) => m.id === p.pinnedModel);
  const tagged = pool.filter((m) => m.tags.includes(p.tag));
  if (tagged.length) pool = tagged;

  const stats = await getDb()
    .select()
    .from(leaderboardStats)
    .where(and(eq(leaderboardStats.tag, p.tag), eq(leaderboardStats.tier, p.tier)))
    .catch(() => []);
  const passRate = new Map(stats.map((s) => [s.modelOrSeller, s.tasks >= 3 ? (s.passRate ?? 0) : null]));

  const scored = pool.map((m) => {
    const offers = [...m.offers]
      .filter((o) => o.rail !== "mpp-tempo-charge" || network().tempo.enabled || env().USE_SELLER_MESH)
      .sort((a, b) => Number(offerCost(a, t.in, t.out) - offerCost(b, t.in, t.out)));
    const offer = offers[0] ?? m.offers[0];
    const cost = offerCost(offer, t.in * t.calls, t.out * t.calls);
    const pr = passRate.get(m.id);
    const quality = pr == null ? m.quality : 0.5 * m.quality + 0.5 * pr;
    const costPenalty = Number(cost) / 5_000_000; // $5 ≈ 1.0
    const latencyPenalty = m.latencyMs / 60_000;
    return { model: m, offer, expectedCost: cost, score: quality - costPenalty - latencyPenalty };
  });
  return scored.sort((a, b) => b.score - a.score);
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Call a model through the chosen offer. Paid rails go through @builderos/fetch (a policy-checked purchase);
 * the private tier uses the NEAR AI Cloud key (disclosed, per-key spend cap).
 * Falls back within the tier on errors.
 */
export async function complete(
  p: { tag: string; tier: Tier; size: string; pinnedModel?: string | null; exclude?: string[]; taskId: string; departmentId: string; messages: ChatMessage[]; maxTokens?: number },
  deps: { fetch: BuilderFetch; log: Logger },
): Promise<{ text: string; model: string; provider: string; rail: string; usage?: { in: number; out: number } }> {
  const choices = await chooseModels(p);
  if (!choices.length) throw new Error(`no model in tier ${p.tier} for ${p.tag}`);
  const db = getDb();
  let lastErr: unknown;
  for (const c of choices.slice(0, 3)) {
    const started = Date.now();
    try {
      const body = JSON.stringify({ model: c.model.id, messages: p.messages, max_tokens: p.maxTokens ?? 4000 });
      let res: Response;
      if (c.offer.rail === "near-ai-cloud") {
        if (!env().NEAR_AI_API_KEY) throw new Error("NEAR_AI_API_KEY not set");
        res = await fetch(`${env().NEAR_AI_BASE_URL}${c.offer.url}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${env().NEAR_AI_API_KEY}` },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } else {
        const base = env().USE_SELLER_MESH ? `${env().SELLER_MESH_URL}/sellers/${c.offer.sellerId}` : await sellerBaseUrl(c.offer.sellerId);
        res = await deps.fetch(
          `${base}${c.offer.url}`,
          { method: "POST", headers: { "content-type": "application/json" }, body },
          { departmentId: p.departmentId, taskId: p.taskId, sellerId: c.offer.sellerId, model: c.model.id, tier: p.tier },
        );
      }
      if (!res.ok) throw new Error(`model ${c.model.id} http ${res.status}`);
      const json = (await res.json()) as any;
      const text = json.choices?.[0]?.message?.content ?? "";
      const usage = json.usage ? { in: json.usage.prompt_tokens, out: json.usage.completion_tokens } : undefined;
      await db.insert(modelCalls).values({
        taskId: p.taskId,
        model: c.model.id,
        provider: c.offer.sellerId,
        rail: c.offer.rail,
        tier: p.tier,
        tokensIn: usage?.in,
        tokensOut: usage?.out,
        cost: usage ? offerCost(c.offer, usage.in, usage.out).toString() : null,
        latencyMs: Date.now() - started,
        outcome: "ok",
      });
      return { text, model: c.model.id, provider: c.offer.sellerId, rail: c.offer.rail, usage };
    } catch (e: any) {
      lastErr = e;
      deps.log.warn({ model: c.model.id, err: e?.message }, "model call failed, trying next in tier");
      await db.insert(modelCalls).values({ taskId: p.taskId, model: c.model.id, provider: c.offer.sellerId, rail: c.offer.rail, tier: p.tier, latencyMs: Date.now() - started, outcome: "error" });
      // Purchase pending/rejected are not model failures; surface them.
      if (e?.name === "PurchasePending" || e?.constructor?.name === "PurchasePending" || e?.constructor?.name === "PurchaseRejected") throw e;
    }
  }
  throw lastErr;
}

const sellerUrls = new Map<string, string>();
async function sellerBaseUrl(sellerId: string) {
  const hit = sellerUrls.get(sellerId);
  if (hit) return hit;
  const { views } = await import("@builderos/near");
  const s = await views.getSeller(sellerId);
  if (!s?.endpoint) throw new Error(`seller ${sellerId} not in registry`);
  sellerUrls.set(sellerId, s.endpoint);
  return s.endpoint as string;
}
