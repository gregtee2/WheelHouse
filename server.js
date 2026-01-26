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

// Import route modules
const settingsRoutes = require('./src/routes/settingsRoutes');
const schwabRoutes = require('./src/routes/schwabRoutes');
const { schwabApiCall } = schwabRoutes; // For internal option chain calls
const wisdomRoutes = require('./src/routes/wisdomRoutes');
const cboeRoutes = require('./src/routes/cboeRoutes');
const updateRoutes = require('./src/routes/updateRoutes');
const aiRoutes = require('./src/routes/aiRoutes');

// ============================================================================
// UTILITY MODULES (extracted for modularity)
// ============================================================================
const { formatExpiryForCBOE, parseExpiryDate, calculateDTE } = require('./src/utils/dateHelpers');
const { getLocalVersion, getChangelog, detectGPU, MODEL_VRAM_REQUIREMENTS, MIME_TYPES, compareVersions } = require('./src/utils/serverHelpers');

// ============================================================================
// SERVICE MODULES (extracted for modularity)
// ============================================================================
const CacheService = require('./src/services/CacheService');
const DiscoveryService = require('./src/services/DiscoveryService');
const AIService = require('./src/services/AIService');
const WisdomService = require('./src/services/WisdomService');
const promptBuilders = require('./src/services/promptBuilders');
const DataService = require('./src/services/DataService');

// Destructure AI functions for backward compatibility (used throughout server.js)
const { callAI, callGrok, callOllama, callMoE } = AIService;

// Destructure Wisdom functions for backward compatibility  
const { loadWisdom, saveWisdom, generateEmbedding, cosineSimilarity, searchWisdom, regenerateAllEmbeddings } = WisdomService;

// Destructure prompt builders for backward compatibility
const { 
    buildDeepDivePrompt, 
    buildCheckupPrompt, 
    buildTradeParsePrompt, 
    buildDiscordTradeAnalysisPrompt,
    buildCritiquePrompt,
    buildTradePrompt,
    buildIdeaPrompt,
    buildStrategyAdvisorPrompt
} = promptBuilders;

// Destructure data functions for backward compatibility
const {
    fetchJson,
    fetchJsonHttp,
    fetchText,
    fetchTickerIVData,
    estimateIVRank,
    fetchOptionPremium,
    fetchOptionPremiumSchwab,
    fetchOptionPremiumCBOE,
    fetchDeepDiveData
} = DataService;

// ============================================================================
// CENTRALIZED MARKET DATA SERVICE
// All features should use this for consistent, reliable pricing
// ============================================================================
const MarketDataService = require('./src/services/MarketDataService');
MarketDataService.initialize(schwabApiCall);

const PORT = process.env.PORT || 8888;
const app = express();

// ============================================================================
// DATA CACHE - Re-exported from CacheService for backward compatibility
// ============================================================================
const { tickerDataCache, optionPremiumCache, CACHE_TTL, getCacheKey, logCache } = CacheService;

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

// Mount wisdom API routes (Vector RAG for trading rules)
app.use('/api/wisdom', wisdomRoutes);

// Initialize and mount CBOE/Yahoo routes
cboeRoutes.init({
    fetchJson,
    fetchTickerIVData
});
app.use('/api', cboeRoutes);

// Initialize and mount Update routes
updateRoutes.init({
    fetchJson,
    fetchText,
    getLocalVersion,
    compareVersions,
    rootDir: __dirname
});
app.use('/api', updateRoutes);

// Initialize and mount AI routes
aiRoutes.init({
    AIService,
    DataService,
    DiscoveryService,
    promptBuilders,
    MarketDataService,
    formatExpiryForCBOE,
    detectGPU,
    fetchJsonHttp,
    MODEL_VRAM_REQUIREMENTS
});
app.use('/api/ai', aiRoutes);


// Main request handler (converted to Express middleware)
// Now only handles static file serving - all API routes moved to route modules
const mainHandler = async (req, res, next) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        
        // Skip all API routes - they're handled by Express routers
        if (url.pathname.startsWith('/api/')) {
            return next();
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

// ═══════════════════════════════════════════════════════════════════════════
// ALL API ROUTES NOW IN ROUTE MODULES:
// - /api/cboe/*, /api/iv/*, /api/yahoo/* → src/routes/cboeRoutes.js
// - /api/update/*, /api/version, /api/restart → src/routes/updateRoutes.js
// - /api/ai/* (17 endpoints) → src/routes/aiRoutes.js
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// BUILD STRATEGY ADVISOR PROMPT - Moved to src/services/promptBuilders.js
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS (continued) - Moved to src/services/promptBuilders.js
// Functions: buildIdeaPrompt, buildStrategyAdvisorPrompt
// ═══════════════════════════════════════════════════════════════════════════

// ============================================================================
// AI CALLING FUNCTIONS - Now imported from AIService.js
// callAI, callGrok, callOllama, callMoE are destructured at top of file
// ============================================================================

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
