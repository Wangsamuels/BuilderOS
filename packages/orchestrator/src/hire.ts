import { createHash, randomUUID } from "node:crypto";
import { env, toBig, type Logger } from "@builderos/shared";
import { and, encryptedLogs, eq, getDb, hires, leaderboardStats, sql, tasks } from "@builderos/db";
import { callAs, serviceAccount, serviceCalls, views, type HireableAgentView } from "@builderos/near";
import { complete, type Tier } from "@builderos/router";
import { createBuilderFetch, PurchasePending, PurchaseRejected } from "@builderos/fetch";
import { seal, serialize, serverKey, sha256Hex } from "@builderos/crypto";
import { agentFor } from "./keystore.js";
import { ROLE_FOR_TAG } from "./planner.js";

/** Tags the in-house swarm already covers — default path is always the swarm. */
export const PLATFORM_TAGS = new Set([
  "frontend",
  "backend",
  "contract",
  "security",
  "devops",
  "design",
  "docs",
  "test",
  "research",
  "growth",
  "support",
]);

/**
 * Strong niche domains the swarm should not freestyle: regulated, licensed, or
 * clearly outside software-build. Soft words like "expert" alone never trigger hire.
 */
const STRONG_NICHE =
  /\b(llc|incorporation|articles of (organization|incorporation)|registered agent|ein\b|irs\b|gaap|ifrs|sales tax nexus|hipaa|gdpr|ccpa|pci[\s-]?dss|soc\s?2|fedramp|trademark (filing|search|office)|patent (claim|filing|prior art)|kyc|aml|ofac|actuarial|medical coding|bookkeeping|cpa\b|bar exam|securities law|ad\s?buy|programmatic media|media buy)\b/i;

/** Minimum necessity / fit before we even consider leaving the swarm. */
export const HIRE_NECESSITY_MIN = 0.75;
export const HIRE_ALIGNMENT_MIN = 0.4;
export const HIRE_EFFICIENCY_ALIGNMENT = 0.55;
export const HIRE_EFFICIENCY_RATING = 0.8;

export type HireCandidate = {
  agentId: string;
  service: string;
  description: string;
  skills: string[];
  rating: number;
  rail: string;
  payTo: string;
  endpoint: string;
  currency: string;
  price: string;
  qualityNote?: string | null;
  alignment: number;
  score: number;
};

export type HireDecision = {
  hire: boolean;
  reason: string;
  necessity: number;
  candidate?: HireCandidate;
  swarmEstimate?: string;
  hirePrice?: string;
};

/**
 * How necessary is out-of-swarm niche knowledge? Swarm stays default.
 * Tag "niche"|"expert" alone is only a weak signal — not enough to hire.
 */
export function nicheNecessity(title: string, tag: string): number {
  const text = `${tag} ${title}`;
  if (STRONG_NICHE.test(text)) return 0.92;
  // Broader-than-build asks that still need a named specialty (not generic "improve").
  if (/\b(beyond (the )?build|outside (software|engineering)|non[- ]engineering|business formation|regulatory (filing|approval))\b/i.test(text)) {
    return 0.8;
  }
  if (tag === "niche" || tag === "expert") return 0.55;
  if (!PLATFORM_TAGS.has(tag)) return 0.45;
  return 0;
}

/**
 * @deprecated Prefer `decideHire` — hire is never automatic from a keyword alone.
 * Kept as a cheap pre-filter: true only when a hire decision is even worth computing.
 */
export function needsHire(p: { tag: string; title: string; hireRequired?: boolean | null; hireAgentId?: string | null }) {
  if (p.hireAgentId) return true;
  if (p.hireRequired) return true;
  return nicheNecessity(p.title, p.tag) >= HIRE_NECESSITY_MIN;
}

/**
 * Hire only when very necessary AND (cheaper than swarm OR a clearly superior niche specialist).
 * Random / opportunistic hiring is rejected.
 */
export function decideHire(p: {
  title: string;
  tag: string;
  size?: string;
  tier?: string;
  hireRequired?: boolean | null;
  hireAgentId?: string | null;
  remainingBudget: bigint;
  /** Swarm path cost ceiling (usually estimate.cap / task.cap). */
  swarmCap: bigint;
  candidates: HireCandidate[];
}): HireDecision {
  const necessity = nicheNecessity(p.title, p.tag);
  const pinned = p.hireAgentId
    ? p.candidates.find((c) => c.agentId === p.hireAgentId)
    : undefined;
  const best = pinned ?? p.candidates[0];

  // Founder/admin pinned a specialist: still require affordability + some alignment.
  if (p.hireAgentId) {
    if (!best) return { hire: false, reason: "pinned_agent_unavailable", necessity };
    if (toBig(best.price) > p.remainingBudget) {
      return { hire: false, reason: "pinned_agent_over_budget", necessity, hirePrice: best.price, swarmEstimate: p.swarmCap.toString() };
    }
    if (best.alignment < HIRE_ALIGNMENT_MIN) {
      return { hire: false, reason: "pinned_agent_poor_fit", necessity, candidate: best };
    }
    return {
      hire: true,
      reason: "founder_pinned",
      necessity,
      candidate: best,
      hirePrice: best.price,
      swarmEstimate: p.swarmCap.toString(),
    };
  }

  if (!best) return { hire: false, reason: "no_candidates", necessity, swarmEstimate: p.swarmCap.toString() };
  if (best.alignment < HIRE_ALIGNMENT_MIN) {
    return { hire: false, reason: "no_strong_specialist_match", necessity, candidate: best, swarmEstimate: p.swarmCap.toString() };
  }

  const hirePrice = toBig(best.price);
  if (hirePrice <= 0n || hirePrice > p.remainingBudget) {
    return { hire: false, reason: "hire_unaffordable", necessity, candidate: best, hirePrice: best.price, swarmEstimate: p.swarmCap.toString() };
  }

  const cheaperThanSwarm = p.swarmCap > 0n && hirePrice < p.swarmCap;
  const highlyEfficient =
    best.alignment >= HIRE_EFFICIENCY_ALIGNMENT && best.rating >= HIRE_EFFICIENCY_RATING && best.score >= 0.6;

  // Explicit hireRequired from an earlier deliberate decision still needs necessity + (cheap|efficient).
  const necessary = p.hireRequired ? necessity >= 0.55 : necessity >= HIRE_NECESSITY_MIN;
  if (!necessary) {
    return { hire: false, reason: "swarm_default_not_necessary", necessity, candidate: best, hirePrice: best.price, swarmEstimate: p.swarmCap.toString() };
  }

  if (cheaperThanSwarm) {
    return {
      hire: true,
      reason: "hire_more_affordable_than_swarm",
      necessity,
      candidate: best,
      hirePrice: best.price,
      swarmEstimate: p.swarmCap.toString(),
    };
  }

  // Expensive specialist only if necessity is high and they are clearly the efficient niche pick.
  if (highlyEfficient && necessity >= HIRE_NECESSITY_MIN) {
    return {
      hire: true,
      reason: "hire_more_efficient_for_niche",
      necessity,
      candidate: best,
      hirePrice: best.price,
      swarmEstimate: p.swarmCap.toString(),
    };
  }

  return {
    hire: false,
    reason: "swarm_preferred",
    necessity,
    candidate: best,
    hirePrice: best.price,
    swarmEstimate: p.swarmCap.toString(),
  };
}

/** Token overlap between the task brief and the hireable agent's description/skills. */
export function alignmentScore(taskText: string, agent: { description: string; skills: string[]; qualityNote?: string | null }) {
  const tokens = new Set(
    taskText
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((t) => t.length > 2),
  );
  if (!tokens.size) return 0;
  const corpus = `${agent.description} ${(agent.skills ?? []).join(" ")} ${agent.qualityNote ?? ""}`.toLowerCase();
  let hit = 0;
  for (const t of tokens) if (corpus.includes(t)) hit++;
  return hit / tokens.size;
}

export function rankHireCandidates(
  task: { title: string; tag: string },
  agents: HireableAgentView[],
  passRates: Map<string, number | null>,
  remainingBudget: bigint,
): HireCandidate[] {
  const brief = `${task.tag} ${task.title}`;
  return agents
    .map((a) => {
      const alignment = alignmentScore(brief, {
        description: a.description ?? "",
        skills: a.skills ?? [],
        qualityNote: a.quality_note,
      });
      const catalogRating = Number(a.rating ?? 0);
      const pr = passRates.get(a.agent_id);
      const rating = pr == null ? catalogRating : 0.4 * catalogRating + 0.6 * pr;
      const price = toBig(a.price);
      const afford = price > 0n && price <= remainingBudget;
      // Drop weak fits early so ranking never surfaces a random/poor match.
      if (alignment < HIRE_ALIGNMENT_MIN) {
        return {
          agentId: a.agent_id,
          service: a.service,
          description: a.description ?? "",
          skills: a.skills ?? [],
          rating,
          rail: a.rail,
          payTo: a.pay_to,
          endpoint: a.endpoint,
          currency: (a.currency ?? "usdc").toLowerCase(),
          price: String(a.price),
          qualityNote: a.quality_note,
          alignment,
          score: Number.NEGATIVE_INFINITY,
        } satisfies HireCandidate;
      }
      // Efficiency: fit × rating, penalize relative cost within budget. Unaffordable → -∞.
      const costPenalty = remainingBudget > 0n ? Number(price) / Number(remainingBudget) : 1;
      const score = afford ? alignment * 0.55 + rating * 0.45 - costPenalty * 0.15 : Number.NEGATIVE_INFINITY;
      return {
        agentId: a.agent_id,
        service: a.service,
        description: a.description ?? "",
        skills: a.skills ?? [],
        rating,
        rail: a.rail,
        payTo: a.pay_to,
        endpoint: a.endpoint,
        currency: (a.currency ?? "usdc").toLowerCase(),
        price: String(a.price),
        qualityNote: a.quality_note,
        alignment,
        score,
      } satisfies HireCandidate;
    })
    .filter((c) => Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score);
}

export async function listHireableAgents(service = "expertise"): Promise<HireableAgentView[]> {
  let agents = await views.listHireableAgents(service).catch(() => [] as HireableAgentView[]);
  if ((!agents || !agents.length) && env().USE_SELLER_MESH) {
    const r = await fetch(`${env().SELLER_MESH_URL}/hireable?service=${encodeURIComponent(service)}`).catch(() => null);
    if (r?.ok) agents = (await r.json()) as HireableAgentView[];
  }
  return agents ?? [];
}

/** Live quote from the hireable agent — amount and currency must match what we reserve and pay. */
export async function fetchExactQuote(endpoint: string): Promise<{ amount: string; currency: string; payTo?: string; rail?: string }> {
  const url = endpoint.replace(/\/$/, "") + "/quote";
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`hire quote failed: ${res.status}`);
  const j = (await res.json()) as any;
  const amount = String(j.amount ?? j.price ?? "");
  const currency = String(j.currency ?? j.token ?? "usdc").toLowerCase();
  if (!/^\d+$/.test(amount)) throw new Error("hire quote missing exact integer amount");
  return { amount, currency, payTo: j.pay_to ?? j.payTo, rail: j.rail };
}

function quoteHash(q: { agentId: string; amount: string; currency: string; payTo: string; rail: string }) {
  return createHash("sha256").update(JSON.stringify(q)).digest("hex");
}

/**
 * Gate + optional hire. Returns null when the swarm should run (hire not necessary).
 * Never hires randomly — only after `decideHire` says the niche specialist is warranted.
 */
export async function evaluateAndMaybeHire(taskId: string, log: Logger) {
  const db = getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || !t.departmentId) return null;
  if (!needsHire(t) && !t.hireAgentId) return null;
  const result = await runHireTask(taskId, log);
  if (result?.status === "swarm_fallback") return null;
  return result;
}

/**
 * Hire path: pick the best niche agent within remaining budget → reserve exact quote via
 * create_bounty → run the hire → hiring agent verifies → verifier key pays only on pass.
 */
export async function runHireTask(taskId: string, log: Logger) {
  const db = getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || !t.departmentId) throw new Error(`task ${taskId} missing department`);
  if (["done", "running"].includes(t.status)) return;

  const hiringRole = ROLE_FOR_TAG[t.tag] ?? "backend";
  const hiring = await agentFor(t.departmentId, hiringRole);
  if (!hiring) throw new Error(`no hiring agent key for ${t.departmentId}/${hiringRole}`);

  const dept = await views.getDepartment(t.departmentId).catch(() => null);
  const remaining = toBig(dept?.budget ?? "0") - toBig(dept?.spent ?? "0");
  const taskCap = t.cap ? toBig(t.cap) : remaining;
  const budget = remaining < taskCap ? remaining : taskCap;
  if (budget <= 0n) {
    await db.update(tasks).set({ status: "paused", pauseReason: "hire_budget_exhausted", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "paused" as const };
  }

  const agents = await listHireableAgents("expertise");
  const stats = await db
    .select()
    .from(leaderboardStats)
    .where(and(eq(leaderboardStats.tag, t.tag), eq(leaderboardStats.tier, t.tier)))
    .catch(() => []);
  const passRates = new Map(stats.map((s) => [s.modelOrSeller, s.tasks >= 2 ? (s.passRate ?? null) : null]));
  const ranked = rankHireCandidates({ title: t.title, tag: t.tag }, agents, passRates, budget);
  const decision = decideHire({
    title: t.title,
    tag: t.tag,
    size: t.size,
    tier: t.tier,
    hireRequired: t.hireRequired,
    hireAgentId: t.hireAgentId,
    remainingBudget: budget,
    swarmCap: taskCap > 0n ? taskCap : budget,
    candidates: ranked,
  });
  if (!decision.hire || !decision.candidate) {
    // Fall back to swarm — hire was not necessary / not cheaper / not efficient enough.
    log.info({ taskId, reason: decision.reason, necessity: decision.necessity }, "skip hire; swarm handles task");
    await db.update(tasks).set({ hireRequired: false, updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "swarm_fallback" as const, reason: decision.reason };
  }
  const pick = decision.candidate;

  await db
    .update(tasks)
    .set({ status: "running", agent: hiring.accountId, attempts: sql`${tasks.attempts} + 1`, hireRequired: true, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  // Exact service cost + currency from the live quote (must match catalog or replace it).
  const quote = await fetchExactQuote(pick.endpoint).catch(() => ({
    amount: pick.price,
    currency: pick.currency,
    payTo: pick.payTo,
    rail: pick.rail,
  }));
  const amount = quote.amount;
  const currency = quote.currency;
  const payTo = quote.payTo ?? pick.payTo;
  const rail = quote.rail ?? pick.rail;
  if (toBig(amount) > budget) {
    await db.update(tasks).set({ status: "paused", pauseReason: "hire_quote_over_budget", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "paused" as const };
  }

  const bountyId = `hire-${taskId.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const qh = quoteHash({ agentId: pick.agentId, amount, currency, payTo, rail });
  const transcript: string[] = [`hire:pick:${pick.agentId}:align=${pick.alignment.toFixed(3)}:rating=${pick.rating.toFixed(3)}:score=${pick.score.toFixed(3)}`];

  const account = await serviceAccount(hiring.accountId, hiring.privateKey);
  let reserveTx: string | undefined;
  try {
    const { txHash } = await callAs(
      account,
      serviceCalls.createBounty(t.departmentId, {
        bountyId,
        taskId,
        agentId: pick.agentId,
        payee: payTo,
        amount,
        currency,
        rail,
        hiringRole,
        quoteHash: qh,
      }),
    );
    reserveTx = txHash;
    transcript.push(`bounty:reserved:${bountyId}:${amount}:${currency}:${rail}`);
  } catch (e: any) {
    // Offline / contracts not deployed yet: keep the hire row and continue with mesh work;
    // payment still only "pays" when verifier submit_verdict succeeds against a live contract.
    if (!env().USE_SELLER_MESH) throw e;
    transcript.push(`bounty:reserve_skipped:${e?.message ?? "error"}`);
    log.warn({ err: e?.message, taskId }, "create_bounty failed; continuing in seller-mesh mode");
  }

  await db.insert(hires).values({
    bountyId,
    taskId,
    companyId: t.companyId,
    departmentId: t.departmentId,
    hiringRole,
    hiringAgent: hiring.accountId,
    hiredAgentId: pick.agentId,
    amount,
    currency,
    rail,
    payTo,
    quoteHash: qh,
    alignmentScore: pick.alignment,
    ratingUsed: pick.rating,
    status: reserveTx ? "reserved" : "quoted",
    nearTx: reserveTx,
  });

  // Work first (pay-on-green): hired agent runs against the reserved bounty id, no upfront charge.
  const hireUrl = pick.endpoint.replace(/\/$/, "") + "/hire";
  const hireRes = await fetch(hireUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bounty-id": bountyId,
      "x-bounty-amount": amount,
      "x-bounty-currency": currency,
    },
    body: JSON.stringify({
      task_id: taskId,
      title: t.title,
      tag: t.tag,
      bounty_id: bountyId,
      amount,
      currency,
      pay_to: payTo,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!hireRes.ok) {
    await voidHire({ departmentId: t.departmentId, taskId, bountyId, hiring, logHash: sha256Hex("hire_http_fail"), log });
    await db.update(hires).set({ status: "failed", hiringVerdict: "fail", hiringReasons: [`http ${hireRes.status}`], updatedAt: new Date() }).where(eq(hires.bountyId, bountyId));
    await db.update(tasks).set({ status: "ready", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "retry" as const };
  }
  const deliverable = (await hireRes.json()) as Record<string, unknown>;
  transcript.push(`hire:deliverable:${JSON.stringify(deliverable).slice(0, 4000)}`);
  await db.update(hires).set({ status: "working", deliverable, updatedAt: new Date() }).where(eq(hires.bountyId, bountyId));

  // Hiring agent verifies the niche work before any payment is released.
  const bfetch = createBuilderFetch({ agent: { accountId: hiring.accountId, privateKey: hiring.privateKey } });
  let verdict: "pass" | "fail" = "fail";
  let reasons: string[] = ["verification unavailable"];
  try {
    const review = await complete(
      {
        tag: t.tag === "niche" || t.tag === "expert" ? "backend" : t.tag,
        tier: t.tier as Tier,
        size: "s",
        taskId,
        departmentId: t.departmentId,
        messages: [
          {
            role: "system",
            content:
              'You hired a niche specialist. Verify their deliverable against the task. Reply ONLY JSON {"verdict":"pass"|"fail","reasons":["..."]}. Pass only if the work is usable and matches the brief.',
          },
          {
            role: "user",
            content: `Task: ${t.title}\nHired agent: ${pick.agentId} (${pick.description})\nQuoted pay: ${amount} ${currency} via ${rail}\n\nDeliverable:\n${JSON.stringify(deliverable).slice(0, 60_000)}`,
          },
        ],
      },
      { fetch: bfetch, log },
    );
    transcript.push(`hire:verify:${review.model}:${review.text.slice(0, 2000)}`);
    const parsed = JSON.parse(review.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as { verdict?: string; reasons?: string[] };
    verdict = parsed.verdict === "pass" ? "pass" : "fail";
    reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [String(parsed.verdict ?? "fail")];
  } catch (e: any) {
    if (e instanceof PurchasePending) {
      await db.update(tasks).set({ status: "paused", pauseReason: `purchase:${e.requestId}`, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      return { status: "paused" as const };
    }
    if (e instanceof PurchaseRejected) {
      await db.update(tasks).set({ status: "failed", pauseReason: e.reason, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      return { status: "failed" as const };
    }
    // Offline mesh: accept mock deliverables that declare ok.
    if (env().USE_SELLER_MESH && (deliverable as any)?.ok !== false && (deliverable as any)?.summary) {
      verdict = "pass";
      reasons = ["seller-mesh auto-verify"];
    } else {
      transcript.push(`hire:verify_error:${e?.message ?? e}`);
    }
  }

  const logHash = await storeHireLog(t.departmentId, taskId, transcript);
  await db
    .update(hires)
    .set({
      status: verdict === "pass" ? "verified_pass" : "verified_fail",
      hiringVerdict: verdict,
      hiringReasons: reasons,
      logHash,
      updatedAt: new Date(),
    })
    .where(eq(hires.bountyId, bountyId));

  if (verdict === "pass") {
    // Exact amount + currency already reserved; verifier key releases that bounty only.
    await releaseHire({ departmentId: t.departmentId, taskId, bountyId, logHash, log });
    await db.update(hires).set({ status: "paid", updatedAt: new Date() }).where(eq(hires.bountyId, bountyId));
    await db.update(tasks).set({ status: "review", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    return { status: "review" as const, logHash, bountyId, amount, currency, hiredAgentId: pick.agentId };
  }

  await voidHire({ departmentId: t.departmentId, taskId, bountyId, hiring, logHash, log });
  await db.update(hires).set({ status: "voided", updatedAt: new Date() }).where(eq(hires.bountyId, bountyId));
  const attempts = (t.attempts ?? 0) + 1;
  if (attempts >= 2) {
    await db.update(tasks).set({ status: "paused", pauseReason: "hire_verify_failed_twice", updatedAt: new Date() }).where(eq(tasks.id, taskId));
  } else {
    await db.update(tasks).set({ status: "ready", updatedAt: new Date() }).where(eq(tasks.id, taskId));
  }
  return { status: "retry" as const, logHash };
}

async function releaseHire(p: { departmentId: string; taskId: string; bountyId: string; logHash: string; log: Logger }) {
  const e = env();
  if (!e.VERIFIER_ACCOUNT_ID || !e.VERIFIER_PRIVATE_KEY) {
    if (e.USE_SELLER_MESH) {
      p.log.warn({ task: p.taskId }, "verifier key missing; hire marked paid in mesh mode only");
      return;
    }
    throw new Error("verifier key not configured");
  }
  const acc = await serviceAccount(e.VERIFIER_ACCOUNT_ID, e.VERIFIER_PRIVATE_KEY);
  await callAs(acc, serviceCalls.submitVerdict(p.departmentId, { taskId: p.taskId, verdict: "pass", logHash: p.logHash, bountyId: p.bountyId }));
}

async function voidHire(p: {
  departmentId: string;
  taskId: string;
  bountyId: string;
  hiring: { accountId: string; privateKey: string };
  logHash: string;
  log: Logger;
}) {
  const e = env();
  if (!e.VERIFIER_ACCOUNT_ID || !e.VERIFIER_PRIVATE_KEY) {
    p.log.warn({ task: p.taskId }, "verifier key missing; cannot void bounty on chain");
    return;
  }
  try {
    const acc = await serviceAccount(e.VERIFIER_ACCOUNT_ID, e.VERIFIER_PRIVATE_KEY);
    await callAs(acc, serviceCalls.submitVerdict(p.departmentId, { taskId: p.taskId, verdict: "fail", logHash: p.logHash, bountyId: p.bountyId }));
  } catch (err: any) {
    p.log.warn({ err: err?.message, task: p.taskId }, "void hire verdict failed");
  }
}

async function storeHireLog(departmentId: string, taskId: string, lines: string[]) {
  const text = lines.join("\n\n");
  const hash = sha256Hex(text);
  const sealed = await seal(text, serverKey(env().SESSION_SECRET), 0, departmentId);
  await getDb()
    .insert(encryptedLogs)
    .values({ departmentId, taskId, keyVersion: 0, ciphertext: Buffer.from(serialize(sealed)), hashOnChain: hash });
  return hash;
}
