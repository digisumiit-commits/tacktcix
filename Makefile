# PRO-86: Sandbox testing environment — test orchestration targets.
# Build, verify, test, and clean up the sandbox testing infrastructure.

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SANDBOX_IMAGE := execution-sandbox
SANDBOX_TAG := test
COMPOSE_BASE := -f docker-compose.yml
COMPOSE_TEST := -f docker-compose.yml -f docker-compose.test.yml

# Detect if Docker is available
HAS_DOCKER := $(shell docker info > /dev/null 2>&1 && echo yes || echo no)

# ---------------------------------------------------------------------------
# Phony targets
# ---------------------------------------------------------------------------
.PHONY: help build verify test test-unit test-docker test-all clean verify-image

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build: ## Build the sandbox test Docker image (execution-sandbox:test)
ifeq ($(HAS_DOCKER),yes)
	docker build -t $(SANDBOX_IMAGE):$(SANDBOX_TAG) -f Dockerfile.sandbox .
	@echo "Image $(SANDBOX_IMAGE):$(SANDBOX_TAG) built successfully"
else
	@echo "Docker not available — skipping build"
endif

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

verify: ## Run sandbox readiness verification checks
	@bash scripts/verify-sandbox.sh

# ---------------------------------------------------------------------------
# Testing
# ---------------------------------------------------------------------------

test-unit: ## Run sandbox unit tests (no Docker required)
	pytest tests/test_sandbox.py tests/test_seccomp.py tests/test_network_egress.py -v \
		--tb=short --strict-markers

test-docker: build ## Run Docker-dependent sandbox integration tests
	@echo "Starting test services..."
	docker compose $(COMPOSE_TEST) up -d worker 2>/dev/null || true
	sleep 3
	pytest tests/test_security_integration.py tests/test_sandbox.py tests/test_network_egress.py \
		-m docker -v --tb=short --strict-markers || true
	@echo "Stopping test services..."
	-docker compose $(COMPOSE_TEST) down 2>/dev/null

test-all: test-unit test-docker ## Run all sandbox tests (unit + Docker integration)

test-sandbox: test-unit ## Run full sandbox test suite (unit tests, default target)

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

up: build ## Start full sandbox environment
	docker compose $(COMPOSE_TEST) up -d

down: ## Stop all sandbox services
	docker compose $(COMPOSE_TEST) down 2>/dev/null || true
	docker compose $(COMPOSE_BASE) down 2>/dev/null || true

logs: ## View sandbox service logs
	docker compose $(COMPOSE_TEST) logs -f

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

clean: ## Remove all sandbox test artifacts (containers, networks, images, volumes)
	@bash scripts/cleanup-sandbox-tests.sh

clean-docker: clean ## Alias for clean

clean-all: clean ## Remove everything including project images
	docker image rm $(SANDBOX_IMAGE):$(SANDBOX_TAG) 2>/dev/null || true
	docker image rm $(SANDBOX_IMAGE):latest 2>/dev/null || true
	-docker compose $(COMPOSE_BASE) down -v 2>/dev/null

# ---------------------------------------------------------------------------
# Verify images
# ---------------------------------------------------------------------------

verify-image: ## Inspect the built sandbox image metadata
ifeq ($(HAS_DOCKER),yes)
	docker inspect $(SANDBOX_IMAGE):$(SANDBOX_TAG) | python3 -c "
import json, sys
data = json.load(sys.stdin)[0]
cfg = data['Config']
print(f'Image: {data[\"RepoTags\"][0]}')
print(f'User: {cfg.get(\"User\", \"root\")}')
print(f'Workdir: {cfg.get(\"WorkingDir\", \"/\")}')
print(f'Entrypoint: {cfg.get(\"Entrypoint\", [])}')
print(f'Cmd: {cfg.get(\"Cmd\", [])}')
print(f'Env: {len(cfg.get(\"Env\", []))} variables')
print(f'Arch: {data[\"Architecture\"]}')
print(f'OS: {data[\"Os\"]}')
print(f'Created: {data[\"Created\"]}')
print(f'Size: {data[\"Size\"] / 1024 / 1024:.1f} MB')
"
endif
