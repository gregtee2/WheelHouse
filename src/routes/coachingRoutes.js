/**
 * coachingRoutes.js - API routes for the Trading Coach
 * 
 * Provides endpoints for:
 * - Viewing your pattern analysis (win rates, danger zones, sweet spots)
 * - Getting advice for a specific ticker/strategy combo
 * - Saving coaching insights from AI critiques
 * 
 * @module coachingRoutes
 */

const express = require('express');
const router = express.Router();

let CoachingService;

function init(deps) {
    CoachingService = deps.CoachingService;
}

/**
 * GET /api/coaching/patterns
 * Returns the full pattern analysis computed from closed positions
 * Body: { closedPositions: [...] }
 */
router.post('/patterns', (req, res) => {
    try {
        const { closedPositions } = req.body;
        if (!closedPositions || !Array.isArray(closedPositions)) {
            return res.status(400).json({ error: 'closedPositions array required' });
        }
        const report = CoachingService.getCoachingReport(closedPositions);
        res.json({ success: true, patterns: report });
    } catch (e) {
        console.error('[COACHING] Pattern analysis error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/coaching/advice
 * Get coaching advice for a specific ticker/strategy combo
 * Body: { closedPositions: [...], ticker: 'PLTR', positionType: 'short_put' }
 */
router.post('/advice', (req, res) => {
    try {
        const { closedPositions, ticker, positionType } = req.body;
        if (!closedPositions || !Array.isArray(closedPositions)) {
            return res.status(400).json({ error: 'closedPositions array required' });
        }
        if (!ticker) {
            return res.status(400).json({ error: 'ticker required' });
        }
        const advice = CoachingService.getAdvice(closedPositions, ticker, positionType);
        const context = CoachingService.buildCoachingContext(closedPositions, ticker, positionType);
        res.json({ success: true, advice, promptContext: context });
    } catch (e) {
        console.error('[COACHING] Advice error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/coaching/insight
 * Save a coaching insight (from AI critique or manual entry)
 * Body: { ticker, type, lesson, source, pnl }
 */
router.post('/insight', (req, res) => {
    try {
        const { ticker, type, lesson, source, pnl } = req.body;
        if (!lesson) {
            return res.status(400).json({ error: 'lesson text required' });
        }
        const insight = CoachingService.saveCoachingInsight({
            ticker: ticker || 'General',
            type: type || 'unknown',
            lesson,
            source: source || 'manual',
            pnl: pnl || 0
        });
        res.json({ success: true, insight });
    } catch (e) {
        console.error('[COACHING] Save insight error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/coaching/insights
 * Get all stored coaching insights
 */
router.get('/insights', (req, res) => {
    try {
        const insights = CoachingService.getCoachingInsights();
        res.json({ success: true, insights });
    } catch (e) {
        console.error('[COACHING] Get insights error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
