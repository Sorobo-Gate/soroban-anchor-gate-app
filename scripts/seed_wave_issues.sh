#!/usr/bin/env bash

set -euo pipefail

REPO="${1:-Sorobo-Gate/soroban-anchor-gate-app}"

echo "========================================================"
echo "  Setting up Drips Wave Labels & Issues for: $REPO"
echo "========================================================"

# Create standard Drips Wave labels
gh label create "drips-wave"   --repo "$REPO" --color "0366D6" --description "Active Stellar Drips Wave Sprint Task" --force
gh label create "wave:trivial" --repo "$REPO" --color "0E8A16" --description "Drips Wave Trivial Task (100 pts)" --force
gh label create "wave:medium"  --repo "$REPO" --color "FBCA04" --description "Drips Wave Medium Task (150 pts)" --force
gh label create "wave:high"    --repo "$REPO" --color "D93F0B" --description "Drips Wave High Task (200 pts)" --force

# Architectural layer labels
gh label create "contracts"     --repo "$REPO" --color "1D76DB" --description "Soroban Smart Contracts (Rust)" --force
gh label create "frontend"      --repo "$REPO" --color "C5DEF5" --description "Next.js 16 Web Dashboard & UI" --force
gh label create "backend"       --repo "$REPO" --color "5319E7" --description "Go Relay Service Daemon" --force
gh label create "sdk"           --repo "$REPO" --color "5319E7" --description "TypeScript Contract Client SDK" --force
gh label create "documentation" --repo "$REPO" --color "0075CA" --description "Documentation & Guides" --force

echo "Creating Drips Wave sprint tasks..."

# 1. High: Arbiter Dispute Resolution
gh issue create --repo "$REPO" \
  --title "feat(contracts): implement arbiter dispute resolution branch" \
  --label "drips-wave,wave:high,contracts" \
  --body "### Summary
Add an arbiter role to mediate payment disputes if the anchor fiat disbursement fails or work is contested before the unlock timeout.

### Acceptance Criteria
- [ ] Store arbiter address during \`init\` or per-escrow in \`contracts/src/types.rs\`
- [ ] Implement \`resolve_dispute(env, escrow_id, payer_bps, beneficiary_bps)\` in \`contracts/src/lib.rs\`
- [ ] Validate basis points sum to 10,000 (100%)
- [ ] Emit dispute resolution event
- [ ] Complete unit test coverage in \`contracts/src/test.rs\` (passing \`make test\`)

### Tech Stack
Rust, Soroban SDK v22"

# 2. Medium: Multi-Token Whitelist
gh issue create --repo "$REPO" \
  --title "feat(contracts): implement multi-token whitelist storage" \
  --label "drips-wave,wave:medium,contracts" \
  --body "### Summary
Currently, any token address can be passed to create_escrow. We need an administrative whitelist ensuring only verified SAC tokens (e.g., USDC, EURC) can be deposited.

### Acceptance Criteria
- [ ] Add \`DataKey::WhitelistedToken(Address)\` to \`contracts/src/types.rs\`
- [ ] Implement \`set_token_whitelist(env, token, bool)\` protected by admin auth
- [ ] Validate whitelist during \`create_escrow\`
- [ ] Unit tests covering unauthorized token rejection

### Tech Stack
Rust, Soroban SDK v22"

# 3. Medium: SEP-10 Authentication Handshake in Relay
gh issue create --repo "$REPO" \
  --title "feat(relay): implement SEP-10 challenge signer client" \
  --label "drips-wave,wave:medium,backend" \
  --body "### Summary
Implement programmatic SEP-10 web authentication handshake in the Go relay daemon to retrieve valid JWTs for anchor operations.

### Acceptance Criteria
- [ ] Function to request challenge XDR from anchor endpoint
- [ ] Sign challenge transaction with relay Ed25519 secret key
- [ ] Post signed challenge to exchange for JWT
- [ ] Cache token in memory until expiration
- [ ] Unit tests with mocked HTTP responses

### Tech Stack
Go 1.22, stellar/go SDK"

# 4. Medium: Interactive Escrow Release & Refund in Frontend
gh issue create --repo "$REPO" \
  --title "feat(web): add interactive escrow release and refund controls" \
  --label "drips-wave,wave:medium,frontend" \
  --body "### Summary
Extend the Next.js web application dashboard to allow escrow payers and admins to trigger \`release_to_anchor\` or claim \`refund\` directly via Freighter wallet.

### Acceptance Criteria
- [ ] Add Escrow details card with current status badge (FUNDED, DISBURSED, REFUNDED)
- [ ] 'Release Payout' button signed by payer or admin
- [ ] 'Claim Refund' button enabled when block timestamp exceeds unlock_time
- [ ] Transaction toast with explorer link
- [ ] Passing frontend tests (\`npm test\` in apps/web)

### Tech Stack
Next.js 16, React 19, Tailwind CSS, TypeScript"

# 5. Trivial: Add contract WASM size and gas benchmarking report
gh issue create --repo "$REPO" \
  --title "docs(contracts): document WASM size metrics and gas benchmarks" \
  --label "drips-wave,wave:trivial,documentation,contracts" \
  --body "### Summary
Document the compiled release and optimized WASM sizes for the Soroban escrow contract, along with gas invocation budgets for create_escrow, release, and refund.

### Acceptance Criteria
- [ ] Run \`make build\` and record SHA-256 and byte sizes in \`docs/gas-benchmarks.md\`
- [ ] Record CPU and memory footprint for standard testnet operations
- [ ] Add link in main README.md

### Tech Stack
Markdown, Rust, Soroban CLI"

echo "All Wave issues and labels seeded successfully for $REPO!"
