import { env } from "@builderos/shared";
import { classifyTag, estimate, type Tier } from "@builderos/router";
import type { PlanFeature } from "@builderos/db";

/** 8 build roles plus the business roles. Tag -> role used to pick the (hiring) agent. */
export const ROLE_FOR_TAG: Record<string, string> = {
  frontend: "frontend",
  backend: "backend",
  contract: "contracts",
  security: "security",
  devops: "devops",
  design: "designer",
  docs: "writer",
  test: "qa",
  research: "scout",
  growth: "growth",
  support: "support",
  niche: "backend",
  expert: "backend",
};

const SIZES = ["xs", "s", "m", "l", "xl"] as const;
function sizeOf(text: string) {
  const words = text.split(/\s+/).length;
  return words < 8 ? "s" : words < 20 ? "m" : words < 40 ? "l" : "xl";
}

/** Heuristic planner (works offline and in tests). */
export function heuristicPlan(description: string): PlanFeature[] {
  const lines = description
    .split(/\n|(?<=\.)\s+/)
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 6)
    .slice(0, 12);
  const feats: PlanFeature[] = lines.map((l, i) => {
    const tag = classifyTag(l);
    return { key: `f${i + 1}`, title: l.slice(0, 120), tag, size: sizeOf(l), dependsOn: [] };
  });
  // Contracts and backend come first; frontend depends on backend; tests depend on everything.
  const backend = feats.filter((f) => f.tag === "backend" || f.tag === "contract").map((f) => f.key);
  for (const f of feats) {
    if (f.tag === "frontend") f.dependsOn = backend;
    if (f.tag === "test") f.dependsOn = feats.filter((x) => x.key !== f.key && x.tag !== "test").map((x) => x.key);
  }
  if (!feats.some((f) => f.tag === "devops")) feats.push({ key: `f${feats.length + 1}`, title: "Deploy to Run402", tag: "devops", size: "s", dependsOn: feats.map((f) => f.key) });
  return feats;
}

/** Planner through NEAR AI Cloud (private tier) when a key is configured, else heuristic. */
export async function plan(description: string, tier: Tier) {
  let features: PlanFeature[] | null = null;
  const e = env();
  if (e.NEAR_AI_API_KEY) {
    try {
      const res = await fetch(`${e.NEAR_AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${e.NEAR_AI_API_KEY}` },
        body: JSON.stringify({
          model: "deepseek-ai/DeepSeek-V3.1",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'You plan software builds. Prefer platform tags (frontend|backend|contract|security|devops|design|docs|test). Use tag niche|expert ONLY when the work needs regulated/licensed specialty knowledge the build swarm cannot do (legal formation, tax, HIPAA/PCI, trademark filing, media buy) — never for ordinary product improvements. Reply JSON {"features":[{"key":"f1","title":"...","tag":"...","size":"xs|s|m|l|xl","dependsOn":["f0"]}]}. Max 12 features.',
            },
            { role: "user", content: description },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = (await res.json()) as any;
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      if (Array.isArray(parsed.features) && parsed.features.length) {
        features = parsed.features.map((f: any, i: number) => {
          const title = String(f.title).slice(0, 200);
          const raw = String(f.tag ?? "");
          const tag = raw in ROLE_FOR_TAG || raw === "niche" || raw === "expert" ? raw : classifyTag(title);
          return {
            key: String(f.key ?? `f${i + 1}`),
            title,
            tag,
            size: (SIZES as readonly string[]).includes(f.size) ? f.size : "m",
            dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn.map(String) : [],
          };
        });
      }
    } catch {
      features = null;
    }
  }
  features ??= heuristicPlan(description);
  return { features, estimate: planEstimate(features, tier) };
}

/** Plan totals (micro-USDC strings) from its features; reused when a draft plan is edited. */
export function planEstimate(features: PlanFeature[], tier: Tier) {
  const perFeature = features.map((f) => ({ key: f.key, ...estimate(f.tag, f.size, tier) }));
  const sum = (k: "p50" | "p90" | "cap") => perFeature.reduce((a, f) => a + BigInt(f[k]), 0n).toString();
  return { tier, p50: sum("p50"), p90: sum("p90"), cap: sum("cap"), perFeature };
}

/** Kahn topological sort; throws on cycles so a bad plan can't deadlock the queue. */
export function topoOrder(features: PlanFeature[]): string[] {
  const indeg = new Map(features.map((f) => [f.key, 0]));
  for (const f of features) for (const d of f.dependsOn) if (indeg.has(d)) indeg.set(f.key, (indeg.get(f.key) ?? 0) + 1);
  const q = [...indeg].filter(([, n]) => n === 0).map(([k]) => k);
  const out: string[] = [];
  while (q.length) {
    const k = q.shift()!;
    out.push(k);
    for (const f of features) if (f.dependsOn.includes(k)) {
      indeg.set(f.key, indeg.get(f.key)! - 1);
      if (indeg.get(f.key) === 0) q.push(f.key);
    }
  }
  if (out.length !== features.length) throw new Error("plan has a dependency cycle");
  return out;
}

// ---------- teams ----------

/** The kind of team a task belongs to. Reports, budgets and analytics are grouped by team. */
export type TeamKind = "build" | "ops" | "growth" | "support";
const KIND_FOR_TAG: Record<string, TeamKind> = { devops: "ops", growth: "growth", support: "support" };
export const teamKindForTag = (tag: string): TeamKind => KIND_FOR_TAG[tag] ?? "build";

/** Names a company may have given each kind of team (first match wins). */
export const TEAM_ALIASES: Record<TeamKind, string[]> = {
  build: ["build", "eng", "engineering", "dev", "product", "core"],
  ops: ["ops", "devops", "infra", "platform"],
  growth: ["growth", "marketing", "sales"],
  support: ["support", "success", "cs", "community", "growth"],
};

/**
 * Which of a company's teams gets a task with this tag. Falls back to the build team, then the first team,
 * so a company with custom team names (eng/growth/ops/support) still routes every task somewhere sensible.
 */
export function pickTeam(tag: string, teamNames: string[]): string | null {
  if (!teamNames.length) return null;
  const kind = teamKindForTag(tag);
  for (const k of [kind, "build" as TeamKind]) for (const alias of TEAM_ALIASES[k]) if (teamNames.includes(alias)) return alias;
  return teamNames[0];
}

const DOLLAR = 1_000_000n;
const roundUpDollars = (micro: bigint) => ((micro + DOLLAR - 1n) / DOLLAR) * DOLLAR;

/**
 * Company setup suggested by a plan: one team per kind of work in it, each budgeted at its tasks' caps
 * + 20% headroom (rounded up to whole dollars, at least $5), a per-purchase limit of 5% of the budget
 * (at least $0.50) and a daily cap of a quarter of the total (at least $10). All amounts micro-USDC.
 */
export function suggestSetup(features: PlanFeature[], perFeature: Array<{ key: string; cap: string }>, title: string) {
  const capOf = new Map(perFeature.map((f) => [f.key, BigInt(f.cap)]));
  const byTeam = new Map<string, { features: string[]; cap: bigint }>();
  for (const f of features) {
    const kind = teamKindForTag(f.tag);
    const team = kind === "support" ? "growth" : kind; // small companies: support sits with growth
    const t = byTeam.get(team) ?? { features: [], cap: 0n };
    t.features.push(f.key);
    t.cap += capOf.get(f.key) ?? 0n;
    byTeam.set(team, t);
  }
  const order: string[] = ["build", "ops", "growth"];
  const teams = [...byTeam.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([team, t]) => {
      let budget = roundUpDollars((t.cap * 12n) / 10n);
      if (budget < 5n * DOLLAR) budget = 5n * DOLLAR;
      let perTx = budget / 20n;
      if (perTx < DOLLAR / 2n) perTx = DOLLAR / 2n;
      return { team, monthlyCap: budget.toString(), perTxLimit: perTx.toString(), features: t.features, estimatedCap: t.cap.toString() };
    });
  const total = teams.reduce((a, t) => a + BigInt(t.monthlyCap), 0n);
  let daily = roundUpDollars(total / 4n);
  if (daily < 10n * DOLLAR) daily = 10n * DOLLAR;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "") || "my-company";
  return { name: title.slice(0, 64), slug: slug.length >= 2 ? slug : `${slug}-co`, dailyCap: daily.toString(), teams, units: "micro-USDC" };
}
