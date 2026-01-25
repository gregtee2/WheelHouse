// WheelHouse - Schwab API Routes
// Handles OAuth, accounts, orders, and market data

const express = require('express');
const router = express.Router();
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Load .env path (at project root, not src/)
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// Schwab API Base URLs
const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth';
const SCHWAB_TRADER_URL = 'https://api.schwabapi.com/trader/v1';
const SCHWAB_MARKET_URL = 'https://api.schwabapi.com/marketdata/v1';

// In-memory token cache (persisted to .env)
let tokenCache = {
    accessToken: null,
    accessExpiry: 0,  // Unix timestamp in ms
    refreshToken: process.env.SCHWAB_REFRESH_TOKEN || null
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// Read .env file as object
function readEnv() {
    try {
        const content = fs.readFileSync(ENV_PATH, 'utf8');
        const env = {};
        content.split('\n').forEach(line => {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match) {
                env[match[1].trim()] = match[2].trim();
            }
        });
        return env;
    } catch (e) {
        return {};
    }
}

// Write .env file from object
function writeEnv(env) {
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

// Update a single .env variable
function updateEnvVar(key, value) {
    const env = readEnv();
    env[key] = value;
    writeEnv(env);
    // Also update process.env
    process.env[key] = value;
}

// Fetch helper for Schwab API
function schwabFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate',
                ...options.headers
            }
        };

        // Only log API calls if VERBOSE mode is enabled
        if (process.env.VERBOSE_LOGGING === 'true') {
            console.log(`[SCHWAB] ${reqOptions.method} ${url}`);
        }

        const req = https.request(reqOptions, (res) => {
            let chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                
                // Decompress if needed
                const encoding = res.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try {
                        buffer = zlib.gunzipSync(buffer);
                    } catch (e) {
                        console.error('[SCHWAB] Gunzip error:', e.message);
                    }
                } else if (encoding === 'deflate') {
                    try {
                        buffer = zlib.inflateSync(buffer);
                    } catch (e) {
                        console.error('[SCHWAB] Inflate error:', e.message);
                    }
                }
                
                const data = buffer.toString('utf8');
                if (process.env.VERBOSE_LOGGING === 'true') {
                    console.log(`[SCHWAB] Response ${res.statusCode}: ${data.substring(0, 300)}`);
                }
                
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        reject({ status: res.statusCode, error: json });
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    // Non-JSON response
                    if (res.statusCode >= 400) {
                        reject({ status: res.statusCode, error: data });
                    } else {
                        resolve(data);
                    }
                }
            });
        });

        req.on('error', (err) => {
            console.error('[SCHWAB] Request error:', err);
            reject(err);
        });
        
        if (options.body) {
            req.write(options.body);
        }
        
        req.end();
    });
}

// ============================================================
// TOKEN MANAGEMENT
// ============================================================

// Get credentials from env
function getCredentials() {
    return {
        appKey: process.env.SCHWAB_APP_KEY || '',
        appSecret: process.env.SCHWAB_APP_SECRET || process.env.SCHWAB_SECRET || '',
        callbackUrl: process.env.SCHWAB_CALLBACK_URL || 'https://127.0.0.1:5556',
        refreshToken: process.env.SCHWAB_REFRESH_TOKEN || ''
    };
}

// Check if we have valid credentials
function hasCredentials() {
    const creds = getCredentials();
    return creds.appKey && creds.appSecret && creds.refreshToken;
}

// Refresh access token using refresh token
async function refreshAccessToken() {
    const creds = getCredentials();
    
    if (!creds.appKey || !creds.appSecret || !creds.refreshToken) {
        throw new Error('Missing Schwab credentials. Please configure in Settings.');
    }

    const basicAuth = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString('base64');

    const response = await schwabFetch(`${SCHWAB_AUTH_URL}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${basicAuth}`
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken
        }).toString()
    });

    // Update cache
    tokenCache.accessToken = response.access_token;
    tokenCache.accessExpiry = Date.now() + (response.expires_in * 1000) - 60000; // 1 min buffer
    
    // If we got a new refresh token, save it
    if (response.refresh_token && response.refresh_token !== creds.refreshToken) {
        updateEnvVar('SCHWAB_REFRESH_TOKEN', response.refresh_token);
        tokenCache.refreshToken = response.refresh_token;
    }

    console.log(`[SCHWAB] ✅ Access token refreshed, expires in ${response.expires_in}s`);
    return tokenCache.accessToken;
}

// Get valid access token (refresh if needed)
async function getAccessToken() {
    // Check if current token is still valid
    if (tokenCache.accessToken && Date.now() < tokenCache.accessExpiry) {
        return tokenCache.accessToken;
    }
    
    // Need to refresh
    return await refreshAccessToken();
}

// Make authenticated API request
async function schwabApiCall(endpoint, options = {}) {
    const accessToken = await getAccessToken();
    
    const baseUrl = endpoint.startsWith('/marketdata') ? SCHWAB_MARKET_URL : SCHWAB_TRADER_URL;
    const cleanEndpoint = endpoint.replace(/^\/(trader|marketdata)\/v1/, '');
    
    return await schwabFetch(`${baseUrl}${cleanEndpoint}`, {
        ...options,
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${accessToken}`
        }
    });
}

// ============================================================
// OAUTH ROUTES
// ============================================================

// Get OAuth status
router.get('/status', (req, res) => {
    const creds = getCredentials();
    res.json({
        configured: !!(creds.appKey && creds.appSecret),
        hasRefreshToken: !!creds.refreshToken,
        hasAccessToken: !!(tokenCache.accessToken && Date.now() < tokenCache.accessExpiry),
        callbackUrl: creds.callbackUrl
    });
});

// Generate OAuth authorization URL
router.get('/authorize-url', (req, res) => {
    const creds = getCredentials();
    
    if (!creds.appKey) {
        return res.status(400).json({ error: 'SCHWAB_APP_KEY not configured' });
    }
    
    const authUrl = `${SCHWAB_AUTH_URL}/authorize?client_id=${creds.appKey}&redirect_uri=${encodeURIComponent(creds.callbackUrl)}`;
    
    res.json({ 
        url: authUrl,
        callbackUrl: creds.callbackUrl,
        instructions: [
            '1. Open the URL in your browser',
            '2. Log in with your Schwab credentials',
            '3. Authorize the app',
            '4. Copy the FULL redirect URL (it will fail to load, that\'s OK)',
            '5. Paste it in the "Complete OAuth" field'
        ]
    });
});

// Complete OAuth flow (exchange code for tokens)
router.post('/complete', async (req, res) => {
    try {
        const { redirectUrl } = req.body;
        
        if (!redirectUrl) {
            return res.status(400).json({ error: 'Missing redirectUrl' });
        }
        
        // Parse the authorization code from the redirect URL
        const urlObj = new URL(redirectUrl);
        const authCode = urlObj.searchParams.get('code');
        
        if (!authCode) {
            return res.status(400).json({ error: 'No authorization code found in URL' });
        }
        
        const creds = getCredentials();
        const basicAuth = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString('base64');
        
        // Exchange code for tokens
        const response = await schwabFetch(`${SCHWAB_AUTH_URL}/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuth}`
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                redirect_uri: creds.callbackUrl,
                code: decodeURIComponent(authCode)
            }).toString()
        });
        
        // Save refresh token
        updateEnvVar('SCHWAB_REFRESH_TOKEN', response.refresh_token);
        
        // Update cache
        tokenCache.accessToken = response.access_token;
        tokenCache.accessExpiry = Date.now() + (response.expires_in * 1000) - 60000;
        tokenCache.refreshToken = response.refresh_token;
        
        console.log('[SCHWAB] ✅ OAuth completed successfully!');
        
        res.json({
            success: true,
            message: 'OAuth completed! Refresh token saved.',
            expiresIn: response.expires_in
        });
        
    } catch (e) {
        console.error('[SCHWAB] ❌ OAuth error:', e);
        res.status(500).json({ error: e.message || 'OAuth failed' });
    }
});

// Save credentials
router.post('/credentials', (req, res) => {
    try {
        const { appKey, appSecret, callbackUrl } = req.body;
        
        if (appKey) updateEnvVar('SCHWAB_APP_KEY', appKey);
        if (appSecret) updateEnvVar('SCHWAB_SECRET', appSecret);
        if (callbackUrl) updateEnvVar('SCHWAB_CALLBACK_URL', callbackUrl);
        
        res.json({ success: true, message: 'Credentials saved' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// ACCOUNT ROUTES
// ============================================================

// Get account numbers
router.get('/accounts/numbers', async (req, res) => {
    try {
        const data = await schwabApiCall('/accounts/accountNumbers');
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Account numbers error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get all accounts with positions
router.get('/accounts', async (req, res) => {
    try {
        const fields = req.query.fields || 'positions';
        const data = await schwabApiCall(`/accounts?fields=${fields}`);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Accounts error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get specific account
router.get('/accounts/:accountHash', async (req, res) => {
    try {
        const { accountHash } = req.params;
        const fields = req.query.fields || 'positions';
        const data = await schwabApiCall(`/accounts/${accountHash}?fields=${fields}`);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Account details error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// ============================================================
// ORDER ROUTES
// ============================================================

// Get orders for account
router.get('/accounts/:accountHash/orders', async (req, res) => {
    try {
        const { accountHash } = req.params;
        const { fromEnteredTime, toEnteredTime, status, maxResults } = req.query;
        
        // Default to last 60 days
        const now = new Date();
        const from = fromEnteredTime || new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
        const to = toEnteredTime || now.toISOString();
        
        let url = `/accounts/${accountHash}/orders?fromEnteredTime=${from}&toEnteredTime=${to}`;
        if (status) url += `&status=${status}`;
        if (maxResults) url += `&maxResults=${maxResults}`;
        
        const data = await schwabApiCall(url);
        
        // Schwab returns an array of orders directly, or empty array
        const orders = Array.isArray(data) ? data : [];
        res.json({ success: true, orders });
    } catch (e) {
        console.error('[SCHWAB] Orders error:', e);
        res.status(e.status || 500).json({ success: false, error: e.error || e.message });
    }
});

// Preview order
router.post('/accounts/:accountHash/previewOrder', async (req, res) => {
    try {
        const { accountHash } = req.params;
        const orderObj = req.body;
        
        const data = await schwabApiCall(`/accounts/${accountHash}/previewOrder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderObj)
        });
        
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Preview order error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Place order
router.post('/accounts/:accountHash/orders', async (req, res) => {
    try {
        const { accountHash } = req.params;
        const orderObj = req.body;
        
        const data = await schwabApiCall(`/accounts/${accountHash}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderObj)
        });
        
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Place order error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Cancel order
router.delete('/accounts/:accountHash/orders/:orderId', async (req, res) => {
    try {
        const { accountHash, orderId } = req.params;
        
        await schwabApiCall(`/accounts/${accountHash}/orders/${orderId}`, {
            method: 'DELETE'
        });
        
        res.json({ success: true, message: 'Order cancelled' });
    } catch (e) {
        console.error('[SCHWAB] Cancel order error:', e);
        res.status(e.status || 500).json({ success: false, error: e.error || e.message });
    }
});

// ============================================================
// TRANSACTION ROUTES
// ============================================================

// Get transactions for account
router.get('/accounts/:accountHash/transactions', async (req, res) => {
    try {
        const { accountHash } = req.params;
        const { types, startDate, endDate, symbol } = req.query;
        
        // Default to last 30 days
        const now = new Date();
        const start = startDate || new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        const end = endDate || now.toISOString();
        
        let url = `/accounts/${accountHash}/transactions?types=${types || 'TRADE'}&startDate=${start}&endDate=${end}`;
        if (symbol) url += `&symbol=${symbol}`;
        
        const data = await schwabApiCall(url);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Transactions error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// ============================================================
// MARKET DATA ROUTES
// ============================================================

// Get quote
router.get('/quote/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const fields = req.query.fields || 'quote,fundamental';
        
        const data = await schwabApiCall(`/marketdata/v1/${symbol}/quotes?fields=${fields}`);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Quote error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get multiple quotes
router.get('/quotes', async (req, res) => {
    try {
        const { symbols, fields } = req.query;
        
        if (!symbols) {
            return res.status(400).json({ error: 'symbols parameter required' });
        }
        
        let url = `/marketdata/v1/quotes?symbols=${symbols}`;
        if (fields) url += `&fields=${fields}`;
        
        const data = await schwabApiCall(url);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Quotes error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get options chain
router.get('/chains/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const options = req.query;
        
        let url = `/marketdata/v1/chains?symbol=${symbol}`;
        
        // Add optional parameters
        const validParams = ['contractType', 'strikeCount', 'strategy', 'interval', 
                           'strike', 'range', 'fromDate', 'toDate', 'volatility',
                           'underlyingPrice', 'interestRate', 'daysToExpiration', 
                           'expMonth', 'optionType'];
        
        validParams.forEach(param => {
            if (options[param]) {
                url += `&${param}=${options[param]}`;
            }
        });
        
        const data = await schwabApiCall(url);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Options chain error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get expiration dates for options
router.get('/expirations/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = await schwabApiCall(`/marketdata/v1/expirationchain?symbol=${symbol}`);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Expirations error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Get price history
router.get('/pricehistory/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { periodType, period, frequencyType, frequency, startDate, endDate } = req.query;
        
        let url = `/marketdata/v1/pricehistory?symbol=${symbol}`;
        if (periodType) url += `&periodType=${periodType}`;
        if (period) url += `&period=${period}`;
        if (frequencyType) url += `&frequencyType=${frequencyType}`;
        if (frequency) url += `&frequency=${frequency}`;
        if (startDate) url += `&startDate=${startDate}`;
        if (endDate) url += `&endDate=${endDate}`;
        
        const data = await schwabApiCall(url);
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] Price history error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// ============================================================
// USER PREFERENCE ROUTES
// ============================================================

router.get('/userPreference', async (req, res) => {
    try {
        const data = await schwabApiCall('/userPreference');
        res.json(data);
    } catch (e) {
        console.error('[SCHWAB] User preference error:', e);
        res.status(e.status || 500).json({ error: e.error || e.message });
    }
});

// Export router and schwabApiCall for internal use
module.exports = router;
module.exports.schwabApiCall = schwabApiCall;
