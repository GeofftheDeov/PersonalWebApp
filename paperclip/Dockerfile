# Paperclip control plane — containerized from the published npm CLI.
# The app is not vendored here; the image installs `paperclipai` (which pulls
# @paperclipai/server) from npm. Pin the version below to upgrade deliberately.
#
# Runtime model:
#   - PAPERCLIP_HOME=/paperclip-data  → instance config, embedded Postgres data,
#     storage, and logs all live on the EFS volume mounted there.
#   - Embedded Postgres by default. Set DATABASE_URL to use external Postgres
#     (e.g. RDS) instead — recommended if dev outgrows EFS-backed embedded PG.
#   - authenticated deployment mode bound to 0.0.0.0 so the personal-web-app
#     backend can reach it across tasks via paperclip-dev.pwa.internal:3100.
#     Network access is restricted by the ECS security group.
#
# NOTE: embedded Postgres refuses to run as root, so this image runs as the
# `node` user (uid 1000). The EFS access point (fsap-02a0045caa8f59650) maps
# the volume root to 1000:1000 to match.

FROM node:22-bookworm-slim

# git: required for Paperclip project workspaces / worktrees.
# curl: container health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin the CLI version; bump intentionally. Installing at build time also
# fetches @embedded-postgres/linux-x64 binaries so nothing downloads at boot.
ARG PAPERCLIP_VERSION=2026.707.0
RUN npm install -g paperclipai@${PAPERCLIP_VERSION} @anthropic-ai/claude-code \
    && npm cache clean --force \
    # embedded-postgres creates library symlinks inside its own package dir at
    # first run; the container runs as `node`, so that subtree must be writable
    # (otherwise: "EACCES: permission denied, symlink 'libcrypto.so.1.1'...").
    && chown -R node:node /usr/local/lib/node_modules/paperclipai/node_modules/@embedded-postgres

COPY entrypoint.sh /usr/local/bin/paperclip-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/paperclip-entrypoint.sh \
    && chmod +x /usr/local/bin/paperclip-entrypoint.sh

# Instance root on the EFS mount (task definition mounts the volume here).
ENV PAPERCLIP_HOME=/paperclip-data \
    NODE_ENV=production \
    PORT=3100 \
    # Headless: never try to open a browser inside the container.
    PAPERCLIP_NO_BROWSER=1 \
    PAPERCLIP_OPEN_ON_LISTEN=false \
    PAPERCLIP_TELEMETRY_DISABLED=1 \
    # Reachable from other tasks: authenticated mode + explicit 0.0.0.0 bind.
    # (local_trusted mode force-binds loopback and would be unreachable.)
    PAPERCLIP_DEPLOYMENT_MODE=authenticated \
    PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
    PAPERCLIP_BIND=custom \
    PAPERCLIP_BIND_HOST=0.0.0.0 \
    # localhost/127.0.0.1 allow access via SSM port-forwarding sessions.
    PAPERCLIP_ALLOWED_HOSTNAMES=paperclip-dev.pwa.internal,localhost,127.0.0.1

RUN mkdir -p /paperclip-data && chown node:node /paperclip-data

USER node
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3100/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/paperclip-entrypoint.sh"]
