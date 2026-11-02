import { env } from "@builderos/shared";
import { classifyTag, estimate, type Tier } from "@builderos/router";
import type { PlanFeature } from "@builderos/db";

/** 8 build roles plus the business roles. Tag -> role used to pick the agent. */
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
  const feats: PlanFeature[] = lines.map((l, i) => ({ key: `f${i + 1}`, title: l.slice(0, 120), tag: classifyTag(l), size: sizeOf(l), dependsOn: [] }));
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
                'You plan software builds. Reply with JSON {"features":[{"key":"f1","title":"...","tag":"frontend|backend|contract|security|devops|design|docs|test","size":"xs|s|m|l|xl","dependsOn":["f0"]}]}. Max 12 features.',
            },
            { role: "user", content: description },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const j = (await res.json()) as any;
      const parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      if (Array.isArray(parsed.features) && parsed.features.length) {
        features = parsed.features.map((f: any, i: number) => ({
          key: String(f.key ?? `f${i + 1}`),
          title: String(f.title).slice(0, 200),
          tag: ROLE_FOR_TAG[f.tag] ? f.tag : classifyTag(String(f.title)),
          size: (SIZES as readonly string[]).includes(f.size) ? f.size : "m",
          dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn.map(String) : [],
        }));
      }
    } catch {
      features = null;
    }
  }
  features ??= heuristicPlan(description);
  const perFeature = features.map((f) => ({ key: f.key, ...estimate(f.tag, f.size, tier) }));
  const sum = (k: "p50" | "p90" | "cap") => perFeature.reduce((a, f) => a + BigInt(f[k]), 0n).toString();
  return { features, estimate: { tier, p50: sum("p50"), p90: sum("p90"), cap: sum("cap"), perFeature } };
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
