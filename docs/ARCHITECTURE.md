# BuilderOS — Backend Architecture

**Version:** 13 Nov 2026 (replaces the original "BuilderOS — Backend Architecture" PDF)
**Network:** NEAR testnet · **API contract:** [`API-CONTRACT.md`](./API-CONTRACT.md) (version `2026-11-13`)

BuilderOS lets a founder describe a product and have AI agents build and run it, while every dollar the agents spend is controlled by NEAR smart contracts. The **founder decides who sees what**: nobody gets access to a company or its money unless the founder grants it on chain. The backend only *reads* and *proposes*. It never holds keys that can move company money.

---

## 1. Design guards

These rules shape everything below. A change that breaks one of them is a bug.

1. **The founder decides access.** Every non-founder right comes from an on-chain grant (founder signs `invite`, member signs `accept_invite`). A grant has scopes (`view`, `approve`, `builder`, `code`, `admin`) and, unless it's `admin`, one team. The API re-reads founder and grant from the company contract on **every** request. Postgres is only a cache and is never trusted for permissions or money.
2. **Nobody holds keys to company or team accounts.** They're created with **no full-access key**, not even the founder's. Agents get *function-call* keys that the team contract adds itself, limited to `request_purchase`, `sign_approved`, `cancel_request`, `record_response` and `create_bounty`. Code changes go through a public **24 h timelock** (`propose_upgrade` → `apply_upgrade`).
3. **Contracts decide spending.** Payee, asset, chain, budget, per-purchase limit, task cap and daily cap are checked on chain. Payments are signed by **NEAR Chain Signatures**, which only the team contract can ask for its derived key.
4. **The backend proposes, the user signs.** Every write route returns unsigned transactions (wallet-selector shape) for the user's wallet to sign.

---

## 2. System overview

```
 Browser (Vercel, Next.js, Privy embedded NEAR wallet)
   │  NEP-413 sign-in → Bearer token          signs every returned tx
   ▼                                                   │
 ┌──────────────── Heroku app "builderos-api" ───────────────┐
 │ web    : Fastify API  (apps/api)  ── REST + SSE            │
 │ worker : apps/workers ── indexer · orchestrator · bridge · │
 │          notify · verifier · controller · deposit sweep    │
 │ release: DB migrations (packages/db/dist/migrate.js)       │
 │ Postgres 16 (Drizzle ORM, pg-boss queues, LISTEN/NOTIFY)   │
 └───────────┬───────────────────────────────┬────────────────┘
             │ views (RPC)                   │ events
             ▼                               ▼
 NEAR testnet contracts            FastNEAR block archive (neardata) +
   factory  builderos-wang.testnet  FastNEAR tx index (fallback / catch-up)
   ├─ company <slug>.builderos-wang.testnet
   │   └─ team <team>.<slug>.builderos-wang.testnet
   registry registry.builderos-wang.testnet
   Chain Signatures v1.signer-prod.testnet ── signs team payments
             │
             ▼
 Sellers: Near AI models + other x402 services (Base USDC),
          Tempo MPP only when a service needs it (Relay / 1Click bridge)
```

**Hosting:** Heroku runs the API, the worker and Postgres. Vercel hosts the web app, which is a separate repo. Browser and API are cross-site (`*.vercel.app` ↔ `*.herokuapp.com`), so auth uses a **Bearer token** with a partitioned cookie as backup. Cloudflare was considered and dropped.

---

## 3. Smart contracts (`contracts/`, Rust, near-sdk 5.30)

Built with `contracts/build.sh` (wasm32, optional `wasm-opt`). `company.wasm` embeds `department.wasm`, and `factory.wasm` embeds `company.wasm`. Redeploying the factory (`without-init-call`) changes the code of **new** companies only.

| Contract | Account | Role |
|---|---|---|
| **Factory** | `builderos-wang.testnet` | `create_company(slug, …)`: creates `<slug>.<factory>` with no full-access key (deposit ≥ 7.5 NEAR) and records slug → founder. Failed creates refund. If a refund can't be sent at once it waits in `refund_pending` (`claim_refund`, `get_pending_refund`). `get_company(slug)`. |
| **Company** | `<slug>.builderos-wang.testnet` | Founder, grants, invites (sha256 hash, single use), teams, daily cap, frozen flag, code-key version, pending approvals, upgrade timelock. Forwards team policy calls (`dept_call`), approves/rejects purchases, registers/fires agents, `check_spend` (daily cap). |
| **Team** ("department") | `<team>.<slug>.builderos-wang.testnet` | Budget, spent, reserved, per-purchase limit, frozen, seller allow-list, tasks (tier, cap, hire), Base EVM config, purchase requests. Accepts policy changes **only from its company**. Builds and requests payment signatures. |
| **Registry** | `registry.builderos-wang.testnet` | Sellers, hireable agents, models-catalog hash (`list_sellers`, `list_hireable_agents`, `get_models_hash`). |
| **Chain Signatures** | `v1.signer-prod.testnet` | MPC signer. Team payment address = `derived_public_key({ path: "builderos-base", predecessor: team, domain_id: 0 })` → keccak → last 20 bytes. |

**Deposits:** company 7.5 NEAR, each team 4.5 NEAR, about 22 NEAR recommended for 3 teams (the API computes the exact amount).

### Company contract versions (`contract_version()`)

| Version | What it adds | Who has it |
|---|---|---|
| none / 1 | original | early companies (e.g. `addy`) |
| **2** | calls to several teams never return a "joint promise" (NEAR rejects that); one team's calls go out as one atomic batch | companies created 10–12 Nov (`demo`, `sezk`, test companies) |
| **3** | `allow_seller` / `set_evm_config` / `top_up_budget` are forwarded with 0 deposit (they always failed before); a team-limited approver can only approve their own team's purchases | companies created after the factory is redeployed with the latest build |

The API reads `contract_version()` per company (cached 5 min):

- **v < 2:** one inner call per transaction.
- **v < 3:** features that need v3 answer `409 contract_upgrade_required`.

Upgrading an existing company takes `propose_upgrade("company", sha256)` → 24 h → `apply_upgrade` with the raw wasm (~680 KB) as input. The web wallet can't sign that yet, so it's an operator task.

### Team policy path

`company.dept_call({ calls: [{ department, method, args }] })`, founder or admin only:

- 1–12 calls per transaction; the attached deposit = number of calls (yocto).
- Allowed inner methods: `assign_task`, `set_task_tier`, `set_task_hire`, `set_rail_float`, `allow_seller`, `set_evm_config`, `top_up_budget`, `freeze`.
- Resuming spend is the company's founder-only `unfreeze`. "Pause all" is company `freeze`, which freezes every team.

---

## 4. How a purchase works

```
agent (function-call key on its team)
  └─ team.request_purchase(challenge from the seller's HTTP 402)
       1. rail must be x402-evm (others → "rail_not_supported"; router tries the next offer)
       2. challenge not reused · asset/chain = team's USDC on Base · within budget
       3. allow-listed seller at a different payee → purchase_rejected (attack), "payee_mismatch"
       4. needs approval? new_seller · over_limit · over_task_cap · unassigned_task
       5. reserve amount → company.check_spend (frozen? daily cap?)
            ok      → team builds EIP-3009 TransferWithAuthorization digest
                      → v1.signer.sign → signature returned to the agent
            pending → purchase_yielded → approval card in the app
            reject  → reservation released
  approval: founder/approver signs company.approve → team.mark_approved
            → agent calls sign_approved → signature
  agent retries the seller with X-PAYMENT; on the response → record_response (settles)
```

The digest is built **in the contract** and matched byte-for-byte against viem in tests. Seller allow-list = seller id → the only address it may be paid at.

**Funding:** agents pay from each team's **Base (Sepolia on testnet) USDC address**, shown by `GET /v1/companies/:id/payments` and `GET /v1/deposit`. A single company-level deposit address and withdrawals need **NEAR Intents**, which isn't deployed on testnet. On mainnet the treasury is the company's NEAR Intents balance.

**Rails:** models are paid with **x402 on Base USDC**. **Tempo MPP** is only for services that require it: the bridge worker tops up a team's Tempo float via Relay (Base USDC → Tempo USDC.e), within fee and frequency guards.

---

## 5. Backend code (`apps/`, `packages/`)

TypeScript, Node 22, pnpm workspaces (hoisted), turbo, esbuild bundles (`scripts/build.mjs`), vitest.

| Path | Purpose |
|---|---|
| `apps/api` | Fastify 5 REST + SSE. Session load, company-id normalisation hook, idempotency, CORS, rate limit (60 writes/min), error envelope, `transactions[]` normalisation. Routes: `auth`, `account` (email, preferences), `drafts` (drafts, launch, company plans), `home` (overview, analytics, reports, inbox, demo), `core` (companies, plans, tasks, agents, payments, sellers), `money` (approvals, ledger, audit, floats, withdrawals, freeze), `members` (invites, members, keys), `stream`, `extra` (teams, deposit, policy, plan edit, task detail/estimate, invite preview, device keys, revenue, stable 501s). |
| `apps/workers` | One process: indexer loop, orchestrator scheduler, bridge scan, deposit sweep, pg-boss jobs (task, verify, notify, bridge top-up/withdraw, controller, leaderboard). Chain-event routing lives in `src/events.ts` (shared with the end-to-end test). |
| `apps/seller-mesh` | Local mock sellers (x402 + MPP) for offline demos and tests (`USE_SELLER_MESH`). |
| `packages/near` | RPC client (fallback + retry), NEP-413 sign-in, login resolution, **all contract method shapes** (`tx.*`, `views.*`), company-id normalisation, contract-version batching, Chain Signatures payment addresses, Base USDC balance reads, service signer. |
| `packages/db` | Drizzle schema, migrations (`drizzle/0000–0003`), pg-boss, `EVENTS_CHANNEL`. |
| `packages/indexer` | Chain → events, receipts and caches (see §7), deposit sweep, tx-index backfill. |
| `packages/shared` | Env config (zod), API body schemas, event schemas, `HttpError` with default codes. |
| `packages/orchestrator` | Planner (description → features + estimate), team routing (`pickTeam`) and suggested company setup (`suggestSetup`), DAG runner, agent work reports (`report.ts`), hiring (niche agents from the registry). |
| `packages/router` | Model catalog, per-tier estimate (p50/p90/cap) and per-model estimate, model choice (quality, pass rate, cost, latency). |
| `packages/fetch` | Policy-checked purchase client: 402 → `request_purchase` → wait for signature/approval → pay → `record_response`. |
| `packages/rails` | 402 challenge parsing (x402 EVM/NEAR, MPP Tempo), payment headers, payee-mismatch guard. |
| `packages/keys` | Wrapped code/log keys: upload (founder, version must match chain), release after an on-chain grant check, delete on revoke. |
| `packages/crypto` | libsodium sealing, server key, hashing. |
| `packages/bridge` | 1Click + Relay quotes, Tempo top-ups, withdrawals. |
| `packages/verifier` | Verifies foreign-chain receipts, submits verdicts. |
| `packages/notify` | In-app, web push, email alerts. |

---

## 6. Identity, access and keys

- **Sign-in (Privy or a NEAR wallet):**
  1. `GET /v1/auth/challenge` → the browser signs NEP-413 (recipient = web host). `accountId` is optional, so the app can fetch the challenge on page load: no RPC, a few ms, and the button works on the first click.
  2. `POST /v1/auth/verify` → session (24 h; cookie sessions rotate after 12 h) and Bearer token. A challenge is claimed atomically, so it works once. `loginMethod` (`privy` / `wallet`) is stored on the session.
  3. Privy (Google/email) logins resolve to the key's **implicit 64-hex account**. Placeholder names `bos-*.testnet` map to it. Named accounts are kept only if the key is a full-access key on them.
- **Email:** founders need a **verified email before creating a company** (403 `email_required`); everything else works without one.
  - Privy users send their Privy identity token at sign-in. It's verified (ES256, issuer, `PRIVY_APP_ID`, expiry) and must list the signing wallet.
  - NEAR wallet users confirm a 6-digit code sent by email (hashed, 10 min, 5 tries).
  - Addresses are sealed at rest, shown masked, and alerts go only to verified addresses.
  - Invites sent to a verified address show up in the inbox and can be accepted there.
- **Company id:** `demo`, `DEMO` and `demo.builderos-wang.testnet` are the same company everywhere (`normalizeCompanyId`, applied by a global hook and inside every check).
- **Authorisation:** `authorize(account, companyId, scopes, team?)`:
  - founder = `company.get_company().founder`, otherwise `company.get_grant(account)` with expiry, revocation and team checks
  - `requireFounder` for founder-only actions (invite, revoke, rotate, unfreeze, withdraw, daily cap)
- **Membership list (`/auth/me`):** candidates from the indexer cache **plus `company_links`**, which is written when an account creates, polls, reads or accepts an invite for a company, and was backfilled from saved create responses. Each candidate is re-checked on chain, so a new company shows up instantly and a revoked one disappears.
- **Device keys:**
  - `register_view_key` only emits an event (no on-chain state), so keys live in `view_keys`. They're saved by the indexer, or immediately by `POST /v1/keys/view/confirm { txHash }`, which checks the tx on chain.
  - Rotation: `rotate_code_key` (founder) → `GET /v1/keys/devices` (public keys of accounts still allowed) → wrap in the browser → `POST /v1/keys/wrapped` (refused until the chain shows the new version).
  - **Encrypted file storage isn't shipped** (`GET /v1/private` → 501).

- **Account home (no company needed):**
  - Sign-in lands on a home that works with zero companies.
  - **Drafts** are product ideas with a plan, an estimate and a suggested company setup (teams, budgets, daily cap). They're owned by their author and sealed to them, with no chain and no money. To anyone else they're a 404.
  - **Launch** creates the company from a draft (`POST /v1/companies { planId }`). The draft joins the company once the chain shows it, and its text is re-sealed to the company. One account can found or join many companies.
  - **Overview, analytics, reports and inbox** are cut to each grant: money for view/approve, work for builder/code, approvals for approve, one team for team-limited grants.
  - **Demo:** `GET /v1/demo` serves an invented, read-only sample company. It touches no chain or database, so the design guard isn't bent for it.

---

## 7. Indexer and live updates

The indexer turns NEP-297 `EVENT_JSON` logs from BuilderOS accounts into `events` rows, read caches (members, floats, bounties, approval cards, companies, teams, view keys) and `receipts`. It publishes each row id on Postgres `LISTEN/NOTIFY` for the SSE hub. Replays are no-ops (unique `receipt_id, log_index`).

**Sources, in order:**

1. **FastNEAR block archive** (`testnet.neardata.xyz`): one request per block with every receipt and log. It reads only up to the archive's own final head, so a block it hasn't got yet is never treated as empty. Defaults: 2 in flight, batch 30, retry with backoff on 429.
2. **FastNEAR tx index** (`tx.test.fastnear.com`): asks only for the transactions of the factory, registry and every company and team (new ones are found from `company_created` / `department_created`), with full receipts. Used when:
   - **far behind** (> 2,000 blocks): the cursor jumps to the head; 488k blocks caught up in ~9 s in production
   - **the archive throttles** (2 loops with 429): it polls every ~5 s and keeps the cursor **60 blocks behind the head**, re-reading the previous 120 blocks each round, so transactions the index lists late are never skipped
3. **Raw RPC** only when the archive is switched off (`NEARDATA_URL=""`).

**Never stall:** a transaction that fails 5 times is dead-lettered and skipped. `department_created` rebuilds a missing company row from chain.

**Free-tier reality:** Heroku's shared IPs get 429s from public RPC and the archive. The worker therefore usually runs in tx-index mode, 60–100 blocks (35–60 s) behind. That's by design, and the app reads access and balances live from chain anyway. `NEARDATA_API_KEY` (optional) removes the throttling.

**Deposit sweep:** every 60 s the worker reads each team's Base USDC balance. An increase writes a `deposit_received` event, which travels the same path as chain events.

**SSE (`GET /v1/stream`):**

- Auth: session or a 15-min **stream token** (`POST /v1/stream/token`, valid only on the stream).
- Frames: `ready`, `status` (indexer lag), `<event>` with `id`, and `reauth` (token expired, then close).
- Resume with `Last-Event-ID` or `?lastEventId=` (≤ 500 replayed).
- Events are filtered by the viewer's grant: everyone gets structural events, view/approve get money events, builder gets build events, founder/admin get all.

---

## 8. Data model (Postgres, cache only)

| Group | Tables |
|---|---|
| Chain caches | `companies`, `departments`, `agents`, `members_cache`, `rail_floats`, `bounties_cache`, `approval_cards`, `events`, `receipts`, `dead_letters`, `indexer_state` |
| Access | `auth_challenges`, `auth_sessions` (+ `login_method`), `idempotency_keys`, `company_links`, `view_keys`, `invites`, `wrapped_keys`, `key_access_log` |
| Account | `account_emails` (+ `verified_at`, `source`), `email_verifications`, `account_prefs`, `inbox_reads` |
| Work | `plans` (description sealed; `company_id` null = draft, + `title`, `launch_company_id`, `launched_at`), `tasks`, `task_reports`, `hires`, `seller_options`, `model_calls`, `provenance`, `services`, `encrypted_logs` |
| Money ops | `bridge_transfers`, `withdrawals`, `address_balances`, `testnet_drips` |
| Notify | `notifications`, `push_subscriptions` |

Migrations run in Heroku's release phase.
- `0003_company_links` adds `company_links` (with backfill), `view_keys` and `address_balances`.
- `0004_account_home` makes `plans.company_id` nullable (drafts) and adds email verification, preferences, task reports and inbox read state. Existing plans are marked launched; existing unverified emails stay unverified.

---

## 9. API surface (summary)

The full matrix (status, auth, shapes, errors) is in [`API-CONTRACT.md`](./API-CONTRACT.md). Conventions:

- **Money:** micro-USDC integer strings; NEAR amounts in yocto.
- **Writes:** return `transactions[]` to sign in order.
- **Errors:** `{ error, code, message, details? }` with stable codes (`forbidden`, `plan_already_approved`, `contract_upgrade_required`, `not_implemented`, …).
- **Unshipped features:** stable `501 not_implemented` with `details.status` and `replacement`.
- **Health:** `GET /health` → `{ network, commit, contract }`; `GET /v1/status` → indexer lag, queue depth.

---

## 10. Agents and the task graph

1. **Plan and estimate.** The planner turns the founder's description into features and an estimate. Plans can be edited until approved; approving returns `dept_call → assign_task` transactions.
2. **Task caps.** Each task has a cost cap of p90 × 1.5.
3. **Running a task.** The runner picks a model in the task's tier and pays through `@builderos/fetch`, so every call is a policy-checked purchase. It writes the patch in an isolated workspace and runs checks.
4. **Review.** A model from another lab reviews the result; contract and security tasks are always reviewed.
5. **Record.** It records provenance, and the verifier posts the verdict.
6. **Report.** Each attempt writes a **work report** (`task_reports`), grouped by team in the app.
   - Facts come from records: model calls and their cost, files, checks, the review verdict, commit and receipts.
   - The agent supplies only its one-paragraph summary, labelled as the agent's.
   - Outcomes: done, needs_review, retrying, paused (e.g. waiting for an approval) or failed.
   - New reports reach the live stream as `task_reported`.
7. **Hiring.** Niche work can hire registry agents only when needed and affordable.
8. **Team routing.** Tasks go to the company's matching team by kind of work, even with custom team names (`eng/growth/ops/support` or `build/ops/growth`).

---

## 11. Operations

| What | Where |
|---|---|
| Deploy backend | `git push origin main`. Heroku builds; release runs migrations; web + worker restart. |
| Deploy contracts | `cd contracts && ./build.sh`, then `near contract deploy builderos-wang.testnet use-file wasm/factory.wasm without-init-call network-config testnet sign-with-keychain send`. Top up the factory if it runs low. |
| Health | `GET /health`, `GET /v1/status` (`indexerLag`), `heroku logs -t -d worker -a builderos-api` |
| E2E check | `tests/e2e/live.mts`: signs in as real wallets, signs every returned tx on testnet, records redacted evidence (74/74 against production on 11 Nov). A founder key needs a verified email once (`FOUNDER_EMAIL`, then `EMAIL_CODE`). `tests/e2e/flow.mts`: the whole account-home flow (169 checks) against Postgres and a NEAR simulator (`tests/sim/near-sim.ts`), for when testnet isn't reachable. |
| Secrets | Only in Heroku/Vercel config vars. The repo is public. `.gitignore` covers `.env`, keystores, keys and `Claude outputs/`. |

**Config (Heroku):**

| Group | Variables |
|---|---|
| Core | `NODE_ENV`, `NETWORK`, `DATABASE_URL`, `SESSION_SECRET`, `WEB_ORIGIN` (+ `WEB_ORIGIN_PATTERN`), `AUTH_RECIPIENT` |
| NEAR | `FACTORY_CONTRACT`, `REGISTRY_CONTRACT`, `MPC_SIGNER`, `NEAR_RPC_URL` / `NEAR_RPC_FALLBACK_URL` |
| Service keys | `WORKER_*` and `VERIFIER_*` (limited keys) |
| Agents | `AGENT_KEYSTORE_*`, `NEAR_AI_*` |
| Rails | `BASE_RPC_URL`, `TEMPO_*`, `RELAY_*`, `ONECLICK_*` |
| Notify | `VAPID_*`, email (`RESEND_API_KEY` + `EMAIL_FROM`, or `NEAR_EMAIL_*`, or `STABLE_EMAIL_URL`; also sends email codes) |
| Sign-in | `PRIVY_APP_ID` (+ optional `PRIVY_VERIFICATION_KEY` / `PRIVY_JWKS_URL`) |
| Home | `DEMO_ENABLED` (default on); `EMAIL_DEV_ECHO` (dev/test only, ignored in production) |
| Testnet sponsor | `TESTNET_SPONSOR_*` |
| Optional indexer | `NEARDATA_URL`, `NEARDATA_API_KEY`, `FASTNEAR_TX_URL`, `INDEXER_*`, `DEPOSIT_SWEEP_MS` |

---

## 12. Status (13 Nov 2026)

| Area | State |
|---|---|
| Sign-in, companies, founder access, invites, permissions, plans, tasks, pause/resume, caps, device keys, rotation, stream | ✅ verified on testnet against production |
| Account home: Privy + wallet sign-in, email verification, drafts, launch from draft, multiple companies, overview, analytics, team reports, inbox, preferences, demo | ✅ 169/169 end-to-end checks against a NEAR simulator; live testnet run pending deploy |
| Indexer | ✅ caught up; runs in tx-index fallback on the free tier (~35–60 s behind) |
| Contract v3 (allow-seller, budget raise, payment re-config, approver team check) | ✅ in source and tests; live for new companies after the factory redeploy |
| Agent purchases end to end (agent key → Chain Signatures → seller paid on Base) | 🟡 contract and client paths built and unit-tested; needs funded team addresses and registered agents for a live run |
| Company-level deposit / withdrawals | ⛔ testnet (no NEAR Intents); mainnet design in place |
| Encrypted file storage, provenance view, leaderboard, services | 🗓 planned (stable 501s) |
