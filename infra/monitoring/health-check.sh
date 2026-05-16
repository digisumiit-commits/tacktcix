#!/usr/bin/env bash
set -euo pipefail

# TACKTCIX Health Check Script
# Verifies all services are healthy post-deployment.
# Called by CI/CD deploy job after each deployment.

TARGET_URL="${1:-http://localhost:8000}"
TIMEOUT="${2:-120}"
START_TIME=$(date +%s)

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

check_endpoint() {
  local url="$1"
  local expected="${2:-200}"
  local response
  response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  [[ "$response" = "$expected" ]]
}

check_json_field() {
  local url="$1"
  local field="$2"
  local expected="$3"
  local value
  value=$(curl -sf --max-time 5 "$url" | jq -r ".${field}" 2>/dev/null || echo "")
  [[ "$value" = "$expected" ]]
}

log "Starting health check against $TARGET_URL (timeout: ${TIMEOUT}s)"

# Wait for initial availability
log "Waiting for service availability..."
while true; do
  if check_endpoint "$TARGET_URL/health"; then
    log "Service is reachable"
    break
  fi
  ELAPSED=$(($(date +%s) - START_TIME))
  if [[ $ELAPSED -gt $TIMEOUT ]]; then
    log "FATAL: Service did not become healthy within ${TIMEOUT}s"
    exit 1
  fi
  sleep 2
done

# Deep health checks
log "Running deep health checks..."

declare -A CHECKS=(
  ["API health"]="$TARGET_URL/health"
  ["Database"]="$TARGET_URL/health/db"
  ["Redis"]="$TARGET_URL/health/redis"
)

FAILURES=0
for name in "${!CHECKS[@]}"; do
  url="${CHECKS[$name]}"
  if check_endpoint "$url"; then
    log "  PASS: $name ($url)"
  else
    log "  FAIL: $name ($url)"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ $FAILURES -gt 0 ]]; then
  log "FATAL: $FAILURES health check(s) failed"
  exit 1
fi

log "All health checks passed"
