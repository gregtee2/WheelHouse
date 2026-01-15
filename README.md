# 🏠 WheelHouse

**Wheel Strategy Options Analyzer**

A Monte Carlo-based options pricing and analysis tool designed specifically for the Wheel Strategy (selling cash-secured puts and covered calls).

## Features

### 📊 Monte Carlo Simulation
- Brownian motion path simulation
- Configurable drift, volatility, and starting position
- Batch simulation with statistical analysis
- Visual histogram of exit times

### 💰 Options Pricing
- Black-Scholes option pricing (calls and puts)
- Monte Carlo simulation-based pricing
- Real-time Yahoo Finance price fetching
- Automatic probability calculation

### 📈 P&L Analysis
- Break-even analysis
- Probability cone visualization (1σ, 2σ, 3σ)
- Interactive heat map showing P&L across price/time
- Roll calculator for position management

### 📋 Position Tracker
- Track multiple open positions
- Edit positions after creation
- LocalStorage persistence
- Portfolio summary (premium collected, risk, theta)
- One-click position analysis

### 💼 Portfolio P&L
- Live P&L tracking for all positions
- Unrealized P&L with current option prices
- Realized P&L from closed positions
- Performance metrics (win rate, best/worst trade)
- Close positions to lock in gains

### Δ Greeks Calculator
- Delta, Gamma, Vega calculations
- Visual comparison charts
- Finite-difference approximation

### 🎯 Trade Metrics
- Return on Capital (ROC)
- Annualized ROC
- Risk:Reward ratio (realistic, not theoretical)
- Win probability vs required win rate
- Kelly criterion position sizing
- Your edge calculation

## Quick Start

Since this uses ES6 modules, you need a local server:

```bash
# Using Node.js
npx serve

# Or using Python
python -m http.server 8000
```

Then open `http://localhost:5000` (or 8000 for Python).

## Project Structure

```
WheelHouse/
├── index.html          # Main HTML shell
├── css/
│   └── styles.css      # All styling
└── js/
    ├── main.js         # Entry point, initialization
    ├── state.js        # Global state management
    ├── utils.js        # Math helpers, formatting
    ├── api.js          # Yahoo Finance API calls
    ├── simulation.js   # Brownian motion simulation
    ├── pricing.js      # Black-Scholes, Monte Carlo pricing
    ├── analysis.js     # Recommendations, EV calculations
    ├── charts.js       # All canvas drawing functions
    ├── positions.js    # Position tracker (localStorage)
    └── ui.js           # Sliders, date pickers, UI bindings
```

## Module Dependencies

```
main.js
  ├── state.js (core state)
  ├── utils.js (helpers)
  ├── api.js ─── state.js, utils.js
  ├── simulation.js ─── state.js, utils.js, charts.js
  ├── pricing.js ─── state.js, utils.js
  ├── analysis.js ─── state.js, pricing.js
  ├── charts.js ─── state.js, utils.js, pricing.js
  ├── positions.js ─── state.js, utils.js, api.js
  └── ui.js ─── state.js, utils.js, charts.js, pricing.js, analysis.js, simulation.js
```

## The Wheel Strategy

The Wheel is a popular options income strategy:

1. **Sell Cash-Secured Put** - Collect premium, agree to buy stock at strike price
2. **If Assigned** - You now own shares at a discount (strike - premium)
3. **Sell Covered Call** - Collect more premium on your shares
4. **If Called Away** - Sell shares at profit, restart the wheel

This tool helps you analyze:
- Probability of assignment (put going ITM)
- Expected value of trades
- Roll opportunities when positions go against you
- Portfolio-level risk management

## Tech Stack

- **Pure JavaScript** - No frameworks, vanilla ES6 modules
- **Canvas API** - All charts rendered with 2D canvas
- **LocalStorage** - Position persistence
- **CORS Proxies** - Yahoo Finance data fetching

## License

MIT

---

*Built for wheel traders who want data-driven decisions.*
