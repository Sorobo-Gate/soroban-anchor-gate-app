# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH

WORKDIR /app

# Build shared TypeScript SDK dependency first with layer-cached dependencies.
COPY packages/contract-client/package.json packages/contract-client/package-lock.json ./packages/contract-client/
RUN --mount=type=cache,target=/root/.npm \
    cd packages/contract-client && npm ci --ignore-scripts

COPY packages/contract-client ./packages/contract-client
RUN cd packages/contract-client && npm run build

# Install and build Next.js standalone bundle for target architecture.
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN --mount=type=cache,target=/root/.npm \
    cd apps/web && npm ci --ignore-scripts

COPY apps/web ./apps/web
WORKDIR /app/apps/web

ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_ESCROW_CONTRACT_ID=CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT
ARG NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ARG NEXT_PUBLIC_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
ENV NEXT_PUBLIC_ESCROW_CONTRACT_ID=${NEXT_PUBLIC_ESCROW_CONTRACT_ID}
ENV NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE=${NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE}
ENV NEXT_PUBLIC_SOROBAN_RPC_URL=${NEXT_PUBLIC_SOROBAN_RPC_URL}

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy only the Next.js standalone server, static chunks, and public assets to minimize footprint.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/web/server.js"]
