#![no_std]

mod errors;
mod types;

#[cfg(test)]
mod test;

use crate::errors::EscrowError;
use crate::types::{
    DataKey, DisbursementCommitment, EscrowEntry, EscrowInitParams, EscrowRecord, EscrowStatus,
    EscrowStream, EscrowTerms, VolumeTracker, WhitelistProposal,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, symbol_short, token, Address, BytesN, Env, Symbol, Vec,
};

const BPS_DIVISOR: i128 = 10_000;
const PERSISTENT_EXTEND_TTL_THRESHOLD: u32 = 100_000;
const PERSISTENT_EXTEND_TTL_AMOUNT: u32 = 200_000;
const INSTANCE_EXTEND_TTL_THRESHOLD: u32 = 100_000;
const INSTANCE_EXTEND_TTL_AMOUNT: u32 = 200_000;

/// Rolling 1-hour window duration in seconds (3600s).
pub const ROLLING_WINDOW_SECONDS: u64 = 3600;

/// Upper bound on the number of legs accepted by `release_split`. Each leg costs
/// one token transfer plus one event, so the cap keeps the worst-case
/// invocation far below the per-transaction CPU/memory/event limits.
pub const MAX_DISBURSEMENT_COMMITMENTS: u32 = 10;

/// Hard ceiling on the page size served by `get_escrows_paginated`. Requests
/// for larger pages are clamped, protecting the read path from gas exhaustion.
pub const MAX_PAGE_SIZE: u32 = 50;

#[contractclient(name = "RateOracleClient")]
pub trait RateOracle {
    fn get_rate(env: Env, token: Address) -> i128;
}

#[contract]
pub struct EscrowGate;

impl EscrowGate {
    fn check_is_admin(env: &Env, account: &Address) -> bool {
        if let Some(primary_admin) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
        {
            if *account == primary_admin {
                return true;
            }
        }

        env.storage()
            .instance()
            .get::<DataKey, bool>(&DataKey::AdminRegistry(account.clone()))
            .unwrap_or(false)
    }

    fn is_rate_within_limit(
        env: &Env,
        escrow_id: u64,
        record: &EscrowRecord,
    ) -> Result<bool, EscrowError> {
        let terms: Option<EscrowTerms> = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowTerms(escrow_id));
        let Some(committed_rate) = terms.and_then(|terms| terms.committed_rate) else {
            return Ok(true);
        };
        let oracle: Address = env
            .storage()
            .instance()
            .get(&DataKey::RateOracle)
            .ok_or(EscrowError::NotInitialized)?;
        let max_deviation_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxRateDeviationBps)
            .ok_or(EscrowError::NotInitialized)?;
        let execution_rate = RateOracleClient::new(env, &oracle).get_rate(&record.token);
        if execution_rate <= 0 {
            return Err(EscrowError::ZeroAmount);
        }
        let difference = if execution_rate >= committed_rate {
            execution_rate
                .checked_sub(committed_rate)
                .ok_or(EscrowError::ArithmeticOverflow)?
        } else {
            committed_rate
                .checked_sub(execution_rate)
                .ok_or(EscrowError::ArithmeticOverflow)?
        };
        let deviation = difference
            .checked_mul(BPS_DIVISOR)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let allowed = committed_rate
            .checked_mul(i128::from(max_deviation_bps))
            .ok_or(EscrowError::ArithmeticOverflow)?;
        Ok(deviation <= allowed)
    }
}

#[contractimpl]
impl EscrowGate {
    pub fn init(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_bps: u32,
    ) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        if fee_bps > 1000 {
            return Err(EscrowError::InvalidBps);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::AdminRegistry(admin.clone()), &true);
        env.storage().instance().set(&DataKey::AdminCount, &1u32);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
        env.storage().instance().set(&DataKey::StreamCounter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::AllowClawbackTokens, &true);
        env.storage()
            .instance()
            .set(&DataKey::KeeperBountyBps, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCounter, &0u64);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        Ok(())
    }

    pub fn create_escrow(
        env: Env,
        payer: Address,
        beneficiary: Address,
        token: Address,
        amount: i128,
        profile_hash: BytesN<32>,
        lock_duration: u64,
    ) -> Result<u64, EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        payer.require_auth();

        if amount <= 0 {
            return Err(EscrowError::ZeroAmount);
        }

        if !Self::is_token_whitelisted(env.clone(), token.clone()) {
            return Err(EscrowError::TokenNotWhitelisted);
        }

        if !Self::is_allow_clawback_tokens(env.clone())
            && Self::is_token_clawback_enabled(env.clone(), token.clone())
        {
            return Err(EscrowError::ClawbackNotAllowed);
        }

        // --- Rate-Limiting Volume Governor Check (Issue 57) ---
        let current_time = env.ledger().timestamp();
        let mut tracker: VolumeTracker = env
            .storage()
            .instance()
            .get(&DataKey::TokenVolumeTracker(token.clone()))
            .unwrap_or(VolumeTracker {
                window_start: current_time,
                volume: 0,
            });

        if current_time >= tracker.window_start.saturating_add(ROLLING_WINDOW_SECONDS) {
            tracker.window_start = current_time;
            tracker.volume = 0;
        }

        let volume_limit = Self::get_token_volume_limit(env.clone(), token.clone());
        if volume_limit > 0 {
            let is_exempt = Self::check_is_admin(&env, &payer)
                || Self::is_institutional_anchor(env.clone(), payer.clone());
            if !is_exempt {
                let projected_volume = tracker
                    .volume
                    .checked_add(amount)
                    .ok_or(EscrowError::ArithmeticOverflow)?;
                if projected_volume > volume_limit {
                    return Err(EscrowError::HourlyVolumeLimitExceeded);
                }
            }
        }

        tracker.volume = tracker
            .volume
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        env.storage()
            .instance()
            .set(&DataKey::TokenVolumeTracker(token.clone()), &tracker);

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .ok_or(EscrowError::NotInitialized)?;

        counter = counter
            .checked_add(1)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let current_time = env.ledger().timestamp();
        let unlock_timestamp = current_time
            .checked_add(lock_duration)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let record = EscrowRecord {
            payer: payer.clone(),
            beneficiary,
            token,
            amount,
            profile_hash: profile_hash.clone(),
            status: EscrowStatus::Funded,
            unlock_timestamp,
        };

        let key = DataKey::Escrow(counter);
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().set(
            &DataKey::EscrowTerms(counter),
            &EscrowTerms {
                created_at: current_time,
                cancellation_penalty_bps: 0,
                referrer: None,
                committed_rate: None,
            },
        );
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );

        env.storage()
            .instance()
            .set(&DataKey::EscrowCounter, &counter);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (symbol_short!("created"), counter),
            (payer, amount, profile_hash),
        );

        Ok(counter)
    }

    pub fn configure_rate_oracle(
        env: Env,
        caller: Address,
        oracle: Address,
        max_deviation_bps: u32,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }
        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }
        if max_deviation_bps > 10_000 {
            return Err(EscrowError::InvalidBps);
        }
        env.storage().instance().set(&DataKey::RateOracle, &oracle);
        env.storage()
            .instance()
            .set(&DataKey::MaxRateDeviationBps, &max_deviation_bps);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);
        env.events().publish(
            (Symbol::new(&env, "rate_oracle_set"), caller),
            (oracle, max_deviation_bps),
        );
        Ok(())
    }

    pub fn create_escrow_with_params(
        env: Env,
        params: EscrowInitParams,
    ) -> Result<u64, EscrowError> {
        if params.cancellation_penalty_bps > 10_000 {
            return Err(EscrowError::InvalidBps);
        }
        if params.committed_rate.is_some_and(|rate| rate <= 0) {
            return Err(EscrowError::ZeroAmount);
        }

        let escrow_id = Self::create_escrow(
            env.clone(),
            params.payer,
            params.beneficiary,
            params.token,
            params.amount,
            params.profile_hash,
            params.lock_duration,
        )?;
        let key = DataKey::EscrowTerms(escrow_id);
        let mut terms: EscrowTerms = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;
        terms.cancellation_penalty_bps = params.cancellation_penalty_bps;
        terms.referrer = params.referrer;
        terms.committed_rate = params.committed_rate;
        env.storage().persistent().set(&key, &terms);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        Ok(escrow_id)
    }

    pub fn cancel_escrow(env: Env, escrow_id: u64, payer: Address) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;
        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }
        if payer != record.payer {
            return Err(EscrowError::Unauthorized);
        }
        payer.require_auth();

        let now = env.ledger().timestamp();
        if now >= record.unlock_timestamp {
            return Err(EscrowError::UnlockTimePassed);
        }
        let terms: EscrowTerms = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowTerms(escrow_id))
            .unwrap_or(EscrowTerms {
                created_at: now,
                cancellation_penalty_bps: 0,
                referrer: None,
                committed_rate: None,
            });
        let duration = record
            .unlock_timestamp
            .checked_sub(terms.created_at)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let elapsed = now
            .checked_sub(terms.created_at)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let denominator = BPS_DIVISOR
            .checked_mul(i128::from(duration))
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let penalty = record
            .amount
            .checked_mul(i128::from(terms.cancellation_penalty_bps))
            .and_then(|value| value.checked_mul(i128::from(elapsed)))
            .ok_or(EscrowError::ArithmeticOverflow)?
            / denominator;
        let refund = record
            .amount
            .checked_sub(penalty)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        let token_client = token::Client::new(&env, &record.token);
        if penalty > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &record.beneficiary,
                &penalty,
            );
        }
        if refund > 0 {
            token_client.transfer(&env.current_contract_address(), &record.payer, &refund);
        }
        env.events().publish(
            (Symbol::new(&env, "cancelled"), escrow_id),
            (penalty, refund),
        );
        Ok(())
    }

    pub fn create_stream(
        env: Env,
        payer: Address,
        beneficiary: Address,
        token: Address,
        rate_per_second: i128,
        duration: u64,
    ) -> Result<u64, EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }
        payer.require_auth();
        if rate_per_second <= 0 || duration == 0 {
            return Err(EscrowError::ZeroAmount);
        }
        if !Self::is_token_whitelisted(env.clone(), token.clone()) {
            return Err(EscrowError::TokenNotWhitelisted);
        }
        if !Self::is_allow_clawback_tokens(env.clone())
            && Self::is_token_clawback_enabled(env.clone(), token.clone())
        {
            return Err(EscrowError::ClawbackNotAllowed);
        }
        let amount = rate_per_second
            .checked_mul(i128::from(duration))
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let current_time = env.ledger().timestamp();
        let mut tracker: VolumeTracker = env
            .storage()
            .instance()
            .get(&DataKey::TokenVolumeTracker(token.clone()))
            .unwrap_or(VolumeTracker {
                window_start: current_time,
                volume: 0,
            });
        if current_time >= tracker.window_start.saturating_add(ROLLING_WINDOW_SECONDS) {
            tracker.window_start = current_time;
            tracker.volume = 0;
        }
        let volume_limit = Self::get_token_volume_limit(env.clone(), token.clone());
        if volume_limit > 0
            && !Self::check_is_admin(&env, &payer)
            && !Self::is_institutional_anchor(env.clone(), payer.clone())
        {
            let projected_volume = tracker
                .volume
                .checked_add(amount)
                .ok_or(EscrowError::ArithmeticOverflow)?;
            if projected_volume > volume_limit {
                return Err(EscrowError::HourlyVolumeLimitExceeded);
            }
        }
        tracker.volume = tracker
            .volume
            .checked_add(amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TokenVolumeTracker(token.clone()), &tracker);
        let start = env.ledger().timestamp();
        let end_time = start
            .checked_add(duration)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let stream_id = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::StreamCounter)
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let key = DataKey::Stream(stream_id);
        env.storage().persistent().set(
            &key,
            &EscrowStream {
                payer: payer.clone(),
                beneficiary: beneficiary.clone(),
                token: token.clone(),
                rate_per_second,
                last_withdrawn: start,
                end_time,
                terminated: false,
            },
        );
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        env.storage()
            .instance()
            .set(&DataKey::StreamCounter, &stream_id);
        token::Client::new(&env, &token).transfer(&payer, &env.current_contract_address(), &amount);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);
        env.events().publish(
            (Symbol::new(&env, "stream_created"), stream_id),
            (payer, beneficiary, amount, end_time),
        );
        Ok(stream_id)
    }

    pub fn stream_withdraw(env: Env, stream_id: u64) -> Result<i128, EscrowError> {
        let key = DataKey::Stream(stream_id);
        let mut stream: EscrowStream = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;
        stream.beneficiary.require_auth();
        let withdraw_until = env.ledger().timestamp().min(stream.end_time);
        let elapsed = withdraw_until
            .checked_sub(stream.last_withdrawn)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let amount = stream
            .rate_per_second
            .checked_mul(i128::from(elapsed))
            .ok_or(EscrowError::ArithmeticOverflow)?;
        if amount == 0 {
            return Ok(0);
        }
        stream.last_withdrawn = withdraw_until;
        env.storage().persistent().set(&key, &stream);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        token::Client::new(&env, &stream.token).transfer(
            &env.current_contract_address(),
            &stream.beneficiary,
            &amount,
        );
        env.events()
            .publish((Symbol::new(&env, "stream_withdrawn"), stream_id), amount);
        Ok(amount)
    }

    pub fn terminate_stream(env: Env, stream_id: u64, payer: Address) -> Result<i128, EscrowError> {
        let key = DataKey::Stream(stream_id);
        let mut stream: EscrowStream = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;
        if stream.terminated {
            return Err(EscrowError::InvalidStatus);
        }
        if payer != stream.payer {
            return Err(EscrowError::Unauthorized);
        }
        payer.require_auth();
        let now = env.ledger().timestamp();
        if now >= stream.end_time {
            return Err(EscrowError::UnlockTimePassed);
        }
        let refund = stream
            .rate_per_second
            .checked_mul(i128::from(stream.end_time - now))
            .ok_or(EscrowError::ArithmeticOverflow)?;
        stream.end_time = now;
        stream.terminated = true;
        env.storage().persistent().set(&key, &stream);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        if refund > 0 {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &stream.payer,
                &refund,
            );
        }
        env.events()
            .publish((Symbol::new(&env, "stream_terminated"), stream_id), refund);
        Ok(refund)
    }

    pub fn release_to_anchor(
        env: Env,
        escrow_id: u64,
        caller: Address,
        anchor_disbursement_address: Address,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if caller != record.payer && !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        if !Self::is_rate_within_limit(&env, escrow_id, &record)? {
            record.status = EscrowStatus::Disputed;
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .set(&DataKey::RateDispute(escrow_id), &true);
            env.events().publish(
                (Symbol::new(&env, "rate_dispute"), escrow_id),
                record.profile_hash,
            );
            return Ok(());
        }

        let token_client = token::Client::new(&env, &record.token);
        let contract_balance = token_client.balance(&env.current_contract_address());
        let mut distributable_amount = record.amount;
        if contract_balance < record.amount {
            let deficit = record.amount - contract_balance;
            distributable_amount = contract_balance;
            env.events().publish(
                (Symbol::new(&env, "ClawbackHandled"), record.token.clone()),
                (escrow_id, deficit),
            );
        }

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(EscrowError::NotInitialized)?;

        let fee_amount = distributable_amount
            .checked_mul(fee_bps as i128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            / BPS_DIVISOR;
        let terms: Option<EscrowTerms> = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowTerms(escrow_id));
        let referral_fee = if terms
            .as_ref()
            .and_then(|terms| terms.referrer.as_ref())
            .is_some()
        {
            fee_amount
                .checked_mul(20)
                .ok_or(EscrowError::ArithmeticOverflow)?
                / 100
        } else {
            0
        };
        let treasury_fee = fee_amount
            .checked_sub(referral_fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        let payout_amount = distributable_amount
            .checked_sub(fee_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        if treasury_fee > 0 {
            token_client.transfer(&env.current_contract_address(), &treasury, &treasury_fee);
        }
        if referral_fee > 0 {
            if let Some(referrer) = terms.and_then(|terms| terms.referrer) {
                token_client.transfer(&env.current_contract_address(), &referrer, &referral_fee);
            }
        }

        if payout_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &anchor_disbursement_address,
                &payout_amount,
            );
        }

        record.status = EscrowStatus::Disbursed;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "disbursed"), escrow_id),
            (record.profile_hash, payout_amount),
        );

        Ok(())
    }

    /// Disburses a funded escrow across multiple bank-account commitments.
    pub fn release_split(
        env: Env,
        escrow_id: u64,
        caller: Address,
        commitments: Vec<DisbursementCommitment>,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if caller != record.payer && !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        let leg_count = commitments.len();
        if leg_count == 0 {
            return Err(EscrowError::EmptyDisbursement);
        }
        if leg_count > MAX_DISBURSEMENT_COMMITMENTS {
            return Err(EscrowError::TooManyDisbursements);
        }

        let token_client = token::Client::new(&env, &record.token);
        let contract_address = env.current_contract_address();
        let contract_balance = token_client.balance(&contract_address);
        let mut distributable_base = record.amount;
        if contract_balance < record.amount {
            let deficit = record.amount - contract_balance;
            distributable_base = contract_balance;
            env.events().publish(
                (Symbol::new(&env, "ClawbackHandled"), record.token.clone()),
                (escrow_id, deficit),
            );
        }

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(EscrowError::NotInitialized)?;

        let fee_amount = distributable_base
            .checked_mul(fee_bps as i128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            / BPS_DIVISOR;
        let distributable = distributable_base
            .checked_sub(fee_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        // Validate every leg and the aggregate before moving any funds.
        let mut total: i128 = 0;
        for commitment in commitments.iter() {
            if commitment.amount <= 0 {
                return Err(EscrowError::InvalidDisbursementAmount);
            }
            total = total
                .checked_add(commitment.amount)
                .ok_or(EscrowError::ArithmeticOverflow)?;
        }
        if total != distributable {
            return Err(EscrowError::DisbursementMismatch);
        }

        if !Self::is_rate_within_limit(&env, escrow_id, &record)? {
            record.status = EscrowStatus::Disputed;
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .set(&DataKey::RateDispute(escrow_id), &true);
            env.events().publish(
                (Symbol::new(&env, "rate_dispute"), escrow_id),
                record.profile_hash,
            );
            return Ok(());
        }

        // Effects before interactions: mark the escrow terminal first.
        record.status = EscrowStatus::Disbursed;
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        let terms: Option<EscrowTerms> = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowTerms(escrow_id));
        let referral_fee = if terms
            .as_ref()
            .and_then(|terms| terms.referrer.as_ref())
            .is_some()
        {
            fee_amount
                .checked_mul(20)
                .ok_or(EscrowError::ArithmeticOverflow)?
                / 100
        } else {
            0
        };
        let treasury_fee = fee_amount
            .checked_sub(referral_fee)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        if treasury_fee > 0 {
            token_client.transfer(&contract_address, &treasury, &treasury_fee);
        }
        if referral_fee > 0 {
            if let Some(referrer) = terms.and_then(|terms| terms.referrer) {
                token_client.transfer(&contract_address, &referrer, &referral_fee);
            }
        }

        let split_topic = Symbol::new(&env, "split_disb");
        for (index, commitment) in commitments.iter().enumerate() {
            token_client.transfer(&contract_address, &commitment.recipient, &commitment.amount);
            env.events().publish(
                (split_topic.clone(), escrow_id, index as u32),
                (
                    commitment.recipient,
                    commitment.amount,
                    commitment.commitment_hash,
                ),
            );
        }

        env.events().publish(
            (Symbol::new(&env, "disbursed"), escrow_id),
            (record.profile_hash, distributable),
        );

        Ok(())
    }

    /// Decentralized refund claiming mechanism with keeper incentive support.
    /// If caller != payer, allocates keeper bounty (bps) to the caller and remainder to payer.
    /// If caller == payer, returns the entire refundable amount to payer.
    pub fn claim_refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        if env.ledger().timestamp() < record.unlock_timestamp {
            return Err(EscrowError::UnlockTimeNotReached);
        }

        caller.require_auth();

        let token_client = token::Client::new(&env, &record.token);
        let contract_balance = token_client.balance(&env.current_contract_address());
        let mut available_amount = record.amount;
        if contract_balance < record.amount {
            let deficit = record.amount - contract_balance;
            available_amount = contract_balance;
            env.events().publish(
                (Symbol::new(&env, "ClawbackHandled"), record.token.clone()),
                (escrow_id, deficit),
            );
        }

        if caller != record.payer {
            let bounty_bps = Self::get_keeper_bounty_bps(env.clone());
            let bounty = available_amount
                .checked_mul(bounty_bps as i128)
                .ok_or(EscrowError::ArithmeticOverflow)?
                / BPS_DIVISOR;
            let refund_amount = available_amount
                .checked_sub(bounty)
                .ok_or(EscrowError::ArithmeticOverflow)?;

            if bounty > 0 {
                token_client.transfer(&env.current_contract_address(), &caller, &bounty);
            }
            if refund_amount > 0 {
                token_client.transfer(
                    &env.current_contract_address(),
                    &record.payer,
                    &refund_amount,
                );
            }

            env.events().publish(
                (Symbol::new(&env, "keeper_refund"), escrow_id),
                (caller, bounty, record.payer.clone(), refund_amount),
            );
        } else if available_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &record.payer,
                &available_amount,
            );
        }

        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "refunded"), escrow_id), available_amount);

        Ok(())
    }

    /// Payer-initiated refund backward compatibility endpoint.
    pub fn refund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        let key = DataKey::Escrow(escrow_id);
        let record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        Self::claim_refund(env, escrow_id, record.payer)
    }

    /// Single admin or direct token whitelist setter.
    pub fn set_token_whitelist(
        env: Env,
        caller: Address,
        token: Address,
        whitelisted: bool,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();

        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::TokenWhitelisted(token.clone()), &whitelisted);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistActive, &true);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "whitelist"), token), whitelisted);

        Ok(())
    }

    pub fn is_token_whitelisted(env: Env, token: Address) -> bool {
        let is_active: bool = env
            .storage()
            .instance()
            .get(&DataKey::WhitelistActive)
            .unwrap_or(false);

        if !is_active {
            return true;
        }

        env.storage()
            .instance()
            .get(&DataKey::TokenWhitelisted(token))
            .unwrap_or(false)
    }

    // --- Clawback Compatibility Layer (Issue 51) ---

    pub fn set_token_clawback_flag(
        env: Env,
        caller: Address,
        token: Address,
        clawback_enabled: bool,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        env.storage().instance().set(
            &DataKey::TokenClawbackFlag(token.clone()),
            &clawback_enabled,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "clawback_flag_set"), token),
            clawback_enabled,
        );

        Ok(())
    }

    pub fn is_token_clawback_enabled(env: Env, token: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::TokenClawbackFlag(token))
            .unwrap_or(false)
    }

    pub fn set_allow_clawback_tokens(
        env: Env,
        caller: Address,
        allowed: bool,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::AllowClawbackTokens, &allowed);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "allow_clawback_set"), caller), allowed);

        Ok(())
    }

    pub fn is_allow_clawback_tokens(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AllowClawbackTokens)
            .unwrap_or(true)
    }

    /// Handles an external clawback deduction on an escrow record to keep internal balance aligned.
    pub fn handle_clawback(env: Env, escrow_id: u64, amount: i128) -> Result<(), EscrowError> {
        if amount <= 0 {
            return Err(EscrowError::ZeroAmount);
        }

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        let handled_amount = if amount >= record.amount {
            let fully_clawed = record.amount;
            record.amount = 0;
            record.status = EscrowStatus::Refunded;
            fully_clawed
        } else {
            record.amount = record
                .amount
                .checked_sub(amount)
                .ok_or(EscrowError::ArithmeticOverflow)?;
            amount
        };

        env.storage().persistent().set(&key, &record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_EXTEND_TTL_THRESHOLD,
            PERSISTENT_EXTEND_TTL_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "ClawbackHandled"), record.token),
            (escrow_id, handled_amount),
        );

        Ok(())
    }

    /// Audits on-chain contract token balance against escrow state and handles any discrepancy.
    pub fn sync_clawback(env: Env, escrow_id: u64) -> Result<i128, EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        let token_client = token::Client::new(&env, &record.token);
        let balance = token_client.balance(&env.current_contract_address());

        if balance < record.amount {
            let deficit = record.amount - balance;
            record.amount = balance;
            if balance == 0 {
                record.status = EscrowStatus::Refunded;
            }
            env.storage().persistent().set(&key, &record);
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_EXTEND_TTL_THRESHOLD,
                PERSISTENT_EXTEND_TTL_AMOUNT,
            );

            env.events().publish(
                (Symbol::new(&env, "ClawbackHandled"), record.token),
                (escrow_id, deficit),
            );

            Ok(deficit)
        } else {
            Ok(0)
        }
    }

    // --- Keeper Bounty Settings (Issue 52) ---

    pub fn set_keeper_bounty_bps(
        env: Env,
        caller: Address,
        bounty_bps: u32,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }
        if bounty_bps > 1000 {
            return Err(EscrowError::InvalidBps);
        }

        env.storage()
            .instance()
            .set(&DataKey::KeeperBountyBps, &bounty_bps);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "bounty_bps_set"), caller), bounty_bps);

        Ok(())
    }

    pub fn get_keeper_bounty_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::KeeperBountyBps)
            .unwrap_or(0)
    }

    // --- Multi-Admin Registry & Two-Step Whitelist Voting (Issue 59) ---

    pub fn is_admin(env: Env, account: Address) -> bool {
        Self::check_is_admin(&env, &account)
    }

    pub fn add_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }
        if Self::check_is_admin(&env, &new_admin) {
            return Err(EscrowError::AdminAlreadyExists);
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AdminCount)
            .unwrap_or(1);

        env.storage()
            .instance()
            .set(&DataKey::AdminRegistry(new_admin.clone()), &true);
        env.storage()
            .instance()
            .set(&DataKey::AdminCount, &(count + 1));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "admin_added"), new_admin), caller);

        Ok(())
    }

    pub fn remove_admin(
        env: Env,
        caller: Address,
        admin_to_remove: Address,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }
        if !Self::check_is_admin(&env, &admin_to_remove) {
            return Err(EscrowError::AdminNotFound);
        }

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AdminCount)
            .unwrap_or(1);

        if count <= 1 {
            return Err(EscrowError::CannotRemoveLastAdmin);
        }

        env.storage()
            .instance()
            .remove(&DataKey::AdminRegistry(admin_to_remove.clone()));

        if let Some(primary_admin) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
        {
            if primary_admin == admin_to_remove {
                // If primary admin removed, point to caller
                env.storage().instance().set(&DataKey::Admin, &caller);
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::AdminCount, &(count - 1));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "admin_removed"), admin_to_remove),
            caller,
        );

        Ok(())
    }

    pub fn get_admin_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::AdminCount)
            .unwrap_or(1)
    }

    /// Step 1: Propose adding or removing a token from the whitelist.
    pub fn propose_token_whitelist(
        env: Env,
        caller: Address,
        token: Address,
        whitelisted: bool,
    ) -> Result<u64, EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCounter)
            .unwrap_or(0);

        counter = counter
            .checked_add(1)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let proposal = WhitelistProposal {
            proposal_id: counter,
            token: token.clone(),
            whitelisted,
            proposer: caller.clone(),
            executed: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::WhitelistProposal(counter), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCounter, &counter);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "whitelist_proposed"), counter),
            (token, whitelisted, caller),
        );

        Ok(counter)
    }

    /// Step 2: Confirm a whitelist proposal. Must be confirmed by a distinct admin.
    pub fn confirm_token_whitelist(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        let mut proposal: WhitelistProposal = env
            .storage()
            .instance()
            .get(&DataKey::WhitelistProposal(proposal_id))
            .ok_or(EscrowError::ProposalNotFound)?;

        if proposal.executed {
            return Err(EscrowError::ProposalAlreadyExecuted);
        }

        if caller == proposal.proposer {
            return Err(EscrowError::CannotConfirmOwnProposal);
        }

        proposal.executed = true;
        env.storage()
            .instance()
            .set(&DataKey::WhitelistProposal(proposal_id), &proposal);

        env.storage().instance().set(
            &DataKey::TokenWhitelisted(proposal.token.clone()),
            &proposal.whitelisted,
        );
        env.storage()
            .instance()
            .set(&DataKey::WhitelistActive, &true);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "whitelist"), proposal.token.clone()),
            proposal.whitelisted,
        );
        env.events().publish(
            (Symbol::new(&env, "whitelist_confirmed"), proposal_id),
            (proposal.token, proposal.whitelisted),
        );

        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Result<WhitelistProposal, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::WhitelistProposal(proposal_id))
            .ok_or(EscrowError::ProposalNotFound)
    }

    // --- Contract Upgrade & Migration Hooks (Issue 53) ---

    /// Upgrades the contract WASM bytecode with strict administrator authorization.
    pub fn upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (Symbol::new(&env, "contract_upgraded"), new_wasm_hash),
            caller,
        );

        Ok(())
    }

    /// Post-upgrade storage schema migration hook.
    pub fn migrate(env: Env, caller: Address, target_version: u32) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        let current_version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(1);

        if target_version <= current_version {
            return Err(EscrowError::MigrationFailed);
        }

        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &target_version);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "state_migrated"), target_version),
            caller,
        );

        Ok(())
    }

    pub fn get_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(1)
    }

    pub fn resolve_dispute(
        env: Env,
        escrow_id: u64,
        caller: Address,
        payer_bps: u32,
        beneficiary_bps: u32,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();

        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        if (payer_bps as u64) + (beneficiary_bps as u64) != (BPS_DIVISOR as u64) {
            return Err(EscrowError::InvalidDisputeSplit);
        }

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        let is_rate_dispute: bool = env
            .storage()
            .persistent()
            .get(&DataKey::RateDispute(escrow_id))
            .unwrap_or(false);
        if record.status != EscrowStatus::Funded
            && !(record.status == EscrowStatus::Disputed && is_rate_dispute)
        {
            return Err(EscrowError::InvalidStatus);
        }

        let payer_amount = record
            .amount
            .checked_mul(payer_bps as i128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            / BPS_DIVISOR;

        let beneficiary_amount = record
            .amount
            .checked_sub(payer_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let token_client = token::Client::new(&env, &record.token);

        if payer_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &record.payer,
                &payer_amount,
            );
        }

        if beneficiary_amount > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &record.beneficiary,
                &beneficiary_amount,
            );
        }

        record.status = EscrowStatus::Disputed;
        env.storage().persistent().set(&key, &record);
        if is_rate_dispute {
            env.storage()
                .persistent()
                .remove(&DataKey::RateDispute(escrow_id));
        }
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "dispute_resolved"), escrow_id),
            (payer_amount, beneficiary_amount),
        );

        Ok(())
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowRecord, EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)
    }

    /// Paginated, read-only audit export of escrow records.
    pub fn get_escrows_paginated(env: Env, start_id: u64, limit: u32) -> Vec<EscrowEntry> {
        let mut page: Vec<EscrowEntry> = Vec::new(&env);

        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);

        let effective_limit = limit.min(MAX_PAGE_SIZE) as u64;
        let first = start_id.max(1);
        if effective_limit == 0 || first > counter {
            return page;
        }

        let last = (first - 1).saturating_add(effective_limit).min(counter);

        for escrow_id in first..=last {
            if let Some(record) = env
                .storage()
                .persistent()
                .get::<DataKey, EscrowRecord>(&DataKey::Escrow(escrow_id))
            {
                page.push_back(EscrowEntry { escrow_id, record });
            }
        }

        page
    }

    pub fn get_counter(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Result<Address, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)
    }

    pub fn get_treasury(env: Env) -> Result<Address, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(EscrowError::NotInitialized)
    }

    pub fn get_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    // --- Rate-Limiting Volume Governor (Issue 57) ---

    /// Sets the rolling 1-hour volume limit for a specific token.
    /// A limit of 0 disables the volume limit for that token.
    /// Requires administrator authorization.
    pub fn set_token_volume_limit(
        env: Env,
        caller: Address,
        token: Address,
        limit: i128,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        if limit < 0 {
            return Err(EscrowError::InvalidVolumeLimit);
        }

        env.storage()
            .instance()
            .set(&DataKey::TokenVolumeLimit(token.clone()), &limit);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "volume_limit_set"), token), limit);

        Ok(())
    }

    /// Alias for `set_token_volume_limit`.
    pub fn set_volume_limit(
        env: Env,
        caller: Address,
        token: Address,
        limit: i128,
    ) -> Result<(), EscrowError> {
        Self::set_token_volume_limit(env, caller, token, limit)
    }

    /// Gets the rolling 1-hour volume limit for a token. Returns 0 if no limit is set.
    pub fn get_token_volume_limit(env: Env, token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TokenVolumeLimit(token))
            .unwrap_or(0)
    }

    /// Alias for `get_token_volume_limit`.
    pub fn get_volume_limit(env: Env, token: Address) -> i128 {
        Self::get_token_volume_limit(env, token)
    }

    /// Returns the current active 1-hour rolling capital inflow for a token.
    /// If the rolling window has expired, returns 0.
    pub fn get_token_hourly_volume(env: Env, token: Address) -> i128 {
        if let Some(tracker) = env
            .storage()
            .instance()
            .get::<DataKey, VolumeTracker>(&DataKey::TokenVolumeTracker(token))
        {
            let current_time = env.ledger().timestamp();
            if current_time >= tracker.window_start.saturating_add(ROLLING_WINDOW_SECONDS) {
                0
            } else {
                tracker.volume
            }
        } else {
            0
        }
    }

    /// Alias for `get_token_hourly_volume`.
    pub fn get_hourly_volume(env: Env, token: Address) -> i128 {
        Self::get_token_hourly_volume(env, token)
    }

    /// Returns the raw volume tracker for a token (window_start and volume).
    pub fn get_token_volume_tracker(env: Env, token: Address) -> VolumeTracker {
        env.storage()
            .instance()
            .get(&DataKey::TokenVolumeTracker(token))
            .unwrap_or(VolumeTracker {
                window_start: env.ledger().timestamp(),
                volume: 0,
            })
    }

    /// Configures an institutional anchor's verification status for governor limit bypass.
    /// Requires administrator authorization.
    pub fn set_institutional_anchor(
        env: Env,
        caller: Address,
        anchor: Address,
        verified: bool,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::InstitutionalAnchor(anchor.clone()), &verified);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "institutional_anchor_set"), anchor),
            verified,
        );

        Ok(())
    }

    /// Alias for `set_institutional_anchor`.
    pub fn set_anchor_bypass(
        env: Env,
        caller: Address,
        anchor: Address,
        bypass: bool,
    ) -> Result<(), EscrowError> {
        Self::set_institutional_anchor(env, caller, anchor, bypass)
    }

    /// Returns whether an address is a verified institutional anchor with bypass privileges.
    pub fn is_institutional_anchor(env: Env, anchor: Address) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::InstitutionalAnchor(anchor))
            .unwrap_or(false)
    }

    /// Alias for `is_institutional_anchor`.
    pub fn is_anchor_bypass(env: Env, anchor: Address) -> bool {
        Self::is_institutional_anchor(env, anchor)
    }

    /// Manually resets the 1-hour rolling volume tracker for a token.
    /// Requires administrator authorization.
    pub fn reset_token_volume_tracker(
        env: Env,
        caller: Address,
        token: Address,
    ) -> Result<(), EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }

        caller.require_auth();
        if !Self::check_is_admin(&env, &caller) {
            return Err(EscrowError::Unauthorized);
        }

        let tracker = VolumeTracker {
            window_start: env.ledger().timestamp(),
            volume: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::TokenVolumeTracker(token.clone()), &tracker);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "volume_tracker_reset"), token), caller);

        Ok(())
    }
}
