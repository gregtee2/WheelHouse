# WheelHouse Changelog

All notable changes to WheelHouse will be documented in this file.

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
