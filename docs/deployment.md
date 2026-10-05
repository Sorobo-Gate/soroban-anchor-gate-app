# Deployment & Infrastructure Guide

## 1. Web Frontend Deployment (`apps/web`)

The Next.js frontend can be deployed to Vercel, Netlify, or Docker container.

### Environment Variables for Web App
```env
NEXT_PUBLIC_ESCROW_CONTRACT_ID="CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
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
SOROBAN_CONTRACT_ID="CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
START_LEDGER="1"
```

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
CMD ["./relay"]
```
