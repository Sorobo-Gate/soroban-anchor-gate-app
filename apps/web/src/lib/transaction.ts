import {
  Address,
  Contract,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { parseTokenAmount } from "./crypto";

export interface EscrowFormData {
  payer: string;
  beneficiary: string;
  token: string;
  amount: string;
  lockDurationDays: string;
  routingInfo: string;
}

export interface ValidatedEscrowParams {
  payer: string;
  beneficiary: string;
  token: string;
  baseUnitsAmount: bigint;
  lockDurationSeconds: bigint;
  routingInfo: string;
}

export interface ConfirmedTransactionResult {
  hash: string;
  ledger: number;
  status: "SUCCESS";
  createdAt: number;
}

export function validateEscrowForm(data: EscrowFormData): ValidatedEscrowParams {
  if (!data.payer || !StrKey.isValidEd25519PublicKey(data.payer)) {
    throw new Error(
      `Invalid payer wallet address: "${data.payer}". Must be a valid 56-character Ed25519 G... address.`
    );
  }

  if (
    !data.beneficiary ||
    (!StrKey.isValidEd25519PublicKey(data.beneficiary) &&
      !StrKey.isValidContract(data.beneficiary))
  ) {
    throw new Error(
      `Invalid contractor/beneficiary address: "${data.beneficiary}". Must be a valid Stellar public key or contract address.`
    );
  }

  if (!data.token || !StrKey.isValidContract(data.token)) {
    throw new Error(
      `Invalid token contract address: "${data.token}". Must be a valid 56-character C... contract address.`
    );
  }

  const baseUnitsAmount = parseTokenAmount(data.amount, 7);
  if (baseUnitsAmount <= 0n) {
    throw new Error("Escrow amount must be strictly greater than zero");
  }

  const days = parseInt(data.lockDurationDays, 10);
  if (isNaN(days) || days <= 0 || days > 365) {
    throw new Error("Lock duration must be a positive integer between 1 and 365 days");
  }
  const lockDurationSeconds = BigInt(days * 86400);

  if (!data.routingInfo || data.routingInfo.trim() === "") {
    throw new Error("Beneficiary routing information cannot be empty");
  }

  return {
    payer: data.payer,
    beneficiary: data.beneficiary,
    token: data.token,
    baseUnitsAmount,
    lockDurationSeconds,
    routingInfo: data.routingInfo.trim(),
  };
}

export function verifyWalletNetwork(
  networkDetails: { network?: string; networkPassphrase?: string } | null | undefined,
  expectedPassphrase: string
): void {
  if (!networkDetails) {
    throw new Error(
      "Unable to verify Freighter wallet network. Please ensure Freighter is unlocked and set to Stellar Testnet."
    );
  }

  const connected = networkDetails.networkPassphrase || networkDetails.network || "";
  if (connected.trim() !== expectedPassphrase.trim()) {
    throw new Error(
      `Wallet network mismatch: Freighter is connected to "${connected}", but application requires "${expectedPassphrase}". Please switch Freighter to Stellar Testnet.`
    );
  }
}

export function buildEscrowContractCall(
  contractId: string,
  params: ValidatedEscrowParams,
  profileHashHex: string
): xdr.Operation {
  const hashBytes = Buffer.from(profileHashHex, "hex");
  if (hashBytes.length !== 32) {
    throw new Error(
      `Invalid profile hash length: expected 32 bytes (64 hex characters), got ${hashBytes.length}`
    );
  }

  const contract = new Contract(contractId);
  return contract.call(
    "create_escrow",
    new Address(params.payer).toScVal(),
    new Address(params.beneficiary).toScVal(),
    new Address(params.token).toScVal(),
    nativeToScVal(params.baseUnitsAmount, { type: "i128" }),
    xdr.ScVal.scvBytes(hashBytes),
    nativeToScVal(params.lockDurationSeconds, { type: "u64" })
  );
}

export async function buildInitialTransaction(
  server: rpc.Server,
  sourceAddress: string,
  operation: xdr.Operation,
  networkPassphrase: string,
  baseFee: string = "100000"
): Promise<Transaction> {
  const account = await server.getAccount(sourceAddress);

  return new TransactionBuilder(account, {
    fee: baseFee,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();
}

export async function simulateAndPrepareTransaction(
  server: rpc.Server,
  tx: Transaction
): Promise<{ preparedTx: Transaction; simulation: rpc.Api.SimulateTransactionResponse }> {
  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    const errorDetails = sim.error || "Simulation rejected by Soroban host";
    throw new Error(`Soroban transaction simulation failed: ${errorDetails}`);
  }

  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Soroban transaction simulation did not return a successful state");
  }

  const preparedTx = rpc.assembleTransaction(tx, sim).build();
  return { preparedTx, simulation: sim };
}

export async function submitSignedTransaction(
  server: rpc.Server,
  signedTxXdr: string,
  networkPassphrase: string
): Promise<string> {
  if (!signedTxXdr || signedTxXdr.trim() === "") {
    throw new Error("Signed transaction XDR is empty or invalid");
  }

  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
  const sendResponse = await server.sendTransaction(signedTx);

  if (sendResponse.status === "ERROR") {
    const msg =
      sendResponse.errorResult?.toXDR("base64") ||
      sendResponse.diagnosticEvents?.map((e) => e.toString()).join("; ") ||
      "Unknown RPC error";
    throw new Error(`Transaction submission failed with RPC error: ${msg}`);
  }

  if (!sendResponse.hash) {
    throw new Error("RPC sendTransaction response did not return a transaction hash");
  }

  return sendResponse.hash;
}

export async function pollTransactionConfirmation(
  server: rpc.Server,
  hash: string,
  maxAttempts: number = 30,
  intervalMs: number = 2000
): Promise<ConfirmedTransactionResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const txStatus = await server.getTransaction(hash);

    if (txStatus.status === "SUCCESS") {
      return {
        hash,
        ledger: txStatus.latestLedger,
        status: "SUCCESS",
        createdAt: txStatus.createdAt || Date.now(),
      };
    }

    if (txStatus.status === "FAILED") {
      const resultXdr = txStatus.resultXdr?.toXDR("base64") || "Unknown result";
      throw new Error(
        `Transaction failed onchain in ledger ${txStatus.latestLedger}. Result: ${resultXdr}`
      );
    }

    // Status is "NOT_FOUND" while pending inclusion in block
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Transaction ${hash} confirmation timed out after ${
      (maxAttempts * intervalMs) / 1000
    }s. Please check Stellar Expert for ledger finality.`
  );
}
