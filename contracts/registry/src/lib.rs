#![allow(clippy::too_many_arguments)]
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Keys {
    Sellers,
    SellersByService,
    Hireable,
    HireableByService,
}

const EVENT_STANDARD: &str = "builderos";
const EVENT_VERSION: &str = "1.0.0";

fn emit(event: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct Seller {
    pub seller_id: String,
    pub service: String,
    pub rail: String,
    pub pay_to: String,
    pub endpoint: String,
    pub quality_note: Option<String>,
    pub probe_url: Option<String>,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
#[borsh(crate = "near_sdk::borsh")]
pub struct HireableAgent {
    pub agent_id: String,
    pub service: String,
    pub description: String,
    pub skills: Vec<String>,
    pub rating: f64,
    pub rail: String,
    pub pay_to: String,
    pub endpoint: String,
    pub currency: String,
    pub price: String,
    pub quality_note: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    sellers: LookupMap<String, Seller>,
    sellers_by_service: LookupMap<String, Vec<String>>,
    hireable: LookupMap<String, HireableAgent>,
    hireable_by_service: LookupMap<String, Vec<String>>,
    models_hash: Option<String>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            sellers: LookupMap::new(Keys::Sellers),
            sellers_by_service: LookupMap::new(Keys::SellersByService),
            hireable: LookupMap::new(Keys::Hireable),
            hireable_by_service: LookupMap::new(Keys::HireableByService),
            models_hash: None,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    #[payable]
    pub fn add_seller(
        &mut self,
        seller_id: String,
        service: String,
        rail: String,
        pay_to: String,
        endpoint: String,
        quality_note: Option<String>,
        probe_url: Option<String>,
    ) {
        self.assert_owner();
        require!(
            env::attached_deposit() >= NearToken::from_millinear(10),
            "attach >= 0.01 NEAR"
        );
        let seller = Seller {
            seller_id: seller_id.clone(),
            service: service.clone(),
            rail,
            pay_to,
            endpoint,
            quality_note,
            probe_url,
        };
        self.sellers.insert(seller_id.clone(), seller);
        let mut ids = self.sellers_by_service.get(&service).cloned().unwrap_or_default();
        if !ids.contains(&seller_id) {
            ids.push(seller_id.clone());
        }
        self.sellers_by_service.insert(service, ids);
        emit(
            "policy_changed",
            serde_json::json!({ "new_hash": format!("seller:{}", seller_id) }),
        );
    }

    pub fn get_seller(&self, seller_id: String) -> Option<Seller> {
        self.sellers.get(&seller_id).cloned()
    }

    pub fn list_sellers(&self, service: String) -> Vec<Seller> {
        self.sellers_by_service
            .get(&service)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.sellers.get(&id).cloned())
            .collect()
    }

    #[payable]
    pub fn add_hireable_agent(
        &mut self,
        agent_id: String,
        service: String,
        description: String,
        skills: Vec<String>,
        rating: f64,
        rail: String,
        pay_to: String,
        endpoint: String,
        currency: String,
        price: String,
        quality_note: Option<String>,
    ) {
        self.assert_owner();
        require!(
            env::attached_deposit() >= NearToken::from_millinear(10),
            "attach >= 0.01 NEAR"
        );
        require!((0.0..=1.0).contains(&rating), "rating must be 0..1");
        require!(
            !price.is_empty() && price.chars().all(|c| c.is_ascii_digit()),
            "price must be integer string"
        );
        let agent = HireableAgent {
            agent_id: agent_id.clone(),
            service: service.clone(),
            description,
            skills,
            rating,
            rail,
            pay_to,
            endpoint,
            currency,
            price,
            quality_note,
        };
        self.hireable.insert(agent_id.clone(), agent);
        let mut ids = self.hireable_by_service.get(&service).cloned().unwrap_or_default();
        if !ids.contains(&agent_id) {
            ids.push(agent_id);
        }
        self.hireable_by_service.insert(service, ids);
    }

    pub fn get_hireable_agent(&self, agent_id: String) -> Option<HireableAgent> {
        self.hireable.get(&agent_id).cloned()
    }

    pub fn list_hireable_agents(&self, service: String) -> Vec<HireableAgent> {
        self.hireable_by_service
            .get(&service)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.hireable.get(&id).cloned())
            .collect()
    }

    pub fn set_models_hash(&mut self, hash: String) {
        self.assert_owner();
        let old = self.models_hash.clone();
        self.models_hash = Some(hash.clone());
        emit(
            "policy_changed",
            serde_json::json!({ "old_hash": old, "new_hash": hash }),
        );
    }

    pub fn get_models_hash(&self) -> Option<String> {
        self.models_hash.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}
