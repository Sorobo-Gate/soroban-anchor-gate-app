# Multi-architecture Go builder stage
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH
ARG TARGETVARIANT

WORKDIR /app

COPY services/relay/go.mod services/relay/go.sum* ./
RUN go mod download

COPY services/relay/ ./
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -ldflags="-s -w" -o relay ./cmd/relay/main.go

# Minimal multi-architecture runtime stage
FROM alpine:3.20

RUN apk --no-cache add ca-certificates tzdata && \
    addgroup -g 10001 -S relaygroup && \
    adduser -u 10001 -S relayuser -G relaygroup && \
    mkdir -p /data && \
    chown -R relayuser:relaygroup /data

WORKDIR /app
COPY --from=builder /app/relay .

ENV SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
ENV CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
ENV SOROBAN_CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
ENV PORT="8080"
ENV POLL_INTERVAL_SECONDS="5"
ENV STORE_PATH="/data/events.json"

USER relayuser

EXPOSE 8080

VOLUME ["/data"]

CMD ["./relay"]
