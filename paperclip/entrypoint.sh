#!/bin/sh
set -e

INSTANCE_DIR="${PAPERCLIP_HOME:-/paperclip-data}/instances/${PAPERCLIP_INSTANCE_ID:-default}"

# First run: write config non-interactively. `--bind lan` selects the
# authenticated/private quickstart path (a bare `--yes` would force trusted
# local loopback and ignore all PAPERCLIP_* deployment env vars). The env vars
# baked into the image (custom bind 0.0.0.0, authenticated mode) take
# precedence at server start on every boot.
if [ ! -f "$INSTANCE_DIR/config.json" ]; then
  echo "[paperclip] No config found — running first-time onboarding (headless)"
  paperclipai onboard --yes --bind lan
else
  echo "[paperclip] Existing config found at $INSTANCE_DIR/config.json"
fi

# Clean up a stale embedded-Postgres pidfile left by an unclean stop (EFS data
# survives container replacement, the old postmaster does not).
rm -f "$INSTANCE_DIR"/db/postmaster.pid 2>/dev/null || true

# `run` = doctor (with automatic repairs) + start server. Doctor's repair pass
# handles residual embedded-Postgres lock/state issues on the persisted volume.
exec paperclipai run
