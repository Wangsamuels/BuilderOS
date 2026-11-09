use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Keys {
    Companies,
    PendingRefunds,
}

const EVENT_STANDARD: &str = "builderos";
const EVENT_VERSION: &str = "1.0.0";

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

const COMPANY_WASM: &[u8] = include_bytes!("../../wasm/company.wasm");

/// company.wasm ≈ 670KB × 10^19 yocto/byte ≈ 6.7 NEAR; keep margin for account + state growth.
const MIN_CREATE_DEPOSIT: NearToken = NearToken::from_millinear(7_500);

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct CompanyMeta {
    pub company_id: AccountId,
    pub founder: AccountId,
    pub name: String,
    pub preset: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    registry_id: AccountId,
    mpc_signer: AccountId,
    worker_id: AccountId,
    verifier_id: AccountId,
    companies: LookupMap<String, CompanyMeta>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        registry_id: AccountId,
        mpc_signer: AccountId,
        worker_id: AccountId,
        verifier_id: AccountId,
    ) -> Self {
        Self {
            owner_id,
            registry_id,
            mpc_signer,
            worker_id,
            verifier_id,
            companies: LookupMap::new(Keys::Companies),
        }
    }

    #[payable]
    pub fn create_company(
        &mut self,
        slug: String,
        name: String,
        preset: String,
        daily_cap: String,
        preset_hash: Option<String>,
    ) -> Promise {
        let _ = preset_hash;
        require!(COMPANY_WASM.len() > 10_000, "company wasm missing — run contracts/build.sh");
        require!(
            slug.len() >= 2
                && slug.len() <= 32
                && slug
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "invalid slug"
        );
        require!(!self.companies.contains_key(&slug), "slug taken");
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_CREATE_DEPOSIT, "attach >= 7.5 NEAR (company wasm storage)");

        let founder = env::predecessor_account_id();
        let company_id: AccountId = format!("{}.{}", slug, env::current_account_id())
            .parse()
            .expect("invalid company id");

        self.companies.insert(
            slug.clone(),
            CompanyMeta {
                company_id: company_id.clone(),
                founder: founder.clone(),
                name: name.clone(),
                preset: preset.clone(),
            },
        );

        let init = near_sdk::serde_json::to_vec(&json!({
            "founder": founder,
            "name": name,
            "registry_id": self.registry_id,
            "worker_id": self.worker_id,
            "verifier_id": self.verifier_id,
            "mpc_signer": self.mpc_signer,
            "daily_cap": daily_cap,
        }))
        .unwrap();

        Promise::new(company_id.clone())
            .create_account()
            .transfer(deposit)
            // No full-access key for anyone: the company's own code (and its upgrade timelock) is
            // the only way to act for this account, so no single key can bypass the spending rules.
            .deploy_contract(COMPANY_WASM.to_vec())
            .function_call(
                "new".to_string(),
                init,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(80),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_company_created(slug, company_id, founder, name, preset, deposit),
            )
    }

    /// On failure: free the slug and refund `deposit` to the founder.
    /// Must NOT panic after `remove` — a panic rolls back state changes in this receipt
    /// (that was why "slug taken" stuck after LackBalanceForState).
    #[private]
    pub fn on_company_created(
        &mut self,
        slug: String,
        company_id: AccountId,
        founder: AccountId,
        name: String,
        preset: String,
        deposit: NearToken,
    ) -> Option<Promise> {
        // Read the result by hand: the init call returns nothing, and `#[callback_result] Result<Vec<u8>, _>`
        // tries to JSON-decode those empty bytes and panics ("EOF while parsing") on the *success* path.
        if Self::promise_failed() {
            self.companies.remove(&slug);
            emit(
                "company_create_failed",
                json!({
                    "slug": slug,
                    "company_id": company_id,
                    "founder": founder,
                    "refund_yocto": deposit.as_yoctonear().to_string(),
                }),
            );
            // The bounced deposit comes back to the factory as a separate refund receipt, which may
            // land after this callback. Only pay out now if the factory can cover it from free
            // balance; otherwise record it so the founder can `claim_refund` once it has arrived.
            // Must not panic: panic rolls back slug removal (caused "slug taken" after storage fails).
            if deposit.as_yoctonear() > 0 {
                if Self::free_balance() >= deposit.as_yoctonear() {
                    return Some(Promise::new(founder).transfer(deposit));
                }
                let mut pending = Self::pending_refunds();
                let owed = pending.get(&founder).copied().unwrap_or(0) + deposit.as_yoctonear();
                pending.insert(founder.clone(), owed);
                pending.flush();
                emit("refund_pending", json!({ "founder": founder, "amount_yocto": owed.to_string() }));
            }
            return None;
        }

        emit(
            "company_created",
            json!({
                "company_id": company_id,
                "founder": founder,
                "name": name,
                "preset": preset,
            }),
        );
        None
    }

    /// Lazily opened map (no field on the contract struct, so redeploying needs no state migration).
    fn pending_refunds() -> LookupMap<AccountId, u128> {
        LookupMap::new(Keys::PendingRefunds)
    }

    /// Balance not locked for this account's own storage, keeping 0.5 NEAR for gas/state headroom.
    fn free_balance() -> u128 {
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let headroom = NearToken::from_millinear(500).as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(storage + headroom)
    }

    pub fn get_pending_refund(&self, account_id: AccountId) -> String {
        Self::pending_refunds().get(&account_id).copied().unwrap_or(0).to_string()
    }

    /// Founder pulls a refund that couldn't be paid inside the failed-create callback.
    pub fn claim_refund(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let mut pending = Self::pending_refunds();
        let owed = pending.get(&who).copied().unwrap_or(0);
        require!(owed > 0, "nothing to refund");
        require!(Self::free_balance() >= owed, "refund not available yet, try again shortly");
        pending.remove(&who);
        pending.flush();
        emit("refund_claimed", json!({ "founder": who, "amount_yocto": owed.to_string() }));
        Promise::new(who).transfer(NearToken::from_yoctonear(owed))
    }

    fn promise_failed() -> bool {
        matches!(env::promise_result_checked(0, 16_384), Err(PromiseError::Failed))
    }

    pub fn get_company(&self, slug: String) -> Option<CompanyMeta> {
        self.companies.get(&slug).cloned()
    }

    pub fn get_config(
        &self,
    ) -> (
        AccountId,
        AccountId,
        AccountId,
        AccountId,
        AccountId,
    ) {
        (
            self.owner_id.clone(),
            self.registry_id.clone(),
            self.mpc_signer.clone(),
            self.worker_id.clone(),
            self.verifier_id.clone(),
        )
    }

    /// Owner: free a reserved slug after a failed create (pre-fix cleanup / ops).
    pub fn admin_clear_slug(&mut self, slug: String) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        self.companies.remove(&slug);
        emit("slug_cleared", json!({ "slug": slug }));
    }

    /// Owner: send NEAR from the factory (e.g. refund stuck create deposits).
    pub fn admin_transfer(&mut self, to: AccountId, amount: NearToken) -> Promise {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(amount.as_yoctonear() > 0, "amount > 0");
        Promise::new(to).transfer(amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_vm_config;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, balance_near: u128, results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id(acc("builderos-wang.testnet"))
            .predecessor_account_id(acc(predecessor))
            .account_balance(NearToken::from_near(balance_near))
            .build();
        testing_env!(context, test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    fn factory() -> Contract {
        ctx("builderos-wang.testnet", 20, vec![]);
        Contract::new(
            acc("builderos-wang.testnet"),
            acc("registry.builderos-wang.testnet"),
            acc("v1.signer-prod.testnet"),
            acc("worker.builderos-wang.testnet"),
            acc("verifier.builderos-wang.testnet"),
        )
    }

    fn fail_create(f: &mut Contract, balance_near: u128) -> Option<Promise> {
        f.companies.insert(
            "demo".into(),
            CompanyMeta { company_id: acc("demo.builderos-wang.testnet"), founder: acc("alice.testnet"), name: "D".into(), preset: "p".into() },
        );
        ctx("builderos-wang.testnet", balance_near, vec![PromiseResult::Failed]);
        f.on_company_created(
            "demo".into(),
            acc("demo.builderos-wang.testnet"),
            acc("alice.testnet"),
            "D".into(),
            "p".into(),
            NearToken::from_near(7),
        )
    }

    #[test]
    fn successful_create_keeps_slug_and_does_not_panic_on_empty_result() {
        let mut f = factory();
        f.companies.insert(
            "demo".into(),
            CompanyMeta { company_id: acc("demo.builderos-wang.testnet"), founder: acc("alice.testnet"), name: "D".into(), preset: "p".into() },
        );
        // `new` returns nothing: the promise result is empty bytes. This used to panic with "EOF while parsing".
        ctx("builderos-wang.testnet", 30, vec![PromiseResult::Successful(vec![])]);
        let r = f.on_company_created("demo".into(), acc("demo.builderos-wang.testnet"), acc("alice.testnet"), "D".into(), "p".into(), NearToken::from_near(7));
        assert!(r.is_none(), "no refund on success");
        assert!(f.get_company("demo".into()).is_some(), "slug stays registered");
    }

    #[test]
    fn failed_create_refunds_now_when_balance_allows() {
        let mut f = factory();
        assert!(fail_create(&mut f, 30).is_some());
        assert!(f.get_company("demo".into()).is_none(), "slug freed");
        assert_eq!(f.get_pending_refund(acc("alice.testnet")), "0");
    }

    #[test]
    fn failed_create_records_pending_refund_when_short() {
        let mut f = factory();
        // Storage of this tiny test state is near zero; 7 NEAR deposit > 5 NEAR balance - headroom.
        assert!(fail_create(&mut f, 5).is_none());
        assert!(f.get_company("demo".into()).is_none(), "slug freed even when refund is deferred");
        assert_eq!(f.get_pending_refund(acc("alice.testnet")), NearToken::from_near(7).as_yoctonear().to_string());

        ctx("alice.testnet", 5, vec![]);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.claim_refund()));
        assert!(early.is_err(), "can't claim before the bounced deposit arrives");

        ctx("alice.testnet", 20, vec![]);
        let _ = f.claim_refund();
        assert_eq!(f.get_pending_refund(acc("alice.testnet")), "0");
    }
}
