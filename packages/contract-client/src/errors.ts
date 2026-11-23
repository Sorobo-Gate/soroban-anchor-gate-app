/**
 * @file Typed contract error hierarchy and parser with localized remediation suggestions.
 * Maps on-chain Soroban contract error codes into typed exception subclasses.
 */

/**
 * Numeric error codes emitted by the Soroban escrow contract.
 * Mirrors `contracts/src/errors.rs::EscrowError`.
 */
export enum EscrowErrorCode {
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
  ClawbackNotAllowed = 17,
  ProposalNotFound = 18,
  ProposalAlreadyExecuted = 19,
  CannotConfirmOwnProposal = 20,
  AdminAlreadyExists = 21,
  CannotRemoveLastAdmin = 22,
  AdminNotFound = 23,
  MigrationFailed = 24,
}

/**
 * Metadata definition for an on-chain contract error.
 */
export interface ErrorDefinition {
  readonly code: EscrowErrorCode;
  readonly name: string;
  readonly message: string;
  readonly remediation: string;
}

/**
 * Complete catalog of on-chain error definitions with clear remediation suggestions.
 */
export const ERROR_DEFINITIONS: Record<EscrowErrorCode, ErrorDefinition> = {
  [EscrowErrorCode.NotInitialized]: {
    code: EscrowErrorCode.NotInitialized,
    name: "NotInitialized",
    message: "The escrow contract has not been initialized yet.",
    remediation: "Invoke the `init` function with admin, treasury, and fee configuration before executing operations.",
  },
  [EscrowErrorCode.AlreadyInitialized]: {
    code: EscrowErrorCode.AlreadyInitialized,
    name: "AlreadyInitialized",
    message: "The contract has already been initialized.",
    remediation: "Initialization is a one-time operation. Do not call `init` on an already active contract.",
  },
  [EscrowErrorCode.Unauthorized]: {
    code: EscrowErrorCode.Unauthorized,
    name: "Unauthorized",
    message: "The caller does not have authorization to perform this operation.",
    remediation: "Verify that the signing address has the required admin, payer, or beneficiary privileges.",
  },
  [EscrowErrorCode.EscrowNotFound]: {
    code: EscrowErrorCode.EscrowNotFound,
    name: "EscrowNotFound",
    message: "No escrow record exists for the provided escrow ID.",
    remediation: "Check that the escrow ID is valid and has been created via `create_escrow`.",
  },
  [EscrowErrorCode.InvalidStatus]: {
    code: EscrowErrorCode.InvalidStatus,
    name: "InvalidStatus",
    message: "The escrow is in a state that does not permit the requested operation.",
    remediation: "Ensure the escrow is in `Funded` state before releasing/refunding, or `Disputed` before resolving disputes.",
  },
  [EscrowErrorCode.UnlockTimeNotReached]: {
    code: EscrowErrorCode.UnlockTimeNotReached,
    name: "UnlockTimeNotReached",
    message: "The lock period has not expired yet.",
    remediation: "Wait until the on-chain ledger timestamp exceeds the configured `unlock_timestamp` before requesting a refund.",
  },
  [EscrowErrorCode.UnlockTimePassed]: {
    code: EscrowErrorCode.UnlockTimePassed,
    name: "UnlockTimePassed",
    message: "The escrow unlock timestamp has already passed.",
    remediation: "Actions requiring an unexpired lock window cannot be performed after expiration.",
  },
  [EscrowErrorCode.ZeroAmount]: {
    code: EscrowErrorCode.ZeroAmount,
    name: "ZeroAmount",
    message: "The provided amount must be strictly greater than zero.",
    remediation: "Provide a positive, non-zero amount when creating escrows or making disbursements.",
  },
  [EscrowErrorCode.InvalidBps]: {
    code: EscrowErrorCode.InvalidBps,
    name: "InvalidBps",
    message: "Basis points are invalid or do not sum up to 10,000 (100%).",
    remediation: "Ensure basis point shares (e.g. platform fee bps or dispute split bps) are within [0, 10000] and sum to 10,000.",
  },
  [EscrowErrorCode.ArithmeticOverflow]: {
    code: EscrowErrorCode.ArithmeticOverflow,
    name: "ArithmeticOverflow",
    message: "An arithmetic operation resulted in an integer overflow or underflow.",
    remediation: "Check input amounts and fee calculations to ensure they fit within 64-bit/128-bit unsigned integer bounds.",
  },
  [EscrowErrorCode.TokenNotWhitelisted]: {
    code: EscrowErrorCode.TokenNotWhitelisted,
    name: "TokenNotWhitelisted",
    message: "The specified asset token contract is not on the accepted whitelist.",
    remediation: "Request an administrator to whitelist the token contract address using `set_token_whitelist`.",
  },
  [EscrowErrorCode.InvalidDisputeSplit]: {
    code: EscrowErrorCode.InvalidDisputeSplit,
    name: "InvalidDisputeSplit",
    message: "Dispute resolution basis points do not sum to 10,000.",
    remediation: "The sum of `payer_bps` and `beneficiary_bps` must equal exactly 10,000 basis points (100%).",
  },
  [EscrowErrorCode.EmptyDisbursement]: {
    code: EscrowErrorCode.EmptyDisbursement,
    name: "EmptyDisbursement",
    message: "The disbursement list cannot be empty.",
    remediation: "Provide at least one recipient recipient and amount in the batch disbursement list.",
  },
  [EscrowErrorCode.TooManyDisbursements]: {
    code: EscrowErrorCode.TooManyDisbursements,
    name: "TooManyDisbursements",
    message: "The number of disbursements exceeds the maximum batch limit.",
    remediation: "Split large disbursement batches into smaller chunks within contract capacity (max 25).",
  },
  [EscrowErrorCode.InvalidDisbursementAmount]: {
    code: EscrowErrorCode.InvalidDisbursementAmount,
    name: "InvalidDisbursementAmount",
    message: "One or more individual disbursement amounts are invalid (e.g. zero or negative).",
    remediation: "Verify that all items in the disbursement schedule contain valid, strictly positive amounts.",
  },
  [EscrowErrorCode.DisbursementMismatch]: {
    code: EscrowErrorCode.DisbursementMismatch,
    name: "DisbursementMismatch",
    message: "The sum of disbursements does not match the total escrowed balance.",
    remediation: "Recalculate split amounts so their sum matches the escrow's net available payout balance.",
  },
  [EscrowErrorCode.ClawbackNotAllowed]: {
    code: EscrowErrorCode.ClawbackNotAllowed,
    name: "ClawbackNotAllowed",
    message: "Clawback is prohibited for the selected escrow configuration.",
    remediation: "Clawback operations are only permitted if explicitly authorized during escrow provisioning.",
  },
  [EscrowErrorCode.ProposalNotFound]: {
    code: EscrowErrorCode.ProposalNotFound,
    name: "ProposalNotFound",
    message: "The requested multi-sig governance proposal does not exist.",
    remediation: "Confirm the proposal ID was properly created via multi-admin proposal workflows.",
  },
  [EscrowErrorCode.ProposalAlreadyExecuted]: {
    code: EscrowErrorCode.ProposalAlreadyExecuted,
    name: "ProposalAlreadyExecuted",
    message: "The proposal has already been executed.",
    remediation: "Governance proposals can only be executed once. Create a new proposal for subsequent changes.",
  },
  [EscrowErrorCode.CannotConfirmOwnProposal]: {
    code: EscrowErrorCode.CannotConfirmOwnProposal,
    name: "CannotConfirmOwnProposal",
    message: "Proposers cannot confirm their own proposals for threshold quorum.",
    remediation: "Require an independent administrator key to review and co-sign the multi-admin proposal.",
  },
  [EscrowErrorCode.AdminAlreadyExists]: {
    code: EscrowErrorCode.AdminAlreadyExists,
    name: "AdminAlreadyExists",
    message: "The designated address is already an administrator.",
    remediation: "Check current admin roster before attempting to add duplicate administrators.",
  },
  [EscrowErrorCode.CannotRemoveLastAdmin]: {
    code: EscrowErrorCode.CannotRemoveLastAdmin,
    name: "CannotRemoveLastAdmin",
    message: "Cannot remove the final remaining contract administrator.",
    remediation: "Appoint a replacement admin before removing the existing active administrator.",
  },
  [EscrowErrorCode.AdminNotFound]: {
    code: EscrowErrorCode.AdminNotFound,
    name: "AdminNotFound",
    message: "The target address is not in the administrator registry.",
    remediation: "Verify the admin public key address before attempting removal or privilege revocation.",
  },
  [EscrowErrorCode.MigrationFailed]: {
    code: EscrowErrorCode.MigrationFailed,
    name: "MigrationFailed",
    message: "Contract state migration failed or incompatible data schema encountered.",
    remediation: "Verify contract WASM hash and ensure storage schema version matches the upgrade target.",
  },
};

/**
 * Base exception class representing an on-chain contract failure.
 */
export class ContractError extends Error {
  public readonly code: number;
  public readonly errorName: string;
  public readonly remediation: string;
  public readonly rawError?: unknown;

  constructor(
    code: number,
    errorName: string,
    message: string,
    remediation: string,
    rawError?: unknown,
  ) {
    super(`[${errorName} (#${code})]: ${message}\nRemediation: ${remediation}`);
    this.name = "ContractError";
    this.code = code;
    this.errorName = errorName;
    this.remediation = remediation;
    this.rawError = rawError;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Concrete typed classes
export class NotInitializedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.NotInitialized];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "NotInitializedError";
  }
}

export class AlreadyInitializedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.AlreadyInitialized];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "AlreadyInitializedError";
  }
}

export class UnauthorizedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.Unauthorized];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "UnauthorizedError";
  }
}

export class EscrowNotFoundError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.EscrowNotFound];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "EscrowNotFoundError";
  }
}

export class InvalidStatusError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.InvalidStatus];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "InvalidStatusError";
  }
}

export class UnlockTimeNotReachedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.UnlockTimeNotReached];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "UnlockTimeNotReachedError";
  }
}

export class UnlockTimePassedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.UnlockTimePassed];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "UnlockTimePassedError";
  }
}

export class ZeroAmountError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.ZeroAmount];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "ZeroAmountError";
  }
}

export class InvalidBpsError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.InvalidBps];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "InvalidBpsError";
  }
}

export class ArithmeticOverflowError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.ArithmeticOverflow];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "ArithmeticOverflowError";
  }
}

export class TokenNotWhitelistedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.TokenNotWhitelisted];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "TokenNotWhitelistedError";
  }
}

export class InvalidDisputeSplitError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.InvalidDisputeSplit];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "InvalidDisputeSplitError";
  }
}

export class EmptyDisbursementError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.EmptyDisbursement];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "EmptyDisbursementError";
  }
}

export class TooManyDisbursementsError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.TooManyDisbursements];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "TooManyDisbursementsError";
  }
}

export class InvalidDisbursementAmountError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.InvalidDisbursementAmount];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "InvalidDisbursementAmountError";
  }
}

export class DisbursementMismatchError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.DisbursementMismatch];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "DisbursementMismatchError";
  }
}

export class ClawbackNotAllowedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.ClawbackNotAllowed];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "ClawbackNotAllowedError";
  }
}

export class ProposalNotFoundError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.ProposalNotFound];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalAlreadyExecutedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.ProposalAlreadyExecuted];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "ProposalAlreadyExecutedError";
  }
}

export class CannotConfirmOwnProposalError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.CannotConfirmOwnProposal];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "CannotConfirmOwnProposalError";
  }
}

export class AdminAlreadyExistsError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.AdminAlreadyExists];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "AdminAlreadyExistsError";
  }
}

export class CannotRemoveLastAdminError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.CannotRemoveLastAdmin];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "CannotRemoveLastAdminError";
  }
}

export class AdminNotFoundError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.AdminNotFound];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "AdminNotFoundError";
  }
}

export class MigrationFailedError extends ContractError {
  constructor(rawError?: unknown) {
    const def = ERROR_DEFINITIONS[EscrowErrorCode.MigrationFailed];
    super(def.code, def.name, def.message, def.remediation, rawError);
    this.name = "MigrationFailedError";
  }
}

export class UnknownContractError extends ContractError {
  constructor(code: number, rawError?: unknown) {
    super(
      code,
      "UnknownContractError",
      `Contract reverted with unrecognized error code #${code}.`,
      "Inspect transaction diagnostics and ensure client SDK versions match contract ABI deployment.",
      rawError,
    );
    this.name = "UnknownContractError";
  }
}

const ERROR_CLASS_MAP: Record<EscrowErrorCode, new (raw?: unknown) => ContractError> = {
  [EscrowErrorCode.NotInitialized]: NotInitializedError,
  [EscrowErrorCode.AlreadyInitialized]: AlreadyInitializedError,
  [EscrowErrorCode.Unauthorized]: UnauthorizedError,
  [EscrowErrorCode.EscrowNotFound]: EscrowNotFoundError,
  [EscrowErrorCode.InvalidStatus]: InvalidStatusError,
  [EscrowErrorCode.UnlockTimeNotReached]: UnlockTimeNotReachedError,
  [EscrowErrorCode.UnlockTimePassed]: UnlockTimePassedError,
  [EscrowErrorCode.ZeroAmount]: ZeroAmountError,
  [EscrowErrorCode.InvalidBps]: InvalidBpsError,
  [EscrowErrorCode.ArithmeticOverflow]: ArithmeticOverflowError,
  [EscrowErrorCode.TokenNotWhitelisted]: TokenNotWhitelistedError,
  [EscrowErrorCode.InvalidDisputeSplit]: InvalidDisputeSplitError,
  [EscrowErrorCode.EmptyDisbursement]: EmptyDisbursementError,
  [EscrowErrorCode.TooManyDisbursements]: TooManyDisbursementsError,
  [EscrowErrorCode.InvalidDisbursementAmount]: InvalidDisbursementAmountError,
  [EscrowErrorCode.DisbursementMismatch]: DisbursementMismatchError,
  [EscrowErrorCode.ClawbackNotAllowed]: ClawbackNotAllowedError,
  [EscrowErrorCode.ProposalNotFound]: ProposalNotFoundError,
  [EscrowErrorCode.ProposalAlreadyExecuted]: ProposalAlreadyExecutedError,
  [EscrowErrorCode.CannotConfirmOwnProposal]: CannotConfirmOwnProposalError,
  [EscrowErrorCode.AdminAlreadyExists]: AdminAlreadyExistsError,
  [EscrowErrorCode.CannotRemoveLastAdmin]: CannotRemoveLastAdminError,
  [EscrowErrorCode.AdminNotFound]: AdminNotFoundError,
  [EscrowErrorCode.MigrationFailed]: MigrationFailedError,
};

/**
 * Creates the appropriate typed `ContractError` subclass for a numeric error code.
 */
export function createContractError(code: number, rawError?: unknown): ContractError {
  const ClassConstructor = ERROR_CLASS_MAP[code as EscrowErrorCode];
  if (ClassConstructor) {
    return new ClassConstructor(rawError);
  }
  return new UnknownContractError(code, rawError);
}

/**
 * Extracts a numeric Soroban contract error code from various RPC simulation / submission formats.
 */
export function extractErrorCode(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }

  if (typeof raw === "string") {
    const patterns = [
      /Error\(Contract,\s*#?(\d+)\)/i,
      /ContractError\((\d+)\)/i,
      /error\s+code\s*[:=]\s*#?(\d+)/i,
      /\"code\"\s*:\s*(\d+)/i,
      /#(\d+)/,
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > 0) {
          return num;
        }
      }
    }
  }

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;

    if (typeof obj.code === "number" && obj.code > 0) {
      return obj.code;
    }

    if (typeof obj.error === "string") {
      const code = extractErrorCode(obj.error);
      if (code !== undefined) return code;
    }

    if (Array.isArray(obj.results) && obj.results.length > 0) {
      const firstResult = obj.results[0] as Record<string, unknown>;
      if (firstResult && typeof firstResult.error === "string") {
        const code = extractErrorCode(firstResult.error);
        if (code !== undefined) return code;
      }
    }

    if (Array.isArray(obj.events)) {
      for (const ev of obj.events) {
        if (typeof ev === "string") {
          const code = extractErrorCode(ev);
          if (code !== undefined) return code;
        }
      }
    }

    if (obj.message && typeof obj.message === "string") {
      const code = extractErrorCode(obj.message);
      if (code !== undefined) return code;
    }
  }

  return undefined;
}

/**
 * Parses any simulation response, RPC error, or thrown exception into a typed `ContractError`.
 */
export function parseContractError(error: unknown): ContractError | undefined {
  if (error instanceof ContractError) {
    return error;
  }

  const code = extractErrorCode(error);
  if (code !== undefined) {
    return createContractError(code, error);
  }

  return undefined;
}
