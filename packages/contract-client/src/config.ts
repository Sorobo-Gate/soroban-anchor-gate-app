/**
 * Network presets and validation for the Soroban Anchor Gate contract client.
 *
 * The presets contain network connection settings. Only Testnet has a
 * repository-verified contract deployment; Mainnet and Standalone callers
 * must provide their own contract ID before creating a client.
 *
 * @packageDocumentation
 */

import { Networks, StrKey } from "@stellar/stellar-sdk";
import type { ClientConfig } from "./index";

/** Supported Stellar network identities. Futurenet is a separate network. */
export type NetworkName = "testnet" | "mainnet" | "standalone";

/** Canonical passphrases for the supported network presets. */
export type NetworkPassphrase =
  | Networks.TESTNET
  | Networks.PUBLIC
  | Networks.STANDALONE;

/** Connection settings for one explicitly selected Stellar network. */
export interface NetworkConfig {
  /** Selected network; this is never inferred from the RPC URL. */
  readonly network: NetworkName;
  /** Soroban RPC endpoint. HTTP is supported for local development. */
  readonly rpcUrl: string;
  /** Canonical passphrase for `network`, used when building transactions. */
  readonly networkPassphrase: NetworkPassphrase;
  /** Deployed contract ID, when known or explicitly supplied by the caller. */
  readonly contractId?: string;
}

/** Allowed network customization. The selected network and passphrase stay fixed. */
export interface NetworkConfigOverrides {
  /** Custom HTTP(S) RPC endpoint for this network. */
  readonly rpcUrl?: string;
  /** Contract instance deployed on the selected network. */
  readonly contractId?: string;
}

/** Stellar Testnet network settings and the verified Anchor Gate deployment. */
export const TESTNET: Readonly<NetworkConfig> & {
  /** Identifies this preset as Stellar Testnet. */
  readonly network: "testnet";
  /** Repository-verified Anchor Gate Testnet deployment. */
  readonly contractId: string;
} = Object.freeze({
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  contractId:
    "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
});

/**
 * Stellar Mainnet production settings using a public Soroban RPC endpoint. A
 * deployed contract ID must be supplied by the caller. Selecting this preset
 * only configures an unsigned client; it does not sign or submit transactions.
 */
export const MAINNET: Readonly<NetworkConfig> & {
  /** Identifies this preset as Stellar Mainnet. */
  readonly network: "mainnet";
} = Object.freeze({
  network: "mainnet",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,
});

/** Local Stellar Standalone settings; this is not the distinct Futurenet. */
export const STANDALONE: Readonly<NetworkConfig> & {
  /** Identifies this preset as a local Standalone network. */
  readonly network: "standalone";
} = Object.freeze({
  network: "standalone",
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: Networks.STANDALONE,
});

const PRESETS: Readonly<Record<NetworkName, NetworkConfig>> = Object.freeze({
  testnet: TESTNET,
  mainnet: MAINNET,
  standalone: STANDALONE,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNetworkName(value: unknown): value is NetworkName {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PRESETS, value)
  );
}

/**
 * Validates an HTTP(S) Soroban endpoint without performing a network request.
 *
 * @internal
 */
export function validateRpcUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("RPC URL must be a non-empty absolute HTTP(S) URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("RPC URL must be a non-empty absolute HTTP(S) URL");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw new TypeError("RPC URL must use HTTP or HTTPS and include a host");
  }
}

/**
 * Validates that a network configuration uses a supported identity and its
 * matching canonical Stellar passphrase.
 *
 * @param value - Candidate network configuration.
 * @throws {TypeError} If the configuration or RPC URL is malformed.
 * @throws {RangeError} If its network identity is unsupported.
 */
export function validateNetworkConfig(
  value: unknown
): asserts value is NetworkConfig {
  if (!isRecord(value)) {
    throw new TypeError("Network configuration must be an object");
  }
  if (!isNetworkName(value.network)) {
    throw new RangeError(`Unsupported Stellar network: ${String(value.network)}`);
  }

  const preset = PRESETS[value.network];
  if (value.networkPassphrase !== preset.networkPassphrase) {
    throw new Error(
      `Network passphrase does not match the selected ${value.network} network`
    );
  }
  validateRpcUrl(value.rpcUrl);

  if (
    value.contractId !== undefined &&
    (typeof value.contractId !== "string" ||
      !StrKey.isValidContract(value.contractId))
  ) {
    throw new TypeError("Network contractId must be a valid Stellar contract ID");
  }
}

/**
 * Creates an independent network configuration with optional RPC or contract
 * overrides. The RPC URL never determines the network or changes its
 * passphrase. Returned configurations are frozen.
 *
 * @param network - Explicitly selected preset identity.
 * @param overrides - Optional RPC endpoint and deployed contract ID.
 * @returns A frozen configuration for the selected network.
 * @throws {RangeError} If `network` is not Testnet, Mainnet, or Standalone.
 * @throws {TypeError} If an override is malformed or attempts to replace the
 *   network identity or passphrase.
 *
 * @example
 * ```ts
 * const localTestnet = createNetworkConfig("testnet", {
 *   rpcUrl: "http://localhost:8000/soroban/rpc",
 * });
 * // Keeps the Testnet passphrase even though the RPC endpoint is local.
 * ```
 */
export function createNetworkConfig<N extends NetworkName>(
  network: N,
  overrides: NetworkConfigOverrides = {}
): NetworkConfig & {
  /** Selected preset identity; RPC overrides do not change this value. */
  readonly network: N;
} {
  if (!isNetworkName(network)) {
    throw new RangeError(`Unsupported Stellar network: ${String(network)}`);
  }
  if (!isRecord(overrides)) {
    throw new TypeError("Network overrides must be an object");
  }
  for (const key of Object.keys(overrides)) {
    if (key !== "rpcUrl" && key !== "contractId") {
      throw new TypeError(
        `Network override '${key}' is not supported; select a preset to change networks`
      );
    }
  }

  const preset = PRESETS[network];
  const rpcUrl =
    overrides.rpcUrl === undefined ? preset.rpcUrl : overrides.rpcUrl;
  validateRpcUrl(rpcUrl);
  const contractId =
    overrides.contractId === undefined
      ? preset.contractId
      : overrides.contractId;
  if (
    contractId !== undefined &&
    (typeof contractId !== "string" || !StrKey.isValidContract(contractId))
  ) {
    throw new TypeError("Network contractId must be a valid Stellar contract ID");
  }
  const config = Object.freeze({
    network,
    rpcUrl,
    networkPassphrase: preset.networkPassphrase,
    ...(contractId === undefined ? {} : { contractId }),
  }) as NetworkConfig & { readonly network: N };
  validateNetworkConfig(config);
  return config;
}

/**
 * Combines a selected network with its deployed contract ID for
 * {@link EscrowGateClient}. Mainnet and Standalone require an explicit ID;
 * this package does not assume those deployments exist.
 *
 * @param networkConfig - A preset or customized network configuration.
 * @param contractId - Optional deployment ID; defaults to a verified preset ID.
 * @returns Client settings carrying the selected network and passphrase.
 * @throws {Error} If no contract ID is configured or the ID is invalid.
 *
 * @example
 * ```ts
 * const testnetClientConfig = createClientConfig(TESTNET);
 * const client = new EscrowGateClient(testnetClientConfig);
 * ```
 */
export function createClientConfig(
  networkConfig: NetworkConfig,
  contractId?: string
): ClientConfig {
  validateNetworkConfig(networkConfig);
  const selectedContractId =
    contractId === undefined ? networkConfig.contractId : contractId;
  if (!selectedContractId || !StrKey.isValidContract(selectedContractId)) {
    throw new Error(
      `A valid contract ID is required for the ${networkConfig.network} network`
    );
  }

  return {
    contractId: selectedContractId,
    network: networkConfig.network,
    rpcUrl: networkConfig.rpcUrl,
    networkPassphrase: networkConfig.networkPassphrase,
  };
}
