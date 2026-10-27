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
}
