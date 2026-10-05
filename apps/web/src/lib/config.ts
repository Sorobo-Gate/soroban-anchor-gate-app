import { StrKey } from "@stellar/stellar-sdk";

export interface AppConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export function getAppConfig(): AppConfig {
  const contractId =
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ||
    "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y";
  const rpcUrl =
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org";
  const networkPassphrase =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ||
    "Test SDF Network ; September 2015";

  if (!StrKey.isValidContract(contractId)) {
    console.warn(
      `Warning: Configured contract ID ${contractId} is not a valid strkey contract address. Using fallback.`
    );
  }

  return {
    contractId,
    rpcUrl,
    networkPassphrase,
  };
}
