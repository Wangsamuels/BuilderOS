/**
 * `pnpm demo` — offline walk-through of the money path against the seller mesh (no internet):
 * 402 challenge → challenge hash → (contract decision, simulated here) → payment header → paid response,
 * plus a plan estimate and a bridge top-up quote. The real chain path needs the BuilderOS contracts
 * (see "BuilderOS — Build Architecture") deployed to near-workspaces or testnet.
 */
import { buildPaymentHeaders, challengeHash, parseChallenges, settlementTx, type SignedPurchase } from "../packages/rails/src/index.js";
import { estimate } from "../packages/router/src/index.js";
import { heuristicPlan, topoOrder } from "../packages/orchestrator/src/planner.js";
import { feeOk, topupAmount } from "../packages/bridge/src/index.js";

const MESH = process.env.SELLER_MESH_URL ?? "http://localhost:4100";

async function main() {
  const health = await fetch(`${MESH}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`seller mesh not running at ${MESH} — run: pnpm --filter @builderos/seller-mesh start`);

  console.log("\n1) Plan + estimate");
  const feats = heuristicPlan("Build a landing page with waitlist signup.\nAdd an API endpoint that stores emails in the database.\nWrite tests for the signup flow.");
  console.log(topoOrder(feats).map((k) => `${k}: ${feats.find((f) => f.key === k)!.title} [${feats.find((f) => f.key === k)!.tag}]`).join("\n"));
  console.log("standard tier, backend m:", estimate("backend", "m", "standard"));

  console.log("\n2) Agent calls a paid seller → 402");
  const url = `${MESH}/sellers/near-ai.x402/v1/chat/completions`;
  const body = JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] });
  const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const [ch] = await parseChallenges(r1);
  console.log(`status ${r1.status}, rail ${ch.rail}, hash ${challengeHash(ch).slice(0, 16)}…`);

  console.log("\n3) request_purchase → contract approves → v1.signer signs (simulated signature)");
  const req = (ch as any).requirement;
  const signed: SignedPurchase = {
    rail: "x402-evm",
    request_id: "demo-1",
    authorization: { from: "0x9999999999999999999999999999999999999999", to: req.payTo, value: req.maxAmountRequired, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: `0x${"ab".repeat(32)}` },
    signature: { big_r: { affine_point: `02${"11".repeat(32)}` }, s: { scalar: "22".repeat(32) }, recovery_id: 0 },
  };
  const headers = buildPaymentHeaders(ch, signed);
  const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  console.log(`retry status ${r2.status}, settlement tx ${settlementTx(r2)}`);

  console.log("\n4) Attack: injected payee is refused before paying");
  try {
    buildPaymentHeaders(ch, { ...signed, authorization: { ...signed.authorization, to: "0x000000000000000000000000000000000000dEaD" } } as SignedPurchase);
  } catch (e: any) {
    console.log(`refused: ${e.message}`);
  }

  console.log("\n5) Bridge rules");
  console.log("top-up for target $100, balance $20:", Number(topupAmount(100_000_000n, 20_000_000n)) / 1e6, "USDC; fee 0.5% ok?", feeOk(1_000_000n, 5_000n));
  console.log("\ndone.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
