#!/usr/bin/env bash
# Deploy TACKTCIX preview on a single VPS with Docker Compose
# Usage: ./scripts/deploy-preview.sh <host> [--setup]
#
# Prerequisites on target VPS: Docker, Docker Compose, git
# This script clones the repo and starts the full stack.

set -euo pipefail

HOST="${1:-}"
SETUP="${2:-}"

if [ -z "$HOST" ]; then
  echo "Usage: ./scripts/deploy-preview.sh <user@host> [--setup]"
  echo ""
  echo "Options:"
  echo "  --setup    Run first-time setup (install Docker, clone repo)"
  echo ""
  echo "Examples:"
  echo "  ./scripts/deploy-preview.sh root@123.456.789.0 --setup"
  echo "  ./scripts/deploy-preview.sh ubuntu@my-vps.example.com"
  exit 1
fi

REPO_URL="https://github.com/digisumiit-commits/tacktcix.git"
REMOTE_DIR="/opt/tacktcix"

if [ "$SETUP" = "--setup" ]; then
  echo "=== First-time setup on $HOST ==="
  ssh "$HOST" bash -s <<'SETUP'
    set -e
    # Install Docker
    if ! command -v docker &>/dev/null; then
      curl -fsSL https://get.docker.com | sh
    fi
    # Clone repo
    REPO_URL="https://github.com/digisumiit-commits/tacktcix.git"
    REMOTE_DIR="/opt/tacktcix"
    if [ ! -d "$REMOTE_DIR" ]; then
      git clone "$REPO_URL" "$REMOTE_DIR"
    fi
    echo "Setup complete. Run without --setup to deploy."
SETUP
  exit 0
fi

echo "=== Deploying to $HOST ==="

ssh "$HOST" bash -s <<'DEPLOY'
  set -e
  cd /opt/tacktcix
  git pull origin main

  # Build and start
  docker compose -f docker-compose.yml -f docker-compose.prod.yml build
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

  # Wait for healthy
  echo "Waiting for backend..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:8000/api/health > /dev/null 2>&1; then
      echo "Backend healthy"
      break
    fi
    sleep 2
  done

  echo "Waiting for frontend..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3000 > /dev/null 2>&1; then
      echo "Frontend healthy"
      break
    fi
    sleep 2
  done

  echo "=== Deploy complete ==="
  echo "Frontend: http://$(hostname -I | awk '{print $1}')"
  echo "Backend:  http://$(hostname -I | awk '{print $1}'):8000"
DEPLOY
