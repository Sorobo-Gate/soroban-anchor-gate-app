FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY services/relay/go.mod services/relay/go.sum* ./
RUN go mod download

COPY services/relay/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o relay ./cmd/relay/main.go

FROM alpine:3.20

RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /app/relay .

ENV SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
ENV CONTRACT_ID="CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
ENV POLL_INTERVAL_SECONDS="5"
ENV STORE_PATH="/data/events.json"

VOLUME ["/data"]

CMD ["./relay"]
