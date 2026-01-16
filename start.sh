#!/bin/bash

# ===============================================
#    WheelHouse - Options Strategy Analyzer
# ===============================================

echo ""
echo "==============================================="
echo "   WheelHouse - Options Strategy Analyzer"
echo "==============================================="
echo ""

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found!"
    echo ""
    echo "Please run ./install.sh first."
    echo ""
    exit 1
fi

# Kill any existing process on port 8888
echo "Checking for existing server..."
lsof -ti:8888 | xargs kill -9 2>/dev/null
sleep 1

# Start the server
echo "Starting WheelHouse server..."
echo ""

# Open browser after a short delay (works on Mac and Linux)
(sleep 2 && {
    if command -v open &> /dev/null; then
        open http://localhost:8888  # Mac
    elif command -v xdg-open &> /dev/null; then
        xdg-open http://localhost:8888  # Linux
    fi
}) &

# Start the server
node server.js

# If server exits
echo ""
echo "Server stopped."
