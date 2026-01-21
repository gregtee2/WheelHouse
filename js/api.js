// WheelHouse - API Module
// Yahoo Finance price fetching with CORS proxy fallbacks

import { state } from './state.js';
import { showNotification } from './utils.js';

const YAHOO_CHART_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const CBOE_OPTIONS_BASE = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';

// Local proxy endpoints (works when using server.js)
const LOCAL_CBOE_PROXY = '/api/cboe/';
const LOCAL_YAHOO_PROXY = '/api/yahoo/';

// CORS proxies - fallback when local proxy not available
const PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://thingproxy.freeboard.io/fetch/${url}`
];

/**
 * Fetch stock price from Yahoo Finance
 * Tries multiple CORS proxies until one works
 */
export async function fetchFromYahoo(ticker) {
    const tickerUpper = ticker.toUpperCase();
    let data = null;
    let lastError = null;
    
    // Try local proxy first (works with server.js)
    try {
        const localUrl = `${LOCAL_YAHOO_PROXY}${tickerUpper}.json`;
        const response = await fetch(localUrl);
        if (response.ok) {
            data = await response.json();
            if (data.chart?.result?.[0]) {
                return data.chart.result[0];
            }
        }
    } catch (e) {
        // Local proxy not available, try CORS proxies
    }
    
    // Fallback to CORS proxies
    const cacheBuster = Date.now();
    const yahooUrl = `${YAHOO_CHART_BASE}${tickerUpper}?interval=1d&range=1d&_cb=${cacheBuster}`;
    
    for (const getProxyUrl of PROXIES) {
        try {
            const proxyUrl = getProxyUrl(yahooUrl);
            const response = await fetch(proxyUrl);
            if (!response.ok) continue;
            data = await response.json();
            if (data.chart?.result?.[0]) return data.chart.result[0];
        } catch (e) {
            lastError = e;
            continue;
        }
    }
    
    if (!data) throw lastError || new Error('All proxies failed');
    if (!data.chart?.result?.[0]) throw new Error('Invalid ticker');
    
    return data.chart.result[0];
}

/**
 * Fetch stock price - tries CBOE first (reliable), falls back to Yahoo
 * This is the preferred way to get current stock prices
 * @param {string} ticker - Stock ticker symbol
 * @returns {number|null} - Current stock price or null
 */
export async function fetchStockPrice(ticker) {
    const tickerUpper = ticker.toUpperCase();
    
    // Try CBOE first (includes stock price in options data)
    try {
        const cboeRes = await fetch(`/api/cboe/${tickerUpper}.json`);
        if (cboeRes.ok) {
            const cboeData = await cboeRes.json();
            if (cboeData.data?.current_price) {
                console.log(`[PRICE] ${tickerUpper}: $${cboeData.data.current_price.toFixed(2)} (CBOE)`);
                return cboeData.data.current_price;
            }
        }
    } catch (e) {
        console.log(`[PRICE] CBOE failed for ${tickerUpper}, trying Yahoo...`);
    }
    
    // Fallback to Yahoo
    try {
        const result = await fetchFromYahoo(tickerUpper);
        const price = result.meta?.regularMarketPrice;
        if (price) {
            console.log(`[PRICE] ${tickerUpper}: $${price.toFixed(2)} (Yahoo)`);
            return price;
        }
    } catch (e) {
        console.warn(`[PRICE] Yahoo also failed for ${tickerUpper}: ${e.message}`);
    }
    
    return null;
}

/**
 * Fetch earnings and dividend calendar data from Yahoo Finance
 * Returns upcoming earnings date and ex-dividend date
 * @param {string} ticker - Stock ticker symbol
 * @returns {object} - { earningsDate, exDividendDate, dividendDate }
 */
export async function fetchCalendarData(ticker) {
    const tickerUpper = ticker.toUpperCase();
    
    // Try local proxy first
    try {
        const localUrl = `/api/yahoo/calendar/${tickerUpper}.json`;
        const response = await fetch(localUrl);
        if (response.ok) {
            const data = await response.json();
            return data;
        }
    } catch (e) {
        console.log('Calendar fetch failed:', e.message);
    }
    
    // Return empty data if failed (non-critical feature)
    return {
        ticker: tickerUpper,
        earningsDate: null,
        exDividendDate: null,
        dividendDate: null
    };
}

// Make fetchCalendarData globally available
window.fetchCalendarData = fetchCalendarData;

/**
 * Fetch options chain from CBOE (free delayed quotes)
 * @param {string} ticker - Stock ticker symbol (e.g., "AAPL")

 * @returns {object} - { calls: [], puts: [], expirations: [], timestamp: string }
 */
export async function fetchOptionsChain(ticker) {
    const tickerUpper = ticker.toUpperCase();
    const cboeUrl = `${CBOE_OPTIONS_BASE}${tickerUpper}.json`;
    
    let data = null;
    let lastError = null;
    
    // Try local proxy first (works with server.js)
    try {
        const localUrl = `${LOCAL_CBOE_PROXY}${tickerUpper}.json`;
        console.log(`Trying local CBOE proxy: ${localUrl}`);
        const response = await fetch(localUrl, { cache: 'no-store' });
        if (response.ok) {
            data = await response.json();
            if (data.data?.options) {
                console.log(`  ✅ Local proxy: ${data.data.options.length} options`);
                // Log CBOE timestamp to see when data was last updated
                if (data.timestamp) {
                    console.log(`  📅 CBOE timestamp: ${data.timestamp}`);
                }
                // Debug: Find and log the specific TSLL $17 put raw data
                if (tickerUpper === 'TSLL') {
                    const tsll17put = data.data.options.find(o => 
                        o.option.includes('P00017000') && o.option.includes('260130')
                    );
                    if (tsll17put) {
                        console.log(`  🔍 RAW TSLL 260130 $17 PUT:`, {
                            bid: tsll17put.bid,
                            ask: tsll17put.ask,
                            last: tsll17put.last_trade_price
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.log(`  Local proxy not available, trying CORS proxies...`);
    }
    
    // Fall back to CORS proxies if local didn't work
    if (!data?.data?.options) {
        for (const getProxyUrl of PROXIES) {
            try {
                const proxyUrl = getProxyUrl(cboeUrl);
                console.log(`Trying CBOE via proxy: ${proxyUrl.substring(0, 60)}...`);
                // Don't use custom headers - they cause CORS preflight failures
                const response = await fetch(proxyUrl);
                if (!response.ok) {
                    console.log(`  Proxy returned ${response.status}`);
                    continue;
                }
                data = await response.json();
                if (data.data?.options) {
                    console.log(`  ✅ Got ${data.data.options.length} options`);
                    break;
                }
            } catch (e) {
                lastError = e;
                console.log(`  ❌ Proxy failed: ${e.message}`);
                continue;
            }
        }
    }
    
    if (!data?.data?.options) {
        throw lastError || new Error('No options data for ' + ticker);
    }
    
    // Parse CBOE format - option symbol format: AAPL260117C00250000
    // Format: TICKER + YYMMDD + C/P + 00000000 (strike * 1000, 8 digits)
    const calls = [];
    const puts = [];
    const expirationSet = new Set();
    
    for (const opt of data.data.options) {
        // Parse the option symbol
        const symbol = opt.option;
        const match = symbol.match(/([A-Z]+)(\d{6})([CP])(\d{8})/);
        if (!match) continue;
        
        const [, , dateStr, type, strikeStr] = match;
        const expiration = `20${dateStr.slice(0,2)}-${dateStr.slice(2,4)}-${dateStr.slice(4,6)}`;
        const strike = parseInt(strikeStr) / 1000;
        
        expirationSet.add(expiration);
        
        const parsed = {
            symbol: symbol,
            expiration: expiration,
            strike: strike,
            bid: opt.bid || 0,
            ask: opt.ask || 0,
            lastPrice: opt.last_trade_price || 0,
            impliedVolatility: opt.iv || 0,
            volume: opt.volume || 0,
            openInterest: opt.open_interest || 0,
            delta: opt.delta || 0,
            gamma: opt.gamma || 0,
            theta: opt.theta || 0,
            vega: opt.vega || 0
        };
        
        if (type === 'C') {
            calls.push(parsed);
        } else {
            puts.push(parsed);
        }
    }
    
    return {
        ticker: ticker.toUpperCase(),
        timestamp: data.timestamp,
        // Include stock price from CBOE (no Yahoo needed!)
        currentPrice: data.data?.current_price || null,
        bid: data.data?.bid || null,
        ask: data.data?.ask || null,
        calls: calls,
        puts: puts,
        expirations: [...expirationSet].sort()
    };
}

/**
 * Find specific option contract in chain
 * @param {array} options - calls or puts array from fetchOptionsChain
 * @param {number} strike - Strike price to find
 * @param {string} expiration - Expiration date (YYYY-MM-DD)
 * @returns {object|null} - Option contract data or null
 */
export function findOption(options, strike, expiration) {
    return options.find(opt => 
        Math.abs(opt.strike - strike) < 0.01 && 
        opt.expiration === expiration
    ) || null;
}

/**
 * Fetch ticker price and update Options tab
 */
export async function fetchTickerPrice(tickerOverride = null) {
    const tickerInput = document.getElementById('tickerInput');
    const ticker = tickerOverride || (tickerInput?.value?.trim()?.toUpperCase() || '');
    const statusEl = document.getElementById('priceStatus');
    const btn = document.getElementById('fetchTickerBtn');
    
    if (!ticker) {
        if (statusEl) {
            statusEl.textContent = '⚠️ Please enter a ticker symbol';
            statusEl.style.color = '#ff5252';
        }
        return;
    }
    
    if (btn) {
        btn.textContent = '⏳';
        btn.disabled = true;
    }
    if (statusEl) {
        statusEl.textContent = 'Looking up ' + ticker + '...';
        statusEl.style.color = '#00d9ff';
    }
    
    try {
        const price = await fetchStockPrice(ticker);
        
        if (price) {
            state.spot = Math.round(price);
            const spotSlider = document.getElementById('spotSlider');
            const spotInput = document.getElementById('spotInput');
            if (spotSlider) spotSlider.value = state.spot;
            if (spotInput) spotInput.value = state.spot;
            
            if (statusEl) {
                statusEl.textContent = `✅ ${ticker}: $${price.toFixed(2)} (updated Spot)`;
                statusEl.style.color = '#00ff88';
            }
            
            // Suggest barriers
            const spread = state.optVol > 0.5 ? 0.20 : 0.15;
            const suggestedLower = Math.round(price * (1 - spread));
            const suggestedUpper = Math.round(price * (1 + spread));
            
            if (statusEl) {
                setTimeout(() => {
                    statusEl.textContent = `💡 Suggested barriers: $${suggestedLower} / $${suggestedUpper}`;
                    statusEl.style.color = '#ffaa00';
                }, 2000);
            }
            
            showNotification(`${ticker}: $${price.toFixed(2)}`, 'success');
        } else {
            throw new Error('Price not found');
        }
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = `❌ Could not find ${ticker}. Check ticker symbol.`;
            statusEl.style.color = '#ff5252';
        }
        console.error('Ticker lookup error:', error);
    } finally {
        if (btn) {
            btn.textContent = '📊 Fetch';
            btn.disabled = false;
        }
    }
}

/**
 * Fetch ticker price for Position tab or for loading a position
 * @param {string} tickerOverride - Optional ticker to use instead of reading from input
 */
export async function fetchPositionTickerPrice(tickerOverride = null) {
    const tickerInput = document.getElementById('posTicker');
    const ticker = tickerOverride || (tickerInput?.value?.trim()?.toUpperCase() || '');
    const statusEl = document.getElementById('posPriceStatus');
    const btn = document.getElementById('posFetchPriceBtn');
    
    if (!ticker) {
        if (statusEl) {
            statusEl.textContent = '⚠️ Enter ticker first';
            statusEl.style.color = '#ff5252';
        }
        return;
    }
    
    if (btn) {
        btn.textContent = '⏳';
        btn.disabled = true;
    }
    if (statusEl) {
        statusEl.textContent = 'Looking up ' + ticker + '...';
        statusEl.style.color = '#00d9ff';
    }
    
    try {
        const price = await fetchStockPrice(ticker);
        
        if (price) {
            // Update spot price in Options tab
            const spotInput = document.getElementById('spotInput');
            const spotSlider = document.getElementById('spotSlider');
            if (spotInput) spotInput.value = Math.round(price);
            if (spotSlider) spotSlider.value = Math.round(price);
            state.spot = price;
            
            // Also update ticker input if it exists
            const tickerField = document.getElementById('tickerInput');
            if (tickerField && tickerOverride) tickerField.value = ticker;
            
            if (statusEl) {
                statusEl.textContent = `✅ ${ticker}: $${price.toFixed(2)}`;
                statusEl.style.color = '#00ff88';
            }
            
            showNotification(`${ticker}: $${price.toFixed(2)}`, 'success');
        } else {
            throw new Error('Price not found');
        }
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = `❌ Could not find ${ticker}`;
            statusEl.style.color = '#ff5252';
        }
        console.error('Position ticker lookup error:', error);
    } finally {
        if (btn) {
            btn.textContent = '📊';
            btn.disabled = false;
        }
    }
}

/**
 * Fetch live price for heat map
 */
export async function fetchHeatMapPrice() {
    const ticker = state.currentPositionContext?.ticker || 
                   document.getElementById('tickerInput').value.trim().toUpperCase();
    const btn = document.getElementById('heatMapFetchBtn');
    
    if (!ticker) {
        alert('No ticker available. Load a position or enter a ticker in the Options tab.');
        return;
    }
    
    btn.textContent = '⏳';
    btn.disabled = true;
    
    try {
        const price = await fetchStockPrice(ticker);
        
        if (price) {
            document.getElementById('heatMapSpot').value = price.toFixed(2);
            // Trigger the update
            const event = new Event('input');
            document.getElementById('heatMapSpot').dispatchEvent(event);
            updateHeatMapSpot();
        }
    } catch (e) {
        console.error('Heat map price fetch error:', e);
    } finally {
        btn.textContent = '📊';
        btn.disabled = false;
    }
}

// Import the update function (will be defined in charts.js)
function updateHeatMapSpot() {
    // This will be called from charts module
    if (window.updateHeatMapSpot) window.updateHeatMapSpot();
}

/**
 * Test options chain fetch - call from console: testOptionsChain('AAPL')
 */
window.testOptionsChain = async function(ticker = 'AAPL') {
    try {
        console.log(`Fetching options chain for ${ticker} from CBOE...`);
        const chain = await fetchOptionsChain(ticker);
        
        console.log('📊 Options Chain Data (CBOE Delayed):');
        console.log(`  Ticker: ${chain.ticker}`);
        console.log(`  Timestamp: ${chain.timestamp}`);
        console.log(`  Expirations: ${chain.expirations.length} dates`);
        console.log(`  Calls: ${chain.calls.length} | Puts: ${chain.puts.length}`);
        
        // Show expirations
        console.log('\n📅 Available Expirations:');
        chain.expirations.slice(0, 8).forEach(exp => console.log('  ' + exp));
        if (chain.expirations.length > 8) console.log(`  ... and ${chain.expirations.length - 8} more`);
        
        // Sample call near ATM
        if (chain.calls.length > 0) {
            // Find one near middle strike
            const sorted = [...chain.calls].sort((a,b) => a.strike - b.strike);
            const mid = sorted[Math.floor(sorted.length / 2)];
            console.log('\n📞 Sample CALL:');
            console.log(`  ${mid.symbol}`);
            console.log(`  Strike: $${mid.strike} | Exp: ${mid.expiration}`);
            console.log(`  Bid: $${mid.bid.toFixed(2)} | Ask: $${mid.ask.toFixed(2)}`);
            console.log(`  IV: ${(mid.impliedVolatility * 100).toFixed(1)}% | Delta: ${mid.delta.toFixed(3)}`);
            console.log(`  Volume: ${mid.volume} | OI: ${mid.openInterest}`);
        }
        
        if (chain.puts.length > 0) {
            const sorted = [...chain.puts].sort((a,b) => a.strike - b.strike);
            const mid = sorted[Math.floor(sorted.length / 2)];
            console.log('\n📉 Sample PUT:');
            console.log(`  ${mid.symbol}`);
            console.log(`  Strike: $${mid.strike} | Exp: ${mid.expiration}`);
            console.log(`  Bid: $${mid.bid.toFixed(2)} | Ask: $${mid.ask.toFixed(2)}`);
            console.log(`  IV: ${(mid.impliedVolatility * 100).toFixed(1)}% | Delta: ${mid.delta.toFixed(3)}`);
        }
        
        return chain;
    } catch (e) {
        console.error('❌ Options chain fetch failed:', e.message);
        return null;
    }
};

// Expose fetchOptionsChain for external use
window.fetchOptionsChain = fetchOptionsChain;

/**
 * Fetch real-time option data for the current position/analysis
 * Updates: spot price, IV, and shows real bid/ask prices
 * @param {string} ticker - Stock ticker
 * @param {number} strike - Option strike price
 * @param {string} expiration - Expiration date (YYYY-MM-DD or MM/DD/YYYY)
 * @returns {object} - { spot, callOption, putOption, iv }
 */
export async function fetchLiveOptionData(ticker, strike, expiration) {
    if (!ticker) {
        throw new Error('No ticker provided');
    }
    
    // Normalize expiration to YYYY-MM-DD
    let expDate = expiration;
    if (expiration && expiration.includes('/')) {
        // Convert MM/DD/YYYY to YYYY-MM-DD
        const parts = expiration.split('/');
        if (parts.length === 3) {
            expDate = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
        }
    }
    
    console.log(`📡 Fetching live data for ${ticker} @ $${strike} exp ${expDate}...`);
    
    // Fetch options chain (includes stock price from CBOE)
    const optionsChain = await fetchOptionsChain(ticker);
    
    // Get stock price from CBOE data, or fetch separately
    let spot = optionsChain.currentPrice;
    if (!spot) {
        spot = await fetchStockPrice(ticker);
    }
    
    // Find matching options at this strike and expiration
    let callOption = null;
    let putOption = null;
    
    // Find closest expiration if exact match not found
    let targetExp = expDate;
    if (expDate && !optionsChain.expirations.includes(expDate)) {
        // Find nearest expiration
        const targetTime = new Date(expDate).getTime();
        let closest = optionsChain.expirations[0];
        let closestDiff = Math.abs(new Date(closest).getTime() - targetTime);
        
        for (const exp of optionsChain.expirations) {
            const diff = Math.abs(new Date(exp).getTime() - targetTime);
            if (diff < closestDiff) {
                closestDiff = diff;
                closest = exp;
            }
        }
        targetExp = closest;
        console.log(`  📅 Using nearest expiration: ${targetExp} (requested: ${expDate})`);
    }
    
    // Find options at this strike
    if (strike) {
        callOption = findOption(optionsChain.calls, strike, targetExp);
        putOption = findOption(optionsChain.puts, strike, targetExp);
        
        // If no exact match, find closest strike
        if (!callOption && !putOption) {
            const allOptions = [...optionsChain.calls, ...optionsChain.puts]
                .filter(o => o.expiration === targetExp);
            
            if (allOptions.length > 0) {
                allOptions.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike));
                const nearestStrike = allOptions[0].strike;
                callOption = findOption(optionsChain.calls, nearestStrike, targetExp);
                putOption = findOption(optionsChain.puts, nearestStrike, targetExp);
                console.log(`  💰 Using nearest strike: $${nearestStrike} (requested: $${strike})`);
            }
        }
    }
    
    // Get IV (prefer put IV for wheel strategy, fallback to call)
    const iv = putOption?.impliedVolatility || callOption?.impliedVolatility || null;
    
    console.log(`  ✅ Spot: $${spot?.toFixed(2)}`);
    if (callOption) console.log(`  📞 Call: $${callOption.bid}/$${callOption.ask} IV:${(callOption.impliedVolatility*100).toFixed(1)}%`);
    if (putOption) console.log(`  📉 Put: $${putOption.bid}/$${putOption.ask} IV:${(putOption.impliedVolatility*100).toFixed(1)}%`);
    
    return {
        spot,
        callOption,
        putOption,
        iv,
        timestamp: optionsChain.timestamp,
        expirationUsed: targetExp
    };
}

/**
 * Update Options tab with live market data
 * Called when user clicks "Price Options" with Sync enabled
 */
export async function syncLiveOptionsData() {
    const syncCheckbox = document.getElementById('syncCheckbox');
    const priceBtn = document.getElementById('priceBtn');
    
    // Only sync if checkbox is checked
    if (!syncCheckbox?.checked) {
        return null;
    }
    
    const ticker = state.currentPositionContext?.ticker || 
                   document.getElementById('tickerInput')?.value?.trim()?.toUpperCase();
    
    if (!ticker) {
        showNotification('Enter a ticker to fetch live data', 'warning');
        return null;
    }
    
    // Get current strike and expiration from UI
    const strike = parseFloat(document.getElementById('strikeInput')?.value || state.strike);
    
    // Calculate expiration from DTE (more reliable than date picker which can be stale)
    const dte = parseInt(document.getElementById('dteInput')?.value || state.dte || 30);
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + dte);
    const expiration = expiryDate.toISOString().split('T')[0]; // YYYY-MM-DD
    
    console.log(`[SYNC] Strike: $${strike}, DTE: ${dte} days → Expiry: ${expiration}`);
    
    // Show loading state
    if (priceBtn) {
        priceBtn.textContent = '⏳ Fetching...';
        priceBtn.disabled = true;
    }
    
    try {
        const liveData = await fetchLiveOptionData(ticker, strike, expiration);
        
        // Update Spot price
        if (liveData.spot) {
            state.spot = liveData.spot;
            const spotSlider = document.getElementById('spotSlider');
            const spotInput = document.getElementById('spotInput');
            if (spotSlider) spotSlider.value = Math.round(liveData.spot);
            if (spotInput) spotInput.value = Math.round(liveData.spot);
        }
        
        // Update IV slider with real IV
        if (liveData.iv && liveData.iv > 0) {
            const ivPercent = Math.round(liveData.iv * 100);
            state.optVol = liveData.iv;
            const volSlider = document.getElementById('optVolSlider');
            const volInput = document.getElementById('optVolInput');
            if (volSlider) volSlider.value = liveData.iv;  // Slider uses 0-1.5 scale
            if (volInput) volInput.value = ivPercent;       // Input uses % (e.g., 76)
            showNotification(`📊 IV updated to ${ivPercent}% from CBOE`, 'success');
        }
        
        // Show real bid/ask prices in the Option Prices panel
        const callPriceEl = document.getElementById('callPrice');
        const putPriceEl = document.getElementById('putPrice');
        
        if (liveData.callOption && callPriceEl) {
            const mid = ((liveData.callOption.bid + liveData.callOption.ask) / 2).toFixed(2);
            callPriceEl.textContent = `$${mid}`;
            callPriceEl.title = `Bid: $${liveData.callOption.bid.toFixed(2)} | Ask: $${liveData.callOption.ask.toFixed(2)}\nIV: ${(liveData.callOption.impliedVolatility*100).toFixed(1)}%`;
        }
        
        if (liveData.putOption && putPriceEl) {
            const mid = ((liveData.putOption.bid + liveData.putOption.ask) / 2).toFixed(2);
            putPriceEl.textContent = `$${mid}`;
            putPriceEl.title = `Bid: $${liveData.putOption.bid.toFixed(2)} | Ask: $${liveData.putOption.ask.toFixed(2)}\nIV: ${(liveData.putOption.impliedVolatility*100).toFixed(1)}%`;
        }
        
        // Update source indicator
        const priceSourceEl = document.getElementById('priceSource');
        if (priceSourceEl) {
            priceSourceEl.textContent = `📡 CBOE ${new Date().toLocaleTimeString()}`;
            priceSourceEl.style.color = '#00ff88';
        }
        
        // Store for later use
        state.liveOptionData = liveData;
        
        return liveData;
        
    } catch (e) {
        console.error('Live data fetch failed:', e);
        showNotification(`Failed to fetch live data: ${e.message}`, 'error');
        return null;
    } finally {
        if (priceBtn) {
            priceBtn.textContent = '💵 Price Options';
            priceBtn.disabled = false;
        }
    }
}

// ============================================
// Auto-refresh live data every 60 seconds
// ============================================
let autoRefreshInterval = null;
let lastRefreshTime = null;

function startAutoRefresh() {
    if (autoRefreshInterval) return; // Already running
    
    console.log('🔄 Starting auto-refresh (every 60s)');
    lastRefreshTime = new Date();
    updateRefreshStatus();
    
    autoRefreshInterval = setInterval(async () => {
        const autoCheckbox = document.getElementById('autoRefreshCheckbox');
        if (!autoCheckbox?.checked) {
            stopAutoRefresh();
            return;
        }
        
        lastRefreshTime = new Date();
        updateRefreshStatus();
        
        // Refresh Portfolio
        console.log('🔄 Auto-refreshing Portfolio...');
        const { renderPortfolio } = await import('./portfolio.js');
        await renderPortfolio(true);
        
    }, 60000); // 60 seconds
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        console.log('⏹️ Stopping auto-refresh');
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        lastRefreshTime = null;
        updateRefreshStatus();
    }
}

function updateRefreshStatus() {
    const autoCheckbox = document.getElementById('autoRefreshCheckbox');
    const label = autoCheckbox?.parentElement;
    if (!label) return;
    
    if (autoRefreshInterval && lastRefreshTime) {
        const timeStr = lastRefreshTime.toLocaleTimeString();
        label.style.color = '#00ff88';
        label.title = `Last refresh: ${timeStr} - Next in 60s`;
    } else {
        label.style.color = '#aaa';
        label.title = 'Auto-refresh prices every 60 seconds from CBOE';
    }
}

// Toggle auto-refresh when checkbox changes
function setupAutoRefreshToggle() {
    const autoCheckbox = document.getElementById('autoRefreshCheckbox');
    if (autoCheckbox) {
        autoCheckbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                startAutoRefresh();
            } else {
                stopAutoRefresh();
            }
        });
    }
}

// Initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAutoRefreshToggle);
} else {
    setupAutoRefreshToggle();
}

// Expose for use
window.fetchLiveOptionData = fetchLiveOptionData;
window.syncLiveOptionsData = syncLiveOptionsData;
window.startAutoRefresh = startAutoRefresh;
window.stopAutoRefresh = stopAutoRefresh;
