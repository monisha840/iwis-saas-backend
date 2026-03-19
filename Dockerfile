# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Install only production dependencies first (layer cache friendly)
COPY package*.json ./
RUN npm ci --omit=dev

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Install ALL deps including dev (needed for prisma generate)
RUN npm ci

COPY . .

# Generate Prisma client — must run after copying schema
RUN npx prisma generate

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Security: run as non-root
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 backend

# Copy production node_modules from deps stage
COPY --from=deps    /app/node_modules ./node_modules

# Copy app source + prisma client generated artifacts
COPY --from=builder /app .

# Remove dev artefacts not needed at runtime
RUN rm -rf tests scripts audit-*.js check-*.js cleanup-*.js \
           create-*.js diag-*.js fix-*.js get-*.js list-*.js \
           migrate-*.js reproduce_issue.js seed-*.js simulate-*.js \
           test-*.js test_*.txt update-*.js

# Prisma migrations are run at deploy time, not image build time
# CMD will trigger `prisma migrate deploy` before starting the server

USER backend

EXPOSE 4000

# ENTRYPOINT handles migration + start in production
ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && node index.js"]
