# WheelHouse Changelog

All notable changes to WheelHouse will be documented in this file.

## [1.17.22] - 2026-01-30

### Added
- **Consistent Strike Dropdowns Across All Modals**: Every trade modal now shows strikes with delta + bid
  - Single-leg Confirm Modal: `$95 ($2.85 | Δ0.30)` format
  - Spread Confirm Modal: Same format with IV summary
  - Roll Calculator: Strike dropdown populated when clicking ✨ Suggest
  
- **IV Summary Display**: Implied Volatility now shown in all trade contexts
  - Color-coded: Blue (<30%), White (30-50%), Orange (>50%)
  - Tooltip explains what IV means
  - Shows in Single-leg confirm, Spread confirm, and Roll Calculator
  - Roll Calculator shows context like "(High - fat premiums!)"

- **Roll Calculator Strike Dropdown**: Converted from text input to dropdown
  - Automatically populated with real strikes from CBOE chain
  - Shows bid price and delta for each strike
  - Filtered to reasonable range (puts: roll down, calls: roll up)

## [1.17.21] - 2026-01-30

### Added
- **Confirm Modal Strike Dropdown**: Single-leg trades now have strike dropdown like spreads
  - Strikes populated from live chain data with bid prices shown
  - Changing strike auto-fetches new premium and recalculates margin
  - Loading status indicator while fetching strikes

- **Dynamic Margin Calculation**: Margin requirement now updates with contract count
  - `updateMarginDisplay()` recalculates: Max(25% × Spot - OTM, 10% × Strike) × contracts
  - Affordability check updates in real-time as you change contracts
  - Stores spot price in hidden field for margin recalculations

- **Enhanced fetchSingleOptionPrice()**: Now populates strike dropdown and stores context
  - Uses `populateSingleStrikeDropdown()` like spread modals do
  - Stores spot price for accurate margin calculations on strike/contract changes
  - Shows error states for strike dropdown when chain fetch fails

### Fixed
- **Contracts Change Bug**: Changing contracts no longer zeroes out premium
  - `updateNetCredit()` now checks if spread elements exist before running
  - Single-leg trades call `updateSingleLegDisplay()` instead

## [1.17.20] - 2026-01-29

### Fixed
- **AI Service Type Safety**: Fixed `model.includes is not a function` errors
  - Added type checking in `AIService.js` for `callGrok()` and `callOllama()` functions
  - Model parameter now validated before calling `.includes()` or `.toLowerCase()`
  
- **AI Function Signatures**: Fixed wrong parameter order in AI calls
  - `callGrok(prompt, model, maxTokens)` was being called with `{ maxTokens }` object instead of number
  - `callAI(prompt, model, maxTokens)` had same issue
  - Both endpoints now pass maxTokens as a number correctly

### Added
- **Roll Display in Pending Trades**: Rolls now show full context in Ideas tab
  - Strike column shows both legs: "Close $87C" (red) + "Open $105C" (green)
  - Expiry column shows both dates: old expiry crossed out, new expiry below
  - Cr/Dr column shows net cost from AI (e.g., "-$930.00 debit" or "+$450 credit")
  - ROLL badge now properly displays on roll trades
  
- **Wheel Continuation Support**: AI can now suggest "let it get called + sell put"
  - Stages as a roll with close leg (assignment) and open leg (new put)
  - Net credit displayed for wheel continuation trades

### Changed
- **Staging Function**: `stageHoldingSuggestedTrade()` now sets proper flags
  - Added `isRoll: true` and `isCall` flags for correct display
  - Added `netCost` field from AI response for roll cost display
  - Stores `rollFrom.type` for accurate option type display

## [1.17.19] - 2026-01-30

### Added
- **Unified AI Context System (Phase 2)**: All AI analysis calls now share position lifecycle context
  - Created `/api/ai/holding-suggestion` backend endpoint for covered call analysis
  - Created `/api/ai/spread-advisor` backend endpoint for spread position advice
  - Both endpoints use `buildPositionFlowContext()` for consistent context injection
  - AI now sees chain history, previous AI recommendations, and opening thesis in every call
  - Each AI call knows its position in the lifecycle: DISCOVERY → ANALYSIS → ENTRY → ACTIVE → CLOSING → REVIEW
  - Frontend functions refactored to call backend endpoints (no more inline prompts)

### Changed
- **aiHoldingSuggestion()**: Now calls `/api/ai/holding-suggestion` instead of building inline prompt
  - Shows chain history count in modal if position is part of a wheel chain
  - Price fetching moved to backend via MarketDataService (Schwab→CBOE→Yahoo)
  
- **askSpreadAI()**: Now calls `/api/ai/spread-advisor` instead of building inline prompt  
  - Chain history and analysis history included in context
  - Response now includes spot price, DTE, ITM status, and max profit/loss

### Technical
- Migrated 2 inline prompts from frontend to backend for unified context awareness
- All AI calls can now reference previous recommendations and adjust accordingly
- Reduced frontend complexity by moving prompt building to `promptBuilders.js`

## [1.17.9] - 2026-01-29

### Added
- **Monte Carlo Probability in Checkups**: AI now receives probability estimates for each position
  - Runs 5,000 path Monte Carlo simulation before each checkup
  - Provides AI with: max profit probability, profitable probability, max loss probability
  - Shows simulated price distribution at expiry (10th, 25th, 50th, 75th, 90th percentiles)
  - AI uses probabilities to inform HOLD/CLOSE/ROLL recommendations
  - Example: "58.2% probability of max profit, 12.4% probability of max loss"
  - Uses current IV for realistic volatility assumptions
  - Works for single-leg options AND spreads

### Technical
- New `runPositionMonteCarlo()` function calculates position-specific probabilities
- Monte Carlo data passed to backend via `/api/ai/checkup` endpoint
- Prompt builder displays probability section with clear visual formatting
- AI instructed to weight recommendations based on probability thresholds

## [1.17.8] - 2026-01-29

### Added
- **User Strategy Notes in Checkups**: Add your own notes to positions to guide AI recommendations
  - New "📝 My Strategy Notes" section in checkup modal
  - Notes are saved per-position and persist across sessions
  - AI sees your notes prominently marked as "USER'S STRATEGY INTENT"
  - AI will adjust recommendations based on your stated strategy
  - Example: "Taking assignment to wheel the shares" tells AI not to suggest avoiding assignment
  - Works for both localStorage positions AND Schwab-synced positions
  - Visual feedback: button turns green "✅ SAVED!" on successful save
  - Tooltip explains that notes override default AI recommendations

### Fixed
- **Schwab-synced Position Notes**: Notes now save correctly for positions from Schwab
  - Previously only localStorage positions could save notes
  - Now checks both localStorage and in-memory state for position
  - Schwab positions are automatically added to localStorage when note is saved

## [1.17.7] - 2026-01-29

### Added
- **Checkup History Tracking**: AI now considers all prior checkups when evaluating positions
  - Each checkup is saved to `pos.analysisHistory[]` with timestamp, recommendation, snapshot
  - Subsequent checkups show last 5 prior checkups to the AI
  - AI evaluates trend: "Is position getting healthier or deteriorating?"
  - Spot price at each checkup shown for trajectory analysis
  - Example: "Stock climbed from $45.30 → $46.50 → $48.39 across 3 checkups, all HOLD"

- **Breakeven Column in Positions Table**: New B/E column shows breakeven price for all position types
  - Short Put: Strike - Premium
  - Put Credit Spread: Sell Strike - Net Credit
  - Call Credit Spread: Sell Strike + Net Credit  
  - Covered Call: Cost Basis or Strike + Premium
  - Long Call/LEAPS: Strike + Premium
  - Buy/Write: Stock Price - Premium

- **Risk Analysis in Spread Confirmation Modal**: See risk before confirming trades
  - Max Loss per contract (spread width - net credit)
  - Total Max Loss based on contract count
  - Risk:Reward ratio with color coding (green if favorable, red if >2:1 against)
  - Breakeven price calculation
  - Strike dropdowns populated from real options chain with bid prices

### Fixed
- **Close Panel Crash on Spreads**: Fixed "Cannot read properties of undefined (reading 'toFixed')" error
  - Spread positions have null `strike` (use `buyStrike`/`sellStrike` instead)
  - Now shows "$320/$315" format for spreads in close panel
  - Changed "Premium received" to "Net credit" label for spreads

- **Checkup Thesis Display**: Fixed "Original thesis N/A" when thesis data exists
  - Empty string `""` in aiSummary fields was passing truthy checks but had no content
  - Now always shows market conditions at entry (price, IV, range) even without AI summary
  - Uses `.trim()` to properly detect empty strings vs actual content
  - Positions synced from Schwab now show their entry conditions properly

- **Positions Table Layout**: Fixed cramped Actions column
  - Changed from `table-layout: fixed` to `table-layout: auto`
  - Reduced column widths for better balance
  - Ticker and Actions columns use `white-space: nowrap`

### Changed
- **X Deep Dive**: Now uses real options chain data instead of estimates
  - Fetches actual options chain via `MarketDataService.getOptionsChain()`
  - Finds ~0.20 delta put at ~30 DTE (conservative target)
  - Returns real strike, expiry, premium with delta/IV data
  - No more guesstimates like `price * 0.9`

## [1.17.6] - 2026-01-29

### Fixed
- **Trending on X: Stale Earnings Data**: Now uses xAI's LIVE X Search tool for real-time data
  - Previously, Grok guessed earnings dates from training data (MSFT/META showed as "next week" when they already reported)
  - Now uses `callGrokWithSearch()` with X Search + Web Search for ACTUAL live posts
  - Prompt explicitly instructs: "If earnings already happened, say ALREADY REPORTED"
  - Citations from real X posts now included in response
  - Upgraded to `grok-4-1-fast-non-reasoning` model for speed with search capability

### Added
- **callGrokWithSearch()**: New AIService function for live search-enabled Grok calls
  - `xSearch: true` - Search X/Twitter for last 7 days of posts
  - `webSearch: true` - Search the web for current information
  - Returns `{ content, citations }` with sources
  - 3-minute timeout for search operations

- **Trend Comparison Across Runs**: AI now knows what was trending in your previous scans
  - Sends last 5 runs of ticker history to Grok
  - AI marks tickers as: 🔥🔥 STILL HOT (persistent buzz), 🆕 NEWLY TRENDING, or 📉 FADING
  - Highlights persistent tickers that appeared in 2+ scans
  - Helps spot sustained momentum vs flash-in-the-pan hype
  - Previously, each scan was independent with no memory of past runs

## [1.17.5] - 2026-01-28

### Fixed
- **Position Checkup Strike Display**: Fixed "$undefinedP" showing for spread positions in checkup modal
  - Spread positions use `sellStrike/buyStrike` (e.g., "$325/$320P") instead of undefined `strike` field
  - Also shows correct option type indicator (P for puts, C for calls)

- **Suggested Trade Truncation**: Increased AI checkup token limit from 1500 to 2500
  - Prevents the SUGGESTED_TRADE block from being cut off
  - Allows AI to complete full analysis with actionable trade recommendations

- **Empty Suggested Trade Section**: Cleaned up display when AI recommends WATCH/HOLD
  - No longer shows dangling "6. SUGGESTED TRADE" header with no content
  - AI now outputs "No trade action required - HOLD position." for non-actionable recommendations

### Added
- **Poor Man's Covered Call (PMCC) in Wall Street Mode**: Added PMCC as preferred strategy #5
  - AI will now recommend PMCC for stocks at all-time highs where shares are too expensive
  - Example: Buy deep ITM LEAPS call (0.80+ delta), sell OTM short-term calls against it
  - Ideal when you want covered call income without tying up capital in 100 shares

- **Full Strategy Toolkit for Wall Street Mode**: AI now has full discretion to pick the best strategy
  - Bullish: Bull Put Spread, Bull Call Spread, CSP, PMCC, Long Call
  - Bearish: Bear Call Spread, Bear Put Spread
  - Neutral: Iron Condor, Calendar Spread, Covered Call
  - Situation-based guidance (ATH + momentum → Bull Call Spread, High IV → sell premium)
  - Still enforces NO INFINITE RISK (all positions must have defined max loss)

- **Stage Any Alternative Trade**: Wall Street Mode now shows "📥 Stage" buttons for all recommendations
  - Primary, Alternative #1, and Alternative #2 each have their own Stage button
  - Click any button to stage that specific trade to Ideas tab
  - Footer now shows hint about staging alternatives

- **Improved Trade Parsing for Staging**: Added parsing for complex strategies
  - **Iron Condor**: Now parses "110/115 Call Spread + 100/95 Put Spread" format
  - **PMCC**: Parses "Buy $85 LEAPS Call + Sell $110 Call" format  
  - **Bull Call Spread**: Parses "Buy $100/$105 Call Spread" format
  - **Bear Put Spread**: Parses various debit spread formats
  - Console shows `[STAGE] Detected...` for debugging what was parsed

## [1.17.4] - 2026-01-28

### Fixed
- **Real IV for Roll Calculator**: Roll Calculator Monte Carlo simulation now uses real IV from CBOE
  - Previously used `state.optVol` (slider value) which was often the default 30%
  - Now fetches actual ATM IV for the ticker before running simulation
  - Roll risk tooltip shows IV value and source (e.g., "IV: 45.2% CBOE")
  - Added `fetchRealIV()` function to api.js with 5-minute caching

- **Real IV for AI Checkups**: Position checkups now include current IV comparison
  - Fetches real IV alongside market data for each checkup
  - AI prompt now shows "IV at entry: X%" vs "IV now: Y%" with change analysis
  - Helps AI understand if IV crush/expansion affected your position
  - Server logs IV fetch: `[AI] Current IV for SNOW: 32.5% (cboe)`

## [1.17.3] - 2026-01-28

### Fixed
- **Real IV for Risk Calculation**: Position risk percentages now use real IV from CBOE instead of hardcoded estimates
  - Previously used 50% default IV for most stocks, 85% for leveraged ETFs, 65% for high-vol stocks
  - Now fetches actual ATM implied volatility from CBOE for accurate Monte Carlo risk calculation
  - Risk tooltips now show IV value and source (e.g., "IV: 32% CBOE" or "IV: 50% estimated")
  - Fixes issue where spreads on low-IV stocks like SNOW showed inflated risk warnings (50% warning despite being OTM)
  - Added `getCachedIV()` and `batchFetchIV()` functions for efficient IV caching

## [1.17.2] - 2026-01-28

### Added
- **Theta Tooltip Enhancement**: Θ/day tooltips now show IV value and timestamp
  - Displays current IV percentage (e.g., "IV: 45.2%") and when it was last updated
  - Shows "just now" for live data or "Xm ago" for cached data
  - Works for both regular positions and spreads
  - Helps users understand the volatility assumptions behind theta calculations

## [1.17.1] - 2026-01-28

### Added
- **Spot Price Color Coding**: Spot prices in Positions table now use same color logic as ITM field
  - Green: Safe zone (OTM for shorts, ITM for longs)
  - Red: Danger zone (ITM for shorts, OTM for longs)  
  - Orange: At-the-money zone
  - Gray: Neutral OTM for longs
  - Works for both regular positions and spreads

## [1.17.0] - 2026-01-28

### Fixed
- **Theta Decay Display** now uses real IV from the options chain for each ticker, not a 30% default.
- Deep OTM/ITM options now show correct (small) theta, with tooltips explaining why.
- Theta values under $1 now show cents (e.g. `+$0.45` instead of `+$0`).

### Improved
- All positions now fetch actual IV for Greeks, making theta/delta more accurate for volatile stocks.

## [1.16.0] - 2026-01-27

### Added
- **🌐 Global AI Model Selector** - One model setting to rule them all!
  - New dropdown in header bar (next to Account switcher)
  - Sets default AI model for all features
  - Local "Override" dropdowns let you customize per-feature if needed
  - Defaults to "(use global)" - no more setting the same model everywhere
  - Preference saved to localStorage for persistence

- **📊 Spread Position Support in Portfolio Audit** - AI now understands spreads!
  - Portfolio audit sends `sellStrike`, `buyStrike`, `spreadWidth` for spreads
  - Also sends calculated `maxProfit` and `maxLoss` values
  - AI sees `$325/$320 (5w) MaxProfit: $X, MaxLoss: $Y` instead of `$null`
  - Proper `[SPREAD]` tag in position summary

- **🧠 Spread AI Advisor** - "What Should I Do?" button for spreads
  - New button in spread explanation modal
  - Fetches live spot price from CBOE
  - Calls AI for recommendation (HOLD, CLOSE, ROLL)
  - Shows model name at bottom of recommendation

- **🔌 Simple AI Endpoint** - New `/api/ai/simple` endpoint
  - Takes raw `{prompt, model}` without prompt builder
  - Used by spread advisor and other direct AI calls
  - Cleaner API for custom prompts

### Fixed
- **AI Model Override Priority** - Local selectors no longer override global incorrectly
  - Fixed: saved local preferences were overriding "(use global)" selection
  - Now properly defaults to global unless explicitly overridden
  - Removed `selected` attribute from DeepSeek option in local dropdowns

- **Spread Explanation Modal** - Enhanced with live position data
  - Shows Current Status section: DTE, Spot Price, Current P/L
  - Unrealized P/L calculated from live option prices
  - Clear visual display of position health

### Changed
- **Local AI Model Selectors** - Now labeled as "Override:" with "(use global)" default
  - P&L tab, Discord Analyzer, Trade Ideas all updated
  - Empty value means "use global model"
  - Consistent pattern across all AI features

### Technical Notes
- `getSelectedAIModel(localSelectId)` helper function for consistent model selection
- Pattern: check local override → fall back to global → final default to qwen2.5:14b
- `window.T2SharedLogic` pattern from T2AutoTron adopted for shared utilities

## [1.15.0] - 2026-01-25

### Added
- **📈 Enhanced Trade Analysis** - AI now considers more data points!
  - Full options chain context for smarter recommendations

## [1.14.0] - 2026-01-24

### Added
- **🎓 AI Strategy Advisor** - Comprehensive strategy analysis for any ticker!
  - Enter any ticker and AI analyzes ALL option strategies:
    - Short Puts, Covered Calls, Long Calls
    - Bull/Bear Put Spreads, Bull/Bear Call Spreads
    - Iron Condors, SKIP™ Strategy
  - Recommends the BEST strategy based on:
    - Current IV rank (high = sell premium, low = buy premium)
    - Stock's position in 3-month range
    - Your buying power and risk tolerance
    - Your existing positions (avoids concentration risk)
  - Shows complete trade setup: strikes, expiration, credit/debit
  - Explains risks, max profit/loss, breakeven, win probability
  - Educational notes help you understand why each strategy fits
  - One-click staging to add recommended trade to pending
  - Data hierarchy: Schwab (real-time) → CBOE → Yahoo fallback

- **🧠 Trading Pattern Memory** - AI remembers your past wins and losses!
  - When analyzing a new trade, AI checks your closed positions for similar patterns
  - Warns you about losing patterns: "TSLA short puts burned you before - 35% win rate"
  - Encourages winning patterns: "MSTX short puts have 80% win rate for you!"
  - Works in both Discord Analyzer and 💡 Get Insight
  - Pattern matching: same ticker+type, same ticker, same strategy type

- **📅 Custom Date Range Filtering** - Filter closed positions by any date range
  - Year dropdown now includes "📅 Custom Range" option
  - Pick From and To dates to analyze specific periods
  - Perfect for monthly reviews, tax periods, or market event analysis
  - Filter applies to table view, CSV export, and AI Historical Audit

- **📊 AI Historical Audit** - AI analyzes your filtered closed trades
  - New "🤖 AI Historical Audit" button in Portfolio tab
  - Grades your trading period (A/B/C/D/F)
  - Identifies what worked well and areas for improvement
  - Finds patterns in your trading (concentrations, preferences)
  - Provides actionable recommendations and key lessons
  - Model selector: choose 7B/14B/32B/DeepSeek-R1/Grok

- **📚 Comprehensive Feature Documentation** - New `docs/FEATURES.md`
  - Detailed "How It Works" explanations for all major features
  - Architecture diagrams and data flow explanations
  - Thresholds, formulas, and decision logic documented
  - Perfect for understanding the system and future maintenance

### Changed
- **Pattern Analysis Thresholds** - Tuned for meaningful insights
  - Warning: <40% win rate OR <-$500 total P&L
  - Encouragement: >=75% win rate AND >$100 avg P&L
  - Minimum trade counts: 2 (ticker+type), 3 (ticker), 5 (type)

### Technical Notes
- Pattern data sent as lightweight `closedSummary` (ticker, type, strike, pnl only)
- Pattern analysis runs server-side for consistent calculations
- AI prompt includes `═══ YOUR HISTORICAL PATTERNS ═══` section when patterns exist
- New functions: `analyzeHistoricalPattern()`, `formatPatternForAI()` in portfolio.js

## [1.13.0] - 2026-01-24

### Added
- **🧠 Vector RAG Wisdom System** - AI now uses semantic search for trading rules!
  - Wisdom entries are converted to vector embeddings using `nomic-embed-text` model
  - AI finds the most semantically relevant rules for each trade (not just category matching)
  - Relevance scores shown: 🎯 (>70%), 📌 (>50%), 📚 (lower)
  - AI MUST cite which rules it followed and explain any overrides
  - New endpoint: `/api/wisdom/regenerate-embeddings` to update all embeddings

- **⚡ Pure Mode Toggle** - Get raw AI analysis without wisdom influence
  - New "📚 Apply Wisdom" checkbox in AI Trade Advisor panel
  - When unchecked, AI gives pure analysis without your trading rules
  - Visual indicators: "✓ Rules active" (green) or "⚡ Pure mode" (yellow)
  - Useful for comparing rule-influenced vs raw AI opinions
  - Preference saved to localStorage

### Changed
- **AI Prompt Strengthening** - Rules changed from "consider" to "MANDATORY"
  - AI must explicitly CITE rule numbers it's following
  - AI must EXPLAIN why if it disagrees with any rule
  - Better compliance with your personal trading philosophy

- **Wisdom Display Improvements**
  - Analysis modal shows which wisdom entries matched with relevance scores
  - Pure mode shows yellow banner explaining wisdom was skipped
  - Model info bar shows 📚 count or ⚡ Pure indicator

## [1.12.0] - 2026-01-24

### Added
- **🖥️ Electron Desktop App** - WheelHouse is now a standalone desktop application!
  - No more browser tabs - runs as a native Windows application
  - Embedded Node.js server starts automatically with the app
  - Clean window with proper app icon and title
  - DevTools available in dev mode for debugging

- **🔐 Password-Protected Login** - Secure app access
  - First launch prompts you to create a password (6-12 characters)
  - Supports letters, numbers, and special characters: `!@#$%^&*?`
  - Password stored securely using SHA-256 hashing
  - Visual dot indicators show password length as you type
  - Login screen appears before any data is accessible

- **🔒 Secure Credential Storage** - Enterprise-grade security for API keys
  - Uses Windows Credential Manager (via Electron's safeStorage API)
  - AES-256-GCM encryption for all sensitive data
  - Schwab tokens automatically migrated from .env to encrypted store
  - Secured keys: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REFRESH_TOKEN, 
    SCHWAB_ACCESS_TOKEN, OPENAI_API_KEY, GROK_API_KEY, TELEGRAM_BOT_TOKEN
  - `.secure-store` file is encrypted and unusable without Windows login

- **🔰 Security Status Banner** - Know your security mode at a glance
  - Green banner in Settings when running in secure (Electron) mode
  - Yellow warning when running in legacy web mode
  - Fetches status from `/api/settings/security` endpoint

- **📦 Windows Installer** - Easy distribution
  - One-click NSIS installer (`WheelHouse Setup 1.12.0.exe`)
  - Installs to user's AppData folder (no admin required)
  - Creates desktop shortcut
  - Clean uninstaller included
  - ~81MB installer size

- **🚀 Launcher Batch Files** - Multiple ways to start
  - `WheelHouse.bat` - Main launcher, clears ports, starts Electron app
  - `WheelHouse-Dev.bat` - Dev mode with Chrome DevTools open
  - `WheelHouse-WebOnly.bat` - Legacy mode, just the Node.js server

### New Files
- `electron/main.js` - Electron main process (app lifecycle, IPC, secure storage)
- `electron/preload.js` - Context bridge for secure renderer communication
- `login.html` - Password login/setup screen
- `src/secureStore.js` - AES-256-GCM encrypted credential manager
- `WheelHouse.bat`, `WheelHouse-Dev.bat`, `WheelHouse-WebOnly.bat` - Launchers

### Changed
- `package.json` - Now configured for Electron with build settings
- `server.js` - Initializes secure store when encryption key present
- `src/routes/settingsRoutes.js` - Uses secureStore for secrets, added `/security` endpoint
- `index.html` - Added security status banner in Settings tab
- `js/settings.js` - Added `checkSecurityStatus()` function
- `.gitignore` - Added `dist/` and `.secure-store` exclusions

### Security Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main Process                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ safeStorage API → Windows Credential Manager            ││
│  │ Stores: WHEELHOUSE_ENCRYPTION_KEY (256-bit)            ││
│  └─────────────────────────────────────────────────────────┘│
│                           │                                  │
│                    passes key via env var                    │
│                           ↓                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Node.js Server (port 8888)                              ││
│  │ secureStore.js ← AES-256-GCM encryption                 ││
│  │ .secure-store file (encrypted JSON)                     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Migration Notes
- **Existing .env secrets**: Automatically migrated to encrypted store on first Electron launch
- **Web mode still works**: Use `WheelHouse-WebOnly.bat` or `npm run start:web`
- **Password reset**: Delete `wheelhouse_password` from localStorage to reset

---

## [1.11.0] - 2026-01-24

### Added
- **🎯 Alternative Strategies AI** - Think beyond rolling!
  - When covered call is ITM, AI now considers 5 strategies instead of just "roll":
    1. LET IT GET CALLED - Take the win, redeploy capital
    2. BUY A SKIP CALL - Capture additional upside above strike
    3. BUY A CALL DEBIT SPREAD - Defined risk upside play
    4. SELL PUTS BELOW - Add bullish exposure on dips
    5. ROLL UP AND OUT - Traditional approach
  - For short puts ITM: TAKE ASSIGNMENT, ROLL, CONVERT TO SPREAD, or CLOSE
  - Inspired by professional options trader advice

- **📊 Assignment Scenario Calculator** - Shows exactly what you'd make if called
  - Stock gain: (strike - cost basis) × shares
  - Premium gain: net premium across entire roll chain
  - Missed upside: (current spot - strike) if stock above strike
  - Helps decide if assignment is actually a WIN, not a problem

- **🔗 Chain History Context** - AI sees full roll history
  - Shows "This position has been rolled X times"
  - Displays total days in trade
  - Calculates net premium collected across all rolls
  - Warns about capital efficiency after 3+ rolls

- **`getChainData(positionId)`** - New helper function
  - Returns `{ chainHistory, totalPremiumCollected }`
  - Used by AI analysis to provide chain-aware recommendations

### Changed
- AI prompts now ask "Why this OVER rolling?" when recommending alternatives
- Checkup prompts for ITM covered calls explicitly list alternatives to consider
- Request payload to `/api/ai/analyze` now includes `chainHistory` and `totalPremiumCollected`

---

## [1.10.0] - 2026-01-24

### Added
- **🏆 Win Rate Dashboard** - Comprehensive trading stats panel
  - Win Rate percentage with W/L count
  - Average DTE held across all trades
  - Average premium collected per trade
  - Best/Worst ticker by total P&L
  - Biggest single win and loss
  - Chain-aware: counts rolled positions as single trades

- **📈 Cumulative P&L Chart** - Visual line chart of your performance
  - Shows P&L growth over time
  - Green when profitable, red when negative
  - Area fill under the curve
  - Date range labels

- **📅 Expiration Calendar** - Interactive monthly calendar
  - Shows all open position expirations
  - Color-coded dots: 🟢 Put, 🔵 Call, 🟣 Spread
  - Navigate months with arrow buttons
  - Click any day to see expiring positions

- **📊 Break-even Indicator** - In Roll vs Redeploy modal
  - Shows exactly how much stock needs to rise for roll to beat redeploy
  - Displays target price increase (e.g., "+$1.61 more")
  - Helps make data-driven roll decisions

- **⚖️ Roll vs Redeploy Analysis** - New opportunity cost calculator
  - Shows missed upside (stock above strike)
  - Compares rolling up vs redeploying capital
  - Uses your actual yield from closed trades
  - Clear verdict on which choice wins

- **🧠 MoE AI System** - Mixture of Experts for 32B model
  - Runs 7B and 14B models in parallel
  - 32B synthesizes both opinions as "judge"
  - More consistent AI recommendations
  - "View Opinions" button shows all perspectives

- **🤖 DeepSeek-R1-Distill-Qwen-32B** - New default AI model
  - Better reasoning for options analysis
  - Improved roll recommendations

- **📊 AI Performance Review** - Track AI prediction accuracy
  - Logs predictions with timestamps
  - Tracks outcomes when positions close
  - Shows accuracy percentages by recommendation type

- **⏱️ 60-Second Data Cache** - Prevents AI inconsistency
  - Same ticker data used for all AI calls within 60 seconds
  - Fixes issue where AI compared different price points

### Changed
- **🔄 Dashboard Layout** - Moved to bottom row (no scrollbar)
  - Win Rate, P&L Chart, Calendar side-by-side under Account Balances
  - Full width utilization, no vertical scroll needed

- **📊 Portfolio Summary** - Fixed metrics alignment
  - Now matches Positions footer calculations exactly
  - Removed duplicate "Performance" panel

### Fixed
- **🔧 Hardcoded Risk-Free Rate** - Now uses `state.rate` instead of hardcoded 0.05
  - Black-Scholes calculations respect user's rate setting
  - Improved roll tips and suggestions
- **🔧 LEAPS Parsing** - Correct expiry detection for long-dated options
- **🔧 Long Option Analyzer** - Correct labels for bought options
- **🔧 Roll Workflow** - Missing close fields on roll now fixed
- **🔧 Capital Velocity** - Now uses blended premium + P&L yield

## [1.9.0] - 2026-01-22

### Added
- **📊 Per-Position Greeks** - Delta (Δ) and Theta (Θ/day) columns in Positions table
  - Shows individual position Greeks calculated from Black-Scholes
  - Delta in neutral gray (pro style), Theta in green when positive
  - Updates on page load and when "Update Greeks" is clicked

- **🤖 AI Portfolio Audit** - Comprehensive AI analysis of your entire portfolio
  - New button in Portfolio Greeks section
  - Analyzes all open positions, Greeks, concentration risk
  - Provides optimization suggestions (rolls, closes, adjustments)
  - Saves portfolio context for use in future AI trade analysis

- **🧠 Portfolio-Aware AI Trade Analysis** - AI now considers your existing positions
  - Portfolio context (from last audit) included in all AI prompts
  - Trade analysis considers sector concentration
  - Ideas feature suggests trades that balance your portfolio
  - Context valid for 24 hours after audit

- **📅 Year Filter for Advanced Analytics** - Filter stats by trading year
  - Uses same year filter as Closed Positions table
  - Shows "(2026)" or "(All Time)" in section header
  - See your current year performance vs historical

- **📥 Stage Roll to Ideas** - Stage suggested rolls directly to pending trades
  - "Stage to Ideas" button on each roll suggestion
  - Purple "ROLL" badge shows in Pending Trades
  - Call/Put indicator (C/P) with color coding
  - Track roll candidates before executing

- **📈 Conservative Kelly Calculator** - Uses account value + 25% of margin
  - No longer uses full buying power (was overestimating)
  - Formula: Account Value + (25% × Available Margin)
  - Tooltip explains calculation
  - Much safer position sizing recommendations

### Changed
- **🎯 Restart Server Button** - Moved to tabs row with dull orange styling
- **📊 Delta Column** - Changed from color-coded to neutral white (professional style)

## [1.8.0] - 2026-01-22

### Added
- **💳 Margin Impact Calculator** - See if you can afford to sell an option
  - Shows margin requirement for short puts AND short calls
  - Compares to your current buying power from Schwab
  - Shows remaining buying power after trade
  - BP Utilization percentage with color coding
  - Verdict: "Low Impact" / "OK" / "High Utilization" / "Insufficient Margin"
  - Note for covered calls (no margin if you own shares)

- **💳 Margin Check on Pending Trades** - New button in Pending Trades section
  - Click 💳 to instantly check if you can afford the trade
  - Fetches live stock price (Schwab → Yahoo fallback)
  - Shows modal with margin required vs your buying power
  - Clear verdict: ✅ OK / ⚠️ HIGH / ❌ INSUFFICIENT

- **🎯 Auto-Fill Barriers** - Suggested barriers now auto-populate
  - When fetching a ticker, barriers are auto-set based on volatility
  - High vol (>50%): ±20% from spot
  - Normal vol: ±15% from spot
  - No more manual entry needed

- **💰 Portfolio Balances Banner** - See your Schwab account info at a glance
  - Cash Available, Buying Power, Account Value, Margin Used, Day Trade BP
  - Auto-fetches when opening Portfolio tab
  - 🔄 button to manually refresh
  - Only shows when Schwab is connected

### Changed
- **🔧 Positions Actions Column** - Cleaner, aligned button layout
  - All buttons now fixed-width (28px) for consistent vertical alignment
  - Invisible placeholders hold space for conditional buttons (Assign, Called Away, etc.)
  - No more jumbled/misaligned buttons across different position types
  - Flexbox layout with proper 4px gaps

## [1.7.0] - 2026-01-21

### Added
- **🤖 AI Holding Suggestions with Model Toggle** - Choose Grok (best) or Ollama (free)
  - Click 🤖 AI button on any holding card in Portfolio tab
  - Fetches live stock price (Schwab → Yahoo → CBOE fallback)
  - Shows position snapshot: Stock P&L, Premium, On Table/Cushion, If Called
  - AI recommends: HOLD / ROLL UP / ROLL OUT / LET CALL / BUY BACK
  - **Grok now default** - significantly better accuracy for ITM/OTM assessment
  - Toggle buttons to switch between models mid-analysis
  - "Roll This Call" button opens Roll Panel directly

- **💾 Save Strategy** - Store AI recommendation for future reference
  - Saves: recommendation, full analysis, market snapshot at time of save
  - Used for checkup comparisons and smart risk indicators

- **🔄 Strategy Checkup** - Compare current conditions to saved strategy
  - Side-by-side: Original vs Current conditions
  - AI evaluates: "Stick with plan" or "Adjust strategy"
  - **Recommendation change detection** - warns if AI advice has changed
  - One-click "Update Strategy" button when recommendation changes

- **🎯 Strategy-Aware Risk Indicator** - Context-smart position badges
  - If strategy is "LET CALL": 🎯 55% (cyan, on track) instead of 🔴 55% (red, danger)
  - Tooltip shows: "55% assignment probability - Strategy: LET CALL ✓"
  - System understands assignment can be GOOD for covered calls

- **📊 Cost Basis Display** - Now shown in Holdings cards
  - Click to edit if imported incorrectly
  - Enables accurate AI analysis and P&L calculations

- **👁️ Hide Holdings** - Clean up stale/irrelevant holdings
  - Hide by ticker (persists across re-imports)
  - "Show X hidden" toggle to reveal hidden items
  - Great for hiding CUSIPs, money markets, etc.

- **🔗→ Mark as Rolled** - Link broker-imported positions retroactively
  - For when you roll at broker, then re-import transactions
  - Smart modal shows OLD → NEW comparison side-by-side
  - Auto-fills buyback cost from: broker import → marked price → CBOE → $0 if expired
  - Live net credit/debit calculation as you adjust
  - Updates holdings to point to new position automatically

- **Auto-Link Holdings** - Holdings find their current covered call
  - If linked position was rolled, AI auto-finds the open position for that ticker
  - Updates holding link automatically for future use

- **X Sentiment Enhancements**
  - Persistence: Survives tab switches (4-hour cache)
  - Trend history: Compare current vs previous runs
  - Shows "Still Trending", "Newly Trending", "Dropped Off" categories
  - Usage counter: Track Grok API calls (~$0.015 each)

- **Generic Grok API Endpoint** - `/api/ai/grok` for custom prompts

### Fixed
- **Staged trades from X Sentiment** - Now show proper DTE, Credit, Ann% in Pending panel
- **Roll linking across types** - buy_write → covered_call rolls now link correctly
- **Holdings update on roll** - Holdings now point to new position after roll link
- **saveHoldingsToStorage import** - Fixed missing import in portfolio.js

---

## [1.8.0] - 2026-01-21

### Added
- **Schwab API Integration** - Real-time option pricing from your brokerage
  - Schwab-first pricing with CBOE fallback
  - Full Greeks: Delta, Theta, Gamma, IV directly from Schwab
  - Win probability calculated from delta
  - Data source indicator: 🔴 Schwab (real-time) vs 🔵 CBOE (delayed)

- **Smart Strike Lookup** - No more guessing invalid strikes
  - Fetches ALL available strikes from Schwab (`strikeCount=50`)
  - Finds closest match to requested strike
  - Shows adjustment: "⚠️ Using actual strike $150 (requested $152)"

- **TradingView Charts for Staged Trades** - Pre-trade analysis
  - 📊 Chart button on each pending trade
  - 3-month chart with Bollinger Bands
  - Dark theme matching WheelHouse UI
  - Check if stock is oversold before entering

- **Friday Expiry Validation** - Options never expire on weekends
  - `snapToFriday()` auto-corrects AI dates (Feb 21 → Feb 20)
  - Prompt now shows exact valid Friday expiry dates
  - No more invalid Saturday/Sunday expirations

- **AI Trade Ideas Generator Improvements**
  - 54 curated stocks + Yahoo Most Active + Trending discovery
  - 10 ideas per run (was 3)
  - Range position filtering (rejects stocks >70% of range)
  - "Show Different Stocks" button for variety
  - 15-minute cache for Yahoo rate limiting

### Fixed
- **IV Display Bug** - Was showing 6500% instead of 65% (×100 error)
- **Deep Dive Buttons** - Regex now handles **bold** markdown format
- **localStorage Persistence** - Trade ideas cached for 24 hours
- **Annualized ROC** - Now displayed in Deep Dive premium section

---

## [1.6.0] - 2026-01-20

### Added
- **SKIP Call™ Strategy Support** - "Safely Keep Increasing Profits"
  - New position type: `skip_call` for LEAPS + shorter-dated overlay
  - Tracks both LEAPS (12+ months) and SKIP call (3-9 months) details
  - Separate fields: LEAPS strike/premium/expiry + SKIP strike/premium/expiry
  - Calculates total investment and both DTEs
  
- **SKIP Exit Window Alerts** - Never miss the optimal exit
  - 🚨 Red alert when SKIP call < 45 DTE (past exit window)
  - ⚠️ Orange warning at 45-60 DTE (exit window active)
  - Row highlighting for SKIP positions needing attention
  
- **SKIP Explanation Modal** - AI-style breakdown
  - `showSkipExplanation(posId)` - Full strategy explanation
  - Shows LEAPS vs SKIP side-by-side
  - Exit window status with countdown
  - Plain-English "How SKIP Works" explanation

### Fixed
- **CBOE Price Priority** - Stock prices now use CBOE first, Yahoo fallback
  - Eliminates Yahoo 429 rate limiting errors
  - `fetchStockPrice()` helper in api.js
  - All price-fetching functions updated to use CBOE `current_price`

---

## [1.5.0] - 2026-01-20

### Added
- **Deep Dive Analysis** - Comprehensive scenario analysis for any trade
  - Bull/Base/Bear/Disaster case modeling
  - Live CBOE option pricing (bid/ask/mid/IV)
  - Support/resistance level analysis
  - Earnings date awareness
  - Decisive verdicts: ✅ ENTER / ⚠️ WAIT / ❌ AVOID

- **Discord Trade Analyzer** - Paste any trade callout for instant analysis
  - AI parses trade text into structured data (ticker, strike, expiry, strategy)
  - Fetches real-time CBOE pricing and market data
  - Analyzes setup with FOLLOW/PASS/AVOID verdict
  - Works with puts, calls, and spreads

- **Spread Risk/Reward Math** - Proper spread calculations
  - Bull put spread / Bear call spread support
  - Correct max profit / max loss / return on risk
  - Breakeven calculations
  - Premium vs spread width percentage (≥30% is ideal)
  - Fixes previous bug where spreads showed naked put math ($41K risk vs $625 actual)

- **Position Checkup** - Compare opening thesis to current conditions
  - Stores entry thesis (price, support levels, SMAs, earnings, AI verdict)
  - Fetches current market data for comparison
  - AI analyzes: Has thesis held up? Roll/Hold/Close recommendation
  - Health verdict: 🟢 HEALTHY / 🟡 STABLE / 🔴 AT RISK

- **Trade Critique** - AI reviews your closed trades
  - Analyzes full roll history chain
  - Identifies what went well vs could improve
  - Gives letter grade (A-F) on process, not just outcome
  - Key lesson takeaway for future trades

- **Stage → Confirm Flow** - Better trade workflow
  - Stage trades from AI analysis (stores thesis data)
  - Confirm when executed with broker (enters actual fill)
  - Thesis persists for later checkup

- **DTE Warnings** - Red flags for short-dated trades
  - 🚨 EXPIRED - Do not enter
  - 🚨 ≤3 days - Very short, high gamma risk
  - ⚠️ ≤7 days - Limited time for thesis to play out

- **Server Restart Button** - 🔄 button in header for quick restart

### Changed
- AI prompts now include explicit spread math (no more $40K risk hallucinations)
- Entry quality indicator: ✅ got ≥ mid (selling) / ✅ paid ≤ mid (buying)
- Spread strikes auto-corrected if AI parses them backwards

### Fixed
- Spread math was using naked put formula - now uses proper spread width
- OTM distance calculation now uses correct strike (sell strike for spreads)
- Bull put spread strikes now enforced: sellStrike > buyStrike

## [1.4.0] - 2026-01-20

### Added
- **AI Trade Advisor** - Local AI-powered trade recommendations
  - Uses Ollama with Qwen 2.5 models (7B/14B/32B)
  - Model selector dropdown - choose speed vs intelligence
  - Analyzes ALL roll options and picks the best one
  - Highlights AI's pick with green border + "AI Pick" badge
  - Smart handling of long calls/puts (no false "assignment risk" warnings)
  - Decision guidance: prefers credit rolls over debit rolls when appropriate

- **AI Health Check** - Skip AI for healthy positions
  - Positions that are OTM + low risk + high win probability get instant "HOLD" advice
  - No 5-15 second AI wait time for winning trades
  - AI only consulted for troubled positions that actually need roll analysis

- **Model Selection & Persistence**
  - Choose between Qwen 7B (fast), 14B (better), 32B (best)
  - Also supports Llama 3.1 8B and Mistral 7B
  - Model preference saved to localStorage
  - Shows which models are installed vs not installed

### Changed
- AI prompt now considers "HOLD - let theta work" as a valid recommendation
- Expert Analysis and AI Advisor are now consistent (both can recommend holding)
- Improved AI prompt with explicit guidance on credit vs debit roll decisions

### Fixed
- Long call/put positions no longer show "assignment risk" language
- AI Pick highlighting now matches exact date (Feb 6 vs Feb 20)
- Model dropdown shows ✓ for installed models, disables uninstalled ones

## [1.3.0] - 2026-01-20

### Added
- **Greeks Display** - Roll suggestions now show delta, theta, and IV
  - Each roll candidate shows: Δ (delta), θ (theta $/day), IV %
  - Helps evaluate risk/reward of each roll option
  - Purple badge row: 📊 Δ-0.25 · θ$15/d · IV 45%

- **Expert System Advisor** - Rule-based trade recommendations
  - Analyzes ITM/OTM status, DTE, and IV environment
  - Provides situation assessment (🚨 CRITICAL to 🟢 LOW risk)
  - Urgency indicator: CRITICAL, HIGH, MEDIUM, LOW
  - Action recommendations based on position status
  - IV context: High IV = good for rolling, Low IV = wait

- **Earnings & Dividend Alerts** - Auto-fetch calendar events
  - Warns when earnings date is BEFORE your expiration
  - Warns when ex-dividend date creates early assignment risk
  - Data from Yahoo Finance quoteSummary API
  - Example: ⚠️ EARNINGS Feb 5 (12d) - BEFORE your expiration!

### Changed
- Roll Calculator now shows Expert Analysis section after suggestions
- Added `/api/yahoo/calendar/:ticker` endpoint for calendar data

## [1.2.2] - 2026-01-20

### Fixed
- **Roll Calculator: TRUE roll cost** - Now calculates actual debit/credit
  - Previous bug: Only showed premium for NEW put (ignored close cost!)
  - Now calculates: `New Put Bid - Current Put Ask = Net Roll Cost`
  - Shows cost to close current position before suggestions
  - Red = debit (you pay), Green = credit (you receive)
  - Matches what Schwab/brokers actually charge for the roll

### Added  
- **Find Credit Rolls** - Search for rolls that pay YOU
  - Suggestions now split into "Best Risk Reduction" and "Credit Rolls" sections
  - "Search Further Out for Credits" button searches ALL expirations
  - Finds same-strike or higher-strike rolls further out in time
  - Shows top 6 credit roll options sorted by credit amount

## [1.2.1] - 2026-01-20

### Fixed
- **Challenge P&L Calculations** - Now correctly handles long calls/puts
  - Closed positions with long options now show correct realized P&L
  - Open positions with long options now show correct unrealized P&L
  - Total premium tracks debits (costs) as negative
  - View Positions modal shows premium in red for debit positions
  - Spread positions display both strikes (buy/sell) in Challenge view

## [1.2.0] - 2026-01-20

### Added
- **Update Notification System** - Toast notification when new version available
  - Automatically checks GitHub for updates on app load
  - Shows changelog summary with what's new
  - One-click update via git pull
  - Links to GitHub releases for manual download
- **Long Call/Put Support** - Proper handling of purchased options
  - Premium displayed as debit (negative, red)
  - Correct capital at risk calculation (premium paid)
  - Ann% shows "—" since ROC doesn't apply to long options
  - Net Premium total correctly subtracts debits

### Fixed
- Long calls/puts now correctly show as debits instead of credits
- Portfolio summary "Net Premium" accounts for long positions
- ROC and Ann% calculations exclude long call/put positions

## [1.1.0] - 2025-01-31

### Added
- **Spread Trading Support** - Track vertical spreads (Call Debit, Put Debit, Call Credit, Put Credit)
  - New position types in the dropdown with optgroup organization
  - Buy Strike / Sell Strike inputs for spread positions
  - Automatic max profit, max loss, and breakeven calculations
  - Purple color styling to distinguish spreads from single-leg options
  - **🤖 AI Explanation Modal** - Click the robot button on any spread to see:
    - Strategy name and direction (bullish/bearish)
    - Setup details with strikes and premium
    - Max profit and max loss scenarios
    - Breakeven price calculation
    - Plain-English explanation of how the trade works
    - Risk/reward ratio
- **Trading Challenges System** - Track Discord community challenges
  - Create challenges with goals, dates, and progress tracking
  - Link positions to challenges (by tag or date range)
  - Visual progress bars with completion percentage
  - 🏆 Challenges tab in navigation
  - Quick-link positions from Portfolio table
- **One-Click Installers**
  - `install.bat` / `start.bat` for Windows (auto-installs Node.js via winget)
  - `install.sh` / `start.sh` for Mac/Linux (Homebrew/apt support)

### Fixed
- Capital-at-risk calculation now properly handles spread positions
- Portfolio summary ROC calculations include spread max-loss

### Changed
- Position form now shows/hides fields dynamically based on position type
- Form resets completely after adding a position (including spread fields)
- Edit position now properly loads spread strike data

## [1.0.0] - 2025-01-30

### Initial Release
- Monte Carlo options simulation (10,000+ paths)
- Black-Scholes and binomial pricing models
- Position tracking for The Wheel strategy
- Live pricing via CBOE API with staleness indicators
- Portfolio analytics with ROC and annual yield calculations
- Stock holdings tracking with assignment flow
- CSV export of positions and history
- Responsive dark theme UI
