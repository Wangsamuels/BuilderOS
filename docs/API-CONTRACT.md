# BuilderOS API contract

**Contract version:** `2026-11-13` (also returned by `GET /health` → `contract`)
**Base URL (testnet):** `https://builderos-api-d6d40e9cc381.herokuapp.com`
**Verified against:**
- `2026-11-11` routes: deployed commit `ad62781`, 74/74 authenticated checks on NEAR testnet (`tests/e2e/live.mts`).
- `2026-11-13` additions (account home, drafts, analytics, reports, inbox, demo): 169/169 checks in `tests/e2e/flow.mts`. That run uses the real API, indexer and worker event router, with a NEAR testnet simulator in place of testnet.

**What changed in 2026-11-13:**
- Sign-in no longer leads to a company form. The home works with zero companies; companies are created when the founder launches a draft.
- New: account and email, drafts, launch from a draft, overview, analytics, reports grouped by team, inbox, preferences, public demo.
- `POST /v1/companies` needs a verified email for a new company, takes `planId`, and no longer adds a redundant `set_caps` tx to a brand-new company.
- `GET /v1/auth/challenge` no longer needs `accountId`, so it can be prefetched. `POST /v1/auth/verify` takes `loginMethod` and `privyIdentityToken`.
- `POST /v1/plans` without `companyId` makes a draft.
- `POST /v1/me/email` now starts verification instead of saving the address.

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
| 400 | `wrong_code` | Email code doesn't match (`message` says how many tries are left) |
| 401 | `bad_privy_token` | Privy identity token invalid, expired, or for another app |
| 401 | `unauthenticated` | No/expired session, or a stream token used outside `/v1/stream` |
| 402 | `insufficient_funds` | Create bundle the wallet can't pay (`details: { requiredYocto, availableYocto, funding }`) |
| 403 | `forbidden` | Not a member, or the grant doesn't cover this (`details.required` = scopes) |
| 403 | `email_required` | Creating a company before verifying an email (`details.next` = the routes to call) |
| 404 | `not_found` / `tx_not_found` | Missing resource / tx not visible yet |
| 409 | `plan_not_launched`, `draft_already_launched`, `privy_no_email`, `privy_wallet_mismatch` | Approving a draft that isn't in a company yet; a draft already in a company; a Privy login with no email, or a Privy token for another wallet |
| 409 | `slug_taken`, `create_in_progress`, `plan_already_approved`, `version_conflict`, `contract_upgrade_required`, `budget_decrease_unsupported`, `insufficient_funds` (withdrawal), `no_teams`, `tx_mismatch`, `conflict` | State conflicts |
| 410 | `code_expired`, `invite_expired` | Email code or inbox invite no longer valid |
| 429 | `rate_limited` | > 60 writes/min per account |
| 429 | `too_many_attempts` | 5 wrong email codes: ask for a new one |
| 501 | `not_implemented` | Feature not available: `details: { feature, status: "unsupported" \| "planned", replacement? }` |
| 503 | `mpc_unavailable`, `sponsor_unavailable`, `email_unavailable`, `privy_unavailable`, `unavailable` | Upstream down or not configured |

---

## 2. Endpoint matrix

Status: **✅ implemented** · **🟡 partial** (works, limits noted) · **⛔ unsupported** (stable 501) · **🗓 planned** (stable 501). Auth: `founder` · `admin` (founder or admin grant) · scope names = any one of them, limited to the grant's team · `session` = any signed-in account · `public`.

### Auth and session

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/auth/challenge?accountId=` | ✅ | public | `accountId` **optional**. Without it the challenge isn't tied to an account, so the app can fetch it on page load and the sign-in button works on the first click. → `{ message, recipient, nonce, expiresAt, accountBound }` (NEP-413, no RPC) |
| `POST /v1/auth/verify` | ✅ | public | `{ accountId, publicKey, signature, message, nonce, loginMethod?: "privy"\|"wallet", privyIdentityToken? }` → `{ accountId, token, expiresAt, loginMethod, email, emailError? }`. A challenge works once, even under parallel requests. With a Privy identity token, the email is verified in the same step; a failure only sets `emailError` and never blocks sign-in. |
| `POST /v1/auth/logout` | ✅ | session | → `{ ok }`; the token stops working at once |
| `GET /v1/auth/me` · `/session` · `/setup` | ✅ | session | → `{ accountId, loginMethod, email, needsEmailForCompany, companies: [{ companyId, slug, name, isFounder, admin, scopes, departmentId }], companyIds, drafts: [{ id, title, createdAt }], home: { view: "welcome"\|"overview", openCompanyId, demo }, balance, funding, pendingRefund, setup: { steps, next, completed, total, showBanner } }`. Every company is re-checked on chain. Setup steps in order: `account`, `email`, `describe`, `fund`, `launch`, `approve`. Setup is progress, **never a gate**. |
| Session refresh | 🟡 | — | No refresh endpoint. Sessions last 24 h; a cookie session older than 12 h is rotated automatically. On a 401, sign in again. |
| `POST /v1/auth/fund-testnet` | ✅ | session | testnet only; sends the create shortfall once per account |

### Account and email (no company needed)

Founders need a **verified email before creating a company**. Privy sign-ins get it from Privy at sign-in. NEAR wallet sign-ups add it with a 6-digit code.

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/account` | ✅ **new** | session | → `{ accountId, loginMethod, email: { address (masked), verified, source: "code"\|"privy"\|null, pending (masked) }, needsEmailForCompany, preferences }` |
| `POST /v1/account/email` | ✅ **new** | session | `{ email }` → `{ ok, sentTo (masked), expiresAt }`. The code expires in 10 min; limit 5 per hour. Outside production with `EMAIL_DEV_ECHO=1`, the response also has `devCode`. A verified address stays in use until the new one is confirmed. `POST /v1/me/email` is the same route under its old name. |
| `POST /v1/account/email/verify` | ✅ **new** | session | `{ code }` → `{ ok, email }`. Errors: 400 `wrong_code`, 410 `code_expired`, 429 `too_many_attempts` (after 5 wrong codes), 404 (no code pending). |
| `POST /v1/account/email/privy` | ✅ **new** | session | `{ identityToken }` → `{ ok, email }`. The token must be a valid Privy ES256 token for `PRIVY_APP_ID`, and one of its linked wallets must be the signed-in account or key (else 409 `privy_wallet_mismatch`). **NEAR wallet sessions** may send a token that doesn't list their wallet: Privy is then only the email verifier (it sends and checks the one-time code), and the token must have been issued in the last 5 minutes (else 401 `bad_privy_token`). |
| `GET /v1/account/preferences` · `PATCH` | ✅ **new** | session | `{ lastCompanyId?: string\|null, dismissed?: string[] }` → `{ preferences }`. `lastCompanyId` must be a company you can open (checked on chain; 403 otherwise). It only decides what the home opens, never access. |

### Home: overview, inbox, demo

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/overview?fresh=1` | ✅ **new** | session | → `{ home, email, totals: { companies, founded, spentToday, budget, spent, pendingApprovals, tasksRunning, tasksDone, needsAttention }, companies: [{ companyId, slug, name, role: founder\|admin\|member, scopes, departmentId, frozen, teams, money\|null, work\|null, approvals\|null }], drafts, inbox: { unread } }`. Sections follow the grant: `money` for view/approve, `work` for builder/code, `approvals` for approve; founder and admin get all three. A team-limited grant sees only its team. Chain numbers are cached about 8 s across companies; `?fresh=1` re-reads them (use it right after signing). Works with zero companies (`home.view = "welcome"`). |
| `GET /v1/inbox?limit=` | ✅ **new** | session | → `{ items: [{ id, kind: approval\|report\|invite\|alert, companyId, slug, title, body, at, read, urgent, action }], unread }`, across all your companies and filtered by grant. A team approver sees only their team's cards. Invites sent to your **verified** email appear here. |
| `POST /v1/inbox/read` | ✅ **new** | session | `{ ids?: string[], all?: boolean }` → `{ ok, marked }` |
| `POST /v1/inbox/invites/:id/accept` | ✅ **new** | session | Only for an invite sent to your verified email (404 otherwise) → `{ companyId, transaction }` (`accept_invite`; no code needed). 410 `invite_expired`. |
| `GET /v1/demo?range=7d\|14d\|30d\|90d` | ✅ **new** | **public** | The read-only sample company "Lumen Notes", in one payload: `{ demo: true, readOnly: true, notice, company, access, overview, teams, analytics, reports, approvals, plan, tasks, members }`. Shapes match the real endpoints, so the same screens render it. The data is invented and fixed for everyone (dates follow the clock), and nothing is read from chain or the database. There are no write routes. `DEMO_ENABLED=0` turns it off. |
| `GET /v1/demo/analytics?range=` · `GET /v1/demo/reports/:id` | ✅ **new** | public | Pieces of the same demo. |

### Drafts (describe before any company exists)

A draft is a product idea with a plan, an estimate and a suggested company setup. It belongs to its author and to no company, nothing is on chain, and nothing costs money. Only the author can read it; to anyone else every draft route answers 404. Launching moves it into a company, and its text is re-sealed to that company.

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `POST /v1/drafts` | ✅ **new** | session | `{ what, who?, howTheyPay?, private?, tier?, title? }` or `{ description, ... }` → `{ draft }`. `draft` = `{ id, title, status: draft\|launching\|launched, companyId: null, launchCompanyId, tier, features: [{ key, title, tag, size, dependsOn, team, estimate }], estimate: { p50, p90, cap }, suggestedSetup: { name, slug, dailyCap, teams: [{ team, monthlyCap, perTxLimit, features, estimatedCap }], funding }, description }`. Limit 20 per hour. |
| `GET /v1/drafts` | ✅ **new** | session | → `{ drafts }`: your drafts not yet in a company, newest first |
| `GET /v1/drafts/:id` · `PATCH` · `DELETE` | ✅ **new** | author | PATCH `{ title?, description? (re-plans), features?, removeKeys?, tier? }` → re-estimated `{ draft }`. A launched draft → 409 `draft_already_launched` with `details.companyId`. |
| `POST /v1/drafts/:id/launch` | ✅ **new** | author + admin of the company | `{ companyId }` → `{ plan, next }`: put a draft into a company you founded or administer |
| `POST /v1/plans` without `companyId` | ✅ | session | Same as `POST /v1/drafts` (older clients) |
| `GET /v1/plans?companyId=` | ✅ **new** | builder | → `{ plans: [{ id, title, tier, estimate, features, approvedAt, tasks: {status:n} }] }` |
| `GET /v1/plans/:id` | ✅ | author (draft) / builder | A draft returns `plan` as a draft view (with description), `tasks: []` |

**Launch flow:**
1. Call `POST /v1/companies { name, slug, planId }`. The teams, budgets and daily cap default to the draft's `suggestedSetup`; any you send win.
2. Sign the returned transactions.
3. Poll `GET /v1/companies/creation/:slug` until `companyExists`. Its `plansBound` lists the draft, which is now in the company.
4. Call `POST /v1/plans/:id/approve`. It also binds the draft if the poll hasn't yet.

If the chain create fails (for example someone took the slug first), the draft stays yours as `launching` and can be launched again under another slug.

### Companies, teams, settings

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `POST /v1/companies` | ✅ | session + verified email | `{ name, slug, planId?, preset?, dailyCap?, teams?: [{ team, monthlyCap }], departments?: [...], autoApproveLimit? }` → `{ companyId, transactions, resumed, complete, missing, verify, funding, requiredYocto, teams, dailyCap, planId? }`. Same slug = resume (no email check). A new company is `create_company` + one `create_department` per team; `create_company` sets the daily cap, so there's no extra `set_caps`. Errors: 402, 403 `email_required`, 404 (`planId` not yours), 409 `slug_taken` / `create_in_progress` / `draft_already_launched`. |
| `GET /v1/companies/creation/:slug` | ✅ | session | → `{ slugTaken, founderIsYou, companyExists, departments, dailyCap, pendingRefundYocto, plansBound }` (`plansBound` = drafts that just joined this company) |
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

### Analytics and agent reports

| Method & path | Status | Auth | Request → Response |
|---|---|---|---|
| `GET /v1/analytics?companyId=&range=7d\|14d\|30d\|90d&team=` | ✅ **new** | any scope | → `{ range, teams, sections: { money, work, control }, money, work, control }`. Each section is `null` when the grant doesn't cover it. A team-limited grant gets its own team only; asking for another → 403. Read fresh from chain.<br>• **money** (view/approve): `total`, `byDay[{ day, total, byTeam }]`, `byTeam[{ spentInRange, budget, spent, reserved, available, burnPerDay, runwayDays }]`, `byModel`, `bySeller`, `dailyCap{ cap, spentToday, usedPct }`. Spend = signed payments.<br>• **work** (builder/code): `tasks`, `tasksByTeam`, `completedByDay`, `reviewPassRate`, `reviewed`, plus with money scope `costPerDoneTask` and `estimateVsActual`.<br>• **control** (approve): `approvals{ pending, oldestPendingAt, decidedInRange }`, `blockedPurchases` (payee mismatch), `pausedTeams`, `companyFrozen`. |
| `GET /v1/reports?companyId=&team=&days=7&limit=20&outcome=` | ✅ **new** | any scope | **Grouped by team** (every team on chain, even with no reports): `{ groupBy: "team", teams: [{ team, departmentId, summary: { done, needsReview, retrying, paused, failed, reports, cost, headline }, reports: [report] }] }`. |
| `GET /v1/reports/:id` | ✅ **new** | any scope (own team) | → `{ report, attempts: [{ id, attempt, outcome, at }] }` |

**A report** = `{ id, taskId, attempt, team, title, tag, outcome: done|needs_review|retrying|paused|failed, agent, summary, summarySource: "agent", cost, facts }`.
- `summary` is the agent's own summary of its work.
- Every number comes from records, never from the agent: model calls, checks, the cross-lab review, the commit and receipts.
- `facts` holds `files`, `checks`, `review`, `commitSha` and `generator` for builder/code scopes, and `models`, `receipts`, `estimate` and `taskCostSoFar` for view/approve. `cost` is `null` without a money scope.
- The task runner writes one report per attempt. A new report reaches the live stream as `task_reported` (builder scope).

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
- builder: `task_assigned`, **`task_reported`** (off-chain, from the task runner: `{ report_id, task_id, title, outcome, attempt, cost }`), `agent_registered`, `bounty_created`, `agent_hired`
- Founder/admin: everything

`deposit_received.data` = `{ company_id, department_id, address, chain_id, token, amount, balance }`. Amount and balance are micro-USDC. It's written by the worker when a team's Base USDC balance goes up (checked every 60 s).

---

## 3. Known limits (honest status)

- **Invitees need a little NEAR for gas.** On testnet a brand-new wallet has 0 NEAR and can't sign `accept_invite` until it holds some, e.g. 0.1 NEAR; `POST /v1/auth/fund-testnet` covers founders only.
- **Reports from real model runs** are written by the task runner, which pays models through Base USDC. They appear once a team is funded and has agents.

- **Company-level deposit and withdrawals** need NEAR Intents, which isn't on testnet. On testnet, teams are funded directly at their Base Sepolia USDC addresses.
- **Changing per-purchase / auto-approve limits** after create isn't possible in the contracts. Changing it would need a contract change plus the 24 h upgrade.
- **Companies on contract v2** (created before the next factory redeploy) can't use allow-seller, team budget raise or payment re-configure until upgraded. The upgrade is `propose_upgrade` → wait 24 h → `apply_upgrade` (raw wasm input).
- **Team-limited approvers:** company contract v3 (next factory redeploy) also enforces the approver's team on chain. On v2 companies only the API enforces it.
