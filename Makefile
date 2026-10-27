# SorobanAnchor Gate Monorepo Makefile

.PHONY: all install dev build build-contracts build-client build-web build-relay test test-contracts test-client test-web test-relay lint clean help

all: build

# Install dependencies across all packages and services
install:
	./install.sh

# Start web frontend and Go relay daemon concurrently
dev:
	npm run dev

# Build all components
build: build-contracts build-client build-web build-relay

build-contracts:
	cd contracts && $(MAKE) build

build-client:
	cd packages/contract-client && npm run build

build-web:
	cd apps/web && npm run build

build-relay:
	cd services/relay && go build -o relay cmd/relay/main.go

# Run all test suites
test: test-contracts test-client test-web test-relay

test-contracts:
	cd contracts && cargo test

test-client:
	cd packages/contract-client && npm test

test-web:
	cd apps/web && npm test

test-relay:
	cd services/relay && go test -v -race ./...

# Run formatters and linters
lint:
	cd contracts && cargo fmt --check
	cd packages/contract-client && npm run typecheck
	cd apps/web && npm run lint && npm run typecheck
	cd services/relay && go vet ./...

# Clean build artifacts
clean:
	npm run clean

help:
	@echo "Available commands:"
	@echo "  make install         - Run install.sh and install all dependencies"
	@echo "  make dev             - Start Next.js web interface and Go relay"
	@echo "  make build           - Build contracts WASM, SDK, web, and relay"
	@echo "  make test            - Run all automated test suites"
	@echo "  make test-contracts  - Run Soroban smart contract tests"
	@echo "  make test-web        - Run Next.js web application tests"
	@echo "  make test-relay      - Run Go relay service race tests"
	@echo "  make test-client     - Run TypeScript contract client tests"
	@echo "  make lint            - Run linters across all codebases"
	@echo "  make clean           - Remove build artifacts and node_modules"
