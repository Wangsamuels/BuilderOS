# BuilderOS API contract

**Contract version:** `2026-11-11` (also returned by `GET /health` → `contract`)
**Base URL (testnet):** `https://builderos-api-d6d40e9cc381.herokuapp.com`
**Verified against:** deployed commit `ad62781` on 11 Nov 2026, 74/74 authenticated checks on NEAR testnet (`tests/e2e/live.mts`).

This file is the source of truth for the web app. A change to a route's shape changes this file and the contract version.

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <session token>` from `POST /v1/auth/verify` (a cookie also works where third-party cookies are allowed). |
| Identity | The signed-in account. For Privy (Google/email) logins this is the key's **implicit 64-hex account**. A claimed `bos-*.testnet` name is mapped to that implicit id. |
| Company id | Accepted anywhere as the **slug** (`demo`) or the **full account id** (`demo.builderos-wang.testnet`), in the path, query or body. Responses always return the full id as `companyId`, plus `slug`. |
| Team id | Full account id (`eng.demo.builderos-wang.testnet`). `POST /v1/policy` and `POST /v1/members/invite` also take a team name (`eng`). |
| Money | **Integer strings in micro-USDC** (6 decimals): `"5000000"` = $5. The create body also accepts a decimal string as dollars (`"5.00"`). Never floats. NEAR amounts are yocto strings. |
| Authorization | Every request re-checks the caller **on chain**: founder (`get_company().founder`) or a live grant (`get_grant`). Postgres is only a cache. |
| Idempotency | Send `Idempotency-Key` on writes. The same key from the same account replays the stored answer (`idempotent-replay: true`). `POST /v1/stream/token` and logout are never replayed. |
| CORS | Production origin allowed with credentials. Allowed headers: `content-type, authorization, idempotency-key, last-event-id, x-request-id`. |
| Writes | Return unsigned NEAR transactions in wallet-selector shape. **Always read `transactions` (an array) and sign in order.** Single-tx routes also keep `transaction` (= `transactions[0]`). Each tx carries `signerId` when only the caller may sign it. |
| After signing | Chain reads use `final` finality, so a change becomes visible 2–3 s after the tx executes. Poll (2 s, up to ~20 s) when the next screen depends on it, e.g. after accept-invite or rotate. |

### Transaction shapes

| Action | receiverId | method | deposit |
|---|---|---|---|
| Team policy (assign tasks, tier, Tempo float, allow seller, team budget, pause one team) | company | `dept_call { calls: [{department, method, args}] }`, ≤ 12 calls per tx | **= number of calls** (yocto) |
| Pause all | company | `freeze` | 1 yocto |
| Resume (founder only) | company | `unfreeze` | 1 yocto |
| Daily cap (founder only) | company | `set_caps` | 1 yocto |
| Approve / reject purchases | company | `approve` / `reject` (≤ 20 ids per tx) | 1 yocto |
| Invite / revoke (founder) | company | `invite` / `revoke` | 1 yocto |
| Accept invite | company | `accept_invite { code }` | 0 |
| Register device key | company | `register_view_key` | 0 |
| Rotate code key (founder) | company | `rotate_code_key` | 1 yocto |
| Agents (founder/admin) | company | `register_agent` / `fire_agent` | 0 |
| Create | factory then company | `create_company` (7.5 NEAR), `create_department` (4.5 NEAR each), `set_caps` | as listed |
| Refund claim | factory | `claim_refund` | 0 |

**Companies on contract version 2** (e.g. `demo`, `sezk`; version is in `contract_version()`) get one `dept_call` inner call per tx. That's because v2 can't return several team calls at once. `allow_seller`, `set_evm_config` and `top_up_budget` need **v3**; on v2 these routes answer `409 contract_upgrade_required`.

### Errors

Every error is `{ "error": code, "code": code, "message": human text, "details"?: object }`.

| HTTP | code | When |
|---|---|---|
| 400 | `invalid_request` | Validation (`message` lists the fields) |
| 401 | `unauthenticated` | No/expired session, or a stream token used outside `/v1/stream` |
| 402 | `insufficient_funds` | Create bundle the wallet can't pay (`details: { requiredYocto, availableYocto, funding }`) |
| 403 | `forbidden` | Not a member, or the grant doesn't cover this (`details.required` = scopes) |
| 404 | `not_found` / `tx_not_found` | Missing resource / tx not visible yet |
| 409 | `slug_taken`, `create_in_progress`, `plan_already_approved`, `version_conflict`, `contract_upgrade_required`, `budget_decrease_unsupported`, `insufficient_funds` (withdrawal), `no_teams`, `tx_mismatch`, `conflict` | State conflicts |
| 429 | `rate_limited` | > 60 writes/min per account |
| 501 | `not_implemented` | Feature not available: `details: { feature, status: "unsupported" \| "planned", replacement? }` |
| 503 | `mpc_unavailable`, `sponsor_unavailable`, `unavailable` | Upstream down |

---

## 2. Endpoint matrix

Status: **✅ implemented** · **🟡 partial** (works, limits noted) · **⛔ unsupported** (stable 501) · **🗓 planned** (stable 501). Auth: `founder` · `admin` (founder or admin grant) · scope names = any one of them, limited to the grant's team · `session` = any signed-in account · `public`.

### Auth and session

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/auth/challenge?accountId=` | ✅ | public | → `{ message, recipient, nonce, expiresAt }` (NEP-413) |
| `POST /v1/auth/verify` | ✅ | public | `{ accountId, publicKey, signature, message, nonce }` → `{ accountId, token, expiresAt }` (24 h) |
| `POST /v1/auth/logout` | ✅ | session | → `{ ok }`; the token stops working at once |
| `GET /v1/auth/me` · `/session` · `/setup` | ✅ | session | → `{ accountId, companies: [{ companyId, slug, name, isFounder, admin, scopes, departmentId }], companyIds, balance, funding, pendingRefund, setup }`. Each company is re-checked on chain. A company appears as soon as the account creates it (no indexer wait). |
| Session refresh | 🟡 | — | No refresh endpoint. Sessions last 24 h; a cookie session older than 12 h is rotated automatically. On a 401, sign in again. |
| `POST /v1/auth/fund-testnet` | ✅ | session | testnet only; sends the create shortfall once per account |

### Companies, teams, settings

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `POST /v1/companies` | ✅ | session | `{ name, slug, preset?, dailyCap?, teams?: [{ team, monthlyCap }], departments?: [...], autoApproveLimit? }` → `{ companyId, transactions, resumed, complete, missing, verify, funding, requiredYocto }`. Same slug = resume. Errors: 402, 409 `slug_taken` / `create_in_progress`. |
| `GET /v1/companies/creation/:slug` | ✅ | session | → `{ slugTaken, founderIsYou, companyExists, departments, dailyCap, pendingRefundYocto }` |
| `GET /v1/companies` | ✅ | session | → `{ companies: [...membership + cached row] }` |
| `GET /v1/companies/:id` | ✅ | any scope | → `{ company, companyId, slug, departments (own team for limited grants), chain, access: { founder, admin, scopes, departmentId, expiresAtMs } }` |
| `POST /v1/companies/claim-refund` | ✅ | session | → `{ amountYocto, amountNear, transaction }`, or 404 when nothing is owed |
| `GET /v1/teams?companyId=` | ✅ **new** | any scope | → `{ teams: [{ name, departmentId, budget, spent, reserved, available, perTxLimit, frozen, paymentAddress, chainId, agents[], tasks{status:n} }], units }` (live from the team contracts) |
| `POST /v1/policy` | 🟡 **new** | see note | `{ companyId, dailyCap? (founder), team?, monthlyCap?, budgetIncrease?, tempo?: { target, enabled } (admin) }` → `{ transactions }`. `perTxLimit`, `autoApproveLimit` and `tier` → **501** (the contracts can't change them after create). Lowering a budget → 409 `budget_decrease_unsupported`. Raising a budget needs company v3. |
| `GET /v1/companies/:id/payments` | ✅ | view/approve | team Base USDC addresses: `{ teams: [{ name, departmentId, chainId, usdc, address, derivedAddress, configured }] }` |
| `POST /v1/companies/:id/payments/configure` | 🟡 | admin | → `{ transactions }` (needs v3) |

### Money

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/deposit?companyId=` | 🟡 **new** | view/approve | → `{ supported, address, method, reason, message, tokens[], units, balance, teams: [{ team, departmentId, address, chainId, token, balance }], event: "deposit_received" }`. **Testnet: `supported:false, address:null`** because NEAR Intents isn't deployed on testnet, so there's no single company address. Fund team addresses; `balance` = sum of their live Base USDC. Mainnet: company NEAR Intents account. |
| `GET /v1/approvals?companyId=&status=` | ✅ | approve | → `{ cards }`. A team-limited approver sees only that team's cards; daily-cap cards need a company-wide grant. |
| `POST /v1/approvals/:id` | ✅ | approve (+admin for alwaysAllow) | `{ decision: "approve"\|"reject", alwaysAllow? }` → `{ card, transactions }`. `alwaysAllow` adds the `dept_call → allow_seller` tx **in the same response** (needs v3). |
| `GET /v1/ledger?companyId=&kind=&departmentId=&before=&limit=&format=json\|csv` | ✅ | view/approve | → `{ receipts }` (amount micro-USDC) |
| `GET /v1/receipts/:id` | ✅ | view/approve | → `{ receipt }` |
| `GET /v1/audit?companyId=` | ✅ | admin | → `{ receipts, keyAccess }` |
| `GET /v1/floats/tempo?companyId=` | ✅ | view | → `{ floats: [{ department_id, name, target, balance, reserved, enabled, paused, topups_today, updated_at, in_flight }] }` (one row per team; null fields = no float yet) |
| `PATCH /v1/floats/tempo` | ✅ | admin | `{ departmentId, target, enabled }` → `{ transaction }` |
| `POST /v1/floats/top-up` | ⛔ | — | 501, replacement `PATCH /v1/floats/tempo` (the bridge tops up automatically) |
| `POST /v1/withdrawals` | 🟡 | founder | `{ companyId, amount, token="usdc", to, chain="near"\|"base"\|"ethereum"\|"arbitrum"\|"solana" }` → `{ plan: { withdrawalId, sources, available }, transaction }`. **Testnet: 409 `insufficient_funds`**, because the treasury is NEAR Intents (not on testnet). |
| `POST /v1/withdraw/quote` | ⛔ | — | 501, replacement `POST /v1/withdrawals` (the plan is the quote) |
| `GET /v1/revenue?companyId=` | ✅ **new** | admin | → `{ total, units, receipts }` |
| `GET /v1/services` · `POST /v1/services/:id/cancel` | 🗓 | — | 501 planned |
| `POST /v1/freeze` | ✅ | admin | `{ companyId, departments? }` → `{ transactions }` (pause all = one `freeze`) |
| `POST /v1/unfreeze` | ✅ | founder | `{ companyId }` → `{ transactions }` |

### Plans, tasks, agents

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `POST /v1/plans` | ✅ | builder | `{ companyId, description, tier }` → `{ plan }` |
| `GET /v1/plans/:id` | ✅ | builder | → `{ plan, tasks }` |
| `PATCH /v1/plans/:id` | ✅ **new** | builder | `{ features?, removeKeys?, tier? }` → `{ plan }` (re-estimated). Approved plan → 409 `plan_already_approved`. |
| `POST /v1/plans/:id/approve` | ✅ | admin | → `{ tasks, transactions, resumed }`. Calling it again before the tasks are on chain returns the same txs. |
| `GET /v1/tasks?companyId=&planId=` | ✅ | builder | → `{ tasks }` |
| `GET /v1/tasks/:id` | ✅ **new** | builder | → `{ task, hires, units }` |
| `PATCH /v1/tasks/:id` | ✅ | admin | `{ tier?, pinnedModel? }` → `{ transactions }` |
| `POST /v1/estimate` | ✅ **new** | builder | `{ taskId, tier?, model? }` → `{ estimate: { p50, p90, cap, ... }, tiers?, current, units }` |
| `GET /v1/estimate?tag=&size=&tier=` | ✅ | public | generic estimate (not task-specific) |
| `GET /v1/hires` · `GET /v1/hires/options` | ✅ | builder · session | |
| `POST /v1/agents` | ✅ | admin | `{ companyId, departmentId, publicKey, role }` → `{ transaction }` |
| `POST /v1/agents/:publicKey/status` | ✅ | admin | `{ companyId, status: running\|paused\|fired }` → `{ ok }` or `{ transaction }` (fired) |
| `POST /v1/sellers/allow` | 🟡 | admin | `{ companyId, departmentId, sellerId, payTo\|null }` → `{ transaction }` (needs v3) |

### Members, invites, keys

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/members?companyId=` | ✅ | any scope | → `{ members, canManage }`. Non-admins see only themselves. |
| `POST /v1/members/invite` | ✅ | founder | `{ companyId, email, departments, template: viewer\|approver\|builder\|admin, limit?, expiresInDays? }` → `{ inviteId, transaction }`. Code is emailed after the tx lands. |
| `GET /v1/invites/:code` | ✅ **new** | session | → `{ companyId, slug, companyName, role, departments, expiresAt, status, canAccept }` (never the email) |
| `POST /v1/invites/accept` | ✅ | session | `{ code }` → `{ companyId, transaction }` (`accept_invite`). Poll `GET /v1/companies/:id` until 200 after signing. |
| `DELETE /v1/members/:accountId?companyId=` | ✅ | founder | → `{ transaction }` (`revoke`) |
| `POST /v1/members/:accountId/grants` | ⛔ | — | 501. Grants can't be edited on chain: revoke, then invite again. |
| `POST /v1/keys/view` | ✅ | session | `{ companyId, x25519PublicKey }` (base64) → `{ transaction, next }` |
| `POST /v1/keys/view/confirm` | ✅ **new** | session | `{ companyId, txHash }` → `{ ok, accountId, x25519PublicKey }` (checked against the tx on chain) |
| `GET /v1/keys/devices?companyId=&kind=code\|log` | ✅ **new** | admin | → `{ codeKeyVersion, devices: [{ accountId, x25519PublicKey, founder, scopes, departmentId }] }`: only accounts still allowed on chain |
| `POST /v1/keys/code/rotate` | ✅ | founder | `{ companyId, newVersion? }` → `{ currentVersion, newVersion, transaction, next }` |
| `POST /v1/keys/wrapped` | ✅ | founder (code) / code scope (log) | `{ companyId, kind, departmentId?, version, keys: [{ memberAccount, ciphertext }] }` → `{ stored }`. 409 `version_conflict` until the rotate is on chain (waits up to 8 s). |
| `GET /v1/keys/wrapped?companyId=&kind=&departmentId=&version=` | ✅ | grant check | → `{ version, ciphertext }` |
| `GET /v1/private` | 🗓 | — | 501 planned. Encrypted file storage isn't shipped; only wrapped keys are served. |
| `GET /v1/provenance` · `GET /v1/leaderboard` | 🗓 | — | 501 planned |

**Rotation order:**

1. `POST /v1/keys/code/rotate` and sign the tx.
2. `GET /v1/keys/devices?kind=code`.
3. In the browser, generate a new key and wrap it to each `x25519PublicKey`.
4. `POST /v1/keys/wrapped { kind:"code", version:newVersion, keys }`.

### Live updates

| Method & path | Status | Auth | Notes |
|---|---|---|---|
| `POST /v1/stream/token` | ✅ **new** | session | → `{ token, expiresAt, url }`, valid **only** on `/v1/stream`, ≤ 15 min |
| `GET /v1/stream?companyId=&lastEventId=&token=` | ✅ | session or stream token | SSE. Resume with the `Last-Event-ID` header or `?lastEventId=` (replays up to 500 events). Events are filtered by the caller's grant. |
| `GET /v1/status` | ✅ | public | `{ indexerLag, queueDepth, ... }` |

**SSE frames:**

- `event: ready` → `{ account, companies, resumedAfter, expiresAt }` (once per connection)
- `event: status` → `{ catchingUp, lag }` (indexer behind)
- `event: <name>` with `id: <n>` → `{ id, event, companyId, departmentId, data, nearTx, blockHeight, at }`
- `event: reauth` → `{ reason: "token_expired", expiresAt }`, then the stream closes. Get a new stream token, or sign in again on 401.

**Event names:**

- Everyone: `company_created`, `department_created`, `frozen`, `unfrozen`, `upgrade_proposed`, `upgrade_cancelled`, `upgrade_applied`
- view/approve: money events — `payment_signed`, `receipt`, `purchase_requested`, `purchase_yielded`, `purchase_approved`, `purchase_rejected`, `topup_*`, `withdrawal_*`, `float_set`, `deposit`, **`deposit_received`**, `revenue`, `bounty_*`
- builder: `task_assigned`, `agent_registered`, `bounty_created`, `agent_hired`
- Founder/admin: everything

`deposit_received.data` = `{ company_id, department_id, address, chain_id, token, amount, balance }`. Amount and balance are micro-USDC. It's written by the worker when a team's Base USDC balance goes up (checked every 60 s).

---

## 3. Known limits (honest status)

- **Company-level deposit and withdrawals** need NEAR Intents, which isn't on testnet. On testnet, teams are funded directly at their Base Sepolia USDC addresses.
- **Changing per-purchase / auto-approve limits** after create isn't possible in the contracts. Changing it would need a contract change plus the 24 h upgrade.
- **Companies on contract v2** (created before the next factory redeploy) can't use allow-seller, team budget raise or payment re-configure until upgraded. The upgrade is `propose_upgrade` → wait 24 h → `apply_upgrade` (raw wasm input).
- **Team-limited approvers:** company contract v3 (next factory redeploy) also enforces the approver's team on chain. On v2 companies only the API enforces it.
