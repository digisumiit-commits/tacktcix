#!/usr/bin/env bash
# Provision PostgreSQL for Tacktcix preview via Neon
# Prerequisites: npm, npx, Vercel CLI authenticated (VERCEL_TOKEN)
# Interactive step: opens browser for Neon OAuth — complete it, then the script continues.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend"
VERCEL_PROJECT="tacktcix-api"
NEON_PROJECT_NAME="tacktcix-preview"
NEON_DB_NAME="tacktcix"
NEON_ROLE_NAME="tacktcix_app"

echo "=== Step 1: Authenticate with Neon (browser OAuth) ==="
cd "$BACKEND_DIR"
npx neonctl auth

echo ""
echo "=== Step 2: Create Neon project ==="
npx neonctl projects create \
  --name "$NEON_PROJECT_NAME" \
  --region-id aws-us-east-1 \
  --output json

PROJECT_ID=$(npx neonctl projects list --output json | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const p=JSON.parse(d).projects.find(p=>p.name==='$NEON_PROJECT_NAME');
    console.log(p?p.id:'');
  })
")

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Could not find project $NEON_PROJECT_NAME"
  exit 1
fi
echo "Project ID: $PROJECT_ID"

echo ""
echo "=== Step 3: Create database and role ==="
npx neonctl databases create --project-id "$PROJECT_ID" --name "$NEON_DB_NAME" --owner-name "$NEON_ROLE_NAME"

echo ""
echo "=== Step 4: Get connection string ==="
CONN_STRING=$(npx neonctl connection-string "$NEON_DB_NAME" --project-id "$PROJECT_ID" --role-name "$NEON_ROLE_NAME" --output json | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const cs=JSON.parse(d).connection_string;
    // asyncpg wants postgresql:// not postgres://
    console.log(cs.replace(/^postgres:\/\//, 'postgresql+asyncpg://'));
  })
")
echo "Connection string: postgresql+asyncpg://${CONN_STRING#*://}"

echo ""
echo "=== Step 5: Set TACKTCIX_DATABASE_URL in Vercel ==="
echo "$CONN_STRING" | npx vercel env add TACKTCIX_DATABASE_URL production --token "${VERCEL_TOKEN:-}" || \
  echo "Set manually: vercel env add TACKTCIX_DATABASE_URL production"

echo ""
echo "=== Step 6: Run database migrations ==="
cd "$BACKEND_DIR"
TACKTCIX_DATABASE_URL="$CONN_STRING" python -m alembic upgrade head

echo ""
echo "=== Step 7: Deploy and verify ==="
cd "$BACKEND_DIR"
npx vercel deploy --prod --yes

echo ""
echo "=== Done! ==="
echo "Verify: curl https://tacktcix-api.vercel.app/api/health"
echo "Test:   curl -X POST https://tacktcix-api.vercel.app/api/v1/onboarding/start \\"
echo "          -H 'Content-Type: application/json' \\"
echo "          -d '{\"name\":\"Test\",\"slug\":\"test-co\"}'"
