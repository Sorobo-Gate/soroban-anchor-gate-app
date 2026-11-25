/**
 * Unified wallet adapter layer for the Soroban Anchor Gate SDK.
 *
 * Every adapter implements the same {@link WalletAdapter} contract:
 * `connect`, `getAddress`, and `signTransaction`. Applications can therefore
 * offer wallet selection without branching on vendor APIs, and tests can swap
 * in {@link MockWalletAdapter}.
 *
 * Supported integrations:
 *
 * - {@link FreighterAdapter} — `@stellar/freighter-api` / `window.freighterApi`
 * - {@link XBullAdapter} — `window.xBullSDK`
 * - {@link AlbedoAdapter} — `window.albedo`
 * - {@link MockWalletAdapter} — deterministic in-memory signer for tests
 *
 * @packageDocumentation
 */

export { WalletError, isWalletError } from "./types";
export type {
  WalletAdapter,
  WalletConnection,
  WalletErrorCode,
  WalletId,
  WalletSignOptions,
} from "./types";
export { FreighterAdapter } from "./freighter";
export type {
  FreighterAdapterOptions,
  FreighterApi,
  FreighterSignParams,
} from "./freighter";
export { XBullAdapter } from "./xbull";
export type {
  XBullAdapterOptions,
  XBullSdk,
  XBullSignParams,
} from "./xbull";
export { AlbedoAdapter } from "./albedo";
export type {
  AlbedoAdapterOptions,
  AlbedoNetwork,
  AlbedoProvider,
  AlbedoTxParams,
} from "./albedo";
export { MockWalletAdapter } from "./mock";
export type { MockWalletAdapterOptions } from "./mock";
