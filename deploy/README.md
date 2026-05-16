# TACKTCIX Deployment Pipeline

## Pipeline Overview

```
Code Generation → CI (lint/test/build) → QA Validation → Approval → Deploy → Monitoring
```

## Services & Platforms

| Service    | Platform | Purpose                    |
|------------|----------|----------------------------|
| Frontend   | Vercel   | Next.js app hosting + CDN  |
| Backend    | Railway  | FastAPI + PostgreSQL + Redis|

## GitHub Actions Workflows

### 1. `ci.yml` — Continuous Integration
- **Triggers:** Push to main/develop, PRs to main, manual dispatch
- **Jobs:** Lint (ruff, mypy, ESLint) → Test (pytest with PostgreSQL + Redis) → Build (Docker + Trivy scan)
- **Artifacts:** Coverage reports, vulnerability scan SARIF

### 2. `qa-validation.yml` — QA Validation
- **Triggers:** CI pipeline completion on main, manual dispatch
- **Jobs:** Smoke tests → E2E regression (Playwright) → QA Gate evaluation → Manual approval request
- **Gates:** Requires QA pass + designated approver sign-off before deploy proceeds

### 3. `deploy.yml` — Deployment
- **Triggers:** QA validation completion on main, manual dispatch
- **Jobs:** Frontend (Vercel) + Backend (Railway + migrations) → Release tag → Automatic rollback on failure
- **Environments:** Staging (default), Production (with concurrency lock)
- **Verification:** Health-check loop on each service post-deploy

### 4. `monitoring.yml` — Post-Deploy Monitoring
- **Triggers:** Deploy completion, cron every 5 min, manual dispatch
- **Jobs:** Health checks (staging + production), Prometheus SLO check, recent deployment status
- **Alerts:** Slack notification on failure

## Secrets Required

| Secret               | Workflow           | Purpose                        |
|----------------------|--------------------|--------------------------------|
| `VERCEL_TOKEN`       | deploy             | Vercel API authentication      |
| `VERCEL_ORG_ID`      | deploy             | Vercel organization ID         |
| `VERCEL_PROJECT_ID`  | deploy             | Vercel project ID              |
| `RAILWAY_TOKEN`      | deploy             | Railway CLI authentication     |
| `RAILWAY_PROJECT_ID` | deploy             | Railway project ID             |
| `SLACK_WEBHOOK_URL`  | monitoring         | Alert notifications            |

## Environment Variables

| Variable           | Workflow              | Purpose                    |
|--------------------|-----------------------|----------------------------|
| `STAGING_URL`      | qa, deploy, monitor   | Staging deployment URL     |
| `PRODUCTION_URL`   | qa, deploy, monitor   | Production deployment URL  |
| `PROMETHEUS_URL`   | monitor               | Prometheus query endpoint  |
| `APPROVERS`        | qa                    | GitHub usernames for deploy approval |

## Rollback

Automatic rollback triggers on deployment failure (built into `deploy.yml`). Manual rollback:

```bash
# Rollback both services
./infra/rollback/rollback.sh --service all --environment production

# Rollback frontend only (dry run)
./infra/rollback/rollback.sh --service frontend --environment staging --dry-run
```

## Health Checks

```bash
# Check a deployed environment
./infra/monitoring/health-check.sh https://api.staging.tacktcix.dev 120
```

## Monitoring Dashboards

- **Prometheus:** Fed from `/metrics` endpoints on API, frontend, workers, and infrastructure
- **Alert rules:** Defined in `infra/monitoring/alerts/deployment-alerts.yml`
  - Deployment failures / rollbacks
  - Service down detection
  - High error rate (>5% 5xx)
  - High latency (P95 > 1s)
  - Resource pressure (memory > 85%, CPU throttling)

## On-Call

1. Slack `#tacktcix-alerts` gets deployment notifications
2. Prometheus Alertmanager routes critical alerts to on-call
3. Runbook: Check the failed workflow run first, then escalate to CTO if infrastructure-level
