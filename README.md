# BuilderOS — Backend

**An operating system for AI-run software companies on NEAR.** Founders describe a product; a team of AI agents plans it, buys the models and services it needs, builds it, ships it, and earns revenue. Every dollar an agent spends is decided by a NEAR smart contract and signed by NEAR Chain Signatures, never by this backend.

This repository holds the off-chain half: the services that run the agents, move money between payment rails, index every on-chain event into receipts, and serve the web app.

> The chain decides. The backend asks, records, and relays.

---

## Why it's built this way

Letting autonomous agents spend money is only safe if a compromised server can't steal it. So the backend is designed to be powerless over funds:

| Rule | What it means in practice |
|---|---|
| **The chain decides** | Postgres is a cache and a store for private data. Budgets, caps and permissions are always re-read from NEAR before acting. |
| **No spending keys** | Agents hold *request-only* NEAR function-call keys. Workers can record results but never pay. The only exceptions are disclosed and capped: Tempo session wallets (≤ $5 each) and the NEAR AI Cloud API key. |
| **Everything leaves a receipt** | Every transaction, money or permission, produces an event and a receipt record. |
| **Idempotent by default** | Every job and write carries an idempotency key, so retries never pay twice. |
| **Private by default** | Code, prompts, plans and logs are stored encrypted (XChaCha20-Poly1305); only hashes go on chain. |
| **Same code offline** | Every external seller has a mock in the seller mesh, so the whole flow runs without the internet. |

The API never signs anything. Every write endpoint returns **unsigned NEAR transactions** that the user signs in their own wallet.

---

## Architecture

```
          Web app (Vercel, Next.js)  ── user signs every tx in the browser
                     │  HTTPS + SSE
                     ▼
   ┌──────────────── App API (Fastify) ────────────────┐
   │  auth · unsigned tx builders · key service · SSE  │
   └───────────────────────┬───────────────────────────┘
                           │
                   Postgres (cache · job queue · encrypted data)
                           │
   ┌──────────────────── Workers ──────────────────────┐
   │ Orchestrator │ Indexer │ Bridge │ Notify │ Verifier│
   └──────┬────────────┬─────────┬──────────────────────┘
          │ request_   │ events  │ top-ups / withdrawals
          │ purchase   │         │
          ▼            │         ▼
   NEAR contracts ─────┘   NEAR Intents · 1Click · Relay → Tempo
   (policy, grants,
    events)  ──► v1.signer (MPC) signs only what the contract approved
          │
          ▼
   Sellers: x402 on Base · MPP on Tempo · NEAR AI Cloud
```

| Service | Path | Runs as |
|---|---|---|
| App API + key service + live events | `apps/api` | Fastify server (web dyno) |
| Orchestrator, indexer, bridge worker, notify, verifier | `apps/workers` | One Node process; each service is a module with its own loop (worker dyno) |
| Database | `packages/db` | Postgres 16 with Drizzle migrations, pg-boss job queue |
| Seller mesh | `apps/seller-mesh` | Local mocks of every seller, bridge and email provider |

---

## How a purchase works

Agents call paid APIs through **`@builderos/fetch`**, a drop-in `fetch` that acts as a spend firewall:

1. The seller answers `402 Payment Required` with an x402 or MPP challenge.
2. The SDK hashes the challenge and calls `request_purchase(seller, rail, amount, challenge_hash, task, model)` on the department contract with the agent's request-only key.
3. The contract checks policy: allow-listed seller, per-transaction limit, budget, daily cap. If a human must approve, it yields and the task waits on the approval event.
4. On approval, the contract asks Chain Signatures (`v1.signer`) to sign the payment. The SDK builds the payment header through the rail adapter and retries the call.
5. The SDK records `record_response(request_id, response_hash, foreign_tx, outcome)`, and the indexer turns it into a receipt. The verifier checks the foreign transaction on Base or Tempo.

The SDK never supplies the payee or a hash to sign. Before paying, it refuses if the seller's `payTo` differs from what the contract authorised. A compromised agent can at most overbuy from allow-listed sellers, within caps.

### Payment rails

| Adapter | Builds | Notes |
|---|---|---|
| `x402-evm` | `X-PAYMENT` header from an EIP-3009 signature | Base Sepolia → Base; the facilitator pays gas |
| `mpp-tempo` charge | Tempo transaction with a TIP-20 transfer | Gated by `TEMPO_ENABLED` |
| `mpp-tempo` session | Payment channel opened via Chain Signatures | Session wallet holds exactly the cap (≤ $5), swept on close |
| `x402-near` | Delegated `ft_transfer` | Stretch goal |

The **model router** scores models in the chosen tier (quality, own pass rate, cost, latency), compares the same model across rails, and pays the cheaper one. It falls back within the tier on errors and never moves up a tier without asking.

The **bridge worker** keeps each department's Tempo pocket funded. When the pocket drops below 25% of its target, it tops it up to 50% (minimum $10) via 1Click and Relay. It enforces a 1% fee guard and at most two top-ups per department per day. It also executes withdrawals without touching funds reserved for open sessions or pending purchases.

---

## Agents and the task graph

An approved plan becomes a DAG of tasks. Each task is assigned on chain (`assign_task`) with a cost cap of p90 × 1.5, then runs:

1. The router picks a model (tag, tier, price, pass rate).
2. Model calls go through `@builderos/fetch`, so every call is a policy-checked purchase.
3. The agent writes a patch in an isolated workspace, which is wiped afterwards.
4. Tests run.
5. A model from a different lab reviews the patch. Contract and security tasks are always reviewed; two failures ask the founder.
6. The patch is committed with provenance trailers (task, model, provider, rail, agent). Logs are sealed, and the verifier posts the verdict with the log hash on chain.

Roles: 8 build roles (frontend, backend, contracts, security, devops, designer, writer, QA) plus Scout, Buyer, Controller, Ops, Growth and Support.

---

## Indexer and receipts

The indexer follows NEAR blocks by RPC polling and keeps only receipts from BuilderOS accounts. It parses NEP-297 `EVENT_JSON` logs against zod schemas (standard `builderos` v1.0.0) and does the following:

- writes the event and updates the read caches (members, floats, bounties, approval cards)
- writes a receipt for every transaction
- publishes the event to live clients over Postgres `LISTEN/NOTIFY` and Server-Sent Events
- sends unknown or malformed events to a dead-letter table

It stores the last processed block height and replays from it after a restart. Replays are no-ops.

| Receipt | From events |
|---|---|
| Purchase | `payment_signed`, `receipt` |
| Approval / rejection | `purchase_approved`, `purchase_rejected` |
| Top-up / withdrawal | `topup_recorded`, `withdrawal_recorded` |
| Deposit / revenue | Intents deposit, PingPay settlement |
| Bounty | `bounty_released`, `bounty_voided` |
| Membership | `member_invited`, `grant_set`, `grant_revoked` |
| Keys and policy | `code_key_rotated`, `policy_changed`, `frozen`, `unfrozen` |

---

## Keys, encryption and access

- **Sign-in:** the browser signs a NEP-413 challenge with its NEAR key. The API verifies the signature and checks that the key is a full-access key on the account via RPC. It then issues an HTTP-only session cookie (24 h, rotated) and returns a bearer token as a fallback for browsers that block third-party cookies.
- **Authorisation:** before building any transaction, the API re-checks the caller on chain (founder, or `get_grant` with the right scope, expiry and revocation).
- **Key service:** it stores keys only in wrapped form (sealed to each member's x25519 view key) and releases them after an on-chain grant check. It never sees a plaintext key. On `grant_revoked`, it deletes that member's copies and prompts the founder to rotate the code key.
- **Viewers** see money receipts only, and only for the teams they're granted.

---

## API

REST + JSON under `/v1`, validated with zod. Rate limits are 60 writes per minute per account and 10 sign-ins per minute per IP. Writes accept an `Idempotency-Key` header.

| Endpoint | Does |
|---|---|
| `GET /auth/challenge` · `POST /auth/verify` · `GET /auth/me` | NEAR sign-in |
| `POST /companies` · `GET /companies[/:id]` | Create a company from a preset → `create_company`, departments, caps |
| `POST /plans` · `POST /plans/:id/approve` | Run the planner; turn an approved plan into `assign_task` transactions |
| `GET /estimate` | Cost per tier (p50, p90, cap) for a task tag and size |
| `GET /tasks` · `PATCH /tasks/:id` | Task list; change tier or pin a model → `set_task_tier` |
| `GET /sellers/options?service=` | Up to 3 sellers with live 402 price and a quality note |
| `GET /approvals` · `POST /approvals/:id` | Pending cards (incl. one daily-cap card per day) → batched `approve` / `reject` |
| `GET /ledger` · `GET /audit` · `GET /receipts/:id` | Money receipts (JSON or CSV); permission and key receipts |
| `POST /members/invite` · `DELETE /members/:account` | Invite (email sent after the founder signs) · revoke |
| `GET/PATCH /floats/tempo` | Tempo pocket status and settings → `set_rail_float` |
| `POST /withdrawals` | Plan a withdrawal (sources, quotes, fees) → `request_withdrawal` |
| `POST /keys/code/rotate` · `GET/POST /keys/wrapped` | Founder-only key rotation; wrapped key store |
| `POST /freeze` | Pause all spending → `freeze` per team |
| `GET /stream` | Live events (SSE), resumable by `Last-Event-ID` |
| `GET /status` · `GET /health` | Indexer lag, queue depth, failed jobs, bridges in flight |

---

## Reliability

| Failure | What happens |
|---|---|
| Seller times out or errors | No charge (x402 never settles); the router tries the next model or seller in the tier |
| Chain Signatures slow or down | Purchases stay queued; jobs retry with backoff up to 30 min |
| Approval never comes | Yielded request expires; the task parks and resumes on the approval event |
| Daily cap reached | Requests join the day's single approval card; tasks that need no spend continue |
| Bridge fee > 1% | Top-up aborts; purchase falls back to an x402 seller if one exists |
| Relay transfer fails | Funds refund to the department's Base address; failed top-up is recorded |
| Indexer behind | Live stream shows "catching up"; the API reads budgets and grants straight from RPC |
| Worker crash | pg-boss re-runs the job; idempotency keys make it safe |

---

## Repository layout

```
apps/
  api/             Fastify App API, key-service routes, SSE
  workers/         indexer · orchestrator · bridge · notify · verifier · controller
  seller-mesh/     offline mocks: x402 + MPP sellers, Relay, 1Click, email
packages/
  shared/          config (testnet/mainnet switch), zod schemas, NEP-297 event schemas, logger
  db/              Drizzle schema + migrations, pg-boss
  near/            RPC client, NEP-413 verify, contract tx builders and views, service-key signer
  crypto/          libsodium sealing, x25519 key wrapping
  fetch/           @builderos/fetch — the spend-firewall SDK
  rails/           x402-evm, mpp-tempo, x402-near adapters
  router/          model catalog, estimates, cross-rail routing
  bridge/          Tempo top-ups and withdrawals
  indexer/         block follower, event → receipt pipeline
  keys/            wrapped-key store with on-chain grant checks
  notify/          web push, near-email, StableEmail fallback
  verifier/        foreign-tx verification, submit_verdict
  orchestrator/    planner, task DAG, agent keystore, task runner
tests/             unit + attack tests (vitest)
```

## Tech stack

TypeScript · Node 22 · pnpm + Turborepo · Fastify 5 · Postgres 16 · Drizzle ORM · pg-boss · zod · near-api-js · viem · libsodium · pino · vitest · esbuild

## Development

```bash
pnpm install
docker compose up -d     # Postgres + MailHog
pnpm db:migrate
pnpm dev                 # api :4000, workers, seller mesh :4100
pnpm demo                # offline walk-through of the money path
pnpm test                # unit + attack tests
```

`pnpm test` covers: NEP-413 sign-in, event parsing and dead letters, receipt building, router estimates, bridge rules (thresholds, minimums, 1% fee guard), MPP challenge parsing, plan cycle detection, encryption, and attack cases (injected payee, value above challenge, replayed challenge).

## Status

Built for the NEAR hackathon and running on **testnet**.

- The Tempo rail is wired but switched off (`TEMPO_ENABLED`) pending the Tempo spike.
- The indexer uses RPC polling; NEAR Lake is the upgrade path if lag shows up.
- Mainnet runs only after a founder-approved switch (`NETWORK=mainnet`).

## Related

- **BuilderOS — Build Architecture**: contracts, payment rails, policy
- **BuilderOS — Frontend Architecture**: the web app
