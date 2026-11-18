use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Disbursed,
    Refunded,
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRecord {
    pub payer: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub amount: i128,
    pub profile_hash: BytesN<32>,
    pub status: EscrowStatus,
    pub unlock_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformSettings {
    pub admin: Address,
    pub treasury: Address,
    pub fee_bps: u32,
    pub keeper_bounty_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    FeeBps,
    KeeperBountyBps,
    EscrowCounter,
    Escrow(u64),
    TokenWhitelisted(Address),
    WhitelistActive,
}
