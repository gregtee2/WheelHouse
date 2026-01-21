# WheelHouse UI Redesign Plan

## 🎯 Vision: Position Command Center

**Problem**: Features are scattered across the UI, requiring users to jump between panels, modals, and sections to manage a single position.

**Solution**: Unified "Command Center" modal that opens when clicking any position row - all tools in one place with tabs.

---

## Current Pain Points

| Action | Current Location | Issue |
|--------|------------------|-------|
| View position details | Positions table row | Just a row, no detail view |
| Expert Analysis | Right panel | Only shows when position selected |
| AI Trade Advisor | Inside Expert panel | Buried, easy to miss |
| Roll Calculator | Left panel | Separate from analysis |
| Roll History | Popup modal | Click 🔗 button |
| AI Critique | Closed positions tab | Completely separate flow |
| Deep Dive | Another button somewhere | Disconnected |

**Result**: User clicks a lot, loses context, forgets what they were doing.

---

## Proposed: Unified Position Modal

```
┌─────────────────────────────────────────────────────────────────────┐
│ TSLL $17 Put · Feb 21, 2026 · 3 contracts                    [ X ] │
│ Current: $17.20 │ Premium: $0.82 │ P&L: +$150 (+25%)                │
├─────────────────────────────────────────────────────────────────────┤
│  [📊 Overview]  [🤖 AI Advisor]  [🔄 Rolls]  [📜 History]          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                     (Tab content appears here)                      │
│                                                                     │
│                                                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tab Breakdown

### 📊 Overview Tab
- Position metrics (strike, premium, DTE, contracts)
- Current market data (spot, bid/ask, IV)
- Expert Analysis verdict (ATM/ITM/OTM badge + recommendation)
- Quick action buttons: [Close Position] [Edit] [Duplicate]
- P&L chart (mini sparkline of position value over time)

### 🤖 AI Advisor Tab
- Model selector dropdown
- [Get Insight] button
- Current analysis display
- **Thesis History** section (NEW):
  - Timeline of past analyses with timestamps
  - Key metrics at time of each analysis (spot, IV, DTE)
  - AI comparison: "Since your last analysis on Jan 15..."
- [Save as Entry Thesis] button for new positions

### 🔄 Rolls Tab
- Roll Calculator (current left panel content)
- Risk Reduction suggestions
- Credit Roll suggestions
- What-if simulator: "If I roll to $X strike..."
- Side-by-side comparison mode

### 📜 History Tab
- Roll history timeline (if position was rolled)
- Chain visualization (all linked positions)
- Analysis history with diff view
- Key events: opened, rolled, adjusted, closed

---

## Implementation Phases

### Phase 1: Backend Prep (Current Session)
- [x] Fix AI endpoints (req.body issue)
- [x] Add larger model token scaling
- [ ] Add `analysisHistory` to position schema
- [ ] API to save/retrieve analysis history

### Phase 2: Thesis Tracking
- [ ] Save AI analysis with timestamp + market snapshot
- [ ] Feed previous analysis into AI prompt
- [ ] Show analysis timeline in UI
- [ ] "Thesis changed?" comparison feature

### Phase 3: Command Center Shell
- [ ] Create modal component
- [ ] Tab navigation system
- [ ] Migrate Overview content
- [ ] Wire up position click → modal

### Phase 4: Migrate Features
- [ ] Move Roll Calculator into Rolls tab
- [ ] Move AI Advisor into AI tab
- [ ] Move Roll History into History tab
- [ ] Retire old scattered UI elements

### Phase 5: Polish
- [ ] Keyboard navigation (arrow keys for tabs)
- [ ] Escape to close
- [ ] Remember last-used tab
- [ ] Mobile-friendly responsive layout

---

## Data Structure Changes

### Position Object Additions
```javascript
{
    // ... existing fields ...
    
    // NEW: Analysis tracking
    analysisHistory: [
        {
            id: 1737500000000,
            timestamp: '2026-01-15T14:30:00Z',
            model: 'qwen2.5:32b',
            recommendation: 'HOLD',
            insight: '...full AI response...',
            
            // Market snapshot at time of analysis
            snapshot: {
                spot: 18.50,
                iv: 95,
                dte: 14,
                delta: 0.35,
                riskPercent: 32.5
            }
        }
    ],
    
    // Optional: User's entry thesis (manual note)
    entryThesis: 'Bullish on TSLL post-earnings, expecting IV crush...',
    entryThesisDate: '2026-01-10T09:00:00Z'
}
```

### localStorage Changes
- `wheelhouse_positions` - Updated to include analysisHistory
- Need migration for existing positions (add empty analysisHistory array)

---

## UI/UX Principles

1. **One click to everything** - Position row click opens full context
2. **Don't hide the data** - Show key metrics always, drill down for details
3. **AI is a tool, not the answer** - Show analysis alongside raw data
4. **History matters** - Every action should be reviewable
5. **Escape hatch** - Always easy to close/back out

---

## Open Questions

1. **Mobile layout?** - Tabs might need to be a dropdown on small screens
2. **Multiple positions?** - Open multiple command centers, or one at a time?
3. **Keyboard traders?** - What shortcuts would power users want?
4. **Closed positions?** - Same command center, or simpler read-only view?

---

## Priority: What to Build First

**High Value, Low Effort:**
1. Thesis tracking (analysisHistory) - Backend ready, just needs UI
2. Command Center shell - Basic modal with tabs
3. Migrate AI Advisor to dedicated tab

**High Value, High Effort:**
4. Full Roll Calculator migration
5. History tab with timeline visualization

**Nice to Have:**
6. P&L sparkline charts
7. What-if roll simulator
8. Mobile responsive layout

---

*Created: January 21, 2026*
*Status: Planning*
