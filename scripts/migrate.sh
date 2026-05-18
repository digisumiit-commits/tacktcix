#!/bin/bash
# Apply the memory system PostgreSQL migration.
# Usage: ./scripts/migrate.sh [database-url]
set -euo pipefail

DB_URL="${1:-postgresql://postgres:postgres@localhost:5432/tacktcix}"

echo "Running memory schema migration against $DB_URL..."

PGPASSWORD="${DB_URL#*:}" && PGPASSWORD="${PGPASSWORD%@*}"
psql "$DB_URL" -f migrations/001_memory_schema.sql
psql "$DB_URL" -f migrations/002_context_bus_schema.sql
psql "$DB_URL" -f migrations/002_workflow_schema.sql
psql "$DB_URL" -f migrations/002_usage_records.sql
psql "$DB_URL" -f migrations/003_budget_schema.sql

echo "Migration complete."
