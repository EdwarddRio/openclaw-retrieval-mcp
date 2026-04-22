#!/bin/bash
set -e

# OpenClaw Context Engine JS - MCP Server Startup Script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment variables
if [ -f "$PROJECT_DIR/config/context-engine.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/config/context-engine.env" | xargs)
fi

# Start MCP server (stdio mode)
cd "$PROJECT_DIR"
exec node src/mcp-server.js
