/**
 * Typed, user-friendly errors for the Soroban Anchor Gate escrow contract.
 *
 * Soroban reports contract failures as numeric codes embedded in diagnostic
 * strings such as `HostError: Error(Contract, #6)`. Applications that consume
 * that text directly end up with cryptic messages and duplicated:
 *
 * ```ts
 * if (message.includes("#6")) { ... }
 * ```
 *
 * This module turns every code declared by `contracts/src/errors.rs`
 * (`EscrowError`, `#1`–`#30`) into a dedicated {@link ContractError} subclass
 * carrying:
 *
 * - the stable numeric `code` and the Rust enum `errorName`,
 * - an English message describing what the contract rejected,
 * - a `remediation` hint telling the caller what to do next,
 * - the optional `contractId` and sanitized RPC diagnostic that produced it.
 *
 * It also exposes {@link parseContractError}, which accepts the shapes Soroban
 * RPC actually returns — raw strings, `Error` instances, simulation responses
 * with an `error` field, and objects exposing a numeric `contractErrorCode` —
 * and returns the matching typed error (or `undefined` when the input carries
 * no contract code).
 *
 * @example
 * ```ts
 * const failure = rpc.Api.isSimulationError(simulation)
 *   ? parseContractError(simulation)
 *   : undefined;
 *
 * if (failure instanceof UnlockTimeNotReachedError) {
 *   console.warn(failure.remediation);
 * }
 * ```
 *
 * @packageDocumentation
 */

/** Every error code currently declared by the escrow contract. */
export enum ContractErrorCode {
  /** The contract has not been initialized. */
  NotInitialized = 1,
  /** The contract was already initialized. */
  AlreadyInitialized = 2,
  /** The caller is not authorized for the requested operation. */
  Unauthorized = 3,
  /** No escrow exists for the supplied identifier. */
  EscrowNotFound = 4,
  /** The escrow is not in a state that permits the operation. */
  InvalidStatus = 5,
  /** The unlock timestamp has not been reached yet. */
  UnlockTimeNotReached = 6,
  /** The unlock timestamp has already passed. */
  UnlockTimePassed = 7,
  /** The supplied amount is zero. */
  ZeroAmount = 8,
  /** Basis points are invalid or do not sum to 10,000. */
  InvalidBps = 9,
  /** An arithmetic operation overflowed. */
  ArithmeticOverflow = 10,
  /** The token is not on the contract whitelist. */
  TokenNotWhitelisted = 11,
  /** The dispute split is invalid. */
  InvalidDisputeSplit = 12,
  /** The disbursement list is empty. */
  EmptyDisbursement = 13,
  /** The disbursement list contains too many entries. */
  TooManyDisbursements = 14,
  /** A disbursement amount is invalid. */
  InvalidDisbursementAmount = 15,
  /** The disbursement total does not match the escrow amount. */
  DisbursementMismatch = 16,
  /** The token's clawback configuration is not allowed. */
  ClawbackNotAllowed = 17,
  /** The requested whitelist proposal does not exist. */
  ProposalNotFound = 18,
  /** The whitelist proposal has already been executed. */
  ProposalAlreadyExecuted = 19,
  /** A proposal creator cannot confirm their own proposal. */
  CannotConfirmOwnProposal = 20,
  /** The administrator is already registered. */
  AdminAlreadyExists = 21,
  /** The contract cannot remove its last administrator. */
  CannotRemoveLastAdmin = 22,
  /** The requested administrator is not registered. */
  AdminNotFound = 23,
  /** The contract migration could not be completed. */
  MigrationFailed = 24,
  /** The hourly transfer volume limit has been exceeded. */
  HourlyVolumeLimitExceeded = 25,
  /** The configured volume limit is invalid. */
  InvalidVolumeLimit = 26,
  /** The contract blocked a re-entrant call. */
  ReentrancyDetected = 27,
  /** The supplied preimage does not match the escrow's hashlock. */
  InvalidPreimage = 28,
  /** The escrow has no hashlock configured. */
  HashlockNotSet = 29,
  /** The escrow's secondary beneficiary is not registered. */
  SecondaryBeneficiaryNotFound = 30,
}

/**
 * Documentation attached to one contract error code.
 */
export interface ContractErrorDefinition {
  /** Numeric code emitted by the contract. */
  code: ContractErrorCode;
  /** Rust enum member name, useful for logs and dashboards. */
  name: string;
  /** User-facing English description of the failure. */
  description: string;
  /** Actionable next step for the caller or operator. */
  remediation: string;
}

/**
 * Optional context attached to a typed contract error.
 */
export interface ContractErrorDetails {
  /** Contract ID that produced the failure, when known. */
  contractId?: string;
  /** Sanitized RPC or diagnostic text that carried the code. */
  rpcMessage?: string;
  /** Underlying error, preserved for debugging. */
  cause?: unknown;
}

/** Complete catalogue of the contract's error codes. */
export const CONTRACT_ERROR_DEFINITIONS: readonly ContractErrorDefinition[] = [
  {
    code: ContractErrorCode.NotInitialized,
    name: "NotInitialized",
    description: "The escrow contract has not been initialized yet.",
    remediation:
      "Deploy and initialize the contract with an admin, treasury, and fee before invoking escrow methods.",
  },
  {
    code: ContractErrorCode.AlreadyInitialized,
    name: "AlreadyInitialized",
    description: "The escrow contract has already been initialized.",
    remediation:
      "Reuse the existing deployment; initialization is a one-time operation per contract instance.",
  },
  {
    code: ContractErrorCode.Unauthorized,
    name: "Unauthorized",
    description: "The caller is not authorized to perform this operation.",
    remediation:
      "Sign the transaction with the payer, beneficiary, or admin account the contract expects, and verify the address passed in the call.",
  },
  {
    code: ContractErrorCode.EscrowNotFound,
    name: "EscrowNotFound",
    description: "The requested escrow does not exist.",
    remediation:
      "Check the escrow ID and confirm the escrow was created on the contract and network you are querying.",
  },
  {
    code: ContractErrorCode.InvalidStatus,
    name: "InvalidStatus",
    description: "The escrow is not in a state that permits this operation.",
    remediation:
      "Read the escrow with `get_escrow` first; release requires `Funded`, refund requires an unlocked `Funded` escrow, and disputes cannot be re-resolved.",
  },
  {
    code: ContractErrorCode.UnlockTimeNotReached,
    name: "UnlockTimeNotReached",
    description:
      "Escrow is still within its lock period; the unlock time has not been reached.",
    remediation:
      "Wait until the escrow's `unlock_timestamp` has passed, or ask the payer to release funds through `release_to_anchor`.",
  },
  {
    code: ContractErrorCode.UnlockTimePassed,
    name: "UnlockTimePassed",
    description: "The escrow's unlock time has already passed.",
    remediation:
      "Use `refund` for an unlocked escrow instead of an early release, or create a new escrow with a future lock duration.",
  },
  {
    code: ContractErrorCode.ZeroAmount,
    name: "ZeroAmount",
    description: "The escrow amount must be greater than zero.",
    remediation:
      "Pass a positive amount in the token's smallest unit, for example `10_000_000n` for 1 XLM.",
  },
  {
    code: ContractErrorCode.InvalidBps,
    name: "InvalidBps",
    description: "The supplied basis points are invalid.",
    remediation:
      "Use integer basis points in `0..=10_000` for splits, and `0..=1_000` for the protocol fee.",
  },
  {
    code: ContractErrorCode.ArithmeticOverflow,
    name: "ArithmeticOverflow",
    description: "An escrow arithmetic operation exceeded its supported range.",
    remediation:
      "Reduce the amount or fee so the total fits in `i128`, and verify token decimals match the amount you scaled.",
  },
  {
    code: ContractErrorCode.TokenNotWhitelisted,
    name: "TokenNotWhitelisted",
    description: "The token is not on the escrow contract whitelist.",
    remediation:
      "Ask an admin to add the token through `set_token_whitelist` before creating an escrow with it.",
  },
  {
    code: ContractErrorCode.InvalidDisputeSplit,
    name: "InvalidDisputeSplit",
    description: "The dispute split is invalid.",
    remediation:
      "Provide non-negative payer and beneficiary shares that sum to exactly 10,000 basis points.",
  },
  {
    code: ContractErrorCode.EmptyDisbursement,
    name: "EmptyDisbursement",
    description: "The disbursement list cannot be empty.",
    remediation:
      "Supply at least one anchor disbursement entry, or omit the disbursement path entirely.",
  },
  {
    code: ContractErrorCode.TooManyDisbursements,
    name: "TooManyDisbursements",
    description: "The disbursement list contains more entries than the contract allows.",
    remediation:
      "Split the payout into multiple escrows so each disbursement list stays within the contract limit.",
  },
  {
    code: ContractErrorCode.InvalidDisbursementAmount,
    name: "InvalidDisbursementAmount",
    description: "A disbursement amount is invalid.",
    remediation:
      "Ensure every disbursement amount is positive and expressed in the token's smallest unit.",
  },
  {
    code: ContractErrorCode.DisbursementMismatch,
    name: "DisbursementMismatch",
    description: "The disbursement amounts do not match the escrow amount.",
    remediation:
      "Make the disbursement amounts sum exactly to the escrowed amount before submitting the release.",
  },
  {
    code: ContractErrorCode.ClawbackNotAllowed,
    name: "ClawbackNotAllowed",
    description: "The token's clawback configuration is not allowed for escrow.",
    remediation:
      "Use a token without clawback enabled, or ask an admin to review the token policy before creating the escrow.",
  },
  {
    code: ContractErrorCode.ProposalNotFound,
    name: "ProposalNotFound",
    description: "The requested whitelist proposal does not exist.",
    remediation:
      "List the pending proposals and confirm the proposal ID; proposals are scoped to this contract deployment.",
  },
  {
    code: ContractErrorCode.ProposalAlreadyExecuted,
    name: "ProposalAlreadyExecuted",
    description: "The whitelist proposal has already been executed.",
    remediation:
      "Do not re-submit the same proposal; query the token whitelist to confirm the change already applied.",
  },
  {
    code: ContractErrorCode.CannotConfirmOwnProposal,
    name: "CannotConfirmOwnProposal",
    description: "A proposal creator cannot confirm their own proposal.",
    remediation:
      "Ask a different admin to confirm the proposal so the required multi-signature threshold is met.",
  },
  {
    code: ContractErrorCode.AdminAlreadyExists,
    name: "AdminAlreadyExists",
    description: "The administrator is already registered.",
    remediation:
      "Skip the registration call and list the current admins before adding another address.",
  },
  {
    code: ContractErrorCode.CannotRemoveLastAdmin,
    name: "CannotRemoveLastAdmin",
    description: "The contract cannot remove its last administrator.",
    remediation:
      "Register a replacement admin first, then remove the old address.",
  },
  {
    code: ContractErrorCode.AdminNotFound,
    name: "AdminNotFound",
    description: "The requested administrator is not registered.",
    remediation:
      "Verify the admin address and network; admins are stored per contract deployment.",
  },
  {
    code: ContractErrorCode.MigrationFailed,
    name: "MigrationFailed",
    description: "The contract migration could not be completed.",
    remediation:
      "Check the stored contract version and the migration payload, and retry only after the failing state entry is corrected.",
  },
  {
    code: ContractErrorCode.HourlyVolumeLimitExceeded,
    name: "HourlyVolumeLimitExceeded",
    description: "The hourly transfer volume limit has been exceeded.",
    remediation:
      "Wait for the rate-limiting window to reset, or split the operation into smaller transfers within the configured volume limit.",
  },
  {
    code: ContractErrorCode.InvalidVolumeLimit,
    name: "InvalidVolumeLimit",
    description: "The configured volume limit is invalid.",
    remediation:
      "Set a non-negative integer volume limit and ensure it is stored in the token's smallest unit.",
  },
  {
    code: ContractErrorCode.ReentrancyDetected,
    name: "ReentrancyDetected",
    description: "The contract blocked a re-entrant call.",
    remediation:
      "Retry the operation without nesting contract calls; the re-entrancy guard rejects nested entry until the outer call returns.",
  },
  {
    code: ContractErrorCode.InvalidPreimage,
    name: "InvalidPreimage",
    description: "The supplied preimage does not match the escrow's hashlock.",
    remediation:
      "Verify the preimage hashes to the value committed when the hashlock was configured, then retry the release.",
  },
  {
    code: ContractErrorCode.HashlockNotSet,
    name: "HashlockNotSet",
    description: "The escrow has no hashlock configured.",
    remediation:
      "Configure the hashlock before attempting a hashlocked release, or use the time-based release path instead.",
  },
  {
    code: ContractErrorCode.SecondaryBeneficiaryNotFound,
    name: "SecondaryBeneficiaryNotFound",
    description: "The escrow's secondary beneficiary is not registered.",
    remediation:
      "Register a secondary beneficiary on the escrow before relying on fallback routing.",
  },
];

/**
 * Catalogue keyed by numeric code for constant-time lookups.
 */
export const CONTRACT_ERROR_CATALOG: Readonly<
  Record<number, ContractErrorDefinition>
> = Object.freeze(
  CONTRACT_ERROR_DEFINITIONS.reduce<Record<number, ContractErrorDefinition>>(
    (catalog, definition) => {
      catalog[definition.code] = definition;
      return catalog;
    },
    {}
  )
);

/** Renders the diagnostic message for a definition. */
function buildMessage(definition: ContractErrorDefinition): string {
  return `${definition.description} (Anchor Gate contract error #${definition.code}: ${definition.name})`;
}

/**
 * Base class for every typed contract failure.
 *
 * Subclasses add no behaviour; they exist so callers can branch with
 * `instanceof` on a specific failure such as {@link UnlockTimeNotReachedError}.
 */
export class ContractError extends Error {
  /** Numeric code emitted by the contract. */
  public readonly code: number;

  /** Rust enum member name for the code. */
  public readonly errorName: string;

  /** Actionable next step for the caller or operator. */
  public readonly remediation: string;

  /** Contract ID that produced the failure, when known. */
  public readonly contractId?: string;

  /** Sanitized RPC diagnostic that carried the code, when available. */
  public readonly rpcMessage?: string;

  constructor(
    definition: ContractErrorDefinition,
    details: ContractErrorDetails = {}
  ) {
    super(buildMessage(definition), { cause: details.cause });
    this.name = "ContractError";
    this.code = definition.code;
    this.errorName = definition.name;
    this.remediation = definition.remediation;
    this.contractId = details.contractId;
    this.rpcMessage = details.rpcMessage;
  }
}

/** Raised when the contract has not been initialized. */
export class NotInitializedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.NotInitialized], details);
    this.name = "NotInitializedError";
  }
}

/** Raised when the contract was initialized twice. */
export class AlreadyInitializedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.AlreadyInitialized], details);
    this.name = "AlreadyInitializedError";
  }
}

/** Raised when the caller lacks the authorization a method requires. */
export class UnauthorizedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.Unauthorized], details);
    this.name = "UnauthorizedError";
  }
}

/** Raised when an escrow ID does not resolve to a stored record. */
export class EscrowNotFoundError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.EscrowNotFound], details);
    this.name = "EscrowNotFoundError";
  }
}

/** Raised when an operation is not valid for the escrow's current state. */
export class InvalidStatusError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidStatus], details);
    this.name = "InvalidStatusError";
  }
}

/** Raised when funds are still locked and cannot be refunded yet. */
export class UnlockTimeNotReachedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.UnlockTimeNotReached],
      details
    );
    this.name = "UnlockTimeNotReachedError";
  }
}

/** Raised when an operation requires a locked escrow but the lock has expired. */
export class UnlockTimePassedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.UnlockTimePassed], details);
    this.name = "UnlockTimePassedError";
  }
}

/** Raised when an amount is zero. */
export class ZeroAmountError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.ZeroAmount], details);
    this.name = "ZeroAmountError";
  }
}

/** Raised when basis points fall outside their permitted range. */
export class InvalidBpsError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidBps], details);
    this.name = "InvalidBpsError";
  }
}

/** Raised when contract arithmetic overflows its declared width. */
export class ArithmeticOverflowError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.ArithmeticOverflow],
      details
    );
    this.name = "ArithmeticOverflowError";
  }
}

/** Raised when a token is not whitelisted for escrow. */
export class TokenNotWhitelistedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.TokenNotWhitelisted],
      details
    );
    this.name = "TokenNotWhitelistedError";
  }
}

/** Raised when a dispute split is malformed. */
export class InvalidDisputeSplitError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidDisputeSplit],
      details
    );
    this.name = "InvalidDisputeSplitError";
  }
}

/** Raised when a disbursement list is empty. */
export class EmptyDisbursementError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.EmptyDisbursement], details);
    this.name = "EmptyDisbursementError";
  }
}

/** Raised when a disbursement list exceeds the contract limit. */
export class TooManyDisbursementsError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.TooManyDisbursements],
      details
    );
    this.name = "TooManyDisbursementsError";
  }
}

/** Raised when a disbursement amount is invalid. */
export class InvalidDisbursementAmountError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidDisbursementAmount],
      details
    );
    this.name = "InvalidDisbursementAmountError";
  }
}

/** Raised when disbursement amounts do not add up to the escrow amount. */
export class DisbursementMismatchError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.DisbursementMismatch],
      details
    );
    this.name = "DisbursementMismatchError";
  }
}

/** Raised when a token's clawback configuration is rejected. */
export class ClawbackNotAllowedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.ClawbackNotAllowed],
      details
    );
    this.name = "ClawbackNotAllowedError";
  }
}

/** Raised when a whitelist proposal cannot be found. */
export class ProposalNotFoundError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.ProposalNotFound], details);
    this.name = "ProposalNotFoundError";
  }
}

/** Raised when a whitelist proposal was already executed. */
export class ProposalAlreadyExecutedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.ProposalAlreadyExecuted],
      details
    );
    this.name = "ProposalAlreadyExecutedError";
  }
}

/** Raised when an admin tries to confirm their own proposal. */
export class CannotConfirmOwnProposalError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.CannotConfirmOwnProposal],
      details
    );
    this.name = "CannotConfirmOwnProposalError";
  }
}

/** Raised when an admin address is already registered. */
export class AdminAlreadyExistsError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.AdminAlreadyExists], details);
    this.name = "AdminAlreadyExistsError";
  }
}

/** Raised when the last remaining admin would be removed. */
export class CannotRemoveLastAdminError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.CannotRemoveLastAdmin],
      details
    );
    this.name = "CannotRemoveLastAdminError";
  }
}

/** Raised when an admin address is not registered. */
export class AdminNotFoundError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.AdminNotFound], details);
    this.name = "AdminNotFoundError";
  }
}

/** Raised when a contract migration cannot be completed. */
export class MigrationFailedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.MigrationFailed], details);
    this.name = "MigrationFailedError";
  }
}

/** Raised when the hourly volume limit is exceeded. */
export class HourlyVolumeLimitExceededError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.HourlyVolumeLimitExceeded],
      details
    );
    this.name = "HourlyVolumeLimitExceededError";
  }
}

/** Raised when the configured volume limit is invalid. */
export class InvalidVolumeLimitError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidVolumeLimit],
      details
    );
    this.name = "InvalidVolumeLimitError";
  }
}

/** Raised when the contract blocks a re-entrant call. */
export class ReentrancyDetectedError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.ReentrancyDetected],
      details
    );
    this.name = "ReentrancyDetectedError";
  }
}

/** Raised when a hashlock preimage does not match the commitment. */
export class InvalidPreimageError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.InvalidPreimage],
      details
    );
    this.name = "InvalidPreimageError";
  }
}

/** Raised when a hashlocked release is attempted without a hashlock. */
export class HashlockNotSetError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(CONTRACT_ERROR_CATALOG[ContractErrorCode.HashlockNotSet], details);
    this.name = "HashlockNotSetError";
  }
}

/** Raised when fallback routing cannot find the secondary beneficiary. */
export class SecondaryBeneficiaryNotFoundError extends ContractError {
  constructor(details: ContractErrorDetails = {}) {
    super(
      CONTRACT_ERROR_CATALOG[ContractErrorCode.SecondaryBeneficiaryNotFound],
      details
    );
    this.name = "SecondaryBeneficiaryNotFoundError";
  }
}

/**
 * Fallback for a numeric code the SDK does not know yet.
 *
 * New contract versions can add codes; surfacing them as this class keeps
 * `instanceof ContractError` handling working without hiding the raw number.
 */
export class UnknownContractError extends ContractError {
  constructor(code: number, details: ContractErrorDetails = {}) {
    super(
      {
        code: code as ContractErrorCode,
        name: "UnknownContractError",
        description: `The Anchor Gate contract failed with unrecognized error code ${code}.`,
        remediation:
          "Upgrade @soroban-anchor-gate/contract-client to a version that documents this code, and check the contract deployment version.",
      },
      details
    );
    this.name = "UnknownContractError";
  }
}

/** Matches `Error(Contract, #6)`, `Error(Contract,#6)`, and lowercase variants. */
const CONTRACT_ERROR_PATTERN =
  /\bError\s*\(\s*Contract\s*,\s*#?\s*(\d+)\s*\)/i;

/** Matches human-written diagnostics such as `contract error #12`. */
const CONTRACT_ERROR_TEXT_PATTERN = /\bcontract\s+error\s+#?\s*(\d+)\b/i;

/** Matches a bare numeric code string (`"6"`). */
const NUMERIC_CODE_PATTERN = /^\d{1,10}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIntegerCode(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && NUMERIC_CODE_PATTERN.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Extracts a contract error code from a diagnostic string.
 *
 * Recognizes Soroban's canonical `Error(Contract, #N)` form and the phrase
 * `contract error #N` used by RPC wrappers.
 *
 * @param value - Diagnostic text to inspect.
 * @returns The numeric code, or `undefined` when none is present.
 */
export function extractContractErrorCode(value: string): number | undefined {
  const canonical = CONTRACT_ERROR_PATTERN.exec(value);
  if (canonical) return Number(canonical[1]);
  const descriptive = CONTRACT_ERROR_TEXT_PATTERN.exec(value);
  if (descriptive) return Number(descriptive[1]);
  return undefined;
}

/**
 * Builds the typed error for a numeric contract error code.
 *
 * @param code - Code emitted by the contract.
 * @param details - Optional contract ID, RPC text, and underlying cause.
 * @returns A subclass of {@link ContractError}; {@link UnknownContractError}
 *   when the code is not in the catalogue.
 */
export function contractErrorFromCode(
  code: number,
  details: ContractErrorDetails = {}
): ContractError {
  switch (code) {
    case ContractErrorCode.NotInitialized:
      return new NotInitializedError(details);
    case ContractErrorCode.AlreadyInitialized:
      return new AlreadyInitializedError(details);
    case ContractErrorCode.Unauthorized:
      return new UnauthorizedError(details);
    case ContractErrorCode.EscrowNotFound:
      return new EscrowNotFoundError(details);
    case ContractErrorCode.InvalidStatus:
      return new InvalidStatusError(details);
    case ContractErrorCode.UnlockTimeNotReached:
      return new UnlockTimeNotReachedError(details);
    case ContractErrorCode.UnlockTimePassed:
      return new UnlockTimePassedError(details);
    case ContractErrorCode.ZeroAmount:
      return new ZeroAmountError(details);
    case ContractErrorCode.InvalidBps:
      return new InvalidBpsError(details);
    case ContractErrorCode.ArithmeticOverflow:
      return new ArithmeticOverflowError(details);
    case ContractErrorCode.TokenNotWhitelisted:
      return new TokenNotWhitelistedError(details);
    case ContractErrorCode.InvalidDisputeSplit:
      return new InvalidDisputeSplitError(details);
    case ContractErrorCode.EmptyDisbursement:
      return new EmptyDisbursementError(details);
    case ContractErrorCode.TooManyDisbursements:
      return new TooManyDisbursementsError(details);
    case ContractErrorCode.InvalidDisbursementAmount:
      return new InvalidDisbursementAmountError(details);
    case ContractErrorCode.DisbursementMismatch:
      return new DisbursementMismatchError(details);
    case ContractErrorCode.ClawbackNotAllowed:
      return new ClawbackNotAllowedError(details);
    case ContractErrorCode.ProposalNotFound:
      return new ProposalNotFoundError(details);
    case ContractErrorCode.ProposalAlreadyExecuted:
      return new ProposalAlreadyExecutedError(details);
    case ContractErrorCode.CannotConfirmOwnProposal:
      return new CannotConfirmOwnProposalError(details);
    case ContractErrorCode.AdminAlreadyExists:
      return new AdminAlreadyExistsError(details);
    case ContractErrorCode.CannotRemoveLastAdmin:
      return new CannotRemoveLastAdminError(details);
    case ContractErrorCode.AdminNotFound:
      return new AdminNotFoundError(details);
    case ContractErrorCode.MigrationFailed:
      return new MigrationFailedError(details);
    case ContractErrorCode.HourlyVolumeLimitExceeded:
      return new HourlyVolumeLimitExceededError(details);
    case ContractErrorCode.InvalidVolumeLimit:
      return new InvalidVolumeLimitError(details);
    case ContractErrorCode.ReentrancyDetected:
      return new ReentrancyDetectedError(details);
    case ContractErrorCode.InvalidPreimage:
      return new InvalidPreimageError(details);
    case ContractErrorCode.HashlockNotSet:
      return new HashlockNotSetError(details);
    case ContractErrorCode.SecondaryBeneficiaryNotFound:
      return new SecondaryBeneficiaryNotFoundError(details);
    default:
      return new UnknownContractError(code, details);
  }
}

/**
 * Narrows an unknown value to a {@link ContractError}.
 *
 * @param value - Value to check.
 * @returns `true` when the value is a typed contract error.
 */
export function isContractError(value: unknown): value is ContractError {
  return value instanceof ContractError;
}

/** Shared options for the parser, used for the recursive branches. */
interface ParseContext {
  contractId?: string;
  cause?: unknown;
  depth: number;
}

function parseWithContext(
  input: unknown,
  context: ParseContext
): ContractError | undefined {
  if (input === null || input === undefined) return undefined;
  if (input instanceof ContractError) return input;
  if (context.depth > 4) return undefined;

  const next: ParseContext = { ...context, depth: context.depth + 1 };

  if (input instanceof Error) {
    return parseWithContext(input.message, {
      ...next,
      cause: context.cause ?? input,
    });
  }

  if (typeof input === "number") {
    return input >= 0 && Number.isSafeInteger(input)
      ? contractErrorFromCode(input, {
          contractId: context.contractId,
          cause: context.cause,
        })
      : undefined;
  }

  if (typeof input === "string") {
    const code = extractContractErrorCode(input);
    if (code === undefined) return undefined;
    return contractErrorFromCode(code, {
      contractId: context.contractId,
      rpcMessage: input,
      cause: context.cause,
    });
  }

  if (!isRecord(input)) return undefined;

  const contractId =
    typeof input.contractId === "string"
      ? input.contractId
      : context.contractId;

  for (const key of ["contractErrorCode", "contractError", "code"]) {
    const code = toIntegerCode(input[key]);
    if (code !== undefined) {
      return contractErrorFromCode(code, {
        contractId,
        rpcMessage:
          typeof input.message === "string" ? input.message : undefined,
        cause: context.cause ?? input,
      });
    }
  }

  for (const key of ["error", "message", "diagnostic", "details"]) {
    const nested = input[key];
    if (typeof nested === "string" || isRecord(nested)) {
      const parsed = parseWithContext(nested, { ...next, contractId });
      if (parsed) return parsed;
    }
  }

  if (Array.isArray(input.events)) {
    for (const event of input.events) {
      const parsed = parseWithContext(event, { ...next, contractId });
      if (parsed) return parsed;
    }
  }

  return undefined;
}

/**
 * Parses any Soroban RPC failure shape into a typed {@link ContractError}.
 *
 * Accepted inputs include:
 *
 * - the canonical diagnostic string `Error(Contract, #6)`,
 * - `Error` instances whose message carries the code,
 * - simulation responses such as `{ error: "HostError: Error(Contract, #5)" }`,
 * - parsed objects exposing `contractErrorCode`,
 * - the numeric code itself.
 *
 * Inputs without a recognizable code (transport failures, timeouts, plain
 * validation errors) return `undefined`, so callers can keep their existing
 * handling for non-contract failures.
 *
 * @param failure - Unknown failure value from a simulation or submission.
 * @param options - Optional contract ID attached to the returned error.
 * @returns The typed contract error, or `undefined` when no code is present.
 */
export function parseContractError(
  failure: unknown,
  options: { contractId?: string } = {}
): ContractError | undefined {
  return parseWithContext(failure, {
    contractId: options.contractId,
    depth: 0,
  });
}

/**
 * Renders a one-line, user-facing explanation plus remediation for a code.
 *
 * @param code - Contract error code.
 * @returns Message followed by the remediation hint.
 */
export function describeContractError(code: number): string {
  const error = contractErrorFromCode(code);
  return `${error.message} ${error.remediation}`;
}
