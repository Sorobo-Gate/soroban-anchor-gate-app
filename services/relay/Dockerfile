# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY services/relay/go.mod services/relay/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY services/relay/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay/main.go && \
    mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=builder --chown=65532:65532 /out/relay /app/relay
COPY --from=builder --chown=65532:65532 /out/data /data

ENV SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
ENV CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
ENV POLL_INTERVAL_SECONDS="5"
ENV STORE_PATH="/data/events.json"
ENV PORT="8080"

EXPOSE 8080
VOLUME ["/data"]

USER nonroot:nonroot

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/relay", "healthcheck"]

ENTRYPOINT ["/app/relay"]
