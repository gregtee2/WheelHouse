# WheelHouse - AI Coding Instructions

## 🎯 Project Overview

**WheelHouse** is a Wheel Strategy Options Analyzer & Position Tracker built with vanilla JavaScript (ES6 modules) and Node.js. It provides Monte Carlo-based options pricing, real-time CBOE quotes, position tracking, and portfolio analytics.

**Version**: 1.20.0  
**Repository**: https://github.com/gregtee2/WheelHouse  
**Branches**: `main` (development), `stable` (releases)

---

## 🏗️ Architecture

### Tech Stack
- **Frontend**: Pure JavaScript ES6 modules, Canvas API for charts
- **Backend**: Node.js + Express (server.js)
- **Desktop**: Electron v33 for native Windows app
- **Security**: Windows Credential Manager + AES-256-GCM encryption
- **Data Sources**: CBOE delayed quotes API, Yahoo Finance fallback
- **Storage**: Browser localStorage (positions), encrypted .secure-store (secrets)
- **Port**: 8888

### File Structure
```
WheelHouse/
├── electron/
│   ├── main.js         # Electron main process, IPC handlers, secure storage
│   └── preload.js      # Context bridge for renderer security
├── server.js           # Node.js server - CBOE/Yahoo proxy, static file serving
├── login.html          # Password login screen (6-12 char, alphanumeric + symbols)
├── index.html          # Main HTML shell with all tabs
├── install.bat/.sh     # One-click installers (Windows/Mac)
├── WheelHouse.bat      # Main Electron launcher (clears ports)
├── WheelHouse-Dev.bat  # Dev mode with DevTools
├── WheelHouse-WebOnly.bat # Legacy server-only mode
├── package.json        # Electron + build config
├── CHANGELOG.md        # Release notes
├── src/
│   ├── secureStore.js  # AES-256-GCM encrypted credential storage
│   ├── routes/         # API route handlers
│   │   ├── settingsRoutes.js  # Settings API
│   │   ├── schwabRoutes.js    # Schwab broker API
│   │   ├── autonomousRoutes.js # Autonomous trader REST API
│   │   └── wisdomRoutes.js    # Trading wisdom RAG API
│   ├── utils/          # Utility modules
│   │   ├── dateHelpers.js     # Date formatting utilities
│   │   └── serverHelpers.js   # Version, GPU detection, MIME types
│   └── services/       # Business logic services
│       ├── CacheService.js    # Centralized caching
│       ├── DiscoveryService.js # Stock discovery/screening
│       ├── AIService.js       # AI model calling (Ollama, Grok)
│       ├── WisdomService.js   # Trading wisdom + embeddings
│       ├── promptBuilders.js  # AI prompt templates (~1100 lines)
│       ├── DataService.js     # Market data fetching
│       ├── MarketDataService.js # Schwab→CBOE→Yahoo fallback
│       ├── AutonomousTraderService.js # 🤖 Autonomous AI trading engine
│       └── TraderDatabase.js  # SQLite database for auto trades
├── css/
│   └── styles.css      # Dark theme styling
└── js/
    ├── main.js         # Entry point, tab switching, initialization (3,576 lines after v1.19.92 refactor)
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
    ├── settings.js     # Settings tab logic, security status check
    ├── ui.js           # Sliders, date pickers, UI bindings
    ├── schwab.js       # Schwab sync, account switching
    ├── theme.js        # Theme management
    │
    │   # ── Extracted Modules (v1.19.92 refactor from main.js) ──
    ├── aiFunctions.js      # Deep Dive, Discord analysis, trade parsing, AI insights (2,090 lines)
    ├── aiHelpers.js        # Model warmup, SSE streaming, prompt builders (210 lines)
    ├── coach.js            # Trading Coach UI, pattern display, danger zones (294 lines)
    ├── monteCarlo.js       # Monte Carlo simulation, probability cone charts (458 lines)
    ├── pmccCalculator.js   # PMCC/LEAPS calculator with strategy analysis (774 lines)
    ├── positionCheckup.js  # Position checkup, analysis history, thesis comparison (802 lines)
    ├── strategyAdvisor.js  # Multi-strategy analysis, alternative tile rendering (974 lines)
    ├── tradeStaging.js     # Pending trades management, staging flow (2,365 lines)
    ├── wheelScanner.js     # Oversold scanner, ticker screening (176 lines)
    ├── autonomousTrader.js # 🤖 Auto trader dashboard UI + position sync (908 lines)
    │
    ├── utils/
    │   └── formatters.js   # Shared formatting: $, %, DTE, dates, delta (109 lines)
    └── services/
        ├── AccountService.js       # Schwab account balances (single source of truth)
        ├── AlertService.js         # Price alert system
        ├── PositionsService.js     # Centralized position CRUD
        ├── SparkChartService.js    # Inline SVG sparkline charts (179 lines)
        ├── StreamingService.js     # Schwab real-time streaming client
        ├── TradeCardService.js     # Shared trade card UI + staging
        └── WeeklySummaryService.js # Week Summary AI pipeline (1,361 lines)
```

---

## 🏛️ Backend Architecture (COMPLETED January 2026)

**Status**: ✅ COMPLETE - server.js reduced from 5,247 → 217 lines (96% reduction!)

### Architecture Overview
```
server.js (217 lines) - Express app setup, middleware, router mounts
    │
    ├── src/routes/           # API endpoint handlers (Express routers)
    │   ├── aiRoutes.js       # All /api/ai/* endpoints (1158 lines)
    │   ├── cboeRoutes.js     # CBOE/IV/Yahoo proxy endpoints (168 lines)
    │   ├── updateRoutes.js   # Version check/apply/restart (182 lines)
    │   ├── wisdomRoutes.js   # Trading wisdom CRUD (154 lines)
    │   ├── settingsRoutes.js # Settings API (394 lines)
    │   └── schwabRoutes.js   # Schwab broker API (551 lines)
    │
    ├── src/services/         # Business logic (reusable across routes)
    │   ├── AIService.js      # callAI, callGrok, callOllama (409 lines)
    │   ├── CacheService.js   # Ticker/option caching (163 lines)
    │   ├── DataService.js    # Market data fetching (573 lines)
    │   ├── DiscoveryService.js # Stock screening (314 lines)
    │   ├── WisdomService.js  # RAG embeddings (192 lines)
    │   ├── MarketDataService.js # Schwab→CBOE→Yahoo fallback (519 lines)
    │   └── promptBuilders.js # AI prompt templates (1949 lines)
    │
    └── src/utils/            # Pure utility functions
        ├── dateHelpers.js    # Date formatting (146 lines)
        └── serverHelpers.js  # Version, GPU, MIME (139 lines)
```

---

## 🚨 CRITICAL: How to Add New Backend Features

**⚠️ NEVER add new endpoints or business logic directly to server.js!**

### The Pattern

| What You're Adding | Where It Goes | Example |
|-------------------|---------------|---------|
| New API endpoint | `src/routes/xxxRoutes.js` | POST /api/new-feature |
| AI/LLM calls | `src/services/AIService.js` | New AI function |
| Data fetching | `src/services/DataService.js` | New data source |
| AI prompts | `src/services/promptBuilders.js` | New prompt builder |
| Date/time utils | `src/utils/dateHelpers.js` | New date function |
| Caching logic | `src/services/CacheService.js` | New cache type |

### Adding a New API Endpoint

**Step 1: Create or use existing route file**
```javascript
// src/routes/myFeatureRoutes.js
const express = require('express');
const router = express.Router();

// Dependencies injected via init()
let AIService, DataService, promptBuilders;

function init(deps) {
    AIService = deps.AIService;
    DataService = deps.DataService;
    promptBuilders = deps.promptBuilders;
}

router.post('/analyze', async (req, res) => {
    try {
        const { ticker } = req.body;
        const data = await DataService.fetchTickerIVData(ticker);
        const prompt = promptBuilders.buildMyPrompt(data);
        const result = await AIService.callAI(prompt, req.body.model);
        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
```

**Step 2: Mount in server.js**
```javascript
// In server.js imports section
const myFeatureRoutes = require('./src/routes/myFeatureRoutes');

// After other route inits
myFeatureRoutes.init({ AIService, DataService, promptBuilders });

// Mount the router
app.use('/api/my-feature', myFeatureRoutes);
```

### Adding Business Logic (Services)

If your feature needs reusable logic (not just an endpoint), add it to an existing service or create a new one:

```javascript
// src/services/MyService.js
class MyService {
    static someCalculation(data) {
        // Pure business logic, no Express req/res
        return result;
    }
    
    static async fetchSomething(ticker) {
        // Async operations
        return data;
    }
}

module.exports = MyService;
```

Then import it in your route file and inject via `init()`.

### Adding AI Prompts

All AI prompts go in `src/services/promptBuilders.js`:

```javascript
// Add to promptBuilders.js
function buildMyNewPrompt(ticker, data, options = {}) {
    return `
You are analyzing ${ticker}...

DATA:
${JSON.stringify(data, null, 2)}

INSTRUCTIONS:
...
    `.trim();
}

// Add to module.exports at bottom
module.exports = {
    // ... existing exports
    buildMyNewPrompt
};
```

### ❌ What NOT to Do

```javascript
// ❌ WRONG - Adding directly to server.js
app.post('/api/my-new-feature', async (req, res) => {
    // 500 lines of logic here...
});

// ❌ WRONG - Duplicating fetch logic
const response = await fetch('https://api.schwab.com/...');

// ❌ WRONG - Inline AI prompts in route handlers
const prompt = `You are an AI that...` // Should be in promptBuilders.js
```

### ✅ What TO Do

```javascript
// ✅ CORRECT - Use existing services
const data = await DataService.fetchTickerIVData(ticker);
const quote = await MarketDataService.getQuote(ticker);

// ✅ CORRECT - Use promptBuilders
const prompt = promptBuilders.buildMyPrompt(data);

// ✅ CORRECT - Use AIService
const result = await AIService.callAI(prompt, model);

// ✅ CORRECT - Keep routes thin, logic in services
router.post('/analyze', async (req, res) => {
    const result = await MyService.analyze(req.body);
    res.json(result);
});
```

### Dependency Injection Pattern

Routes receive their dependencies via `init()` to avoid circular imports:

```javascript
// Route file
let AIService, CacheService;
function init(deps) {
    AIService = deps.AIService;
    CacheService = deps.CacheService;
}
module.exports.init = init;

// server.js
myRoutes.init({ AIService, CacheService, DataService, promptBuilders, secureStore });
```

---

## 🏗️ Frontend Modularization (v1.19.92 — February 2026)

**Status**: ✅ COMPLETE — `main.js` reduced from 11,600 → 3,576 lines (68% reduction!)

### Why This Was Done
`main.js` was a monolithic 11,600-line file containing ALL AI features, Monte Carlo simulation, trade staging, coaching, position checkups, and strategy analysis. It was impossible to navigate and caused merge conflicts constantly.

### Architecture After Refactor
```
main.js (3,576 lines) — Entry point, tab switching, initialization, event bindings
    │
    ├── js/aiFunctions.js (2,090 lines) — Deep Dive, Discord analysis, trade parsing, AI insights
    ├── js/aiHelpers.js (210 lines) — Model warmup, SSE streaming, prompt formatting
    ├── js/coach.js (294 lines) — Trading Coach UI, pattern display, sweet spots, danger zones
    ├── js/monteCarlo.js (458 lines) — Monte Carlo simulation, probability cone charts
    ├── js/pmccCalculator.js (774 lines) — PMCC/LEAPS calculator with strategy analysis
    ├── js/positionCheckup.js (802 lines) — Position checkup, analysis history, thesis comparison
    ├── js/strategyAdvisor.js (974 lines) — Multi-strategy analysis, alternative tile rendering
    ├── js/tradeStaging.js (2,365 lines) — Pending trades management, staging flow
    ├── js/wheelScanner.js (176 lines) — Oversold scanner, ticker screening
    │
    ├── js/utils/formatters.js (109 lines) — Shared formatting: $, %, DTE, dates, delta
    │
    └── js/services/
        ├── SparkChartService.js (179 lines) — Inline SVG sparkline charts
        ├── WeeklySummaryService.js (1,361 lines) — Week Summary AI pipeline
        └── (existing services: AccountService, AlertService, PositionsService, etc.)
```

### Module Import/Export Pattern
All extracted modules use clean ES6 `import`/`export`:

```javascript
// In aiFunctions.js — exports specific functions
export { analyzeDiscordTrade, runDeepDive, runTradeIdeas, ... };

// In main.js — imports what it needs
import { analyzeDiscordTrade, runDeepDive } from './aiFunctions.js';

// Some functions are exposed globally for onclick handlers
window.analyzeDiscordTrade = analyzeDiscordTrade;
```

### ⚠️ CRITICAL: Where to Add New Code

| What You're Adding | Where It Goes | NOT Here |
|-------------------|---------------|----------|
| New AI analysis feature | `aiFunctions.js` | ~~main.js~~ |
| AI prompt helpers, SSE | `aiHelpers.js` | ~~main.js~~ |
| Monte Carlo / simulation | `monteCarlo.js` | ~~main.js~~ |
| Position checkup/thesis | `positionCheckup.js` | ~~main.js~~ |
| Strategy scoring/tiles | `strategyAdvisor.js` | ~~main.js~~ |
| Trade staging/pending | `tradeStaging.js` | ~~main.js~~ |
| Coaching patterns | `coach.js` | ~~main.js~~ |
| PMCC/LEAPS calculator | `pmccCalculator.js` | ~~main.js~~ |
| Scanner/screening | `wheelScanner.js` | ~~main.js~~ |
| Dollar/percent formatting | `utils/formatters.js` | Inline in each file |
| Sparkline charts | `services/SparkChartService.js` | ~~charts.js~~ |
| Tab init, event bindings | `main.js` | Only if truly global |

### Shared Formatting (formatters.js)

All dollar amounts, percentages, and DTE formatting should use the shared formatters:

```javascript
import { formatDollars, formatPercent, formatDTE, formatDate, formatDelta } from './utils/formatters.js';

formatDollars(1234.5);    // "$1,234.50" (always 2 decimal places)
formatDollars(-500);       // "-$500.00"
formatPercent(0.156);      // "15.6%"
formatDTE(30);             // "30d"
formatDate('2026-02-21');  // "Feb 21"
formatDelta(-0.25);        // "-0.25Δ"
```

**⚠️ ALWAYS use `formatDollars()` for money** — never `Math.round()` or `.toFixed(0)` on dollar amounts. This was a bug that showed `$1,235` instead of `$1,234.50`.

---

## 📈 SparkChartService — Inline SVG Sparklines

**Location**: `js/services/SparkChartService.js`

### Why This Exists
Market Internals tiles (TICK, A/D, VOL Δ, TRIN, VIX) and Futures tiles (ES, NQ, YM, RTY) needed small inline trend charts. Canvas is overkill for 50×20px charts — SVG is lighter and auto-scales.

### How It Works
1. Data arrives every 30 seconds from Schwab streaming
2. `SparkChartService.addDataPoint(key, value)` stores in a ring buffer (60 data points = 2 hours at 2-min buckets)
3. `SparkChartService.renderSpark(key, width, height)` returns an SVG string
4. SVG injected into tile's `.spark-container` element

### Usage
```javascript
import SparkChartService from './services/SparkChartService.js';

// Add data point (called on each market data update)
SparkChartService.addDataPoint('TICK', 523);
SparkChartService.addDataPoint('ES', 5892.50);

// Render sparkline (returns SVG HTML string)
const svg = SparkChartService.renderSpark('TICK', 60, 20);
document.querySelector('#tick-spark').innerHTML = svg;
```

### Visual Style
- **Green area fill** for positive trend (value > start)
- **Red area fill** for negative trend
- **Gradient opacity** from bottom to line
- **No axes, labels, or gridlines** — just the shape

---

## 🏋️ Trading Coach (coach.js)

**Location**: `js/coach.js` (UI) — trading pattern analysis powered by closed position history

### What It Does
Analyzes your closed trade history to find **patterns** in your wins and losses:

| Pattern Type | Example |
|-------------|---------|
| **Win Rate by Ticker** | "PLTR: 85% win rate (11/13 trades)" |
| **Win Rate by Strategy** | "Short puts: 78% win rate, Covered calls: 62%" |
| **Sweet Spots** | "Your best setup: 30-45 DTE puts on PLTR at 25-30 delta" |
| **Danger Zones** | "⚠️ TSLA < 14 DTE: 30% win rate — avoid!" |
| **DTE Performance** | "14-30 DTE: 82% win rate vs 0-14 DTE: 55%" |

### AI Integration
Coach insights are automatically injected into AI prompts via `promptBuilders.js`:
```javascript
// In AI trade analysis prompts:
"TRADER'S PATTERN DATA:
- Win rate on PLTR puts: 85% (11/13)
- Danger: TSLA < 14 DTE has 30% win rate
- Sweet spot: 30-45 DTE, 25-30 delta, PLTR/MSTX"
```

This makes the AI aware of your personal trading history when giving advice.

### UI Access
- **Portfolio tab** → "🏋️ Trading Coach" button
- Shows patterns in a modal with categorized sections
- Automatically refreshes when closed positions change

---

## 💰 AccountService - SINGLE SOURCE OF TRUTH FOR BALANCES

**CRITICAL: All new features that need account balances MUST use AccountService!**

Location: `js/services/AccountService.js`

### Why This Exists
We kept having bugs where every feature either:
1. Made its own `/api/schwab/accounts` fetch (wasteful, slow)
2. Scraped DOM elements like `balBuyingPower` (fragile, breaks if element not visible)

### Available Functions

```javascript
import AccountService from './services/AccountService.js';

// Get cached balances (populated by Portfolio page on load)
const balances = AccountService.getBalances();
// Returns: { buyingPower, accountValue, cashAvailable, marginUsed, dayTradeBP, accountType, accountNumber, lastUpdated }

// Get just buying power (with fallback)
const bp = AccountService.getBuyingPower() || 25000;

// Get account value (equity/liquidation value)
const equity = AccountService.getAccountValue();

// Force refresh from Schwab (use sparingly!)
await AccountService.refresh();
```

### How It Works
1. **Portfolio page loads** → `fetchAccountBalances()` runs
2. **Portfolio calls `AccountService.updateCache()`** with balance data
3. **Other features call `AccountService.getBuyingPower()`** to get cached value
4. If cache is empty, they can call `await AccountService.refresh()` (but this is rare)

### ⚠️ NEVER Do This Again
```javascript
// ❌ WRONG - Fetching separately in every feature
const res = await fetch('/api/schwab/accounts');
const accounts = await res.json();
const marginAccount = accounts.find(a => a.securitiesAccount?.type === 'MARGIN');
const buyingPower = marginAccount?.securitiesAccount?.currentBalances?.buyingPower;

// ❌ WRONG - Scraping DOM elements
const buyingPower = parseFloat(document.getElementById('balBuyingPower').textContent);

// ✅ CORRECT - Use AccountService
const buyingPower = AccountService.getBuyingPower();
```

---

## � TradeCardService - SHARED TRADE CARD UI

**CRITICAL: All AI features that suggest trades MUST use TradeCardService!**

Location: `js/services/TradeCardService.js`

### Why This Exists
We had 4+ places with duplicated trade card HTML and staging logic:
- Position Checkup (main.js)
- AI Holding Suggestion (portfolio.js)
- Roll Calculator (analysis.js)
- Discord Analyzer (main.js)

Each had slightly different styling, field names, and staging code. Now consolidated.

### Available Functions

```javascript
import TradeCardService from './services/TradeCardService.js';

// Parse ===SUGGESTED_TRADE=== block from AI response
const trade = TradeCardService.parseSuggestedTrade(aiResponse);
// Returns: { action, closeStrike, closeExpiry, newStrike, newExpiry, netCost, rationale, ... }

// Strip trade block from AI response for display
const cleanText = TradeCardService.stripTradeBlock(aiResponse);

// Render trade card HTML
const cardHtml = TradeCardService.renderTradeCard(trade, {
    ticker: 'AAPL',
    onStageClick: 'window.stageThisTrade()',  // onclick handler
    showStageButton: true,
    stageButtonText: '📥 Stage Roll'
});

// Stage trade to pending (localStorage)
TradeCardService.stageToPending(trade, {
    ticker: 'AAPL',
    source: 'ai_checkup',     // ai_checkup, ai_holding, roll_calc, discord
    badge: 'ROLL',            // ROLL, NEW, SKIP
    originalPositionId: 123   // Optional
});

// Utility functions
const pending = TradeCardService.getPendingTrades();
TradeCardService.removePendingTrade(tradeId);
TradeCardService.clearPendingTrades();
```

### AI Prompt Format for Suggested Trades

When building AI prompts that should return actionable trades, include this instruction:

```
If recommending a ROLL or trade action, include a structured block:

===SUGGESTED_TRADE===
ACTION: ROLL (or BUY_BACK, CLOSE, etc.)
CLOSE_STRIKE: 95
CLOSE_EXPIRY: 2026-02-21
CLOSE_TYPE: PUT
NEW_STRIKE: 90
NEW_EXPIRY: 2026-03-21
NEW_TYPE: PUT
ESTIMATED_DEBIT: $1.20
ESTIMATED_CREDIT: $2.50
NET_COST: $1.30 credit
RATIONALE: Rolling down and out for credit while stock recovers
===END_TRADE===
```

### ⚠️ NEVER Do This Again
```javascript
// ❌ WRONG - Duplicating trade card HTML in each file
const html = `<div style="background:linear-gradient...">
    <h4>📋 Suggested Trade</h4>
    ... 50 lines of HTML ...
</div>`;

// ❌ WRONG - Duplicating staging logic
let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
pending.push({ ... });
localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));

// ✅ CORRECT - Use TradeCardService
const trade = TradeCardService.parseSuggestedTrade(aiResponse);
const html = TradeCardService.renderTradeCard(trade, { ticker });
TradeCardService.stageToPending(trade, { ticker, source: 'ai_checkup' });
```

---

## 📋 PositionsService - SINGLE SOURCE OF TRUTH FOR POSITIONS

**CRITICAL: All new features that access positions MUST use PositionsService!**

Location: `js/services/PositionsService.js`

### Why This Exists
Position access was scattered across 12+ files with inconsistent localStorage key usage:
- main.js (12+ occurrences)
- portfolio.js (4+ occurrences)  
- positions.js (multiple occurrences)
- settings.js (2+ occurrences)

Each file accessed `wheelhouse_positions` or `wheelhouse_closed` directly, leading to:
- Inconsistent key names (some used account-specific keys, some didn't)
- No normalization (realizedPnL vs closePnL confusion)
- Duplicated find/filter logic everywhere

### Available Functions

```javascript
import PositionsService from './services/PositionsService.js';

// === OPEN POSITIONS ===
const positions = PositionsService.getAll();         // Array of all open positions
const pos = PositionsService.find(positionId);       // Find by ID
const pltrPos = PositionsService.findByTicker('PLTR'); // Find by ticker
PositionsService.add(newPosition);                   // Add (auto-generates ID if missing)
PositionsService.update(id, { strike: 95 });         // Update fields
PositionsService.remove(id);                         // Delete position
PositionsService.setAll(positionsArray);             // Replace all (for imports)

// === CLOSED POSITIONS ===
const closed = PositionsService.getClosed();         // All closed positions
const closedPos = PositionsService.findClosed(id);   // Find closed by ID
PositionsService.addClosed(position);                // Add to closed
PositionsService.setAllClosed(closedArray);          // Replace all closed

// === CLOSE A POSITION (move open → closed) ===
PositionsService.close(id, {
    closePrice: 0.50,
    closeDate: '2026-01-21',
    closeReason: 'expired'  // expired | rolled | closed | assigned
});

// === CHAIN OPERATIONS (roll history) ===
const chain = PositionsService.getChain(chainId);    // All positions in chain
const hasHistory = PositionsService.hasRollHistory(id);
const premium = PositionsService.getChainPremium(chainId);  // Net premium

// === HOLDINGS (stock from assignments) ===
const holdings = PositionsService.getHoldings();
PositionsService.addHolding(holding);
PositionsService.removeHolding(id);

// === LOAD/SAVE ===
PositionsService.load();    // Load from localStorage (call on app startup)
PositionsService.saveAll(); // Force save all (usually auto-saved)
```

### ⚠️ NEVER Do This Again
```javascript
// ❌ WRONG - Direct localStorage access with inconsistent keys
const saved = localStorage.getItem('wheelhouse_positions');
state.positions = JSON.parse(saved) || [];

// ❌ WRONG - Finding positions manually everywhere
const pos = state.positions.find(p => p.id === Number(id));

// ❌ WRONG - Inconsistent P&L access
const pnl = pos.realizedPnL || pos.closePnL;  // Could be either!

// ✅ CORRECT - Use PositionsService (normalizes automatically)
const pos = PositionsService.find(id);  // Always returns normalized position
const positions = PositionsService.getAll();
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

## � MarketDataService - SINGLE SOURCE OF TRUTH

**CRITICAL: All new features that need stock/options data MUST use MarketDataService!**

Location: `src/services/MarketDataService.js`

### Why This Exists
We kept having bugs where every new AI feature (Strategy Advisor, Discord Analyzer, Trade Ideas, etc.) 
wrote its own fetch code for Schwab/CBOE/Yahoo, often getting it wrong. This centralized service:
1. Handles the fallback chain automatically (Schwab → CBOE → Yahoo)
2. Normalizes the response format regardless of source
3. Handles token refresh via `schwabApiCall()`
4. Returns `source` field so you know where data came from

### Available Functions

```javascript
const MarketDataService = require('./src/services/MarketDataService');

// Get stock quote
const quote = await MarketDataService.getQuote('AAPL');
// Returns: { ticker, price, change, changePercent, high52, low52, volume, rangePosition, source }

// Get options chain
const chain = await MarketDataService.getOptionsChain('AAPL', { strikeCount: 20 });
// Returns: { ticker, spotPrice, calls[], puts[], expirations[], ivRank, source }

// Get specific option premium
const premium = await MarketDataService.getOptionPremium('AAPL', 200, '2026-02-21', 'P');
// Returns: { bid, ask, mid, iv, delta, theta, source }

// Batch quotes
const quotes = await MarketDataService.getQuotes(['AAPL', 'NVDA', 'AMD']);
// Returns: { AAPL: {...}, NVDA: {...}, AMD: {...} }

// Find option by delta
const opt = await MarketDataService.findOptionByDelta('AAPL', 'P', 0.30, 30);
// Returns best matching ~30 delta put with ~30 DTE
```

### Data Source Priority
1. **Schwab** (real-time, requires auth) - Best quality, includes Greeks
2. **CBOE** (15-min delayed, no auth) - Good for options, free
3. **Yahoo** (real-time spot, no auth) - Fallback for quotes only

### ⚠️ NEVER Do This Again
```javascript
// ❌ WRONG - Writing custom fetch logic in every feature
const schwabToken = process.env.SCHWAB_ACCESS_TOKEN;
const res = await fetch(`https://api.schwabapi.com/...`, { headers: { 'Authorization': `Bearer ${schwabToken}` }});

// ❌ WRONG - Duplicating fallback logic
if (!schwabWorked) {
    const cboeRes = await fetch(`https://cdn.cboe.com/...`);
    // ... 50 lines of parsing code ...
}

// ✅ CORRECT - Use MarketDataService
const quote = await MarketDataService.getQuote(ticker);
const chain = await MarketDataService.getOptionsChain(ticker);
```

---

## �🔌 API Endpoints (server.js)

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

## 📋 Recent Features (January–February 2026)

### v1.20.0 (Current)
- **🤖 Autonomous AI Trader**: Full 5-phase autonomous paper trading system
  - **Phase 1**: Grok-4 scans X/Twitter for market sentiment and breaking news
  - **Phase 2**: DeepSeek-R1:70b analyzes 40+ candidates, selects up to 5 trades
  - **Phase 3**: Executes trades with live CBOE pricing validation
  - **Phase 4**: End-of-day review, closes expired positions
  - **Phase 5**: AI self-reflection, writes learned rules for future use
  - **Real-time Monitor**: 30-second checks during market hours (stop-loss + profit target)
  - **SQLite Database**: `data/autonomous-trader.db` stores trades, scans, rules, reflections
  - **Paper Trading Only**: $100K paper balance, completely isolated from real accounts
  - See "Autonomous AI Trader" section below for full architecture

- **🛡️ Capital Preservation System**: Multi-layer margin protection
  - `max_margin_pct` config (default 70%) — hard cap on total portfolio margin
  - Per-trade margin check — each new trade tested against remaining capacity
  - AI prompt awareness — DeepSeek sees current margin utilization, prefers smaller trades when high
  - Real-time margin warning — logs when approaching 90% of cap
  - Margin gauge card in Auto tab UI with color-coded bar

- **🏢 Sector Diversification**: Prevents correlated blowups
  - `SECTOR_MAP` maps ~60 tickers to 7 sectors (Tech, Finance, Energy, Consumer, Healthcare, ETF, High IV)
  - `max_per_sector` config (default 2) — hard enforcement in Phase 3
  - AI prompt requires picks from at least 3 different sectors
  - `sector` column in trades table, displayed in UI

- **📊 Credit Spread Preference**: AI defaults to defined-risk strategies
  - Prompt mandates at least 3 of 5 picks be credit spreads
  - Naked puts require justification ("explain WHY the premium is worth the extra risk")
  - Example trade in prompt shows spread format, not naked put

- **📈 P/L Day Fix**: Schwab streaming now sends NET_CHANGE for options
  - Python streamer (`streamer.py`) was missing `NET_CHANGE`, `NET_CHANGE_PERCENT`, `CLOSE_PRICE` for options
  - `StreamingService.js` now reads `quote.netChange` to set `pos.dayChange`
  - Same-day trade detection: P/L Day = P/L Open for trades opened today

### v1.19.92
- **🏗️ Frontend Modularization**: `main.js` reduced from 11,600 → 3,576 lines (68% reduction!)
  - Extracted 9 modules: `aiFunctions.js`, `aiHelpers.js`, `coach.js`, `monteCarlo.js`, `pmccCalculator.js`, `positionCheckup.js`, `strategyAdvisor.js`, `tradeStaging.js`, `wheelScanner.js`
  - Clean ES6 `import`/`export` with `window.*` exposure for onclick handlers
  - See "Frontend Modularization" section above for full architecture

- **📊 SparkChartService**: Inline SVG sparkline charts for Market Internals & Futures tiles
  - Ring buffer (60 data points, 2-hour window at 2-min buckets)
  - Green/red area fills based on trend direction
  - Used by TICK, A/D, VOL Δ, TRIN, VIX, ES, NQ, YM, RTY tiles

- **🏋️ Trading Coach**: AI-powered pattern analysis from closed trade history
  - Win rate by ticker, strategy, DTE range
  - Sweet spot detection (best setups) and danger zone warnings
  - Coach insights auto-injected into AI prompts via `promptBuilders.js`

- **💲 Shared Formatters**: `utils/formatters.js` centralizes `$`, `%`, DTE, date, delta formatting
  - `formatDollars()` always shows 2 decimal places (fixes `$1,235` → `$1,234.50` bug)
  - All extracted modules import from this shared source

- **📊 Week Summary Compact Redesign**: Replaced verbose AI output with compact card layout
  - DTE urgency badges, sparkline-style risk indicators
  - Collapsible detail sections, cleaner visual hierarchy

- **🔧 Schwab Dividend Fixes**: Proper handling of dividend transactions in broker import
  - Dividends tracked separately from option P&L
  - Account-specific storage keys prevent cross-account data bleed

- **🔄 Reconcile Modal Rewrite**: Improved position reconciliation UI
  - Side-by-side comparison of local vs broker positions
  - Batch resolve/skip actions

- **📈 CC Modal Strike Range Fix**: Covered call modal now shows correct strike range
  - Uses actual stock price for ITM/OTM boundary
  - No longer shows strikes far outside practical range

- **🔢 Decimal Place Fixes**: Dollar amounts throughout app now consistently use 2 decimal places
  - P&L, premium, account balances all use `formatDollars()`

- **🏷️ Button Typo & Label Fixes**: Various UI button label corrections across tabs

- **🔖 Cache-Busting Unification**: All `index.html` script/CSS tags use consistent `?v=1.19.92` parameter

### v1.19.0
- **📊 Week Summary Report**: Comprehensive weekly portfolio review
  - 4-step AI pipeline with SSE progress streaming:
    1. Identify At-Risk Positions (DTE-based urgency)
    2. Position Checkups (individual AI analysis)
    3. Portfolio Audit (leverage, concentration, bias)
    4. Synthesis (actionable report with recommendations)
  - DTE urgency badges: 🔴 URGENT (≤7 DTE), 🟠 ACTION (8-21 DTE), 🟡 WATCH (22+ DTE)
  - Collapsible sections for detailed AI outputs
  - "Week Summary" button in Portfolio tab header

- **🐦 X/Twitter Sentiment Integration (Grok Only)**
  - When Grok-3 is the AI model, Week Summary includes real-time X sentiment
  - AI searches X for sentiment on your specific tickers
  - Breaking news, Fed policy, sector rotation woven into recommendations
  - Provides "trader's edge" context beyond static data analysis
  - **Discoverable UI**: When non-Grok model selected, shows "Switch to Grok for live 𝕏 sentiment" link
  - Clicking switches to Grok instantly; badge changes to "✓ 𝕏 Live sentiment enabled"

- **🔧 Account-Specific Storage Keys**
  - Week Summary reads from correct account-specific localStorage key
  - Format: `wheelhouse_MARGIN_XXXX_closed_positions`
  - Matches `state.js` `getStorageKey()` logic
  - Prevents paper trading data bleeding into real account reports

- **🚫 AI Anti-Hallucination**
  - Explicit instructions: "THESE ARE THE ONLY TRADES CLOSED THIS WEEK"
  - Closed trades listed by exact ticker/strike/date
  - Warning when no trades: "Do NOT invent or hallucinate any closed trades"

### v1.18.0
- **🔴 Real-Time Schwab Streaming Infrastructure**
  - Socket.IO server for real-time price updates
  - OCC symbol conversion for option positions
  - Surgical DOM updates instead of full table re-renders
  - `StreamingService.js` for frontend streaming client
  - Flash animations for price changes (green up, red down)

- **📊 Capital at Risk in Portfolio Balances**
  - Added Capital at Risk display to Portfolio tab
  - Leverage gauge dynamic updates every 2 seconds
  - Redesigned leverage thresholds based on margin call risk

### v1.16.0
- **🌐 Global AI Model Selector**: One model setting for all features
  - New dropdown in header bar (next to Account switcher)
  - Local "Override" dropdowns let you customize per-feature if needed
  - `getSelectedAIModel(localSelectId)` helper function for consistent model selection
  - Pattern: check local override → fall back to global → final default

- **📊 Spread Position Support**: AI now understands spreads in Portfolio Audit
  - Sends `sellStrike`, `buyStrike`, `spreadWidth` for spreads
  - Calculated `maxProfit` and `maxLoss` values included
  - AI sees `$325/$320 (5w) MaxProfit: $X, MaxLoss: $Y` not `$null`
  - Proper `[SPREAD]` tag in position summary

- **🧠 Spread AI Advisor**: "What Should I Do?" button for spreads
  - New button in spread explanation modal
  - Fetches live spot price from CBOE
  - Calls AI for recommendation (HOLD, CLOSE, ROLL)

- **🔌 Simple AI Endpoint**: New `/api/ai/simple` endpoint
  - Takes raw `{prompt, model}` without prompt builder
  - Used by spread advisor and custom prompts

### v1.14.0
- **🎓 AI Strategy Advisor**: Comprehensive strategy analysis for any ticker
  - Recommends BEST strategy based on IV rank, range position, buying power
  - Data hierarchy: Schwab (real-time) → CBOE → Yahoo fallback

- **🧠 Trading Pattern Memory**: AI remembers your past wins and losses
  - Warns about losing patterns, encourages winning patterns

- **📅 Custom Date Range Filtering**: Filter closed positions by any date range

- **📊 AI Historical Audit**: AI analyzes your filtered closed trades

### v1.13.0
- **🧠 Vector RAG Wisdom System**: AI uses semantic search for trading rules
  - Wisdom entries converted to vector embeddings via `nomic-embed-text` model
  - `generateEmbedding(text)` - Calls Ollama embedding API
  - `searchWisdom(query, positionType, topK)` - Semantic search with relevance scores
  - AI MUST cite rules and explain any overrides
  - Relevance indicators: 🎯 (>70%), 📌 (>50%), 📚 (lower)
  - New endpoint: `POST /api/wisdom/regenerate-embeddings`

- **⚡ Pure Mode Toggle**: Get raw AI analysis without wisdom influence
  - New "📚 Apply Wisdom" checkbox in AI Trade Advisor panel
  - `skipWisdom: true` in request bypasses wisdom injection
  - Visual indicators: "✓ Rules active" (green) or "⚡ Pure mode" (yellow)
  - Preference saved to localStorage as `wheelhouse_wisdom_enabled`

- **AI Prompt Strengthening**: Changed from "consider" to "MANDATORY"
  - AI must explicitly CITE rule numbers
  - AI must EXPLAIN why if disagreeing with a rule
  - Modal shows matched wisdom entries with relevance scores

### v1.12.0
- **🖥️ Electron Desktop App**: Standalone Windows application
  - Embedded Node.js server, no browser needed
  - Password-protected login (6-12 chars)
  - Secure credential storage via Windows Credential Manager + AES-256-GCM

### v1.11.0
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
6. **localStorage is the database** - No server-side storage for positions
7. **Push to `main` first** - Only push to `stable` for releases
8. **Discord Analyzer uses `discordModelSelect`** - Separate from main `aiModelSelect`
9. **Premium validation: >$50 is stock price** - Option premiums are typically $0.50-$15
10. **Range position: 0%=3-month low, 100%=high** - Provides entry context
11. **openingThesis stores entry data** - IV, model, range, aiSummary with spectrum
12. **analysisHistory tracks AI over time** - Array of { timestamp, recommendation, snapshot }
13. **Secrets go in secureStore** - Never store API keys in .env when Electron is available
14. **Use `WheelHouse.bat`** - Not `start.bat` or `npm start` for normal use
15. **Never add AI features to `main.js`** - Use extracted modules (`aiFunctions.js`, `positionCheckup.js`, `strategyAdvisor.js`, etc.)
16. **Always use `formatDollars()` for money** - Never `Math.round()` or `.toFixed(0)` on dollar amounts (import from `utils/formatters.js`)
17. **Use SparkChartService for sparklines** - Not `charts.js` — SVG sparklines go through `js/services/SparkChartService.js`
18. **New backend endpoints go in `src/routes/`** - Never add logic directly to `server.js` (see Backend Architecture section)
19. **AI prompts go in `promptBuilders.js`** - Never inline prompts in route handlers
20. **Use AccountService for balances** - Never fetch `/api/schwab/accounts` directly or scrape DOM elements
21. **Use PositionsService for positions** - Never access `localStorage['wheelhouse_positions']` directly
22. **Use TradeCardService for trade cards** - Never duplicate trade card HTML or staging logic
23. **Auto trades use SQLite** - `data/autonomous-trader.db` via `TraderDatabase.js`, NOT localStorage
24. **Auto trades sync to paper account only** - `syncAutoTradesToPositions()` filters by `state.accountMode === 'paper'`
25. **Auto trade positions have `_autoTrade: true` marker** - Filter with `p._autoTrade` to identify them
26. **SECTOR_MAP is lazy-loaded** - `ensureSectorMap()` must be called before accessing it (DiscoveryService isn't available at module load)
27. **Margin cap enforcement** - `calculatePortfolioMargin()` checks total committed margin; Phase 3 skips trades that would exceed `max_margin_pct`
28. **Prefer credit spreads over naked puts** - AI prompt mandates at least 3 of 5 picks be credit spreads for capital preservation
29. **NEVER call `getOptionPremium()` directly for trade pricing** - Always use `getStrategyPrice(opts)` which handles both credit spreads (two-leg net credit) and single-leg options. Calling `getOptionPremium()` with just the sell strike was a real bug that stored $95.40 instead of ~$1.50 net credit. The helper lives in `AutonomousTraderService.js` and accepts both camelCase (`strikeSell`) and snake_case (`strike_sell`) field names.
30. **Credit spread net credit can NEVER exceed spread width** - If `entryPrice > spreadWidth`, it's a data error. Phase 3 has a sanity check that skips such trades.

---

## 🔐 Electron & Security Architecture

### Desktop App Mode (Default)

WheelHouse runs as an Electron desktop app with password protection and encrypted credential storage.

**Startup Flow:**
```
WheelHouse.bat
    └── electron .
        └── electron/main.js
            ├── Load/create encryption key from Windows Credential Manager
            ├── Spawn Node.js server (port 8888) with encryption key
            ├── Show login.html (password prompt)
            └── On success → load index.html
```

**Key Files:**
| File | Purpose |
|------|---------|
| `electron/main.js` | Main process, secure storage IPC, server lifecycle |
| `electron/preload.js` | Context bridge exposing `window.electronAPI` |
| `login.html` | Password setup/login screen |
| `src/secureStore.js` | AES-256-GCM encrypted credential storage |

### Secure Storage System

The secureStore uses Windows Credential Manager (via Electron's `safeStorage` API) to store an encryption key, which is then used to encrypt/decrypt a local `.secure-store` file.

**Encryption Details:**
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Size**: 256 bits (32 bytes)
- **IV**: Random 16 bytes per encryption
- **Auth Tag**: 16 bytes appended to ciphertext

**Secured Keys:**
```javascript
const SECURE_KEYS = [
    'SCHWAB_APP_KEY',
    'SCHWAB_APP_SECRET', 
    'SCHWAB_REFRESH_TOKEN',
    'SCHWAB_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'GROK_API_KEY',
    'TELEGRAM_BOT_TOKEN'
];
```

**Usage in Code:**
```javascript
// In server.js - Initialize on startup
const secureStore = require('./src/secureStore');
if (process.env.WHEELHOUSE_ENCRYPTION_KEY) {
    secureStore.initialize(process.env.WHEELHOUSE_ENCRYPTION_KEY);
}

// In routes - Get/set secrets
const value = secureStore.get('SCHWAB_APP_KEY');
secureStore.set('SCHWAB_APP_KEY', newValue);
```

### Password System

**Requirements:**
- 6-12 characters
- Alphanumeric plus `!@#$%^&*?`
- Stored in localStorage as SHA-256 hash

**Login Flow:**
1. User enters password
2. Hash with SHA-256
3. Compare to stored hash in `localStorage['wheelhouse_password']`
4. On match → redirect to `index.html`

**Password Reset:** Delete `wheelhouse_password` from localStorage

### IPC Handlers (electron/main.js)

```javascript
// Secure storage
ipcMain.handle('secure-storage:save', (event, key, value) => {...})
ipcMain.handle('secure-storage:get', (event, key) => {...})
ipcMain.handle('secure-storage:delete', (event, key) => {...})

// App info
ipcMain.handle('app:getVersion', () => app.getVersion())

// Server control
ipcMain.handle('server:restart', () => {...})
```

### Context Bridge (electron/preload.js)

Exposes to renderer:
```javascript
window.electronAPI = {
    secureStorage: { save, get, delete },
    app: { getVersion },
    server: { restart }
}
```

### Launcher Scripts

| Script | Purpose |
|--------|---------|
| `WheelHouse.bat` | Main launcher - kills existing node, starts Electron |
| `WheelHouse-Dev.bat` | Dev mode with DevTools open |
| `WheelHouse-WebOnly.bat` | Legacy mode - just Node.js server, no Electron |

### Building the Installer

```bash
# Build Windows NSIS installer
npm run dist

# Output: dist/WheelHouse Setup X.X.X.exe (~81MB)
```

**Build Config (package.json):**
```json
{
  "build": {
    "appId": "com.wheelhouse.app",
    "productName": "WheelHouse",
    "win": {
      "target": "nsis",
      "signAndEditExecutable": false
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

---

## 🧪 Testing

```bash
# Start Electron app (recommended)
WheelHouse.bat

# Or with DevTools
WheelHouse-Dev.bat

# Legacy web-only mode
WheelHouse-WebOnly.bat

# Or manually
cd c:\WheelHouse
node server.js

# Or use start script
start.bat     # Windows
./start.sh    # Mac/Linux
```

Browser opens to http://localhost:8888

---

*Built for wheel traders who want data-driven decisions.* 🎰
