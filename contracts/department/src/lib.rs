#![allow(clippy::too_many_arguments)]
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Keys {
    Tasks,
    Requests,
    Bounties,
    Floats,
    AllowedSellers,
}

const EVENT_STANDARD: &str = "builderos";
const EVENT_VERSION: &str = "1.0.0";

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
pub struct Task {
    pub task_id: String,
    pub tier: String,
    pub cap: String,
    pub tag: String,
    pub role: String,
    pub depends_on: Vec<String>,
    pub pinned_model: Option<String>,
    pub hire_agent_id: Option<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct PurchaseRequest {
    pub request_id: String,
    pub seller_id: String,
    pub rail: String,
    pub amount: String,
    pub challenge_hash: String,
    pub task_id: String,
    pub model: Option<String>,
    pub status: String, // pending | signed | rejected | settled
    pub authorization: Option<String>,
    pub signature: Option<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Bounty {
    pub bounty_id: String,
    pub task_id: String,
    pub agent_id: String,
    pub payee: String,
    pub amount: String,
    pub currency: String,
    pub rail: String,
    pub hiring_role: String,
    pub quote_hash: String,
    pub status: String, // reserved | released | voided
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct RailFloat {
    pub rail: String,
    pub target: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct DepartmentView {
    pub budget: String,
    pub spent: String,
    pub per_tx_limit: String,
    pub frozen: bool,
    pub company_id: AccountId,
    pub base_address: Option<String>,
    pub registry_id: AccountId,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseResult {
    pub status: String,
    pub request_id: String,
    pub rail: Option<String>,
    pub authorization: Option<String>,
    pub signature: Option<String>,
    pub reason: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    company_id: AccountId,
    registry_id: AccountId,
    worker_id: AccountId,
    verifier_id: AccountId,
    mpc_signer: AccountId,
    budget: u128,
    spent: u128,
    reserved: u128,
    per_tx_limit: u128,
    frozen: bool,
    base_address: Option<String>,
    tasks: LookupMap<String, Task>,
    requests: LookupMap<String, PurchaseRequest>,
    bounties: LookupMap<String, Bounty>,
    floats: LookupMap<String, RailFloat>,
    allowed_sellers: LookupMap<String, bool>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        company_id: AccountId,
        registry_id: AccountId,
        worker_id: AccountId,
        verifier_id: AccountId,
        mpc_signer: AccountId,
        budget: String,
        per_tx_limit: String,
        base_address: Option<String>,
    ) -> Self {
        Self {
            company_id,
            registry_id,
            worker_id,
            verifier_id,
            mpc_signer,
            budget: parse_u128(&budget),
            spent: 0,
            reserved: 0,
            per_tx_limit: parse_u128(&per_tx_limit),
            frozen: false,
            base_address,
            tasks: LookupMap::new(Keys::Tasks),
            requests: LookupMap::new(Keys::Requests),
            bounties: LookupMap::new(Keys::Bounties),
            floats: LookupMap::new(Keys::Floats),
            allowed_sellers: LookupMap::new(Keys::AllowedSellers),
        }
    }

    fn assert_not_frozen(&self) {
        require!(!self.frozen, "department frozen");
    }

    fn assert_company(&self) {
        require!(env::predecessor_account_id() == self.company_id, "company only");
    }

    fn assert_worker(&self) {
        require!(env::predecessor_account_id() == self.worker_id, "worker only");
    }

    fn assert_verifier(&self) {
        require!(env::predecessor_account_id() == self.verifier_id, "verifier only");
    }

    fn available(&self) -> u128 {
        self.budget.saturating_sub(self.spent).saturating_sub(self.reserved)
    }

    pub fn get_department(&self) -> DepartmentView {
        DepartmentView {
            budget: self.budget.to_string(),
            spent: self.spent.to_string(),
            per_tx_limit: self.per_tx_limit.to_string(),
            frozen: self.frozen,
            company_id: self.company_id.clone(),
            base_address: self.base_address.clone(),
            registry_id: self.registry_id.clone(),
        }
    }

    pub fn get_request(&self, request_id: String) -> Option<PurchaseRequest> {
        self.requests.get(&request_id).cloned()
    }

    pub fn get_bounty(&self, bounty_id: String) -> Option<Bounty> {
        self.bounties.get(&bounty_id).cloned()
    }

    #[payable]
    pub fn assign_task(
        &mut self,
        task_id: String,
        tier: String,
        cap: String,
        tag: String,
        role: String,
        depends_on: Vec<String>,
    ) {
        self.assert_company();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        let task = Task {
            task_id: task_id.clone(),
            tier: tier.clone(),
            cap: cap.clone(),
            tag: tag.clone(),
            role,
            depends_on,
            pinned_model: None,
            hire_agent_id: None,
        };
        self.tasks.insert(task_id.clone(), task);
        emit(
            "task_assigned",
            json!({
                "task_id": task_id,
                "department_id": env::current_account_id(),
                "tier": tier,
                "cap": cap,
                "tag": tag,
            }),
        );
    }

    #[payable]
    pub fn set_task_tier(&mut self, task_id: String, tier: String, pinned_model: Option<String>) {
        self.assert_company();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        let mut t = self.tasks.get(&task_id).cloned().expect("unknown task");
        t.tier = tier;
        t.pinned_model = pinned_model;
        self.tasks.insert(task_id, t);
    }

    #[payable]
    pub fn set_task_hire(&mut self, task_id: String, agent_id: Option<String>) {
        self.assert_company();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        let mut t = self.tasks.get(&task_id).cloned().expect("unknown task");
        t.hire_agent_id = agent_id;
        self.tasks.insert(task_id, t);
    }

    #[payable]
    pub fn set_rail_float(&mut self, rail: String, target: String, enabled: bool) {
        self.assert_company();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.floats.insert(
            rail.clone(),
            RailFloat {
                rail: rail.clone(),
                target: target.clone(),
                enabled,
            },
        );
        emit(
            "float_set",
            json!({ "department_id": env::current_account_id(), "rail": rail, "target": target }),
        );
    }

    pub fn allow_seller(&mut self, seller_id: String, allowed: bool) {
        self.assert_company();
        self.allowed_sellers.insert(seller_id, allowed);
    }

    /// Agent spend firewall entrypoint. Auto-signs within budget/per-tx; otherwise yields pending.
    pub fn request_purchase(
        &mut self,
        seller_id: String,
        rail: String,
        amount: String,
        challenge_hash: String,
        task_id: String,
        model: Option<String>,
        payload: Option<Value>,
    ) -> PurchaseResult {
        let _ = payload;
        self.assert_not_frozen();
        let amt = parse_u128(&amount);
        require!(amt > 0, "amount > 0");
        require!(amt <= self.per_tx_limit, "over per_tx_limit");
        require!(amt <= self.available(), "over budget");

        let request_id = format!("{}:{}", task_id, env::block_height());
        emit(
            "purchase_requested",
            json!({
                "request_id": request_id,
                "task_id": task_id,
                "seller_id": seller_id,
                "rail": rail,
                "amount": amount,
                "challenge_hash": challenge_hash,
            }),
        );

        // Within limits → treat as signed (MPC hook: call self.mpc_signer in a follow-up spike).
        self.reserved = self.reserved.saturating_add(amt);
        let authorization = format!("auth:{}:{}:{}", seller_id, amount, challenge_hash);
        let signature = format!("sig:{}", env::sha256(authorization.as_bytes()).iter().map(|b| format!("{b:02x}")).take(16).collect::<String>());
        let req = PurchaseRequest {
            request_id: request_id.clone(),
            seller_id: seller_id.clone(),
            rail: rail.clone(),
            amount: amount.clone(),
            challenge_hash,
            task_id: task_id.clone(),
            model: model.clone(),
            status: "signed".into(),
            authorization: Some(authorization.clone()),
            signature: Some(signature.clone()),
        };
        self.requests.insert(request_id.clone(), req);
        emit(
            "payment_signed",
            json!({
                "request_id": request_id,
                "seller_id": seller_id,
                "rail": rail,
                "amount": amount,
                "task_id": task_id,
                "model": model,
            }),
        );
        PurchaseResult {
            status: "signed".into(),
            request_id,
            rail: Some(rail),
            authorization: Some(authorization),
            signature: Some(signature),
            reason: None,
        }
    }

    pub fn record_response(
        &mut self,
        request_id: String,
        response_hash: String,
        foreign_tx: Option<String>,
        outcome: String,
    ) {
        self.assert_not_frozen();
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        let amt = parse_u128(&req.amount);
        if req.status == "signed" {
            self.reserved = self.reserved.saturating_sub(amt);
            if outcome == "ok" {
                self.spent = self.spent.saturating_add(amt);
            }
            req.status = "settled".into();
            self.requests.insert(request_id.clone(), req);
        }
        emit(
            "receipt",
            json!({
                "request_id": request_id,
                "response_hash": response_hash,
                "foreign_tx": foreign_tx,
                "outcome": outcome,
            }),
        );
    }

    /// Reserve exact hire payment (pay-on-green). Does not spend until submit_verdict(pass).
    pub fn create_bounty(
        &mut self,
        bounty_id: String,
        task_id: String,
        agent_id: String,
        payee: String,
        amount: String,
        currency: String,
        token: Option<String>,
        rail: String,
        hiring_role: String,
        quote_hash: String,
    ) {
        self.assert_not_frozen();
        require!(!self.bounties.contains_key(&bounty_id), "bounty exists");
        let amt = parse_u128(&amount);
        require!(amt > 0, "amount > 0");
        require!(amt <= self.per_tx_limit, "over per_tx_limit");
        require!(amt <= self.available(), "over budget");
        let currency = token.unwrap_or(currency);
        self.reserved = self.reserved.saturating_add(amt);
        let bounty = Bounty {
            bounty_id: bounty_id.clone(),
            task_id: task_id.clone(),
            agent_id: agent_id.clone(),
            payee: payee.clone(),
            amount: amount.clone(),
            currency: currency.clone(),
            rail: rail.clone(),
            hiring_role: hiring_role.clone(),
            quote_hash,
            status: "reserved".into(),
        };
        self.bounties.insert(bounty_id.clone(), bounty);
        emit(
            "bounty_created",
            json!({
                "bounty_id": bounty_id,
                "task_id": task_id,
                "payee": payee,
                "amount": amount,
                "currency": currency,
                "rail": rail,
                "agent_id": agent_id,
                "hiring_role": hiring_role,
            }),
        );
        emit(
            "agent_hired",
            json!({
                "task_id": task_id,
                "department_id": env::current_account_id(),
                "agent_id": agent_id,
                "bounty_id": bounty_id,
                "amount": amount,
                "currency": currency,
                "hiring_role": hiring_role,
            }),
        );
    }

    pub fn submit_verdict(
        &mut self,
        task_id: String,
        verdict: String,
        log_hash: String,
        bounty_id: Option<String>,
    ) {
        self.assert_verifier();
        let pass = verdict == "pass";
        if let Some(bid) = bounty_id {
            let mut b = self.bounties.get(&bid).cloned().expect("unknown bounty");
            require!(b.task_id == task_id, "bounty/task mismatch");
            require!(b.status == "reserved", "bounty not reserved");
            let amt = parse_u128(&b.amount);
            self.reserved = self.reserved.saturating_sub(amt);
            if pass {
                self.spent = self.spent.saturating_add(amt);
                b.status = "released".into();
                self.bounties.insert(bid.clone(), b.clone());
                emit(
                    "bounty_released",
                    json!({
                        "task_id": task_id,
                        "bounty_id": bid,
                        "payee": b.payee,
                        "verdict": "pass",
                        "log_hash": log_hash,
                        "amount": b.amount,
                        "currency": b.currency,
                        "token": b.currency,
                        "rail": b.rail,
                        "agent_id": b.agent_id,
                    }),
                );
            } else {
                b.status = "voided".into();
                self.bounties.insert(bid.clone(), b.clone());
                emit(
                    "bounty_voided",
                    json!({
                        "task_id": task_id,
                        "bounty_id": bid,
                        "verdict": "fail",
                        "log_hash": log_hash,
                        "amount": b.amount,
                        "currency": b.currency,
                    }),
                );
            }
            return;
        }
        // Non-hire task verdict (legacy path).
        if pass {
            emit(
                "bounty_released",
                json!({ "task_id": task_id, "payee": env::predecessor_account_id(), "verdict": "pass", "log_hash": log_hash }),
            );
        } else {
            emit(
                "bounty_voided",
                json!({ "task_id": task_id, "verdict": "fail", "log_hash": log_hash }),
            );
        }
    }

    pub fn request_rail_topup(&mut self, job_id: String, amount: String, rail: String) {
        self.assert_worker();
        emit(
            "topup_requested",
            json!({ "department_id": env::current_account_id(), "job_id": job_id, "amount": amount, "rail": rail }),
        );
    }

    pub fn record_topup(
        &mut self,
        job_id: String,
        amount_in: String,
        amount_out: String,
        fees: Option<String>,
        quote_id: Option<String>,
        origin_tx: Option<String>,
        dest_tx: Option<String>,
        token: Option<String>,
    ) {
        self.assert_worker();
        emit(
            "topup_recorded",
            json!({
                "department_id": env::current_account_id(),
                "job_id": job_id,
                "amount_in": amount_in,
                "amount_out": amount_out,
                "fees": fees,
                "quote_id": quote_id,
                "origin_tx": origin_tx,
                "dest_tx": dest_tx,
                "token": token.unwrap_or_else(|| "usdc".into()),
            }),
        );
    }

    #[payable]
    pub fn freeze(&mut self) {
        require!(
            env::predecessor_account_id() == self.company_id || env::predecessor_account_id() == env::current_account_id(),
            "unauthorized"
        );
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = true;
        emit("frozen", json!({ "department_id": env::current_account_id() }));
    }

    #[payable]
    pub fn unfreeze(&mut self) {
        self.assert_company();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "1 yocto");
        self.frozen = false;
        emit("unfrozen", json!({ "department_id": env::current_account_id() }));
    }

    pub fn top_up_budget(&mut self, amount: String) {
        self.assert_company();
        self.budget = self.budget.saturating_add(parse_u128(&amount));
    }
}
