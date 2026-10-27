#!/usr/bin/env bash

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}  SorobanAnchor Gate - Automated Setup & Verification ${NC}"
echo -e "${CYAN}======================================================${NC}"

REQUIRED_NODE_MAJOR=20
REQUIRED_GO_VERSION="1.22"

print_status() {
    echo -e "${GREEN}[OK]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

fail() {
    print_error "$1"
    exit 1
}

require_command() {
    local command_name="$1"
    local install_hint="$2"

    if ! command -v "${command_name}" >/dev/null 2>&1; then
        fail "${command_name} is required but was not found. ${install_hint}"
    fi
}

check_node() {
    require_command "node" "Install Node.js >= 20: https://nodejs.org/"
    require_command "npm" "Install npm >= 9 (bundled with Node.js)."

    local node_version
    node_version="$(node -p "process.versions.node")"
    local node_major="${node_version%%.*}"

    if (( node_major < REQUIRED_NODE_MAJOR )); then
        fail "Node.js ${node_version} is not supported. Please use Node.js >= 20.x."
    fi

    local npm_version
    npm_version="$(npm -v)"
    print_status "Node.js v${node_version} and npm v${npm_version} detected"
}

check_go() {
    require_command "go" "Install Go >= 1.22: https://go.dev/dl/"
    local go_version
    go_version="$(go version | awk '{print $3}')"
    print_status "Go runtime detected (${go_version})"
}

check_rust() {
    require_command "rustc" "Install Rust via rustup: https://rustup.rs/"
    require_command "cargo" "Install Cargo via rustup: https://rustup.rs/"
    require_command "rustup" "Install rustup: https://rustup.rs/"

    local rustc_version
    rustc_version="$(rustc --version)"

    if ! rustup target list --installed | grep -qx "wasm32-unknown-unknown"; then
        echo "Adding wasm32-unknown-unknown target..."
        rustup target add wasm32-unknown-unknown
    fi

    print_status "Rust toolchain detected (${rustc_version}) with wasm32-unknown-unknown target"
}

check_stellar_cli() {
    if command -v stellar >/dev/null 2>&1; then
        local ver
        ver="$(stellar --version)"
        print_status "Stellar CLI detected (${ver})"
    elif command -v soroban >/dev/null 2>&1; then
        local ver
        ver="$(soroban --version)"
        print_status "Soroban CLI detected (${ver})"
    else
        print_warning "Neither 'stellar' nor 'soroban' CLI found. You can install it via: cargo install --locked stellar-cli"
    fi
}

install_dependencies() {
    echo ""
    echo "Installing dependencies across monorepo workspaces..."

    print_status "Installing root dependencies..."
    npm install

    print_status "Installing web app dependencies (apps/web)..."
    (cd apps/web && npm install)

    print_status "Installing SDK dependencies (packages/contract-client)..."
    (cd packages/contract-client && npm install && npm run build)

    if [ -d "contracts" ]; then
        print_status "Checking Soroban smart contracts (contracts)..."
        (cd contracts && cargo check)
    fi

    if [ -d "services/relay" ]; then
        print_status "Downloading Go relay module dependencies..."
        (cd services/relay && go mod download)
    fi
}

setup_env_files() {
    echo ""
    echo "Setting up local environment files..."

    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        cp .env.example .env
        print_status "Created .env from .env.example"
    fi

    if [ ! -f "apps/web/.env.local" ] && [ -f ".env.example" ]; then
        cp .env.example apps/web/.env.local
        print_status "Created apps/web/.env.local"
    fi
}

main() {
    check_node
    check_go
    check_rust
    check_stellar_cli
    install_dependencies
    setup_env_files

    echo ""
    echo -e "${GREEN}======================================================${NC}"
    echo -e "${GREEN}  Installation & Verification Complete!               ${NC}"
    echo -e "${GREEN}======================================================${NC}"
    echo ""
    echo "Quick Start Commands:"
    echo "  npm run dev          # Start web interface + Go relay concurrently"
    echo "  npm test             # Run all test suites (contracts, web, SDK, relay)"
    echo "  npm run build        # Build contract WASM, SDK, web app, and relay"
    echo "  npm run lint         # Run formatters and linters across all layers"
    echo ""
    echo "Contract specific commands:"
    echo "  cd contracts && make test     # Run 21 Soroban contract unit tests"
    echo "  cd contracts && make build    # Compile contract to release WASM"
    echo ""
    echo "Web Application: http://localhost:3000"
    echo "Testnet Contract: CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
    echo ""
}

main "$@"
