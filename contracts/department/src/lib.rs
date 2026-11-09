#![allow(clippy::too_many_arguments)]
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Keys {
    Tasks,
    Requests,
    Bounties,
    Floats,
    AllowedSellers,
    Challenges,
    TaskSpend,
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

/// The only methods an agent key on this account can call.
const AGENT_METHODS: &str = "request_purchase,sign_approved,cancel_request,record_response,create_bounty";

/// Chain Signatures derivation path for this team's EVM (Base) payment address.
pub const MPC_PATH: &str = "builderos-base";
/// Longest an x402 authorization stays valid after it is signed.
const MAX_AUTH_TTL_SECS: u64 = 3600;

// ---------------- EIP-3009 TransferWithAuthorization (USDC) ----------------

fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn word_u64(v: u64) -> [u8; 32] {
    word_u128(v as u128)
}

fn parse_address(a: &str) -> [u8; 20] {
    let h = a.strip_prefix("0x").unwrap_or(a);
    require!(h.len() == 40, "bad EVM address");
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("bad EVM address"));
    }
    out
}

fn word_address(a: &str) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&parse_address(a));
    w
}

/// EIP-712 digest of USDC `TransferWithAuthorization` — exactly what the token's `transferWithAuthorization` verifies.
pub fn eip3009_digest(
    token_name: &str,
    token_version: &str,
    chain_id: u64,
    usdc: &str,
    from: &str,
    to: &str,
    value: u128,
    valid_after: u64,
    valid_before: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let domain_type = keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    let mut d = Vec::with_capacity(160);
    d.extend_from_slice(&domain_type);
    d.extend_from_slice(&keccak(token_name.as_bytes()));
    d.extend_from_slice(&keccak(token_version.as_bytes()));
    d.extend_from_slice(&word_u64(chain_id));
    d.extend_from_slice(&word_address(usdc));
    let domain_sep = keccak(&d);

    let type_hash = keccak(b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    let mut m = Vec::with_capacity(224);
    m.extend_from_slice(&type_hash);
    m.extend_from_slice(&word_address(from));
    m.extend_from_slice(&word_address(to));
    m.extend_from_slice(&word_u128(value));
    m.extend_from_slice(&word_u64(valid_after));
    m.extend_from_slice(&word_u64(valid_before));
    m.extend_from_slice(nonce);
    let struct_hash = keccak(&m);

    let mut out = Vec::with_capacity(66);
    out.extend_from_slice(&[0x19, 0x01]);
    out.extend_from_slice(&domain_sep);
    out.extend_from_slice(&struct_hash);
    keccak(&out)
}

/// x402 network name → EVM chain id.
fn chain_id_of(network: &str) -> Option<u64> {
    match network {
        "base" | "eip155:8453" => Some(8453),
        "base-sepolia" | "eip155:84532" => Some(84532),
        _ => network.strip_prefix("eip155:").and_then(|n| n.parse().ok()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
    /// checking → pending (approval card) → approved → signed → settled; or rejected / cancelled.
    pub status: String,
    /// Why it needs a person: over_limit | new_seller | over_task_cap | unassigned_task | daily_cap.
    pub reason: Option<String>,
    /// Payee the contract will sign to (allow-list entry, or the one the approver saw on the card).
    pub pay_to: String,
    pub token_name: String,
    pub token_version: String,
    /// JSON of the EIP-3009 authorization that was signed, and the Chain Signatures response.
    pub authorization: Option<String>,
    pub signature: Option<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct AllowedSeller {
    pub pay_to: String,
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
    pub evm_chain_id: u64,
    pub evm_usdc: Option<String>,
    pub reserved: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PurchaseResult {
    /// signed | pending | approved | rejected
    pub status: String,
    pub request_id: String,
    pub rail: Option<String>,
    pub authorization: Option<Value>,
    pub signature: Option<Value>,
    pub reason: Option<String>,
}

impl PurchaseResult {
    fn of(req: &PurchaseRequest) -> Self {
        PurchaseResult {
            status: req.status.clone(),
            request_id: req.request_id.clone(),
            rail: Some(req.rail.clone()),
            authorization: req.authorization.as_ref().and_then(|a| near_sdk::serde_json::from_str(a).ok()),
            signature: req.signature.as_ref().and_then(|a| near_sdk::serde_json::from_str(a).ok()),
            reason: req.reason.clone(),
        }
    }
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
    allowed_sellers: LookupMap<String, AllowedSeller>,
    /// challenge_hash → request_id (a 402 challenge can only be paid once).
    challenges: LookupMap<String, String>,
    /// task_id → reserved + spent, checked against the task's cap.
    task_spend: LookupMap<String, u128>,
    evm_chain_id: u64,
    evm_usdc: Option<String>,
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
        evm_chain_id: Option<u64>,
        evm_usdc: Option<String>,
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
            challenges: LookupMap::new(Keys::Challenges),
            task_spend: LookupMap::new(Keys::TaskSpend),
            evm_chain_id: evm_chain_id.unwrap_or(0),
            evm_usdc: evm_usdc.map(|u| u.to_lowercase()),
        }
    }

    fn assert_not_frozen(&self) {
        require!(!self.frozen, "department frozen");
    }

    fn assert_company(&self) {
        require!(env::predecessor_account_id() == self.company_id, "company only");
    }

    /// Agents hold function-call keys on this account limited to AGENT_METHODS, so an agent call
    /// arrives with this account as predecessor. Nobody else (and no full-access key) can call them.
    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == env::current_account_id(), "agent key only");
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
            evm_chain_id: self.evm_chain_id,
            evm_usdc: self.evm_usdc.clone(),
            reserved: self.reserved.to_string(),
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

    /// Company-only (founder/admin via dept_call): allow-list a seller and the only address it may be paid at.
    /// `pay_to: null` removes it. Purchases from sellers not on the list need a person's approval.
    pub fn allow_seller(&mut self, seller_id: String, pay_to: Option<String>) {
        self.assert_company();
        match pay_to {
            Some(p) => {
                parse_address(&p);
                self.allowed_sellers.insert(seller_id.clone(), AllowedSeller { pay_to: p.to_lowercase() });
                emit("seller_allowed", json!({ "department_id": env::current_account_id(), "seller_id": seller_id, "pay_to": p }));
            }
            None => {
                self.allowed_sellers.remove(&seller_id);
                emit("seller_removed", json!({ "department_id": env::current_account_id(), "seller_id": seller_id }));
            }
        }
    }

    /// Company-only (founder/admin via dept_call): Base chain, USDC contract and this team's
    /// Chain Signatures address (derived from this account + MPC_PATH).
    pub fn set_evm_config(&mut self, chain_id: u64, usdc: String, from: String) {
        self.assert_company();
        parse_address(&usdc);
        parse_address(&from);
        self.evm_chain_id = chain_id;
        self.evm_usdc = Some(usdc.to_lowercase());
        self.base_address = Some(from.to_lowercase());
    }

    pub fn get_seller(&self, seller_id: String) -> Option<AllowedSeller> {
        self.allowed_sellers.get(&seller_id).cloned()
    }

    /// Agent spend firewall entrypoint (x402 on Base). The contract — never the agent — decides:
    ///  1. payee: allow-listed seller → must match its pay_to (mismatch = blocked attack);
    ///     unknown seller → needs approval, and the approver sees the payee
    ///  2. limits: team budget (hard), per-transaction limit and task cap (approval)
    ///  3. company: frozen (reject) and daily cap (approval), checked on the company contract
    /// Within all limits it asks Chain Signatures to sign the EIP-3009 authorization right away;
    /// otherwise it returns `pending` and an approval card appears for the founder/approvers.
    pub fn request_purchase(
        &mut self,
        seller_id: String,
        rail: String,
        amount: String,
        challenge_hash: String,
        task_id: String,
        model: Option<String>,
        payload: Option<Value>,
    ) -> PromiseOrValue<PurchaseResult> {
        self.assert_agent();
        self.assert_not_frozen();
        let request_id = format!("{}:{}:{}", task_id, env::block_height(), &challenge_hash[..challenge_hash.len().min(8)]);
        let reject = |reason: &str| {
            PromiseOrValue::Value(PurchaseResult {
                status: "rejected".into(),
                request_id: request_id.clone(),
                rail: Some(rail.clone()),
                authorization: None,
                signature: None,
                reason: Some(reason.into()),
            })
        };
        if rail != "x402-evm" {
            // Tempo/MPP and NEAR delegate signing aren't contract-built yet; the SDK falls back to an x402 seller.
            return reject("rail_not_supported");
        }
        let amt = parse_u128(&amount);
        require!(amt > 0, "amount > 0");
        require!(!self.challenges.contains_key(&challenge_hash), "challenge already used");
        if amt > self.available() {
            return reject("over_budget");
        }
        let req_json = payload.unwrap_or(Value::Null);
        let pay_to = req_json.get("payTo").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let asset = req_json.get("asset").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let network = req_json.get("network").and_then(|v| v.as_str()).unwrap_or("");
        parse_address(&pay_to);
        require!(self.base_address.is_some() && self.evm_usdc.is_some(), "team payment address not configured");
        require!(Some(asset) == self.evm_usdc, "asset is not this team's USDC");
        require!(chain_id_of(network) == Some(self.evm_chain_id), "wrong chain");

        // Payee check: an allow-listed seller can only be paid at its registered address.
        let mut reason: Option<String> = None;
        match self.allowed_sellers.get(&seller_id) {
            Some(entry) if entry.pay_to != pay_to => {
                emit(
                    "purchase_rejected",
                    json!({ "request_id": request_id, "seller_id": seller_id, "reason": "attack", "blocked": true, "detail": "payTo differs from allow-listed address", "amount": amount }),
                );
                return reject("payee_mismatch");
            }
            Some(_) => {}
            None => reason = Some("new_seller".into()),
        }
        if amt > self.per_tx_limit {
            reason = Some("over_limit".into());
        }
        match self.tasks.get(&task_id) {
            Some(t) => {
                let used = self.task_spend.get(&task_id).copied().unwrap_or(0);
                if used + amt > parse_u128(&t.cap) {
                    reason = Some("over_task_cap".into());
                }
            }
            None => reason = Some("unassigned_task".into()),
        }

        let extra = req_json.get("extra");
        let token_name = extra.and_then(|e| e.get("name")).and_then(|v| v.as_str()).unwrap_or(if self.evm_chain_id == 8453 { "USD Coin" } else { "USDC" });
        let token_version = extra.and_then(|e| e.get("version")).and_then(|v| v.as_str()).unwrap_or("2");

        self.reserved += amt;
        *self.task_spend.entry(task_id.clone()).or_insert(0) += amt;
        self.challenges.insert(challenge_hash.clone(), request_id.clone());
        self.requests.insert(
            request_id.clone(),
            PurchaseRequest {
                request_id: request_id.clone(),
                seller_id: seller_id.clone(),
                rail: rail.clone(),
                amount: amount.clone(),
                challenge_hash: challenge_hash.clone(),
                task_id: task_id.clone(),
                model,
                status: "checking".into(),
                reason: reason.clone(),
                pay_to: pay_to.clone(),
                token_name: token_name.into(),
                token_version: token_version.into(),
                authorization: None,
                signature: None,
            },
        );
        emit(
            "purchase_requested",
            json!({ "request_id": request_id, "task_id": task_id, "seller_id": seller_id, "rail": rail, "amount": amount, "challenge_hash": challenge_hash, "pay_to": pay_to }),
        );

        // Company decides frozen / daily cap / approval card.
        let args = json!({ "request_id": request_id, "amount": amount, "reason": reason, "seller_id": seller_id, "task_id": task_id, "pay_to": pay_to });
        PromiseOrValue::Promise(
            Promise::new(self.company_id.clone())
                .function_call("check_spend", near_sdk::serde_json::to_vec(&args).unwrap(), NearToken::from_yoctonear(0), Gas::from_tgas(15))
                .then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_spend_checked",
                        near_sdk::serde_json::to_vec(&json!({ "request_id": request_id })).unwrap(),
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(120),
                    ),
                ),
        )
    }

    /// Callback from company.check_spend: "ok" → sign now, "pending" → wait for approval, else reject.
    pub fn on_spend_checked(&mut self, request_id: String) -> PromiseOrValue<PurchaseResult> {
        require!(env::predecessor_account_id() == env::current_account_id(), "private");
        let verdict: String = match env::promise_result_checked(0, 256) {
            Ok(v) => near_sdk::serde_json::from_slice(&v).unwrap_or_else(|_| "rejected:bad_response".into()),
            Err(_) => "rejected:company_check_failed".into(),
        };
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        if verdict == "ok" {
            req.status = "approved".into();
            self.requests.insert(request_id.clone(), req);
            return PromiseOrValue::Promise(self.sign(request_id));
        }
        if verdict == "pending" {
            req.status = "pending".into();
            if req.reason.is_none() {
                req.reason = Some("daily_cap".into());
            }
            self.requests.insert(request_id.clone(), req.clone());
            return PromiseOrValue::Value(PurchaseResult::of(&req));
        }
        let why = verdict.trim_start_matches("rejected:").to_string();
        self.release(&mut req, "rejected", &why);
        PromiseOrValue::Value(PurchaseResult::of(&req))
    }

    /// Company-only: an approver approved this request on the company contract.
    pub fn mark_approved(&mut self, request_id: String) {
        self.assert_company();
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        require!(req.status == "pending", "request is not pending");
        req.status = "approved".into();
        self.requests.insert(request_id, req);
    }

    /// Company-only: an approver rejected this request.
    pub fn mark_rejected(&mut self, request_id: String) {
        self.assert_company();
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        require!(req.status == "pending", "request is not pending");
        self.release(&mut req, "rejected", "rejected_by_approver");
    }

    /// Agent: get the Chain Signatures signature for an approved request (after its approval card).
    pub fn sign_approved(&mut self, request_id: String) -> Promise {
        self.assert_agent();
        self.assert_not_frozen();
        let req = self.requests.get(&request_id).cloned().expect("unknown request");
        require!(req.status == "approved", "request is not approved");
        self.sign(request_id)
    }

    /// Agent: give up on a request that is still waiting (e.g. the task moved on); frees the reservation.
    pub fn cancel_request(&mut self, request_id: String) {
        self.assert_agent();
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        require!(req.status == "pending" || req.status == "approved", "request can't be cancelled");
        self.release(&mut req, "cancelled", "cancelled_by_agent");
    }

    /// Find a request by the 402 challenge it paid (the SDK uses this if its RPC call timed out mid-flight).
    pub fn get_request_by_challenge(&self, challenge_hash: String) -> Option<PurchaseRequest> {
        self.challenges.get(&challenge_hash).and_then(|id| self.requests.get(id).cloned())
    }

    pub fn get_payment_path(&self) -> String {
        MPC_PATH.to_string()
    }

    /// Ask v1.signer (domain 0, secp256k1) to sign the EIP-3009 authorization for this request.
    /// validBefore is set at signing time, so an approval that came hours later still gets a fresh window.
    fn sign(&mut self, request_id: String) -> Promise {
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        let from = self.base_address.clone().expect("team payment address not configured");
        let usdc = self.evm_usdc.clone().expect("team USDC not configured");
        let valid_before = env::block_timestamp() / 1_000_000_000 + MAX_AUTH_TTL_SECS;
        let nonce = env::sha256_array(request_id.as_bytes());
        let value = parse_u128(&req.amount);
        let digest = eip3009_digest(&req.token_name, &req.token_version, self.evm_chain_id, &usdc, &from, &req.pay_to, value, 0, valid_before, &nonce);
        let authorization = json!({
            "from": from,
            "to": req.pay_to,
            "value": req.amount,
            "validAfter": "0",
            "validBefore": valid_before.to_string(),
            "nonce": format!("0x{}", hex(&nonce)),
        });
        req.authorization = Some(authorization.to_string());
        self.requests.insert(request_id.clone(), req);
        let args = json!({ "request": { "path": MPC_PATH, "payload": digest.to_vec(), "domain_id": 0 } });
        Promise::new(self.mpc_signer.clone())
            .function_call("sign", near_sdk::serde_json::to_vec(&args).unwrap(), NearToken::from_yoctonear(1), Gas::from_tgas(50))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_signed",
                    near_sdk::serde_json::to_vec(&json!({ "request_id": request_id })).unwrap(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(15),
                ),
            )
    }

    /// Callback from v1.signer. On failure the request stays `approved` so the agent can retry `sign_approved`.
    pub fn on_signed(&mut self, request_id: String) -> PurchaseResult {
        require!(env::predecessor_account_id() == env::current_account_id(), "private");
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        match env::promise_result_checked(0, 2_048) {
            Ok(v) => {
                let sig: Value = near_sdk::serde_json::from_slice(&v).unwrap_or(Value::Null);
                req.status = "signed".into();
                req.signature = Some(sig.to_string());
                self.requests.insert(request_id.clone(), req.clone());
                emit(
                    "payment_signed",
                    json!({
                        "request_id": request_id,
                        "seller_id": req.seller_id,
                        "rail": req.rail,
                        "chain_id": self.evm_chain_id,
                        "amount": req.amount,
                        "task_id": req.task_id,
                        "model": req.model,
                        "pay_to": req.pay_to,
                    }),
                );
            }
            _ => {
                req.reason = Some("sign_failed_retry".into());
                self.requests.insert(request_id.clone(), req.clone());
            }
        }
        PurchaseResult::of(&req)
    }

    fn release(&mut self, req: &mut PurchaseRequest, status: &str, why: &str) {
        let amt = parse_u128(&req.amount);
        self.reserved = self.reserved.saturating_sub(amt);
        if let Some(t) = self.task_spend.get_mut(&req.task_id) {
            *t = t.saturating_sub(amt);
        }
        req.status = status.into();
        req.reason = Some(why.into());
        self.requests.insert(req.request_id.clone(), req.clone());
        emit("purchase_rejected", json!({ "request_id": req.request_id, "reason": why, "amount": req.amount }));
    }

    pub fn record_response(
        &mut self,
        request_id: String,
        response_hash: String,
        foreign_tx: Option<String>,
        outcome: String,
    ) {
        self.assert_agent();
        let mut req = self.requests.get(&request_id).cloned().expect("unknown request");
        require!(req.status == "signed", "request is not signed");
        let amt = parse_u128(&req.amount);
        self.reserved = self.reserved.saturating_sub(amt);
        if outcome == "ok" {
            self.spent = self.spent.saturating_add(amt);
        } else if let Some(t) = self.task_spend.get_mut(&req.task_id) {
            // x402 never settles on a failed call: give the task its cap back.
            *t = t.saturating_sub(amt);
        }
        req.status = "settled".into();
        self.requests.insert(request_id.clone(), req);
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
        self.assert_agent();
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

    /// Company-only: give an agent a key that can only call the agent methods on this account.
    /// Its NEAR allowance only covers gas — spending USDC still goes through `request_purchase`.
    pub fn add_agent_key(&mut self, public_key: PublicKey, role: String) -> Promise {
        self.assert_company();
        emit(
            "agent_registered",
            json!({ "department_id": env::current_account_id(), "public_key": String::from(&public_key), "role": role }),
        );
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            Allowance::limited(NearToken::from_millinear(250)).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Company-only: "Fire" — delete the agent's key.
    pub fn remove_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_company();
        emit("agent_fired", json!({ "department_id": env::current_account_id(), "public_key": String::from(&public_key) }));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Company-only: replace this contract's code. The company forwards it only after the founder's
    /// upgrade proposal has waited out its delay. Raw wasm is the call input (no JSON).
    pub fn upgrade(&mut self) -> Promise {
        self.assert_company();
        let code = env::input().expect("code");
        emit("upgrade_applied", json!({ "target": env::current_account_id(), "code_hash": hex(&env::sha256(&code)) }));
        Promise::new(env::current_account_id()).deploy_contract(code)
    }

    pub fn top_up_budget(&mut self, amount: String) {
        self.assert_company();
        self.budget = self.budget.saturating_add(parse_u128(&amount));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

    const DEPT: &str = "build.acme.builderos-wang.testnet";
    const COMPANY: &str = "acme.builderos-wang.testnet";
    const USDC: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const FROM: &str = "0x9999999999999999999999999999999999999999";
    const SELLER_PAY: &str = "0x1111111111111111111111111111111111111111";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx_with(predecessor: &str, results: Vec<PromiseResult>) {
        let c = VMContextBuilder::new()
            .current_account_id(acc(DEPT))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .block_timestamp(1_700_000_000_000_000_000)
            .build();
        testing_env!(c, test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }
    fn ctx(predecessor: &str) {
        ctx_with(predecessor, vec![]);
    }
    fn dept() -> Contract {
        ctx(COMPANY);
        let mut d = Contract::new(
            acc(COMPANY),
            acc("registry.builderos-wang.testnet"),
            acc("worker.builderos-wang.testnet"),
            acc("verifier.builderos-wang.testnet"),
            acc("v1.signer-prod.testnet"),
            "100000000".into(), // $100
            "5000000".into(),   // $5 per tx
            Some(FROM.into()),
            Some(84532),
            Some(USDC.into()),
        );
        d.allow_seller("inferx.base".into(), Some(SELLER_PAY.into()));
        d.assign_task_for_test("t1", "20000000");
        d
    }
    impl Contract {
        fn assign_task_for_test(&mut self, id: &str, cap: &str) {
            self.tasks.insert(
                id.into(),
                Task { task_id: id.into(), tier: "s".into(), cap: cap.into(), tag: "x".into(), role: "x".into(), depends_on: vec![], pinned_model: None, hire_agent_id: None },
            );
        }
    }
    fn challenge(pay_to: &str) -> Value {
        json!({ "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "20000", "payTo": pay_to, "asset": USDC, "extra": { "name": "USDC", "version": "2" } })
    }
    fn buy(d: &mut Contract, seller: &str, amount: &str, hash: &str, task: &str, pay_to: &str) -> PromiseOrValue<PurchaseResult> {
        ctx(DEPT); // agent function-call key on this account
        d.request_purchase(seller.into(), "x402-evm".into(), amount.into(), hash.into(), task.into(), None, Some(challenge(pay_to)))
    }
    fn only_request(d: &Contract, task: &str) -> PurchaseRequest {
        // request ids are task:height:hash8; height is 0 in unit tests
        d.requests.get(&format!("{task}:0:{}", "hash0001")).cloned().expect("request")
    }
    fn value(r: PromiseOrValue<PurchaseResult>) -> PurchaseResult {
        match r {
            PromiseOrValue::Value(v) => v,
            PromiseOrValue::Promise(_) => panic!("expected a value"),
        }
    }

    #[test]
    fn eip3009_digest_matches_viem() {
        let nonce = [0x11u8; 32];
        let d = eip3009_digest("USDC", "2", 84532, USDC, FROM, SELLER_PAY, 20000, 0, 1_800_000_000, &nonce);
        assert_eq!(hex(&d), "d05c8bafb31d60467dca2565093cc0a25014abcd7159fea920e1a2b63f99bd1e");
    }

    #[test]
    fn allowed_seller_within_limits_goes_to_company_check() {
        let mut d = dept();
        let r = buy(&mut d, "inferx.base", "20000", "hash0001", "t1", SELLER_PAY);
        assert!(matches!(r, PromiseOrValue::Promise(_)));
        let req = only_request(&d, "t1");
        assert_eq!(req.status, "checking");
        assert_eq!(req.reason, None);
        assert_eq!(d.reserved, 20000);
    }

    #[test]
    fn injected_payee_is_blocked() {
        let mut d = dept();
        let r = value(buy(&mut d, "inferx.base", "20000", "hash0001", "t1", "0x000000000000000000000000000000000000dead"));
        assert_eq!(r.status, "rejected");
        assert_eq!(r.reason.as_deref(), Some("payee_mismatch"));
        assert_eq!(d.reserved, 0);
    }

    #[test]
    fn unknown_seller_over_limit_and_unassigned_task_need_approval() {
        let mut d = dept();
        let _ = buy(&mut d, "new.seller", "20000", "hash0001", "t1", SELLER_PAY);
        assert_eq!(only_request(&d, "t1").reason.as_deref(), Some("new_seller"));
        let mut d = dept();
        let _ = buy(&mut d, "inferx.base", "6000000", "hash0001", "t1", SELLER_PAY);
        assert_eq!(only_request(&d, "t1").reason.as_deref(), Some("over_limit"));
        let mut d = dept();
        let _ = buy(&mut d, "inferx.base", "20000", "hash0001", "t9", SELLER_PAY);
        assert_eq!(only_request(&d, "t9").reason.as_deref(), Some("unassigned_task"));
    }

    #[test]
    fn task_cap_is_enforced() {
        let mut d = dept();
        d.assign_task_for_test("t2", "10000");
        let _ = buy(&mut d, "inferx.base", "20000", "hash0001", "t2", SELLER_PAY);
        assert_eq!(only_request(&d, "t2").reason.as_deref(), Some("over_task_cap"));
    }

    #[test]
    fn over_budget_wrong_asset_and_other_rails_are_rejected() {
        let mut d = dept();
        assert_eq!(value(buy(&mut d, "inferx.base", "200000000", "hash0001", "t1", SELLER_PAY)).reason.as_deref(), Some("over_budget"));
        ctx(DEPT);
        let r = value(d.request_purchase("s".into(), "mpp-tempo-charge".into(), "1".into(), "h2".into(), "t1".into(), None, None));
        assert_eq!(r.reason.as_deref(), Some("rail_not_supported"));
        ctx(DEPT);
        let mut bad = challenge(SELLER_PAY);
        bad["asset"] = json!("0x2222222222222222222222222222222222222222");
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            d.request_purchase("inferx.base".into(), "x402-evm".into(), "1".into(), "h3".into(), "t1".into(), None, Some(bad.clone()))
        }));
        assert!(res.is_err(), "other tokens are refused");
    }

    #[test]
    #[should_panic(expected = "challenge already used")]
    fn a_challenge_can_only_be_paid_once() {
        let mut d = dept();
        let _ = buy(&mut d, "inferx.base", "20000", "hash0001", "t1", SELLER_PAY);
        let _ = buy(&mut d, "inferx.base", "20000", "hash0001", "t1", SELLER_PAY);
    }

    #[test]
    fn full_approval_flow_signs_and_settles() {
        let mut d = dept();
        let _ = buy(&mut d, "inferx.base", "6000000", "hash0001", "t1", SELLER_PAY); // over $5 → approval
        let id = only_request(&d, "t1").request_id;

        ctx_with(DEPT, vec![PromiseResult::Successful(b"\"pending\"".to_vec())]);
        let r = value(d.on_spend_checked(id.clone()));
        assert_eq!(r.status, "pending");

        ctx(DEPT);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| d.sign_approved(id.clone()))).is_err(), "can't sign before approval");

        ctx(COMPANY);
        d.mark_approved(id.clone());
        ctx(DEPT);
        let _ = d.sign_approved(id.clone());
        let auth: Value = near_sdk::serde_json::from_str(&only_request(&d, "t1").authorization.unwrap()).unwrap();
        assert_eq!(auth["to"], SELLER_PAY);
        assert_eq!(auth["from"], FROM);
        assert_eq!(auth["value"], "6000000");

        let sig = br#"{"scheme":"Secp256k1","big_r":{"affine_point":"02aa"},"s":{"scalar":"bb"},"recovery_id":1}"#.to_vec();
        ctx_with(DEPT, vec![PromiseResult::Successful(sig)]);
        let signed = d.on_signed(id.clone());
        assert_eq!(signed.status, "signed");
        assert_eq!(signed.signature.unwrap()["recovery_id"], 1);

        ctx(DEPT);
        d.record_response(id, "rh".into(), Some("0xtx".into()), "ok".into());
        assert_eq!(d.spent, 6000000);
        assert_eq!(d.reserved, 0);
    }

    #[test]
    fn rejection_and_cancel_free_the_reservation() {
        let mut d = dept();
        let _ = buy(&mut d, "new.seller", "20000", "hash0001", "t1", SELLER_PAY);
        let id = only_request(&d, "t1").request_id;
        ctx_with(DEPT, vec![PromiseResult::Successful(b"\"pending\"".to_vec())]);
        let _ = d.on_spend_checked(id.clone());
        ctx(COMPANY);
        d.mark_rejected(id.clone());
        assert_eq!(d.reserved, 0);
        assert_eq!(only_request(&d, "t1").status, "rejected");
        assert_eq!(d.task_spend.get("t1").copied().unwrap_or(0), 0);
    }

    #[test]
    fn frozen_company_rejects() {
        let mut d = dept();
        let _ = buy(&mut d, "inferx.base", "20000", "hash0001", "t1", SELLER_PAY);
        let id = only_request(&d, "t1").request_id;
        ctx_with(DEPT, vec![PromiseResult::Successful(b"\"rejected:frozen\"".to_vec())]);
        let r = value(d.on_spend_checked(id));
        assert_eq!((r.status.as_str(), r.reason.as_deref()), ("rejected", Some("frozen")));
        assert_eq!(d.reserved, 0);
    }

    #[test]
    #[should_panic(expected = "agent key only")]
    fn outsiders_cannot_request_purchase() {
        let mut d = dept();
        ctx("stranger.testnet");
        let _ = d.request_purchase("s".into(), "x402-evm".into(), "5".into(), "h".into(), "t1".into(), None, None);
    }

    #[test]
    #[should_panic(expected = "agent key only")]
    fn founder_cannot_request_purchase_directly() {
        let mut d = dept();
        ctx("founder.testnet");
        let _ = d.request_purchase("s".into(), "x402-evm".into(), "5".into(), "h".into(), "t1".into(), None, None);
    }

    #[test]
    #[should_panic(expected = "agent key only")]
    fn outsiders_cannot_create_bounties() {
        let mut d = dept();
        ctx("stranger.testnet");
        d.create_bounty("b".into(), "t".into(), "a".into(), "p".into(), "5".into(), "usdc".into(), None, "x402-evm".into(), "r".into(), "q".into());
    }

    #[test]
    fn only_company_manages_agent_keys_and_sellers() {
        let mut d = dept();
        let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
        ctx(COMPANY);
        let _ = d.add_agent_key(pk.clone(), "backend".into());
        let _ = d.remove_agent_key(pk.clone());
        ctx("founder.testnet");
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| d.add_agent_key(pk.clone(), "x".into()))).is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| d.allow_seller("x".into(), Some(SELLER_PAY.into())))).is_err());
    }

    #[test]
    #[should_panic(expected = "company only")]
    fn only_company_can_upgrade() {
        let mut d = dept();
        ctx("founder.testnet");
        let _ = d.upgrade();
    }
}
