# SorobanAnchor Gate Contract Makefile

.PHONY: all build build-optimized test hash clean deploy-testnet init-contract install-tools setup-testnet help

# Default target
all: build

# Build the contract WASM
build:
	cargo build --target wasm32-unknown-unknown --release
	@$(MAKE) hash

# Build with optimization using stellar/soroban CLI
build-optimized:
	cargo build --target wasm32-unknown-unknown --release
	@if command -v stellar >/dev/null 2>&1; then \
		stellar contract optimize --wasm target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm; \
	elif command -v soroban >/dev/null 2>&1; then \
		soroban contract optimize --wasm target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm; \
	else \
		echo "Stellar/Soroban CLI not found. Install it for WASM optimization."; \
	fi
	@$(MAKE) hash

# Calculate WASM hash
hash:
	@if [ -f target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm ]; then \
		if command -v sha256sum >/dev/null 2>&1; then \
			echo -n "WASM Hash (Release):    " && sha256sum target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm | cut -d' ' -f1; \
		elif command -v shasum >/dev/null 2>&1; then \
			echo -n "WASM Hash (Release):    " && shasum -a 256 target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm | cut -d' ' -f1; \
		else \
			echo -n "WASM Hash (Release):    " && openssl dgst -sha256 target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm | awk '{print $$NF}'; \
		fi; \
	else \
		echo "WASM target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm not found. Run 'make build' first."; \
	fi
	@if [ -f target/wasm32-unknown-unknown/release/soroban_anchor_escrow.optimized.wasm ]; then \
		if command -v sha256sum >/dev/null 2>&1; then \
			echo -n "WASM Hash (Optimized):  " && sha256sum target/wasm32-unknown-unknown/release/soroban_anchor_escrow.optimized.wasm | cut -d' ' -f1; \
		elif command -v shasum >/dev/null 2>&1; then \
			echo -n "WASM Hash (Optimized):  " && shasum -a 256 target/wasm32-unknown-unknown/release/soroban_anchor_escrow.optimized.wasm | cut -d' ' -f1; \
		else \
			echo -n "WASM Hash (Optimized):  " && openssl dgst -sha256 target/wasm32-unknown-unknown/release/soroban_anchor_escrow.optimized.wasm | awk '{print $$NF}'; \
		fi; \
	fi

# Run tests
test:
	cargo test

# Run clippy linter
lint:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings

# Clean build artifacts
clean:
	cargo clean
	rm -f *.wasm

# Deploy to testnet
deploy-testnet:
	@if [ -z "$(STELLAR_SECRET_KEY)" ] && [ -z "$(SOURCE_ACCOUNT)" ]; then \
		echo "Error: Set STELLAR_SECRET_KEY or SOURCE_ACCOUNT environment variable"; \
		exit 1; \
	fi
	@SOURCE=$${SOURCE_ACCOUNT:-$$STELLAR_SECRET_KEY}; \
	if command -v stellar >/dev/null 2>&1; then \
		stellar contract deploy \
			--wasm target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm \
			--source $$SOURCE \
			--network testnet; \
	elif command -v soroban >/dev/null 2>&1; then \
		soroban contract deploy \
			--wasm target/wasm32-unknown-unknown/release/soroban_anchor_escrow.wasm \
			--source $$SOURCE \
			--network testnet; \
	else \
		echo "Error: Stellar CLI or Soroban CLI is required for deployment"; \
		exit 1; \
	fi

# Initialize deployed contract
init-contract:
	@if [ -z "$(CONTRACT_ID)" ]; then \
		echo "Error: CONTRACT_ID environment variable is required"; \
		exit 1; \
	fi
	@if [ -z "$(ADMIN_ADDRESS)" ] || [ -z "$(TREASURY_ADDRESS)" ]; then \
		echo "Error: ADMIN_ADDRESS and TREASURY_ADDRESS environment variables are required"; \
		exit 1; \
	fi
	@CLI=$$(command -v stellar || command -v soroban); \
	$$CLI contract invoke \
		--id $(CONTRACT_ID) \
		--source $${SOURCE_ACCOUNT:-deployer} \
		--network testnet \
		-- init \
		--admin $(ADMIN_ADDRESS) \
		--treasury $(TREASURY_ADDRESS) \
		--fee_bps $${FEE_BPS:-50}

# Install required tools
install-tools:
	@echo "Installing required tools..."
	@if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then \
		echo "Adding wasm32-unknown-unknown target..."; \
		rustup target add wasm32-unknown-unknown; \
	fi

# Setup local Soroban testnet prerequisites
setup-testnet:
	@echo "Setting up local Soroban testnet prerequisites..."
	@if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then \
		rustup target add wasm32-unknown-unknown; \
	fi
	@CLI=$$(command -v stellar || command -v soroban || echo ""); \
	if [ -n "$$CLI" ]; then \
		if ! $$CLI keys address deployer >/dev/null 2>&1; then \
			echo "Generating deployer identity..."; \
			$$CLI keys generate deployer; \
		fi; \
		if ! $$CLI network ls | grep -q '^testnet$$'; then \
			echo "Adding testnet network..."; \
			$$CLI network add testnet \
				--rpc-url https://soroban-testnet.stellar.org \
				--network-passphrase "Test SDF Network ; September 2015"; \
		fi; \
		echo "Deployer address: $$($$CLI keys address deployer)"; \
	fi

# Help target
help:
	@echo "Available targets:"
	@echo "  build           - Build the contract WASM"
	@echo "  build-optimized - Build with WASM optimization"
	@echo "  test            - Run all unit and lifecycle tests"
	@echo "  lint            - Run formatting and clippy checks"
	@echo "  hash            - Output SHA-256 hash of compiled WASM"
	@echo "  clean           - Clean build artifacts"
	@echo "  deploy-testnet  - Deploy to Stellar Testnet"
	@echo "  init-contract   - Initialize deployed contract"
	@echo "  install-tools   - Install wasm32 target"
	@echo "  setup-testnet   - Configure deployer identity and testnet profile"
