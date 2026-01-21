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
# Core Installation Complete
# ===================================================
echo ""
echo "==============================================="
echo "   Core Installation Complete!"
echo "==============================================="
echo ""

# ===================================================
# Optional: AI Trade Advisor (Ollama + Qwen)
# ===================================================
echo "OPTIONAL: AI Trade Advisor"
echo "-----------------------------------------------"
echo "WheelHouse includes an AI-powered trade advisor"
echo "that runs locally on your computer using Ollama."
echo ""
echo "GPU Requirements:"
echo "  - NVIDIA GPU with 8GB+ VRAM (recommended)"
echo "  - Or: Apple Silicon Mac (M1/M2/M3)"
echo "  - Or: CPU-only (slower, ~30 sec per query)"
echo ""
echo "The AI model (Qwen 2.5 7B) requires:"
echo "  - ~5GB disk space"
echo "  - ~8GB VRAM (GPU) or ~16GB RAM (CPU)"
echo ""

# Check for NVIDIA GPU
HAS_NVIDIA=0
if command -v nvidia-smi &> /dev/null; then
    HAS_NVIDIA=1
    echo "Detected: NVIDIA GPU"
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null
    echo ""
fi

# Check for Apple Silicon
if [[ "$(uname -m)" == "arm64" ]] && [[ "$(uname)" == "Darwin" ]]; then
    echo "Detected: Apple Silicon (Metal acceleration available)"
    echo ""
fi

if [ "$HAS_NVIDIA" -eq 0 ] && [[ "$(uname -m)" != "arm64" ]]; then
    echo "Note: No GPU detected. AI will run on CPU (slower)."
    echo ""
fi

read -p "Install AI Trade Advisor? (y/n): " INSTALL_AI

if [[ "$INSTALL_AI" =~ ^[Yy]$ ]]; then
    echo ""
    echo "[AI] Checking for Ollama..."
    
    if ! command -v ollama &> /dev/null; then
        echo "[AI] Ollama not found. Installing..."
        
        if [[ "$(uname)" == "Darwin" ]]; then
            # macOS - use Homebrew
            if command -v brew &> /dev/null; then
                brew install ollama
            else
                echo "[AI] Please install Ollama from https://ollama.com"
                echo "[AI] Then run: ollama pull qwen2.5:7b"
            fi
        else
            # Linux
            curl -fsSL https://ollama.com/install.sh | sh
        fi
    else
        echo "[AI] Found Ollama"
    fi
    
    # Check if ollama is now available
    if command -v ollama &> /dev/null; then
        echo ""
        echo "[AI] Downloading Qwen 2.5 7B model (~5GB)..."
        echo "[AI] This may take several minutes..."
        echo ""
        
        # Start Ollama service if not running (Linux)
        ollama serve &>/dev/null &
        sleep 3
        
        # Pull the model
        ollama pull qwen2.5:7b
        
        if [ $? -eq 0 ]; then
            echo ""
            echo "[AI] AI Trade Advisor installed successfully!"
        else
            echo ""
            echo "[AI] Model download failed."
            echo "[AI] Try manually: ollama pull qwen2.5:7b"
        fi
    fi
else
    echo ""
    echo "Skipping AI installation."
    echo "You can install later by running: ollama pull qwen2.5:7b"
fi

echo ""
echo "==============================================="
echo "   Setup Complete!"
echo "==============================================="
echo ""
echo "To start WheelHouse, run:"
echo "   ./start.sh"
echo ""
echo "Or run: node server.js"
echo ""
