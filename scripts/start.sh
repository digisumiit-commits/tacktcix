#!/bin/bash
# Start the TACKTCIX Memory System.
# Usage: ./scripts/start.sh
set -euo pipefail

# Apply migration
echo "Applying database migration..."
PGPASSWORD="${DATABASE_URL#*:}" && PGPASSWORD="${PGPASSWORD%@*}"
psql "$DATABASE_URL" -f migrations/001_memory_schema.sql 2>/dev/null || echo "Migration may have already been applied."

# Start the server
echo "Starting memory service..."
exec npx tsx src/main.ts
