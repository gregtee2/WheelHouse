/**
 * autonomousRoutes.js — REST API for the Autonomous Trader
 * 
 * Endpoints:
 *   GET  /api/autonomous/status        — Full status (positions, metrics, equity curve)
 *   POST /api/autonomous/enable        — Enable the autonomous trader
 *   POST /api/autonomous/disable       — Disable (kill switch)
 *   POST /api/autonomous/run-phase     — Manually trigger a phase (1-5)
 *   POST /api/autonomous/close-trade   — Manually close a trade
 *   GET  /api/autonomous/trades        — Trade history
 *   GET  /api/autonomous/trades/open   — Open positions only
 *   GET  /api/autonomous/scans         — Market scan history
 *   GET  /api/autonomous/rules         — Learned rules
 *   POST /api/autonomous/rules         — Add a manual rule
 *   DELETE /api/autonomous/rules/:id   — Delete a rule
 *   GET  /api/autonomous/equity-curve  — Equity curve data
 *   GET  /api/autonomous/journal       — Trade journal (trades + reviews)
 *   GET  /api/autonomous/config        — Get all config
 *   POST /api/autonomous/config        — Update config
 *   GET  /api/autonomous/daily-summaries — Daily performance summaries
 */

const express = require('express');
const router = express.Router();

let AutonomousTrader, TraderDB;

function init(deps) {
    AutonomousTrader = deps.AutonomousTrader;
    TraderDB = deps.TraderDB;
}

// ────────────────────────────────────────────────────────────
// Status & Control
// ────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
    try {
        const status = AutonomousTrader.getStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/enable', (req, res) => {
    try {
        AutonomousTrader.enable();
        res.json({ success: true, message: 'Autonomous Trader enabled' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/disable', (req, res) => {
    try {
        AutonomousTrader.disable();
        res.json({ success: true, message: 'Autonomous Trader disabled' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual phase trigger
router.post('/run-phase', async (req, res) => {
    const { phase } = req.body;
    if (!phase || phase < 1 || phase > 5) {
        return res.status(400).json({ error: 'Phase must be 1-5' });
    }

    try {
        const result = await AutonomousTrader.runPhase(phase);
        res.json({ success: true, phase, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual trade close
router.post('/close-trade', async (req, res) => {
    const { tradeId, reason } = req.body;
    if (!tradeId) return res.status(400).json({ error: 'tradeId required' });

    try {
        const trade = await AutonomousTrader.manualClose(tradeId, reason || 'manual');
        res.json({ success: true, trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ────────────────────────────────────────────────────────────
// Trade Data
// ────────────────────────────────────────────────────────────

router.get('/trades', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const status = req.query.status;
        let trades;
        if (status === 'open') {
            trades = TraderDB.getOpenTrades();
        } else if (status === 'closed') {
            trades = TraderDB.getClosedTrades(limit);
        } else {
            trades = TraderDB.getAllTrades(limit);
        }
        res.json({ trades });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/trades/open', (req, res) => {
    try {
        const trades = TraderDB.getOpenTrades();
        res.json({ trades });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/trades/closed', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const trades = TraderDB.getClosedTrades(limit);
        res.json({ trades });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/trades/:id', (req, res) => {
    try {
        const trade = TraderDB.getTrade(parseInt(req.params.id));
        if (!trade) return res.status(404).json({ error: 'Trade not found' });
        
        // Include reviews
        const reviews = TraderDB.getTradeReviews(trade.id);
        res.json({ ...trade, reviews });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/trades/:id', (req, res) => {
    try {
        const trade = TraderDB.getTrade(parseInt(req.params.id));
        if (!trade) return res.status(404).json({ error: 'Trade not found' });
        TraderDB.deleteTrade(trade.id);
        res.json({ success: true, deleted: trade });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ────────────────────────────────────────────────────────────
// Market Scans
// ────────────────────────────────────────────────────────────

router.get('/scans', (req, res) => {
    try {
        // Get last 30 days of scans
        const scans = [];
        for (let i = 0; i < 30; i++) {
            const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const scan = TraderDB.getMarketScan(date);
            if (scan) scans.push(scan);
        }
        res.json(scans);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/scans/latest', (req, res) => {
    try {
        const scan = TraderDB.getLatestMarketScan();
        res.json(scan || { error: 'No scans yet' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ────────────────────────────────────────────────────────────
// Learned Rules
// ────────────────────────────────────────────────────────────

router.get('/rules', (req, res) => {
    try {
        const rules = TraderDB.getActiveRules();
        res.json(rules);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/rules', (req, res) => {
    const { ruleText, category } = req.body;
    if (!ruleText) return res.status(400).json({ error: 'ruleText required' });

    try {
        const id = TraderDB.insertLearnedRule({
            ruleText,
            category: category || 'manual',
            sourceTradeIds: [],
            confidence: 0.8 // Manual rules start with high confidence
        });
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/rules/:id', (req, res) => {
    try {
        // Soft delete — set active = 0
        TraderDB.updateRuleEffectiveness(parseInt(req.params.id), false);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ────────────────────────────────────────────────────────────
// Analytics
// ────────────────────────────────────────────────────────────

router.get('/equity-curve', (req, res) => {
    try {
        const curve = TraderDB.getEquityCurve();
        res.json(curve);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/metrics', (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const metrics = TraderDB.getPerformanceMetrics(days);
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/journal', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const trades = TraderDB.getAllTrades(limit);
        
        // Enrich with reviews
        const journal = trades.map(trade => {
            const reviews = TraderDB.getTradeReviews(trade.id);
            return { ...trade, reviews };
        });
        
        res.json(journal);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/daily-summaries', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 30;
        const summaries = TraderDB.getDailySummaries(limit);
        res.json(summaries);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
    try {
        const config = TraderDB.getAllConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/config', (req, res) => {
    try {
        const updates = req.body;
        const allowedKeys = [
            'paper_balance', 'max_positions', 'max_daily_risk_pct',
            'stop_loss_multiplier', 'profit_target_pct', 'min_dte', 'max_dte',
            'allowed_strategies', 'min_spread_width', 'blacklist_earnings_dte',
            'monitor_interval_sec', 'deepseek_model', 'grok_model'
        ];

        for (const [key, value] of Object.entries(updates)) {
            if (allowedKeys.includes(key)) {
                const storeValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                TraderDB.setConfig(key, storeValue);
            }
        }

        res.json({ success: true, config: TraderDB.getAllConfig() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
