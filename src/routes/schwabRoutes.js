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

    try {
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
    } catch (e) {
        // Log detailed error from Schwab
        console.error(`[SCHWAB] ❌ Token refresh failed:`, e.error || e.message || e);
        if (e.status === 401) {
            throw new Error('Refresh token expired or invalid. Please re-authorize in Settings → Schwab.');
        }
        if (e.status === 400) {
            throw new Error(`Schwab rejected refresh: ${JSON.stringify(e.error)}`);
        }
        throw new Error(`Token refresh failed: ${e.message || JSON.stringify(e)}`);
    }
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

// Get access token for streaming (used by Python streamer)
router.get('/streaming-token', async (req, res) => {
    try {
        // Pre-check credentials
        const creds = getCredentials();
        if (!creds.appKey || !creds.appSecret) {
            return res.status(400).json({ error: 'Schwab API credentials not configured. Go to Settings → Schwab tab.' });
        }
        if (!creds.refreshToken) {
            return res.status(400).json({ error: 'Schwab not authorized. Complete OAuth flow in Settings → Schwab tab.' });
        }
        
        const token = await getAccessToken();
        
        // Get account hash for streaming
        const accountsResp = await schwabApiCall('/accounts/accountNumbers');
        const accounts = Array.isArray(accountsResp) ? accountsResp : [];
        
        res.json({
            accessToken: token,
            expiresAt: tokenCache.accessExpiry,
            accounts: accounts.map(a => ({
                accountNumber: a.accountNumber,
                hashValue: a.hashValue
            })),
            appKey: creds.appKey
        });
    } catch (e) {
        console.error('[SCHWAB] Streaming token error:', e.message || e);
        res.status(500).json({ error: e.message || 'Unknown error getting streaming token' });
    }
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
// HELPER: Build and place option order
// ============================================================

const { buildOCCSymbol } = require('../utils/dateHelpers');

/**
 * Build a Schwab order object for an option trade
 * @param {Object} params - Order parameters
 * @returns {Object} Schwab order object
 */
function buildOptionOrder(params) {
    const { ticker, strike, expiry, type, instruction, quantity, limitPrice } = params;
    
    // Build OCC symbol
    const optionSymbol = buildOCCSymbol(ticker, expiry, type, strike);
    
    // Determine order type based on limitPrice
    const orderType = limitPrice ? 'LIMIT' : 'MARKET';
    
    const order = {
        orderType,
        session: 'NORMAL',
        duration: 'DAY',
        orderStrategyType: 'SINGLE',
        orderLegCollection: [
            {
                instruction: instruction || 'SELL_TO_OPEN', // SELL_TO_OPEN, BUY_TO_CLOSE, etc.
                quantity: quantity || 1,
                instrument: {
                    symbol: optionSymbol,
                    assetType: 'OPTION'
                }
            }
        ]
    };
    
    // Add limit price if provided
    if (limitPrice) {
        order.price = limitPrice.toFixed(2);
    }
    
    return order;
}

// Preview an option order (doesn't execute)
router.post('/preview-option-order', async (req, res) => {
    try {
        const { ticker, strike, expiry, type, instruction, quantity, limitPrice, covered } = req.body;
        
        if (!ticker || !strike || !expiry) {
            return res.status(400).json({ error: 'Missing required fields: ticker, strike, expiry' });
        }
        
        // Build the order object
        const order = buildOptionOrder({
            ticker,
            strike: parseFloat(strike),
            expiry,
            type: type || 'P',
            instruction: instruction || 'SELL_TO_OPEN',
            quantity: parseInt(quantity) || 1,
            limitPrice: limitPrice ? parseFloat(limitPrice) : null
        });
        
        // Get account hash from accountNumbers endpoint (this has the hash we need)
        const accountNumbers = await schwabApiCall('/accounts/accountNumbers');
        if (!accountNumbers || accountNumbers.length === 0) {
            return res.status(400).json({ error: 'No Schwab accounts found' });
        }
        
        // Use first account hash (or find specific account if needed)
        const accountHash = accountNumbers[0]?.hashValue;
        
        if (!accountHash) {
            return res.status(400).json({ error: 'Could not determine account hash' });
        }
        
        // Get account details for buying power
        const accounts = await schwabApiCall('/accounts');
        const marginAccount = accounts?.find(a => 
            a.securitiesAccount?.type === 'MARGIN'
        );
        const account = marginAccount || accounts?.[0];
        
        // Get buying power for display
        const buyingPower = account?.securitiesAccount?.currentBalances?.buyingPower || 0;
        
        // Calculate collateral - $0 for covered calls (PMCC, covered call with shares)
        // Otherwise use cash-secured formula: strike × 100 × quantity
        const collateralRequired = covered ? 0 : strike * 100 * (quantity || 1);
        
        if (covered) {
            console.log('[SCHWAB] Covered position - no margin required');
        }
        
        // Get the OCC symbol for quote lookup
        const occSymbol = order.orderLegCollection[0].instrument.symbol;
        
        // Fetch live quote for this option
        let liveQuote = null;
        let liveBid = null;
        let liveAsk = null;
        let liveMid = null;
        try {
            const quoteData = await schwabApiCall(`/marketdata/v1/quotes?symbols=${encodeURIComponent(occSymbol)}&fields=quote`);
            if (quoteData && quoteData[occSymbol]) {
                liveQuote = quoteData[occSymbol];
                liveBid = liveQuote.quote?.bidPrice || liveQuote.bidPrice || 0;
                liveAsk = liveQuote.quote?.askPrice || liveQuote.askPrice || 0;
                liveMid = (liveBid + liveAsk) / 2;
                console.log(`[SCHWAB] Live quote for ${occSymbol}: bid=$${liveBid}, ask=$${liveAsk}, mid=$${liveMid.toFixed(2)}`);
            }
        } catch (e) {
            console.log('[SCHWAB] Quote fetch error (non-fatal):', e.message);
        }
        
        // Preview the order
        let preview = null;
        let previewError = null;
        try {
            preview = await schwabApiCall(`/accounts/${accountHash}/previewOrder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(order)
            });
        } catch (e) {
            previewError = e.error?.message || e.message || 'Preview failed';
            console.log('[SCHWAB] Preview error (non-fatal):', previewError);
        }
        
        res.json({
            success: true,
            order,
            occSymbol,
            accountHash,
            buyingPower,
            collateralRequired,
            preview,
            previewError,
            // Live pricing
            liveBid,
            liveAsk,
            liveMid,
            suggestedLimit: liveBid || limitPrice, // For sells, use bid; for buys would use ask
            description: `${instruction || 'SELL_TO_OPEN'} ${quantity || 1}x ${ticker} $${strike} ${type || 'P'} exp ${expiry} @ $${limitPrice?.toFixed(2) || 'MKT'}`
        });
        
    } catch (e) {
        console.error('[SCHWAB] Preview option order error:', e);
        res.status(e.status || 500).json({ error: e.error?.message || e.message });
    }
});

// Place an option order (executes!)
router.post('/place-option-order', async (req, res) => {
    try {
        const { ticker, strike, expiry, type, instruction, quantity, limitPrice, confirm } = req.body;
        
        // Safety: require explicit confirmation
        if (confirm !== true) {
            return res.status(400).json({ 
                error: 'Order not confirmed. Set confirm: true to execute.',
                hint: 'This is a safety check to prevent accidental orders.'
            });
        }
        
        if (!ticker || !strike || !expiry) {
            return res.status(400).json({ error: 'Missing required fields: ticker, strike, expiry' });
        }
        
        // Build the order object
        const order = buildOptionOrder({
            ticker,
            strike: parseFloat(strike),
            expiry,
            type: type || 'P',
            instruction: instruction || 'SELL_TO_OPEN',
            quantity: parseInt(quantity) || 1,
            limitPrice: limitPrice ? parseFloat(limitPrice) : null
        });
        
        // Get account hash from accountNumbers endpoint (this has the hash we need)
        const accountNumbers = await schwabApiCall('/accounts/accountNumbers');
        if (!accountNumbers || accountNumbers.length === 0) {
            return res.status(400).json({ error: 'No Schwab accounts found' });
        }
        
        // Use first account hash
        const accountHash = accountNumbers[0]?.hashValue;
        
        if (!accountHash) {
            return res.status(400).json({ error: 'Could not determine account hash' });
        }
        
        console.log(`[SCHWAB] 📤 Placing order: ${order.orderLegCollection[0].instrument.symbol} @ $${order.price || 'MKT'}`);
        
        // Place the order
        const result = await schwabApiCall(`/accounts/${accountHash}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
        });
        
        console.log('[SCHWAB] ✅ Order placed successfully');
        
        res.json({
            success: true,
            order,
            result,
            message: `Order placed: ${instruction || 'SELL_TO_OPEN'} ${quantity || 1}x ${ticker} $${strike} ${type || 'P'}`
        });
        
    } catch (e) {
        console.error('[SCHWAB] ❌ Place option order error:', e);
        res.status(e.status || 500).json({ 
            success: false,
            error: e.error?.message || e.error || e.message 
        });
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

// Get dividends for specific tickers (aggregated)
// POST body: { tickers: ['NVDA', 'PLTR'], since: '2025-01-01' }
// Searches ALL accounts and matches by company description (Schwab doesn't put
// ticker symbol in dividend transactions — instrument.symbol is always CURRENCY_USD)
router.post('/dividends', async (req, res) => {
    try {
        const { tickers, since } = req.body;
        if (!tickers || !Array.isArray(tickers) || tickers.length === 0) {
            return res.status(400).json({ error: 'tickers array required' });
        }

        // Get ALL account hashes (dividends could be in any account)
        const accountNumbers = await schwabApiCall('/accounts/accountNumbers');
        const accounts = Array.isArray(accountNumbers) ? accountNumbers : [];
        if (accounts.length === 0) {
            return res.status(400).json({ error: 'No Schwab accounts found' });
        }

        const tickerSet = new Set(tickers.map(t => t.toUpperCase()));

        // Step 1: Build a description→ticker mapping using Schwab quotes
        // Schwab dividend transactions only have company name (e.g. "PROSHARES BITCOIN ETF"),
        // not the ticker symbol. We need to look up each ticker's official description.
        const descToTicker = {};  // "PROSHARES BITCOIN ETF" → "BITO"
        for (const ticker of tickerSet) {
            try {
                const quoteData = await schwabApiCall(`/marketdata/v1/${ticker}/quotes?fields=quote,reference`);
                const entry = quoteData?.[ticker];
                const desc = entry?.reference?.description || entry?.description || '';
                if (desc) {
                    descToTicker[desc.toUpperCase()] = ticker;
                }
            } catch (e) {
                // Non-fatal: we'll still try fuzzy matching
                console.log(`[SCHWAB] Could not get description for ${ticker}:`, e.message);
            }
        }

        // Step 2: Calculate date range (Schwab max is 1 year per request)
        const now = new Date();
        const endDate = now.toISOString();
        const sinceDate = since ? new Date(since) : new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

        // Build yearly chunks to respect Schwab's 1-year limit
        const chunks = [];
        let chunkStart = new Date(sinceDate);
        const endDateObj = new Date(endDate);
        while (chunkStart < endDateObj) {
            const chunkEnd = new Date(Math.min(
                chunkStart.getTime() + 364 * 24 * 60 * 60 * 1000, // 364 days (safe margin)
                endDateObj.getTime()
            ));
            chunks.push({ start: chunkStart.toISOString(), end: chunkEnd.toISOString() });
            chunkStart = new Date(chunkEnd.getTime() + 1); // next ms
        }

        // Step 3: Fetch dividend transactions from ALL accounts, ALL date chunks
        const allTxns = [];
        for (const acct of accounts) {
            const hash = acct.hashValue;
            if (!hash) continue;
            for (const chunk of chunks) {
                try {
                    const url = `/accounts/${hash}/transactions?types=DIVIDEND_OR_INTEREST&startDate=${chunk.start}&endDate=${chunk.end}`;
                    const txns = await schwabApiCall(url);
                    if (Array.isArray(txns)) {
                        allTxns.push(...txns);
                    }
                } catch (e) {
                    // Some accounts may not support transactions; skip
                }
            }
        }

        // Step 4: Match transactions to tickers using description
        const result = {};
        for (const ticker of tickerSet) {
            result[ticker] = { total: 0, payments: [] };
        }

        // Helper: find which ticker a transaction description matches
        function matchTicker(txnDescription) {
            const desc = (txnDescription || '').toUpperCase().trim();
            if (!desc) return null;

            // Try exact match against quote descriptions
            if (descToTicker[desc]) return descToTicker[desc];

            // Try contains match (txn description might be truncated or slightly different)
            for (const [quoteDesc, ticker] of Object.entries(descToTicker)) {
                if (desc.includes(quoteDesc) || quoteDesc.includes(desc)) {
                    return ticker;
                }
            }

            // Try normalized match (strip multiple spaces, remove special chars)
            const normalize = s => s.replace(/[^A-Z0-9]/g, '');
            const descNorm = normalize(desc);
            for (const [quoteDesc, ticker] of Object.entries(descToTicker)) {
                if (descNorm.includes(normalize(quoteDesc)) || normalize(quoteDesc).includes(descNorm)) {
                    return ticker;
                }
            }

            // Try matching ticker symbol directly in description (e.g. "NVDA DIVIDEND")
            for (const ticker of tickerSet) {
                if (desc.includes(ticker)) return ticker;
            }

            return null;
        }

        // Deduplicate by activityId (same txn from multiple chunk queries)
        const seenIds = new Set();
        for (const txn of allTxns) {
            const activityId = txn.activityId;
            if (activityId && seenIds.has(activityId)) continue;
            if (activityId) seenIds.add(activityId);

            const matchedTicker = matchTicker(txn.description);
            if (matchedTicker && result[matchedTicker]) {
                const amount = txn.netAmount || 0;
                if (amount !== 0) {
                    result[matchedTicker].total += amount;
                    result[matchedTicker].payments.push({
                        date: txn.tradeDate || txn.settlementDate || txn.time,
                        amount: amount,
                        description: txn.description || '',
                        account: txn.accountNumber || ''
                    });
                }
            }
        }

        // Round totals and sort payments (newest first)
        for (const ticker of Object.keys(result)) {
            result[ticker].total = Math.round(result[ticker].total * 100) / 100;
            result[ticker].payments.sort((a, b) => new Date(b.date) - new Date(a.date));
        }

        res.json(result);
    } catch (e) {
        console.error('[SCHWAB] Dividends error:', e.message || e);
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
