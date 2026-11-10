import { describe, expect, it } from "vitest";
import { CreateCompanyBody } from "../../packages/shared/src/api.js";
import { tx, splitDepartment } from "../../packages/near/src/contracts.js";
import { visible } from "../../apps/api/src/sse.js";
import { streamFilter } from "../../apps/api/src/routes/stream.js";
import type { Access } from "../../apps/api/src/auth.js";

process.env.FACTORY_CONTRACT = "builderos-wang.testnet";

describe("create company body", () => {
  it("defaults to three valid teams", () => {
    const b = CreateCompanyBody.parse({ name: "Acme", slug: "acme" });
    expect(b.departments.map((d) => d.name)).toEqual(["build", "ops", "growth"]);
  });
  it("maps the web app's teams[] and lowercases names", () => {
    const b = CreateCompanyBody.parse({ name: "Acme", slug: "acme", teams: [{ team: "Eng", monthlyCap: "100.5" }] });
    expect(b.departments).toEqual([{ name: "eng", budget: "100500000", perTxLimit: "5025000" }]);
  });
  it("rejects team names that can't be NEAR sub-accounts", () => {
    expect(() => CreateCompanyBody.parse({ name: "Acme", slug: "acme", departments: [{ name: "Build Team", budget: "1", perTxLimit: "1" }] })).toThrow();
  });
  it("rejects duplicate teams and per-tx limits above the budget", () => {
    expect(() => CreateCompanyBody.parse({ name: "Acme", slug: "acme", teams: [{ team: "eng", monthlyCap: "5" }, { team: "ENG", monthlyCap: "5" }] })).toThrow();
    expect(() => CreateCompanyBody.parse({ name: "Acme", slug: "acme", departments: [{ name: "eng", budget: "10", perTxLimit: "11" }] })).toThrow();
  });
});

describe("department changes go through the company contract", () => {
  it("assign_task is a company.dept_call", () => {
    const t = tx.assignTask("build.acme.builderos-wang.testnet", { taskId: "t1", tier: "standard", cap: "1", tag: "backend", agentRole: "backend", dependsOn: [] });
    expect(t.receiverId).toBe("acme.builderos-wang.testnet");
    expect(t.actions[0].params.methodName).toBe("dept_call");
    expect((t.actions[0].params.args as any).calls[0]).toMatchObject({ department: "build", method: "assign_task" });
  });
  it("batches plan approval into ≤12 calls per tx with 1 yocto each", () => {
    const calls = Array.from({ length: 13 }, (_, i) => tx.assignTaskCall("build.acme.builderos-wang.testnet", { taskId: `t${i}`, tier: "s", cap: "1", tag: "x", agentRole: "x", dependsOn: [] }));
    const txs = tx.deptCalls("acme.builderos-wang.testnet", calls);
    expect(txs.map((t) => (t.actions[0].params.args as any).calls.length)).toEqual([12, 1]);
    expect(txs[0].actions[0].params.deposit).toBe("12");
  });
  it("agent keys are added by the team contract via the company, never by a person's key", () => {
    const t = tx.registerAgent("build.acme.builderos-wang.testnet", "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", "backend");
    expect(t.receiverId).toBe("acme.builderos-wang.testnet");
    expect(t.actions[0].params).toMatchObject({ methodName: "register_agent", args: { department_name: "build", role: "backend" } });
    expect(tx.fireAgent("build.acme.builderos-wang.testnet", "ed25519:x").actions[0].params.methodName).toBe("fire_agent");
  });
  it("pause-all is one company tx (contract cascades to teams)", () => {
    expect(tx.freeze("acme.builderos-wang.testnet").receiverId).toBe("acme.builderos-wang.testnet");
    expect(splitDepartment("ops.acme.builderos-wang.testnet")).toEqual({ name: "ops", companyId: "acme.builderos-wang.testnet" });
  });
});

describe("live stream only shows what the founder granted", () => {
  const member = (scopes: string[], departmentId: string | null = "build.acme.t"): Access => ({
    founder: false,
    admin: scopes.includes("admin"),
    grant: null,
    scopes: new Set(scopes),
    departmentId: scopes.includes("admin") ? null : departmentId,
  });
  const ev = (event: string, department_id: string | null = "build.acme.t") => ({ event, department_id });

  it("viewer sees money events for their team only", () => {
    const f = streamFilter(member(["view"]));
    expect(visible(f, ev("payment_signed"))).toBe(true);
    expect(visible(f, ev("payment_signed", "ops.acme.t"))).toBe(false);
    expect(visible(f, ev("grant_set", null))).toBe(false);
    expect(visible(f, ev("task_assigned"))).toBe(false);
    expect(visible(f, ev("frozen", null))).toBe(true);
  });
  it("builder sees task events, admin sees everything", () => {
    expect(visible(streamFilter(member(["builder"])), ev("task_assigned"))).toBe(true);
    const admin = streamFilter(member(["admin"]));
    expect(visible(admin, ev("grant_set", null))).toBe(true);
    expect(visible(admin, ev("payment_signed", "ops.acme.t"))).toBe(true);
  });
});

describe("legacy company batching (joint promise)", () => {
  const co = "acme.builderos-wang.testnet";
  const calls = Array.from({ length: 5 }, (_, i) => tx.assignTaskCall(`build.${co}`, { taskId: `t${i}`, tier: "standard", cap: "1", tag: "backend", agentRole: "backend", dependsOn: [] }));
  it("sends one dept_call per tx when perTx = 1", () => {
    const txs = tx.deptCalls(co, calls, 1);
    expect(txs).toHaveLength(5);
    for (const t of txs) {
      expect(t.actions[0].params.deposit).toBe("1");
      expect((t.actions[0].params.args as any).calls).toHaveLength(1);
    }
  });
  it("batches up to 12 on current code", () => {
    expect(tx.deptCalls(co, calls)).toHaveLength(1);
  });
  it("splits approvals one per tx on legacy code", () => {
    expect(tx.approve(co, ["a", "b", "c"], "card", 1)).toHaveLength(3);
  });
});
