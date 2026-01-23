# 🏠 WheelHouse

**The Wheel Strategy Options Analyzer & Position Tracker**

A powerful Monte Carlo-based options analysis tool with **real-time Schwab & CBOE pricing**, AI-powered trade analysis, position tracking, and portfolio analytics - built specifically for traders running The Wheel Strategy.

![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-1.9.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

---

## 🆕 What's New in v1.9.0

### 📊 Per-Position Greeks
- **Delta (Δ) and Theta (Θ/day)** columns in Positions table
- Individual position Greeks calculated from Black-Scholes
- Neutral styling (pro trader aesthetic)

### 🤖 AI Portfolio Audit
- **Comprehensive AI analysis** of your entire portfolio
- Analyzes concentration risk, problem positions, Greeks balance
- Provides specific optimization suggestions (rolls, closes, adjustments)
- Saves context for use in future AI trade analysis

### 🧠 Portfolio-Aware AI Analysis
- **AI now considers your existing positions** when analyzing new trades
- Trade analysis warns about sector concentration
- Ideas feature suggests trades that balance your portfolio
- Context valid for 24 hours after audit

### 📅 Year Filter for Advanced Analytics
- Advanced Analytics now filters by selected year (matches Closed Positions filter)
- See "(2026)" or "(All Time)" label in header
- Compare current year vs historical performance

### 📥 Stage Roll Suggestions to Ideas
- **"Stage to Ideas" button** on each roll suggestion
- Purple **"ROLL" badge** in Pending Trades
- Call/Put indicator (C/P) with color coding
- Track roll candidates before executing with broker

### 📈 Conservative Kelly Calculator
- Now uses **Account Value + 25% of margin** (not full buying power)
- Much safer position sizing recommendations
- Tooltip explains the calculation

---

## 📦 Previous: v1.8.0

### 💹 Schwab API Integration (Real-Time Pricing!)
- **Schwab-first option pricing** - Real-time bid/ask/Greeks from your Schwab account
- **CBOE fallback** - Automatically falls back to CBOE delayed quotes if Schwab unavailable
- **Full Greeks** - Delta, Theta, Gamma, IV all from Schwab's live data
- **Win Probability** - Calculated from delta (e.g., -0.23 delta ≈ 77% profit probability)
- **Data source indicator** - 🔴 Schwab (real-time) vs 🔵 CBOE (15-min delayed)

### 🎯 Smart Strike Lookup
- **Finds REAL strikes** - No more guessing! Fetches all available strikes from Schwab
- **Auto-adjustment** - If you request $152 but only $150 exists, it uses $150 and tells you
- **Strike adjustment notes** - "⚠️ Using actual strike $150 (requested $152)"

### 📊 TradingView Charts for Staged Trades
- **📊 Chart button** on each staged trade
- **3-month chart** with **Bollinger Bands** pre-loaded
- **Dark theme** matching WheelHouse
- Perfect for checking if stock is oversold before entering

### 🗓️ Friday Expiry Validation
- **Auto-snaps to Fridays** - Options expire on Fridays, never weekends
- If AI says "Feb 21" (Saturday), auto-corrects to **"Feb 20"** (Friday)
- Prompt now shows exact valid expiry dates to AI

### 🤖 AI Trade Ideas Generator Improvements
- **54 curated stocks** + Yahoo Most Active + Trending discovery
- **10 ideas per run** (was 3)
- **Range position filtering** - Rejects stocks >70% of range (extended/risky)
- **"Show Different Stocks"** button for variety
- **15-minute cache** for Yahoo rate limiting

### 🔧 Bug Fixes
- Fixed IV display (was 6500%, now shows correct 65%)
- Fixed Deep Dive buttons not appearing (regex now handles **bold** markdown)
- Fixed localStorage persistence for trade ideas (24-hour cache)

---

## 📦 Previous: v1.7.0

### 🧠 AI Model Improvements
- **Model Selector for Discord Analyzer** - Choose 7B (fast), 14B, or 32B (best) - defaults to 32B
- **Model Warmup Button** - Pre-load models into GPU memory for instant responses
- **Real-time Progress** - See step-by-step progress during trade analysis with elapsed time
- **Smart Token Scaling** - Larger models get higher token limits for more detailed analysis

### 📊 Verdict Spectrum (New!)
Instead of binary FOLLOW/PASS, Discord Analyzer now gives **three perspectives**:
- 🟢 **AGGRESSIVE VIEW** - Bull case, probability of max profit
- 🟡 **MODERATE VIEW** - Balanced take with position sizing advice
- 🔴 **CONSERVATIVE VIEW** - What concerns would make you pass
- **BOTTOM LINE** - Who is this trade best suited for?

### 📈 Enhanced Thesis Tracking
- **Range Position Indicator** - See where stock is in its 3-month range (0%=low, 100%=high)
- **IV Saved at Entry** - Compare entry IV to current IV during checkups
- **Full Analysis Saved** - "View Full Entry Analysis" button to review original AI reasoning
- **Analysis History** - Track multiple AI analyses over time with market snapshots
- **Model Tracking** - Know which AI model was used for each analysis

### 🔧 Bug Fixes
- Fixed premium validation (stock prices no longer confused with option premiums)
- Fixed range position interpretation (7B model was saying 1%=high, now has emoji hints)
- Improved server restart handling (cleans up orphaned processes)

---

## 📦 Previous: v1.5.0

### 🤖 AI Trade Advisor
- **Deep Dive Analysis** - Comprehensive scenario analysis with CBOE live pricing
- **Discord Trade Analyzer** - Paste any trade callout for instant AI analysis
- **Spread Support** - Full risk/reward math for spreads
- **Position Checkup** - Compare opening thesis to current conditions
- **Trade Critique** - AI reviews closed trades with feedback

### 📊 Analysis Features
- **Stage → Confirm Flow** - Stage trades, confirm when executed
- **Thesis Storage** - Each position remembers WHY you entered
- **DTE Warnings** - Red flags for short-dated trades (≤7 days)
- **Spread Math** - Proper risk/reward (max profit, max loss, return on risk)

---

## ✨ Key Features

### 📡 Real-Time Options Pricing (Schwab + CBOE)
- **Schwab API integration** - Real-time bid/ask/last from your brokerage account
- **Full Greeks from Schwab** - Delta, Theta, Gamma, IV for accurate risk assessment
- **CBOE delayed quotes fallback** - 15-min delayed data when Schwab unavailable
- **Smart strike lookup** - Fetches all available strikes, finds closest match
- **Staleness indicators** - Know when prices are stale vs fresh
- **Rate of Change (ROC)** tracking for mark-to-market P&L
- Fallback to Yahoo Finance for stock quotes

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

### 🧠 AI Trade Advisor (Local - No Cloud Required)
- **100% Local AI** - Runs entirely on your machine via [Ollama](https://ollama.com)
- **No API keys, no subscriptions, no data leaves your computer**
- **Model Selection**: Choose between 7B (fast), 14B (better), 32B (best)

**AI Features:**

| Feature | Description |
|---------|-------------|
| **Deep Dive** | Comprehensive analysis with CBOE live pricing, support/resistance, scenario modeling |
| **Discord Analyzer** | Paste any trade callout → AI parses it and gives FOLLOW/PASS/AVOID verdict |
| **Position Checkup** | Compare opening thesis to current market - has your trade thesis held up? |
| **Trade Critique** | Review closed trades with AI feedback on what went well/could improve |
| **Roll Advisor** | AI analyzes all roll options and recommends the best choice |
| **Spread Math** | Proper risk/reward for spreads (not the broken "naked put" math!) |

**Verdicts:**
- ✅ **ENTER/FOLLOW** - Good setup, trade worth taking
- ⚠️ **WAIT/PASS** - Not ideal entry, wait for better conditions
- ❌ **AVOID** - Poor risk/reward, skip this one

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
