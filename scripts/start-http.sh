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

# Check ChromaDB
if ! curl -sf http://localhost:8000/api/v1/heartbeat > /dev/null 2>&1; then
  echo "Warning: ChromaDB is not running at http://localhost:8000"
  echo "Start it with: chromadb run --host localhost --port 8000"
fi

# Check Embedding Service
if ! curl -sf http://localhost:8902/health > /dev/null 2>&1; then
  echo "Warning: Embedding service is not running at http://localhost:8902"
  echo "Start it with: cd embedding-service && python app.py"
fi

# Start HTTP server
echo "Starting OpenClaw Context Engine HTTP server..."
cd "$PROJECT_DIR"
exec node src/index.js
