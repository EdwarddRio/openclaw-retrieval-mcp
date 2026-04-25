#!/bin/bash
set -e

# OpenClaw Context Engine JS - HTTP Server Startup Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment variables
if [ -f "$PROJECT_DIR/config/context-engine.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/config/context-engine.env" | xargs)
fi

# Check dependencies
echo "Checking dependencies..."

# Start HTTP server
echo "Starting OpenClaw Context Engine HTTP server..."
cd "$PROJECT_DIR"
exec node src/index.js
