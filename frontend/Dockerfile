# The portfolio image. It builds from the repo root, the npm workspace (#209),
# so it can reach the root lockfile and the packages it shares with Hearthside:
#   docker build -f frontend/Dockerfile .
# What the build may see is in the root .dockerignore.

# Install dependencies only when needed
FROM node:20-alpine AS deps
WORKDIR /app
# Every workspace's manifest, so `npm ci` can check them against the lockfile.
# A new workspace adds its package.json here (and in hearthside/Dockerfile).
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY hearthside/package.json ./hearthside/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --no-audit --no-fund
# npm hoists everything to the root today; make sure the runner's copy of the
# app's own node_modules has something to copy either way.
RUN mkdir -p frontend/node_modules

# Rebuild the source code only when needed
FROM deps AS builder
WORKDIR /app
ARG BACKEND_URL=http://localhost:5000
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
# Hearthside's origin (spec #69), for the portfolio's links to it and its 308
# redirects of /game-night/... (#234). Empty means Hearthside isn't live in
# this environment yet: treat "" as unset. The deploy workflows pass it only
# once the environment's HEARTHSIDE_LIVE switch is on (scripts/hearthside-wizard.sh).
ARG NEXT_PUBLIC_HEARTHSIDE_URL
ENV BACKEND_URL=$BACKEND_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_HEARTHSIDE_URL=$NEXT_PUBLIC_HEARTHSIDE_URL
COPY . .
RUN npm run build --workspace frontend

# Production image, copy all the files and run next
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# The workspace's node_modules links @gtd/shared to packages/shared.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/frontend/node_modules ./frontend/node_modules
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/package.json ./frontend/package.json
COPY --from=builder /app/frontend/next.config.js ./frontend/next.config.js
COPY --from=builder /app/frontend/https-server.js ./frontend/https-server.js

WORKDIR /app/frontend

EXPOSE 3000
EXPOSE 3001

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "https-server.js"]
