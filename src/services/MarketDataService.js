/**
 * MarketDataService - Centralized market data fetching
 * 
 * THE SINGLE SOURCE OF TRUTH FOR ALL PRICE/OPTIONS DATA
 * 
 * Data Source Priority:
 * 1. Schwab (real-time, requires auth) - BEST
 * 2. CBOE (15-min delayed, no auth) - GOOD for options
 * 3. Yahoo (real-time spot, no auth) - FALLBACK for quotes
 * 
 * Usage:
 *   const { getQuote, getOptionsChain, getOptionPremium } = require('./services/MarketDataService');
 *   
 *   const quote = await getQuote('AAPL');
 *   // Returns: { price, change, changePercent, high52, low52, volume, source }
 *   
 *   const chain = await getOptionsChain('AAPL', { strikeCount: 20 });
 *   // Returns: { calls: [...], puts: [...], expirations: [...], ivRank, source }
 *   
 *   const premium = await getOptionPremium('AAPL', 200, '2026-02-21', 'P');
 *   // Returns: { bid, ask, mid, iv, delta, source }
 */

// Import schwabApiCall from schwabRoutes (handles token refresh automatically)
let schwabApiCall = null;

function initialize(schwabApiCallFn) {
    schwabApiCall = schwabApiCallFn;
    console.log('[MarketDataService] Initialized with Schwab API');
}

/**
 * Get stock quote with automatic fallback
 * @param {string} ticker - Stock symbol
 * @returns {Promise<{price, change, changePercent, high52, low52, high3mo, low3mo, volume, rangePosition, source}>}
 */
async function getQuote(ticker) {
    const symbol = ticker.toUpperCase().trim();
    
    // 1. Try Schwab first (best - real-time)
    if (schwabApiCall) {
        try {
            const data = await schwabApiCall(`/marketdata/v1/quotes?symbols=${symbol}`);
            if (data && data[symbol]?.quote) {
                const q = data[symbol].quote;
                const price = q.lastPrice || q.mark;
                const high52 = q['52WeekHigh'];
                const low52 = q['52WeekLow'];
                
                // Schwab doesn't give 3-month range directly
                // Estimate: 3-month is roughly 1/4 of 52-week volatility from current price
                // Better: fetch price history, but that's another API call
                // For now, estimate conservatively
                const range52 = high52 - low52;
                const estimatedRange3mo = range52 * 0.4; // 3-month typically ~40% of annual range
                const high3mo = Math.min(high52, price + estimatedRange3mo * 0.6);
                const low3mo = Math.max(low52, price - estimatedRange3mo * 0.6);
                
                return {
                    ticker: symbol,
                    price,
                    change: q.netChange,
                    changePercent: q.netPercentChangeInDouble,
                    high52,
                    low52,
                    high3mo,
                    low3mo,
                    volume: q.totalVolume,
                    rangePosition: high3mo && low3mo && high3mo !== low3mo 
                        ? Math.round((price - low3mo) / (high3mo - low3mo) * 100) 
                        : null,
                    source: 'schwab'
                };
            }
        } catch (e) {
            console.log(`[MarketDataService] Schwab quote failed for ${symbol}:`, e.message);
        }
    }
    
    // 2. Try Yahoo Finance (real-time spot, with 3-month history)
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const result = data.chart?.result?.[0];
            if (result?.meta?.regularMarketPrice) {
                const price = result.meta.regularMarketPrice;
                const highs = result.indicators?.quote?.[0]?.high?.filter(h => h) || [];
                const lows = result.indicators?.quote?.[0]?.low?.filter(l => l) || [];
                const high3mo = highs.length > 0 ? Math.max(...highs) : null;
                const low3mo = lows.length > 0 ? Math.min(...lows) : null;
                
                return {
                    ticker: symbol,
                    price,
                    change: price - (result.meta.previousClose || price),
                    changePercent: result.meta.previousClose 
                        ? ((price - result.meta.previousClose) / result.meta.previousClose * 100) 
                        : 0,
                    high52: result.meta.fiftyTwoWeekHigh || high3mo,
                    low52: result.meta.fiftyTwoWeekLow || low3mo,
                    high3mo,
                    low3mo,
                    volume: result.meta.regularMarketVolume,
                    rangePosition: high3mo && low3mo && high3mo !== low3mo
                        ? Math.round((price - low3mo) / (high3mo - low3mo) * 100)
                        : null,
                    source: 'yahoo'
                };
            }
        }
    } catch (e) {
        console.log(`[MarketDataService] Yahoo quote failed for ${symbol}:`, e.message);
    }
    
    // 3. No data available
    return null;
}

/**
 * Get options chain with automatic fallback
 * @param {string} ticker - Stock symbol
 * @param {Object} options - { strikeCount, contractType, range, dteMin, dteMax }
 * @returns {Promise<{calls, puts, expirations, ivRank, spotPrice, source}>}
 */
async function getOptionsChain(ticker, options = {}) {
    const symbol = ticker.toUpperCase().trim();
    const { 
        strikeCount = 20, 
        contractType = 'ALL', 
        range = 'NTM',
        dteMin = null,
        dteMax = null 
    } = options;
    
    let spotPrice = null;
    
    // 1. Try Schwab first (best - real-time with Greeks)
    if (schwabApiCall) {
        try {
            const url = `/marketdata/v1/chains?symbol=${symbol}&contractType=${contractType}&strikeCount=${strikeCount}&includeUnderlyingQuote=true&range=${range}`;
            const data = await schwabApiCall(url);
            
            if (data && (data.callExpDateMap || data.putExpDateMap)) {
                spotPrice = data.underlyingPrice || data.underlying?.last;
                
                const calls = [];
                const puts = [];
                const expirations = new Set();
                let ivSum = 0;
                let ivCount = 0;
                
                // Parse calls
                for (const [expKey, strikes] of Object.entries(data.callExpDateMap || {})) {
                    const expDate = expKey.split(':')[0];
                    expirations.add(expDate);
                    
                    for (const [strikeKey, contracts] of Object.entries(strikes)) {
                        const c = contracts[0];
                        if (c && c.bid > 0) {
                            calls.push({
                                expiration: expDate,
                                strike: parseFloat(strikeKey),
                                bid: c.bid,
                                ask: c.ask,
                                mid: (c.bid + c.ask) / 2,
                                last: c.last,
                                volume: c.totalVolume,
                                openInterest: c.openInterest,
                                iv: c.volatility,
                                delta: c.delta,
                                gamma: c.gamma,
                                theta: c.theta,
                                vega: c.vega,
                                dte: c.daysToExpiration
                            });
                            
                            // Collect IV for ATM options
                            if (spotPrice && Math.abs(parseFloat(strikeKey) - spotPrice) / spotPrice < 0.05) {
                                if (c.volatility > 0) {
                                    ivSum += c.volatility;
                                    ivCount++;
                                }
                            }
                        }
                    }
                }
                
                // Parse puts
                for (const [expKey, strikes] of Object.entries(data.putExpDateMap || {})) {
                    const expDate = expKey.split(':')[0];
                    expirations.add(expDate);
                    
                    for (const [strikeKey, contracts] of Object.entries(strikes)) {
                        const c = contracts[0];
                        if (c && c.bid > 0) {
                            puts.push({
                                expiration: expDate,
                                strike: parseFloat(strikeKey),
                                bid: c.bid,
                                ask: c.ask,
                                mid: (c.bid + c.ask) / 2,
                                last: c.last,
                                volume: c.totalVolume,
                                openInterest: c.openInterest,
                                iv: c.volatility,
                                delta: c.delta,
                                gamma: c.gamma,
                                theta: c.theta,
                                vega: c.vega,
                                dte: c.daysToExpiration
                            });
                            
                            if (spotPrice && Math.abs(parseFloat(strikeKey) - spotPrice) / spotPrice < 0.05) {
                                if (c.volatility > 0) {
                                    ivSum += c.volatility;
                                    ivCount++;
                                }
                            }
                        }
                    }
                }
                
                return {
                    ticker: symbol,
                    spotPrice,
                    calls,
                    puts,
                    expirations: Array.from(expirations).sort(),
                    ivRank: ivCount > 0 ? Math.round(ivSum / ivCount) : null,
                    source: 'schwab'
                };
            }
        } catch (e) {
            console.log(`[MarketDataService] Schwab chain failed for ${symbol}:`, e.message);
        }
    }
    
    // 2. Try CBOE (15-min delayed, but has options data)
    try {
        const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const allOptions = data.data?.options || [];
            
            // Get spot price from CBOE or fetch separately
            spotPrice = data.data?.current_price || data.data?.close;
            if (!spotPrice) {
                const quote = await getQuote(symbol);
                spotPrice = quote?.price;
            }
            
            const calls = [];
            const puts = [];
            const expirations = new Set();
            let ivSum = 0;
            let ivCount = 0;
            
            for (const opt of allOptions) {
                const isCall = opt.option_type === 'C';
                const strike = parseFloat(opt.strike);
                const expDate = opt.expiration_date;
                
                expirations.add(expDate);
                
                const parsed = {
                    expiration: expDate,
                    strike,
                    bid: parseFloat(opt.bid) || 0,
                    ask: parseFloat(opt.ask) || 0,
                    mid: (parseFloat(opt.bid) + parseFloat(opt.ask)) / 2 || 0,
                    last: parseFloat(opt.last_trade_price) || 0,
                    volume: parseInt(opt.volume) || 0,
                    openInterest: parseInt(opt.open_interest) || 0,
                    iv: parseFloat(opt.iv) || null,
                    delta: parseFloat(opt.delta) || null,
                    gamma: parseFloat(opt.gamma) || null,
                    theta: parseFloat(opt.theta) || null,
                    vega: parseFloat(opt.vega) || null,
                    dte: opt.dte || null
                };
                
                if (isCall) {
                    calls.push(parsed);
                } else {
                    puts.push(parsed);
                }
                
                // Collect IV for ATM
                if (spotPrice && Math.abs(strike - spotPrice) / spotPrice < 0.05) {
                    if (parsed.iv > 0) {
                        ivSum += parsed.iv * 100; // CBOE IV is decimal
                        ivCount++;
                    }
                }
            }
            
            return {
                ticker: symbol,
                spotPrice,
                calls,
                puts,
                expirations: Array.from(expirations).sort(),
                ivRank: ivCount > 0 ? Math.round(ivSum / ivCount) : null,
                source: 'cboe'
            };
        }
    } catch (e) {
        console.log(`[MarketDataService] CBOE chain failed for ${symbol}:`, e.message);
    }
    
    return null;
}

/**
 * Get specific option premium with automatic fallback
 * @param {string} ticker - Stock symbol
 * @param {number} strike - Strike price
 * @param {string} expiry - Expiration date (YYYY-MM-DD)
 * @param {string} optionType - 'C' for call, 'P' for put
 * @returns {Promise<{bid, ask, mid, iv, delta, theta, source}>}
 */
async function getOptionPremium(ticker, strike, expiry, optionType = 'P') {
    const symbol = ticker.toUpperCase().trim();
    const type = optionType.toUpperCase();
    
    // 1. Try Schwab first
    if (schwabApiCall) {
        try {
            const url = `/marketdata/v1/chains?symbol=${symbol}&contractType=${type === 'C' ? 'CALL' : 'PUT'}&strike=${strike}&fromDate=${expiry}&toDate=${expiry}`;
            const data = await schwabApiCall(url);
            
            const expMap = type === 'C' ? data.callExpDateMap : data.putExpDateMap;
            if (expMap) {
                for (const [expKey, strikes] of Object.entries(expMap)) {
                    for (const [strikeKey, contracts] of Object.entries(strikes)) {
                        if (Math.abs(parseFloat(strikeKey) - strike) < 0.01) {
                            const c = contracts[0];
                            if (c) {
                                return {
                                    ticker: symbol,
                                    strike,
                                    expiry,
                                    optionType: type,
                                    bid: c.bid,
                                    ask: c.ask,
                                    mid: (c.bid + c.ask) / 2,
                                    last: c.last,
                                    iv: c.volatility,
                                    delta: c.delta,
                                    theta: c.theta,
                                    gamma: c.gamma,
                                    vega: c.vega,
                                    source: 'schwab'
                                };
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`[MarketDataService] Schwab premium failed for ${symbol} ${strike} ${type}:`, e.message);
        }
    }
    
    // 2. Try CBOE
    try {
        const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const allOptions = data.data?.options || [];
            
            // Format expiry to match CBOE format (YYYY-MM-DD)
            const targetExpiry = expiry.slice(0, 10);
            
            for (const opt of allOptions) {
                if (opt.option_type === type && 
                    opt.expiration_date === targetExpiry &&
                    Math.abs(parseFloat(opt.strike) - strike) < 0.01) {
                    
                    return {
                        ticker: symbol,
                        strike,
                        expiry,
                        optionType: type,
                        bid: parseFloat(opt.bid) || 0,
                        ask: parseFloat(opt.ask) || 0,
                        mid: (parseFloat(opt.bid) + parseFloat(opt.ask)) / 2,
                        last: parseFloat(opt.last_trade_price) || 0,
                        iv: parseFloat(opt.iv) * 100 || null, // CBOE is decimal
                        delta: parseFloat(opt.delta) || null,
                        theta: parseFloat(opt.theta) || null,
                        gamma: parseFloat(opt.gamma) || null,
                        vega: parseFloat(opt.vega) || null,
                        source: 'cboe'
                    };
                }
            }
        }
    } catch (e) {
        console.log(`[MarketDataService] CBOE premium failed for ${symbol} ${strike} ${type}:`, e.message);
    }
    
    return null;
}

/**
 * Get multiple quotes at once (batch)
 * @param {string[]} tickers - Array of symbols
 * @returns {Promise<Object>} - Map of ticker -> quote
 */
async function getQuotes(tickers) {
    const symbols = tickers.map(t => t.toUpperCase().trim());
    const results = {};
    
    // 1. Try Schwab batch quote
    if (schwabApiCall) {
        try {
            const data = await schwabApiCall(`/marketdata/v1/quotes?symbols=${symbols.join(',')}`);
            
            for (const symbol of symbols) {
                if (data && data[symbol]?.quote) {
                    const q = data[symbol].quote;
                    const price = q.lastPrice || q.mark;
                    const high52 = q['52WeekHigh'];
                    const low52 = q['52WeekLow'];
                    
                    results[symbol] = {
                        ticker: symbol,
                        price,
                        change: q.netChange,
                        changePercent: q.netPercentChangeInDouble,
                        high52,
                        low52,
                        volume: q.totalVolume,
                        rangePosition: high52 && low52 && high52 !== low52 
                            ? Math.round((price - low52) / (high52 - low52) * 100) 
                            : null,
                        source: 'schwab'
                    };
                }
            }
            
            // Check if we got all of them
            const missing = symbols.filter(s => !results[s]);
            if (missing.length === 0) {
                return results;
            }
            
            // Fall through to get missing ones from Yahoo
            console.log(`[MarketDataService] Schwab missing ${missing.length} quotes, trying Yahoo`);
        } catch (e) {
            console.log(`[MarketDataService] Schwab batch quote failed:`, e.message);
        }
    }
    
    // 2. Get remaining from Yahoo (one at a time, unfortunately)
    const missing = symbols.filter(s => !results[s]);
    for (const symbol of missing) {
        const quote = await getQuote(symbol);
        if (quote) {
            results[symbol] = quote;
        }
    }
    
    return results;
}

/**
 * Find options near target delta
 * @param {string} ticker - Stock symbol
 * @param {string} optionType - 'C' or 'P'
 * @param {number} targetDelta - Target delta (e.g., 0.30 for 30-delta)
 * @param {number} targetDte - Target days to expiration
 * @returns {Promise<Object>} - Best matching option
 */
async function findOptionByDelta(ticker, optionType, targetDelta, targetDte = 30) {
    const chain = await getOptionsChain(ticker, { contractType: optionType === 'C' ? 'CALL' : 'PUT' });
    
    if (!chain) return null;
    
    const options = optionType === 'C' ? chain.calls : chain.puts;
    
    // Filter to target DTE range (+/- 10 days)
    const candidates = options.filter(o => {
        const dte = o.dte || calculateDte(o.expiration);
        return dte >= targetDte - 10 && dte <= targetDte + 10;
    });
    
    // Find closest to target delta
    const absDelta = Math.abs(targetDelta);
    let best = null;
    let bestDiff = Infinity;
    
    for (const opt of candidates) {
        if (opt.delta) {
            const diff = Math.abs(Math.abs(opt.delta) - absDelta);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = opt;
            }
        }
    }
    
    return best;
}

/**
 * Calculate DTE from expiration date string
 */
function calculateDte(expirationDate) {
    const exp = new Date(expirationDate + 'T16:00:00');
    const now = new Date();
    return Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
}

module.exports = {
    initialize,
    getQuote,
    getQuotes,
    getOptionsChain,
    getOptionPremium,
    findOptionByDelta,
    calculateDte
};
