// WheelHouse Server with CBOE Proxy and Settings API
// Serves static files AND proxies CBOE requests to avoid CORS

// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Initialize secure storage if running in Electron mode
const secureStore = require('./src/secureStore');
if (process.env.WHEELHOUSE_ENCRYPTION_KEY) {
    secureStore.initialize(process.env.WHEELHOUSE_ENCRYPTION_KEY);
    // Migrate any secrets from .env to secure storage (one-time)
    secureStore.migrateFromEnv();
}

// Import settings routes
const settingsRoutes = require('./src/routes/settingsRoutes');
const schwabRoutes = require('./src/routes/schwabRoutes');
const { schwabApiCall } = schwabRoutes; // For internal option chain calls

// ============================================================================
// CENTRALIZED MARKET DATA SERVICE
// All features should use this for consistent, reliable pricing
// ============================================================================
const MarketDataService = require('./src/services/MarketDataService');
MarketDataService.initialize(schwabApiCall);

const PORT = process.env.PORT || 8888;
const app = express();

// ============================================================================
// DATA CACHE - Ensures consistent pricing across AI features
// ============================================================================
const tickerDataCache = new Map();  // ticker → { data, timestamp }
const optionPremiumCache = new Map();  // "TICKER|STRIKE|EXPIRY|TYPE" → { data, timestamp }
const CACHE_TTL = 60000;  // 60 seconds - short enough to stay fresh, long enough for consistency

function getCacheKey(ticker, strike, expiry, optionType) {
    return `${ticker}|${strike}|${expiry}|${optionType}`;
}

function logCache(action, key, ageMs = null) {
    if (ageMs !== null) {
        console.log(`[CACHE] ${action}: ${key} (${Math.round(ageMs/1000)}s old)`);
    } else {
        console.log(`[CACHE] ${action}: ${key}`);
    }
}

// Parse JSON request bodies
app.use(express.json({ limit: '50mb' }));  // Large limit for image uploads

// CORS middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Mount settings API routes
app.use('/api/settings', settingsRoutes);

// Mount Schwab API routes
app.use('/api/schwab', schwabRoutes);

// ═══ TRADING WISDOM API (Vector RAG) ═══
const WISDOM_FILE = path.join(__dirname, 'wisdom.json');

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

function saveWisdom(data) {
    fs.writeFileSync(WISDOM_FILE, JSON.stringify(data, null, 2));
}

/**
 * Generate embedding for text using Ollama's nomic-embed-text model
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

/**
 * Semantic search for relevant wisdom entries
 * Falls back to category matching if embeddings unavailable
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

// Get all wisdom entries
app.get('/api/wisdom', (req, res) => {
    const wisdom = loadWisdom();
    res.json(wisdom);
});

// Regenerate all embeddings endpoint
app.post('/api/wisdom/regenerate-embeddings', async (req, res) => {
    try {
        const updated = await regenerateAllEmbeddings();
        res.json({ success: true, updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add new wisdom (AI processes the raw text + generates embedding)
app.post('/api/wisdom', async (req, res) => {
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

// Delete wisdom entry
app.delete('/api/wisdom/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const wisdom = loadWisdom();
    wisdom.entries = wisdom.entries.filter(e => e.id !== id);
    saveWisdom(wisdom);
    res.json({ success: true });
});

// Preview which wisdom applies to a position type
app.post('/api/wisdom/preview', (req, res) => {
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


// Get current version from package.json
function getLocalVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
}

// Get changelog content
function getChangelog() {
    try {
        return fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    } catch (e) {
        return '';
    }
}

// GPU Detection - Query nvidia-smi for VRAM info
function detectGPU() {
    try {
        // Query nvidia-smi for GPU name and memory
        const output = execSync('nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used --format=csv,noheader,nounits', {
            encoding: 'utf8',
            timeout: 5000
        }).trim();
        
        // Parse output: "NVIDIA GeForce RTX 4090, 24564, 20000, 4564"
        const lines = output.split('\n');
        const gpus = lines.map(line => {
            const parts = line.split(',').map(s => s.trim());
            return {
                name: parts[0],
                totalMB: parseInt(parts[1]) || 0,
                freeMB: parseInt(parts[2]) || 0,
                usedMB: parseInt(parts[3]) || 0,
                totalGB: ((parseInt(parts[1]) || 0) / 1024).toFixed(1),
                freeGB: ((parseInt(parts[2]) || 0) / 1024).toFixed(1),
                usedGB: ((parseInt(parts[3]) || 0) / 1024).toFixed(1)
            };
        });
        
        // Return primary GPU (first one)
        return {
            available: true,
            ...gpus[0],
            allGPUs: gpus
        };
    } catch (e) {
        // No nvidia-smi = no NVIDIA GPU or not installed
        return {
            available: false,
            name: 'No GPU detected',
            totalMB: 0,
            freeMB: 0,
            usedMB: 0,
            totalGB: '0',
            freeGB: '0',
            usedGB: '0',
            error: e.message
        };
    }
}

// Model VRAM requirements (approximate, for loading)
const MODEL_VRAM_REQUIREMENTS = {
    'qwen2.5:7b': { minGB: 5, recGB: 8, description: '7B parameters - Fast, good quality' },
    'qwen2.5:14b': { minGB: 10, recGB: 14, description: '14B parameters - Balanced' },
    'deepseek-r1:32b': { minGB: 20, recGB: 24, description: '32B parameters - Best quality, slow' },
    'deepseek-r1:32b': { minGB: 20, recGB: 24, description: '32B parameters - Best for quant/math reasoning' },
    'minicpm-v:latest': { minGB: 6, recGB: 8, description: 'Vision model - Image analysis' },
    'llava:7b': { minGB: 5, recGB: 8, description: 'Vision model - Image analysis' },
    'llava:13b': { minGB: 10, recGB: 14, description: 'Vision model - Better image analysis' }
};

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Main request handler (converted to Express middleware)
const mainHandler = async (req, res, next) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        
        // Skip if already handled by Express routes (like /api/settings)
        if (url.pathname.startsWith('/api/settings')) {
            return next();
        }
    
    // Proxy endpoint for CBOE options
    if (url.pathname.startsWith('/api/cboe/')) {
        const ticker = url.pathname.replace('/api/cboe/', '').replace('.json', '').toUpperCase();
        // Add cache-buster to defeat CDN/browser caching
        const cacheBuster = Date.now();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
        
        console.log(`[PROXY] Fetching CBOE options for ${ticker}...`);
        
        try {
            const data = await fetchJson(cboeUrl);
            // Send no-cache headers
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(JSON.stringify(data));
            console.log(`[PROXY] ✅ Returned ${data.data?.options?.length || 0} options for ${ticker}`);
        } catch (e) {
            console.log(`[PROXY] ❌ Failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // IV Data endpoint - Get ATM implied volatility for a ticker
    // Uses Schwab first (if authenticated), then CBOE fallback
    if (url.pathname.startsWith('/api/iv/')) {
        const ticker = url.pathname.replace('/api/iv/', '').replace('.json', '').toUpperCase();
        console.log(`[IV] Fetching IV data for ${ticker}...`);
        
        try {
            const ivData = await fetchTickerIVData(ticker);
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            });
            res.end(JSON.stringify(ivData));
            console.log(`[IV] ✅ ${ticker}: ATM IV=${ivData.atmIV}%, source=${ivData.source}`);
        } catch (e) {
            console.log(`[IV] ❌ Failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Proxy endpoint for Yahoo Finance earnings/calendar data (MUST come before generic /api/yahoo/)
    if (url.pathname.startsWith('/api/yahoo/calendar/')) {
        const ticker = url.pathname.replace('/api/yahoo/calendar/', '').replace('.json', '').toUpperCase();
        // Yahoo quoteSummary with calendarEvents module contains earnings and dividends
        const yahooUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents,earnings`;
        
        console.log(`[PROXY] Fetching Yahoo calendar for ${ticker}...`);
        
        try {
            const data = await fetchJson(yahooUrl);
            const summary = data.quoteSummary?.result?.[0] || {};
            const calendar = summary.calendarEvents || {};
            const earnings = summary.earnings || {};
            
            // Extract key dates
            const result = {
                ticker,
                // Next earnings date
                earningsDate: calendar.earnings?.earningsDate?.[0]?.raw 
                    ? new Date(calendar.earnings.earningsDate[0].raw * 1000).toISOString().split('T')[0]
                    : null,
                earningsDateEnd: calendar.earnings?.earningsDate?.[1]?.raw
                    ? new Date(calendar.earnings.earningsDate[1].raw * 1000).toISOString().split('T')[0]
                    : null,
                // Dividend dates
                exDividendDate: calendar.exDividendDate?.raw
                    ? new Date(calendar.exDividendDate.raw * 1000).toISOString().split('T')[0]
                    : null,
                dividendDate: calendar.dividendDate?.raw
                    ? new Date(calendar.dividendDate.raw * 1000).toISOString().split('T')[0]
                    : null,
                // Historical earnings for context
                earningsHistory: earnings.earningsChart?.quarterly || []
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            console.log(`[PROXY] ✅ ${ticker} earnings: ${result.earningsDate || 'N/A'}, ex-div: ${result.exDividendDate || 'N/A'}`);
        } catch (e) {
            console.log(`[PROXY] ❌ Yahoo calendar failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Proxy endpoint for Yahoo Finance stock prices
    if (url.pathname.startsWith('/api/yahoo/')) {
        const ticker = url.pathname.replace('/api/yahoo/', '').replace('.json', '').toUpperCase();
        const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        
        console.log(`[PROXY] Fetching Yahoo price for ${ticker}...`);
        
        try {
            const data = await fetchJson(yahooUrl);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
            console.log(`[PROXY] ✅ ${ticker} = $${price?.toFixed(2) || 'N/A'}`);
        } catch (e) {
            console.log(`[PROXY] ❌ Yahoo failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Update check endpoint - compares local version to GitHub
    if (url.pathname === '/api/update/check') {
        const localVersion = getLocalVersion();
        console.log(`[UPDATE] Checking for updates... (local: v${localVersion})`);
        
        try {
            // Fetch package.json from GitHub main branch
            const remoteUrl = 'https://raw.githubusercontent.com/gregtee2/WheelHouse/main/package.json';
            const remotePkg = await fetchJson(remoteUrl);
            const remoteVersion = remotePkg.version || '0.0.0';
            
            // Fetch changelog from GitHub
            let changelog = '';
            try {
                const changelogUrl = 'https://raw.githubusercontent.com/gregtee2/WheelHouse/main/CHANGELOG.md';
                changelog = await fetchText(changelogUrl);
            } catch (e) {
                changelog = '';
            }
            
            // Compare versions
            const updateAvailable = compareVersions(remoteVersion, localVersion) > 0;
            
            console.log(`[UPDATE] Remote: v${remoteVersion}, Update available: ${updateAvailable}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                updateAvailable,
                localVersion,
                remoteVersion,
                changelog
            }));
        } catch (e) {
            console.log(`[UPDATE] ❌ Check failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Update apply endpoint - runs git pull
    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
        console.log('[UPDATE] Applying update via git pull...');
        
        try {
            // Check if this is a git repo
            const isGitRepo = fs.existsSync(path.join(__dirname, '.git'));
            if (!isGitRepo) {
                throw new Error('Not a git repository. Please update manually.');
            }
            
            // Run git pull
            const result = execSync('git pull origin main', { 
                cwd: __dirname,
                encoding: 'utf8',
                timeout: 30000
            });
            
            console.log(`[UPDATE] ✅ Git pull result: ${result}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                message: result,
                newVersion: getLocalVersion()
            }));
        } catch (e) {
            console.log(`[UPDATE] ❌ Apply failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Get current version
    if (url.pathname === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: getLocalVersion() }));
        return;
    }
    
    // Restart server endpoint - properly kills old process before starting new one
    if (url.pathname === '/api/restart' && req.method === 'POST') {
        console.log('[SERVER] 🔄 Restart requested...');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Restarting...' }));
        
        // Give time for response to send, then exit (start.bat will handle restart)
        setTimeout(() => {
            console.log('[SERVER] Exiting for restart...');
            // On Windows, spawn a batch file that waits for this process to die, then starts a new one
            const restartScript = `
                @echo off
                timeout /t 2 /nobreak >nul
                for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8888 ^| findstr LISTENING 2^>nul') do (
                    taskkill /F /PID %%a >nul 2>&1
                )
                cd /d "${__dirname.replace(/\\/g, '\\\\')}"
                node server.js
            `.trim();
            
            // Write temp batch file
            const tempBat = path.join(__dirname, '.restart.bat');
            fs.writeFileSync(tempBat, restartScript);
            
            // Spawn detached and exit
            spawn('cmd', ['/c', tempBat], {
                cwd: __dirname,
                detached: true,
                stdio: 'ignore',
                shell: true
            }).unref();
            
            process.exit(0);
        }, 300);
        return;
    }
    
    // AI Trade Critique endpoint - analyze a closed trade's performance
    if (url.pathname === '/api/ai/critique' && req.method === 'POST') {
        try {
            const data = req.body;
            const selectedModel = data.model || 'deepseek-r1:32b'; // Use DeepSeek for quant reasoning
                console.log('[AI] Critiquing trade:', data.ticker, 'with model:', selectedModel);
                
                const prompt = buildCritiquePrompt(data);
                const response = await callAI(prompt, selectedModel, 500); // More tokens for detailed critique
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    critique: response,
                    model: selectedModel
                }));
                console.log('[AI] ✅ Critique complete');
        } catch (e) {
            console.log('[AI] ❌ Critique error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // AI STRATEGY ADVISOR - Analyzes all strategies for a ticker and recommends best
    // ═══════════════════════════════════════════════════════════════════════════
    if (url.pathname === '/api/ai/strategy-advisor' && req.method === 'POST') {
        try {
            const data = req.body;
            const { ticker, buyingPower, accountValue, kellyBase, riskTolerance, existingPositions, model } = data;
            const selectedModel = model || 'qwen2.5:32b';
            
            console.log(`[STRATEGY-ADVISOR] Analyzing ${ticker} with model ${selectedModel}`);
            console.log(`[STRATEGY-ADVISOR] Buying power from request: ${buyingPower} (type: ${typeof buyingPower})`);
            
            // =====================================================================
            // USE CENTRALIZED MarketDataService - single source of truth for pricing
            // =====================================================================
            
            // 1. Get stock quote
            const quote = await MarketDataService.getQuote(ticker);
            if (!quote) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Could not fetch price for ${ticker}` }));
                return;
            }
            
            console.log(`[STRATEGY-ADVISOR] ✅ Quote from ${quote.source}: $${quote.price}`);
            
            // 2. Get options chain - need wider strike range for spreads
            // strikeCount: 40 gives us ~$20 range on either side of ATM
            const chain = await MarketDataService.getOptionsChain(ticker, { strikeCount: 40, range: 'ALL' });
            
            let sampleOptions = [];
            let expirations = [];
            let ivRank = null;
            let dataSource = quote.source;
            
            if (chain) {
                expirations = chain.expirations.slice(0, 6);
                ivRank = chain.ivRank;
                dataSource = chain.source === quote.source ? chain.source : `${quote.source}+${chain.source}`;
                
                // Add option_type to each option BEFORE merging
                const callsWithType = (chain.calls || []).map(c => ({ ...c, option_type: 'C' }));
                const putsWithType = (chain.puts || []).map(p => ({ ...p, option_type: 'P' }));
                
                // Combine calls and puts
                const allOpts = [...callsWithType, ...putsWithType];
                console.log(`[STRATEGY-ADVISOR] Raw options from ${chain.source}: ${allOpts.length} total (${putsWithType.length} puts, ${callsWithType.length} calls)`);
                
                // TARGET: ~30 DTE for optimal theta decay
                const today = new Date();
                const targetDTE = 30;
                
                // DEDUPLICATE: Keep one option per (strike, type) combo, preferring ~30 DTE
                const optionsByKey = new Map();
                for (const opt of allOpts) {
                    const key = `${opt.option_type}_${opt.strike}`;
                    const expDate = new Date(opt.expiration);
                    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
                    
                    if (!optionsByKey.has(key)) {
                        optionsByKey.set(key, { ...opt, dte });
                    } else {
                        // Prefer option closer to target DTE (30 days)
                        const existing = optionsByKey.get(key);
                        if (Math.abs(dte - targetDTE) < Math.abs(existing.dte - targetDTE)) {
                            optionsByKey.set(key, { ...opt, dte });
                        }
                    }
                }
                
                // Convert back to array
                const uniqueOpts = Array.from(optionsByKey.values());
                console.log(`[STRATEGY-ADVISOR] Unique strikes: ${uniqueOpts.length} (after dedup by strike+type)`);
                
                // FILTER: Keep strikes within $15 of spot to ensure we have OTM for spreads
                // This is better than "closest 40" which clusters around ATM
                const strikeRange = 15; // $15 on each side
                const minStrike = quote.price - strikeRange;
                const maxStrike = quote.price + strikeRange;
                
                const inRangeOpts = uniqueOpts.filter(o => o.strike >= minStrike && o.strike <= maxStrike);
                console.log(`[STRATEGY-ADVISOR] In-range strikes ($${minStrike.toFixed(0)}-$${maxStrike.toFixed(0)}): ${inRangeOpts.length}`);
                
                // Sort by strike for easier debugging
                inRangeOpts.sort((a, b) => a.strike - b.strike);
                
                sampleOptions = inRangeOpts.map(o => ({
                    option_type: o.option_type,
                    strike: o.strike,
                    expiration_date: o.expiration,
                    bid: o.bid,
                    ask: o.ask,
                    delta: o.delta,
                    iv: o.iv,
                    dte: o.dte
                }));
                
                // Debug: show strike range we're using
                const putStrikes = sampleOptions.filter(o => o.option_type === 'P').map(o => o.strike).sort((a,b) => b-a);
                const callStrikes = sampleOptions.filter(o => o.option_type === 'C').map(o => o.strike).sort((a,b) => a-b);
                console.log(`[STRATEGY-ADVISOR] Put strikes: $${putStrikes[0] || '?'} down to $${putStrikes[putStrikes.length-1] || '?'} (${putStrikes.length} total)`);
                console.log(`[STRATEGY-ADVISOR] Call strikes: $${callStrikes[0] || '?'} up to $${callStrikes[callStrikes.length-1] || '?'} (${callStrikes.length} total)`);
                
                console.log(`[STRATEGY-ADVISOR] ✅ Using ${sampleOptions.length} unique options for analysis, IV ~${ivRank}%`);
            } else {
                console.log(`[STRATEGY-ADVISOR] ⚠️ No options data available for ${ticker}`);
            }
            
            // 3. Build context for AI
            const stockData = {
                price: quote.price,
                change: quote.change,
                changePercent: quote.changePercent,
                high52: quote.high52,
                low52: quote.low52,
                high3mo: quote.high3mo,
                low3mo: quote.low3mo,
                volume: quote.volume,
                rangePosition: quote.rangePosition
            };
            
            const context = {
                ticker,
                spot: quote.price,
                stockData,
                ivRank,
                expirations,
                sampleOptions: sampleOptions, // All options in range (already filtered to ±$15 of spot)
                buyingPower: buyingPower || 25000,
                accountValue: accountValue || null,    // For prop desk context
                kellyBase: kellyBase || null,          // For prop desk sizing display
                riskTolerance: riskTolerance || 'moderate',
                existingPositions: existingPositions || [],
                dataSource
            };
            
            // 4. Build AI prompt (returns { prompt, calculatedValues })
            const { prompt, calculatedValues } = buildStrategyAdvisorPrompt(context);
            
            // Debug: Show what strikes we're sending to AI
            if (context.sampleOptions?.length > 0) {
                const strikes = context.sampleOptions.map(o => `$${o.strike}`).slice(0, 5);
                console.log(`[STRATEGY-ADVISOR] Sending strikes to AI: ${strikes.join(', ')}...`);
            } else {
                console.log(`[STRATEGY-ADVISOR] ⚠️ No options data being sent to AI!`);
            }
            
            // DEBUG: Log first 1000 chars of prompt to verify template interpolation
            console.log(`[STRATEGY-ADVISOR] Prompt preview (first 1000 chars):`);
            console.log(prompt.slice(0, 1000));
            console.log(`[STRATEGY-ADVISOR] ...prompt continues for ${prompt.length} total chars`);
            
            // 5. Call AI
            console.log(`[STRATEGY-ADVISOR] Calling AI for recommendation...`);
            let aiResponse = await callAI(prompt, selectedModel, 2000);
            
            // =====================================================================
            // POST-PROCESSING #1: Fix math hallucinations (AI concatenating numbers)
            // The AI sees "$94 strike" and "$1,362 profit" and outputs "$94,362"
            // We know the CORRECT values, so we replace any obviously wrong amounts
            // =====================================================================
            const cv = calculatedValues;
            
            // Log what we expect to see
            console.log(`[STRATEGY-ADVISOR] 🔢 Post-processing - Expected values:`);
            console.log(`  Total Max Profit: $${cv.totalPutMaxProfit.toLocaleString()}`);
            console.log(`  Total Max Loss: $${cv.totalPutMaxLoss.toLocaleString()}`);
            console.log(`  Total Buying Power: $${cv.totalBuyingPower.toLocaleString()}`);
            
            // =====================================================================
            // NUCLEAR MATH FIX: Replace ANY obviously wrong dollar amounts
            // The AI hallucinates numbers like $94,365, $199,365, $500,035
            // Our actual totals are always < $10,000 for this account size
            // =====================================================================
            
            // Debug: Log a sample of the AI response to see what we're working with
            const profitLine = aiResponse.match(/(Total\s+)?Max Profit[^\n]{0,80}/gi);
            const lossLine = aiResponse.match(/(Total\s+)?Max Loss[^\n]{0,80}/gi);
            console.log(`[STRATEGY-ADVISOR] 🔍 Found profit lines: ${JSON.stringify(profitLine)}`);
            console.log(`[STRATEGY-ADVISOR] 🔍 Found loss lines: ${JSON.stringify(lossLine)}`);
            
            // More aggressive pattern: Any dollar amount with 5+ digits (with or without comma)
            // Matches: $94365, $94,365, $199365, $199,365, $500035, $500,035
            const largeNumber = /\$\d{2,3},?\d{3}/g;
            
            // Count hallucinations before fixing
            const allLargeNumbers = aiResponse.match(largeNumber) || [];
            console.log(`[STRATEGY-ADVISOR] 🔍 Large numbers found: ${JSON.stringify(allLargeNumbers)}`);
            
            // =====================================================================
            // TRULY NUCLEAR: Fix ALL profit/loss amounts regardless of format
            // Order matters! Fix doubled numbers FIRST, then specific patterns
            // =====================================================================
            
            // DEBUG: Log what we're working with in P/L table area
            const plTableMatch = aiResponse.match(/\|\s*\$?\d+[^\n]*\|[^\n]*\|/g);
            if (plTableMatch) {
                console.log(`[STRATEGY-ADVISOR] 📋 P/L table rows found: ${JSON.stringify(plTableMatch.slice(0, 3))}`);
            }
            
            // STEP 0: Fix doubled numbers (like "1,365,365" or "$1,365,365")
            // Pattern: X,YYY,YYY where YYY repeats
            aiResponse = aiResponse.replace(/\$?(\d{1,3}),(\d{3}),\2(?!\d)/g, (match, first, second) => {
                console.log(`[STRATEGY-ADVISOR] 🔧 Fixed doubled number: ${match} → $${first},${second}`);
                return `$${first},${second}`;
            });
            
            // STEP 0b: NUCLEAR - Any 7-digit number pattern X,XXX,XXX is wrong
            aiResponse = aiResponse.replace(/(\+|-)\s*\$?(\d),(\d{3}),(\d{3})(?!\d)/g, (match, sign, d1, d2, d3) => {
                const correctVal = sign === '+' ? cv.totalPutMaxProfit : cv.totalPutMaxLoss;
                console.log(`[STRATEGY-ADVISOR] 🔧 Fixed 7-digit P/L: ${match} → ${sign}$${correctVal.toLocaleString()}`);
                return `${sign}$${correctVal.toLocaleString()}`;
            });
            
            // STEP 1: Fix "Total Max Profit:" and "Max Profit:" - handle both patterns
            // CRITICAL: Use callback function, NOT string replacement!
            // String replacement interprets $1 in "$1,365" as a backreference!
            const maxProfitStr = `$${cv.totalPutMaxProfit.toLocaleString()}`;
            const maxLossStr = `$${cv.totalPutMaxLoss.toLocaleString()}`;
            
            aiResponse = aiResponse.replace(/(Total\s+)?Max\s*Profit[:\s]*\$?[\d,]+/gi, 
                () => `Max Profit: ${maxProfitStr}`);
            
            // STEP 2: Fix "Total Max Loss:" and "Max Loss:"
            aiResponse = aiResponse.replace(/(Total\s+)?Max\s*Loss[:\s]*\$?[\d,]+/gi,
                () => `Max Loss: ${maxLossStr}`);
            
            // STEP 3: Fix "TOTAL Max Profit:" (all caps variant)
            aiResponse = aiResponse.replace(/TOTAL\s+Max\s*Profit[:\s]*\$?[\d,]+/gi, 
                () => `TOTAL Max Profit: ${maxProfitStr}`);
            aiResponse = aiResponse.replace(/TOTAL\s+Max\s*Loss[:\s]*\$?[\d,]+/gi,
                () => `TOTAL Max Loss: ${maxLossStr}`);
            
            // STEP 4: Fix P&L table rows with + prefix (any large number = total)
            // CRITICAL: Use callback function to avoid $1 backreference interpretation
            aiResponse = aiResponse.replace(/\+\s*\$?(\d{1,3},\d{3}(?:,\d{3})?|\d{4,})/g, 
                () => `+${maxProfitStr}`);
            
            // STEP 5: Fix P&L table rows with - prefix  
            aiResponse = aiResponse.replace(/-\s*\$?(\d{1,3},\d{3}(?:,\d{3})?|\d{4,})/g, 
                () => `-${maxLossStr}`);
            
            // STEP 6: Fix the "(X contracts × $Y)" parenthetical - recalculate total
            aiResponse = aiResponse.replace(
                /\$?[\d,]+\s*\((\d+)\s*contracts\s*[×x]\s*\$(\d+)\)/gi,
                (match, contracts, perContract) => {
                    const numContracts = parseInt(contracts);
                    const perContractVal = parseInt(perContract);
                    const correctTotal = (numContracts * perContractVal).toLocaleString();
                    return `$${correctTotal} (${contracts} contracts × $${perContract})`;
                }
            );
            
            // Count remaining after fix
            const remainingNumbers = aiResponse.match(largeNumber) || [];
            if (remainingNumbers.length > 0) {
                console.log(`[STRATEGY-ADVISOR] ⚠️ ${remainingNumbers.length} large dollar amounts remain: ${JSON.stringify(remainingNumbers)}`);

            } else if (allLargeNumbers.length > 0) {
                console.log(`[STRATEGY-ADVISOR] ✅ Fixed ${allLargeNumbers.length} hallucinated dollar amounts`);
            }
            
            console.log(`[STRATEGY-ADVISOR] ✅ Math post-processing complete`);
            
            // =====================================================================
            // POST-PROCESSING #2: Fix AI hallucinations where it outputs "$1" for everything
            // This is a known issue with some models (DeepSeek-R1, Grok) that replace
            // dollar amounts with "$1" placeholder
            // =====================================================================
            
            // Calculate the values we SHOULD see in the output
            const puts = context.sampleOptions?.filter(o => o.option_type === 'P') || [];
            const calls = context.sampleOptions?.filter(o => o.option_type === 'C') || [];
            const atmPut = puts.find(p => parseFloat(p.strike) <= quote.price) || puts[0];
            const atmCall = calls.find(c => parseFloat(c.strike) >= quote.price) || calls[0];
            
            const sellPutStrike = atmPut ? parseFloat(atmPut.strike).toFixed(0) : Math.floor(quote.price);
            const buyPutStrike = Math.floor(quote.price - 5);
            const sellCallStrike = atmCall ? parseFloat(atmCall.strike).toFixed(0) : Math.ceil(quote.price);
            const buyCallStrike = Math.ceil(quote.price + 5);
            const premium = atmPut ? ((parseFloat(atmPut.bid) + parseFloat(atmPut.ask)) / 2).toFixed(2) : '2.50';
            const spreadWidth = 5;
            const stockPrice = quote.price.toFixed(0);
            
            // Count how many standalone "$1" appear (not $1.xx which is valid premium)
            // Pattern: $1 NOT followed by digit or decimal point
            const dollarOneCount = (aiResponse.match(/\$1(?![0-9.])/g) || []).length;
            
            // If the stock is > $10 and we see standalone "$1", it's likely a hallucination
            const stockIsExpensive = quote.price > 10;
            const shouldFix = stockIsExpensive && dollarOneCount >= 1;
            
            if (dollarOneCount > 0) {
                console.log(`[STRATEGY-ADVISOR] ⚠️ Detected ${dollarOneCount} standalone "$1" - applying fixes (using $${sellPutStrike}/$${buyPutStrike} spreads)`);
            }
            
            if (shouldFix) {
                console.log(`[STRATEGY-ADVISOR] ⚠️ Detected ${dollarOneCount} "$1" hallucinations - applying fixes (using $${sellPutStrike}/$${buyPutStrike} spreads)`);
                
                // NUCLEAR OPTION: Replace ALL standalone "$1" with appropriate values
                // CRITICAL: All patterns must use (?![0-9.,]) to NOT match $1,365 or $1.50!
                
                // Replace spread patterns first (most specific)
                aiResponse = aiResponse.replace(/\$1\s*\/\s*\$1\s+Put\s+Spread/gi, `$${sellPutStrike}/$${buyPutStrike} Put Spread`);
                aiResponse = aiResponse.replace(/\$1\s*\/\s*\$1\s+Call\s+Spread/gi, `$${sellCallStrike}/$${buyCallStrike} Call Spread`);
                
                // Replace "Sell [TICKER] $1" patterns - use (?![0-9.,]) to protect $1,xxx
                aiResponse = aiResponse.replace(new RegExp(`Sell\\s+${ticker}\\s+\\$1(?![0-9.,])`, 'gi'), `Sell ${ticker} $${sellPutStrike}`);
                
                // Replace premium patterns (these should stay small)
                aiResponse = aiResponse.replace(/~\$1\/share/gi, `~$${premium}/share`);
                aiResponse = aiResponse.replace(/\$1\/share/gi, `$${premium}/share`);
                aiResponse = aiResponse.replace(/\$1\s+per\s+share/gi, `$${premium} per share`);
                aiResponse = aiResponse.replace(/\$1\s+credit/gi, `$${premium} credit`);
                
                // Replace buying power references
                aiResponse = aiResponse.replace(/\$1k\s+buying\s+power/gi, `$25,000 buying power`);
                aiResponse = aiResponse.replace(/\$1k\s+of\s+buying/gi, `$25,000 of buying`);
                // REMOVED: /\$1,000/g pattern - it was matching valid amounts like $1,365!
                aiResponse = aiResponse.replace(/\$1k(?![0-9.,])/gi, `$25,000`);
                
                // Replace strike references - use (?![0-9.,]) to protect $1,xxx
                aiResponse = aiResponse.replace(/\$1\s+strike/gi, `$${sellPutStrike} strike`);
                aiResponse = aiResponse.replace(/\$1\s+put(?![0-9.,])/gi, `$${sellPutStrike} put`);
                aiResponse = aiResponse.replace(/\$1\s+call(?![0-9.,])/gi, `$${sellCallStrike} call`);
                
                // Replace price references - use (?![0-9.,]) to protect $1,xxx
                aiResponse = aiResponse.replace(/price\s+of\s+\$1(?![0-9.,])/gi, `price of $${stockPrice}`);
                aiResponse = aiResponse.replace(/above\s+\$1(?![0-9.,])/gi, `above $${sellPutStrike}`);
                aiResponse = aiResponse.replace(/below\s+\$1(?![0-9.,])/gi, `below $${buyPutStrike}`);
                
                // REMOVED: Max Profit/Loss patterns - STEP 1-3 already fixed these correctly!
                // These patterns were matching $1,365 and corrupting it because (?!\d) 
                // doesn't exclude commas!
                
                // Replace breakeven calculations - use (?![0-9.,]) to protect $1,xxx
                const breakeven = (parseFloat(sellPutStrike) - parseFloat(premium)).toFixed(2);
                aiResponse = aiResponse.replace(/Breakeven:\s+\$1(?![0-9.,])/gi, `Breakeven: $${breakeven}`);
                
                // FINAL NUCLEAR PASS: Replace any remaining standalone $1 with stock price
                // Pattern: $1 NOT followed by digit, decimal point, OR COMMA
                aiResponse = aiResponse.replace(/\$1(?![0-9.,])/g, `$${stockPrice}`);
                
                // Count remaining standalone $1 instances (for sanity check)
                // Use same pattern - exclude valid $1.xx AND $1,xxx prices
                const remainingCount = (aiResponse.match(/\$1(?![0-9.,])/g) || []).length;
                if (remainingCount > 0) {
                    console.log(`[STRATEGY-ADVISOR] ⚠️ ${remainingCount} standalone "$1" remain after fixes`);
                } else {
                    console.log(`[STRATEGY-ADVISOR] ✅ All standalone "$1" corrected`);
                }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                ticker,
                spot: quote.price,
                stockData,
                ivRank,
                expirations,
                dataSource,
                recommendation: aiResponse,
                model: selectedModel
            }));
            
            console.log(`[STRATEGY-ADVISOR] ✅ Analysis complete for ${ticker}`);
            
        } catch (e) {
            console.log('[STRATEGY-ADVISOR] ❌ Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Trade Idea Generator endpoint
    if (url.pathname === '/api/ai/ideas' && req.method === 'POST') {
        try {
            const data = req.body;
                const selectedModel = data.model || 'qwen2.5:14b';
                const xTrendingTickers = data.xTrendingTickers || [];
                console.log('[AI] Generating trade ideas with model:', selectedModel);
                if (xTrendingTickers.length > 0) {
                    console.log('[AI] Including X trending tickers:', xTrendingTickers.join(', '));
                }
                
                // Fetch real prices for wheel candidates
                const buyingPower = data.buyingPower || 25000;
                const excludeTickers = data.excludeTickers || [];
                const realPrices = await fetchWheelCandidatePrices(buyingPower, excludeTickers);
                
                // Fetch prices for X trending tickers if provided
                let xTickerPrices = [];
                if (xTrendingTickers.length > 0) {
                    const xPricePromises = xTrendingTickers.map(async (ticker) => {
                        try {
                            const quoteRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`);
                            if (quoteRes.ok) {
                                const data = await quoteRes.json();
                                const result = data.chart?.result?.[0];
                                if (result?.meta?.regularMarketPrice) {
                                    const price = result.meta.regularMarketPrice;
                                    const prevClose = result.meta.previousClose || price;
                                    const highs = result.indicators?.quote?.[0]?.high || [];
                                    const lows = result.indicators?.quote?.[0]?.low || [];
                                    const monthHigh = Math.max(...highs.filter(h => h));
                                    const monthLow = Math.min(...lows.filter(l => l));
                                    const monthChange = prevClose ? ((price - prevClose) / prevClose * 100).toFixed(1) : 0;
                                    const rangePosition = monthHigh - monthLow > 0 ? Math.round((price - monthLow) / (monthHigh - monthLow) * 100) : 50;
                                    
                                    return {
                                        ticker,
                                        price: price.toFixed(2),
                                        monthLow: monthLow?.toFixed(2) || price.toFixed(2),
                                        monthHigh: monthHigh?.toFixed(2) || price.toFixed(2),
                                        monthChange,
                                        rangePosition,
                                        sector: '🔥 X Trending'
                                    };
                                }
                            }
                        } catch (e) {
                            console.log(`[AI] Failed to fetch X ticker ${ticker}:`, e.message);
                        }
                        return null;
                    });
                    xTickerPrices = (await Promise.all(xPricePromises)).filter(p => p !== null);
                    console.log(`[AI] Fetched ${xTickerPrices.length} X ticker prices`);
                }
                
                // Combine: X trending first, then regular candidates
                const allCandidates = [...xTickerPrices, ...realPrices];
                
                const prompt = buildIdeaPrompt(data, allCandidates, xTrendingTickers);
                const response = await callAI(prompt, selectedModel, 1500); // More tokens for 10 ideas
                
                // Count discovery sources
                const discoveredCount = realPrices.filter(p => p.sector === 'Active Today' || p.sector === 'Trending').length;
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    ideas: response,
                    model: selectedModel,
                    candidatesChecked: allCandidates.length,
                    discoveredCount: discoveredCount,
                    xTrendingCount: xTickerPrices.length,
                    candidates: allCandidates // Include data for deep-dive
                }));
                console.log(`[AI] ✅ Ideas generated (${allCandidates.length} candidates, ${discoveredCount} from discovery, ${xTickerPrices.length} from X)`);
        } catch (e) {
            console.log('[AI] ❌ Ideas error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Generic Grok prompt endpoint - for any custom prompt using Grok
    if (url.pathname === '/api/ai/grok' && req.method === 'POST') {
        try {
            const { prompt, maxTokens } = req.body;
            
            if (!process.env.GROK_API_KEY) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Grok API key not configured. Add in Settings.' }));
                return;
            }
            
            console.log('[AI] Grok custom prompt request...');
            const response = await callGrok(prompt, 'grok-3', maxTokens || 800);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                insight: response,
                source: 'grok-3'
            }));
            console.log('[AI] ✅ Grok custom prompt complete');
        } catch (e) {
            console.log('[AI] ❌ Grok error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // X/Twitter Sentiment - Grok-only feature using real-time X access
    if (url.pathname === '/api/ai/x-sentiment' && req.method === 'POST') {
        try {
            const data = req.body;
            const { buyingPower, holdings } = data;
            
            // This ONLY works with Grok (has X access)
            if (!process.env.GROK_API_KEY) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'X Sentiment requires Grok API. Configure in Settings.' }));
                return;
            }
            
            console.log('[AI] 🔥 Fetching X/Twitter sentiment via Grok...');
            
            // Get current date for prompt
            const today = new Date();
            const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            
            // Build holdings context if provided
            let holdingsContext = '';
            if (holdings && holdings.length > 0) {
                const holdingsList = holdings.map(h => `${h.ticker} (${h.shares || h.quantity || 100} shares @ $${h.costBasis || h.avgCost || '?'})`).join(', ');
                holdingsContext = `

**IMPORTANT - CHECK MY HOLDINGS FIRST:**
I currently hold these stocks: ${holdingsList}

BEFORE the main analysis, check if there's ANY news, sentiment, or buzz on X about my holdings. Put this in a section called "⚡ YOUR HOLDINGS ALERT" at the very top. If nothing notable, just say "No significant X chatter about your holdings today."
`;
            }
            
            const prompt = `Today is ${dateStr}. You have real-time access to X (Twitter). I'm a wheel strategy options trader with $${buyingPower || 25000} buying power.
${holdingsContext}
Scan X/Twitter RIGHT NOW and find me:

1. **🔥 TRENDING TICKERS** - What stocks are traders actively discussing today? Look for unusual volume mentions, breakout alerts, or momentum plays.

2. **📢 EARNINGS PLAYS** - Any upcoming earnings that FinTwit is buzzing about? Stocks where people expect big moves? Include the ACTUAL earnings date if mentioned.

3. **⚠️ CAUTION FLAGS** - Any stocks where sentiment has turned negative? Shorts piling in? Bad news circulating?

4. **💰 PUT SELLING OPPORTUNITIES** - Based on X chatter, which stocks might be good for selling puts? Look for stocks that got beaten down but sentiment is turning, or stable stocks with elevated IV from news.

5. **🚀 SECTOR MOMENTUM** - What sectors are traders most bullish/bearish on today based on X discussion?

FORMAT each ticker mention like: **TICKER** @ $XX.XX (if you know the price)

Be specific about WHAT you're seeing on X - quote tweets if relevant, mention influencers if they're driving discussion. I want the "street feel" that only live X access can provide.

Focus on wheel-friendly stocks ($5-$200 range, liquid options, not meme garbage). Use current ${today.getFullYear()} dates for any earnings or events.`;

            const response = await callGrok(prompt, 'grok-3', 1500);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                sentiment: response,
                source: 'grok-x-realtime',
                timestamp: new Date().toISOString()
            }));
            console.log('[AI] ✅ X sentiment retrieved');
        } catch (e) {
            console.log('[AI] ❌ X sentiment error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Deep Dive - comprehensive analysis of a single trade idea
    if (url.pathname === '/api/ai/deep-dive' && req.method === 'POST') {
        try {
            const data = req.body;
                const { ticker, strike, expiry, currentPrice, model, positionType } = data;
                const selectedModel = model || 'deepseek-r1:32b'; // Use DeepSeek for quant analysis
                
                // Determine option type from position type
                const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
                const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
                const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
                
                console.log(`[AI] Deep dive on ${ticker} $${strike} ${optionType.toLowerCase()}, expiry ${expiry}`);
                
                // Fetch extended data for this ticker
                const tickerData = await fetchDeepDiveData(ticker);
                
                // Fetch actual option premium from CBOE
                const premium = await fetchOptionPremium(ticker, parseFloat(strike), expiry, optionType);
                if (premium) {
                    tickerData.premium = premium;
                    console.log(`[CBOE] Found premium: bid=$${premium.bid} ask=$${premium.ask} IV=${premium.iv}%`);
                }
                
                const prompt = buildDeepDivePrompt(data, tickerData);
                const response = await callAI(prompt, selectedModel, 1000); // More tokens for deep analysis
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    analysis: response,
                    model: selectedModel,
                    tickerData: tickerData,
                    premium: premium
                }));
                console.log('[AI] ✅ Deep dive complete');
        } catch (e) {
            console.log('[AI] ❌ Deep dive error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Position Checkup endpoint - compares opening thesis to current state
    if (url.pathname === '/api/ai/checkup' && req.method === 'POST') {
        try {
            const data = req.body;
                const { ticker, strike, expiry, openingThesis, positionType, model } = data;
                const selectedModel = model || 'qwen2.5:7b';
                
                // Determine option type from position type
                const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
                const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
                const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
                
                console.log(`[AI] Position checkup for ${ticker} $${strike} ${optionType.toLowerCase()}`);
                
                // Fetch current data for comparison
                const currentData = await fetchDeepDiveData(ticker);
                const currentPremium = await fetchOptionPremium(ticker, parseFloat(strike), formatExpiryForCBOE(expiry), optionType);
                
                // Build comparison prompt
                const prompt = buildCheckupPrompt(data, openingThesis, currentData, currentPremium);
                const response = await callAI(prompt, selectedModel, 800);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    checkup: response,
                    model: selectedModel,
                    currentData,
                    currentPremium
                }));
                console.log('[AI] ✅ Checkup complete');
        } catch (e) {
            console.log('[AI] ❌ Checkup error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Parse & Analyze Discord Trade Callout (with SSE progress)
    if (url.pathname === '/api/ai/parse-trade' && req.method === 'POST') {
        // Check if client wants streaming progress
        const acceptsSSE = req.headers.accept?.includes('text/event-stream');
        
        // Helper to send SSE progress
        const sendProgress = (step, message, data = {}) => {
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify({ type: 'progress', step, message, ...data })}\n\n`);
            }
            console.log(`[AI] Step ${step}: ${message}`);
        };
        
        try {
            const { tradeText, model } = req.body;
            const selectedModel = model || 'qwen2.5:7b';
            
            // Set up SSE headers if streaming
            if (acceptsSSE) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
            }
                
                sendProgress(1, `Loading ${selectedModel}...`, { total: 4 });
                
                // Step 1: Use AI to parse the trade text into structured data
                const parsePrompt = buildTradeParsePrompt(tradeText);
                sendProgress(1, `Parsing trade callout with ${selectedModel}...`);
                const parsedJson = await callAI(parsePrompt, selectedModel, 500);
                
                // Try to extract JSON from the response
                let parsed;
                try {
                    // Look for JSON in the response
                    const jsonMatch = parsedJson.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        parsed = JSON.parse(jsonMatch[0]);
                    } else {
                        throw new Error('No JSON found in parse response');
                    }
                } catch (parseErr) {
                    console.log('[AI] Parse extraction failed:', parseErr.message);
                    console.log('[AI] Raw response:', parsedJson.substring(0, 200));
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: 'Could not parse trade format. Try a clearer format like: Ticker: XYZ, Strike: $100, Expiry: Feb 21' 
                    }));
                    return;
                }
                
                console.log('[AI] Parsed trade:', JSON.stringify(parsed));
                
                // Validate required fields
                if (!parsed.ticker) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Could not identify ticker symbol' }));
                    return;
                }
                
                // Fix spread strikes if AI parsed them backwards
                // For CREDIT spreads (bull put, bear call): sellStrike should be closer to current price
                // For DEBIT spreads: buyStrike should be closer to current price
                if (parsed.buyStrike && parsed.sellStrike) {
                    const buy = parseFloat(parsed.buyStrike);
                    const sell = parseFloat(parsed.sellStrike);
                    const strategy = parsed.strategy?.toLowerCase() || '';
                    
                    // Bull put spread: sell higher strike, buy lower strike (credit)
                    if (strategy.includes('bull') && strategy.includes('put')) {
                        if (sell < buy) {
                            console.log('[AI] Fixing bull put spread strikes (sellStrike should be > buyStrike)');
                            parsed.sellStrike = Math.max(buy, sell);
                            parsed.buyStrike = Math.min(buy, sell);
                        }
                    }
                    // Bear call spread: sell lower strike, buy higher strike (credit)
                    else if (strategy.includes('bear') && strategy.includes('call')) {
                        if (sell > buy) {
                            console.log('[AI] Fixing bear call spread strikes (sellStrike should be < buyStrike)');
                            parsed.sellStrike = Math.min(buy, sell);
                            parsed.buyStrike = Math.max(buy, sell);
                        }
                    }
                    // Put credit spread = bull put spread
                    else if (strategy.includes('put') && strategy.includes('credit')) {
                        if (sell < buy) {
                            parsed.sellStrike = Math.max(buy, sell);
                            parsed.buyStrike = Math.min(buy, sell);
                        }
                    }
                    // Call credit spread = bear call spread  
                    else if (strategy.includes('call') && strategy.includes('credit')) {
                        if (sell > buy) {
                            parsed.sellStrike = Math.min(buy, sell);
                            parsed.buyStrike = Math.max(buy, sell);
                        }
                    }
                    console.log('[AI] Final strikes: buy=$' + parsed.buyStrike + ' sell=$' + parsed.sellStrike);
                }
                
                // Step 2: Fetch current data for the ticker
                sendProgress(2, `Fetching market data for ${parsed.ticker}...`);
                const tickerData = await fetchDeepDiveData(parsed.ticker);
                if (!tickerData || !tickerData.price) {
                    if (acceptsSSE) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: `Could not fetch data for ${parsed.ticker}` })}\n\n`);
                        res.end();
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `Could not fetch data for ${parsed.ticker}` }));
                    }
                    return;
                }
                
                // Step 3: Try to get CBOE premium if we have strike/expiry
                sendProgress(3, `Fetching CBOE options pricing...`);
                let premium = null;
                if (parsed.strike && parsed.expiry) {
                    const strikeNum = parseFloat(String(parsed.strike).replace(/[^0-9.]/g, ''));
                    
                    // Determine option type from strategy
                    const callStrategies = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
                    const strategyLower = (parsed.strategy || '').toLowerCase().replace(/\s+/g, '_');
                    const optionType = callStrategies.some(s => strategyLower.includes(s)) ? 'CALL' : 'PUT';
                    console.log(`[CBOE] Strategy "${parsed.strategy}" → optionType: ${optionType}`);
                    
                    premium = await fetchOptionPremium(parsed.ticker, strikeNum, formatExpiryForCBOE(parsed.expiry), optionType);
                }
                
                // Step 4: Build analysis prompt and get AI recommendation
                sendProgress(4, `Generating AI analysis with ${selectedModel}...`);
                
                // Generate pattern context from closed positions summary
                let patternContext = null;
                const closedSummary = req.body.closedSummary || null;
                
                if (closedSummary && closedSummary.length > 0) {
                    const ticker = parsed.ticker?.toUpperCase();
                    const strategyType = parsed.strategy?.toLowerCase().replace(/\s+/g, '_') || '';
                    
                    // Find trades with same ticker + same type
                    const sameTickerType = closedSummary.filter(p => 
                        p.ticker?.toUpperCase() === ticker && 
                        p.type?.toLowerCase().replace(/\s+/g, '_') === strategyType
                    );
                    
                    // Find all trades with same ticker
                    const sameTicker = closedSummary.filter(p => 
                        p.ticker?.toUpperCase() === ticker
                    );
                    
                    // Find all trades with same type
                    const sameType = closedSummary.filter(p => 
                        p.type?.toLowerCase().replace(/\s+/g, '_') === strategyType
                    );
                    
                    // Calculate stats
                    const calcStats = (trades) => {
                        if (trades.length === 0) return null;
                        const totalPnL = trades.reduce((sum, p) => sum + (p.pnl || 0), 0);
                        const winners = trades.filter(p => (p.pnl || 0) >= 0);
                        const winRate = (winners.length / trades.length * 100);
                        return { count: trades.length, totalPnL, winRate, avgPnL: totalPnL / trades.length };
                    };
                    
                    const tickerTypeStats = calcStats(sameTickerType);
                    const tickerStats = calcStats(sameTicker);
                    const typeStats = calcStats(sameType);
                    
                    // Build pattern context string
                    let text = '';
                    const warnings = [];
                    const encouragements = [];
                    
                    if (tickerTypeStats && tickerTypeStats.count >= 2) {
                        text += `### ${ticker} ${strategyType.replace(/_/g, ' ')} History\n`;
                        text += `- ${tickerTypeStats.count} trades, ${tickerTypeStats.winRate.toFixed(0)}% win rate, $${tickerTypeStats.totalPnL.toFixed(0)} total P&L\n\n`;
                        
                        if (tickerTypeStats.winRate < 40) {
                            warnings.push(`⚠️ LOW WIN RATE: Only ${tickerTypeStats.winRate.toFixed(0)}% on ${ticker} ${strategyType.replace(/_/g,' ')}`);
                        }
                        if (tickerTypeStats.totalPnL < -500) {
                            warnings.push(`🚨 LOSING PATTERN: You've lost $${Math.abs(tickerTypeStats.totalPnL).toFixed(0)} on this exact setup`);
                        }
                        if (tickerTypeStats.winRate >= 75) {
                            encouragements.push(`✅ STRONG PATTERN: ${tickerTypeStats.winRate.toFixed(0)}% win rate on this setup`);
                        }
                        if (tickerTypeStats.avgPnL > 100) {
                            encouragements.push(`💰 PROFITABLE: Avg $${tickerTypeStats.avgPnL.toFixed(0)} on ${ticker} ${strategyType.replace(/_/g,' ')}`);
                        }
                    }
                    
                    if (tickerStats && tickerStats.count >= 3 && !tickerTypeStats) {
                        text += `### All ${ticker} Trades\n`;
                        text += `- ${tickerStats.count} trades, ${tickerStats.winRate.toFixed(0)}% win rate\n\n`;
                        
                        if (tickerStats.winRate < 40) {
                            warnings.push(`⚠️ ${ticker} HAS BEEN DIFFICULT: ${tickerStats.winRate.toFixed(0)}% win rate`);
                        }
                        if (tickerStats.winRate >= 70) {
                            encouragements.push(`✅ ${ticker} WORKS FOR YOU: ${tickerStats.winRate.toFixed(0)}% win rate`);
                        }
                    }
                    
                    if (typeStats && typeStats.count >= 5) {
                        text += `### All ${strategyType.replace(/_/g, ' ')} Trades\n`;
                        text += `- ${typeStats.count} trades, ${typeStats.winRate.toFixed(0)}% win rate, $${typeStats.avgPnL.toFixed(0)} avg\n\n`;
                        
                        if (typeStats.winRate < 50 && strategyType.includes('long')) {
                            warnings.push(`⚠️ ${strategyType.replace(/_/g,' ')} UNDERPERFORMING: Only ${typeStats.winRate.toFixed(0)}% win rate`);
                        }
                        if (typeStats.winRate >= 70) {
                            encouragements.push(`✅ ${strategyType.replace(/_/g,' ')} IS YOUR STRENGTH: ${typeStats.winRate.toFixed(0)}% win rate`);
                        }
                    }
                    
                    // Add warnings and encouragements
                    if (warnings.length > 0) {
                        text += `### ⚠️ WARNINGS\n${warnings.join('\n')}\n\n`;
                    }
                    if (encouragements.length > 0) {
                        text += `### ✅ POSITIVE PATTERNS\n${encouragements.join('\n')}\n\n`;
                    }
                    
                    // Set summary
                    if (warnings.length > 0 && encouragements.length === 0) {
                        text += `**SUMMARY**: ⚠️ CAUTION - Historical patterns suggest risk.\n`;
                    } else if (encouragements.length > 0 && warnings.length === 0) {
                        text += `**SUMMARY**: ✅ FAVORABLE - Matches your winning patterns.\n`;
                    } else if (warnings.length > 0 && encouragements.length > 0) {
                        text += `**SUMMARY**: ⚖️ MIXED SIGNALS - Some patterns favorable, others concerning.\n`;
                    } else if (tickerTypeStats || tickerStats || typeStats) {
                        text += `**SUMMARY**: 📊 NEUTRAL - Limited history, proceed with standard caution.\n`;
                    }
                    
                    if (text.length > 0) {
                        patternContext = text;
                        console.log(`[AI] Pattern context: ${warnings.length} warnings, ${encouragements.length} encouragements`);
                    }
                }
                
                const analysisPrompt = buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium, patternContext);
                const analysis = await callAI(analysisPrompt, selectedModel, 1200);
                
                // Send final result
                const result = { 
                    type: 'complete',
                    success: true,
                    parsed,
                    tickerData,
                    premium,
                    analysis,
                    model: selectedModel
                };
                
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify(result)}\n\n`);
                res.end();
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            }
            console.log('[AI] ✅ Trade callout analyzed');
        } catch (e) {
            console.log('[AI] ❌ Parse trade error:', e.message);
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
                res.end();
            } else {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                }
                res.end(JSON.stringify({ error: e.message }));
            }
        }
        return;
    }
    
    // AI Trade Advisor endpoint - uses Ollama with user-selected model
    if (url.pathname === '/api/ai/analyze' && req.method === 'POST') {
        try {
            const data = req.body;
            const selectedModel = data.model || 'qwen2.5:7b';
            const isGrok = selectedModel.startsWith('grok');
            const useMoE = !isGrok && data.useMoE !== false; // Default to true for 32B, but never for Grok
            const skipWisdom = data.skipWisdom === true;  // NEW: Pure mode toggle
            console.log('[AI] Analyzing position:', data.ticker, 'with model:', selectedModel, 'MoE:', useMoE, skipWisdom ? '(PURE MODE - no wisdom)' : '');
            
            // Scale token limit based on model size - scorecard format needs more tokens
            const isLargeModel = selectedModel.includes('32b') || selectedModel.includes('70b') || selectedModel.includes('72b') || isGrok;
            const tokenLimit = isLargeModel ? 1800 : 1000;  // Scorecard needs ~1500+ tokens
            
            // Build structured prompt from pre-computed data (now async for semantic search)
            const prompt = await buildTradePrompt({ ...data, skipWisdom }, isLargeModel);
            
            // Get the wisdom entries that were applied (stored by buildTradePrompt)
            const wisdomUsed = buildTradePrompt._lastWisdomUsed || [];
            
            let response;
            let took = '';
            let moeDetails = null;
            
            // Use Mixture of Experts for 32B model
            if (isLargeModel && useMoE) {
                const moeResult = await callMoE(prompt, data);
                response = moeResult.response;
                took = `MoE: ${moeResult.timing.total}ms (7B+14B: ${moeResult.timing.parallel}ms, 32B judge: ${moeResult.timing.judge}ms)`;
                moeDetails = {
                    opinions: moeResult.opinions,
                    timing: moeResult.timing
                };
            } else {
                // Single model call
                const start = Date.now();
                response = await callAI(prompt, selectedModel, tokenLimit);
                took = `${Date.now() - start}ms`;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                insight: response,
                model: selectedModel,
                took,
                moe: moeDetails,
                pureMode: skipWisdom,
                wisdomApplied: !skipWisdom && wisdomUsed.length > 0 ? {
                    count: wisdomUsed.length,
                    positionType: data.positionType,
                    entries: wisdomUsed.map(w => ({ category: w.category, wisdom: w.wisdom.substring(0, 100) + '...', relevance: w.relevance?.toFixed(2) }))
                } : null
            }));
            console.log('[AI] ✅ Analysis complete' + (skipWisdom ? ' (PURE MODE)' : wisdomUsed.length > 0 ? ` (${wisdomUsed.length} wisdom entries applied)` : ''));
        } catch (e) {
            console.log('[AI] ❌ Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Portfolio Audit - analyzes entire portfolio for problems and recommendations
    if (url.pathname === '/api/ai/portfolio-audit' && req.method === 'POST') {
        try {
            const data = req.body;
            const selectedModel = data.model || 'qwen2.5:14b';
            console.log('[AI] Portfolio audit with model:', selectedModel, '- Positions:', data.positions?.length);
            
            const positions = data.positions || [];
            const greeks = data.greeks || {};
            const closedStats = data.closedStats || {};
            
            // Build position summary for AI - include position type context
            const positionSummary = positions.map(p => {
                const riskPct = p.riskPercent || 0;
                const isLong = ['long_call', 'long_put', 'long_call_leaps', 'skip_call', 'call_debit_spread', 'put_debit_spread'].includes(p.type);
                const isLeaps = p.dte >= 365;
                
                // Different risk interpretation for long vs short
                let riskNote;
                if (isLong) {
                    // For long options, "ITM probability" means profit probability!
                    riskNote = riskPct > 50 ? '✓ PROFITABLE ZONE' : riskPct > 30 ? '→ APPROACHING' : '⏳ WAITING';
                } else {
                    // For short options, ITM = assignment risk
                    riskNote = riskPct > 50 ? '⚠️ HIGH RISK' : riskPct > 30 ? '⚠️ ELEVATED' : '✓ OK';
                }
                
                const typeNote = isLong ? '[LONG - profits from DIRECTION]' : '[SHORT - profits from theta]';
                const leapsNote = isLeaps ? ' 📅LEAPS' : '';
                
                return `${p.ticker}: ${p.type}${leapsNote} $${p.strike} (${p.dte}d DTE) ${typeNote} - ${riskPct.toFixed(0)}% ITM ${riskNote}, Δ${p.delta?.toFixed(0) || '?'}, Θ$${p.theta?.toFixed(2) || '?'}/day`;
            }).join('\n');
            
            // Concentration analysis
            const tickerCounts = {};
            positions.forEach(p => {
                tickerCounts[p.ticker] = (tickerCounts[p.ticker] || 0) + 1;
            });
            const concentrations = Object.entries(tickerCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([t, c]) => `${t}: ${c} position${c > 1 ? 's' : ''}`);
            
            const prompt = `You are a professional options portfolio manager auditing a wheel strategy portfolio.

## IMPORTANT: LONG vs SHORT POSITIONS
⚠️ This portfolio may contain BOTH short (credit) AND long (debit) positions. They are evaluated DIFFERENTLY:

**SHORT positions** (short_put, covered_call, credit spreads):
- You COLLECTED premium upfront
- Positive theta = GOOD (you profit from time decay)
- High ITM probability = BAD (assignment risk)
- Goal: Let theta decay, close at 50-80% profit

**LONG positions** (long_call, long_put, long_call_leaps, debit spreads):
- You PAID premium upfront
- Negative theta is EXPECTED (cost of holding, like insurance)
- LEAPS (365+ DTE): Theta is TINY (~$0.50-1/day on a $1700 position = 0.04%/day = negligible)
- Profit comes from DELTA (directional move), NOT theta
- High ITM probability = GOOD (means you're profitable!)
- Goal: Ride the directional move, sell when thesis achieved

**DO NOT flag long positions as "problems" just because theta is negative!** That's like saying car insurance is a problem because you pay premiums. Evaluate long positions by whether the THESIS is working (is the stock moving in your favor?).

## CURRENT POSITIONS (${positions.length} total)
${positionSummary || 'No open positions'}

## PORTFOLIO GREEKS
- Net Delta: ${greeks.delta?.toFixed(0) || 0} (${greeks.delta > 0 ? 'bullish' : greeks.delta < 0 ? 'bearish' : 'neutral'} exposure)
- Daily Theta: $${greeks.theta?.toFixed(2) || 0} (premium decay/day)
- Vega: $${greeks.vega?.toFixed(0) || 0} per 1% IV change
- Average IV: ${greeks.avgIV?.toFixed(1) || '?'}%
- Average IV Rank: ${greeks.avgIVRank || '?'}%

## CONCENTRATION
${concentrations.join('\n') || 'None'}

## HISTORICAL PERFORMANCE
- Win Rate: ${closedStats.winRate?.toFixed(1) || '?'}%
- Profit Factor: ${closedStats.profitFactor?.toFixed(2) || '?'}
- Avg Win: $${closedStats.avgWin?.toFixed(0) || '?'}
- Avg Loss: $${closedStats.avgLoss?.toFixed(0) || '?'}

## YOUR AUDIT TASK
Analyze this portfolio and provide:

**START WITH THE OVERALL GRADE** (this should be the FIRST thing in your response):

## 📊 PORTFOLIO GRADE: [A/B/C/D/F]

Grade the portfolio health using these criteria:
- **A (90-100%)**: No problem positions, good theta generation, balanced Greeks, proper diversification
- **B (80-89%)**: Minor issues (1 position needs attention OR slight concentration), but fundamentally sound
- **C (70-79%)**: Moderate issues (2+ positions need attention OR significant concentration OR poor theta)
- **D (60-69%)**: Serious concerns (high ITM risk positions, poor Greeks balance, or heavy concentration)
- **F (<60%)**: Critical problems (multiple positions at high assignment risk, negative net theta, severe imbalance)

After the grade, explain in ONE sentence why you gave that grade.

---

Then provide the detailed analysis using this EXACT format with emojis and bullet points:

1. 🚨 PROBLEM POSITIONS
List positions needing attention, or "None" if all healthy.
- For SHORT positions: High ITM risk, poor theta/risk ratio, about to be assigned
- For LONG positions: Thesis failing (stock moving AGAINST you), about to expire worthless
- **NOT a problem**: Long options with negative theta (that's normal!)

2. ⚠️ CONCENTRATION RISKS
Flag if too much exposure to one ticker or sector. List ticker counts.

3. 📊 GREEKS ASSESSMENT
One paragraph on portfolio balance. Include net delta interpretation, theta quality, vega exposure.

4. 💡 OPTIMIZATION IDEAS
Use bullet points (•) for specific actionable suggestions:
• [Suggestion 1 with specific ticker/strike]
• [Suggestion 2]
• [Suggestion 3]

5. ✅ WHAT'S WORKING
Use bullet points (•) to highlight well-positioned trades:
• [What's working 1 with specific ticker/strike and why]
• [What's working 2]

IMPORTANT FORMATTING RULES:
- Use the section headers EXACTLY as shown (with emojis and numbers)
- Use bullet points (•) not dashes for lists
- Keep each section concise but specific
- Reference actual ticker symbols and strikes
- Do NOT use markdown headers (##) except for the grade`;

            const response = await callAI(prompt, selectedModel, 1200);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                audit: response,
                model: selectedModel
            }));
            console.log('[AI] ✅ Portfolio audit complete');
        } catch (e) {
            console.log('[AI] ❌ Portfolio audit error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // AI Historical Audit - analyzes closed trades for a specific time period
    if (url.pathname === '/api/ai/historical-audit' && req.method === 'POST') {
        try {
            const data = req.body;
            console.log('[AI] Historical audit for period:', data.periodLabel, '- Trades:', data.totalTrades);
            
            const prompt = `You are a professional options trading coach analyzing historical trade data for a wheel strategy trader.

## PERIOD ANALYZED: ${data.periodLabel}
## OVERALL STATS
- Total Trades: ${data.totalTrades}
- Total P&L: $${data.totalPnL?.toFixed(0) || 0} ${data.totalPnL >= 0 ? '✅' : '❌'}
- Win Rate: ${data.winRate}% (${data.winnersCount} winners, ${data.losersCount} losers)

## PERFORMANCE BY TICKER (Top 10)
${(data.tickerSummary || []).join('\n') || 'No data'}

## PERFORMANCE BY STRATEGY TYPE
${(data.typeSummary || []).join('\n') || 'No data'}

## BIGGEST WINNERS
${(data.topWinners || []).join('\n') || 'None'}

## BIGGEST LOSERS
${(data.topLosers || []).join('\n') || 'None'}

## YOUR ANALYSIS TASK
Provide a comprehensive audit of this trading period using this EXACT format:

## 📊 PERIOD GRADE: [A/B/C/D/F]

Grade the trading performance:
- **A (90-100%)**: Win rate >70%, positive P&L, no major drawdowns, consistent execution
- **B (80-89%)**: Win rate >60%, positive P&L, minor issues but overall profitable
- **C (70-79%)**: Win rate 50-60%, break-even or small profit, needs improvement
- **D (60-69%)**: Win rate <50% OR negative P&L, significant issues
- **F (<60%)**: Major losses, poor execution, serious problems to address

After the grade, ONE sentence summary of why.

---

## 1. 🎯 WHAT WORKED WELL
Use bullet points to highlight:
• Best performing tickers and why they likely worked
• Most profitable strategy types
• Good execution patterns observed

## 2. ⚠️ AREAS FOR IMPROVEMENT  
Use bullet points to identify:
• Worst performing tickers and possible reasons
• Strategy types that underperformed
• Patterns in losing trades

## 3. 📈 PATTERN ANALYSIS
Identify trading patterns:
• Any ticker concentration (good or bad)?
• Strategy type preferences
• Win rate by strategy type observation

## 4. 💡 RECOMMENDATIONS
Actionable suggestions based on this data:
• What to do more of (based on winners)
• What to avoid or change (based on losers)
• Position sizing observations
• Risk management notes

## 5. 🏆 KEY LESSONS
Top 3 takeaways from this trading period:
• Lesson 1
• Lesson 2
• Lesson 3

FORMATTING RULES:
- Use exact section headers with emojis
- Use bullet points (•) for all lists
- Be specific - reference actual ticker symbols
- Keep insights actionable and practical`;

            const response = await callAI(prompt, 'qwen2.5:14b', 1200);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                analysis: response
            }));
            console.log('[AI] ✅ Historical audit complete');
        } catch (e) {
            console.log('[AI] ❌ Historical audit error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Check if AI/Ollama is available and what's loaded
    if (url.pathname === '/api/ai/status') {
        try {
            // Get GPU info
            const gpu = detectGPU();
            
            // Get available models
            const ollamaRes = await fetchJsonHttp('http://localhost:11434/api/tags');
            const models = ollamaRes.models || [];
            const hasQwen = models.some(m => m.name?.includes('qwen'));
            const hasVision = models.some(m => m.name?.includes('minicpm-v') || m.name?.includes('llava'));
            
            // Get currently loaded models (in VRAM)
            let loadedModels = [];
            try {
                const psRes = await fetchJsonHttp('http://localhost:11434/api/ps');
                loadedModels = (psRes.models || []).map(m => ({
                    name: m.name,
                    sizeVram: m.size_vram,
                    sizeVramGB: (m.size_vram / 1024 / 1024 / 1024).toFixed(1)
                }));
            } catch (e) {
                // /api/ps might not exist in older Ollama versions
            }
            
            // Add can-run info to each model
            const freeGB = parseFloat(gpu.freeGB) || 0;
            const totalGB = parseFloat(gpu.totalGB) || 0;
            const modelsWithCapability = models.map(m => {
                const req = MODEL_VRAM_REQUIREMENTS[m.name] || { minGB: 4, recGB: 8, description: 'Unknown model' };
                const canRun = gpu.available && freeGB >= req.minGB;
                const recommended = gpu.available && totalGB >= req.recGB;
                return { 
                    name: m.name, 
                    size: m.size,
                    sizeGB: (m.size / 1024 / 1024 / 1024).toFixed(1),
                    requirements: req,
                    canRun,
                    recommended,
                    warning: !canRun ? `Needs ${req.minGB}GB VRAM (${freeGB}GB free)` : null
                };
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                available: models.length > 0,
                hasQwen,
                hasVision,
                gpu,
                models: modelsWithCapability,
                loaded: loadedModels,
                isWarm: loadedModels.length > 0
            }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ available: false, error: 'Ollama not running', gpu: detectGPU() }));
        }
        return;
    }
    
    // Restart Ollama service
    if (url.pathname === '/api/ai/restart' && req.method === 'POST') {
        console.log('[AI] 🔄 Restarting Ollama...');
        try {
            const { exec } = require('child_process');
            
            // Kill existing Ollama processes and restart
            await new Promise((resolve, reject) => {
                exec('taskkill /f /im ollama.exe', (err) => {
                    // Ignore errors (process might not exist)
                    resolve();
                });
            });
            
            // Wait a moment then start Ollama
            await new Promise(r => setTimeout(r, 1000));
            
            await new Promise((resolve, reject) => {
                exec('start /b ollama serve', { shell: true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
            // Wait for Ollama to start
            await new Promise(r => setTimeout(r, 3000));
            
            // Check if it's running
            try {
                const status = await fetchJsonHttp('http://localhost:11434/api/tags');
                console.log('[AI] ✅ Ollama restarted successfully');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, models: status.models?.length || 0 }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Ollama failed to start' }));
            }
        } catch (e) {
            console.log('[AI] ❌ Restart error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }
    
    // Warmup/preload a model into VRAM (with streaming progress)
    if (url.pathname === '/api/ai/warmup' && req.method === 'POST') {
        console.log(`[AI] 🔥 Warmup endpoint hit, body:`, req.body);
        try {
            // Express already parsed the body for us
            const selectedModel = req.body?.model || 'qwen2.5:7b';
            
            console.log(`[AI] 🔥 Warming up model: ${selectedModel}...`);
            
            // Use SSE for progress updates
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            
            res.write(`data: ${JSON.stringify({ type: 'progress', message: `Loading ${selectedModel}...`, percent: 10 })}\n\n`);
            
            const startTime = Date.now();
                
                // Call Ollama directly with longer timeout for warmup
                const postData = JSON.stringify({
                    model: selectedModel,
                    prompt: 'Hi',
                    stream: false,
                    options: { num_predict: 1 }
                });
                
                const ollamaReq = http.request({
                    hostname: 'localhost',
                    port: 11434,
                    path: '/api/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (ollamaRes) => {
                    let data = '';
                    
                    // Send progress updates while waiting
                    const progressInterval = setInterval(() => {
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                        const percent = Math.min(90, 10 + parseInt(elapsed) * 5);
                        res.write(`data: ${JSON.stringify({ type: 'progress', message: `Loading ${selectedModel}... ${elapsed}s`, percent })}\n\n`);
                    }, 1000);
                    
                    ollamaRes.on('data', chunk => data += chunk);
                    ollamaRes.on('end', () => {
                        clearInterval(progressInterval);
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        console.log(`[AI] ✅ Model ${selectedModel} loaded in ${elapsed}s`);
                        
                        res.write(`data: ${JSON.stringify({ type: 'complete', success: true, message: `Loaded in ${elapsed}s`, model: selectedModel, loadTimeSeconds: parseFloat(elapsed) })}\n\n`);
                        res.end();
                    });
                });
                
                ollamaReq.on('error', (e) => {
                    console.log(`[AI] ❌ Warmup failed: ${e.message}`);
                    res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
                    res.end();
                });
                
                // Longer timeout for large models (3 minutes)
                ollamaReq.setTimeout(180000, () => {
                    ollamaReq.destroy();
                    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Timeout - model too large or Ollama busy' })}\n\n`);
                    res.end();
                });
                
                ollamaReq.write(postData);
                ollamaReq.end();
                
        } catch (e) {
            console.log(`[AI] ❌ Warmup failed: ${e.message}`);
            if (!res.headersSent) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            }
            res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
            res.end();
        }
        return;
    }
    
    // Parse image using vision model (minicpm-v or llava)
    if (url.pathname === '/api/ai/parse-image' && req.method === 'POST') {
        console.log('[AI-VISION] 📷 Image parse request received');
        try {
            const { image, model = 'minicpm-v:latest' } = req.body || {};
            
            if (!image) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No image provided' }));
                return;
            }
            
            // Extract base64 data (handle data URL format)
            let base64Data = image;
            if (image.startsWith('data:image')) {
                base64Data = image.split(',')[1];
            }
            
            console.log(`[AI-VISION] Using model: ${model}, image size: ${(base64Data.length / 1024).toFixed(1)}KB`);
            
            const prompt = `You are extracting trade information from a broker confirmation screenshot.
Look at this image and extract:
1. Ticker symbol
2. Action (Sold to Open, Bought to Open, Sold to Close, etc.)  
3. Option type (Put or Call)
4. Strike price
5. Expiration date
6. Premium/price per share
7. Number of contracts
8. Total premium received or paid

Format your response as:
TICKER: [symbol]
ACTION: [action]
TYPE: [put/call]
STRIKE: [strike price]
EXPIRY: [date]
PREMIUM: [per share price]
CONTRACTS: [number]
TOTAL: [total amount]

If any field is unclear, write "unclear" for that field.`;

            const postData = JSON.stringify({
                model: model,
                prompt: prompt,
                images: [base64Data],
                stream: false,
                options: { temperature: 0.1 }
            });
            
            const response = await new Promise((resolve, reject) => {
                const ollamaReq = http.request({
                    hostname: 'localhost',
                    port: 11434,
                    path: '/api/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (ollamaRes) => {
                    let data = '';
                    ollamaRes.on('data', chunk => data += chunk);
                    ollamaRes.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed.response || parsed.message?.content || data);
                        } catch {
                            resolve(data);
                        }
                    });
                });
                
                ollamaReq.on('error', reject);
                ollamaReq.setTimeout(120000, () => {
                    ollamaReq.destroy();
                    reject(new Error('Timeout - vision model took too long'));
                });
                
                ollamaReq.write(postData);
                ollamaReq.end();
            });
            
            console.log('[AI-VISION] ✅ Image parsed successfully');
            
            // Parse the structured response
            const parsed = {};
            const lines = response.split('\n');
            for (const line of lines) {
                const match = line.match(/^(TICKER|ACTION|TYPE|STRIKE|EXPIRY|PREMIUM|CONTRACTS|TOTAL):\s*(.+)/i);
                if (match) {
                    parsed[match[1].toLowerCase()] = match[2].trim();
                }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true,
                raw: response,
                parsed,
                model
            }));
            
        } catch (e) {
            console.log('[AI-VISION] ❌ Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Parse wisdom image - extract trading advice text from screenshots
    if (url.pathname === '/api/ai/parse-wisdom-image' && req.method === 'POST') {
        console.log('[AI-VISION] 📚 Wisdom image parse request received');
        try {
            const { image, model = 'minicpm-v:latest' } = req.body || {};
            
            if (!image) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No image provided' }));
                return;
            }
            
            // Extract base64 data (handle data URL format)
            let base64Data = image;
            if (image.startsWith('data:image')) {
                base64Data = image.split(',')[1];
            }
            
            console.log(`[AI-VISION] Using model: ${model}, image size: ${(base64Data.length / 1024).toFixed(1)}KB`);
            
            const prompt = `Look at this screenshot and extract ALL trading advice, tips, or wisdom mentioned.
This is likely from a Discord, Twitter, or other social media post about options trading.

Focus on extracting:
- Any specific rules or guidelines mentioned (e.g., "close at 50% profit", "don't hold through earnings")
- Any strategies or recommendations
- Any warnings or things to avoid
- Any tips about rolling, timing, or position sizing

Return ONLY the trading advice/wisdom text that you find in the image.
If there are multiple pieces of advice, list each one on a new line.
Do NOT add any commentary or explanation - just the exact advice from the image.
If you cannot find any trading advice, respond with: NO_TRADING_ADVICE_FOUND`;

            const postData = JSON.stringify({
                model: model,
                prompt: prompt,
                images: [base64Data],
                stream: false,
                options: { temperature: 0.1 }
            });
            
            const response = await new Promise((resolve, reject) => {
                const ollamaReq = http.request({
                    hostname: 'localhost',
                    port: 11434,
                    path: '/api/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (ollamaRes) => {
                    let data = '';
                    ollamaRes.on('data', chunk => data += chunk);
                    ollamaRes.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            resolve(parsed.response || parsed.message?.content || data);
                        } catch {
                            resolve(data);
                        }
                    });
                });
                
                ollamaReq.on('error', reject);
                ollamaReq.setTimeout(120000, () => {
                    ollamaReq.destroy();
                    reject(new Error('Timeout - vision model took too long'));
                });
                
                ollamaReq.write(postData);
                ollamaReq.end();
            });
            
            // Check if response looks like an Ollama error
            if (!response) {
                console.log('[AI-VISION] ⚠️ Empty response from Ollama');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Vision model returned empty response. Try restarting Ollama.' }));
                return;
            }
            
            // Check for JSON error objects (but not regular text that happens to have quotes)
            if (response.trim().startsWith('{"error"')) {
                console.log('[AI-VISION] ⚠️ Ollama returned error JSON:', response);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Vision model crashed. Try restarting Ollama.' }));
                return;
            }
            
            console.log('[AI-VISION] ✅ Wisdom image parsed successfully');
            
            // Check if no advice found
            if (response.includes('NO_TRADING_ADVICE_FOUND')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: false,
                    error: 'No trading advice found in image',
                    extractedText: ''
                }));
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true,
                extractedText: response.trim(),
                model
            }));
            
        } catch (e) {
            console.log('[AI-VISION] ❌ Wisdom parse error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Static file serving
    let filePath = url.pathname;
    if (filePath === '/') filePath = '/index.html';
    
    const fullPath = path.join(__dirname, filePath);
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    try {
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (e) {
        if (e.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
        } else {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Server error');
        }
    }
    } catch (err) {
        // Top-level error handler for mainHandler
        console.error('[SERVER] Unhandled error in mainHandler:', err.message);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
};

// Helper to fetch JSON over HTTPS
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', reject);
    });
}

// Discovery cache - refresh every 15 minutes
let discoveryCache = { mostActive: [], trending: [], timestamp: 0 };
const DISCOVERY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Fetch Yahoo's Most Active stocks (high volume today)
async function fetchMostActiveStocks() {
    try {
        const url = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=50';
        const data = await fetchJson(url);
        const quotes = data.finance?.result?.[0]?.quotes || [];
        
        // Filter to optionable stocks (skip ADRs, penny stocks, etc.)
        const tickers = quotes
            .filter(q => q.symbol && !q.symbol.includes('.') && q.regularMarketPrice > 5)
            .map(q => ({ ticker: q.symbol, sector: 'Active Today' }))
            .slice(0, 30);
        
        console.log(`[Discovery] Found ${tickers.length} most active stocks`);
        return tickers;
    } catch (e) {
        console.log('[Discovery] Most active fetch failed:', e.message);
        return [];
    }
}

// Fetch Yahoo's Trending stocks (unusual activity/news)
async function fetchTrendingStocks() {
    try {
        const url = 'https://query1.finance.yahoo.com/v1/finance/trending/US';
        const data = await fetchJson(url);
        const quotes = data.finance?.result?.[0]?.quotes || [];
        
        const tickers = quotes
            .filter(q => q.symbol && !q.symbol.includes('.'))
            .map(q => ({ ticker: q.symbol, sector: 'Trending' }))
            .slice(0, 20);
        
        console.log(`[Discovery] Found ${tickers.length} trending stocks`);
        return tickers;
    } catch (e) {
        console.log('[Discovery] Trending fetch failed:', e.message);
        return [];
    }
}

// Fetch current prices for a list of tickers (for AI trade ideas)
async function fetchWheelCandidatePrices(buyingPower, excludeTickers = []) {
    // Core curated wheel-friendly stocks (reliable favorites)
    const curatedCandidates = [
        // Tech - Large Cap
        { ticker: 'AAPL', sector: 'Tech' },
        { ticker: 'MSFT', sector: 'Tech' },
        { ticker: 'GOOGL', sector: 'Tech' },
        { ticker: 'META', sector: 'Tech' },
        { ticker: 'NVDA', sector: 'Tech' },
        // Tech - Mid Cap / High IV
        { ticker: 'AMD', sector: 'Tech' },
        { ticker: 'INTC', sector: 'Tech' },
        { ticker: 'PLTR', sector: 'Tech' },
        { ticker: 'CRWD', sector: 'Tech' },
        { ticker: 'SNOW', sector: 'Tech' },
        { ticker: 'NET', sector: 'Tech' },
        { ticker: 'DDOG', sector: 'Tech' },
        { ticker: 'MU', sector: 'Tech' },
        { ticker: 'UBER', sector: 'Tech' },
        { ticker: 'SHOP', sector: 'Tech' },
        // Finance
        { ticker: 'BAC', sector: 'Finance' },
        { ticker: 'C', sector: 'Finance' },
        { ticker: 'JPM', sector: 'Finance' },
        { ticker: 'GS', sector: 'Finance' },
        { ticker: 'SOFI', sector: 'Finance' },
        { ticker: 'COIN', sector: 'Finance' },
        { ticker: 'SCHW', sector: 'Finance' },
        { ticker: 'V', sector: 'Finance' },
        // Energy
        { ticker: 'XOM', sector: 'Energy' },
        { ticker: 'OXY', sector: 'Energy' },
        { ticker: 'CVX', sector: 'Energy' },
        { ticker: 'DVN', sector: 'Energy' },
        { ticker: 'HAL', sector: 'Energy' },
        // Consumer / Retail
        { ticker: 'KO', sector: 'Consumer' },
        { ticker: 'F', sector: 'Consumer' },
        { ticker: 'GM', sector: 'Consumer' },
        { ticker: 'NKE', sector: 'Consumer' },
        { ticker: 'SBUX', sector: 'Consumer' },
        { ticker: 'DIS', sector: 'Consumer' },
        { ticker: 'TGT', sector: 'Consumer' },
        // Healthcare / Biotech
        { ticker: 'PFE', sector: 'Healthcare' },
        { ticker: 'ABBV', sector: 'Healthcare' },
        { ticker: 'JNJ', sector: 'Healthcare' },
        { ticker: 'MRK', sector: 'Healthcare' },
        { ticker: 'MRNA', sector: 'Healthcare' },
        // ETFs
        { ticker: 'SPY', sector: 'ETF' },
        { ticker: 'QQQ', sector: 'ETF' },
        { ticker: 'IWM', sector: 'ETF' },
        { ticker: 'SLV', sector: 'ETF' },
        { ticker: 'GLD', sector: 'ETF' },
        { ticker: 'XLF', sector: 'ETF' },
        // High IV / Meme / Speculative
        { ticker: 'MSTR', sector: 'High IV' },
        { ticker: 'HOOD', sector: 'High IV' },
        { ticker: 'RIVN', sector: 'High IV' },
        { ticker: 'LCID', sector: 'High IV' },
        { ticker: 'NIO', sector: 'High IV' },
        { ticker: 'TSLA', sector: 'High IV' },
        { ticker: 'GME', sector: 'High IV' },
        { ticker: 'AMC', sector: 'High IV' }
    ];
    
    // Fetch dynamic discovery lists (most active + trending today)
    // Use cache to avoid Yahoo rate limiting
    const now = Date.now();
    let mostActive = [];
    let trending = [];
    
    if (now - discoveryCache.timestamp < DISCOVERY_CACHE_TTL && discoveryCache.mostActive.length > 0) {
        console.log('[Discovery] Using cached results (', Math.round((DISCOVERY_CACHE_TTL - (now - discoveryCache.timestamp)) / 1000), 's until refresh)');
        mostActive = discoveryCache.mostActive;
        trending = discoveryCache.trending;
    } else {
        console.log('[Discovery] Fetching fresh most active and trending stocks...');
        [mostActive, trending] = await Promise.all([
            fetchMostActiveStocks(),
            fetchTrendingStocks()
        ]);
        
        // Update cache if we got results
        if (mostActive.length > 0 || trending.length > 0) {
            discoveryCache = { mostActive, trending, timestamp: now };
        }
    }
    
    // Merge all sources, removing duplicates (curated takes priority for sector)
    const curatedTickers = new Set(curatedCandidates.map(c => c.ticker));
    const allCandidates = [
        ...curatedCandidates,
        ...mostActive.filter(c => !curatedTickers.has(c.ticker)),
        ...trending.filter(c => !curatedTickers.has(c.ticker) && !mostActive.find(m => m.ticker === c.ticker))
    ];
    
    console.log(`[Discovery] Combined pool: ${curatedCandidates.length} curated + ${mostActive.length} active + ${trending.length} trending = ${allCandidates.length} unique`);
    
    // Filter out excluded tickers (for "Show Different" feature)
    let candidates = allCandidates.filter(c => !excludeTickers.includes(c.ticker));
    
    // Shuffle and pick a random subset (20 tickers for variety from larger pool)
    candidates = shuffleArray(candidates).slice(0, 20);
    
    const results = [];
    const maxStrike = buyingPower / 100; // Max strike we can afford
    
    console.log(`[AI] Fetching prices for ${candidates.length} candidates (max strike: $${maxStrike.toFixed(0)})...`);
    
    // Fetch prices in parallel (batch of 5 to avoid rate limits)
    for (let i = 0; i < candidates.length; i += 5) {
        const batch = candidates.slice(i, i + 5);
        const promises = batch.map(async (c) => {
            try {
                // Fetch 1-month data to get price range and movement
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${c.ticker}?interval=1d&range=1mo`;
                const data = await fetchJson(url);
                const quote = data.chart?.result?.[0];
                const meta = quote?.meta;
                const price = meta?.regularMarketPrice;
                
                if (!price || price > maxStrike) return null;
                
                // Get price history for context
                const closes = quote?.indicators?.quote?.[0]?.close || [];
                const validCloses = closes.filter(c => c !== null);
                const monthHigh = Math.max(...validCloses);
                const monthLow = Math.min(...validCloses);
                const priceAtStart = validCloses[0];
                const monthChange = priceAtStart ? ((price - priceAtStart) / priceAtStart * 100).toFixed(1) : 0;
                
                // Calculate where price is in its range (0% = at low, 100% = at high)
                const rangePosition = monthHigh !== monthLow 
                    ? ((price - monthLow) / (monthHigh - monthLow) * 100).toFixed(0)
                    : 50;
                
                // Try to get earnings date
                let earnings = null;
                try {
                    const calUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${c.ticker}?modules=calendarEvents`;
                    const calData = await fetchJson(calUrl);
                    const earningsDate = calData.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
                    if (earningsDate) {
                        earnings = new Date(earningsDate * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    }
                } catch (e) { /* ignore earnings fetch errors */ }
                
                return {
                    ticker: c.ticker,
                    sector: c.sector,
                    price: price.toFixed(2),
                    buyingPower: (price * 100).toFixed(0),
                    monthChange: monthChange,
                    monthLow: monthLow.toFixed(2),
                    monthHigh: monthHigh.toFixed(2),
                    rangePosition: rangePosition,
                    earnings: earnings
                };
            } catch (e) {
                return null; // Failed to fetch
            }
        });
        const batchResults = await Promise.all(promises);
        results.push(...batchResults.filter(r => r !== null));
    }
    
    // IMPORTANT: Sort to prefer better wheel candidates (lower range = near support)
    // Keep all results for display, but sort so AI sees best candidates first
    results.sort((a, b) => {
        const rangeA = parseInt(a.rangePosition) || 50;
        const rangeB = parseInt(b.rangePosition) || 50;
        // Prefer lower range (0-50% = near lows = better put entry)
        // Also penalize very high range (80%+)
        const scoreA = rangeA < 50 ? 0 : (rangeA > 80 ? 2 : 1);
        const scoreB = rangeB < 50 ? 0 : (rangeB > 80 ? 2 : 1);
        if (scoreA !== scoreB) return scoreA - scoreB;
        return rangeA - rangeB; // Within same tier, prefer lower
    });
    
    console.log(`[AI] Found ${results.length} affordable candidates (sorted by range position - lower = better)`);
    return results;
}

// Fisher-Yates shuffle for randomizing ticker selection
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Convert any expiry format to "Mon DD" or "Mon DD, YYYY" format for CBOE lookup
// For LEAPS (1+ year out), we preserve the year so CBOE can find the correct chain
function formatExpiryForCBOE(expiry) {
    if (!expiry) return null;
    
    const currentYear = new Date().getFullYear();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // ISO format: 2026-02-20 or 2028-01-21
    const isoMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = months[parseInt(isoMatch[2]) - 1];
        const day = parseInt(isoMatch[3]);
        // If it's a LEAPS (more than 1 year out), include the year
        if (year > currentYear) {
            return `${month} ${day}, ${year}`;
        }
        return `${month} ${day}`;
    }
    
    // US format: 1/21/28 or 1/21/2028
    const usMatch = expiry.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (usMatch) {
        const month = months[parseInt(usMatch[1]) - 1];
        const day = parseInt(usMatch[2]);
        let year = parseInt(usMatch[3]);
        if (year < 100) year += 2000; // 28 -> 2028
        if (year > currentYear) {
            return `${month} ${day}, ${year}`;
        }
        return `${month} ${day}`;
    }
    
    // Already in "Mon DD" format? Check if there's a year
    const shortMatch = expiry.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)$/i);
    if (shortMatch) return expiry;
    
    // "Mon DD, YYYY" format - preserve year if future
    const longMatch = expiry.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+),?\s*(\d{4})?/i);
    if (longMatch) {
        const year = longMatch[3] ? parseInt(longMatch[3]) : currentYear;
        if (year > currentYear) {
            return `${longMatch[1]} ${parseInt(longMatch[2])}, ${year}`;
        }
        return `${longMatch[1]} ${parseInt(longMatch[2])}`;
    }
    
    // Full month name: "February 20, 2028" or "February 20"
    const fullMonthMatch = expiry.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+),?\s*(\d{4})?/i);
    if (fullMonthMatch) {
        const shortMonths = { January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr', May: 'May', June: 'Jun',
                             July: 'Jul', August: 'Aug', September: 'Sep', October: 'Oct', November: 'Nov', December: 'Dec' };
        const year = fullMonthMatch[3] ? parseInt(fullMonthMatch[3]) : currentYear;
        if (year > currentYear) {
            return `${shortMonths[fullMonthMatch[1]]} ${parseInt(fullMonthMatch[2])}, ${year}`;
        }
        return `${shortMonths[fullMonthMatch[1]]} ${parseInt(fullMonthMatch[2])}`;
    }
    
    console.log(`[CBOE] Could not parse expiry format: ${expiry}`);
    return expiry; // Return as-is, let the caller handle it
}

// Parse expiry string to Date object for DTE calculation
// Handles various formats: "Jan 23", "2026-02-20", "Feb 20, 2026", "2/27/26"
function parseExpiryDate(expiry) {
    if (!expiry) return null;
    
    const currentYear = new Date().getFullYear();
    const monthMap = { 
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
        january: 0, february: 1, march: 2, april: 3, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    
    // ISO format: 2026-02-20
    const isoMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
    }
    
    // US format: 2/27/26 or 2/27/2026
    const usMatch = expiry.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (usMatch) {
        let year = parseInt(usMatch[3]);
        if (year < 100) year += 2000; // 26 -> 2026
        return new Date(year, parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
    }
    
    // "Mon DD" or "Mon DD, YYYY" format
    const monthDayMatch = expiry.match(/^([A-Za-z]+)\s+(\d+),?\s*(\d{4})?/);
    if (monthDayMatch) {
        const month = monthMap[monthDayMatch[1].toLowerCase()];
        if (month !== undefined) {
            const day = parseInt(monthDayMatch[2]);
            const year = monthDayMatch[3] ? parseInt(monthDayMatch[3]) : currentYear;
            const date = new Date(year, month, day);
            // If date is in the past and no year specified, assume next year
            if (!monthDayMatch[3] && date < new Date()) {
                date.setFullYear(date.getFullYear() + 1);
            }
            return date;
        }
    }
    
    console.log(`[DTE] Could not parse expiry for DTE: ${expiry}`);
    return null;
}

// Fetch ATM IV data for a ticker - Schwab first, CBOE fallback
// Returns: { ticker, atmIV, ivRank, spot, source }
async function fetchTickerIVData(ticker) {
    try {
        // First get current stock price
        const quoteRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`);
        let spot = null;
        if (quoteRes.ok) {
            const data = await quoteRes.json();
            spot = data.chart?.result?.[0]?.meta?.regularMarketPrice;
        }
        
        if (!spot) {
            throw new Error(`Could not get current price for ${ticker}`);
        }
        
        // Try Schwab first for IV data
        try {
            // Get options expiring ~30 days out
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + 30);
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() + 20);
            const toDate = new Date();
            toDate.setDate(toDate.getDate() + 45);
            
            const chainData = await schwabApiCall(
                `/marketdata/v1/chains?symbol=${ticker}&contractType=PUT&fromDate=${fromDate.toISOString().split('T')[0]}&toDate=${toDate.toISOString().split('T')[0]}&strikeCount=20`
            );
            
            if (chainData && chainData.putExpDateMap) {
                // Find ATM option (strike closest to spot)
                const allPuts = [];
                for (const dateKey of Object.keys(chainData.putExpDateMap)) {
                    const strikeMap = chainData.putExpDateMap[dateKey];
                    for (const strikeKey of Object.keys(strikeMap)) {
                        const options = strikeMap[strikeKey];
                        if (options && options.length > 0) {
                            allPuts.push({
                                strike: parseFloat(strikeKey),
                                option: options[0]
                            });
                        }
                    }
                }
                
                if (allPuts.length > 0) {
                    // Find ATM (closest to spot)
                    allPuts.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
                    const atm = allPuts[0];
                    const atmIV = atm.option.volatility;
                    
                    if (atmIV) {
                        // Estimate IV Rank (simplified: compare to typical ranges)
                        // Real IV Rank needs 52-week IV history which Schwab doesn't provide
                        // Using heuristic: ATM IV position relative to asset class norms
                        const ivRank = estimateIVRank(ticker, atmIV);
                        
                        return {
                            ticker,
                            spot: spot.toFixed(2),
                            atmIV: atmIV.toFixed(1),
                            ivRank,
                            atmStrike: atm.strike,
                            delta: atm.option.delta,
                            source: 'schwab'
                        };
                    }
                }
            }
        } catch (schwabErr) {
            console.log(`[IV] Schwab failed for ${ticker}: ${schwabErr.message}`);
        }
        
        // Fallback to CBOE
        const cacheBuster = Date.now();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
        const cboeData = await fetchJson(cboeUrl);
        
        if (cboeData?.data?.options) {
            const options = cboeData.data.options;
            // Get 30-day expiry puts
            const targetDTE = 30;
            const puts = options.filter(opt => {
                if (!opt.option?.includes('P')) return false;
                // Estimate DTE from symbol
                const symDate = opt.option.substring(opt.option.length - 15, opt.option.length - 9);
                const expDate = new Date(2000 + parseInt(symDate.slice(0,2)), parseInt(symDate.slice(2,4)) - 1, parseInt(symDate.slice(4,6)));
                const dte = Math.floor((expDate - new Date()) / (1000 * 60 * 60 * 24));
                return dte >= 20 && dte <= 45;
            });
            
            if (puts.length > 0) {
                // Find ATM
                const putsWithStrike = puts.map(p => ({
                    ...p,
                    strike: parseFloat(p.option.slice(-8)) / 1000
                }));
                putsWithStrike.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
                const atm = putsWithStrike[0];
                const atmIV = atm.iv ? (atm.iv * 100) : null;
                
                if (atmIV) {
                    const ivRank = estimateIVRank(ticker, atmIV);
                    return {
                        ticker,
                        spot: spot.toFixed(2),
                        atmIV: atmIV.toFixed(1),
                        ivRank,
                        atmStrike: atm.strike,
                        source: 'cboe'
                    };
                }
            }
        }
        
        // No IV data available
        return {
            ticker,
            spot: spot.toFixed(2),
            atmIV: null,
            ivRank: null,
            source: 'none'
        };
        
    } catch (e) {
        console.log(`[IV] Error fetching IV for ${ticker}: ${e.message}`);
        throw e;
    }
}

// Estimate IV Rank based on typical ranges for different asset classes
// This is a heuristic since we don't have 52-week IV history
function estimateIVRank(ticker, currentIV) {
    // Typical IV ranges by asset type (based on historical norms)
    const ivRanges = {
        // High IV stocks (meme/growth)
        high: { tickers: ['GME', 'AMC', 'TSLA', 'RIVN', 'LCID', 'MARA', 'RIOT', 'COIN', 'HOOD', 'PLTR', 'SOFI', 'AFRM', 'UPST', 'HIMS', 'IONQ', 'SMCI', 'NVDA'], low: 40, high: 120 },
        // Medium IV (tech)
        medium: { tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'AMD', 'INTC', 'CRM', 'ADBE', 'ORCL'], low: 20, high: 60 },
        // Low IV (stable)
        low: { tickers: ['SPY', 'QQQ', 'IWM', 'DIA', 'JNJ', 'PG', 'KO', 'PEP', 'WMT', 'JPM', 'BAC'], low: 10, high: 35 },
        // Commodities/ETFs
        commodity: { tickers: ['GLD', 'SLV', 'USO', 'UNG', 'XLE', 'XLF', 'XLK'], low: 15, high: 50 },
        // Leveraged ETFs
        leveraged: { tickers: ['TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SOXL', 'SOXS', 'TSLL', 'NVDL'], low: 50, high: 150 }
    };
    
    // Find which category this ticker belongs to
    let range = { low: 20, high: 80 }; // Default range
    for (const [category, data] of Object.entries(ivRanges)) {
        if (data.tickers.includes(ticker.toUpperCase())) {
            range = data;
            break;
        }
    }
    
    // Calculate IV Rank (0-100)
    // IV Rank = (Current IV - 52wk Low IV) / (52wk High IV - 52wk Low IV) * 100
    let ivRank = Math.round((currentIV - range.low) / (range.high - range.low) * 100);
    ivRank = Math.max(0, Math.min(100, ivRank)); // Clamp 0-100
    
    return ivRank;
}

// Fetch option premium - Schwab first, CBOE fallback (with caching)
// optionType: 'PUT' or 'CALL' - derived from strategy
async function fetchOptionPremium(ticker, strike, expiry, optionType = 'PUT') {
    // Check cache first
    const cacheKey = getCacheKey(ticker, strike, expiry, optionType);
    const cached = optionPremiumCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logCache('HIT option premium', `${ticker} $${strike} ${optionType}`, Date.now() - cached.timestamp);
        return cached.data;
    }
    
    // Try Schwab first (real-time data)
    const schwabResult = await fetchOptionPremiumSchwab(ticker, strike, expiry, optionType);
    if (schwabResult) {
        // Cache and return
        optionPremiumCache.set(cacheKey, { data: schwabResult, timestamp: Date.now() });
        logCache('STORE option premium', `${ticker} $${strike} ${optionType}`);
        return schwabResult;
    }
    
    // Fallback to CBOE (delayed but always available)
    console.log(`[OPTION] Schwab unavailable, falling back to CBOE for ${ticker}`);
    const cboeResult = await fetchOptionPremiumCBOE(ticker, strike, expiry, optionType);
    if (cboeResult) {
        optionPremiumCache.set(cacheKey, { data: cboeResult, timestamp: Date.now() });
        logCache('STORE option premium', `${ticker} $${strike} ${optionType}`);
    }
    return cboeResult;
}

// Fetch option premium from Schwab
async function fetchOptionPremiumSchwab(ticker, strike, expiry, optionType = 'PUT') {
    try {
        // Parse expiry - supports "Feb 20", "Feb 20, 2028", "2028-01-21"
        const currentYear = new Date().getFullYear();
        let month, day, expiryYear;
        
        // Try "Mon DD, YYYY" format first (for LEAPS)
        const longMatch = expiry.match(/(\w+)\s+(\d+),?\s*(\d{4})/);
        if (longMatch) {
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[longMatch[1]];
            day = longMatch[2].padStart(2, '0');
            expiryYear = parseInt(longMatch[3]);
        } else {
            // Try "Mon DD" format (assumes current/next year)
            const shortMatch = expiry.match(/(\w+)\s+(\d+)/);
            if (!shortMatch) {
                console.log(`[SCHWAB] Could not parse expiry: ${expiry}`);
                return null;
            }
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[shortMatch[1]];
            day = shortMatch[2].padStart(2, '0');
            const currentMonth = new Date().getMonth() + 1;
            expiryYear = parseInt(month) < currentMonth ? currentYear + 1 : currentYear;
        }
        
        const expiryDate = `${expiryYear}-${month}-${day}`;
        
        console.log(`[SCHWAB] Fetching ${optionType}s for ${ticker} expiry ${expiryDate} strike=$${strike}`);
        
        // Fetch options for this expiry (use wider date range for LEAPS)
        const isLeaps = expiryYear > currentYear;
        const dateRangeDays = isLeaps ? 14 : 7; // LEAPS may have different exact dates
        const fromDate = expiryDate;
        const toDate = new Date(new Date(expiryDate).getTime() + dateRangeDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const chainData = await schwabApiCall(`/marketdata/v1/chains?symbol=${ticker}&contractType=${optionType}&fromDate=${fromDate}&toDate=${toDate}&strikeCount=50`);
        
        if (!chainData || chainData.status === 'FAILED') {
            console.log(`[SCHWAB] No option chain data for ${ticker}`);
            return null;
        }
        
        const expDateMap = optionType === 'PUT' ? chainData.putExpDateMap : chainData.callExpDateMap;
        if (!expDateMap || Object.keys(expDateMap).length === 0) {
            console.log(`[SCHWAB] No ${optionType} options in chain for ${ticker}`);
            return null;
        }
        
        // Collect ALL available options with their strikes
        const allOptions = [];
        for (const dateKey of Object.keys(expDateMap)) {
            const strikeMap = expDateMap[dateKey];
            for (const strikeKey of Object.keys(strikeMap)) {
                const options = strikeMap[strikeKey];
                if (options && options.length > 0) {
                    const opt = options[0];
                    allOptions.push({
                        strike: parseFloat(strikeKey),
                        expiry: dateKey.split(':')[0], // "2026-02-21:30" -> "2026-02-21"
                        option: opt
                    });
                }
            }
        }
        
        if (allOptions.length === 0) {
            console.log(`[SCHWAB] No ${optionType}s found for ${ticker}`);
            return null;
        }
        
        console.log(`[SCHWAB] Found ${allOptions.length} ${optionType.toLowerCase()}s. Available strikes: $${allOptions.map(p => p.strike).sort((a,b) => a-b).join(', $')}`);
        
        // Find closest strike to requested
        allOptions.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
        const closest = allOptions[0];
        const matchingOption = closest.option;
        
        // Warn if we had to adjust
        if (Math.abs(closest.strike - strike) > 0.01) {
            console.log(`[SCHWAB] ⚠️ Adjusted strike: $${strike} → $${closest.strike} (closest available)`);
        }
        
        console.log(`[SCHWAB] Using: ${matchingOption.symbol} strike=$${closest.strike} bid=${matchingOption.bid} ask=${matchingOption.ask} delta=${matchingOption.delta}`);
        
        return {
            bid: matchingOption.bid || 0,
            ask: matchingOption.ask || 0,
            last: matchingOption.last || 0,
            mid: ((matchingOption.bid || 0) + (matchingOption.ask || 0)) / 2,
            volume: matchingOption.totalVolume || 0,
            openInterest: matchingOption.openInterest || 0,
            // Schwab returns volatility as percentage (e.g., 65.11 = 65.11%), no need to multiply
            iv: matchingOption.volatility ? matchingOption.volatility.toFixed(1) : null,
            delta: matchingOption.delta || null,
            theta: matchingOption.theta || null,
            gamma: matchingOption.gamma || null,
            actualStrike: closest.strike, // The REAL strike used
            actualExpiry: closest.expiry, // The REAL expiry used
            source: 'schwab'
        };
    } catch (e) {
        console.log(`[SCHWAB] Failed to fetch option for ${ticker}: ${e.message}`);
        return null;
    }
}

// Fetch option premium from CBOE (fallback)
async function fetchOptionPremiumCBOE(ticker, strike, expiry, optionType = 'PUT') {
    try {
        const cacheBuster = Date.now();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
        const data = await fetchJson(cboeUrl);
        
        if (!data?.data?.options) {
            console.log(`[CBOE] No options data for ${ticker}`);
            return null;
        }
        
        // Parse expiry - can be "Feb 20", "Feb 20, 2028", "2028-01-21", etc.
        // CBOE format: HOOD260220P00095000 = HOOD + 26 (year) + 02 (month) + 20 (day) + P (put) + strike
        const currentYear = new Date().getFullYear();
        let month, day, year;
        
        // Try "Mon DD, YYYY" format first (for LEAPS)
        const longMatch = expiry.match(/(\w+)\s+(\d+),?\s*(\d{4})/);
        if (longMatch) {
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[longMatch[1]];
            day = longMatch[2].padStart(2, '0');
            year = longMatch[3].slice(-2); // "2028" -> "28"
        } else {
            // Try "Mon DD" format (assumes current/next year)
            const shortMatch = expiry.match(/(\w+)\s+(\d+)/);
            if (!shortMatch) {
                console.log(`[CBOE] Could not parse expiry: ${expiry}`);
                return null;
            }
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[shortMatch[1]];
            day = shortMatch[2].padStart(2, '0');
            year = String(currentYear).slice(-2); // Default to current year
        }
        
        // Determine option type symbol (C for call, P for put)
        const optSymbol = optionType === 'CALL' ? 'C' : 'P';
        console.log(`[CBOE] Looking for ${ticker} ${optionType} expiry: 20${year}-${month}-${day} strike=$${strike}`);
        
        // Get ALL options of the requested type
        const options = data.data.options;
        const filteredOptions = options.filter(opt => opt.option?.includes(optSymbol));
        
        // Build date prefix to filter by expiry (or nearby expirations)
        const datePrefix = `${ticker}${year}${month}`;
        
        // Filter to options near our target expiry (within a week)
        const targetDay = parseInt(day);
        const nearbyOptions = filteredOptions.filter(opt => {
            if (!opt.option?.startsWith(datePrefix)) return false;
            // Extract day from symbol
            const symDay = parseInt(opt.option.substring(ticker.length + 4, ticker.length + 6));
            return Math.abs(symDay - targetDay) <= 7;
        });
        
        if (nearbyOptions.length === 0) {
            console.log(`[CBOE] No ${optionType.toLowerCase()}s found for ${ticker} near 20${year}-${month}-${day}`);
            return null;
        }
        
        // Extract strikes and find available options
        const optionsWithStrikes = nearbyOptions.map(opt => ({
            option: opt,
            strike: parseFloat(opt.option.slice(-8)) / 1000,
            expiry: `${opt.option.substring(ticker.length, ticker.length + 6)}` // YYMMDD
        }));
        
        const availableStrikes = [...new Set(optionsWithStrikes.map(p => p.strike))].sort((a, b) => a - b);
        console.log(`[CBOE] Found ${nearbyOptions.length} ${optionType.toLowerCase()}s. Available strikes: $${availableStrikes.slice(0, 15).join(', $')}${availableStrikes.length > 15 ? '...' : ''}`);
        
        // Find closest strike to requested
        optionsWithStrikes.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
        const closest = optionsWithStrikes[0];
        
        // Warn if we adjusted
        if (Math.abs(closest.strike - strike) > 0.01) {
            console.log(`[CBOE] ⚠️ Adjusted strike: $${strike} → $${closest.strike} (closest available)`);
        }
        
        const match = closest.option;
        console.log(`[CBOE] Using: ${match.option} strike=$${closest.strike} bid=${match.bid} ask=${match.ask}`);
        
        return {
            bid: match.bid || 0,
            ask: match.ask || 0,
            last: match.last_trade_price || 0,
            mid: ((match.bid || 0) + (match.ask || 0)) / 2,
            volume: match.volume || 0,
            openInterest: match.open_interest || 0,
            iv: match.iv ? (match.iv * 100).toFixed(1) : null,
            actualStrike: closest.strike,
            source: 'cboe'
        };
    } catch (e) {
        console.log(`[CBOE] Failed to fetch premium for ${ticker}: ${e.message}`);
        return null;
    }
}

// Fetch extended data for deep dive analysis (with caching)
async function fetchDeepDiveData(ticker) {
    // Check cache first
    const cached = tickerDataCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logCache('HIT ticker data', ticker, Date.now() - cached.timestamp);
        return cached.data;
    }
    
    const result = {
        ticker,
        price: null,
        threeMonthData: null,
        yearHigh: null,
        yearLow: null,
        earnings: null,
        exDividend: null,
        avgVolume: null,
        recentSupport: [],
        recentResistance: []
    };
    
    try {
        // Fetch 3-month daily data for support/resistance analysis
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`;
        const chartData = await fetchJson(chartUrl);
        const quote = chartData.chart?.result?.[0];
        const meta = quote?.meta;
        
        result.price = meta?.regularMarketPrice?.toFixed(2);
        result.yearHigh = meta?.fiftyTwoWeekHigh?.toFixed(2);
        result.yearLow = meta?.fiftyTwoWeekLow?.toFixed(2);
        
        // Get price history
        const closes = quote?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
        const lows = quote?.indicators?.quote?.[0]?.low?.filter(l => l !== null) || [];
        const highs = quote?.indicators?.quote?.[0]?.high?.filter(h => h !== null) || [];
        
        if (closes.length > 0) {
            result.threeMonthHigh = Math.max(...closes).toFixed(2);
            result.threeMonthLow = Math.min(...closes).toFixed(2);
            
            // Calculate moving averages
            const last20 = closes.slice(-20);
            const last50 = closes.slice(-50);
            result.sma20 = (last20.reduce((a, b) => a + b, 0) / last20.length).toFixed(2);
            result.sma50 = last50.length >= 50 
                ? (last50.reduce((a, b) => a + b, 0) / last50.length).toFixed(2) 
                : null;
            
            // Find potential support levels (recent lows)
            if (lows.length > 20) {
                const recentLows = lows.slice(-20).sort((a, b) => a - b);
                result.recentSupport = [
                    recentLows[0].toFixed(2),
                    recentLows[Math.floor(recentLows.length * 0.1)].toFixed(2)
                ];
            }
            
            // Price position relative to moving averages
            const currentPrice = parseFloat(result.price);
            result.aboveSMA20 = currentPrice > parseFloat(result.sma20);
            result.aboveSMA50 = result.sma50 ? currentPrice > parseFloat(result.sma50) : null;
        }
        
        // Fetch calendar data (earnings, dividends)
        try {
            const calUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`;
            const calData = await fetchJson(calUrl);
            const cal = calData.quoteSummary?.result?.[0]?.calendarEvents;
            
            if (cal?.earnings?.earningsDate?.[0]?.raw) {
                result.earnings = new Date(cal.earnings.earningsDate[0].raw * 1000)
                    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }
            if (cal?.exDividendDate?.raw) {
                result.exDividend = new Date(cal.exDividendDate.raw * 1000)
                    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }
        } catch (e) { /* ignore */ }
        
    } catch (e) {
        console.log(`[AI] Deep dive data fetch error for ${ticker}:`, e.message);
    }
    
    // Cache the result
    tickerDataCache.set(ticker, { data: result, timestamp: Date.now() });
    logCache('STORE ticker data', ticker);
    
    return result;
}

// Build deep dive analysis prompt
function buildDeepDivePrompt(tradeData, tickerData) {
    const { ticker, strike, expiry, currentPrice } = tradeData;
    const t = tickerData;
    
    const strikeNum = parseFloat(strike);
    const priceNum = parseFloat(currentPrice || t.price);
    const otmPercent = ((priceNum - strikeNum) / priceNum * 100).toFixed(1);
    const assignmentCost = strikeNum * 100;
    
    // Format premium data if available
    let premiumSection = '';
    if (t.premium) {
        const p = t.premium;
        const premiumPerShare = p.mid.toFixed(2);
        const totalPremium = (p.mid * 100).toFixed(0);
        const costBasis = (strikeNum - p.mid).toFixed(2);
        const roc = ((p.mid / strikeNum) * 100).toFixed(2);
        
        // Calculate DTE for annualized ROC
        const expiryParts = expiry.match(/(\w+)\s+(\d+)/);
        let dte = 30; // Default
        if (expiryParts) {
            const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const expMonth = monthMap[expiryParts[1]];
            const expDay = parseInt(expiryParts[2]);
            const expYear = expMonth < new Date().getMonth() ? new Date().getFullYear() + 1 : new Date().getFullYear();
            const expDate = new Date(expYear, expMonth, expDay);
            dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
        }
        const annualizedRoc = ((p.mid / strikeNum) * (365 / dte) * 100).toFixed(1);
        
        // Probability of profit from delta (if available)
        let probProfit = '';
        if (p.delta) {
            const pop = ((1 - Math.abs(p.delta)) * 100).toFixed(0);
            probProfit = `\nProbability of Profit: ~${pop}% (based on delta ${p.delta.toFixed(2)})`;
        }
        
        const source = p.source === 'schwab' ? '🔴 SCHWAB (real-time)' : '🔵 CBOE (15-min delay)';
        
        // Note if strike was adjusted to actual available strike
        let strikeNote = '';
        if (p.actualStrike && Math.abs(p.actualStrike - strikeNum) > 0.01) {
            strikeNote = `\n⚠️ NOTE: Using actual available strike $${p.actualStrike} (requested $${strikeNum} not available)`;
        }
        
        premiumSection = `
═══ LIVE OPTION PRICING — ${source} ═══${strikeNote}
Bid: $${p.bid.toFixed(2)} | Ask: $${p.ask.toFixed(2)} | Mid: $${premiumPerShare}
Volume: ${p.volume} | Open Interest: ${p.openInterest}
${p.iv ? `Implied Volatility: ${p.iv}%` : ''}${probProfit}
Premium Income: $${totalPremium} (for 1 contract)
If Assigned, Cost Basis: $${costBasis}/share
Return on Capital: ${roc}% for ${dte} days = ${annualizedRoc}% annualized`;
    }
    
    return `You are analyzing a WHEEL STRATEGY trade in depth. Provide comprehensive analysis.

═══ THE TRADE ═══
Ticker: ${ticker}
Current Price: $${currentPrice || t.price}
Proposed: Sell $${strike} put, expiry ${expiry}
OTM Distance: ${otmPercent}%
Assignment Cost: $${assignmentCost.toLocaleString()} (100 shares @ $${strike})
${premiumSection}

═══ TECHNICAL DATA ═══
52-Week Range: $${t.yearLow} - $${t.yearHigh}
3-Month Range: $${t.threeMonthLow} - $${t.threeMonthHigh}
20-Day SMA: $${t.sma20} (price ${t.aboveSMA20 ? 'ABOVE' : 'BELOW'})
${t.sma50 ? `50-Day SMA: $${t.sma50} (price ${t.aboveSMA50 ? 'ABOVE' : 'BELOW'})` : ''}
Recent Support Levels: $${t.recentSupport.join(', $')}

═══ CALENDAR ═══
${t.earnings ? `⚠️ Next Earnings: ${t.earnings}` : 'No upcoming earnings date found'}
${t.exDividend ? `📅 Ex-Dividend: ${t.exDividend}` : ''}

═══ PROVIDE THIS ANALYSIS ═══

**1. STRIKE ANALYSIS**
- Is $${strike} a good strike? Compare to support levels and moving averages.
- More conservative option: What LOWER strike (further OTM) would reduce assignment risk? (less premium, safer)
- More aggressive option: What HIGHER strike (closer to current price) would yield more premium? (more risk, more reward)

**2. EXPIRY ANALYSIS**
- Is ${expiry} a good expiry given the earnings date?
- Shorter expiry option: If you want less risk
- Longer expiry option: If you want more premium

**3. SCENARIO ANALYSIS**
- Bull case: Stock rallies 10% - what happens?
- Base case: Stock stays flat - what's your profit?
- Bear case: Stock drops 15% - are you comfortable owning at $${strike}?
- Disaster case: Stock drops 30% - what's the damage?

**4. IF ASSIGNED (the wheel continues)**
- Cost basis if assigned: $${strike} minus premium received
- What covered call strike makes sense?
- Is this a stock you'd WANT to own at $${strike}?

**5. VERDICT** (REQUIRED - be decisive!)
Rate this trade with ONE of these:
- ✅ ENTER TRADE - Good setup, acceptable risk
- ⚠️ WAIT - Not ideal entry, watch for better price
- ❌ AVOID - Risk too high or poor setup

Give a 1-2 sentence summary justifying your rating.

Be specific with numbers. Use the data provided. DO NOT hedge with "it depends" - make a call.`;
}

// Build prompt for position checkup - compares opening thesis to current state
function buildCheckupPrompt(tradeData, openingThesis, currentData, currentPremium) {
    const { ticker, strike, expiry, positionType } = tradeData;
    const o = openingThesis; // Opening state
    const c = currentData;   // Current state
    
    // Determine if this is a LONG (debit) position - different evaluation!
    const isLongPosition = ['long_call', 'long_put', 'long_call_leaps', 'skip_call', 'call_debit_spread', 'put_debit_spread'].includes(positionType);
    const isCall = positionType?.includes('call');
    const positionDesc = isLongPosition ? `Long $${strike} ${isCall ? 'call' : 'put'}` : `Short $${strike} ${isCall ? 'call' : 'put'}`;
    
    // Parse prices as numbers (they might come as strings from API)
    const currentPrice = parseFloat(c.price) || 0;
    const entryPrice = parseFloat(o.priceAtAnalysis) || 0;
    
    // Calculate changes
    const priceChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : 0;
    const priceDirection = priceChange >= 0 ? '📈 UP' : '📉 DOWN';
    
    // Range position: 0% = at low, 100% = at high
    const openingRange = o.rangePosition !== undefined ? o.rangePosition : 'N/A';
    const threeMonthHigh = parseFloat(c.threeMonthHigh) || 0;
    const threeMonthLow = parseFloat(c.threeMonthLow) || 0;
    const currentRange = (threeMonthHigh && threeMonthLow && threeMonthHigh !== threeMonthLow) ? 
        (((currentPrice - threeMonthLow) / (threeMonthHigh - threeMonthLow)) * 100).toFixed(0) : 'N/A';
    
    // Days since analysis
    const daysSinceOpen = Math.floor((Date.now() - new Date(o.analyzedAt).getTime()) / (1000 * 60 * 60 * 24));
    
    // DTE calculation
    const expDate = new Date(expiry);
    const dte = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));
    
    // Format premium comparison - opposite meaning for long vs short!
    let premiumChange = '';
    if (o.premium && currentPremium) {
        const openMid = parseFloat(o.premium.mid) || 0;
        const currMid = parseFloat(currentPremium.mid) || 0;
        const pctChange = openMid > 0 ? ((currMid - openMid) / openMid * 100).toFixed(0) : 0;
        
        // For LONG options: you want premium to INCREASE (buy low, sell high)
        // For SHORT options: you want premium to DECREASE (sell high, buy back low)
        const profitMessage = isLongPosition
            ? (currMid > openMid ? '✅ Premium has INCREASED - position is PROFITABLE' : '⚠️ Premium has DECREASED - position is underwater')
            : (currMid < openMid ? '✅ Premium has DECAYED - trade is profitable' : '⚠️ Premium has INCREASED - trade is underwater');
        
        premiumChange = `
OPTION PREMIUM MOVEMENT:
At Entry: $${openMid.toFixed(2)} mid
Now: $${currMid.toFixed(2)} mid (${pctChange >= 0 ? '+' : ''}${pctChange}%)
${profitMessage}`;
    }
    
    return `You are conducting a POSITION CHECKUP for ${isLongPosition ? 'a LONG option position' : 'a wheel trade'}. Compare the opening thesis to current conditions.

═══ THE POSITION ═══
Ticker: ${ticker}
Trade: ${positionDesc}, expiry ${expiry}
Position Type: ${isLongPosition ? '🟠 LONG (debit) - You PAID premium and profit from DIRECTION, not theta!' : '🟢 SHORT (credit) - You collected premium and profit from theta decay'}
Days to Expiry: ${dte}
Days Held: ${daysSinceOpen}

═══ THEN vs NOW ═══

PRICE MOVEMENT:
At Entry (${new Date(o.analyzedAt).toLocaleDateString()}): $${entryPrice.toFixed(2)}
Now: $${currentPrice.toFixed(2)} (${priceDirection} ${Math.abs(priceChange)}%)

RANGE POSITION (0% = 3mo low, 100% = 3mo high):
At Entry: ${openingRange}% of range
Now: ${currentRange}% of range
${currentRange !== 'N/A' && openingRange !== 'N/A' ? (
  parseFloat(currentRange) > parseFloat(openingRange) 
    ? (isLongPosition && isCall ? '📈 Stock has moved UP in range (GOOD for long call!)' : isLongPosition ? '📈 Stock has moved UP in range (bad for long put)' : '📈 Stock has moved UP in range (good for short put)')
    : parseFloat(currentRange) < parseFloat(openingRange) 
    ? (isLongPosition && isCall ? '📉 Stock has moved DOWN in range (bad for long call)' : isLongPosition ? '📉 Stock has moved DOWN in range (GOOD for long put!)' : '📉 Stock has moved DOWN in range (closer to strike)')
    : '➡️ Roughly the same position'
) : ''}

TECHNICAL LEVELS:
Entry SMA20: $${o.sma20 || 'N/A'} | Now: $${c.sma20 || 'N/A'}
Entry SMA50: $${o.sma50 || 'N/A'} | Now: $${c.sma50 || 'N/A'}
Entry Support: $${o.support?.join(', $') || 'N/A'}
Current Support: $${c.recentSupport?.join(', $') || 'N/A'}
${premiumChange}

CALENDAR EVENTS:
Entry Earnings: ${o.earnings || 'None scheduled'}
Current Earnings: ${c.earnings || 'None scheduled'}
${o.earnings && !c.earnings ? '✅ Earnings have PASSED - thesis event resolved' : ''}
${!o.earnings && c.earnings ? '⚠️ NEW earnings date appeared!' : ''}

═══ ORIGINAL ENTRY THESIS ═══
Verdict at Entry: ${o.aiSummary?.verdict || 'N/A'}
Summary: ${o.aiSummary?.summary || 'N/A'}

═══ YOUR CHECKUP ASSESSMENT ═══

**1. THESIS STATUS**
Has the original reason for entry been validated, invalidated, or is it still playing out?

**2. RISK ASSESSMENT**
- Distance from strike: Is the stock now closer or further from $${strike}?
- Support levels: Have they held or broken?
- Probability of assignment: Higher, lower, or same as at entry?

**3. TIME DECAY / THETA**
With ${dte} days remaining:
${isLongPosition ? `⚠️ IMPORTANT: This is a LONG (debit) position - theta works AGAINST you!
- Negative theta is EXPECTED and NOT a problem - it's the cost of holding the position.
- You profit from DELTA (directional move), not theta decay.
- ${dte >= 365 ? '📅 LEAPS: Daily theta is tiny! Focus on thesis, not time decay.' : dte >= 180 ? '⏳ Long-dated: Theta decay is slow. Direction matters more.' : 'Theta accelerates under 45 DTE - time is working against you.'}` : dte >= 365 ? `- 📅 LEAPS EVALUATION: Daily theta is MINIMAL for long-dated options!
- Focus on: Has the THESIS played out? Stock direction matters more than time decay.
- VEGA matters: Has IV changed significantly since entry?` : dte >= 180 ? `- ⏳ LONG-DATED: Theta decay is slow. Focus on directional thesis and IV changes.` : `- Is theta working for you? (Short options COLLECT theta)
- How much of the original premium has decayed?`}

**4. ACTION RECOMMENDATION**
${!isLongPosition && isCall && currentPrice > strike ? `
⚠️ YOUR COVERED CALL IS ITM - Consider ALL options, not just rolling!

ALTERNATIVES TO ROLLING:
• 🎯 LET IT GET CALLED - Take your profit and redeploy capital
• 📈 BUY A LONG CALL - Buy a call above current price to capture more upside
• 📊 BUY A CALL DEBIT SPREAD - Defined risk way to participate in further rally
• 💰 SELL PUTS BELOW - Add bullish exposure if you'd buy more on a pullback
• 🔄 ROLL UP & OUT - Traditional approach, but may be fighting the trend

Pick ONE:
- ✅ HOLD - Let position get called away (take the win!)
- 📈 ADD UPSIDE - Buy a long call or call spread to capture more gains
- 💰 ADD EXPOSURE - Sell puts below to add bullish delta
- 🔄 ROLL - Roll up/out (explain why this beats taking assignment)
- ⚠️ CLOSE EARLY - Buy back call to keep shares (expensive but keeps upside)` : `Pick ONE:
${dte >= 365 ? `- ✅ HOLD - LEAPS are meant to be held; thesis still valid
- 🔄 ROLL UP/DOWN - Adjust strike if stock moved significantly (not for time!)
- 💰 CLOSE - Take profit if thesis achieved or invalidated
- 📈 ADD - Consider adding on pullback if thesis strengthening` : `- ✅ HOLD - Thesis intact, let it ride
- 🔄 ROLL - Consider rolling (specify why - expiry, strike, or both)
- 💰 CLOSE - Take profit/loss now (specify when)
- ⚠️ WATCH - Position needs monitoring (specify triggers)`}`}

**5. CHECKUP VERDICT**
Rate the position health:
- 🟢 HEALTHY - On track, no action needed
- 🟡 STABLE - Minor concerns but manageable
- 🔴 AT RISK - Original thesis weakening, action may be needed

Give a 2-3 sentence summary of how the position has evolved since entry.`;
}

// Build prompt to parse Discord/chat trade callout into structured JSON
function buildTradeParsePrompt(tradeText) {
    return `Parse this trade callout into JSON. Extract the key fields.

TRADE CALLOUT:
${tradeText}

INSTRUCTIONS:
1. Extract: ticker, strategy, expiry, strike(s), premium/entry price
2. For spreads, use "buyStrike" and "sellStrike" - KEEP THEM EXACTLY AS STATED
   - If callout says "Buy 400 / Sell 410", then buyStrike=400, sellStrike=410
   - Do NOT swap or reorder the strikes
3. Normalize strategy to: "short_put", "short_call", "covered_call", "bull_put_spread", "bear_call_spread", "call_debit_spread", "put_debit_spread", "long_call", "long_put", "long_call_leaps", "long_put_leaps"
   - LEAPS are options with expiry 1+ year out - use "long_call_leaps" or "long_put_leaps" if mentioned
4. Format expiry as "YYYY-MM-DD" (e.g., "2026-02-21" or "2028-01-21")
   - ALWAYS include the full year, especially for LEAPS (1+ year out)
   - If year is "26" or "28", interpret as 2026 or 2028
5. Premium should be the OPTION premium (what you pay/receive for the option), NOT the stock price
   - If callout says "PLTR @ $167 - Sell $150 put" → $167 is STOCK PRICE, not premium. Premium is unknown.
   - If callout says "Sell $150 put for $4.85" → Premium is 4.85
   - If no premium mentioned, set premium to null
6. IMPORTANT: Stock prices are typically $50-$500+, option premiums are typically $0.50-$15
   - If you see "@" followed by a price, that's usually the stock price, NOT the option premium

RESPOND WITH ONLY JSON, no explanation:
{
    "ticker": "SYMBOL",
    "strategy": "strategy_type",
    "expiry": "2026-02-21",
    "strike": 100,
    "buyStrike": null,
    "sellStrike": null,
    "premium": null,
    "stockPrice": 167.00,
    "notes": "any additional context from the callout"
}

For spreads, strike should be null and buyStrike/sellStrike should have values.
For single-leg options, strike should have a value and buyStrike/sellStrike should be null.
If premium is not explicitly stated, set it to null (we'll fetch live pricing).`;
}

// Build prompt to analyze a Discord trade callout
function buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium, patternContext = null) {
    const t = tickerData;
    const isSpread = parsed.buyStrike || parsed.sellStrike;
    const strikeDisplay = isSpread 
        ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
        : `$${parsed.strike}`;
    
    // Calculate OTM distance
    const price = parseFloat(t.price) || 0;
    const strike = parseFloat(parsed.strike || parsed.sellStrike) || 0;
    const otmPercent = price > 0 ? ((price - strike) / price * 100).toFixed(1) : 'N/A';
    
    // Calculate range position (0% = at 3-month low, 100% = at 3-month high)
    const threeMonthHigh = parseFloat(t.threeMonthHigh) || 0;
    const threeMonthLow = parseFloat(t.threeMonthLow) || 0;
    let rangePosition = 'N/A';
    let rangeContext = '';
    if (threeMonthHigh > threeMonthLow && price > 0) {
        const pct = Math.round(((price - threeMonthLow) / (threeMonthHigh - threeMonthLow)) * 100);
        rangePosition = pct;
        if (pct <= 20) {
            rangeContext = '🟢 NEAR 3-MONTH LOW - Stock has pulled back, good entry for short puts';
        } else if (pct <= 40) {
            rangeContext = '🟡 Lower half of range - Decent entry point';
        } else if (pct <= 60) {
            rangeContext = '⚪ Mid-range - Neutral positioning';
        } else if (pct <= 80) {
            rangeContext = '🟠 Upper half of range - Caution for short puts';
        } else {
            rangeContext = '🔴 NEAR 3-MONTH HIGH - Risky entry, stock may be topping';
        }
    }
    
    // Calculate DTE (days to expiry)
    let dte = 'unknown';
    let dteWarning = '';
    if (parsed.expiry) {
        const expDate = parseExpiryDate(parsed.expiry);
        if (expDate) {
            const now = new Date();
            const diffMs = expDate - now;
            dte = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            
            // Add warnings for short DTE and notes for LEAPS
            if (dte <= 0) {
                dteWarning = '🚨 EXPIRED OR EXPIRING TODAY - DO NOT ENTER';
            } else if (dte <= 3) {
                dteWarning = '🚨 VERY SHORT DTE - High gamma risk, small moves = big swings';
            } else if (dte <= 7) {
                dteWarning = '⚠️ SHORT DTE - Limited time for thesis to play out';
            } else if (dte <= 14) {
                dteWarning = 'ℹ️ 2 weeks or less - Theta accelerating';
            } else if (dte >= 365) {
                dteWarning = '📅 LEAPS (1+ year) - Long-term position, evaluate as stock proxy. Daily theta is minimal, but VEGA (IV sensitivity) matters more.';
            } else if (dte >= 180) {
                dteWarning = '📅 LONG-DATED (6+ months) - Extended horizon means IV changes matter more than daily theta.';
            }
        }
    }
    
    // Calculate risk/reward - DIFFERENT FOR SPREADS vs SINGLE LEG
    let riskRewardSection = '';
    
    // Validate premium: stock prices are >$50, option premiums typically $0.50-$15
    // For SELLING options: you want HIGHER entry (above mid is good)
    // For BUYING options: you want LOWER entry (below mid is good)
    const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                      parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
    const calloutPremiumValid = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50;
    const effectivePremium = calloutPremiumValid ? parseFloat(parsed.premium) : (premium?.mid || 0);
    
    if (isSpread && parsed.buyStrike && parsed.sellStrike) {
        // SPREAD RISK/REWARD
        const buyStrike = parseFloat(parsed.buyStrike);
        const sellStrike = parseFloat(parsed.sellStrike);
        const spreadWidth = Math.abs(sellStrike - buyStrike);
        const maxProfit = effectivePremium * 100;
        const maxLoss = (spreadWidth - effectivePremium) * 100;
        const capitalRequired = maxLoss; // For credit spreads, capital = max loss
        const returnOnRisk = maxLoss > 0 ? (maxProfit / maxLoss * 100).toFixed(1) : 'N/A';
        const premiumVsWidth = ((effectivePremium / spreadWidth) * 100).toFixed(1);
        
        // Breakeven for credit spreads
        const isBullPut = parsed.strategy?.includes('bull') || parsed.strategy?.includes('put_credit');
        const breakeven = isBullPut 
            ? sellStrike - effectivePremium  // Bull put: short strike - premium
            : sellStrike + effectivePremium; // Bear call: short strike + premium
        
        riskRewardSection = `
═══ SPREAD RISK/REWARD MATH ═══
Strategy: ${parsed.strategy?.toUpperCase()}
Spread Width: $${spreadWidth} ($${buyStrike} to $${sellStrike})
Premium: $${effectivePremium.toFixed(2)} (${premiumVsWidth}% of spread width)${!calloutPremiumValid ? ' [using live mid]' : ''}
Max Profit: $${maxProfit.toFixed(0)} (keep full credit if OTM at expiry)
Max Loss: $${maxLoss.toFixed(0)} (spread width - premium)
Return on Risk: ${returnOnRisk}% ($${maxProfit.toFixed(0)} profit / $${maxLoss.toFixed(0)} risk)
Capital Required: $${capitalRequired.toFixed(0)} (margin = max loss for spreads)
Breakeven: $${breakeven.toFixed(2)}

💡 SPREAD GUIDELINES:
- Good spreads collect ≥30% of width as premium
- This trade collects ${premiumVsWidth}% ${parseFloat(premiumVsWidth) >= 30 ? '✅' : '⚠️ (below 30%)'}`;
        
    } else if (effectivePremium && strike) {
        // SINGLE LEG (naked put, covered call, etc.)
        const maxProfit = effectivePremium * 100;
        const maxRisk = (strike - effectivePremium) * 100;
        const riskRewardRatio = maxRisk > 0 ? (maxProfit / maxRisk * 100).toFixed(2) : 'N/A';
        
        // Add DTE context for LEAPS
        const dteContext = dte >= 365 ? '\n📅 LEAPS NOTE: High premium is expected - contains significant time value. Evaluate cost basis after premium vs holding stock directly.' :
                           dte >= 180 ? '\n⏳ LONG-DATED NOTE: Premium reflects extended time value. Good for cost basis reduction on covered calls.' : '';
        
        riskRewardSection = `
═══ SINGLE-LEG RISK/REWARD MATH ═══
Premium: $${effectivePremium.toFixed(2)}${!calloutPremiumValid ? ' [using live mid price]' : ''}
Max Profit: $${maxProfit.toFixed(0)} (keep full premium if OTM at expiry)
Max Risk: $${maxRisk.toFixed(0)} (if stock goes to $0)
Risk/Reward: ${riskRewardRatio}% return on risk
Capital Required: $${(strike * 100).toFixed(0)} (to secure 1 contract)${dteContext}`;
    }
    
    // Format premium section
    let premiumSection = '';
    if (premium) {
        let entryQuality = '';
        // Only compare if callout had a premium AND it looks like an option premium (not stock price)
        if (premium.mid && calloutPremiumValid) {
            if (isSelling) {
                // Selling: want to get MORE than mid
                entryQuality = parsed.premium >= premium.mid 
                    ? '(got ≥ mid ✅)' 
                    : `(got ${((1 - parsed.premium/premium.mid) * 100).toFixed(0)}% LESS than mid ⚠️)`;
            } else {
                // Buying: want to pay LESS than mid
                entryQuality = parsed.premium <= premium.mid 
                    ? '(paid ≤ mid ✅)' 
                    : `(paid ${((parsed.premium/premium.mid - 1) * 100).toFixed(0)}% MORE than mid ⚠️)`;
            }
        }
        
        // Only show discrepancy if we have a valid callout premium to compare
        const showDiscrepancy = calloutPremiumValid && Math.abs(premium.mid - parsed.premium) > 0.5;
        
        premiumSection = `
LIVE CBOE PRICING:
Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
${premium.iv ? `IV: ${premium.iv}%` : ''}
${calloutPremiumValid ? `Callout Entry: $${parsed.premium} ${entryQuality}` : 'Callout Entry: Not specified - using live mid price for calculations'}
${showDiscrepancy ? '⚠️ LARGE DISCREPANCY between callout entry and current mid - trade may be stale!' : ''}`;
    } else if (calloutPremiumValid) {
        premiumSection = `\nCALLOUT ENTRY PRICE: $${parsed.premium}`;
    }
    
    // Build pattern context section if available
    let patternSection = '';
    if (patternContext) {
        patternSection = `
═══ YOUR HISTORICAL TRADING PATTERNS ═══
⚠️ IMPORTANT: This data is from YOUR OWN past trades. Use it to inform your decision!

${patternContext}
`;
    }

    return `You are evaluating a TRADE CALLOUT from a Discord trading group. Analyze whether this is a good trade.

═══ THE CALLOUT ═══
Ticker: ${parsed.ticker}
Strategy: ${parsed.strategy}
Strike: ${strikeDisplay}
Expiry: ${parsed.expiry} (${dte} days to expiry)
${dteWarning ? dteWarning : ''}
Entry Premium: ${calloutPremiumValid ? '$' + parsed.premium : 'Not specified in callout'}
${parsed.notes ? `Notes: ${parsed.notes}` : ''}
${riskRewardSection}

═══ CURRENT MARKET DATA ═══
Current Price: $${t.price}
📊 RANGE POSITION: ${rangePosition}% ${rangeContext}
${strike ? `OTM Distance: ${otmPercent}%` : ''}
52-Week Range: $${t.yearLow} - $${t.yearHigh}
3-Month Range: $${t.threeMonthLow} - $${t.threeMonthHigh}
20-Day SMA: $${t.sma20} (price ${t.aboveSMA20 ? 'ABOVE ✅' : 'BELOW ⚠️'})
${t.sma50 ? `50-Day SMA: $${t.sma50}` : ''}
Support Levels: $${t.recentSupport?.join(', $') || 'N/A'}
${t.earnings ? `⚠️ Earnings: ${t.earnings}` : 'No upcoming earnings'}
${premiumSection}
${patternSection}
═══ YOUR ANALYSIS ═══
${patternContext ? `
**0. PATTERN CHECK** (IMPORTANT - Look at YOUR HISTORICAL TRADING PATTERNS above!)
- Does this trade match a WINNING pattern from your history? Mention it!
- Does this trade resemble a LOSING pattern? WARN about it!
- If no history exists for this ticker/strategy, say so.
` : ''}
**1. TRADE SETUP REVIEW**
- Is this a reasonable entry? Evaluate strike selection vs support/resistance.
- Is the expiry sensible given any upcoming events?
${isSpread ? '- For spreads: Is the premium collected a good % of spread width? (≥30% is ideal)' : '- Is the premium worth the risk? Use the RISK/REWARD MATH above.'}
${dte <= 7 ? '- ⚠️ WITH ONLY ' + dte + ' DAYS TO EXPIRY, is there enough time for theta decay?' : ''}
${dte >= 365 ? '- 📅 LEAPS CONSIDERATIONS: This is a long-term directional bet. Premium is HIGH but so is time value. Evaluate as stock alternative with defined risk.' : ''}
${dte >= 180 && dte < 365 ? '- ⏳ LONG-DATED: Extended horizon gives time for thesis to play out. IV sensitivity (vega) matters more than daily theta.' : ''}

**2. TECHNICAL CHECK**
- Note the RANGE POSITION above - use it to assess entry timing
- How far OTM is the strike? Is there adequate cushion?
- Are support levels being respected?

**3. RISK/REWARD**
- What's the max risk on this trade?
- What's the realistic profit target?
- Is the risk/reward ratio favorable?

**4. RED FLAGS**
- Any concerns? Earnings, ex-dividend, low volume, etc.?
- Is this "chasing" a move or entering at support?

**5. VERDICT SPECTRUM** (Give ALL THREE perspectives!)

🟢 **AGGRESSIVE VIEW**: 
- What's the bull case for taking this trade?
- Probability of max profit (expires worthless): X%

🟡 **MODERATE VIEW**:
- What's the balanced take?
- Would you take this with position sizing adjustments?

🔴 **CONSERVATIVE VIEW**:
- What concerns would make you pass?
- What would need to change for a better entry?

**BOTTOM LINE**: In one sentence, what type of trader is this trade best suited for?

Be specific. Use the data. Give percentages where possible.`;
}

// Helper to fetch JSON over HTTP (for local services like Ollama)
function fetchJsonHttp(url) {
    return new Promise((resolve, reject) => {
        http.get(url, { 
            headers: { 
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', reject);
    });
}

// Helper to fetch plain text over HTTPS
function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// Compare semantic versions (returns 1 if a > b, -1 if a < b, 0 if equal)
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    
    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

// Build a structured prompt for the AI trade advisor
// Now supports semantic search for wisdom and skipWisdom parameter
async function buildTradePrompt(data, isLargeModel = false) {
    const {
        ticker, positionType, strike, premium, dte, contracts,
        spot, costBasis, breakeven, maxProfit, maxLoss,
        iv, riskPercent, winProbability, costToClose,
        rollOptions, expertRecommendation, previousAnalysis,
        portfolioContext,  // Portfolio context from audit
        chainHistory,      // Array of previous positions in this chain
        totalPremiumCollected,  // Net premium across all rolls
        skipWisdom,        // Skip wisdom for "pure" analysis
        closedSummary      // Historical closed positions for pattern matching
    } = data;
    
    // Load relevant wisdom using semantic search (unless skipped)
    let wisdomSection = '';
    let wisdomUsed = [];
    
    if (!skipWisdom) {
        try {
            // Build a query from the position context
            const query = `${ticker} ${positionType?.replace(/_/g, ' ')} strike ${strike} ${dte} days to expiry ${riskPercent > 50 ? 'high risk' : 'low risk'} ${spot > strike ? 'ITM' : 'OTM'}`;
            
            // Use semantic search (with category fallback)
            const searchResults = await searchWisdom(query, positionType, 5);
            
            if (searchResults.length > 0) {
                wisdomUsed = searchResults.map(r => r.entry);
                const wisdomList = searchResults.map(r => {
                    const relevanceTag = r.score > 0.7 ? '🎯' : r.score > 0.5 ? '📌' : '📚';
                    return `${relevanceTag} [${r.entry.category}] ${r.entry.wisdom}`;
                }).join('\n');
                
                wisdomSection = `
═══ YOUR TRADING RULES (MANDATORY) ═══
These are YOUR personal rules from your knowledge base. You MUST:
1. Follow these unless there's a COMPELLING reason not to
2. CITE which rule(s) influenced your recommendation  
3. If you contradict a rule, EXPLAIN WHY the situation warrants an exception

${wisdomList}

At the END of your response, include:
📚 Rules Applied: [list which rules you followed]
📚 Rules Overridden: [list any rules you deviated from and why]
`;
            }
        } catch (e) {
            console.log('[WISDOM] Search error:', e.message);
        }
    }
    
    // Store wisdom in function result metadata
    buildTradePrompt._lastWisdomUsed = wisdomUsed;
    
    // Determine position characteristics
    const isLongCall = positionType === 'long_call';
    const isLongPut = positionType === 'long_put';
    const isLong = isLongCall || isLongPut;
    const isCall = isLongCall || positionType === 'buy_write' || positionType === 'covered_call' || positionType === 'short_call';
    const isCoveredCall = positionType === 'covered_call' || positionType === 'buy_write';
    const isShortPut = positionType === 'short_put';
    
    // Generate historical pattern context if closed summary is available
    let patternContext = '';
    if (closedSummary && closedSummary.length > 0) {
        const tickerUpper = ticker?.toUpperCase();
        const typeNormalized = positionType?.toLowerCase().replace(/\s+/g, '_') || '';
        
        // Find matching trades
        const sameTickerType = closedSummary.filter(p => 
            p.ticker?.toUpperCase() === tickerUpper && 
            p.type?.toLowerCase().replace(/\s+/g, '_') === typeNormalized
        );
        const sameTicker = closedSummary.filter(p => p.ticker?.toUpperCase() === tickerUpper);
        const sameType = closedSummary.filter(p => p.type?.toLowerCase().replace(/\s+/g, '_') === typeNormalized);
        
        const calcStats = (trades) => {
            if (trades.length === 0) return null;
            const totalPnL = trades.reduce((sum, p) => sum + (p.pnl || 0), 0);
            const winners = trades.filter(p => (p.pnl || 0) >= 0);
            return { count: trades.length, totalPnL, winRate: (winners.length / trades.length * 100), avgPnL: totalPnL / trades.length };
        };
        
        const tickerTypeStats = calcStats(sameTickerType);
        const tickerStats = calcStats(sameTicker);
        const typeStats = calcStats(sameType);
        
        let patternText = '';
        const warnings = [];
        const encouragements = [];
        
        if (tickerTypeStats && tickerTypeStats.count >= 2) {
            patternText += `• ${tickerUpper} ${typeNormalized.replace(/_/g,' ')}: ${tickerTypeStats.count} trades, ${tickerTypeStats.winRate.toFixed(0)}% win, $${tickerTypeStats.totalPnL.toFixed(0)} total\n`;
            if (tickerTypeStats.winRate < 40) warnings.push(`LOW WIN RATE on ${tickerUpper} ${typeNormalized.replace(/_/g,' ')}`);
            if (tickerTypeStats.totalPnL < -500) warnings.push(`NET LOSING on this exact setup (-$${Math.abs(tickerTypeStats.totalPnL).toFixed(0)})`);
            if (tickerTypeStats.winRate >= 75) encouragements.push(`STRONG WIN RATE (${tickerTypeStats.winRate.toFixed(0)}%) on this setup`);
            if (tickerTypeStats.avgPnL > 100) encouragements.push(`PROFITABLE pattern ($${tickerTypeStats.avgPnL.toFixed(0)} avg)`);
        }
        
        if (tickerStats && tickerStats.count >= 3 && !tickerTypeStats) {
            patternText += `• All ${tickerUpper}: ${tickerStats.count} trades, ${tickerStats.winRate.toFixed(0)}% win rate\n`;
            if (tickerStats.winRate < 40) warnings.push(`${tickerUpper} HAS BEEN DIFFICULT overall`);
            if (tickerStats.winRate >= 70) encouragements.push(`${tickerUpper} WORKS WELL for you`);
        }
        
        if (typeStats && typeStats.count >= 5) {
            patternText += `• All ${typeNormalized.replace(/_/g,' ')}: ${typeStats.count} trades, ${typeStats.winRate.toFixed(0)}% win rate\n`;
            if (typeStats.winRate < 50 && typeNormalized.includes('long')) warnings.push(`${typeNormalized.replace(/_/g,' ')} UNDERPERFORMING`);
            if (typeStats.winRate >= 70) encouragements.push(`${typeNormalized.replace(/_/g,' ')} IS YOUR STRENGTH`);
        }
        
        if (patternText || warnings.length > 0 || encouragements.length > 0) {
            patternContext = `
═══ YOUR HISTORICAL PATTERNS ═══
${patternText}${warnings.length > 0 ? '⚠️ WARNINGS: ' + warnings.join(', ') + '\n' : ''}${encouragements.length > 0 ? '✅ POSITIVE: ' + encouragements.join(', ') + '\n' : ''}
**Use this history to inform your recommendation!**
`;
        }
    }
    
    // Calculate assignment scenario for covered calls
    let assignmentProfit = null;
    let assignmentAnalysis = '';
    if (isCoveredCall && costBasis && strike && spot) {
        const stockGain = (strike - costBasis) * 100 * contracts;
        const premiumGain = (totalPremiumCollected || premium * 100 * contracts);
        assignmentProfit = stockGain + premiumGain;
        const missedUpside = spot > strike ? ((spot - strike) * 100 * contracts).toFixed(0) : 0;
        assignmentAnalysis = `
═══ ASSIGNMENT SCENARIO (Let it get called) ═══
If assigned at $${strike}:
• Stock gain: $${stockGain.toFixed(0)} ($${strike} - $${costBasis.toFixed(2)} cost basis × ${contracts * 100} shares)
• Premium collected: $${premiumGain.toFixed(0)}${chainHistory?.length > 1 ? ` (across ${chainHistory.length} rolls)` : ''}
• TOTAL PROFIT: $${assignmentProfit.toFixed(0)}
${spot > strike ? `• Upside you'd miss: $${missedUpside} (stock at $${spot.toFixed(2)} vs $${strike} strike)` : '• Stock is below strike - assignment unlikely'}

⚠️ IMPORTANT: Assignment is not always bad! If you've collected good premium and the stock is above your strike, 
getting called away can be a WIN. Consider: Is this profit acceptable, or is the upside worth chasing?`;
    }
    
    // Calculate chain context if available
    let chainContext = '';
    if (chainHistory?.length > 1) {
        const rollCount = chainHistory.length - 1;
        const firstOpen = chainHistory[0]?.openDate;
        const daysInTrade = firstOpen ? Math.floor((Date.now() - new Date(firstOpen).getTime()) / (1000 * 60 * 60 * 24)) : null;
        chainContext = `
═══ ROLL HISTORY ═══
This position has been rolled ${rollCount} time${rollCount > 1 ? 's' : ''}.
Original open: ${firstOpen || 'Unknown'}${daysInTrade ? ` (${daysInTrade} days ago)` : ''}
Net premium collected: $${totalPremiumCollected?.toFixed(0) || 'N/A'}
${rollCount >= 3 ? '⚠️ Multiple rolls - consider if continuing to roll is the best use of capital vs. taking assignment or closing.' : ''}`;
    }
    
    // Build alternative strategies section for covered calls in bullish scenarios
    let alternativeStrategies = '';
    let scorecardStrategies = [];  // Dynamic list based on situation
    
    if (isCoveredCall && spot > strike) {
        // Stock is above strike - ITM covered call, bullish scenario
        const upsideMissed = ((spot - strike) / strike * 100).toFixed(1);
        const itmPercent = ((spot - strike) / strike * 100).toFixed(1);
        
        // Build dynamic strategy list based on situation
        scorecardStrategies = [
            { name: 'LET ASSIGN', detail: `($${assignmentProfit?.toFixed(0) || '???'} profit)`, always: true },
            { name: 'ROLL UP+OUT', detail: '(higher strike, further out)', always: true },
        ];
        
        // Add bullish strategies if stock has momentum (significantly ITM)
        if (parseFloat(itmPercent) > 3) {
            scorecardStrategies.push({ name: 'SKIP™ STRATEGY', detail: '(LEAPS 12+ mo + SKIP call 3-9 mo)', reason: 'Stock has momentum' });
            scorecardStrategies.push({ name: 'BUY LONG CALL', detail: `($${Math.ceil(spot / 5) * 5} call, 60-90 DTE)`, reason: 'Capture upside' });
            scorecardStrategies.push({ name: 'BUY CALL SPREAD', detail: `($${Math.ceil(spot / 5) * 5}/$${Math.ceil(spot / 5) * 5 + 5})`, reason: 'Defined risk upside' });
        }
        
        // Add put selling if still bullish on underlying
        scorecardStrategies.push({ name: 'SELL PUT', detail: `($${Math.floor((spot * 0.9) / 5) * 5} strike)`, reason: 'Add bullish exposure' });
        
        // Add protective strategies if concerned about pullback
        if (parseFloat(itmPercent) > 8) {
            scorecardStrategies.push({ name: 'COLLAR', detail: '(buy put + sell higher call)', reason: 'Lock in gains, worried about pullback' });
        }
        
        // Add close entirely option
        scorecardStrategies.push({ name: 'CLOSE ENTIRELY', detail: '(buy back call + sell stock)', reason: 'Take profits, redeploy capital' });
        
        alternativeStrategies = `
═══ ALTERNATIVE STRATEGIES (Think Beyond Rolling!) ═══
Your covered call is ITM with the stock at $${spot.toFixed(2)} vs $${strike} strike (${itmPercent}% ITM).

STRATEGY MENU (evaluate each that applies to this situation):

📈 BULLISH STRATEGIES (if you think stock continues higher):
• SKIP™ STRATEGY - Buy LEAPS (12+ mo) + SKIP call (3-9 mo, higher strike). Exit SKIP at 45-60 DTE.
• BUY LONG CALL - Buy $${Math.ceil(spot / 5) * 5} call 60-90 DTE to ride further upside
• BUY CALL SPREAD - Buy $${Math.ceil(spot / 5) * 5}/$${Math.ceil(spot / 5) * 5 + 5} spread for defined risk upside
• DIAGONAL SPREAD - Sell near-term call, buy longer-dated higher strike call

📊 NEUTRAL STRATEGIES (if you think stock will consolidate):
• ROLL UP+OUT - Buy back call, sell higher strike further out
• CALENDAR SPREAD - Sell near-term call, buy same strike longer-dated (theta play)
• JADE LIZARD - Sell put + sell call spread (collect premium, no upside risk)

🛡️ PROTECTIVE STRATEGIES (if worried about pullback):
• COLLAR - Buy protective put below, sell call above (locks in gain range)
• CLOSE ENTIRELY - Buy back call + sell stock, take profits, redeploy capital

🟢 TAKE THE WIN:
• LET ASSIGN - Collect $${assignmentProfit?.toFixed(0) || '???'} profit, free up capital

💡 KEY INSIGHT: You're missing ${upsideMissed}% of upside ($${spot.toFixed(2)} vs $${strike} cap).
Pick strategies that match YOUR outlook on ${ticker}.`;

    } else if (isCoveredCall && spot <= strike) {
        // OTM or ATM covered call - winning position, theta working
        const otmPercent = ((strike - spot) / strike * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'HOLD', detail: '(let expire worthless)', always: true },
            { name: 'CLOSE EARLY', detail: '(buy back cheap, lock in profit)', always: true },
            { name: 'ROLL DOWN', detail: '(lower strike for more premium)', reason: 'Collect more if bearish' },
        ];
        
        if (dte <= 14) {
            scorecardStrategies.push({ name: 'LET EXPIRE', detail: '(collect 100% premium)', reason: 'Close to expiry' });
        }
        
        alternativeStrategies = `
═══ POSITION STATUS: OTM COVERED CALL (WINNING) ═══
Your call is ${otmPercent}% OTM - theta is working in your favor.

STRATEGY OPTIONS:
• HOLD - Let time decay work, collect full premium at expiration
• CLOSE EARLY - Buy back at 50-80% profit, free up the position for new trades
• ROLL DOWN - If bearish, roll to lower strike for more premium (increases assignment risk)
${dte <= 14 ? '• LET EXPIRE - Only ' + dte + ' DTE, likely to expire worthless' : ''}

Usually best to just HOLD when OTM and winning.`;

    } else if (isShortPut && spot < strike) {
        // Short put ITM - stock falling scenario
        const itmPercent = ((strike - spot) / strike * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'TAKE ASSIGNMENT', detail: `(buy shares at $${strike}, basis $${(strike - premium).toFixed(2)})`, always: true },
            { name: 'ROLL DOWN+OUT', detail: '(lower strike, further out)', always: true },
            { name: 'CONVERT TO SPREAD', detail: '(buy lower put to cap loss)', reason: 'Define max loss' },
            { name: 'CLOSE FOR LOSS', detail: '(cut losses, move on)', reason: 'Thesis broken' },
        ];
        
        // Add repair strategies for deep ITM
        if (parseFloat(itmPercent) > 10) {
            scorecardStrategies.push({ name: 'RATIO SPREAD', detail: '(sell 2x puts at lower strike, buy back current)', reason: 'Attempt to recover' });
        }
        
        alternativeStrategies = `
═══ ALTERNATIVE STRATEGIES (ITM Short Put) ═══
Your short put is ITM with stock at $${spot.toFixed(2)} vs $${strike} strike (${itmPercent}% ITM).

STRATEGY OPTIONS:
🟢 TAKE ASSIGNMENT - Buy shares at $${strike}, effective basis $${(strike - premium).toFixed(2)}, then sell calls
🔄 ROLL DOWN+OUT - Buy back put, sell lower strike further out for credit
🛡️ CONVERT TO SPREAD - Buy $${Math.floor(spot * 0.9 / 5) * 5} put to cap max loss (turns into bull put spread)
✂️ CLOSE FOR LOSS - Buy back put, take the loss, free up capital
${parseFloat(itmPercent) > 10 ? '⚠️ RATIO SPREAD - Sell 2 lower puts, buy back current (risky, for recovery)' : ''}

Pick based on whether you still want to own ${ticker} at these prices.`;

    } else if (isShortPut && spot >= strike) {
        // OTM short put - winning position
        const otmPercent = ((spot - strike) / spot * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'HOLD', detail: '(let expire worthless)', always: true },
            { name: 'CLOSE EARLY', detail: '(buy back cheap)', reason: 'Lock in 50-80% profit' },
            { name: 'ROLL UP', detail: '(higher strike for more premium)', reason: 'If still bullish' },
        ];
        
        alternativeStrategies = `
═══ POSITION STATUS: OTM SHORT PUT (WINNING) ═══
Your put is ${otmPercent}% OTM - theta working, low assignment risk.

STRATEGY OPTIONS:
• HOLD - Let expire worthless for max profit
• CLOSE EARLY - Buy back at 50-80% profit if you want to redeploy capital
• ROLL UP - If bullish, roll to higher strike for more premium (but more risk)

Usually best to HOLD when winning.`;
    }
    
    // Format position type nicely
    const typeLabel = positionType === 'buy_write' ? 'Buy/Write (covered call)' :
                      positionType === 'short_put' ? 'Cash-secured put' :
                      positionType === 'covered_call' ? 'Covered call' :
                      positionType === 'short_call' ? 'Short call' :
                      positionType === 'long_call' ? 'Long call' :
                      positionType === 'long_put' ? 'Long put' :
                      positionType || 'Option position';
    
    // Determine moneyness (ITM means profitable direction for the holder)
    // Long call ITM = spot > strike, Long put ITM = spot < strike
    // Short put ITM (bad) = spot < strike, Short call ITM (bad) = spot > strike
    const isITM = isCall ? (spot > strike) : (spot < strike);
    const moneynessLabel = isITM ? 'ITM' : (Math.abs(spot - strike) / strike < 0.02 ? 'ATM' : 'OTM');
    
    // Risk label differs for long vs short
    const riskLabel = isLong ? 'Expire worthless probability' : 'Assignment risk';
    const premiumLabel = isLong ? 'Premium paid' : 'Premium received';
    
    // Build risk reduction options text
    let riskReductionText = 'None available.';
    if (rollOptions?.riskReduction?.length > 0) {
        riskReductionText = rollOptions.riskReduction.map((r, i) => 
            `  ${i+1}. $${r.strike} ${r.expiry || ''} - ${r.isCredit ? '$' + r.amount + ' credit' : '$' + r.amount + ' debit'} (↓${r.riskChange}% risk${r.delta ? ', Δ' + r.delta : ''})`
        ).join('\n');
    }
    
    // Build credit roll options text
    let creditRollsText = 'None available.';
    if (rollOptions?.creditRolls?.length > 0) {
        creditRollsText = rollOptions.creditRolls.map((r, i) => 
            `  ${i+1}. $${r.strike} ${r.expiry || ''} - $${r.amount} credit (↓${r.riskChange}% risk${r.delta ? ', Δ' + r.delta : ''})`
        ).join('\n');
    }
    
    const hasRollOptions = (rollOptions?.riskReduction?.length > 0) || (rollOptions?.creditRolls?.length > 0);
    
    // Roll instructions differ for long vs short options
    const rollInstructions = isLong 
        ? 'For long options: SELL TO CLOSE current position, BUY TO OPEN new position'
        : 'For short options: BUY TO CLOSE current position, SELL TO OPEN new position';
    
    // Critical warning for long options - AI models often confuse this
    const longOptionWarning = isLong ? `
⚠️ CRITICAL: This is a LONG ${isLongCall ? 'CALL' : 'PUT'} - the trader OWNS this option.
- There is ZERO assignment risk. You CANNOT be assigned on a long option.
- The only risk is the option EXPIRING WORTHLESS and losing the premium paid.
- Do NOT mention "assignment" or "being assigned" - that only applies to SHORT options.
- The ${riskPercent?.toFixed(1) || 'N/A'}% risk means chance of expiring worthless, NOT assignment.
` : '';
    
    return `You are an expert options trading advisor. Analyze this position and recommend a SPECIFIC action.
${longOptionWarning}
═══ CURRENT POSITION ═══
${ticker} ${typeLabel}${dte >= 365 ? ' 📅 LEAPS' : dte >= 180 ? ' ⏳ LONG-DATED' : ''}
Strike: $${strike} | Spot: $${spot?.toFixed(2) || 'N/A'} (${moneynessLabel})
${premiumLabel}: $${premium}/share | Contracts: ${contracts}
DTE: ${dte} days${dte >= 365 ? ' (treat as stock proxy, daily theta minimal)' : dte >= 180 ? ' (extended horizon, IV matters more)' : ''}
${costBasis ? `Cost basis: $${costBasis.toFixed(2)}` : ''}
${breakeven ? `Break-even: $${breakeven.toFixed(2)}` : ''}
${isLong ? `Max loss: $${(premium * 100 * contracts).toFixed(0)} (premium paid)` : ''}
${costToClose ? `Current option price: $${costToClose}` : ''}

═══ RISK METRICS ═══
${riskLabel}: ${riskPercent ? riskPercent.toFixed(1) + '%' : 'N/A'}
Win probability: ${winProbability ? winProbability.toFixed(1) + '%' : 'N/A'}
IV: ${iv ? iv.toFixed(0) + '%' : 'N/A'}
${isLong ? (dte >= 365 ? 'Note: LEAPS have minimal daily theta. Focus on directional thesis and IV changes (vega exposure).' : dte >= 180 ? 'Note: Long-dated options have slow theta decay. IV changes matter more than daily time decay.' : 'Note: Time decay (theta) works AGAINST long options. You lose value daily.') : (dte >= 365 ? 'Note: LEAPS covered calls provide consistent income. Assignment is not imminent - focus on cost basis reduction.' : '')}
${chainContext}${patternContext}${assignmentAnalysis}${alternativeStrategies}
═══ AVAILABLE ROLL OPTIONS ═══
${rollInstructions}

RISK REDUCTION ROLLS:
${riskReductionText}

CREDIT ROLLS:
${creditRollsText}

═══ SYSTEM ANALYSIS ═══
${expertRecommendation || 'No system recommendation'}
${wisdomSection}
${portfolioContext ? `═══ PORTFOLIO CONTEXT ═══
${portfolioContext}
` : ''}${previousAnalysis ? `═══ PREVIOUS ANALYSIS ═══
On ${new Date(previousAnalysis.timestamp).toLocaleDateString()}, you recommended: ${previousAnalysis.recommendation}

At that time:
• Spot: $${previousAnalysis.snapshot?.spot?.toFixed(2) || 'N/A'}
• DTE: ${previousAnalysis.snapshot?.dte || 'N/A'} days
• IV: ${previousAnalysis.snapshot?.iv?.toFixed(0) || 'N/A'}%
• Risk: ${previousAnalysis.snapshot?.riskPercent?.toFixed(1) || 'N/A'}%

Your previous reasoning:
"${previousAnalysis.insight?.substring(0, 300)}${previousAnalysis.insight?.length > 300 ? '...' : ''}"

⚠️ COMPARE: Has anything changed significantly? If your thesis is still valid, confirm it. If conditions changed, explain what's different.
` : ''}═══ DECISION GUIDANCE ═══
${dte >= 365 ? `📅 LEAPS EVALUATION CRITERIA:
• LEAPS are long-term bets on direction, NOT theta plays
• Don't roll for time - you have plenty. Only roll for strike adjustment if stock moved significantly
• Key question: Is the original THESIS still valid?
• If selling covered calls against LEAPS: Focus on reducing cost basis over time
• Assignment on LEAPS is RARE - only worry if deeply ITM near expiration` : dte >= 180 ? `⏳ LONG-DATED OPTION CRITERIA:
• Extended timeframe means IV changes matter more than daily theta
• Only roll if thesis changed or to capture significant strike adjustment
• Don't panic on short-term moves - you have time for recovery` : `FIRST: Decide if you should roll at all!
• If the position is OTM, low risk (<35%), and approaching expiration → "HOLD - let theta work" is often best
• If the Expert Analysis says "on track for max profit" → you probably DON'T need to roll
• Only roll if: (a) position is ITM/troubled, (b) risk is high (>50%), or (c) you want to extend for more premium`}

IF you do need to roll, compare options CAREFULLY:
• Credit roll (you get paid) that reduces risk = ALWAYS better than debit roll (you pay) with same risk
• Getting paid AND reducing risk = obvious winner
• Debit rolls only make sense if you're desperate to cut risk and no credit option exists

═══ YOUR TASK ═══
${(scorecardStrategies && scorecardStrategies.length > 0) ? `🚨 MANDATORY: Evaluate EACH strategy before recommending.

These strategies were selected because they're relevant to YOUR specific situation.

**STRATEGY SCORECARD** (Rate each 1-10, where 10 = best choice)

| Strategy | Score | Reasoning |
|----------|-------|-----------|
${scorecardStrategies.map((s, i) => `| ${i + 1}. ${s.name} ${s.detail} | ?/10 | [Your reasoning] |`).join('\n')}

After completing the scorecard, provide:

**WINNER:** [Highest scoring strategy] 
**Trade Details:** [Specific action - strike, expiry, premium if applicable]
**Why This Beats Alternatives:** [Why winner is better than 2nd place]
**Key Risk:** [Main downside to watch]

IMPORTANT NOTES:
• If you recommend SKIP™, include BOTH legs (LEAPS strike/expiry + SKIP call strike/expiry)
• If you recommend a SPREAD, specify both strikes and expiry
• If you recommend COLLAR, specify put strike to buy and call strike to sell
• Be specific with trade execution details` : hasRollOptions ? `First, decide: Should you roll, or just HOLD and let this expire?

If HOLD is best, respond:
1. HOLD - Let position expire worthless for max profit
2. [Why] - Position is OTM with X% win probability, theta is working in your favor
3. [Watch] - What price level would change this advice

If rolling IS needed, respond:
1. [Your pick] - "Roll to $XXX [date like Feb 20] - $XXX ${isLong ? 'debit' : 'credit'}"
2. [Why this one] - 1-2 sentences comparing to alternatives
3. [Key risk] - Main risk with this trade` 
: `No roll options available. Respond in this format:

1. [Action] - ${isLong ? 'Hold for rally, take profits, or cut losses' : 'Hold, close, or wait'}

2. [Why] - 1-2 sentences explaining your reasoning

3. [Risk] - One key thing to watch`}

Be specific. Use the actual numbers provided. No headers or bullet points - just the numbered items.${isLargeModel ? `

Since you're a larger model, provide additional insight:
5. [Greeks] - Brief comment on theta/delta implications
6. [Market context] - Any broader market factors to consider (if relevant)` : ''}`;
}

// Build a critique prompt for analyzing a closed trade
function buildCritiquePrompt(data) {
    const { ticker, chainHistory, totalPremium, totalDays, finalOutcome } = data;
    
    if (!chainHistory || chainHistory.length === 0) {
        return `No trade history provided for ${ticker}. Cannot critique.`;
    }
    
    // Format the chain history as a timeline (include buyback costs for rolls)
    let timeline = '';
    chainHistory.forEach((pos, idx) => {
        const action = idx === 0 ? 'OPENED' : 'ROLLED';
        const premium = (pos.premium * 100 * (pos.contracts || 1)).toFixed(0);
        const isDebit = pos.type?.includes('long') || pos.type?.includes('debit');
        const premiumStr = isDebit ? `-$${premium} paid` : `+$${premium} received`;
        
        // Include buyback cost if position was rolled
        let buybackStr = '';
        if (pos.closeReason === 'rolled' && pos.closePrice) {
            const buyback = (pos.closePrice * 100 * (pos.contracts || 1)).toFixed(0);
            buybackStr = `\n   Buyback cost: -$${buyback}`;
        }
        
        timeline += `${idx + 1}. ${action}: ${pos.openDate || 'Unknown date'}
   Strike: $${pos.strike || pos.sellStrike || 'N/A'} ${pos.type || 'option'}
   Premium: ${premiumStr}${buybackStr}
   Expiry: ${pos.expiry || 'N/A'}
   ${pos.closeDate ? `Closed: ${pos.closeDate} (${pos.closeReason || 'closed'})` : 'Status: OPEN'}
   ${pos.spotAtOpen ? `Spot at open: $${pos.spotAtOpen}` : ''}
   
`;
    });
    
    return `You are an expert options trading coach. Analyze this completed trade and provide constructive feedback.

═══ TRADE SUMMARY ═══
Ticker: ${ticker}
Total positions in chain: ${chainHistory.length}
NET premium collected: $${totalPremium?.toFixed(0) || 'N/A'} (premiums received minus buyback costs)
Total days in trade: ${totalDays || 'N/A'}
Final outcome: ${finalOutcome || 'Unknown'}

═══ TRADE TIMELINE ═══
${timeline}

═══ YOUR ANALYSIS ═══
Provide a thoughtful critique in this format:

1. **What went well** - Identify 1-2 good decisions (entry timing, strike selection, roll timing, etc.)

2. **What could improve** - Identify 1-2 areas for improvement. Be specific - "rolled too early" or "strike was too aggressive" with reasoning.

3. **Key lesson** - One actionable takeaway for future trades.

4. **Grade** - Rate this trade: A (excellent), B (good), C (acceptable), D (poor), F (disaster)

Be honest but constructive. Focus on the PROCESS, not just the outcome. A losing trade can still have good process, and a winning trade can have poor process.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILD STRATEGY ADVISOR PROMPT - Analyzes all strategies and recommends best
// ═══════════════════════════════════════════════════════════════════════════
function buildStrategyAdvisorPrompt(context) {
    const { ticker, spot, stockData, ivRank, expirations, sampleOptions, buyingPower, accountValue, kellyBase, riskTolerance, existingPositions, dataSource } = context;
    
    // =========================================================================
    // HELPER: Round strike to valid increment ($1 for stocks > $50, $0.50 for < $50)
    // =========================================================================
    const roundStrike = (price) => {
        const increment = spot >= 50 ? 1 : 0.5;
        return Math.round(price / increment) * increment;
    };
    
    // =========================================================================
    // EXTRACT SPECIFIC STRIKES - Use REAL chain data with proper rounding
    // =========================================================================
    const puts = sampleOptions?.filter(o => o.option_type === 'P').sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike)) || [];
    const calls = sampleOptions?.filter(o => o.option_type === 'C').sort((a, b) => parseFloat(a.strike) - parseFloat(b.strike)) || [];
    
    console.log(`[STRATEGY-ADVISOR] Processing ${puts.length} puts, ${calls.length} calls for spot $${spot.toFixed(2)}`);
    // Debug: Show available put strikes
    const putStrikes = puts.map(p => `$${p.strike}`).join(', ');
    console.log(`[STRATEGY-ADVISOR] Available put strikes: ${putStrikes || 'NONE'}`);
    
    // Find ATM put (just below spot, rounded to valid strike)
    const atmPut = puts.find(p => parseFloat(p.strike) <= spot) || puts[0];
    if (atmPut) {
        console.log(`[STRATEGY-ADVISOR] ATM put: $${atmPut.strike} @ $${atmPut.bid}/$${atmPut.ask}`);
    }
    
    // For spreads, find a put ~$5 OTM (standard spread width)
    // OTM put should be $5 below the ATM put strike, not below spot
    const spreadWidth = spot >= 100 ? 5 : (spot >= 50 ? 5 : 2.5);
    const targetOtmStrike = atmPut ? parseFloat(atmPut.strike) - spreadWidth : spot - spreadWidth;
    console.log(`[STRATEGY-ADVISOR] Target OTM strike: $${targetOtmStrike} (ATM $${atmPut?.strike} - $${spreadWidth} spread)`);
    
    // Find closest put to target OTM strike
    let otmPut = puts.find(p => {
        const strike = parseFloat(p.strike);
        // Look for a put within $1 of our target OTM strike, and not the ATM put
        return Math.abs(strike - targetOtmStrike) <= 1 && p !== atmPut && (p.bid > 0 || p.ask > 0);
    });
    
    // If exact match not found, get the next lower strike put with valid pricing
    if (!otmPut) {
        otmPut = puts.find(p => {
            const strike = parseFloat(p.strike);
            return strike < parseFloat(atmPut?.strike || spot) - 2 && p !== atmPut && (p.bid > 0 || p.ask > 0);
        });
    }
    
    // If STILL no OTM put in chain, create synthetic based on ATM
    if (!otmPut && atmPut) {
        const otmStrike = roundStrike(parseFloat(atmPut.strike) - spreadWidth);
        // Estimate OTM premium as ~60% of ATM premium (better estimate for $5 OTM)
        const atmMid = (parseFloat(atmPut.bid) + parseFloat(atmPut.ask)) / 2;
        otmPut = { strike: otmStrike, bid: atmMid * 0.55, ask: atmMid * 0.65, synthetic: true };
        console.log(`[STRATEGY-ADVISOR] ⚠️ Created SYNTHETIC OTM put: $${otmStrike} with estimated premium $${(atmMid * 0.6).toFixed(2)}`);
    } else if (otmPut) {
        console.log(`[STRATEGY-ADVISOR] ✅ Found REAL OTM put: $${otmPut.strike} @ $${otmPut.bid}/$${otmPut.ask}`);
    }
    
    // Find ATM call (just above spot)
    const atmCall = calls.find(c => parseFloat(c.strike) >= spot) || calls[0];
    // Find OTM call for spread - look for strike $5 above ATM call
    const targetOtmCallStrike = atmCall ? parseFloat(atmCall.strike) + spreadWidth : spot + spreadWidth;
    let otmCall = calls.find(c => {
        const strike = parseFloat(c.strike);
        return Math.abs(strike - targetOtmCallStrike) <= 1 && c !== atmCall && (c.bid > 0 || c.ask > 0);
    });
    if (!otmCall) {
        otmCall = calls.find(c => {
            const strike = parseFloat(c.strike);
            return strike > parseFloat(atmCall?.strike || spot) + 2 && c !== atmCall && (c.bid > 0 || c.ask > 0);
        });
    }
    if (!otmCall && atmCall) {
        const otmStrike = roundStrike(parseFloat(atmCall.strike) + spreadWidth);
        const atmMid = (parseFloat(atmCall.bid) + parseFloat(atmCall.ask)) / 2;
        otmCall = { strike: otmStrike, bid: atmMid * 0.55, ask: atmMid * 0.65, synthetic: true };
        console.log(`[STRATEGY-ADVISOR] ⚠️ Created SYNTHETIC OTM call: $${otmStrike} with estimated premium $${(atmMid * 0.6).toFixed(2)}`);
    } else if (otmCall) {
        console.log(`[STRATEGY-ADVISOR] ✅ Found REAL OTM call: $${otmCall.strike} @ $${otmCall.bid}/$${otmCall.ask}`);
    }
    
    // Pre-calculate strikes (rounded to valid increments)
    const sellPutStrike = atmPut ? roundStrike(parseFloat(atmPut.strike)) : roundStrike(spot - 1);
    const buyPutStrike = otmPut ? roundStrike(parseFloat(otmPut.strike)) : roundStrike(spot - spreadWidth - 1);
    const sellCallStrike = atmCall ? roundStrike(parseFloat(atmCall.strike)) : roundStrike(spot + 1);
    const buyCallStrike = otmCall ? roundStrike(parseFloat(otmCall.strike)) : roundStrike(spot + spreadWidth + 1);
    
    // Calculate ACTUAL spread width (may differ from target due to available strikes)
    const putSpreadWidth = sellPutStrike - buyPutStrike;
    const callSpreadWidth = buyCallStrike - sellCallStrike;
    
    // Calculate premiums for spreads (NET credit = sell premium - buy premium)
    const atmPutMid = atmPut ? (parseFloat(atmPut.bid) + parseFloat(atmPut.ask)) / 2 : 2.00;
    const otmPutMid = otmPut ? (parseFloat(otmPut.bid) + parseFloat(otmPut.ask)) / 2 : atmPutMid * 0.4;
    const putSpreadCredit = Math.max(0.10, atmPutMid - otmPutMid); // Net credit received
    
    const atmCallMid = atmCall ? (parseFloat(atmCall.bid) + parseFloat(atmCall.ask)) / 2 : 2.00;
    const otmCallMid = otmCall ? (parseFloat(otmCall.bid) + parseFloat(otmCall.ask)) / 2 : atmCallMid * 0.4;
    const callSpreadCredit = Math.max(0.10, atmCallMid - otmCallMid); // Net credit received
    
    // Calculate deltas (BULL PUT = POSITIVE delta, BEAR CALL = NEGATIVE delta)
    const atmPutDelta = atmPut?.delta ? parseFloat(atmPut.delta) : -0.45; // ATM put delta ~-0.45
    const otmPutDelta = otmPut?.delta ? parseFloat(otmPut.delta) : -0.25; // OTM put delta ~-0.25
    // Bull put spread net delta = |short put delta| - |long put delta| = POSITIVE
    const putSpreadDelta = Math.abs(atmPutDelta) - Math.abs(otmPutDelta); // ~+0.20 per contract
    
    const atmCallDelta = atmCall?.delta ? parseFloat(atmCall.delta) : 0.45;
    const otmCallDelta = otmCall?.delta ? parseFloat(otmCall.delta) : 0.25;
    // Bear call spread net delta = -(short call delta - long call delta) = NEGATIVE  
    const callSpreadDelta = -(atmCallDelta - otmCallDelta); // ~-0.20 per contract
    
    // Find ideal expiration: target 30-45 DTE for wheel strategies
    // Weeklies (< 7 days) have too much gamma risk and not enough premium
    let targetExpiry = expirations?.[0] || 'next monthly';
    if (expirations && expirations.length > 1) {
        const today = new Date();
        for (const exp of expirations) {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            if (dte >= 21) { // Prefer 21+ DTE for premium decay
                targetExpiry = exp;
                break;
            }
        }
        // If no 21+ DTE found, use the furthest available
        if (targetExpiry === expirations[0]) {
            targetExpiry = expirations[expirations.length - 1];
        }
    }
    const firstExpiry = targetExpiry;
    
    // =========================================================================
    // PROP DESK WARNINGS - Professional risk management checks
    // =========================================================================
    const propDeskWarnings = [];
    
    // 1. Calculate DTE for gamma warning
    const today = new Date();
    let targetDTE = 30;
    if (firstExpiry && firstExpiry !== 'next monthly') {
        const expDate = new Date(firstExpiry);
        targetDTE = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
    }
    
    // Gamma alert: Short DTE + wide spread = high gamma risk
    if (targetDTE < 14 && putSpreadWidth >= spot * 0.03) {
        propDeskWarnings.push(`⚠️ HIGH GAMMA RISK: ${targetDTE} DTE with $${putSpreadWidth} spread. Short expiry amplifies losses on gaps.`);
    }
    
    // 2. IV vs estimated HV check (rough approximation)
    // High IV may persist in volatile assets
    if (ivRank > 70) {
        propDeskWarnings.push(`📊 IV ELEVATED (${ivRank}%): Good for selling, but vol could persist or spike on news. Set stops.`);
    } else if (ivRank < 30) {
        propDeskWarnings.push(`📉 IV LOW (${ivRank}%): Options are cheap. Favor buying strategies or wait for vol spike.`);
    }
    
    // 3. Position sizing guidance
    const marginPerSpread = putSpreadWidth * 100;
    const maxContractsByKelly = buyingPower > 0 ? Math.floor(buyingPower / marginPerSpread) : 10;
    const conservativeContracts = Math.max(1, Math.floor(maxContractsByKelly * 0.6)); // 60% of max
    propDeskWarnings.push(`💰 POSITION SIZE: Max ${maxContractsByKelly} contracts by Kelly, recommend ${conservativeContracts} (60% for safety buffer).`);
    
    // 4. Liquidity check (approximate - we'd need OI data for real check)
    // Flag if using very low-priced options
    if (atmPutMid < 0.50 || otmPutMid < 0.20) {
        propDeskWarnings.push(`💧 LIQUIDITY NOTE: Low premium options may have wide bid/ask spreads. Consider legging in.`);
    }
    
    // 5. Win probability from delta
    const winProbability = Math.round((1 - Math.abs(atmPutDelta)) * 100);
    
    // DEBUG: Log what we're sending to AI
    console.log(`[STRATEGY-ADVISOR] Pre-calculated values for AI prompt:`);
    console.log(`  ATM Put: $${atmPut?.strike} bid=${atmPut?.bid} ask=${atmPut?.ask} → mid=$${atmPutMid.toFixed(2)}`);
    console.log(`  OTM Put: $${otmPut?.strike} bid=${otmPut?.bid} ask=${otmPut?.ask} → mid=$${otmPutMid.toFixed(2)}`);
    console.log(`  Sell Put: $${sellPutStrike}, Buy Put: $${buyPutStrike}, Width: $${putSpreadWidth}`);
    console.log(`  Put Spread Credit: $${putSpreadCredit.toFixed(2)} (sell $${atmPutMid.toFixed(2)} - buy $${otmPutMid.toFixed(2)})`);
    console.log(`  Sell Call: $${sellCallStrike}, Buy Call: $${buyCallStrike}, Width: $${callSpreadWidth}`);
    console.log(`  Call Spread Credit: $${callSpreadCredit.toFixed(2)}`);
    console.log(`  Put Spread Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)`);
    console.log(`  First Expiry: ${firstExpiry}`);
    console.log(`  Options in chain: ${sampleOptions?.length || 0}, Puts: ${puts.length}, Calls: ${calls.length}`);
    
    // DEBUG: Log the exact TOTALS being sent (to verify AI isn't hallucinating)
    const totalMaxProfit = putSpreadCredit * 100 * conservativeContracts;
    const totalMaxLoss = (putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts;
    console.log(`[STRATEGY-ADVISOR] 💰 EXACT TOTALS BEING SENT TO AI:`);
    console.log(`  Conservative contracts: ${conservativeContracts}`);
    console.log(`  Max Profit per contract: $${(putSpreadCredit * 100).toFixed(0)}`);
    console.log(`  Max Loss per contract: $${((putSpreadWidth - putSpreadCredit) * 100).toFixed(0)}`);
    console.log(`  TOTAL MAX PROFIT: $${totalMaxProfit.toLocaleString()} ← AI MUST output this EXACT number`);
    console.log(`  TOTAL MAX LOSS: $${totalMaxLoss.toLocaleString()} ← AI MUST output this EXACT number`);
    
    // Format sample options for context - CRYSTAL CLEAR format to prevent AI confusion
    let optionsContext = '';
    if (sampleOptions && sampleOptions.length > 0) {
        // Group by type for clarity
        const putOptions = sampleOptions.filter(o => o.option_type === 'P');
        const callOptions = sampleOptions.filter(o => o.option_type === 'C');
        
        optionsContext = `═══════════════════════════════════════════════════════════════
⚠️ CRITICAL: STRIKE PRICE ≈ STOCK PRICE ($${spot.toFixed(0)}), PREMIUM = SMALL ($1-$5)
═══════════════════════════════════════════════════════════════

`;
        
        if (putOptions.length > 0) {
            optionsContext += `PUT OPTIONS (for selling puts or put spreads):\n`;
            optionsContext += putOptions.slice(0, 6).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? Math.abs(parseFloat(o.delta)).toFixed(2) : '?';
                return `  • STRIKE $${strike.toFixed(0)} put → You receive $${mid}/share premium (Δ${delta})`;
            }).join('\n');
            optionsContext += '\n\n';
        }
        
        if (callOptions.length > 0) {
            optionsContext += `CALL OPTIONS (for covered calls or call spreads):\n`;
            optionsContext += callOptions.slice(0, 6).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? Math.abs(parseFloat(o.delta)).toFixed(2) : '?';
                return `  • STRIKE $${strike.toFixed(0)} call → You receive $${mid}/share premium (Δ${delta})`;
            }).join('\n');
        }
        
        optionsContext += `\n\n🚨 REMEMBER: Use strikes near $${spot.toFixed(0)}, NOT the premium amounts!`;
    } else {
        optionsContext = 'No options data available - use estimated strikes near current price.';
    }
    
    // Format existing positions
    let positionsContext = 'None';
    if (existingPositions && existingPositions.length > 0) {
        const tickerPositions = existingPositions.filter(p => p.ticker?.toUpperCase() === ticker.toUpperCase());
        if (tickerPositions.length > 0) {
            positionsContext = tickerPositions.map(p => `  - ${p.type}: $${p.strike} exp ${p.expiry}`).join('\n');
        } else {
            positionsContext = 'None for this ticker (but user has other positions)';
        }
    }
    
    // Calculate range position description
    let rangeDesc = '';
    if (stockData.rangePosition !== undefined) {
        if (stockData.rangePosition < 25) rangeDesc = 'Near 3-month LOW (potentially oversold)';
        else if (stockData.rangePosition < 50) rangeDesc = 'Lower half of 3-month range';
        else if (stockData.rangePosition < 75) rangeDesc = 'Upper half of 3-month range';
        else rangeDesc = 'Near 3-month HIGH (potentially overbought)';
    }
    
    // IV context
    let ivDesc = 'Unknown';
    if (ivRank !== null) {
        if (ivRank < 20) ivDesc = `Low (${ivRank}%) - options are cheap, favor BUYING strategies`;
        else if (ivRank < 40) ivDesc = `Below average (${ivRank}%) - slightly favors buying`;
        else if (ivRank < 60) ivDesc = `Moderate (${ivRank}%) - neutral`;
        else if (ivRank < 80) ivDesc = `Elevated (${ivRank}%) - favors SELLING strategies`;
        else ivDesc = `High (${ivRank}%) - options are expensive, strongly favor SELLING`;
    }
    
    const promptText = `You are an expert options strategist helping a trader who is NEW to complex strategies beyond basic puts and calls.

═══════════════════════════════════════════════════════════════════════════
TICKER: ${ticker}
CURRENT PRICE: $${spot.toFixed(2)}
DATA SOURCE: ${dataSource}
═══════════════════════════════════════════════════════════════════════════

MARKET CONTEXT:
• 3-Month Range: $${stockData.low3mo?.toFixed(2) || '?'} - $${stockData.high3mo?.toFixed(2) || '?'}
• Position in Range: ${stockData.rangePosition || '?'}% (${rangeDesc})
• IV Rank: ${ivDesc}
• Available Expirations: ${expirations?.slice(0, 4).join(', ') || 'Unknown'}

REAL OPTIONS CHAIN DATA (USE THESE EXACT STRIKES AND PREMIUMS!):
⚠️ STRIKE = the price level where option activates (near current price of $${spot.toFixed(2)})
⚠️ PREMIUM = what you pay/receive for the option (the bid/ask prices below)
${optionsContext || 'Options data not available'}

USER PROFILE:
• Available Capital: $${buyingPower.toLocaleString()} (Kelly-adjusted, Half-Kelly of account)${kellyBase ? `\n• Kelly Base: $${kellyBase.toLocaleString()} (Account Value + 25% margin)` : ''}${accountValue ? `\n• Account Value: $${accountValue.toLocaleString()}` : ''}
• Risk Tolerance: ${riskTolerance}
• Existing ${ticker} Positions:
${positionsContext}

═══════════════════════════════════════════════════════════════════════════
🏦 PROP DESK RISK CHECKS:
═══════════════════════════════════════════════════════════════════════════
${propDeskWarnings.join('\n')}

═══════════════════════════════════════════════════════════════════════════
PRE-CALCULATED SPREAD VALUES (USE THESE EXACT NUMBERS!):
═══════════════════════════════════════════════════════════════════════════
PUT CREDIT SPREAD (Bull Put):
• Sell: $${sellPutStrike} put @ $${atmPutMid.toFixed(2)}
• Buy: $${buyPutStrike} put @ $${otmPutMid.toFixed(2)}
• Net Credit: $${putSpreadCredit.toFixed(2)} per share ($${(putSpreadCredit * 100).toFixed(0)} per contract)
• Spread Width: $${putSpreadWidth}
• Max Loss: $${(putSpreadWidth - putSpreadCredit).toFixed(2)} per share
• Breakeven: $${(sellPutStrike - putSpreadCredit).toFixed(2)}
• Net Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)
• Win Probability: ~${winProbability}%
• Recommended Contracts: ${conservativeContracts}

CALL CREDIT SPREAD (Bear Call):
• Sell: $${sellCallStrike} call
• Buy: $${buyCallStrike} call
• Net Credit: $${callSpreadCredit.toFixed(2)} per share
• Net Delta: ${(callSpreadDelta * 100).toFixed(0)} per contract (BEARISH)

═══════════════════════════════════════════════════════════════════════════
STRATEGIES TO EVALUATE (analyze ALL of these):
═══════════════════════════════════════════════════════════════════════════

1. SHORT PUT (Cash-Secured Put)
   - Sell a put, collect premium, may get assigned stock
   - Bullish strategy, unlimited risk if stock crashes

2. COVERED CALL (if user owns shares)
   - Sell a call against shares you own
   - Neutral/slightly bullish, caps upside

3. LONG CALL
   - Buy a call for leveraged upside
   - Very bullish, lose entire premium if wrong

4. PUT CREDIT SPREAD (Bull Put Spread)
   - Sell higher put, buy lower put for protection
   - Bullish with DEFINED RISK (max loss = width - credit)

5. CALL DEBIT SPREAD (Bull Call Spread)
   - Buy lower call, sell higher call to reduce cost
   - Bullish with defined risk/reward

6. CALL CREDIT SPREAD (Bear Call Spread)
   - Sell lower call, buy higher call for protection
   - Bearish with defined risk

7. PUT DEBIT SPREAD (Bear Put Spread)
   - Buy higher put, sell lower put
   - Bearish with defined risk

8. IRON CONDOR
   - Sell put spread + call spread
   - Neutral - profits if stock stays in range

9. SKIP™ (Long LEAPS + Short-term Call)
   - Buy long-dated call (12+ months) + shorter call (3-6 months)
   - Long-term bullish with reduced cost basis

═══════════════════════════════════════════════════════════════════════════
YOUR TASK: Recommend THE BEST strategy for this situation
═══════════════════════════════════════════════════════════════════════════

🚨🚨🚨 MANDATORY STRIKE PRICES (valid CBOE strikes near $${spot.toFixed(0)}):
   
   FOR PUTS:  Sell the $${sellPutStrike} strike, Buy the $${buyPutStrike} strike (${putSpreadWidth} point spread)
   FOR CALLS: Sell the $${sellCallStrike} strike, Buy the $${buyCallStrike} strike (${callSpreadWidth} point spread)
   EXPIRATION: ${firstExpiry}

VALID TRADE SETUPS (these are the ONLY options - pick ONE):

SETUP A - Short Put (Cash-Secured) - ALL MATH PRE-CALCULATED:
  Trade: Sell ${ticker} $${sellPutStrike} Put, ${firstExpiry}
  Credit Received: $${atmPutMid.toFixed(2)}/share
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(atmPutMid * 100).toFixed(0)} (keep all premium)
  • Max Loss per contract: $${((sellPutStrike - atmPutMid) * 100).toFixed(0)} (assigned at $${sellPutStrike} minus premium)
  • Breakeven: $${(sellPutStrike - atmPutMid).toFixed(2)}
  • Buying Power per contract: $${(sellPutStrike * 100).toLocaleString()} (cash-secured)
  • Max contracts with $${buyingPower.toLocaleString()}: ${Math.floor(buyingPower / (sellPutStrike * 100))}
  • Recommended contracts: ${Math.max(1, Math.floor(Math.floor(buyingPower / (sellPutStrike * 100)) * 0.6))} (60% of max)
  
  💰 TOTALS FOR ${Math.max(1, Math.floor(Math.floor(buyingPower / (sellPutStrike * 100)) * 0.6))} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(atmPutMid * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (sellPutStrike * 100)) * 0.6))).toLocaleString()}
  • TOTAL MAX LOSS: $${((sellPutStrike - atmPutMid) * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (sellPutStrike * 100)) * 0.6))).toLocaleString()} (if stock goes to $0)
  • TOTAL BUYING POWER USED: $${(sellPutStrike * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (sellPutStrike * 100)) * 0.6))).toLocaleString()}
  
  • Delta: +${Math.abs(atmPutDelta * 100).toFixed(0)} per contract (BULLISH)
  • Win Probability: ~${Math.round((1 - Math.abs(atmPutDelta)) * 100)}%
  ⚠️ RISK: Unlimited loss if stock crashes. Requires significant buying power.

SETUP B - Put Credit Spread (Bull Put) - ALL MATH PRE-CALCULATED:
  Trade: Sell ${ticker} $${sellPutStrike}/$${buyPutStrike} Put Spread, ${firstExpiry}
  Spread Width: $${putSpreadWidth.toFixed(2)}
  Credit Received: $${putSpreadCredit.toFixed(2)}/share (= $${atmPutMid.toFixed(2)} sell - $${otmPutMid.toFixed(2)} buy)
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(putSpreadCredit * 100).toFixed(0)}
  • Max Loss per contract: $${((putSpreadWidth - putSpreadCredit) * 100).toFixed(0)}
  • Breakeven: $${(sellPutStrike - putSpreadCredit).toFixed(2)}
  • Buying Power per contract: $${(putSpreadWidth * 100).toFixed(0)}
  • Recommended contracts: ${conservativeContracts} (60% of Kelly)
  
  💰 TOTALS FOR ${conservativeContracts} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(putSpreadCredit * 100 * conservativeContracts).toLocaleString()}
  • TOTAL MAX LOSS: $${((putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts).toLocaleString()}
  • TOTAL BUYING POWER USED: $${(putSpreadWidth * 100 * conservativeContracts).toLocaleString()}
  
  • Risk/Reward Ratio: ${((putSpreadWidth - putSpreadCredit) / putSpreadCredit).toFixed(1)}:1
  • Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)
  • Win Probability: ~${winProbability}%

SETUP C - Covered Call (requires owning 100 shares per contract):
  Trade: Sell ${ticker} $${sellCallStrike} Call, ${firstExpiry}
  Credit: ~$${atmCallMid.toFixed(2)}/share
  ⚠️ REQUIREMENT: Must own 100 shares of ${ticker} per contract
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(atmCallMid * 100).toFixed(0)} premium + stock gains up to strike
  • Max upside if called: $${((sellCallStrike - spot + atmCallMid) * 100).toFixed(0)} (stock at $${sellCallStrike} + premium)
  • Breakeven: $${(spot - atmCallMid).toFixed(2)} (stock cost - premium)
  • Stock ownership required: 100 shares at ~$${spot.toFixed(2)} = $${(spot * 100).toLocaleString()} per contract
  
  💰 FOR 1 CONTRACT (100 shares):
  • PREMIUM COLLECTED: $${(atmCallMid * 100).toFixed(0)}
  • MAX PROFIT IF CALLED: $${((sellCallStrike - spot + atmCallMid) * 100).toFixed(0)}
  
  • Delta: -${Math.abs(atmCallDelta * 100).toFixed(0)} per contract (reduces long delta from shares)
  ⚠️ NOTE: Only valid if user OWNS ${ticker} shares. Caps upside above $${sellCallStrike}.

SETUP D - Call Credit Spread (Bear Call) - ALL MATH PRE-CALCULATED:
  Trade: Sell ${ticker} $${sellCallStrike}/$${buyCallStrike} Call Spread, ${firstExpiry}
  Spread Width: $${callSpreadWidth.toFixed(2)}
  Credit Received: $${callSpreadCredit.toFixed(2)}/share
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(callSpreadCredit * 100).toFixed(0)}
  • Max Loss per contract: $${((callSpreadWidth - callSpreadCredit) * 100).toFixed(0)}
  • Breakeven: $${(sellCallStrike + callSpreadCredit).toFixed(2)}
  • Buying Power per contract: $${(callSpreadWidth * 100).toFixed(0)}
  • Recommended contracts: ${conservativeContracts} (60% of Kelly)
  
  💰 TOTALS FOR ${conservativeContracts} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(callSpreadCredit * 100 * conservativeContracts).toLocaleString()}
  • TOTAL MAX LOSS: $${((callSpreadWidth - callSpreadCredit) * 100 * conservativeContracts).toLocaleString()}
  • TOTAL BUYING POWER USED: $${(callSpreadWidth * 100 * conservativeContracts).toLocaleString()}
  
  • Risk/Reward Ratio: ${((callSpreadWidth - callSpreadCredit) / callSpreadCredit).toFixed(1)}:1
  • Delta: ${(callSpreadDelta * 100).toFixed(0)} per contract (BEARISH)
  • Win Probability: ~${Math.round((1 - Math.abs(atmCallDelta)) * 100)}%

YOUR JOB: Pick ONE setup (A, B, C, or D) based on the market conditions below:

🚨 DIRECTIONAL BIAS BASED ON RANGE POSITION (${stockData?.rangePosition || '?'}%):
${stockData?.rangePosition > 80 ? `⬇️ BEARISH LEAN: Stock at ${stockData?.rangePosition}% of 3-month range = OVERBOUGHT.
   → STRONGLY FAVOR SETUP D (Call Credit Spread) - profits if stock pulls back or stays flat.
   → Avoid A and B (bullish) unless you have a strong contrarian reason.` : 
   stockData?.rangePosition < 20 ? `⬆️ BULLISH LEAN: Stock at ${stockData?.rangePosition}% of 3-month range = OVERSOLD.
   → FAVOR SETUP A or B (bullish) - profits if stock recovers.
   → Avoid D (bearish) unless fundamentals are deteriorating.` :
   `↔️ NEUTRAL: Stock at ${stockData?.rangePosition}% = mid-range.
   → Either B (bullish) or D (bearish) reasonable based on your thesis.`}

🎯 ADDITIONAL DECISION CRITERIA:
• IV Rank ${ivRank}%: ${ivRank > 50 ? 'ELEVATED - favors SELLING strategies (A, B, C, D)' : 'LOW - options are cheap, spreads help manage this'}
• Risk Tolerance: ${riskTolerance} - ${riskTolerance === 'conservative' ? 'favor defined risk (B, D)' : riskTolerance === 'aggressive' ? 'A is fine if bullish' : 'B or D for balanced risk/reward'}
• Buying Power: $${buyingPower.toLocaleString()} - ${buyingPower < sellPutStrike * 100 ? 'Too low for A, use spreads (B or D)' : 'Enough for any strategy'}

🚨🚨🚨 CRITICAL MATH WARNING 🚨🚨🚨
The dollar amounts for Max Profit, Max Loss, and P&L are ALREADY CALCULATED in each SETUP above.
DO NOT DO ANY MULTIPLICATION - just COPY the exact numbers from the SETUP you chose.
🚨🚨🚨 END MATH WARNING 🚨🚨🚨

Respond with this format:

## 🏆 RECOMMENDED: [Setup Letter] - [Strategy Name]

### THE TRADE
[Copy the EXACT trade line from the setup you chose, including strikes and expiry]

### WHY THIS STRATEGY (explain in plain English)
• [Reason 1 - tie to IV level of ${ivRank || '?'}%]
• [Reason 2 - tie to stock position in range: ${stockData?.rangePosition || '?'}%]
• [Reason 3 - tie to risk management]

### THE RISKS
• ⚠️ [Risk 1]
• ⚠️ [Risk 2]
${propDeskWarnings.length > 0 ? '\n### 🏦 PROP DESK RISK NOTES\n' + propDeskWarnings.map(w => `• ${w}`).join('\n') : ''}

### THE NUMBERS (COPY FROM YOUR CHOSEN SETUP - do NOT calculate!)
Copy the "📐 EXACT NUMBERS" and "💰 TOTALS" sections from the setup you chose.

### 📊 PROFIT/LOSS AT EXPIRATION
Create a simple P&L table for YOUR CHOSEN STRATEGY using the numbers from that setup.
Use format: | If Stock Ends At | You Make/Lose | Result |

### PORTFOLIO IMPACT
• Buying Power Used: [from your chosen setup]
• Delta Exposure: [from your chosen setup]

### 📚 OTHER OPTIONS CONSIDERED
Briefly explain why you DIDN'T choose these (1 line each):
1. [Another setup letter]: [Why not ideal for THIS situation]
2. [Another setup letter]: [Why not ideal]

### 💡 EDUCATIONAL NOTE
Write 2-3 sentences explaining your chosen strategy for someone new to options.

### ✅ SANITY CHECK
Confirm: My recommended strikes are valid and near ${ticker}'s price of $${spot.toFixed(2)}

### 🔢 MATH VERIFICATION
I confirm that my numbers are copied directly from the SETUP section, NOT calculated by me.`;
    
    // Return both the prompt AND the calculated values for post-processing
    return {
        prompt: promptText,
        calculatedValues: {
            conservativeContracts,
            putSpreadCredit,
            putSpreadWidth,
            callSpreadCredit,
            callSpreadWidth,
            sellPutStrike,
            buyPutStrike,
            sellCallStrike,
            buyCallStrike,
            atmPutMid,
            atmCallMid,
            totalPutMaxProfit: Math.round(putSpreadCredit * 100 * conservativeContracts),
            totalPutMaxLoss: Math.round((putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts),
            totalCallMaxProfit: Math.round(callSpreadCredit * 100 * conservativeContracts),
            totalCallMaxLoss: Math.round((callSpreadWidth - callSpreadCredit) * 100 * conservativeContracts),
            totalBuyingPower: Math.round(putSpreadWidth * 100 * conservativeContracts),
            shortPutMaxProfit: Math.round(atmPutMid * 100),
            shortPutBuyingPower: sellPutStrike * 100,
            coveredCallCredit: Math.round(atmCallMid * 100)
        }
    };
}

// Build a prompt for generating trade ideas (with real prices!)
function buildIdeaPrompt(data, realPrices = [], xTrendingTickers = []) {
    const { buyingPower, targetAnnualROC, currentPositions, sectorsToAvoid, portfolioContext } = data;
    
    // Calculate upcoming monthly expiry dates (3rd Friday of month)
    const getThirdFriday = (year, month) => {
        const firstDay = new Date(year, month, 1);
        const dayOfWeek = firstDay.getDay();
        const firstFriday = dayOfWeek <= 5 ? (5 - dayOfWeek + 1) : (12 - dayOfWeek + 1);
        return new Date(year, month, firstFriday + 14);
    };
    
    const today = new Date();
    const expiryDates = [];
    for (let i = 0; i < 3; i++) {
        const targetMonth = today.getMonth() + i;
        const targetYear = today.getFullYear() + Math.floor(targetMonth / 12);
        const friday = getThirdFriday(targetYear, targetMonth % 12);
        if (friday > today) {
            const dte = Math.ceil((friday - today) / (1000 * 60 * 60 * 24));
            expiryDates.push({
                date: friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                dte: dte
            });
        }
    }
    const expiryStr = expiryDates.map(e => `${e.date} (${e.dte} DTE)`).join(', ');
    
    // Format current positions
    let currentTickers = [];
    if (currentPositions && currentPositions.length > 0) {
        currentTickers = currentPositions.map(p => p.ticker);
    }
    
    // Format real prices with context data
    let priceData = 'No price data available';
    if (realPrices.length > 0) {
        priceData = realPrices.map(p => {
            // Calculate a reasonable strike (~10% below current)
            const suggestedStrike = Math.floor(parseFloat(p.price) * 0.9);
            const putCapital = suggestedStrike * 100;
            
            let line = `${p.ticker}: $${p.price}`;
            line += ` | Range: $${p.monthLow}-$${p.monthHigh}`;
            line += ` | ${p.monthChange > 0 ? '+' : ''}${p.monthChange}% this month`;
            line += ` | ${p.rangePosition}% of range`;
            if (p.earnings) line += ` | ⚠️ Earnings: ${p.earnings}`;
            line += ` | 10% OTM strike: $${suggestedStrike} → Capital: $${putCapital.toLocaleString()}`;
            return line;
        }).join('\n');
    }
    
    return `You are a WHEEL STRATEGY advisor. Analyze the data below and pick 10 SHORT PUT trades.
PRIORITIZE variety - pick from DIFFERENT sectors. Spread across all available sectors.
If you see "Active Today" or "Trending" stocks, INCLUDE at least 2-3 of them - these are today's movers!
${xTrendingTickers.length > 0 ? `\n🔥 X/TWITTER PRIORITY: ${xTrendingTickers.join(', ')} - These are trending on FinTwit right now! Include at least 2-3 if they meet criteria!` : ''}

═══ CRITICAL RULES ═══
⚠️ NEVER pick stocks above 70% of range - they are EXTENDED and risky for puts!
⚠️ PREFER stocks 0-50% of range - these are near SUPPORT = safer put entries
⚠️ Negative month change is GOOD - pullbacks = better premium capture

═══ ACCOUNT ═══
Buying Power: $${buyingPower?.toLocaleString() || '25,000'}
Target ROC: ${targetAnnualROC || 25}%/year
Today: ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
Expiries: ${expiryStr}
${currentTickers.length > 0 ? `Already have positions in: ${currentTickers.join(', ')}` : ''}
${sectorsToAvoid ? `Avoid sectors: ${sectorsToAvoid}` : ''}
${portfolioContext ? `
═══ PORTFOLIO CONTEXT (from recent audit) ═══
${portfolioContext}
⚠️ PRIORITIZE trades that BALANCE the portfolio - reduce concentration, balance delta!` : ''}

═══ CANDIDATE DATA (real-time) ═══
${priceData}

═══ WHEEL STRATEGY CRITERIA ═══
✅ IDEAL candidates (PICK THESE):
- Range 0-40%: NEAR LOWS = excellent put entry
- Negative month change: pullback = juicy premium
- NO earnings before expiry
- Strike ~10% below current

⚠️ OKAY candidates (use judgment):
- Range 40-65%: mid-range = acceptable if other factors align
- Small positive month gain (<5%): not ideal but workable

❌ DO NOT PICK (skip these entirely):
- Range 70%+: EXTENDED, high risk of assignment
- Range 100%: AT MONTHLY HIGH - worst possible put entry
- Large positive month gain (>10%): chasing momentum

═══ EXPIRY DATES (use EXACTLY these - they are Fridays) ═══
Near-term: ${expiryDates[0]?.date || 'Feb 20'} (${expiryDates[0]?.dte || 30} DTE)
Mid-term: ${expiryDates[1]?.date || 'Mar 20'} (${expiryDates[1]?.dte || 60} DTE)

═══ FORMAT (exactly like this) ═══
1. [TICKER] @ $XX.XX - Sell $XX put, ${expiryDates[0]?.date || 'Feb 20'}
   Entry: [Why NOW is good timing - use the data: range position, month change, support level]
   Risk: [Specific risk - earnings date, sector issue, or technical concern]
   Capital: $X,XXX (COPY from data above - it's strike × 100)

2. ... (continue through 10)

Give me 10 different ideas from DIFFERENT sectors. USE THE DATA. Copy the Capital value from the candidate data.
SKIP any stock above 70% of range - those are extended and risky!
USE ONLY the expiry dates listed above - they are valid Friday expirations.`;
}

/**
 * Universal AI call - routes to Ollama or Grok based on model name
 */
async function callAI(prompt, model = 'qwen2.5:7b', maxTokens = 400) {
    // Check if this is a Grok model
    if (model.startsWith('grok')) {
        return callGrok(prompt, model, maxTokens);
    }
    // Otherwise use Ollama
    return callOllama(prompt, model, maxTokens);
}

/**
 * Call Grok API (xAI)
 * Model names: grok-4, grok-3, grok-3-mini, grok-2 (check xAI docs for latest)
 */
async function callGrok(prompt, model = 'grok-3', maxTokens = 400) {
    const apiKey = process.env.GROK_API_KEY;
    
    if (!apiKey) {
        throw new Error('Grok API key not configured. Add GROK_API_KEY to Settings.');
    }
    
    // Model-specific timeouts (grok-4 is slower but smarter)
    const timeoutMs = model.includes('grok-4') ? 180000 : 90000;
    const timeoutSec = timeoutMs / 1000;
    
    console.log(`[AI] Using Grok model: ${model}, maxTokens: ${maxTokens}, timeout: ${timeoutSec}s`);
    
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[AI] ⚠️ Grok request timed out after ${timeoutSec}s`);
        controller.abort();
    }, timeoutMs);
    
    try {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                max_tokens: maxTokens,
                temperature: 0.7
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errText = await response.text();
            console.log(`[AI] Grok API error: ${response.status} - ${errText}`);
            
            // Parse error for helpful message
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error?.message) {
                    throw new Error(`Grok: ${errJson.error.message}`);
                }
            } catch (parseErr) {
                // Not JSON, use raw text
            }
            
            throw new Error(`Grok API error: ${response.status} - ${errText.substring(0, 200)}`);
        }
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Grok';
        
        // Log token usage for cost tracking
        const usage = data.usage;
        if (usage) {
            console.log(`[AI] Grok tokens: ${usage.prompt_tokens} in → ${usage.completion_tokens} out = ${usage.total_tokens} total`);
        }
        console.log(`[AI] ✅ Grok response length: ${content.length} chars`);
        return content;
        
    } catch (e) {
        clearTimeout(timeoutId);
        
        if (e.name === 'AbortError') {
            throw new Error(`Grok request timed out after ${timeoutSec} seconds. Try grok-3 for faster responses.`);
        }
        
        console.log(`[AI] ❌ Grok call failed: ${e.message}`);
        throw e;
    }
}

// Call Ollama API
function callOllama(prompt, model = 'qwen2.5:7b', maxTokens = 400) {
    // Support both short names and full names
    const modelMap = {
        '7b': 'qwen2.5:7b',
        '14b': 'qwen2.5:14b', 
        '32b': 'deepseek-r1:32b',
        'deepseek': 'deepseek-r1:32b',
        'deepseek-r1': 'deepseek-r1:32b',
        'deepseek-r1:32b': 'deepseek-r1:32b',
        'qwen2.5:7b': 'qwen2.5:7b',
        'qwen2.5:14b': 'qwen2.5:14b',
        'deepseek-r1:32b': 'deepseek-r1:32b',
        'llama3.1:8b': 'llama3.1:8b',
        'mistral:7b': 'mistral:7b'
    };
    const resolvedModel = modelMap[model] || model;
    console.log(`[AI] Using model: ${resolvedModel}, maxTokens: ${maxTokens}`);
    
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: resolvedModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.7,
                num_predict: maxTokens
            }
        });
        
        const options = {
            hostname: 'localhost',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    console.log(`[AI] Ollama response keys:`, Object.keys(json));
                    
                    // DeepSeek-R1 is special: it puts chain-of-thought in "thinking" and final answer in "response"
                    // BUT sometimes "response" is incomplete or the better answer is in "thinking"
                    // For DeepSeek-R1, ALWAYS prefer extracting from "thinking" if it contains our expected format
                    const isDeepSeekR1 = model.includes('deepseek-r1');
                    let answer = '';
                    
                    // Helper to detect chain-of-thought rambling vs actual formatted answer
                    const looksLikeChainOfThought = (text) => {
                        if (!text) return false;
                        const cotIndicators = [
                            'let me think',
                            'I need to',
                            'I should',
                            'let me go through',
                            'considering all this',
                            "I'm trying to",
                            'wait, maybe',
                            'hmm,',
                            'okay, so',
                            'let me check',
                            "I'm not sure",
                            'actually,'
                        ];
                        const lowerText = text.slice(0, 500).toLowerCase();
                        return cotIndicators.some(indicator => lowerText.includes(indicator));
                    };
                    
                    // Helper to find formatted answer in text
                    const extractFormattedAnswer = (text) => {
                        if (!text) return null;
                        
                        // Look for our expected format markers
                        const markers = [
                            '## 🏆 RECOMMENDED',
                            '### THE TRADE',
                            '🏆 RECOMMENDED:',
                            '**RECOMMENDED:**'
                        ];
                        
                        for (const marker of markers) {
                            const idx = text.indexOf(marker);
                            if (idx !== -1) {
                                return text.slice(idx);
                            }
                        }
                        return null;
                    };
                    
                    if (isDeepSeekR1) {
                        console.log(`[AI] DeepSeek-R1 detected`);
                        console.log(`[AI]   thinking: ${json.thinking?.length || 0} chars`);
                        console.log(`[AI]   response: ${json.response?.length || 0} chars`);
                        
                        // First, try to find formatted answer in thinking
                        const thinkingAnswer = extractFormattedAnswer(json.thinking);
                        if (thinkingAnswer) {
                            answer = thinkingAnswer;
                            console.log(`[AI] ✅ Found formatted answer in thinking (${answer.length} chars)`);
                        }
                        
                        // If not found in thinking, try response
                        if (!answer) {
                            const responseAnswer = extractFormattedAnswer(json.response);
                            if (responseAnswer) {
                                answer = responseAnswer;
                                console.log(`[AI] ✅ Found formatted answer in response (${answer.length} chars)`);
                            }
                        }
                        
                        // If still no formatted answer, check if response is NOT chain-of-thought
                        if (!answer && json.response && !looksLikeChainOfThought(json.response)) {
                            answer = json.response;
                            console.log(`[AI] Using response (not chain-of-thought) (${answer.length} chars)`);
                        }
                        
                        // Last resort: if thinking has formatted sections but no clear header, try to extract
                        if (!answer && json.thinking) {
                            // Look for any markdown headers that might indicate structure
                            const headerMatch = json.thinking.match(/^(#+\s+.+)$/m);
                            if (headerMatch) {
                                const headerIdx = json.thinking.indexOf(headerMatch[0]);
                                answer = json.thinking.slice(headerIdx);
                                console.log(`[AI] ⚠️ Extracted from first markdown header (${answer.length} chars)`);
                            } else {
                                answer = json.thinking;
                                console.log(`[AI] ⚠️ Using full thinking (no structure found) (${answer.length} chars)`);
                            }
                        }
                    } else {
                        // Non-DeepSeek model: use response field
                        answer = json.response || '';
                    }
                    
                    // Fallback: if answer is still empty, try thinking
                    if (!answer && json.thinking) {
                        console.log(`[AI] Fallback: using thinking field (${json.thinking.length} chars)`);
                        answer = json.thinking;
                    }
                    
                    if (!answer) {
                        console.log(`[AI] ⚠️ Empty response. Full JSON:`, JSON.stringify(json).slice(0, 500));
                    }
                    resolve(answer || 'No response from model');
                } catch (e) {
                    console.log(`[AI] ❌ Parse error. Raw data:`, data.slice(0, 500));
                    reject(new Error('Invalid response from Ollama'));
                }
            });
        });
        
        req.on('error', (e) => {
            reject(new Error(`Ollama connection failed: ${e.message}. Is Ollama running?`));
        });
        
        // DeepSeek-R1 is a reasoning model that takes much longer - give it 3 minutes
        const timeoutMs = resolvedModel.includes('deepseek') ? 180000 : 60000;
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`Ollama request timed out (${timeoutMs/1000}s)`));
        });
        
        req.write(postData);
        req.end();
    });
}

/**
 * Mixture of Experts (MoE) approach
 * 1. Run 7B and 14B in parallel with the same prompt
 * 2. Pass both opinions to 32B for final nuanced decision
 */
async function callMoE(basePrompt, data) {
    const startTime = Date.now();
    console.log('[AI] 🧠 Starting MoE analysis (7B + 14B → 32B)...');
    
    // Build a shorter prompt for the smaller models (they just need to give a quick opinion)
    const quickPrompt = `${basePrompt}

IMPORTANT: Be concise. Give your recommendation in 2-3 sentences. Format:
VERDICT: [HOLD/ROLL/CLOSE]
REASON: [Brief explanation]
${data.rollOptions?.creditRolls?.length > 0 || data.rollOptions?.riskReduction?.length > 0 ? 'PICK: [If rolling, which option and why]' : ''}`;

    // Run 7B and 14B in parallel
    console.log('[AI] ⚡ Running 7B and 14B in parallel...');
    const [opinion7B, opinion14B] = await Promise.all([
        callOllama(quickPrompt, 'qwen2.5:7b', 200).catch(e => `Error: ${e.message}`),
        callOllama(quickPrompt, 'qwen2.5:14b', 200).catch(e => `Error: ${e.message}`)
    ]);
    
    const parallelTime = Date.now() - startTime;
    console.log(`[AI] ✓ Parallel phase done in ${parallelTime}ms`);
    console.log('[AI] 7B opinion:', opinion7B.substring(0, 100) + '...');
    console.log('[AI] 14B opinion:', opinion14B.substring(0, 100) + '...');
    
    // Now build the judge prompt for 32B - include full scorecard instructions
    const judgePrompt = `You are a senior options trading advisor reviewing assessments from two junior analysts.

${basePrompt}

═══ ANALYST OPINIONS (for context) ═══

**Analyst #1 (7B Quick):**
${opinion7B}

**Analyst #2 (14B Standard):**
${opinion14B}

═══ YOUR TASK AS SENIOR ADVISOR ═══
You have the full position data and strategy scorecard format above. Now:

1. Consider both analysts' quick takes
2. Complete the FULL STRATEGY SCORECARD rating each strategy 1-10
3. Determine the WINNER based on your expert judgment
4. If analysts disagreed, explain which reasoning you found more compelling

Proceed with the scorecard analysis now.`;

    // Call 32B as the judge - needs more tokens for full scorecard
    console.log('[AI] 👨‍⚖️ Running 32B as judge...');
    const finalResponse = await callOllama(judgePrompt, 'deepseek-r1:32b', 1800);
    
    const totalTime = Date.now() - startTime;
    console.log(`[AI] ✅ MoE complete in ${totalTime}ms (parallel: ${parallelTime}ms, judge: ${totalTime - parallelTime}ms)`);
    
    return {
        response: finalResponse,
        opinions: { '7B': opinion7B, '14B': opinion14B },
        timing: { total: totalTime, parallel: parallelTime, judge: totalTime - parallelTime }
    };
}

// Use main handler as Express middleware
app.use(mainHandler);

// Create HTTP server with Express app
// Global Express error handler (catches route errors)
app.use((err, req, res, next) => {
    console.error('[EXPRESS ERROR]', err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

const server = http.createServer(app);

// Handle uncaught exceptions to prevent server crash
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled rejection:', reason);
});

server.listen(PORT, () => {
    const version = getLocalVersion();
    console.log(`
╔════════════════════════════════════════════════════╗
║           🏠 WheelHouse Server v${version.padEnd(6)}            ║
╠════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                       ║
║                                                    ║
║  Features:                                         ║
║  • Static file serving                             ║
║  • CBOE options proxy at /api/cboe/{TICKER}.json   ║
║  • Settings API at /api/settings                   ║
║  • Update check at /api/update/check               ║
╚════════════════════════════════════════════════════╝
`);
});
