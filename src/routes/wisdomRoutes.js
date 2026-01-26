/**
 * Wisdom Routes - Trading wisdom vector RAG API endpoints
 * 
 * Endpoints:
 * - GET /api/wisdom - Get all wisdom entries
 * - POST /api/wisdom - Add new wisdom (AI extracts + generates embedding)
 * - DELETE /api/wisdom/:id - Delete a wisdom entry
 * - POST /api/wisdom/regenerate-embeddings - Regenerate all embeddings
 * - POST /api/wisdom/preview - Preview which wisdom applies to a position type
 */

const express = require('express');
const router = express.Router();

// Import services
const WisdomService = require('../services/WisdomService');
const AIService = require('../services/AIService');

const { loadWisdom, saveWisdom, generateEmbedding, regenerateAllEmbeddings } = WisdomService;
const { callAI } = AIService;

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/wisdom - Get all wisdom entries
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', (req, res) => {
    const wisdom = loadWisdom();
    res.json(wisdom);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/wisdom/regenerate-embeddings - Regenerate all embeddings
// ═══════════════════════════════════════════════════════════════════════════
router.post('/regenerate-embeddings', async (req, res) => {
    try {
        const updated = await regenerateAllEmbeddings();
        res.json({ success: true, updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/wisdom - Add new wisdom (AI processes the raw text + generates embedding)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
    try {
        const { raw, model } = req.body;
        if (!raw || raw.trim().length < 10) {
            return res.status(400).json({ error: 'Wisdom text too short' });
        }
        
        // AI extracts the wisdom
        const prompt = `Extract trading wisdom from this text. Return ONLY valid JSON, no markdown.

TEXT: "${raw}"

Return JSON format:
{
  "wisdom": "One clear sentence summarizing the advice",
  "category": "one of: rolling, short_puts, covered_calls, spreads, leaps, earnings, assignment, exit_rules, position_sizing, market_conditions, general",
  "appliesTo": ["array of position types this applies to, e.g. covered_call, short_put, long_call, etc. Use 'all' if general advice"]
}`;

        const response = await callAI(prompt, model || 'qwen2.5:7b', 200);
        
        // Parse AI response
        let parsed;
        try {
            // Extract JSON from response (handle markdown code blocks)
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in response');
            }
        } catch (e) {
            console.log('[WISDOM] AI parse error:', e.message, 'Response:', response);
            return res.status(500).json({ error: 'Failed to parse AI response', raw: response });
        }
        
        // Generate embedding for semantic search
        const embedding = await generateEmbedding(parsed.wisdom);
        
        // Create entry
        const entry = {
            id: Date.now(),
            raw: raw.trim(),
            wisdom: parsed.wisdom,
            category: parsed.category || 'general',
            appliesTo: parsed.appliesTo || ['all'],
            source: 'User input',
            added: new Date().toISOString().split('T')[0],
            embedding: embedding  // Store embedding for vector search
        };
        
        // Save to file
        const wisdom = loadWisdom();
        wisdom.entries.push(entry);
        wisdom.version = 2;
        saveWisdom(wisdom);
        
        console.log(`[WISDOM] ✅ Added: "${entry.wisdom}" (${entry.category})${embedding ? ' [with embedding]' : ''}`);
        res.json({ success: true, entry: { ...entry, embedding: undefined } }); // Don't send embedding to client
        
    } catch (e) {
        console.log('[WISDOM] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/wisdom/:id - Delete wisdom entry
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const wisdom = loadWisdom();
    wisdom.entries = wisdom.entries.filter(e => e.id !== id);
    saveWisdom(wisdom);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/wisdom/preview - Preview which wisdom applies to a position type
// ═══════════════════════════════════════════════════════════════════════════
router.post('/preview', (req, res) => {
    try {
        const { positionType } = req.body || {};
        const wisdomData = loadWisdom();
        
        const relevantWisdom = wisdomData.entries.filter(w => 
            w.appliesTo.includes('all') || 
            w.appliesTo.includes(positionType) ||
            (positionType === 'buy_write' && w.appliesTo.includes('covered_call')) ||
            (positionType === 'cash_secured_put' && w.appliesTo.includes('short_put'))
        );
        
        res.json({ 
            success: true,
            positionType,
            total: wisdomData.entries.length,
            matching: relevantWisdom.length,
            usedInPrompt: Math.min(relevantWisdom.length, 5),
            entries: relevantWisdom.map(w => ({
                category: w.category,
                wisdom: w.wisdom,
                appliesTo: w.appliesTo
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
