# Deployment & Infrastructure Guide

## 1. Web Frontend Deployment (`apps/web`)

The Next.js frontend can be deployed to Vercel, Netlify, or a Docker container.

### Environment Variables for Web App
```env
NEXT_PUBLIC_ESCROW_CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
NEXT_PUBLIC_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

### Build Commands
```bash
cd apps/web
npm install
npm run build
```

---

## 2. Go Relay Daemon Deployment (`services/relay`)

The Go relay service is a long-running background process suited for systemd, Docker, or Kubernetes.

### Environment Variables for Relay Service
```env
SOROBAN_CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
START_LEDGER="5036360"
STORE_PATH="/data/relay_state.json"
```

`STORE_PATH=:memory:` runs the relay with process-local memory state. Any other
value uses the durable JSON file store. Neither store is shared between
processes, so both are single-replica deployments.

### Dockerfile Deployment Example
```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /relay ./cmd/relay/main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /relay .
VOLUME ["/data"]
CMD ["./relay"]
```

---

## 3. High-Availability & Zero-Downtime Rolling Deployments

> **Deployment gate:** the relay currently ships with `MemoryStore` and
> `DurableFileStore`. Both keep event state inside a single process, so two
> replicas polling the same contract each see the same `disbursed` event and
> can each call the anchor. That is a double-payout. **Run exactly one replica
> until the deployment provides a shared `store.IdempotencyStore` backend.**

The rest of this section defines the coordination contract such a backend must
implement, how to verify it with the repository's HA harness, and how to roll
the relay out once it is in place.

### 3.1 Coordination contract for a shared backend

A shared backend (PostgreSQL is the reference) must make event ownership atomic
across processes. The relay relies on four states:

| State | Meaning |
|---|---|
| `observed` | A replica saw the event in an RPC poll. |
| `processing` | A replica owns the event and is disbursing through the anchor. |
| `completed` | The anchor payout succeeded; the event is terminal. |
| `failed` | Processing failed and the event may be retried. |

Claiming must be a single atomic conditional write against a unique event ID.
This is the PostgreSQL form used by the verification harness:

```sql
INSERT INTO processed_events (event_id, state, updated_at)
VALUES ($1, 'processing', $2)
ON CONFLICT (event_id) DO UPDATE
SET state = 'processing', updated_at = EXCLUDED.updated_at, error = NULL
WHERE processed_events.state NOT IN ('completed', 'processing')
RETURNING state;
```

PostgreSQL takes a row lock for the winner. A concurrent replica blocks on that
lock, re-evaluates the `WHERE` clause after the winner commits, and receives no
row: it must treat the event as owned elsewhere, not disburse, and not revert
the state. Observing an event must likewise never steal ownership from a
replica that is already processing it. A completed claim must be rejected on
every subsequent poll.

The shared ledger cursor must be monotonic. Concurrent replicas may report
different `latestLedger` values, so advance it with a conditional upsert that
only accepts a higher ledger:

```sql
INSERT INTO relay_cursor (id, last_ledger) VALUES (1, $1)
ON CONFLICT (id) DO UPDATE
SET last_ledger = EXCLUDED.last_ledger
WHERE relay_cursor.last_ledger <= EXCLUDED.last_ledger
RETURNING last_ledger;
```

A rejected update means the cursor would regress; the replica keeps the stored
value. This prevents an old pod finishing a poll late and rewinding the rollout
to already-processed ledgers.

### 3.2 Verifying a shared backend

`services/relay/internal/ha_test.go` is the executable acceptance test for this
contract. It creates an isolated schema, runs the existing migrations, and
starts **two independent replicas** with separate connection pools against the
same database. A fake Soroban RPC endpoint feeds both replicas the same events,
and a fake anchor counts every payout request. The test asserts:

- exactly one claim winner when four replicas race on one event;
- a completed event cannot be claimed or completed twice;
- concurrent cursor updates settle on the highest ledger and regressions fail;
- both replicas poll the shared feed, yet every event and every escrow is
  disbursed **exactly once** and ends in the shared `completed` state.

Run it against a disposable PostgreSQL database:

```bash
cd services/relay
POSTGRES_URL="postgres://postgres:postgres@127.0.0.1:55432/relay_ha?sslmode=disable" \
  go test -v -race -count=1 ./internal/
```

Expected result:

```text
=== RUN   TestPostgresStore_ConcurrentClaimSingleWinner
--- PASS: TestPostgresStore_ConcurrentClaimSingleWinner (0.71s)
=== RUN   TestPostgresStore_ConcurrentCursorMonotonic
--- PASS: TestPostgresStore_ConcurrentCursorMonotonic (0.58s)
=== RUN   TestRelayReplicas_NoDuplicatePayoutsDuringRollingDeploy
--- PASS: TestRelayReplicas_NoDuplicatePayoutsDuringRollingDeploy (5.41s)
PASS
ok      github.com/soroban-anchor-gate/relay/internal    7.751s
```

The test skips (rather than failing) when `POSTGRES_URL` and `DATABASE_URL` are
unset, so the default unit suite stays dependency-free. Each run creates and
drops its own `ha_test_<timestamp>` schema; it never touches application data.

### 3.3 Rolling deployment procedure

Before enabling more than one replica:

1. **Provision PostgreSQL** with the schema from migrations 000001 and 000002
   (`processed_events`, `relay_cursor`, `schema_migrations`). Use a dedicated
   database and a pooled connection string.
2. **Wire the shared backend** into the relay's store selection and keep the
   file/memory stores as the single-replica fallback. Do not point two replicas
   at per-pod `STORE_PATH` volumes and call it HA.
3. **Run the HA harness** from section 3.2 against the production-like database
   before the rollout.
4. **Expose `/health`** for readiness and liveness probes, and `/status` for the
   shared `total_events` count used in post-rollout checks.
5. **Set a termination grace period** longer than one in-flight anchor request
   so `SIGTERM` can stop the poller cleanly.

Then use a surge-first rollout so an old replica is only terminated after the
new one is healthy:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: soroban-relay
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: soroban-relay
  template:
    metadata:
      labels:
        app: soroban-relay
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: relay
          image: ghcr.io/example/soroban-relay:1.4.0
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: SOROBAN_CONTRACT_ID
              value: CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT
            - name: SOROBAN_RPC_URL
              value: https://soroban-testnet.stellar.org
            - name: START_LEDGER
              value: "5036360"
            # Configure the shared idempotency backend for this build here.
          readinessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 15
            periodSeconds: 10
```

During the overlap both pods poll the same events. The shared claim lets only
one of them disburse each event; the other records a claim conflict and moves
on. After the rollout, confirm that a previously completed event never returns
to `observed` or `processing` and that `/status` reports the expected total.

**If you cannot provide a shared backend yet**, deploy a single replica with
`maxSurge: 0, maxUnavailable: 1`. That avoids duplicate payouts at the cost of a
short ingestion gap during the restart. A one-replica `maxSurge: 1` rollout is
unsafe with the file store: the overlap itself creates two pollers.

### 3.4 Operational notes and limits

- **Shared state is mandatory for overlap.** Replica count above one, including
  a brief rolling overlap, requires a shared store that passes section 3.2.
- **A crashed replica can leave an event in `processing`.** This blocks a
  duplicate payout but also prevents automatic retry; inspect and requeue the
  row only after confirming whether the anchor paid. `completed` is written
  only after the anchor returns success.
- **The anchor call is not idempotent by itself.** If the anchor succeeds and
  the relay crashes before `MarkCompleted`, the event stays `processing`. Send
  the event ID as an idempotency key wherever the anchor supports one.
- **Latency matters.** Claim and completion writes happen while an event is
  processed. Keep PostgreSQL close to the relay and watch pool saturation
  during ledger bursts.
- **Never hand-edit `processed_events` rows** to force a retry without knowing
  which replica owns the row; the state machine is the payout audit trail.

---

## 4. Multi-Architecture Container Builds (`linux/amd64` & `linux/arm64`)

Both `apps/web/Dockerfile` and `services/relay/Dockerfile` are configured for deterministic multi-architecture builds targeting **Apple Silicon (`linux/arm64`)** and **Linux servers (`linux/amd64`)**, with non-root runtime users, native health checks, and minimized final image footprints:

- **`apps/web/Dockerfile`**:
  - Uses BuildKit syntax (`docker/dockerfile:1.7`), `npm ci --ignore-scripts` with BuildKit npm cache mounts, and Next.js `output: "standalone"` (`apps/web/next.config.ts`) so devDependencies (`playwright`, `eslint`, `typescript`, `axe-core`, etc.) are omitted from the production `runner` image.
  - Runs as non-root user `nextjs` (UID `1001`) with a built-in Node `fetch` `HEALTHCHECK`.
  - Excludes non-web paths via `apps/web/Dockerfile.dockerignore`.
- **`services/relay/Dockerfile`**:
  - Uses `FROM --platform=$BUILDPLATFORM golang:1.22-alpine` with `ARG TARGETOS` / `ARG TARGETARCH` and `CGO_ENABLED=0` for fast native cross-compilation to both `linux/amd64` and `linux/arm64`.
  - Uses `gcr.io/distroless/static-debian12:nonroot` (`USER nonroot:nonroot`, UID `65532`) for minimal runtime image size (~15 MB) and zero shell/package-manager attack surface.
  - Includes a built-in `relay healthcheck` CLI subcommand (`services/relay/cmd/relay/main.go`) for distroless `HEALTHCHECK` verification.
  - Excludes non-relay paths via `services/relay/Dockerfile.dockerignore`.

### Local Multi-Arch Build & Verification

```bash
# Ensure Buildx builder with QEMU multi-arch emulation is active
docker buildx create --use --name soroban-multiarch || docker buildx use soroban-multiarch

# Build both services for linux/amd64 and linux/arm64
docker buildx build --platform linux/amd64,linux/arm64 -f apps/web/Dockerfile .
docker buildx build --platform linux/amd64,linux/arm64 -f services/relay/Dockerfile .

# Verify container startup & healthcheck on each architecture (single-arch load)
docker buildx build --platform linux/amd64 --load -t soroban-relay:amd64 -f services/relay/Dockerfile .
docker run --rm -d -p 8080:8080 --name relay-amd64 soroban-relay:amd64
curl -sf http://127.0.0.1:8080/health && docker stop relay-amd64
```

### Reference CI Workflow (`.github/workflows/docker.yml`)

> **Note:** Repository policy (`scripts/ci/issue_compliance.js`) restricts `.github/workflows/` modifications to maintainers. Maintainers can enable the multi-architecture Buildx workflow below directly in `.github/workflows/docker.yml`:

```yaml
name: Multi-Arch Docker Builds

on:
  push:
    branches: [develop, main]
  pull_request:
    branches: [develop, main]

jobs:
  docker-multiarch:
    name: Build & Verify (${{ matrix.service }} / ${{ matrix.platform }})
    runs-on: ubuntu-latest
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        include:
          - service: web
            dockerfile: apps/web/Dockerfile
            platform: linux/amd64
            port: "3000"
            health_path: /
          - service: web
            dockerfile: apps/web/Dockerfile
            platform: linux/arm64
            port: "3000"
            health_path: /
          - service: relay
            dockerfile: services/relay/Dockerfile
            platform: linux/amd64
            port: "8080"
            health_path: /health
          - service: relay
            dockerfile: services/relay/Dockerfile
            platform: linux/arm64
            port: "8080"
            health_path: /health
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - name: Build image (${{ matrix.service }} - ${{ matrix.platform }})
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          platforms: ${{ matrix.platform }}
          load: true
          tags: soroban-${{ matrix.service }}:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Verify image footprint & container startup
        run: |
          docker image inspect soroban-${{ matrix.service }}:ci --format '{{.Architecture}} {{.Size}}'
          cid=$(docker run -d -p ${{ matrix.port }}:${{ matrix.port }} soroban-${{ matrix.service }}:ci)
          trap 'docker rm -f "$cid"' EXIT
          for i in $(seq 1 15); do
            if curl -sf "http://127.0.0.1:${{ matrix.port }}${{ matrix.health_path }}" >/dev/null; then
              exit 0
            fi
            sleep 2
          done
          docker logs "$cid"
          exit 1
```

