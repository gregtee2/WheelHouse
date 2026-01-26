/**
 * WisdomService.js - Trading Wisdom Vector RAG System
 * 
 * Provides semantic search for trading rules using embeddings.
 * Uses Ollama's nomic-embed-text model for vector generation.
 * 
 * @module WisdomService
 */

const fs = require('fs');
const path = require('path');

const WISDOM_FILE = path.join(__dirname, '../../wisdom.json');

// ═══════════════════════════════════════════════════════════════════════════
// WISDOM STORAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load wisdom data from JSON file
 * @returns {Object} Wisdom data with entries array
 */
function loadWisdom() {
    try {
        if (fs.existsSync(WISDOM_FILE)) {
            return JSON.parse(fs.readFileSync(WISDOM_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('[WISDOM] Error loading:', e.message);
    }
    return { version: 2, entries: [] };
}

/**
 * Save wisdom data to JSON file
 * @param {Object} data - Wisdom data to save
 */
function saveWisdom(data) {
    fs.writeFileSync(WISDOM_FILE, JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBEDDING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate embedding for text using Ollama's nomic-embed-text model
 * @param {string} text - Text to embed
 * @returns {number[]|null} Embedding vector or null on error
 */
async function generateEmbedding(text) {
    try {
        const response = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'nomic-embed-text',
                prompt: text
            })
        });
        
        if (!response.ok) {
            throw new Error(`Embedding API error: ${response.status}`);
        }
        
        const data = await response.json();
        return data.embedding;
    } catch (e) {
        console.log('[WISDOM] Embedding error:', e.message);
        return null;
    }
}

/**
 * Cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Similarity score (0-1)
 */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC SEARCH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Semantic search for relevant wisdom entries
 * Falls back to category matching if embeddings unavailable
 * 
 * @param {string} query - Search query
 * @param {string} positionType - Position type for category filtering
 * @param {number} topK - Number of results to return
 * @returns {Array<{entry: Object, score: number}>} Scored results
 */
async function searchWisdom(query, positionType, topK = 5) {
    const wisdomData = loadWisdom();
    if (!wisdomData.entries || wisdomData.entries.length === 0) {
        return [];
    }
    
    // Try semantic search first
    const queryEmbedding = await generateEmbedding(query);
    
    if (queryEmbedding) {
        // Score each entry by semantic similarity + category bonus
        const scored = wisdomData.entries.map(entry => {
            let score = 0;
            
            // Semantic similarity (if embedding exists)
            if (entry.embedding) {
                score = cosineSimilarity(queryEmbedding, entry.embedding);
            }
            
            // Category bonus (boost relevant categories)
            if (entry.appliesTo?.includes('all') || entry.appliesTo?.includes(positionType)) {
                score += 0.2; // 20% bonus for category match
            }
            if (positionType === 'buy_write' && entry.appliesTo?.includes('covered_call')) {
                score += 0.2;
            }
            
            return { entry, score };
        });
        
        // Sort by score and return top K
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK).filter(s => s.score > 0.3); // Minimum threshold
    }
    
    // Fallback: category matching (old behavior)
    console.log('[WISDOM] Falling back to category matching (no embeddings)');
    const relevant = wisdomData.entries.filter(w => 
        w.appliesTo?.includes('all') || 
        w.appliesTo?.includes(positionType) ||
        (positionType === 'buy_write' && w.appliesTo?.includes('covered_call'))
    );
    return relevant.slice(0, topK).map(entry => ({ entry, score: 0.5 }));
}

/**
 * Regenerate embeddings for all wisdom entries
 * @returns {number} Number of entries updated
 */
async function regenerateAllEmbeddings() {
    const wisdomData = loadWisdom();
    let updated = 0;
    
    for (const entry of wisdomData.entries) {
        const embedding = await generateEmbedding(entry.wisdom);
        if (embedding) {
            entry.embedding = embedding;
            updated++;
        }
    }
    
    if (updated > 0) {
        wisdomData.version = 2;
        saveWisdom(wisdomData);
        console.log(`[WISDOM] ✅ Regenerated ${updated} embeddings`);
    }
    
    return updated;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Storage
    loadWisdom,
    saveWisdom,
    
    // Embeddings
    generateEmbedding,
    cosineSimilarity,
    
    // Search
    searchWisdom,
    regenerateAllEmbeddings
};
