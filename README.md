# BuilderOS — Backend

TypeScript services around the NEAR contracts: App API (Fastify, Heroku web dyno), workers (indexer, orchestrator, bridge, notify, verifier, controller — Heroku worker dyno), one Heroku Postgres. The web app runs on **Vercel** and talks to the API over HTTPS.

Nothing here can move money on its own authority. Every write endpoint returns **unsigned NEAR transactions** in wallet-selector format (`{ receiverId, actions: [{ type: "FunctionCall", params }] }`), so the browser passes them straight to `wallet.signAndSendTransactions({ transactions })`.

```
apps/api           Fastify App API + key-service routes + SSE      → Heroku web
apps/workers       indexer · orchestrator · bridge · notify · verifier → Heroku worker
apps/seller-mesh   offline mocks for every seller, Relay, 1Click, email (local only)
packages/shared    env/config (NETWORK switch), zod schemas, NEP-297 event schemas, logger
packages/db        Drizzle schema + migrations, pg-boss queue
packages/near      RPC, NEP-413 sign-in verify, contract tx builders + views, service-key signer
packages/crypto    libsodium XChaCha20-Poly1305 sealing, x25519 key wrapping
packages/fetch     @builderos/fetch — spend-firewall fetch for agents (402 → request_purchase)
packages/rails     x402-evm, mpp-tempo (charge/session), x402-near adapters
packages/router    model catalog (models.json), estimates (p50/p90/cap), cross-rail routing
packages/bridge    Tempo top-ups (1Click + Relay, 1% fee guard), withdrawals
packages/indexer   NEAR block polling → events → caches → receipts → NOTIFY
packages/keys      wrapped-key store, on-chain grant check on every release
packages/notify    web push (VAPID), near-email, StableEmail fallback, in-app
packages/verifier  foreign-tx verification on Base/Tempo, submit_verdict
packages/orchestrator  planner, task DAG, agent keystore, task runner
```

## Local

```bash
pnpm install
docker compose up -d            # Postgres 16 + MailHog
pnpm run setup                  # .env, VAPID keys, encrypted agent keystore (plain `pnpm setup` is a pnpm built-in)
pnpm db:migrate
pnpm dev                        # api :4000, workers, seller mesh :4100
pnpm demo                       # offline money path against the seller mesh
pnpm test                       # unit + attack tests
```

## Deploy the API + workers to Heroku

```bash
heroku create builderos-api
heroku addons:create heroku-postgresql:essential-0
heroku buildpacks:set heroku/nodejs
heroku config:set NODE_ENV=production NETWORK=testnet \
  SESSION_SECRET=$(openssl rand -base64 32) \
  WEB_ORIGIN=https://<your-app>.vercel.app \
  WEB_ORIGIN_PATTERN='^https://<your-project>-[a-z0-9-]+-<your-team>\.vercel\.app$' \
  FACTORY_CONTRACT=<factory>.testnet REGISTRY_CONTRACT=<registry>.testnet \
  WORKER_ACCOUNT_ID=... WORKER_PRIVATE_KEY=ed25519:... \
  VERIFIER_ACCOUNT_ID=... VERIFIER_PRIVATE_KEY=ed25519:... \
  AGENT_KEYSTORE_JSON="$(cat keystore/agents.json)" AGENT_KEYSTORE_PASSPHRASE=... \
  NEAR_AI_API_KEY=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  NEAR_EMAIL_URL=... NEAR_EMAIL_PAYMENT_KEY=...
git push heroku main
heroku ps:scale web=1:basic worker=1:basic
```

- Build: Heroku runs `heroku-postbuild` → `turbo build` (esbuild bundles each app; workspace packages are inlined).
- `release:` in the Procfile runs Drizzle migrations before each deploy goes live.
- `DATABASE_URL` is set by the Postgres add-on; SSL is turned on automatically in production.
- Essential-0 allows 20 connections: `DB_POOL_MAX=5` per dyno + pg-boss (3) + the SSE listener (1) stays well under.
- Check `https://builderos-api.herokuapp.com/health` and `/v1/status` (indexer lag, queue depth, failed jobs, bridges in flight).

## Connect the Vercel frontend

Set on Vercel: `NEXT_PUBLIC_API_URL=https://builderos-api.herokuapp.com` (or `https://api.<your-domain>`).
Set on Heroku: `WEB_ORIGIN` = the Vercel production URL (and `WEB_ORIGIN_PATTERN` for previews). They must point at each other.

**Cookies across Vercel and Heroku.** `*.vercel.app` and `*.herokuapp.com` are different sites, so the session cookie is a third-party cookie. The API handles both cases:

| Setup | What to set | How auth works |
|---|---|---|
| Custom domain: `app.<domain>` on Vercel + `api.<domain>` on Heroku | `COOKIE_DOMAIN=.<domain>` | Shared first-party cookie, `SameSite=Lax`. Most reliable. |
| Default domains (`vercel.app` + `herokuapp.com`) | nothing | Cookie is `SameSite=None; Secure; Partitioned`. Safari and some browsers block it, so **also store the `token` from `/v1/auth/verify` and send `Authorization: Bearer <token>`**. |

Minimal client for the web app:

```ts
// lib/api.ts (Next.js on Vercel)
const API = process.env.NEXT_PUBLIC_API_URL!;
let token: string | null = typeof window !== "undefined" ? sessionStorage.getItem("bos_token") : null;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.method && init.method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
  return res.json();
}

// Sign in with NEAR (wallet-selector)
export async function signIn(wallet: any, accountId: string) {
  const ch = await api<{ message: string; recipient: string; nonce: string }>(`/v1/auth/challenge?accountId=${accountId}`);
  const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonce, "base64") });
  const out = await api<{ token: string }>("/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce, message: ch.message }),
  });
  token = out.token;
  sessionStorage.setItem("bos_token", out.token);
}

// Any write: get unsigned txs, have the user sign them
export async function approve(wallet: any, cardId: string) {
  const { transaction } = await api<{ transaction: any }>(`/v1/approvals/${cardId}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  await wallet.signAndSendTransactions({ transactions: [transaction] });
}

// Live events (resumes from Last-Event-ID automatically on reconnect)
export function stream(onEvent: (e: any) => void) {
  const es = new EventSource(`${API}/v1/stream${token ? `?token=${token}` : ""}`, { withCredentials: true });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  ["payment_signed", "purchase_yielded", "purchase_approved", "receipt", "frozen", "topup_recorded"].forEach((t) =>
    es.addEventListener(t, (m: MessageEvent) => onEvent(JSON.parse(m.data))),
  );
  return () => es.close();
}
```

SSE on Heroku: the router closes idle connections after 55 s, so the API sends a `: ping` every 20 s; `EventSource` reconnects and resumes from `Last-Event-ID` after dyno restarts.

## Endpoints

Auth: `GET /v1/auth/challenge`, `POST /v1/auth/verify`, `POST /v1/auth/logout`, `GET /v1/auth/me`.
App: `GET|POST /v1/companies`, `GET /v1/companies/:id`, `POST /v1/plans`, `GET /v1/plans/:id`, `POST /v1/plans/:id/approve`, `GET /v1/estimate`, `GET /v1/tasks`, `PATCH /v1/tasks/:id`, `GET /v1/sellers/options?service=`, `GET /v1/approvals`, `POST /v1/approvals/:id`, `GET /v1/ledger` (`format=csv`), `GET /v1/audit`, `GET /v1/receipts/:id`, `POST /v1/members/invite`, `POST /v1/invites/accept`, `GET /v1/members`, `DELETE /v1/members/:account`, `GET|PATCH /v1/floats/tempo`, `POST /v1/withdrawals`, `POST /v1/keys/code/rotate`, `GET|POST /v1/keys/wrapped`, `POST /v1/keys/view`, `POST /v1/freeze`, `POST /v1/unfreeze`, `GET /v1/stream`, `GET /v1/status`, `GET /v1/push/vapid`, `POST /v1/push/subscribe`, `POST /v1/me/email`, `GET /v1/notifications`.

Rate limits: 60 writes/min per account, 10/min per IP on sign-in. Writes accept `Idempotency-Key`.

## Things to align with the contracts

- **Method names and argument shapes** are all in `packages/near/src/contracts.ts`; event payload schemas are in `packages/shared/src/events.ts`. They follow the architecture doc. Check them against the real contracts before the first testnet run.
- `request_purchase` is expected to return `{ status: "signed", rail, request_id, authorization, signature }` or `{ status: "pending" | "rejected", request_id, reason }`, and `get_request` to expose the same thing once signed.
- The **Tempo rail** (`mpp-tempo`) is wired but gated by `TEMPO_ENABLED` until the Tempo spike lands (Plan A–D).
- The **indexer** scans transactions sent to or from BuilderOS accounts. Deposits that arrive as receipts from someone else's transaction (e.g. an `ft_transfer_call`) need the NEAR Lake upgrade.
- Plans and logs are sealed with a key derived from the server secret. Once each company's code key exists, swap in the company key (via the orchestrator's x25519 key).
