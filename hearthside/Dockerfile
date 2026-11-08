# The Hearthside image (spec #69). Like the portfolio's, it builds from the
# repo root, the npm workspace, so it can reach the root lockfile and the
# package it shares with the portfolio:
#   docker build -f hearthside/Dockerfile .
# What the build may see is in the root .dockerignore.
#
# Build args (read by `next build`, which bakes them in; the running server
# doesn't read them again, so each environment builds its own image):
#   BACKEND_URL                where /api and /uploads go. Default
#                              http://localhost:5000: the backend container in
#                              the same ECS task. docker-compose passes
#                              http://backend:5000.
#   NEXT_PUBLIC_PORTFOLIO_URL  required: the portfolio's origin, for the top
#                              bar's portfolio items: https://geoffthedeov.net
#                              (prod), https://deov.geoffthedeov.net (dev). No
#                              default, so an image can't ship with localhost
#                              links; docker-compose passes http://localhost:3000.

# Install dependencies only when needed
FROM node:20-alpine AS deps
WORKDIR /app
# Every workspace's manifest, so `npm ci` can check them against the lockfile.
# A new workspace adds its package.json here (and in frontend/Dockerfile).
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY hearthside/package.json ./hearthside/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --no-audit --no-fund
# npm hoists everything to the root today; make sure the runner's copy of the
# app's own node_modules has something to copy either way.
RUN mkdir -p hearthside/node_modules

# Rebuild the source code only when needed
FROM deps AS builder
WORKDIR /app
ARG BACKEND_URL=http://localhost:5000
ARG NEXT_PUBLIC_PORTFOLIO_URL
RUN test -n "$NEXT_PUBLIC_PORTFOLIO_URL" || (echo "Build with --build-arg NEXT_PUBLIC_PORTFOLIO_URL=<the portfolio's origin>" >&2; exit 1)
ENV BACKEND_URL=$BACKEND_URL
ENV NEXT_PUBLIC_PORTFOLIO_URL=$NEXT_PUBLIC_PORTFOLIO_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# next/font downloads the fonts here, so the build needs the network; the
# running app serves them itself.
RUN npm run build --workspace hearthside

# Production image: the built app and its own copy of the custom server.
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The workspace's node_modules links @gtd/shared to packages/shared.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/hearthside/node_modules ./hearthside/node_modules
COPY --from=builder /app/hearthside/.next ./hearthside/.next
COPY --from=builder /app/hearthside/package.json ./hearthside/package.json
COPY --from=builder /app/hearthside/next.config.js ./hearthside/next.config.js
COPY --from=builder /app/hearthside/https-server.js ./hearthside/https-server.js

WORKDIR /app/hearthside

# The portfolio's container has 3000 and 3001 in the same task.
EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"

CMD ["node", "https-server.js"]
