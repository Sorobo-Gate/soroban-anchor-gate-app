extern crate std;

use super::*;
use crate::types::{DisbursementCommitment, EscrowEntry, EscrowInitParams};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::Client as TokenClient,
    token::StellarAssetClient,
    vec, Address, BytesN, Env, Symbol, TryFromVal, Vec,
};

#[contract]
struct MockRateOracle;

#[contractimpl]
impl MockRateOracle {
    pub fn get_rate(env: Env, _token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("rate"))
            .unwrap()
    }
}

fn set_mock_rate(env: &Env, oracle: &Address, rate: i128) {
    env.as_contract(oracle, || {
        env.storage().instance().set(&symbol_short!("rate"), &rate);
    });
}

fn setup_test_env<'a>(
    env: &'a Env,
    initial_balance: i128,
) -> (
    EscrowGateClient<'a>,
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
    TokenClient<'a>,
    StellarAssetClient<'a>,
) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let payer = Address::generate(env);
    let beneficiary = Address::generate(env);
    let anchor_addr = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_client = TokenClient::new(env, &token_contract.address());
    let token_admin_client = StellarAssetClient::new(env, &token_contract.address());

    if initial_balance > 0 {
        token_admin_client.mint(&payer, &initial_balance);
    }

    let contract_id = env.register(EscrowGate, ());
    let client = EscrowGateClient::new(env, &contract_id);

    (
        client,
        contract_id,
        admin,
        treasury,
        payer,
        beneficiary,
        anchor_addr,
        token_client,
        token_admin_client,
    )
}

#[test]
fn test_init_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);

    let res = client.try_init(&admin, &treasury, &200);
    assert!(res.is_ok());

    // Verify instance storage reflects initialization parameters
    env.as_contract(&contract_id, || {
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        let stored_treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        let stored_fee: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        let stored_counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap();

        assert_eq!(stored_admin, admin);
        assert_eq!(stored_treasury, treasury);
        assert_eq!(stored_fee, 200);
        assert_eq!(stored_counter, 0);
    });
}

#[test]
fn test_init_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);

    assert!(client.try_init(&admin, &treasury, &200).is_ok());

    let res = client.try_init(&admin, &treasury, &100);
    assert_eq!(res, Err(Ok(EscrowError::AlreadyInitialized)));
}

#[test]
fn test_init_excessive_fee_bps_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);

    // Max allowable is 1000 bps (10%)
    let res = client.try_init(&admin, &treasury, &1001);
    assert_eq!(res, Err(Ok(EscrowError::InvalidBps)));

    let res_max = client.try_init(&admin, &treasury, &1000);
    assert!(res_max.is_ok());
}

#[test]
fn test_init_requires_auth() {
    let env = Env::default();
    let (client, _, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);

    // Calling init without mock_all_auths should verify admin authentication
    client.mock_all_auths().init(&admin, &treasury, &250);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin);
}

#[test]
fn test_create_escrow_uninitialized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, beneficiary, _, token_client, _) = setup_test_env(&env, 10_000);
    let profile_hash = BytesN::from_array(&env, &[1u8; 32]);

    let res = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &1_000,
        &profile_hash,
        &86400,
    );

    assert_eq!(res, Err(Ok(EscrowError::NotInitialized)));
}

#[test]
fn test_create_escrow_zero_or_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[2u8; 32]);

    let res_zero = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &0,
        &profile_hash,
        &86400,
    );
    assert_eq!(res_zero, Err(Ok(EscrowError::ZeroAmount)));

    let res_negative = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &-500,
        &profile_hash,
        &86400,
    );
    assert_eq!(res_negative, Err(Ok(EscrowError::ZeroAmount)));
}

#[test]
fn test_create_escrow_success_and_state_verification() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 50_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1_000_000);

    let profile_hash = BytesN::from_array(&env, &[3u8; 32]);
    let lock_duration = 3600u64;

    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &20_000,
        &profile_hash,
        &lock_duration,
    );

    assert_eq!(escrow_id, 1);
    assert_eq!(token_client.balance(&contract_id), 20_000);
    assert_eq!(token_client.balance(&payer), 30_000);

    // Verify record in persistent storage
    env.as_contract(&contract_id, || {
        let key = DataKey::Escrow(escrow_id);
        let record: EscrowRecord = env.storage().persistent().get(&key).unwrap();

        assert_eq!(record.payer, payer);
        assert_eq!(record.beneficiary, beneficiary);
        assert_eq!(record.token, token_client.address);
        assert_eq!(record.amount, 20_000);
        assert_eq!(record.profile_hash, profile_hash);
        assert_eq!(record.status, EscrowStatus::Funded);
        assert_eq!(record.unlock_timestamp, 1_000_000 + lock_duration);
    });
}

#[test]
fn test_create_escrow_counter_increments_deterministically() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &150);

    let profile_hash = BytesN::from_array(&env, &[4u8; 32]);

    let id1 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &1000,
    );
    let id2 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &1000,
    );
    let id3 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &1000,
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
}

#[test]
fn test_release_to_anchor_by_payer() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200); // 2% fee

    let profile_hash = BytesN::from_array(&env, &[5u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &5000,
    );

    // Release by payer
    let res = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert!(res.is_ok());

    // 2% of 10,000 = 200 to treasury, 9,800 to anchor
    assert_eq!(token_client.balance(&treasury), 200);
    assert_eq!(token_client.balance(&anchor_addr), 9_800);
    assert_eq!(token_client.balance(&contract_id), 0);

    // Verify record status Disbursed
    env.as_contract(&contract_id, || {
        let record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap();
        assert_eq!(record.status, EscrowStatus::Disbursed);
    });
}

#[test]
fn test_release_to_anchor_by_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[6u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &5000,
    );

    // Release by admin is authorized
    let res = client.try_release_to_anchor(&escrow_id, &admin, &anchor_addr);
    assert!(res.is_ok());

    assert_eq!(token_client.balance(&treasury), 200);
    assert_eq!(token_client.balance(&anchor_addr), 9_800);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_release_to_anchor_unauthorized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[7u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &5000,
    );

    let unauthorized_caller = Address::generate(&env);
    let res = client.try_release_to_anchor(&escrow_id, &unauthorized_caller, &anchor_addr);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_release_to_anchor_missing_escrow_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, _, anchor_addr, _, _) = setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    let res = client.try_release_to_anchor(&999, &payer, &anchor_addr);
    assert_eq!(res, Err(Ok(EscrowError::EscrowNotFound)));
}

#[test]
fn test_release_to_anchor_duplicate_release_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[8u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &5000,
    );

    assert!(client
        .try_release_to_anchor(&escrow_id, &payer, &anchor_addr)
        .is_ok());

    let res_second = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert_eq!(res_second, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_release_fee_math_zero_and_max_supported_bps() {
    let env = Env::default();
    env.mock_all_auths();

    // Zero fee (0 bps)
    {
        let (
            client,
            contract_id,
            admin,
            treasury,
            payer,
            beneficiary,
            anchor_addr,
            token_client,
            _,
        ) = setup_test_env(&env, 20_000);
        client.init(&admin, &treasury, &0);

        let profile_hash = BytesN::from_array(&env, &[9u8; 32]);
        let escrow_id = client.create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &10_000,
            &profile_hash,
            &5000,
        );

        client.release_to_anchor(&escrow_id, &payer, &anchor_addr);
        assert_eq!(token_client.balance(&treasury), 0);
        assert_eq!(token_client.balance(&anchor_addr), 10_000);
        assert_eq!(token_client.balance(&contract_id), 0);
    }

    // Max fee (1000 bps / 10%) with rounding check
    {
        let (
            client,
            contract_id,
            admin,
            treasury,
            payer,
            beneficiary,
            anchor_addr,
            token_client,
            _,
        ) = setup_test_env(&env, 20_000);
        client.init(&admin, &treasury, &1000);

        let profile_hash = BytesN::from_array(&env, &[10u8; 32]);
        // 9,999 stroops at 10% = 999 fee, 9,000 remainder
        let escrow_id = client.create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &9_999,
            &profile_hash,
            &5000,
        );

        client.release_to_anchor(&escrow_id, &payer, &anchor_addr);
        assert_eq!(token_client.balance(&treasury), 999);
        assert_eq!(token_client.balance(&anchor_addr), 9_000);
        assert_eq!(token_client.balance(&contract_id), 0);
    }
}

#[test]
fn test_refund_before_unlock_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 500);

    let profile_hash = BytesN::from_array(&env, &[11u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &1000, // unlock at 1500
    );

    // Attempt refund at timestamp 1499
    env.ledger().with_mut(|l| l.timestamp = 1499);
    let res = client.try_refund(&escrow_id);
    assert_eq!(res, Err(Ok(EscrowError::UnlockTimeNotReached)));
}

#[test]
fn test_refund_after_unlock_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let profile_hash = BytesN::from_array(&env, &[12u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500, // unlock at 1500
    );

    assert_eq!(token_client.balance(&payer), 10_000);
    assert_eq!(token_client.balance(&contract_id), 10_000);

    // Advance past unlock time
    env.ledger().with_mut(|l| l.timestamp = 1500);

    let res = client.try_refund(&escrow_id);
    assert!(res.is_ok());

    // 100% of amount returned to payer
    assert_eq!(token_client.balance(&payer), 20_000);
    assert_eq!(token_client.balance(&contract_id), 0);

    // Verify record status Refunded
    env.as_contract(&contract_id, || {
        let record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .unwrap();
        assert_eq!(record.status, EscrowStatus::Refunded);
    });
}

#[test]
fn test_refund_duplicate_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let profile_hash = BytesN::from_array(&env, &[13u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    assert!(client.try_refund(&escrow_id).is_ok());

    let res_second = client.try_refund(&escrow_id);
    assert_eq!(res_second, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_release_after_refund_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let profile_hash = BytesN::from_array(&env, &[14u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.refund(&escrow_id);

    let res = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert_eq!(res, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_refund_after_release_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let profile_hash = BytesN::from_array(&env, &[15u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    client.release_to_anchor(&escrow_id, &payer, &anchor_addr);

    // Advance timestamp past lock
    env.ledger().with_mut(|l| l.timestamp = 2000);

    let res = client.try_refund(&escrow_id);
    assert_eq!(res, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_event_schemas_emitted() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 30_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let profile_hash = BytesN::from_array(&env, &[16u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    // Inspect created event
    let events = env.events().all();
    let created_event = events
        .iter()
        .find(|e| {
            if e.0 != contract_id || e.1.len() != 2 {
                return false;
            }
            let topic: Result<Symbol, _> = Symbol::try_from_val(&env, &e.1.get(0).unwrap());
            topic == Ok(symbol_short!("created"))
        })
        .expect("created event not found");

    let event_escrow_id: u64 = u64::try_from_val(&env, &created_event.1.get(1).unwrap()).unwrap();
    assert_eq!(event_escrow_id, escrow_id);

    // Release to anchor and inspect disbursed event
    client.release_to_anchor(&escrow_id, &payer, &anchor_addr);

    let events = env.events().all();
    let disbursed_event = events
        .iter()
        .find(|e| {
            if e.0 != contract_id || e.1.len() != 2 {
                return false;
            }
            let topic: Result<Symbol, _> = Symbol::try_from_val(&env, &e.1.get(0).unwrap());
            topic == Ok(Symbol::new(&env, "disbursed"))
        })
        .expect("disbursed event not found");

    let disbursed_id: u64 = u64::try_from_val(&env, &disbursed_event.1.get(1).unwrap()).unwrap();
    assert_eq!(disbursed_id, escrow_id);

    // Create a second escrow to verify refunded event
    let escrow_id_2 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &200,
    );
    env.ledger().with_mut(|l| l.timestamp = 1300);
    client.refund(&escrow_id_2);

    let events = env.events().all();
    let refunded_event = events
        .iter()
        .find(|e| {
            if e.0 != contract_id || e.1.len() != 2 {
                return false;
            }
            let topic: Result<Symbol, _> = Symbol::try_from_val(&env, &e.1.get(0).unwrap());
            topic == Ok(Symbol::new(&env, "refunded"))
        })
        .expect("refunded event not found");

    let refunded_id: u64 = u64::try_from_val(&env, &refunded_event.1.get(1).unwrap()).unwrap();
    assert_eq!(refunded_id, escrow_id_2);
}

#[test]
fn test_create_escrow_overflow_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[16u8; 32]);

    // Test timestamp overflow: current_time (1000) + lock_duration (u64::MAX) overflows
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let res_overflow = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &u64::MAX,
    );
    assert_eq!(res_overflow, Err(Ok(EscrowError::ArithmeticOverflow)));
}

#[test]
fn test_whitelist_unauthorized_caller_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, _, _, token_client, _) = setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    let res = client.try_set_token_whitelist(&payer, &token_client.address, &true);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_whitelist_enforcement_and_unauthorized_token_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    // Create a second non-whitelisted token
    let other_token_admin = Address::generate(&env);
    let other_token_contract = env.register_stellar_asset_contract_v2(other_token_admin);
    let other_token_admin_client = StellarAssetClient::new(&env, &other_token_contract.address());
    let other_token_client = TokenClient::new(&env, &other_token_contract.address());
    other_token_admin_client.mint(&payer, &10_000);

    // Whitelist the primary token
    assert!(client.is_token_whitelisted(&token_client.address));
    client.set_token_whitelist(&admin, &token_client.address, &true);
    assert!(client.is_token_whitelisted(&token_client.address));
    assert!(!client.is_token_whitelisted(&other_token_client.address));

    let profile_hash = BytesN::from_array(&env, &[7u8; 32]);

    // Attempting escrow with non-whitelisted token must fail
    let res_rejected = client.try_create_escrow(
        &payer,
        &beneficiary,
        &other_token_client.address,
        &5_000,
        &profile_hash,
        &100,
    );
    assert_eq!(res_rejected, Err(Ok(EscrowError::TokenNotWhitelisted)));

    // Escrow with whitelisted token must succeed
    let res_ok = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &100,
    );
    assert!(res_ok.is_ok());
}

#[test]
fn test_resolve_dispute_unauthorized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[9u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &100,
    );

    // Non-admin cannot resolve dispute
    let res = client.try_resolve_dispute(&escrow_id, &payer, &5_000, &5_000);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_resolve_dispute_invalid_split_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[9u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &100,
    );

    // Splits that don't sum to 10_000 must fail
    let res_under = client.try_resolve_dispute(&escrow_id, &admin, &4_000, &5_000);
    assert_eq!(res_under, Err(Ok(EscrowError::InvalidDisputeSplit)));

    let res_over = client.try_resolve_dispute(&escrow_id, &admin, &6_000, &5_000);
    assert_eq!(res_over, Err(Ok(EscrowError::InvalidDisputeSplit)));
}

#[test]
fn test_resolve_dispute_success_split() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[12u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &100,
    );

    assert_eq!(token_client.balance(&payer), 0);
    assert_eq!(token_client.balance(&beneficiary), 0);
    assert_eq!(token_client.balance(&contract_id), 10_000);

    // Split 60% to payer (6000 bps) and 40% to beneficiary (4000 bps)
    let res = client.try_resolve_dispute(&escrow_id, &admin, &6_000, &4_000);
    assert!(res.is_ok());

    assert_eq!(token_client.balance(&payer), 6_000);
    assert_eq!(token_client.balance(&beneficiary), 4_000);
    assert_eq!(token_client.balance(&contract_id), 0);

    // Record should reflect Disputed status
    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.status, EscrowStatus::Disputed);

    // Further operations on disputed escrow must fail with InvalidStatus
    let res_dup = client.try_resolve_dispute(&escrow_id, &admin, &5_000, &5_000);
    assert_eq!(res_dup, Err(Ok(EscrowError::InvalidStatus)));
}

#[test]
fn test_getters_and_metadata() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &250);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_treasury(), treasury);
    assert_eq!(client.get_fee_bps(), 250);
    assert_eq!(client.get_counter(), 0);

    let profile_hash = BytesN::from_array(&env, &[25u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &500,
    );

    assert_eq!(client.get_counter(), 1);
    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.payer, payer);
    assert_eq!(record.beneficiary, beneficiary);
    assert_eq!(record.amount, 5_000);
    assert_eq!(record.status, EscrowStatus::Funded);
}

// ============================================================================
// Issue #70 — Beneficiary payout split to multiple bank-account commitments
// ============================================================================

fn commitment(env: &Env, recipient: &Address, amount: i128, tag: u8) -> DisbursementCommitment {
    DisbursementCommitment {
        recipient: recipient.clone(),
        amount,
        commitment_hash: BytesN::from_array(env, &[tag; 32]),
    }
}

/// Initializes the contract with `fee_bps` and funds a single escrow of `amount`.
fn setup_funded_escrow<'a>(
    env: &'a Env,
    fee_bps: u32,
    amount: i128,
) -> (
    EscrowGateClient<'a>,
    Address,
    Address,
    Address,
    Address,
    TokenClient<'a>,
    u64,
) {
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(env, amount);
    client.init(&admin, &treasury, &fee_bps);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &amount,
        &BytesN::from_array(env, &[42u8; 32]),
        &1_000,
    );
    (
        client,
        contract_id,
        admin,
        treasury,
        payer,
        token_client,
        escrow_id,
    )
}

#[test]
fn test_release_split_payout_and_anchor_fee_legs() {
    let env = Env::default();
    env.mock_all_auths();

    // 2% protocol fee: 10_000 -> 200 treasury, 9_800 distributable.
    let (client, contract_id, _, treasury, payer, token_client, escrow_id) =
        setup_funded_escrow(&env, 200, 10_000);

    let customer_bank = Address::generate(&env);
    let anchor_fee_account = Address::generate(&env);

    // 90% payout / 10% anchor fee of the distributable balance.
    let legs = vec![
        &env,
        commitment(&env, &customer_bank, 8_820, 1),
        commitment(&env, &anchor_fee_account, 980, 2),
    ];
    client.release_split(&escrow_id, &payer, &legs);

    assert_eq!(token_client.balance(&treasury), 200);
    assert_eq!(token_client.balance(&customer_bank), 8_820);
    assert_eq!(token_client.balance(&anchor_fee_account), 980);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(
        client.get_escrow(&escrow_id).status,
        EscrowStatus::Disbursed
    );
}

#[test]
fn test_release_split_zero_fee_multi_leg() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, _, treasury, payer, token_client, escrow_id) =
        setup_funded_escrow(&env, 0, 9_000);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let legs = vec![
        &env,
        commitment(&env, &a, 3_000, 1),
        commitment(&env, &b, 5_999, 2),
        commitment(&env, &c, 1, 3),
    ];
    client.release_split(&escrow_id, &payer, &legs);

    assert_eq!(token_client.balance(&treasury), 0);
    assert_eq!(token_client.balance(&a), 3_000);
    assert_eq!(token_client.balance(&b), 5_999);
    assert_eq!(token_client.balance(&c), 1);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_release_split_same_recipient_multiple_commitments() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, token_client, escrow_id) = setup_funded_escrow(&env, 0, 1_000);

    // One anchor wallet can settle several distinct bank commitments.
    let anchor = Address::generate(&env);
    let legs = vec![
        &env,
        commitment(&env, &anchor, 400, 1),
        commitment(&env, &anchor, 600, 2),
    ];
    client.release_split(&escrow_id, &payer, &legs);
    assert_eq!(token_client.balance(&anchor), 1_000);
}

#[test]
fn test_release_split_by_admin() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, _, _, token_client, escrow_id) = setup_funded_escrow(&env, 100, 10_000);

    let recipient = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &recipient, 9_900, 1)];
    client.release_split(&escrow_id, &admin, &legs);
    assert_eq!(token_client.balance(&recipient), 9_900);
}

#[test]
fn test_release_split_requires_caller_auth() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, 1_000);
    let recipient = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &recipient, 1_000, 1)];
    client.release_split(&escrow_id, &payer, &legs);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, payer);
}

#[test]
fn test_release_split_unauthorized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, _, _, escrow_id) = setup_funded_escrow(&env, 0, 1_000);
    let stranger = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &stranger, 1_000, 1)];

    let res = client.try_release_split(&escrow_id, &stranger, &legs);
    assert_eq!(res, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_release_split_missing_escrow_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, _) = setup_funded_escrow(&env, 0, 1_000);
    let recipient = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &recipient, 1_000, 1)];

    let res = client.try_release_split(&999, &payer, &legs);
    assert_eq!(res, Err(Ok(EscrowError::EscrowNotFound)));
}

#[test]
fn test_release_split_uninitialized_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, _, _, _) = setup_test_env(&env, 0);
    let recipient = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &recipient, 1_000, 1)];

    let res = client.try_release_split(&1, &payer, &legs);
    assert_eq!(res, Err(Ok(EscrowError::NotInitialized)));
}

#[test]
fn test_release_split_empty_commitments_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, 1_000);
    let legs: Vec<DisbursementCommitment> = Vec::new(&env);

    let res = client.try_release_split(&escrow_id, &payer, &legs);
    assert_eq!(res, Err(Ok(EscrowError::EmptyDisbursement)));
}

#[test]
fn test_release_split_max_commitments_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let max = MAX_DISBURSEMENT_COMMITMENTS as i128;

    // MAX + 1 legs is rejected.
    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, (max + 1) * 100);
    let mut too_many = Vec::new(&env);
    for i in 0..(max + 1) {
        too_many.push_back(commitment(&env, &Address::generate(&env), 100, i as u8));
    }
    let res = client.try_release_split(&escrow_id, &payer, &too_many);
    assert_eq!(res, Err(Ok(EscrowError::TooManyDisbursements)));

    // Exactly MAX legs succeeds.
    let env2 = Env::default();
    env2.mock_all_auths();
    let (client2, contract_id2, _, _, payer2, token2, escrow_id2) =
        setup_funded_escrow(&env2, 0, max * 100);
    let mut exactly_max = Vec::new(&env2);
    for i in 0..max {
        exactly_max.push_back(commitment(&env2, &Address::generate(&env2), 100, i as u8));
    }
    client2.release_split(&escrow_id2, &payer2, &exactly_max);
    assert_eq!(token2.balance(&contract_id2), 0);
}

#[test]
fn test_release_split_zero_or_negative_leg_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, 1_000);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let zero_leg = vec![
        &env,
        commitment(&env, &a, 1_000, 1),
        commitment(&env, &b, 0, 2),
    ];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &zero_leg),
        Err(Ok(EscrowError::InvalidDisbursementAmount))
    );

    // A negative leg that "balances" an over-allocated leg must not slip through.
    let negative_leg = vec![
        &env,
        commitment(&env, &a, 1_500, 1),
        commitment(&env, &b, -500, 2),
    ];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &negative_leg),
        Err(Ok(EscrowError::InvalidDisbursementAmount))
    );
}

#[test]
fn test_release_split_total_mismatch_rejected_and_state_untouched() {
    let env = Env::default();
    env.mock_all_auths();

    // 1% fee: 10_000 -> 100 fee, 9_900 distributable.
    let (client, contract_id, _, treasury, payer, token_client, escrow_id) =
        setup_funded_escrow(&env, 100, 10_000);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    // Under-allocation by one stroop.
    let under = vec![
        &env,
        commitment(&env, &a, 9_000, 1),
        commitment(&env, &b, 899, 2),
    ];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &under),
        Err(Ok(EscrowError::DisbursementMismatch))
    );

    // Over-allocation by one stroop.
    let over = vec![
        &env,
        commitment(&env, &a, 9_000, 1),
        commitment(&env, &b, 901, 2),
    ];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &over),
        Err(Ok(EscrowError::DisbursementMismatch))
    );

    // Full gross amount ignores the protocol fee and is therefore a mismatch.
    let gross = vec![&env, commitment(&env, &a, 10_000, 1)];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &gross),
        Err(Ok(EscrowError::DisbursementMismatch))
    );

    // No funds moved, escrow still funded and still releasable.
    assert_eq!(token_client.balance(&contract_id), 10_000);
    assert_eq!(token_client.balance(&treasury), 0);
    assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Funded);

    let exact = vec![&env, commitment(&env, &a, 9_900, 1)];
    client.release_split(&escrow_id, &payer, &exact);
    assert_eq!(token_client.balance(&a), 9_900);
}

#[test]
fn test_release_split_sum_overflow_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, 1_000);
    let a = Address::generate(&env);
    let legs = vec![
        &env,
        commitment(&env, &a, i128::MAX, 1),
        commitment(&env, &a, 1, 2),
    ];
    assert_eq!(
        client.try_release_split(&escrow_id, &payer, &legs),
        Err(Ok(EscrowError::ArithmeticOverflow))
    );
}

#[test]
fn test_release_split_terminal_state_transitions_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor, token_client, _) =
        setup_test_env(&env, 30_000);
    client.init(&admin, &treasury, &0);
    let hash = BytesN::from_array(&env, &[7u8; 32]);
    let recipient = Address::generate(&env);
    let legs = vec![&env, commitment(&env, &recipient, 10_000, 1)];

    // Split -> split / release / refund all rejected.
    let id1 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &0,
    );
    client.release_split(&id1, &payer, &legs);
    assert_eq!(
        client.try_release_split(&id1, &payer, &legs),
        Err(Ok(EscrowError::InvalidStatus))
    );
    assert_eq!(
        client.try_release_to_anchor(&id1, &payer, &anchor),
        Err(Ok(EscrowError::InvalidStatus))
    );
    assert_eq!(client.try_refund(&id1), Err(Ok(EscrowError::InvalidStatus)));

    // Release -> split rejected.
    let id2 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &0,
    );
    client.release_to_anchor(&id2, &payer, &anchor);
    assert_eq!(
        client.try_release_split(&id2, &payer, &legs),
        Err(Ok(EscrowError::InvalidStatus))
    );

    // Refund -> split rejected.
    let id3 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &0,
    );
    client.refund(&id3);
    assert_eq!(
        client.try_release_split(&id3, &payer, &legs),
        Err(Ok(EscrowError::InvalidStatus))
    );
}

#[test]
fn test_release_split_emits_per_leg_tracking_events() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, contract_id, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 200, 10_000);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let legs = vec![
        &env,
        commitment(&env, &a, 5_000, 0xA1),
        commitment(&env, &b, 3_800, 0xB2),
        commitment(&env, &c, 1_000, 0xC3),
    ];
    client.release_split(&escrow_id, &payer, &legs);

    let split_topic = Symbol::new(&env, "split_disb");
    let events = env.events().all();
    let split_events: std::vec::Vec<_> = events
        .iter()
        .filter(|e| {
            e.0 == contract_id
                && e.1.len() == 3
                && Symbol::try_from_val(&env, &e.1.get(0).unwrap()) == Ok(split_topic.clone())
        })
        .collect();
    assert_eq!(split_events.len(), 3);

    for (expected_index, event) in split_events.iter().enumerate() {
        let id: u64 = u64::try_from_val(&env, &event.1.get(1).unwrap()).unwrap();
        let index: u32 = u32::try_from_val(&env, &event.1.get(2).unwrap()).unwrap();
        let (recipient, amount, hash): (Address, i128, BytesN<32>) =
            <(Address, i128, BytesN<32>)>::try_from_val(&env, &event.2).unwrap();

        let expected = legs.get(expected_index as u32).unwrap();
        assert_eq!(id, escrow_id);
        assert_eq!(index, expected_index as u32);
        assert_eq!(recipient, expected.recipient);
        assert_eq!(amount, expected.amount);
        assert_eq!(hash, expected.commitment_hash);
    }

    // Summary event remains compatible with existing `disbursed` indexers.
    let disbursed = events
        .iter()
        .find(|e| {
            e.0 == contract_id
                && e.1.len() == 2
                && Symbol::try_from_val(&env, &e.1.get(0).unwrap())
                    == Ok(Symbol::new(&env, "disbursed"))
        })
        .expect("summary disbursed event not found");
    let (profile_hash, total): (BytesN<32>, i128) =
        <(BytesN<32>, i128)>::try_from_val(&env, &disbursed.2).unwrap();
    assert_eq!(profile_hash, BytesN::from_array(&env, &[42u8; 32]));
    assert_eq!(total, 9_800);
}

// ============================================================================
// Issue #72 — Paginated, immutable audit-trail export
// ============================================================================

/// Initializes the contract and creates `count` escrows of 100 units each.
fn setup_many_escrows(env: &Env, count: u64) -> (EscrowGateClient<'_>, Address, Address) {
    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(env, (count as i128) * 100);
    client.init(&admin, &treasury, &0);
    for i in 0..count {
        client.create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &100,
            &BytesN::from_array(env, &[(i % 256) as u8; 32]),
            &0,
        );
    }
    (client, admin, payer)
}

fn page_ids(page: &Vec<EscrowEntry>) -> std::vec::Vec<u64> {
    page.iter().map(|e| e.escrow_id).collect()
}

#[test]
fn test_paginated_uninitialized_and_empty_contract() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);
    assert_eq!(client.get_escrows_paginated(&1, &10).len(), 0);

    client.init(&admin, &treasury, &0);
    assert_eq!(client.get_escrows_paginated(&1, &10).len(), 0);
    assert_eq!(client.get_escrows_paginated(&0, &50).len(), 0);
}

#[test]
fn test_paginated_first_page_matches_get_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _) = setup_many_escrows(&env, 5);
    let page = client.get_escrows_paginated(&1, &3);
    assert_eq!(page_ids(&page), std::vec![1, 2, 3]);
    for entry in page.iter() {
        assert_eq!(entry.record, client.get_escrow(&entry.escrow_id));
    }
}

#[test]
fn test_paginated_start_zero_treated_as_first_id() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _) = setup_many_escrows(&env, 3);
    assert_eq!(
        client.get_escrows_paginated(&0, &10),
        client.get_escrows_paginated(&1, &10)
    );
    assert_eq!(
        page_ids(&client.get_escrows_paginated(&0, &10)),
        std::vec![1, 2, 3]
    );
}

#[test]
fn test_paginated_zero_limit_returns_empty() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _) = setup_many_escrows(&env, 3);
    assert_eq!(client.get_escrows_paginated(&1, &0).len(), 0);
}

#[test]
fn test_paginated_tail_and_out_of_range_boundaries() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _) = setup_many_escrows(&env, 5);
    // Page straddling the end is truncated, not padded.
    assert_eq!(
        page_ids(&client.get_escrows_paginated(&4, &10)),
        std::vec![4, 5]
    );
    // start_id == counter yields exactly the last escrow.
    assert_eq!(
        page_ids(&client.get_escrows_paginated(&5, &10)),
        std::vec![5]
    );
    // start_id beyond counter yields an empty page.
    assert_eq!(client.get_escrows_paginated(&6, &10).len(), 0);
    // Extreme inputs never panic or overflow.
    assert_eq!(client.get_escrows_paginated(&u64::MAX, &u32::MAX).len(), 0);
}

#[test]
fn test_paginated_limit_clamped_to_hard_maximum() {
    let env = Env::default();
    env.mock_all_auths();

    let total = (MAX_PAGE_SIZE as u64) + 10;
    let (client, _, _) = setup_many_escrows(&env, total);

    let page = client.get_escrows_paginated(&1, &u32::MAX);
    assert_eq!(page.len(), MAX_PAGE_SIZE);
    assert_eq!(page.first().unwrap().escrow_id, 1);
    assert_eq!(page.last().unwrap().escrow_id, MAX_PAGE_SIZE as u64);

    let exactly_max = client.get_escrows_paginated(&1, &MAX_PAGE_SIZE);
    assert_eq!(exactly_max.len(), MAX_PAGE_SIZE);

    let over_max = client.get_escrows_paginated(&1, &(MAX_PAGE_SIZE + 1));
    assert_eq!(over_max.len(), MAX_PAGE_SIZE);
}

#[test]
fn test_paginated_full_traversal_is_contiguous_and_complete() {
    let env = Env::default();
    env.mock_all_auths();

    let total = 23u64;
    let (client, _, _) = setup_many_escrows(&env, total);

    let mut seen = std::vec::Vec::new();
    let mut cursor = 1u64;
    let mut pages = 0;
    loop {
        let page = client.get_escrows_paginated(&cursor, &7);
        if page.is_empty() {
            break;
        }
        pages += 1;
        cursor = page.last().unwrap().escrow_id + 1;
        seen.extend(page_ids(&page));
    }

    assert_eq!(pages, 4); // 7 + 7 + 7 + 2
    assert_eq!(seen, (1..=total).collect::<std::vec::Vec<u64>>());
}

#[test]
fn test_paginated_reflects_lifecycle_transitions() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, payer) = setup_many_escrows(&env, 3);
    let anchor = Address::generate(&env);
    client.release_to_anchor(&1, &payer, &anchor);
    client.refund(&2);

    let page = client.get_escrows_paginated(&1, &3);
    assert_eq!(page.get(0).unwrap().record.status, EscrowStatus::Disbursed);
    assert_eq!(page.get(1).unwrap().record.status, EscrowStatus::Refunded);
    assert_eq!(page.get(2).unwrap().record.status, EscrowStatus::Funded);
}

#[test]
fn test_paginated_query_is_read_only() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, _) = setup_many_escrows(&env, 2);
    let before_counter = client.get_counter();
    let before = client.get_escrows_paginated(&1, &2);

    let _ = client.get_escrows_paginated(&1, &50);
    assert_eq!(client.get_counter(), before_counter);
    assert_eq!(client.get_escrows_paginated(&1, &2), before);
    // No auth is required for the audit read path.
    let _ = client.get_escrows_paginated(&1, &2);
    assert_eq!(env.auths().len(), 0);
}

// ============================================================================
// Issue #71 — Gas profiling harness (Soroban budget metering)
// ============================================================================
//
// Every top-level contract invocation resets the host budget, so reading
// `env.cost_estimate().budget()` immediately after a client call yields the
// CPU instructions and memory bytes metered for exactly that invocation
// (including nested SAC token transfers and auth checks).
//
// Reproduce the table in `docs/gas-benchmarks.md` with:
//   cargo test gas_benchmark -- --nocapture --test-threads=1

/// Stellar mainnet per-transaction CPU instruction limit (Protocol 22).
const MAINNET_TX_MAX_CPU_INSTRUCTIONS: u64 = 100_000_000;
/// Stellar mainnet per-transaction memory limit (Protocol 22): 40 MiB.
const MAINNET_TX_MAX_MEMORY_BYTES: u64 = 41_943_040;
/// "Comfortable" headroom target: every entrypoint must stay below this share
/// of the mainnet limits even in its worst-case payload configuration, leaving
/// room for the Wasm VM instantiation overhead that native test registration
/// does not meter.
const COMFORT_MARGIN_PERCENT: u64 = 25;

struct GasSample {
    entrypoint: &'static str,
    payload: std::string::String,
    cpu: u64,
    mem: u64,
}

/// Captures the budget of the invocation that just completed and asserts it
/// fits within the mainnet limits with the required headroom.
fn record_gas(env: &Env, entrypoint: &'static str, payload: &str) -> GasSample {
    let budget = env.cost_estimate().budget();
    let sample = GasSample {
        entrypoint,
        payload: payload.into(),
        cpu: budget.cpu_instruction_cost(),
        mem: budget.memory_bytes_cost(),
    };

    assert!(sample.cpu > 0, "{entrypoint}: CPU metering returned zero");
    assert!(
        sample.mem > 0,
        "{entrypoint}: memory metering returned zero"
    );
    assert!(
        sample.cpu * 100 <= MAINNET_TX_MAX_CPU_INSTRUCTIONS * COMFORT_MARGIN_PERCENT,
        "{entrypoint} ({payload}): {} CPU instructions exceeds {COMFORT_MARGIN_PERCENT}% of mainnet limit",
        sample.cpu
    );
    assert!(
        sample.mem * 100 <= MAINNET_TX_MAX_MEMORY_BYTES * COMFORT_MARGIN_PERCENT,
        "{entrypoint} ({payload}): {} memory bytes exceeds {COMFORT_MARGIN_PERCENT}% of mainnet limit",
        sample.mem
    );
    sample
}

fn print_gas_table(title: &str, samples: &[GasSample]) {
    std::println!("\n### {title}\n");
    std::println!(
        "| Entrypoint | Payload | CPU Instructions | Memory (Bytes) | % CPU Limit | % Mem Limit |"
    );
    std::println!("| :--- | :--- | ---: | ---: | ---: | ---: |");
    for s in samples {
        std::println!(
            "| `{}` | {} | {} | {} | {:.3}% | {:.3}% |",
            s.entrypoint,
            s.payload,
            s.cpu,
            s.mem,
            (s.cpu as f64) * 100.0 / (MAINNET_TX_MAX_CPU_INSTRUCTIONS as f64),
            (s.mem as f64) * 100.0 / (MAINNET_TX_MAX_MEMORY_BYTES as f64),
        );
    }
}

#[test]
fn test_gas_benchmark_metering_resets_per_invocation() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, _, _, _, _, _) = setup_test_env(&env, 0);

    client.init(&admin, &treasury, &200);
    let init_cpu = env.cost_estimate().budget().cpu_instruction_cost();

    // A trivial getter must cost far less than `init`, proving the budget is
    // scoped to the most recent invocation rather than cumulative.
    client.get_fee_bps();
    let getter_cpu = env.cost_estimate().budget().cpu_instruction_cost();
    assert!(getter_cpu > 0);
    assert!(getter_cpu < init_cpu);
}

#[test]
fn test_gas_benchmark_core_lifecycle_entrypoints() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, anchor, token_client, token_admin) =
        setup_test_env(&env, 1_000_000);
    let hash = BytesN::from_array(&env, &[9u8; 32]);
    let mut samples = std::vec::Vec::new();

    client.init(&admin, &treasury, &200);
    samples.push(record_gas(&env, "init", "fee_bps=200"));

    client.set_token_whitelist(&admin, &token_client.address, &true);
    samples.push(record_gas(&env, "set_token_whitelist", "1 token"));

    client.is_token_whitelisted(&token_client.address);
    samples.push(record_gas(&env, "is_token_whitelisted", "whitelist active"));

    let id_release = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &100,
    );
    samples.push(record_gas(&env, "create_escrow", "whitelisted token"));

    client.release_to_anchor(&id_release, &payer, &anchor);
    samples.push(record_gas(&env, "release_to_anchor", "fee + payout"));

    let id_refund = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &100,
    );
    env.ledger().with_mut(|l| l.timestamp += 200);
    client.refund(&id_refund);
    samples.push(record_gas(&env, "refund", "after unlock"));

    let id_dispute = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &hash,
        &100,
    );
    client.resolve_dispute(&id_dispute, &admin, &4_000, &6_000);
    samples.push(record_gas(&env, "resolve_dispute", "40/60 split"));

    client.get_escrow(&id_dispute);
    samples.push(record_gas(&env, "get_escrow", "1 record"));

    client.get_counter();
    samples.push(record_gas(&env, "get_counter", "-"));
    client.get_admin();
    samples.push(record_gas(&env, "get_admin", "-"));
    client.get_treasury();
    samples.push(record_gas(&env, "get_treasury", "-"));
    client.get_fee_bps();
    samples.push(record_gas(&env, "get_fee_bps", "-"));

    // Keep the token admin alive for the whole benchmark environment.
    let _ = token_admin;
    print_gas_table("Core lifecycle entrypoints", &samples);
}

#[test]
fn test_gas_benchmark_release_split_scaling() {
    let mut samples = std::vec::Vec::new();
    let mut previous_cpu = 0u64;

    for legs in [1u32, 2, 5, MAX_DISBURSEMENT_COMMITMENTS] {
        let env = Env::default();
        env.mock_all_auths();
        let amount = (legs as i128) * 1_000;
        let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 0, amount);

        let mut commitments = Vec::new(&env);
        for i in 0..legs {
            commitments.push_back(commitment(&env, &Address::generate(&env), 1_000, i as u8));
        }
        client.release_split(&escrow_id, &payer, &commitments);
        let sample = record_gas(
            &env,
            "release_split",
            &std::format!("legs={legs}, fee_bps=0"),
        );

        // Cost must grow with payload size: each leg adds a transfer + event.
        assert!(
            sample.cpu > previous_cpu,
            "release_split CPU did not scale with leg count"
        );
        previous_cpu = sample.cpu;
        samples.push(sample);
    }

    // Worst case with an additional treasury fee transfer.
    let env = Env::default();
    env.mock_all_auths();
    let legs = MAX_DISBURSEMENT_COMMITMENTS;
    let (client, _, _, _, payer, _, escrow_id) = setup_funded_escrow(&env, 1_000, 100_000);
    let mut commitments = Vec::new(&env);
    for i in 0..legs {
        commitments.push_back(commitment(&env, &Address::generate(&env), 9_000, i as u8));
    }
    client.release_split(&escrow_id, &payer, &commitments);
    samples.push(record_gas(
        &env,
        "release_split",
        &std::format!("legs={legs}, fee_bps=1000 (worst case)"),
    ));

    print_gas_table("release_split payload scaling", &samples);
}

#[test]
fn test_gas_benchmark_paginated_query_scaling() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, _) = setup_many_escrows(&env, MAX_PAGE_SIZE as u64);
    let mut samples = std::vec::Vec::new();
    let mut previous_cpu = 0u64;

    for limit in [1u32, 10, 25, MAX_PAGE_SIZE] {
        let page = client.get_escrows_paginated(&1, &limit);
        assert_eq!(page.len(), limit);
        let sample = record_gas(
            &env,
            "get_escrows_paginated",
            &std::format!("limit={limit}"),
        );
        assert!(
            sample.cpu > previous_cpu,
            "pagination CPU did not scale with page size"
        );
        previous_cpu = sample.cpu;
        samples.push(sample);
    }

    // Oversized request is clamped, so it must cost no more than a max page.
    let max_page_cpu = previous_cpu;
    client.get_escrows_paginated(&1, &u32::MAX);
    let clamped = record_gas(
        &env,
        "get_escrows_paginated",
        "limit=u32::MAX (clamped to 50)",
    );
    assert!(clamped.cpu <= max_page_cpu + max_page_cpu / 100);
    samples.push(clamped);

    print_gas_table("get_escrows_paginated payload scaling", &samples);
}

// =========================================================================
// Issue 51: Clawback-Aware Token Compatibility Layer Tests
// =========================================================================

#[test]
fn test_clawback_flag_management_and_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, _, _, token_client, _) = setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    // Initial state: clawback tokens allowed, token clawback flag is false
    assert!(client.is_allow_clawback_tokens());
    assert!(!client.is_token_clawback_enabled(&token_client.address));

    // Admin sets clawback flag
    assert!(client
        .try_set_token_clawback_flag(&admin, &token_client.address, &true)
        .is_ok());
    assert!(client.is_token_clawback_enabled(&token_client.address));

    // Non-admin cannot set clawback flag
    let err = client.try_set_token_clawback_flag(&payer, &token_client.address, &false);
    assert_eq!(err, Err(Ok(EscrowError::Unauthorized)));

    // Admin toggles allow_clawback_tokens
    assert!(client.try_set_allow_clawback_tokens(&admin, &false).is_ok());
    assert!(!client.is_allow_clawback_tokens());

    // Non-admin cannot toggle allow_clawback_tokens
    let err_allow = client.try_set_allow_clawback_tokens(&payer, &true);
    assert_eq!(err_allow, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_clawback_disallowed_token_rejected_in_create_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 10_000);
    client.init(&admin, &treasury, &200);

    // Mark token as having clawback enabled
    client.set_token_clawback_flag(&admin, &token_client.address, &true);

    // Protocol disallows clawback-enabled tokens
    client.set_allow_clawback_tokens(&admin, &false);

    let profile_hash = BytesN::from_array(&env, &[11u8; 32]);
    let res = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &1000,
    );
    assert_eq!(res, Err(Ok(EscrowError::ClawbackNotAllowed)));

    // Re-enable clawback tokens allowed
    client.set_allow_clawback_tokens(&admin, &true);
    let res_ok = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &1000,
    );
    assert!(res_ok.is_ok());
}

#[test]
fn test_handle_clawback_adjusts_record_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[12u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &1000,
    );

    // Partial clawback: 3,000 clawed back
    let res = client.try_handle_clawback(&escrow_id, &3_000);
    assert!(res.is_ok());

    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.amount, 7_000);
    assert_eq!(record.status, EscrowStatus::Funded);

    // Full remaining clawback: 7,000 clawed back
    let res_full = client.try_handle_clawback(&escrow_id, &7_000);
    assert!(res_full.is_ok());

    let record_after = client.get_escrow(&escrow_id);
    assert_eq!(record_after.amount, 0);
    assert_eq!(record_after.status, EscrowStatus::Refunded);

    // Attempting clawback on terminal status returns InvalidStatus
    let res_terminal = client.try_handle_clawback(&escrow_id, &1_000);
    assert_eq!(res_terminal, Err(Ok(EscrowError::InvalidStatus)));

    // Zero amount returns ZeroAmount
    let res_zero = client.try_handle_clawback(&escrow_id, &0);
    assert_eq!(res_zero, Err(Ok(EscrowError::ZeroAmount)));
}

#[test]
fn test_sync_clawback_with_external_sac_clawback() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[13u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &1000,
    );

    // Simulate external clawback from contract balance:
    env.as_contract(&contract_id, || {
        token_client.transfer(&contract_id, &admin, &2_500);
    });
    assert_eq!(token_client.balance(&contract_id), 7_500);

    // Contract syncs the clawback discrepancy
    let deficit = client.sync_clawback(&escrow_id);
    assert_eq!(deficit, 2_500);

    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.amount, 7_500);

    // Second sync with no new clawback returns 0
    let deficit_zero = client.sync_clawback(&escrow_id);
    assert_eq!(deficit_zero, 0);
}

#[test]
fn test_release_to_anchor_graceful_clawback_handling() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, _, anchor_addr, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200); // 2% fee

    let profile_hash = BytesN::from_array(&env, &[14u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &Address::generate(&env),
        &token_client.address,
        &10_000,
        &profile_hash,
        &1000,
    );

    // Simulate external clawback of 4,000 from contract
    env.as_contract(&contract_id, || {
        token_client.transfer(&contract_id, &admin, &4_000);
    });
    assert_eq!(token_client.balance(&contract_id), 6_000);

    // release_to_anchor succeeds gracefully!
    // Distributable balance is 6,000. 2% fee = 120, anchor payout = 5,880.
    let res = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert!(res.is_ok());

    assert_eq!(token_client.balance(&treasury), 120);
    assert_eq!(token_client.balance(&anchor_addr), 5_880);
    assert_eq!(token_client.balance(&contract_id), 0);

    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.status, EscrowStatus::Disbursed);
}

#[test]
fn test_claim_refund_graceful_clawback_handling() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, _, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[15u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &Address::generate(&env),
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    // Simulate external clawback of 3,500
    env.as_contract(&contract_id, || {
        token_client.transfer(&contract_id, &admin, &3_500);
    });

    env.ledger().with_mut(|l| l.timestamp = 2_000);

    let payer_balance_before = token_client.balance(&payer);
    let res = client.try_claim_refund(&escrow_id, &payer);
    assert!(res.is_ok());

    // Payer receives remaining 6,500
    assert_eq!(token_client.balance(&payer), payer_balance_before + 6_500);
    assert_eq!(token_client.balance(&contract_id), 0);
}

// =========================================================================
// Issue 52: Decentralized Keeper Incentives Tests
// =========================================================================

#[test]
fn test_keeper_bounty_bps_settings() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, _, _, _, _) = setup_test_env(&env, 0);
    client.init(&admin, &treasury, &200);

    // Default keeper bounty is 0 bps
    assert_eq!(client.get_keeper_bounty_bps(), 0);

    // Admin configures 20 bps (0.20%)
    assert!(client.try_set_keeper_bounty_bps(&admin, &20).is_ok());
    assert_eq!(client.get_keeper_bounty_bps(), 20);

    // Non-admin setting bounty is rejected
    let res_unauth = client.try_set_keeper_bounty_bps(&payer, &25);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));

    // Exceeding maximum allowed 1000 bps is rejected
    let res_excess = client.try_set_keeper_bounty_bps(&admin, &1001);
    assert_eq!(res_excess, Err(Ok(EscrowError::InvalidBps)));
}

#[test]
fn test_keeper_claim_refund_allocates_bounty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 200_000);
    client.init(&admin, &treasury, &200);

    // 20 bps = 0.20% keeper bounty
    client.set_keeper_bounty_bps(&admin, &20);

    let profile_hash = BytesN::from_array(&env, &[16u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &100_000,
        &profile_hash,
        &1_000,
    );

    let keeper = Address::generate(&env);
    assert_eq!(token_client.balance(&keeper), 0);
    let payer_balance_before = token_client.balance(&payer);

    // Advance time past lock duration
    env.ledger().with_mut(|l| l.timestamp = 2_000);

    // Keeper executes refund liquidation
    let res = client.try_claim_refund(&escrow_id, &keeper);
    assert!(res.is_ok());

    // Keeper receives 20 bps of 100,000 = 200
    assert_eq!(token_client.balance(&keeper), 200);
    // Payer receives remainder = 99,800
    assert_eq!(token_client.balance(&payer), payer_balance_before + 99_800);
    assert_eq!(token_client.balance(&contract_id), 0);

    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.status, EscrowStatus::Refunded);
}

#[test]
fn test_payer_claim_refund_receives_full_amount_no_bounty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 200_000);
    client.init(&admin, &treasury, &200);
    client.set_keeper_bounty_bps(&admin, &50); // 50 bps

    let profile_hash = BytesN::from_array(&env, &[17u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &100_000,
        &profile_hash,
        &1_000,
    );

    let payer_balance_before = token_client.balance(&payer);
    env.ledger().with_mut(|l| l.timestamp = 2_000);

    // Payer claims their own refund: receives 100% without bounty deduction
    let res = client.try_claim_refund(&escrow_id, &payer);
    assert!(res.is_ok());

    assert_eq!(token_client.balance(&payer), payer_balance_before + 100_000);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_keeper_claim_refund_before_unlock_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &200);
    client.set_keeper_bounty_bps(&admin, &20);

    let profile_hash = BytesN::from_array(&env, &[18u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &50_000,
        &profile_hash,
        &5_000,
    );

    let keeper = Address::generate(&env);
    // Timestamp is 0, unlock timestamp is 5000 -> rejected
    let res = client.try_claim_refund(&escrow_id, &keeper);
    assert_eq!(res, Err(Ok(EscrowError::UnlockTimeNotReached)));
}

// =========================================================================
// Issue 53: Upgradeable Contract Proxy Pattern & Migration Hooks Tests
// =========================================================================

#[test]
fn test_upgrade_requires_admin_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, _, _, _, _) = setup_test_env(&env, 0);
    client.init(&admin, &treasury, &200);

    let dummy_hash = BytesN::from_array(&env, &[99u8; 32]);

    // Non-admin attempting to upgrade is rejected
    let res_unauth = client.try_upgrade(&payer, &dummy_hash);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_migration_hook_and_versioning() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, _, _, _, _) = setup_test_env(&env, 0);
    client.init(&admin, &treasury, &200);

    // Default version is 1
    assert_eq!(client.get_version(), 1);

    // Non-admin migration rejected
    let res_unauth = client.try_migrate(&payer, &2);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));

    // Migrating to same or lower version rejected
    let res_downgrade = client.try_migrate(&admin, &1);
    assert_eq!(res_downgrade, Err(Ok(EscrowError::MigrationFailed)));

    // Admin migrates to version 2
    let res_ok = client.try_migrate(&admin, &2);
    assert!(res_ok.is_ok());
    assert_eq!(client.get_version(), 2);

    // Next migration to version 3
    assert!(client.try_migrate(&admin, &3).is_ok());
    assert_eq!(client.get_version(), 3);
}

#[test]
fn test_escrow_records_accessible_after_migration() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 50_000);
    client.init(&admin, &treasury, &200);

    let profile_hash = BytesN::from_array(&env, &[19u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &25_000,
        &profile_hash,
        &1_000,
    );

    // Contract undergoes schema migration
    client.migrate(&admin, &2);
    assert_eq!(client.get_version(), 2);

    // Escrow record remains fully accessible
    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.amount, 25_000);
    assert_eq!(record.payer, payer);
    assert_eq!(record.status, EscrowStatus::Funded);

    // Escrow export includes record intact
    let page = client.get_escrows_paginated(&1, &10);
    assert_eq!(page.len(), 1);
    assert_eq!(page.get(0).unwrap().escrow_id, escrow_id);

    // Execution on existing escrow succeeds after migration
    let res_release = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert!(res_release.is_ok());

    let disbursed_record = client.get_escrow(&escrow_id);
    assert_eq!(disbursed_record.status, EscrowStatus::Disbursed);
}

// =========================================================================
// Issue 59: Multi-Token Whitelist Management with Administrative Voting Tests
// =========================================================================

#[test]
fn test_multi_admin_management() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin1, treasury, payer, _, _, _, _) = setup_test_env(&env, 0);
    client.init(&admin1, &treasury, &200);

    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    assert_eq!(client.get_admin_count(), 1);
    assert!(client.is_admin(&admin1));
    assert!(!client.is_admin(&admin2));

    // Admin 1 adds Admin 2
    assert!(client.try_add_admin(&admin1, &admin2).is_ok());
    assert_eq!(client.get_admin_count(), 2);
    assert!(client.is_admin(&admin2));

    // Adding existing admin returns AdminAlreadyExists
    let res_dup = client.try_add_admin(&admin1, &admin2);
    assert_eq!(res_dup, Err(Ok(EscrowError::AdminAlreadyExists)));

    // Non-admin cannot add admin
    let res_unauth = client.try_add_admin(&payer, &admin3);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));

    // Admin 2 adds Admin 3
    assert!(client.try_add_admin(&admin2, &admin3).is_ok());
    assert_eq!(client.get_admin_count(), 3);

    // Admin 1 removes Admin 3
    assert!(client.try_remove_admin(&admin1, &admin3).is_ok());
    assert_eq!(client.get_admin_count(), 2);
    assert!(!client.is_admin(&admin3));

    // Removing non-existent admin returns AdminNotFound
    let res_not_found = client.try_remove_admin(&admin1, &admin3);
    assert_eq!(res_not_found, Err(Ok(EscrowError::AdminNotFound)));

    // Admin 1 removes Admin 2
    assert!(client.try_remove_admin(&admin1, &admin2).is_ok());
    assert_eq!(client.get_admin_count(), 1);

    // Cannot remove the last remaining admin
    let res_last = client.try_remove_admin(&admin1, &admin1);
    assert_eq!(res_last, Err(Ok(EscrowError::CannotRemoveLastAdmin)));
}

#[test]
fn test_two_step_whitelist_voting_flow() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin1, treasury, payer, _, _, _, _) = setup_test_env(&env, 0);
    client.init(&admin1, &treasury, &200);

    let admin2 = Address::generate(&env);
    client.add_admin(&admin1, &admin2);

    let token_admin = Address::generate(&env);
    let new_token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    // Enable whitelist active by whitelisting primary token first
    client.set_token_whitelist(&admin1, &Address::generate(&env), &true);
    assert!(!client.is_token_whitelisted(&new_token));

    // Non-admin proposal rejected
    let res_unauth_prop = client.try_propose_token_whitelist(&payer, &new_token, &true);
    assert_eq!(res_unauth_prop, Err(Ok(EscrowError::Unauthorized)));

    // Admin 1 proposes whitelisting new token
    let prop_id = client.propose_token_whitelist(&admin1, &new_token, &true);
    assert_eq!(prop_id, 1);

    let proposal = client.get_proposal(&prop_id);
    assert_eq!(proposal.token, new_token);
    assert!(proposal.whitelisted);
    assert_eq!(proposal.proposer, admin1);
    assert!(!proposal.executed);

    // Token is NOT whitelisted yet
    assert!(!client.is_token_whitelisted(&new_token));

    // Non-admin confirmation rejected
    let res_unauth_conf = client.try_confirm_token_whitelist(&payer, &prop_id);
    assert_eq!(res_unauth_conf, Err(Ok(EscrowError::Unauthorized)));

    // Admin 1 confirming own proposal rejected (requires 2 distinct admin signatures!)
    let res_self_conf = client.try_confirm_token_whitelist(&admin1, &prop_id);
    assert_eq!(
        res_self_conf,
        Err(Ok(EscrowError::CannotConfirmOwnProposal))
    );

    // Admin 2 confirms proposal
    let res_ok = client.try_confirm_token_whitelist(&admin2, &prop_id);
    assert!(res_ok.is_ok());

    // Token is now whitelisted!
    assert!(client.is_token_whitelisted(&new_token));

    // Confirming already executed proposal rejected
    let res_dup_conf = client.try_confirm_token_whitelist(&admin2, &prop_id);
    assert_eq!(res_dup_conf, Err(Ok(EscrowError::ProposalAlreadyExecuted)));

    // Invalid proposal ID returns ProposalNotFound
    let res_missing = client.try_confirm_token_whitelist(&admin2, &999);
    assert_eq!(res_missing, Err(Ok(EscrowError::ProposalNotFound)));
}

#[test]
fn test_delisting_token_does_not_brick_existing_open_escrows() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin1, treasury, payer, beneficiary, anchor_addr, token_client, _) =
        setup_test_env(&env, 50_000);
    client.init(&admin1, &treasury, &200);

    let admin2 = Address::generate(&env);
    client.add_admin(&admin1, &admin2);

    // Whitelist token via voting
    let prop_whitelist = client.propose_token_whitelist(&admin1, &token_client.address, &true);
    client.confirm_token_whitelist(&admin2, &prop_whitelist);
    assert!(client.is_token_whitelisted(&token_client.address));

    // Create an open escrow with the whitelisted token
    let profile_hash = BytesN::from_array(&env, &[20u8; 32]);
    let escrow_id = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &20_000,
        &profile_hash,
        &1_000,
    );

    // Admin 1 and Admin 2 vote to DELIST the token
    let prop_delist = client.propose_token_whitelist(&admin1, &token_client.address, &false);
    client.confirm_token_whitelist(&admin2, &prop_delist);
    assert!(!client.is_token_whitelisted(&token_client.address));

    // New escrows with the delisted token are rejected
    let res_new_escrow = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &1_000,
    );
    assert_eq!(res_new_escrow, Err(Ok(EscrowError::TokenNotWhitelisted)));

    // Existing open escrow is NOT bricked: release_to_anchor succeeds completely!
    let res_release = client.try_release_to_anchor(&escrow_id, &payer, &anchor_addr);
    assert!(res_release.is_ok());

    let record = client.get_escrow(&escrow_id);
    assert_eq!(record.status, EscrowStatus::Disbursed);
    assert_eq!(token_client.balance(&anchor_addr), 19_600);
    assert_eq!(token_client.balance(&treasury), 400);
}

// ==============================================================================
// RATE-LIMITING VOLUME GOVERNOR TESTS (Issue #57)
// ==============================================================================

#[test]
fn test_set_and_get_token_volume_limit() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, _, _, token_client, _) = setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &200);

    // Initial limit should be 0 (unlimited/disabled)
    assert_eq!(client.get_token_volume_limit(&token_client.address), 0);
    assert_eq!(client.get_volume_limit(&token_client.address), 0);

    // Admin sets limit
    let res = client.try_set_token_volume_limit(&admin, &token_client.address, &50_000);
    assert!(res.is_ok());
    assert_eq!(client.get_token_volume_limit(&token_client.address), 50_000);
    assert_eq!(client.get_volume_limit(&token_client.address), 50_000);

    // Alias set_volume_limit works
    let res_alias = client.try_set_volume_limit(&admin, &token_client.address, &75_000);
    assert!(res_alias.is_ok());
    assert_eq!(client.get_token_volume_limit(&token_client.address), 75_000);

    // Non-admin cannot set limit
    let res_unauth = client.try_set_token_volume_limit(&payer, &token_client.address, &100_000);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));

    // Setting negative limit is rejected
    let res_neg = client.try_set_token_volume_limit(&admin, &token_client.address, &-100);
    assert_eq!(res_neg, Err(Ok(EscrowError::InvalidVolumeLimit)));

    // Admin disables limit by setting to 0
    let res_zero = client.try_set_token_volume_limit(&admin, &token_client.address, &0);
    assert!(res_zero.is_ok());
    assert_eq!(client.get_token_volume_limit(&token_client.address), 0);
}

#[test]
fn test_hourly_volume_tracking_single_and_multiple_escrows() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _token_admin) =
        setup_test_env(&env, 500_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 1_000);

    // Initial volume should be 0
    assert_eq!(client.get_token_hourly_volume(&token_client.address), 0);
    assert_eq!(client.get_hourly_volume(&token_client.address), 0);

    // Create first escrow with 10,000
    let profile_hash = BytesN::from_array(&env, &[1u8; 32]);
    client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        10_000
    );

    // Create second escrow with 25,000 at timestamp 1,500
    env.ledger().with_mut(|l| l.timestamp = 1_500);
    client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &25_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        35_000
    );

    // Check volume tracker struct
    let tracker = client.get_token_volume_tracker(&token_client.address);
    assert_eq!(tracker.window_start, 1_000);
    assert_eq!(tracker.volume, 35_000);

    // Setup second token and verify independent volume tracking
    let token2_admin = Address::generate(&env);
    let token2_contract = env.register_stellar_asset_contract_v2(token2_admin);
    let token2_client = TokenClient::new(&env, &token2_contract.address());
    let token2_admin_client = StellarAssetClient::new(&env, &token2_contract.address());
    token2_admin_client.mint(&payer, &100_000);

    client.create_escrow(
        &payer,
        &beneficiary,
        &token2_client.address,
        &7_500,
        &profile_hash,
        &500,
    );

    // Token 2 volume is 7,500 while Token 1 remains 35,000
    assert_eq!(
        client.get_token_hourly_volume(&token2_client.address),
        7_500
    );
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        35_000
    );
}

#[test]
fn test_revert_create_escrow_when_hourly_volume_limit_exceeded() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 2_000);

    // Set hourly volume limit to 30,000
    client.set_token_volume_limit(&admin, &token_client.address, &30_000);

    let profile_hash = BytesN::from_array(&env, &[2u8; 32]);

    // Create escrow with 20,000 -> succeeds
    let id1 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &20_000,
        &profile_hash,
        &500,
    );
    assert_eq!(id1, 1);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        20_000
    );

    // Attempting 15,000 exceeds 30,000 (20,000 + 15,000 = 35,000 > 30,000) -> Reverts!
    let res_exceed = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &15_000,
        &profile_hash,
        &500,
    );
    assert_eq!(res_exceed, Err(Ok(EscrowError::HourlyVolumeLimitExceeded)));

    // Verify payer balance untouched and counter not incremented
    assert_eq!(token_client.balance(&payer), 80_000);
    assert_eq!(client.get_counter(), 1);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        20_000
    );

    // Deposit exactly 10,000 -> reaches 30,000 cap exactly -> succeeds!
    let id2 = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );
    assert_eq!(id2, 2);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        30_000
    );

    // Any further deposit (even 1 token) in this hour is rejected
    let res_one = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &1,
        &profile_hash,
        &500,
    );
    assert_eq!(res_one, Err(Ok(EscrowError::HourlyVolumeLimitExceeded)));
}

#[test]
fn test_rolling_window_expiration_resets_volume_limit() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 200_000);
    client.init(&admin, &treasury, &200);

    // Set starting timestamp to 10,000
    env.ledger().with_mut(|l| l.timestamp = 10_000);

    // Set limit to 25,000
    client.set_token_volume_limit(&admin, &token_client.address, &25_000);

    let profile_hash = BytesN::from_array(&env, &[3u8; 32]);

    // Fill entire limit
    client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &25_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        25_000
    );

    // Immediate deposit is rejected
    let res_blocked = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &500,
    );
    assert_eq!(res_blocked, Err(Ok(EscrowError::HourlyVolumeLimitExceeded)));

    // Advance timestamp by 3,599 seconds (t = 13,599). 1 hour has NOT elapsed yet (< 3600s)
    env.ledger().with_mut(|l| l.timestamp = 13_599);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        25_000
    );

    let res_still_blocked = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        res_still_blocked,
        Err(Ok(EscrowError::HourlyVolumeLimitExceeded))
    );

    // Advance timestamp by 1 more second to 13,600 (exactly 3,600 seconds elapsed)
    env.ledger().with_mut(|l| l.timestamp = 13_600);

    // Query shows hourly volume reset to 0
    assert_eq!(client.get_token_hourly_volume(&token_client.address), 0);

    // Now a new deposit of 15,000 succeeds!
    let id_new = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &15_000,
        &profile_hash,
        &500,
    );
    assert_eq!(id_new, 2);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        15_000
    );

    let tracker = client.get_token_volume_tracker(&token_client.address);
    assert_eq!(tracker.window_start, 13_600);
    assert_eq!(tracker.volume, 15_000);
}

#[test]
fn test_institutional_anchor_administrative_bypass() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, token_admin) =
        setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 5_000);

    // Set hourly volume limit to 10,000
    client.set_token_volume_limit(&admin, &token_client.address, &10_000);

    let profile_hash = BytesN::from_array(&env, &[4u8; 32]);

    // Regular user fills the limit to 10,000
    client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );

    // Regular user is now blocked
    let res_blocked = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &5_000,
        &profile_hash,
        &500,
    );
    assert_eq!(res_blocked, Err(Ok(EscrowError::HourlyVolumeLimitExceeded)));

    // anchor_addr is initially not verified
    assert!(!client.is_institutional_anchor(&anchor_addr));
    assert!(!client.is_anchor_bypass(&anchor_addr));

    // Admin verifies anchor_addr as an institutional anchor
    let res_set = client.try_set_institutional_anchor(&admin, &anchor_addr, &true);
    assert!(res_set.is_ok());
    assert!(client.is_institutional_anchor(&anchor_addr));
    assert!(client.is_anchor_bypass(&anchor_addr));

    // Mint tokens to anchor_addr
    token_admin.mint(&anchor_addr, &100_000);

    // Institutional anchor creates escrow for 50,000 (far exceeding the 10,000 limit) -> SUCCEEDS!
    let id_anchor = client.create_escrow(
        &anchor_addr,
        &beneficiary,
        &token_client.address,
        &50_000,
        &profile_hash,
        &500,
    );
    assert_eq!(id_anchor, 2);

    // Total hourly inflow accurately reflects the anchor volume
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        60_000
    );

    // Admin revokes anchor bypass
    let res_revoke = client.try_set_anchor_bypass(&admin, &anchor_addr, &false);
    assert!(res_revoke.is_ok());
    assert!(!client.is_institutional_anchor(&anchor_addr));

    // Anchor is now subject to limits and rejected because volume (60k) > limit (10k)
    let res_anchor_rejected = client.try_create_escrow(
        &anchor_addr,
        &beneficiary,
        &token_client.address,
        &1_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        res_anchor_rejected,
        Err(Ok(EscrowError::HourlyVolumeLimitExceeded))
    );

    // Non-admin cannot set institutional anchor
    let res_unauth = client.try_set_institutional_anchor(&payer, &anchor_addr, &true);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));
}

#[test]
fn test_high_transaction_load_simulation() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, anchor_addr, token_client, token_admin) =
        setup_test_env(&env, 1_000_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 20_000);

    // Hourly limit: 50,000
    client.set_token_volume_limit(&admin, &token_client.address, &50_000);

    let profile_hash = BytesN::from_array(&env, &[5u8; 32]);

    // Simulate 25 consecutive rapid transactions of 2,000 each under high load
    for i in 0..25 {
        let res = client.try_create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &2_000,
            &profile_hash,
            &100,
        );
        assert!(res.is_ok(), "Transaction {} should succeed", i);
    }

    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        50_000
    );
    assert_eq!(client.get_counter(), 25);

    // 26th transaction under high load attempts 1,000 -> Exceeds limit -> Reverted!
    let res_overflow = client.try_create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &1_000,
        &profile_hash,
        &100,
    );
    assert_eq!(
        res_overflow,
        Err(Ok(EscrowError::HourlyVolumeLimitExceeded))
    );

    // Institutional anchor sends a high-volume batch through bypass
    client.set_institutional_anchor(&admin, &anchor_addr, &true);
    token_admin.mint(&anchor_addr, &200_000);

    let res_anchor = client.try_create_escrow(
        &anchor_addr,
        &beneficiary,
        &token_client.address,
        &150_000,
        &profile_hash,
        &100,
    );
    assert!(res_anchor.is_ok());
    assert_eq!(client.get_counter(), 26);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        200_000
    );

    // Advance 1 hour into the future (3600s)
    env.ledger().with_mut(|l| l.timestamp = 23_600);

    // High transaction load resumes in the new hour window
    for i in 0..25 {
        let res = client.try_create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &2_000,
            &profile_hash,
            &100,
        );
        assert!(
            res.is_ok(),
            "Second-window transaction {} should succeed",
            i
        );
    }
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        50_000
    );
    assert_eq!(client.get_counter(), 51);
}

#[test]
fn test_admin_reset_token_volume_tracker() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100_000);
    client.init(&admin, &treasury, &200);

    env.ledger().with_mut(|l| l.timestamp = 50_000);
    client.set_token_volume_limit(&admin, &token_client.address, &20_000);

    let profile_hash = BytesN::from_array(&env, &[6u8; 32]);
    client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &20_000,
        &profile_hash,
        &500,
    );
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        20_000
    );

    // Next deposit blocked
    assert_eq!(
        client.try_create_escrow(
            &payer,
            &beneficiary,
            &token_client.address,
            &1_000,
            &profile_hash,
            &500
        ),
        Err(Ok(EscrowError::HourlyVolumeLimitExceeded))
    );

    // Non-admin reset fails
    let res_unauth = client.try_reset_token_volume_tracker(&payer, &token_client.address);
    assert_eq!(res_unauth, Err(Ok(EscrowError::Unauthorized)));

    // Admin resets volume tracker manually
    let res_reset = client.try_reset_token_volume_tracker(&admin, &token_client.address);
    assert!(res_reset.is_ok());
    assert_eq!(client.get_token_hourly_volume(&token_client.address), 0);

    // Payer can immediately deposit again without waiting 1 hour
    let id_new = client.create_escrow(
        &payer,
        &beneficiary,
        &token_client.address,
        &10_000,
        &profile_hash,
        &500,
    );
    assert_eq!(id_new, 2);
    assert_eq!(
        client.get_token_hourly_volume(&token_client.address),
        10_000
    );
}

#[test]
fn test_volume_governor_uninitialized_and_disabled_modes() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, _, admin, _, _, _, anchor_addr, token_client, _) = setup_test_env(&env, 50_000);

    // Uninitialized calls fail with NotInitialized
    let res_set = client.try_set_token_volume_limit(&admin, &token_client.address, &10_000);
    assert_eq!(res_set, Err(Ok(EscrowError::NotInitialized)));

    let res_anchor = client.try_set_institutional_anchor(&admin, &anchor_addr, &true);
    assert_eq!(res_anchor, Err(Ok(EscrowError::NotInitialized)));

    let res_reset = client.try_reset_token_volume_tracker(&admin, &token_client.address);
    assert_eq!(res_reset, Err(Ok(EscrowError::NotInitialized)));
}

#[test]
fn test_time_weighted_cancellation_uses_single_floor_and_routes_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &0);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);

    let params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary: beneficiary.clone(),
        token: token_client.address.clone(),
        amount: 10,
        profile_hash: BytesN::from_array(&env, &[31; 32]),
        lock_duration: 11,
        cancellation_penalty_bps: 1_100,
        referrer: None,
        committed_rate: None,
    };
    let escrow_id = client.create_escrow_with_params(&params);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_010);

    client.cancel_escrow(&escrow_id, &payer);

    // Flooring the full ratio gives 1; flooring the intermediate fee would incorrectly give 0.
    assert_eq!(10 * 1_100 * 10 / (10_000 * 11), 1);
    assert_eq!(token_client.balance(&beneficiary), 1);
    assert_eq!(token_client.balance(&payer), 19_999);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Refunded);
}

#[test]
fn test_cancellation_rejects_deadline_and_bps_above_full_penalty() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &0);

    let mut params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary,
        token: token_client.address.clone(),
        amount: 1_000,
        profile_hash: BytesN::from_array(&env, &[32; 32]),
        lock_duration: 10,
        cancellation_penalty_bps: 10_001,
        referrer: None,
        committed_rate: None,
    };
    assert_eq!(
        client.try_create_escrow_with_params(&params),
        Err(Ok(EscrowError::InvalidBps))
    );

    params.cancellation_penalty_bps = 10_000;
    let escrow_id = client.create_escrow_with_params(&params);
    env.ledger().with_mut(|ledger| ledger.timestamp += 10);
    assert_eq!(
        client.try_cancel_escrow(&escrow_id, &payer),
        Err(Ok(EscrowError::UnlockTimePassed))
    );
}

#[test]
fn test_referrer_receives_twenty_percent_of_platform_fee() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, anchor, token_client, _) =
        setup_test_env(&env, 20_000);
    let referrer = Address::generate(&env);
    client.init(&admin, &treasury, &200);
    let params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary,
        token: token_client.address.clone(),
        amount: 10_000,
        profile_hash: BytesN::from_array(&env, &[33; 32]),
        lock_duration: 100,
        cancellation_penalty_bps: 0,
        referrer: Some(referrer.clone()),
        committed_rate: None,
    };
    let escrow_id = client.create_escrow_with_params(&params);

    client.release_to_anchor(&escrow_id, &payer, &anchor);

    assert_eq!(token_client.balance(&treasury), 160);
    assert_eq!(token_client.balance(&referrer), 40);
    assert_eq!(token_client.balance(&anchor), 9_800);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_stream_accrues_per_second_and_caps_withdrawal_at_end() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100);
    client.init(&admin, &treasury, &0);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let stream_id = client.create_stream(&payer, &beneficiary, &token_client.address, &3, &10);

    env.ledger().with_mut(|ledger| ledger.timestamp = 1_001);
    assert_eq!(client.stream_withdraw(&stream_id), 3);
    assert_eq!(client.stream_withdraw(&stream_id), 0);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_002);
    assert_eq!(client.stream_withdraw(&stream_id), 3);
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_012);
    assert_eq!(client.stream_withdraw(&stream_id), 24);

    assert_eq!(token_client.balance(&beneficiary), 30);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_terminating_stream_returns_only_unaccrued_capital() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 100);
    client.init(&admin, &treasury, &0);
    env.ledger().with_mut(|ledger| ledger.timestamp = 2_000);
    let stream_id = client.create_stream(&payer, &beneficiary, &token_client.address, &2, &10);
    env.ledger().with_mut(|ledger| ledger.timestamp = 2_004);

    assert_eq!(client.terminate_stream(&stream_id, &payer), 12);
    assert_eq!(client.stream_withdraw(&stream_id), 8);
    assert_eq!(token_client.balance(&payer), 92);
    assert_eq!(token_client.balance(&beneficiary), 8);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(
        client.try_terminate_stream(&stream_id, &payer),
        Err(Ok(EscrowError::InvalidStatus))
    );
}

#[test]
fn test_oracle_deviation_disputes_escrow_and_admin_can_resolve_once() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, anchor, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &0);
    let oracle = env.register(MockRateOracle, ());
    set_mock_rate(&env, &oracle, 110);
    client.configure_rate_oracle(&admin, &oracle, &1_000);

    let params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary: beneficiary.clone(),
        token: token_client.address.clone(),
        amount: 10_000,
        profile_hash: BytesN::from_array(&env, &[34; 32]),
        lock_duration: 100,
        cancellation_penalty_bps: 0,
        referrer: None,
        committed_rate: Some(100),
    };
    let within_limit_id = client.create_escrow_with_params(&params);
    client.release_to_anchor(&within_limit_id, &payer, &anchor);
    assert_eq!(
        client.get_escrow(&within_limit_id).status,
        EscrowStatus::Disbursed
    );

    set_mock_rate(&env, &oracle, 111);
    let disputed_id = client.create_escrow_with_params(&params);
    client.release_to_anchor(&disputed_id, &payer, &anchor);
    assert_eq!(
        client.get_escrow(&disputed_id).status,
        EscrowStatus::Disputed
    );
    assert_eq!(token_client.balance(&contract_id), 10_000);

    client.resolve_dispute(&disputed_id, &admin, &5_000, &5_000);
    assert_eq!(token_client.balance(&payer), 5_000);
    assert_eq!(token_client.balance(&beneficiary), 5_000);
    assert_eq!(
        client.try_resolve_dispute(&disputed_id, &admin, &5_000, &5_000),
        Err(Ok(EscrowError::InvalidStatus))
    );
}

#[test]
fn test_split_release_pays_referrer_from_fee_only() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, _, token_client, _) =
        setup_test_env(&env, 20_000);
    let recipient = Address::generate(&env);
    let referrer = Address::generate(&env);
    client.init(&admin, &treasury, &200);
    let params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary,
        token: token_client.address.clone(),
        amount: 10_000,
        profile_hash: BytesN::from_array(&env, &[35; 32]),
        lock_duration: 100,
        cancellation_penalty_bps: 0,
        referrer: Some(referrer.clone()),
        committed_rate: None,
    };
    let escrow_id = client.create_escrow_with_params(&params);
    let commitments = vec![
        &env,
        DisbursementCommitment {
            recipient: recipient.clone(),
            amount: 9_800,
            commitment_hash: BytesN::from_array(&env, &[36; 32]),
        },
    ];

    client.release_split(&escrow_id, &payer, &commitments);

    assert_eq!(token_client.balance(&treasury), 160);
    assert_eq!(token_client.balance(&referrer), 40);
    assert_eq!(token_client.balance(&recipient), 9_800);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_oracle_deviation_also_blocks_split_release() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, contract_id, admin, treasury, payer, beneficiary, recipient, token_client, _) =
        setup_test_env(&env, 20_000);
    client.init(&admin, &treasury, &0);
    let oracle = env.register(MockRateOracle, ());
    set_mock_rate(&env, &oracle, 111);
    client.configure_rate_oracle(&admin, &oracle, &1_000);
    let params = EscrowInitParams {
        payer: payer.clone(),
        beneficiary,
        token: token_client.address.clone(),
        amount: 10_000,
        profile_hash: BytesN::from_array(&env, &[37; 32]),
        lock_duration: 100,
        cancellation_penalty_bps: 0,
        referrer: None,
        committed_rate: Some(100),
    };
    let escrow_id = client.create_escrow_with_params(&params);
    let commitments = vec![
        &env,
        DisbursementCommitment {
            recipient: recipient.clone(),
            amount: 10_000,
            commitment_hash: BytesN::from_array(&env, &[38; 32]),
        },
    ];

    client.release_split(&escrow_id, &payer, &commitments);

    assert_eq!(client.get_escrow(&escrow_id).status, EscrowStatus::Disputed);
    assert_eq!(token_client.balance(&recipient), 0);
    assert_eq!(token_client.balance(&contract_id), 10_000);
}
