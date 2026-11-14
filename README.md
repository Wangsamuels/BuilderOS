# BuilderOS

**An operating system for AI-run software companies on NEAR.** A founder describes a product; BuilderOS turns it into a plan and a company on chain, with teams of AI agents that buy the models and services they need, build the product and ship it. Every team spends from a budget that a NEAR smart contract enforces, and every payment is signed by NEAR Chain Signatures only after that contract approves it. The backend never holds a key that can move money.

The problem: autonomous agents that can spend money are only safe if a compromised server, a prompt-injected agent or a bad seller can't drain the treasury. BuilderOS puts the rules on chain (budgets, per-purchase limits, daily caps, allow-listed sellers, approvals, a company-wide pause) and makes the off-chain services powerless over funds. The founder approves anything unusual, sees what each team did, and can pause all spending in one transaction.

Built for **NEAR HACKATHON** (1–14 Nov 2026). Status: **NEAR testnet**, with agent payments on **Base Sepolia** USDC.

| | |
|---|---|
| Backend (this repo) | https://github.com/Wangsamuels/BuilderOS |
| Frontend | https://github.com/Wangsamuels/BuilderOS-frontend |
| Hosted app | https://builder-os-eight.vercel.app |
| Hosted API | https://builderos-api-sam-77caab77f14e.herokuapp.com (`/health`, `/v1/demo`) |
| Tracks | `agents`, `swarms`, `business` |
| Submission tag | `hackathon-submission` (in both repos) |
| Other project by the same author (rule Q-015) | **Kronos**, a security layer for DeFi lending that blocks transactions breaking a protocol's rules and puts risky admin changes behind a public timelock: https://github.com/Wangsamuels/Kronos-backend. Independent project, separate codebase, separate submission. |

---

## What NEAR does in BuilderOS

| Layer | NEAR piece | What it does |
|---|---|---|
| Enforce | Rust contracts: `factory`, `company`, `department` (near-sdk 5.7) | Each company is a NEAR account and each team a sub-account. Budgets, per-purchase limits, task cost caps, the allow-listed sellers, the daily cap, approvals, grants and the freeze all live in contract state and are checked on every purchase. |
| Pay | Chain Signatures (`v1.signer-prod.testnet`) | The team contract builds the USDC `TransferWithAuthorization` itself and asks the MPC signer to sign it with the team's derived Base key. Only that contract can request that key, and only for a purchase it approved. |
| Act | Function-call access keys | Agents hold request-only keys added by the team contract (`request_purchase`, `record_response`, `create_bounty`). The worker key can record outcomes but never pay. No one, including the founder, holds a full-access key to a company or team account. |
| Identify | NEP-413 signed messages, NEAR implicit accounts | Sign-in is a NEP-413 signature checked against the account's full-access keys on chain. Google/email users get a NEAR implicit account through Privy. |
| Record | NEP-297 events | Every money, permission and key change emits a `builderos` v1.0.0 event; the indexer turns each one into a receipt and a live update. |
| Think | NEAR AI models, paid per call via x402 | The model router picks NEAR AI models by tier and pays for each call through the same contract-checked purchase path. |
| Treasury (mainnet path) | NEAR Intents + 1Click | Company deposits and withdrawals use NEAR Intents. Company contract version 4 moves Intents funds only on the founder's signature, and 1Click delivers to Base, Ethereum, Arbitrum or Solana. NEAR Intents is mainnet only, so this path is implemented and tested against a simulator, not live (see [MVP vs stretch](#mvp-vs-stretch-nothing-unfinished-is-claimed-as-working)). |

---

## Try it

### 1. Check the live deployment (read-only, about 2 minutes)

```bash
# API is up and on the published contract version
curl -s https://builderos-api-sam-77caab77f14e.herokuapp.com/health
# → {"ok":true,"service":"api","network":"testnet",...,"contract":"2026-11-13"}

# The public sample company: 4 teams with budgets, 30 days of spend that adds up across days, teams and models
curl -s https://builderos-api-sam-77caab77f14e.herokuapp.com/v1/demo | head -c 600

# The factory on NEAR testnet and its wiring (owner, registry, MPC signer, worker, verifier)
near contract call-function as-read-only builderos-wang.testnet get_config json-args '{}' network-config testnet now
```

### 2. Use the hosted app

1. Open https://builder-os-eight.vercel.app and click **See a sample company**. This is the real app rendering the read-only demo: dashboard, team budgets, spend by day/team/model, agent reports, the ledger.
2. Go back and **Continue with Google** (or email, or a NEAR wallet). You land on Home with no company.
3. **Describe** a product (for example, "A notes app for small teams with sharing links and a monthly plan"). You get a private draft: features, a cost estimate, and a suggested company with teams and budgets.
4. **Launch** it. Creating the company and its teams on chain needs about 13 testnet NEAR in the signing wallet; the app shows the exact amount, your balance and a faucet link if it's short. Sign the transactions in the signing sheet; the company and each team appear as NEAR accounts.
5. In the company: **Approve** the plan (one `assign_task` per task), open **Money** to see team budgets, the ledger and the **Deposit** address for each team, and use **Pause all spending** (one `company.freeze`).

### 3. Run the whole system locally (about 5 minutes)

```bash
pnpm install
docker compose up -d     # Postgres + MailHog
pnpm db:migrate
pnpm dev                 # API :4000, workers, seller mesh :4100 (offline mocks of every seller, bridge and email)
pnpm demo                # offline walk-through of the money path: 402 challenge → contract checks → signed payment → receipt
```

Point the frontend at it with `NEXT_PUBLIC_API_URL=http://localhost:4000` (see the frontend README).

### 4. Tests

```bash
pnpm typecheck
pnpm test                # 64 unit + attack tests (injected payee, value above challenge, replayed challenge, …)
cd contracts && cargo test && cd ..        # 33 company · 15 department · 3 factory

# End to end over HTTP: real API, indexer, worker event router and Postgres against tests/sim/near-sim.ts,
# a NEAR stand-in that enforces the contracts' rules and signatures
DATABASE_URL=postgres://…/postgres npx tsx tests/e2e/flow.mts      # 174 checks, testnet mode
DATABASE_URL=postgres://…/postgres npx tsx tests/e2e/intents.mts   # 46 checks, mainnet mode: Intents treasury + 1Click

# Against real NEAR testnet (funded throwaway keys)
API=… FOUNDER_KEY=… INVITEE_KEY=… npx tsx tests/e2e/live.mts
```

The frontend repo adds 46 Playwright tests (desktop and phone) against a contract-shaped mock API.

---

## Live testnet deployment

API contract: `docs/API-CONTRACT.md`, version **2026-11-13**. Explorer: [testnet.nearblocks.io](https://testnet.nearblocks.io).

| Role | NEAR testnet account |
|---|---|
| Factory (creates companies; embeds the company and team code) | [`builderos-wang.testnet`](https://testnet.nearblocks.io/address/builderos-wang.testnet) |
| Registry (sellers and hireable agents) | [`registry.builderos-wang.testnet`](https://testnet.nearblocks.io/address/registry.builderos-wang.testnet) |
| Worker (record-only key: outcomes, top-ups, withdrawals) | `worker.builderos-wang.testnet` |
| Verifier (posts task verdicts and log hashes) | `verifier.builderos-wang.testnet` |
| MPC signer (Chain Signatures) | `v1.signer-prod.testnet` |
| A company | `<slug>.builderos-wang.testnet` |
| A team | `<team>.<slug>.builderos-wang.testnet` |

The factory was last upgraded on 14 Nov 2026 to company contract version 4 (transaction [`A63X53Be…AQUnL3z`](https://testnet.nearblocks.io/txns/A63X53BecY1e26tkqBaPia9SBak3fSRdLABc5AQUnL3z)). Companies created before an upgrade keep their code until the founder runs `propose_upgrade` → 24 h → `apply_upgrade`. `contract_version` on a company returns its version.

---

## How it works

### Rules the backend holds to

| Rule | In practice |
|---|---|
| **The chain decides** | Postgres is a cache and a store for private data. Budgets, caps and permissions are re-read from NEAR before acting. |
| **No spending keys** | The API never signs. Every write endpoint returns **unsigned NEAR transactions** that the user signs in their own wallet. Agents hold request-only keys; the worker can record but never pay. |
| **Everything leaves a receipt** | Every money or permission transaction produces an event and a receipt. |
| **Idempotent by default** | Every job and write carries an idempotency key, so retries never pay twice. |
| **Private by default** | Code, prompts, plans and logs are stored encrypted (XChaCha20-Poly1305); only hashes go on chain. |
| **Same code offline** | Every external seller has a mock in the seller mesh, so the whole flow runs without the internet. |

### Architecture

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
          │ request_   │ events  │ withdrawals (record only)
          │ purchase   │         │
          ▼            │         ▼
   NEAR contracts ─────┘   NEAR Intents · 1Click
   (policy, grants,
    events)  ──► v1.signer (MPC) signs only what the contract approved
          │
          ▼
   Sellers: NEAR AI models via x402 (Base USDC) · other x402 services
```

### How a purchase works

Agents call paid APIs through **`@builderos/fetch`**, a drop-in `fetch` that acts as a spend firewall:

1. The seller answers `402 Payment Required` with an x402 challenge.
2. The SDK hashes the challenge and calls `request_purchase(seller, rail, amount, challenge_hash, task, model, challenge)` on the team contract with the agent's limited key.
3. The **team contract** checks the payee (an allow-listed seller can only be paid at its registered address), the asset and chain (the team's USDC on Base), the budget, the per-purchase limit, the task's cost cap and the seller allow-list.
4. The **company contract** checks that the company isn't frozen and applies the company-wide **daily cap**.
5. Within every limit, the team contract builds the EIP-3009 transfer itself and asks Chain Signatures to sign it.
6. Otherwise the request becomes an **approval card** (`over_limit`, `new_seller`, `over_task_cap`, `unassigned_task`, `daily_cap`) with the budget reserved. A founder or approver signs `approve` or `reject`.
7. The SDK sends the `X-PAYMENT` header and records `record_response`. The indexer writes the receipt and the verifier checks the Base transaction.

The SDK never supplies the payee or the hash to sign; the contract builds both. A compromised agent can at most buy from allow-listed sellers within the caps.

### Agents and the task graph

An approved plan becomes a DAG of tasks, each assigned on chain (`assign_task`) with a cost cap of p90 × 1.5. For each task the router picks a model, every model call goes through `@builderos/fetch`, the agent writes a patch in an isolated workspace, tests run, and a model from a different lab reviews it (contract and security tasks always). The patch is committed with provenance trailers; logs are sealed and the verifier posts the verdict with the log hash on chain. Roles: 8 build roles (frontend, backend, contracts, security, devops, designer, writer, QA) plus Scout, Buyer, Controller, Ops, Growth and Support.

### Withdrawals (NEAR Intents, mainnet path)

1. `POST /v1/withdrawals` reads the company's USDC in Intents (`mt_balance_of`), picks the route and, for another chain, commits a 1Click quote.
2. The founder signs `request_withdrawal`. The company contract moves the funds inside Intents in that same transaction: `ft_withdraw` to a NEAR account, or `mt_transfer` to the quote's one-time account. Withdrawal ids are single use.
3. `withdrawal_requested` is emitted only if the transfer succeeded; otherwise `withdrawal_failed` and nothing left the company.
4. The worker follows the swap on 1Click and records `done`, `refunded` or `failed` on chain. It never pays.

### Access

Sign-in is a NEP-413 signature, checked against the account's full-access keys on chain. Before building any transaction the API re-checks the caller on chain (founder, or `get_grant` with scope, team, expiry and revocation). Nobody but the founder has access until the founder signs an `invite` and the member accepts.

| Grant | Can see | Can do |
|---|---|---|
| Founder | everything | everything, including invite/revoke, keys, withdrawals, resume spending |
| `admin` | everything | approve, assign tasks, change tiers, pause spending |
| `approve` | approval cards and money for their team | approve / reject purchases |
| `builder` | plans and tasks for their team | create plans |
| `view` | money and budget for their team | — |

The key service stores code keys only wrapped to each member's x25519 view key and releases them after an on-chain grant check. On `grant_revoked` it deletes that member's copies and prompts a rotation.

### Indexer and receipts

The indexer follows NEAR blocks, keeps only BuilderOS accounts, parses NEP-297 `EVENT_JSON` logs against zod schemas, writes receipts and read caches, publishes events to live clients (Postgres `LISTEN/NOTIFY` → SSE, filtered by grant) and sends malformed events to a dead-letter table. It resumes from the last processed block; replays are no-ops.

### API

REST + JSON under `/v1`, validated with zod; writes accept an `Idempotency-Key`. The full contract, with every shape and error code, is in [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md). Main groups: auth and account (`/auth/*`, `/account/*`), drafts (`/drafts`), companies and launch (`/companies`), plans and tasks (`/plans`, `/tasks`, `/estimate`), approvals (`/approvals`), money (`/ledger`, `/deposit`, `/withdrawals`, `/freeze`, `/unfreeze`), members and keys (`/members/*`, `/keys/*`), dashboard (`/overview`, `/analytics`, `/reports`, `/inbox`), the public demo (`/demo`) and live events (`/stream`).

### Reliability

| Failure | What happens |
|---|---|
| Seller times out or errors | No charge (x402 never settles); the router tries the next model or seller |
| Chain Signatures slow or down | Purchases stay queued; jobs retry with backoff |
| Approval never comes | The request expires; the task parks and resumes on the approval event |
| Daily cap reached | Requests join the day's single approval card |
| Indexer behind | Live stream shows "catching up"; the API reads budgets and grants straight from RPC |
| Worker crash | The job re-runs; idempotency keys make it safe |

---

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Rust NEAR contracts: `factory`, `company`, `department`, `registry`; `build.sh` builds the wasm |
| `apps/api/` | Fastify App API, key-service routes, SSE |
| `apps/workers/` | indexer · orchestrator · bridge · notify · verifier · controller (one process) |
| `apps/seller-mesh/` | Offline mocks: x402 sellers, 1Click, Relay, email |
| `packages/shared/` | Config (testnet/mainnet switch), zod and NEP-297 event schemas, logger |
| `packages/db/` | Drizzle schema and migrations, pg-boss queues |
| `packages/near/` | RPC client, NEP-413 verify, contract transaction builders and views |
| `packages/fetch/` | `@builderos/fetch`, the spend-firewall SDK |
| `packages/rails/` · `packages/router/` | Payment-rail adapters; model catalog, estimates and routing |
| `packages/bridge/` | Withdrawal routing (NEAR Intents, 1Click) and optional Tempo top-ups |
| `packages/indexer/` · `packages/verifier/` | Block follower and event → receipt pipeline; foreign-tx verification |
| `packages/crypto/` · `packages/keys/` | libsodium sealing, x25519 wrapping; wrapped-key store with grant checks |
| `packages/orchestrator/` · `packages/notify/` | Planner, task DAG, agent keystore and runner; web push and email |
| `tests/` | Unit and attack tests; `sim/` (NEAR and 1Click simulators); `e2e/` (flow, intents, live) |
| `docs/` | `API-CONTRACT.md`, `ARCHITECTURE.md` |

Deploy: Heroku (`Procfile`, `app.json`: web + worker + Postgres, migrations in the release phase); contracts per [`contracts/README.md`](contracts/README.md).

---

## Hackathon window and pre-existing code (rules Q-001 to Q-004)

- All code in both repositories was written during the hackathon window (work counts from 19 Oct 2026). The first backend commit is dated **2 Nov 2026**; the first frontend commit is dated **13 Nov 2026**. There is no pre-hackathon baseline and no earlier product on another chain.
- Commit history: [backend](https://github.com/Wangsamuels/BuilderOS/commits/main), [frontend](https://github.com/Wangsamuels/BuilderOS-frontend/commits/main). The submitted state is tagged `hackathon-submission` in both repositories.
- An earlier BuilderOS web app built during the hackathon (`builder-os-mu.vercel.app`) gave the black-hole visual concept; it was replaced by the current frontend repository on 13 Nov 2026.

## Libraries, templates and AI tools (rule Q-005)

- **AI coding assistance:** Claude (Anthropic) wrote large parts of the backend, the contracts, the frontend, the tests and this README. The author directed the design, reviewed the code and ran the deployments.
- **AI at runtime:** NEAR AI models, paid per call through x402.
- **Backend:** TypeScript, Node 22, pnpm + Turborepo, Fastify 5, Postgres 16, Drizzle ORM, pg-boss, zod, near-api-js, viem, libsodium, pino, vitest, esbuild.
- **Contracts:** Rust, near-sdk 5.7.
- **NEAR:** Chain Signatures (`v1.signer-prod.testnet`), NEAR Intents and the 1Click API (mainnet path), NEP-413, NEP-297.
- **Sign-in:** Privy (Google/email with NEAR embedded wallets), NEAR wallet-selector.
- **Frontend (separate repo):** Next.js 16, React 19, Tailwind 4, TanStack Query, Playwright.
- **Hosting:** Heroku (API, workers, Postgres), Vercel (web app). Email: Resend.
- No third-party templates or boilerplate beyond standard library scaffolds.

## MVP vs stretch (nothing unfinished is claimed as working)

**Works on testnet now:** sign-in with Google, email or a NEAR wallet; verified email; drafts with a plan, estimate and suggested setup; launching a company and its teams on chain; plan approval into on-chain task assignments; approval cards; invites, grants and revocation; pause and resume; the ledger and receipts; deposit addresses per team; the live event stream; the public demo. The authenticated end-to-end suite (`tests/e2e/live.mts`) ran against real testnet on 11 Nov 2026 (74/74).

**Implemented and tested, not live:**
- NEAR Intents treasury (company deposit address, withdrawals with 1Click delivery). NEAR Intents is mainnet only; the path is covered by `tests/e2e/intents.mts` against simulated Intents and 1Click. The Intents call shapes and 1Click asset ids have not been exercised on mainnet.
- Agent purchases end to end on live testnet: the contract path is covered by contract and simulator tests; a live run with funded agents is still pending.

**Not running yet:** mainnet deployment; Tempo MPP payments (off, `TEMPO_ENABLED=false`); the `x402-near` rail; NEAR Lake indexing (RPC polling today).

**What BuilderOS can't stop:** a founder approving a bad purchase, or spending that stays inside the limits the founder set. The limits are the guarantee; choosing them is up to the founder.

## License

MIT. See [`LICENSE`](LICENSE).
