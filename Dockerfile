FROM node:20-alpine AS base

# Install dependencies for Puppeteer/Chromium
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  freetype-dev \
  harfbuzz \
  ca-certificates \
  ttf-freefont \
  python3 \
  make \
  g++

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# ── DEPENDENCIES ───────────────────────────────
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --only=production

# ── BUILD ──────────────────────────────────────
FROM base AS builder
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
COPY . .
RUN npm run db:generate
RUN npm run build

# ── PRODUCTION ─────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY package*.json ./

# Create logs directory
RUN mkdir -p logs

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 expressjs
RUN chown -R expressjs:nodejs /app
USER expressjs

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
