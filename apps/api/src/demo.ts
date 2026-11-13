/**
 * Sample company for the "See a demo" button: a fixed, invented company ("Lumen Notes") served read-only at
 * GET /v1/demo. It isn't any real company and reads nothing from the chain or the database, so showing it
 * can't leak anyone's data. Shapes match the real endpoints so the same screens render it. Dates move with
 * the clock and the numbers are deterministic, so every visitor sees the same consistent company.
 */

const DAY = 86_400_000;
const FACTORY = "demo.builderos.sample";
export const DEMO_COMPANY_ID = `lumen-notes.${FACTORY}`;
const dept = (n: string) => `${n}.${DEMO_COMPANY_ID}`;

/** Small deterministic PRNG (mulberry32) so the demo is identical for everyone. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS = [
  { name: "build", budget: 400_000_000n, perTx: 5_000_000n, base: 2_600_000, models: ["deepseek-v3.1", "qwen3-coder", "glm-4.6"] },
  { name: "ops", budget: 120_000_000n, perTx: 2_000_000n, base: 650_000, models: ["qwen3-coder", "gpt-oss-120b"] },
  { name: "growth", budget: 150_000_000n, perTx: 2_000_000n, base: 900_000, models: ["gpt-oss-120b", "deepseek-v3.1"] },
  { name: "support", budget: 60_000_000n, perTx: 1_000_000n, base: 300_000, models: ["gpt-oss-120b"] },
] as const;

const SELLERS = ["near-ai-x402", "pingpay-models", "search-api", "email-sender"];

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const today0 = () => Math.floor(Date.now() / DAY) * DAY;

/** Daily spend per team for the last 90 days (micro-USDC), with a weekday rhythm and a rising trend. */
function spendSeries() {
  const r = rng(42);
  const start = today0() - 89 * DAY;
  const rows: Array<{ day: string; team: string; amount: bigint; model: string; seller: string; purchases: number }> = [];
  for (let i = 0; i < 90; i++) {
    const t = start + i * DAY;
    const weekday = new Date(t).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const trend = 0.55 + (i / 90) * 0.75;
    for (const team of TEAMS) {
      const amt = Math.round(team.base * weekend * trend * (0.6 + r() * 0.8));
      const model = team.models[Math.floor(r() * team.models.length)];
      const seller = team.name === "growth" && r() < 0.3 ? "search-api" : team.name === "support" && r() < 0.4 ? "email-sender" : SELLERS[Math.floor(r() * 2)];
      rows.push({ day: dayKey(t), team: team.name, amount: BigInt(amt), model, seller, purchases: 3 + Math.floor(r() * 18) });
    }
  }
  return rows;
}

const FEATURES = [
  { key: "f1", title: "Accounts: sign up with email and Google", tag: "backend", team: "build", status: "done" },
  { key: "f2", title: "Notes API with sharing and version history", tag: "backend", team: "build", status: "done" },
  { key: "f3", title: "Editor UI with offline drafts", tag: "frontend", team: "build", status: "done" },
  { key: "f4", title: "Billing: monthly plan with Stripe checkout", tag: "backend", team: "build", status: "review" },
  { key: "f5", title: "Security review of sharing links", tag: "security", team: "build", status: "running" },
  { key: "f6", title: "End-to-end tests for the editor", tag: "test", team: "build", status: "assigned" },
  { key: "f7", title: "Deploy pipeline and uptime alerts", tag: "devops", team: "ops", status: "done" },
  { key: "f8", title: "Nightly database backups with restore drill", tag: "devops", team: "ops", status: "paused" },
  { key: "f9", title: "Launch page and waitlist", tag: "growth", team: "growth", status: "done" },
  { key: "f10", title: "Weekly product-update email", tag: "growth", team: "growth", status: "running" },
  { key: "f11", title: "Help center with the 20 top questions", tag: "support", team: "support", status: "done" },
  { key: "f12", title: "Reply drafts for support inbox", tag: "support", team: "support", status: "failed" },
];

const SUMMARIES: Record<string, string> = {
  f1: "Added email + Google sign-up with verified emails, session cookies and rate limits on login. Tests cover sign-up, wrong password and expired links.",
  f2: "Notes API: create, edit, share by link (read or edit), and keep the last 50 versions per note. Sharing links can be revoked.",
  f3: "Editor with autosave, offline drafts in the browser and conflict prompts when two people edit the same note.",
  f4: "Monthly plan with Stripe Checkout and a webhook that turns the plan on. Waiting for the review agent.",
  f7: "CI builds and deploys on every merge; uptime checks every minute with an alert to the ops channel.",
  f8: "Backups run nightly. The restore drill needs a paid storage service — waiting for your approval of the purchase.",
  f9: "Launch page with a waitlist form, social preview images and a thank-you email.",
  f11: "Help center with the 20 most likely questions, written from the product's features and settings.",
  f12: "Couldn't finish: the email seller asked to be paid at a different address than the one allowed, so the purchase was blocked.",
};

function reports() {
  const r = rng(7);
  const now = Date.now();
  return FEATURES.filter((f) => f.status !== "assigned").map((f, i) => {
    const outcome = f.status === "done" ? "done" : f.status === "review" ? "needs_review" : f.status === "paused" ? "paused" : f.status === "failed" ? "failed" : "retrying";
    const team = TEAMS.find((t) => t.name === f.team)!;
    const cost = BigInt(Math.round(180_000 + r() * 1_400_000));
    const at = new Date(now - Math.round((i * 9 + r() * 6) * 3_600_000));
    const files =
      f.tag === "frontend"
        ? ["web/editor/Editor.tsx", "web/editor/offline.ts", "web/editor/conflicts.ts"]
        : f.tag === "devops"
          ? ["ops/deploy.yml", "ops/uptime.ts"]
          : f.tag === "growth"
            ? ["site/launch.html", "site/waitlist.ts"]
            : f.tag === "support"
              ? ["help/questions.md"]
              : [`api/${f.key}/routes.ts`, `api/${f.key}/service.ts`, `api/${f.key}/service.test.ts`];
    return {
      id: `00000000-0000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`,
      taskId: `demo-${f.key}`,
      attempt: f.status === "failed" ? 2 : 1,
      planId: "00000000-0000-4000-8000-00000000a001",
      departmentId: dept(f.team),
      team: f.team,
      title: f.title,
      tag: f.tag,
      outcome,
      agent: `${f.tag}-agent.${dept(f.team)}`,
      summary: SUMMARIES[f.key] ?? `Working on "${f.title}".`,
      summarySource: "agent",
      cost: cost.toString(),
      facts: {
        files: outcome === "failed" || outcome === "paused" ? [] : files,
        checks: outcome === "failed" ? null : { passed: true, errors: [] },
        review: outcome === "done" ? { verdict: "pass", model: "glm-4.6", reasons: [] } : outcome === "needs_review" ? null : null,
        commitSha: outcome === "done" || outcome === "needs_review" ? Math.floor(r() * 0xffffffffff).toString(16).padStart(10, "0") : null,
        generator: { model: team.models[0], provider: "near-ai-x402", rail: "x402-evm" },
        models: [{ model: team.models[0], provider: "near-ai-x402", calls: 2 + Math.floor(r() * 6), failed: 0, cost: cost.toString(), tokensIn: 12_000 + Math.floor(r() * 30_000), tokensOut: 3_000 + Math.floor(r() * 9_000) }],
        receipts: [],
        estimate: { p50: (cost * 9n / 10n).toString(), p90: (cost * 14n / 10n).toString(), cap: (cost * 21n / 10n).toString() },
        taskCostSoFar: cost.toString(),
        reason: outcome === "paused" ? "a purchase is waiting for approval" : outcome === "failed" ? "purchase rejected: payee_mismatch" : null,
        error: null,
        attempt: f.status === "failed" ? 2 : 1,
        durationMs: Math.round(60_000 + r() * 900_000),
        tier: "standard",
      },
      createdAt: at,
      updatedAt: at,
    };
  });
}

function teamsView(spend: ReturnType<typeof spendSeries>) {
  return TEAMS.map((t) => {
    const spent = spend.filter((s) => s.team === t.name).reduce((a, s) => a + s.amount, 0n);
    const reserved = t.name === "ops" ? 1_500_000n : t.name === "build" ? 3_200_000n : 0n;
    const available = t.budget - spent - reserved;
    const tasks: Record<string, number> = {};
    for (const f of FEATURES.filter((f) => f.team === t.name)) tasks[f.status] = (tasks[f.status] ?? 0) + 1;
    return {
      name: t.name,
      departmentId: dept(t.name),
      budget: t.budget.toString(),
      spent: spent.toString(),
      reserved: reserved.toString(),
      available: (available > 0n ? available : 0n).toString(),
      perTxLimit: t.perTx.toString(),
      frozen: false,
      paymentAddress: null,
      chainId: 84532,
      agents: t.models.slice(0, 2).map((m, i) => ({ publicKey: `ed25519:demo${t.name}${i}`, accountId: dept(t.name), role: i === 0 ? (t.name === "build" ? "backend" : t.name) : "qa", status: "active", maxTier: "standard" })),
      tasks,
      chainReadOk: true,
    };
  });
}

function analytics(days: number, spendAll: ReturnType<typeof spendSeries>, reps: ReturnType<typeof reports>) {
  const from = today0() - (days - 1) * DAY;
  const dayList = Array.from({ length: days }, (_, i) => dayKey(from + i * DAY));
  const spend = spendAll.filter((s) => s.day >= dayList[0]);
  const teams = teamsView(spendAll);
  const sum = (xs: bigint[]) => xs.reduce((a, x) => a + x, 0n);
  const group = (key: "model" | "seller") => {
    const m = new Map<string, { amount: bigint; purchases: number }>();
    for (const s of spend) {
      const v = m.get(s[key]) ?? { amount: 0n, purchases: 0 };
      v.amount += s.amount;
      v.purchases += s.purchases;
      m.set(s[key], v);
    }
    return [...m.entries()].map(([k, v]) => ({ [key]: k, amount: v.amount.toString(), purchases: v.purchases })).sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
  };
  const todaySpend = sum(spendAll.filter((s) => s.day === dayKey(today0())).map((s) => s.amount));
  const done = reps.filter((r) => r.outcome === "done");
  const actual = sum(done.map((r) => BigInt(r.cost)));
  return {
    companyId: DEMO_COMPANY_ID,
    slug: "lumen-notes",
    range: { days, from: dayList[0], to: dayList[dayList.length - 1] },
    units: "micro-USDC",
    teams: teams.map((t) => ({ name: t.name, departmentId: t.departmentId })),
    sections: { money: true, work: true, control: true },
    money: {
      total: sum(spend.map((s) => s.amount)).toString(),
      byDay: dayList.map((day) => ({
        day,
        total: sum(spend.filter((s) => s.day === day).map((s) => s.amount)).toString(),
        byTeam: Object.fromEntries(TEAMS.map((t) => [t.name, sum(spend.filter((s) => s.day === day && s.team === t.name).map((s) => s.amount)).toString()])),
      })),
      byTeam: teams.map((t) => {
        const inRange = sum(spend.filter((s) => s.team === t.name).map((s) => s.amount));
        const burn = inRange / BigInt(days);
        return { team: t.name, departmentId: t.departmentId, spentInRange: inRange.toString(), budget: t.budget, spent: t.spent, reserved: t.reserved, available: t.available, perTxLimit: t.perTxLimit, frozen: false, burnPerDay: burn.toString(), runwayDays: burn > 0n ? Number(BigInt(t.available) / burn) : null };
      }),
      byModel: group("model"),
      bySeller: group("seller"),
      dailyCap: { cap: "15000000", spentToday: todaySpend.toString(), usedPct: Math.round((Number(todaySpend) / 15_000_000) * 100) },
    },
    work: {
      tasksByTeam: teams.map((t) => ({ team: t.name, departmentId: t.departmentId, ...t.tasks })),
      tasks: FEATURES.reduce<Record<string, number>>((a, f) => ({ ...a, [f.status]: (a[f.status] ?? 0) + 1 }), {}),
      completedByDay: dayList.map((day) => ({ day, done: done.filter((r) => r.updatedAt.toISOString().slice(0, 10) === day).length })),
      reviewPassRate: 0.86,
      reviewed: 14,
      costPerDoneTask: done.length ? (actual / BigInt(done.length)).toString() : null,
      estimateVsActual: { estimated: sum(done.map((r) => BigInt(r.facts.estimate.p50))).toString(), actual: actual.toString(), tasks: done.length },
    },
    control: {
      approvals: { pending: 2, oldestPendingAt: new Date(Date.now() - 5 * 3_600_000), decidedInRange: 9 },
      blockedPurchases: 1,
      pausedTeams: [],
      companyFrozen: false,
    },
    generatedAt: new Date().toISOString(),
    teamName: null,
  };
}

function headline(c: Record<string, number>, cost: bigint) {
  const parts = [
    c.done ? `${c.done} done` : null,
    c.needsReview ? `${c.needsReview} in review` : null,
    c.retrying ? `${c.retrying} retrying` : null,
    c.paused ? `${c.paused} waiting on you` : null,
    c.failed ? `${c.failed} failed` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")} · $${(Number(cost) / 1e6).toFixed(2)} spent in the last 7 days`;
}

export function demoBundle(range = 30) {
  const spend = spendSeries();
  const reps = reports();
  const teams = teamsView(spend);
  const byTeam = TEAMS.map((t) => {
    const mine = reps.filter((r) => r.team === t.name);
    const c = { done: 0, needsReview: 0, retrying: 0, paused: 0, failed: 0 };
    for (const r of mine) {
      const k = r.outcome === "needs_review" ? "needsReview" : (r.outcome as keyof typeof c);
      c[k]++;
    }
    const cost = mine.reduce((a, r) => a + BigInt(r.cost), 0n);
    return { team: t.name, departmentId: dept(t.name), summary: { days: 7, ...c, reports: mine.length, cost: cost.toString(), headline: headline(c, cost) }, reports: mine };
  });
  const now = Date.now();
  return {
    demo: true,
    readOnly: true,
    notice: "Sample company with invented data. Nothing here is on chain; sign in and describe your product to build your own.",
    companyId: DEMO_COMPANY_ID,
    slug: "lumen-notes",
    company: { id: DEMO_COMPANY_ID, name: "Lumen Notes", preset: "saas-starter", founderAccount: "founder.demo", frozen: false, createdAt: new Date(now - 34 * DAY) },
    access: { founder: false, admin: false, scopes: ["view", "approve", "builder"], departmentId: null, expiresAtMs: null, demo: true },
    chain: { founder: "founder.demo", name: "Lumen Notes", frozen: false, code_key_version: 1, daily_cap: "15000000", spent_today: analytics(1, spend, reps).money.dailyCap.spentToday },
    units: "micro-USDC",
    overview: {
      companyId: DEMO_COMPANY_ID,
      slug: "lumen-notes",
      name: "Lumen Notes",
      role: "demo",
      frozen: false,
      teams: teams.map((t) => ({ name: t.name, departmentId: t.departmentId, frozen: false })),
      money: {
        dailyCap: "15000000",
        spentToday: analytics(1, spend, reps).money.dailyCap.spentToday,
        budget: teams.reduce((a, t) => a + BigInt(t.budget), 0n).toString(),
        spent: teams.reduce((a, t) => a + BigInt(t.spent), 0n).toString(),
        reserved: teams.reduce((a, t) => a + BigInt(t.reserved), 0n).toString(),
        available: teams.reduce((a, t) => a + BigInt(t.available), 0n).toString(),
      },
      work: { tasks: FEATURES.reduce<Record<string, number>>((a, f) => ({ ...a, [f.status]: (a[f.status] ?? 0) + 1 }), {}), reportsThisWeek: reps.length, needsAttention: reps.filter((r) => r.outcome === "paused" || r.outcome === "failed").length, lastReport: reps[0] },
      approvals: { pending: 2, oldestAt: new Date(now - 5 * 3_600_000) },
    },
    teams,
    analytics: analytics(range, spend, reps),
    reports: { companyId: DEMO_COMPANY_ID, units: "micro-USDC", days: 7, groupBy: "team", teams: byTeam },
    approvals: [
      { id: "00000000-0000-4000-8000-00000000c001", companyId: DEMO_COMPANY_ID, kind: "single", status: "pending", amount: "2400000", requestIds: ["req-demo-1"], payload: { department_id: dept("ops"), seller_id: "backup-storage", reason: "new_seller", title: "Backup storage for the restore drill" }, createdAt: new Date(now - 5 * 3_600_000) },
      { id: "00000000-0000-4000-8000-00000000c002", companyId: DEMO_COMPANY_ID, kind: "single", status: "pending", amount: "6100000", requestIds: ["req-demo-2"], payload: { department_id: dept("build"), seller_id: "near-ai-x402", reason: "over_limit", title: "Large model run for the security review" }, createdAt: new Date(now - 2 * 3_600_000) },
    ],
    plan: {
      id: "00000000-0000-4000-8000-00000000a001",
      title: "Lumen Notes v1",
      tier: "standard",
      status: "launched",
      approvedAt: new Date(now - 33 * DAY),
      features: FEATURES.map(({ key, title, tag, team }) => ({ key, title, tag, team, size: "m", dependsOn: [] })),
    },
    tasks: FEATURES.map((f) => ({ id: `demo-${f.key}`, title: f.title, tag: f.tag, status: f.status, departmentId: dept(f.team), tier: "standard" })),
    members: [
      { account_id: "founder.demo", role: "founder", department_id: null },
      { account_id: "ada.demo", scopes: ["view", "approve"], department_id: null },
      { account_id: "kemi.demo", scopes: ["view", "builder", "code"], department_id: dept("build") },
    ],
  };
}

export function demoReport(id: string) {
  return reports().find((r) => r.id === id) ?? null;
}
