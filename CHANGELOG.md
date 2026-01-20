# WheelHouse Changelog

All notable changes to WheelHouse will be documented in this file.

## [1.2.2] - 2026-01-20

### Fixed
- **Roll Calculator: TRUE roll cost** - Now calculates actual debit/credit
  - Previous bug: Only showed premium for NEW put (ignored close cost!)
  - Now calculates: `New Put Bid - Current Put Ask = Net Roll Cost`
  - Shows cost to close current position before suggestions
  - Red = debit (you pay), Green = credit (you receive)
  - Matches what Schwab/brokers actually charge for the roll

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
