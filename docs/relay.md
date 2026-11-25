# Go Relay Daemon Architecture & Operations

## Overview

The Go Relay service (`services/relay`) monitors the Soroban blockchain for smart contract events emitted by the `SorobanAnchor Gate` contract and bridges off-chain anchor banking infrastructure.

## Key Features

1. **RPC Event Poller**: Queries `getEvents` on Soroban RPC at regular intervals (4s ticker).
2. **Typed Event Decoder**: Decodes `disbursed` events, extracting `escrow_id`, `payout_amount` (using `math/big.Int` to prevent integer truncation across the full `i128` numeric domain), `profile_hash_hex`, and `contract_id`.
3. **Durable File Store & Idempotency**: Thread-safe durable file store (`DurableFileStore`) persisting event states (`observed` → `claimed` → `processing` → `completed` / `failed`) to disk across daemon restarts and crashes.
4. **Ledger Cursor Persistence**: Tracks the latest processed ledger sequence number on disk, ensuring the daemon resumes without skipping or re-reading ledger windows.
5. **Graceful Shutdown**: Intercepts `os.Interrupt` and `SIGTERM` signals for clean lifecycle termination.
6. **Multi-Tenant Anchor Registry**: One daemon can serve several independent anchors, each with its own endpoint set and credentials.
7. **SEP-38 Quote Cache**: Active anchor quotes are cached in Redis with TTLs that mirror the quote lifetime.
8. **Chaos-Tested Resilience**: Network partitions, RPC 503 storms, corrupted event streams and anchor outages are covered by an end-to-end fault injection suite.

## Configuration Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOROBAN_CONTRACT_ID` | Yes | `CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT` | Deployed Soroban escrow contract ID |
| `SOROBAN_RPC_URL` | Yes | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint URL |
| `START_LEDGER` | No | `1` | Starting ledger sequence for event query window |
| `RELAY_STORE_PATH` | No | `""` (in-memory) or path | Durable file path for event state and cursor persistence |
| `ANCHOR_REGISTRY_FILE` | No | `""` | Path to the multi-anchor JSON registry (see below) |
| `REDIS_ADDRS` | No | `""` | Comma-separated Redis/cluster seed nodes (`host:port`) for the SEP-38 quote cache |

## Multi-Tenant Anchor Registry

`internal/anchor/registry.go` replaces the single-anchor environment model with an `anchors` map. Each entry declares its own domain and credentials:

```json
{
  "anchors": {
    "anclap": {
      "domain": "anclap.com",
      "home_domain": "anclap.com",
      "web_auth_endpoint": "https://anclap.com/auth",
      "transfer_server": "https://anclap.com/sep24",
      "quote_server": "https://anclap.com/sep38",
      "signing_key": "GANCLAPSIGNINGKEY...",
      "auth_key": "tenant-a-bearer-token",
      "client_account": "GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ",
      "network_passphrase": "Test SDF Network ; September 2015",
      "rate_limit": { "rps": 8, "burst": 16 }
    },
    "moneygram": {
      "domain": "moneygram.com",
      "quote_server": "https://moneygram.com/sep38",
      "auth_key": "tenant-b-bearer-token"
    }
  }
}
```

Load and validate it with `anchor.LoadRegistryConfig(path)` followed by `anchor.NewRegistry(cfg)`.

### Routing

Operations are routed by the escrow's target anchor domain (`EscrowTarget{ EscrowID, AnchorDomain }`), never by a daemon-wide default:

* `Registry.Route(target)` → the `Anchor` tenant bundle.
* `Registry.QuoteClientFor(target)` → that tenant's SEP-38 client.
* `Registry.InteractiveClientFor(target)` → that tenant's SEP-24 client.
* `Registry.Resolve(domain)` → normalization-aware lookup (`HTTPS://Anclap.com/sep38?x=1`, `anclap.com:443` and `anclap.com` are equivalent).

An unknown domain returns `ErrAnchorNotRegistered`; a disabled entry returns `ErrAnchorDisabled`. Neither falls back to another tenant.

### Credential isolation guarantees

* Every `Anchor` builds its own SEP-10/SEP-24/SEP-38 clients, each closing over that anchor's own token provider. A JWT minted for anchor A is never attached to a request sent to anchor B.
* Bearer credentials are resolved per request from that anchor's `auth_key` (or its SEP-10 token cache).
* `RegistryConfig` rejects duplicate domains after normalization, so two configuration entries can never compete for the same route.
* `Anchor.Config()` and `Registry.Anchors()` return redacted copies (`auth_key` / `signing_key` removed) so diagnostics cannot leak secrets.
* `auth_key` and `signing_key` values containing whitespace or control characters are rejected, preventing header injection.

## SEP-38 Quote Cache

`internal/cache/` provides a cache-aside layer for anchor quote lookups, which sit on the hot path of every escrow release.

* **Key scheme**: `anchor:quote:<id>`.
* **Backends**: `cache.RedisStore` (RESP over TCP, connection pooling, MOVED/ASK redirection, optional AUTH/SELECT/TLS) and `cache.MemoryStore` (single-process and tests).
* **TTL**: derived from the quote's own `expires_at`, capped by `MaxTTL` (default 5 minutes) and floored by `MinTTL` (default 1 second). Quotes already inside `MinTTL` of expiry are invalidated instead of cached, so an expired rate can never authorize a release.
* **Invalidation**: expired or unparseable entries are deleted on read (self-healing); `QuoteCache.Invalidate(id)` removes a quote explicitly.
* **Stampede protection**: `QuoteCache.GetOrLoad` collapses concurrent misses for the same quote ID into one anchor request.
* **Failure policy**: anchor errors are never cached; cache errors surface to the caller so the relay can fall back to the anchor.

Latency comparison (run locally; numbers depend on your anchor and network):

```bash
cd services/relay
go test ./internal/cache -run '^$' -bench 'BenchmarkQuoteLookup' -benchmem
```

`BenchmarkQuoteLookupCacheHit` measures the cached path and `BenchmarkQuoteLookupAnchorRoundTrip` models a 250µs anchor round trip, so the `ns/op` ratio of the two benchmarks is the latency improvement for repeated lookups of the same quote.

## Chaos Engineering & Recovery Time Objectives (RTO)

`internal/chaos_test.go` drives the real listener, idempotency store, transactional outbox and outbox worker against fault-injecting fakes.

### Fault matrix

| Fault | Injection | Expected relay behaviour |
|---|---|---|
| RPC network latency | 500ms delay on every third RPC call | Cursor does not advance until a response is accepted; no event is skipped |
| RPC 503 storm | Seeded 35% of RPC calls return HTTP 503 with a JSON-RPC error | Exponential backoff reconnects, then backfills from the persisted cursor |
| Corrupted event stream | Truncated ScVal `value.xdr` payloads interleaved with valid events | Decoder skips the bad event, logs at debug level, and keeps ingesting |
| Anchor outage | Seeded 25% of payout submissions return HTTP 503 | Outbox retries with a stable idempotency key; anchor settles exactly once |
| Duplicate delivery | Overlapping pages after reconnect | Idempotency store claims each event once; each event is emitted exactly once |

### Durability contract asserted by the suite

1. **No dropped events** — every disbursed event reaches a `completed` outbox state, even when RPC calls fail mid-stream.
2. **No double disbursement** — every payout settles exactly once; retries reuse the Soroban event ID as the idempotency key, and the fake anchor records zero duplicate settlements.
3. **Recovery** — after faults stop, the listener returns to `CONNECTED` and the pipeline drains.

### Recovery Time Objectives

| Scenario | RTO | Notes |
|---|---|---|
| Transient RPC 503 / network delay | ≤ 30s from the last injected fault to the last settled payout | Backoff starts at 10ms in tests (1s in production) and is capped at 80ms (60s in production) |
| Corrupted event stream | ≤ 30s | A bad event is skipped in the same poll cycle as its neighbours |
| Anchor payout outage | ≤ 30s after the anchor recovers | Outbox retries every poll interval (500ms in production, `MaxRetries` = 5) |
| Daemon restart | Resume from the persisted ledger cursor; no re-scan of already-processed ledgers | `DurableFileStore` + `processed_ledgers` |

The suite fails if the observed recovery exceeds `chaosRTOObjective` (30s), if any event is emitted more than once, or if any payout settles more than once.

Run it with:

```bash
cd services/relay
go test -race -run 'TestChaos' -v ./internal
```

The chaos tests are skipped under `go test -short` because the injected 500ms latency dominates the runtime.

## Testing

```bash
cd services/relay
go vet ./...
go test -v -race ./...
```
