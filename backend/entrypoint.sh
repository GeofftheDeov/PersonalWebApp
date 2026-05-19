#!/bin/sh
set -e

# Sync Obsidian vault from GitHub onto EFS if a token is available.
# On first run: git clone. On subsequent runs: git pull (vault persists on EFS).
if [ -n "$GITHUB_VAULT_TOKEN" ] && [ -n "$GITHUB_VAULT_REPO" ]; then
  VAULT_DIR="${OBSIDIAN_VAULT_PATH:-/obsidian-vault}"
  CLONE_URL="https://oauth2:${GITHUB_VAULT_TOKEN}@github.com/${GITHUB_VAULT_REPO}.git"

  if [ -d "$VAULT_DIR/.git" ]; then
    echo "[vault] Pulling latest notes..."
    git -C "$VAULT_DIR" pull --ff-only --quiet 2>&1 || echo "[vault] git pull failed — running with cached data"
  else
    echo "[vault] Cloning vault..."
    git clone --depth 1 --quiet "$CLONE_URL" "$VAULT_DIR" 2>&1 || echo "[vault] git clone failed — vault will be unavailable"
  fi
else
  echo "[vault] GITHUB_VAULT_TOKEN or GITHUB_VAULT_REPO not set — skipping vault sync"
fi

exec npm start
