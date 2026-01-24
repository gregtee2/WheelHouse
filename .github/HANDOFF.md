# WheelHouse - Agent Handoff Document

**Last Updated**: January 24, 2026  
**Current Version**: 1.10.0  
**Status**: All features working, ready for next iteration

---

## 🎯 What is WheelHouse?

A **Wheel Strategy Options Analyzer** for tracking short puts, covered calls, and other options positions. Built with vanilla JavaScript (no frameworks) and Node.js backend.

**Key User**: Greg - options trader using the Wheel strategy on Schwab

---

## 🏗️ Architecture Quick Reference

| Component | Technology | File |
|-----------|------------|------|
| Frontend | Vanilla JS ES6 modules | `js/*.js` |
| Backend | Node.js + Express | `server.js` |
| Storage | localStorage | Browser |
| AI | Ollama (local LLMs) | `server.js` endpoints |
| Data | Schwab API, CBOE, Yahoo | `js/api.js`, `server.js` |

**Port**: 8888

---

## 📁 Key Files to Know

| File | Purpose |
|------|---------|
| `server.js` | Express server, AI endpoints, Schwab proxy |
| `js/portfolio.js` | Portfolio tab, holdings, closed positions, dashboards |
| `js/positions.js` | Open positions CRUD, roll workflow |
| `js/analysis.js` | AI trade analysis, roll calculator, MoE system |
| `js/settings.js` | Settings panel, Schwab sync |
| `index.html` | All HTML structure |
| `css/styles.css` | Dark theme styling |

---

## 🔥 Recent Work (This Session - Jan 23-24, 2026)

### Features Added
1. **Win Rate Dashboard** - Shows win %, avg DTE, avg premium, best/worst ticker
2. **P&L Chart** - Canvas line chart of cumulative P&L over time
3. **Expiration Calendar** - Interactive monthly calendar with position dots
4. **Break-even Indicator** - Shows how much stock needs to rise for roll to win
5. **MoE AI System** - 7B + 14B → 32B synthesis for consistent recommendations
6. **Holdings Card UI** - Redesigned from table to stat boxes

### Layout Change
- Moved dashboards to **bottom row** under Account Balances banner
- No more scrollbar in right panel
- 3-column layout: Win Rate | P&L Chart | Calendar

### Bug Fixes
- Capital velocity now uses blended yield (premium + realized P&L)
- Portfolio Summary aligned with Positions footer
- Roll workflow missing close fields fixed

---

## 🚧 Known Issues / TODOs

See `TODO.md` for full backlog. Key items:

1. **Model Auto-Setup** - Auto-download Ollama models on first run
2. **Dashboard Scrollbar** - User dislikes scrolling; already moved to bottom row
3. **Roll History UI** - Could be improved

---

## 🧠 AI System Overview

### Endpoints
| Endpoint | Purpose |
|----------|---------|
| `POST /api/ai/analyze` | Trade analysis with optional MoE |
| `POST /api/ai/checkup` | Position checkup vs opening thesis |
| `POST /api/ai/parse-trade` | Discord trade callout parser |
| `POST /api/ai/deep-dive` | Comprehensive scenario analysis |
| `POST /api/ai/ideas` | Generate trade ideas |
| `POST /api/ai/critique` | Review closed trades |
| `GET /api/ai/status` | Check Ollama availability |

### MoE (Mixture of Experts)
When user selects 32B model:
1. Runs 7B and 14B in parallel
2. Passes both opinions to 32B
3. 32B synthesizes as "judge"
4. Returns combined result with timing breakdown

**Code**: `callMoE()` function in `server.js` (~line 1600)

### Data Cache
60-second cache prevents AI getting different prices mid-analysis.
**Code**: `getTickerDataCached()` in `server.js`

---

## 📊 Key Data Structures

### Position Object
```javascript
{
    id: timestamp,
    chainId: timestamp,      // Links rolled positions
    ticker: 'PLTR',
    type: 'short_put',       // short_put | covered_call | buy_write | spread types
    strike: 75.00,
    premium: 2.50,
    contracts: 3,
    expiry: '2026-02-21',
    openDate: '2026-01-15',
    openingThesis: { ... },  // AI analysis at entry
    analysisHistory: [ ... ] // Checkups over time
}
```

### Holding Object (Stock Holdings)
```javascript
{
    id: timestamp,
    ticker: 'PLTR',
    sharesHeld: 300,
    costBasis: 75.00,        // Per share
    assignedFrom: positionId, // If from put assignment
    hasCoveredCall: true,
    coveredCallId: positionId
}
```

### Chain System
- `chainId` links rolled positions together
- Original position's `id` becomes `chainId` for the chain
- Use `hasRollHistory(pos)` to check if position has been rolled

---

## 🔧 Common Tasks

### Adding a New Dashboard Panel
1. Add HTML in `index.html` (in the dashboard row div)
2. Add update function in `js/portfolio.js`
3. Call from `refreshAllDashboards()`

### Adding an AI Endpoint
1. Add route in `server.js`
2. Build prompt with context
3. Call `callOllama()` or `callMoE()`
4. Handle SSE if streaming needed

### Modifying Position Display
1. Check `js/positions.js` for Positions table
2. Check `js/portfolio.js` for Closed Positions table
3. Both use similar `render*()` patterns

---

## 🐛 Debugging Tips

1. **AI not responding**: Check `GET /api/ai/status` - Ollama might be down
2. **Prices stale**: Clear cache in browser DevTools → Application → localStorage
3. **Position not saving**: Check browser console for localStorage errors
4. **Schwab sync issues**: Token expires; re-authenticate in Settings

---

## 📝 Code Patterns

### Adding to Portfolio.js
```javascript
// Export function for use elsewhere
export function myNewFunction() { ... }

// Attach to window for onclick handlers
window.myNewFunction = myNewFunction;
```

### Year Filter Pattern
```javascript
const yearFilter = state.closedYearFilter || new Date().getFullYear().toString();
const closed = yearFilter === 'all' 
    ? allClosed 
    : allClosed.filter(p => (p.closeDate || '').startsWith(yearFilter));
```

### Modal Pattern
```javascript
const modal = document.createElement('div');
modal.style.cssText = `position:fixed; top:0; left:0; right:0; bottom:0; 
    background:rgba(0,0,0,0.85); display:flex; align-items:center; 
    justify-content:center; z-index:10000;`;
modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
modal.innerHTML = `...`;
document.body.appendChild(modal);
```

---

## 🔐 User Preferences

Based on conversations with Greg:
- **Dislikes scrollbars** - Keep everything visible at once
- **Likes visual dashboards** - Charts, calendars, stat boxes
- **Prefers data-driven decisions** - Break-even indicators, opportunity cost
- **Uses AI for analysis** - But wants consistency (hence MoE)
- **Trades on Schwab** - Sync functionality is important

---

## 📚 Reference Files

- `.github/copilot-instructions.md` - Full architecture docs
- `CHANGELOG.md` - Release notes
- `TODO.md` - Feature backlog
- `README.md` - User documentation

---

## ✅ Pre-Handoff Checklist

- [x] All changes committed to git
- [x] Pushed to both `main` and `stable`
- [x] CHANGELOG updated with v1.10.0
- [x] No console errors in browser
- [x] Server runs without errors
- [x] All tests passing (manual verification)

---

*Last session ended with user wanting to test the new dashboard layout. Next session might continue with layout refinements or new feature requests.*
