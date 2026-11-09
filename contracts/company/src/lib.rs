#![allow(clippy::too_many_arguments)]
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Keys {
    Departments,
    Grants,
    Invites,
    PendingApprovals,
    DepartmentNames,
}

const EVENT_STANDARD: &str = "builderos";
const EVENT_VERSION: &str = "1.0.0";
const TGAS: u64 = 1_000_000_000_000;

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

/// Methods a founder/admin may forward to a department. Departments only accept these from the company
/// account (`assert_company`), so every change still goes through this contract's checks.
const DEPT_FORWARD_METHODS: &[&str] = &[
    "assign_task",
    "set_task_tier",
    "set_task_hire",
    "set_rail_float",
    "allow_seller",
    "set_evm_config",
    "top_up_budget",
    "freeze", // pause one team; resuming goes through the company's founder-only `unfreeze`
];

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0xf) as usize] as char);
    }
    out
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingApproval {
    pub department: AccountId,
    pub amount: u128,
    pub reason: String,
}

/// Team payment settings handed to each new department (its Chain Signatures Base address + USDC).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct EvmConfig {
    pub chain_id: u64,
    pub usdc: String,
    pub from: String,
}

const MS_PER_DAY: u64 = 86_400_000;

/// How long the founder must wait between proposing and applying a code upgrade (members see it).
const UPGRADE_DELAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct PendingUpgrade {
    pub target: String,
    pub code_hash: String,
    pub ready_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct DeptCall {
    pub department: String,
    pub method: String,
    pub args: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct DepartmentEntry {
    pub name: String,
    pub department_id: AccountId,
}

fn parse_u128(s: &str) -> u128 {
    s.parse::<u128>().unwrap_or_else(|_| env::panic_str("invalid amount"))
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Grant {
    pub account_id: AccountId,
    pub department_id: AccountId,
    pub scopes: Vec<String>,
    pub limit: Option<String>,
    pub expires_at_ms: Option<u64>,
    pub revoked: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Invite {
    pub invite_hash: String,
    pub departments: Vec<String>,
    pub scopes: Vec<String>,
    pub limit: Option<String>,
    pub expires_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct CompanyView {
    pub founder: AccountId,
    pub name: String,
    pub frozen: bool,
    pub code_key_version: u32,
    pub daily_cap: String,
    pub spent_today: String,
    pub registry_id: AccountId,
}

/// Embedded department wasm (filled by `./build.sh` before factory/company deploy).
const DEPARTMENT_WASM: &[u8] = include_bytes!("../../wasm/department.wasm");

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    founder: AccountId,
    name: String,
    registry_id: AccountId,
    worker_id: AccountId,
    verifier_id: AccountId,
    mpc_signer: AccountId,
    daily_cap: u128,
    spent_today: u128,
    frozen: bool,
    code_key_version: u32,
    departments: LookupMap<String, AccountId>,
    grants: LookupMap<String, Grant>,
    invites: LookupMap<String, Invite>,
    pending_approvals: LookupMap<String, PendingApproval>,
    spent_day: u64,
    department_names: Vector<String>,
    pending_upgrade: Option<PendingUpgrade>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        founder: AccountId,
        name: String,
        registry_id: AccountId,
        worker_id: AccountId,
        verifier_id: AccountId,
        mpc_signer: AccountId,
        daily_cap: String,
    ) -> Self {
        Self {
            founder: founder.clone(),
            name,
            registry_id,
            worker_id,
            verifier_id,
            mpc_signer,
            daily_cap: parse_u128(&daily_cap),
            spent_today: 0,
            frozen: false,
            code_key_version: 0,
            departments: LookupMap::new(Keys::Departments),
            grants: LookupMap::new(Keys::Grants),
            invites: LookupMap::new(Keys::Invites),
            pending_approvals: LookupMap::new(Keys::PendingApprovals),
            spent_day: 0,
            department_names: Vector::new(Keys::DepartmentNames),
            pending_upgrade: None,
        }
    }

    fn assert_founder(&self) {
        require!(env::predecessor_account_id() == self.founder, "founder only");
    }

    /// Live (not revoked, not expired) grant holding one of `scopes`. "admin" always qualifies.
    fn has_scope(&self, account: &AccountId, scopes: &[&str]) -> bool {
        let now_ms = env::block_timestamp() / 1_000_000;
        self.grants
            .get(&account.to_string())
            .map(|g| {
                !g.revoked
                    && g.expires_at_ms.map(|e| e >= now_ms).unwrap_or(true)
                    && g.scopes.iter().any(|s| s == "admin" || scopes.contains(&s.as_str()))
            })
            .unwrap_or(false)
    }

    /// Founder, or a member the founder granted one of `scopes` to.
    fn assert_founder_or(&self, scopes: &[&str], what: &str) {
        let caller = env::predecessor_account_id();
        require!(caller == self.founder || self.has_scope(&caller, scopes), what);
    }

    pub fn get_departments(&self) -> Vec<DepartmentEntry> {
        self.department_names
            .iter()
            .filter_map(|n| {
                self.departments.get(n).map(|id| DepartmentEntry { name: n.clone(), department_id: id.clone() })
            })
            .collect()
    }

    /// Founder/admin changes to a department (assign tasks, tiers, floats, sellers, budget).
    /// The department only accepts these from this contract, so the grant check here is the gate.
    #[payable]
    pub fn dept_call(&mut self, calls: Vec<DeptCall>) -> Promise {
        self.assert_founder_or(&[], "founder or admin only");
        require!(!calls.is_empty() && calls.len() <= 12, "1..=12 calls");
        let deposit_needed = calls.len() as u128;
        require!(env::attached_deposit().as_yoctonear() >= deposit_needed, "attach 1 yocto per call");
        let mut promise: Option<Promise> = None;
        for c in calls {
            require!(DEPT_FORWARD_METHODS.contains(&c.method.as_str()), "method not allowed");
            let dept = self.departments.get(&c.department).cloned().expect("unknown department");
            let args = near_sdk::serde_json::to_vec(&c.args).expect("bad args");
            let p = Promise::new(dept).function_call(c.method, args, NearToken::from_yoctonear(1), Gas::from_tgas(15));
            promise = Some(match promise {
                None => p,
                Some(prev) => prev.and(p),
            });
        }
        promise.unwrap()
    }

    pub fn get_company(&self) -> CompanyView {
        CompanyView {
            founder: self.founder.clone(),
            name: self.name.clone(),
            frozen: self.frozen,
            code_key_version: self.code_key_version,
            daily_cap: self.daily_cap.to_string(),
            spent_today: self.spent_today.to_string(),
            registry_id: self.registry_id.clone(),
        }
    }

    pub fn get_grant(&self, account_id: AccountId) -> Option<Grant> {
        // Return any non-revoked grant for this account (first match).
        // Keys are "{account}:{department}".
        let prefix = format!("{account_id}:");
        // LookupMap has no prefix scan; callers pass department via grant key convention in revoke.
        // Provide a dedicated key for company-wide if stored as account_id alone.
        self.grants.get(&account_id.to_string()).cloned()
            .or_else(|| self.grants.get(&format!("{prefix}*")).cloned())
    }

    #[payable]
    pub fn set_caps(&mut self, daily_cap: String) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.daily_cap = parse_u128(&daily_cap);
        emit("policy_changed", json!({ "new_hash": format!("daily_cap:{}", daily_cap) }));
    }

    #[payable]
    pub fn create_department(&mut self, name: String, budget: String, per_tx_limit: String, evm: Option<EvmConfig>) -> Promise {
        self.assert_founder();
        require!(!self.frozen, "frozen");
        require!(DEPARTMENT_WASM.len() > 10_000, "department wasm missing — run contracts/build.sh");
        let deposit = env::attached_deposit();
        // department.wasm ≈ 340KB × 10^19 ≈ 3.4 NEAR storage; the rest pays agent gas and state.
        require!(deposit >= NearToken::from_millinear(4_500), "attach >= 4.5 NEAR for team storage + agent gas");
        let dept_id: AccountId = format!("{}.{}", name, env::current_account_id())
            .parse()
            .expect("invalid dept id");
        require!(!self.departments.contains_key(&name), "department exists");
        self.departments.insert(name.clone(), dept_id.clone());
        self.department_names.push(name.clone());

        let init = near_sdk::serde_json::to_vec(&json!({
            "company_id": env::current_account_id(),
            "registry_id": self.registry_id,
            "worker_id": self.worker_id,
            "verifier_id": self.verifier_id,
            "mpc_signer": self.mpc_signer,
            "budget": budget,
            "per_tx_limit": per_tx_limit,
            "base_address": evm.as_ref().map(|e| e.from.clone()),
            "evm_chain_id": evm.as_ref().map(|e| e.chain_id),
            "evm_usdc": evm.as_ref().map(|e| e.usdc.clone()),
        }))
        .unwrap();

        let founder = env::predecessor_account_id();
        Promise::new(dept_id.clone())
            .create_account()
            .transfer(deposit)
            // No full-access key: only this contract (and agent keys it adds) can act for the team.
            .deploy_contract(DEPARTMENT_WASM.to_vec())
            .function_call(
                "new".to_string(),
                init,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(50),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_department_created(name, dept_id, founder, deposit),
            )
    }

    #[private]
    pub fn on_department_created(
        &mut self,
        name: String,
        department_id: AccountId,
        founder: AccountId,
        deposit: NearToken,
        #[callback_result] result: Result<Vec<u8>, PromiseError>,
    ) -> Option<Promise> {
        if result.is_err() {
            // Do not panic — that would roll back the remove (same bug as factory slug).
            self.departments.remove(&name);
            if let Some(i) = self.department_names.iter().position(|n| n == &name) {
                self.department_names.swap_remove(i as u32);
            }
            if deposit.as_yoctonear() > 0 {
                return Some(Promise::new(founder).transfer(deposit));
            }
            return None;
        }
        emit(
            "department_created",
            json!({
                "company_id": env::current_account_id(),
                "department_id": department_id,
                "name": name,
            }),
        );
        None
    }

    /// Called by a department for every agent purchase. Returns "ok" (sign now), "pending" (approval card)
    /// or "rejected:<why>". Daily cap is company-wide; approvals count toward it once approved.
    pub fn check_spend(&mut self, request_id: String, amount: String, reason: Option<String>, seller_id: String, task_id: String, pay_to: Option<String>) -> String {
        let dept = env::predecessor_account_id();
        let name = dept.as_str().split('.').next().unwrap_or("").to_string();
        require!(self.departments.get(&name) == Some(&dept), "not a team of this company");
        if self.frozen {
            return "rejected:frozen".into();
        }
        let amt = parse_u128(&amount);
        self.roll_day();
        let why = match reason {
            Some(r) => Some(r),
            None if self.spent_today + amt > self.daily_cap => Some("daily_cap".to_string()),
            None => None,
        };
        match why {
            None => {
                self.spent_today += amt;
                "ok".into()
            }
            Some(r) => {
                self.pending_approvals.insert(request_id.clone(), PendingApproval { department: dept.clone(), amount: amt, reason: r.clone() });
                emit(
                    "purchase_yielded",
                    json!({
                        "request_id": request_id,
                        "reason": r,
                        "amount": amount,
                        "company_id": env::current_account_id(),
                        "department_id": dept,
                        "seller_id": seller_id,
                        "task_id": task_id,
                        "pay_to": pay_to,
                        "spent_today": self.spent_today.to_string(),
                        "daily_cap": self.daily_cap.to_string(),
                    }),
                );
                "pending".into()
            }
        }
    }

    fn roll_day(&mut self) {
        let day = env::block_timestamp_ms() / MS_PER_DAY;
        if day != self.spent_day {
            self.spent_day = day;
            self.spent_today = 0;
        }
    }

    /// Founder or approver: approve waiting purchases (one card can cover many). Each team is told to let
    /// its agent get the Chain Signatures signature. Approved amounts count toward today's cap.
    #[payable]
    pub fn approve(&mut self, request_ids: Vec<String>, card_id: Option<String>) -> Promise {
        self.assert_founder_or(&["approve"], "no approve scope");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        require!(!request_ids.is_empty() && request_ids.len() <= 20, "1..=20 requests per call");
        require!(!self.frozen, "frozen");
        self.roll_day();
        let approver = env::predecessor_account_id();
        let mut promise: Option<Promise> = None;
        for request_id in &request_ids {
            let p = self.pending_approvals.remove(request_id).expect("request is not waiting for approval");
            self.spent_today += p.amount;
            emit(
                "purchase_approved",
                json!({ "request_id": request_id, "approvers": [approver], "card_id": card_id, "amount": p.amount.to_string(), "department_id": p.department }),
            );
            let call = Promise::new(p.department).function_call(
                "mark_approved",
                near_sdk::serde_json::to_vec(&json!({ "request_id": request_id })).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            );
            promise = Some(match promise {
                None => call,
                Some(prev) => prev.and(call),
            });
        }
        promise.unwrap()
    }

    /// Founder or approver: reject waiting purchases; the team frees the reserved budget.
    #[payable]
    pub fn reject(&mut self, request_ids: Vec<String>, card_id: Option<String>) -> Promise {
        self.assert_founder_or(&["approve"], "no approve scope");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        require!(!request_ids.is_empty() && request_ids.len() <= 20, "1..=20 requests per call");
        let approver = env::predecessor_account_id();
        let mut promise: Option<Promise> = None;
        for request_id in &request_ids {
            let p = self.pending_approvals.remove(request_id).expect("request is not waiting for approval");
            emit("purchase_rejected", json!({ "request_id": request_id, "approvers": [approver], "card_id": card_id, "reason": "rejected_by_approver" }));
            let call = Promise::new(p.department).function_call(
                "mark_rejected",
                near_sdk::serde_json::to_vec(&json!({ "request_id": request_id })).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            );
            promise = Some(match promise {
                None => call,
                Some(prev) => prev.and(call),
            });
        }
        promise.unwrap()
    }

    pub fn get_pending_approval(&self, request_id: String) -> Option<PendingApproval> {
        self.pending_approvals.get(&request_id).cloned()
    }

    #[payable]
    pub fn invite(
        &mut self,
        invite_hash: String,
        departments: Vec<String>,
        scopes: Vec<String>,
        limit: Option<String>,
        expires_at_ms: u64,
    ) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.invites.insert(
            invite_hash.clone(),
            Invite {
                invite_hash: invite_hash.clone(),
                departments: departments.clone(),
                scopes: scopes.clone(),
                limit,
                expires_at_ms,
            },
        );
        emit(
            "member_invited",
            json!({
                "company_id": env::current_account_id(),
                "invite_hash": invite_hash,
                "departments": departments,
                "scopes": scopes,
            }),
        );
    }

    pub fn accept_invite(&mut self, code: String) {
        // The invite is stored under sha256(code) (the founder never puts the code on chain).
        let invite_hash = hex(&env::sha256(code.as_bytes()));
        let invite = self.invites.get(&invite_hash).cloned().expect("invalid invite");
        require!(env::block_timestamp() / 1_000_000 <= invite.expires_at_ms, "invite expired");
        let account = env::predecessor_account_id();
        let dept = invite
            .departments
            .first()
            .and_then(|n| self.departments.get(n).cloned())
            .unwrap_or_else(|| env::current_account_id());
        let grant = Grant {
            account_id: account.clone(),
            department_id: dept.clone(),
            scopes: invite.scopes.clone(),
            limit: invite.limit.clone(),
            expires_at_ms: Some(invite.expires_at_ms),
            revoked: false,
        };
        require!(account != self.founder, "founder already owns the company");
        self.grants.insert(account.to_string(), grant);
        self.invites.remove(&invite_hash); // single use
        emit(
            "grant_set",
            json!({
                "account_id": account,
                "department_id": dept,
                "scopes": invite.scopes,
                "limit": invite.limit,
                "expires_at": invite.expires_at_ms,
            }),
        );
    }

    #[payable]
    pub fn revoke(&mut self, account_id: AccountId) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        if let Some(mut g) = self.grants.get(&account_id.to_string()).cloned() {
            g.revoked = true;
            self.grants.insert(account_id.to_string(), g);
        }
        emit(
            "grant_revoked",
            json!({ "account_id": account_id, "company_id": env::current_account_id() }),
        );
    }

    pub fn register_view_key(&mut self, x25519_public_key: String) {
        emit(
            "view_key_registered",
            json!({ "account_id": env::predecessor_account_id(), "x25519_public_key": x25519_public_key }),
        );
    }

    #[payable]
    pub fn rotate_code_key(&mut self, version: u32) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.code_key_version = version;
        emit(
            "code_key_rotated",
            json!({ "company_id": env::current_account_id(), "version": version }),
        );
    }

    #[payable]
    pub fn request_withdrawal(
        &mut self,
        withdrawal_id: String,
        amount: String,
        token: String,
        to: String,
        chain: String,
    ) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        emit(
            "withdrawal_requested",
            json!({
                "company_id": env::current_account_id(),
                "withdrawal_id": withdrawal_id,
                "amount": amount,
                "token": token,
                "to": to,
                "chain": chain,
            }),
        );
    }

    pub fn record_withdrawal(&mut self, payload: Value) {
        require!(env::predecessor_account_id() == self.worker_id, "worker only");
        let mut data = payload;
        if let Some(obj) = data.as_object_mut() {
            obj.entry("company_id".to_string())
                .or_insert_with(|| json!(env::current_account_id()));
        }
        emit("withdrawal_recorded", data);
    }

    #[payable]
    pub fn freeze(&mut self) -> Option<Promise> {
        // "Pause all": founder or admin. Departments are frozen too, so agents stop spending at once.
        self.assert_founder_or(&[], "founder or admin only");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = true;
        emit("frozen", json!({ "company_id": env::current_account_id() }));
        self.cascade("freeze")
    }

    fn cascade(&self, method: &str) -> Option<Promise> {
        let mut promise: Option<Promise> = None;
        for name in self.department_names.iter() {
            if let Some(dept) = self.departments.get(name) {
                let p = Promise::new(dept.clone()).function_call(
                    method.to_string(),
                    b"{}".to_vec(),
                    NearToken::from_yoctonear(1),
                    Gas::from_tgas(10),
                );
                promise = Some(match promise {
                    None => p,
                    Some(prev) => prev.and(p),
                });
            }
        }
        promise
    }

    #[payable]
    pub fn unfreeze(&mut self) -> Option<Promise> {
        // Resuming spend stays founder-only.
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = false;
        emit("unfrozen", json!({ "company_id": env::current_account_id() }));
        self.cascade("unfreeze")
    }

    /// Founder/admin: give an agent a key on a team account, limited to the agent methods
    /// (request_purchase, record_response, create_bounty). The team adds the key itself.
    pub fn register_agent(&mut self, department_name: String, public_key: PublicKey, role: String) -> Promise {
        self.assert_founder_or(&[], "founder or admin only");
        let dept = self.departments.get(&department_name).cloned().expect("unknown department");
        let args = near_sdk::serde_json::to_vec(&json!({ "public_key": public_key, "role": role })).unwrap();
        Promise::new(dept).function_call("add_agent_key", args, NearToken::from_yoctonear(0), Gas::from_tgas(15))
    }

    /// Founder/admin: "Fire" an agent — the team deletes its key.
    pub fn fire_agent(&mut self, department_name: String, public_key: PublicKey) -> Promise {
        self.assert_founder_or(&[], "founder or admin only");
        let dept = self.departments.get(&department_name).cloned().expect("unknown department");
        let args = near_sdk::serde_json::to_vec(&json!({ "public_key": public_key })).unwrap();
        Promise::new(dept).function_call("remove_agent_key", args, NearToken::from_yoctonear(0), Gas::from_tgas(15))
    }

    // ---------------- upgrades (replace the old founder full-access key) ----------------
    //
    // Nobody holds a full-access key on the company or team accounts, so code can only change through
    // here: the founder proposes a code hash, everyone sees `upgrade_proposed`, and only after
    // UPGRADE_DELAY_MS can the founder apply exactly that code.

    pub fn propose_upgrade(&mut self, target: String, code_hash: String) {
        self.assert_founder();
        require!(target == "company" || self.departments.contains_key(&target), "target: \"company\" or a team name");
        require!(code_hash.len() == 64 && code_hash.chars().all(|c| c.is_ascii_hexdigit()), "code_hash: sha256 hex");
        let ready_at_ms = env::block_timestamp_ms() + UPGRADE_DELAY_MS;
        self.pending_upgrade = Some(PendingUpgrade { target: target.clone(), code_hash: code_hash.to_lowercase(), ready_at_ms });
        emit("upgrade_proposed", json!({ "company_id": env::current_account_id(), "target": target, "code_hash": code_hash, "ready_at_ms": ready_at_ms }));
    }

    pub fn cancel_upgrade(&mut self) {
        self.assert_founder();
        if let Some(u) = self.pending_upgrade.take() {
            emit("upgrade_cancelled", json!({ "company_id": env::current_account_id(), "target": u.target }));
        }
    }

    pub fn get_pending_upgrade(&self) -> Option<PendingUpgrade> {
        self.pending_upgrade.clone()
    }

    /// Founder: apply the proposed upgrade. The raw wasm is the call input (no JSON args).
    pub fn apply_upgrade(&mut self) -> Promise {
        self.assert_founder();
        let u = self.pending_upgrade.clone().expect("no upgrade proposed");
        require!(env::block_timestamp_ms() >= u.ready_at_ms, "upgrade delay not over");
        let code = env::input().expect("code");
        require!(hex(&env::sha256(&code)) == u.code_hash, "code does not match the proposed hash");
        self.pending_upgrade = None;
        if u.target == "company" {
            emit("upgrade_applied", json!({ "target": env::current_account_id(), "code_hash": u.code_hash }));
            Promise::new(env::current_account_id()).deploy_contract(code)
        } else {
            let dept = self.departments.get(&u.target).cloned().expect("unknown department");
            Promise::new(dept).function_call("upgrade", code, NearToken::from_yoctonear(0), Gas::from_tgas(100))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: u128, now_ms: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("acme.builderos-wang.testnet"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(10))
            .block_timestamp(now_ms * 1_000_000)
            .build());
    }

    fn company() -> Contract {
        ctx("founder.testnet", 0, 1_000);
        Contract::new(
            acc("founder.testnet"),
            "Acme".into(),
            acc("registry.builderos-wang.testnet"),
            acc("worker.builderos-wang.testnet"),
            acc("verifier.builderos-wang.testnet"),
            acc("v1.signer-prod.testnet"),
            "50000000".into(),
        )
    }

    /// Founder creates an invite (stored under sha256(code)) and `who` accepts it with the raw code.
    fn grant(c: &mut Contract, who: &str, code: &str, scopes: &[&str], expires_at_ms: u64) {
        ctx("founder.testnet", 1, 1_000);
        c.invite(hex(&env::sha256(code.as_bytes())), vec!["build".into()], scopes.iter().map(|s| s.to_string()).collect(), None, expires_at_ms);
        ctx(who, 0, 1_000);
        c.accept_invite(code.into());
    }

    fn with_build_dept(c: &mut Contract) {
        ctx("founder.testnet", 4_500_000_000_000_000_000_000_000, 1_000);
        let _ = c.create_department("build".into(), "100".into(), "10".into(), None);
    }

    #[test]
    fn invite_accepts_raw_code_once() {
        let mut c = company();
        grant(&mut c, "alice.testnet", "secret-code-123", &["view"], 10_000);
        assert!(c.get_grant(acc("alice.testnet")).is_some());
        ctx("bob.testnet", 0, 1_000);
        let reused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.accept_invite("secret-code-123".into())));
        assert!(reused.is_err(), "invite must be single use");
    }

    #[test]
    #[should_panic(expected = "invalid invite")]
    fn wrong_code_is_rejected() {
        let mut c = company();
        ctx("founder.testnet", 1, 1_000);
        c.invite(hex(&env::sha256(b"right")), vec![], vec!["view".into()], None, 10_000);
        ctx("eve.testnet", 0, 1_000);
        c.accept_invite("wrong".into());
    }

    #[test]
    fn approver_can_approve_and_reject() {
        let mut c = company();
        with_build_dept(&mut c);
        ctx_dept(1_500);
        c.check_spend("r1".into(), "1".into(), Some("over_limit".into()), "s".into(), "t".into(), None);
        c.check_spend("r2".into(), "1".into(), Some("new_seller".into()), "s".into(), "t".into(), None);
        grant(&mut c, "ann.testnet", "code-approver", &["view", "approve"], 10_000);
        ctx("ann.testnet", 1, 2_000);
        let _ = c.approve(vec!["r1".into()], None);
        let _ = c.reject(vec!["r2".into()], None);
        assert!(c.get_pending_approval("r2".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "no approve scope")]
    fn viewer_cannot_approve() {
        let mut c = company();
        grant(&mut c, "vic.testnet", "code-viewer", &["view"], 10_000);
        ctx("vic.testnet", 1, 2_000);
        c.approve(vec!["r1".into()], None);
    }

    #[test]
    #[should_panic(expected = "no approve scope")]
    fn expired_grant_cannot_approve() {
        let mut c = company();
        grant(&mut c, "ann.testnet", "code-exp", &["approve"], 5_000);
        ctx("ann.testnet", 1, 6_000);
        c.approve(vec!["r1".into()], None);
    }

    #[test]
    fn founder_dept_call_and_department_list() {
        let mut c = company();
        with_build_dept(&mut c);
        assert_eq!(c.get_departments().len(), 1);
        ctx("founder.testnet", 2, 1_000);
        let _ = c.dept_call(vec![
            DeptCall { department: "build".into(), method: "assign_task".into(), args: json!({"task_id":"t1"}) },
            DeptCall { department: "build".into(), method: "set_task_tier".into(), args: json!({"task_id":"t1"}) },
        ]);
    }

    #[test]
    fn admin_can_dept_call_and_pause() {
        let mut c = company();
        with_build_dept(&mut c);
        grant(&mut c, "adm.testnet", "code-admin", &["admin"], 10_000);
        ctx("adm.testnet", 1, 2_000);
        let _ = c.dept_call(vec![DeptCall { department: "build".into(), method: "set_rail_float".into(), args: json!({}) }]);
        ctx("adm.testnet", 1, 2_000);
        assert!(c.freeze().is_some(), "freeze must cascade to departments");
        assert!(c.get_company().frozen);
    }

    #[test]
    #[should_panic(expected = "founder or admin only")]
    fn builder_cannot_dept_call() {
        let mut c = company();
        with_build_dept(&mut c);
        grant(&mut c, "bld.testnet", "code-builder", &["view", "builder", "code"], 10_000);
        ctx("bld.testnet", 1, 2_000);
        let _ = c.dept_call(vec![DeptCall { department: "build".into(), method: "assign_task".into(), args: json!({}) }]);
    }

    #[test]
    #[should_panic(expected = "method not allowed")]
    fn dept_call_rejects_unlisted_methods() {
        let mut c = company();
        with_build_dept(&mut c);
        ctx("founder.testnet", 1, 1_000);
        let _ = c.dept_call(vec![DeptCall { department: "build".into(), method: "request_purchase".into(), args: json!({}) }]);
    }

    #[test]
    #[should_panic(expected = "founder only")]
    fn admin_cannot_unfreeze() {
        let mut c = company();
        grant(&mut c, "adm.testnet", "code-admin2", &["admin"], 10_000);
        ctx("adm.testnet", 1, 2_000);
        let _ = c.unfreeze();
    }

    #[test]
    #[should_panic(expected = "founder only")]
    fn viewer_cannot_invite() {
        let mut c = company();
        grant(&mut c, "vic.testnet", "code-v2", &["view"], 10_000);
        ctx("vic.testnet", 1, 2_000);
        c.invite("h".into(), vec![], vec!["admin".into()], None, 10_000);
    }

    fn ctx_input(predecessor: &str, now_ms: u64, input: Vec<u8>) {
        let mut context = VMContextBuilder::new()
            .current_account_id(acc("acme.builderos-wang.testnet"))
            .predecessor_account_id(acc(predecessor))
            .account_balance(NearToken::from_near(10))
            .block_timestamp(now_ms * 1_000_000)
            .build();
        context.input = input.into();
        testing_env!(context);
    }

    fn pk() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
    }

    #[test]
    fn founder_and_admin_register_agents_builder_cannot() {
        let mut c = company();
        with_build_dept(&mut c);
        ctx("founder.testnet", 0, 1_000);
        let _ = c.register_agent("build".into(), pk(), "backend".into());
        grant(&mut c, "adm.testnet", "code-a3", &["admin"], 10_000);
        ctx("adm.testnet", 0, 2_000);
        let _ = c.fire_agent("build".into(), pk());
        grant(&mut c, "bld.testnet", "code-b3", &["builder"], 10_000);
        ctx("bld.testnet", 0, 2_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.register_agent("build".into(), pk(), "x".into())));
        assert!(r.is_err());
    }

    #[test]
    fn upgrade_waits_for_delay_and_exact_code() {
        let mut c = company();
        let code = b"\0asm new code".to_vec();
        let h = hex(&env::sha256(&code));
        ctx("founder.testnet", 0, 1_000);
        c.propose_upgrade("company".into(), h.clone());
        assert_eq!(c.get_pending_upgrade().unwrap().code_hash, h);

        ctx_input("founder.testnet", 2_000, code.clone());
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.apply_upgrade()));
        assert!(early.is_err(), "must wait out the delay");

        let later = 1_000 + UPGRADE_DELAY_MS + 1;
        ctx_input("founder.testnet", later, b"other code".to_vec());
        let wrong = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.apply_upgrade()));
        assert!(wrong.is_err(), "only the proposed code");

        ctx_input("founder.testnet", later, code);
        let _ = c.apply_upgrade();
        assert!(c.get_pending_upgrade().is_none());
    }

    #[test]
    #[should_panic(expected = "founder only")]
    fn admin_cannot_propose_upgrades() {
        let mut c = company();
        grant(&mut c, "adm.testnet", "code-a4", &["admin"], 10_000);
        ctx("adm.testnet", 0, 2_000);
        c.propose_upgrade("company".into(), "a".repeat(64));
    }

    fn ctx_dept(now_ms: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("acme.builderos-wang.testnet"))
            .predecessor_account_id(acc("build.acme.builderos-wang.testnet"))
            .account_balance(NearToken::from_near(10))
            .block_timestamp(now_ms * 1_000_000)
            .build());
    }

    #[test]
    fn daily_cap_sends_purchases_to_an_approval_card() {
        let mut c = company(); // daily cap $50
        with_build_dept(&mut c);
        ctx_dept(1_000);
        assert_eq!(c.check_spend("r1".into(), "40000000".into(), None, "s".into(), "t".into(), None), "ok");
        assert_eq!(c.check_spend("r2".into(), "20000000".into(), None, "s".into(), "t".into(), None), "pending");
        assert_eq!(c.get_pending_approval("r2".into()).unwrap().reason, "daily_cap");
        // next day the counter resets
        ctx_dept(1_000 + MS_PER_DAY);
        assert_eq!(c.check_spend("r3".into(), "20000000".into(), None, "s".into(), "t".into(), None), "ok");
    }

    #[test]
    fn team_reasons_always_need_approval_and_approving_counts_toward_the_cap() {
        let mut c = company();
        with_build_dept(&mut c);
        ctx_dept(1_000);
        assert_eq!(c.check_spend("r1".into(), "1".into(), Some("new_seller".into()), "s".into(), "t".into(), None), "pending");
        grant(&mut c, "ann.testnet", "code-ap9", &["approve"], 10_000);
        ctx("ann.testnet", 1, 2_000);
        let _ = c.approve(vec!["r1".into()], None);
        assert!(c.get_pending_approval("r1".into()).is_none());
        assert_eq!(c.get_company().spent_today, "1");
    }

    #[test]
    fn frozen_company_rejects_spend() {
        let mut c = company();
        with_build_dept(&mut c);
        ctx("founder.testnet", 1, 1_000);
        let _ = c.freeze();
        ctx_dept(1_000);
        assert_eq!(c.check_spend("r1".into(), "1".into(), None, "s".into(), "t".into(), None), "rejected:frozen");
    }

    #[test]
    #[should_panic(expected = "not a team of this company")]
    fn only_own_teams_can_check_spend() {
        let mut c = company();
        ctx("stranger.testnet", 0, 1_000);
        c.check_spend("r1".into(), "1".into(), None, "s".into(), "t".into(), None);
    }

    #[test]
    #[should_panic(expected = "request is not waiting for approval")]
    fn cannot_approve_unknown_requests() {
        let mut c = company();
        ctx("founder.testnet", 1, 1_000);
        let _ = c.approve(vec!["nope".into()], None);
    }
}
