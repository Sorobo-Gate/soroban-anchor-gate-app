use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Disbursed,
    Refunded,
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
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    FeeBps,
    EscrowCounter,
    Escrow(u64),
}
