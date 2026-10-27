#![no_std]

mod errors;
mod types;

#[cfg(test)]
mod test;

use crate::errors::EscrowError;
use crate::types::{DataKey, EscrowRecord, EscrowStatus};
use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, BytesN, Env, Symbol};

const BPS_DIVISOR: i128 = 10_000;
const PERSISTENT_EXTEND_TTL_THRESHOLD: u32 = 100_000;
const PERSISTENT_EXTEND_TTL_AMOUNT: u32 = 200_000;
const INSTANCE_EXTEND_TTL_THRESHOLD: u32 = 100_000;
const INSTANCE_EXTEND_TTL_AMOUNT: u32 = 200_000;

#[contract]
pub struct EscrowGate;

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
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
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
        payer.require_auth();

        if amount <= 0 {
            return Err(EscrowError::ZeroAmount);
        }

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

    pub fn release_to_anchor(
        env: Env,
        escrow_id: u64,
        caller: Address,
        anchor_disbursement_address: Address,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;

        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        if caller != record.payer && caller != admin {
            return Err(EscrowError::Unauthorized);
        }

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0);
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(EscrowError::NotInitialized)?;

        let fee_amount = record
            .amount
            .checked_mul(fee_bps as i128)
            .ok_or(EscrowError::ArithmeticOverflow)?
            / BPS_DIVISOR;
        let payout_amount = record
            .amount
            .checked_sub(fee_amount)
            .ok_or(EscrowError::ArithmeticOverflow)?;

        let token_client = token::Client::new(&env, &record.token);

        if fee_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &treasury, &fee_amount);
        }

        token_client.transfer(
            &env.current_contract_address(),
            &anchor_disbursement_address,
            &payout_amount,
        );

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

    pub fn refund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let key = DataKey::Escrow(escrow_id);
        let mut record: EscrowRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::EscrowNotFound)?;

        record.payer.require_auth();

        if record.status != EscrowStatus::Funded {
            return Err(EscrowError::InvalidStatus);
        }

        if env.ledger().timestamp() < record.unlock_timestamp {
            return Err(EscrowError::UnlockTimeNotReached);
        }

        let token_client = token::Client::new(&env, &record.token);
        token_client.transfer(
            &env.current_contract_address(),
            &record.payer,
            &record.amount,
        );

        record.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&key, &record);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_EXTEND_TTL_THRESHOLD, INSTANCE_EXTEND_TTL_AMOUNT);

        env.events()
            .publish((Symbol::new(&env, "refunded"), escrow_id), record.amount);

        Ok(())
    }
}
