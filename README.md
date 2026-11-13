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
| **No spending keys** | Agents hold *request-only* NEAR function-call keys. Workers can record results but never pay. Disclosed exceptions (capped): optional Tempo session wallets when an MPP service is required, and optional NEAR AI API-key fallback (off by default). |
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
   Sellers: Near AI models via x402 (Base USDC) · other x402 services · Tempo MPP only if needed
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

1. The seller answers `402 Payment Required` with an x402 challenge.
2. The SDK hashes the challenge and calls `request_purchase(seller, rail, amount, challenge_hash, task, model, challenge)` on the team contract with the agent's limited key.
3. The **team contract** checks, in order:
   - the payee: an allow-listed seller can only be paid at its registered address, and anything else is blocked as an attack
   - the asset and chain: only the team's USDC on Base
   - the budget: a hard stop
   - the per-transaction limit, the task's cost cap, and whether the seller is on the allow-list
4. The **company contract** checks that the company isn't frozen and applies the company-wide **daily cap**.
5. Within every limit, the team contract builds the USDC `TransferWithAuthorization` (EIP-3009) itself and asks Chain Signatures (`v1.signer`) to sign it with the team's derived Base key. Only that contract can ask for that key.
6. Otherwise the request becomes an **approval card**: `purchase_yielded` has the reason (`over_limit`, `new_seller`, `over_task_cap`, `unassigned_task`, `daily_cap`), and the budget stays reserved. A founder or approver signs `approve` (or `reject`). The agent then calls `sign_approved` and gets the signature. A task that parked meanwhile reuses the approved request when it resumes.
7. The SDK sends the `X-PAYMENT` header and records `record_response(...)`. The indexer writes the receipt, and the verifier checks the Base transaction.

The SDK never supplies the payee or the hash to sign; the contract builds both. A compromised agent can at most buy from allow-listed sellers within the caps, and everything else waits for a person.

Fund each team's Base address (shown by `GET /v1/companies/:id/payments`) with USDC so agents can pay.

### Payment rails

| Adapter | Builds | Notes |
|---|---|---|
| `x402-evm` | `X-PAYMENT` header from an EIP-3009 signature built and signed by the team contract via Chain Signatures | Base Sepolia → Base; the facilitator pays gas |
| `mpp-tempo` charge (not contract-signed yet: the contract refuses it and the router falls back to x402) | Tempo transaction with a TIP-20 transfer | Gated by `TEMPO_ENABLED` |
| `mpp-tempo` session | Payment channel opened via Chain Signatures | Session wallet holds exactly the cap (≤ $5), swept on close |
| `x402-near` | Delegated `ft_transfer` | Stretch goal (not contract-signed yet) |

The **model router** scores Near AI models in the chosen tier and pays them with **x402 on Base USDC** (department Chain Signatures Base address). Tempo/MPP is not used for inference.

The **bridge worker** only tops up a Tempo pocket when `TEMPO_ENABLED` and a non-model MPP service needs it (below 25% of target → top up toward 50%, min $10, 1% fee guard, ≤2/day). Model working capital stays as **USDC on Base**.

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
- **The founder decides who sees what.** Nobody but the founder has access until the founder signs an `invite` and the member accepts it. The grant sets the scopes and, unless it's `admin`, the one team it covers. The API reads it live from the company contract on every request:

  | Grant | Can see | Can do |
  |---|---|---|
  | Founder | everything | everything, including invite/revoke, keys, withdrawals, resume spending |
  | `admin` (founder-appointed) | everything | approve, assign tasks, change tiers/floats, pause spending |
  | `approve` | approval cards, money receipts for their team | approve / reject purchases |
  | `builder` | plans, tasks, hires for their team | create plans |
  | `view` | money receipts and budget for their team | — |

  The live event stream is filtered the same way. Member lists, audit and permission/key events are founder/admin only.
- **No one holds a key to the company or team accounts.** The factory and company create those accounts without adding anyone's key, so even the founder can't sign as them and skip the rules. Agent keys are added by the team contract itself (`register_agent`, founder or admin), limited to `request_purchase`, `record_response` and `create_bounty`. The spend methods reject every other caller. Code changes need a founder `propose_upgrade` that every member can see, then a 24 h wait before `apply_upgrade` deploys exactly that code.
- **Department changes go through the company contract.** Teams only accept policy calls from their company, so `assign_task`, tier, float, seller and per-team pause changes are sent as `company.dept_call`, which checks the signer's grant first. "Pause all" is one `company.freeze` that freezes every team; resuming is founder-only.
- **Key service:** it stores keys only in wrapped form (sealed to each member's x25519 view key) and releases them after an on-chain grant check. It never sees a plaintext key. On `grant_revoked`, it deletes that member's copies and prompts the founder to rotate the code key.
- **Viewers** see money receipts only, and only for the teams they're granted.

---

## API

REST + JSON under `/v1`, validated with zod. Rate limits are 60 writes per minute per account and 10 sign-ins per minute per IP. Writes accept an `Idempotency-Key` header.

| Endpoint | Does |
|---|---|
| `GET /auth/challenge` · `POST /auth/verify` · `GET /auth/me` | Sign in with Privy (Google/email) or a NEAR wallet (NEP-413). The home works with no company |
| `GET /account` · `POST /account/email[/verify\|/privy]` · `PATCH /account/preferences` | Email (verified by code or Privy; needed before creating a company), last company opened |
| `POST /drafts` · `GET/PATCH/DELETE /drafts/:id` · `POST /drafts/:id/launch` | Describe a product → private draft with plan, estimate and suggested company setup; no chain, no money |
| `GET /overview` · `GET /inbox` | Home: every company you can open with the numbers your grant covers; approvals, agent reports and invites in one inbox |
| `GET /analytics` · `GET /reports[/:id]` | Company dashboard: spend by day/team/model/seller, budgets and runway, work and review rate; agent work reports grouped by team |
| `GET /demo` | Public, read-only sample company (invented data) |
| `POST /companies` · `GET /companies[/:id]` | Create a company (from a draft with `planId`, or a preset) → `create_company` + teams. Checks email, slug and wallet balance first; a partial create resumes with only the missing steps |
| `GET /companies/creation/:slug` · `POST /companies/claim-refund` | On-chain create status (no indexer needed) · claim a deferred refund after a failed create |
| `POST /plans` · `GET /plans?companyId=` · `POST /plans/:id/approve` | Run the planner; list a company's plans; turn an approved plan into `assign_task` transactions (routed to the company's matching teams) |
| `GET /estimate` | Cost per tier (p50, p90, cap) for a task tag and size |
| `GET /tasks` · `PATCH /tasks/:id` | Task list; change tier or pin a model → `set_task_tier` |
| `GET /sellers/options?service=` | Up to 3 sellers with live 402 price and a quality note |
| `GET /approvals` · `POST /approvals/:id` | Pending cards (incl. one daily-cap card per day) → batched `approve` / `reject` |
| `GET /ledger` · `GET /audit` · `GET /receipts/:id` | Money receipts (JSON or CSV); permission and key receipts |
| `POST /members/invite` · `DELETE /members/:account` | Invite (email sent after the founder signs) · revoke |
| `GET/PATCH /floats/tempo` | Tempo pocket status and settings → `set_rail_float` |
| `POST /withdrawals` | Plan a withdrawal (sources, quotes, fees) → `request_withdrawal` |
| `POST /keys/code/rotate` · `GET/POST /keys/wrapped` | Founder-only key rotation; wrapped key store |
| `POST /freeze` · `POST /unfreeze` | Pause all spending (one `company.freeze`, cascades to teams; or chosen teams) · resume (founder only) |
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

- Tempo MPP (services outside x402): set `TEMPO_ENABLED=true`. Pocket top-ups use Relay `quote/v2` Base USDC → Tempo USDC.e (`RELAY_API_KEY` / `RELAY_BASE_URL`, or seller-mesh mock). Models stay on Base USDC x402.
- The indexer uses RPC polling; NEAR Lake is the upgrade path if lag shows up.
- Mainnet runs only after a founder-approved switch (`NETWORK=mainnet`).

## Related

- **BuilderOS — Build Architecture**: contracts, payment rails, policy
- **BuilderOS — Frontend Architecture**: the web app
