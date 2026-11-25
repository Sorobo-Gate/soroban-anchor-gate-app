# Verification Report: Issues #137 & #157

**Linked Issues:** `#137`, `#157`  
**Branch:** `wave/137-157-a11y-multiarch-docker` (branched from `upstream/develop`)  
**Target Branch:** `develop`

---

## 1. Issue #137 — Accessible Keyboard Navigation & ARIA Landmarks (`apps/web/`)

### Implemented Changes
- **Skip Link & Focus Styling** ([`apps/web/src/app/layout.tsx`](../apps/web/src/app/layout.tsx), [`apps/web/src/app/globals.css`](../apps/web/src/app/globals.css)): Added a keyboard-accessible "Skip to main content" link targeting `#main-content`, global `:focus-visible` high-contrast outlines, and `@media (prefers-reduced-motion: reduce)` handling.
- **Page Landmarks & Primary Navigation** ([`apps/web/src/app/page.tsx`](../apps/web/src/app/page.tsx), [`apps/web/src/app/create/page.tsx`](../apps/web/src/app/create/page.tsx), [`apps/web/src/app/disputes/page.tsx`](../apps/web/src/app/disputes/page.tsx), [`apps/web/src/components/MobileNav.tsx`](../apps/web/src/components/MobileNav.tsx)): Added shared `DesktopNav` (`<nav aria-label="Primary">` with `aria-current="page"`), `<header>`, `<main id="main-content" tabIndex={-1}>`, `<aside aria-label="Protocol guardrails">`, and `<footer aria-label="Site footer">`.
- **Keyboard Navigation & Focus Trapping** ([`apps/web/src/lib/a11y.ts`](../apps/web/src/lib/a11y.ts), [`apps/web/src/components/SimulationModal.tsx`](../apps/web/src/components/SimulationModal.tsx), [`apps/web/src/components/WalletProvider.tsx`](../apps/web/src/components/WalletProvider.tsx)): Extracted shared `getFocusableElements`, `trapDialogFocus`, and `handleHorizontalButtonKeyDown` helpers. Enabled `Tab` / `Shift+Tab` focus trapping, `Escape` dismissal, and trigger focus restoration across `MobileNav`, `SimulationModal`, and `NetworkMismatchModal`, plus `ArrowLeft` / `ArrowRight` / `Home` / `End` navigation for workspace mode, token preset, and action groups.
- **Forms, Tables, Sliders, & Live Regions** ([`apps/web/src/components/EscrowTable.tsx`](../apps/web/src/components/EscrowTable.tsx), [`apps/web/src/components/DisputeSlider.tsx`](../apps/web/src/components/DisputeSlider.tsx), [`apps/web/src/components/EvidenceUpload.tsx`](../apps/web/src/components/EvidenceUpload.tsx), [`apps/web/src/components/wizard/EscrowWizard.tsx`](../apps/web/src/components/wizard/EscrowWizard.tsx), [`apps/web/src/components/PaymentQR.tsx`](../apps/web/src/components/PaymentQR.tsx)): Associated all inputs with `<label htmlFor>`, replaced the fake `div` table header in `EscrowTable` with a semantic `<thead>` + `<th scope="col">` + `aria-sort` inside `<ResponsiveTable>`, added ARIA slider attributes (`aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext`), `aria-pressed` states, `aria-live` status/alert regions, and `aria-hidden="true"` on decorative icons.
- **Automated `axe-core` Audits** ([`apps/web/src/lib/accessibility.test.ts`](../apps/web/src/lib/accessibility.test.ts), [`apps/web/e2e/accessibility.spec.ts`](../apps/web/e2e/accessibility.spec.ts)): Added unit + `jsdom` `axe-core` WCAG 2.1 AA audits and Playwright E2E `axe-core` + keyboard navigation tests.

### Observed Frontend Verification
- `npm run lint` (`apps/web`): **0 errors, 0 warnings**
- `npm run typecheck` (`apps/web`): **0 errors**
- `npm run build` (`apps/web`): **Succeeded** (Next.js 16.4.5 standalone output; routes `/`, `/_not-found`, `/create`, `/disputes`)
- `npm run bundle-size` (`apps/web`): **374.8 KB** total client JS gzip (budget: 450 KB)
- `node node_modules/tsx/dist/cli.mjs --test src/lib/accessibility.test.ts`: **7/7 passed** (0 `axe-core` violations across all tested component groups; `color-contrast` disabled in `jsdom` due to missing canvas implementation)
- `npm test` (`apps/web`): **344/345 passed**; 1 pre-existing failure in `src/lib/escrowSocket.test.ts:374` (`keeps retrying with backoff while the server is unreachable, then connects once it is up` — timed out waiting for retry attempts, identical to clean `upstream/develop` baseline).
- Playwright E2E (`npm run test:e2e`): Not run locally because Chromium browser binaries (`~/.cache/ms-playwright`) are not installed in this environment.

---

## 2. Issue #157 — Multi-Architecture Docker Container Builds (`amd64` and `arm64`)

### Implemented Changes
- **Next.js Standalone & Multi-Arch Web Dockerfile** ([`apps/web/next.config.ts`](../apps/web/next.config.ts), [`apps/web/Dockerfile`](../apps/web/Dockerfile), [`apps/web/Dockerfile.dockerignore`](../apps/web/Dockerfile.dockerignore)): Enabled `output: "standalone"`, added `TARGETPLATFORM` / `TARGETOS` / `TARGETARCH` build args, BuildKit npm cache mounts, non-root `nextjs` user (`UID 1001`), built-in Node `fetch` `HEALTHCHECK`, and `.dockerignore` exclusions.
- **Go Relay Cross-Compilation & Distroless Dockerfile** ([`services/relay/Dockerfile`](../services/relay/Dockerfile), [`services/relay/Dockerfile.dockerignore`](../services/relay/Dockerfile.dockerignore), [`services/relay/cmd/relay/main.go`](../services/relay/cmd/relay/main.go), [`services/relay/cmd/relay/main_test.go`](../services/relay/cmd/relay/main_test.go)): Configured `FROM --platform=$BUILDPLATFORM golang:1.22-alpine` cross-compiling with `GOOS=${TARGETOS}` / `GOARCH=${TARGETARCH}` and `CGO_ENABLED=0 -trimpath -ldflags="-s -w"`, switched runtime to `gcr.io/distroless/static-debian12:nonroot` (`UID 65532`), and added a native `relay healthcheck` CLI subcommand for container `HEALTHCHECK`.
- **Deployment & Reference CI Documentation** ([`docs/deployment.md`](../docs/deployment.md)): Documented multi-arch Buildx build/verification commands and the `.github/workflows/docker.yml` reference workflow (`.github/` was intentionally not modified in this PR because `scripts/ci/issue_compliance.js` restricts `.github/` changes to maintainers).

### Observed Relay & Footprint Verification
- `gofmt -l .` (`services/relay`): **0 unformatted files**
- `go vet ./...` (`services/relay`): **0 issues**
- `go test -v -race ./cmd/relay/...`: **PASS** (`TestCheckHealth` passed in `1.121s`)
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w"`: **15M** static stripped `ELF 64-bit LSB executable, x86-64`
- `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w"`: **14M** static stripped `ELF 64-bit LSB executable, ARM aarch64`
- Web standalone footprint: `node_modules` (`793M`) replaced in the runner stage by `.next/standalone` (`70M`) + `.next/static` (`1.6M`) + `public` (`272K`).
- `docker buildx`: Not executed locally because `docker` is not installed in this environment.
