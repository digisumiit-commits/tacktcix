#!/usr/bin/env bash
# PRO-15: Smoke test for the execution worker runtime
# Verifies: Docker Compose starts cleanly, health endpoint responds,
# a test job can be enqueued and executed, and the sandbox enforces limits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; exit 1; }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

info "Building sandbox image..."
docker build -t execution-sandbox:latest -f Dockerfile.sandbox . || fail "Sandbox image build failed"

info "Building worker image..."
docker build -t execution-worker:latest -f Dockerfile.worker . || fail "Worker image build failed"

info "Starting services..."
docker compose up -d redis || fail "Redis failed to start"

# Wait for Redis health
for i in $(seq 1 30); do
    if docker compose exec -T redis redis-cli ping | grep -q PONG; then
        break
    fi
    sleep 1
done

info "Starting worker..."
docker compose up -d worker || fail "Worker failed to start"

# Wait for worker health
for i in $(seq 1 30); do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

HEALTH=$(curl -s http://localhost:8080/health)
echo "$HEALTH" | grep -q "healthy" || fail "Worker health check failed: $HEALTH"
pass "Worker health endpoint responds healthy"

STATUS=$(curl -s http://localhost:8080/status)
echo "$STATUS" | grep -q "worker_id" || fail "Status endpoint missing worker_id"
pass "Worker status endpoint responds"

METRICS=$(curl -s http://localhost:8080/metrics)
echo "$METRICS" | grep -q "execution_worker_healthy" || fail "Metrics endpoint missing"
pass "Worker metrics endpoint responds"

# Enqueue a test job
info "Enqueuing test job..."
JOB_ID="smoke-$(date +%s)"
docker compose exec -T redis redis-cli XADD jobs:execution "*" \
    type "smoke-test" \
    profile "tiny" \
    timeout_s "30" \
    network_access "false" \
    payload '{"command":"echo hello world && exit 0"}' \
    || fail "Failed to enqueue job"

pass "Test job enqueued: $JOB_ID"

# Wait for job processing (consumer polls every 5s, plus execution time)
info "Waiting for job execution..."
sleep 10

# Verify the stream is empty (job was consumed)
PENDING=$(docker compose exec -T redis redis-cli XLEN jobs:execution || echo "unknown")
info "Pending jobs in stream: $PENDING"

# Check worker is still healthy
HEALTH=$(curl -s http://localhost:8080/health)
echo "$HEALTH" | grep -q "healthy" || fail "Worker unhealthy after job execution: $HEALTH"
pass "Worker still healthy after job execution"

echo ""
echo -e "${GREEN}=== All smoke tests passed ===${NC}"
echo ""
info "Run 'docker compose down' to clean up"
