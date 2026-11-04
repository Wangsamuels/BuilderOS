#![allow(clippy::too_many_arguments)]
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
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
    pending_approvals: LookupMap<String, String>, // request_id -> department
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
        }
    }

    fn assert_founder(&self) {
        require!(env::predecessor_account_id() == self.founder, "founder only");
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
    pub fn create_department(&mut self, name: String, budget: String, per_tx_limit: String) -> Promise {
        self.assert_founder();
        require!(!self.frozen, "frozen");
        require!(DEPARTMENT_WASM.len() > 10_000, "department wasm missing — run contracts/build.sh");
        let deposit = env::attached_deposit();
        require!(deposit >= NearToken::from_near(1), "attach >= 1 NEAR for dept storage");
        let dept_id: AccountId = format!("{}.{}", name, env::current_account_id())
            .parse()
            .expect("invalid dept id");
        require!(!self.departments.contains_key(&name), "department exists");
        self.departments.insert(name.clone(), dept_id.clone());

        let init = near_sdk::serde_json::to_vec(&json!({
            "company_id": env::current_account_id(),
            "registry_id": self.registry_id,
            "worker_id": self.worker_id,
            "verifier_id": self.verifier_id,
            "mpc_signer": self.mpc_signer,
            "budget": budget,
            "per_tx_limit": per_tx_limit,
            "base_address": Value::Null,
        }))
        .unwrap();

        Promise::new(dept_id.clone())
            .create_account()
            .transfer(deposit)
            .add_full_access_key(env::signer_account_pk())
            .deploy_contract(DEPARTMENT_WASM.to_vec())
            .function_call(
                "new".to_string(),
                init,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(50),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_department_created(name, dept_id),
            )
    }

    #[private]
    pub fn on_department_created(
        &mut self,
        name: String,
        department_id: AccountId,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.departments.remove(&name);
            env::panic_str("department create failed");
        }
        emit(
            "department_created",
            json!({
                "company_id": env::current_account_id(),
                "department_id": department_id,
                "name": name,
            }),
        );
    }

    #[payable]
    pub fn approve(&mut self, request_ids: Vec<String>, card_id: Option<String>) {
        require!(
            env::predecessor_account_id() == self.founder
                || self
                    .grants
                    .get(&env::predecessor_account_id().to_string())
                    .map(|g| !g.revoked && g.scopes.iter().any(|s| s == "approve" || s == "admin"))
                    .unwrap_or(false),
            "no approve scope"
        );
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        for request_id in &request_ids {
            emit(
                "purchase_approved",
                json!({
                    "request_id": request_id,
                    "approvers": [env::predecessor_account_id()],
                    "card_id": card_id,
                }),
            );
            self.pending_approvals.remove(request_id);
        }
    }

    #[payable]
    pub fn reject(&mut self, request_ids: Vec<String>, card_id: Option<String>) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        for request_id in &request_ids {
            emit(
                "purchase_rejected",
                json!({
                    "request_id": request_id,
                    "approvers": [env::predecessor_account_id()],
                    "card_id": card_id,
                }),
            );
            self.pending_approvals.remove(request_id);
        }
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
        let invite = self.invites.get(&code).cloned().expect("invalid invite");
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
        self.grants.insert(account.to_string(), grant);
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
    pub fn freeze(&mut self) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = true;
        emit("frozen", json!({ "company_id": env::current_account_id() }));
    }

    #[payable]
    pub fn unfreeze(&mut self) {
        self.assert_founder();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = false;
        emit("unfrozen", json!({ "company_id": env::current_account_id() }));
    }

    /// Register an agent function-call key on a department (founder-signed).
    pub fn register_agent(&mut self, department_name: String, public_key: PublicKey, role: String) -> Promise {
        self.assert_founder();
        let dept = self
            .departments
            .get(&department_name)
            .cloned()
            .expect("unknown department");
        emit(
            "agent_registered",
            json!({
                "department_id": dept,
                "public_key": format!("{public_key}"),
                "role": role,
            }),
        );
        // Actual AddKey must be done on the department account; emit for indexer and return empty promise.
        Promise::new(dept)
    }
}
