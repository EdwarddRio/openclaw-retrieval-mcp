#!/bin/bash

# OpenClaw Context Engine JS - Health Check Script

HTTP_HOST="${HTTP_HOST:-127.0.0.1}"
HTTP_PORT="${HTTP_PORT:-8901}"

HEALTH_URL="http://${HTTP_HOST}:${HTTP_PORT}/api/health"

echo "Checking health at ${HEALTH_URL}..."

if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
  echo "Health check passed"
  curl -s "${HEALTH_URL}" | python3 -m json.tool 2>/dev/null || curl -s "${HEALTH_URL}"
  exit 0
else
  echo "Health check failed"
  exit 1
fi
