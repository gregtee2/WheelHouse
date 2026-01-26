/**
 * DiscoveryService - Stock discovery and candidate selection
 * Fetches most active, trending stocks from Yahoo Finance
 */

const https = require('https');

// Discovery cache - refresh every 15 minutes
let discoveryCache = { mostActive: [], trending: [], timestamp: 0 };
const DISCOVERY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Fetch JSON over HTTPS
 * @param {string} url 
 * @returns {Promise<Object>}
 */
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

/**
 * Fetch Yahoo's Most Active stocks (high volume today)
 * @returns {Promise<Array>} Array of { ticker, sector }
 */
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

/**
 * Fetch Yahoo's Trending stocks (unusual activity/news)
 * @returns {Promise<Array>} Array of { ticker, sector }
 */
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

/**
 * Fisher-Yates shuffle for randomizing ticker selection
 * @param {Array} array 
 * @returns {Array}
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Core curated wheel-friendly stocks (reliable favorites)
const CURATED_CANDIDATES = [
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

/**
 * Fetch current prices for a list of tickers (for AI trade ideas)
 * @param {number} buyingPower - Available buying power
 * @param {Array} excludeTickers - Tickers to exclude (for "Show Different")
 * @returns {Promise<Array>} Array of candidate objects with prices
 */
async function fetchWheelCandidatePrices(buyingPower, excludeTickers = []) {
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
    const curatedTickers = new Set(CURATED_CANDIDATES.map(c => c.ticker));
    const allCandidates = [
        ...CURATED_CANDIDATES,
        ...mostActive.filter(c => !curatedTickers.has(c.ticker)),
        ...trending.filter(c => !curatedTickers.has(c.ticker) && !mostActive.find(m => m.ticker === c.ticker))
    ];
    
    console.log(`[Discovery] Combined pool: ${CURATED_CANDIDATES.length} curated + ${mostActive.length} active + ${trending.length} trending = ${allCandidates.length} unique`);
    
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

/**
 * Get discovery cache stats
 * @returns {Object}
 */
function getCacheStats() {
    const now = Date.now();
    const age = now - discoveryCache.timestamp;
    return {
        mostActiveCount: discoveryCache.mostActive.length,
        trendingCount: discoveryCache.trending.length,
        cacheAgeMs: age,
        cacheAgeSec: Math.round(age / 1000),
        isFresh: age < DISCOVERY_CACHE_TTL
    };
}

module.exports = {
    fetchMostActiveStocks,
    fetchTrendingStocks,
    fetchWheelCandidatePrices,
    shuffleArray,
    getCacheStats,
    CURATED_CANDIDATES,
    DISCOVERY_CACHE_TTL
};
