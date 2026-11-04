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
        require!(deposit >= NearToken::from_millinear(2500), "attach >= 2.5 NEAR");

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
            .add_full_access_key(env::signer_account_pk())
            .deploy_contract(COMPANY_WASM.to_vec())
            .function_call(
                "new".to_string(),
                init,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(80),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_company_created(slug, company_id, founder, name, preset),
            )
    }

    #[private]
    pub fn on_company_created(
        &mut self,
        slug: String,
        company_id: AccountId,
        founder: AccountId,
        name: String,
        preset: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.companies.remove(&slug);
            env::panic_str("company create failed");
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
}
