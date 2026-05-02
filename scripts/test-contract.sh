#!/bin/bash
# API Contract Integration Test
# Starts the engine, runs health + endpoint scan, then shuts down.

set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ENGINE_DIR"

# Load env if available
if [ -f config/context-engine.env ]; then
  export $(grep -v '^#' config/context-engine.env | xargs)
fi

# Ensure API_SECRET is set for test
export OPENCLAW_API_SECRET="${OPENCLAW_API_SECRET:-test-secret}"
# Use a temporary port to avoid conflict with production service
export HTTP_PORT="${TEST_HTTP_PORT:-18901}"

echo "[contract-test] Starting context-engine on port $HTTP_PORT..."
node src/index.js &
SERVER_PID=$!

# Wait for ready
for i in $(seq 1 30); do
  if curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $OPENCLAW_API_SECRET" \
    http://127.0.0.1:$HTTP_PORT/api/health/ready | grep -q "200"; then
    echo "[contract-test] Server ready (attempt $i)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[contract-test] Server failed to start"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Run contract checks
echo "[contract-test] Running endpoint scan..."
FAIL=0

check_endpoint() {
  local method=$1
  local path=$2
  local expected=$3
  local body=${4:-}
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $OPENCLAW_API_SECRET" \
      -H "Content-Type: application/json" \
      -X "$method" \
      -d "$body" \
      "http://127.0.0.1:$HTTP_PORT$path" || echo "000")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $OPENCLAW_API_SECRET" \
      -X "$method" \
      "http://127.0.0.1:$HTTP_PORT$path" || echo "000")
  fi
  if [ "$code" = "$expected" ]; then
    echo "  ✓ $method $path → $code"
  else
    echo "  ✗ $method $path → $code (expected $expected)"
    FAIL=1
  fi
}

check_endpoint GET  /api/health         200
check_endpoint GET  /api/health/ready   200
check_endpoint GET  /metrics            200
check_endpoint GET  /api/memory/reviews 200
check_endpoint POST /api/memory/query   200 '{"query":"test","top_k":3}'
check_endpoint POST /api/memory/query-context 200 '{"query":"test","top_k":3}'
check_endpoint POST /api/wiki/search    200 '{"query":"test","top_k":3}'

# Shutdown
echo "[contract-test] Shutting down server..."
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

if [ $FAIL -eq 0 ]; then
  echo "[contract-test] All endpoints passed."
  exit 0
else
  echo "[contract-test] Some endpoints failed."
  exit 1
fi
