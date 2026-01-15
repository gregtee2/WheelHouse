// WheelHouse - API Module
// Yahoo Finance price fetching with CORS proxy fallbacks

import { state } from './state.js';
import { showNotification } from './utils.js';

const YAHOO_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const PROXIES = [
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
];

/**
 * Fetch stock price from Yahoo Finance
 * Tries multiple CORS proxies until one works
 */
export async function fetchFromYahoo(ticker) {
    // Add cache-buster to avoid stale data
    const cacheBuster = Date.now();
    const yahooUrl = `${YAHOO_BASE}${ticker}?interval=1d&range=1d&_cb=${cacheBuster}`;
    
    let data = null;
    let lastError = null;
    
    for (const getProxyUrl of PROXIES) {
        try {
            const proxyUrl = getProxyUrl(yahooUrl);
            const response = await fetch(proxyUrl, { 
                cache: 'no-store',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!response.ok) continue;
            data = await response.json();
            if (data.chart?.result?.[0]) break;
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
        const result = await fetchFromYahoo(ticker);
        const price = result.meta.regularMarketPrice;
        
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
        const result = await fetchFromYahoo(ticker);
        const price = result.meta.regularMarketPrice;
        
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
        const result = await fetchFromYahoo(ticker);
        const price = result.meta.regularMarketPrice;
        
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
