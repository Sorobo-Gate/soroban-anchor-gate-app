
# SorobanAnchor Gate

> **Programmable Soroban-to-SEP Gateway & Automated Compliance Escrow**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Soroban](https://img.shields.io/badge/Soroban-v22.0.0-purple.svg)](https://soroban.stellar.org/)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8.svg)](https://go.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-14+-black.svg)](https://nextjs.org/)
[![Stellar](https://img.shields.io/badge/Stellar-Mainnet%2FTestnet-08B5E5.svg)](https://stellar.org/)

SorobanAnchor Gate is an open-source middleware protocol bridging smart contracts on Stellar (**Soroban**) with Stellar's regulated banking off-ramps (**Stellar Ecosystem Proposals / SEPs**). It enables decentralized protocols, DAOs, and escrow applications to disburse funds directly into real-world bank accounts and mobile money wallets without manual intervention or centralized custodial risk.

---

## 📌 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Architecture Overview](#%EF%B8%8F-architecture-overview)
- [Monorepo Structure](#-monorepo-structure)
- [Supported Stellar Standards (SEPs)](#-supported-stellar-standards-seps)
- [Prerequisites](#-prerequisites)
- [Quickstart Guide](#-quickstart-guide)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Environment Configuration](#2-environment-configuration)
  - [3. Contract Client Package](#3-contract-client-package)
  - [4. Go Relayer Daemon](#4-go-relayer-daemon)
  - [5. Frontend Web Dashboard](#5-frontend-web-dashboard)
- [Development & Verification](#%EF%B8%8F-development--verification)
- [Security & Audits](#-security--audits)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Overview

Many decentralized protocols often struggle to bridge on-chain assets into traditional fiat financial networks. SorobanAnchor Gate solves this by providing a programmable relay layer. When a Soroban smart contract emits disbursement events, the gateway automatically orchestrates identity verification (KYC), rate discovery (RFQ), and off-ramp settlement through regulated Stellar anchors.

---

## ✨ Key Features

- 🔐 **Programmable Non-Custodial Escrows**: Automate conditional disbursements via Soroban smart contract events.
- ⚡ **Automated SEP Bridge**: Seamless orchestration of SEP-10 (Web Auth), SEP-12 (KYC), SEP-31 (Cross-Border Payments), and SEP-38 (Quotes/RFQ).
- 📡 **Real-Time RPC Event Listener**: High-performance Go relayer engine featuring event idempotency tracking, robust retries, and state persistence.
- 💻 **Modern Web Dashboard**: Next.js dashboard supporting wallet integration (Freighter / Stellar Wallet Kit), anchor discovery via `stellar.toml`, and live escrow tracking.
- 📦 **Clean Monorepo Architecture**: Strict separation of concerns between web dashboard (`apps/web`), Go relayer service (`services/relay`), and TypeScript contract SDK (`packages/contract-client`).

---

## 🏗️ Architecture Overview

```text
               +-------------------------------------------+
               |         Next.js / React Frontend          |
               | (Freighter Kit, KYC Upload, Live Tracker) |
               +---------------------+---------------------+
                                     |
              +----------------------+----------------------+
              |                                             |
              v                                             v
+-------------------------------+             +-------------------------------+
|    TypeScript SDK / Package   |             |      Go Relayer & Gateway     |
|   (@soroban-gate/contract)    |             |       (services/relay)        |
+---------------+---------------+             +---------------+---------------+
                |                                             |
                | Interacts / Emits:                          | Pulls Event via Soroban RPC,
                | DisbursementAuthorized                      | Signs SEP-10 Auth Challenge
                v                                             v
+-----------------------------------------------------------------------------+
|                               Stellar Network                               |
|                  (Horizon, Soroban RPC, SAC USDC/EURC)                      |
+-----------------------------------------------------------------------------+
                                                              |
                                                              | Executes SEP-12 / SEP-31 / SEP-38
                                                              v
                                              +-------------------------------+
                                              |        Stellar Anchors        |
                                              |  (Bank Transfer, Mobile Money)|
                                              +-------------------------------+
```

The system operates across three core decoupled layers:

### 1. Frontend Web Dashboard (`apps/web`)
A Next.js dashboard providing user wallet connections, anchor discovery via `stellar.toml`, KYC form submission, and real-time escrow tracking.

### 2. Go Relayer Daemon (`services/relay`)
A Go background service that monitors Soroban RPC event streams, signs SEP-10 cryptographic auth challenges, submits SEP-12 customer profiles, and executes automated SEP-31/SEP-6 off-ramp payouts.

### 3. Contract Client Package (`packages/contract-client`)
A TypeScript package encapsulating contract interaction logic, type definitions, and RPC helper utilities.

---

## 📂 Monorepo Structure

```text
soroban-anchor-gate-app/
├── apps/
│   └── web/                    # Next.js 14 web app & wallet dashboard
├── packages/
│   └── contract-client/        # TypeScript SDK for Soroban contract interaction
├── services/
│   └── relay/                  # Go relayer daemon & SEP integration service
├── .env.example                # Centralized environment template
├── CONTRIBUTING.md             # Developer contribution guidelines & Drips Wave info
├── LICENSE                     # Apache 2.0 License
├── SECURITY.md                 # Vulnerability disclosure & audit status
└── README.md                   # Repository documentation
```

---

## 📑 Supported Stellar Standards (SEPs)

| Standard | Name | Description |
|---|---|---|
| **SEP-1** | Stellar Info File | Anchor service discovery via `stellar.toml` |
| **SEP-10** | Stellar Web Authentication | Cryptographic challenge-response wallet authentication |
| **SEP-12** | KYC API | Automated customer KYC profile & document submission |
| **SEP-31** | Cross-Border Payout | Direct cross-border banking payout execution |
| **SEP-38** | RFQ / Quotes API | Anchor FX rate quotes and asset conversion discovery |
| **CAP-46-06 / Soroban** | Smart Contract Engine | WebAssembly smart contract execution environment on Stellar |

---

## 📋 Prerequisites

Ensure you have the following installed locally:

- **Node.js**: `v18.x` or later (with `npm` or `pnpm`)
- **Go**: `v1.22` or later
- **Stellar CLI** *(Optional)*: `cargo install --locked stellar-cli`
- **PostgreSQL**: `v14+` (or Docker for running local database sandbox)

---

## ⚡ Quickstart Guide

### 1. Clone the Repository

```bash
git clone https://github.com/<your-org-or-username>/soroban-anchor-gate.git
cd soroban-anchor-gate
```

### 2. Environment Configuration

Copy the root `.env.example` file to `.env`:

```bash
cp .env.example .env
```

Populate `.env` with your network and service credentials:

```env
# Stellar Network Settings
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
HORIZON_URL="https://horizon-testnet.stellar.org"

# Deployed Contract ID
NEXT_PUBLIC_ESCROW_CONTRACT_ID="CA..."

# Backend Relayer Keys & Config
RELAY_SIGNER_SECRET="S..."
TARGET_ANCHOR_DOMAIN="testanchor.stellar.org"
DATABASE_URL="postgres://postgres:postgres@localhost:5432/soroban_anchor_gate?sslmode=disable"
PORT=8080
```

> ⚠️ **Security Warning:** Never commit `.env` files or secret keys (`S...`) to version control.

---

### 3. Contract Client Package

Navigate to the contract client package to install dependencies and build:

```bash
cd packages/contract-client
npm install
npm run build
```

---

### 4. Go Relayer Daemon

Navigate to the relayer service directory to fetch dependencies and run the daemon:

```bash
cd ../../services/relay

# Download Go module dependencies
go mod download

# Start the relayer engine
go run cmd/relay/main.go
```

To run unit and race detection tests:

```bash
go test -v -race ./...
```

---

### 5. Frontend Web Dashboard

Open a new terminal tab and start the Next.js development server:

```bash
cd apps/web

# Install dependencies
npm install

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the application.

---

## 🛠️ Development & Verification

Verify each monorepo package before submitting pull requests:

| Component | Directory | Validation Commands |
|---|---|---|
| **Web Dashboard** | `apps/web` | `npm run lint`<br>`npm run build` |
| **Go Relayer** | `services/relay` | `go vet ./...`<br>`go test -race ./...` |
| **Contract Client** | `packages/contract-client` | `npm run build` |

---

## 🛡️ Security & Audits

This project is currently in active development and has not yet undergone a formal cryptographic audit. Do not deploy these components to Stellar Mainnet with real capital without independent verification.

For security guidelines or to report a vulnerability, see [SECURITY.md](SECURITY.md).

---

## 🤝 Contributing

We welcome community contributions! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on:
- Monorepo structure and branching strategy
- Conventional commit conventions
- **Drips Wave** program issue guidelines and point rules

---

## 📄 License

This repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for full details.

