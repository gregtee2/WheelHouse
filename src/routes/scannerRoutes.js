/**
 * Wheel Scanner Routes
 * Scans a curated watchlist for wheel-friendly stocks near 3-month lows
 */

const express = require('express');
const router = express.Router();

// Curated watchlist of wheel-friendly stocks with sectors
const WHEEL_WATCHLIST = [
    // Tech - Large Cap
    { ticker: 'AAPL', sector: 'Tech', cap: 'Large' },
    { ticker: 'MSFT', sector: 'Tech', cap: 'Large' },
    { ticker: 'GOOGL', sector: 'Tech', cap: 'Large' },
    { ticker: 'AMZN', sector: 'Tech', cap: 'Large' },
    { ticker: 'META', sector: 'Tech', cap: 'Large' },
    { ticker: 'NVDA', sector: 'Tech', cap: 'Large' },
    { ticker: 'AMD', sector: 'Tech', cap: 'Large' },
    { ticker: 'INTC', sector: 'Tech', cap: 'Large' },
    { ticker: 'TSM', sector: 'Tech', cap: 'Large' },
    { ticker: 'AVGO', sector: 'Tech', cap: 'Large' },
    { ticker: 'QCOM', sector: 'Tech', cap: 'Large' },
    { ticker: 'CRM', sector: 'Tech', cap: 'Large' },
    { ticker: 'ADBE', sector: 'Tech', cap: 'Large' },
    { ticker: 'ORCL', sector: 'Tech', cap: 'Large' },
    
    // Tech - Mid/Growth
    { ticker: 'PLTR', sector: 'Tech', cap: 'Mid' },
    { ticker: 'SNOW', sector: 'Tech', cap: 'Mid' },
    { ticker: 'NET', sector: 'Tech', cap: 'Mid' },
    { ticker: 'CRWD', sector: 'Tech', cap: 'Mid' },
    { ticker: 'DDOG', sector: 'Tech', cap: 'Mid' },
    { ticker: 'ZS', sector: 'Tech', cap: 'Mid' },
    { ticker: 'MDB', sector: 'Tech', cap: 'Mid' },
    { ticker: 'PANW', sector: 'Tech', cap: 'Mid' },
    { ticker: 'DELL', sector: 'Tech', cap: 'Mid' },
    { ticker: 'HPE', sector: 'Tech', cap: 'Mid' },
    
    // Fintech & Crypto-adjacent
    { ticker: 'COIN', sector: 'Fintech', cap: 'Mid' },
    { ticker: 'HOOD', sector: 'Fintech', cap: 'Mid' },
    { ticker: 'SOFI', sector: 'Fintech', cap: 'Mid' },
    { ticker: 'SQ', sector: 'Fintech', cap: 'Mid' },
    { ticker: 'PYPL', sector: 'Fintech', cap: 'Large' },
    { ticker: 'AFRM', sector: 'Fintech', cap: 'Small' },
    { ticker: 'UPST', sector: 'Fintech', cap: 'Small' },
    { ticker: 'MARA', sector: 'Crypto', cap: 'Small' },
    { ticker: 'RIOT', sector: 'Crypto', cap: 'Small' },
    { ticker: 'MSTR', sector: 'Crypto', cap: 'Mid' },
    
    // Space & Defense
    { ticker: 'RKLB', sector: 'Space', cap: 'Small' },
    { ticker: 'LUNR', sector: 'Space', cap: 'Small' },
    { ticker: 'RDW', sector: 'Space', cap: 'Small' },
    { ticker: 'ASTS', sector: 'Space', cap: 'Small' },
    { ticker: 'LMT', sector: 'Defense', cap: 'Large' },
    { ticker: 'RTX', sector: 'Defense', cap: 'Large' },
    { ticker: 'NOC', sector: 'Defense', cap: 'Large' },
    { ticker: 'GD', sector: 'Defense', cap: 'Large' },
    
    // EV & Energy
    { ticker: 'TSLA', sector: 'EV', cap: 'Large' },
    { ticker: 'RIVN', sector: 'EV', cap: 'Mid' },
    { ticker: 'LCID', sector: 'EV', cap: 'Small' },
    { ticker: 'NIO', sector: 'EV', cap: 'Mid' },
    { ticker: 'XPEV', sector: 'EV', cap: 'Small' },
    { ticker: 'ENPH', sector: 'Energy', cap: 'Mid' },
    { ticker: 'FSLR', sector: 'Energy', cap: 'Mid' },
    { ticker: 'CEG', sector: 'Energy', cap: 'Large' },
    { ticker: 'VST', sector: 'Energy', cap: 'Mid' },
    
    // AI & Data Centers
    { ticker: 'SMCI', sector: 'AI', cap: 'Mid' },
    { ticker: 'ARM', sector: 'AI', cap: 'Large' },
    { ticker: 'AI', sector: 'AI', cap: 'Mid' },
    { ticker: 'PATH', sector: 'AI', cap: 'Mid' },
    { ticker: 'IREN', sector: 'AI', cap: 'Small' },
    { ticker: 'CLSK', sector: 'Crypto', cap: 'Small' },
    
    // Healthcare & Biotech
    { ticker: 'JNJ', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'UNH', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'PFE', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'ABBV', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'MRK', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'LLY', sector: 'Healthcare', cap: 'Large' },
    { ticker: 'BMY', sector: 'Healthcare', cap: 'Large' },
    
    // Retail & Consumer
    { ticker: 'WMT', sector: 'Retail', cap: 'Large' },
    { ticker: 'COST', sector: 'Retail', cap: 'Large' },
    { ticker: 'TGT', sector: 'Retail', cap: 'Large' },
    { ticker: 'HD', sector: 'Retail', cap: 'Large' },
    { ticker: 'LOW', sector: 'Retail', cap: 'Large' },
    { ticker: 'NKE', sector: 'Retail', cap: 'Large' },
    { ticker: 'SBUX', sector: 'Retail', cap: 'Large' },
    { ticker: 'MCD', sector: 'Retail', cap: 'Large' },
    
    // Finance
    { ticker: 'JPM', sector: 'Finance', cap: 'Large' },
    { ticker: 'BAC', sector: 'Finance', cap: 'Large' },
    { ticker: 'WFC', sector: 'Finance', cap: 'Large' },
    { ticker: 'GS', sector: 'Finance', cap: 'Large' },
    { ticker: 'MS', sector: 'Finance', cap: 'Large' },
    { ticker: 'C', sector: 'Finance', cap: 'Large' },
    { ticker: 'V', sector: 'Finance', cap: 'Large' },
    { ticker: 'MA', sector: 'Finance', cap: 'Large' },
    
    // ETFs (high volume, great for wheeling)
    { ticker: 'SPY', sector: 'ETF', cap: 'ETF' },
    { ticker: 'QQQ', sector: 'ETF', cap: 'ETF' },
    { ticker: 'IWM', sector: 'ETF', cap: 'ETF' },
    { ticker: 'XLF', sector: 'ETF', cap: 'ETF' },
    { ticker: 'XLE', sector: 'ETF', cap: 'ETF' },
    { ticker: 'GLD', sector: 'ETF', cap: 'ETF' },
    { ticker: 'SLV', sector: 'ETF', cap: 'ETF' },
    { ticker: 'TLT', sector: 'ETF', cap: 'ETF' },
    { ticker: 'EEM', sector: 'ETF', cap: 'ETF' },
    { ticker: 'ARKK', sector: 'ETF', cap: 'ETF' },
    { ticker: 'SOXL', sector: 'ETF', cap: 'ETF' },
    { ticker: 'TQQQ', sector: 'ETF', cap: 'ETF' },
    
    // Commodities & Materials
    { ticker: 'XOM', sector: 'Energy', cap: 'Large' },
    { ticker: 'CVX', sector: 'Energy', cap: 'Large' },
    { ticker: 'COP', sector: 'Energy', cap: 'Large' },
    { ticker: 'FCX', sector: 'Materials', cap: 'Large' },
    { ticker: 'NEM', sector: 'Materials', cap: 'Large' },
    
    // Gaming & Entertainment
    { ticker: 'DIS', sector: 'Entertainment', cap: 'Large' },
    { ticker: 'NFLX', sector: 'Entertainment', cap: 'Large' },
    { ticker: 'RBLX', sector: 'Gaming', cap: 'Mid' },
    { ticker: 'EA', sector: 'Gaming', cap: 'Large' },
    { ticker: 'TTWO', sector: 'Gaming', cap: 'Large' },
];

// Dependencies injected via init()
let DataService;

function init(deps) {
    DataService = deps.DataService;
}

/**
 * GET /api/scanner/wheel
 * Scan watchlist for wheel candidates near 3-month lows
 */
router.get('/wheel', async (req, res) => {
    const maxRange = parseFloat(req.query.maxRange) || 15; // Default: within 15% of low
    const minIV = parseFloat(req.query.minIV) || 0;
    const sector = req.query.sector || 'all';
    const cap = req.query.cap || 'all';
    const minPrice = parseFloat(req.query.minPrice) || 0;
    const maxPrice = parseFloat(req.query.maxPrice) || 9999;
    
    console.log(`[SCANNER] Starting wheel scan: maxRange=${maxRange}%, minIV=${minIV}%, sector=${sector}, cap=${cap}`);
    
    try {
        // Filter watchlist by sector/cap if specified
        let watchlist = WHEEL_WATCHLIST;
        if (sector !== 'all') {
            watchlist = watchlist.filter(s => s.sector.toLowerCase() === sector.toLowerCase());
        }
        if (cap !== 'all') {
            watchlist = watchlist.filter(s => s.cap.toLowerCase() === cap.toLowerCase());
        }
        
        const results = [];
        const batchSize = 10; // Process in batches to avoid rate limits
        
        for (let i = 0; i < watchlist.length; i += batchSize) {
            const batch = watchlist.slice(i, i + batchSize);
            
            // Fetch quotes in parallel for this batch
            const batchPromises = batch.map(async (stock) => {
                try {
                    // Fetch 3-month price history from Yahoo
                    const historyRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${stock.ticker}?interval=1d&range=3mo`);
                    if (!historyRes.ok) return null;
                    
                    const historyData = await historyRes.json();
                    const chart = historyData.chart?.result?.[0];
                    if (!chart || !chart.indicators?.quote?.[0]) return null;
                    
                    const closes = chart.indicators.quote[0].close?.filter(c => c != null) || [];
                    if (closes.length < 10) return null;
                    
                    const currentPrice = closes[closes.length - 1];
                    const low3m = Math.min(...closes);
                    const high3m = Math.max(...closes);
                    
                    // Calculate range position (0% = at low, 100% = at high)
                    const rangePosition = high3m !== low3m 
                        ? ((currentPrice - low3m) / (high3m - low3m)) * 100 
                        : 50;
                    
                    // Filter by range position
                    if (rangePosition > maxRange) return null;
                    
                    // Filter by price
                    if (currentPrice < minPrice || currentPrice > maxPrice) return null;
                    
                    // Try to get IV from CBOE (optional - won't fail if unavailable)
                    let iv = null;
                    let putPremium = null;
                    try {
                        const cboeRes = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${stock.ticker}.json`);
                        if (cboeRes.ok) {
                            const cboeData = await cboeRes.json();
                            
                            // Find ATM put ~30 DTE for premium estimate
                            const options = cboeData.data?.options || [];
                            const puts = options.filter(o => o.option?.includes('P'));
                            
                            // Get average IV from first few puts
                            const ivsWithValues = puts.slice(0, 20).map(p => p.iv).filter(v => v > 0);
                            if (ivsWithValues.length > 0) {
                                iv = ivsWithValues.reduce((a, b) => a + b, 0) / ivsWithValues.length;
                            }
                            
                            // Find 30-45 DTE put near current price
                            const now = new Date();
                            const targetDate = new Date(now.getTime() + 35 * 24 * 60 * 60 * 1000);
                            const targetStrike = Math.round(currentPrice * 0.95); // ~5% OTM
                            
                            const nearPut = puts.find(p => {
                                if (!p.option) return false;
                                const strikeMatch = p.option.match(/P(\d+)/);
                                if (!strikeMatch) return false;
                                const strike = parseFloat(strikeMatch[1]) / 1000;
                                return Math.abs(strike - targetStrike) < currentPrice * 0.03;
                            });
                            
                            if (nearPut) {
                                putPremium = (nearPut.bid + nearPut.ask) / 2;
                            }
                        }
                    } catch (e) {
                        // Ignore CBOE errors - IV is optional
                    }
                    
                    // Filter by IV if specified
                    if (minIV > 0 && (iv === null || iv < minIV)) return null;
                    
                    return {
                        ticker: stock.ticker,
                        sector: stock.sector,
                        cap: stock.cap,
                        price: currentPrice,
                        low3m,
                        high3m,
                        rangePosition: Math.round(rangePosition * 10) / 10,
                        iv: iv ? Math.round(iv * 10) / 10 : null,
                        putPremium: putPremium ? Math.round(putPremium * 100) / 100 : null,
                        priceFromLow: Math.round((currentPrice - low3m) * 100) / 100,
                        percentFromLow: Math.round(((currentPrice - low3m) / low3m) * 1000) / 10
                    };
                } catch (e) {
                    console.log(`[SCANNER] Error fetching ${stock.ticker}:`, e.message);
                    return null;
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults.filter(r => r !== null));
            
            // Small delay between batches to be nice to APIs
            if (i + batchSize < watchlist.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        // Sort by range position (lowest first = closest to 3-month low)
        results.sort((a, b) => a.rangePosition - b.rangePosition);
        
        console.log(`[SCANNER] Found ${results.length} candidates within ${maxRange}% of 3-month low`);
        
        res.json({
            success: true,
            count: results.length,
            filters: { maxRange, minIV, sector, cap, minPrice, maxPrice },
            results,
            scannedAt: new Date().toISOString()
        });
        
    } catch (e) {
        console.error('[SCANNER] Error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/scanner/watchlist
 * Return the curated watchlist (for UI to show available tickers)
 */
router.get('/watchlist', (req, res) => {
    const sectors = [...new Set(WHEEL_WATCHLIST.map(s => s.sector))].sort();
    const caps = [...new Set(WHEEL_WATCHLIST.map(s => s.cap))].sort();
    
    res.json({
        count: WHEEL_WATCHLIST.length,
        sectors,
        caps,
        tickers: WHEEL_WATCHLIST.map(s => s.ticker)
    });
});

module.exports = router;
module.exports.init = init;
