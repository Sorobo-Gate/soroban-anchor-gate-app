use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    EscrowNotFound = 4,
    InvalidStatus = 5,
    UnlockTimeNotReached = 6,
    UnlockTimePassed = 7,
    ZeroAmount = 8,
    InvalidBps = 9,
    ArithmeticOverflow = 10,
    TokenNotWhitelisted = 11,
    InvalidDisputeSplit = 12,
    EmptyDisbursement = 13,
    TooManyDisbursements = 14,
    InvalidDisbursementAmount = 15,
    DisbursementMismatch = 16,
    // Wave enhancements: Issues 51, 52, 53, 59
    ClawbackNotAllowed = 17,
    ProposalNotFound = 18,
    ProposalAlreadyExecuted = 19,
    CannotConfirmOwnProposal = 20,
    AdminAlreadyExists = 21,
    CannotRemoveLastAdmin = 22,
    AdminNotFound = 23,
    MigrationFailed = 24,
    // Rate-limiting volume governor (Issue 57)
    HourlyVolumeLimitExceeded = 25,
    InvalidVolumeLimit = 26,
    // Cross-contract reentrancy lock (Issue 67)
    ReentrancyDetected = 27,
    // Cryptographic hashlock HTLC release (Issue 65)
    InvalidPreimage = 28,
    HashlockNotSet = 29,
    // Secondary beneficiary fallback routing (Issue 64)
    SecondaryBeneficiaryNotFound = 30,
}
