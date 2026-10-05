import { StrKey } from "@stellar/stellar-sdk";

export const DEFAULT_TESTNET_CONTRACT_ID =
  "CD36A2JQEEQSBTKOE6T5PB3BPV7IGIYDSSOBOOK6NE4RSOWGNC2HXXDA";
export const DEFAULT_TESTNET_RPC_URL =
  "https://soroban-testnet.stellar.org";
export const DEFAULT_TESTNET_PASSPHRASE =
  "Test SDF Network ; September 2015";
export const DEFAULT_TESTNET_NATIVE_SAC =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export interface AppConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  nativeSacTokenAddress: string;
}

export function validateContractId(contractId: string | undefined): string {
  if (!contractId || contractId.trim() === "") {
    throw new Error(
      "Contract ID is required. Please set NEXT_PUBLIC_ESCROW_CONTRACT_ID."
    );
  }
  const trimmed = contractId.trim();
  if (!StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid contract ID format: "${contractId}". Must be a valid 56-character Stellar StrKey contract address (starting with 'C').`
    );
  }
  return trimmed;
}

export function validateNetworkPassphrase(passphrase: string | undefined): string {
  if (!passphrase || passphrase.trim() === "") {
    throw new Error(
      "Stellar network passphrase is required. Please set NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE."
    );
  }
  return passphrase.trim();
}

export function validateRpcUrl(rpcUrl: string | undefined): string {
  if (!rpcUrl || !rpcUrl.startsWith("http")) {
    throw new Error(
      `Invalid Soroban RPC URL: "${rpcUrl}". Must be a valid HTTP or HTTPS endpoint.`
    );
  }
  return rpcUrl.trim();
}

export function getAppConfig(): AppConfig {
  const rawContractId =
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || DEFAULT_TESTNET_CONTRACT_ID;
  const contractId = validateContractId(rawContractId);

  const rawRpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || DEFAULT_TESTNET_RPC_URL;
  const rpcUrl = validateRpcUrl(rawRpcUrl);

  const rawPassphrase =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || DEFAULT_TESTNET_PASSPHRASE;
  const networkPassphrase = validateNetworkPassphrase(rawPassphrase);

  const nativeSacTokenAddress =
    process.env.NEXT_PUBLIC_TOKEN_SAC_ADDRESS || DEFAULT_TESTNET_NATIVE_SAC;

  return {
    contractId,
    rpcUrl,
    networkPassphrase,
    nativeSacTokenAddress,
  };
}
