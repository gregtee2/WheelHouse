// WheelHouse - Portfolio P&L Tracker
// Tracks actual P&L across all positions

import { state } from './state.js';
import { showNotification, isDebitPosition, calculateRealizedPnL, colors, createModal, modalHeader, calculatePortfolioGreeks } from './utils.js';
import { fetchStockPrice, fetchStockPricesBatch, fetchOptionsChain, findOption } from './api.js';
import { saveHoldingsToStorage, renderPositions } from './positions.js';

const STORAGE_KEY_CLOSED = 'wheelhouse_closed_positions';
const CHECKPOINT_KEY = 'wheelhouse_data_checkpoint';
const AI_LOG_KEY = 'wheelhouse_ai_predictions';

// ============================================================
// AI PREDICTION LOGGING
// ============================================================

/**
 * Log an AI prediction for future accuracy tracking
 * Call this whenever AI makes a prediction (entry, checkup, etc.)
 */
export function logAIPrediction(prediction) {
    const log = JSON.parse(localStorage.getItem(AI_LOG_KEY) || '[]');
    
    const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        type: prediction.type, // 'entry', 'checkup', 'roll', 'close'
        ticker: prediction.ticker,
        strike: prediction.strike,
        expiry: prediction.expiry,
        positionType: prediction.positionType, // 'short_put', 'covered_call', etc.
        
        // AI's prediction
        recommendation: prediction.recommendation, // 'ENTER', 'HOLD', 'ROLL', 'CLOSE'
        confidence: prediction.confidence || null, // 0-100%
        model: prediction.model || 'unknown',
        
        // Market snapshot at prediction time
        spotAtPrediction: prediction.spot || null,
        premiumAtPrediction: prediction.premium || null,
        
        // Will be filled in when position closes
        outcome: null, // 'win', 'loss', 'breakeven'
        actualPnL: null,
        resolvedAt: null,
        
        // Link to position if available
        positionId: prediction.positionId || null
    };
    
    log.push(entry);
    
    // Keep only last 500 predictions
    if (log.length > 500) {
        log.shift();
    }
    
    localStorage.setItem(AI_LOG_KEY, JSON.stringify(log));
    console.log('[AI-LOG] Recorded prediction:', entry.type, entry.ticker, entry.recommendation);
    
    return entry.id;
}

/**
 * Resolve an AI prediction with actual outcome
 */
export function resolveAIPrediction(predictionId, outcome, actualPnL) {
    const log = JSON.parse(localStorage.getItem(AI_LOG_KEY) || '[]');
    
    const prediction = log.find(p => p.id === predictionId);
    if (prediction) {
        prediction.outcome = outcome;
        prediction.actualPnL = actualPnL;
        prediction.resolvedAt = new Date().toISOString();
        localStorage.setItem(AI_LOG_KEY, JSON.stringify(log));
        console.log('[AI-LOG] Resolved prediction:', prediction.ticker, outcome, actualPnL);
    }
}

/**
 * Get AI prediction log for analysis
 */
export function getAIPredictionLog() {
    return JSON.parse(localStorage.getItem(AI_LOG_KEY) || '[]');
}

// Make available globally
window.logAIPrediction = logAIPrediction;
window.resolveAIPrediction = resolveAIPrediction;
window.getAIPredictionLog = getAIPredictionLog;

// ============================================================
// ACCOUNT BALANCES
// ============================================================

// Store preferred account hash in localStorage
const PREFERRED_ACCOUNT_KEY = 'wheelhouse_preferred_account';

/**
 * Fetch and display Schwab account balances
 */
export async function fetchAccountBalances() {
    const banner = document.getElementById('accountBalancesBanner');
    if (!banner) return;
    
    try {
        const res = await fetch('/api/schwab/accounts');
        if (!res.ok) {
            console.log('[BALANCES] Schwab not connected or auth failed');
            banner.style.display = 'none';
            return;
        }
        
        const accounts = await res.json();
        
        // Debug: log all accounts
        console.log('[BALANCES] All accounts:', accounts.map(a => ({
            type: a.securitiesAccount?.type,
            accountNumber: a.securitiesAccount?.accountNumber?.slice(-4), // Last 4 digits
            hasBalances: !!a.securitiesAccount?.currentBalances,
            equity: a.securitiesAccount?.currentBalances?.equity || a.securitiesAccount?.currentBalances?.liquidationValue
        })));
        
        // Try to find the right account in order of preference:
        // 1. User's saved preferred account
        // 2. MARGIN type account
        // 3. Account with highest equity (most likely the main trading account)
        const preferredHash = localStorage.getItem(PREFERRED_ACCOUNT_KEY);
        let account = null;
        
        if (preferredHash) {
            account = accounts.find(a => a.securitiesAccount?.accountNumber === preferredHash);
            if (account) console.log('[BALANCES] Using preferred account:', preferredHash.slice(-4));
        }
        
        if (!account) {
            // Try MARGIN type first
            account = accounts.find(a => a.securitiesAccount?.type === 'MARGIN');
            if (account) console.log('[BALANCES] Found MARGIN account');
        }
        
        if (!account) {
            // Fall back to account with highest equity
            account = accounts
                .filter(a => a.securitiesAccount?.currentBalances)
                .sort((a, b) => {
                    const eqA = a.securitiesAccount?.currentBalances?.equity || a.securitiesAccount?.currentBalances?.liquidationValue || 0;
                    const eqB = b.securitiesAccount?.currentBalances?.equity || b.securitiesAccount?.currentBalances?.liquidationValue || 0;
                    return eqB - eqA; // Descending
                })[0];
            if (account) console.log('[BALANCES] Using account with highest equity');
        }
        
        if (!account?.securitiesAccount?.currentBalances) {
            console.log('[BALANCES] No balance data found');
            banner.style.display = 'none';
            return;
        }
        
        // Store the account number for display
        const accountNumber = account.securitiesAccount?.accountNumber;
        const accountType = account.securitiesAccount?.type || 'Unknown';
        
        const bal = account.securitiesAccount.currentBalances;
        const fmt = (v) => {
            if (v === undefined || v === null) return '—';
            return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };
        
        // Update display - use correct Schwab field names
        document.getElementById('balCashAvailable').textContent = fmt(bal.availableFunds ?? bal.cashBalance);
        document.getElementById('balBuyingPower').textContent = fmt(bal.buyingPower);
        document.getElementById('balAccountValue').textContent = fmt(bal.equity ?? bal.liquidationValue);
        document.getElementById('balMarginUsed').textContent = fmt(bal.marginBalance || 0);
        document.getElementById('balDayTradeBP').textContent = fmt(bal.dayTradingBuyingPower);
        
        // Timestamp with account info
        const now = new Date();
        const lastDigits = accountNumber ? `...${accountNumber.slice(-4)}` : '';
        document.getElementById('balanceLastUpdated').innerHTML = `
            <span style="color:#00d9ff;">${accountType}</span> ${lastDigits} · Updated ${now.toLocaleTimeString()}
            ${accounts.length > 1 ? `<button onclick="window.showAccountSwitcher()" style="margin-left:8px; background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.4); color:#00d9ff; padding:2px 6px; border-radius:4px; cursor:pointer; font-size:10px;">Switch</button>` : ''}
        `;
        
        // Store accounts for switcher
        window._schwabAccounts = accounts;
        
        // Show the banner
        banner.style.display = 'block';
        
        console.log('[BALANCES] Displayed:', {
            account: accountNumber?.slice(-4),
            type: accountType,
            cash: bal.cashAvailableForTrading,
            buyingPower: bal.buyingPower,
            equity: bal.liquidationValue
        });
        
    } catch (e) {
        console.log('[BALANCES] Error:', e.message);
        banner.style.display = 'none';
    }
}

/**
 * Show account switcher modal
 */
window.showAccountSwitcher = function() {
    const accounts = window._schwabAccounts || [];
    if (accounts.length < 2) return;
    
    const preferredHash = localStorage.getItem(PREFERRED_ACCOUNT_KEY);
    
    const fmt = (v) => {
        if (v === undefined || v === null) return '—';
        return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    
    const rows = accounts.map(a => {
        const sec = a.securitiesAccount;
        const bal = sec?.currentBalances || {};
        const accNum = sec?.accountNumber || '';
        const type = sec?.type || 'Unknown';
        const equity = bal.equity || bal.liquidationValue || 0;
        const isSelected = accNum === preferredHash;
        
        return `
            <div style="padding:12px; margin:8px 0; background:${isSelected ? 'rgba(0,217,255,0.15)' : 'rgba(255,255,255,0.05)'}; border:1px solid ${isSelected ? '#00d9ff' : '#333'}; border-radius:8px; cursor:pointer;" 
                 onclick="window.selectAccount('${accNum}')">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="font-weight:bold; color:${type === 'MARGIN' ? '#00d9ff' : '#ffaa00'};">${type}</span>
                        <span style="color:#888; margin-left:8px;">...${accNum.slice(-4)}</span>
                        ${isSelected ? '<span style="color:#00ff88; margin-left:8px;">✓ Selected</span>' : ''}
                    </div>
                    <div style="text-align:right;">
                        <div style="color:#fff; font-weight:bold;">${fmt(equity)}</div>
                        <div style="color:#888; font-size:11px;">Account Value</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    const modal = createModal('accountSwitcher', `
        ${modalHeader('🔄 Switch Account', 'Choose which Schwab account to display')}
        <div style="padding:15px;">
            ${rows}
            <div style="margin-top:15px; padding:10px; background:rgba(255,170,0,0.1); border-radius:6px; font-size:12px; color:#ffaa00;">
                💡 Your selection will be remembered for future sessions.
            </div>
        </div>
    `);
    document.body.appendChild(modal);
};

/**
 * Select a Schwab account as preferred
 */
window.selectAccount = function(accountNumber) {
    localStorage.setItem(PREFERRED_ACCOUNT_KEY, accountNumber);
    document.getElementById('accountSwitcher')?.remove();
    fetchAccountBalances();
    showNotification(`Switched to account ...${accountNumber.slice(-4)}`, 'success');
};

// Initialize balance refresh button
document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refreshBalancesBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            fetchAccountBalances();
            showNotification('Refreshing balances...', 'info', 1500);
        });
    }
    
    // Auto-fetch balances when Portfolio tab is opened
    document.querySelectorAll('[data-tab="portfolio"]').forEach(tab => {
        tab.addEventListener('click', () => {
            // Small delay to ensure tab is visible
            setTimeout(fetchAccountBalances, 100);
        });
    });
});

// Export for use in main.js init
window.fetchAccountBalances = fetchAccountBalances;

// isDebitPosition is now imported from utils.js

/**
 * Trigger auto-save if enabled (calls the global function from positions.js)
 */
function triggerAutoSave() {
    if (window.triggerAutoSave) window.triggerAutoSave();
}

/**
 * Save a checkpoint of data counts - used to detect data loss
 */
function saveDataCheckpoint() {
    const checkpoint = {
        positions: (state.positions || []).length,
        holdings: (state.holdings || []).length,
        closedPositions: (state.closedPositions || []).length,
        timestamp: Date.now()
    };
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

/**
 * Load closed positions from storage
 */
export function loadClosedPositions() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_CLOSED);
        state.closedPositions = saved ? JSON.parse(saved) : [];
    } catch (e) {
        state.closedPositions = [];
    }
}

/**
 * Save closed positions to storage
 */
function saveClosedPositions() {
    localStorage.setItem(STORAGE_KEY_CLOSED, JSON.stringify(state.closedPositions || []));
    saveDataCheckpoint(); // Track data count for integrity check
    triggerAutoSave();
}

/**
 * Refresh prices for ALL open positions from Schwab (or CBOE fallback)
 * Updates lastOptionPrice and markedPrice on each position
 */
async function refreshAllPositionPrices() {
    const positions = state.positions || [];
    if (positions.length === 0) {
        console.log('[REFRESH] No positions to update');
        return;
    }
    
    console.log(`[REFRESH] Updating prices for ${positions.length} positions...`);
    
    // Check if Schwab is connected for real-time data
    let hasSchwab = false;
    try {
        if (window.SchwabAPI) {
            const status = await window.SchwabAPI.getStatus();
            hasSchwab = status.hasRefreshToken;
            console.log(`[REFRESH] Schwab status: ${hasSchwab ? 'Connected (real-time)' : 'Not connected (using CBOE delayed)'}`);
        }
    } catch (e) {
        console.log('[REFRESH] Could not check Schwab status:', e.message);
    }
    
    // Group positions by ticker to minimize API calls
    const tickerPositions = {};
    for (const pos of positions) {
        if (!tickerPositions[pos.ticker]) {
            tickerPositions[pos.ticker] = [];
        }
        tickerPositions[pos.ticker].push(pos);
    }
    
    let updated = 0;
    let failed = 0;
    
    for (const [ticker, tickerPos] of Object.entries(tickerPositions)) {
        try {
            // Fetch full options chain for this ticker (Schwab first, then CBOE)
            const chain = await fetchOptionsChain(ticker);
            if (!chain) {
                console.log(`[REFRESH] No chain data for ${ticker}`);
                failed += tickerPos.length;
                continue;
            }
            
            console.log(`[REFRESH] ${ticker}: Got ${chain.calls?.length || 0} calls, ${chain.puts?.length || 0} puts from ${hasSchwab ? 'Schwab' : 'CBOE'}`);
            
            // Update each position with this ticker
            for (const pos of tickerPos) {
                const isPut = pos.type?.toLowerCase().includes('put');
                const isCall = pos.type?.toLowerCase().includes('call');
                const options = isPut ? chain.puts : (isCall ? chain.calls : null);
                
                if (!options) {
                    console.log(`[REFRESH] ${ticker} ${pos.type}: Unknown option type`);
                    failed++;
                    continue;
                }
                
                // Find matching option by strike and expiry
                const strike = pos.strike;
                const expiry = pos.expiry; // YYYY-MM-DD format
                
                // Look for exact match first, then closest
                let matchedOption = options.find(o => 
                    Math.abs(o.strike - strike) < 0.01 && 
                    o.expiration === expiry
                );
                
                // If no exact match, try different date formats
                if (!matchedOption) {
                    matchedOption = options.find(o => {
                        if (Math.abs(o.strike - strike) > 0.01) return false;
                        // Try to normalize dates
                        const oExp = new Date(o.expiration).toISOString().split('T')[0];
                        const pExp = new Date(expiry).toISOString().split('T')[0];
                        return oExp === pExp;
                    });
                }
                
                if (matchedOption) {
                    // Use mid price (between bid and ask) for most accurate current value
                    const mid = matchedOption.mid || ((matchedOption.bid + matchedOption.ask) / 2);
                    const last = matchedOption.last || mid;
                    const price = mid > 0 ? mid : last;
                    
                    if (price > 0) {
                        const oldPrice = pos.lastOptionPrice;
                        pos.lastOptionPrice = price;
                        pos.markedPrice = price;
                        pos.priceUpdatedAt = new Date().toISOString();
                        updated++;
                        console.log(`[REFRESH] ${ticker} $${strike} ${isPut ? 'put' : 'call'}: $${oldPrice?.toFixed(2) || '?'} → $${price.toFixed(2)}`);
                    }
                } else {
                    console.log(`[REFRESH] ${ticker} $${strike} ${expiry}: No matching option found in chain`);
                    failed++;
                }
            }
        } catch (err) {
            console.error(`[REFRESH] Error fetching ${ticker}:`, err);
            failed += tickerPos.length;
        }
    }
    
    // Save updated positions
    if (updated > 0) {
        // Use the global window function to save
        if (window.savePositionsToStorage) {
            window.savePositionsToStorage();
        }
        // Re-render the positions table
        renderPositions();
    }
    
    console.log(`[REFRESH] Complete: ${updated} updated, ${failed} failed`);
    return { updated, failed };
}

// Export for use in other modules
window.refreshAllPositionPrices = refreshAllPositionPrices;

// ============================================================
// AUTO-REFRESH PRICES (30-second interval)
// ============================================================

let autoRefreshPricesInterval = null;
let lastPriceRefreshTime = null;
const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds

/**
 * Update the "Last updated" display
 */
function updatePriceLastUpdated() {
    lastPriceRefreshTime = new Date();
    const el = document.getElementById('priceLastUpdated');
    if (el) {
        el.textContent = `Updated: ${lastPriceRefreshTime.toLocaleTimeString()}`;
        el.style.color = '#00ff88';
        // Fade back to gray after 3 seconds
        setTimeout(() => {
            el.style.color = '#666';
        }, 3000);
    }
}

/**
 * Start auto-refreshing prices every 30 seconds
 */
function startAutoRefreshPrices() {
    if (autoRefreshPricesInterval) return; // Already running
    
    console.log('🔄 Starting auto-refresh prices (every 30s)');
    
    // Update checkbox label to show active
    const checkbox = document.getElementById('autoRefreshPricesCheckbox');
    if (checkbox) {
        checkbox.parentElement.style.color = '#00ff88';
    }
    
    autoRefreshPricesInterval = setInterval(async () => {
        // Check if still enabled
        const cb = document.getElementById('autoRefreshPricesCheckbox');
        if (!cb?.checked) {
            stopAutoRefreshPrices();
            return;
        }
        
        console.log('🔄 Auto-refreshing prices...');
        try {
            await refreshAllPositionPrices();
            updatePriceLastUpdated();
        } catch (err) {
            console.error('Auto-refresh failed:', err);
        }
    }, AUTO_REFRESH_INTERVAL);
    
    // Do an immediate refresh when starting
    refreshAllPositionPrices().then(() => {
        updatePriceLastUpdated();
    });
}

/**
 * Stop auto-refreshing prices
 */
function stopAutoRefreshPrices() {
    if (autoRefreshPricesInterval) {
        console.log('⏹️ Stopping auto-refresh prices');
        clearInterval(autoRefreshPricesInterval);
        autoRefreshPricesInterval = null;
        
        // Update checkbox label to show inactive
        const checkbox = document.getElementById('autoRefreshPricesCheckbox');
        if (checkbox) {
            checkbox.parentElement.style.color = '#aaa';
        }
    }
}

/**
 * Setup the auto-refresh checkbox toggle
 */
function setupAutoRefreshPrices() {
    const checkbox = document.getElementById('autoRefreshPricesCheckbox');
    if (!checkbox) return;
    
    // Load saved preference
    const saved = localStorage.getItem('wheelhouse_autoRefreshPrices');
    if (saved === 'true') {
        checkbox.checked = true;
        startAutoRefreshPrices();
    }
    
    // Handle toggle
    checkbox.addEventListener('change', (e) => {
        localStorage.setItem('wheelhouse_autoRefreshPrices', e.target.checked);
        if (e.target.checked) {
            startAutoRefreshPrices();
        } else {
            stopAutoRefreshPrices();
        }
    });
}

// Export
window.startAutoRefreshPrices = startAutoRefreshPrices;
window.stopAutoRefreshPrices = stopAutoRefreshPrices;

/**
 * Fetch current option price for a position from CBOE (real market data)
 * Falls back to Black-Scholes if CBOE doesn't have the option
 * Now uses CBOE for BOTH stock price and options - no Yahoo needed!
 */
async function fetchCurrentOptionPrice(position) {
    try {
        // Fetch options chain from CBOE (includes stock price!)
        const optionsChain = await fetchOptionsChain(position.ticker).catch(() => null);
        
        // Get stock price from CBOE (no more Yahoo dependency!)
        let spot = optionsChain?.currentPrice;
        
        // If CBOE doesn't have it, use fetchStockPrice helper
        if (!spot) {
            spot = await fetchStockPrice(position.ticker);
        }
        
        if (!spot) return { success: false };
        
        console.log(`[MATCH] ${position.ticker}: $${spot.toFixed(2)} from ${optionsChain?.currentPrice ? 'CBOE' : 'fallback'}`);
        
        const isPut = position.type.toLowerCase().includes('put');
        const strike = position.strike;
        
        console.log(`[MATCH] ${position.ticker}: Looking for ${isPut ? 'PUT' : 'CALL'} @ $${strike}`);
        
        // Try to find the exact option in CBOE data
        if (optionsChain) {
            // Convert expiry to YYYY-MM-DD format
            let expDate = position.expiry;
            console.log(`[MATCH]   Original expiry: ${expDate}`);
            
            if (expDate && expDate.includes('/')) {
                const parts = expDate.split('/');
                if (parts.length === 3) {
                    expDate = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
                }
            }
            console.log(`[MATCH]   Normalized expiry: ${expDate}`);
            console.log(`[MATCH]   Available expirations: ${optionsChain.expirations.slice(0,5).join(', ')}...`);
            
            // Find the option
            const options = isPut ? optionsChain.puts : optionsChain.calls;
            console.log(`[MATCH]   ${options.length} ${isPut ? 'puts' : 'calls'} in chain`);
            
            let matchedOption = findOption(options, strike, expDate);
            
            // If no exact match, try nearest expiration
            if (!matchedOption && optionsChain.expirations.length > 0) {
                console.log(`[MATCH]   No exact match, finding nearest expiration...`);
                const targetTime = new Date(expDate).getTime();
                let closestExp = optionsChain.expirations[0];
                let closestDiff = Math.abs(new Date(closestExp).getTime() - targetTime);
                
                for (const exp of optionsChain.expirations) {
                    const diff = Math.abs(new Date(exp).getTime() - targetTime);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                        closestExp = exp;
                    }
                }
                console.log(`[MATCH]   Trying nearest: ${closestExp}`);
                matchedOption = findOption(options, strike, closestExp);
            }
            
            if (matchedOption) {
                // Prefer last trade price over mid-price (more accurate for stale data)
                const midPrice = (matchedOption.bid + matchedOption.ask) / 2;
                const lastPrice = matchedOption.lastPrice || 0;
                const usePrice = lastPrice > 0 ? lastPrice : midPrice;
                const priceSource = lastPrice > 0 ? 'last' : 'mid';
                
                console.log(`[MATCH]   ✅ FOUND: ${matchedOption.symbol || 'no symbol'}`);
                console.log(`[MATCH]   Strike: $${matchedOption.strike}, Exp: ${matchedOption.expiration}, Type: ${matchedOption.type}`);
                console.log(`[MATCH]   Bid: $${matchedOption.bid} | Ask: $${matchedOption.ask} | Mid: $${midPrice.toFixed(2)} | Last: $${lastPrice.toFixed(2)}`);
                console.log(`[MATCH]   Using ${priceSource} price: $${usePrice.toFixed(2)}`);
                console.log(`[MATCH]   Position expiry: ${position.expiry}, DTE: ${position.dte}`);
                
                // Check staleness - CBOE timestamp format: "2026-01-16 17:46:21"
                const cboeTimestamp = optionsChain.timestamp;
                let dataAgeMinutes = null;
                if (cboeTimestamp) {
                    const cboeTime = new Date(cboeTimestamp.replace(' ', 'T'));
                    dataAgeMinutes = Math.round((Date.now() - cboeTime.getTime()) / 60000);
                    console.log(`[MATCH]   Data age: ${dataAgeMinutes} minutes`);
                }
                
                return {
                    spot,
                    optionPrice: usePrice,
                    bid: matchedOption.bid,
                    ask: matchedOption.ask,
                    lastPrice: lastPrice,
                    priceSource: priceSource,
                    iv: matchedOption.impliedVolatility,
                    delta: matchedOption.delta,
                    isLive: true,
                    dataAgeMinutes: dataAgeMinutes,
                    cboeTimestamp: cboeTimestamp,
                    success: true
                };
            } else {
                console.log(`[MATCH]   ❌ No match found, using Black-Scholes fallback`);
                // Show sample of available strikes at nearest expiration
                const nearestExp = optionsChain.expirations[0];
                const sampleStrikes = options
                    .filter(o => o.expiration === nearestExp)
                    .map(o => o.strike)
                    .slice(0, 10);
                console.log(`[MATCH]   Sample strikes at ${nearestExp}: ${sampleStrikes.join(', ')}`);
            }
        }
        
        // Fallback to Black-Scholes with estimated IV
        const dte = Math.max(1, position.dte);
        const T = dte / 365;
        const r = 0.05;
        const sigma = 0.30; // Fallback IV
        
        const price = blackScholesPrice(spot, strike, T, r, sigma, isPut);
        
        return {
            spot,
            optionPrice: Math.max(0.01, price),
            isLive: false,
            success: true
        };
    } catch (e) {
        console.warn(`Failed to fetch price for ${position.ticker}:`, e.message);
    }
    return { success: false };
}

/**
 * Simple Black-Scholes pricing
 */
function blackScholesPrice(S, K, T, r, sigma, isPut) {
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    const Nd1 = normalCDF(d1);
    const Nd2 = normalCDF(d2);
    
    if (isPut) {
        return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
    } else {
        return S * Nd1 - K * Math.exp(-r * T) * Nd2;
    }
}

function normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

/**
 * Render the portfolio view (Holdings + Closed Trades)
 * Note: Open positions are now only shown in the Positions tab
 */
export async function renderPortfolio(fetchPrices = false) {
    const loadingEl = document.getElementById('portfolioLoading');
    
    // Show loading if fetching prices for holdings
    if (fetchPrices && loadingEl) {
        loadingEl.style.display = 'block';
    }
    
    // Get position data for summary calculations (but don't render the table)
    const positions = (state.positions || []).filter(p => p.status === 'open');
    const positionData = positions.map(pos => {
        const isDebit = isDebitPosition(pos.type);
        const premiumAmount = pos.premium * 100 * pos.contracts;
        const currentPrice = pos.markedPrice || pos.lastOptionPrice || null;
        const currentValue = currentPrice ? currentPrice * 100 * pos.contracts : null;
        
        let unrealizedPnL = null;
        if (currentValue !== null) {
            unrealizedPnL = isDebit ? currentValue - premiumAmount : premiumAmount - currentValue;
        }
        
        return {
            ...pos,
            isDebit,
            premiumAmount,
            currentValue,
            unrealizedPnL
        };
    });
    
    if (loadingEl) loadingEl.style.display = 'none';
    
    // Render the portfolio components
    renderClosedPositions();
    updatePortfolioSummary(positionData);
    renderHoldings();
}

/**
 * Update portfolio summary stats
 */
function updatePortfolioSummary(positionData) {
    const openCount = positionData.length;
    
    // Net premium: credits add, debits subtract
    const netPremium = positionData.reduce((sum, p) => {
        return sum + (p.isDebit ? -p.premiumAmount : p.premiumAmount);
    }, 0);
    
    const capitalRisk = positionData.reduce((sum, p) => sum + (p.strike * 100 * p.contracts), 0);
    const unrealizedPnL = positionData.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
    
    // Filter closed positions by selected year
    const allClosed = state.closedPositions || [];
    const yearFilter = state.closedYearFilter || 'all';
    const filteredClosed = yearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === yearFilter;
        });
    
    // Realized P&L from filtered closed positions (support both field names)
    const realizedPnL = filteredClosed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const totalPnL = unrealizedPnL + realizedPnL;
    
    // Update display
    setEl('portOpenCount', openCount.toString());
    
    // Net premium with sign and color
    const premEl = document.getElementById('portTotalPremium');
    if (premEl) {
        premEl.textContent = (netPremium >= 0 ? '$' : '-$') + Math.abs(netPremium).toFixed(0);
        premEl.style.color = netPremium >= 0 ? '#00ff88' : '#ff5252';
    }
    
    setEl('portCapitalRisk', '$' + capitalRisk.toLocaleString());
    
    const unrealEl = document.getElementById('portUnrealizedPnL');
    if (unrealEl) {
        unrealEl.textContent = (unrealizedPnL >= 0 ? '+$' : '-$') + Math.abs(unrealizedPnL).toFixed(0);
        unrealEl.style.color = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    const realEl = document.getElementById('portRealizedPnL');
    if (realEl) {
        realEl.textContent = (realizedPnL >= 0 ? '+$' : '-$') + Math.abs(realizedPnL).toFixed(0);
        realEl.style.color = realizedPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    const totalEl = document.getElementById('portTotalPnL');
    if (totalEl) {
        totalEl.textContent = (totalPnL >= 0 ? '+$' : '-$') + Math.abs(totalPnL).toFixed(0);
        totalEl.style.color = totalPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    // Performance stats use the same filtered closed positions
    if (filteredClosed.length > 0) {
        // Helper to get P&L from either field name
        const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
        
        // Helper to get days held - calculate from dates if not stored
        const getDaysHeld = (p) => {
            if (p.daysHeld) return p.daysHeld;
            if (p.openDate && p.closeDate) {
                const open = new Date(p.openDate);
                const close = new Date(p.closeDate);
                if (!isNaN(open) && !isNaN(close)) {
                    return Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
                }
            }
            return 0;
        };
        
        const wins = filteredClosed.filter(p => getPnL(p) >= 0).length;
        const winRate = (wins / filteredClosed.length) * 100;
        const avgDays = filteredClosed.reduce((sum, p) => sum + getDaysHeld(p), 0) / filteredClosed.length;
        
        // Find best and worst trades
        const bestTrade = filteredClosed.reduce((best, p) => getPnL(p) > getPnL(best) ? p : best, filteredClosed[0]);
        const worstTrade = filteredClosed.reduce((worst, p) => getPnL(p) < getPnL(worst) ? p : worst, filteredClosed[0]);
        
        setEl('portWinRate', winRate.toFixed(0) + '%');
        setEl('portAvgDays', avgDays.toFixed(0) + 'd');
        
        // Best trade (always positive, green)
        const bestEl = document.getElementById('portBestTrade');
        if (bestEl) {
            const bestPnL = getPnL(bestTrade);
            bestEl.textContent = (bestPnL >= 0 ? '+$' : '-$') + Math.abs(bestPnL).toFixed(0);
            bestEl.style.color = '#00ff88';
            bestEl.style.cursor = 'pointer';
            bestEl.title = `Click to see details`;
            bestEl.onclick = () => showTradeDetails(bestTrade, 'Best Trade');
        }
        
        // Worst trade (may be negative, red)
        const worstEl = document.getElementById('portWorstTrade');
        if (worstEl) {
            const worstPnL = getPnL(worstTrade);
            worstEl.textContent = (worstPnL >= 0 ? '+$' : '-$') + Math.abs(worstPnL).toFixed(0);
            worstEl.style.color = worstPnL >= 0 ? '#ffaa00' : '#ff5252';
            worstEl.style.cursor = 'pointer';
            worstEl.title = `Click to see details`;
            worstEl.onclick = () => showTradeDetails(worstTrade, 'Worst Trade');
        }
    } else {
        // No closed positions for this filter - show defaults
        setEl('portWinRate', '—');
        setEl('portAvgDays', '—');
        setEl('portBestTrade', '—');
        setEl('portWorstTrade', '—');
    }
    
    // Update all dashboard components (analytics, win rate, P&L chart, calendar)
    refreshAllDashboards();
}

/**
 * Show trade details in a notification or alert
 */
function showTradeDetails(trade, label) {
    const pnl = trade.realizedPnL ?? trade.closePnL ?? 0;
    const pnlStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0);
    const msg = `${label}: ${trade.ticker} ${trade.type.replace('_', ' ')}\n` +
                `Strike: $${trade.strike.toFixed(2)}\n` +
                `Premium: $${trade.premium.toFixed(2)} × ${trade.contracts || 1}\n` +
                `Opened: ${trade.openDate || '?'} → Closed: ${trade.closeDate || '?'}\n` +
                `Days Held: ${trade.daysHeld || '?'}\n` +
                `P&L: ${pnlStr}`;
    
    // Show for 6 seconds since there's lots of info to read
    showNotification(msg.replace(/\n/g, ' | '), pnl >= 0 ? 'success' : 'warning', 6000);
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/**
 * Show the Close Position panel (no popups!)
 */
export function showClosePanel(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    state.closingPositionId = id;
    
    // Populate panel info
    const infoEl = document.getElementById('closeCurrentInfo');
    if (infoEl) {
        infoEl.innerHTML = `
            <strong style="color:#00ff88;">${pos.ticker}</strong> 
            ${pos.type.replace('_', ' ')} @ <strong>$${pos.strike.toFixed(2)}</strong>
            <br>Premium received: <strong>$${pos.premium.toFixed(2)}</strong> × ${pos.contracts} contract(s)
            <br>Opened: ${pos.openDate || 'Unknown'}
        `;
    }
    
    // Set defaults
    const closingPriceInput = document.getElementById('closeClosingPrice');
    if (closingPriceInput) {
        closingPriceInput.value = pos.markedPrice?.toFixed(2) || pos.lastOptionPrice?.toFixed(2) || '0.00';
    }
    
    const closeDateInput = document.getElementById('closeDate');
    if (closeDateInput) {
        closeDateInput.value = new Date().toISOString().split('T')[0];
    }
    
    // Update P&L preview
    updateClosePnLPreview();
    
    // Show panel
    const closePanel = document.getElementById('closePanel');
    if (closePanel) closePanel.style.display = 'block';
    
    // Hide roll panel if visible
    const rollPanel = document.getElementById('rollPanel');
    if (rollPanel) rollPanel.style.display = 'none';
    
    // Add live update listeners
    if (closingPriceInput) {
        closingPriceInput.oninput = updateClosePnLPreview;
    }
}
window.showClosePanel = showClosePanel;

/**
 * Update the P&L preview in the close panel
 */
function updateClosePnLPreview() {
    const pos = state.positions.find(p => p.id === state.closingPositionId);
    if (!pos) return;
    
    const closingPrice = parseFloat(document.getElementById('closeClosingPrice')?.value) || 0;
    const pnl = calculateRealizedPnL(pos, closingPrice);
    
    const pnlEl = document.getElementById('closePnLValue');
    if (pnlEl) {
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`;
        pnlEl.style.color = pnl >= 0 ? '#00ff88' : '#ff5252';
    }
}

/**
 * Execute the close from the panel
 */
export function executeClose() {
    const id = state.closingPositionId;
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const closingPrice = parseFloat(document.getElementById('closeClosingPrice')?.value);
    const closeDateValue = document.getElementById('closeDate')?.value;
    
    if (isNaN(closingPrice) || closingPrice < 0) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    
    if (!closeDateValue) {
        showNotification('Please enter a close date', 'error');
        return;
    }
    
    // Calculate realized P&L (handles both credit and debit positions)
    const realizedPnL = calculateRealizedPnL(pos, closingPrice);
    
    // Calculate days held
    const today = new Date().toISOString().split('T')[0];
    const openDate = new Date(pos.openDate || today);
    const closeDate = new Date(closeDateValue);
    const daysHeld = Math.max(0, Math.ceil((closeDate - openDate) / (1000 * 60 * 60 * 24)));
    
    // Add to closed positions
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...pos,
        closeDate: closeDateValue,
        daysHeld,
        closingPrice,
        realizedPnL
    });
    saveClosedPositions();
    
    // Remove from open positions
    state.positions = state.positions.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    showNotification(`Closed ${pos.ticker}: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)} P&L`, 
                     realizedPnL >= 0 ? 'success' : 'warning');
    
    // Hide panel and refresh
    cancelClose();
    renderPortfolio(false);
}
window.executeClose = executeClose;

/**
 * Cancel close and hide panel
 */
export function cancelClose() {
    state.closingPositionId = null;
    const closePanel = document.getElementById('closePanel');
    if (closePanel) closePanel.style.display = 'none';
}
window.cancelClose = cancelClose;

/**
 * Render closed positions history - grouped by TICKER with collapsible rows
 */
function renderClosedPositions() {
    const el = document.getElementById('closedPositionsTable');
    if (!el) return;
    
    const allClosed = state.closedPositions || [];
    
    // Update summary in collapsible header
    const summaryEl = document.getElementById('closedPositionsSummary');
    if (summaryEl) {
        const totalPnL = allClosed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
        const pnlColor = totalPnL >= 0 ? 'positive' : 'negative';
        summaryEl.innerHTML = `
            <span>${allClosed.length} trades</span>
            <span class="value ${pnlColor}">${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}</span>
        `;
    }
    
    if (allClosed.length === 0) {
        el.innerHTML = '<div style="color:#888;">No closed positions yet.</div>';
        return;
    }
    
    // Get available years from closed positions
    const years = [...new Set(allClosed.map(p => {
        const closeDate = p.closeDate || '';
        const match = closeDate.match(/^(\d{4})/);
        return match ? match[1] : null;
    }).filter(y => y))].sort().reverse();
    
    const currentYear = new Date().getFullYear().toString();
    const hasCurrentYearPositions = allClosed.some(p => (p.closeDate || '').startsWith(currentYear));
    
    if (!state.closedYearFilter) {
        state.closedYearFilter = hasCurrentYearPositions ? currentYear : 'all';
    }
    
    if (state.closedYearFilter !== 'all' && !years.includes(state.closedYearFilter)) {
        state.closedYearFilter = 'all';
    }
    
    const closed = state.closedYearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === state.closedYearFilter;
        });
    
    const ytdPnL = allClosed
        .filter(p => (p.closeDate || '').startsWith(currentYear))
        .reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    
    let filterHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <label style="color:#888; font-size:12px;">Tax Year:</label>
                <select id="closedYearFilter" style="padding:4px 8px; font-size:12px;">
                    <option value="all" ${state.closedYearFilter === 'all' ? 'selected' : ''}>All Years</option>
                    ${years.map(y => `<option value="${y}" ${state.closedYearFilter === y ? 'selected' : ''}>${y}</option>`).join('')}
                </select>
                <span style="color:#888; font-size:11px;">(${closed.length} trades)</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                <span style="color:#888; font-size:11px;">YTD ${currentYear}:</span>
                <span style="font-weight:bold; color:${ytdPnL >= 0 ? '#00ff88' : '#ff5252'};">
                    ${ytdPnL >= 0 ? '+' : ''}$${ytdPnL.toFixed(0)}
                </span>
                <button onclick="window.exportClosedForTax()" 
                        style="padding:4px 8px; font-size:11px; background:#2a2a4e; border:1px solid #444; color:#aaa; border-radius:4px; cursor:pointer;"
                        title="Export filtered trades as CSV for tax records">
                    📥 Export CSV
                </button>
            </div>
        </div>
    `;
    
    if (closed.length === 0) {
        el.innerHTML = filterHtml + `<div style="color:#888; padding:20px; text-align:center;">No closed positions in ${state.closedYearFilter}.</div>`;
        setTimeout(() => attachYearFilterListener(), 0);
        return;
    }
    
    // GROUP BY TICKER instead of chain
    const tickerGroups = {};
    closed.forEach(pos => {
        const ticker = pos.ticker || 'Unknown';
        if (!tickerGroups[ticker]) {
            tickerGroups[ticker] = {
                positions: [],
                totalPnL: 0,
                totalPremium: 0,
                tradeCount: 0
            };
        }
        tickerGroups[ticker].positions.push(pos);
        tickerGroups[ticker].totalPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
        tickerGroups[ticker].totalPremium += (pos.premium || 0) * 100 * (pos.contracts || 1);
        tickerGroups[ticker].tradeCount++;
    });
    
    // Sort tickers by total P&L (biggest winners first)
    const sortedTickers = Object.entries(tickerGroups)
        .sort((a, b) => b[1].totalPnL - a[1].totalPnL);
    
    // Get collapsed state from localStorage
    const collapsedTickers = JSON.parse(localStorage.getItem('wheelhouse_collapsed_tickers') || '{}');
    
    let html = filterHtml + `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
                <tr style="color:#888;">
                    <th style="padding:6px; text-align:left;">Ticker</th>
                    <th style="padding:6px; text-align:left;">Type</th>
                    <th style="padding:6px; text-align:right;">Strike</th>
                    <th style="padding:6px; text-align:right;">Premium</th>
                    <th style="padding:6px; text-align:center;">Closed</th>
                    <th style="padding:6px; text-align:right;">Held</th>
                    <th style="padding:6px; text-align:right;">P&L</th>
                    <th style="padding:6px; text-align:right;">ROC%</th>
                    <th style="padding:6px; text-align:center;">🔗</th>
                    <th style="padding:6px; text-align:center;">🗑️</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    for (const [ticker, group] of sortedTickers) {
        const pnlColor = group.totalPnL >= 0 ? '#00ff88' : '#ff5252';
        const isCollapsed = collapsedTickers[ticker] || false;
        const arrowClass = isCollapsed ? 'collapsed' : '';
        
        // Ticker group header row (clickable)
        html += `
            <tr class="ticker-group-header ${arrowClass}" data-ticker="${ticker}" onclick="window.toggleTickerGroup('${ticker}')">
                <td style="font-weight:bold; color:#8b5cf6;">
                    <span class="ticker-group-arrow">▼</span>
                    ${ticker}
                </td>
                <td style="color:#888;">${group.tradeCount} trade${group.tradeCount > 1 ? 's' : ''}</td>
                <td></td>
                <td style="text-align:right; color:#00ff88;">$${group.totalPremium.toFixed(0)}</td>
                <td></td>
                <td></td>
                <td style="text-align:right; font-weight:bold; color:${pnlColor}; font-size:13px;">
                    ${group.totalPnL >= 0 ? '+' : ''}$${group.totalPnL.toFixed(0)}
                </td>
                <td></td>
                <td></td>
                <td></td>
            </tr>
        `;
        
        // Individual trades (collapsible tbody)
        const tradesClass = isCollapsed ? 'collapsed' : '';
        html += `</tbody><tbody class="ticker-group-trades ${tradesClass}" data-ticker="${ticker}">`;
        
        // Group positions by chainId within this ticker
        const chains = {};
        group.positions.forEach(pos => {
            const chainKey = pos.chainId || pos.id;
            if (!chains[chainKey]) {
                chains[chainKey] = {
                    positions: [],
                    totalPnL: 0,
                    firstOpen: pos.openDate,
                    lastClose: pos.closeDate
                };
            }
            chains[chainKey].positions.push(pos);
            chains[chainKey].totalPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
            if (pos.openDate < chains[chainKey].firstOpen) chains[chainKey].firstOpen = pos.openDate;
            if (pos.closeDate > chains[chainKey].lastClose) chains[chainKey].lastClose = pos.closeDate;
        });
        
        // Sort chains by last close date (newest first)
        const sortedChains = Object.values(chains).sort((a, b) => 
            new Date(b.lastClose) - new Date(a.lastClose)
        );
        
        // Render each chain
        for (const chain of sortedChains) {
            const isMultiLeg = chain.positions.length > 1;
            
            // Sort positions within chain chronologically (oldest first)
            chain.positions.sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
            
            // Show chain header for multi-leg (rolled) positions
            if (isMultiLeg) {
                const chainPnlColor = chain.totalPnL >= 0 ? '#00ff88' : '#ff5252';
                html += `
                    <tr style="background:rgba(0,217,255,0.08); border-left:3px solid #00d9ff;">
                        <td colspan="6" style="padding:6px 6px 6px 20px; color:#00d9ff; font-size:11px;">
                            🔗 Rolled ${chain.positions.length}× 
                            <span style="color:#888;">(${chain.firstOpen} → ${chain.lastClose})</span>
                        </td>
                        <td style="padding:6px; text-align:right; font-weight:bold; color:${chainPnlColor}; font-size:12px;">
                            Σ ${chain.totalPnL >= 0 ? '+' : ''}$${chain.totalPnL.toFixed(0)}
                        </td>
                        <td colspan="3"></td>
                    </tr>
                `;
            }
            
            // Render each position in the chain
            chain.positions.forEach((pos, idx) => {
                const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
                const capitalAtRisk = pos.strike * 100 * (pos.contracts || 1);
                const roc = capitalAtRisk > 0 ? (pnl / capitalAtRisk) * 100 : 0;
                const rocColor = roc >= 0 ? '#00ff88' : '#ff5252';
                
                let daysHeld = pos.daysHeld;
                if (!daysHeld && pos.openDate && pos.closeDate) {
                    const open = new Date(pos.openDate);
                    const close = new Date(pos.closeDate);
                    daysHeld = Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
                }
                
                // Indent and style differently for chain members
                const indent = isMultiLeg ? 'padding-left:35px;' : 'padding-left:25px;';
                const legLabel = isMultiLeg ? `<span style="color:#00d9ff; font-size:9px; margin-right:4px;">L${idx+1}</span>` : '';
                const rowBorder = isMultiLeg && idx < chain.positions.length - 1 
                    ? 'border-bottom:1px dashed rgba(0,217,255,0.2);' 
                    : 'border-bottom:1px solid rgba(255,255,255,0.05);';
                
                html += `
                    <tr style="${rowBorder}">
                        <td style="padding:6px; ${indent} color:#888; font-size:11px;">${legLabel}${pos.closeDate?.substring(5) || '—'}</td>
                        <td style="padding:6px; color:#aaa;">${pos.type?.replace('_', ' ') || '—'}</td>
                        <td style="padding:6px; text-align:right;">$${pos.strike?.toFixed(2) || '—'}</td>
                        <td style="padding:6px; text-align:right;">
                            <span style="color:#00ff88;">$${((pos.premium || 0) * 100 * (pos.contracts || 1)).toFixed(0)}</span>
                            <span style="color:#666; font-size:10px;"> ×${pos.contracts || 1}</span>
                        </td>
                        <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.closeDate || '—'}</td>
                        <td style="padding:6px; text-align:right; color:#888;">${daysHeld ?? '—'}d</td>
                        <td style="padding:6px; text-align:right; font-weight:bold; color:${pnl >= 0 ? '#00ff88' : '#ff5252'};">
                            ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                        </td>
                        <td style="padding:6px; text-align:right; color:${rocColor};">
                            ${roc >= 0 ? '+' : ''}${roc.toFixed(1)}%
                        </td>
                        <td style="padding:6px; text-align:center;">
                            <button onclick="event.stopPropagation(); window.showLinkToChainModal(${pos.id})" 
                                    style="background:transparent; border:none; color:#6bf; cursor:pointer; font-size:11px;"
                                    title="${isMultiLeg ? 'Part of roll chain' : 'Link to chain'}">
                                ${isMultiLeg ? '🔗' : '🔗'}
                            </button>
                        </td>
                        <td style="padding:6px; text-align:center;">
                            <button onclick="event.stopPropagation(); window.deleteClosedPosition(${pos.id})" 
                                    style="background:transparent; border:none; color:#ff5252; cursor:pointer; font-size:11px;">
                                ✕
                            </button>
                        </td>
                    </tr>
                `;
            });
        }
        
        html += `</tbody><tbody>`;
    }
    
    html += `
            </tbody>
        </table>
    `;
    
    const grandTotal = closed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const totalColor = grandTotal >= 0 ? '#00ff88' : '#ff5252';
    const yearLabel = state.closedYearFilter === 'all' ? 'All Time' : state.closedYearFilter;
    html += `
        <div style="margin-top:12px; padding:10px; background:rgba(255,255,255,0.03); border-radius:6px; text-align:right;">
            <span style="color:#888;">${yearLabel} Realized P&L:</span>
            <span style="font-size:16px; font-weight:bold; color:${totalColor}; margin-left:10px;">
                ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(0)}
            </span>
            <span style="color:#888; margin-left:15px;">(${closed.length} trades across ${sortedTickers.length} tickers)</span>
        </div>
    `;
    
    el.innerHTML = html;
    setTimeout(() => attachYearFilterListener(), 0);
}

/**
 * Attach listener to year filter dropdown
 */
function attachYearFilterListener() {
    const filterEl = document.getElementById('closedYearFilter');
    if (filterEl) {
        filterEl.onchange = (e) => {
            state.closedYearFilter = e.target.value;
            renderClosedPositions();
            // Also update Portfolio Summary to reflect filtered stats
            renderPortfolio(false);
        };
    }
}

/**
 * Export closed positions as CSV for tax records
 */
export function exportClosedForTax() {
    const allClosed = state.closedPositions || [];
    const currentFilter = state.closedYearFilter || 'all';
    
    // Filter by selected year
    const toExport = currentFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => (p.closeDate || '').startsWith(currentFilter));
    
    if (toExport.length === 0) {
        showNotification('No trades to export', 'warning');
        return;
    }
    
    // Build CSV
    const headers = ['Ticker', 'Type', 'Strike', 'Premium', 'Contracts', 'Opened', 'Closed', 'Days Held', 'Realized P&L', 'Broker'];
    const rows = toExport.map(p => [
        p.ticker,
        p.type.replace('_', ' '),
        p.strike.toFixed(2),
        p.premium.toFixed(2),
        p.contracts || 1,
        p.openDate || '',
        p.closeDate || '',
        p.daysHeld || '',
        p.realizedPnL.toFixed(2),
        p.broker || ''
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wheelhouse_trades_${currentFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification(`Exported ${toExport.length} trades for ${currentFilter}`, 'success');
}
window.exportClosedForTax = exportClosedForTax;

/**
 * Mark current option price (manual entry from broker)
 */
export function markPrice(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    const currentVal = pos.markedPrice || pos.lastOptionPrice || '';
    const input = prompt(
        `Enter current option price for ${pos.ticker} $${pos.strike} ${pos.type}:\n\n` +
        `(Check your Schwab position for the current bid/ask)`,
        currentVal ? currentVal.toFixed(2) : ''
    );
    
    if (input === null) return; // Cancelled
    
    const price = parseFloat(input);
    if (isNaN(price) || price < 0) {
        showNotification('Invalid price entered', 'error');
        return;
    }
    
    // Save the marked price
    pos.markedPrice = price;
    pos.lastOptionPrice = price;
    pos.markedAt = new Date().toISOString();
    
    // Save to localStorage
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    showNotification(`Marked ${pos.ticker} at $${price.toFixed(2)}`, 'success');
    
    // Re-render without fetching (use cached prices)
    renderPortfolio(false);
}

// Expose to window for inline onclick
window.closePosition = closePosition;
window.markPrice = markPrice;

/**
 * Analyze position from Portfolio - loads data and switches to Options tab
 */
export function analyzeFromPortfolio(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    // Load position into analyzer (uses the existing function from positions.js)
    // This already handles tab switching to Analyze → Pricing
    if (window.loadPositionToAnalyze) {
        window.loadPositionToAnalyze(id);
    }
    
    // Switch to Analyze tab → Pricing sub-tab (fallback if loadPositionToAnalyze didn't do it)
    const analyzeTab = document.querySelector('[data-tab="analyze"]');
    const optionsTab = document.querySelector('[data-tab="options"]');
    if (analyzeTab) {
        analyzeTab.click();
        // Activate Pricing sub-tab
        if (window.switchSubTab) {
            window.switchSubTab('analyze', 'analyze-pricing');
        }
    } else if (optionsTab) {
        optionsTab.click();
    }
    
    // Trigger price fetch, then auto-run pricing analysis
    setTimeout(() => {
        const fetchBtn = document.getElementById('fetchTickerBtn');
        if (fetchBtn) {
            fetchBtn.click();
            
            // After fetch completes, automatically run pricing
            setTimeout(() => {
                const priceBtn = document.getElementById('priceBtn');
                if (priceBtn) {
                    priceBtn.click();
                }
            }, 800); // Wait for fetch to complete
        }
    }, 300);
    
    showNotification(`Analyzing ${pos.ticker} $${pos.strike} ${pos.type.replace('_', ' ')}...`, 'info');
}

window.analyzeFromPortfolio = analyzeFromPortfolio;

/**
 * Delete a closed position record
 */
export function deleteClosedPosition(id) {
    if (!confirm('Delete this closed position record?')) return;
    
    state.closedPositions = (state.closedPositions || []).filter(p => p.id !== id);
    saveClosedPositions();
    showNotification('Deleted closed position record', 'info');
    renderPortfolio(false);
}
window.deleteClosedPosition = deleteClosedPosition;

/**
 * Add a historical closed position manually
 */
export function addHistoricalClosedPosition() {
    // Simple prompt-based entry for now
    const ticker = prompt('Ticker symbol (e.g., TSLL):');
    if (!ticker) return;
    
    const type = prompt('Type (put or call):', 'put');
    if (!type || !['put', 'call'].includes(type.toLowerCase())) {
        showNotification('Type must be "put" or "call"', 'error');
        return;
    }
    
    const strike = parseFloat(prompt('Strike price:', '20'));
    if (isNaN(strike)) {
        showNotification('Invalid strike price', 'error');
        return;
    }
    
    const premium = parseFloat(prompt('Premium received per share:', '1.00'));
    if (isNaN(premium)) {
        showNotification('Invalid premium', 'error');
        return;
    }
    
    const contracts = parseInt(prompt('Number of contracts:', '1'));
    if (isNaN(contracts) || contracts < 1) {
        showNotification('Invalid contracts', 'error');
        return;
    }
    
    const openDate = prompt('Date opened (YYYY-MM-DD):', new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
    const closeDate = prompt('Date closed (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
    
    const closingPrice = parseFloat(prompt('Closing price paid (enter 0 if expired worthless):', '0'));
    if (isNaN(closingPrice)) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    
    // Create a position-like object to calculate P&L correctly
    const posLike = { type: type.toLowerCase(), premium, contracts };
    const realizedPnL = calculateRealizedPnL(posLike, closingPrice);
    
    // Calculate days held
    const open = new Date(openDate);
    const close = new Date(closeDate);
    const daysHeld = Math.ceil((close - open) / (1000 * 60 * 60 * 24));
    
    // Add to closed positions
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: ticker.toUpperCase(),
        type: type.toLowerCase(),
        strike,
        premium,
        contracts,
        openDate,
        closeDate,
        closingPrice,
        daysHeld,
        realizedPnL
    });
    saveClosedPositions();
    
    showNotification(`Added historical ${ticker} trade: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)}`, 
                     realizedPnL >= 0 ? 'success' : 'warning');
    renderPortfolio(false);
}
window.addHistoricalClosedPosition = addHistoricalClosedPosition;

/**
 * Render Holdings section - shares from assignments
 */
export function renderHoldings() {
    const section = document.getElementById('holdingsSection');
    const table = document.getElementById('holdingsTable');
    if (!section || !table) return;
    
    const allHoldings = state.holdings || [];
    
    // Get hidden tickers list
    const hiddenTickers = JSON.parse(localStorage.getItem('wheelhouse_hidden_tickers') || '[]');
    const showHidden = window._showHiddenHoldings || false;
    
    // Filter out hidden holdings unless showing all
    const holdings = showHidden 
        ? allHoldings 
        : allHoldings.filter(h => !hiddenTickers.includes(h.ticker));
    
    const hiddenCount = allHoldings.length - allHoldings.filter(h => !hiddenTickers.includes(h.ticker)).length;
    
    // Update collapsible header summary
    const summaryEl = document.getElementById('holdingsSummary');
    if (summaryEl) {
        const totalShares = holdings.reduce((sum, h) => sum + (h.shares || 100), 0);
        const totalValue = holdings.reduce((sum, h) => sum + ((h.shares || 100) * (h.costBasis || 0)), 0);
        summaryEl.innerHTML = holdings.length > 0 
            ? `<span>${holdings.length} holding${holdings.length !== 1 ? 's'  : ''} (${totalShares} shares)</span>
               <span class="value" style="color:#ff8c00;">~$${totalValue.toFixed(0)}</span>`
            : `<span style="color:#888;">No holdings</span>`;
    }
    
    if (holdings.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    
    // Build comprehensive holdings display - card-based layout for clarity
    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px; color:#666; margin-bottom:10px; padding:0 8px;">
            <span>Shares from Buy/Writes and Put Assignments</span>
            ${hiddenCount > 0 ? `
            <button onclick="window.toggleHiddenHoldings()" 
                    style="background:${showHidden ? 'rgba(255,170,0,0.2)' : 'rgba(100,100,100,0.2)'}; 
                           border:1px solid ${showHidden ? '#ffaa00' : '#555'}; 
                           color:${showHidden ? '#ffaa00' : '#888'}; 
                           padding:3px 8px; border-radius:4px; cursor:pointer; font-size:10px;">
                ${showHidden ? '👁️ Showing' : '👁️‍🗨️ Show'} ${hiddenCount} hidden
            </button>
            ` : ''}
        </div>
    `;
    
    // Store holding data for summary calculation after price fetch
    const holdingData = [];
    
    holdings.forEach(h => {
        const isBuyWrite = h.source === 'buy_write';
        const sourceLabel = isBuyWrite ? 'Buy/Write' : 'Assigned';
        const sourceColor = isBuyWrite ? '#00d9ff' : '#fa0';
        const isHidden = hiddenTickers.includes(h.ticker);
        
        // Get key values
        const costBasis = h.costBasis || 0;  // Per-share cost
        const shares = h.shares || 100;
        const totalCost = h.totalCost || (costBasis * shares);
        
        // Find the CURRENT open position in the chain (not the original which may be closed)
        let strike = h.strike;
        let premiumTotal = h.premiumCredit || 0;
        let currentOpenPosition = null;
        
        if (isBuyWrite && h.linkedPositionId) {
            // First try to find the original linked position to get the chainId
            const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
            const originalPos = allPositions.find(p => p.id === h.linkedPositionId);
            
            if (originalPos) {
                const chainId = originalPos.chainId || originalPos.id;
                
                // Find the CURRENT open position in this chain
                currentOpenPosition = state.positions.find(p => 
                    p.chainId === chainId || p.id === chainId
                );
                
                if (currentOpenPosition) {
                    // Use the CURRENT position's strike (after rolls)
                    strike = currentOpenPosition.strike;
                    
                    // Calculate total premium from entire chain (all premiums - all buybacks)
                    const chainPositions = allPositions.filter(p => 
                        p.chainId === chainId || p.id === chainId
                    );
                    let totalPremiumCollected = 0;
                    let totalBuybackCost = 0;
                    chainPositions.forEach(p => {
                        totalPremiumCollected += (p.premium || 0) * 100 * (p.contracts || 1);
                        if (p.closePrice && p.closeReason === 'rolled') {
                            totalBuybackCost += p.closePrice * 100 * (p.contracts || 1);
                        }
                    });
                    premiumTotal = totalPremiumCollected - totalBuybackCost;
                }
            }
        }
        
        // Calculate max profit if called away (always recalculate for chains)
        let maxProfit = 0;
        if (strike && costBasis) {
            const gainOnShares = Math.max(0, (strike - costBasis) * shares);
            maxProfit = gainOnShares + premiumTotal;
        }
        
        // Net cost basis (breakeven price)
        const netBasis = h.netCostBasis || (costBasis - (premiumTotal / shares));
        
        // Store for summary
        holdingData.push({
            id: h.id,
            ticker: h.ticker,
            shares,
            costBasis,
            totalCost,
            strike: strike || 0,
            premium: premiumTotal,
            netBasis,
            maxProfit,
            isBuyWrite,
            linkedPositionId: h.linkedPositionId
        });
        
        // Unique IDs for async updates
        const rowId = `holding-row-${h.id}`;
        const priceId = `hp-${h.id}`;
        const stockPnLId = `hspnl-${h.id}`;
        const totalReturnId = `htr-${h.id}`;
        const onTableId = `hot-${h.id}`;
        const actionId = `hact-${h.id}`;
        
        const strikeDisplay = strike ? `$${strike.toFixed(2)}` : '—';
        
        // Card-based layout - cleaner and more scannable
        // Hidden cards get muted styling
        html += `
            <div id="${rowId}" style="background:${isHidden ? '#151520' : '#1a1a2e'}; border-radius:8px; padding:12px; margin-bottom:8px; border:1px solid ${isHidden ? '#222' : '#333'}; ${isHidden ? 'opacity:0.6;' : ''}">
                <!-- Header Row: Ticker + Buttons -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:18px; font-weight:bold; color:${sourceColor};">${h.ticker}</span>
                        <span style="font-size:11px; color:#888; background:rgba(0,0,0,0.3); padding:2px 8px; border-radius:4px;">
                            ${sourceLabel} · ${shares} shares · Call @ ${strikeDisplay}
                        </span>
                        ${isHidden ? '<span style="font-size:10px; color:#ff9800; background:rgba(255,152,0,0.15); padding:2px 6px; border-radius:4px;">HIDDEN</span>' : ''}
                    </div>
                    <div style="display:flex; gap:6px;">
                        <!-- Hide/Unhide button -->
                        <button onclick="window.toggleHoldingVisibility('${h.ticker}')" 
                                style="background:rgba(100,100,100,0.2); border:1px solid #555; color:#888; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="${isHidden ? 'Show this ticker' : 'Hide this ticker'}">
                            ${isHidden ? '👁️ Show' : '👁️‍🗨️ Hide'}
                        </button>
                        ${isBuyWrite && h.linkedPositionId ? `
                        <button onclick="window.aiHoldingSuggestion(${h.id})" 
                                style="background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.4); color:#ffaa00; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="AI suggestions for this holding">
                            🤖 AI
                        </button>
                        ${h.savedStrategy ? `
                        <button onclick="window.holdingCheckup(${h.id})" 
                                style="background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.4); color:#00d9ff; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Compare to saved strategy (${h.savedStrategy.recommendation})">
                            🔄 Checkup
                        </button>
                        ` : ''}
                        <button onclick="window.analyzeHolding(${h.id})" 
                                style="background:rgba(139,92,246,0.2); border:1px solid rgba(139,92,246,0.4); color:#8b5cf6; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Analyze in P&L tab">
                            🔬
                        </button>
                        ` : ''}
                        <button onclick="window.sellShares(${h.id})" 
                                style="background:rgba(255,82,82,0.2); border:1px solid rgba(255,82,82,0.4); color:#f55; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Sell shares">
                            💰 Sell
                        </button>
                    </div>
                </div>
                
                <!-- Stats Grid - Caveman Clear Layout -->
                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; text-align:center;">
                    <!-- Row 1: The Stock -->
                    <!-- You Paid -->
                    <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px; cursor:pointer;" 
                         onclick="window.editHoldingCostBasis(${h.id})"
                         title="Click to edit. Your purchase price per share.">
                        <div style="font-size:9px; color:#888; margin-bottom:4px;">💰 YOU PAID ✏️</div>
                        <div id="hcb-${h.id}" style="font-size:16px; font-weight:bold; color:#ccc;">$${costBasis.toFixed(2)}</div>
                        <div style="font-size:10px; color:#666;">× ${shares} = $${(costBasis * shares).toFixed(0)}</div>
                    </div>
                    
                    <!-- Now Worth -->
                    <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                        <div style="font-size:9px; color:#888; margin-bottom:4px;">📈 NOW WORTH</div>
                        <div id="${priceId}" style="font-size:16px; font-weight:bold; color:#fff;">Loading...</div>
                        <div style="font-size:10px; color:#666;">current value</div>
                    </div>
                    
                    <!-- Stock Gain -->
                    <div style="background:rgba(0,0,0,0.2); padding:10px; border-radius:6px;">
                        <div style="font-size:9px; color:#888; margin-bottom:4px;">📊 STOCK GAIN</div>
                        <div id="${stockPnLId}" style="font-size:16px; font-weight:bold;">—</div>
                        <div style="font-size:10px; color:#666;">price change</div>
                    </div>
                </div>
                
                <!-- Row 2: The Option -->
                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; text-align:center; margin-top:8px;">
                    <!-- Premium Collected -->
                    <div style="background:rgba(0,255,136,0.08); padding:10px; border-radius:6px; border:1px solid rgba(0,255,136,0.2);">
                        <div style="font-size:9px; color:#00ff88; margin-bottom:4px;">✅ CALL PREMIUM</div>
                        <div style="font-size:16px; font-weight:bold; color:#00ff88;">+$${premiumTotal.toFixed(0)}</div>
                        <div style="font-size:10px; color:#666;">yours to keep</div>
                    </div>
                    
                    <!-- Max Profit (if called) -->
                    <div style="background:rgba(0,217,255,0.08); padding:10px; border-radius:6px; border:1px solid rgba(0,217,255,0.2);">
                        <div style="font-size:9px; color:#00d9ff; margin-bottom:4px;">🎯 MAX PROFIT</div>
                        <div style="font-size:16px; font-weight:bold; color:#00d9ff;">${maxProfit > 0 ? `+$${maxProfit.toFixed(0)}` : '—'}</div>
                        <div style="font-size:10px; color:#666;">${strike ? `if called @ $${strike}` : 'no call sold'}</div>
                    </div>
                    
                    <!-- Upside Capped / On Table -->
                    <div id="${onTableId}" style="background:rgba(255,152,0,0.08); padding:10px; border-radius:6px; border:1px solid rgba(255,152,0,0.2);">
                        <div style="font-size:9px; color:#ff9800; margin-bottom:4px;">⚠️ UPSIDE CAPPED</div>
                        <div style="font-size:16px; font-weight:bold; color:#ff9800;">—</div>
                        <div style="font-size:10px; color:#666;">gains you'd miss</div>
                    </div>
                </div>
                
                <!-- Total Return Bar -->
                <div id="${totalReturnId}" style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.3); border-radius:6px; text-align:center;">
                    <span style="color:#888; font-size:11px;">TOTAL RETURN: </span>
                    <span style="font-weight:bold; font-size:14px;">—</span>
                </div>
            </div>
        `;
    });
    
    // Summary section - will be updated after price fetch
    html += `
        <div id="holdingsSummary" style="margin-top:12px; padding:12px; background:rgba(255,140,0,0.1); border-radius:8px; border:1px solid rgba(255,140,0,0.3);">
            <div style="font-size:10px; color:#fa0; margin-bottom:8px; font-weight:bold;">📊 PORTFOLIO TOTALS</div>
            <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:12px; text-align:center;">
                <div>
                    <div style="color:#888; font-size:10px;">Capital Invested</div>
                    <div id="sumCapital" style="color:#fa0; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Current Value</div>
                    <div id="sumValue" style="color:#fff; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Stock P&L</div>
                    <div id="sumStockPnL" style="font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Premium Banked</div>
                    <div id="sumPremium" style="color:#00ff88; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Total Return</div>
                    <div id="sumTotalReturn" style="font-weight:bold; font-size:14px;">—</div>
                </div>
            </div>
        </div>
    `;
    
    table.innerHTML = html;
    
    // Store holding data globally for price fetch to use
    window._holdingData = holdingData;
    
    // Fetch current prices for all holdings async
    fetchHoldingPrices(holdingData);
}
window.renderHoldings = renderHoldings;

/**
 * Edit the cost basis for a holding
 */
window.editHoldingCostBasis = function(holdingId) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding) return;
    
    const currentBasis = holding.costBasis || 0;
    const newBasisStr = prompt(`Enter new cost basis for ${holding.ticker} (current: $${currentBasis.toFixed(2)}):`, currentBasis.toFixed(2));
    
    if (newBasisStr === null) return; // Cancelled
    
    const newBasis = parseFloat(newBasisStr);
    if (isNaN(newBasis) || newBasis < 0) {
        alert('Invalid cost basis. Please enter a positive number.');
        return;
    }
    
    // Update the holding
    holding.costBasis = newBasis;
    holding.totalCost = newBasis * (holding.shares || 100);
    
    // Recalculate net cost basis if we have premium
    if (holding.premiumCredit) {
        holding.netCostBasis = newBasis - (holding.premiumCredit / (holding.shares || 100));
    }
    
    // Save and re-render
    saveHoldingsToStorage();
    renderHoldings();
    
    showNotification(`Updated ${holding.ticker} cost basis to $${newBasis.toFixed(2)}`, 'success');
};

/**
 * Fetch current prices for holdings and calculate all metrics
 * This is where the magic happens - we show traders what they need to know
 * Now uses Schwab BATCH API (single request for all tickers!)
 */
async function fetchHoldingPrices(holdingData) {
    if (!holdingData || holdingData.length === 0) return;
    
    const tickers = [...new Set(holdingData.map(h => h.ticker))];
    
    // BATCH fetch all prices in ONE request!
    const priceMap = await fetchStockPricesBatch(tickers);
    console.log(`[HOLDINGS] Fetched ${Object.keys(priceMap).length} prices for holdings`);
    
    // Summary totals
    let sumCapital = 0;
    let sumCurrentValue = 0;
    let sumStockPnL = 0;
    let sumPremium = 0;
    let sumOnTable = 0;
    let hasPrices = false;  // Track if we got any valid prices
    
    // Update each holding row with calculated metrics
    for (const h of holdingData) {
        const currentPrice = priceMap[h.ticker] || 0;
        
        // Always add capital and premium to summary (we know these)
        sumCapital += h.totalCost;
        sumPremium += h.premium;
        
        // Only calculate current value metrics if we have a valid price
        if (currentPrice > 0) {
            hasPrices = true;
            const currentValue = currentPrice * h.shares;
            const stockPnL = currentValue - h.totalCost;
            const totalReturn = stockPnL + h.premium;
            const moneyOnTable = h.strike > 0 && currentPrice > h.strike 
                ? (currentPrice - h.strike) * h.shares 
                : 0;
            
            sumCurrentValue += currentValue;
            sumStockPnL += stockPnL;
            sumOnTable += moneyOnTable;
            
            // Update row with calculated values
            updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable);
        } else {
            // Price fetch failed - show error state
            showHoldingError(h);
        }
    }
    
    // Update summary row (only if we have prices)
    updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumOnTable, hasPrices);
}

/**
 * Update a single holding row with calculated values
 */
function updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable) {
    // Common calculations
    const stockPnLSign = stockPnL >= 0 ? '+' : '';
    const stockPnLColor = stockPnL >= 0 ? '#00ff88' : '#ff5252';
    
    // NOW WORTH column - show current value
    const priceEl = document.getElementById(`hp-${h.id}`);
    if (priceEl) {
        priceEl.textContent = `$${currentValue.toFixed(0)}`;
        priceEl.style.color = '#fff';
    }
    
    // STOCK GAIN column - show stock P&L
    const stockPnLEl = document.getElementById(`hspnl-${h.id}`);
    if (stockPnLEl) {
        stockPnLEl.innerHTML = `${stockPnLSign}$${stockPnL.toFixed(0)}`;
        stockPnLEl.style.color = stockPnLColor;
    }
    
    // TOTAL RETURN bar at bottom
    const totalReturnEl = document.getElementById(`htr-${h.id}`);
    if (totalReturnEl) {
        const trColor = totalReturn >= 0 ? '#00ff88' : '#ff5252';
        const trSign = totalReturn >= 0 ? '+' : '';
        const trPct = h.totalCost > 0 ? ((totalReturn / h.totalCost) * 100).toFixed(1) : 0;
        totalReturnEl.innerHTML = `
            <span style="color:#888; font-size:11px;">TOTAL RETURN: </span>
            <span style="font-weight:bold; font-size:14px; color:${trColor};">${trSign}$${totalReturn.toFixed(0)} (${trSign}${trPct}%)</span>
            <span style="color:#666; font-size:10px; margin-left:10px;">= Stock ${stockPnLSign}$${stockPnL.toFixed(0)} + Premium +$${h.premium.toFixed(0)}</span>
        `;
    }
    
    // UPSIDE CAPPED column
    const onTableEl = document.getElementById(`hot-${h.id}`);
    if (onTableEl) {
        if (moneyOnTable > 0) {
            // Stock is above strike - money being left on table
            // Calculate opportunity cost: roll up vs redeploy
            const capital = h.totalCost || (currentPrice * h.shares);
            const rollOutDte = 45; // Typical roll would be ~45 DTE out
            const opp = calculateOpportunityCost(moneyOnTable, capital, 0, rollOutDte);
            
            // Build recommendation text
            let recommendation, recColor;
            if (opp.betterChoice === 'redeploy') {
                recommendation = `💡 Let it ride! Redeploy wins by +$${opp.difference.toFixed(0)}`;
                recColor = '#00ff88';
            } else {
                recommendation = `📈 Roll UP worth +$${opp.difference.toFixed(0)} vs redeploy`;
                recColor = '#ff9800';
            }
            
            onTableEl.innerHTML = `
                <div style="font-size:9px; color:#ff9800; margin-bottom:4px;">⚠️ UPSIDE CAPPED</div>
                <div style="font-size:16px; font-weight:bold; color:#ff9800;">$${moneyOnTable.toFixed(0)}</div>
                <div style="font-size:10px; color:${recColor}; cursor:pointer; text-decoration:underline;" 
                     onclick="window.showOpportunityCostModal(${h.id}, ${moneyOnTable}, ${capital}, ${opp.monthlyYieldPct}, ${opp.expectedFromRedeploy})">
                    ${opp.betterChoice === 'redeploy' ? '✅ Redeploy wins' : '🔄 Roll UP?'} ▸
                </div>
            `;
            onTableEl.style.background = 'rgba(255,152,0,0.15)';
            onTableEl.style.borderColor = 'rgba(255,152,0,0.4)';
        } else if (h.strike > 0) {
            // Stock is below strike - show cushion
            const distToStrike = h.strike - currentPrice;
            const distPct = ((distToStrike / currentPrice) * 100).toFixed(1);
            if (distToStrike > 0) {
                onTableEl.innerHTML = `
                    <div style="font-size:9px; color:#00ff88; margin-bottom:4px;">✅ CUSHION</div>
                    <div style="font-size:16px; font-weight:bold; color:#00ff88;">${distPct}%</div>
                    <div style="font-size:10px; color:#666;">below strike</div>
                `;
                onTableEl.style.background = 'rgba(0,255,136,0.08)';
                onTableEl.style.borderColor = 'rgba(0,255,136,0.2)';
            } else {
                // At or above strike - ITM, will be called
                onTableEl.innerHTML = `
                    <div style="font-size:9px; color:#00d9ff; margin-bottom:4px;">📞 IN THE MONEY</div>
                    <div style="font-size:16px; font-weight:bold; color:#00d9ff;">ITM</div>
                    <div style="font-size:10px; color:#666;">likely called away</div>
                `;
                onTableEl.style.background = 'rgba(0,217,255,0.1)';
                onTableEl.style.borderColor = 'rgba(0,217,255,0.3)';
            }
        } else {
            // No strike (no call sold)
            onTableEl.innerHTML = `
                <div style="font-size:9px; color:#888; margin-bottom:4px;">UPSIDE CAPPED</div>
                <div style="font-size:16px; font-weight:bold; color:#888;">—</div>
                <div style="font-size:10px; color:#666;">no call sold</div>
            `;
        }
    }
}

/**
 * Show error state for a holding when price fetch fails
 */
function showHoldingError(h) {
    const priceEl = document.getElementById(`hp-${h.id}`);
    const stockPnLEl = document.getElementById(`hspnl-${h.id}`);
    const totalReturnEl = document.getElementById(`htr-${h.id}`);
    const onTableEl = document.getElementById(`hot-${h.id}`);
    
    if (priceEl) {
        priceEl.innerHTML = `<span style="color:#ff5252; font-size:12px;">⚠️ No price</span>`;
    }
    if (stockPnLEl) {
        stockPnLEl.innerHTML = '';
    }
    if (totalReturnEl) {
        totalReturnEl.innerHTML = `<div style="font-size:14px; color:#888;">—</div>`;
    }
    if (onTableEl) {
        onTableEl.innerHTML = `
            <div style="font-size:9px; color:#666; margin-bottom:2px;">CUSHION</div>
            <div style="font-size:14px; font-weight:bold; color:#888;">—</div>
        `;
    }
}

/**
 * Show opportunity cost analysis modal
 * Compares: Rolling UP to capture missed upside vs. Getting called and redeploying capital
 */
window.showOpportunityCostModal = function(holdingId, missedUpside, capital, monthlyYieldPct, expectedFromRedeploy) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding) return;
    
    const velocity = calculateCapitalVelocity();
    const rollOutDte = 45;
    const monthsToCapture = rollOutDte / 30;
    
    const betterChoice = expectedFromRedeploy > missedUpside ? 'redeploy' : 'roll';
    const difference = Math.abs(expectedFromRedeploy - missedUpside);
    
    // Calculate break-even: how much more upside needed for roll to win
    // missedUpside = (currentPrice - callStrike) * shares
    const shares = holding.sharesHeld || 100;
    const additionalUpsideNeeded = betterChoice === 'redeploy' ? difference : 0;
    const priceIncreaseNeeded = additionalUpsideNeeded / shares;
    
    const modal = document.createElement('div');
    modal.id = 'oppCostModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const redeployColor = betterChoice === 'redeploy' ? '#00ff88' : '#888';
    const rollColor = betterChoice === 'roll' ? '#ff9800' : '#888';
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #0d0d1a 0%, #16213e 100%); border:1px solid #00d9ff; 
                    border-radius:16px; padding:30px; width:90%; max-width:550px; max-height:90vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 217, 255, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:25px;">
                <span style="font-size:32px;">⚖️</span>
                <div>
                    <h2 style="margin:0; color:#fff; font-size:20px;">Roll vs. Redeploy Analysis</h2>
                    <div style="color:#888; font-size:13px;">${holding.ticker} • $${capital.toLocaleString()} capital at risk</div>
                </div>
            </div>
            
            <div style="text-align:center; margin-bottom:25px; padding:20px; background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:10px;">
                <div style="color:#ff9800; font-size:12px; margin-bottom:5px;">MISSED UPSIDE (above strike)</div>
                <div style="color:#ff9800; font-size:28px; font-weight:bold;">$${missedUpside.toFixed(0)}</div>
                <div style="color:#666; font-size:11px;">To capture this, you'd roll UP ~${rollOutDte} days</div>
            </div>
            
            ${betterChoice === 'redeploy' ? `
            <div style="text-align:center; margin-bottom:20px; padding:12px; background:rgba(0,217,255,0.1); border:1px solid rgba(0,217,255,0.3); border-radius:8px;">
                <div style="color:#00d9ff; font-size:12px;">
                    📊 <strong>Break-even:</strong> ${holding.ticker} needs to rise <strong>+$${priceIncreaseNeeded.toFixed(2)}</strong> more for roll to win
                </div>
                <div style="color:#666; font-size:10px; margin-top:4px;">
                    Roll needs $${expectedFromRedeploy.toFixed(0)} upside to match your ${monthlyYieldPct.toFixed(1)}%/mo velocity
                </div>
            </div>
            ` : `
            <div style="text-align:center; margin-bottom:20px; padding:12px; background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:8px;">
                <div style="color:#00ff88; font-size:12px;">
                    ✅ Roll already beats redeploy by <strong>+$${difference.toFixed(0)}</strong>
                </div>
            </div>
            `}
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:25px;">
                <!-- Option 1: Roll UP -->
                <div style="background:rgba(255,152,0,0.08); border:2px solid ${rollColor}; border-radius:10px; padding:20px; text-align:center;">
                    <div style="font-size:12px; color:${rollColor}; margin-bottom:10px; font-weight:bold;">🔄 ROLL UP</div>
                    <div style="font-size:24px; font-weight:bold; color:${rollColor};">+$${missedUpside.toFixed(0)}</div>
                    <div style="color:#888; font-size:11px; margin-top:8px;">
                        Tie up $${capital.toLocaleString()}<br>
                        for ~${rollOutDte} more days
                    </div>
                </div>
                
                <!-- Option 2: Let it ride, redeploy -->
                <div style="background:rgba(0,255,136,0.08); border:2px solid ${redeployColor}; border-radius:10px; padding:20px; text-align:center;">
                    <div style="font-size:12px; color:${redeployColor}; margin-bottom:10px; font-weight:bold;">✅ REDEPLOY</div>
                    <div style="font-size:24px; font-weight:bold; color:${redeployColor};">+$${expectedFromRedeploy.toFixed(0)}</div>
                    <div style="color:#888; font-size:11px; margin-top:8px;">
                        At your ${monthlyYieldPct.toFixed(1)}%/mo yield<br>
                        over ${monthsToCapture.toFixed(1)} months
                    </div>
                </div>
            </div>
            
            <!-- Verdict -->
            <div style="background:linear-gradient(135deg, ${betterChoice === 'redeploy' ? 'rgba(0,255,136,0.15)' : 'rgba(255,152,0,0.15)'} 0%, transparent 100%); 
                        border:1px solid ${betterChoice === 'redeploy' ? 'rgba(0,255,136,0.5)' : 'rgba(255,152,0,0.5)'}; 
                        border-radius:10px; padding:20px; text-align:center; margin-bottom:20px;">
                <div style="font-size:14px; font-weight:bold; color:${betterChoice === 'redeploy' ? '#00ff88' : '#ff9800'};">
                    ${betterChoice === 'redeploy' 
                        ? `💡 LET IT RIDE! Redeploying wins by +$${difference.toFixed(0)}`
                        : `📈 ROLL UP is worth +$${difference.toFixed(0)} more`
                    }
                </div>
                <div style="color:#888; font-size:12px; margin-top:8px;">
                    ${betterChoice === 'redeploy'
                        ? `Your capital velocity beats the capped upside. Take the win and redeploy!`
                        : `The missed upside is significant enough to justify tying up capital longer.`
                    }
                </div>
            </div>
            
            <!-- Yield info -->
            <div style="background:#1a1a2e; border-radius:8px; padding:12px; margin-bottom:20px;">
                <div style="color:#888; font-size:11px;">
                    📊 <strong>Your Expected Yield:</strong> ${monthlyYieldPct.toFixed(1)}% monthly
                    ${velocity.isDefault ? ' (default - need 3+ closed trades)' : ` (from ${velocity.tradeCount} trades)`}
                </div>
                <div style="color:#666; font-size:10px; margin-top:5px;">
                    ${velocity.method ? `Method: ${velocity.method}` : ''}
                    ${velocity.premiumBasedYield ? ` | Premium yield: ${velocity.premiumBasedYield.toFixed(1)}%` : ''}
                    ${velocity.pnlBasedYield !== undefined ? ` | Realized yield: ${velocity.pnlBasedYield.toFixed(1)}%` : ''}
                </div>
            </div>
            
            <div style="display:flex; justify-content:center;">
                <button onclick="document.getElementById('oppCostModal').remove()" 
                        style="background:#00d9ff; border:none; color:#000; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;">
                    Got it! 👍
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Update the holdings summary row
 */
function updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumOnTable, hasPrices) {
    const updateSum = (id, value, color) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = value;
            if (color) el.style.color = color;
        }
    };
    
    updateSum('sumCapital', `$${sumCapital.toFixed(0)}`, '#fa0');
    updateSum('sumPremium', `+$${sumPremium.toFixed(0)}`, '#00ff88');
    
    if (hasPrices) {
        const sumTotalReturn = sumStockPnL + sumPremium;
        const returnPct = sumCapital > 0 ? ((sumTotalReturn / sumCapital) * 100).toFixed(1) : 0;
        
        updateSum('sumValue', `$${sumCurrentValue.toFixed(0)}`, '#fff');
        updateSum('sumStockPnL', `${sumStockPnL >= 0 ? '+' : ''}$${sumStockPnL.toFixed(0)}`, sumStockPnL >= 0 ? '#00ff88' : '#ff5252');
        updateSum('sumTotalReturn', `${sumTotalReturn >= 0 ? '+' : ''}$${sumTotalReturn.toFixed(0)} (${returnPct}%)`, sumTotalReturn >= 0 ? '#00ff88' : '#ff5252');
        
        // Add "on table" warning if significant
        if (sumOnTable > 100) {
            const summaryEl = document.getElementById('holdingsSummary');
            if (summaryEl && !summaryEl.innerHTML.includes('On Table')) {
                const warningHtml = `
                    <div style="margin-top:10px; padding:8px; background:rgba(255,152,0,0.2); border:1px solid rgba(255,152,0,0.4); border-radius:4px;">
                        <span style="color:#ff9800; font-weight:bold;">⚠️ $${sumOnTable.toFixed(0)} On Table</span>
                        <span style="color:#888; margin-left:10px; font-size:11px;">Consider rolling up to capture more upside</span>
                    </div>
                `;
                summaryEl.insertAdjacentHTML('beforeend', warningHtml);
            }
        }
    } else {
        // No prices available
        updateSum('sumValue', '⚠️ No prices', '#ff5252');
        updateSum('sumStockPnL', '—', '#888');
        updateSum('sumTotalReturn', '—', '#888');
    }
}

/**
 * Get AI suggestions for a holding (roll up, sell, hold, etc.)
 */
window.aiHoldingSuggestion = async function(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) return;
    
    // Find linked position - first try the stored linkedPositionId
    let position = holding.linkedPositionId 
        ? state.positions.find(p => p.id === holding.linkedPositionId)
        : null;
    
    // If not found (position may have been rolled/closed), find the current OPEN position for this ticker
    if (!position) {
        // Look for any open covered_call or buy_write for this ticker
        position = state.positions.find(p => 
            p.ticker === holding.ticker && 
            (p.type === 'covered_call' || p.type === 'buy_write') &&
            p.status !== 'closed'
        );
        
        // If found, update the holding's link
        if (position && holding.linkedPositionId !== position.id) {
            console.log(`[AI] Auto-linking ${holding.ticker} holding to position ${position.id}`);
            holding.linkedPositionId = position.id;
            localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
        }
    }
    
    const shares = holding.shares || 100;
    const strike = position?.strike || holding.strike || 0;
    const premium = holding.premiumCredit || (position?.premium * 100) || 0;
    const costBasis = holding.stockPrice || holding.costBasis || 0;
    const dte = position?.expiry ? Math.max(0, Math.round((new Date(position.expiry) - new Date()) / 86400000)) : 0;
    const expiry = position?.expiry || 'unknown';
    
    // Show loading modal immediately
    const modal = document.createElement('div');
    modal.id = 'aiHoldingModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10001;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #ffaa00;border-radius:12px;padding:24px;max-width:650px;width:90%;max-height:85vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            <div style="text-align:center;padding:40px;color:#888;">
                <div style="font-size:24px;margin-bottom:10px;">🔄</div>
                <div>Fetching current price...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Fetch current stock price
    let currentPrice = 0;
    try {
        const quoteRes = await fetch(`/api/schwab/quote/${holding.ticker}`);
        if (quoteRes.ok) {
            const quoteData = await quoteRes.json();
            currentPrice = quoteData.lastPrice || quoteData.price || quoteData.regularMarketLastPrice || 0;
        }
    } catch (e) {
        console.warn('Failed to fetch Schwab quote, trying Yahoo');
    }
    
    // Try Yahoo Finance (different endpoint format)
    if (!currentPrice) {
        try {
            const yahooRes = await fetch(`/api/yahoo/${holding.ticker}`);
            if (yahooRes.ok) {
                const yahooData = await yahooRes.json();
                // Yahoo returns nested structure
                currentPrice = yahooData.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
            }
        } catch (e) {
            console.warn('Failed to fetch Yahoo quote');
        }
    }
    
    // Try CBOE as last resort (the same endpoint used for options)
    if (!currentPrice) {
        try {
            const cboeRes = await fetch(`/api/cboe/quote/${holding.ticker}`);
            if (cboeRes.ok) {
                const cboeData = await cboeRes.json();
                currentPrice = cboeData.currentPrice || cboeData.underlyingPrice || cboeData.data?.underlying_price || 0;
            }
        } catch (e) {
            console.warn('Failed to fetch CBOE quote');
        }
    }
    
    if (!currentPrice) {
        document.querySelector('#aiHoldingModal > div').innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ff5252;">❌ Price Error</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            <p style="color:#888;">Could not fetch current price for ${holding.ticker}.</p>
            <p style="color:#666;font-size:11px;">Check your Schwab connection or try again.</p>
        `;
        return;
    }
    
    // Update modal to show analyzing
    document.querySelector('#aiHoldingModal > div > div:last-child').innerHTML = `
        <div style="font-size:24px;margin-bottom:10px;">🤔</div>
        <div>Analyzing position...</div>
    `;
    
    // Calculate metrics with real per-share price
    const stockValue = currentPrice * shares;
    const stockGainLoss = costBasis > 0 ? (currentPrice - costBasis) * shares : 0;
    const onTable = strike && currentPrice > strike ? (currentPrice - strike) * shares : 0;
    const cushion = strike && currentPrice < strike ? (strike - currentPrice) * shares : 0;
    const ifCalled = strike ? (strike - costBasis) * shares + premium : 0;
    const breakeven = costBasis - (premium / shares);
    
    // Determine situation
    const isITM = currentPrice > strike;
    const isOTM = currentPrice < strike;
    const isDeep = isITM ? (currentPrice - strike) / strike > 0.05 : (strike - currentPrice) / strike > 0.1;
    
    // Build detailed prompt
    const prompt = `You are a wheel strategy options expert. Analyze this covered call position and give SPECIFIC, ACTIONABLE advice.

=== POSITION DETAILS ===
Ticker: ${holding.ticker}
Shares: ${shares} @ $${costBasis.toFixed(2)} cost basis (Total: $${(costBasis * shares).toFixed(0)})
Current stock price: $${currentPrice.toFixed(2)}
Covered call: $${strike.toFixed(2)} strike, expires ${expiry} (${dte} DTE)
Premium collected: $${premium.toFixed(0)} total ($${(premium/shares).toFixed(2)}/share)
Breakeven: $${breakeven.toFixed(2)}

=== CURRENT STATUS ===
Stock P&L: ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss.toFixed(0)} (${((stockGainLoss / (costBasis * shares)) * 100).toFixed(1)}%)
Option status: ${isITM ? 'IN THE MONEY (ITM)' : 'OUT OF THE MONEY (OTM)'}
${isITM ? `Money on table (above strike): $${onTable.toFixed(0)}` : `Cushion to strike: $${cushion.toFixed(0)} (${((strike - currentPrice) / currentPrice * 100).toFixed(1)}%)`}
If called at expiry: +$${ifCalled.toFixed(0)} total profit

=== YOUR TASK ===
Provide a COMPLETE analysis with these sections:

**SITUATION SUMMARY**
Explain what's happening with this position in 2-3 sentences. Is the covered call working as intended? What's the risk?

**RECOMMENDATION** 
Choose ONE: HOLD / ROLL UP / ROLL OUT / ROLL UP & OUT / LET IT GET CALLED / BUY BACK THE CALL
Explain WHY this is the best action right now.

**SPECIFIC ACTION**
If holding: Explain what price levels would change your recommendation.
If rolling: Suggest specific new strike (e.g., "$31 or $32") and timeframe (e.g., "30-45 DTE").
If letting call: Explain what to expect at expiration.

**KEY RISK**
One important risk or thing to watch.

Be specific with dollar amounts and percentages. Don't be vague.`;

    // Store context for retry with different model
    window._aiHoldingContext = {
        holding, position, currentPrice, strike, premium, costBasis, dte, expiry,
        shares, stockValue, stockGainLoss, onTable, cushion, ifCalled, breakeven,
        isITM, isOTM, isDeep, prompt
    };
    
    // Run analysis with Grok by default (better quality)
    await runHoldingAnalysis('grok');
};

/**
 * Run the holding analysis with specified model (called by toggle)
 */
async function runHoldingAnalysis(modelType) {
    const ctx = window._aiHoldingContext;
    if (!ctx) return;
    
    const { holding, position, currentPrice, strike, premium, costBasis, dte, 
            stockGainLoss, onTable, cushion, ifCalled, isITM, prompt, shares } = ctx;
    
    // Update modal to show loading
    const contentDiv = document.querySelector('#aiHoldingModal > div');
    if (!contentDiv) return;
    
    contentDiv.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
            <button onclick="this.closest('#aiHoldingModal').remove()" 
                style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
        </div>
        
        <!-- Model toggle -->
        <div style="display:flex;gap:8px;margin-bottom:16px;">
            <button id="btnOllama" onclick="runHoldingAnalysis('ollama')" 
                style="flex:1;padding:8px;border:1px solid ${modelType === 'ollama' ? '#00ff88' : '#444'};
                       background:${modelType === 'ollama' ? 'rgba(0,255,136,0.15)' : '#252540'};
                       color:${modelType === 'ollama' ? '#00ff88' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                🦙 Ollama (32B) - Free
            </button>
            <button id="btnGrok" onclick="runHoldingAnalysis('grok')" 
                style="flex:1;padding:8px;border:1px solid ${modelType === 'grok' ? '#1da1f2' : '#444'};
                       background:${modelType === 'grok' ? 'rgba(29,161,242,0.15)' : '#252540'};
                       color:${modelType === 'grok' ? '#1da1f2' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                🔥 Grok - ~$0.02
            </button>
        </div>
        
        <div style="text-align:center;padding:40px;color:#888;">
            <div style="font-size:24px;margin-bottom:10px;">🔄</div>
            <div>Analyzing with ${modelType === 'grok' ? 'Grok' : 'Ollama 32B'}...</div>
        </div>
    `;
    
    try {
        let response, result, analysis;
        
        if (modelType === 'grok') {
            response = await fetch('/api/ai/grok', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, maxTokens: 800 })
            });
        } else {
            response = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker: holding.ticker,
                    customPrompt: prompt,
                    model: 'qwen2.5:32b'
                })
            });
        }
        
        if (!response.ok) throw new Error('AI analysis failed');
        
        result = await response.json();
        analysis = result.insight || result.analysis || 'No analysis returned';
        
        // Store the raw analysis for saving
        window._aiHoldingContext.lastAnalysis = analysis;
        window._aiHoldingContext.lastModel = modelType;
        window._aiHoldingContext.lastAnalyzedAt = new Date().toISOString();
        
        // Better formatting for section headers
        const formatted = analysis
            // Bold text
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#ffaa00;">$1</strong>')
            // Section headers like "**SITUATION SUMMARY**" or "SITUATION SUMMARY"
            .replace(/^[\*]*\s*(SITUATION SUMMARY|RECOMMENDATION|SPECIFIC ACTION|KEY RISK)[:\*]*/gim, 
                '<div style="color:#00d9ff;font-weight:bold;font-size:14px;margin-top:16px;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;">$1</div>')
            // Numbered headers like "1. SITUATION"
            .replace(/^(\d+)\.\s*(SITUATION|RECOMMENDATION|SPECIFIC|KEY|RISK)/gim,
                '<div style="color:#00d9ff;font-weight:bold;font-size:14px;margin-top:16px;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;">$2</div>')
            // Line breaks
            .replace(/\n/g, '<br>');
        
        const modelBadge = modelType === 'grok' 
            ? '<span style="background:rgba(29,161,242,0.2);color:#1da1f2;padding:2px 8px;border-radius:4px;font-size:10px;margin-left:8px;">🔥 Grok</span>'
            : '<span style="background:rgba(0,255,136,0.2);color:#00ff88;padding:2px 8px;border-radius:4px;font-size:10px;margin-left:8px;">🦙 Ollama</span>';
        
        contentDiv.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker} ${modelBadge}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <!-- Model toggle -->
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <button onclick="runHoldingAnalysis('ollama')" 
                    style="flex:1;padding:8px;border:1px solid ${modelType === 'ollama' ? '#00ff88' : '#444'};
                           background:${modelType === 'ollama' ? 'rgba(0,255,136,0.15)' : '#252540'};
                           color:${modelType === 'ollama' ? '#00ff88' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                    🦙 Ollama (32B) - Free
                </button>
                <button onclick="runHoldingAnalysis('grok')" 
                    style="flex:1;padding:8px;border:1px solid ${modelType === 'grok' ? '#1da1f2' : '#444'};
                           background:${modelType === 'grok' ? 'rgba(29,161,242,0.15)' : '#252540'};
                           color:${modelType === 'grok' ? '#1da1f2' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                    🔥 Grok - ~$0.02
                </button>
            </div>
            
            <!-- Position snapshot -->
            <div style="background:#252540;padding:12px;border-radius:8px;margin-bottom:16px;">
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12px;margin-bottom:10px;">
                    <div><span style="color:#666;">Stock:</span> <span style="color:#fff;">$${currentPrice.toFixed(2)}</span></div>
                    <div><span style="color:#666;">Strike:</span> <span style="color:#fff;">$${strike.toFixed(2)}</span></div>
                    <div><span style="color:#666;">Cost:</span> <span style="color:#fff;">$${costBasis.toFixed(2)}</span></div>
                    <div><span style="color:#666;">DTE:</span> <span style="color:#fff;">${dte} days</span></div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center;padding-top:10px;border-top:1px solid #333;">
                    <div>
                        <div style="font-size:9px;color:#666;">STOCK P&L</div>
                        <div style="font-weight:bold;color:${stockGainLoss >= 0 ? '#00ff88' : '#ff5252'};">
                            ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss.toFixed(0)}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">PREMIUM</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${premium.toFixed(0)}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">${isITM ? 'ON TABLE' : 'CUSHION'}</div>
                        <div style="font-weight:bold;color:${isITM ? '#ffaa00' : '#00d9ff'};">
                            ${isITM ? '$' + onTable.toFixed(0) : '$' + cushion.toFixed(0)}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">IF CALLED</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${ifCalled.toFixed(0)}</div>
                    </div>
                </div>
            </div>
            
            <!-- Status badge -->
            <div style="margin-bottom:12px;">
                <span style="background:${isITM ? 'rgba(255,152,0,0.2)' : 'rgba(0,217,255,0.2)'}; 
                       color:${isITM ? '#ff9800' : '#00d9ff'}; 
                       padding:4px 12px; border-radius:12px; font-size:11px; font-weight:bold;">
                    ${isITM ? '⚠️ IN THE MONEY' : '✅ OUT OF THE MONEY'}
                </span>
            </div>
            
            <!-- AI Analysis -->
            <div style="line-height:1.7;font-size:13px;">
                ${formatted}
            </div>
            
            <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="window.saveHoldingStrategy(${holding.id})" 
                    style="padding:10px 16px;background:rgba(0,217,255,0.2);border:1px solid #00d9ff;border-radius:6px;color:#00d9ff;font-weight:bold;cursor:pointer;">
                    💾 Save Strategy
                </button>
                ${position ? `
                <button onclick="window.rollPosition(${position.id});this.closest('#aiHoldingModal').remove();" 
                    style="padding:10px 16px;background:#ce93d8;border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">
                    🔄 Roll This Call
                </button>
                ` : ''}
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="padding:10px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
    } catch (e) {
        console.error('AI Holding suggestion error:', e);
        contentDiv.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ff5252;">❌ AI Error</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <!-- Model toggle for retry -->
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <button onclick="runHoldingAnalysis('ollama')" 
                    style="flex:1;padding:8px;border:1px solid #444;background:#252540;color:#888;border-radius:6px;cursor:pointer;font-size:11px;">
                    🦙 Retry with Ollama
                </button>
                <button onclick="runHoldingAnalysis('grok')" 
                    style="flex:1;padding:8px;border:1px solid #444;background:#252540;color:#888;border-radius:6px;cursor:pointer;font-size:11px;">
                    🔥 Retry with Grok
                </button>
            </div>
            
            <p style="color:#888;">Failed to get AI analysis: ${e.message}</p>
            <p style="color:#666;font-size:11px;">${modelType === 'grok' ? 'Check your Grok API key in Settings.' : 'Make sure Ollama is running with qwen2.5:32b loaded.'}</p>
        `;
    }
}
window.runHoldingAnalysis = runHoldingAnalysis;

/**
 * Save the current AI strategy to the holding for future reference
 */
window.saveHoldingStrategy = function(holdingId) {
    const ctx = window._aiHoldingContext;
    if (!ctx || !ctx.lastAnalysis) {
        showNotification('No analysis to save', 'warning');
        return;
    }
    
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    // Extract key data from the analysis
    // Try to find recommendation, price triggers, etc.
    const analysis = ctx.lastAnalysis;
    let recommendation = 'HOLD';
    
    // Parse recommendation from analysis text
    if (analysis.match(/LET IT (GET )?CALLED/i)) recommendation = 'LET CALL';
    else if (analysis.match(/ROLL UP/i)) recommendation = 'ROLL UP';
    else if (analysis.match(/ROLL OUT/i)) recommendation = 'ROLL OUT';
    else if (analysis.match(/ROLL UP.*OUT|ROLL OUT.*UP/i)) recommendation = 'ROLL UP & OUT';
    else if (analysis.match(/BUY BACK/i)) recommendation = 'BUY BACK';
    else if (analysis.match(/HOLD/i)) recommendation = 'HOLD';
    
    // Store the strategy on the holding
    holding.savedStrategy = {
        savedAt: ctx.lastAnalyzedAt || new Date().toISOString(),
        model: ctx.lastModel,
        recommendation,
        fullAnalysis: analysis,
        snapshot: {
            stockPrice: ctx.currentPrice,
            strike: ctx.strike,
            costBasis: ctx.costBasis,
            dte: ctx.dte,
            premium: ctx.premium,
            stockPnL: ctx.stockGainLoss,
            ifCalled: ctx.ifCalled,
            isITM: ctx.isITM
        }
    };
    
    saveHoldingsToStorage();
    
    showNotification(`✅ Strategy saved for ${holding.ticker}: ${recommendation}`, 'success');
    
    // Update the button to show saved state
    const modal = document.getElementById('aiHoldingModal');
    if (modal) {
        const saveBtn = modal.querySelector('button[onclick*="saveHoldingStrategy"]');
        if (saveBtn) {
            saveBtn.innerHTML = '✅ Saved';
            saveBtn.style.background = 'rgba(0,255,136,0.2)';
            saveBtn.style.borderColor = '#00ff88';
            saveBtn.style.color = '#00ff88';
            saveBtn.disabled = true;
        }
    }
};

/**
 * Get saved strategy for a holding
 */
window.getHoldingStrategy = function(holdingId) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    return holding?.savedStrategy || null;
};

/**
 * Toggle visibility of a specific ticker (hide/unhide)
 */
window.toggleHoldingVisibility = function(ticker) {
    const hiddenTickers = JSON.parse(localStorage.getItem('wheelhouse_hidden_tickers') || '[]');
    
    const idx = hiddenTickers.indexOf(ticker);
    if (idx >= 0) {
        // Currently hidden, unhide it
        hiddenTickers.splice(idx, 1);
        showNotification(`${ticker} is now visible`, 'success');
    } else {
        // Currently visible, hide it
        hiddenTickers.push(ticker);
        showNotification(`${ticker} hidden - click "Show hidden" to see it`, 'info');
    }
    
    localStorage.setItem('wheelhouse_hidden_tickers', JSON.stringify(hiddenTickers));
    renderHoldings();
};

/**
 * Toggle showing all hidden holdings
 */
window.toggleHiddenHoldings = function() {
    window._showHiddenHoldings = !window._showHiddenHoldings;
    renderHoldings();
};

/**
 * Update holding strategy from checkup (when recommendation changes)
 */
window.updateHoldingStrategy = function(holdingId, newRecommendation, newAnalysis) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding || !holding.savedStrategy) {
        showNotification('Holding or strategy not found', 'error');
        return;
    }
    
    const oldRec = holding.savedStrategy.recommendation;
    
    // Update the strategy
    holding.savedStrategy.recommendation = newRecommendation;
    holding.savedStrategy.fullAnalysis = newAnalysis;
    holding.savedStrategy.savedAt = new Date().toISOString();
    holding.savedStrategy.model = 'grok';  // Checkups use Grok
    
    saveHoldingsToStorage();
    
    showNotification(`✅ Strategy updated: ${oldRec} → ${newRecommendation}`, 'success');
    
    // Close the modal and refresh displays
    const modal = document.getElementById('aiHoldingModal');
    if (modal) modal.remove();
    
    // Re-render to update risk indicators
    renderHoldings();
    if (window.renderPositions) window.renderPositions();
};

/**
 * Get list of hidden tickers
 */
window.getHiddenTickers = function() {
    return JSON.parse(localStorage.getItem('wheelhouse_hidden_tickers') || '[]');
};

/**
 * Run a checkup on a holding - compares current conditions to saved strategy
 */
window.holdingCheckup = async function(holdingId) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    const strategy = holding.savedStrategy;
    if (!strategy) {
        showNotification('No saved strategy to compare. Run AI suggestion first and save it.', 'warning');
        return;
    }
    
    // Find linked position for current strike/expiry
    let position = state.positions.find(p => p.id === holding.linkedPositionId);
    if (!position) {
        const openPositions = state.positions.filter(p => 
            p.ticker === holding.ticker && 
            p.status !== 'closed' && 
            (p.type === 'covered_call' || p.type === 'buy_write')
        );
        position = openPositions[0];
    }
    
    if (!position) {
        showNotification('No linked position found', 'warning');
        return;
    }
    
    // Fetch current price
    let currentPrice = 0;
    try {
        const resp = await fetch(`/api/schwab/quote/${holding.ticker}`);
        if (resp.ok) {
            const data = await resp.json();
            currentPrice = data.lastPrice || data.mark || data.last || 0;
        }
    } catch (e) {
        console.error('Price fetch failed:', e);
    }
    
    if (!currentPrice) {
        try {
            const resp = await fetch(`/api/yahoo/${holding.ticker}`);
            if (resp.ok) {
                const data = await resp.json();
                currentPrice = data.quotes?.[holding.ticker]?.price || data.price || 0;
            }
        } catch (e) { /* ignore */ }
    }
    
    const strike = position.strike || holding.strike || 0;
    const costBasis = holding.costBasis || 0;
    const shares = holding.shares || 100;
    const premium = (position.premium || 0) * 100 * (position.contracts || 1);
    const dte = position.expiry ? Math.ceil((new Date(position.expiry) - new Date()) / (1000 * 60 * 60 * 24)) : 0;
    const isITM = currentPrice > strike;
    const stockGainLoss = (currentPrice - costBasis) * shares;
    const ifCalled = ((strike - costBasis) * shares) + premium;
    
    // Build comparison prompt
    const prompt = `You previously analyzed this covered call position. Compare current conditions to your original recommendation.

ORIGINAL ANALYSIS (from ${new Date(strategy.savedAt).toLocaleDateString()}):
- Stock was: $${strategy.snapshot.stockPrice.toFixed(2)}
- Recommendation: ${strategy.recommendation}
- DTE was: ${strategy.snapshot.dte} days
- Was ITM: ${strategy.snapshot.isITM ? 'Yes' : 'No'}

CURRENT CONDITIONS:
- Ticker: ${holding.ticker}
- Stock NOW: $${currentPrice.toFixed(2)} (was $${strategy.snapshot.stockPrice.toFixed(2)}, change: ${((currentPrice - strategy.snapshot.stockPrice) / strategy.snapshot.stockPrice * 100).toFixed(1)}%)
- Strike: $${strike.toFixed(2)}
- Cost Basis: $${costBasis.toFixed(2)}
- DTE NOW: ${dte} days (was ${strategy.snapshot.dte})
- Currently ITM: ${isITM ? 'Yes' : 'No'}
- Stock P&L: $${stockGainLoss.toFixed(0)}
- Premium: $${premium.toFixed(0)}
- If Called Profit: $${ifCalled.toFixed(0)}

ORIGINAL FULL ANALYSIS:
${strategy.fullAnalysis.substring(0, 1500)}

Based on how conditions have changed, should the trader:
1. STICK WITH the original plan (${strategy.recommendation})?
2. ADJUST the strategy? If so, what new action?

Be concise. Focus on what changed and whether it matters.
End your response with one of these exact phrases:
- "VERDICT: STICK WITH ${strategy.recommendation}"
- "VERDICT: CHANGE TO ROLL"
- "VERDICT: CHANGE TO HOLD"
- "VERDICT: CHANGE TO LET CALL"
- "VERDICT: CHANGE TO BUY BACK"`;

    // Show modal with loading
    let modal = document.getElementById('aiHoldingModal');
    if (modal) modal.remove();
    
    modal = document.createElement('div');
    modal.id = 'aiHoldingModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border-radius:12px;padding:24px;max-width:700px;max-height:80vh;overflow-y:auto;border:1px solid #333;width:90%;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#00d9ff;">🔄 Strategy Checkup: ${holding.ticker}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            <div style="text-align:center;padding:40px;color:#888;">
                <div style="font-size:24px;margin-bottom:10px;">🔄</div>
                <div>Comparing current conditions to saved strategy...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const response = await fetch('/api/ai/grok', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, maxTokens: 600 })
        });
        
        if (!response.ok) throw new Error('Checkup failed');
        
        const result = await response.json();
        const checkupAnalysis = result.insight || 'No checkup returned';
        
        // Parse the verdict from the response
        let newRecommendation = null;
        let recommendationChanged = false;
        
        const verdictMatch = checkupAnalysis.match(/VERDICT:\s*(STICK WITH|CHANGE TO)\s*(\w+(?:\s+\w+)?)/i);
        if (verdictMatch) {
            if (verdictMatch[1].toUpperCase() === 'STICK WITH') {
                newRecommendation = strategy.recommendation;
            } else {
                // Parse the new recommendation
                const newRec = verdictMatch[2].toUpperCase().trim();
                if (newRec.includes('ROLL')) newRecommendation = 'ROLL';
                else if (newRec.includes('HOLD')) newRecommendation = 'HOLD';
                else if (newRec.includes('LET') || newRec.includes('CALL')) newRecommendation = 'LET CALL';
                else if (newRec.includes('BUY')) newRecommendation = 'BUY BACK';
                else newRecommendation = newRec;
                
                recommendationChanged = newRecommendation !== strategy.recommendation;
            }
        }
        
        const formatted = checkupAnalysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#ffaa00;">$1</strong>')
            .replace(/VERDICT:\s*(STICK WITH|CHANGE TO)\s*(\w+(?:\s+\w+)?)/gi, 
                '<div style="margin-top:12px;padding:8px;background:rgba(0,217,255,0.1);border-radius:6px;font-weight:bold;color:#00d9ff;">$&</div>')
            .replace(/\n/g, '<br>');
        
        // Build the recommendation change banner if needed
        const changeBanner = recommendationChanged ? `
            <div style="background:rgba(255,140,0,0.2);border:1px solid #ff8800;border-radius:8px;padding:12px;margin-bottom:16px;">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                    <span style="font-size:20px;">⚠️</span>
                    <span style="color:#ff8800;font-weight:bold;">RECOMMENDATION CHANGED</span>
                </div>
                <div style="display:flex;gap:20px;font-size:13px;margin-bottom:12px;">
                    <div>
                        <span style="color:#888;">Saved:</span> 
                        <span style="color:#888;text-decoration:line-through;">${strategy.recommendation}</span>
                    </div>
                    <div>
                        <span style="color:#888;">New:</span> 
                        <span style="color:#00ff88;font-weight:bold;">${newRecommendation}</span>
                    </div>
                </div>
                <button onclick="window.updateHoldingStrategy(${holdingId}, '${newRecommendation}', \`${checkupAnalysis.replace(/`/g, "'").replace(/\\/g, '\\\\')}\`)" 
                    style="padding:8px 16px;background:#ff8800;border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">
                    💾 Update Strategy to ${newRecommendation}
                </button>
            </div>
        ` : '';
        
        modal.querySelector('div > div').innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#00d9ff;">🔄 Strategy Checkup: ${holding.ticker}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            ${changeBanner}
            
            <!-- Original vs Current comparison -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
                <div style="background:rgba(255,170,0,0.1);padding:12px;border-radius:8px;border:1px solid rgba(255,170,0,0.3);">
                    <div style="color:#ffaa00;font-weight:bold;font-size:11px;margin-bottom:8px;">📋 ORIGINAL (${new Date(strategy.savedAt).toLocaleDateString()})</div>
                    <div style="font-size:12px;color:#ccc;">
                        <div>Stock: $${strategy.snapshot.stockPrice.toFixed(2)}</div>
                        <div>DTE: ${strategy.snapshot.dte} days</div>
                        <div>ITM: ${strategy.snapshot.isITM ? 'Yes' : 'No'}</div>
                        <div style="margin-top:8px;color:#00ff88;font-weight:bold;">→ ${strategy.recommendation}</div>
                    </div>
                </div>
                <div style="background:rgba(0,217,255,0.1);padding:12px;border-radius:8px;border:1px solid rgba(0,217,255,0.3);">
                    <div style="color:#00d9ff;font-weight:bold;font-size:11px;margin-bottom:8px;">📊 CURRENT</div>
                    <div style="font-size:12px;color:#ccc;">
                        <div>Stock: $${currentPrice.toFixed(2)} <span style="color:${currentPrice > strategy.snapshot.stockPrice ? '#00ff88' : '#ff5252'};">(${currentPrice > strategy.snapshot.stockPrice ? '+' : ''}${((currentPrice - strategy.snapshot.stockPrice) / strategy.snapshot.stockPrice * 100).toFixed(1)}%)</span></div>
                        <div>DTE: ${dte} days</div>
                        <div>ITM: ${isITM ? 'Yes' : 'No'}</div>
                        <div style="margin-top:8px;">If Called: +$${ifCalled.toFixed(0)}</div>
                    </div>
                </div>
            </div>
            
            <!-- Checkup Analysis -->
            <div style="line-height:1.7;font-size:13px;background:#252540;padding:16px;border-radius:8px;">
                ${formatted}
            </div>
            
            <div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="window.aiHoldingSuggestion(${holdingId})" 
                    style="padding:10px 16px;background:rgba(255,170,0,0.2);border:1px solid #ffaa00;border-radius:6px;color:#ffaa00;cursor:pointer;">
                    🤖 New Full Analysis
                </button>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="padding:10px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
    } catch (e) {
        console.error('Checkup error:', e);
        modal.querySelector('div > div').innerHTML = `
            <h3 style="color:#ff5252;">❌ Checkup Failed</h3>
            <p style="color:#888;">${e.message}</p>
            <button onclick="this.closest('#aiHoldingModal').remove()" 
                style="padding:10px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;margin-top:16px;">
                Close
            </button>
        `;
    }
};

/**
 * Analyze a Buy/Write holding - loads linked position into P&L tab
 */
window.analyzeHolding = function(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding || !holding.linkedPositionId) {
        showNotification('No linked position found', 'warning');
        return;
    }
    
    // Find the linked Buy/Write position
    const position = state.positions.find(p => p.id === holding.linkedPositionId);
    if (!position) {
        showNotification('Linked position not found - may be closed', 'warning');
        return;
    }
    
    // Load position into analyzer - this switches to Options tab
    // User can see the position loaded, then click Run Monte Carlo
    if (window.loadPositionToAnalyze) {
        window.loadPositionToAnalyze(position.id);
        // loadPositionToAnalyze already switches to Options tab and shows notification
    }
};

/**
 * Sell Covered Call - creates CC position linked to holding
 */
export function sellCoveredCall(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    // Pre-fill covered call data
    const suggestedStrike = Math.ceil(holding.costBasis * 1.05); // 5% above cost basis
    
    // Switch to Positions tab and pre-fill form
    const posTab = document.querySelector('[data-tab="positions"]');
    if (posTab) posTab.click();
    
    setTimeout(() => {
        // Pre-fill the add position form
        const tickerInput = document.getElementById('posTicker');
        const strikeInput = document.getElementById('posStrike');
        const typeSelect = document.getElementById('posType');
        const contractsInput = document.getElementById('posContracts');
        const brokerSelect = document.getElementById('posBroker');
        
        if (tickerInput) tickerInput.value = holding.ticker;
        if (strikeInput) strikeInput.value = suggestedStrike;
        if (typeSelect) typeSelect.value = 'short_call';
        if (contractsInput) contractsInput.value = holding.shares / 100;
        if (brokerSelect) brokerSelect.value = holding.broker || 'Schwab';
        
        showNotification(
            `Ready to sell CC on ${holding.ticker}! Enter premium and expiry, then click Add.`,
            'info',
            5000
        );
    }, 200);
}
window.sellCoveredCall = sellCoveredCall;

/**
 * Sell shares - exit the wheel position
 */
export function sellShares(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    const salePrice = parseFloat(prompt(
        `Sell ${holding.shares} shares of ${holding.ticker}\n\n` +
        `Cost basis: $${holding.costBasis.toFixed(2)}/share\n` +
        `Enter sale price per share:`,
        holding.costBasis.toFixed(2)
    ));
    
    if (isNaN(salePrice) || salePrice <= 0) {
        showNotification('Invalid sale price', 'error');
        return;
    }
    
    // Calculate P&L from shares
    const sharePnL = (salePrice - holding.costBasis) * holding.shares;
    const totalPnL = sharePnL + holding.premiumCredit; // Include premium already banked
    
    // Record as closed wheel cycle
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: holding.ticker,
        type: 'wheel_cycle',
        strike: holding.strike,
        premium: holding.premiumReceived,
        contracts: holding.shares / 100,
        openDate: holding.assignedDate,
        closeDate: new Date().toISOString().split('T')[0],
        salePrice: salePrice,
        costBasis: holding.costBasis,
        sharePnL: sharePnL,
        realizedPnL: totalPnL,
        daysHeld: holding.assignedDate ? 
            Math.ceil((new Date() - new Date(holding.assignedDate)) / (1000 * 60 * 60 * 24)) : 0,
        chainId: holding.chainId
    });
    saveClosedPositions();
    
    // Remove from holdings
    state.holdings = state.holdings.filter(h => h.id !== holdingId);
    localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
    
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(0)}` : `-$${Math.abs(totalPnL).toFixed(0)}`;
    showNotification(
        `Sold ${holding.ticker} shares! Total wheel P&L: ${pnlStr}`,
        totalPnL >= 0 ? 'success' : 'warning',
        5000
    );
    
    renderHoldings();
    renderPortfolio(false);
}
window.sellShares = sellShares;

/**
 * Called Away - shares got called away from covered call
 */
export function calledAway(positionId) {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos || !pos.type.includes('call')) {
        showNotification('Invalid position for called away', 'error');
        return;
    }
    
    // Find the linked holding
    const holding = (state.holdings || []).find(h => 
        h.ticker === pos.ticker && h.shares >= 100 * (pos.contracts || 1)
    );
    
    if (!holding) {
        showNotification(`No ${pos.ticker} shares found to be called away`, 'error');
        return;
    }
    
    const sharesToCall = 100 * (pos.contracts || 1);
    const callPremium = pos.premium * 100 * (pos.contracts || 1);
    
    // P&L from being called:
    // Sell at strike + keep call premium + original put premium
    const saleProceeds = pos.strike * sharesToCall;
    const costBasisTotal = holding.costBasis * sharesToCall;
    const sharePnL = saleProceeds - costBasisTotal;
    const totalPnL = sharePnL + callPremium + (holding.premiumCredit * sharesToCall / holding.shares);
    
    // Record the completed wheel cycle
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: pos.ticker,
        type: 'wheel_complete',
        strike: pos.strike,
        premium: pos.premium,
        contracts: pos.contracts || 1,
        openDate: holding.assignedDate,
        closeDate: new Date().toISOString().split('T')[0],
        callPremium: callPremium,
        costBasis: holding.costBasis,
        sharePnL: sharePnL,
        realizedPnL: totalPnL,
        chainId: holding.chainId
    });
    saveClosedPositions();
    
    // Close the call position
    pos.status = 'called_away';
    pos.closeDate = new Date().toISOString().split('T')[0];
    pos.realizedPnL = callPremium;
    state.closedPositions.push({...pos});
    state.positions = state.positions.filter(p => p.id !== positionId);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Update holding (remove shares)
    if (holding.shares <= sharesToCall) {
        state.holdings = state.holdings.filter(h => h.id !== holding.id);
    } else {
        holding.shares -= sharesToCall;
    }
    localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
    
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(0)}` : `-$${Math.abs(totalPnL).toFixed(0)}`;
    showNotification(
        `🎉 Wheel Complete! ${pos.ticker} called at $${pos.strike}. Total P&L: ${pnlStr}`,
        'success',
        6000
    );
    
    renderHoldings();
    renderPortfolio(false);
    if (window.renderPositions) window.renderPositions();
}
window.calledAway = calledAway;

/**
 * Show modal to link a closed position to another position's chain
 */
window.showLinkToChainModal = function(positionId) {
    // Find the position we're linking
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) {
        console.error('Position not found:', positionId);
        return;
    }
    
    // Find all other positions with the same ticker that could be linked
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    const sameTickerPositions = allPositions
        .filter(p => p.ticker === pos.ticker && p.id !== positionId)
        .sort((a, b) => new Date(b.openDate || 0) - new Date(a.openDate || 0));
    
    // Group by chainId to show chains
    const chains = {};
    sameTickerPositions.forEach(p => {
        const chainKey = p.chainId || p.id;
        if (!chains[chainKey]) {
            chains[chainKey] = {
                id: chainKey,
                positions: [],
                firstOpen: p.openDate,
                lastClose: p.closeDate
            };
        }
        chains[chainKey].positions.push(p);
        if (p.openDate < chains[chainKey].firstOpen) chains[chainKey].firstOpen = p.openDate;
        if (p.closeDate > chains[chainKey].lastClose) chains[chainKey].lastClose = p.closeDate;
    });
    
    const chainList = Object.values(chains);
    
    const modal = document.createElement('div');
    modal.id = 'linkChainModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build chain options
    let chainOptionsHtml = '';
    if (chainList.length === 0) {
        chainOptionsHtml = `
            <div style="color:#888; padding:20px; text-align:center;">
                No other ${pos.ticker} positions found to link with.
            </div>
        `;
    } else {
        chainOptionsHtml = chainList.map(chain => {
            const posCount = chain.positions.length;
            const dateRange = `${chain.firstOpen || '?'} → ${chain.lastClose || '?'}`;
            const strikes = [...new Set(chain.positions.map(p => '$' + p.strike))].join(', ');
            
            return `
                <div onclick="window.linkPositionToChain(${positionId}, ${chain.id})" 
                     style="padding:15px; background:#0d0d1a; border:1px solid #333; border-radius:8px; 
                            cursor:pointer; transition: all 0.2s; margin-bottom:10px;"
                     onmouseover="this.style.borderColor='#0096ff'; this.style.background='#1a1a3e';"
                     onmouseout="this.style.borderColor='#333'; this.style.background='#0d0d1a';">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#00d9ff; font-weight:bold;">
                            🔗 Chain with ${posCount} position${posCount > 1 ? 's' : ''}
                        </span>
                        <span style="color:#888; font-size:11px;">${dateRange}</span>
                    </div>
                    <div style="color:#aaa; font-size:12px; margin-top:6px;">
                        Strikes: ${strikes}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    // Current chain info
    const currentChainId = pos.chainId || pos.id;
    const currentChainPositions = allPositions.filter(p => (p.chainId || p.id) === currentChainId);
    const isAlreadyLinked = currentChainPositions.length > 1;
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #0096ff; 
                    border-radius:16px; padding:30px; width:90%; max-width:500px; max-height:80vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 150, 255, 0.3);">
            
            <h2 style="margin:0 0 10px 0; color:#fff; font-size:18px;">🔗 Link Position to Chain</h2>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:20px;">
                <div style="color:#888; font-size:11px; margin-bottom:4px;">LINKING THIS POSITION:</div>
                <div style="color:#00d9ff; font-weight:bold;">
                    ${pos.ticker} • $${pos.strike} ${pos.type?.replace('_', ' ') || 'PUT'}
                </div>
                <div style="color:#888; font-size:12px;">
                    ${pos.openDate || '?'} → ${pos.closeDate || '?'}
                </div>
                ${isAlreadyLinked ? `
                <div style="margin-top:8px; padding:6px 10px; background:rgba(255,170,0,0.15); border-radius:4px; color:#ffaa00; font-size:11px;">
                    ⚠️ Already linked to a chain with ${currentChainPositions.length} positions
                </div>
                ` : ''}
            </div>
            
            <div style="color:#888; font-size:12px; margin-bottom:12px;">
                Select a chain to link this position to:
            </div>
            
            ${chainOptionsHtml}
            
            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                ${isAlreadyLinked ? `
                <button onclick="window.unlinkPositionFromChain(${positionId})" 
                        style="background:#ff5252; border:none; color:#fff; padding:10px 20px; 
                               border-radius:6px; cursor:pointer; font-size:13px;">
                    Unlink from Chain
                </button>
                ` : ''}
                <button onclick="document.getElementById('linkChainModal').remove()" 
                        style="background:#333; border:none; color:#fff; padding:10px 20px; 
                               border-radius:6px; cursor:pointer; font-size:13px;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Link a position to an existing chain
 */
window.linkPositionToChain = function(positionId, targetChainId) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    pos.chainId = targetChainId;
    saveClosedPositions();
    
    document.getElementById('linkChainModal')?.remove();
    
    showNotification(`✅ Position linked to chain`, 'success');
    renderPortfolio(false);
};

/**
 * Unlink a position from its chain (give it its own unique chainId)
 */
window.unlinkPositionFromChain = function(positionId) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    // Give it a unique chainId (its own id)
    pos.chainId = pos.id;
    saveClosedPositions();
    
    document.getElementById('linkChainModal')?.remove();
    
    showNotification(`Position unlinked - now standalone`, 'info');
    renderPortfolio(false);
};

/**
 * Show modal to link a closed position to a challenge
 */
window.showLinkToChallengeModal = function(positionId) {
    // Find the position
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) {
        console.error('Position not found:', positionId);
        return;
    }
    
    const challenges = state.challenges || [];
    const linkedChallengeIds = pos.challengeIds || [];
    
    const modal = document.createElement('div');
    modal.id = 'linkChallengeModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build challenge options
    let challengeOptionsHtml = '';
    if (challenges.length === 0) {
        challengeOptionsHtml = `
            <div style="color:#888; padding:20px; text-align:center;">
                No challenges created yet.<br>
                <span style="font-size:11px;">Create a challenge in the Challenges tab first.</span>
            </div>
        `;
    } else {
        challengeOptionsHtml = challenges.map(ch => {
            const isLinked = linkedChallengeIds.includes(ch.id);
            const statusBadge = ch.status === 'completed' ? '✅' : ch.status === 'archived' ? '📦' : '🎯';
            const dateRange = `${ch.startDate} → ${ch.endDate}`;
            
            return `
                <div style="padding:12px; background:#0d0d1a; border:1px solid ${isLinked ? '#ffd700' : '#333'}; border-radius:8px; 
                            margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:${isLinked ? '#ffd700' : '#fff'}; font-weight:bold;">
                            ${statusBadge} ${ch.name}
                        </span>
                        <div style="color:#888; font-size:11px; margin-top:4px;">${dateRange}</div>
                    </div>
                    <button onclick="window.togglePositionChallenge(${positionId}, ${ch.id}, ${isLinked})"
                            style="padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;
                                   background:${isLinked ? '#ff5252' : '#00d9ff'}; 
                                   color:${isLinked ? '#fff' : '#000'}; border:none;">
                        ${isLinked ? 'Remove' : 'Add'}
                    </button>
                </div>
            `;
        }).join('');
    }
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #ffd700; 
                    border-radius:16px; padding:30px; width:90%; max-width:450px; max-height:80vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(255, 215, 0, 0.2);">
            
            <h2 style="margin:0 0 10px 0; color:#fff; font-size:18px;">🏆 Link to Challenge</h2>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:20px;">
                <div style="color:#00d9ff; font-weight:bold; font-size:14px;">${pos.ticker}</div>
                <div style="color:#888; font-size:12px;">
                    ${pos.type.replace('_', ' ')} • $${pos.strike} • Closed ${pos.closeDate}
                </div>
            </div>
            
            <div style="color:#aaa; font-size:12px; margin-bottom:15px;">
                Select challenges to link this position to:
            </div>
            
            <div style="max-height:300px; overflow-y:auto;">
                ${challengeOptionsHtml}
            </div>
            
            <div style="margin-top:20px; text-align:right;">
                <button onclick="document.getElementById('linkChallengeModal').remove()"
                        style="padding:10px 20px; background:#333; color:#fff; border:none; border-radius:8px; cursor:pointer;">
                    Done
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Toggle a position's link to a challenge
 */
window.togglePositionChallenge = function(positionId, challengeId, isCurrentlyLinked) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    if (!pos.challengeIds) pos.challengeIds = [];
    
    if (isCurrentlyLinked) {
        // Remove from challenge
        pos.challengeIds = pos.challengeIds.filter(cid => cid !== challengeId);
        showNotification('Removed from challenge', 'info');
    } else {
        // Add to challenge
        if (!pos.challengeIds.includes(challengeId)) {
            pos.challengeIds.push(challengeId);
        }
        showNotification('✅ Added to challenge', 'success');
    }
    
    saveClosedPositions();
    
    // Refresh the modal to show updated state
    document.getElementById('linkChallengeModal')?.remove();
    window.showLinkToChallengeModal(positionId);
    
    // Refresh the table in background
    renderClosedPositions();
};

// ============================================================
// PORTFOLIO GREEKS DASHBOARD
// ============================================================

/**
 * Update portfolio Greeks display
 */
export async function updatePortfolioGreeks() {
    const positions = state.positions || [];
    if (positions.length === 0) {
        setGreeksDisplay({ delta: 0, gamma: 0, theta: 0, vega: 0, avgIV: null, avgIVRank: null });
        return;
    }
    
    // Get current spot prices for all tickers
    const tickers = [...new Set(positions.map(p => p.ticker))];
    const spotPrices = {};
    const ivData = {};
    const ivRankData = {};
    
    try {
        // Fetch batch prices
        const prices = await fetchStockPricesBatch(tickers);
        tickers.forEach((ticker, i) => {
            spotPrices[ticker] = prices[i] || 100;
        });
        
        // Fetch IV data from our new endpoint (Schwab first, then CBOE)
        const ivPromises = tickers.map(async ticker => {
            try {
                const res = await fetch(`/api/iv/${ticker}`);
                if (res.ok) {
                    const data = await res.json();
                    return { ticker, iv: parseFloat(data.atmIV) / 100 || 0.30, ivRank: data.ivRank };
                }
            } catch (e) {
                console.warn(`Failed to fetch IV for ${ticker}:`, e);
            }
            return { ticker, iv: 0.30, ivRank: null };
        });
        
        const ivResults = await Promise.all(ivPromises);
        ivResults.forEach(({ ticker, iv, ivRank }) => {
            ivData[ticker] = iv;
            ivRankData[ticker] = ivRank;
        });
        
    } catch (err) {
        console.warn('Failed to fetch spot prices for Greeks:', err);
    }
    
    const greeks = calculatePortfolioGreeks(positions, spotPrices, ivData);
    
    // Calculate average IV and IV Rank across positions
    const validIVs = Object.values(ivData).filter(iv => iv > 0);
    const validRanks = Object.values(ivRankData).filter(r => r !== null);
    greeks.avgIV = validIVs.length > 0 ? (validIVs.reduce((a, b) => a + b, 0) / validIVs.length) * 100 : null;
    greeks.avgIVRank = validRanks.length > 0 ? Math.round(validRanks.reduce((a, b) => a + b, 0) / validRanks.length) : null;
    greeks.ivByTicker = ivRankData;
    
    setGreeksDisplay(greeks);
    
    return greeks;
}

function setGreeksDisplay(greeks) {
    const setEl = (id, val, color) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = val;
            if (color) el.style.color = color;
        }
    };
    
    // Delta: positive = bullish, negative = bearish
    const deltaColor = greeks.delta > 0 ? '#00ff88' : greeks.delta < 0 ? '#ff5252' : '#888';
    setEl('portDelta', greeks.delta.toFixed(0), deltaColor);
    
    // Theta: positive = collecting premium (good for sellers)
    const thetaColor = greeks.theta > 0 ? '#00ff88' : '#ff5252';
    setEl('portTheta', (greeks.theta >= 0 ? '+$' : '-$') + Math.abs(greeks.theta).toFixed(0), thetaColor);
    
    // Gamma: shows acceleration of delta
    setEl('portGamma', greeks.gamma.toFixed(2), '#888');
    
    // Vega: exposure to IV changes
    const vegaColor = greeks.vega > 0 ? '#ff5252' : '#00ff88';  // Short vega is good for sellers
    setEl('portVega', (greeks.vega >= 0 ? '+$' : '-$') + Math.abs(greeks.vega).toFixed(0), vegaColor);
    
    // Average IV
    if (greeks.avgIV !== null) {
        setEl('portAvgIV', greeks.avgIV.toFixed(1) + '%', '#888');
    }
    
    // Average IV Rank
    if (greeks.avgIVRank !== null) {
        // Color: green if high (>50), red if low (<30), orange otherwise
        const ivRankColor = greeks.avgIVRank >= 50 ? '#00ff88' : greeks.avgIVRank < 30 ? '#ff5252' : '#ffaa00';
        setEl('portIVRank', greeks.avgIVRank + '%', ivRankColor);
    }
}

// ============================================================
// CAPITAL VELOCITY ANALYTICS
// ============================================================

/**
 * Calculate the user's average monthly return on capital from closed positions
 * This is used for opportunity cost analysis (roll up vs redeploy)
 * Returns: { monthlyYieldPct, avgDaysHeld, tradeCount, totalPnL, totalCapital }
 */
export function calculateCapitalVelocity() {
    const closed = state.closedPositions || [];
    
    // Only credit strategies (short puts, covered calls, buy/writes)
    // Exclude long calls/puts and spreads for this calculation
    const creditTrades = closed.filter(p => {
        const type = p.type || '';
        return type === 'short_put' || type === 'covered_call' || type === 'buy_write';
    });
    
    if (creditTrades.length < 3) {
        return {
            monthlyYieldPct: 2.0,  // Default assumption: 2% monthly
            avgDaysHeld: 30,
            tradeCount: 0,
            totalPnL: 0,
            totalCapital: 0,
            isDefault: true,
            method: 'default'
        };
    }
    
    const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
    const getDaysHeld = (p) => {
        if (p.daysHeld) return p.daysHeld;
        if (p.openDate && p.closeDate) {
            const open = new Date(p.openDate);
            const close = new Date(p.closeDate);
            if (!isNaN(open) && !isNaN(close)) {
                return Math.max(1, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
            }
        }
        return 30; // Default assumption
    };
    
    // Calculate capital at risk for each trade
    const getCapitalAtRisk = (p) => {
        if (p.type === 'buy_write' && p.stockPrice) {
            // Buy/Write: capital is stock cost
            return p.stockPrice * 100 * (p.contracts || 1);
        } else if (p.type === 'short_put' || p.type === 'covered_call') {
            // Short put/CC: capital is strike × 100 (max assignment risk)
            return (p.strike || 0) * 100 * (p.contracts || 1);
        }
        return (p.strike || 50) * 100 * (p.contracts || 1);
    };
    
    // === METHOD 1: Realized PnL-based (includes losses from assignments) ===
    let totalPnL = 0;
    let totalCapitalDays = 0;
    let totalDays = 0;
    
    // === METHOD 2: Premium-based (what you collect if trades expire worthless) ===
    let totalPremiumCollected = 0;
    let totalCapital = 0;
    
    for (const p of creditTrades) {
        const pnl = getPnL(p);
        const days = getDaysHeld(p);
        const capital = getCapitalAtRisk(p);
        const premium = (p.premium || 0) * 100 * (p.contracts || 1);
        
        totalPnL += pnl;
        totalDays += days;
        totalCapitalDays += capital * days;
        totalPremiumCollected += premium;
        totalCapital += capital;
    }
    
    const avgDays = totalDays / creditTrades.length;
    const avgCapitalPerTrade = totalCapital / creditTrades.length;
    
    // Method 1: PnL-based monthly yield (can be depressed by big losers)
    const dailyYield = totalPnL / totalCapitalDays;
    const pnlBasedMonthlyYield = dailyYield * 30 * 100;
    
    // Method 2: Premium-based yield (what you'd earn at max profit)
    const avgPremiumPerTrade = totalPremiumCollected / creditTrades.length;
    const tradesPerMonth = 30 / avgDays;
    const monthlyPremium = avgPremiumPerTrade * tradesPerMonth;
    const premiumBasedMonthlyYield = (monthlyPremium / avgCapitalPerTrade) * 100;
    
    // Use a BLEND: 50% premium-based + 50% realized (acknowledges losses but not dominated by them)
    // This gives a more realistic expectation than either extreme
    const blendedYield = (premiumBasedMonthlyYield * 0.5) + (Math.max(0, pnlBasedMonthlyYield) * 0.5);
    
    // If PnL-based is negative (net loser), lean more on premium-based
    let finalYield;
    let method;
    if (pnlBasedMonthlyYield < 0) {
        // You're net negative - use 75% premium, 25% of 0 (being conservative)
        finalYield = premiumBasedMonthlyYield * 0.75;
        method = 'premium-weighted (losses detected)';
    } else if (pnlBasedMonthlyYield < premiumBasedMonthlyYield * 0.5) {
        // Realized yield is much lower than premium (big losers dragging it down)
        finalYield = blendedYield;
        method = 'blended (losers detected)';
    } else {
        // Realized is close to or above premium (efficient execution)
        finalYield = pnlBasedMonthlyYield;
        method = 'realized PnL';
    }
    
    return {
        monthlyYieldPct: Math.max(0.5, Math.min(10, finalYield)), // Clamp to 0.5-10%
        avgDaysHeld: avgDays,
        tradeCount: creditTrades.length,
        totalPnL,
        totalCapital: avgCapitalPerTrade,
        isDefault: false,
        method,
        // Debug info
        pnlBasedYield: pnlBasedMonthlyYield,
        premiumBasedYield: premiumBasedMonthlyYield
    };
}
window.calculateCapitalVelocity = calculateCapitalVelocity;

/**
 * Calculate opportunity cost: Roll Up vs Let It Get Called Away
 * @param {number} missedUpside - Dollar amount left on table
 * @param {number} currentCapital - Capital tied up in position
 * @param {number} dteRemaining - Days until current expiry
 * @param {number} rollOutDte - DTE of the roll target (e.g., 45 days further out)
 */
export function calculateOpportunityCost(missedUpside, currentCapital, dteRemaining, rollOutDte = 45) {
    const velocity = calculateCapitalVelocity();
    
    // Time to capture missed upside = roll out to new expiry
    const monthsToCapture = rollOutDte / 30;
    
    // Expected return from redeploying capital into new trade
    const expectedFromRedeploy = currentCapital * (velocity.monthlyYieldPct / 100) * monthsToCapture;
    
    // Comparison
    const betterChoice = expectedFromRedeploy > missedUpside ? 'redeploy' : 'roll';
    const difference = Math.abs(expectedFromRedeploy - missedUpside);
    
    return {
        missedUpside,
        rollOutDte,
        monthsToCapture,
        monthlyYieldPct: velocity.monthlyYieldPct,
        expectedFromRedeploy,
        betterChoice,
        difference,
        isDefaultYield: velocity.isDefault
    };
}
window.calculateOpportunityCost = calculateOpportunityCost;

// ============================================================
// ADVANCED ANALYTICS (Profit Factor, Kelly, etc.)
// ============================================================

/**
 * Calculate and display advanced analytics
 * Filters by the selected year (same as Closed Positions table)
 */
export function updateAdvancedAnalytics() {
    const allClosed = state.closedPositions || [];
    const yearFilter = state.closedYearFilter || new Date().getFullYear().toString();
    
    // Filter by year (same logic as Closed Positions table)
    const closed = yearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            return closeDate.startsWith(yearFilter);
        });
    
    // Update label to show which year
    const labelEl = document.getElementById('analyticsYearLabel');
    if (labelEl) {
        labelEl.textContent = yearFilter === 'all' ? '(All Time)' : `(${yearFilter})`;
    }
    
    if (closed.length < 3) {
        setAnalyticsDefaults();
        return;
    }
    
    const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
    
    const wins = closed.filter(p => getPnL(p) > 0);
    const losses = closed.filter(p => getPnL(p) < 0);
    
    // Win rate
    const winRate = closed.length > 0 ? (wins.length / closed.length) : 0;
    
    // Average win / loss
    const totalWins = wins.reduce((sum, p) => sum + getPnL(p), 0);
    const totalLosses = Math.abs(losses.reduce((sum, p) => sum + getPnL(p), 0));
    const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;
    
    // Profit Factor = Gross Profit / Gross Loss
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? Infinity : 0);
    
    // Expectancy = (Win% × Avg Win) - (Loss% × Avg Loss)
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    
    // Max Drawdown (peak-to-trough)
    let peak = 0, maxDrawdown = 0, cumPnL = 0;
    // Sort by close date
    const sorted = [...closed].sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
    for (const p of sorted) {
        cumPnL += getPnL(p);
        if (cumPnL > peak) peak = cumPnL;
        const drawdown = peak - cumPnL;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    
    // Kelly Criterion = W - [(1-W) / R]
    // W = win probability, R = win/loss ratio
    const R = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kellyPercent = avgLoss > 0 ? (winRate - ((1 - winRate) / R)) * 100 : 0;
    const halfKelly = kellyPercent / 2;
    
    // Display
    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    
    setEl('portProfitFactor', profitFactor === Infinity ? '∞' : profitFactor.toFixed(2));
    setEl('portAvgWin', '+$' + avgWin.toFixed(0));
    setEl('portAvgLoss', '-$' + avgLoss.toFixed(0));
    setEl('portExpectancy', (expectancy >= 0 ? '+$' : '-$') + Math.abs(expectancy).toFixed(0) + '/trade');
    setEl('portMaxDrawdown', '-$' + maxDrawdown.toFixed(0));
    
    // Kelly
    const kellyEl = document.getElementById('portKelly');
    if (kellyEl) {
        kellyEl.textContent = kellyPercent.toFixed(1) + '%';
        kellyEl.style.color = kellyPercent > 0 ? '#00d9ff' : '#ff5252';
    }
    
    // Half Kelly with conservative margin usage
    // Formula: Kelly Base = Account Value + (25% × Available Margin)
    // This uses margin sparingly while acknowledging it exists as a tool
    const halfKellyEl = document.getElementById('portHalfKelly');
    if (halfKellyEl) {
        const buyingPower = parseFloat(document.getElementById('balBuyingPower')?.textContent?.replace(/[^0-9.]/g, '')) || 0;
        const accountValue = parseFloat(document.getElementById('balAccountValue')?.textContent?.replace(/[^0-9.]/g, '')) || 0;
        
        // Calculate conservative Kelly Base
        let kellyBase = 0;
        if (accountValue > 0) {
            // Account Value + 25% of available margin
            const availableMargin = Math.max(0, buyingPower - accountValue);
            kellyBase = accountValue + (availableMargin * 0.25);
        } else if (buyingPower > 0) {
            // Fallback: estimate account value as BP / 2
            kellyBase = buyingPower * 0.625; // 50% + 25% of remaining 50%
        }
        
        if (kellyBase > 0 && halfKelly > 0) {
            const suggestedSize = (kellyBase * halfKelly / 100).toFixed(0);
            halfKellyEl.textContent = `${halfKelly.toFixed(1)}% = $${Number(suggestedSize).toLocaleString()}`;
            halfKellyEl.title = `Based on Account Value ($${accountValue.toLocaleString()}) + 25% of available margin`;
        } else {
            halfKellyEl.textContent = halfKelly.toFixed(1) + '% of account';
        }
    }
}

function setAnalyticsDefaults() {
    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    
    setEl('portProfitFactor', '—');
    setEl('portAvgWin', '—');
    setEl('portAvgLoss', '—');
    setEl('portExpectancy', '—');
    setEl('portMaxDrawdown', '—');
    setEl('portKelly', '—');
    setEl('portHalfKelly', 'Need 3+ trades');
}

// ============================================================
// WIN RATE DASHBOARD
// ============================================================

/**
 * Update the Win Rate Dashboard with detailed stats
 */
export function updateWinRateDashboard() {
    const allClosed = state.closedPositions || [];
    const yearFilter = state.closedYearFilter || new Date().getFullYear().toString();
    
    const closed = yearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => (p.closeDate || '').startsWith(yearFilter));
    
    // Update year label
    const labelEl = document.getElementById('winRateYearLabel');
    if (labelEl) labelEl.textContent = yearFilter === 'all' ? '(All Time)' : `(${yearFilter})`;
    
    const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };
    
    if (closed.length === 0) {
        setEl('dashWinRate', '—');
        setEl('dashTotalTrades', '0');
        setEl('dashAvgDTE', '—');
        setEl('dashAvgPremium', '—');
        setEl('dashBestTicker', '—');
        setEl('dashWorstTicker', '—');
        setEl('dashBiggestWin', '—');
        setEl('dashBiggestLoss', '—');
        return;
    }
    
    const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
    const wins = closed.filter(p => getPnL(p) > 0);
    const losses = closed.filter(p => getPnL(p) < 0);
    
    // Win rate
    const winRate = (wins.length / closed.length * 100).toFixed(1);
    setEl('dashWinRate', `${winRate}% (${wins.length}W/${losses.length}L)`);
    setEl('dashTotalTrades', closed.length.toString());
    
    // Average DTE held
    const dteValues = closed.filter(p => p.daysHeld != null).map(p => p.daysHeld);
    const avgDTE = dteValues.length > 0 
        ? (dteValues.reduce((a, b) => a + b, 0) / dteValues.length).toFixed(1) 
        : '—';
    setEl('dashAvgDTE', avgDTE + ' days');
    
    // Average premium
    const premiums = closed.filter(p => p.premium > 0).map(p => p.premium * 100 * (p.contracts || 1));
    const avgPremium = premiums.length > 0 
        ? (premiums.reduce((a, b) => a + b, 0) / premiums.length).toFixed(0)
        : 0;
    setEl('dashAvgPremium', '$' + Number(avgPremium).toLocaleString());
    
    // Group by ticker
    const byTicker = {};
    closed.forEach(p => {
        const ticker = p.ticker || 'Unknown';
        if (!byTicker[ticker]) byTicker[ticker] = { wins: 0, losses: 0, totalPnL: 0 };
        if (getPnL(p) > 0) byTicker[ticker].wins++;
        else if (getPnL(p) < 0) byTicker[ticker].losses++;
        byTicker[ticker].totalPnL += getPnL(p);
    });
    
    // Best/Worst ticker (by total P&L)
    const tickers = Object.entries(byTicker).map(([ticker, stats]) => ({
        ticker,
        ...stats,
        winRate: stats.wins + stats.losses > 0 ? stats.wins / (stats.wins + stats.losses) : 0
    }));
    
    tickers.sort((a, b) => b.totalPnL - a.totalPnL);
    const best = tickers[0];
    const worst = tickers[tickers.length - 1];
    
    if (best) {
        const bestWinPct = (best.winRate * 100).toFixed(0);
        setEl('dashBestTicker', `${best.ticker} +$${best.totalPnL.toLocaleString()} (${bestWinPct}%)`);
    }
    if (worst && worst.totalPnL < 0) {
        const worstWinPct = (worst.winRate * 100).toFixed(0);
        setEl('dashWorstTicker', `${worst.ticker} -$${Math.abs(worst.totalPnL).toLocaleString()} (${worstWinPct}%)`);
    } else {
        setEl('dashWorstTicker', 'None! 🎉');
    }
    
    // Biggest win/loss BY CHAIN (not individual legs)
    // Group closed positions by chainId and sum their P&L
    const chainPnL = {};
    closed.forEach(p => {
        const chainId = p.chainId || p.id; // Use position id if no chain
        if (!chainPnL[chainId]) {
            chainPnL[chainId] = { 
                ticker: p.ticker, 
                totalPnL: 0, 
                legs: 0,
                isChain: false 
            };
        }
        chainPnL[chainId].totalPnL += getPnL(p);
        chainPnL[chainId].legs++;
        if (chainPnL[chainId].legs > 1) chainPnL[chainId].isChain = true;
    });
    
    // Convert to array and sort
    const chains = Object.entries(chainPnL).map(([chainId, data]) => ({
        chainId,
        ...data
    }));
    chains.sort((a, b) => b.totalPnL - a.totalPnL);
    
    const biggestWinChain = chains[0];
    const biggestLossChain = chains[chains.length - 1];
    
    if (biggestWinChain && biggestWinChain.totalPnL > 0) {
        const chainLabel = biggestWinChain.isChain ? ' 🔗' : '';
        setEl('dashBiggestWin', `${biggestWinChain.ticker}${chainLabel} +$${biggestWinChain.totalPnL.toLocaleString()}`);
    } else {
        setEl('dashBiggestWin', '—');
    }
    if (biggestLossChain && biggestLossChain.totalPnL < 0) {
        const chainLabel = biggestLossChain.isChain ? ' 🔗' : '';
        setEl('dashBiggestLoss', `${biggestLossChain.ticker}${chainLabel} -$${Math.abs(biggestLossChain.totalPnL).toLocaleString()}`);
    } else {
        setEl('dashBiggestLoss', 'None! 🎉');
    }
}

// ============================================================
// P&L CHART (Cumulative Line Chart)
// ============================================================

/**
 * Draw cumulative P&L chart on canvas
 */
export function drawPnLChart() {
    const canvas = document.getElementById('pnlChartCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const M = 25; // margin
    
    // Clear
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    const allClosed = state.closedPositions || [];
    const yearFilter = state.closedYearFilter || new Date().getFullYear().toString();
    
    const closed = yearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => (p.closeDate || '').startsWith(yearFilter));
    
    // Update year label
    const labelEl = document.getElementById('pnlChartYearLabel');
    if (labelEl) labelEl.textContent = yearFilter === 'all' ? '(All Time)' : `(${yearFilter})`;
    
    if (closed.length < 2) {
        ctx.fillStyle = '#888';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Need 2+ closed trades', W/2, H/2);
        document.getElementById('pnlChartStart')?.setAttribute('textContent', '—');
        document.getElementById('pnlChartEnd')?.setAttribute('textContent', '—');
        return;
    }
    
    const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
    
    // Sort by close date
    const sorted = [...closed].sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
    
    // Calculate cumulative P&L
    let cumulative = 0;
    const dataPoints = sorted.map(p => {
        cumulative += getPnL(p);
        return { date: p.closeDate, value: cumulative };
    });
    
    const minVal = Math.min(0, ...dataPoints.map(d => d.value));
    const maxVal = Math.max(0, ...dataPoints.map(d => d.value));
    const range = maxVal - minVal || 1;
    
    // Draw zero line
    const zeroY = H - M - ((0 - minVal) / range) * (H - 2*M);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(M, zeroY);
    ctx.lineTo(W - M, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw line
    ctx.strokeStyle = cumulative >= 0 ? '#00ff88' : '#ff5252';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    dataPoints.forEach((pt, i) => {
        const x = M + (i / (dataPoints.length - 1)) * (W - 2*M);
        const y = H - M - ((pt.value - minVal) / range) * (H - 2*M);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
    
    // Fill area under curve
    ctx.lineTo(W - M, zeroY);
    ctx.lineTo(M, zeroY);
    ctx.closePath();
    ctx.fillStyle = cumulative >= 0 ? 'rgba(0,255,136,0.15)' : 'rgba(255,82,82,0.15)';
    ctx.fill();
    
    // End point dot
    const lastPt = dataPoints[dataPoints.length - 1];
    const lastX = W - M;
    const lastY = H - M - ((lastPt.value - minVal) / range) * (H - 2*M);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = cumulative >= 0 ? '#00ff88' : '#ff5252';
    ctx.fill();
    
    // Labels for min/max
    ctx.fillStyle = '#888';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('$' + maxVal.toLocaleString(), 2, M);
    ctx.fillText('$' + minVal.toLocaleString(), 2, H - 5);
    
    // Date range labels
    const startEl = document.getElementById('pnlChartStart');
    const endEl = document.getElementById('pnlChartEnd');
    if (startEl) startEl.textContent = formatShortDate(sorted[0].closeDate);
    if (endEl) endEl.textContent = formatShortDate(sorted[sorted.length - 1].closeDate);
}

function formatShortDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return (d.getMonth() + 1) + '/' + d.getDate();
}

// ============================================================
// EXPIRATION CALENDAR
// ============================================================

let calendarMonth = new Date().getMonth();
let calendarYear = new Date().getFullYear();

window.changeCalendarMonth = function(delta) {
    calendarMonth += delta;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderExpirationCalendar();
};

/**
 * Render the expiration calendar for open positions
 */
export function renderExpirationCalendar() {
    const container = document.getElementById('expirationCalendar');
    const labelEl = document.getElementById('calendarMonthLabel');
    if (!container) return;
    
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
    if (labelEl) labelEl.textContent = `${months[calendarMonth]} ${calendarYear}`;
    
    const positions = state.positions || [];
    
    // Group expirations by date
    const expirations = {};
    positions.forEach(p => {
        if (!p.expiry) return;
        const expDate = p.expiry.split('T')[0]; // YYYY-MM-DD
        if (!expirations[expDate]) expirations[expDate] = [];
        expirations[expDate].push(p);
    });
    
    // Build calendar grid
    const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    let html = '<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:2px; text-align:center;">';
    
    // Day headers
    ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(day => {
        html += `<div style="color:#888; font-size:9px; padding:2px;">${day}</div>`;
    });
    
    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
        html += '<div></div>';
    }
    
    // Days
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayPositions = expirations[dateStr] || [];
        const isToday = dateStr === todayStr;
        
        let bgColor = 'transparent';
        let dots = '';
        
        if (dayPositions.length > 0) {
            // Create dots for each position type
            dots = dayPositions.map(p => {
                const type = p.type || '';
                if (type.includes('spread')) return '🟣';
                if (type.includes('call')) return '🔵';
                if (type.includes('put')) return '🟢';
                return '⚪';
            }).join('');
            bgColor = 'rgba(255,170,0,0.3)';
        }
        
        const todayStyle = isToday ? 'border:1px solid #00d9ff;' : '';
        const title = dayPositions.map(p => `${p.ticker} ${p.strike} ${p.type}`).join('\n');
        
        html += `<div style="padding:3px; border-radius:3px; background:${bgColor}; ${todayStyle} cursor:${dayPositions.length ? 'pointer' : 'default'};" 
                      title="${title}" 
                      onclick="${dayPositions.length ? `window.showCalendarDay('${dateStr}')` : ''}">
                    <div style="color:${isToday ? '#00d9ff' : '#ddd'};">${day}</div>
                    <div style="font-size:8px; line-height:1;">${dots}</div>
                 </div>`;
    }
    
    html += '</div>';
    container.innerHTML = html;
}

window.showCalendarDay = function(dateStr) {
    const positions = (state.positions || []).filter(p => (p.expiry || '').startsWith(dateStr));
    if (positions.length === 0) return;
    
    const formattedDate = new Date(dateStr).toLocaleDateString('en-US', { 
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' 
    });
    
    let html = `
        <div style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); 
                    display:flex; align-items:center; justify-content:center; z-index:10000;"
             onclick="if(event.target===this) this.remove();">
            <div style="background:#1a1a2e; border-radius:12px; padding:20px; max-width:500px; width:90%; 
                        border:1px solid rgba(255,170,0,0.5);">
                <h3 style="color:#ffaa00; margin:0 0 15px;">📅 Expiring ${formattedDate}</h3>
                <div style="max-height:300px; overflow-y:auto;">
    `;
    
    positions.forEach(p => {
        const typeIcon = (p.type || '').includes('put') ? '🟢' : (p.type || '').includes('call') ? '🔵' : '🟣';
        html += `
            <div style="padding:10px; background:rgba(255,255,255,0.05); border-radius:6px; margin-bottom:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:600; color:#ddd;">${typeIcon} ${p.ticker}</span>
                    <span style="color:#888;">${p.contracts || 1} contracts</span>
                </div>
                <div style="color:#aaa; font-size:12px; margin-top:5px;">
                    Strike: $${p.strike || p.sellStrike || '—'} | Premium: $${p.premium?.toFixed(2) || '—'}
                </div>
            </div>
        `;
    });
    
    html += `
                </div>
                <button onclick="this.closest('div[style*=fixed]').remove()" 
                        style="margin-top:15px; padding:10px 20px; background:#ffaa00; color:#000; border:none; 
                               border-radius:6px; cursor:pointer; font-weight:600;">Close</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
};

// ============================================================
// REFRESH ALL DASHBOARDS
// ============================================================

/**
 * Refresh all dashboard components when year filter changes or data updates
 */
export function refreshAllDashboards() {
    updateAdvancedAnalytics();
    updateWinRateDashboard();
    drawPnLChart();
    renderExpirationCalendar();
}

// Hook up refresh button
document.addEventListener('DOMContentLoaded', () => {
    const refreshGreeksBtn = document.getElementById('refreshGreeksBtn');
    if (refreshGreeksBtn) {
        refreshGreeksBtn.onclick = async () => {
            refreshGreeksBtn.textContent = '⏳...';
            refreshGreeksBtn.disabled = true;
            try {
                await updatePortfolioGreeks();
                updateAdvancedAnalytics();
                showNotification('✅ Greeks updated', 'success', 2000);
            } catch (err) {
                console.error('Failed to update Greeks:', err);
                showNotification('Failed to update Greeks', 'error');
            } finally {
                refreshGreeksBtn.textContent = '🔄 Greeks & IV';
                refreshGreeksBtn.disabled = false;
            }
        };
    }
    
    // Refresh Prices button - fetch real-time prices from Schwab for all positions
    const refreshPricesBtn = document.getElementById('refreshPricesBtn');
    if (refreshPricesBtn) {
        refreshPricesBtn.onclick = async () => {
            refreshPricesBtn.textContent = '⏳ Fetching...';
            refreshPricesBtn.disabled = true;
            try {
                await refreshAllPositionPrices();
                updatePriceLastUpdated();
                showNotification('✅ Prices refreshed from Schwab', 'success', 2000);
            } catch (err) {
                console.error('Failed to refresh prices:', err);
                showNotification('Failed to refresh prices', 'error');
            } finally {
                refreshPricesBtn.textContent = '💲 Refresh Prices';
                refreshPricesBtn.disabled = false;
            }
        };
    }
    
    // Auto-refresh prices toggle
    setupAutoRefreshPrices();
});

// ============================================================
// AI PERFORMANCE REVIEW
// ============================================================

/**
 * Analyze AI prediction accuracy from closed positions with stored AI data
 */
window.showAIPerformanceReview = function() {
    const closedPositions = state.closedPositions || [];
    
    // Get prediction log (forward-tracking)
    const predictionLog = getAIPredictionLog();
    const resolvedPredictions = predictionLog.filter(p => p.outcome !== null);
    const unresolvedPredictions = predictionLog.filter(p => p.outcome === null);
    
    // Separate positions by AI data availability
    const withThesis = closedPositions.filter(p => p.openingThesis?.aiSummary);
    const withHistory = closedPositions.filter(p => p.analysisHistory?.length > 0);
    const totalWithAI = closedPositions.filter(p => p.openingThesis?.aiSummary || p.analysisHistory?.length > 0);
    
    // Calculate entry accuracy (AI said ENTER with X% confidence → did it win?)
    const entryAnalysis = analyzeEntryAccuracy(withThesis);
    
    // Calculate checkup accuracy (AI said HOLD/ROLL/CLOSE → was it right?)
    const checkupAnalysis = analyzeCheckupAccuracy(withHistory);
    
    // Calculate probability calibration (AI said 75% → actual win rate?)
    const calibrationAnalysis = analyzeCalibration(withThesis);
    
    // Build the modal
    const modal = document.createElement('div');
    modal.id = 'aiPerformanceModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const hasData = totalWithAI.length > 0 || unresolvedPredictions.length > 0;
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border-radius:12px;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 0 30px rgba(0,217,255,0.3);">
            <div style="padding:20px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;">
                <h2 style="margin:0;color:#00d9ff;">📊 AI Performance Review</h2>
                <button onclick="this.closest('#aiPerformanceModal').remove()" style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">&times;</button>
            </div>
            
            <div style="padding:20px;">
                ${!hasData ? `
                    <div style="text-align:center;padding:40px 20px;">
                        <div style="font-size:48px;margin-bottom:20px;">📝</div>
                        <h3 style="color:#ffaa00;margin-bottom:15px;">No AI Data Yet</h3>
                        <p style="color:#aaa;line-height:1.6;">
                            AI performance tracking starts when you:<br><br>
                            • Use <b style="color:#00d9ff;">Discord Analyzer</b> to stage trades (stores AI entry thesis)<br>
                            • Run <b style="color:#00d9ff;">AI Checkups</b> on open positions (stores recommendations)<br><br>
                            As you close positions that have AI data, this panel will show accuracy stats.
                        </p>
                        <div style="margin-top:20px;padding:15px;background:rgba(0,255,136,0.1);border-radius:8px;text-align:left;">
                            <div style="color:#00ff88;font-weight:600;margin-bottom:8px;">🚀 Get Started:</div>
                            <div style="color:#aaa;font-size:13px;">
                                1. Go to <b>Ideas</b> tab → paste a trade from Discord<br>
                                2. AI analyzes it → click "Stage Trade"<br>
                                3. When you close that position, we'll track if AI was right
                            </div>
                        </div>
                    </div>
                ` : `
                    <!-- Tracking Status -->
                    ${unresolvedPredictions.length > 0 ? `
                    <div style="background:rgba(255,170,0,0.1);padding:12px;border-radius:8px;margin-bottom:15px;border:1px solid rgba(255,170,0,0.3);">
                        <div style="display:flex;align-items:center;gap:10px;">
                            <span style="font-size:20px;">📍</span>
                            <div>
                                <div style="color:#ffaa00;font-weight:600;">Currently Tracking ${unresolvedPredictions.length} Predictions</div>
                                <div style="font-size:12px;color:#888;">
                                    ${unresolvedPredictions.filter(p => p.type === 'entry').length} entry picks • 
                                    ${unresolvedPredictions.filter(p => p.type === 'checkup').length} checkup recommendations
                                </div>
                            </div>
                        </div>
                    </div>
                    ` : ''}
                    
                    <!-- Summary Stats -->
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin-bottom:25px;">
                        <div style="background:rgba(0,255,136,0.1);padding:15px;border-radius:8px;text-align:center;">
                            <div style="font-size:28px;font-weight:bold;color:#00ff88;">${entryAnalysis.total > 0 ? entryAnalysis.winRate.toFixed(0) : '—'}%</div>
                            <div style="font-size:12px;color:#888;margin-top:4px;">Entry Accuracy</div>
                            <div style="font-size:11px;color:#666;">${entryAnalysis.total > 0 ? `${entryAnalysis.wins}/${entryAnalysis.total} trades` : 'No data yet'}</div>
                        </div>
                        <div style="background:rgba(0,217,255,0.1);padding:15px;border-radius:8px;text-align:center;">
                            <div style="font-size:28px;font-weight:bold;color:#00d9ff;">${checkupAnalysis.total > 0 ? checkupAnalysis.accuracy.toFixed(0) : '—'}%</div>
                            <div style="font-size:12px;color:#888;margin-top:4px;">Checkup Accuracy</div>
                            <div style="font-size:11px;color:#666;">${checkupAnalysis.total > 0 ? `${checkupAnalysis.correct}/${checkupAnalysis.total} calls` : 'No data yet'}</div>
                        </div>
                        <div style="background:rgba(255,170,0,0.1);padding:15px;border-radius:8px;text-align:center;">
                            <div style="font-size:28px;font-weight:bold;color:#ffaa00;">${calibrationAnalysis.error.toFixed(0)}%</div>
                            <div style="font-size:12px;color:#888;margin-top:4px;">Calibration Error</div>
                            <div style="font-size:11px;color:#666;">Lower is better</div>
                        </div>
                    </div>
                    
                    <!-- Entry Analysis -->
                    <div style="background:rgba(0,0,0,0.2);padding:15px;border-radius:8px;margin-bottom:15px;">
                        <h3 style="color:#00ff88;margin:0 0 12px 0;font-size:14px;">📥 Entry Predictions</h3>
                        <div style="color:#aaa;font-size:13px;line-height:1.6;">
                            AI recommended entering <b>${entryAnalysis.total}</b> trades with an average confidence of <b>${entryAnalysis.avgConfidence.toFixed(0)}%</b>.<br>
                            <b style="color:#00ff88;">${entryAnalysis.wins} won</b> (profitable) · <b style="color:#ff5252;">${entryAnalysis.losses} lost</b>
                            ${entryAnalysis.avgWinPnL > 0 ? `<br>Avg win: <span style="color:#00ff88;">+$${entryAnalysis.avgWinPnL.toFixed(0)}</span> · Avg loss: <span style="color:#ff5252;">-$${Math.abs(entryAnalysis.avgLossPnL).toFixed(0)}</span>` : ''}
                        </div>
                    </div>
                    
                    <!-- Checkup Analysis -->
                    <div style="background:rgba(0,0,0,0.2);padding:15px;border-radius:8px;margin-bottom:15px;">
                        <h3 style="color:#00d9ff;margin:0 0 12px 0;font-size:14px;">🔍 Checkup Recommendations</h3>
                        <div style="color:#aaa;font-size:13px;line-height:1.6;">
                            ${checkupAnalysis.total === 0 ? 'No checkup data yet. Run AI Checkups on open positions to build this data.' : `
                            AI gave <b>${checkupAnalysis.total}</b> checkup recommendations.<br>
                            <b>HOLD</b>: ${checkupAnalysis.holdCorrect}/${checkupAnalysis.holdTotal} correct (${checkupAnalysis.holdTotal > 0 ? ((checkupAnalysis.holdCorrect/checkupAnalysis.holdTotal)*100).toFixed(0) : 0}%)<br>
                            <b>ROLL</b>: ${checkupAnalysis.rollCorrect}/${checkupAnalysis.rollTotal} correct (${checkupAnalysis.rollTotal > 0 ? ((checkupAnalysis.rollCorrect/checkupAnalysis.rollTotal)*100).toFixed(0) : 0}%)<br>
                            <b>CLOSE</b>: ${checkupAnalysis.closeCorrect}/${checkupAnalysis.closeTotal} correct (${checkupAnalysis.closeTotal > 0 ? ((checkupAnalysis.closeCorrect/checkupAnalysis.closeTotal)*100).toFixed(0) : 0}%)
                            `}
                        </div>
                    </div>
                    
                    <!-- Probability Calibration -->
                    <div style="background:rgba(0,0,0,0.2);padding:15px;border-radius:8px;margin-bottom:15px;">
                        <h3 style="color:#ffaa00;margin:0 0 12px 0;font-size:14px;">🎯 Probability Calibration</h3>
                        <div style="color:#aaa;font-size:13px;line-height:1.6;">
                            ${calibrationAnalysis.buckets.length === 0 ? 'Not enough data for calibration analysis.' : `
                            How well do AI probability predictions match reality?<br><br>
                            ${calibrationAnalysis.buckets.map(b => `
                                <div style="display:flex;align-items:center;margin:4px 0;">
                                    <span style="width:80px;">AI said ${b.range}:</span>
                                    <span style="flex:1;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;margin:0 8px;">
                                        <span style="display:block;height:100%;width:${b.actual}%;background:${Math.abs(b.predicted - b.actual) <= 10 ? '#00ff88' : '#ffaa00'};"></span>
                                    </span>
                                    <span style="width:100px;font-size:11px;">${b.actual.toFixed(0)}% actual (${b.count} trades)</span>
                                </div>
                            `).join('')}
                            <div style="margin-top:10px;font-size:11px;color:#666;">
                                Perfect calibration = predicted % matches actual win rate
                            </div>
                            `}
                        </div>
                    </div>
                    
                    <!-- Misses List -->
                    ${entryAnalysis.misses.length > 0 ? `
                    <div style="background:rgba(255,82,82,0.1);padding:15px;border-radius:8px;">
                        <h3 style="color:#ff5252;margin:0 0 12px 0;font-size:14px;">❌ AI Misses (Losses on High-Confidence Entries)</h3>
                        <div style="color:#aaa;font-size:12px;">
                            ${entryAnalysis.misses.slice(0, 5).map(m => `
                                <div style="padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:6px;">
                                    <b>${m.ticker}</b> ${m.strike}${m.type.includes('put') ? 'P' : 'C'} - AI: ${m.confidence}% conf → <span style="color:#ff5252;">-$${Math.abs(m.pnl).toFixed(0)}</span>
                                    ${m.closeReason ? `<span style="color:#888;"> (${m.closeReason})</span>` : ''}
                                </div>
                            `).join('')}
                            ${entryAnalysis.misses.length > 5 ? `<div style="color:#666;font-size:11px;margin-top:8px;">+${entryAnalysis.misses.length - 5} more...</div>` : ''}
                        </div>
                    </div>
                    ` : ''}
                `}
            </div>
            
            <div style="padding:15px 20px;border-top:1px solid rgba(255,255,255,0.1);text-align:center;">
                <div style="font-size:11px;color:#666;">
                    ${hasData ? `Based on ${totalWithAI.length} closed positions with AI data` : 'Data collected from Discord Analyzer entries and AI Checkups'}
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Analyze entry accuracy - AI recommended entering, did it profit?
 */
function analyzeEntryAccuracy(positions) {
    const result = {
        total: positions.length,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgConfidence: 0,
        avgWinPnL: 0,
        avgLossPnL: 0,
        misses: []
    };
    
    if (positions.length === 0) return result;
    
    let totalConfidence = 0;
    let winPnLSum = 0;
    let lossPnLSum = 0;
    
    positions.forEach(pos => {
        const confidence = pos.openingThesis?.aiSummary?.probability || pos.openingThesis?.probability || 50;
        const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
        
        totalConfidence += confidence;
        
        if (pnl >= 0) {
            result.wins++;
            winPnLSum += pnl;
        } else {
            result.losses++;
            lossPnLSum += pnl;
            
            // Track high-confidence misses
            if (confidence >= 70) {
                result.misses.push({
                    ticker: pos.ticker,
                    strike: pos.strike || pos.sellStrike,
                    type: pos.type,
                    confidence: confidence,
                    pnl: pnl,
                    closeReason: pos.closeReason
                });
            }
        }
    });
    
    result.avgConfidence = totalConfidence / positions.length;
    result.winRate = (result.wins / positions.length) * 100;
    result.avgWinPnL = result.wins > 0 ? winPnLSum / result.wins : 0;
    result.avgLossPnL = result.losses > 0 ? lossPnLSum / result.losses : 0;
    
    // Sort misses by confidence (highest first)
    result.misses.sort((a, b) => b.confidence - a.confidence);
    
    return result;
}

/**
 * Analyze checkup accuracy - AI said HOLD/ROLL/CLOSE, was it right?
 */
function analyzeCheckupAccuracy(positions) {
    const result = {
        total: 0,
        correct: 0,
        accuracy: 0,
        holdTotal: 0, holdCorrect: 0,
        rollTotal: 0, rollCorrect: 0,
        closeTotal: 0, closeCorrect: 0
    };
    
    positions.forEach(pos => {
        if (!pos.analysisHistory || pos.analysisHistory.length === 0) return;
        
        const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
        const closeReason = pos.closeReason || '';
        
        pos.analysisHistory.forEach(analysis => {
            const rec = (analysis.recommendation || '').toUpperCase();
            if (!rec) return;
            
            result.total++;
            
            if (rec === 'HOLD' || rec.includes('HOLD')) {
                result.holdTotal++;
                // HOLD is correct if it eventually profited or expired worthless
                if (pnl >= 0 || closeReason === 'expired') {
                    result.holdCorrect++;
                    result.correct++;
                }
            } else if (rec === 'ROLL' || rec.includes('ROLL')) {
                result.rollTotal++;
                // ROLL is correct if the position was rolled or if holding would have lost more
                // For now, we consider it correct if closeReason was 'rolled'
                if (closeReason === 'rolled') {
                    result.rollCorrect++;
                    result.correct++;
                }
            } else if (rec === 'CLOSE' || rec.includes('CLOSE')) {
                result.closeTotal++;
                // CLOSE is correct if it was closed early (not expired/assigned)
                // This is harder to evaluate without knowing what happened after
                if (closeReason === 'closed') {
                    result.closeCorrect++;
                    result.correct++;
                }
            }
        });
    });
    
    result.accuracy = result.total > 0 ? (result.correct / result.total) * 100 : 0;
    
    return result;
}

/**
 * Analyze probability calibration - AI said X% chance, actual rate?
 */
function analyzeCalibration(positions) {
    const result = {
        buckets: [],
        error: 0
    };
    
    if (positions.length < 5) return result;
    
    // Group by probability buckets
    const buckets = {
        '60-70%': { predicted: 65, wins: 0, total: 0 },
        '70-80%': { predicted: 75, wins: 0, total: 0 },
        '80-90%': { predicted: 85, wins: 0, total: 0 },
        '90%+': { predicted: 95, wins: 0, total: 0 }
    };
    
    positions.forEach(pos => {
        const confidence = pos.openingThesis?.aiSummary?.probability || pos.openingThesis?.probability || 50;
        const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
        const won = pnl >= 0;
        
        if (confidence >= 90) {
            buckets['90%+'].total++;
            if (won) buckets['90%+'].wins++;
        } else if (confidence >= 80) {
            buckets['80-90%'].total++;
            if (won) buckets['80-90%'].wins++;
        } else if (confidence >= 70) {
            buckets['70-80%'].total++;
            if (won) buckets['70-80%'].wins++;
        } else if (confidence >= 60) {
            buckets['60-70%'].total++;
            if (won) buckets['60-70%'].wins++;
        }
    });
    
    // Calculate actual rates and calibration error
    let totalError = 0;
    let bucketCount = 0;
    
    Object.entries(buckets).forEach(([range, data]) => {
        if (data.total >= 2) {
            const actual = (data.wins / data.total) * 100;
            result.buckets.push({
                range: range,
                predicted: data.predicted,
                actual: actual,
                count: data.total
            });
            totalError += Math.abs(data.predicted - actual);
            bucketCount++;
        }
    });
    
    result.error = bucketCount > 0 ? totalError / bucketCount : 0;
    
    return result;
}

// ============================================================
// AI PORTFOLIO AUDIT
// ============================================================

/**
 * Run AI portfolio audit - analyzes all positions for problems and recommendations
 */
window.runPortfolioAudit = async function() {
    const btn = document.getElementById('aiPortfolioAuditBtn');
    if (btn) {
        btn.textContent = '⏳ Analyzing...';
        btn.disabled = true;
    }
    
    try {
        // First refresh Greeks to get latest data
        const greeks = await updatePortfolioGreeks();
        
        // Get advanced analytics stats
        const closed = state.closedPositions || [];
        const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
        const wins = closed.filter(p => getPnL(p) > 0);
        const losses = closed.filter(p => getPnL(p) < 0);
        const totalWins = wins.reduce((sum, p) => sum + getPnL(p), 0);
        const totalLosses = Math.abs(losses.reduce((sum, p) => sum + getPnL(p), 0));
        const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
        const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
        const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;
        
        // Build position data with risk and Greeks
        const positions = (state.positions || []).filter(p => p.status === 'open').map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            expiry: p.expiry,
            dte: p.dte,
            contracts: p.contracts,
            premium: p.premium,
            delta: p._delta || 0,
            theta: p._theta || 0,
            riskPercent: parseFloat(document.getElementById(`risk-cell-${p.id}`)?.textContent?.match(/\\d+/)?.[0] || 0)
        }));
        
        // Get selected AI model
        const modelSelect = document.getElementById('aiModelSelect');
        const selectedModel = modelSelect?.value || 'qwen2.5:14b';
        
        // Call AI audit endpoint
        const res = await fetch('/api/ai/portfolio-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                positions,
                greeks: {
                    delta: greeks?.delta || 0,
                    theta: greeks?.theta || 0,
                    gamma: greeks?.gamma || 0,
                    vega: greeks?.vega || 0,
                    avgIV: greeks?.avgIV || 0,
                    avgIVRank: greeks?.avgIVRank || 0
                },
                closedStats: {
                    winRate,
                    profitFactor,
                    avgWin,
                    avgLoss,
                    totalTrades: closed.length
                }
            })
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'AI audit failed');
        }
        
        const result = await res.json();
        
        // ============================================================
        // SAVE PORTFOLIO CONTEXT for future trade analysis
        // ============================================================
        const tickerCounts = {};
        positions.forEach(p => {
            tickerCounts[p.ticker] = (tickerCounts[p.ticker] || 0) + 1;
        });
        
        const portfolioContext = {
            timestamp: new Date().toISOString(),
            positionCount: positions.length,
            greeks: {
                netDelta: greeks?.delta || 0,
                dailyTheta: greeks?.theta || 0,
                vega: greeks?.vega || 0,
                avgIV: greeks?.avgIV || 0,
                avgIVRank: greeks?.avgIVRank || 0
            },
            concentration: tickerCounts,
            concentrationWarnings: Object.entries(tickerCounts)
                .filter(([_, count]) => count >= 2)
                .map(([ticker, count]) => `${ticker} (${count} positions)`),
            stats: {
                winRate,
                profitFactor,
                avgWin,
                avgLoss
            },
            // Extract key issues from audit
            auditSummary: extractAuditSummary(result.audit)
        };
        
        localStorage.setItem('wheelhouse_portfolio_context', JSON.stringify(portfolioContext));
        console.log('[PORTFOLIO] Saved portfolio context for trade analysis:', portfolioContext);
        
        // Show audit results in modal
        showAuditModal(result.audit, result.model);
        
    } catch (err) {
        console.error('Portfolio audit failed:', err);
        showNotification('AI audit failed: ' + err.message, 'error');
    } finally {
        if (btn) {
            btn.textContent = '🤖 AI Portfolio Audit';
            btn.disabled = false;
        }
    }
};

/**
 * Display audit results in a modal
 */
function showAuditModal(audit, model) {
    // Parse markdown-style formatting
    const formatAudit = (text) => {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/^### (.*?)$/gm, '<h3 style="color:#8b5cf6;margin:15px 0 8px 0;">$1</h3>')
            .replace(/^## (.*?)$/gm, '<h2 style="color:#ffaa00;margin:18px 0 10px 0;">$1</h2>')
            .replace(/^# (.*?)$/gm, '<h1 style="color:#fff;margin:20px 0 12px 0;">$1</h1>')
            .replace(/^- (.*?)$/gm, '<div style="margin-left:15px;margin-bottom:4px;">• $1</div>')
            .replace(/^(\d+)\. (.*?)$/gm, '<div style="margin-left:15px;margin-bottom:4px;">$1. $2</div>')
            .replace(/\n\n/g, '<br><br>')
            .replace(/\n/g, '<br>');
    };
    
    const modal = createModal('portfolioAuditModal');
    modal.innerHTML = `
        <div style="background:#1a1a2e; border:1px solid rgba(139,92,246,0.5); border-radius:10px; max-width:700px; max-height:85vh; overflow:hidden; display:flex; flex-direction:column;">
            ${modalHeader('🤖 AI Portfolio Audit', 'portfolioAuditModal')}
            <div style="padding:20px; overflow-y:auto; flex:1;">
                <div style="background:rgba(139,92,246,0.1); padding:8px 12px; border-radius:6px; font-size:11px; color:#888; margin-bottom:15px;">
                    Model: <span style="color:#8b5cf6;">${model}</span>
                </div>
                <div style="color:#ddd; line-height:1.6; font-size:13px;">
                    ${formatAudit(audit)}
                </div>
            </div>
            <div style="padding:15px; border-top:1px solid rgba(255,255,255,0.1); text-align:right;">
                <button onclick="document.getElementById('portfolioAuditModal').remove()" style="background:rgba(139,92,246,0.3); border:1px solid rgba(139,92,246,0.5); color:#fff; padding:8px 20px; border-radius:6px; cursor:pointer;">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

/**
 * Extract key points from audit for storage
 */
function extractAuditSummary(auditText) {
    // Extract key issues mentioned
    const issues = [];
    const recommendations = [];
    
    // Look for tickers mentioned with problems
    const problemMatch = auditText.match(/PROBLEM.*?(?=⚠️|📊|💡|✅|$)/s);
    if (problemMatch) {
        const tickersInProblems = problemMatch[0].match(/[A-Z]{2,5}/g) || [];
        issues.push(...tickersInProblems.filter(t => t !== 'ITM' && t !== 'DTE' && t !== 'OTM'));
    }
    
    // Look for concentration warnings
    const concMatch = auditText.match(/CONCENTRATION.*?(?=📊|💡|✅|$)/s);
    if (concMatch && concMatch[0].toLowerCase().includes('risk')) {
        const tickersInConc = concMatch[0].match(/[A-Z]{2,5}/g) || [];
        recommendations.push(`Concentration risk in: ${tickersInConc.filter(t => t !== 'CONCENTRATION' && t !== 'RISKS').join(', ')}`);
    }
    
    // Delta direction
    const deltaDirection = auditText.toLowerCase().includes('bearish') ? 'bearish' : 
                          auditText.toLowerCase().includes('bullish') ? 'bullish' : 'neutral';
    
    return {
        problemTickers: [...new Set(issues)],
        recommendations: recommendations.slice(0, 3),
        deltaDirection,
        hasHighIV: auditText.toLowerCase().includes('high') && auditText.toLowerCase().includes('iv')
    };
}

/**
 * Get stored portfolio context for trade analysis
 * Called by other modules when evaluating new trades
 */
export function getPortfolioContext() {
    try {
        const stored = localStorage.getItem('wheelhouse_portfolio_context');
        if (stored) {
            const context = JSON.parse(stored);
            // Check if context is recent (within 24 hours)
            const age = Date.now() - new Date(context.timestamp).getTime();
            if (age < 24 * 60 * 60 * 1000) {
                return context;
            }
        }
    } catch (e) {
        console.warn('Failed to load portfolio context:', e);
    }
    return null;
}

/**
 * Format portfolio context for AI prompts
 */
export function formatPortfolioContextForAI() {
    const ctx = getPortfolioContext();
    if (!ctx) return '';
    
    const lines = [
        `\n## CURRENT PORTFOLIO CONTEXT (from last audit ${new Date(ctx.timestamp).toLocaleDateString()})`,
        `- ${ctx.positionCount} open positions`,
        `- Net Delta: ${ctx.greeks.netDelta.toFixed(0)} (${ctx.auditSummary?.deltaDirection || 'unknown'} bias)`,
        `- Daily Theta: $${ctx.greeks.dailyTheta.toFixed(2)}`,
        `- Avg IV Rank: ${ctx.greeks.avgIVRank?.toFixed(0) || '?'}%`
    ];
    
    if (ctx.concentrationWarnings?.length > 0) {
        lines.push(`- ⚠️ CONCENTRATION: ${ctx.concentrationWarnings.join(', ')}`);
    }
    
    if (ctx.auditSummary?.problemTickers?.length > 0) {
        lines.push(`- ⚠️ PROBLEM TICKERS: ${ctx.auditSummary.problemTickers.join(', ')}`);
    }
    
    lines.push('', '**Consider how this new trade affects portfolio balance.**');
    
    return lines.join('\n');
}
