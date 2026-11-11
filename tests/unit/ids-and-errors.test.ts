import { describe, expect, it } from "vitest";
process.env.FACTORY_CONTRACT = "builderos-wang.testnet";
process.env.NETWORK = "testnet";
const { normalizeCompanyId, companySlug } = await import("../../packages/near/src/contracts.js");
const { HttpError } = await import("../../packages/shared/src/index.js");
const { estimateForModel, MODELS } = await import("../../packages/router/src/index.js");

describe("company id normalisation", () => {
  it("treats slug and full account id as the same company", () => {
    expect(normalizeCompanyId("demo")).toBe("demo.builderos-wang.testnet");
    expect(normalizeCompanyId("DEMO")).toBe("demo.builderos-wang.testnet");
    expect(normalizeCompanyId("demo.builderos-wang.testnet")).toBe("demo.builderos-wang.testnet");
    expect(normalizeCompanyId(" Demo.Builderos-Wang.Testnet ")).toBe("demo.builderos-wang.testnet");
  });
  it("short form for URLs", () => {
    expect(companySlug("demo.builderos-wang.testnet")).toBe("demo");
  });
});

describe("error codes", () => {
  it("defaults the code from the status", () => {
    expect(new HttpError(404, "x").code).toBe("not_found");
    expect(new HttpError(403, "x").code).toBe("forbidden");
    expect(new HttpError(501, "x").code).toBe("not_implemented");
    expect(new HttpError(409, "x", "plan_already_approved").code).toBe("plan_already_approved");
  });
});

describe("task pricing on one model", () => {
  it("prices a known model and refuses an unknown one", () => {
    const m = MODELS[0];
    const e = estimateForModel(m.tags[0], "m", m.id)!;
    expect(BigInt(e.cap)).toBeGreaterThanOrEqual(BigInt(e.p90));
    expect(estimateForModel("backend", "m", "no-such-model")).toBeNull();
  });
});
