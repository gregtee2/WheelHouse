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

// Import settings routes
const settingsRoutes = require('./src/routes/settingsRoutes');
const schwabRoutes = require('./src/routes/schwabRoutes');
const { schwabApiCall } = schwabRoutes; // For internal option chain calls

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
    'qwen2.5:32b': { minGB: 20, recGB: 24, description: '32B parameters - Best quality, slow' },
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
            const selectedModel = data.model || 'qwen2.5:14b'; // Use smarter model for critique
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
                const selectedModel = model || 'qwen2.5:32b'; // Use best model for deep analysis
                
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
                const analysisPrompt = buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium);
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
            const useMoE = data.useMoE !== false; // Default to true for 32B
            console.log('[AI] Analyzing position:', data.ticker, 'with model:', selectedModel, 'MoE:', useMoE);
            
            // Scale token limit based on model size - bigger models can give more insight
            const isLargeModel = selectedModel.includes('32b') || selectedModel.includes('70b') || selectedModel.includes('72b');
            const tokenLimit = isLargeModel ? 800 : 500;
            
            // Build structured prompt from pre-computed data
            const prompt = buildTradePrompt(data, isLargeModel);
            
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
                moe: moeDetails
            }));
            console.log('[AI] ✅ Analysis complete');
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

Then provide the detailed analysis:

1. **🚨 PROBLEM POSITIONS** - List positions that need attention:
   - For SHORT positions: High ITM risk, poor theta/risk ratio, about to be assigned
   - For LONG positions: Thesis failing (stock moving AGAINST you), about to expire worthless, far OTM with little time left
   - **NOT a problem**: Long options with negative theta (that's normal!) or LEAPS with tiny daily theta

2. **⚠️ CONCENTRATION RISKS** - Flag if too much exposure to one ticker or sector

3. **📊 GREEKS ASSESSMENT** - Is the portfolio balanced? Consider that long calls ADD to bullish delta intentionally

4. **💡 OPTIMIZATION IDEAS** - Specific actionable suggestions (rolls, closes, adjustments)

5. **✅ WHAT'S WORKING** - Highlight well-positioned trades (including profitable long positions!)

Be specific. Reference actual ticker symbols and strikes. Keep it actionable.`;

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
- More conservative option: What strike would be safer?
- More aggressive option: What strike would yield more premium?

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
Pick ONE:
${dte >= 365 ? `- ✅ HOLD - LEAPS are meant to be held; thesis still valid
- 🔄 ROLL UP/DOWN - Adjust strike if stock moved significantly (not for time!)
- 💰 CLOSE - Take profit if thesis achieved or invalidated
- 📈 ADD - Consider adding on pullback if thesis strengthening` : `- ✅ HOLD - Thesis intact, let it ride
- 🔄 ROLL - Consider rolling (specify why - expiry, strike, or both)
- 💰 CLOSE - Take profit/loss now (specify when)
- ⚠️ WATCH - Position needs monitoring (specify triggers)`}

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
function buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium) {
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

═══ YOUR ANALYSIS ═══

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
function buildTradePrompt(data, isLargeModel = false) {
    const {
        ticker, positionType, strike, premium, dte, contracts,
        spot, costBasis, breakeven, maxProfit, maxLoss,
        iv, riskPercent, winProbability, costToClose,
        rollOptions, expertRecommendation, previousAnalysis,
        portfolioContext  // NEW: Portfolio context from audit
    } = data;
    
    // Determine position characteristics
    const isLongCall = positionType === 'long_call';
    const isLongPut = positionType === 'long_put';
    const isLong = isLongCall || isLongPut;
    const isCall = isLongCall || positionType === 'buy_write' || positionType === 'covered_call' || positionType === 'short_call';
    
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

═══ AVAILABLE ROLL OPTIONS ═══
${rollInstructions}

RISK REDUCTION ROLLS:
${riskReductionText}

CREDIT ROLLS:
${creditRollsText}

═══ SYSTEM ANALYSIS ═══
${expertRecommendation || 'No system recommendation'}

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
${hasRollOptions ? `First, decide: Should you roll, or just HOLD and let this expire?

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
4. [Greeks] - Brief comment on theta/delta implications
5. [Market context] - Any broader market factors to consider (if relevant)` : ''}`;
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
 */
async function callGrok(prompt, model = 'grok-3', maxTokens = 400) {
    const apiKey = process.env.GROK_API_KEY;
    
    if (!apiKey) {
        throw new Error('Grok API key not configured. Add GROK_API_KEY to Settings.');
    }
    
    console.log(`[AI] Using Grok model: ${model}, maxTokens: ${maxTokens}`);
    
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
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            console.log(`[AI] Grok API error: ${response.status} - ${errText}`);
            throw new Error(`Grok API error: ${response.status}`);
        }
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Grok';
        
        // Log token usage for cost tracking
        const usage = data.usage;
        if (usage) {
            console.log(`[AI] Grok tokens: ${usage.prompt_tokens} in → ${usage.completion_tokens} out = ${usage.total_tokens} total`);
        }
        console.log(`[AI] Grok response length: ${content.length} chars`);
        return content;
        
    } catch (e) {
        console.log(`[AI] Grok call failed: ${e.message}`);
        throw e;
    }
}

// Call Ollama API
function callOllama(prompt, model = 'qwen2.5:7b', maxTokens = 400) {
    // Support both short names and full names
    const modelMap = {
        '7b': 'qwen2.5:7b',
        '14b': 'qwen2.5:14b', 
        '32b': 'qwen2.5:32b',
        'qwen2.5:7b': 'qwen2.5:7b',
        'qwen2.5:14b': 'qwen2.5:14b',
        'qwen2.5:32b': 'qwen2.5:32b',
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
                    if (!json.response) {
                        console.log(`[AI] ⚠️ Empty response. Full JSON:`, JSON.stringify(json).slice(0, 500));
                    }
                    resolve(json.response || 'No response from model');
                } catch (e) {
                    console.log(`[AI] ❌ Parse error. Raw data:`, data.slice(0, 500));
                    reject(new Error('Invalid response from Ollama'));
                }
            });
        });
        
        req.on('error', (e) => {
            reject(new Error(`Ollama connection failed: ${e.message}. Is Ollama running?`));
        });
        
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('Ollama request timed out (60s)'));
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
    
    // Now build the judge prompt for 32B
    const judgePrompt = `You are a senior options trading advisor reviewing assessments from two junior analysts.

═══ POSITION DATA ═══
${basePrompt.split('═══')[1] || 'See below'}

═══ ANALYST #1 (Quick Model) ═══
${opinion7B}

═══ ANALYST #2 (Standard Model) ═══
${opinion14B}

═══ YOUR TASK ═══
As the senior advisor, synthesize both opinions and make the final call.

If both analysts AGREE:
- Confirm their recommendation with additional nuance
- Explain why this consensus makes sense

If they DISAGREE:
- Adjudicate the disagreement
- Explain which analyst's reasoning is more sound and why
- Make the final call

Your response format:
1. [Your final pick] - The specific action to take (e.g., "Roll to $48 May 15 - $505 credit" or "HOLD - let expire")
2. [Why this one] - 2-3 sentences synthesizing the analyst opinions
3. [Key risk] - Main risk with this approach
4. [Consensus note] - "Both analysts agreed" or "Overriding Analyst X because..."`;

    // Call 32B as the judge
    console.log('[AI] 👨‍⚖️ Running 32B as judge...');
    const finalResponse = await callOllama(judgePrompt, 'qwen2.5:32b', 600);
    
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
