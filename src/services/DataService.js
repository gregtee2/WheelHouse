/**
 * DataService - Market data fetching utilities
 * 
 * Functions:
 * - fetchJson - Fetch JSON over HTTPS
 * - fetchJsonHttp - Fetch JSON over HTTP (for local services)
 * - fetchText - Fetch plain text over HTTPS
 * - fetchTickerIVData - Get ATM IV for a ticker
 * - estimateIVRank - Heuristic IV rank estimation
 * - fetchOptionPremium - Get option premium (Schwab → CBOE fallback)
 * - fetchOptionPremiumSchwab - Schwab-specific option fetch
 * - fetchOptionPremiumCBOE - CBOE-specific option fetch
 * - fetchDeepDiveData - Extended ticker data for analysis
 */

const https = require('https');
const http = require('http');
const CacheService = require('./CacheService');

// Cache instances
const tickerDataCache = new Map();
const optionPremiumCache = new Map();
const CACHE_TTL = 60000; // 1 minute

// Get Schwab API helper (lazily loaded to avoid circular deps)
let schwabApiCall = null;
const getSchwabApiCall = () => {
    if (!schwabApiCall) {
        try {
            const schwabRoutes = require('../routes/schwabRoutes');
            schwabApiCall = schwabRoutes.schwabApiCall || (async () => null);
        } catch (e) {
            console.log('[DataService] Schwab routes not available:', e.message);
            schwabApiCall = async () => null;
        }
    }
    return schwabApiCall;
};

// Helper for cache logging
const VERBOSE = process.env.VERBOSE_LOGGING === 'true';
function logCache(action, key, age = null) {
    if (!VERBOSE) return;
    const ageStr = age ? ` (age: ${(age/1000).toFixed(1)}s)` : '';
    console.log(`[CACHE] ${action}: ${key}${ageStr}`);
}

// Generate cache key for option premium
function getCacheKey(ticker, strike, expiry, optionType) {
    return `${ticker}_${strike}_${expiry}_${optionType}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// IV Data Functions
// ═══════════════════════════════════════════════════════════════════════════

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
            const schwabApi = getSchwabApiCall();
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + 30);
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() + 20);
            const toDate = new Date();
            toDate.setDate(toDate.getDate() + 45);
            
            const chainData = await schwabApi(
                `/marketdata/v1/chains?symbol=${ticker}&contractType=PUT&fromDate=${fromDate.toISOString().split('T')[0]}&toDate=${toDate.toISOString().split('T')[0]}&strikeCount=20`
            );
            
            if (chainData && chainData.putExpDateMap) {
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
                    allPuts.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
                    const atm = allPuts[0];
                    const atmIV = atm.option.volatility;
                    
                    if (atmIV) {
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
            const targetDTE = 30;
            const puts = options.filter(opt => {
                if (!opt.option?.includes('P')) return false;
                const symDate = opt.option.substring(opt.option.length - 15, opt.option.length - 9);
                const expDate = new Date(2000 + parseInt(symDate.slice(0,2)), parseInt(symDate.slice(2,4)) - 1, parseInt(symDate.slice(4,6)));
                const dte = Math.floor((expDate - new Date()) / (1000 * 60 * 60 * 24));
                return dte >= 20 && dte <= 45;
            });
            
            if (puts.length > 0) {
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

function estimateIVRank(ticker, currentIV) {
    const ivRanges = {
        high: { tickers: ['GME', 'AMC', 'TSLA', 'RIVN', 'LCID', 'MARA', 'RIOT', 'COIN', 'HOOD', 'PLTR', 'SOFI', 'AFRM', 'UPST', 'HIMS', 'IONQ', 'SMCI', 'NVDA'], low: 40, high: 120 },
        medium: { tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'AMD', 'INTC', 'CRM', 'ADBE', 'ORCL'], low: 20, high: 60 },
        low: { tickers: ['SPY', 'QQQ', 'IWM', 'DIA', 'JNJ', 'PG', 'KO', 'PEP', 'WMT', 'JPM', 'BAC'], low: 10, high: 35 },
        commodity: { tickers: ['GLD', 'SLV', 'USO', 'UNG', 'XLE', 'XLF', 'XLK'], low: 15, high: 50 },
        leveraged: { tickers: ['TQQQ', 'SQQQ', 'UPRO', 'SPXU', 'SOXL', 'SOXS', 'TSLL', 'NVDL'], low: 50, high: 150 }
    };
    
    let range = { low: 20, high: 80 };
    for (const [category, data] of Object.entries(ivRanges)) {
        if (data.tickers.includes(ticker.toUpperCase())) {
            range = data;
            break;
        }
    }
    
    let ivRank = Math.round((currentIV - range.low) / (range.high - range.low) * 100);
    ivRank = Math.max(0, Math.min(100, ivRank));
    
    return ivRank;
}

// ═══════════════════════════════════════════════════════════════════════════
// Option Premium Functions
// ═══════════════════════════════════════════════════════════════════════════

async function fetchOptionPremium(ticker, strike, expiry, optionType = 'PUT') {
    const cacheKey = getCacheKey(ticker, strike, expiry, optionType);
    const cached = optionPremiumCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logCache('HIT option premium', `${ticker} $${strike} ${optionType}`, Date.now() - cached.timestamp);
        return cached.data;
    }
    
    const schwabResult = await fetchOptionPremiumSchwab(ticker, strike, expiry, optionType);
    if (schwabResult) {
        optionPremiumCache.set(cacheKey, { data: schwabResult, timestamp: Date.now() });
        logCache('STORE option premium', `${ticker} $${strike} ${optionType}`);
        return schwabResult;
    }
    
    console.log(`[OPTION] Schwab unavailable, falling back to CBOE for ${ticker}`);
    const cboeResult = await fetchOptionPremiumCBOE(ticker, strike, expiry, optionType);
    if (cboeResult) {
        optionPremiumCache.set(cacheKey, { data: cboeResult, timestamp: Date.now() });
        logCache('STORE option premium', `${ticker} $${strike} ${optionType}`);
    }
    return cboeResult;
}

async function fetchOptionPremiumSchwab(ticker, strike, expiry, optionType = 'PUT') {
    try {
        const schwabApi = getSchwabApiCall();
        const currentYear = new Date().getFullYear();
        let month, day, expiryYear;
        
        const longMatch = expiry.match(/(\w+)\s+(\d+),?\s*(\d{4})/);
        if (longMatch) {
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[longMatch[1]];
            day = longMatch[2].padStart(2, '0');
            expiryYear = parseInt(longMatch[3]);
        } else {
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
        
        const isLeaps = expiryYear > currentYear;
        const dateRangeDays = isLeaps ? 14 : 7;
        const fromDate = expiryDate;
        const toDate = new Date(new Date(expiryDate).getTime() + dateRangeDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const chainData = await schwabApi(`/marketdata/v1/chains?symbol=${ticker}&contractType=${optionType}&fromDate=${fromDate}&toDate=${toDate}&strikeCount=50`);
        
        if (!chainData || chainData.status === 'FAILED') {
            console.log(`[SCHWAB] No option chain data for ${ticker}`);
            return null;
        }
        
        const expDateMap = optionType === 'PUT' ? chainData.putExpDateMap : chainData.callExpDateMap;
        if (!expDateMap || Object.keys(expDateMap).length === 0) {
            console.log(`[SCHWAB] No ${optionType} options in chain for ${ticker}`);
            return null;
        }
        
        const allOptions = [];
        for (const dateKey of Object.keys(expDateMap)) {
            const strikeMap = expDateMap[dateKey];
            for (const strikeKey of Object.keys(strikeMap)) {
                const options = strikeMap[strikeKey];
                if (options && options.length > 0) {
                    const opt = options[0];
                    allOptions.push({
                        strike: parseFloat(strikeKey),
                        expiry: dateKey.split(':')[0],
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
        
        allOptions.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
        const closest = allOptions[0];
        const matchingOption = closest.option;
        
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
            iv: matchingOption.volatility ? matchingOption.volatility.toFixed(1) : null,
            delta: matchingOption.delta || null,
            theta: matchingOption.theta || null,
            gamma: matchingOption.gamma || null,
            actualStrike: closest.strike,
            actualExpiry: closest.expiry,
            source: 'schwab'
        };
    } catch (e) {
        console.log(`[SCHWAB] Failed to fetch option for ${ticker}: ${e.message}`);
        return null;
    }
}

async function fetchOptionPremiumCBOE(ticker, strike, expiry, optionType = 'PUT') {
    try {
        const cacheBuster = Date.now();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
        const data = await fetchJson(cboeUrl);
        
        if (!data?.data?.options) {
            console.log(`[CBOE] No options data for ${ticker}`);
            return null;
        }
        
        const currentYear = new Date().getFullYear();
        let month, day, year;
        
        const longMatch = expiry.match(/(\w+)\s+(\d+),?\s*(\d{4})/);
        if (longMatch) {
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[longMatch[1]];
            day = longMatch[2].padStart(2, '0');
            year = longMatch[3].slice(-2);
        } else {
            const shortMatch = expiry.match(/(\w+)\s+(\d+)/);
            if (!shortMatch) {
                console.log(`[CBOE] Could not parse expiry: ${expiry}`);
                return null;
            }
            const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            month = monthMap[shortMatch[1]];
            day = shortMatch[2].padStart(2, '0');
            year = String(currentYear).slice(-2);
        }
        
        const optSymbol = optionType === 'CALL' ? 'C' : 'P';
        console.log(`[CBOE] Looking for ${ticker} ${optionType} expiry: 20${year}-${month}-${day} strike=$${strike}`);
        
        const options = data.data.options;
        const filteredOptions = options.filter(opt => opt.option?.includes(optSymbol));
        
        const datePrefix = `${ticker}${year}${month}`;
        const targetDay = parseInt(day);
        const nearbyOptions = filteredOptions.filter(opt => {
            if (!opt.option?.startsWith(datePrefix)) return false;
            const symDay = parseInt(opt.option.substring(ticker.length + 4, ticker.length + 6));
            return Math.abs(symDay - targetDay) <= 7;
        });
        
        if (nearbyOptions.length === 0) {
            console.log(`[CBOE] No ${optionType.toLowerCase()}s found for ${ticker} near 20${year}-${month}-${day}`);
            return null;
        }
        
        const optionsWithStrikes = nearbyOptions.map(opt => ({
            option: opt,
            strike: parseFloat(opt.option.slice(-8)) / 1000,
            expiry: `${opt.option.substring(ticker.length, ticker.length + 6)}`
        }));
        
        const availableStrikes = [...new Set(optionsWithStrikes.map(p => p.strike))].sort((a, b) => a - b);
        console.log(`[CBOE] Found ${nearbyOptions.length} ${optionType.toLowerCase()}s. Available strikes: $${availableStrikes.slice(0, 15).join(', $')}${availableStrikes.length > 15 ? '...' : ''}`);
        
        optionsWithStrikes.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
        const closest = optionsWithStrikes[0];
        
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

// ═══════════════════════════════════════════════════════════════════════════
// Deep Dive Data
// ═══════════════════════════════════════════════════════════════════════════

async function fetchDeepDiveData(ticker) {
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
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo`;
        const chartData = await fetchJson(chartUrl);
        const quote = chartData.chart?.result?.[0];
        const meta = quote?.meta;
        
        result.price = meta?.regularMarketPrice?.toFixed(2);
        result.yearHigh = meta?.fiftyTwoWeekHigh?.toFixed(2);
        result.yearLow = meta?.fiftyTwoWeekLow?.toFixed(2);
        
        const closes = quote?.indicators?.quote?.[0]?.close?.filter(c => c !== null) || [];
        const lows = quote?.indicators?.quote?.[0]?.low?.filter(l => l !== null) || [];
        const highs = quote?.indicators?.quote?.[0]?.high?.filter(h => h !== null) || [];
        
        if (closes.length > 0) {
            result.threeMonthHigh = Math.max(...closes).toFixed(2);
            result.threeMonthLow = Math.min(...closes).toFixed(2);
            
            const last20 = closes.slice(-20);
            const last50 = closes.slice(-50);
            result.sma20 = (last20.reduce((a, b) => a + b, 0) / last20.length).toFixed(2);
            result.sma50 = last50.length >= 50 
                ? (last50.reduce((a, b) => a + b, 0) / last50.length).toFixed(2) 
                : null;
            
            if (lows.length > 20) {
                const recentLows = lows.slice(-20).sort((a, b) => a - b);
                result.recentSupport = [
                    recentLows[0].toFixed(2),
                    recentLows[Math.floor(recentLows.length * 0.1)].toFixed(2)
                ];
            }
            
            const currentPrice = parseFloat(result.price);
            result.aboveSMA20 = currentPrice > parseFloat(result.sma20);
            result.aboveSMA50 = result.sma50 ? currentPrice > parseFloat(result.sma50) : null;
        }
        
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
    
    tickerDataCache.set(ticker, { data: result, timestamp: Date.now() });
    logCache('STORE ticker data', ticker);
    
    return result;
}

module.exports = {
    fetchJson,
    fetchJsonHttp,
    fetchText,
    fetchTickerIVData,
    estimateIVRank,
    fetchOptionPremium,
    fetchOptionPremiumSchwab,
    fetchOptionPremiumCBOE,
    fetchDeepDiveData
};
