# WheelHouse Changelog

All notable changes to WheelHouse will be documented in this file.

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
