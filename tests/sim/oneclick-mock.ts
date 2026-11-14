/**
 * 1Click (NEAR Intents swap API) stand-in for end-to-end runs. It speaks the four calls BuilderOS uses:
 * GET /v0/tokens, POST /v0/quote, POST /v0/deposit/submit, GET /v0/status. A test double, not the service:
 * a test sets how each swap ends with `settle()`.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";

export type MockSwap = { depositAddress: string; quoteId: string; request: any; amountIn: string; amountOut: string; submitted: string | null; status: string };

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export class OneClickMock {
  swaps = new Map<string, MockSwap>();
  /** Set to make the next quote calls fail (the service being down). */
  down = false;
  /** Fee in basis points taken out of amountOut. */
  feeBps = 10n;
  tokens = [
    { assetId: USDC_NEAR, blockchain: "near", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", blockchain: "base", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", blockchain: "eth", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", blockchain: "arb", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", blockchain: "sol", symbol: "USDC", decimals: 6 },
    { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR", decimals: 24 },
  ];

  /** Decide how a swap ends: SUCCESS, REFUNDED or FAILED. Until then it reports PROCESSING. */
  settle(depositAddress: string, status: "SUCCESS" | "REFUNDED" | "FAILED") {
    const s = this.swaps.get(depositAddress);
    if (!s) throw new Error(`no quote for ${depositAddress}`);
    s.status = status;
  }

  async listen(): Promise<{ url: string; close: () => void }> {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "GET" && url.pathname === "/v0/tokens") return send(200, this.tokens);
      if (req.method === "POST" && url.pathname === "/v0/quote") {
        if (this.down) return send(503, { message: "solver unavailable" });
        if (!this.tokens.some((t) => t.assetId === body.destinationAsset) || body.originAsset !== USDC_NEAR) return send(400, { message: "tokenOut is not valid" });
        const amountIn = BigInt(body.amount);
        const amountOut = (amountIn - (amountIn * this.feeBps) / 10_000n).toString();
        // depositType INTENTS: the deposit address is a one-time NEAR implicit account inside Intents
        const depositAddress = body.dry ? undefined : randomBytes(32).toString("hex");
        const quoteId = randomBytes(8).toString("hex");
        if (depositAddress) this.swaps.set(depositAddress, { depositAddress, quoteId, request: body, amountIn: body.amount, amountOut, submitted: null, status: "PENDING_DEPOSIT" });
        return send(200, { correlationId: quoteId, quoteRequest: body, quote: { depositAddress, amountIn: body.amount, amountOut, minAmountOut: amountOut, deadline: body.deadline, timeEstimate: 20 } });
      }
      if (req.method === "POST" && url.pathname === "/v0/deposit/submit") {
        const s = this.swaps.get(body.depositAddress);
        if (!s) return send(404, { message: "deposit address not found" });
        s.submitted = body.txHash;
        if (s.status === "PENDING_DEPOSIT") s.status = "PROCESSING";
        return send(200, { status: s.status });
      }
      if (req.method === "GET" && url.pathname === "/v0/status") {
        const s = this.swaps.get(url.searchParams.get("depositAddress") ?? "");
        if (!s) return send(404, { message: "deposit address not found" });
        const done = s.status === "SUCCESS";
        return send(200, {
          status: s.status,
          quoteResponse: { correlationId: s.quoteId },
          swapDetails: { amountIn: s.amountIn, amountOut: done ? s.amountOut : null, destinationChainTxHashes: done ? [{ hash: `0x${"ab".repeat(32)}`, explorerUrl: "" }] : [], refundedAmount: s.status === "REFUNDED" ? s.amountIn : "0" },
        });
      }
      send(404, { message: "not found" });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() };
  }
}
