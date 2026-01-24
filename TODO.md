# WheelHouse - Feature Backlog & TODO

## 🚀 Planned Features

### Model Auto-Setup Wizard (First-Run Experience)
**Priority**: Medium  
**Added**: 2026-01-23

First-time users should get a guided setup for AI models:

1. **Detection**: Check `/api/ai/status` on app load → detect missing Ollama or models
2. **Setup Modal**: Show wizard with:
   - Ollama installation status + install guide link
   - DeepSeek-R1 32B download button with progress bar
   - Alternative: Grok cloud API key setup
   - "Skip for now" option
3. **Backend**: Add `POST /api/ai/pull` endpoint that streams `ollama pull` progress via SSE
4. **Persistence**: Store "setup complete" flag in localStorage to skip on future loads

**UI Mockup:**
```
┌─────────────────────────────────────────────────────┐
│  🧠 AI Setup Required                               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  WheelHouse uses local AI for trade analysis.       │
│                                                     │
│  ☐ Ollama (not installed)     [Install Guide]      │
│  ☐ DeepSeek-R1 32B (0/19GB)   [Download]           │
│                                                     │
│  Or use cloud AI instead:                           │
│  ○ Grok-3 (requires API key)  [Setup Grok]         │
│                                                     │
│            [Skip for now]  [Start Setup]           │
└─────────────────────────────────────────────────────┘
```

---

## ✅ Completed (Recent)

### 2026-01-23
- [x] Switch default AI to DeepSeek-R1-Distill-Qwen-32B (better quant reasoning)
- [x] Fix hardcoded `r=0.05` → use `state.rate` for consistency
- [x] Roll tips now reference real CBOE chain via "Suggest Roll" button
- [x] Chain-aware Win Rate Dashboard (counts chains, not legs)
- [x] Portfolio Summary aligned with Positions footer (Net Premium, Capital at Risk)
- [x] Removed redundant Performance panel

---

## 💡 Ideas (Not Yet Planned)

- Dividend yield support (q parameter) for high-yield stocks
- Dynamic VRAM detection for model recommendations
- Export trade history to CSV/Excel
- Mobile-responsive layout
- Dark/light theme toggle

