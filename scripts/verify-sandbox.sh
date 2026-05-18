#!/usr/bin/env bash
# PRO-86: Sandbox testing environment — readiness verification.
# Checks that Docker, Docker Compose build, and sandbox image are functional.
# Exits 0 if all checks pass, 1 with diagnostics on failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo -e "${GREEN}PASS${NC}[${PASS}]: $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "${RED}FAIL${NC}[${FAIL}]: $1"; }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

echo "=== Sandbox Testing Environment — Readiness Check ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Docker daemon availability
# ---------------------------------------------------------------------------
info "1/6: Checking Docker daemon..."
if docker info > /dev/null 2>&1; then
    pass "Docker daemon is running"
else
    fail "Docker daemon not reachable. Is Docker running?"
fi

# ---------------------------------------------------------------------------
# 2. Docker BuildKit support
# ---------------------------------------------------------------------------
info "2/6: Checking BuildKit support..."
if docker buildx version > /dev/null 2>&1; then
    pass "Docker BuildKit available"
else
    info "BuildKit not available — falling back to legacy builder (OK for basic tests)"
fi

# ---------------------------------------------------------------------------
# 3. Build sandbox image
# ---------------------------------------------------------------------------
info "3/6: Building sandbox image..."
if docker build -t execution-sandbox:test -f Dockerfile.sandbox . > /tmp/sandbox-build.log 2>&1; then
    pass "Sandbox image built successfully (execution-sandbox:test)"
else
    fail "Sandbox image build failed. Log: $(tail -5 /tmp/sandbox-build.log)"
fi

# ---------------------------------------------------------------------------
# 4. Sandbox image verification — check non-root user, workspace, tools
# ---------------------------------------------------------------------------
info "4/6: Verifying sandbox image contents..."
INSPECT=$(docker inspect execution-sandbox:test 2>/dev/null || true)

# Check non-root user
if docker run --rm execution-sandbox:test whoami 2>/dev/null | grep -q "executor"; then
    pass "Container runs as 'executor' user (non-root)"
else
    fail "Container not running as expected 'executor' user"
fi

# Check workspace directory
if docker run --rm execution-sandbox:test test -d /workspace 2>/dev/null; then
    pass "Workspace directory /workspace exists"
else
    fail "Workspace directory /workspace missing"
fi

# Check Python availability
if docker run --rm execution-sandbox:test python3 --version 2>/dev/null; then
    pass "Python 3 available in sandbox"
else
    fail "Python 3 not available in sandbox"
fi

# Check no shell history (security hardening)
if docker run --rm execution-sandbox:test bash -c 'echo $HISTFILE' 2>/dev/null | grep -q "unset"; then
    pass "Shell history disabled (security hardening)"
else
    info "Shell history not explicitly unset (check /etc/bash.bashrc)"
fi

# ---------------------------------------------------------------------------
# 5. Docker Compose availability
# ---------------------------------------------------------------------------
info "5/6: Checking Docker Compose..."
if docker compose version > /dev/null 2>&1; then
    pass "Docker Compose v2 available"
else
    info "Docker Compose v2 not found — integration tests may require manual service setup"
fi

# ---------------------------------------------------------------------------
# 6. Pytest + Docker dependencies
# ---------------------------------------------------------------------------
info "6/6: Checking test dependencies..."
MISSING=""
python3 -c "import pytest" 2>/dev/null || MISSING="$MISSING pytest"
python3 -c "import docker" 2>/dev/null || MISSING="$MISSING docker"
python3 -c "import structlog" 2>/dev/null || MISSING="$MISSING structlog"
python3 -c "import yaml" 2>/dev/null || MISSING="$MISSING pyyaml"

if [ -z "$MISSING" ]; then
    pass "All Python test dependencies available"
else
    fail "Missing Python packages:${MISSING}"
    info "Run: pip install -r requirements.txt"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: ${PASS}/${TOTAL} checks passed, ${FAIL} failed ==="
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "Some checks failed. Review diagnostics above."
    echo "For integration tests (pytest -m docker), Docker must be running."
    exit 1
else
    echo "All checks passed — sandbox testing environment is ready."
    echo ""
    echo "To run tests:"
    echo "  pytest tests/ -v                    # unit tests only"
    echo "  pytest tests/ -m docker -v          # with Docker integration tests"
    echo "  make test-sandbox                   # full sandbox test suite"
    echo ""
    echo "To clean up:"
    echo "  docker compose down                 # stop all services"
    echo "  docker image rm execution-sandbox:test  # remove test image"
    echo "  scripts/cleanup-sandbox-tests.sh    # automated cleanup"
    exit 0
fi
