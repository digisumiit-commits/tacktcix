#!/usr/bin/env bash
set -euo pipefail

# TACKTCIX Rollback Script
# Usage: ./rollback.sh --service <frontend|backend|all> --environment <staging|production>
# Automates rollback to the last known-good deployment.

SERVICE=""
ENVIRONMENT=""
DRY_RUN=false

usage() {
  cat << 'EOF'
Usage: rollback.sh --service <frontend|backend|all> --environment <staging|production> [--dry-run]

Rolls back the specified service to the last successful deployment.

Options:
  --service      Target service (frontend, backend, or all)
  --environment  Deployment environment (staging or production)
  --dry-run      Print what would happen without executing
  --help         Show this help
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help) usage ;;
    *) echo "Unknown flag: $1"; usage ;;
  esac
done

[[ -z "$SERVICE" || -z "$ENVIRONMENT" ]] && usage

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
error() { log "ERROR: $*"; exit 1; }

rollback_vercel() {
  log "Rolling back Vercel frontend ($ENVIRONMENT)..."
  if $DRY_RUN; then
    log "[DRY RUN] Would roll back Vercel project to last successful deployment"
    return
  fi

  if [[ -z "${VERCEL_TOKEN:-}" ]]; then
    error "VERCEL_TOKEN not set"
  fi

  DEPLOYMENTS=$(curl -sf \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&target=production&state=READY&limit=5")

  LAST_GOOD=$(echo "$DEPLOYMENTS" | jq -r '.deployments[1].uid // empty')
  if [[ -z "$LAST_GOOD" ]]; then
    error "No previous deployment found to roll back to"
  fi

  log "Rolling back to deployment $LAST_GOOD"
  curl -sf -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/rollback/$LAST_GOOD"

  log "Vercel rollback complete"
}

rollback_railway() {
  log "Rolling back Railway backend ($ENVIRONMENT)..."
  if $DRY_RUN; then
    log "[DRY RUN] Would roll back Railway service to last successful deployment"
    return
  fi

  if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
    error "RAILWAY_TOKEN not set"
  fi

  railway link --project "$RAILWAY_PROJECT_ID"

  DEPLOYMENTS=$(railway deployments --service api --environment "$ENVIRONMENT" --limit 10 2>/dev/null)
  LAST_GOOD=$(echo "$DEPLOYMENTS" | grep -m2 "SUCCESS" | tail -1 | awk '{print $1}')

  if [[ -z "$LAST_GOOD" ]]; then
    error "No successful deployment found to roll back to"
  fi

  log "Rolling back to deployment $LAST_GOOD"
  railway rollback --service api --environment "$ENVIRONMENT" --deployment "$LAST_GOOD"

  log "Railway rollback complete. Verifying health..."
  for i in $(seq 1 30); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://api.railway.app/health" || echo "000")
    if [[ "$STATUS" = "200" ]]; then
      log "Backend healthy after rollback"
      return
    fi
    sleep 2
  done
  error "Health check failed after rollback — manual intervention required"
}

case "$SERVICE" in
  frontend) rollback_vercel ;;
  backend) rollback_railway ;;
  all)
    rollback_vercel
    rollback_railway
    ;;
  *) error "Unknown service: $SERVICE" ;;
esac

log "Rollback finished"
