import { describe, expect, it, vi, beforeEach } from "vitest";

const calls: string[] = [];
let requestState: any = null;
vi.mock("../../packages/near/src/index.ts", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    serviceAccount: vi.fn(async () => ({})),
    callAs: vi.fn(async (_acc: any, c: any) => {
      calls.push(c.methodName);
      if (c.methodName === "request_purchase") return { value: { status: "pending", request_id: "t1:1:abcd", reason: "over_limit" } };
      if (c.methodName === "sign_approved")
        return {
          value: {
            status: "signed",
            request_id: "t1:1:abcd",
            authorization: { from: "0x9999999999999999999999999999999999999999", to: "0x1111111111111111111111111111111111111111", value: "20000", validAfter: "0", validBefore: "1800000000", nonce: "0x" + "00".repeat(32) },
            signature: { scheme: "Secp256k1", big_r: { affine_point: "02" + "11".repeat(32) }, s: { scalar: "22".repeat(32) }, recovery_id: 1 },
          },
        };
      return { value: null };
    }),
    views: { ...real.views, getRequest: vi.fn(async () => requestState), getRequestByChallenge: vi.fn(async () => null) },
  };
});

const { createBuilderFetch, PurchaseRejected } = await import("../../packages/fetch/src/index.js");

const accepts = { x402Version: 1, accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "20000", resource: "r", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" } }] };

function seller() {
  return vi.fn(async (_url: any, init: any) => {
    const h = new Headers(init?.headers);
    if (!h.get("X-PAYMENT")) return new Response(JSON.stringify(accepts), { status: 402, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

describe("agent purchase flow (approval card → Chain Signatures)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("waits for the approval, asks the contract to sign, pays and records", async () => {
    const s = seller();
    vi.stubGlobal("fetch", s);
    requestState = { status: "approved", request_id: "t1:1:abcd" };
    const f = createBuilderFetch({ agent: { accountId: "build.acme.t", privateKey: "ed25519:x" }, pollMs: 1 });
    const res = await f("https://seller.example/v1/x", { method: "POST" }, { departmentId: "build.acme.t", taskId: "t1", sellerId: "inferx.base" });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["request_purchase", "sign_approved", "record_response"]);
    const paid = JSON.parse(Buffer.from(new Headers(s.mock.calls[1][1].headers).get("X-PAYMENT")!, "base64").toString());
    expect(paid.payload.authorization.to).toBe("0x1111111111111111111111111111111111111111");
    expect(paid.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("stops when the approver rejects", async () => {
    vi.stubGlobal("fetch", seller());
    requestState = { status: "rejected", request_id: "t1:1:abcd", reason: "rejected_by_approver" };
    const f = createBuilderFetch({ agent: { accountId: "build.acme.t", privateKey: "ed25519:x" }, pollMs: 1 });
    await expect(f("https://seller.example/v1/x", {}, { departmentId: "build.acme.t", taskId: "t1", sellerId: "inferx.base" })).rejects.toBeInstanceOf(PurchaseRejected);
  });
});
