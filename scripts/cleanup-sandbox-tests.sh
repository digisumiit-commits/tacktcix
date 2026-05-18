#!/usr/bin/env bash
# PRO-86: Clean up sandbox test artifacts — containers, networks, images, and volumes.
# Safe to run multiple times; idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CLEANED=0
clean() { CLEANED=$((CLEANED + 1)); echo -e "${GREEN}CLEANED${NC}: $1"; }
skip() { echo -e "${YELLOW}SKIP${NC}: $1"; }
err() { echo -e "${RED}ERROR${NC}: $1"; }

echo "=== Sandbox Test Artifact Cleanup ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Stop and remove test containers
# ---------------------------------------------------------------------------
echo "--- Containers ---"
for CONTAINER in $(docker ps -aq --filter "label=paperclip.sandbox=true" --filter "label=paperclip.env=test" 2>/dev/null); do
    docker rm -f "$CONTAINER" 2>/dev/null && clean "Removed sandbox container: $(echo "$CONTAINER" | cut -c1-12)"
done

# Also clean any from security integration tests
for CONTAINER in $(docker ps -aq --filter "label=paperclip.test=security-integration" 2>/dev/null); do
    docker rm -f "$CONTAINER" 2>/dev/null && clean "Removed integration test container: $(echo "$CONTAINER" | cut -c1-12)"
done

# Clean test-runner and test-worker if left running
for NAME in sandbox-test-worker sandbox-test-runner sandbox-test-isolated-net; do
    if docker ps -aq --filter "name=$NAME" 2>/dev/null | grep -q .; then
        docker rm -f "$NAME" 2>/dev/null && clean "Removed test service: $NAME"
    else
        skip "No container named $NAME"
    fi
done

# ---------------------------------------------------------------------------
# 2. Remove test networks
# ---------------------------------------------------------------------------
echo ""
echo "--- Networks ---"
for NET in sandbox-test-net sandbox-test-isolated-net; do
    if docker network ls --filter "name=$NET" -q 2>/dev/null | grep -q .; then
        docker network rm "$NET" 2>/dev/null && clean "Removed test network: $NET" || err "Cannot remove network $NET (may have connected containers)"
    else
        skip "No network named $NET"
    fi
done

# ---------------------------------------------------------------------------
# 3. Remove test images
# ---------------------------------------------------------------------------
echo ""
echo "--- Images ---"
for TAG in execution-sandbox:test execution-sandbox:latest; do
    if docker image ls --filter "reference=$TAG" -q 2>/dev/null | grep -q .; then
        docker image rm "$TAG" 2>/dev/null && clean "Removed image: $TAG" || err "Cannot remove image $TAG (in use)"
    else
        skip "No image tagged $TAG"
    fi
done

# ---------------------------------------------------------------------------
# 4. Prune build cache for sandbox builds
# ---------------------------------------------------------------------------
echo ""
echo "--- Build Cache ---"
BUILDER=$(docker buildx ls 2>/dev/null | head -1 | awk '{print $1}' || echo "default")
docker builder prune --filter "label=paperclip.sandbox" --force 2>/dev/null && clean "Pruned sandbox build cache"
skip "Build cache pruning is best-effort (no label filter may match Dockerfile.sandbox layers)"

# ---------------------------------------------------------------------------
# 5. Remove test volumes
# ---------------------------------------------------------------------------
echo ""
echo "--- Volumes ---"
docker volume ls --filter "label=paperclip.env=test" -q 2>/dev/null | while read -r VOL; do
    docker volume rm "$VOL" 2>/dev/null && clean "Removed volume: $VOL"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Cleanup complete: ${CLEANED} items removed ==="
echo ""
echo "Manual checks if issues persist:"
echo "  docker ps -a --filter 'label=paperclip.sandbox'"
echo "  docker network ls --filter 'label=paperclip.network'"
echo "  docker image ls execution-sandbox"
echo ""
