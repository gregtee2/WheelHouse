# WheelHouse - AI Coding Instructions

## 🎯 Project Overview

**WheelHouse** is a Wheel Strategy Options Analyzer & Position Tracker built with vanilla JavaScript (ES6 modules) and Node.js. It provides Monte Carlo-based options pricing, real-time CBOE quotes, position tracking, and portfolio analytics.

**Version**: 1.11.0  
**Repository**: https://github.com/gregtee2/WheelHouse  
**Branches**: `main` (development), `stable` (releases)

---

## 🏗️ Architecture

### Tech Stack
- **Frontend**: Pure JavaScript ES6 modules, Canvas API for charts
- **Backend**: Node.js + Express (server.js)
- **Data Sources**: CBOE delayed quotes API, Yahoo Finance fallback
- **Storage**: Browser localStorage (no database)
- **Port**: 8888

### File Structure
```
WheelHouse/
├── server.js           # Node.js server - CBOE/Yahoo proxy, static file serving
├── index.html          # Main HTML shell with all tabs
├── install.bat/.sh     # One-click installers (Windows/Mac)
├── start.bat/.sh       # Launcher scripts
├── package.json        # Version 1.1.0
├── CHANGELOG.md        # Release notes
├── css/
│   └── styles.css      # Dark theme styling
└── js/
    ├── main.js         # Entry point, tab switching, initialization
    ├── state.js        # Global state object (singleton)
    ├── api.js          # CBOE & Yahoo Finance API calls
    ├── pricing.js      # Black-Scholes, Monte Carlo pricing
    ├── simulation.js   # Brownian motion path simulation
    ├── positions.js    # Position CRUD, localStorage, roll history
    ├── portfolio.js    # Portfolio P&L, closed positions, chain linking
    ├── challenges.js   # Trading challenges system
    ├── charts.js       # Canvas chart rendering (payoff, probability cone, etc.)
    ├── analysis.js     # Recommendations, EV calculations, roll calculator
    ├── broker-import.js# Schwab CSV import
    └── ui.js           # Sliders, date pickers, UI bindings
```

### Module Dependencies
```
main.js (entry point)
  ├── state.js (global state - imported by everything)
  ├── api.js → state.js, utils.js
  ├── simulation.js → state.js, charts.js
  ├── pricing.js → state.js
  ├── positions.js → state.js, api.js, portfolio.js
  ├── portfolio.js → state.js, positions.js
  ├── challenges.js → state.js, positions.js
  ├── charts.js → state.js, pricing.js
  ├── analysis.js → state.js, pricing.js
  └── ui.js → state.js, charts.js, pricing.js, simulation.js
```

---

## 📊 Key Data Structures

### Position Object
```javascript
{
    id: 1737012345678,           // Date.now() timestamp
    chainId: 1737012345678,      // Links rolled positions together
    ticker: 'PLTR',
    type: 'short_put',           // short_put | covered_call | buy_write | call_debit_spread | etc.
    strike: 75.00,               // For single-leg options
    buyStrike: 170.00,           // For spreads
    sellStrike: 210.00,          // For spreads
    spreadWidth: 40,             // |sellStrike - buyStrike|
    premium: 2.50,               // Per-share premium received/paid
    contracts: 3,
    expiry: '2026-02-21',
    dte: 36,                     // Days to expiration (calculated)
    openDate: '2026-01-15',
    closeDate: null,             // Set when closed
    status: 'open',              // open | closed
    broker: 'Schwab',
    delta: -0.25,                // Optional
    
    // For spreads
    maxProfit: 1200,             // Calculated at creation
    maxLoss: 800,
    breakeven: 182.43,
    
    // For Buy/Write
    stockPrice: 80.50,           // Purchase price
    costBasis: 78.00,            // stockPrice - premium
    
    // Live pricing (updated by CBOE)
    lastOptionPrice: 1.85,       // Current option price
    markedPrice: 1.85,           // User's marked price
    currentSpot: 78.50,          // Current stock price
    
    // Challenge linking
    challengeIds: [1737000000000], // Array of challenge IDs
    
    // Opening thesis (saved when staging from Discord Analyzer)
    openingThesis: {
        analyzedAt: '2026-01-21T14:30:00Z',
        priceAtAnalysis: 105.92,
        rangePosition: 0,          // 0-100, where stock is in 3-month range
        iv: 66.4,                  // IV at time of analysis
        modelUsed: 'qwen2.5:32b',  // AI model used
        aiSummary: {
            aggressive: '...',     // Bull case (300 chars)
            moderate: '...',       // Balanced view
            conservative: '...',   // Bear case
            bottomLine: '...',     // One-sentence summary
            probability: 75,       // Max profit probability %
            fullAnalysis: '...'    // Complete AI response
        }
    },
    
    // Analysis history (multiple AI analyses over time)
    analysisHistory: [
        {
            id: 1737500000000,
            timestamp: '2026-01-21T14:30:00Z',
            model: 'qwen2.5:32b',
            recommendation: 'HOLD',  // HOLD | ROLL | CLOSE
            insight: '...',          // Full AI response
            snapshot: {              // Market conditions at time
                spot: 105.92,
                strike: 95,
                dte: 30,
                iv: 66.4,
                riskPercent: 15.2,
                winProbability: 85
            }
        }
    ],
    
    // For SKIP Call™ Strategy (type: 'skip_call')
    leapsStrike: 100,            // LEAPS call strike (12+ months out)
    leapsPremium: 15.00,         // Premium paid for LEAPS
    leapsExpiry: '2027-01-15',   // LEAPS expiration date
    skipStrike: 120,             // SKIP call strike (3-9 months out)
    skipPremium: 5.00,           // Premium paid for SKIP
    skipExpiry: '2026-06-19',    // SKIP call expiration
    totalInvestment: 2000,       // (leapsPremium + skipPremium) * 100 * contracts
    leapsDte: 365,               // Days to LEAPS expiration
    skipDte: 150                 // Days to SKIP expiration (exit at 45-60 DTE)
}
```

### Closed Position Object
```javascript
{
    ...position,                  // All position fields
    status: 'closed',
    closeDate: '2026-01-20',
    closePrice: 0.50,             // Price paid to close
    closeReason: 'expired',       // expired | rolled | closed | assigned
    realizedPnL: 600,             // (premium - closePrice) * 100 * contracts
    closePnL: 600,                // Alternative field from broker imports
    daysHeld: 5
}
```

### Challenge Object
```javascript
{
    id: 1737012345678,
    name: 'January $3K Challenge',
    goal: 3000,
    goalType: 'net_pnl',          // net_pnl | premium | trades
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active'              // active | completed | archived
}
```

### State Object (state.js)
```javascript
window.state = {
    // Simulator parameters
    p: 0.5, q: 0.5, sigma: 0.3,
    spot: 100, strike: 95, dte: 30, optVol: 0.3,
    numPaths: 10000,
    
    // Position data
    positions: [],                // Open positions
    closedPositions: [],          // Closed positions
    holdings: [],                 // Stock holdings from assignments
    challenges: [],               // Trading challenges
    
    // UI state
    editingPositionId: null,
    closedYearFilter: '2026',
    
    // Simulation results
    optionResults: null,
    currentPositionContext: null
};
```

---

## 🔌 API Endpoints (server.js)

### CBOE Options Pricing
```javascript
GET /api/cboe/quote/:symbol
// Returns: { calls: [...], puts: [...] } with bid/ask/last/volume

GET /api/cboe/options/:symbol
// Returns delayed options chain data
```

### Yahoo Finance (Fallback)
```javascript
GET /api/yahoo/quote/:symbol
// Returns stock quote with price, change, volume
```

### AI Endpoints (Ollama)
```javascript
GET /api/ai/status
// Returns: { available, hasQwen, models[], loaded[], isWarm }

POST /api/ai/warmup  { model: 'qwen2.5:32b' }
// SSE stream: progress updates as model loads into GPU

POST /api/ai/analyze  { ticker, spot, strike, ... }
// Returns: { insight, model }

POST /api/ai/parse-trade  { tradeText, model }
// SSE stream: 4-step progress (parse, fetch, CBOE, analyze)
// Returns: { parsed, tickerData, premium, analysis }

POST /api/ai/deep-dive  { ticker, strike, expiry, currentPrice, model }
// Returns: { analysis, tickerData, premium }

POST /api/ai/checkup  { ticker, strike, expiry, openingThesis, model }
// Returns: { checkup, currentData, currentPremium }

POST /api/ai/critique  { ...closedPosition, model }
// Returns: { insight, model }

POST /api/ai/ideas  { buyingPower, model }
// Returns: { ideas, candidates }
```

### Static Files
All other requests serve static files from project root.

---

## 💾 localStorage Keys

| Key | Data |
|-----|------|
| `wheelhouse_positions` | Open positions array |
| `wheelhouse_closed` | Closed positions array |
| `wheelhouse_holdings` | Stock holdings array |
| `wheelhouse_challenges` | Challenges array |
| `wheelhouse_checkpoint` | Data integrity checkpoint |

---

## 🔗 Chain System (Roll Tracking)

When a position is rolled, the new position inherits the `chainId` from the original:

```javascript
// Original position
{ id: 100, chainId: 100, ticker: 'PLTR', strike: 75, ... }

// After rolling (old position closed, new one opened)
{ id: 100, chainId: 100, status: 'closed', closeReason: 'rolled', ... }
{ id: 101, chainId: 100, ticker: 'PLTR', strike: 72, ... }  // Same chainId!

// After rolling again
{ id: 102, chainId: 100, ticker: 'PLTR', strike: 70, ... }  // Still same chainId!
```

### Finding Chain History
```javascript
const allPositions = [...state.positions, ...state.closedPositions];
const chainHistory = allPositions.filter(p => p.chainId === targetChainId);
```

### Manual Chain Linking
Users can manually link positions via the 🔗 button in Closed Positions table:
- `window.showLinkToChainModal(positionId)` - Opens modal
- `window.linkPositionToChain(positionId, targetChainId)` - Links position
- `window.unlinkPositionFromChain(positionId)` - Makes standalone

---

## 📈 Spread Position Types

### Types Supported
- `call_debit_spread` - Bull Call Spread (buy lower strike call, sell higher)
- `put_debit_spread` - Bear Put Spread (buy higher strike put, sell lower)
- `call_credit_spread` - Bear Call Spread (sell lower strike call, buy higher)
- `put_credit_spread` - Bull Put Spread (sell higher strike put, buy lower)

### Detection
```javascript
const isSpread = pos.type?.includes('_spread');
```

### Spread-Specific Fields
- `buyStrike`, `sellStrike` - The two strikes
- `spreadWidth` - Absolute difference
- `maxProfit`, `maxLoss` - Pre-calculated at entry
- `breakeven` - Calculated based on spread type

### AI Explanation
`window.showSpreadExplanation(positionId)` - Opens modal with:
- Strategy name and direction (bullish/bearish)
- Setup details
- Max profit/loss scenarios
- Breakeven calculation
- Plain-English "How It Works" explanation

---

## � SKIP Call™ Strategy

### Overview
SKIP = "Safely Keep Increasing Profits" - A LEAPS overlay strategy where you:
1. Own a long-dated LEAPS call (12+ months)
2. Buy a shorter-dated "SKIP" call (3-9 months) at a higher strike
3. Exit the SKIP call at 45-60 DTE to capture gains
4. LEAPS continues riding the longer-term trend
5. Repeat with new SKIP calls to reduce LEAPS cost basis

### Position Type
```javascript
const isSkip = pos.type === 'skip_call';
```

### SKIP-Specific Fields
- `leapsStrike` - LEAPS call strike (12+ months out)
- `leapsPremium` - Premium paid for LEAPS
- `leapsExpiry` - LEAPS expiration date
- `skipStrike` - SKIP call strike (uses main strike field)
- `skipPremium` - SKIP call premium (uses main premium field)
- `skipExpiry` - SKIP call expiration (uses main expiry field)
- `totalInvestment` - Total cost: (leapsPremium + skipPremium) × 100 × contracts
- `leapsDte` - Days to LEAPS expiration
- `skipDte` - Days to SKIP expiration

### Exit Window Warnings
- `skipDte > 60` - Hold position, not yet in exit window
- `skipDte 45-60` - ⚠️ IN EXIT WINDOW - Time to sell SKIP call
- `skipDte < 45` - 🚨 PAST EXIT - Close immediately (theta decay accelerates)

### AI Explanation
`window.showSkipExplanation(positionId)` - Opens modal with:
- LEAPS vs SKIP details side by side
- Current DTE for both legs
- Exit window status
- Plain-English strategy explanation
- Total investment breakdown

---

## 📅 LEAPS Evaluation Criteria

LEAPS (Long-term Equity Anticipation Securities) require different evaluation than standard 30-45 DTE options.

### DTE Thresholds
| DTE | Classification | Evaluation Focus |
|-----|---------------|------------------|
| ≤ 45 | Standard | Theta decay, roll timing |
| 180-364 | Long-dated | IV changes (vega), thesis validation |
| ≥ 365 | LEAPS | Directional thesis, stock proxy |

### LEAPS vs Standard Options

| Factor | Standard (45 DTE) | LEAPS (365+ DTE) |
|--------|-------------------|------------------|
| **Daily Theta** | High, accelerating | Minimal |
| **IV Sensitivity** | Moderate | HIGH (vega matters most) |
| **Roll Timing** | Time-based (21 DTE rule) | Strike-based only |
| **Evaluation** | Premium decay % | Thesis still valid? |
| **Assignment Risk** | Moderate if ITM | Very low unless deep ITM |
| **When to Roll** | Near expiry or troubled | Only if strike needs adjusting |

### AI Prompt Adaptations
- **Checkups**: Focus on "Has thesis played out?" not "How much theta decayed?"
- **Trade Analysis**: Note LEAPS as "stock proxy with defined risk"
- **Roll Suggestions**: No time-based rolls for LEAPS - only strike adjustments if stock moved significantly
- **Covered Call LEAPS**: Focus on cost basis reduction over time

### Key LEAPS Questions
1. Is the original directional thesis still valid?
2. Has IV changed significantly since entry?
3. Is the strike still appropriate given stock movement?
4. For covered call LEAPS: How much have you reduced cost basis?

---

## 🏆 Challenge System

### Position Inclusion Rules (IMPORTANT!)
Only positions **OPENED** within the challenge date range count:
```javascript
// Position opened Jan 5 → counts for January challenge
// Position opened Dec 28, closed Jan 5 → does NOT count (pre-loaded)
```

This keeps challenges honest - can't "pre-load" positions before challenge starts.

### P&L Calculation
Uses stored `realizedPnL` or `closePnL` values (not recalculated):
```javascript
closed.forEach(pos => {
    realizedPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
});
```

### Challenge Progress
```javascript
const progress = calculateChallengeProgress(challengeId);
// Returns: { current, percent, daysLeft, realizedPnL, unrealizedPnL, ... }
```

---

## 🎨 UI Patterns

### Tab Structure (Main Navigation)

| Tab | ID | Icon | Purpose |
|-----|-----|------|---------|
| Ideas | `ideas` | 🎯 | Trade Ideas, Discord Analyzer, AI staging |
| Analyze | `analyze` | 🔬 | Pricing simulator (Pricing/Monte Carlo/Greeks sub-tabs), payoff charts |
| P&L | `pnl` | 💰 | Roll Calculator, AI Trade Advisor (💡 Get Insight button), Trade Metrics |
| Positions | `positions` | 📋 | Open positions table, quick actions |
| Portfolio | `portfolio` | 💼 | Closed trades, analytics, P&L history |
| Challenges | 🏆 | | Trading challenges & goals |
| Settings | `settings` | ⚙️ | API keys, broker sync, preferences |

### Key UI Locations

**Where to find AI features:**
- **💡 Get Insight** (trade analysis) → **P&L tab** → right panel → "🧠 AI Trade Advisor"
- **✨ Suggest** (roll suggestions) → **P&L tab** → middle section → "🔄 Roll Calculator"
- **🤖 Trade Ideas** (AI-generated) → **Ideas tab** → left panel
- **📝 Discord Analyzer** → **Ideas tab** → "📋 Pending Trades" section

**Where to find analysis tools:**
- **Payoff Charts** → **Analyze tab** → Pricing sub-tab
- **Monte Carlo Simulation** → **Analyze tab** → Monte Carlo sub-tab
- **Greeks Calculator** → **Analyze tab** → Greeks sub-tab
- **Trade Metrics** → **P&L tab** → right panel (ROC, Win Prob, etc.)

### Tab System Code Pattern
Tabs are shown/hidden via `data-tab` attributes:
```html
<button data-tab="positions">Positions</button>
<div id="positions" class="tab-content">...</div>
```

### Modals
Created dynamically and appended to `document.body`:
```javascript
const modal = document.createElement('div');
modal.id = 'myModal';
modal.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; 
    background:rgba(0,0,0,0.85); display:flex; align-items:center; 
    justify-content:center; z-index:10000;`;
modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
modal.innerHTML = `...`;
document.body.appendChild(modal);
```

### Notifications
```javascript
import { showNotification } from './utils.js';
showNotification('Position saved!', 'success');  // success | error | info
showNotification('Error occurred', 'error', 5000);  // Optional duration
```

### Color Scheme
- Background: `#0d0d1a`, `#1a1a2e`
- Accent: `#00d9ff` (cyan)
- Success: `#00ff88` (green)
- Warning: `#ffaa00` (orange)
- Danger: `#ff5252` (red)
- Spreads: `#8b5cf6` (purple)
- Muted: `#888`

---

## 🐛 Common Issues & Fixes

### P&L Not Matching
- Check if using `realizedPnL` vs `closePnL` - broker imports may use different field
- Use `pos.realizedPnL ?? pos.closePnL ?? 0` pattern

### Chain Not Showing
- Ensure `chainId` is set on both positions
- Check `hasRollHistory(pos)` returns true

### CBOE Prices Stale
- CBOE has 15-min delay
- Check `lastUpdated` timestamp
- Falls back to Yahoo if CBOE fails

### Spread Strike Display
- Spreads use `buyStrike`/`sellStrike`, not `strike`
- `strike` is null for spreads

---

## 🔄 Git Workflow

### Branches
- `main` - Development, all new features
- `stable` - Production releases

### Commit Prefixes
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `refactor:` - Code restructure
- `chore:` - Maintenance

### Release to Stable
```bash
git push origin main:stable
```

---

## 📋 Recent Features (January 2026)

### v1.11.0 (Current)
- **SKIP™ Strategy Support**: Full two-leg SKIP™ strategy now available
  - SKIP™ = "Safely Keep Increasing Profits" (trademarked strategy)
  - LEG 1: LEAPS call (12+ months out, ATM or slightly OTM)
  - LEG 2: SKIP call (3-9 months out, higher strike above spot)
  - Exit SKIP call at 45-60 DTE, continue riding LEAPS
  - AI scorecard now rates 6 strategies (including SKIP™)
  - Alternative Strategies tiles show real CBOE pricing for both legs
  - `stageSkipStrategy()` stages both legs to Ideas tab
- **Alternative Strategies Tiles**: Real-time CBOE data for all strategies
  - Long Call, Call Spread, Sell Put tiles show actual prices/strikes
  - SKIP™ tile shows LEAPS + SKIP call with combined cost
  - Click "Stage to Ideas" for any strategy
  - Uses 60-120 DTE for long calls, 90-270 DTE for SKIP calls, 365+ DTE for LEAPS

### v1.10.0
- **Alternative Strategies AI**: AI now thinks beyond rolling for covered calls
  - When covered call is ITM, AI considers: LET ASSIGN, SKIP™, LONG CALL, CALL SPREAD, SELL PUTS, ROLL
  - Shows assignment profit calculation (stock gain + all premiums collected)
  - Calculates upside you'd miss by getting called vs. current spot price
  - Chain-aware analysis: shows total premium collected across all rolls
  - For short puts ITM: suggests TAKE ASSIGNMENT, ROLL, CONVERT TO SPREAD, or CLOSE
- **Chain History Context**: AI now sees full roll history when analyzing positions
  - `getChainData(positionId)` - Returns chain history and net premium
  - Shows "This position has been rolled X times" with days in trade
  - Warns about capital efficiency after 3+ rolls
- **Assignment Scenario Calculator**: For covered calls, shows exactly what you'd make if called
  - Stock gain: (strike - cost basis) × shares
  - Premium gain: net premium across entire chain
  - Missed upside: (current spot - strike) if stock above strike

### v1.9.1
- **LEAPS-Aware AI**: AI prompts now correctly handle long-dated options (365+ days)
  - Recognizes LEAPS (1+ year) and long-dated (6+ months) options
  - Checkups focus on thesis validity and IV changes, not daily theta
  - Trade prompts explain LEAPS as "stock proxy with defined risk"
  - No time-based roll recommendations for LEAPS - only strike adjustments
- **Long Position Support**: Properly tracks debit positions (bought options)
  - Auto-detects long vs short from Schwab sync using `shortQuantity` vs `longQuantity`
  - Cr/Dr column shows unrealized P&L for long positions (+ green or - red)
  - Ann% shows return % instead of yield for long positions
  - Greeks display: Theta shown as cost (amber) not warning for long options
  - AI Checkup understands long options profit from DELTA, not theta
- **Margin Check for Calls/Rolls**: Fixed to recognize covered calls ($0 margin) and rolls (net ~$0)

### v1.9.0
- **Per-Position Greeks**: Delta (Δ) and Theta (Θ/day) columns in Positions table
- **AI Portfolio Audit**: Comprehensive AI analysis of entire portfolio with optimization suggestions
- **Portfolio-Aware AI**: Trade analysis and Ideas now consider your existing positions
- **Year Filter for Analytics**: Advanced Analytics filters by selected year (not all-time)
- **Stage Roll to Ideas**: Stage suggested rolls to pending trades with "ROLL" badge
- **Conservative Kelly**: Uses Account Value + 25% of margin (not full buying power)

### v1.8.0
- **Margin Impact Calculator**: Check if you can afford a trade before executing
- **Margin Check on Pending**: 💳 button to check margin requirement
- **Auto-Fill Barriers**: Barriers auto-set based on volatility
- **Portfolio Balances Banner**: Account Value, Buying Power, Margin Used from Schwab

### v1.7.0
- **AI Holding Suggestions**: Choose Grok (best) or Ollama (free) for holding analysis
- **Model Toggle**: Switch between AI models mid-analysis

### v1.6.0
- **Verdict Spectrum**: Discord Analyzer now gives 3 perspectives (Aggressive/Moderate/Conservative)
- **Model Selector for Discord**: Choose 7B/14B/32B, defaults to 32B
- **Model Warmup**: Pre-load models into GPU with progress indicator
- **Range Position**: Shows where stock is in 3-month range (0%=low, 100%=high)
- **Analysis History**: Track multiple AI analyses over time with market snapshots
- **Full Analysis Storage**: "View Full Entry Analysis" button in checkups
- **IV Tracking**: IV saved at entry for comparison during checkups
- **SSE Progress**: Real-time step-by-step progress during Discord analysis
- **Premium Validation**: Stock prices no longer confused with option premiums

### v1.5.0
- **Deep Dive Analysis**: Comprehensive scenario analysis with CBOE pricing
- **Discord Trade Analyzer**: Paste any trade callout for instant AI analysis
- **Stage → Confirm Flow**: Stage trades from AI, confirm when executed
- **Position Checkup**: Compare opening thesis to current conditions
- **Trade Critique**: AI reviews closed trades with feedback

### Key Functions Added
- `getChainData(positionId)` - Returns { chainHistory, totalPremiumCollected } for rolled positions
- `calculateGreeks(S, K, T, r, sigma, isPut, contracts)` - Black-Scholes Greeks
- `calculatePortfolioGreeks()` - Sum Greeks across all open positions
- `window.runPortfolioAudit()` - AI Portfolio Audit modal
- `getPortfolioContext()` - Get stored portfolio context
- `formatPortfolioContextForAI()` - Format context for AI prompts
- `window.stageRollSuggestion(data)` - Stage a roll to pending trades
- `updateAdvancedAnalytics()` - Calculate and display advanced analytics (year-filtered)
- `getSpreadExplanation(pos)` - Returns spread strategy details
- `hasRollHistory(pos)` - Checks if position has been rolled
- `window.showRollHistory(chainId)` - Roll history modal
- `window.showLinkToChainModal(positionId)` - Chain linking modal
- `calculateChallengeProgress(challengeId)` - Challenge P&L calculation

---

## ⚠️ Important Rules for AI Agents

1. **Never use `strike` for spreads** - Use `buyStrike`/`sellStrike`
2. **Always use `??` for P&L** - `pos.realizedPnL ?? pos.closePnL ?? 0`
3. **Chain linking is by `chainId`** - Not by position ID
4. **Challenges filter by OPEN date** - Not close date
5. **Test on port 8888** - `http://localhost:8888`
6. **localStorage is the database** - No server-side storage
7. **Push to `main` first** - Only push to `stable` for releases
8. **Discord Analyzer uses `discordModelSelect`** - Separate from main `aiModelSelect`
9. **Premium validation: >$50 is stock price** - Option premiums are typically $0.50-$15
10. **Range position: 0%=3-month low, 100%=high** - Provides entry context
11. **openingThesis stores entry data** - IV, model, range, aiSummary with spectrum
12. **analysisHistory tracks AI over time** - Array of { timestamp, recommendation, snapshot }

---

## 🧪 Testing

```bash
# Start server
cd c:\WheelHouse
node server.js

# Or use start script
start.bat     # Windows
./start.sh    # Mac/Linux
```

Browser opens to http://localhost:8888

---

*Built for wheel traders who want data-driven decisions.* 🎰
