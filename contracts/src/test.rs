use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::Client as TokenClient,
    token::StellarAssetClient,
    Address, BytesN, Env, Symbol, TryFromVal,
};

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
