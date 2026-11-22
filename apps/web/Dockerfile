# Build stage
FROM node:22-alpine AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

WORKDIR /app

# Install libc6-compat for compatibility with Alpine and Next.js SWC across architectures
RUN apk add --no-cache libc6-compat

# Copy SDK dependency first
COPY packages/contract-client ./packages/contract-client
RUN cd packages/contract-client && npm install && npm run build

# Copy web frontend
COPY apps/web ./apps/web
WORKDIR /app/apps/web

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_ESCROW_CONTRACT_ID=CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT
ENV NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ENV NEXT_PUBLIC_SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"

RUN npm install
RUN npm run build

# Production runner stage
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Security best practice: run container as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/node_modules ./node_modules
COPY --from=builder /app/apps/web/package.json ./package.json

USER nextjs

EXPOSE 3000

CMD ["npm", "start"]
