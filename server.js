// WheelHouse Simple Server with CBOE Proxy
// Serves static files AND proxies CBOE requests to avoid CORS

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 8888;

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

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
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
    
    // AI Trade Advisor endpoint - uses Ollama with user-selected model
    if (url.pathname === '/api/ai/analyze' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const selectedModel = data.model || 'qwen2.5:7b';
                console.log('[AI] Analyzing position:', data.ticker, 'with model:', selectedModel);
                
                // Build structured prompt from pre-computed data
                const prompt = buildTradePrompt(data);
                
                // Call Ollama with selected model
                const response = await callOllama(prompt, selectedModel);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    insight: response,
                    model: selectedModel
                }));
                console.log('[AI] ✅ Analysis complete');
            } catch (e) {
                console.log('[AI] ❌ Error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // Check if AI/Ollama is available
    if (url.pathname === '/api/ai/status') {
        try {
            const ollamaRes = await fetchJsonHttp('http://localhost:11434/api/tags');
            const models = ollamaRes.models || [];
            const hasQwen = models.some(m => m.name?.includes('qwen'));
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                available: models.length > 0,
                hasQwen,
                models: models.map(m => ({ name: m.name, size: m.size }))
            }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ available: false, error: 'Ollama not running' }));
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
});

// Helper to fetch JSON over HTTPS
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0',
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
function buildTradePrompt(data) {
    const {
        ticker, positionType, strike, premium, dte, contracts,
        spot, costBasis, breakeven, maxProfit, maxLoss,
        iv, riskPercent, winProbability, costToClose,
        rollOptions, expertRecommendation
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
${ticker} ${typeLabel}
Strike: $${strike} | Spot: $${spot?.toFixed(2) || 'N/A'} (${moneynessLabel})
${premiumLabel}: $${premium}/share | Contracts: ${contracts}
DTE: ${dte} days
${costBasis ? `Cost basis: $${costBasis.toFixed(2)}` : ''}
${breakeven ? `Break-even: $${breakeven.toFixed(2)}` : ''}
${isLong ? `Max loss: $${(premium * 100 * contracts).toFixed(0)} (premium paid)` : ''}
${costToClose ? `Current option price: $${costToClose}` : ''}

═══ RISK METRICS ═══
${riskLabel}: ${riskPercent ? riskPercent.toFixed(1) + '%' : 'N/A'}
Win probability: ${winProbability ? winProbability.toFixed(1) + '%' : 'N/A'}
IV: ${iv ? iv.toFixed(0) + '%' : 'N/A'}
${isLong ? 'Note: Time decay (theta) works AGAINST long options. You lose value daily.' : ''}

═══ AVAILABLE ROLL OPTIONS ═══
${rollInstructions}

RISK REDUCTION ROLLS:
${riskReductionText}

CREDIT ROLLS:
${creditRollsText}

═══ SYSTEM ANALYSIS ═══
${expertRecommendation || 'No system recommendation'}

═══ DECISION GUIDANCE ═══
FIRST: Decide if you should roll at all!
• If the position is OTM, low risk (<35%), and approaching expiration → "HOLD - let theta work" is often best
• If the Expert Analysis says "on track for max profit" → you probably DON'T need to roll
• Only roll if: (a) position is ITM/troubled, (b) risk is high (>50%), or (c) you want to extend for more premium

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

Be specific. Use the actual numbers provided. No headers or bullet points - just the numbered items.`;
}

// Call Ollama API
function callOllama(prompt, model = 'qwen2.5:7b') {
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
    console.log(`[AI] Using model: ${resolvedModel}`);
    
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: resolvedModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.7,
                num_predict: 300  // Slightly more for larger models
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
║  • Update check at /api/update/check               ║
╚════════════════════════════════════════════════════╝
`);
});
