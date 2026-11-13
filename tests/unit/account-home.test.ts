import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";

process.env.FACTORY_CONTRACT = "builderos-wang.testnet";
process.env.PRIVY_APP_ID = "unit-app";

const { CreateDraftBody, CreateCompanyBody, ChallengeQuery, VerifyBody } = await import("../../packages/shared/src/api.js");
const { pickTeam, suggestSetup, teamKindForTag, planEstimate, heuristicPlan } = await import("../../packages/orchestrator/src/planner.js");
const { parseSummary, parseReview } = await import("../../packages/orchestrator/src/runner.js");
const { maskEmail } = await import("../../apps/api/src/account.js");
const { setPrivyTestKey, verifyPrivyIdentityToken, privyWalletMatches } = await import("../../apps/api/src/privy.js");
const { demoBundle } = await import("../../apps/api/src/demo.js");

describe("sign-in inputs", () => {
  it("challenge can be fetched without an account (prefetch)", () => {
    expect(ChallengeQuery.parse({})).toEqual({});
    expect(ChallengeQuery.parse({ accountId: "abc.testnet" }).accountId).toBe("abc.testnet");
  });
  it("verify accepts the login method and a Privy token", () => {
    const v = VerifyBody.parse({ accountId: "a.testnet", publicKey: "abc12345", signature: "s", nonce: "n", message: "m", loginMethod: "privy", privyIdentityToken: "x".repeat(30) });
    expect(v.publicKey).toBe("ed25519:abc12345");
    expect(v.loginMethod).toBe("privy");
    expect(() => VerifyBody.parse({ accountId: "a.testnet", publicKey: "abc12345", signature: "s", nonce: "n", message: "m", loginMethod: "email" })).toThrow();
  });
});

describe("drafts", () => {
  it("builds a description from the Describe answers", () => {
    const d = CreateDraftBody.parse({ what: "A notes app. With sharing.", who: "studios", howTheyPay: "monthly", private: true });
    expect(d.description).toBe("Build: A notes app. With sharing.\nFor: studios\nHow they pay: monthly");
    expect(d.tier).toBe("private");
    expect(d.title).toBe("A notes app");
  });
  it("needs a description or what, and rejects unknown fields", () => {
    expect(() => CreateDraftBody.parse({})).toThrow();
    expect(() => CreateDraftBody.parse({ what: "a thing", companyId: "x" })).toThrow();
  });
  it("create-company keeps planId and knows whether teams/cap were given", () => {
    const b = CreateCompanyBody.parse({ name: "Acme", slug: "acme", planId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" });
    expect(b.planId).toBeTruthy();
    expect(b.teamsGiven).toBe(false);
    expect(b.dailyCapGiven).toBe(false);
    expect(b.dailyCap).toBe("50000000");
    expect(CreateCompanyBody.parse({ name: "Acme", slug: "acme", teams: [{ team: "eng", monthlyCap: "5" }], dailyCap: "1" }).teamsGiven).toBe(true);
  });
});

describe("teams", () => {
  it("routes tags to the company's own team names", () => {
    expect(pickTeam("backend", ["eng", "growth", "ops", "support"])).toBe("eng");
    expect(pickTeam("devops", ["eng", "growth", "ops", "support"])).toBe("ops");
    expect(pickTeam("support", ["eng", "growth", "ops", "support"])).toBe("support");
    expect(pickTeam("support", ["build", "growth"])).toBe("growth");
    expect(pickTeam("growth", ["build"])).toBe("build");
    expect(pickTeam("devops", ["alpha", "beta"])).toBe("alpha");
    expect(pickTeam("backend", [])).toBeNull();
    expect(teamKindForTag("contract")).toBe("build");
  });
  it("suggests one funded team per kind of work, with sane limits", () => {
    const features = heuristicPlan("Notes API with sharing. Editor UI. Launch campaign for growth. Help center for support.");
    const est = planEstimate(features, "standard");
    const s = suggestSetup(features, est.perFeature, "Lumen Notes!");
    expect(s.slug).toBe("lumen-notes");
    expect(s.teams[0].team).toBe("build");
    const names = s.teams.map((t) => t.team);
    expect(new Set(names).size).toBe(names.length);
    for (const t of s.teams) {
      expect(BigInt(t.monthlyCap)).toBeGreaterThanOrEqual(5_000_000n);
      expect(BigInt(t.perTxLimit)).toBeLessThanOrEqual(BigInt(t.monthlyCap));
      expect(BigInt(t.monthlyCap) % 1_000_000n).toBe(0n);
      expect(BigInt(t.monthlyCap)).toBeGreaterThanOrEqual(BigInt(t.estimatedCap));
    }
    expect(BigInt(s.dailyCap)).toBeGreaterThanOrEqual(10_000_000n);
    expect(s.teams.flatMap((t) => t.features).sort()).toEqual(features.map((f) => f.key).sort());
  });
  it("makes a valid slug from any title", () => {
    expect(suggestSetup([], [], "!!!").slug).toBe("my-company");
    expect(suggestSetup([], [], "A").slug).toBe("a-co");
    expect(suggestSetup([], [], "x".repeat(80)).slug.length).toBeLessThanOrEqual(32);
  });
});

describe("reports", () => {
  it("reads the agent's summary and the review verdict", () => {
    expect(parseSummary('```json {"files":[],"summary":"Added login"}```')).toBe("Added login");
    expect(parseSummary("no json")).toBeNull();
    expect(parseReview('{"verdict":"pass","reasons":[]}')).toEqual({ verdict: "pass", reasons: [] });
    expect(parseReview('{"verdict":"fail","reasons":["no tests"]}')).toEqual({ verdict: "fail", reasons: ["no tests"] });
    expect(parseReview(null).verdict).toBe("fail");
  });
});

describe("email", () => {
  it("masks addresses", () => {
    expect(maskEmail("ada.lovelace@example.com")).toBe("a•••e@example.com");
    expect(maskEmail("ab@x.io")).toBe("a•@x.io");
  });
});

describe("privy identity token", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  beforeAll(() => setPrivyTestKey(keys.publicKey));
  const tok = (claims: Record<string, unknown>, key = keys.privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: "ES256", kid: "k" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const p = Buffer.from(JSON.stringify({ iss: "privy.io", aud: "unit-app", exp: now + 60, sub: "did:privy:1", ...claims })).toString("base64url");
    return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  it("reads the email and wallets", async () => {
    const id = await verifyPrivyIdentityToken(tok({ linked_accounts: JSON.stringify([{ type: "google_oauth", email: "A@B.com" }, { type: "wallet", address: "ABCDEF" }]) }));
    expect(id.email).toBe("a@b.com");
    expect(privyWalletMatches(id, "abcdef", null, null)).toBe(true);
    expect(privyWalletMatches(id, "other", null, null)).toBe(false);
    expect(id.issuedAt).toBeNull(); // no iat claim in this token
  });
  it("rejects another signer, issuer, audience or an expired token", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await expect(verifyPrivyIdentityToken(tok({}, other.privateKey))).rejects.toMatchObject({ code: "bad_privy_token" });
    await expect(verifyPrivyIdentityToken(tok({ iss: "evil" }))).rejects.toMatchObject({ code: "bad_privy_token" });
    await expect(verifyPrivyIdentityToken(tok({ aud: "x" }))).rejects.toMatchObject({ code: "bad_privy_token" });
    await expect(verifyPrivyIdentityToken(tok({ exp: 1 }))).rejects.toMatchObject({ code: "bad_privy_token" });
  });
});

describe("demo company", () => {
  it("is consistent: days, teams and models add up; budgets balance", () => {
    const d = demoBundle(30);
    const m = d.analytics.money;
    const sum = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n);
    expect(sum(m.byDay.map((x) => x.total))).toBe(BigInt(m.total));
    expect(sum(m.byTeam.map((x) => x.spentInRange))).toBe(BigInt(m.total));
    for (const t of d.teams) expect(BigInt(t.spent) + BigInt(t.reserved) + BigInt(t.available)).toBe(BigInt(t.budget));
    expect(d.reports.teams.map((t) => t.team)).toEqual(["build", "ops", "growth", "support"]);
    expect(d.readOnly).toBe(true);
  });
});
