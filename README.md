# 🏠 WheelHouse

**The Wheel Strategy Options Analyzer & Position Tracker**

A powerful Monte Carlo-based options analysis tool with **real-time CBOE pricing**, position tracking, and portfolio analytics - built specifically for traders running The Wheel Strategy.

![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-1.4.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

---

## ✨ Key Features

### 📡 Real-Time CBOE Options Pricing
- **Live bid/ask/last prices** from CBOE's delayed quotes API
- **Staleness indicators** - Know when prices are stale vs fresh
- **Rate of Change (ROC)** tracking for mark-to-market P&L
- Automatic refresh with visual freshness indicators
- Fallback to Yahoo Finance when CBOE unavailable

### 💰 Monte Carlo Simulation Engine
- **10,000+ path Brownian motion** simulations
- Configurable drift, volatility, and time parameters
- Visual histogram of price distributions
- Probability cone visualization (1σ, 2σ, 3σ)

### 📊 Options Pricing & Greeks
- Black-Scholes analytical pricing
- Monte Carlo simulation-based pricing
- Delta, Gamma, Theta, Vega calculations
- Interactive payoff diagrams

### 📋 Position Tracker
- Track unlimited open positions
- **Automatic DTE calculation** with urgency colors
- ROC and Annualized ROC per position
- Edit, roll, close, or delete positions
- Assignment and called-away workflows
- **Chain tracking** - See your full roll history

### 💼 Portfolio Analytics
- Total premium collected
- Capital at risk calculations
- Weighted average annual ROC
- Win rate and P&L statistics
- Live unrealized P&L with CBOE prices

### 🏆 Trading Challenges
- Create time-bound trading challenges
- Link positions to challenges
- Track progress toward goals
- Visual progress bars

### 📈 Stock Holdings Tracker
- Track shares from assignments
- Cost basis management
- Covered call integration

### 🧠 AI Trade Advisor (Optional)
- **Local AI-powered** trade analysis using Qwen 2.5 models
- Runs entirely on your machine via [Ollama](https://ollama.com)
- No cloud API keys or subscriptions required
- **Model Selection**: Choose between 7B (fast), 14B (better), 32B (best)
- **Smart Health Check**: Skips AI for healthy positions, instant "HOLD" advice
- **AI Pick Highlighting**: Green border + badge on recommended roll
- Get natural language recommendations based on:
  - Current position parameters (ITM/OTM, DTE, IV)
  - Monte Carlo probabilities
  - ALL available roll options (analyzed and ranked)
  - Credit vs debit roll comparison
  - Expert Analysis context

**Supported Models:**
| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| qwen2.5:7b | ~5GB | Fast (5s) | Good |
| qwen2.5:14b | ~9GB | Medium (10s) | Better |
| qwen2.5:32b | ~20GB | Slower (20s) | Best |
| llama3.1:8b | ~5GB | Fast | Good |
| mistral:7b | ~4GB | Fast | Good |

**GPU Requirements for AI:**
| Hardware | Speed | Notes |
|----------|-------|-------|
| NVIDIA GPU (8GB+ VRAM) | Fast (~5-10 sec) | RTX 3060 or better recommended |
| NVIDIA GPU (24GB+ VRAM) | Fast | Can run 32B model for best quality |
| Apple Silicon (M1/M2/M3) | Fast | Native Metal acceleration |
| CPU Only | Slow (~30 sec) | Works but not recommended |

---

## 🚀 Quick Start

### Windows
```batch
# 1. Clone the repository
git clone https://github.com/gregtee2/WheelHouse.git
cd WheelHouse

# 2. Install (auto-installs Node.js if needed)
install.bat

# 3. Run
start.bat
```

### Mac/Linux
```bash
# 1. Clone the repository
git clone https://github.com/gregtee2/WheelHouse.git
cd WheelHouse

# 2. Make scripts executable and install
chmod +x install.sh start.sh
./install.sh

# 3. Run
./start.sh
```

Browser opens automatically to **http://localhost:8888**

Your positions are saved locally - no account required!

---

## 🎯 The Wheel Strategy

The Wheel is an income strategy for stocks you want to own:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SELL PUT       │────▶│  GET ASSIGNED   │────▶│  SELL CALL      │
│  Collect $$$    │     │  Own shares     │     │  Collect $$$    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                               │
        │ Expires worthless                             │ Shares called away
        ▼                                               ▼
   KEEP PREMIUM ←──────────────────────────────── START OVER
```

**WheelHouse helps you:**
- Analyze assignment probability before entering trades
- Track premium collected across your portfolio  
- Calculate optimal roll points when positions go against you
- Monitor your overall capital at risk

---

## 📁 Project Structure

```
WheelHouse/
├── server.js           # Node.js server (CBOE/Yahoo proxy)
├── index.html          # Main application shell
├── css/
│   └── styles.css      # Dark theme styling
└── js/
    ├── main.js         # Entry point, initialization
    ├── state.js        # Global state management  
    ├── api.js          # CBOE & Yahoo Finance API
    ├── pricing.js      # Black-Scholes, Monte Carlo
    ├── simulation.js   # Brownian motion engine
    ├── positions.js    # Position CRUD, localStorage
    ├── portfolio.js    # Portfolio analytics
    ├── challenges.js   # Trading challenges system
    ├── charts.js       # Canvas chart rendering
    ├── analysis.js     # Recommendations, EV calcs
    └── ui.js           # UI bindings, sliders
```

---

## 🔧 Configuration

The server runs on port **8888** by default. To change:

```javascript
// In server.js
const PORT = process.env.PORT || 8888;
```

---

## 📊 Screenshots

### Portfolio - Open Positions Dashboard
![Portfolio](screencaps/01-portfolio.png)
*Your main dashboard showing all open wheel positions at a glance. View DTE, premium collected, capital at risk, and live P&L across your entire portfolio.*

---

### Positions - Live Tracking with CBOE Prices
![Positions](screencaps/02-positions.png)
*Detailed position view with real-time CBOE pricing. See current option prices, staleness indicators, unrealized P&L, and quick actions for rolling, closing, or analyzing each trade.*

---

### Trading Challenges - Goal Tracking
![Challenges](screencaps/03-challenges.png)
*Create time-bound trading challenges (e.g., "$3K in January"). Track progress with the "To Go" stat, realized vs unrealized P&L, and only positions opened within the challenge period count for honest tracking.*

---

### Options Pricing - Black-Scholes & Monte Carlo
![Options](screencaps/04-options.png)
*Calculate theoretical option prices using both Black-Scholes and Monte Carlo methods. View probability of profit, expected value, and risk/reward analysis before entering trades.*

---

### P&L Analysis - Payoff Diagrams & Risk Visualization
![P&L](screencaps/05-pnl.png)
*Visual P&L analysis tools: payoff diagram at expiration, probability cone (1σ, 2σ, 3σ), break-even analysis, roll calculator, and an interactive P&L heat map showing profit/loss zones across stock price and days to expiry.*

---

### Simulator - Monte Carlo Brownian Motion
![Simulator](screencaps/06-simulator.png)
*Run thousands of price path simulations to visualize probability distributions. See how often positions expire ITM vs OTM with configurable volatility and DTE parameters.*

---

### Trade Metrics - Risk Analysis Panel
![Trade Metrics](screencaps/07-trade-metrics.png)
*Real-time risk assessment showing assignment probability, ROC, annualized returns, risk/reward ratio, win probability, Kelly criterion, and expected loss if assigned. The "Moderate Risk - WATCH" banner gives actionable guidance.*

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla JavaScript (ES6 modules), Canvas API
- **Backend**: Node.js, Express
- **Data**: CBOE delayed quotes, Yahoo Finance fallback
- **Storage**: Browser localStorage (no database needed)

---

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Contributions welcome! Please open an issue first to discuss changes.

---

*Built for wheel traders who want data-driven decisions.* 🎰
