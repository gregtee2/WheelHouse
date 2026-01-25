# WheelHouse - Feature Documentation

This document provides detailed "How It Works" explanations for all major WheelHouse features. It's designed to help users understand the system deeply and for developers maintaining the codebase.

---

## Table of Contents

1. [AI Strategy Advisor](#ai-strategy-advisor) ⭐ NEW
2. [Historical Pattern Memory](#historical-pattern-memory)
3. [Custom Date Range Filtering](#custom-date-range-filtering)
4. [AI Historical Audit](#ai-historical-audit)
5. [Vector RAG Wisdom System](#vector-rag-wisdom-system)
6. [Portfolio Audit System](#portfolio-audit-system)
7. [Chain/Roll Tracking System](#chainroll-tracking-system)
8. [SKIP Call™ Strategy](#skip-call-strategy)
9. [LEAPS Evaluation Criteria](#leaps-evaluation-criteria)
10. [Spread Position Types](#spread-position-types)
11. [Secure Credential Storage](#secure-credential-storage)

---

## AI Strategy Advisor

**Added**: v1.14.0 (January 2026)

### What It Does

Enter ANY ticker and the AI analyzes ALL possible option strategies, then recommends the BEST one for current market conditions. It explains:
- Exactly what to buy/sell (strikes, expiration)
- Why this strategy beats the others
- The risks and max loss
- Win probability and breakeven
- How it fits your portfolio

### How It Works

```
User enters "PLTR"
        ↓
┌─────────────────────────────────────────────────────────────────┐
│  1. FETCH MARKET DATA                                            │
│     Schwab API (real-time) → CBOE (15-min delay) → Yahoo backup  │
│     Gets: spot price, 3-month range, options chain               │
├─────────────────────────────────────────────────────────────────┤
│  2. CALCULATE IV RANK                                            │
│     Compare current IV to historical IV percentile               │
│     High IV (>60%) = sell premium | Low IV (<30%) = buy premium  │
├─────────────────────────────────────────────────────────────────┤
│  3. BUILD CONTEXT FOR AI                                         │
│     • Spot price and range position                              │
│     • Sample options chain (12 contracts with bids/asks)         │
│     • User's buying power and risk tolerance                     │
│     • Existing positions in this ticker                          │
├─────────────────────────────────────────────────────────────────┤
│  4. AI ANALYZES ALL 9 STRATEGIES                                 │
│     Short Put, Covered Call, Long Call                           │
│     Put Credit Spread, Call Debit Spread                         │
│     Call Credit Spread, Put Debit Spread                         │
│     Iron Condor, SKIP™                                           │
├─────────────────────────────────────────────────────────────────┤
│  5. AI RECOMMENDS BEST STRATEGY                                  │
│     Structured response with:                                    │
│     • THE TRADE: exact action, expiration, credit/debit          │
│     • WHY THIS: ties to market conditions, IV, user profile      │
│     • THE RISKS: what could go wrong, worst case                 │
│     • THE NUMBERS: max profit, max loss, breakeven, probability  │
│     • PORTFOLIO IMPACT: buying power used, delta exposure        │
│     • OTHER OPTIONS: why alternatives weren't chosen             │
│     • EDUCATIONAL NOTE: explains strategy for beginners          │
└─────────────────────────────────────────────────────────────────┘
        ↓
User clicks "Stage Trade" → adds to pending trades
```

### Strategies Evaluated

| Strategy | When AI Recommends It |
|----------|----------------------|
| **Short Put** | Bullish, high IV, want to acquire shares at discount |
| **Covered Call** | Own shares, neutral/slightly bullish, want income |
| **Long Call** | Very bullish, low IV, limited capital |
| **Put Credit Spread** | Bullish, want defined risk (vs naked put) |
| **Call Debit Spread** | Bullish, reduce cost vs long call |
| **Call Credit Spread** | Bearish, high IV, defined risk |
| **Put Debit Spread** | Bearish, low IV, defined risk |
| **Iron Condor** | Neutral, high IV, expect range-bound |
| **SKIP™** | Long-term bullish, want leveraged exposure |

### IV Rank Interpretation

```
┌──────────────────────────────────────────────────────────────┐
│  0%────────20%────────40%────────60%────────80%────────100%  │
│  ▼           ▼           ▼           ▼           ▼           │
│  LOW      Below Avg    Moderate   Elevated    HIGH           │
│  ═══════════════        ════════════════════════════════     │
│  BUY STRATEGIES         SELL STRATEGIES                      │
│  Long call/put          Short put                            │
│  Debit spreads          Covered call                         │
│  SKIP™                  Credit spreads                       │
│                         Iron condor                          │
└──────────────────────────────────────────────────────────────┘
```

### Data Hierarchy

The Strategy Advisor tries data sources in order of quality:

1. **Schwab API** (if token exists) - Real-time quotes
2. **CBOE** - 15-minute delayed, free, reliable
3. **Yahoo Finance** - Fallback for spot price only

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | `/api/ai/strategy-advisor` endpoint |
| `server.js` | `buildStrategyAdvisorPrompt()` function |
| `js/main.js` | `runStrategyAdvisor()` frontend logic |
| `js/main.js` | `stageStrategyAdvisorTrade()` staging logic |
| `index.html` | UI in Ideas tab |

### Example Output

```
## 🏆 RECOMMENDED STRATEGY: Put Credit Spread

### THE TRADE
• Action: Sell $95 Put / Buy $90 Put
• Expiration: Feb 21, 2026 (30 DTE)
• Credit: $1.25 per share ($125 per contract)
• Contracts: 2

### WHY THIS STRATEGY
• IV Rank at 72% - options are expensive, selling is advantageous
• Stock at 45% of 3-month range - not overbought
• Defined risk vs naked put - max loss is $375 not $9,000

### THE RISKS
• ⚠️ Stock could crash below $90 (max loss scenario)
• ⚠️ Earnings in 3 weeks - volatility could spike
• ⚠️ If assigned, you'd own 200 shares at $93.75 effective

### THE NUMBERS
• Max Profit: $250 (if expires above $95)
• Max Loss: $750 (if expires below $90)
• Breakeven: $93.75
• Win Probability: ~68% (based on delta)
• Risk/Reward: 3:1

### 📚 EDUCATIONAL NOTE
A put credit spread is like selling insurance but with a cap on your 
risk. You collect premium hoping the stock stays above your sold 
strike. Unlike a naked put where you could lose thousands, your max 
loss is limited to the width of the spread minus the credit received.
```

---

## Historical Pattern Memory

**Added**: v1.14.0 (January 2026)

### What It Does

When analyzing a new trade, the AI checks your past trading history and provides personalized insights:
- "Hey, you've done well with MSTX short puts - 80% win rate!" ✅
- "Warning! TSLA has burned you before - 35% win rate, -$3000 total" ⚠️

### How It Works

1. **You click "Analyze Trade"** (Discord Analyzer or 💡 Get Insight)
2. **Frontend sends your closed positions** (ticker, type, P&L only - lightweight)
3. **Server matches patterns**:
   - Same ticker + same strategy type (most specific)
   - Same ticker (any strategy)
   - Same strategy type (any ticker)
4. **Server calculates stats**: Win rate, total P&L, average P&L
5. **Server generates warnings/encouragements** based on thresholds
6. **AI prompt includes your patterns** and must address them
7. **AI gives personalized advice** based on YOUR trading history

### Thresholds Used

| Pattern | Warning Threshold | Encouragement Threshold |
|---------|-------------------|------------------------|
| Win Rate | < 40% | >= 75% |
| Total P&L | < -$500 | (not used) |
| Avg P&L | (not used) | > $100 |
| Min Trades (ticker+type) | 2 | 2 |
| Min Trades (ticker only) | 3 | 3 |
| Min Trades (type only) | 5 | 5 |

### What the AI Sees

```
═══ YOUR HISTORICAL PATTERNS ═══
• TSLA short put: 5 trades, 40% win, -$2100 total
⚠️ WARNINGS: LOW WIN RATE on TSLA short put, NET LOSING on this exact setup (-$2100)

**Use this history to inform your recommendation!**
```

### Key Files

| File | Purpose |
|------|---------|
| `js/portfolio.js` | `analyzeHistoricalPattern()`, `formatPatternForAI()` |
| `js/main.js` | Discord Analyzer sends `closedSummary` |
| `js/analysis.js` | Trade Insight sends `closedSummary` |
| `server.js` | Pattern analysis in `/api/ai/parse-trade` and `buildTradePrompt()` |

---

## Custom Date Range Filtering

**Added**: v1.14.0 (January 2026)

### What It Does

Filter your closed positions by any date range, not just by year. Perfect for:
- Analyzing a specific trading month
- Reviewing performance during a market event
- Tax year analysis with custom periods

### How to Use

1. **Go to Portfolio tab** → Closed Positions section
2. **Use the Year dropdown** → Select a year OR select "📅 Custom Range"
3. **If custom**: Pick From and To dates, click "Apply"
4. **The table updates** to show only trades in that range
5. **Click 📥 Export CSV** to download filtered trades

### Key Functions

| Function | Purpose |
|----------|---------|
| `window.applyCustomDateRange()` | Applies the From/To date filter |
| `window.clearCustomDateRange()` | Resets to "All" filter |
| `renderClosedPositions()` | Re-renders table with current filter |

### State Variables

- `state.closedYearFilter` - Current filter: 'all', '2025', '2026', or 'custom'
- `state.closedDateFrom` - Custom range start date (YYYY-MM-DD)
- `state.closedDateTo` - Custom range end date (YYYY-MM-DD)

---

## AI Historical Audit

**Added**: v1.14.0 (January 2026)

### What It Does

Runs an AI analysis on your filtered closed trades to find patterns, lessons, and areas for improvement.

### How to Use

1. **Filter your closed positions** (by year or custom date range)
2. **Click 🤖 AI Historical Audit** button
3. **AI analyzes the filtered trades** and provides:
   - Period Grade (A/B/C/D/F)
   - What Worked Well (best tickers, strategies)
   - Areas for Improvement (worst performers)
   - Pattern Analysis (concentration, preferences)
   - Recommendations (actionable next steps)
   - Key Lessons (top 3 takeaways)

### AI Output Format

```
## 📊 PERIOD GRADE: B

## 1. 🎯 WHAT WORKED WELL
• MSTX: 17 trades, $5284 profit - consistent performer
• Short put strategy: 71 trades, 75% win rate

## 2. ⚠️ AREAS FOR IMPROVEMENT
• TSLA: Multiple large losses suggest high volatility risk
• Long call: 6 trades with $1322 total loss

## 3. 📈 PATTERN ANALYSIS
• Heavy concentration in MSTX (17% of trades)
• Strong preference for short put strategies (71%)

## 4. 💡 RECOMMENDATIONS
• Continue MSTX short puts - proven winner
• Reduce TSLA exposure or use tighter stops

## 5. 🏆 KEY LESSONS
• Lesson 1: Short puts on range-bound stocks work best
• Lesson 2: Avoid chasing volatile earnings plays
• Lesson 3: Position sizing matters more than win rate
```

### Key Files

| File | Purpose |
|------|---------|
| `js/portfolio.js` | `window.runHistoricalAudit()` - frontend logic |
| `server.js` | `/api/ai/historical-audit` endpoint |

---

## Vector RAG Wisdom System

**Added**: v1.13.0 (January 2026)

### What It Does

Your personal trading rules are stored in `wisdom.json`. When the AI analyzes a trade, it uses **semantic search** to find the most relevant rules and injects them into the prompt.

### How It Works

1. **Wisdom entries** are stored in `wisdom.json` with categories
2. **Embeddings are generated** using `nomic-embed-text` model (Ollama)
3. **When analyzing a trade**, the system builds a search query from position context
4. **Semantic search** finds the most relevant wisdom entries
5. **AI prompt includes** matching rules with relevance scores
6. **AI must CITE** which rules it followed or explain why it deviated

### Relevance Indicators

| Icon | Score | Meaning |
|------|-------|---------|
| 🎯 | >70% | High relevance |
| 📌 | >50% | Medium relevance |
| 📚 | <50% | Lower relevance |

### Pure Mode Toggle

The "📚 Apply Wisdom" checkbox lets you compare:
- **With wisdom** (default): AI follows your personal rules
- **Pure mode** (unchecked): Raw AI analysis without rules

### Key Files

| File | Purpose |
|------|---------|
| `wisdom.json` | Your trading rules with embeddings |
| `server.js` | `searchWisdom()`, `/api/wisdom/*` endpoints |
| `js/analysis.js` | Wisdom toggle checkbox |

### Regenerating Embeddings

```bash
POST /api/wisdom/regenerate-embeddings
```

This recalculates all embeddings after adding/editing wisdom entries.

---

## Portfolio Audit System

**Added**: v1.13.0 (January 2026)

### What It Does

Analyzes your entire open portfolio for problems, concentration risks, Greeks balance, and optimization opportunities.

### How to Access

- Click "🤖 Run AI Portfolio Audit" button in the Portfolio tab
- Or in the Advanced Analytics section

### AI Output Format

```
## 📊 PORTFOLIO GRADE: B

Grade explanation in one sentence.

## 1. 🚨 PROBLEM POSITIONS
• [Position needing attention with reason]

## 2. ⚠️ CONCENTRATION RISKS
• AAPL: 4 positions (40% of portfolio)

## 3. 📊 GREEKS ASSESSMENT
Net delta: +150 (moderately bullish)
Daily theta: $45/day
Vega exposure: $500 per 1% IV change

## 4. 💡 OPTIMIZATION IDEAS
• Consider rolling AAPL Feb 150P up to reduce delta

## 5. ✅ WHAT'S WORKING
• MSFT covered call at 60% profit - close soon
```

### Model Selection

You can choose which AI model to use:
- Qwen 7B/14B/32B (local, free)
- DeepSeek-R1 32B (local, free)
- Grok-3/Grok-4 (cloud, paid)

Use the dropdown in the audit modal and "🔄 Re-run" button to compare.

---

## Chain/Roll Tracking System

### What It Does

When you roll a position (close one, open new at different strike/expiry), the system links them together to track:
- Total premium collected across all rolls
- Days in trade from original open
- Roll count and history

### How It Works

1. **Original position** has `id` and `chainId` set to same value
2. **When rolled**: Old position closed with `closeReason: 'rolled'`
3. **New position** inherits the same `chainId`
4. **System can find entire chain** by filtering on `chainId`

### Example

```javascript
// Original position
{ id: 100, chainId: 100, ticker: 'PLTR', strike: 75, status: 'open' }

// After rolling (old closed, new opened)
{ id: 100, chainId: 100, status: 'closed', closeReason: 'rolled' }
{ id: 101, chainId: 100, ticker: 'PLTR', strike: 72, status: 'open' }

// Both share chainId: 100, so they're linked
```

### Manual Chain Linking

Users can manually link unrelated positions via the 🔗 button:
- `window.showLinkToChainModal(positionId)`
- `window.linkPositionToChain(positionId, targetChainId)`
- `window.unlinkPositionFromChain(positionId)`

---

## SKIP Call™ Strategy

### What It Is

SKIP = "Safely Keep Increasing Profits" - A LEAPS overlay strategy:

1. **Own a LEAPS call** (12+ months out, ATM or slightly OTM)
2. **Buy a shorter-dated "SKIP" call** (3-9 months out, higher strike)
3. **Exit the SKIP call at 45-60 DTE** to capture gains
4. **LEAPS continues** riding the longer-term trend
5. **Repeat** with new SKIP calls to reduce LEAPS cost basis

### Position Type

```javascript
const isSkip = pos.type === 'skip_call';
```

### SKIP-Specific Fields

| Field | Purpose |
|-------|---------|
| `leapsStrike` | LEAPS call strike |
| `leapsPremium` | Premium paid for LEAPS |
| `leapsExpiry` | LEAPS expiration date |
| `skipStrike` | SKIP call strike |
| `skipPremium` | SKIP call premium |
| `skipExpiry` | SKIP call expiration |
| `totalInvestment` | (leapsPremium + skipPremium) × 100 × contracts |

### Exit Window Warnings

| DTE | Status |
|-----|--------|
| >60 | Hold - not yet in exit window |
| 45-60 | ⚠️ IN EXIT WINDOW - Time to sell |
| <45 | 🚨 PAST EXIT - Close immediately |

---

## LEAPS Evaluation Criteria

### Key Difference from Standard Options

| Factor | Standard (45 DTE) | LEAPS (365+ DTE) |
|--------|-------------------|------------------|
| Daily Theta | High, accelerating | Minimal |
| IV Sensitivity | Moderate | HIGH (vega matters) |
| Roll Timing | Time-based (21 DTE rule) | Strike-based only |
| Evaluation | Premium decay % | Thesis still valid? |

### AI Prompt Adaptations

- **Checkups**: Focus on "Has thesis played out?" not theta decay
- **Trade Analysis**: Note LEAPS as "stock proxy with defined risk"
- **Roll Suggestions**: No time-based rolls - only strike adjustments

---

## Spread Position Types

### Supported Spreads

| Type | Direction | Structure |
|------|-----------|-----------|
| `call_debit_spread` | Bullish | Buy lower, sell higher call |
| `put_debit_spread` | Bearish | Buy higher, sell lower put |
| `call_credit_spread` | Bearish | Sell lower, buy higher call |
| `put_credit_spread` | Bullish | Sell higher, buy lower put |

### Spread-Specific Fields

| Field | Purpose |
|-------|---------|
| `buyStrike` | Strike of bought leg |
| `sellStrike` | Strike of sold leg |
| `spreadWidth` | \|sellStrike - buyStrike\| |
| `maxProfit` | Pre-calculated at entry |
| `maxLoss` | Pre-calculated at entry |
| `breakeven` | Calculated based on spread type |

---

## Secure Credential Storage

**Added**: v1.12.0 (January 2026)

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Windows Credential Manager                         │
│  (via Electron safeStorage API)                     │
│  ├── Stores: WHEELHOUSE_ENCRYPTION_KEY              │
└─────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│  AES-256-GCM Encryption                             │
│  ├── 256-bit key                                    │
│  ├── Random 16-byte IV per encryption               │
│  ├── 16-byte auth tag                               │
└─────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│  .secure-store file                                 │
│  ├── SCHWAB_APP_KEY (encrypted)                     │
│  ├── SCHWAB_APP_SECRET (encrypted)                  │
│  ├── SCHWAB_REFRESH_TOKEN (encrypted)               │
│  ├── SCHWAB_ACCESS_TOKEN (encrypted)                │
│  ├── OPENAI_API_KEY (encrypted)                     │
│  ├── GROK_API_KEY (encrypted)                       │
│  └── TELEGRAM_BOT_TOKEN (encrypted)                 │
└─────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `electron/main.js` | Electron main process, IPC handlers |
| `electron/preload.js` | Context bridge for renderer |
| `src/secureStore.js` | AES-256-GCM encryption/decryption |

### Password System

- **Requirements**: 6-12 characters, alphanumeric + `!@#$%^&*?`
- **Storage**: SHA-256 hash in `localStorage['wheelhouse_password']`
- **Reset**: Delete `wheelhouse_password` from localStorage

---

## Data Structures Reference

### Position Object

```javascript
{
    id: 1737012345678,           // Date.now() timestamp
    chainId: 1737012345678,      // Links rolled positions
    ticker: 'PLTR',
    type: 'short_put',           // short_put | covered_call | etc.
    strike: 75.00,
    buyStrike: 170.00,           // For spreads
    sellStrike: 210.00,          // For spreads
    premium: 2.50,               // Per-share
    contracts: 3,
    expiry: '2026-02-21',
    dte: 36,
    openDate: '2026-01-15',
    status: 'open',              // open | closed
    broker: 'Schwab',
    
    // Opening thesis (from Discord Analyzer)
    openingThesis: {
        analyzedAt: '2026-01-21T14:30:00Z',
        priceAtAnalysis: 105.92,
        rangePosition: 0,
        iv: 66.4,
        modelUsed: 'qwen2.5:32b',
        aiSummary: { aggressive, moderate, conservative, bottomLine, probability }
    },
    
    // Analysis history
    analysisHistory: [
        { id, timestamp, model, recommendation, insight, snapshot }
    ]
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
    status: 'active'              // active | completed | archived
}
```

---

*Document last updated: January 2026 (v1.14.0)*
