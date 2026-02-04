/**
 * CBOE & Yahoo Finance Proxy Routes
 * Extracted from server.js Phase 6 modularization
 * 
 * Handles:
 * - /api/cboe/:ticker - CBOE delayed options quotes
 * - /api/iv/:ticker - ATM implied volatility (Schwab first, CBOE fallback)
 * - /api/yahoo/calendar/:ticker - Earnings and dividend calendar
 * - /api/yahoo/:ticker - Stock price quotes
 */

const express = require('express');
const router = express.Router();

// Dependencies - will be injected
let fetchJson;
let fetchTickerIVData;

/**
 * Initialize the router with required dependencies
 * @param {Object} deps - Dependencies object
 * @param {Function} deps.fetchJson - Function to fetch and parse JSON
 * @param {Function} deps.fetchTickerIVData - Function to get IV data (from DataService)
 */
function init(deps) {
    fetchJson = deps.fetchJson;
    fetchTickerIVData = deps.fetchTickerIVData;
}

// =============================================================================
// CBOE OPTIONS PROXY
// =============================================================================

/**
 * GET /api/cboe/:ticker
 * Proxy to CBOE delayed quotes API (15-min delay)
 * Adds cache-busting to defeat CDN caching
 */
router.get('/cboe/:ticker', async (req, res) => {
    const ticker = req.params.ticker.replace('.json', '').toUpperCase();
    // Add cache-buster to defeat CDN/browser caching
    const cacheBuster = Date.now();
    const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
    
    console.log(`[PROXY] Fetching CBOE options for ${ticker}...`);
    
    try {
        const data = await fetchJson(cboeUrl);
        // Send no-cache headers
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.json(data);
        console.log(`[PROXY] ✅ Returned ${data.data?.options?.length || 0} options for ${ticker}`);
    } catch (e) {
        console.log(`[PROXY] ❌ Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// IV DATA
// =============================================================================

/**
 * GET /api/iv/:ticker
 * Get ATM implied volatility for a ticker
 * Uses Schwab first (if authenticated), then CBOE fallback
 */
router.get('/iv/:ticker', async (req, res) => {
    const ticker = req.params.ticker.replace('.json', '').toUpperCase();
    console.log(`[IV] Fetching IV data for ${ticker}...`);
    
    try {
        const ivData = await fetchTickerIVData(ticker);
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        res.json(ivData);
        console.log(`[IV] ✅ ${ticker}: ATM IV=${ivData.atmIV}%, source=${ivData.source}`);
    } catch (e) {
        console.log(`[IV] ❌ Failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// YAHOO FINANCE CALENDAR (must come before generic /yahoo/:ticker)
// =============================================================================

/**
 * GET /api/yahoo/calendar/:ticker
 * Fetch earnings dates and dividend calendar from Yahoo Finance
 * Returns structured data with dates in ISO format
 */
router.get('/yahoo/calendar/:ticker', async (req, res) => {
    const ticker = req.params.ticker.replace('.json', '').toUpperCase();
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
        
        res.json(result);
        console.log(`[PROXY] ✅ ${ticker} earnings: ${result.earningsDate || 'N/A'}, ex-div: ${result.exDividendDate || 'N/A'}`);
    } catch (e) {
        console.log(`[PROXY] ❌ Yahoo calendar failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// YAHOO FINANCE STOCK PRICE
// =============================================================================

/**
 * GET /api/yahoo/:ticker
 * Fetch current stock price from Yahoo Finance
 */
router.get('/yahoo/:ticker', async (req, res) => {
    const ticker = req.params.ticker.replace('.json', '').toUpperCase();
    const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    
    console.log(`[PROXY] Fetching Yahoo price for ${ticker}...`);
    
    try {
        const data = await fetchJson(yahooUrl);
        res.json(data);
        const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
        console.log(`[PROXY] ✅ ${ticker} = $${price?.toFixed(2) || 'N/A'}`);
    } catch (e) {
        console.log(`[PROXY] ❌ Yahoo failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// TECHNICAL ANALYSIS - Trendline support detection
// =============================================================================

const TechnicalService = require('../services/TechnicalService');

router.get('/technical/:ticker', async (req, res) => {
    const ticker = req.params.ticker?.toUpperCase();
    console.log(`[TECHNICAL] Analyzing trendlines for ${ticker}...`);
    
    try {
        const analysis = await TechnicalService.analyzeTrendlines(ticker);
        res.json(analysis);
        
        if (analysis.longestValidTrendline) {
            console.log(`[TECHNICAL] ✅ ${ticker}: ${analysis.summary}`);
        } else {
            console.log(`[TECHNICAL] ⚠️ ${ticker}: No valid trendlines`);
        }
    } catch (e) {
        console.log(`[TECHNICAL] ❌ Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
