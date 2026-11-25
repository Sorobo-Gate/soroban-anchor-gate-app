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
pub struct EscrowInitParams {
    pub payer: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub amount: i128,
    pub profile_hash: BytesN<32>,
    pub lock_duration: u64,
    pub cancellation_penalty_bps: u32,
    pub referrer: Option<Address>,
    pub committed_rate: Option<i128>,
    pub hashlock: Option<BytesN<32>>,
    pub secondary_beneficiary: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowTerms {
    pub created_at: u64,
    pub cancellation_penalty_bps: u32,
    pub referrer: Option<Address>,
    pub committed_rate: Option<i128>,
    pub hashlock: Option<BytesN<32>>,
    pub secondary_beneficiary: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowStream {
    pub payer: Address,
    pub beneficiary: Address,
    pub token: Address,
    pub rate_per_second: i128,
    pub last_withdrawn: u64,
    pub end_time: u64,
    pub terminated: bool,
}

/// A single leg of a split payout: one off-chain bank-account commitment that
/// receives a fixed share of an escrow's distributable balance.
///
/// `commitment_hash` is an opaque 32-byte digest that binds the on-chain leg to
/// the anchor's off-chain disbursement instruction (e.g. a hash of the
/// beneficiary bank account + reference), so auditors can reconcile each
/// tracking event against the anchor's ledger without exposing PII on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisbursementCommitment {
    pub recipient: Address,
    pub amount: i128,
    pub commitment_hash: BytesN<32>,
}

/// One row of a paginated audit export: the escrow identifier paired with
/// its current on-chain record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowEntry {
    pub escrow_id: u64,
    pub record: EscrowRecord,
}

/// Proposal for token whitelist modification requiring multi-admin consensus.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WhitelistProposal {
    pub proposal_id: u64,
    pub token: Address,
    pub whitelisted: bool,
    pub proposer: Address,
    pub executed: bool,
}

/// Rolling 1-hour volume tracker for an asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolumeTracker {
    pub window_start: u64,
    pub volume: i128,
}

/// Settlement proposal for mutual split between payer and beneficiary.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementProposal {
    pub escrow_id: u64,
    pub proposer: Address,
    pub payer_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    FeeBps,
    EscrowCounter,
    Escrow(u64),
    TokenWhitelisted(Address),
    WhitelistActive,
    // Clawback compatibility layer (Issue 51)
    TokenClawbackFlag(Address),
    AllowClawbackTokens,
    // Decentralized keeper incentives (Issue 52)
    KeeperBountyBps,
    // Upgradeable contract proxy & migration (Issue 53)
    ContractVersion,
    // Multi-token whitelist voting & admin registry (Issue 59)
    AdminRegistry(Address),
    AdminCount,
    WhitelistProposal(u64),
    ProposalCounter,
    // Rate-limiting volume governor (Issue 57)
    TokenVolumeLimit(Address),
    TokenVolumeTracker(Address),
    InstitutionalAnchor(Address),
    EscrowTerms(u64),
    RateOracle,
    MaxRateDeviationBps,
    RateDispute(u64),
    StreamCounter,
    Stream(u64),
    // Cross-contract reentrancy lock (Issue 67)
    ReentrancyLock,
    // Cryptographic hashlock HTLC release (Issue 65)
    Hashlock(u64),
    // Secondary beneficiary fallback routing (Issue 64)
    SecondaryBeneficiary(u64),
}
