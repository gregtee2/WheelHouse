#!/bin/bash

# ===============================================
#    WheelHouse - One-Click Installer (Mac/Linux)
#    Options Strategy Analyzer
# ===============================================

echo ""
echo "==============================================="
echo "   WheelHouse - One-Click Installer"
echo "   Options Strategy Analyzer"
echo "==============================================="
echo ""

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# ===================================================
# Step 1: Check for Node.js
# ===================================================
echo "[1/2] Checking for Node.js..."

if ! command -v node &> /dev/null; then
    echo "   Node.js not found. Attempting to install..."
    
    # Check for Homebrew (Mac)
    if command -v brew &> /dev/null; then
        echo "   Installing via Homebrew..."
        brew install node
    # Check for apt (Debian/Ubuntu)
    elif command -v apt &> /dev/null; then
        echo "   Installing via apt..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    # Check for yum (RHEL/CentOS)
    elif command -v yum &> /dev/null; then
        echo "   Installing via yum..."
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs
    else
        echo ""
        echo "   ERROR: Could not install Node.js automatically."
        echo "   Please install Node.js manually from https://nodejs.org"
        echo ""
        exit 1
    fi
    
    # Verify installation
    if ! command -v node &> /dev/null; then
        echo ""
        echo "   ERROR: Node.js installation failed."
        echo "   Please install Node.js manually from https://nodejs.org"
        echo ""
        exit 1
    fi
    echo "   Node.js installed successfully!"
else
    echo "   Found Node.js $(node -v)"
fi

# ===================================================
# Step 2: Install npm dependencies
# ===================================================
echo ""
echo "[2/2] Installing dependencies..."

if [ -f "package.json" ]; then
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "   ERROR: npm install failed!"
        echo ""
        exit 1
    fi
    echo "   Dependencies installed!"
else
    echo "   No package.json found - skipping npm install"
fi

# ===================================================
# Make start.sh executable
# ===================================================
chmod +x "$SCRIPT_DIR/start.sh" 2>/dev/null

# ===================================================
# Installation Complete
# ===================================================
echo ""
echo "==============================================="
echo "   Installation Complete!"
echo "==============================================="
echo ""
echo "To start WheelHouse, run:"
echo "   ./start.sh"
echo ""
echo "Or run: node server.js"
echo ""
