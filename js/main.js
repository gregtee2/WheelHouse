// WheelHouse - Main Entry Point
// Initialization and tab management

import { state, resetSimulation, setAccountMode, updatePaperModeIndicator, setPaperAccountBalance, getPaperAccountBalance, setSelectedAccount, getAccountDisplayName } from './state.js';
import { draw, drawPayoffChart, drawHistogram, drawPnLChart, drawProbabilityCone, drawHeatMap, drawGreeksChart } from './charts.js';
import { runSingle, runBatch, resetAll } from './simulation.js';
import { priceOptions, calcGreeks } from './pricing.js';
import { calculateRoll, generateRecommendation, suggestOptimalRoll } from './analysis.js';
import { fetchTickerPrice, fetchHeatMapPrice, fetchPositionTickerPrice } from './api.js';
import { loadPositions, addPosition, editPosition, cancelEdit, renderPositions, updatePortfolioSummary } from './positions.js';
import { loadClosedPositions, renderPortfolio, renderHoldings, formatPortfolioContextForAI } from './portfolio.js';
import { initChallenges, renderChallenges } from './challenges.js';
import { setupSliders, setupDatePicker, setupPositionDatePicker, setupRollDatePicker, updateDteDisplay, updateResults, updateDataTab, syncToSimulator } from './ui.js';
import { showNotification } from './utils.js';
import AccountService from './services/AccountService.js';
import TradeCardService from './services/TradeCardService.js';  // For staging trades to Ideas tab

/**
 * Switch between Real and Paper trading accounts
 * LEGACY: Kept for backwards compatibility, now redirects to handleAccountChange
 */
window.switchAccountMode = function(mode) {
    if (mode === 'paper') {
        handleAccountChange('paper');
    } else {
        // For 'real', we need an account selected - just ignore this old call
        console.log('[Account] Legacy switchAccountMode called with:', mode);
    }
};

// =============================================================================
// MULTI-ACCOUNT SYSTEM
// =============================================================================

/**
 * Initialize account dropdown on page load
 * Fetches available Schwab accounts and populates the dropdown
 */
async function initAccountDropdown() {
    const select = document.getElementById('accountModeSelect');
    if (!select) return;
    
    select.innerHTML = '<option value="loading" disabled selected>Loading...</option>';
    
    try {
        // Fetch account numbers and full account data
        const [numbersRes, accountsRes] = await Promise.all([
            fetch('/api/schwab/accounts/numbers'),
            fetch('/api/schwab/accounts')
        ]);
        
        // Build dropdown options
        select.innerHTML = '';
        
        // Always add Paper Trading option first
        const paperOpt = document.createElement('option');
        paperOpt.value = 'paper';
        paperOpt.textContent = '📝 Paper Trading';
        select.appendChild(paperOpt);
        
        // Add separator
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '── Schwab Accounts ──';
        select.appendChild(sep);
        
        if (numbersRes.ok && accountsRes.ok) {
            const numbers = await numbersRes.json();
            const accounts = await accountsRes.json();
            
            state.availableAccounts = [];
            
            for (const num of (numbers || [])) {
                const fullAcct = accounts.find(a => a.securitiesAccount?.accountNumber === num.accountNumber);
                const type = fullAcct?.securitiesAccount?.type || 'Account';
                const bal = fullAcct?.securitiesAccount?.currentBalances;
                const equity = bal?.equity || bal?.liquidationValue || 0;
                const posCount = fullAcct?.securitiesAccount?.positions?.length || 0;
                
                const acctData = {
                    accountNumber: num.accountNumber,
                    hashValue: num.hashValue,
                    type: type,
                    equity: equity,
                    positionCount: posCount,
                    nickname: localStorage.getItem(`wheelhouse_acct_nickname_${num.accountNumber}`) || ''
                };
                state.availableAccounts.push(acctData);
                
                const opt = document.createElement('option');
                opt.value = num.accountNumber;
                opt.dataset.hash = num.hashValue;
                opt.dataset.type = type;
                
                const nickname = acctData.nickname ? ` "${acctData.nickname}"` : '';
                const equityStr = equity > 0 ? ` ($${Math.round(equity/1000)}k)` : '';
                opt.textContent = `${type === 'MARGIN' ? '💰' : type === 'IRA' ? '🏦' : '📊'} ${type} ...${num.accountNumber.slice(-4)}${nickname}${equityStr}`;
                
                select.appendChild(opt);
            }
        } else {
            // Schwab not connected - add message option
            const noAcct = document.createElement('option');
            noAcct.value = '';
            noAcct.disabled = true;
            noAcct.textContent = '⚠️ Connect Schwab in Settings';
            select.appendChild(noAcct);
        }
        
        // Restore saved selection
        if (state.accountMode === 'paper') {
            select.value = 'paper';
            showPaperModeUI(true);
        } else if (state.selectedAccount?.accountNumber) {
            select.value = state.selectedAccount.accountNumber;
            showPaperModeUI(false);
        } else {
            // Default to first real account if available
            const firstRealAcct = state.availableAccounts[0];
            if (firstRealAcct) {
                select.value = firstRealAcct.accountNumber;
                handleAccountChange(firstRealAcct.accountNumber, false); // Don't sync on first load
            } else {
                select.value = 'paper';
            }
        }
        
    } catch (e) {
        console.error('[Account] Failed to load accounts:', e);
        select.innerHTML = `
            <option value="paper">📝 Paper Trading</option>
            <option disabled>── Schwab Accounts ──</option>
            <option value="" disabled>⚠️ Error loading accounts</option>
        `;
        select.value = 'paper';
    }
}

/**
 * Handle account dropdown change
 * @param {string} value - 'paper' or accountNumber
 * @param {boolean} autoSync - Whether to auto-sync from Schwab (default true)
 */
window.handleAccountChange = async function(value, autoSync = true) {
    const select = document.getElementById('accountModeSelect');
    const syncBtn = document.getElementById('syncAccountBtn');
    
    if (value === 'paper') {
        // Switch to paper trading
        setAccountMode('paper');
        setSelectedAccount(null);
        showPaperModeUI(true);
        
        // Load paper positions
        loadPositions();
        loadClosedPositions();
        renderPortfolio();
        renderHoldings();
        initChallenges();
        
        // Show paper balance
        const bp = getPaperAccountBalance();
        updateBalanceDisplay(bp, bp, 0, 0, 0, 'Paper', 'PAPER');
        
        showNotification(`📝 Switched to Paper Trading - $${bp.toLocaleString()} balance`, 'info');
        
    } else {
        // Switch to a real Schwab account
        const acct = state.availableAccounts.find(a => a.accountNumber === value);
        if (!acct) {
            console.error('[Account] Account not found:', value);
            return;
        }
        
        setAccountMode('real');
        setSelectedAccount(acct);
        showPaperModeUI(false);
        
        // Load saved positions for this account (from localStorage)
        loadPositions();
        loadClosedPositions();
        renderPortfolio();
        renderHoldings();
        initChallenges();
        
        // Fetch fresh balances for this account
        await fetchAccountBalancesForAccount(acct);
        
        // Auto-sync from Schwab if requested and no local positions exist
        const currentPositions = state.positions || [];
        if (autoSync && currentPositions.length === 0) {
            showNotification(`🔄 New account detected - syncing from Schwab...`, 'info');
            await refreshAccountFromSchwab();
        } else if (autoSync) {
            showNotification(`💰 Switched to ${acct.type} ...${acct.accountNumber.slice(-4)} (${currentPositions.length} positions)`, 'success');
        }
    }
};

/**
 * Show/hide paper mode UI elements
 */
function showPaperModeUI(isPaper) {
    const paperBtn = document.getElementById('setPaperBalanceBtn');
    const syncBtn = document.getElementById('syncAccountBtn');
    const accountDiv = document.getElementById('accountSwitcherHeader');
    
    if (paperBtn) paperBtn.style.display = isPaper ? 'inline-block' : 'none';
    if (syncBtn) syncBtn.style.display = isPaper ? 'none' : 'inline-block';
    
    // Update border color
    if (accountDiv) {
        accountDiv.style.borderColor = isPaper ? '#8b5cf6' : '#333';
    }
    
    updatePaperModeIndicator();
}

/**
 * Fetch and display balances for a specific account
 */
async function fetchAccountBalancesForAccount(acct) {
    try {
        const res = await fetch(`/api/schwab/accounts/${acct.hashValue}?fields=positions`);
        if (!res.ok) return;
        
        const data = await res.json();
        const bal = data.securitiesAccount?.currentBalances || {};
        
        updateBalanceDisplay(
            bal.buyingPower || 0,
            bal.equity || bal.liquidationValue || 0,
            bal.availableFunds || bal.cashBalance || 0,
            bal.marginBalance || 0,
            bal.dayTradingBuyingPower || 0,
            acct.type,
            acct.accountNumber
        );
        
        // Update AccountService cache
        AccountService.updateCache({
            buyingPower: bal.buyingPower,
            accountValue: bal.equity || bal.liquidationValue,
            cashAvailable: bal.availableFunds || bal.cashBalance,
            marginUsed: bal.marginBalance,
            dayTradeBP: bal.dayTradingBuyingPower,
            accountType: acct.type,
            accountNumber: acct.accountNumber
        });
        
    } catch (e) {
        console.error('[Account] Failed to fetch balances:', e);
    }
}

/**
 * Update the balance display in the banner
 */
function updateBalanceDisplay(buyingPower, accountValue, cashAvailable, marginUsed, dayTradeBP, type, accountNumber) {
    const fmt = (v) => {
        if (v === undefined || v === null) return '—';
        return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    
    const balBP = document.getElementById('balBuyingPower');
    const balValue = document.getElementById('balAccountValue');
    const balCash = document.getElementById('balCashAvailable');
    const balMargin = document.getElementById('balMarginUsed');
    const balDayTrade = document.getElementById('balDayTradeBP');
    const balUpdated = document.getElementById('balanceLastUpdated');
    
    if (balBP) balBP.textContent = fmt(buyingPower);
    if (balValue) balValue.textContent = fmt(accountValue);
    if (balCash) balCash.textContent = fmt(cashAvailable);
    if (balMargin) balMargin.textContent = fmt(marginUsed);
    if (balDayTrade) balDayTrade.textContent = fmt(dayTradeBP);
    
    if (balUpdated) {
        const now = new Date();
        const lastDigits = accountNumber ? `...${accountNumber.slice(-4)}` : '';
        balUpdated.innerHTML = `
            <span style="color:#00d9ff;">${type}</span> ${lastDigits} · Updated ${now.toLocaleTimeString()}
        `;
    }
    
    // Show banner if hidden
    const banner = document.getElementById('accountBalancesBanner');
    if (banner) banner.style.display = 'block';
}

/**
 * Refresh positions from Schwab for current account
 */
window.refreshAccountFromSchwab = async function() {
    if (state.accountMode === 'paper') {
        showNotification('📝 Paper trading mode - no Schwab sync needed', 'info');
        return;
    }
    
    const acct = state.selectedAccount;
    if (!acct) {
        showNotification('⚠️ No account selected', 'error');
        return;
    }
    
    console.log('[Sync] Starting sync for account:', acct.accountNumber, 'hash:', acct.hashValue);
    
    const syncBtn = document.getElementById('syncAccountBtn');
    if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = '⏳ Syncing...';
    }
    
    try {
        // Use SchwabAPI to fetch and normalize positions
        if (!window.SchwabAPI) {
            throw new Error('SchwabAPI not loaded');
        }
        
        console.log('[Sync] Fetching positions with hash:', acct.hashValue);
        const parsed = await window.SchwabAPI.getPositions(acct.hashValue);
        console.log('[Sync] Received positions:', parsed?.length || 0, parsed);
        
        if (!parsed || parsed.length === 0) {
            showNotification(`ℹ️ No positions found in Schwab account ...${acct.accountNumber.slice(-4)}`, 'info');
            if (syncBtn) {
                syncBtn.disabled = false;
                syncBtn.textContent = '🔄 Sync';
            }
            return;
        }
        
        // Separate options from stocks
        const optionPositions = parsed.filter(p => p.type !== 'stock');
        const stockPositions = parsed.filter(p => p.type === 'stock');
        
        console.log('[Sync] Options:', optionPositions.length, 'Stocks:', stockPositions.length);
        
        // Get current saved positions for this account
        let existingPositions = [...(state.positions || [])];
        let existingHoldings = [...(state.holdings || [])];
        
        let imported = 0, skipped = 0, holdingsImported = 0;
        
        // Import option positions
        for (const schwabPos of optionPositions) {
            const existingMatch = existingPositions.find(p => 
                p.ticker === schwabPos.ticker &&
                p.strike === schwabPos.strike &&
                p.expiry === schwabPos.expiry &&
                p.status !== 'closed'
            );
            
            if (existingMatch) {
                // Update prices but preserve user data
                existingMatch.lastOptionPrice = schwabPos.currentPrice || existingMatch.lastOptionPrice;
                existingMatch.markedPrice = schwabPos.currentPrice || existingMatch.markedPrice;
                existingMatch.contracts = schwabPos.contracts;
                skipped++;
            } else {
                // New position
                const newPosition = {
                    id: Date.now() + imported,
                    chainId: Date.now() + imported,
                    ticker: schwabPos.ticker,
                    type: schwabPos.type,
                    strike: schwabPos.strike,
                    contracts: schwabPos.contracts,
                    premium: schwabPos.averagePrice,
                    expiry: schwabPos.expiry,
                    openDate: new Date().toISOString().split('T')[0],
                    status: 'open',
                    broker: 'Schwab',
                    source: 'schwab_sync',
                    schwabSymbol: schwabPos.symbol,
                    lastOptionPrice: schwabPos.currentPrice || null,
                    markedPrice: schwabPos.currentPrice || null
                };
                
                // Calculate DTE
                const expiryDate = new Date(schwabPos.expiry + 'T16:00:00');
                const now = new Date();
                newPosition.dte = Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)));
                
                existingPositions.push(newPosition);
                imported++;
            }
        }
        
        // Import stock holdings
        for (const schwabStock of stockPositions) {
            const existingHolding = existingHoldings.find(h => h.ticker === schwabStock.ticker);
            
            if (existingHolding) {
                existingHolding.shares = schwabStock.shares;
                existingHolding.costBasis = schwabStock.averagePrice;
                existingHolding.totalCost = schwabStock.shares * schwabStock.averagePrice;
                existingHolding.currentPrice = schwabStock.currentPrice;
                existingHolding.marketValue = schwabStock.marketValue;
            } else {
                const newHolding = {
                    id: Date.now() + imported + holdingsImported,
                    ticker: schwabStock.ticker,
                    shares: schwabStock.shares,
                    costBasis: schwabStock.averagePrice,
                    totalCost: schwabStock.shares * schwabStock.averagePrice,
                    currentPrice: schwabStock.currentPrice,
                    marketValue: schwabStock.marketValue,
                    source: 'schwab_sync',
                    acquiredDate: new Date().toISOString().split('T')[0]
                };
                existingHoldings.push(newHolding);
            }
            holdingsImported++;
        }
        
        // Save to account-specific storage
        state.positions = existingPositions;
        state.holdings = existingHoldings;
        
        const { getPositionsKey, getHoldingsKey } = await import('./state.js');
        localStorage.setItem(getPositionsKey(), JSON.stringify(existingPositions));
        localStorage.setItem(getHoldingsKey(), JSON.stringify(existingHoldings));
        
        // Refresh UI
        loadPositions();
        renderHoldings();
        await fetchAccountBalancesForAccount(acct);
        
        // Show result
        const msg = [];
        if (imported > 0) msg.push(`${imported} new positions`);
        if (skipped > 0) msg.push(`${skipped} updated`);
        if (holdingsImported > 0) msg.push(`${holdingsImported} holdings`);
        
        showNotification(`✅ Schwab Sync: ${msg.join(', ') || 'No changes'}`, 'success');
        
    } catch (e) {
        console.error('[Account] Sync error:', e);
        showNotification(`❌ Sync failed: ${e.message}`, 'error');
    } finally {
        if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.textContent = '🔄 Sync';
        }
    }
};

/**
 * Set paper account starting balance
 */
window.setPaperBalance = function() {
    const currentBalance = getPaperAccountBalance();
    const input = prompt('Enter paper trading starting balance ($):', currentBalance.toString());
    if (input === null) return;
    
    const newBalance = parseFloat(input.replace(/[,$]/g, ''));
    if (isNaN(newBalance) || newBalance <= 0) {
        showNotification('Invalid amount. Please enter a positive number.', 'error');
        return;
    }
    
    setPaperAccountBalance(newBalance);
    
    // Update display if in paper mode
    if (state.accountMode === 'paper') {
        const balBP = document.getElementById('balBuyingPower');
        const balValue = document.getElementById('balAccountValue');
        if (balBP) balBP.textContent = `$${newBalance.toLocaleString()}`;
        if (balValue) balValue.textContent = `$${newBalance.toLocaleString()}`;
    }
    
    showNotification(`📝 Paper account balance set to $${newBalance.toLocaleString()}`, 'success');
};

// =============================================================================
// GLOBAL AI MODEL SELECTOR
// =============================================================================

/**
 * Get the currently selected AI model
 * Priority: local override (if set to non-default) > global selector > hardcoded default
 * @param {string} localSelectId - Optional ID of local override selector
 * @returns {string} The model name to use
 */
window.getSelectedAIModel = function(localSelectId = null) {
    // Check local override first (if provided and has a non-empty value)
    if (localSelectId) {
        const localSelect = document.getElementById(localSelectId);
        if (localSelect && localSelect.value) {
            return localSelect.value;
        }
    }
    
    // Fall back to global selector
    const globalSelect = document.getElementById('globalAiModelSelect');
    if (globalSelect && globalSelect.value) {
        return globalSelect.value;
    }
    
    // Final fallback
    return 'qwen2.5:14b';
};

/**
 * Save global AI model preference to localStorage
 */
window.saveGlobalAIModel = function() {
    const select = document.getElementById('globalAiModelSelect');
    if (select) {
        localStorage.setItem('wheelhouse_global_ai_model', select.value);
        showNotification(`🧠 Default AI model set to ${select.value}`, 'info', 2000);
    }
};

/**
 * Load global AI model preference on startup
 */
function initGlobalAIModel() {
    const saved = localStorage.getItem('wheelhouse_global_ai_model');
    const select = document.getElementById('globalAiModelSelect');
    if (select && saved) {
        select.value = saved;
    }
}

/**
 * Initialize account mode on page load
 * Now uses the multi-account dropdown system
 */
function initAccountMode() {
    // Initialize multi-account dropdown (async)
    initAccountDropdown().then(() => {
        console.log('[Account] Dropdown initialized');
    }).catch(e => {
        console.error('[Account] Dropdown init failed:', e);
    });
    
    // Show paper mode indicator if in paper mode
    updatePaperModeIndicator();
    
    // If in paper mode, set paper balance display
    if (state.accountMode === 'paper') {
        const bp = getPaperAccountBalance();
        setTimeout(() => {
            updateBalanceDisplay(bp, bp, 0, 0, 0, 'Paper', 'PAPER');
        }, 500);
    }
}

/**
 * Get the next 3rd Friday of the month (standard options expiry)
 * @param {number} monthsAhead - 0 = this month, 1 = next month, etc.
 * @returns {Date} The 3rd Friday date
 */
function getThirdFriday(monthsAhead = 1) {
    const today = new Date();
    let targetMonth = today.getMonth() + monthsAhead;
    let targetYear = today.getFullYear() + Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
    
    // Find 3rd Friday: first day of month, find first Friday, add 14 days
    const firstDay = new Date(targetYear, targetMonth, 1);
    const dayOfWeek = firstDay.getDay();
    const firstFriday = dayOfWeek <= 5 ? (5 - dayOfWeek + 1) : (12 - dayOfWeek + 1);
    const thirdFriday = new Date(targetYear, targetMonth, firstFriday + 14);
    
    // If this month's 3rd Friday already passed, go to next month
    if (thirdFriday <= today && monthsAhead === 0) {
        return getThirdFriday(1);
    }
    
    return thirdFriday;
}

/**
 * Format a date as "Mon DD" (e.g., "Feb 20")
 * @param {Date} date
 * @returns {string}
 */
function formatExpiryShort(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Snap any date string to the nearest valid Friday expiry
 * Options expire on Fridays, never weekends
 * @param {string} dateStr - e.g., "Feb 21" or "Mar 20"
 * @returns {string} Corrected date string, e.g., "Feb 20"
 */
function snapToFriday(dateStr) {
    if (!dateStr) return formatExpiryShort(getThirdFriday(1));
    
    // Parse the date string
    const months = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 
                     'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    const match = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d+)/i);
    if (!match) return dateStr;
    
    const month = months[match[1].toLowerCase()];
    const day = parseInt(match[2]);
    const year = new Date().getFullYear() + (month < new Date().getMonth() ? 1 : 0);
    
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
    
    if (dayOfWeek === 5) {
        return dateStr; // Already Friday
    } else if (dayOfWeek === 6) {
        // Saturday -> go back to Friday
        date.setDate(date.getDate() - 1);
    } else if (dayOfWeek === 0) {
        // Sunday -> go back to Friday
        date.setDate(date.getDate() - 2);
    } else {
        // Weekday -> find nearest Friday (usually go forward)
        const daysToFriday = (5 - dayOfWeek + 7) % 7;
        if (daysToFriday <= 3) {
            date.setDate(date.getDate() + daysToFriday);
        } else {
            date.setDate(date.getDate() - (7 - daysToFriday));
        }
    }
    
    return formatExpiryShort(date);
}

// Expose for use in other places
window.snapToFriday = snapToFriday;
window.getThirdFriday = getThirdFriday;
window.formatExpiryShort = formatExpiryShort;

/**
 * Restart the server
 */
window.restartServer = async function() {
    if (!confirm('Restart the server? The page will reload in a few seconds.')) {
        return;
    }
    
    const btn = document.getElementById('restartServerBtn');
    if (btn) {
        btn.textContent = '⏳ Restarting...';
        btn.disabled = true;
    }
    
    try {
        await fetch('/api/restart', { method: 'POST' });
        showNotification('Server restarting... Page will reload.', 'info');
        
        // Wait for server to restart, then reload
        setTimeout(() => {
            location.reload();
        }, 3000);
    } catch (e) {
        console.error('Restart failed:', e);
        showNotification('Restart failed: ' + e.message, 'error');
        if (btn) {
            btn.textContent = '🔄 Restart';
            btn.disabled = false;
        }
    }
};

/**
 * Main initialization
 */
export function init() {
    console.log('🏠 WheelHouse - Wheel Strategy Options Analyzer');
    
    // Initialize account mode (Real vs Paper trading)
    initAccountMode();
    
    // Initialize global AI model selector
    initGlobalAIModel();
    
    // Setup tabs
    setupTabs();
    
    // Migrate old tab content into new Analyze sub-tabs
    migrateTabContent();
    
    // Setup sliders and controls
    setupSliders();
    setupDatePicker();
    setupPositionDatePicker();
    setupRollDatePicker();
    
    // Setup buttons
    setupButtons();
    
    // Initial draws
    draw();
    drawPayoffChart();
    updateDteDisplay();
    
    // Load saved positions
    loadPositions();
    loadClosedPositions();
    initChallenges();
    
    // Restore collapsed section states
    setTimeout(() => window.restoreCollapsedStates?.(), 100);
    
    // Expose loadPositions to window for staged trade confirmation
    window.loadPositions = loadPositions;
    
    // Render pending trades if any
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
    
    // Check for updates (after a short delay to not block init)
    setTimeout(checkForUpdates, 2000);
    
    // Check AI availability (show/hide AI panel)
    setTimeout(checkAIAvailability, 1000);
    
    // Start live indicator
    initLiveIndicator();
    
    console.log('✅ Initialization complete');
}

/**
 * Live Indicator - Shows app is connected and updates timestamp
 */
let liveIndicatorInterval = null;
let lastDataRefresh = Date.now();
let serverConnected = true;

function initLiveIndicator() {
    // Update timestamp display every second
    liveIndicatorInterval = setInterval(updateLiveIndicator, 1000);
    
    // Mark initial connection
    markDataRefresh();
    
    // Check server health immediately, then every 30 seconds
    checkServerHealth();
    setInterval(checkServerHealth, 30000);
}

function updateLiveIndicator() {
    const timeEl = document.getElementById('lastRefreshTime');
    const indicator = document.getElementById('liveIndicator');
    if (!timeEl || !indicator) return;
    
    const now = Date.now();
    const secondsAgo = Math.floor((now - lastDataRefresh) / 1000);
    
    // Update timestamp display
    if (secondsAgo < 60) {
        timeEl.textContent = `${secondsAgo}s ago`;
    } else if (secondsAgo < 3600) {
        timeEl.textContent = `${Math.floor(secondsAgo / 60)}m ago`;
    } else {
        timeEl.textContent = `${Math.floor(secondsAgo / 3600)}h ago`;
    }
    
    // Only show stale warning if connected but no data refresh in 5+ minutes
    // Don't change color based on time - only health check changes connection status
    if (serverConnected && secondsAgo > 300) {
        indicator.classList.add('stale');
        indicator.classList.remove('disconnected');
        indicator.title = 'Connected but data may be stale - no refresh in 5+ minutes';
    } else if (serverConnected) {
        indicator.classList.remove('stale', 'disconnected');
        indicator.title = 'App is running and connected';
    }
    // If not connected, checkServerHealth manages the disconnected class
}

// Call this whenever data is fetched from server
window.markDataRefresh = function() {
    lastDataRefresh = Date.now();
    serverConnected = true;
    const indicator = document.getElementById('liveIndicator');
    if (indicator) {
        indicator.classList.remove('disconnected', 'stale');
        // Reset text to LIVE in case it was OFFLINE
        const liveText = indicator.querySelector('span:nth-child(2)');
        if (liveText) liveText.textContent = 'LIVE';
    }
}

async function checkServerHealth() {
    const indicator = document.getElementById('liveIndicator');
    if (!indicator) return;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const res = await fetch('/api/health', { 
            method: 'GET',
            signal: controller.signal 
        });
        clearTimeout(timeoutId);
        
        if (res.ok) {
            serverConnected = true;
            indicator.classList.remove('disconnected');
            // Reset text to LIVE
            const liveText = indicator.querySelector('span:nth-child(2)');
            if (liveText) liveText.textContent = 'LIVE';
        } else {
            serverConnected = false;
            indicator.classList.add('disconnected');
        }
    } catch (e) {
        serverConnected = false;
        indicator.classList.add('disconnected');
        const liveText = indicator.querySelector('span:nth-child(2)');
        if (liveText) liveText.textContent = 'OFFLINE';
    }
}

/**
 * Check if AI Trade Advisor (Ollama) is available
 */
async function checkAIAvailability() {
    const aiPanel = document.getElementById('aiInsightsPanel');
    const aiBtn = document.getElementById('aiInsightBtn');
    const aiContent = document.getElementById('aiInsightContent');
    const modelSelect = document.getElementById('aiModelSelect');
    const modelStatus = document.getElementById('aiModelStatus');
    const gpuStatusEl = document.getElementById('gpuStatus');
    
    if (!aiPanel) return;
    
    // Restore saved model preference (empty string means "use global")
    const savedModel = localStorage.getItem('wheelhouse_ai_model');
    if (modelSelect) {
        // Default to empty (use global) if no preference saved
        modelSelect.value = savedModel || '';
    }
    
    // Restore wisdom toggle preference
    loadWisdomPreference();
    
    try {
        const res = await fetch('/api/ai/status');
        if (!res.ok) throw new Error('API error');
        
        const data = await res.json();
        
        // Store for other functions to use
        window.aiStatus = data;
        
        // Display GPU info
        if (data.gpu) {
            const gpu = data.gpu;
            console.log(`🎮 GPU: ${gpu.name} (${gpu.totalGB}GB total, ${gpu.freeGB}GB free)`);
            
            // Update GPU status display if element exists
            if (gpuStatusEl) {
                if (gpu.available) {
                    gpuStatusEl.innerHTML = `🎮 <b>${gpu.name}</b> | ${gpu.freeGB}GB free / ${gpu.totalGB}GB`;
                    gpuStatusEl.style.color = '#00ff88';
                } else {
                    gpuStatusEl.innerHTML = `⚠️ No GPU detected - AI will run on CPU (slow)`;
                    gpuStatusEl.style.color = '#ffaa00';
                }
            }
        }
        
        if (data.available) {
            // AI is ready - show which models are available
            const models = data.models || [];
            const modelNames = models.map(m => m.name);
            console.log('🧠 AI Trade Advisor: Ready. Available models:', modelNames.join(', '));
            
            // Log model capabilities
            models.forEach(m => {
                const status = m.canRun ? (m.recommended ? '✅' : '⚠️') : '❌';
                console.log(`   ${status} ${m.name}: ${m.sizeGB}GB (needs ${m.requirements?.minGB || '?'}GB)`);
            });
            
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '1';
            
            // Update model dropdown to show installed + capability status
            if (modelSelect) {
                // Check if Grok API is configured (check localStorage for saved key)
                const grokConfigured = localStorage.getItem('wheelhouse_grok_configured') === 'true';
                
                Array.from(modelSelect.options).forEach(opt => {
                    // Handle Grok models separately (cloud-based)
                    if (opt.value.startsWith('grok')) {
                        opt.textContent = opt.textContent.replace(/\s*[✓⚠❌].*/g, '').replace(/\s*\(not installed\)/g, '').trim();
                        if (grokConfigured) {
                            opt.textContent += ' ✓';
                            opt.disabled = false;
                            opt.style.color = '#ff6b35'; // Grok orange
                        } else {
                            opt.textContent += ' (configure in Settings)';
                            opt.disabled = true;
                            opt.style.color = '#888';
                        }
                        return;
                    }
                    
                    const modelInfo = models.find(m => m.name === opt.value || m.name.startsWith(opt.value.split(':')[0]));
                    opt.textContent = opt.textContent.replace(/\s*[✓⚠❌].*/g, '').trim();
                    
                    if (modelInfo) {
                        if (!modelInfo.canRun) {
                            opt.textContent += ` ❌ (need ${modelInfo.requirements?.minGB}GB)`;
                            opt.disabled = true;
                            opt.style.color = '#888';
                        } else if (!modelInfo.recommended) {
                            opt.textContent += ' ⚠️ (tight fit)';
                            opt.disabled = false;
                            opt.style.color = '#ffaa00';
                        } else {
                            opt.textContent += ' ✓';
                            opt.disabled = false;
                            opt.style.color = '#00ff88';
                        }
                    } else {
                        opt.textContent += ' (not installed)';
                        opt.disabled = true;
                        opt.style.color = '#888';
                    }
                });
                
                // If saved model can't run, select first available
                const currentOpt = modelSelect.querySelector(`option[value="${savedModel}"]`);
                if (currentOpt?.disabled) {
                    const firstEnabled = Array.from(modelSelect.options).find(o => !o.disabled);
                    if (firstEnabled) {
                        modelSelect.value = firstEnabled.value;
                        localStorage.setItem('wheelhouse_ai_model', firstEnabled.value);
                        showNotification(`Switched to ${firstEnabled.value} (${savedModel} needs more VRAM)`, 'info');
                    }
                }
            }
            
            if (aiContent) {
                aiContent.innerHTML = `Click <b>Get Insight</b> after loading a position for AI-powered analysis.`;
            }
            
            // Check for vision model availability
            if (data.hasVision) {
                console.log('👁️ Vision model available for image parsing');
                window.hasVisionModel = true;
            }
        } else {
            // Ollama not running
            console.log('🧠 AI Trade Advisor: Ollama not running (AI features disabled)');
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '0.5';
            if (aiContent) {
                aiContent.innerHTML = `<span style="color:#888;">AI not available.</span><br>
                    <span style="font-size:10px;">Install Ollama from <a href="https://ollama.com" target="_blank" style="color:#00d9ff;">ollama.com</a> for AI insights.</span>`;
            }
            if (aiBtn) {
                aiBtn.disabled = true;
                aiBtn.title = 'Ollama not running';
            }
            if (modelSelect) modelSelect.disabled = true;
        }
    } catch (e) {
        // Server doesn't support AI endpoint - hide panel entirely
        console.log('🧠 AI Trade Advisor: Not available');
        if (aiPanel) aiPanel.style.display = 'none';
    }
}

// ============================================================
// SECTION: IMAGE PARSING (Broker Screenshots)
// Functions: handleImageDrop, handleImageUpload, parseUploadedImage, useExtractedTrade
// Lines: ~297-470
// ============================================================

/**
 * Handle image drag & drop
 */
window.handleImageDrop = function(event) {
    event.preventDefault();
    const dropZone = document.getElementById('imageDropZone');
    dropZone.style.borderColor = 'rgba(0,217,255,0.3)';
    dropZone.style.background = 'rgba(0,217,255,0.05)';
    
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        displayImagePreview(file);
    } else {
        showNotification('Please drop an image file', 'error');
    }
};

/**
 * Handle image upload from file input
 */
window.handleImageUpload = function(event) {
    const file = event.target.files[0];
    if (file && file.type.startsWith('image/')) {
        displayImagePreview(file);
    }
};

/**
 * Display image preview
 */
function displayImagePreview(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const preview = document.getElementById('imagePreview');
        const img = document.getElementById('previewImg');
        img.src = e.target.result;
        preview.style.display = 'block';
        // Store base64 for later parsing
        window.pendingImageData = e.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * Handle paste from clipboard (Ctrl+V)
 */
document.addEventListener('paste', async function(event) {
    // Only handle if we're on the Ideas tab
    const ideasTab = document.getElementById('ideas');
    if (!ideasTab || ideasTab.style.display === 'none') return;
    
    const items = event.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) {
                displayImagePreview(file);
                showNotification('Image pasted! Click "Extract Trade Details" to analyze', 'info');
            }
            break;
        }
    }
});

/**
 * Parse the uploaded image using vision model
 */
window.parseUploadedImage = async function(event) {
    if (event) event.stopPropagation();
    
    if (!window.pendingImageData) {
        showNotification('No image to parse', 'error');
        return;
    }
    
    // Check if vision model is available
    if (!window.hasVisionModel) {
        showNotification('Vision model not installed. Run: ollama pull minicpm-v', 'error');
        return;
    }
    
    const resultDiv = document.getElementById('imageParseResult');
    const contentDiv = document.getElementById('imageParseContent');
    
    resultDiv.style.display = 'block';
    contentDiv.innerHTML = '<span style="color:#ffaa00;">⏳ Analyzing image with AI vision...</span>';
    
    try {
        const response = await fetch('/api/ai/parse-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                image: window.pendingImageData,
                model: 'minicpm-v:latest'
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            contentDiv.innerHTML = `<span style="color:#ff5252;">❌ ${data.error}</span>`;
            return;
        }
        
        // Format the parsed result
        const parsed = data.parsed || {};
        let html = '<div style="display:grid; grid-template-columns:auto 1fr; gap:6px 12px;">';
        
        const fields = [
            ['TICKER', parsed.ticker],
            ['ACTION', parsed.action],
            ['TYPE', parsed.type],
            ['STRIKE', parsed.strike],
            ['EXPIRY', parsed.expiry],
            ['PREMIUM', parsed.premium],
            ['CONTRACTS', parsed.contracts],
            ['TOTAL', parsed.total]
        ];
        
        for (const [label, value] of fields) {
            if (value && value.toLowerCase() !== 'unclear') {
                html += `<span style="color:#888;">${label}:</span><span style="color:#00ff88;">${value}</span>`;
            } else {
                html += `<span style="color:#888;">${label}:</span><span style="color:#666;">—</span>`;
            }
        }
        html += '</div>';
        
        // Store for use in analyzer
        window.extractedTradeData = parsed;
        
        contentDiv.innerHTML = html;
        showNotification('Trade details extracted!', 'success');
        
    } catch (e) {
        contentDiv.innerHTML = `<span style="color:#ff5252;">❌ Error: ${e.message}</span>`;
    }
};

/**
 * Use extracted trade data in the analyzer
 */
window.useExtractedTrade = function() {
    const data = window.extractedTradeData;
    if (!data) {
        showNotification('No extracted data available', 'error');
        return;
    }
    
    // Build a trade string from parsed data
    let tradeStr = '';
    if (data.ticker) tradeStr += data.ticker + ' ';
    if (data.strike) tradeStr += '$' + data.strike;
    if (data.type) tradeStr += data.type.toUpperCase().charAt(0) + ' ';
    if (data.expiry) tradeStr += data.expiry + ' ';
    if (data.premium) tradeStr += 'for $' + data.premium;
    
    // Put it in the paste input
    const input = document.getElementById('pasteTradeInput2');
    if (input) {
        input.value = tradeStr.trim() || `${data.ticker || ''} ${data.strike || ''} ${data.type || ''} ${data.expiry || ''}`.trim();
        input.focus();
        showNotification('Trade sent to analyzer. Click "Analyze Trade" to continue.', 'info');
    }
    
    // Hide the image result
    document.getElementById('imageParseResult').style.display = 'none';
};

// ============================================================
// SECTION: AI FUNCTIONS (Ollama Integration)
// Functions: saveAIModelPreference, checkAIStatus, warmupAIModel,
//            getXSentiment, xDeepDive, getTradeIdeas, deepDive,
//            analyzeDiscordTrade, stageDiscordTrade, stageTradeWithThesis
// Lines: ~473-2000
// ============================================================

/**
 * Save AI model preference to localStorage
 */
window.saveAIModelPreference = function() {
    const modelSelect = document.getElementById('aiModelSelect');
    if (modelSelect) {
        localStorage.setItem('wheelhouse_ai_model', modelSelect.value);
        console.log('AI model preference saved:', modelSelect.value);
        // Check if this model is loaded
        checkAIStatus();
    }
};

/**
 * Save wisdom toggle preference to localStorage and update UI
 */
window.saveWisdomPreference = function() {
    const wisdomToggle = document.getElementById('aiWisdomToggle');
    const wisdomStatus = document.getElementById('wisdomStatus');
    if (wisdomToggle) {
        const isEnabled = wisdomToggle.checked;
        localStorage.setItem('wheelhouse_wisdom_enabled', isEnabled ? 'true' : 'false');
        console.log('Wisdom preference saved:', isEnabled ? 'enabled' : 'disabled (pure mode)');
        
        // Update status indicator
        if (wisdomStatus) {
            if (isEnabled) {
                wisdomStatus.textContent = '✓ Rules active';
                wisdomStatus.style.color = '#4ade80';
            } else {
                wisdomStatus.textContent = '⚡ Pure mode';
                wisdomStatus.style.color = '#fbbf24';
            }
        }
    }
};

/**
 * Load wisdom toggle preference from localStorage
 */
window.loadWisdomPreference = function() {
    const wisdomToggle = document.getElementById('aiWisdomToggle');
    if (wisdomToggle) {
        const saved = localStorage.getItem('wheelhouse_wisdom_enabled');
        // Default to enabled if not set
        wisdomToggle.checked = saved !== 'false';
        // Update status indicator
        saveWisdomPreference();
    }
};

/**
 * Check AI/Ollama status and show what's loaded
 */
window.checkAIStatus = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    if (!statusEl) return;
    
    try {
        const response = await fetch('/api/ai/status');
        const status = await response.json();
        
        if (!status.available) {
            statusEl.textContent = '❌ Ollama not running';
            statusEl.style.color = '#ff5252';
            return;
        }
        
        // Use global model selector (local aiModelSelect is an override)
        const selectedModel = window.getSelectedAIModel('aiModelSelect');
        const isLoaded = status.loaded?.some(m => m.name === selectedModel);
        
        if (isLoaded) {
            const loaded = status.loaded.find(m => m.name === selectedModel);
            statusEl.textContent = `✅ Loaded (${loaded.sizeVramGB}GB VRAM)`;
            statusEl.style.color = '#00ff88';
            if (warmupBtn) {
                warmupBtn.style.background = '#1a3a1a';
                warmupBtn.style.color = '#00ff88';
                warmupBtn.textContent = '✓ Ready';
            }
        } else if (status.loaded?.length > 0) {
            const other = status.loaded[0];
            statusEl.textContent = `⚠️ ${other.name} loaded, not ${selectedModel.split(':')[1]}`;
            statusEl.style.color = '#ffaa00';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#ffaa00';
                warmupBtn.textContent = '🔥 Load';
            }
        } else {
            statusEl.textContent = '💤 Cold (click Warmup)';
            statusEl.style.color = '#888';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#888';
                warmupBtn.textContent = '🔥 Warmup';
            }
        }
    } catch (e) {
        statusEl.textContent = '❌ Error';
        statusEl.style.color = '#ff5252';
    }
};

/**
 * Warmup (pre-load) the selected AI model into GPU memory
 */
window.warmupAIModel = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    // Use global model selector (local aiModelSelect is an override)
    const selectedModel = window.getSelectedAIModel('aiModelSelect');
    
    if (warmupBtn) {
        warmupBtn.disabled = true;
        warmupBtn.innerHTML = '⏳ 0s';
        warmupBtn.style.color = '#8a9aa8';
        warmupBtn.style.minWidth = '60px';
    }
    if (statusEl) {
        statusEl.textContent = `Loading ${selectedModel}...`;
        statusEl.style.color = '#8a9aa8';
    }
    
    const startTime = Date.now();
    
    try {
        const response = await fetch('/api/ai/warmup', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ model: selectedModel })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        if (warmupBtn) warmupBtn.innerHTML = `⏳ ${elapsed}s`;
                        if (statusEl) statusEl.textContent = data.message;
                    } else if (data.type === 'complete') {
                        if (statusEl) {
                            statusEl.textContent = `✅ ${data.message}`;
                            statusEl.style.color = '#00ff88';
                        }
                        if (warmupBtn) {
                            warmupBtn.innerHTML = '✓ Ready';
                            warmupBtn.style.background = '#1a3a1a';
                            warmupBtn.style.color = '#00ff88';
                        }
                        showNotification(`🧠 ${selectedModel} loaded and ready!`, 'success');
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = `❌ ${e.message}`;
            statusEl.style.color = '#ff5252';
        }
        if (warmupBtn) {
            warmupBtn.innerHTML = '🔥 Retry';
            warmupBtn.style.color = '#ff5252';
        }
        showNotification(`Failed to load model: ${e.message}`, 'error');
    } finally {
        if (warmupBtn) warmupBtn.disabled = false;
    }
};

// Check AI status on page load and periodically
setTimeout(checkAIStatus, 2000);
setInterval(checkAIStatus, 30000); // Refresh every 30 seconds

/**
 * Show/hide X Sentiment button based on model selection
 */
function updateXSentimentButton() {
    // Handle both Ideas panels (Ideas tab and Positions tab)
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    const xBtn1 = document.getElementById('xSentimentBtn');
    const xBtn2 = document.getElementById('xSentimentBtn2');
    
    if (modelSelect1 && xBtn1) {
        const isGrok = modelSelect1.value?.startsWith('grok');
        xBtn1.style.display = isGrok ? 'block' : 'none';
    }
    if (modelSelect2 && xBtn2) {
        const isGrok = modelSelect2.value?.startsWith('grok');
        xBtn2.style.display = isGrok ? 'block' : 'none';
    }
}

// Listen for model changes - run immediately since DOM is likely ready
(function setupXSentimentToggle() {
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    
    if (modelSelect1 || modelSelect2) {
        if (modelSelect1) modelSelect1.addEventListener('change', updateXSentimentButton);
        if (modelSelect2) modelSelect2.addEventListener('change', updateXSentimentButton);
        updateXSentimentButton(); // Check immediately
    } else {
        // DOM not ready, wait a bit
        setTimeout(setupXSentimentToggle, 500);
    }
})();

/**
 * Restore X Sentiment from localStorage (persists across tab switches)
 */
window.restoreXSentiment = function() {
    try {
        const saved = localStorage.getItem('wheelhouse_x_sentiment');
        if (!saved) return false;
        
        const data = JSON.parse(saved);
        if (!data.html || !data.tickers) return false;
        
        // Check if data is less than 4 hours old
        const ageMs = Date.now() - data.timestamp;
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > 4) {
            console.log('[X Sentiment] Cached data too old, clearing');
            localStorage.removeItem('wheelhouse_x_sentiment');
            return false;
        }
        
        // Restore to both panels
        const ageMinutes = Math.round(ageMs / 60000);
        const ageDisplay = ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes/60)}h ago`;
        
        // Update header with age indicator
        let html = data.html.replace(
            /\([\d:]+\s*[AP]M\)/i, 
            `(${data.timeString} - <span style="color:#ffaa00;">${ageDisplay}</span>)`
        );
        
        // Restore to Ideas tab
        const ideaContentLarge = document.getElementById('ideaContentLarge');
        const ideaResultsLarge = document.getElementById('ideaResultsLarge');
        if (ideaContentLarge && ideaResultsLarge) {
            ideaContentLarge.innerHTML = html;
            ideaResultsLarge.style.display = 'block';
        }
        
        // Restore to Positions tab
        const ideaContent = document.getElementById('ideaContent');
        const ideaResults = document.getElementById('ideaResults');
        if (ideaContent && ideaResults) {
            ideaContent.innerHTML = html;
            ideaResults.style.display = 'block';
        }
        
        // Restore tickers for Trade Ideas integration
        window._xTrendingTickers = data.tickers;
        
        // Show X tickers integration checkbox
        const tickerCount = data.tickers.length;
        ['', '2'].forEach(suffix => {
            const optionDiv = document.getElementById('xTickersOption' + suffix);
            const countSpan = document.getElementById('xTickerCount' + suffix);
            if (optionDiv && tickerCount > 0) {
                optionDiv.style.display = 'block';
                if (countSpan) countSpan.textContent = tickerCount;
            }
        });
        
        console.log(`[X Sentiment] Restored from cache (${ageDisplay}):`, data.tickers);
        return true;
    } catch (e) {
        console.error('[X Sentiment] Restore failed:', e);
        return false;
    }
};

// Restore X Sentiment on page load
setTimeout(() => window.restoreXSentiment(), 1000);

/**
 * Save X Sentiment to history for trend comparison (keep last 10)
 */
window.saveXSentimentToHistory = function(data) {
    try {
        let history = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]');
        
        // Add new entry
        history.unshift({
            timestamp: data.timestamp,
            timeString: data.timeString,
            tickers: data.tickers,
            rawText: data.rawText
        });
        
        // Keep only last 10
        if (history.length > 10) history = history.slice(0, 10);
        
        localStorage.setItem('wheelhouse_x_sentiment_history', JSON.stringify(history));
        console.log(`[X Sentiment] History saved (${history.length} entries)`);
    } catch (e) {
        console.error('[X Sentiment] History save failed:', e);
    }
};

/**
 * Show X Sentiment history comparison modal
 */
window.showXSentimentHistory = function() {
    const history = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]');
    
    if (history.length < 2) {
        showNotification('Need at least 2 sentiment runs to compare. Run X Sentiment again later!', 'info');
        return;
    }
    
    // Analyze trends across history
    const tickerCounts = {};
    history.forEach((entry, idx) => {
        (entry.tickers || []).forEach(t => {
            if (!tickerCounts[t]) tickerCounts[t] = { count: 0, appearances: [] };
            tickerCounts[t].count++;
            tickerCounts[t].appearances.push(idx);
        });
    });
    
    // Sort by frequency (most mentioned across runs)
    const sorted = Object.entries(tickerCounts)
        .sort((a, b) => b[1].count - a[1].count);
    
    const persistent = sorted.filter(([_, data]) => data.count >= 2);
    const oneTime = sorted.filter(([_, data]) => data.count === 1);
    
    // Build comparison between latest and previous
    const latest = history[0];
    const previous = history[1];
    const latestTickers = new Set(latest.tickers || []);
    const prevTickers = new Set(previous.tickers || []);
    
    const newTickers = [...latestTickers].filter(t => !prevTickers.has(t));
    const droppedTickers = [...prevTickers].filter(t => !latestTickers.has(t));
    const stillTrending = [...latestTickers].filter(t => prevTickers.has(t));
    
    const timeDiff = latest.timestamp - previous.timestamp;
    const hoursDiff = Math.round(timeDiff / (1000 * 60 * 60) * 10) / 10;
    
    const modal = document.createElement('div');
    modal.id = 'xHistoryModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10001;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #1da1f2;border-radius:12px;padding:24px;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h2 style="margin:0;color:#1da1f2;">📊 X Sentiment Trend Analysis</h2>
                <button onclick="this.closest('#xHistoryModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <div style="background:rgba(29,161,242,0.1);padding:12px;border-radius:8px;margin-bottom:16px;">
                <strong>Comparing:</strong> ${latest.timeString} vs ${previous.timeString} 
                <span style="color:#888;">(${hoursDiff} hours apart)</span>
            </div>
            
            ${stillTrending.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#00ff88;margin:0 0 8px 0;">🔥 Still Trending (Persistent Buzz)</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${stillTrending.map(t => `
                        <span onclick="window.xDeepDive('${t}')" 
                            style="background:#00ff88;color:#000;padding:6px 12px;border-radius:16px;cursor:pointer;font-weight:bold;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    💡 These tickers appeared in both scans - sustained interest!
                </div>
            </div>
            ` : ''}
            
            ${newTickers.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#ffaa00;margin:0 0 8px 0;">🆕 Newly Trending</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${newTickers.map(t => `
                        <span onclick="window.xDeepDive('${t}')" 
                            style="background:#ffaa00;color:#000;padding:6px 12px;border-radius:16px;cursor:pointer;font-weight:bold;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    ⚡ New in latest scan - emerging momentum
                </div>
            </div>
            ` : ''}
            
            ${droppedTickers.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#888;margin:0 0 8px 0;">📉 Dropped Off</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${droppedTickers.map(t => `
                        <span style="background:#333;color:#888;padding:6px 12px;border-radius:16px;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    Yesterday's news - buzz faded
                </div>
            </div>
            ` : ''}
            
            <div style="margin-top:20px;padding-top:16px;border-top:1px solid #333;">
                <h3 style="color:#1da1f2;margin:0 0 12px 0;">📈 All-Time Frequency (Last ${history.length} Scans)</h3>
                <table style="width:100%;font-size:12px;">
                    <tr style="color:#888;">
                        <th style="text-align:left;padding:4px;">Ticker</th>
                        <th style="text-align:center;padding:4px;">Mentions</th>
                        <th style="text-align:left;padding:4px;">Status</th>
                    </tr>
                    ${persistent.slice(0, 10).map(([ticker, data]) => `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:6px;color:#00d9ff;font-weight:bold;cursor:pointer;" 
                                onclick="window.xDeepDive('${ticker}')">${ticker}</td>
                            <td style="padding:6px;text-align:center;">${data.count}x</td>
                            <td style="padding:6px;color:${latestTickers.has(ticker) ? '#00ff88' : '#888'};">
                                ${latestTickers.has(ticker) ? '🔥 Active' : '💤 Quiet'}
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
            
            <div style="margin-top:20px;text-align:center;">
                <button onclick="this.closest('#xHistoryModal').remove()" 
                    style="padding:10px 24px;background:#1da1f2;border:none;border-radius:6px;color:#fff;font-weight:bold;cursor:pointer;">
                    Got It
                </button>
                <button onclick="if(confirm('Clear all sentiment history?')){localStorage.removeItem('wheelhouse_x_sentiment_history');this.closest('#xHistoryModal').remove();showNotification('History cleared','info');}" 
                    style="padding:10px 24px;background:#333;border:none;border-radius:6px;color:#888;cursor:pointer;margin-left:10px;">
                    Clear History
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Get X/Twitter sentiment via Grok (Grok-only feature)
 */
window.getXSentiment = async function() {
    // Try both panels - Ideas tab uses "Large" suffix, Positions tab doesn't
    const ideaBtn = document.getElementById('xSentimentBtn2') || document.getElementById('xSentimentBtn');
    const ideaResults = document.getElementById('ideaResultsLarge') || document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContentLarge') || document.getElementById('ideaContent');
    
    if (!ideaResults || !ideaContent) {
        console.error('Could not find result containers');
        return;
    }
    
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 
                        parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    
    // Get holdings for impact check
    const holdings = (state.holdings || []).map(h => ({
        ticker: h.ticker,
        shares: h.shares || h.quantity || 100,
        costBasis: h.costBasis || h.avgCost
    }));
    
    // Get previous runs for trend comparison (last 5 runs)
    const previousRuns = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]').slice(0, 5);
    console.log(`[X Sentiment] Sending ${previousRuns.length} previous runs for trend comparison`);
    
    // Show loading
    if (ideaBtn) {
        ideaBtn.disabled = true;
        ideaBtn.textContent = '⏳ Scanning X...';
    }
    ideaResults.style.display = 'block';
    ideaContent.innerHTML = '<span style="color:#1da1f2;">🔄 Grok is scanning X/Twitter for trader sentiment... (may take 30-60 seconds with live search)</span>';
    
    try {
        const response = await fetch('/api/ai/x-sentiment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buyingPower, holdings, previousRuns })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Extract tickers from the response for Deep Dive and Trade Ideas integration
        // Multiple patterns to catch different formats:
        // 1. **TICKER** @ $XX.XX (bold with price)
        // 2. **TICKER** (just bold)
        // 3. - TICKER @ $XX (list item with price)
        // 4. TICKER followed by context words
        const foundTickers = new Set();
        
        // Pattern 1: Bold tickers like **AMD** or **ORCL**
        const boldPattern = /\*\*([A-Z]{2,5})\*\*/g;
        let match;
        while ((match = boldPattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Pattern 2: Ticker @ $price like "AMD @ $96.50" or "- CSCO @ $56.00"
        const pricePattern = /\b([A-Z]{2,5})\s*@\s*\$/g;
        while ((match = pricePattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Pattern 3: Context patterns (original, as backup)
        const contextPattern = /\b([A-Z]{2,5})\b(?:\s*-\s*[A-Za-z]|\s+is\s|\s+has\s|\s+could|\s+looks|\s+breaking)/g;
        while ((match = contextPattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Filter out common words that look like tickers
        const excludeWords = ['AI', 'IV', 'OTM', 'ATM', 'ITM', 'ETF', 'EV', 'CEO', 'CFO', 'IPO', 'PE', 'EPS', 'GDP', 'CPI', 'FED', 'SEC', 'USD', 'EUR', 'NOW', 'ANY', 'ALL', 'PUT', 'CALL', 'BUY', 'SELL'];
        excludeWords.forEach(word => foundTickers.delete(word));
        
        // Store for Trade Ideas integration
        window._xTrendingTickers = Array.from(foundTickers);
        console.log('[X Sentiment] Extracted tickers:', window._xTrendingTickers);
        
        // Format the response with nice styling
        let formatted = result.sentiment
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#1da1f2;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(🔥|📢|⚠️|💰|🚀)/g, '<span style="font-size:14px;">$1</span>');
        
        // Make tickers clickable for Deep Dive
        window._xTrendingTickers.forEach(ticker => {
            const tickerRegex = new RegExp(`\\b(${ticker})\\b`, 'g');
            formatted = formatted.replace(tickerRegex, 
                `<span class="x-ticker" onclick="window.xDeepDive('${ticker}')" style="color:#00ff88; cursor:pointer; text-decoration:underline; font-weight:bold;" title="Click for Deep Dive on ${ticker}">$1</span>`);
        });
        
        // Add header with refresh button and history button
        const timestamp = new Date().toLocaleTimeString();
        const historyCount = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]').length;
        const usageCount = parseInt(localStorage.getItem('wheelhouse_x_sentiment_usage') || '0') + 1; // +1 because we haven't saved yet
        const historyBtn = historyCount >= 2 
            ? `<button onclick="window.showXSentimentHistory()" style="font-size:10px; padding:3px 8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer; margin-right:6px;" title="Compare with previous scans">📊 Trends (${historyCount})</button>`
            : '';
        const header = `<div style="color:#1da1f2; font-weight:bold; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center;">
            <span>🔥 Live from X/Twitter <span style="color:#666; font-size:10px;">(${timestamp})</span></span>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:9px; color:#666; background:rgba(29,161,242,0.15); padding:2px 6px; border-radius:3px;" title="Total Grok API calls">📊 #${usageCount}</span>
                ${historyBtn}
                <button onclick="window.getXSentiment()" style="font-size:10px; padding:3px 8px; background:#1da1f2; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔄 Refresh</button>
            </div>
        </div>
        <div style="font-size:10px; color:#888; margin-bottom:10px; padding:6px; background:rgba(0,255,136,0.1); border-radius:4px;">
            💡 <strong style="color:#00ff88;">Click any ticker</strong> for Deep Dive analysis | Found: ${window._xTrendingTickers.join(', ')}
        </div>`;
        
        const fullHtml = header + formatted;
        ideaContent.innerHTML = fullHtml;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Trending on X (Grok)';
            ideaBtn.disabled = false;
        }
        
        // Save to localStorage for persistence across tab switches
        const sentimentData = {
            html: fullHtml,
            tickers: window._xTrendingTickers,
            timestamp: Date.now(),
            timeString: timestamp,
            rawText: result.insight  // Store raw text for comparison
        };
        localStorage.setItem('wheelhouse_x_sentiment', JSON.stringify(sentimentData));
        
        // Save the incremented usage counter (usageCount already calculated above)
        localStorage.setItem('wheelhouse_x_sentiment_usage', usageCount.toString());
        console.log(`[X Sentiment] API call #${usageCount}`);
        
        // Also save to history (keep last 10 runs)
        window.saveXSentimentToHistory(sentimentData);
        console.log('[X Sentiment] Saved to localStorage and history');
        
        // Show the X tickers integration checkbox
        const tickerCount = window._xTrendingTickers.length;
        ['', '2'].forEach(suffix => {
            const optionDiv = document.getElementById('xTickersOption' + suffix);
            const countSpan = document.getElementById('xTickerCount' + suffix);
            if (optionDiv && tickerCount > 0) {
                optionDiv.style.display = 'block';
                if (countSpan) countSpan.textContent = tickerCount;
            }
        });
        
    } catch (e) {
        console.error('X Sentiment error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">X Sentiment requires Grok API. Make sure it's configured in Settings.</span>`;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Retry';
            ideaBtn.disabled = false;
        }
    }
};

/**
 * Deep Dive from X Sentiment - fetches live price and runs analysis
 */
window.xDeepDive = async function(ticker) {
    // Use global model selector - prefer non-reasoning models for cleaner output
    // deepseek-r1 models show chain-of-thought which is verbose
    const selectedModel = window.getSelectedAIModel?.('ideaModelSelect2') || 
                          window.getSelectedAIModel?.('ideaModelSelect') || 
                          'qwen2.5:32b';  // Default to non-reasoning model
    
    // Show loading modal
    const modal = document.createElement('div');
    modal.id = 'xDeepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#1da1f2;">🔥 X → Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#xDeepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="xDeepDiveContent" style="color:#ddd; line-height:1.7;">
                <div style="text-align:center; padding:40px;">
                    <div style="font-size:24px; margin-bottom:10px;">⏳</div>
                    <div style="color:#1da1f2;">Fetching ${ticker} data and running analysis...</div>
                    <div style="color:#666; font-size:12px; margin-top:8px;">Using ${selectedModel}</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        // Backend fetches real options chain and finds best ~0.20 delta put at ~30 DTE
        console.log(`[xDeepDive] Requesting real options analysis for ${ticker}...`);
        
        // Call Deep Dive API - let backend find the best strike/expiry from real chain
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                ticker, 
                model: selectedModel,
                targetDelta: 0.20  // Conservative 0.20 delta
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Deep Dive failed');
        }
        
        const result = await response.json();
        
        // Get the REAL strike/expiry/price from the backend (from real options chain)
        const strike = result.strike;
        const expiry = result.expiry;
        const price = result.currentPrice;
        const premium = result.premium;
        
        // Format the analysis
        let formatted = result.analysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#7a8a94;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(🎯|⚠️|💡|📊)/g, '<span style="font-size:14px;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Show premium info with delta (from real chain data)
        const premiumInfo = premium ? 
            `<div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <strong style="color:#7a8a94;">Current Premium:</strong> $${premium.mid?.toFixed(2) || premium.bid?.toFixed(2) || '?'} per share
                <span style="color:#666; margin-left:10px;">(bid $${premium.bid?.toFixed(2)} / ask $${premium.ask?.toFixed(2)})</span>
                ${premium.delta ? `<span style="margin-left:15px; color:#00d9ff;">Δ ${(premium.delta * 100).toFixed(0)}%</span>` : ''}
                ${premium.iv ? `<span style="margin-left:15px; color:#ffaa00;">IV ${premium.iv}%</span>` : ''}
            </div>` : '';
        
        document.getElementById('xDeepDiveContent').innerHTML = `
            <div style="background:rgba(29,161,242,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <strong style="color:#1da1f2;">${ticker}</strong> @ $${price?.toFixed(2) || '?'}
                <span style="margin-left:20px;">Analyzing: <span style="color:#00ff88;">Sell $${strike} Put</span> expiring ${expiry}</span>
                <span style="color:#666; font-size:10px; margin-left:10px;">(real chain data)</span>
            </div>
            ${premiumInfo}
            <div style="white-space:pre-wrap;">${formatted}</div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:10px;">
                <button id="xDeepDiveStageBtn" 
                    style="padding:10px 20px; background:#00ff88; border:none; border-radius:6px; color:#000; font-weight:bold; cursor:pointer;">
                    📋 Stage This Trade
                </button>
                <button onclick="this.closest('#xDeepDiveModal').remove()" 
                    style="padding:10px 20px; background:#333; border:none; border-radius:6px; color:#fff; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        
        // Attach click handler with closure to preserve analysis text and premium
        document.getElementById('xDeepDiveStageBtn').onclick = () => {
            window.stageFromXSentiment(ticker, price, strike, expiry, result.analysis, premium?.mid || premium?.bid);
            document.getElementById('xDeepDiveModal')?.remove();
        };
        
    } catch (e) {
        console.error('X Deep Dive error:', e);
        document.getElementById('xDeepDiveContent').innerHTML = `
            <div style="color:#ff5252; text-align:center; padding:20px;">
                ❌ ${e.message}
                <br><br>
                <button onclick="this.closest('#xDeepDiveModal').remove()" 
                    style="padding:8px 16px; background:#333; border:none; border-radius:6px; color:#fff; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
    }
};

/**
 * Stage a trade from X Sentiment Deep Dive
 */
window.stageFromXSentiment = function(ticker, price, strike, expiry, analysis, cboPremium) {
    console.log('[Stage] Starting stage for', ticker, strike, expiry, 'premium:', cboPremium);
    
    // Close modal
    document.getElementById('xDeepDiveModal')?.remove();
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade with X Sentiment source
    const trade = {
        id: Date.now(),
        ticker: ticker,
        type: 'short_put',
        strike: parseFloat(strike),
        expiry: expiry,
        currentPrice: parseFloat(price),
        premium: cboPremium ? parseFloat(cboPremium) : 0,  // Use CBOE premium if available
        isCall: false,  // Short put
        isDebit: false, // Sold = credit
        stagedAt: new Date().toISOString(),
        source: 'x-sentiment',
        // Store thesis if analysis provided
        openingThesis: analysis ? {
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(price),
            source: 'X/Twitter Sentiment → Deep Dive',
            aiSummary: {
                fullAnalysis: analysis
            }
        } : null
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${ticker} $${strike} put, ${expiry} (with thesis)`, 'success');
    
    // Switch to Positions tab
    const positionsTab = document.querySelector('.tab-btn[data-tab="positions"]');
    if (positionsTab) positionsTab.click();
    
    // Render pending trades
    setTimeout(() => {
        window.renderPendingTrades?.();
    }, 100);
};

/**
 * Get AI-powered trade ideas
 */
window.getTradeIdeas = async function() {
    const ideaBtn = document.getElementById('ideaBtn');
    const ideaResults = document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContent');
    
    if (!ideaBtn || !ideaResults || !ideaContent) return;
    
    // Get inputs
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'deepseek-r1:32b';
    
    // Check if X trending tickers should be included
    const useXTickers = document.getElementById('useXTickers')?.checked;
    const xTrendingTickers = (useXTickers && window._xTrendingTickers?.length > 0) ? window._xTrendingTickers : [];
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaBtn.textContent = '⏳ Generating...';
    ideaResults.style.display = 'block';
    const xNote = xTrendingTickers.length > 0 ? ` (including ${xTrendingTickers.length} from X)` : '';
    ideaContent.innerHTML = `<span style="color:#888;">🔄 AI is researching trade ideas${xNote}... (15-30 seconds)</span>`;
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel,
                xTrendingTickers,  // Pass X tickers to backend
                portfolioContext: formatPortfolioContextForAI()  // Include portfolio context from audit
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Store candidates for deep dive
        window._lastTradeIdeas = result.candidates || [];
        
        // Debug: log raw response to see exact format
        console.log('Raw AI response:', result.ideas.substring(0, 500));
        
        // Add Deep Dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                console.log('Deep Dive match:', match, 'Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
            });
        
        // Now apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/<span class="dd-ticker" data-ticker="([^"]+)">([^<]+)<\/span>/g, '<span style="color:#00ff88; font-weight:bold;">$2</span>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>');
        
        ideaContent.innerHTML = formatted;
        ideaBtn.textContent = '💡 Generate Ideas';
        ideaBtn.disabled = false;
        
    } catch (e) {
        console.error('Trade ideas error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">Make sure Ollama is running with the selected model installed.</span>`;
        ideaBtn.textContent = '💡 Retry';
        ideaBtn.disabled = false;
    }
};

/**
 * Deep Dive - comprehensive analysis of a single trade
 */
window.deepDive = async function(ticker) {
    // Find the candidate data
    const candidates = window._lastTradeIdeas || [];
    const candidate = candidates.find(c => c.ticker === ticker);
    
    if (!candidate) {
        showNotification(`No data found for ${ticker}`, 'error');
        return;
    }
    
    // Parse the current ideas to find the proposed strike/expiry
    const ideaContent = document.getElementById('ideaContent');
    const ideaText = ideaContent?.textContent || '';
    
    // Try to extract strike and expiry from the idea text
    const strikeMatch = ideaText.match(new RegExp(`${ticker}[^]*?Sell\\s*\\$?(\\d+)\\s*put`, 'i'));
    const expiryMatch = ideaText.match(new RegExp(`${ticker}[^]*?put,?\\s*([A-Z][a-z]+\\s+\\d+)`, 'i'));
    
    const strike = strikeMatch ? strikeMatch[1] : Math.floor(parseFloat(candidate.price) * 0.9);
    // Snap expiry to valid Friday (options never expire on weekends)
    const rawExpiry = expiryMatch ? expiryMatch[1] : null;
    const expiry = snapToFriday(rawExpiry);
    
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'deepseek-r1:32b';
    
    // Show modal with loading state
    const modal = document.createElement('div');
    modal.id = 'deepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#7a8a94;">🔍 Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#deepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div style="color:#888; margin-bottom:16px;">
                Analyzing: Sell $${strike} put, ${expiry} | Current: $${candidate.price}
            </div>
            <div id="deepDiveContent" style="color:#ddd; font-size:13px; line-height:1.7;">
                <div style="text-align:center; padding:40px; color:#888;">
                    ⏳ Running comprehensive analysis... (30-60 seconds)
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                strike,
                expiry,
                currentPrice: candidate.price,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Format the analysis
        let formatted = result.analysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(✅ ENTER TRADE)/g, '<span style="color:#00ff88; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(⚠️ WAIT)/g, '<span style="color:#ffaa00; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(❌ AVOID)/g, '<span style="color:#ff5252; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(Strong Buy|Buy|Neutral|Avoid)/g, (match) => {
                const colors = { 'Strong Buy': '#00ff88', 'Buy': '#00d9ff', 'Neutral': '#ffaa00', 'Avoid': '#ff5252' };
                return `<span style="color:${colors[match] || '#fff'}; font-weight:bold;">${match}</span>`;
            })
            .replace(/(Bull case|Base case|Bear case|Disaster case)/gi, '<span style="color:#7a8a94; font-weight:bold;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Add premium info if available
        let premiumHtml = '';
        if (result.premium) {
            const p = result.premium;
            const source = p.source === 'schwab' ? '🔴 Schwab (real-time)' : '🔵 CBOE (15-min delay)';
            
            // Note if strike was adjusted
            const actualStrike = p.actualStrike || parseFloat(strike);
            const strikeAdjusted = p.actualStrike && Math.abs(p.actualStrike - parseFloat(strike)) > 0.01;
            const strikeNote = strikeAdjusted 
                ? `<div style="color:#ffaa00; grid-column: span 3; font-size:11px;">⚠️ Using actual strike $${p.actualStrike} (requested $${strike})</div>` 
                : '';
            
            // Calculate annualized ROC using actual strike
            const expiryMatch = expiry.match(/(\w+)\s+(\d+)/);
            let dte = 30, annualizedRoc = 0;
            if (expiryMatch) {
                const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
                const expMonth = monthMap[expiryMatch[1]];
                const expDay = parseInt(expiryMatch[2]);
                const expYear = expMonth < new Date().getMonth() ? new Date().getFullYear() + 1 : new Date().getFullYear();
                const expDate = new Date(expYear, expMonth, expDay);
                dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
            }
            const roc = (p.mid / actualStrike) * 100;
            annualizedRoc = (roc * (365 / dte)).toFixed(1);
            
            // Probability of profit from delta
            let probProfit = '';
            if (p.delta) {
                const pop = ((1 - Math.abs(p.delta)) * 100).toFixed(0);
                probProfit = `<div style="color:#00ff88;">Win Prob: ~${pop}%</div>`;
            }
            
            premiumHtml = `
                <div style="background:#1e3a5f; border:1px solid #00d9ff; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#00d9ff; font-weight:bold; margin-bottom:8px;">💰 ${source}</div>
                    ${strikeNote}
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; font-size:12px;">
                        <div>Bid: <span style="color:#00ff88;">$${p.bid.toFixed(2)}</span></div>
                        <div>Ask: <span style="color:#ffaa00;">$${p.ask.toFixed(2)}</span></div>
                        <div>Mid: <span style="color:#fff;">$${p.mid.toFixed(2)}</span></div>
                        <div>Volume: ${p.volume}</div>
                        <div>OI: ${p.openInterest}</div>
                        ${p.iv ? `<div>IV: ${p.iv}%</div>` : ''}
                        ${probProfit}
                        ${p.delta ? `<div>Delta: ${p.delta.toFixed(2)}</div>` : ''}
                        ${p.theta ? `<div>Theta: ${p.theta.toFixed(3)}</div>` : ''}
                    </div>
                    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #335577; display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; font-size:12px;">
                        <div>Premium: <span style="color:#00ff88;">$${(p.mid * 100).toFixed(0)}</span>/contract</div>
                        <div>ROC: <span style="color:#00ff88;">${roc.toFixed(2)}%</span> (${annualizedRoc}% ann.)</div>
                        <div>DTE: ${dte} days</div>
                        <div>Cost Basis: <span style="color:#ffaa00;">$${(actualStrike - p.mid).toFixed(2)}</span>/sh</div>
                    </div>
                </div>`;
        }
        
        // Store thesis data for staging
        const price = parseFloat(candidate.price);
        const rangeHigh = result.tickerData?.threeMonthHigh;
        const rangeLow = result.tickerData?.threeMonthLow;
        const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
            Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
        
        window._currentThesis = {
            ticker,
            strike: parseFloat(strike),
            expiry,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: price,
            premium: result.premium || null,
            tickerData: result.tickerData || {},
            aiAnalysis: result.analysis,
            // Extract key thesis points
            support: result.tickerData?.recentSupport || [],
            sma20: result.tickerData?.sma20,
            sma50: result.tickerData?.sma50,
            earnings: result.tickerData?.earnings,
            rangeHigh,
            rangeLow,
            rangePosition  // 0% = at low, 100% = at high
        };
        
        // Add Stage Trade button
        const stageButtonHtml = `
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageTradeWithThesis()" 
                        style="background:#7a8a94; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#deepDiveModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>`;
        
        document.getElementById('deepDiveContent').innerHTML = premiumHtml + formatted + stageButtonHtml;
        
    } catch (e) {
        document.getElementById('deepDiveContent').innerHTML = `
            <div style="color:#ff5252; text-align:center; padding:20px;">
                ❌ ${e.message}
            </div>
        `;
    }
};

/**
 * Analyze a Discord trade callout
 * Parses the trade text, fetches data, and runs AI analysis
 * @param {string} tradeTextOverride - Optional: pass text directly instead of reading from DOM
 * @param {string} modelOverride - Optional: pass model directly instead of reading from DOM
 */
window.analyzeDiscordTrade = async function(tradeTextOverride, modelOverride) {
    // Use overrides if provided, otherwise read from DOM
    let tradeText, model;
    
    if (tradeTextOverride) {
        tradeText = tradeTextOverride;
        model = modelOverride || 'deepseek-r1:32b';
    } else {
        const textarea = document.getElementById('pasteTradeInput');
        tradeText = textarea?.value?.trim();
        // Discord has its own selector, but falls back to global
        const discordModelSelect = document.getElementById('discordModelSelect');
        model = discordModelSelect?.value || window.getSelectedAIModel?.() || 'deepseek-r1:32b';
    }
    
    if (!tradeText) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }

    // Create modal with loading state
    const modal = document.createElement('div');
    modal.id = 'discordTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Progress steps for display
    const stepLabels = [
        'Extract trade details',
        'Fetch market data', 
        'Get CBOE pricing',
        'AI analysis'
    ];
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:25px; border:1px solid rgba(139,92,246,0.5);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="margin:0; color:#8a9aa8;">📋 Discord Trade Analysis</h2>
                <button onclick="this.closest('#discordTradeModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="discordTradeContent" style="color:#ccc;">
                <div style="text-align:center; padding:40px;">
                    <div class="spinner" style="width:50px; height:50px; border:3px solid #333; border-top:3px solid #8a9aa8; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 20px;"></div>
                    <p id="discordProgressText" style="font-size:16px; color:#8a9aa8;">Initializing...</p>
                    <div id="discordProgressSteps" style="margin-top:20px; text-align:left; display:inline-block;">
                        ${stepLabels.map((label, i) => `
                            <div id="discordStep${i+1}" style="padding:6px 0; color:#666;">
                                <span style="display:inline-block; width:24px; text-align:center;">○</span> ${label}
                            </div>
                        `).join('')}
                    </div>
                    <p id="discordElapsed" style="font-size:12px; color:#555; margin-top:15px;">Elapsed: 0s</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Start elapsed timer
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const elapsedEl = document.getElementById('discordElapsed');
        if (elapsedEl) {
            elapsedEl.textContent = `Elapsed: ${elapsed}s`;
            if (elapsed > 30) {
                elapsedEl.style.color = '#ffaa00';
                elapsedEl.textContent += ' (larger models take longer to load)';
            }
        }
    }, 1000);
    
    // Helper to update step UI
    const updateStep = (stepNum, status, message) => {
        const stepEl = document.getElementById(`discordStep${stepNum}`);
        const progressText = document.getElementById('discordProgressText');
        if (stepEl) {
            const icon = status === 'done' ? '✓' : status === 'active' ? '●' : '○';
            const color = status === 'done' ? '#00ff88' : status === 'active' ? '#8a9aa8' : '#666';
            stepEl.style.color = color;
            stepEl.querySelector('span').textContent = icon;
        }
        if (progressText && message) {
            progressText.textContent = message;
        }
    };
    
    try {
        // Gather closed positions summary for pattern matching
        // The server will use this to provide historical context
        const closedPositions = state.closedPositions || [];
        const closedSummary = closedPositions.length > 0 ? closedPositions.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            pnl: p.realizedPnL ?? p.closePnL ?? 0,
            closeDate: p.closeDate
        })) : null;
        
        // Use SSE for real-time progress
        const response = await fetch('/api/ai/parse-trade', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ tradeText, model, closedSummary })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // Keep incomplete chunk
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        // Mark previous steps as done
                        for (let i = 1; i < data.step; i++) {
                            updateStep(i, 'done');
                        }
                        // Mark current step as active
                        updateStep(data.step, 'active', data.message);
                    } else if (data.type === 'complete') {
                        // All steps done
                        for (let i = 1; i <= 4; i++) updateStep(i, 'done');
                        result = data;
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
        
        clearInterval(timerInterval);
        
        if (!result || result.error) {
            throw new Error(result?.error || 'No response received');
        }
        
        const { parsed, tickerData, premium, analysis } = result;
        
        // Helper: Convert markdown tables to HTML tables
        const convertMarkdownTables = (text) => {
            // More robust regex - handles various whitespace and separator formats
            // Pattern: header row | col | col |, separator row |---|---|, data rows
            const lines = text.split('\n');
            let result = [];
            let i = 0;
            
            while (i < lines.length) {
                const line = lines[i];
                
                // Check if this line looks like a table header (starts and ends with |, has multiple |)
                if (line.trim().startsWith('|') && line.trim().endsWith('|') && (line.match(/\|/g) || []).length >= 3) {
                    // Check if next line is separator (contains only |, -, :, spaces)
                    const nextLine = lines[i + 1] || '';
                    if (/^\|[\s\-:|]+\|$/.test(nextLine.trim())) {
                        // This is a table! Collect all rows
                        const tableLines = [line];
                        let j = i + 1;
                        
                        // Skip separator and collect data rows
                        while (j < lines.length && lines[j].trim().startsWith('|')) {
                            tableLines.push(lines[j]);
                            j++;
                        }
                        
                        // Parse and convert to HTML
                        if (tableLines.length >= 3) {
                            const headerCells = tableLines[0].split('|').map(c => c.trim()).filter(c => c);
                            const dataRows = tableLines.slice(2).map(row => 
                                row.split('|').map(c => c.trim()).filter(c => c)
                            ).filter(row => row.length > 0);
                            
                            let html = `<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px; background:#0a0a14;">`;
                            html += `<thead><tr style="background:#1a1a2e;">`;
                            headerCells.forEach(cell => {
                                html += `<th style="padding:10px 14px; border:1px solid #333; text-align:left; color:#8a9aa8; font-weight:600;">${cell}</th>`;
                            });
                            html += `</tr></thead><tbody>`;
                            
                            dataRows.forEach(row => {
                                html += `<tr style="background:#0d0d1a;">`;
                                row.forEach(cell => {
                                    html += `<td style="padding:10px 14px; border:1px solid #333; color:#ccc;">${cell}</td>`;
                                });
                                html += `</tr>`;
                            });
                            
                            html += `</tbody></table>`;
                            result.push(html);
                            i = j;
                            continue;
                        }
                    }
                }
                
                result.push(line);
                i++;
            }
            
            return result.join('\n');
        };
        
        // Format the analysis
        const formatted = convertMarkdownTables(analysis)
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#8a9aa8;">$1</strong>')
            .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
            .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
            .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
            .replace(/\n/g, '<br>');
        
        // Build strike display
        const isSpread = parsed.buyStrike || parsed.sellStrike;
        const strikeDisplay = isSpread 
            ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
            : `$${parsed.strike}`;
        
        // Validate callout premium: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumForStorage = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50 
            ? parseFloat(parsed.premium) 
            : null;
        
        // Get the model used for this analysis (Discord override or global)
        const discordModelSelect = document.getElementById('discordModelSelect');
        const modelUsed = discordModelSelect?.value || window.getSelectedAIModel?.() || 'deepseek-r1:32b';
        
        // Store parsed data for staging
        window._currentParsedTrade = {
            ticker: parsed.ticker,
            strike: parsed.strike || parsed.sellStrike,
            buyStrike: parsed.buyStrike,
            sellStrike: parsed.sellStrike,
            expiry: parsed.expiry,
            strategy: parsed.strategy,
            isSpread,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(tickerData.price),
            premium: premium || { mid: calloutPremiumForStorage || 0 },
            calloutPremium: calloutPremiumForStorage,  // Store separately for clarity
            iv: premium?.iv || null,  // Store IV at time of analysis
            modelUsed,  // Store which AI model was used
            tickerData,
            aiAnalysis: analysis,
            support: tickerData.recentSupport || [],
            sma20: tickerData.sma20,
            sma50: tickerData.sma50,
            earnings: tickerData.earnings,
            rangeHigh: tickerData.threeMonthHigh,
            rangeLow: tickerData.threeMonthLow
        };
        
        // Premium section - logic differs for selling vs buying
        // Validate: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumValid = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50;
        const effectivePremium = calloutPremiumValid ? parseFloat(parsed.premium) : (premium?.mid || 0);
        
        const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                          parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
        let premiumHtml = '';
        if (premium) {
            let entryQuality = '';
            if (calloutPremiumValid && premium.mid) {
                if (isSelling) {
                    // Selling: want to get MORE than mid
                    entryQuality = parsed.premium >= premium.mid 
                        ? '✅ got ≥ mid' 
                        : `⚠️ got ${Math.round((1 - parsed.premium/premium.mid) * 100)}% less than mid`;
                } else {
                    // Buying: want to pay LESS than mid  
                    entryQuality = parsed.premium <= premium.mid 
                        ? '✅ paid ≤ mid' 
                        : `⚠️ paid ${Math.round((parsed.premium/premium.mid - 1) * 100)}% more than mid`;
                }
            }
            const discrepancy = calloutPremiumValid && Math.abs(premium.mid - parsed.premium) > 0.5;
            premiumHtml = `
                <div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:15px; border:1px solid rgba(139,92,246,0.3);">
                    <div style="font-weight:bold; color:#8a9aa8; margin-bottom:6px;">💰 Live CBOE Pricing</div>
                    <div style="font-size:13px;">
                        Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
                        ${premium.iv ? ` | IV: ${premium.iv}%` : ''}
                        ${calloutPremiumValid ? `<br>Callout Entry: $${parsed.premium} ${entryQuality}` : '<br>Callout Entry: Not specified - using live mid'}
                        ${discrepancy ? '<br><span style="color:#ff5252;">⚠️ Large discrepancy - callout may be stale!</span>' : ''}
                    </div>
                </div>`;
        }
        
        // Show results
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#0d0d1a; padding:15px; border-radius:8px; margin-bottom:15px;">
                <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:15px; text-align:center;">
                    <div>
                        <div style="font-size:12px; color:#888;">Ticker</div>
                        <div style="font-size:20px; font-weight:bold; color:#00d9ff;">${parsed.ticker}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strategy</div>
                        <div style="font-size:14px; font-weight:bold; color:#8a9aa8;">${parsed.strategy?.replace(/_/g, ' ') || 'Unknown'}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strike</div>
                        <div style="font-size:16px; font-weight:bold;">${strikeDisplay}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Expiry</div>
                        <div style="font-size:16px; font-weight:bold;">${parsed.expiry}</div>
                    </div>
                </div>
                <div style="margin-top:10px; text-align:center; font-size:13px;">
                    Current Price: <strong style="color:#00d9ff;">$${parseFloat(tickerData.price).toFixed(2)}</strong>
                </div>
            </div>
            ${premiumHtml}
            <div style="background:#0d0d1a; padding:20px; border-radius:8px;">
                <h4 style="margin:0 0 15px; color:#8a9aa8;">AI Analysis</h4>
                <div style="white-space:pre-wrap; line-height:1.6; font-size:14px;">${formatted}</div>
            </div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <button onclick="window.stageDiscordTrade()" 
                        style="background:#7a8a94; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="window.attachThesisToPosition()" 
                        style="background:#00d9ff; color:#000; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    🔗 Attach to Existing Position
                </button>
                <button onclick="this.closest('#discordTradeModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        clearInterval(timerInterval);
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#3a1a1a; padding:20px; border-radius:8px; border:1px solid #ff5252;">
                <h4 style="color:#ff5252; margin:0 0 10px;">❌ Analysis Failed</h4>
                <p style="color:#ccc; margin:0;">${err.message}</p>
                <p style="color:#888; font-size:12px; margin-top:10px;">Try a clearer format like:<br>
                Ticker: XYZ<br>Strategy: Short Put<br>Strike: $100<br>Expiry: Feb 21<br>Entry: $2.50</p>
            </div>
        `;
    }
};

/**
 * Stage a trade from Discord callout analysis
 */
window.stageDiscordTrade = function() {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === trade.ticker && p.strike === trade.strike && p.expiry === trade.expiry);
    if (exists) {
        showNotification(`${trade.ticker} $${trade.strike} already staged`, 'info');
        return;
    }
    
    // Calculate range position
    const price = trade.priceAtAnalysis;
    const rangeHigh = parseFloat(trade.rangeHigh) || 0;
    const rangeLow = parseFloat(trade.rangeLow) || 0;
    const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
        Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
    
    // Determine position type
    let posType = 'short_put'; // default
    if (trade.strategy) {
        const strat = trade.strategy.toLowerCase();
        if (strat.includes('bull_put') || strat.includes('put_credit')) posType = 'put_credit_spread';
        else if (strat.includes('bear_call') || strat.includes('call_credit')) posType = 'call_credit_spread';
        else if (strat.includes('call_debit') || strat.includes('bull_call')) posType = 'call_debit_spread';
        else if (strat.includes('put_debit') || strat.includes('bear_put')) posType = 'put_debit_spread';
        else if (strat.includes('short_call') || strat.includes('covered')) posType = 'short_call';
        else if (strat.includes('short_put') || strat.includes('cash')) posType = 'short_put';
    }
    
    // Determine if call or put, debit or credit
    const isCallType = posType.includes('call');
    const isDebitType = posType.includes('long') || posType.includes('debit');
    
    // Create pending trade with thesis
    const pendingTrade = {
        id: Date.now(),
        ticker: trade.ticker,
        type: posType,
        strike: trade.strike,
        buyStrike: trade.buyStrike,
        sellStrike: trade.sellStrike,
        upperStrike: trade.buyStrike || trade.sellStrike,  // For spread display
        expiry: trade.expiry,
        currentPrice: trade.priceAtAnalysis,
        premium: trade.premium?.mid || 0,
        isCall: isCallType,
        isDebit: isDebitType,
        stagedAt: new Date().toISOString(),
        source: 'discord', // Mark as Discord import
        // THESIS DATA
        openingThesis: {
            analyzedAt: trade.analyzedAt,
            priceAtAnalysis: trade.priceAtAnalysis,
            support: trade.support,
            sma20: trade.sma20,
            sma50: trade.sma50,
            earnings: trade.earnings,
            rangeHigh: trade.rangeHigh,
            rangeLow: trade.rangeLow,
            rangePosition,
            premium: trade.premium,
            iv: trade.iv,  // IV at time of analysis
            modelUsed: trade.modelUsed,  // AI model used
            aiSummary: extractThesisSummary(trade.aiAnalysis)
        }
    };
    
    pending.push(pendingTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged from Discord: ${trade.ticker} ${posType.replace(/_/g, ' ')}`, 'success');
    
    // Close modal and clear
    document.getElementById('discordTradeModal')?.remove();
    window._currentParsedTrade = null;
    
    // Clear textarea
    const textarea = document.getElementById('pasteTradeInput');
    if (textarea) textarea.value = '';
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Attach thesis from Discord analysis to an existing position
 */
window.attachThesisToPosition = function() {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Get positions from localStorage
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    
    // Find matching positions (same ticker)
    const matchingPositions = positions.filter(p => 
        p.ticker.toUpperCase() === trade.ticker.toUpperCase() && 
        p.status !== 'closed'
    );
    
    if (matchingPositions.length === 0) {
        showNotification(`No open positions found for ${trade.ticker}`, 'error');
        return;
    }
    
    // If only one match, attach directly
    if (matchingPositions.length === 1) {
        attachThesisToPositionById(matchingPositions[0].id);
        return;
    }
    
    // Multiple matches - show picker modal
    const pickerModal = document.createElement('div');
    pickerModal.id = 'thesisPickerModal';
    pickerModal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10001;';
    pickerModal.onclick = (e) => { if (e.target === pickerModal) pickerModal.remove(); };
    
    const positionButtons = matchingPositions.map(p => {
        const typeDisplay = p.type.replace(/_/g, ' ').toUpperCase();
        const dte = Math.ceil((new Date(p.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        return `
            <button onclick="window.attachThesisToPositionById(${p.id}); this.closest('#thesisPickerModal').remove();"
                    style="background:#1a1a2e; border:1px solid #7a8a94; color:#fff; padding:15px; border-radius:8px; cursor:pointer; text-align:left; width:100%;">
                <div style="font-weight:bold; color:#7a8a94;">${p.ticker} $${p.strike} ${typeDisplay}</div>
                <div style="font-size:12px; color:#888;">Expires: ${p.expiry} (${dte} DTE) | ${p.contracts} contract${p.contracts > 1 ? 's' : ''}</div>
            </button>
        `;
    }).join('');
    
    pickerModal.innerHTML = `
        <div style="background:#0d0d1a; border-radius:12px; max-width:500px; width:100%; padding:25px; border:1px solid #7a8a94;">
            <h3 style="color:#7a8a94; margin:0 0 15px;">🔗 Select Position to Attach Thesis</h3>
            <p style="color:#888; margin-bottom:15px;">Multiple ${trade.ticker} positions found. Select one:</p>
            <div style="display:flex; flex-direction:column; gap:10px;">
                ${positionButtons}
            </div>
            <button onclick="this.closest('#thesisPickerModal').remove()" 
                    style="margin-top:15px; background:#333; color:#888; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; width:100%;">
                Cancel
            </button>
        </div>
    `;
    
    document.body.appendChild(pickerModal);
};

/**
 * Attach thesis to a specific position by ID
 */
window.attachThesisToPositionById = function(positionId) {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Get positions from state (the source of truth)
    const positions = window.state?.positions || JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const posIdx = positions.findIndex(p => p.id === positionId);
    
    if (posIdx < 0) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const pos = positions[posIdx];
    
    // Calculate range position
    const price = trade.priceAtAnalysis;
    const rangeHigh = parseFloat(trade.rangeHigh) || 0;
    const rangeLow = parseFloat(trade.rangeLow) || 0;
    const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
        Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
    
    // Build opening thesis object
    pos.openingThesis = {
        analyzedAt: new Date().toISOString(),
        priceAtAnalysis: price,
        rangePosition: rangePosition,
        iv: trade.iv || null,
        modelUsed: trade.model || 'deepseek-r1:32b',
        aiSummary: {
            aggressive: trade.spectrum?.aggressive || '',
            moderate: trade.spectrum?.moderate || '',
            conservative: trade.spectrum?.conservative || '',
            bottomLine: trade.spectrum?.bottomLine || '',
            probability: trade.probability || null,
            fullAnalysis: trade.analysis || ''
        }
    };
    
    // Update state and save
    if (window.state?.positions) {
        window.state.positions[posIdx] = pos;
    }
    
    // Save to localStorage - ALWAYS save directly as well for reliability
    try {
        const toSave = window.state?.positions || positions;
        localStorage.setItem('wheelhouse_positions', JSON.stringify(toSave));
        console.log(`[AttachThesis] Saved ${pos.ticker} with thesis to localStorage`);
        console.log('[AttachThesis] Thesis preview:', JSON.stringify(pos.openingThesis).substring(0, 200));
        
        // Also trigger auto-save to file if available
        if (window.savePositionsToStorage) {
            window.savePositionsToStorage();
        }
    } catch (e) {
        console.error('[AttachThesis] Failed to save:', e);
    }
    
    showNotification(`✅ Thesis attached to ${pos.ticker} $${pos.strike}`, 'success');
    
    // Re-render positions table to show the 🩺 button
    if (window.renderPositions) {
        window.renderPositions();
    }
    
    // Close modals
    document.getElementById('discordTradeModal')?.remove();
    document.getElementById('thesisPickerModal')?.remove();
    window._currentParsedTrade = null;
    
    // Clear textarea
    const textarea = document.getElementById('pasteTradeInput');
    if (textarea) textarea.value = '';
};

/**
 * Stage a trade with thesis from Deep Dive
 */
window.stageTradeWithThesis = function() {
    const thesis = window._currentThesis;
    if (!thesis) {
        showNotification('No thesis data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === thesis.ticker && p.strike === thesis.strike && p.expiry === thesis.expiry);
    if (exists) {
        showNotification(`${thesis.ticker} $${thesis.strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade with full thesis
    const trade = {
        id: Date.now(),
        ticker: thesis.ticker,
        type: 'short_put',  // Deep dive is typically for puts
        strike: thesis.strike,
        expiry: thesis.expiry,
        currentPrice: thesis.priceAtAnalysis,
        premium: thesis.premium?.mid || 0,
        isCall: false,
        isDebit: false,  // Short put = credit
        stagedAt: new Date().toISOString(),
        // THESIS DATA - for checkup later
        openingThesis: {
            analyzedAt: thesis.analyzedAt,
            priceAtAnalysis: thesis.priceAtAnalysis,
            support: thesis.support,
            sma20: thesis.sma20,
            sma50: thesis.sma50,
            earnings: thesis.earnings,
            rangeHigh: thesis.rangeHigh,
            rangeLow: thesis.rangeLow,
            rangePosition: thesis.rangePosition,  // 0% = at 3mo low, 100% = at 3mo high
            premium: thesis.premium,
            aiSummary: extractThesisSummary(thesis.aiAnalysis)
        }
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // Log AI prediction for accuracy tracking
    if (window.logAIPrediction) {
        window.logAIPrediction({
            type: 'entry',
            ticker: thesis.ticker,
            strike: thesis.strike,
            expiry: thesis.expiry,
            positionType: 'short_put',
            recommendation: 'ENTER',
            confidence: trade.openingThesis?.aiSummary?.probability || null,
            model: thesis.model || 'ollama',
            spot: thesis.priceAtAnalysis,
            premium: thesis.premium?.mid || 0
        });
    }
    
    showNotification(`📥 Staged: ${thesis.ticker} $${thesis.strike} put, ${thesis.expiry} (with thesis)`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Clear current thesis
    window._currentThesis = null;
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Extract key points from AI analysis for storage
 */
function extractThesisSummary(analysis) {
    if (!analysis) return null;
    
    // Extract verdict spectrum sections
    const aggressiveMatch = analysis.match(/(?:GREEN|AGGRESSIVE)[^:]*:([^🟡🔴]*)/is);
    const moderateMatch = analysis.match(/(?:YELLOW|MODERATE)[^:]*:([^🔴]*)/is);
    const conservativeMatch = analysis.match(/(?:RED|CONSERVATIVE)[^:]*:([^B]*)/is);
    const bottomLineMatch = analysis.match(/BOTTOM LINE:([^\n]+)/i);
    
    // Legacy verdict format fallback
    const legacyVerdictMatch = analysis.match(/(✅ FOLLOW|⚠️ PASS|❌ AVOID)[^\n]*/);
    
    // Extract probability if mentioned
    const probabilityMatch = analysis.match(/(\d+)%\s*(?:probability|chance|max profit)/i);
    
    return {
        // New spectrum format
        aggressive: aggressiveMatch ? aggressiveMatch[1].trim().substring(0, 300) : null,
        moderate: moderateMatch ? moderateMatch[1].trim().substring(0, 300) : null,
        conservative: conservativeMatch ? conservativeMatch[1].trim().substring(0, 300) : null,
        bottomLine: bottomLineMatch ? bottomLineMatch[1].trim() : null,
        probability: probabilityMatch ? parseInt(probabilityMatch[1]) : null,
        
        // Legacy format
        verdict: legacyVerdictMatch ? legacyVerdictMatch[0] : null,
        
        // Full analysis for later review
        fullAnalysis: analysis
    };
}

/**
 * Extract a section from Wall Street Mode analysis by header name
 * Looks for patterns like "MARKET ANALYSIS\n..." or "THE RISKS\n..."
 */
function extractSection(text, sectionName) {
    if (!text || !sectionName) return null;
    
    // Create pattern to match section header and capture content until next section or end
    // Sections typically end with a blank line + next header in ALL CAPS
    const pattern = new RegExp(
        sectionName + '[\\s\\n]+([\\s\\S]*?)(?=\\n(?:THE TRADE|MARKET ANALYSIS|WHY THIS STRATEGY|THE RISKS|THE NUMBERS|STRATEGIES I CONSIDERED|TRADE MANAGEMENT|$))',
        'i'
    );
    
    const match = text.match(pattern);
    if (match && match[1]) {
        // Clean up the extracted section
        return match[1].trim().substring(0, 1000);  // Limit to 1000 chars per section
    }
    return null;
}

// ============================================================
// SECTION: PORTFOLIO FIT ANALYZER
// ============================================================

/**
 * Run AI Portfolio Fit Analysis on pending trades
 */
window.runPortfolioFitAnalysis = async function() {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    if (pending.length < 2) {
        showNotification('Need at least 2 pending trades for portfolio fit analysis', 'info');
        return;
    }
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'portfolioFitModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:900px; width:95%; max-height:90vh; overflow-y:auto; padding:25px; border:1px solid rgba(122,138,148,0.5);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0; color:#7a8a94;">🧠 Portfolio Fit Analysis</h2>
                <button onclick="this.closest('#portfolioFitModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="portfolioFitContent" style="color:#ccc;">
                <div style="text-align:center; padding:40px;">
                    <div class="spinner" style="width:50px; height:50px; border:3px solid #333; border-top:3px solid #7a8a94; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 20px;"></div>
                    <p style="font-size:16px; color:#7a8a94;">Analyzing ${pending.length} candidates against your portfolio...</p>
                    <p style="font-size:12px; color:#666;">Evaluating diversification, historical edge, and position sizing</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        // Get account balances from AccountService
        const AccountService = (await import('./services/AccountService.js')).default;
        const balances = AccountService.getBalances();
        
        // Get global AI model
        const model = window.getSelectedAIModel?.() || 'qwen2.5:32b';
        
        const response = await fetch('/api/ai/portfolio-fit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                openPositions: state.positions || [],
                closedPositions: state.closedPositions || [],
                pendingTrades: pending,
                accountBalances: {
                    buyingPower: balances.buyingPower || 0,
                    accountValue: balances.accountValue || 0,
                    cashAvailable: balances.cashAvailable || 0
                },
                model
            })
        });
        
        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.error || 'Analysis failed');
        }
        
        // Format the analysis with markdown table support
        const convertMarkdownTables = (text) => {
            const lines = text.split('\n');
            let result = [];
            let i = 0;
            
            while (i < lines.length) {
                const line = lines[i];
                
                if (line.trim().startsWith('|') && line.trim().endsWith('|') && (line.match(/\|/g) || []).length >= 3) {
                    const nextLine = lines[i + 1] || '';
                    if (/^\|[\s\-:|]+\|$/.test(nextLine.trim())) {
                        const tableLines = [line];
                        let j = i + 1;
                        
                        while (j < lines.length && lines[j].trim().startsWith('|')) {
                            tableLines.push(lines[j]);
                            j++;
                        }
                        
                        if (tableLines.length >= 3) {
                            const headerCells = tableLines[0].split('|').map(c => c.trim()).filter(c => c);
                            const dataRows = tableLines.slice(2).map(row => 
                                row.split('|').map(c => c.trim()).filter(c => c)
                            ).filter(row => row.length > 0);
                            
                            let html = `<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px; background:#0a0a14;">`;
                            html += `<thead><tr style="background:#1a1a2e;">`;
                            headerCells.forEach(cell => {
                                html += `<th style="padding:10px 14px; border:1px solid #333; text-align:left; color:#7a8a94; font-weight:600;">${cell}</th>`;
                            });
                            html += `</tr></thead><tbody>`;
                            
                            dataRows.forEach(row => {
                                html += `<tr style="background:#0d0d1a;">`;
                                row.forEach(cell => {
                                    html += `<td style="padding:10px 14px; border:1px solid #333; color:#ccc;">${cell}</td>`;
                                });
                                html += `</tr>`;
                            });
                            
                            html += `</tbody></table>`;
                            result.push(html);
                            i = j;
                            continue;
                        }
                    }
                }
                
                result.push(line);
                i++;
            }
            
            return result.join('\n');
        };
        
        const formatted = convertMarkdownTables(result.analysis)
            .replace(/## (.*)/g, '<h3 style="color:#7a8a94; margin-top:20px; margin-bottom:10px;">$1</h3>')
            .replace(/### (.*)/g, '<h4 style="color:#8a9aa8; margin-top:16px; margin-bottom:8px;">$1</h4>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#ccc;">$1</strong>')
            .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
            .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
            .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
            .replace(/📊|💰|🎯/g, match => `<span style="font-size:16px;">${match}</span>`)
            .replace(/\n/g, '<br>');
        
        document.getElementById('portfolioFitContent').innerHTML = `
            <div style="background:#0d0d1a; padding:20px; border-radius:8px; line-height:1.7; font-size:14px;">
                ${formatted}
            </div>
            <div style="margin-top:20px; text-align:center;">
                <span style="color:#666; font-size:11px;">Model: ${result.model} | ${result.candidateCount} candidates analyzed against ${result.openPositionCount} open positions</span>
            </div>
        `;
        
    } catch (err) {
        document.getElementById('portfolioFitContent').innerHTML = `
            <div style="background:#3a1a1a; padding:20px; border-radius:8px; border:1px solid #ff5252;">
                <h4 style="color:#ff5252; margin:0 0 10px;">❌ Analysis Failed</h4>
                <p style="color:#ccc; margin:0;">${err.message}</p>
            </div>
        `;
    }
};

// ============================================================
// SECTION: TRADE STAGING (Pending Trades Queue)
// Functions: stageTrade, renderPendingTrades, showTickerChart,
//            confirmStagedTrade, finalizeConfirmedTrade, removeStagedTrade,
//            checkMarginForTrade
// Lines: ~2003-2485
// ============================================================

/**
 * Legacy stage function (without thesis)
 */
window.stageTrade = function(ticker, strike, expiry, currentPrice, premium) {
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade
    const trade = {
        id: Date.now(),
        ticker,
        type: 'short_put',  // Default staging is for puts
        strike: parseFloat(strike),
        expiry,
        currentPrice: parseFloat(currentPrice),
        premium: parseFloat(premium) || 0,
        isCall: false,
        isDebit: false,  // Short put = credit
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${ticker} $${strike} put, ${expiry}`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Render pending trades section
 */
window.renderPendingTrades = function() {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    let container = document.getElementById('pendingTradesSection');
    
    // Create container if it doesn't exist
    if (!container) {
        const positionsTab = document.getElementById('positions');
        if (!positionsTab) return;
        
        container = document.createElement('div');
        container.id = 'pendingTradesSection';
        positionsTab.insertBefore(container, positionsTab.firstChild);
    }
    
    if (pending.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    // Calculate DTE and annualized return for each pending trade
    const today = new Date();
    const pendingWithCalcs = pending.map(p => {
        // Parse expiry to calculate DTE
        const expiryDate = parseExpiryToDate(p.expiry);
        const expDate = expiryDate ? new Date(expiryDate) : null;
        const dte = expDate ? Math.ceil((expDate - today) / (1000 * 60 * 60 * 24)) : null;
        
        // Calculate credit/debit display (premium × 100)
        const credit = p.premium ? (p.premium * 100) : null;
        
        // Calculate annualized return based on trade type
        // Use minimum 1 DTE to avoid division by zero for 0 DTE trades
        let annReturn = null;
        const safeDte = Math.max(dte || 1, 1);
        if (p.premium && safeDte > 0) {
            const isSpread = p.type?.includes('_spread') || p.upperStrike;
            const isDebitSpread = p.isDebit || p.type?.includes('debit');
            
            if (isSpread && p.strike && p.upperStrike) {
                const spreadWidth = Math.abs(p.strike - p.upperStrike);
                
                if (isDebitSpread) {
                    // For DEBIT spreads: (Max Profit / Debit Paid) × (365 / DTE) × 100
                    // Max Profit = Spread Width - Debit
                    const maxProfit = (spreadWidth - p.premium) * 100;
                    const debitPaid = p.premium * 100;
                    if (debitPaid > 0) {
                        annReturn = ((maxProfit / debitPaid) * (365 / safeDte) * 100).toFixed(1);
                    }
                } else {
                    // For CREDIT spreads: (Premium / Spread Width) × (365 / DTE) × 100
                    const buyingPowerPerContract = spreadWidth * 100;
                    if (buyingPowerPerContract > 0) {
                        annReturn = ((p.premium * 100) / buyingPowerPerContract * (365 / safeDte) * 100).toFixed(1);
                    }
                }
            } else if (p.strike) {
                // For single legs: (premium / strike) × (365 / DTE) × 100
                annReturn = ((p.premium / p.strike) * (365 / safeDte) * 100).toFixed(1);
            }
        }
        
        return { ...p, dte, credit, annReturn };
    });
    
    container.innerHTML = `
        <div style="background:rgba(0,217,255,0.05); border:1px solid rgba(0,217,255,0.3); border-radius:8px; padding:16px; margin-bottom:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="color:#00d9ff; margin:0; font-size:14px;">📋 Pending Trades (${pending.length})</h3>
                ${pending.length >= 2 ? `<button onclick="window.runPortfolioFitAnalysis()" style="background:linear-gradient(135deg, #7a8a94, #5a6a74); color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:11px; font-weight:bold;">🧠 AI Portfolio Fit</button>` : ''}
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:12px;">
                Staged from AI analysis - confirm when you execute with your broker
            </div>
            <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <thead>
                    <tr style="color:#888; text-align:left;">
                        <th style="padding:6px;">Ticker</th>
                        <th style="padding:6px;">Strike</th>
                        <th style="padding:6px;">Expiry</th>
                        <th style="padding:6px;">DTE</th>
                        <th style="padding:6px;">Cr/Dr</th>
                        <th style="padding:6px;">Ann%</th>
                        <th style="padding:6px;">Staged</th>
                        <th style="padding:6px; min-width:180px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${pendingWithCalcs.map(p => {
                        // Determine option type - SKIP is always calls
                        const isCall = p.isCall || p.type === 'skip_call' || p.type === 'long_call' || p.type?.includes('call');
                        const optionType = isCall ? 'C' : 'P';
                        const typeColor = isCall ? '#ffaa00' : '#00d9ff';
                        // Spreads and long positions are debits, short positions are credits
                        const isSpread = p.type?.includes('_spread') || p.upperStrike;
                        const isDebit = p.isDebit || p.type === 'skip_call' || p.type === 'long_call' || p.type?.includes('debit');
                        const crDrLabel = isDebit ? 'Dr' : 'Cr';
                        const crDrColor = isDebit ? '#ff9800' : '#00d9ff';  // Orange for debit, cyan for credit
                        // Badge priority: CLOSE > ROLL > SKIP > SPREAD
                        const closeBadge = p.isClose ? '<span style="background:#ff5252;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">CLOSE</span>' : '';
                        const rollBadge = !p.isClose && p.isRoll ? '<span style="background:#7a8a94;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">ROLL</span>' : '';
                        const skipBadge = p.isSkip ? '<span style="background:#8b5cf6;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">SKIP™</span>' : '';
                        const spreadBadge = isSpread && !p.isSkip ? '<span style="background:#00bcd4;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">SPREAD</span>' : '';
                        
                        // Determine strike display based on trade type
                        let strikeDisplay, expiryDisplay, dteDisplay;
                        
                        if (p.isSkip && p.leapsStrike && p.skipStrike) {
                            // SKIP trades show both LEAPS and SKIP legs
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#ffaa00;">$${p.leapsStrike}<span style="color:#888;font-size:10px;">C</span> <span style="color:#888;font-size:9px;">LEAPS</span></div>
                                <div style="color:#ffaa00;">$${p.skipStrike}<span style="color:#888;font-size:10px;">C</span> <span style="color:#888;font-size:9px;">SKIP</span></div>
                            </div>`;
                            expiryDisplay = `<div style="line-height:1.3;">
                                <div>${p.leapsExpiry}</div>
                                <div>${p.skipExpiry}</div>
                            </div>`;
                            dteDisplay = `<div style="line-height:1.3;">
                                <div style="color:#888;">${p.leapsDte ?? '-'}</div>
                                <div style="color:#888;">${p.skipDte ?? '-'}</div>
                            </div>`;
                        } else if (isSpread && p.upperStrike) {
                            // Spread trades show buy/sell legs
                            const isBullSpread = p.type?.includes('debit') || (isCall && p.strike < p.upperStrike);
                            const buyStrike = isBullSpread ? p.strike : p.upperStrike;
                            const sellStrike = isBullSpread ? p.upperStrike : p.strike;
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#00ff88;">Buy $${buyStrike}<span style="color:#888;font-size:10px;">${optionType}</span></div>
                                <div style="color:#ff5252;">Sell $${sellStrike}<span style="color:#888;font-size:10px;">${optionType}</span></div>
                            </div>`;
                            expiryDisplay = p.expiry;
                            dteDisplay = p.dte ?? '-';
                        } else if (p.isRoll && p.rollFrom) {
                            // Roll trades show close/open legs
                            const rollType = p.isCall ? 'C' : 'P';
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#ff5252;">Close $${p.rollFrom.strike}<span style="color:#888;font-size:10px;">${rollType}</span></div>
                                <div style="color:#00ff88;">Open $${p.strike}<span style="color:#888;font-size:10px;">${rollType}</span></div>
                            </div>`;
                            expiryDisplay = `<div style="line-height:1.3;">
                                <div style="color:#888;text-decoration:line-through;">${p.rollFrom.expiry}</div>
                                <div>${p.expiry}</div>
                            </div>`;
                            dteDisplay = p.dte ?? '-';
                        } else {
                            // Single leg trades
                            strikeDisplay = `<span style="color:${typeColor};">$${p.strike}<span style="color:#888;font-size:10px;">${optionType}</span></span>`;
                            expiryDisplay = p.expiry;
                            dteDisplay = p.dte ?? '-';
                        }
                        // Calculate credit/debit display for rolls
                        let crDrDisplay = '-';
                        if (p.isRoll && p.netCost) {
                            // Show the net cost from AI (e.g. "-$930.00 debit")
                            crDrDisplay = `<span style="color:#ff9800;font-size:11px;">${p.netCost}</span>`;
                        } else if (p.credit) {
                            crDrDisplay = `<span style="color:${crDrColor};">$${p.credit.toFixed(0)} ${crDrLabel}</span>`;
                        }
                        
                        return `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:8px; color:#00ff88; font-weight:bold;">${p.ticker}${closeBadge}${rollBadge}${skipBadge}${spreadBadge}</td>
                            <td style="padding:8px;">${strikeDisplay}</td>
                            <td style="padding:8px;">${expiryDisplay}</td>
                            <td style="padding:8px;">${dteDisplay}</td>
                            <td style="padding:8px;">${crDrDisplay}</td>
                            <td style="padding:8px; color:${p.annReturn && parseFloat(p.annReturn) >= 25 ? '#00ff88' : '#ffaa00'};">${p.annReturn ? p.annReturn + '%' : '-'}</td>
                            <td style="padding:8px; color:#888;">${new Date(p.stagedAt).toLocaleDateString()}</td>
                            <td style="padding:8px;">
                                <div style="display:flex; flex-wrap:nowrap; gap:4px; justify-content:flex-start;">
                                    <button onclick="window.checkMarginForTrade('${p.ticker}', ${p.strike}, ${p.premium || 0}, ${p.isCall || false}, ${p.isRoll || false}, ${p.isDebit || false}, ${p.credit || 0}, ${p.isSkip || false}, '${p.type || ''}', ${p.upperStrike || 0})" 
                                            title="Check margin/cost"
                                            style="background:#ffaa00; color:#000; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        💳
                                    </button>
                                    <button onclick="window.showTickerChart('${p.ticker}')" 
                                            title="View 3-month chart"
                                            style="background:#00d9ff; color:#000; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        📊
                                    </button>
                                    <button onclick="window.confirmStagedTrade(${p.id})" 
                                            title="Confirm trade executed"
                                            style="background:#00ff88; color:#000; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        ✓ Confirm
                                    </button>
                                    <button onclick="window.removeStagedTrade(${p.id})" 
                                            title="Remove staged trade"
                                            style="background:#ff5252; color:#fff; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        ✕
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        </div>
    `;
};

/**
 * Show TradingView chart with Bollinger Bands for a ticker
 */
window.showTickerChart = function(ticker) {
    // Remove any existing chart modal
    document.getElementById('chartModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'chartModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.95); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Generate unique container ID
    const containerId = 'tradingview_' + Date.now();
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:90%; max-width:1000px; padding:24px; border:1px solid #00d9ff; max-height:90vh; overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h2 style="color:#00d9ff; margin:0;">📊 ${ticker} - 3 Month Chart with Bollinger Bands</h2>
                <button onclick="document.getElementById('chartModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:8px 16px; border-radius:8px; cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="${containerId}" style="height:500px; width:100%;"></div>
            <div style="margin-top:12px; font-size:11px; color:#888;">
                💡 <b>Bollinger Bands:</b> Price near lower band = potentially oversold (good for selling puts). 
                Price near upper band = potentially overbought (caution).
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Load TradingView widget script and create chart
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = function() {
        new TradingView.widget({
            "width": "100%",
            "height": 500,
            "symbol": ticker,
            "interval": "D",
            "timezone": "America/New_York",
            "theme": "dark",
            "style": "1",
            "locale": "en",
            "toolbar_bg": "#1a1a2e",
            "enable_publishing": false,
            "hide_side_toolbar": false,
            "allow_symbol_change": true,
            "range": "3M",
            "studies": ["BB@tv-basicstudies"],
            "container_id": containerId
        });
    };
    document.head.appendChild(script);
};

/**
 * Confirm a staged trade - moves to real positions
 */
window.confirmStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // For CLOSE trades, show a simpler close confirmation
    if (trade.isClose) {
        window.confirmClosePosition(id);
        return;
    }
    
    // Detect if this is a spread trade
    const isSpread = trade.type?.includes('_spread') || trade.upperStrike;
    const isCredit = trade.type?.includes('credit') || (trade.type === 'put_credit_spread' || trade.type === 'call_credit_spread');
    const isPut = trade.type?.includes('put');
    
    // For put credit spread: strike = sell (higher), upperStrike = buy (lower)
    // For call credit spread: strike = sell (lower), upperStrike = buy (higher)
    const sellStrike = trade.strike || '';
    const buyStrike = trade.upperStrike || '';
    const expiry = parseExpiryToDate(trade.expiry);
    
    // Show modal to enter actual trade details
    const modal = document.createElement('div');
    modal.id = 'confirmTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Format trade type for display
    const tradeTypeDisplay = trade.type?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Short Put';
    
    // Build strike and premium fields based on trade type
    let strikeFieldsHtml = '';
    let premiumFieldsHtml = '';
    
    if (isSpread) {
        // Spread: two strikes (dropdowns) + shift arrows + two premiums + net credit display
        strikeFieldsHtml = `
            <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:8px; align-items:end;">
                <div>
                    <label style="color:#ff5252; font-size:12px;">Sell Strike</label>
                    <select id="confirmSellStrike" 
                           onchange="window.onStrikeChange()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px; cursor:pointer;">
                        <option value="${sellStrike}">$${sellStrike} (loading...)</option>
                    </select>
                </div>
                <div style="display:flex; flex-direction:column; gap:2px; padding-bottom:2px;">
                    <button onclick="window.shiftSpread(1)" 
                            title="Shift spread UP (higher strikes)"
                            style="padding:4px 8px; background:#2a2a3e; border:1px solid #00d9ff; color:#00d9ff; border-radius:4px; cursor:pointer; font-size:14px; transition:all 0.2s;"
                            onmouseover="this.style.background='#00d9ff'; this.style.color='#000';" 
                            onmouseout="this.style.background='#2a2a3e'; this.style.color='#00d9ff';">▲</button>
                    <button onclick="window.shiftSpread(-1)" 
                            title="Shift spread DOWN (lower strikes)"
                            style="padding:4px 8px; background:#2a2a3e; border:1px solid #00d9ff; color:#00d9ff; border-radius:4px; cursor:pointer; font-size:14px; transition:all 0.2s;"
                            onmouseover="this.style.background='#00d9ff'; this.style.color='#000';" 
                            onmouseout="this.style.background='#2a2a3e'; this.style.color='#00d9ff';">▼</button>
                </div>
                <div>
                    <label style="color:#00ff88; font-size:12px;">Buy Strike (protection)</label>
                    <select id="confirmBuyStrike" 
                           onchange="window.onStrikeChange()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #00ff88; color:#fff; border-radius:4px; cursor:pointer;">
                        <option value="${buyStrike}">$${buyStrike} (loading...)</option>
                    </select>
                </div>
            </div>
            <div id="strikeLoadingStatus" style="color:#888; font-size:11px; text-align:center; margin-top:4px;">
                ⏳ Loading available strikes...
            </div>
        `;
        premiumFieldsHtml = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                    <label style="color:#ff5252; font-size:12px;">Sell Premium (received)</label>
                    <input id="confirmSellPremium" type="number" step="0.01" placeholder="e.g., 5.50"
                           oninput="window.updateNetCredit(); window.updateSpreadRisk();"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#00ff88; font-size:12px;">Buy Premium (paid)</label>
                    <input id="confirmBuyPremium" type="number" step="0.01" placeholder="e.g., 3.15"
                           oninput="window.updateNetCredit(); window.updateSpreadRisk();"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #00ff88; color:#fff; border-radius:4px;">
                </div>
            </div>
            <div style="background:#0d0d1a; padding:12px; border-radius:8px; border:1px solid #333;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span style="color:#888;">Net Credit (per share):</span>
                    <span id="netCreditPerShare" style="color:#888; font-size:14px;">${trade.premium ? '$' + trade.premium.toFixed(2) : '$0.00'}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:#00ff88; font-weight:bold;">Total Credit Received:</span>
                    <span id="netCreditDisplay" style="color:#00ff88; font-size:20px; font-weight:bold;">${trade.premium ? '$' + (trade.premium * 100).toFixed(0) : '$0'}</span>
                </div>
                <input type="hidden" id="confirmPremium" value="${trade.premium || 0}">
                ${trade.premium ? `<div style="color:#666; font-size:10px; margin-top:6px; text-align:center;">
                    💡 AI estimated ~$${trade.premium.toFixed(2)}/share net credit. Enter actual fill prices above.
                </div>` : ''}
            </div>
            <div id="spreadRiskDisplay" style="background:linear-gradient(135deg, rgba(255,82,82,0.15), rgba(255,170,0,0.1)); padding:12px; border-radius:8px; border:1px solid rgba(255,82,82,0.3); margin-top:4px;">
                <div style="font-size:11px; color:#888; margin-bottom:8px; text-transform:uppercase; letter-spacing:1px;">⚠️ Risk Analysis</div>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Spread Width:</span>
                        <div id="spreadWidthDisplay" style="color:#ffaa00; font-size:14px; font-weight:bold;">$${Math.abs(sellStrike - buyStrike).toFixed(0)}</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Risk:Reward Ratio - How much you risk to make $1. Lower is better. < 2:1 is good, > 3:1 is risky.">R:R Ratio: ℹ️</span>
                        <div id="spreadRiskRewardRatio" style="color:#00d9ff; font-size:14px; font-weight:bold; cursor:help;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Win Probability - Chance stock stays OTM at expiration. Based on delta of the sold strike. Higher is better.">Win Prob: ℹ️</span>
                        <div id="spreadWinProb" style="color:#00ff88; font-size:14px; font-weight:bold; cursor:help;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Max Loss <span id="maxLossContractCount" style="color:#666;">(1 contract)</span>:</span>
                        <div id="totalMaxLoss" style="color:#ff5252; font-size:18px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Breakeven:</span>
                        <div id="breakevenPrice" style="color:#ffaa00; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Implied Volatility - How 'expensive' premiums are. Higher IV = fatter premiums but more volatile stock. Low (<30%) | Normal (30-50%) | High (>50%)">IV: ℹ️</span>
                        <div id="spreadIvDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                </div>
            </div>
        `;
    } else {
        // Single leg: one strike dropdown + one premium + margin
        strikeFieldsHtml = `
            <div>
                <label style="color:#888; font-size:12px;">Strike Price</label>
                <select id="confirmStrike" 
                       onchange="window.onSingleStrikeChange()"
                       style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px; cursor:pointer;">
                    <option value="${trade.strike}">$${trade.strike} (loading...)</option>
                </select>
                <div id="strikeLoadingStatus" style="color:#888; font-size:11px; text-align:center; margin-top:4px;">
                    ⏳ Loading available strikes...
                </div>
            </div>
        `;
        const isCall = trade.isCall || trade.type?.includes('call');
        premiumFieldsHtml = `
            <div>
                <label style="color:#888; font-size:12px;">Premium (per share)</label>
                <div style="position:relative;">
                    <input id="confirmPremium" type="number" value="${trade.premium?.toFixed(2) || ''}" step="0.01" placeholder="Loading..."
                           oninput="window.updateSingleLegDisplay()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    <div id="premiumLoadingSpinner" style="position:absolute; right:10px; top:50%; transform:translateY(-50%); color:#00d9ff; font-size:11px;">
                        ⏳
                    </div>
                </div>
            </div>
            <div id="singleLegSummary" style="background:#0d0d1a; padding:12px; border-radius:8px; border:1px solid #333; margin-top:8px;">
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Total Credit:</span>
                        <div id="totalCreditDisplay" style="color:#00ff88; font-size:18px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Ann. Return:</span>
                        <div id="annReturnDisplay" style="color:#ffaa00; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="How far stock can drop before you lose money. Higher = more cushion = safer.">Cushion: ℹ️</span>
                        <div id="cushionDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Probability stock stays above your strike at expiry (based on delta). Higher = more likely to win.">Win Prob: ℹ️</span>
                        <div id="winProbDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Implied Volatility - How 'expensive' premiums are. Higher IV = fatter premiums but more volatile stock. Low (<30%) | Normal (30-50%) | High (>50%)">IV: ℹ️</span>
                        <div id="ivDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                </div>
            </div>
            <div id="marginRequirementSection" style="background:linear-gradient(135deg, rgba(255,170,0,0.1), rgba(0,217,255,0.05)); padding:12px; border-radius:8px; border:1px solid rgba(255,170,0,0.3); margin-top:8px;">
                <div style="font-size:11px; color:#888; margin-bottom:6px; text-transform:uppercase; letter-spacing:1px;">💳 Margin Requirement</div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Est. Margin:</span>
                        <div id="marginEstimate" style="color:#ffaa00; font-size:16px; font-weight:bold;">Calculating...</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Buying Power:</span>
                        <div id="buyingPowerDisplay" style="color:#00d9ff; font-size:14px;">Loading...</div>
                    </div>
                </div>
                <div id="marginStatus" style="margin-top:8px; font-size:11px; color:#888;">
                    Checking margin...
                </div>
            </div>
            <input type="hidden" id="confirmSpotPrice" value="0">
            <input type="hidden" id="confirmIsPut" value="${isPut ? '1' : '0'}">
        `;
    }
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:450px; padding:24px; border:1px solid #00ff88;">
            <h2 style="color:#00ff88; margin:0 0 8px 0;">✅ Confirm Trade Executed</h2>
            <div style="color:#888; font-size:12px; margin-bottom:16px; padding:8px; background:rgba(0,0,0,0.3); border-radius:4px;">
                ${isSpread ? `📊 <span style="color:#8b5cf6;">${tradeTypeDisplay}</span> - enter both legs` : tradeTypeDisplay}
            </div>
            <div style="display:grid; gap:12px;">
                <div>
                    <label style="color:#888; font-size:12px;">Ticker</label>
                    <input id="confirmTicker" type="text" value="${trade.ticker}" readonly
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                ${strikeFieldsHtml}
                ${premiumFieldsHtml}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                    <div>
                        <label style="color:#888; font-size:12px;">Contracts</label>
                        <input id="confirmContracts" type="number" value="${trade.contracts || 1}" min="1"
                               oninput="window.updateNetCredit(); window.updateSpreadRisk(); window.updateMarginDisplay();"
                               style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    </div>
                    <div>
                        <label style="color:#888; font-size:12px;">Expiry Date</label>
                        <input id="confirmExpiry" type="date" value="${expiry}"
                               style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    </div>
                </div>
                <input type="hidden" id="confirmTradeType" value="${trade.type || 'short_put'}">
                <input type="hidden" id="confirmIsSpread" value="${isSpread ? '1' : '0'}">
                <div id="priceLoadingStatus" style="color:#888; font-size:11px; text-align:center; display:none;">
                    ⏳ Fetching market prices...
                </div>
            </div>
            
            <!-- Broker Integration -->
            <div id="schwabSendSection" style="margin-top:16px; padding:12px; background:rgba(0,217,255,0.08); border:1px solid rgba(0,217,255,0.3); border-radius:8px;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="sendToSchwabCheckbox" 
                           onchange="window.updateSchwabPreview()" 
                           style="width:18px; height:18px; cursor:pointer;">
                    <span style="color:#00d9ff; font-weight:bold;">📤 Also send order to Schwab</span>
                </label>
                <div id="schwabPreviewInfo" style="display:none; margin-top:10px; font-size:12px; color:#888;">
                    <div id="schwabOrderDetails" style="padding:8px; background:rgba(0,0,0,0.3); border-radius:4px;">Loading...</div>
                </div>
            </div>
            
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button onclick="window.finalizeConfirmedTrade(${id})" 
                        style="flex:1; background:#00ff88; color:#000; border:none; padding:12px; border-radius:8px; cursor:pointer; font-weight:bold;">
                    Add to Positions
                </button>
                <button onclick="this.closest('#confirmTradeModal').remove()" 
                        style="flex:1; background:#333; color:#888; border:none; padding:12px; border-radius:8px; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Fetch option prices to pre-populate
    if (isSpread && trade.ticker && expiry) {
        fetchOptionPricesForModal(trade.ticker, sellStrike, buyStrike, expiry, isPut);
    } else if (!isSpread && trade.ticker && trade.strike && expiry) {
        fetchSingleOptionPrice(trade.ticker, trade.strike, expiry, isPut);
    }
};

/**
 * Update net credit display for spreads
 */
window.updateNetCredit = function() {
    // Only run for spreads (check if spread elements exist)
    const sellPremiumEl = document.getElementById('confirmSellPremium');
    const buyPremiumEl = document.getElementById('confirmBuyPremium');
    if (!sellPremiumEl || !buyPremiumEl) {
        // Not a spread - call single leg update instead
        window.updateSingleLegDisplay?.();
        return;
    }
    
    const sellPremium = parseFloat(sellPremiumEl.value) || 0;
    const buyPremium = parseFloat(buyPremiumEl.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const netCreditPerShare = sellPremium - buyPremium;
    const totalCredit = netCreditPerShare * 100 * contracts;
    
    const perShareDisplay = document.getElementById('netCreditPerShare');
    const totalDisplay = document.getElementById('netCreditDisplay');
    const hidden = document.getElementById('confirmPremium');
    
    if (perShareDisplay) {
        perShareDisplay.textContent = `$${netCreditPerShare.toFixed(2)}`;
    }
    if (totalDisplay) {
        totalDisplay.textContent = `$${totalCredit.toLocaleString()}`;
        totalDisplay.style.color = totalCredit >= 0 ? '#00ff88' : '#ff5252';
    }
    if (hidden) {
        hidden.value = netCreditPerShare;  // Store per-share for position
    }
};

/**
 * Update spread risk analysis display (max loss, risk:reward, breakeven)
 */
window.updateSpreadRisk = function() {
    const sellStrike = parseFloat(document.getElementById('confirmSellStrike')?.value) || 0;
    const buyStrike = parseFloat(document.getElementById('confirmBuyStrike')?.value) || 0;
    const sellPremium = parseFloat(document.getElementById('confirmSellPremium')?.value) || 0;
    const buyPremium = parseFloat(document.getElementById('confirmBuyPremium')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    
    const isPutSpread = tradeType.includes('put');
    const spreadWidth = Math.abs(sellStrike - buyStrike);
    const netCredit = sellPremium - buyPremium;
    const maxLossPerShare = spreadWidth - netCredit;  // For credit spreads
    const maxLossPerContract = maxLossPerShare * 100;
    const totalMaxLoss = maxLossPerContract * contracts;
    
    // Breakeven: for put credit spread = sell strike - net credit
    // For call credit spread = sell strike + net credit
    const breakeven = isPutSpread 
        ? (sellStrike - netCredit)
        : (sellStrike + netCredit);
    
    // Risk:Reward ratio (how much you risk to gain $1)
    const riskRewardRatio = netCredit > 0 ? (maxLossPerShare / netCredit).toFixed(2) : '-';
    const rewardRiskRatio = maxLossPerShare > 0 ? (netCredit / maxLossPerShare * 100).toFixed(0) : '-';  // As percentage return
    
    // Update displays
    const widthEl = document.getElementById('spreadWidthDisplay');
    const totalMaxLossEl = document.getElementById('totalMaxLoss');
    const contractCountEl = document.getElementById('maxLossContractCount');
    const ratioEl = document.getElementById('spreadRiskRewardRatio');
    const breakevenEl = document.getElementById('breakevenPrice');
    
    if (widthEl) widthEl.textContent = `$${spreadWidth.toFixed(0)}`;
    
    // Update contract count label
    if (contractCountEl) {
        contractCountEl.textContent = `(${contracts} contract${contracts > 1 ? 's' : ''})`;
    }
    
    if (totalMaxLossEl) {
        totalMaxLossEl.textContent = netCredit > 0 ? `$${totalMaxLoss.toLocaleString()}` : '-';
        // Color code based on severity
        if (totalMaxLoss > 5000) {
            totalMaxLossEl.style.color = '#ff5252';  // Red for large risk
        } else if (totalMaxLoss > 2000) {
            totalMaxLossEl.style.color = '#ffaa00';  // Orange for medium
        } else {
            totalMaxLossEl.style.color = '#00ff88';  // Green for manageable
        }
    }
    
    if (ratioEl) {
        if (riskRewardRatio !== '-') {
            ratioEl.textContent = `${riskRewardRatio}:1`;
            // Color code: < 2:1 is good, 2-3:1 is ok, > 3:1 is concerning
            const ratio = parseFloat(riskRewardRatio);
            let ratingText, ratingEmoji;
            if (ratio < 1.5) {
                ratioEl.style.color = '#00ff88';
                ratingText = 'Excellent';
                ratingEmoji = '🎯';
            } else if (ratio < 2) {
                ratioEl.style.color = '#00ff88';
                ratingText = 'Good';
                ratingEmoji = '✅';
            } else if (ratio < 3) {
                ratioEl.style.color = '#ffaa00';
                ratingText = 'Marginal';
                ratingEmoji = '⚠️';
            } else {
                ratioEl.style.color = '#ff5252';
                ratingText = 'Poor';
                ratingEmoji = '❌';
            }
            ratioEl.title = `${ratingEmoji} ${ratingText} - You risk $${riskRewardRatio} to make $1.\n\nIf you win, you keep $${netCredit.toFixed(2)}/share (${rewardRiskRatio}% return).\nIf you lose, max loss is $${maxLossPerShare.toFixed(2)}/share.\n\n< 1.5:1 = Excellent | < 2:1 = Good | 2-3:1 = Marginal | > 3:1 = Poor`;
        } else {
            ratioEl.textContent = '-';
            ratioEl.title = 'Risk:Reward ratio - Enter premium values to calculate';
        }
    }
    
    if (breakevenEl) {
        breakevenEl.textContent = netCredit > 0 ? `$${breakeven.toFixed(2)}` : '-';
    }
};

/**
 * Called when user changes strike dropdown - refresh prices for new strikes
 */
window.onStrikeChange = async function() {
    window.updateSpreadRisk();
    
    const ticker = document.getElementById('confirmTicker')?.value;
    const sellStrike = document.getElementById('confirmSellStrike')?.value;
    const buyStrike = document.getElementById('confirmBuyStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    const isPut = tradeType.includes('put');
    
    // Fetch prices for new strikes
    await fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut);
};

/**
 * Shift both spread strikes up or down the chain while maintaining width
 * @param {number} direction - +1 for higher strikes, -1 for lower strikes
 */
window.shiftSpread = async function(direction) {
    const sellSelect = document.getElementById('confirmSellStrike');
    const buySelect = document.getElementById('confirmBuyStrike');
    
    if (!sellSelect || !buySelect) return;
    
    // Get current values
    const currentSellStrike = parseFloat(sellSelect.value);
    const currentBuyStrike = parseFloat(buySelect.value);
    
    // Get all available strikes from the dropdown options (sorted descending = high to low)
    const allStrikes = Array.from(sellSelect.options)
        .map(opt => parseFloat(opt.value))
        .filter(s => !isNaN(s))
        .sort((a, b) => b - a);  // Descending: 160, 155, 150, 145...
    
    if (allStrikes.length < 2) {
        console.warn('[SHIFT] Not enough strikes to shift');
        return;
    }
    
    // Find current indices
    const sellIdx = allStrikes.findIndex(s => Math.abs(s - currentSellStrike) < 0.01);
    const buyIdx = allStrikes.findIndex(s => Math.abs(s - currentBuyStrike) < 0.01);
    
    if (sellIdx === -1 || buyIdx === -1) {
        console.warn('[SHIFT] Current strikes not found in list');
        return;
    }
    
    // Calculate new indices
    // direction +1 = higher strikes = lower indices (since sorted descending)
    // direction -1 = lower strikes = higher indices
    const newSellIdx = sellIdx - direction;
    const newBuyIdx = buyIdx - direction;
    
    // Check bounds
    if (newSellIdx < 0 || newSellIdx >= allStrikes.length ||
        newBuyIdx < 0 || newBuyIdx >= allStrikes.length) {
        console.log('[SHIFT] Already at edge of chain');
        // Flash the buttons to indicate edge
        const buttons = document.querySelectorAll('#confirmModal button[onclick*="shiftSpread"]');
        buttons.forEach(btn => {
            btn.style.background = '#ff5252';
            btn.style.borderColor = '#ff5252';
            setTimeout(() => {
                btn.style.background = '#2a2a3e';
                btn.style.borderColor = '#00d9ff';
            }, 200);
        });
        return;
    }
    
    // Update dropdown values
    const newSellStrike = allStrikes[newSellIdx];
    const newBuyStrike = allStrikes[newBuyIdx];
    
    sellSelect.value = newSellStrike;
    buySelect.value = newBuyStrike;
    
    console.log(`[SHIFT] Moved spread: $${currentSellStrike}/$${currentBuyStrike} → $${newSellStrike}/$${newBuyStrike} (direction: ${direction > 0 ? 'UP' : 'DOWN'})`);
    
    // Trigger price refresh (this also updates risk analysis)
    await window.onStrikeChange();
};

/**
 * Called when user changes single-leg strike dropdown
 */
window.onSingleStrikeChange = async function() {
    const ticker = document.getElementById('confirmTicker')?.value;
    const strike = document.getElementById('confirmStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const isPut = document.getElementById('confirmIsPut')?.value === '1';
    
    if (!ticker || !strike || !expiry) return;
    
    // Fetch new price for this strike
    await fetchSingleOptionPrice(ticker, strike, expiry, isPut);
};

/**
 * Update margin display based on current values (for contract changes)
 */
window.updateMarginDisplay = function() {
    const spotPrice = parseFloat(document.getElementById('confirmSpotPrice')?.value) || 100;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const isPut = document.getElementById('confirmIsPut')?.value === '1';
    
    const marginEl = document.getElementById('marginEstimate');
    const marginStatusEl = document.getElementById('marginStatus');
    
    if (!marginEl) return;
    
    // Calculate margin for one contract
    const otmAmount = isPut ? Math.max(0, strike - spotPrice) : Math.max(0, spotPrice - strike);
    const marginOption1 = 0.25 * spotPrice * 100 - otmAmount * 100;
    const marginOption2 = 0.10 * strike * 100;
    const marginPerContract = Math.max(marginOption1, marginOption2);
    const totalMargin = marginPerContract * contracts;
    
    marginEl.textContent = `$${totalMargin.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
    
    // Update affordability check
    const buyingPower = window.AccountService?.getBuyingPower?.() || 0;
    if (marginStatusEl && buyingPower > 0) {
        if (buyingPower >= totalMargin) {
            const pctUsed = ((totalMargin / buyingPower) * 100).toFixed(1);
            marginStatusEl.innerHTML = `<span style="color:#00ff88;">✅ Affordable</span> - Uses ${pctUsed}% of buying power`;
        } else {
            marginStatusEl.innerHTML = `<span style="color:#ff5252;">⚠️ Insufficient margin</span> - Need $${(totalMargin - buyingPower).toLocaleString()} more`;
        }
    }
};

/**
 * Populate single-leg strike dropdown from chain data
 */
window.populateSingleStrikeDropdown = function(options, expiry, currentStrike) {
    const strikeSelect = document.getElementById('confirmStrike');
    const statusEl = document.getElementById('strikeLoadingStatus');
    
    if (!strikeSelect) return;
    
    // Filter to target expiry and get unique strikes
    const optsAtExpiry = options.filter(o => o.expiration === expiry);
    const strikes = [...new Set(optsAtExpiry.map(o => o.strike))].sort((a, b) => b - a);  // Descending
    
    if (strikes.length === 0) {
        if (statusEl) {
            statusEl.textContent = '⚠️ No strikes found for this expiry';
            statusEl.style.color = '#ffaa00';
        }
        return;
    }
    
    // Build options HTML with bid and delta
    const optionsHtml = strikes.map(s => {
        const opt = optsAtExpiry.find(o => o.strike === s);
        let info = '';
        if (opt) {
            const bid = opt.bid?.toFixed(2) || '?';
            const delta = opt.delta ? Math.abs(opt.delta).toFixed(2) : null;
            info = delta ? ` ($${bid} | Δ${delta})` : ` (bid $${bid})`;
        }
        const selected = Math.abs(s - parseFloat(currentStrike)) < 0.01 ? 'selected' : '';
        return `<option value="${s}" ${selected}>$${s}${info}</option>`;
    }).join('');
    
    strikeSelect.innerHTML = optionsHtml;
    
    if (statusEl) {
        statusEl.textContent = `✅ ${strikes.length} strikes available`;
        statusEl.style.color = '#00ff88';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    }
};

/**
 * Update single leg display (total credit, annualized return)
 */
window.updateSingleLegDisplay = function() {
    const premium = parseFloat(document.getElementById('confirmPremium')?.value) || 0;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const spotPrice = parseFloat(document.getElementById('confirmSpotPrice')?.value) || 0;
    
    const totalCredit = premium * 100 * contracts;
    
    // Calculate DTE
    const today = new Date();
    const expDate = expiry ? new Date(expiry) : null;
    const dte = expDate ? Math.max(1, Math.ceil((expDate - today) / (1000 * 60 * 60 * 24))) : 30;
    
    // Annualized return = (premium / strike) * (365 / DTE) * 100
    const annReturn = strike > 0 ? ((premium / strike) * (365 / dte) * 100).toFixed(1) : 0;
    
    // Cushion = (Spot - Breakeven) / Spot * 100 where Breakeven = Strike - Premium
    const breakeven = strike - premium;
    const cushion = spotPrice > 0 ? ((spotPrice - breakeven) / spotPrice * 100).toFixed(1) : 0;
    
    const totalDisplay = document.getElementById('totalCreditDisplay');
    const annDisplay = document.getElementById('annReturnDisplay');
    const cushionDisplay = document.getElementById('cushionDisplay');
    const winProbDisplay = document.getElementById('winProbDisplay');
    
    if (totalDisplay) {
        totalDisplay.textContent = `$${totalCredit.toLocaleString()}`;
    }
    if (annDisplay) {
        annDisplay.textContent = `${annReturn}%`;
        annDisplay.style.color = parseFloat(annReturn) >= 25 ? '#00ff88' : '#ffaa00';
    }
    if (cushionDisplay && spotPrice > 0) {
        cushionDisplay.textContent = `${cushion}%`;
        // Color code: >15% cushion = green, 10-15% = orange, <10% = red
        cushionDisplay.style.color = parseFloat(cushion) >= 15 ? '#00ff88' : parseFloat(cushion) >= 10 ? '#ffaa00' : '#ff5252';
        cushionDisplay.title = `Breakeven: $${breakeven.toFixed(2)} (stock can drop ${cushion}% before you lose)`;
    }
};

/**
 * Populate strike dropdowns with real chain data
 */
window.populateStrikeDropdowns = function(options, expiry, currentSellStrike, currentBuyStrike) {
    const sellSelect = document.getElementById('confirmSellStrike');
    const buySelect = document.getElementById('confirmBuyStrike');
    const statusEl = document.getElementById('strikeLoadingStatus');
    
    if (!sellSelect || !buySelect) return;
    
    // Filter to target expiry and get unique strikes
    const optsAtExpiry = options.filter(o => o.expiration === expiry);
    const strikes = [...new Set(optsAtExpiry.map(o => o.strike))].sort((a, b) => b - a);  // Descending (higher strikes first)
    
    if (strikes.length === 0) {
        if (statusEl) {
            statusEl.textContent = '⚠️ No strikes found for this expiry';
            statusEl.style.color = '#ffaa00';
        }
        return;
    }
    
    // Build options HTML
    const buildOptions = (selectedValue) => {
        return strikes.map(s => {
            const opt = optsAtExpiry.find(o => o.strike === s);
            const bidAsk = opt ? ` (bid $${opt.bid?.toFixed(2) || '?'})` : '';
            const selected = Math.abs(s - parseFloat(selectedValue)) < 0.01 ? 'selected' : '';
            return `<option value="${s}" ${selected}>$${s}${bidAsk}</option>`;
        }).join('');
    };
    
    sellSelect.innerHTML = buildOptions(currentSellStrike);
    buySelect.innerHTML = buildOptions(currentBuyStrike);
    
    if (statusEl) {
        statusEl.textContent = `✅ ${strikes.length} strikes available`;
        statusEl.style.color = '#00ff88';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    }
    
    console.log(`[CONFIRM] Populated dropdowns with ${strikes.length} strikes`);
};

/**
 * Refresh option prices when user changes strikes (legacy - kept for compatibility)
 */
window.refreshSpreadPrices = async function() {
    const ticker = document.getElementById('confirmTicker')?.value;
    const sellStrike = document.getElementById('confirmSellStrike')?.value;
    const buyStrike = document.getElementById('confirmBuyStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    const isPut = tradeType.includes('put');
    
    try {
        await fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut);
        window.updateSpreadRisk();
    } catch (err) {
        console.warn('Error refreshing prices:', err);
    }
};

/**
 * Fetch option prices for spread and populate modal fields
 */
async function fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut) {
    const statusEl = document.getElementById('priceLoadingStatus');
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = '⏳ Fetching market prices...';
    }
    
    try {
        const chain = await window.fetchOptionsChain(ticker);
        if (!chain) throw new Error('No chain data');
        
        const options = isPut ? chain.puts : chain.calls;
        if (!options?.length) throw new Error('No options data');
        
        console.log(`[CONFIRM] Looking for ${ticker} ${isPut ? 'PUT' : 'CALL'} strikes $${sellStrike}/$${buyStrike} exp ${expiry}`);
        
        // Populate strike dropdowns with all available strikes at this expiry
        window.populateStrikeDropdowns(options, expiry, sellStrike, buyStrike);
        
        // Show what strikes exist at target expiry
        const targetExpOptions = options.filter(o => o.expiration === expiry);
        
        // Find matching options - try exact match first
        let sellOption = options.find(opt => 
            Math.abs(opt.strike - parseFloat(sellStrike)) < 0.01 && opt.expiration === expiry
        );
        let buyOption = options.find(opt => 
            Math.abs(opt.strike - parseFloat(buyStrike)) < 0.01 && opt.expiration === expiry
        );
        
        // Track if strike doesn't exist at target expiry
        let sellExpiryMismatch = false;
        let buyExpiryMismatch = false;
        
        if (!sellOption && targetExpOptions.length > 0) {
            console.log(`[CONFIRM] ⚠️ Sell strike $${sellStrike} not found at ${expiry}`);
            sellExpiryMismatch = true;
        }
        if (!buyOption && targetExpOptions.length > 0) {
            console.log(`[CONFIRM] ⚠️ Buy strike $${buyStrike} not found at ${expiry}`);
            buyExpiryMismatch = true;
        }
        
        console.log(`[CONFIRM] Sell option:`, sellOption ? `$${sellOption.strike} bid=${sellOption.bid} ask=${sellOption.ask}` : 'NOT FOUND');
        console.log(`[CONFIRM] Buy option:`, buyOption ? `$${buyOption.strike} bid=${buyOption.bid} ask=${buyOption.ask}` : 'NOT FOUND');
        
        // Populate fields (use mid price: (bid+ask)/2)
        if (sellOption) {
            const sellMid = (sellOption.bid + sellOption.ask) / 2;
            document.getElementById('confirmSellPremium').value = sellMid.toFixed(2);
        }
        if (buyOption) {
            const buyMid = (buyOption.bid + buyOption.ask) / 2;
            document.getElementById('confirmBuyPremium').value = buyMid.toFixed(2);
        }
        
        // Update net credit display
        window.updateNetCredit();
        
        // Small delay to ensure DOM is updated before risk calculation
        await new Promise(r => setTimeout(r, 50));
        
        // Update risk analysis display
        window.updateSpreadRisk();
        
        // Update IV display for spreads
        const spreadIvDisplay = document.getElementById('spreadIvDisplay');
        if (spreadIvDisplay && sellOption) {
            const iv = sellOption.impliedVolatility || 0;
            if (iv > 0) {
                const ivPct = (iv * 100).toFixed(0);
                const ivColor = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
                spreadIvDisplay.style.color = ivColor;
                spreadIvDisplay.textContent = `${ivPct}%`;
            }
        }
        
        // Update Win Probability for spreads (based on sell strike delta)
        const spreadWinProbEl = document.getElementById('spreadWinProb');
        if (spreadWinProbEl && sellOption) {
            const delta = sellOption.delta || 0;
            if (delta !== 0) {
                // Win prob = 100% - |delta| (for short options, prob of staying OTM)
                const winProb = (100 - Math.abs(delta) * 100).toFixed(0);
                spreadWinProbEl.textContent = `${winProb}%`;
                
                // Color code: green >=70%, orange 50-70%, red <50%
                if (winProb >= 70) {
                    spreadWinProbEl.style.color = '#00ff88';
                } else if (winProb >= 50) {
                    spreadWinProbEl.style.color = '#ffaa00';
                } else {
                    spreadWinProbEl.style.color = '#ff5252';
                }
                
                spreadWinProbEl.title = `Delta: ${delta.toFixed(2)}\nProbability stock stays OTM at expiration: ${winProb}%\n\nHigher = safer but lower premium\nLower = riskier but higher premium`;
            } else {
                spreadWinProbEl.textContent = '-';
            }
        }
        
        // Show appropriate status
        if (sellExpiryMismatch || buyExpiryMismatch) {
            const missingStrikes = [];
            if (sellExpiryMismatch) missingStrikes.push(`$${sellStrike}`);
            if (buyExpiryMismatch) missingStrikes.push(`$${buyStrike}`);
            if (statusEl) {
                statusEl.textContent = `⚠️ Strike${missingStrikes.length > 1 ? 's' : ''} ${missingStrikes.join(' & ')} not available at ${expiry}`;
                statusEl.style.color = '#ffaa00';
            }
        } else if (sellOption && buyOption) {
            if (statusEl) {
                statusEl.textContent = '✅ Prices loaded from market data';
                statusEl.style.color = '#00ff88';
                setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
            }
        } else {
            if (statusEl) {
                statusEl.textContent = '⚠️ Some prices unavailable';
                statusEl.style.color = '#ffaa00';
            }
        }
    } catch (err) {
        console.warn('Could not fetch option prices:', err.message);
        if (statusEl) {
            statusEl.textContent = '⚠️ Enter prices manually (market data unavailable)';
            statusEl.style.color = '#ffaa00';
        }
    }
}

/**
 * Fetch single option price, margin requirement, and populate modal fields
 */
async function fetchSingleOptionPrice(ticker, strike, expiry, isPut) {
    const spinnerEl = document.getElementById('premiumLoadingSpinner');
    const marginEl = document.getElementById('marginEstimate');
    const bpEl = document.getElementById('buyingPowerDisplay');
    const marginStatusEl = document.getElementById('marginStatus');
    const strikeLoadingEl = document.getElementById('strikeLoadingStatus');
    
    try {
        // Fetch option chain for premium
        const chain = await window.fetchOptionsChain(ticker);
        if (!chain) throw new Error('No chain data');
        
        const options = isPut ? chain.puts : chain.calls;
        const spotPrice = chain.spotPrice || chain.underlyingPrice || 100;
        
        // Store spot price for margin recalculations
        const spotInput = document.getElementById('confirmSpotPrice');
        if (spotInput) spotInput.value = spotPrice;
        
        // Populate strike dropdown with available strikes (like spreads do)
        if (window.populateSingleStrikeDropdown && options?.length) {
            window.populateSingleStrikeDropdown(options, expiry, strike);
        }
        
        // Find matching option for selected strike
        let premium = 0;
        let iv = 0;
        let delta = 0;
        const selectedStrike = parseFloat(document.getElementById('confirmStrike')?.value) || parseFloat(strike);
        if (options?.length) {
            const option = options.find(opt => 
                Math.abs(opt.strike - selectedStrike) < 0.01 && opt.expiration === expiry
            );
            if (option) {
                premium = (option.bid + option.ask) / 2;
                iv = option.impliedVolatility || 0;
                delta = option.delta ? Math.abs(parseFloat(option.delta)) : 0;
                const premiumInput = document.getElementById('confirmPremium');
                if (premiumInput) premiumInput.value = premium.toFixed(2);
            }
        }
        
        // Update IV display
        const ivDisplay = document.getElementById('ivDisplay');
        if (ivDisplay) {
            if (iv > 0) {
                const ivPct = (iv * 100).toFixed(0);
                // Color code: <30% blue (low), 30-50% white (normal), >50% orange (high)
                const ivColor = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
                ivDisplay.style.color = ivColor;
                ivDisplay.textContent = `${ivPct}%`;
            } else {
                ivDisplay.textContent = '-';
            }
        }
        
        // Update Win Probability display (for short options, win prob = 1 - |delta|)
        const winProbDisplay = document.getElementById('winProbDisplay');
        if (winProbDisplay) {
            if (delta > 0) {
                const winProb = Math.round((1 - delta) * 100);
                winProbDisplay.textContent = `${winProb}%`;
                // Color code: >70% green, 50-70% orange, <50% red
                winProbDisplay.style.color = winProb >= 70 ? '#00ff88' : winProb >= 50 ? '#ffaa00' : '#ff5252';
                winProbDisplay.title = `Based on delta (${(delta * 100).toFixed(0)}Δ). Higher delta = higher assignment risk, lower win prob.`;
            } else {
                winProbDisplay.textContent = '-';
            }
        }
        
        // Update display
        if (spinnerEl) spinnerEl.textContent = '✓';
        window.updateSingleLegDisplay();
        
        // Calculate margin requirement for short put/call
        // Standard formula: Max(25% × Underlying - OTM Amount, 10% × Strike) + Premium
        const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
        const otmAmount = isPut ? Math.max(0, selectedStrike - spotPrice) : Math.max(0, spotPrice - selectedStrike);
        const marginOption1 = 0.25 * spotPrice * 100 - otmAmount * 100;
        const marginOption2 = 0.10 * selectedStrike * 100;
        const marginPerContract = Math.max(marginOption1, marginOption2);
        const marginReq = marginPerContract * contracts;
        
        if (marginEl) {
            marginEl.textContent = `$${marginReq.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
        }
        
        // Fetch buying power from AccountService
        const buyingPower = window.AccountService?.getBuyingPower?.() || 0;
        if (bpEl) {
            bpEl.textContent = buyingPower > 0 ? `$${buyingPower.toLocaleString(undefined, {maximumFractionDigits: 0})}` : 'N/A';
        }
        
        // Check if trade is affordable
        if (marginStatusEl) {
            if (buyingPower > 0) {
                if (buyingPower >= marginReq) {
                    const pctUsed = ((marginReq / buyingPower) * 100).toFixed(1);
                    marginStatusEl.innerHTML = `<span style="color:#00ff88;">✅ Affordable</span> - Uses ${pctUsed}% of buying power`;
                } else {
                    marginStatusEl.innerHTML = `<span style="color:#ff5252;">⚠️ Insufficient margin</span> - Need $${(marginReq - buyingPower).toLocaleString()} more`;
                }
            } else {
                marginStatusEl.textContent = '💡 Sync portfolio to check margin';
            }
        }
        
    } catch (err) {
        console.warn('Could not fetch option price:', err.message);
        if (spinnerEl) spinnerEl.textContent = '⚠️';
        if (marginStatusEl) marginStatusEl.textContent = '⚠️ Enter price manually';
        if (strikeLoadingEl) {
            strikeLoadingEl.textContent = '⚠️ Enter strike manually';
            strikeLoadingEl.style.color = '#ffaa00';
        }
    }
}

/**
 * Parse "Feb 20" or "Mar 21" to YYYY-MM-DD
 */
function parseExpiryToDate(expiry) {
    if (!expiry) return '';
    
    // If already ISO format (2026-02-27), return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        return expiry;
    }
    
    // Parse "Feb 27" or "Feb 27, 2026" format
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const match = expiry.match(/(\w+)\s+(\d+)(?:,?\s*(\d{4}))?/);
    if (!match) return '';
    const month = monthMap[match[1]] || '01';
    const day = match[2].padStart(2, '0');
    const year = match[3] || '2026';
    return `${year}-${month}-${day}`;
}

/**
 * Confirm closing an existing position (from CLOSE staged trade)
 */
window.confirmClosePosition = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Find the original position we're closing
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const originalPos = positions.find(p => p.id === trade.rollFrom?.positionId);
    
    const isSpread = trade.type?.includes('_spread');
    const isPut = trade.type?.includes('put') || trade.isCall === false;
    const optionType = isPut ? 'PUT' : 'CALL';
    
    // Display details
    let positionDetails = '';
    if (isSpread) {
        const sellStrike = trade.strike || trade.sellStrike;
        const buyStrike = trade.buyStrike || trade.upperStrike;
        positionDetails = `$${sellStrike}/$${buyStrike} ${optionType} Spread`;
    } else {
        positionDetails = `$${trade.strike} ${optionType}`;
    }
    
    // Original premium received
    const origPremium = originalPos?.premium || 0;
    const contracts = trade.contracts || 1;
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'confirmCloseModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:400px; padding:24px; border:1px solid #ff5252;">
            <h2 style="color:#ff5252; margin:0 0 16px 0;">🔴 Close Position</h2>
            
            <div style="background:rgba(255,82,82,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <div style="font-size:24px; font-weight:bold; color:#00ff88;">${trade.ticker}</div>
                <div style="color:#888; font-size:14px;">${positionDetails}</div>
                <div style="color:#666; font-size:12px;">Exp: ${trade.expiry}</div>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="color:#888; font-size:12px;">Original Premium Received (per share)</label>
                <div style="color:#00ff88; font-size:18px; padding:8px; background:#0d0d1a; border-radius:4px;">
                    $${origPremium.toFixed(2)} Cr
                </div>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="color:#ff5252; font-size:12px;">Close Price (per share) - what you paid to buy back</label>
                <input id="closePrice" type="number" step="0.01" value="${trade.premium?.toFixed(2) || ''}" placeholder="e.g., 4.95"
                       oninput="window.updateClosePnL(${origPremium}, ${contracts})"
                       style="width:100%; padding:12px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px; font-size:16px;">
                ${trade.premium ? `<div style="color:#00d9ff; font-size:10px; margin-top:4px;">📊 Current market: $${trade.premium.toFixed(2)}/share (CBOE). Adjust if your fill differs.</div>` : ''}
            </div>
            
            <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Net P&L (per share):</span>
                    <span id="closePnLPerShare" style="color:#888;">-</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#888; font-weight:bold;">Total P&L (${contracts} contracts):</span>
                    <span id="closePnLTotal" style="font-size:20px; font-weight:bold; color:#888;">-</span>
                </div>
            </div>
            
            <div style="display:flex; gap:12px;">
                <button onclick="window.executeClosePosition(${id})" 
                        style="flex:1; padding:12px; background:linear-gradient(135deg, #ff5252, #ff1744); border:none; border-radius:8px; color:#fff; font-weight:bold; cursor:pointer;">
                    Close Position
                </button>
                <button onclick="document.getElementById('confirmCloseModal').remove()" 
                        style="flex:1; padding:12px; background:#333; border:none; border-radius:8px; color:#888; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Trigger initial P&L calculation
    setTimeout(() => window.updateClosePnL(origPremium, contracts), 100);
};

/**
 * Update the close P&L display
 */
window.updateClosePnL = function(origPremium, contracts) {
    const closePrice = parseFloat(document.getElementById('closePrice')?.value) || 0;
    const pnlPerShare = origPremium - closePrice;  // Received - paid = profit
    const totalPnL = pnlPerShare * 100 * contracts;
    
    const perShareEl = document.getElementById('closePnLPerShare');
    const totalEl = document.getElementById('closePnLTotal');
    
    if (perShareEl) {
        perShareEl.textContent = `$${pnlPerShare.toFixed(2)}`;
        perShareEl.style.color = pnlPerShare >= 0 ? '#00ff88' : '#ff5252';
    }
    if (totalEl) {
        totalEl.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`;
        totalEl.style.color = totalPnL >= 0 ? '#00ff88' : '#ff5252';
    }
};

/**
 * Execute closing the position
 */
window.executeClosePosition = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    const closePrice = parseFloat(document.getElementById('closePrice')?.value);
    if (!closePrice && closePrice !== 0) {
        showNotification('Enter close price', 'error');
        return;
    }
    
    // Find and close the original position
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const posIndex = positions.findIndex(p => p.id === trade.rollFrom?.positionId);
    
    if (posIndex === -1) {
        showNotification('Original position not found', 'error');
        return;
    }
    
    const pos = positions[posIndex];
    const origPremium = pos.premium || 0;
    const contracts = pos.contracts || 1;
    const pnlPerShare = origPremium - closePrice;
    const realizedPnL = pnlPerShare * 100 * contracts;
    
    // Move to closed positions
    const closedPos = {
        ...pos,
        status: 'closed',
        closeDate: new Date().toISOString().split('T')[0],
        closePrice: closePrice,
        closeReason: 'closed',
        realizedPnL: realizedPnL,
        daysHeld: Math.ceil((new Date() - new Date(pos.openDate || pos.stagedAt)) / (1000 * 60 * 60 * 24))
    };
    
    // Add to closed positions
    let closed = JSON.parse(localStorage.getItem('wheelhouse_closed') || '[]');
    closed.unshift(closedPos);
    localStorage.setItem('wheelhouse_closed', JSON.stringify(closed));
    
    // Remove from open positions
    positions.splice(posIndex, 1);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
    
    // Remove from pending trades
    const updatedPending = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updatedPending));
    
    // Update state
    if (window.state) {
        window.state.positions = positions;
        window.state.closedPositions = closed;
    }
    
    // Close modal
    document.getElementById('confirmCloseModal')?.remove();
    
    // Refresh UI
    if (typeof renderPositions === 'function') renderPositions();
    if (typeof renderPendingTrades === 'function') renderPendingTrades();
    
    const pnlSign = realizedPnL >= 0 ? '+' : '';
    showNotification(`✅ Closed ${trade.ticker} for ${pnlSign}$${realizedPnL.toFixed(0)}`, realizedPnL >= 0 ? 'success' : 'error');
};

/**
 * Finalize the confirmed trade - add to positions
 */
window.finalizeConfirmedTrade = async function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Check if user wants to send to Schwab
    const sendToSchwab = document.getElementById('sendToSchwabCheckbox')?.checked || false;
    
    // Get values from modal
    const ticker = document.getElementById('confirmTicker').value;
    const premium = parseFloat(document.getElementById('confirmPremium').value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts').value) || 1;
    const expiry = document.getElementById('confirmExpiry').value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'short_put';
    const isSpread = document.getElementById('confirmIsSpread')?.value === '1';
    
    // If sending to Schwab, do that first (so we can abort if it fails)
    if (sendToSchwab && !isSpread) {
        const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
        const isPut = tradeType.includes('put');
        const instruction = tradeType.startsWith('long_') ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
        
        // Use live pricing if we have it from the preview
        const livePricing = window._schwabLivePricing;
        const orderPrice = livePricing?.hasLivePricing ? livePricing.suggestedPrice : premium;
        
        try {
            // Show loading state
            const btn = document.querySelector('#confirmTradeModal button[onclick*="finalizeConfirmedTrade"]');
            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Sending to Schwab...';
                btn.style.background = '#888';
            }
            
            const res = await fetch('/api/schwab/place-option-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker,
                    strike,
                    expiry,
                    type: isPut ? 'P' : 'C',
                    instruction,
                    quantity: contracts,
                    limitPrice: orderPrice,
                    confirm: true
                })
            });
            
            const result = await res.json();
            
            if (!res.ok || !result.success) {
                throw new Error(result.error || 'Order failed');
            }
            
            showNotification(`📤 Order sent to Schwab: ${ticker} $${strike} @ $${orderPrice.toFixed(2)}`, 'success');
            
            // Clear live pricing
            window._schwabLivePricing = null;
            
        } catch (e) {
            console.error('Schwab order error:', e);
            showNotification(`❌ Schwab order failed: ${e.message}`, 'error');
            
            // Re-enable button
            const btn = document.querySelector('#confirmTradeModal button[onclick*="finalizeConfirmedTrade"]');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add to Positions';
                btn.style.background = '#00ff88';
            }
            
            // Ask if they want to continue without Schwab
            if (!confirm('Schwab order failed. Add to positions anyway (for tracking)?')) {
                return;
            }
        }
    }
    
    // Create position object
    let position = {
        id: Date.now(),
        chainId: Date.now(),
        ticker,
        type: tradeType,
        premium,
        contracts,
        expiry,
        openDate: new Date().toISOString().split('T')[0],
        status: 'open',
        broker: 'Manual',
        openingThesis: trade.openingThesis || null,
        // PMCC: Link to parent LEAPS position for nesting in UI
        parentPositionId: trade.parentPositionId || null
    };
    
    // Handle spread vs single-leg positions
    if (isSpread) {
        const sellStrike = parseFloat(document.getElementById('confirmSellStrike').value);
        const buyStrike = parseFloat(document.getElementById('confirmBuyStrike').value);
        const sellPremium = parseFloat(document.getElementById('confirmSellPremium')?.value) || 0;
        const buyPremium = parseFloat(document.getElementById('confirmBuyPremium')?.value) || 0;
        
        // For spreads, use sellStrike/buyStrike format matching positions.js
        position.sellStrike = sellStrike;
        position.buyStrike = buyStrike;
        position.spreadWidth = Math.abs(sellStrike - buyStrike);
        
        // Store individual leg premiums for record-keeping
        position.sellPremium = sellPremium;
        position.buyPremium = buyPremium;
        
        // Calculate max profit/loss for the spread
        const spreadWidth = position.spreadWidth;
        position.maxProfit = premium * 100 * contracts;
        position.maxLoss = (spreadWidth - premium) * 100 * contracts;
        
        // Calculate breakeven based on spread type
        if (tradeType === 'put_credit_spread') {
            position.breakeven = sellStrike - premium;
        } else if (tradeType === 'call_credit_spread') {
            position.breakeven = sellStrike + premium;
        }
        
        console.log(`[CONFIRM] Created ${tradeType}: Sell $${sellStrike}@${sellPremium} / Buy $${buyStrike}@${buyPremium}, net: $${premium}`);
    } else {
        // Single leg - just one strike
        const strike = parseFloat(document.getElementById('confirmStrike').value);
        position.strike = strike;
    }
    
    // Add to positions using the correct storage key based on account mode
    const { getPositionsKey } = window.state ? { getPositionsKey: () => window.state.accountMode === 'paper' ? 'wheelhouse_paper_positions' : 'wheelhouse_positions' } : { getPositionsKey: () => 'wheelhouse_positions' };
    const storageKey = getPositionsKey();
    
    const positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    positions.push(position);
    localStorage.setItem(storageKey, JSON.stringify(positions));
    
    // Remove from pending
    const updatedPending = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updatedPending));
    
    // Close modal
    document.getElementById('confirmTradeModal')?.remove();
    
    // Refresh displays
    renderPendingTrades();
    
    // Reload positions from localStorage to show the new one
    if (window.loadPositions) {
        window.loadPositions();
    }
    
    // Format success message based on trade type
    const strikeDisplay = isSpread 
        ? `$${position.sellStrike}/$${position.buyStrike} spread` 
        : `$${position.strike} ${tradeType.includes('put') ? 'put' : 'call'}`;
    
    showNotification(`✅ Added ${ticker} ${strikeDisplay} to positions!`, 'success');
};

/**
 * Update Schwab preview when checkbox is toggled
 */
window.updateSchwabPreview = async function() {
    const checkbox = document.getElementById('sendToSchwabCheckbox');
    const previewDiv = document.getElementById('schwabPreviewInfo');
    const detailsDiv = document.getElementById('schwabOrderDetails');
    const isSpread = document.getElementById('confirmIsSpread')?.value === '1';
    
    if (!checkbox?.checked) {
        if (previewDiv) previewDiv.style.display = 'none';
        return;
    }
    
    // Show preview section
    if (previewDiv) previewDiv.style.display = 'block';
    if (detailsDiv) detailsDiv.innerHTML = '⏳ Checking order requirements...';
    
    // Spreads not supported yet
    if (isSpread) {
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="color:#ffaa00;">⚠️ Spread orders not yet supported for broker integration</div>
                <div style="color:#888; font-size:11px; margin-top:4px;">This trade will be added to positions only (for tracking)</div>
            `;
        }
        return;
    }
    
    // Get trade details
    const ticker = document.getElementById('confirmTicker')?.value;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const premium = parseFloat(document.getElementById('confirmPremium')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'short_put';
    const isPut = tradeType.includes('put');
    const instruction = tradeType.startsWith('long_') ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
    const isSell = instruction === 'SELL_TO_OPEN';
    
    // Check if this short call is covered by a LEAPS or stock position
    let isCovered = false;
    let coverReason = '';
    if (!isPut && isSell) {
        // For short calls, check if user owns:
        // 1. A LEAPS call on this ticker (for PMCC)
        // 2. 100+ shares of stock (for covered call)
        const positions = window.state?.positions || JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
        const holdings = window.state?.holdings || JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
        
        console.log(`[SCHWAB] Checking coverage for ${ticker} $${strike} short call...`);
        console.log(`[SCHWAB] Found ${positions.length} positions, ${holdings.length} holdings`);
        
        // Check for LEAPS or long call that covers this short call
        const coveringPosition = positions.find(p => {
            if (p.ticker?.toUpperCase() !== ticker.toUpperCase()) return false;
            
            // For PMCC/SKIP positions, check leapsStrike
            if ((p.type === 'pmcc' || p.type === 'skip_call') && p.leapsStrike) {
                const covers = p.leapsStrike <= strike;
                if (covers) console.log(`[SCHWAB] Found covering PMCC/SKIP: LEAPS $${p.leapsStrike} covers $${strike}`);
                return covers;
            }
            
            // For long_call positions, check strike
            if (p.type === 'long_call') {
                const covers = p.strike <= strike;
                if (covers) console.log(`[SCHWAB] Found covering long call: $${p.strike} covers $${strike}`);
                return covers;
            }
            
            // Covered call means they have shares
            if (p.type === 'covered_call') {
                console.log(`[SCHWAB] Found covered_call position - implies shares owned`);
                return true;
            }
            
            return false;
        });
        
        // Check for 100+ shares in holdings
        const coveringHolding = holdings.find(h => 
            h.ticker?.toUpperCase() === ticker.toUpperCase() &&
            (h.shares || 0) >= 100
        );
        
        if (coveringHolding) {
            console.log(`[SCHWAB] Found ${coveringHolding.shares} shares of ${ticker}`);
        }
        
        isCovered = !!(coveringPosition || coveringHolding);
        coverReason = coveringPosition ? 
            (coveringPosition.type === 'long_call' ? 'LEAPS call' : coveringPosition.type.toUpperCase()) : 
            (coveringHolding ? `${coveringHolding.shares} shares` : '');
            
        if (isCovered) {
            console.log(`[SCHWAB] ✅ Short call is COVERED by ${coverReason}`);
        } else {
            console.log(`[SCHWAB] ⚠️ No covering position found - treating as naked`);
        }
    }
    
    try {
        const res = await fetch('/api/schwab/preview-option-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                strike,
                expiry,
                covered: isCovered,  // Tell backend this is a covered position
                type: isPut ? 'P' : 'C',
                instruction,
                quantity: contracts,
                limitPrice: premium
            })
        });
        
        const result = await res.json();
        
        if (!res.ok || result.error) {
            throw new Error(result.error || 'Preview failed');
        }
        
        const collateralOk = result.buyingPower >= result.collateralRequired;
        
        // Use live pricing if available
        const hasLivePricing = result.liveBid !== null && result.liveAsk !== null;
        const liveBid = result.liveBid || 0;
        const liveAsk = result.liveAsk || 0;
        const liveMid = result.liveMid || 0;
        const suggestedPrice = isSell ? liveBid : liveAsk; // For sells, get bid; for buys, get ask
        const credit = (hasLivePricing ? suggestedPrice : premium) * 100 * contracts;
        
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="font-size:11px; font-family:monospace; color:#888; margin-bottom:6px;">
                    OCC: ${result.occSymbol}
                </div>
                ${hasLivePricing ? `
                    <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:4px; padding:8px; margin-bottom:8px;">
                        <div style="font-size:10px; color:#888; text-transform:uppercase; margin-bottom:4px;">📈 Live Schwab Pricing</div>
                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
                            <div>
                                <div style="color:#888; font-size:10px;">Bid</div>
                                <div style="color:#00ff88; font-size:16px; font-weight:bold;">$${liveBid.toFixed(2)}</div>
                            </div>
                            <div>
                                <div style="color:#888; font-size:10px;">Mid</div>
                                <div style="color:#00d9ff; font-size:16px;">$${liveMid.toFixed(2)}</div>
                            </div>
                            <div>
                                <div style="color:#888; font-size:10px;">Ask</div>
                                <div style="color:#ffaa00; font-size:16px;">$${liveAsk.toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                ` : `
                    <div style="color:#ffaa00; font-size:11px; margin-bottom:8px;">
                        ⚠️ Using staged price ($${premium.toFixed(2)}) - live quote unavailable
                    </div>
                `}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                    <div>
                        <span style="color:#888;">Order:</span>
                        <span style="color:#00d9ff;">${isSell ? 'SELL' : 'BUY'} ${contracts}x @ $${(hasLivePricing ? suggestedPrice : premium).toFixed(2)}</span>
                    </div>
                    <div>
                        <span style="color:#888;">${isSell ? 'Credit' : 'Debit'}:</span>
                        <span style="color:${isSell ? '#00ff88' : '#ff5252'};">$${credit.toLocaleString()}</span>
                    </div>
                    <div>
                        <span style="color:#888;">Collateral:</span>
                        <span style="color:#ffaa00;">$${result.collateralRequired?.toLocaleString() || '?'}</span>
                    </div>
                    <div>
                        <span style="color:#888;">Buying Power:</span>
                        <span style="color:${collateralOk ? '#00ff88' : '#ff5252'};">$${result.buyingPower?.toLocaleString() || '?'}</span>
                    </div>
                </div>
                ${!collateralOk ? `
                    <div style="color:#ff5252; margin-top:8px; font-size:11px;">
                        ⚠️ Insufficient buying power - order may be rejected
                    </div>
                ` : `
                    <div style="color:#00ff88; margin-top:8px; font-size:11px;">
                        ✅ Buying power OK - order will be sent as LIMIT, DAY
                    </div>
                `}
            `;
        }
        
        // Store live pricing for use when sending order
        window._schwabLivePricing = {
            hasLivePricing,
            suggestedPrice: hasLivePricing ? suggestedPrice : premium,
            liveBid,
            liveAsk,
            liveMid
        };
        
    } catch (e) {
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="color:#ff5252;">❌ ${e.message}</div>
                <div style="color:#888; font-size:11px; margin-top:4px;">Check Schwab connection in Settings</div>
            `;
        }
    }
};

/**
 * Remove a staged trade
 */
window.removeStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const updated = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updated));
    renderPendingTrades();
    showNotification('Staged trade removed', 'info');
};

/**
 * Check margin requirement for a pending trade
 */
window.checkMarginForTrade = async function(ticker, strike, premium, isCall = false, isRoll = false, isDebit = false, totalCost = 0, isSkip = false, tradeType = '', upperStrike = 0) {
    // Detect debit trades from type if flag not set (for backwards compatibility)
    const isDebitTrade = isDebit || 
        tradeType.includes('debit') || 
        tradeType.includes('long_') || 
        tradeType === 'skip_call';
    
    const isSpread = tradeType.includes('_spread') || upperStrike > 0;
    
    // DEBIT TRADES (long calls, debit spreads, SKIP) - no margin, just need cash
    if (isDebitTrade) {
        // Get buying power from AccountService (single source of truth)
        let buyingPower = AccountService.getBuyingPower();
        if (!buyingPower) {
            await AccountService.refresh();
            buyingPower = AccountService.getBuyingPower();
        }
        
        const cost = totalCost || (premium * 100);  // Use totalCost if provided, else premium × 100
        const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        
        let verdict, verdictColor, verdictBg;
        if (buyingPower !== null) {
            const afterTrade = buyingPower - cost;
            if (afterTrade < 0) {
                verdict = `❌ INSUFFICIENT - Need ${fmt(Math.abs(afterTrade))} more`;
                verdictColor = '#ff5252';
                verdictBg = 'rgba(255,82,82,0.2)';
            } else {
                verdict = `✅ OK - ${fmt(afterTrade)} remaining after purchase`;
                verdictColor = '#00ff88';
                verdictBg = 'rgba(0,255,136,0.2)';
            }
        } else {
            verdict = '💡 Connect Schwab to check buying power';
            verdictColor = '#888';
            verdictBg = 'rgba(255,255,255,0.1)';
        }
        
        // Show debit modal
        document.getElementById('marginCheckModal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'marginCheckModal';
        modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        
        const tradeType = isSkip ? 'SKIP™ (LEAPS + Call)' : 
                          isSpread ? (isCall ? 'Call Debit Spread' : 'Put Debit Spread') :
                          isCall ? 'Long Call' : 'Long Put';
        const badgeColor = isSkip ? '#8b5cf6' : isSpread ? '#00bcd4' : '#ff9800';
        const strikeDisplay = isSpread && upperStrike ? `$${strike} / $${upperStrike}` : `$${strike}`;
        
        modal.innerHTML = `
            <div style="background:#1a1a2e; border-radius:12px; padding:24px; border:2px solid ${badgeColor}; max-width:400px; width:90%;">
                <h3 style="color:${badgeColor}; margin:0 0 16px 0;">
                    💳 Cost Check: ${ticker} <span style="background:${badgeColor};color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:6px;">DEBIT</span>
                </h3>
                
                <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Trade Type:</span>
                        <span style="color:#fff;">${tradeType}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Strike(s):</span>
                        <span style="color:#ffaa00;">${strikeDisplay}</span>
                    </div>
                    ${isSpread ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Max Loss:</span>
                        <span style="color:#ff9800;">${fmt(cost)} (the debit paid)</span>
                    </div>
                    ` : ''}
                    <div style="border-top:1px solid #333; padding-top:8px; margin-top:8px;">
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:#888;">Total Cost (Debit):</span>
                            <span style="color:#ff9800; font-weight:bold; font-size:16px;">${fmt(cost)}</span>
                        </div>
                    </div>
                </div>
                
                <div style="font-size:12px; color:#888; margin-bottom:12px;">${isSpread ? '💡 Spread - long leg covers short leg. No shares needed, no margin!' : '💡 Debit trade - you pay upfront, no margin required'}</div>
                
                ${buyingPower !== null ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                        <span style="color:#888;">Your Buying Power:</span>
                        <span style="color:#00d9ff;">${fmt(buyingPower)}</span>
                    </div>
                ` : ''}
                
                <div style="background:${verdictBg}; border:1px solid ${verdictColor}; border-radius:8px; padding:12px; text-align:center; margin-bottom:16px;">
                    <span style="color:${verdictColor}; font-weight:bold;">${verdict}</span>
                </div>
                
                <button onclick="document.getElementById('marginCheckModal').remove()" 
                        style="width:100%; padding:12px; background:#333; color:#fff; border:none; border-radius:8px; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        document.body.appendChild(modal);
        return;
    }
    
    // CREDIT TRADES (short puts, covered calls) - margin calculation
    // CREDIT TRADES (short puts, covered calls) - margin calculation
    // First fetch current stock price
    let spot = null;
    try {
        // Try Schwab first
        const schwabRes = await fetch(`/api/schwab/quotes?symbols=${ticker}`);
        if (schwabRes.ok) {
            const data = await schwabRes.json();
            spot = data[ticker]?.quote?.lastPrice || data[ticker]?.quote?.mark;
        }
        
        // Fallback to Yahoo
        if (!spot) {
            const yahooRes = await fetch(`/api/yahoo/quote/${ticker}`);
            if (yahooRes.ok) {
                const data = await yahooRes.json();
                spot = data.price;
            }
        }
    } catch (e) {
        console.log('[MARGIN] Price fetch error:', e);
    }
    
    if (!spot) {
        showNotification(`Could not fetch ${ticker} price`, 'error');
        return;
    }
    
    // Determine position type and margin
    const optionType = isCall ? 'Call' : 'Put';
    let marginRequired = 0;
    let marginNote = '';
    let isCovered = false;
    
    // Check if user owns shares (would make the call "covered")
    const holdings = JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
    const ownsShares = holdings.some(h => h.ticker?.toUpperCase() === ticker.toUpperCase() && h.shares >= 100);
    
    if (isCall && ownsShares) {
        // COVERED CALL - no margin required!
        isCovered = true;
        marginRequired = 0;
        marginNote = '✅ Covered by shares you own - no margin needed';
    } else if (isCall && !ownsShares) {
        // NAKED CALL - very high margin (treat like short stock)
        const otmAmount = Math.max(0, strike - spot);  // Positive if OTM
        const optionA = (0.20 * spot - otmAmount + premium) * 100;
        const optionB = (0.10 * strike + premium) * 100;
        marginRequired = Math.max(optionA, optionB);
        marginNote = '⚠️ Naked call - high margin. Consider owning shares first.';
    } else {
        // SHORT PUT - standard margin calculation
        const otmAmount = Math.max(0, spot - strike);  // Positive if OTM
        const optionA = (0.20 * spot - otmAmount + premium) * 100;
        const optionB = (0.10 * strike + premium) * 100;
        marginRequired = Math.max(optionA, optionB);
    }
    
    // For ROLLS, the net margin change is typically zero or near-zero
    // because you're closing one position and opening another of similar size
    let rollNote = '';
    if (isRoll) {
        if (isCovered) {
            rollNote = '🔄 Rolling covered call - no additional margin needed';
            marginRequired = 0;
        } else {
            rollNote = '🔄 Roll trade - actual margin impact will be ~$0 (closing and opening offset)';
            // For rolls, show a nominal amount but explain it's offset
        }
    }
    
    // Get buying power from AccountService (single source of truth)
    let buyingPower = AccountService.getBuyingPower();
    if (!buyingPower) {
        await AccountService.refresh();
        buyingPower = AccountService.getBuyingPower();
    }
    
    // Format helper
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    // Build verdict
    let verdict, verdictColor, verdictBg;
    
    if (isCovered || (isRoll && isCovered)) {
        // Covered or covered roll - always OK
        verdict = '✅ No margin required - covered by shares';
        verdictColor = '#00ff88';
        verdictBg = 'rgba(0,255,136,0.2)';
    } else if (isRoll) {
        // Roll (not covered) - explain the offset
        verdict = '🔄 Roll - closes old position, opens new. Net margin change ~$0';
        verdictColor = '#00d9ff';
        verdictBg = 'rgba(0,217,255,0.2)';
    } else if (buyingPower !== null) {
        const afterTrade = buyingPower - marginRequired;
        const utilization = (marginRequired / buyingPower) * 100;
        
        if (afterTrade < 0) {
            verdict = `❌ INSUFFICIENT - Need ${fmt(Math.abs(afterTrade))} more BP`;
            verdictColor = '#ff5252';
            verdictBg = 'rgba(255,82,82,0.2)';
        } else if (utilization > 50) {
            verdict = `⚠️ HIGH - Uses ${utilization.toFixed(0)}% of BP (${fmt(afterTrade)} left)`;
            verdictColor = '#ffaa00';
            verdictBg = 'rgba(255,170,0,0.2)';
        } else {
            verdict = `✅ OK - Uses ${utilization.toFixed(0)}% of BP (${fmt(afterTrade)} left)`;
            verdictColor = '#00ff88';
            verdictBg = 'rgba(0,255,136,0.2)';
        }
    } else {
        verdict = '💡 Connect Schwab to check if you can afford this';
        verdictColor = '#888';
        verdictBg = 'rgba(255,255,255,0.1)';
    }
    
    // Show modal
    document.getElementById('marginCheckModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'marginCheckModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:24px; border:2px solid ${isRoll ? '#7a8a94' : '#ffaa00'}; max-width:400px; width:90%;">
            <h3 style="color:${isRoll ? '#7a8a94' : '#ffaa00'}; margin:0 0 16px 0;">
                💳 Margin Check: ${ticker} ${isRoll ? '<span style="background:#7a8a94;color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:6px;">ROLL</span>' : ''}
            </h3>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Stock Price:</span>
                    <span style="color:#fff;">${fmt(spot)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">${optionType} Strike:</span>
                    <span style="color:${isCall ? '#ffaa00' : '#00d9ff'};">${fmt(strike)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Premium:</span>
                    <span style="color:#00ff88;">$${premium.toFixed(2)}</span>
                </div>
                ${isCovered ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Coverage:</span>
                        <span style="color:#00ff88;">✅ Own shares</span>
                    </div>
                ` : ''}
                <div style="border-top:1px solid #333; padding-top:8px; margin-top:8px;">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#888;">${isRoll ? 'Net Margin Change:' : 'Margin Required:'}</span>
                        <span style="color:#fff; font-weight:bold; font-size:16px;">${isRoll && isCovered ? '$0' : fmt(marginRequired)}</span>
                    </div>
                </div>
            </div>
            
            ${marginNote ? `<div style="font-size:12px; color:#888; margin-bottom:12px;">${marginNote}</div>` : ''}
            ${rollNote ? `<div style="font-size:12px; color:#7a8a94; margin-bottom:12px;">${rollNote}</div>` : ''}
            
            ${buyingPower !== null && !isCovered && !isRoll ? `
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Your Buying Power:</span>
                    <span style="color:#00d9ff;">${fmt(buyingPower)}</span>
                </div>
            ` : ''}
            
            <div style="background:${verdictBg}; border-radius:8px; padding:12px; text-align:center; color:${verdictColor}; font-weight:bold;">
                ${verdict}
            </div>
            
            <div style="margin-top:16px; text-align:center;">
                <button onclick="document.getElementById('marginCheckModal').remove()" 
                        style="background:#333; color:#fff; border:none; padding:10px 24px; border-radius:6px; cursor:pointer;">
                    Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

// ============================================================
// SECTION: POSITION CHECKUP & UPDATES
// Functions: runPositionCheckup, savePositionNote, restartServer, applyUpdate
// Lines: ~2488-3600
// ============================================================

/**
 * Save a user note to a position (for strategy intent)
 */
window.savePositionNote = function(positionId) {
    const noteInput = document.getElementById('positionNoteInput');
    if (!noteInput) {
        showNotification('Note input not found', 'error');
        return;
    }
    
    const note = noteInput.value.trim();
    
    // Find and update the position - check both localStorage AND in-memory state
    const isPaperMode = window.state?.accountMode === 'paper';
    const storageKey = isPaperMode ? 'wheelhouse_paper_positions' : 'wheelhouse_positions';
    let positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    
    let posIdx = positions.findIndex(p => String(p.id) === String(positionId));
    
    // If not found in localStorage, check window.state.positions (Schwab-synced positions)
    if (posIdx < 0 && window.state?.positions) {
        const statePos = window.state.positions.find(p => String(p.id) === String(positionId));
        if (statePos) {
            // Add this position to localStorage
            statePos.userNotes = note || null;
            positions.push(statePos);
            posIdx = positions.length - 1;
        }
    }
    
    if (posIdx < 0) {
        showNotification('Position not found in any source', 'error');
        return;
    }
    
    // Save the note
    positions[posIdx].userNotes = note || null;
    localStorage.setItem(storageKey, JSON.stringify(positions));
    
    // Also update in-memory state
    if (window.state?.positions) {
        const statePos = window.state.positions.find(p => String(p.id) === String(positionId));
        if (statePos) {
            statePos.userNotes = note || null;
        }
    }
    
    showNotification(note ? '📝 Strategy note saved!' : '📝 Note cleared', 'success');
    
    // Visual feedback using direct IDs
    const noteSection = document.getElementById('notesSectionContainer');
    const header = document.getElementById('notesHeader');
    const saveBtn = document.getElementById('saveNoteBtn');
    
    // Flash the section green
    if (noteSection) {
        noteSection.style.borderColor = '#00ff88';
        noteSection.style.boxShadow = '0 0 15px rgba(0,255,136,0.5)';
        setTimeout(() => {
            noteSection.style.borderColor = note ? '#00ff88' : '#333';
            noteSection.style.boxShadow = 'none';
        }, 1500);
    }
    
    // Update header
    if (header) {
        header.innerHTML = `📝 My Strategy Notes <span style="color:#00ff88;font-weight:bold;">(✓ SAVED)</span>`;
    }
    
    // Update button with confirmation
    if (saveBtn) {
        const originalText = saveBtn.innerHTML;
        const originalBg = saveBtn.style.background;
        saveBtn.innerHTML = '✅ SAVED!';
        saveBtn.style.background = '#00ff88';
        saveBtn.style.color = '#000';
        setTimeout(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.style.background = originalBg;
        }, 2000);
    }
};

/**
 * Run Monte Carlo simulation for a position to get probability estimates
 * @param {Object} pos - The position object
 * @param {number} spotPrice - Current spot price
 * @param {number} iv - Implied volatility (decimal, e.g., 0.45 for 45%)
 * @returns {Object} Probability data for AI
 */
function runPositionMonteCarlo(pos, spotPrice, iv = 0.35) {
    const numPaths = 5000;  // Fast but accurate enough
    const numSteps = 50;
    
    // Calculate DTE
    const expDate = new Date(pos.expiry);
    const dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
    const T = dte / 365.25;  // Time in years
    const dt = T / numSteps;
    const rate = 0.04;  // Risk-free rate ~4%
    
    const isSpread = pos.type?.includes('_spread');
    const isPut = pos.type?.toLowerCase().includes('put');
    const isCredit = pos.type?.includes('credit');
    
    // Determine key price levels
    let shortStrike, longStrike, breakeven;
    
    if (isSpread) {
        shortStrike = pos.sellStrike || pos.strike;
        longStrike = pos.buyStrike;
        
        // Calculate breakeven for spreads
        const netCredit = pos.premium || 2.00;  // Fallback if missing
        if (isPut && isCredit) {
            // Put credit spread: breakeven = short strike - net credit
            breakeven = shortStrike - netCredit;
        } else if (!isPut && isCredit) {
            // Call credit spread: breakeven = short strike + net credit
            breakeven = shortStrike + netCredit;
        } else if (isPut && !isCredit) {
            // Put debit spread: breakeven = long strike - net debit
            breakeven = longStrike - netCredit;
        } else {
            // Call debit spread: breakeven = long strike + net debit
            breakeven = longStrike + netCredit;
        }
    } else {
        shortStrike = pos.strike;
        longStrike = null;
        breakeven = isPut ? pos.strike - (pos.premium || 0) : pos.strike + (pos.premium || 0);
    }
    
    // Run simulation
    let aboveShortStrike = 0;
    let belowShortStrike = 0;
    let maxProfitCount = 0;
    let maxLossCount = 0;
    let profitableCount = 0;
    const finalPrices = [];
    
    for (let i = 0; i < numPaths; i++) {
        let S = spotPrice;
        
        // Simulate GBM path
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormalMC() * Math.sqrt(dt);
            S *= Math.exp((rate - 0.5 * iv * iv) * dt + iv * dW);
        }
        
        finalPrices.push(S);
        
        if (S > shortStrike) aboveShortStrike++;
        if (S < shortStrike) belowShortStrike++;
        
        // Calculate profit/loss scenarios
        if (isSpread) {
            if (isPut && isCredit) {
                // Put credit spread
                if (S >= shortStrike) maxProfitCount++;  // Keep full credit
                if (S <= longStrike) maxLossCount++;      // Max loss
                if (S >= breakeven) profitableCount++;
            } else if (!isPut && isCredit) {
                // Call credit spread
                if (S <= shortStrike) maxProfitCount++;
                if (S >= longStrike) maxLossCount++;
                if (S <= breakeven) profitableCount++;
            }
        } else {
            // Single leg options
            if (isPut) {
                if (S >= shortStrike) maxProfitCount++;  // Put expires worthless
                if (S < breakeven) maxLossCount++;
                if (S >= breakeven) profitableCount++;
            } else {
                if (S <= shortStrike) maxProfitCount++;  // Call expires worthless
                if (S > breakeven) maxLossCount++;
                if (S <= breakeven) profitableCount++;
            }
        }
    }
    
    // Calculate percentiles
    finalPrices.sort((a, b) => a - b);
    const p10 = finalPrices[Math.floor(numPaths * 0.10)];
    const p25 = finalPrices[Math.floor(numPaths * 0.25)];
    const p50 = finalPrices[Math.floor(numPaths * 0.50)];  // Median
    const p75 = finalPrices[Math.floor(numPaths * 0.75)];
    const p90 = finalPrices[Math.floor(numPaths * 0.90)];
    
    return {
        numPaths,
        dte,
        iv: (iv * 100).toFixed(0) + '%',
        spotPrice: spotPrice.toFixed(2),
        probabilities: {
            aboveShortStrike: ((aboveShortStrike / numPaths) * 100).toFixed(1) + '%',
            belowShortStrike: ((belowShortStrike / numPaths) * 100).toFixed(1) + '%',
            maxProfit: ((maxProfitCount / numPaths) * 100).toFixed(1) + '%',
            maxLoss: ((maxLossCount / numPaths) * 100).toFixed(1) + '%',
            profitable: ((profitableCount / numPaths) * 100).toFixed(1) + '%'
        },
        priceRange: {
            p10: '$' + p10.toFixed(2),
            p25: '$' + p25.toFixed(2),
            median: '$' + p50.toFixed(2),
            p75: '$' + p75.toFixed(2),
            p90: '$' + p90.toFixed(2)
        },
        strikes: {
            short: shortStrike,
            long: longStrike,
            breakeven: breakeven?.toFixed(2)
        }
    };
}

// Simple normal random for Monte Carlo (Box-Muller)
function randomNormalMC() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Run a checkup on a position - compares opening thesis to current market conditions
 */
window.runPositionCheckup = async function(positionId) {
    // Find the position - check both real and paper accounts
    const isPaperMode = window.state?.accountMode === 'paper';
    const storageKey = isPaperMode ? 'wheelhouse_paper_positions' : 'wheelhouse_positions';
    let positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    
    // Convert to string for comparison (IDs can be numbers or strings)
    const searchId = String(positionId);
    let pos = positions.find(p => String(p.id) === searchId);
    
    // If not found in current mode, try the other storage (position might have been created in different mode)
    if (!pos) {
        const altKey = isPaperMode ? 'wheelhouse_positions' : 'wheelhouse_paper_positions';
        const altPositions = JSON.parse(localStorage.getItem(altKey) || '[]');
        pos = altPositions.find(p => String(p.id) === searchId);
    }
    
    // Still not found? Try state.positions (in-memory, might not be synced to localStorage yet)
    if (!pos && window.state?.positions) {
        pos = window.state.positions.find(p => String(p.id) === searchId);
    }
    
    if (!pos) {
        console.error('[Checkup] Position not found:', positionId, 'SearchId:', searchId);
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.openingThesis) {
        showNotification('No thesis data for this position', 'error');
        return;
    }
    
    // Use global model selector (with local aiModelSelect as override)
    const model = window.getSelectedAIModel?.('aiModelSelect') || 'deepseek-r1:32b';
    
    // Create loading modal - does NOT close on outside click (user must click X)
    const modal = document.createElement('div');
    modal.id = 'checkupModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);
        display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;`;
    // Removed: modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border-radius:12px;max-width:800px;width:100%;max-height:90vh;
            overflow-y:auto;padding:25px;border:1px solid #333;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h2 style="margin:0;color:#00d9ff;">🩺 Position Checkup: ${pos.ticker}</h2>
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:8px 15px;border-radius:6px;cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="checkupContent" style="color:#ccc;">
                <div style="text-align:center;padding:40px;">
                    <div class="spinner" style="width:50px;height:50px;border:3px solid #333;
                        border-top:3px solid #00d9ff;border-radius:50%;animation:spin 1s linear infinite;
                        margin:0 auto 20px;"></div>
                    <p>Running position checkup with ${model}...</p>
                    <p style="font-size:12px;color:#666;">Comparing opening thesis to current market conditions</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Add spinner animation if not already present
    if (!document.getElementById('spinnerStyle')) {
        const style = document.createElement('style');
        style.id = 'spinnerStyle';
        style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }
    
    try {
        // First, get current spot price for Monte Carlo
        let spotPrice = pos.currentSpot || pos.lastPrice || 0;
        let iv = 0.35;  // Default 35% IV
        
        // Always fetch fresh spot price and IV for accurate Monte Carlo
        try {
            // Fetch stock quote from Yahoo
            const quoteRes = await fetch(`/api/yahoo/${pos.ticker}`);
            const quoteData = await quoteRes.json();
            // Yahoo returns: { chart: { result: [{ meta: { regularMarketPrice: 123.45 } }] } }
            const yahooPrice = quoteData.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (yahooPrice) {
                spotPrice = yahooPrice;
                console.log('[Checkup] Got spot price from Yahoo:', spotPrice);
            }
            
            // Fetch IV separately
            const ivRes = await fetch(`/api/iv/${pos.ticker}`);
            const ivData = await ivRes.json();
            if (ivData.atmIV) {
                iv = ivData.atmIV / 100;  // Convert from percentage (e.g., 45 -> 0.45)
                console.log('[Checkup] Got IV:', (iv * 100).toFixed(1) + '%');
            }
        } catch (e) {
            console.warn('[Checkup] Could not fetch market data, using fallback:', e.message);
        }
        
        // Run Monte Carlo simulation for probability estimates
        let monteCarlo = null;
        if (spotPrice > 0) {
            monteCarlo = runPositionMonteCarlo(pos, spotPrice, iv);
            console.log('[Checkup] Monte Carlo results:', monteCarlo);
        } else {
            console.warn('[Checkup] No spot price available, skipping Monte Carlo');
        }
        
        // Call checkup API - include positionType so AI knows if long or short!
        // For spreads, send both strikes
        const isSpread = pos.type?.includes('_spread');
        const response = await fetch('/api/ai/checkup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: pos.ticker,
                strike: isSpread ? pos.sellStrike : pos.strike,  // Use sellStrike for spreads
                buyStrike: isSpread ? pos.buyStrike : null,      // Include protection strike
                spreadWidth: isSpread ? pos.spreadWidth : null,
                isSpread: isSpread,
                expiry: pos.expiry,
                openingThesis: pos.openingThesis,
                analysisHistory: pos.analysisHistory || [],  // Include prior checkups!
                userNotes: pos.userNotes || null,  // User's strategy intent
                positionType: pos.type,  // Important for long vs short evaluation!
                monteCarlo: monteCarlo,  // Include probability data!
                model
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Extract recommendation from AI response (HOLD, ROLL, CLOSE)
        const checkupText = data.checkup || '';
        let recommendation = 'HOLD';  // default
        if (/\b(ROLL|roll)\b/.test(checkupText) && !/don't roll|no roll|shouldn't roll/i.test(checkupText)) {
            recommendation = 'ROLL';
        } else if (/\b(CLOSE|close now|exit)\b/i.test(checkupText) && !/don't close|shouldn't close/i.test(checkupText)) {
            recommendation = 'CLOSE';
        }
        
        // Parse suggested trade from AI response
        let suggestedTrade = null;
        const tradeMatch = checkupText.match(/===SUGGESTED_TRADE===([\s\S]*?)===END_TRADE===/);
        if (tradeMatch && recommendation !== 'HOLD') {
            const tradeBlock = tradeMatch[1];
            const action = tradeBlock.match(/ACTION:\s*(\S+)/)?.[1] || 'NONE';
            
            // Skip if action is NONE or HOLD
            if (action !== 'NONE' && action !== 'HOLD') {
                // Helper to filter out placeholder text (starts with [ or contains "e.g.")
                const cleanValue = (val) => {
                    if (!val) return null;
                    if (val.startsWith('[') || val.includes('e.g.') || val === 'N/A') return null;
                    return val;
                };
                
                suggestedTrade = {
                    action: action,
                    closeStrike: parseFloat(tradeBlock.match(/CLOSE_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                    closeExpiry: tradeBlock.match(/CLOSE_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                    closeType: tradeBlock.match(/CLOSE_TYPE:\s*(\S+)/)?.[1] || null,
                    newStrike: parseFloat(tradeBlock.match(/NEW_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                    newExpiry: tradeBlock.match(/NEW_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                    newType: tradeBlock.match(/NEW_TYPE:\s*(\S+)/)?.[1] || null,
                    estimatedDebit: cleanValue(tradeBlock.match(/ESTIMATED_DEBIT:\s*(.+)/)?.[1]?.trim()),
                    estimatedCredit: cleanValue(tradeBlock.match(/ESTIMATED_CREDIT:\s*(.+)/)?.[1]?.trim()),
                    netCost: cleanValue(tradeBlock.match(/NET_COST:\s*(.+)/)?.[1]?.trim()),
                    rationale: cleanValue(tradeBlock.match(/RATIONALE:\s*(.+)/)?.[1]?.trim()),
                    ticker: pos.ticker,
                    originalPositionId: positionId,
                    // Include current option premium from API for staging
                    currentPremium: data.currentPremium
                };
                console.log('[CHECKUP] Parsed suggested trade:', suggestedTrade);
                // Store for staging
                window._lastCheckupSuggestedTrade = suggestedTrade;
            }
        }
        
        // Log AI prediction for accuracy tracking
        if (window.logAIPrediction) {
            window.logAIPrediction({
                type: 'checkup',
                ticker: pos.ticker,
                strike: pos.strike,
                expiry: pos.expiry,
                positionType: pos.type,
                recommendation: recommendation,
                model: model,
                spot: data.currentData?.price || null,
                positionId: positionId
            });
        }
        
        // Save to position's analysisHistory
        if (!pos.analysisHistory) pos.analysisHistory = [];
        pos.analysisHistory.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            model: model,
            recommendation: recommendation,
            insight: checkupText.substring(0, 500),  // First 500 chars
            snapshot: {
                spot: parseFloat(data.currentData?.price) || null,
                strike: pos.strike,
                dte: Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24))
            }
        });
        
        // Save updated position
        const posIdx = positions.findIndex(p => p.id === positionId);
        if (posIdx >= 0) {
            positions[posIdx] = pos;
            localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
        }
        
        // Calculate DTE
        const dte = Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        
        // Build position display string (handle spreads vs single-leg)
        // Note: isSpread already declared above at line ~4053
        const strikeDisplay = isSpread 
            ? `$${pos.sellStrike}/$${pos.buyStrike}` 
            : `$${pos.strike}`;
        const typeDisplay = pos.type?.includes('put') ? 'P' : 'C';
        
        // Display result
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;text-align:center;">
                    <div>
                        <div style="font-size:12px;color:#888;">Position</div>
                        <div style="font-size:18px;font-weight:bold;color:#00d9ff;">
                            ${pos.ticker} ${strikeDisplay}${typeDisplay}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Days to Expiry</div>
                        <div style="font-size:18px;font-weight:bold;color:${dte < 7 ? '#ff5252' : dte < 21 ? '#ffaa00' : '#00ff88'};">
                            ${dte} days
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Entry Price</div>
                        <div style="font-size:18px;font-weight:bold;">
                            $${parseFloat(pos.openingThesis.priceAtAnalysis)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Current Price</div>
                        <div style="font-size:18px;font-weight:bold;color:${parseFloat(data.currentData?.price) > parseFloat(pos.openingThesis.priceAtAnalysis) ? '#00ff88' : '#ff5252'};">
                            $${parseFloat(data.currentData?.price)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <h4 style="margin:0 0 10px;color:#888;font-size:12px;text-transform:uppercase;">
                    Original Entry Thesis (${new Date(pos.openingThesis.analyzedAt).toLocaleDateString()})
                    ${pos.openingThesis.modelUsed ? `<span style="color:#666;margin-left:10px;">${pos.openingThesis.modelUsed}</span>` : ''}
                </h4>
                ${pos.openingThesis.aiSummary?.bottomLine ? `
                    <div style="color:#ffaa00;font-weight:bold;margin-bottom:8px;">
                        📊 ${pos.openingThesis.aiSummary.bottomLine}
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.probability ? `
                    <div style="color:#00d9ff;font-size:13px;margin-bottom:8px;">
                        🎯 ${pos.openingThesis.aiSummary.probability}% probability of max profit
                    </div>
                ` : ''}
                <div style="display:grid;gap:8px;font-size:12px;">
                    ${pos.openingThesis.aiSummary?.aggressive ? `
                        <div style="background:rgba(0,255,136,0.1);padding:8px;border-radius:4px;border-left:3px solid #00ff88;">
                            <span style="color:#00ff88;font-weight:bold;">🟢 AGGRESSIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.aggressive.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                    ${pos.openingThesis.aiSummary?.conservative ? `
                        <div style="background:rgba(255,82,82,0.1);padding:8px;border-radius:4px;border-left:3px solid #ff5252;">
                            <span style="color:#ff5252;font-weight:bold;">🔴 CONSERVATIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.conservative.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                </div>
                ${pos.openingThesis.iv ? `
                    <div style="margin-top:8px;font-size:11px;color:#666;">
                        IV at entry: ${pos.openingThesis.iv}% | Range: ${pos.openingThesis.rangePosition}% | 
                        Price: $${pos.openingThesis.priceAtAnalysis}
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.fullAnalysis ? `
                    <div style="margin-top:12px;">
                        <button onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none'; this.textContent = el.style.display === 'none' ? '📄 View Full Entry Analysis' : '📄 Hide Full Analysis';"
                            style="background:#1a1a2e;border:1px solid #333;color:#00d9ff;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px;">
                            📄 View Full Entry Analysis
                        </button>
                        <div style="display:none;margin-top:10px;background:#1a1a2e;padding:12px;border-radius:6px;border:1px solid #333;max-height:300px;overflow-y:auto;">
                            <div style="white-space:pre-wrap;line-height:1.5;font-size:12px;color:#ccc;">
${pos.openingThesis.aiSummary.fullAnalysis}
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
            
            <!-- User Notes Section -->
            <div id="notesSectionContainer" style="background:#1a1a2e;padding:15px;border-radius:8px;margin-bottom:15px;border:1px solid ${pos.userNotes ? '#ffaa00' : '#333'};">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <h4 id="notesHeader" style="margin:0;color:#ffaa00;font-size:12px;text-transform:uppercase;">
                        📝 My Strategy Notes ${pos.userNotes ? '(Saved)' : ''}
                    </h4>
                    <button id="saveNoteBtn" onclick="window.savePositionNote('${pos.id}')" 
                        style="background:#ffaa00;border:none;color:#000;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">
                        💾 Save Note
                    </button>
                </div>
                <textarea id="positionNoteInput" 
                    placeholder="Add your strategy intent here... e.g., 'Decided to take assignment and wheel the shares' or 'Letting this ride to expiry, comfortable with assignment'"
                    style="width:100%;height:60px;background:#0d0d1a;border:1px solid #444;border-radius:6px;color:#ccc;padding:10px;font-size:12px;resize:vertical;box-sizing:border-box;"
                >${pos.userNotes || ''}</textarea>
                <div style="font-size:10px;color:#666;margin-top:5px;">
                    💡 This note is shown to AI during checkups to adjust recommendations to your strategy.
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:20px;border-radius:8px;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">AI Checkup Analysis</h4>
                <div style="white-space:pre-wrap;line-height:1.6;font-size:14px;">
                    ${formatAIResponse(data.checkup
                        .replace(/===SUGGESTED_TRADE===[\s\S]*?===END_TRADE===/g, '')
                        .replace(/\*?\*?6\.\s*SUGGESTED TRADE\*?\*?\s*$/gm, '')
                        .replace(/\*?\*?6\.\s*SUGGESTED TRADE\*?\*?\s*\n\s*$/gm, '')
                        .trim()
                    )}
                </div>
            </div>
            
            ${suggestedTrade && suggestedTrade.action !== 'NONE' ? `
            <div style="background:linear-gradient(135deg, #1a2a3a 0%, #0d1a2a 100%);padding:20px;border-radius:8px;margin-top:15px;border:1px solid #00d9ff;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">📋 Suggested Trade</h4>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;">
                    <div style="background:#0d0d1a;padding:12px;border-radius:6px;">
                        <div style="font-size:11px;color:#888;margin-bottom:5px;">CLOSE (Buy Back)</div>
                        <div style="font-size:16px;font-weight:bold;color:#ff5252;">
                            ${pos.ticker} $${suggestedTrade.closeStrike} ${suggestedTrade.closeType}
                        </div>
                        <div style="font-size:12px;color:#888;">Exp: ${suggestedTrade.closeExpiry}</div>
                        <div style="font-size:12px;color:#ffaa00;margin-top:5px;">Est. Cost: ${suggestedTrade.estimatedDebit || 'N/A'}</div>
                    </div>
                    ${suggestedTrade.newStrike ? `
                    <div style="background:#0d0d1a;padding:12px;border-radius:6px;">
                        <div style="font-size:11px;color:#888;margin-bottom:5px;">OPEN (Sell New)</div>
                        <div style="font-size:16px;font-weight:bold;color:#00ff88;">
                            ${pos.ticker} $${suggestedTrade.newStrike} ${suggestedTrade.newType}
                        </div>
                        <div style="font-size:12px;color:#888;">Exp: ${suggestedTrade.newExpiry}</div>
                        <div style="font-size:12px;color:#00ff88;margin-top:5px;">Est. Credit: ${suggestedTrade.estimatedCredit || 'N/A'}</div>
                    </div>
                    ` : '<div></div>'}
                </div>
                <div style="margin-top:15px;padding:12px;background:#0d0d1a;border-radius:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div>
                            <span style="font-size:12px;color:#888;">Net Cost:</span>
                            <span style="font-size:18px;font-weight:bold;color:${suggestedTrade.netCost?.includes('credit') ? '#00ff88' : '#ffaa00'};margin-left:10px;">
                                ${suggestedTrade.netCost || 'N/A'}
                            </span>
                        </div>
                    </div>
                    <div style="font-size:12px;color:#aaa;margin-top:8px;">
                        💡 ${suggestedTrade.rationale || 'AI-suggested trade based on current conditions'}
                    </div>
                </div>
            </div>
            ` : ''}
            
            <div style="margin-top:15px;display:flex;gap:10px;justify-content:flex-end;">
                ${suggestedTrade && suggestedTrade.action !== 'NONE' ? `
                <button onclick="window.stageCheckupSuggestedTrade()" 
                    style="background:linear-gradient(135deg, #00d9ff 0%, #0099cc 100%);border:none;color:#000;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">
                    📥 Stage ${suggestedTrade.action === 'ROLL' ? 'Roll' : suggestedTrade.action}
                </button>
                ` : ''}
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:10px 20px;border-radius:6px;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#3a1a1a;padding:20px;border-radius:8px;border:1px solid #ff5252;">
                <h4 style="color:#ff5252;margin:0 0 10px;">❌ Checkup Failed</h4>
                <p style="color:#ccc;margin:0;">${err.message}</p>
            </div>
        `;
    }
};

/**
 * Stage the suggested trade from a checkup into pending trades
 */
window.stageCheckupSuggestedTrade = function() {
    const trade = window._lastCheckupSuggestedTrade;
    if (!trade) {
        showNotification('No suggested trade available', 'error');
        return;
    }
    
    // Get positions to find the original position details
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const originalPos = positions.find(p => p.id === trade.originalPositionId);
    
    // Check if this is a CLOSE action (not a roll to new position)
    const isCloseOnly = trade.action === 'CLOSE' || !trade.newStrike || trade.newStrike === 'N/A';
    
    // Determine the trade type for the NEW position (if rolling)
    let newType = 'short_put';  // default
    if (!isCloseOnly && trade.newType === 'CALL') {
        newType = originalPos?.type?.includes('covered') ? 'covered_call' : 'short_call';
    } else if (!isCloseOnly && trade.newType === 'PUT') {
        newType = 'short_put';
    }
    
    // Parse premium from AI estimates
    // For CLOSE: use estimatedDebit (cost to buy back), fallback to currentPremium from API
    // For ROLL: try to parse netCost
    let premium = null;
    if (isCloseOnly) {
        if (trade.estimatedDebit) {
            // Parse "$1.20" or "1.20" to number
            const parsed = parseFloat(trade.estimatedDebit.replace(/[$,]/g, ''));
            if (!isNaN(parsed)) premium = parsed;
        }
        // Fallback to actual current premium from checkup API
        if (!premium && trade.currentPremium) {
            premium = trade.currentPremium;
        }
    } else if (trade.netCost) {
        // Try to extract credit/debit amount from netCost like "$1.30 credit" or "$0.50 debit"
        const match = trade.netCost.match(/\$?([\d.]+)/);
        if (match) premium = parseFloat(match[1]);
    }
    
    // Check if original position is a spread
    const isSpread = originalPos?.type?.includes('_spread');
    
    // Create staged trade
    const now = Date.now();
    const stagedTrade = {
        id: now,
        ticker: trade.ticker,
        type: isCloseOnly ? (originalPos?.type || 'close') : newType,
        // For CLOSE: use closeStrike; for ROLL: use newStrike
        strike: isCloseOnly ? trade.closeStrike : trade.newStrike,
        expiry: isCloseOnly ? trade.closeExpiry : trade.newExpiry,
        premium: premium,  // From AI estimates
        contracts: originalPos?.contracts || 1,
        isCall: isCloseOnly ? (trade.closeType === 'CALL') : (trade.newType === 'CALL'),
        isDebit: isCloseOnly ? true : false,  // Closing is a debit (buy back)
        source: 'AI Checkup',
        stagedAt: now,
        currentPrice: null,
        // Mark as close or roll
        isRoll: !isCloseOnly,
        isClose: isCloseOnly,
        // For spreads: include both strikes from original position
        upperStrike: isSpread ? originalPos.buyStrike : null,
        sellStrike: isSpread ? originalPos.sellStrike : null,
        buyStrike: isSpread ? originalPos.buyStrike : null,
        spreadWidth: isSpread ? originalPos.spreadWidth : null,
        rollFrom: {
            positionId: trade.originalPositionId,
            strike: trade.closeStrike,
            expiry: trade.closeExpiry,
            type: trade.closeType
        },
        // Opening thesis from AI checkup recommendation
        openingThesis: {
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: null,
            rationale: trade.rationale,
            netCost: trade.netCost,
            modelUsed: 'AI Checkup',
            aiSummary: {
                bottomLine: isCloseOnly 
                    ? `CLOSE: Buy back $${trade.closeStrike} ${trade.closeType} at ${trade.netCost || 'market'}`
                    : `${trade.action}: Roll from $${trade.closeStrike} to $${trade.newStrike} ${trade.newType}`,
                fullAnalysis: trade.rationale
            }
        }
    };
    
    // Add to pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const isDuplicate = pending.some(p => 
        p.ticker === stagedTrade.ticker && 
        p.strike === stagedTrade.strike && 
        p.expiry === stagedTrade.expiry
    );
    
    if (isDuplicate) {
        const strikeDisplay = isCloseOnly ? trade.closeStrike : trade.newStrike;
        showNotification(`${trade.ticker} $${strikeDisplay} already staged`, 'info');
        return;
    }
    
    pending.unshift(stagedTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // Close the checkup modal
    document.getElementById('checkupModal')?.remove();
    
    // Render pending trades
    renderPendingTrades();
    
    // Different notification for CLOSE vs ROLL
    if (isCloseOnly) {
        showNotification(`📥 Staged close: ${trade.ticker} $${trade.closeStrike} ${trade.closeType}`, 'success');
    } else {
        showNotification(`📥 Staged roll: ${trade.ticker} $${trade.closeStrike} → $${trade.newStrike} ${trade.newType}`, 'success');
    }
};

/**
 * Format AI response with proper styling - converts markdown to beautiful HTML
 */
function formatAIResponse(text) {
    if (!text) return '';
    
    let html = text;
    
    // First, escape any existing HTML to prevent XSS
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // IMPORTANT: Use function replacements to prevent $94 being interpreted as capture group 94
    // When replacement string contains $N, JavaScript interprets it as backreference!
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: INLINE TEXT STYLING (must happen BEFORE structural HTML is added)
    // This prevents the percentage/dollar regex from matching values inside CSS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Style dollar amounts - green for positive context
    html = html.replace(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/g, (match, p1) =>
        `<span style="color:#00ff88; font-weight:bold;">$${p1}</span>`);
    
    // Style percentages (but NOT inside style="" attributes - those come later)
    html = html.replace(/(\d+(?:\.\d+)?%)/g, (match, p1) =>
        `<span style="color:#00d9ff; font-weight:bold;">${p1}</span>`);
    
    // Style specific keywords/values
    html = html.replace(/Max Profit:/g, '<span style="color:#22c55e; font-weight:bold;">Max Profit:</span>');
    html = html.replace(/Max Loss:/g, '<span style="color:#ff5252; font-weight:bold;">Max Loss:</span>');
    html = html.replace(/Breakeven:/g, '<span style="color:#ffaa00; font-weight:bold;">Breakeven:</span>');
    html = html.replace(/Win Probability:/g, '<span style="color:#00d9ff; font-weight:bold;">Win Probability:</span>');
    html = html.replace(/Risk\/Reward Ratio:/g, '<span style="color:#a78bfa; font-weight:bold;">Risk/Reward Ratio:</span>');
    html = html.replace(/Buying Power Used:/g, '<span style="color:#8b5cf6; font-weight:bold;">Buying Power Used:</span>');
    html = html.replace(/Delta Exposure:/g, '<span style="color:#00d9ff; font-weight:bold;">Delta Exposure:</span>');
    html = html.replace(/Action:/g, '<span style="color:#22c55e; font-weight:bold;">Action:</span>');
    html = html.replace(/Expiration:/g, '<span style="color:#ffaa00; font-weight:bold;">Expiration:</span>');
    html = html.replace(/Credit\/Debit:/g, '<span style="color:#00d9ff; font-weight:bold;">Credit/Debit:</span>');
    html = html.replace(/Contracts:/g, '<span style="color:#a78bfa; font-weight:bold;">Contracts:</span>');
    
    // Convert bold **text** - make it stand out
    html = html.replace(/\*\*([^*]+)\*\*/g, (match, p1) =>
        `<strong style="color:#fff; background:rgba(255,255,255,0.1); padding:1px 4px; border-radius:3px;">${p1}</strong>`);
    
    // Convert emoji colors
    html = html.replace(/✅/g, '<span style="color:#00ff88;">✅</span>');
    html = html.replace(/❌/g, '<span style="color:#ff5252;">❌</span>');
    html = html.replace(/🟢/g, '<span style="color:#00ff88;">🟢</span>');
    html = html.replace(/🟡/g, '<span style="color:#ffaa00;">🟡</span>');
    html = html.replace(/🔴/g, '<span style="color:#ff5252;">🔴</span>');
    html = html.replace(/📈/g, '<span style="color:#00ff88;">📈</span>');
    html = html.replace(/📉/g, '<span style="color:#ff5252;">📉</span>');
    html = html.replace(/💡/g, '<span style="color:#ffaa00;">💡</span>');
    html = html.replace(/📚/g, '<span style="color:#a78bfa;">📚</span>');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: STRUCTURAL HTML (headers, bullets, etc with CSS gradients)
    // Done AFTER inline styling so percentages like "0%" in CSS won't get styled
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert ## headers (main sections) - with colored background
    html = html.replace(/^## 🏆 (.*?)$/gm, (match, p1) =>
        `<div style="background:linear-gradient(135deg, rgba(34,197,94,0.2) 0%, rgba(34,197,94,0.1) 100%); border:1px solid rgba(34,197,94,0.4); border-radius:8px; padding:12px 16px; margin:20px 0 15px 0;"><span style="font-size:18px; font-weight:bold; color:#22c55e;">🏆 ${p1}</span></div>`);
    
    html = html.replace(/^## (.*?)$/gm, (match, p1) =>
        `<div style="background:rgba(147,51,234,0.15); border-left:4px solid #9333ea; padding:10px 15px; margin:20px 0 12px 0; font-size:16px; font-weight:bold; color:#a78bfa;">${p1}</div>`);
    
    // Convert ### headers (subsections) - cyan accent
    html = html.replace(/^### (.*?)$/gm, (match, p1) =>
        `<div style="color:#00d9ff; font-weight:bold; font-size:14px; margin:18px 0 8px 0; padding-bottom:5px; border-bottom:1px solid rgba(0,217,255,0.3);">${p1}</div>`);
    
    // Convert bullet points with • or -
    html = html.replace(/^• (.*?)$/gm, (match, p1) =>
        `<div style="margin:6px 0 6px 20px; padding-left:12px; border-left:2px solid #444;">${p1}</div>`);
    html = html.replace(/^- (.*?)$/gm, (match, p1) =>
        `<div style="margin:6px 0 6px 20px; padding-left:12px; border-left:2px solid #444;">${p1}</div>`);
    
    // Convert numbered lists (1. 2. 3. etc)
    html = html.replace(/^(\d+)\. (.*?)$/gm, (match, p1, p2) =>
        `<div style="margin:8px 0 8px 20px; display:flex; gap:8px;"><span style="color:#8b5cf6; font-weight:bold; min-width:20px;">${p1}.</span><span style="flex:1;">${p2}</span></div>`);
    
    // Convert warning lines (⚠️)
    html = html.replace(/(⚠️[^<\n]*)/g, (match, p1) =>
        `<div style="background:rgba(255,170,0,0.1); border-left:3px solid #ffaa00; padding:8px 12px; margin:6px 0; color:#ffcc00;">${p1}</div>`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2.5: MARKDOWN TABLES → HTML TABLES
    // Matches pipe-delimited tables and converts to styled HTML
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert markdown tables to HTML
    // Regex: Match lines starting and ending with |, capture everything between
    const tableRegex = /(\|[^\n]+\|\n\|[-:\|\s]+\|\n(?:\|[^\n]+\|\n?)+)/g;
    html = html.replace(tableRegex, (tableBlock) => {
        const rows = tableBlock.trim().split('\n').filter(r => r.trim());
        if (rows.length < 2) return tableBlock;
        
        let tableHtml = '<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:12px;">';
        
        rows.forEach((row, idx) => {
            // Skip separator row (contains only |, -, :, and spaces)
            if (/^\|[\s\-:\|]+\|$/.test(row)) return;
            
            const cells = row.split('|').filter(c => c.trim() !== '');
            const isHeader = idx === 0;
            const tag = isHeader ? 'th' : 'td';
            const bgColor = isHeader ? 'rgba(147,51,234,0.2)' : (idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.2)');
            const fontWeight = isHeader ? 'bold' : 'normal';
            const borderColor = isHeader ? '#9333ea' : '#333';
            
            tableHtml += `<tr style="background:${bgColor};">`;
            cells.forEach(cell => {
                tableHtml += `<${tag} style="padding:8px 12px; border:1px solid ${borderColor}; color:${isHeader ? '#a78bfa' : '#ddd'}; font-weight:${fontWeight}; text-align:left;">${cell.trim()}</${tag}>`;
            });
            tableHtml += '</tr>';
        });
        
        tableHtml += '</table>';
        return tableHtml;
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: LINE BREAKS AND FINAL WRAPPING
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert line breaks to proper spacing (but not inside already-styled divs)
    // Double line breaks = paragraph break
    html = html.replace(/\n\n/g, '</p><p style="margin:12px 0;">');
    // Single line breaks that aren't already handled
    html = html.replace(/\n/g, '<br>');
    
    // Wrap in container
    html = '<div style="line-height:1.6;">' + html + '</div>';
    
    return html;
}

/**
 * Check for updates from GitHub
 */
async function checkForUpdates() {
    try {
        const res = await fetch('/api/update/check');
        if (!res.ok) return;
        
        const data = await res.json();
        if (data.updateAvailable) {
            console.log(`🆕 Update available: v${data.localVersion} → v${data.remoteVersion}`);
            showUpdateToast(data);
        } else {
            console.log(`✅ WheelHouse v${data.localVersion} is up to date`);
        }
    } catch (e) {
        console.log('Could not check for updates:', e.message);
    }
}

/**
 * Restart the server (called from UI button)
 */
window.restartServer = async function() {
    const btn = document.getElementById('restartBtn');
    if (btn) {
        btn.style.opacity = '0.3';
        btn.disabled = true;
        btn.innerHTML = '⏳';
    }
    
    try {
        showNotification('Restarting server...', 'info');
        const res = await fetch('/api/restart', { method: 'POST' });
        
        if (res.ok) {
            // Server is restarting - wait a moment then reload
            showNotification('Server restarting, reloading page...', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            throw new Error('Restart failed');
        }
    } catch (e) {
        showNotification('Restart failed: ' + e.message, 'error');
        if (btn) {
            btn.style.opacity = '0.6';
            btn.disabled = false;
            btn.innerHTML = '🔄';
        }
    }
};

/**
 * Show update notification toast
 */
function showUpdateToast(data) {
    // Remove existing toast if any
    const existing = document.getElementById('update-toast');
    if (existing) existing.remove();
    
    // Parse changelog to get the latest version's changes
    const changelogSummary = parseChangelog(data.changelog, data.remoteVersion);
    
    const toast = document.createElement('div');
    toast.id = 'update-toast';
    toast.innerHTML = `
        <div class="update-toast-header">
            <span class="update-toast-icon">🆕</span>
            <span class="update-toast-title">Update Available!</span>
            <button class="update-toast-close" onclick="this.closest('#update-toast').remove()">✕</button>
        </div>
        <div class="update-toast-version">
            v${data.localVersion} → <span style="color: #00ff88;">v${data.remoteVersion}</span>
        </div>
        <div class="update-toast-changelog">
            ${changelogSummary}
        </div>
        <div class="update-toast-actions">
            <button class="update-toast-btn update-btn-primary" onclick="applyUpdate()">
                ⬇️ Update Now
            </button>
            <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse/releases', '_blank')">
                📋 View on GitHub
            </button>
            <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                Later
            </button>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => toast.classList.add('show'));
}

/**
 * Parse changelog to extract latest version's changes
 */
function parseChangelog(changelog, version) {
    if (!changelog) return '<em>No changelog available</em>';
    
    // Find the section for this version
    const versionPattern = new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\][^#]*`, 's');
    const match = changelog.match(versionPattern);
    
    if (match) {
        let section = match[0];
        // Convert markdown to simple HTML
        section = section
            .replace(/^## \[.*?\].*$/m, '') // Remove version header
            .replace(/### (.*)/g, '<strong>$1</strong>') // Convert ### headers
            .replace(/- \*\*(.*?)\*\*/g, '• <strong>$1</strong>') // Bold items
            .replace(/- (.*)/g, '• $1') // Convert list items
            .replace(/\n\n+/g, '<br>') // Convert double newlines
            .replace(/\n/g, ' ') // Remove single newlines
            .trim();
        
        // Limit length
        if (section.length > 400) {
            section = section.substring(0, 400) + '...';
        }
        return section || '<em>See GitHub for details</em>';
    }
    
    return '<em>See GitHub for full changelog</em>';
}

/**
 * Apply update via git pull
 */
window.applyUpdate = async function() {
    const toast = document.getElementById('update-toast');
    const actionsDiv = toast?.querySelector('.update-toast-actions');
    
    if (actionsDiv) {
        actionsDiv.innerHTML = `
            <div style="color: #00d9ff; display: flex; align-items: center; gap: 8px;">
                <div class="update-spinner"></div>
                Updating...
            </div>
        `;
    }
    
    try {
        const res = await fetch('/api/update/apply', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
            if (actionsDiv) {
                actionsDiv.innerHTML = `
                    <div style="color: #00ff88;">
                        ✅ Updated to v${data.newVersion}!
                    </div>
                    <button class="update-toast-btn update-btn-primary" onclick="location.reload()">
                        🔄 Reload Page
                    </button>
                `;
            }
            showNotification(`Updated to v${data.newVersion}! Reload to apply.`, 'success');
        } else {
            throw new Error(data.error || 'Update failed');
        }
    } catch (e) {
        if (actionsDiv) {
            actionsDiv.innerHTML = `
                <div style="color: #ff5252; margin-bottom: 8px;">
                    ❌ ${e.message}
                </div>
                <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse', '_blank')">
                    📥 Manual Download
                </button>
                <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                    Close
                </button>
            `;
        }
        showNotification('Update failed: ' + e.message, 'error');
    }
};

/**
 * Migrate content from old tabs (Options, Simulator, Greeks) into Analyze sub-tabs
 * This runs once on init to avoid duplicating HTML
 */
function migrateTabContent() {
    console.log('🔄 Starting tab content migration...');
    
    // Move Options tab content → analyze-pricing sub-tab
    const optionsContent = document.getElementById('options');
    const pricingSubTab = document.getElementById('analyze-pricing');
    console.log('  Options tab:', optionsContent ? `found (${optionsContent.childNodes.length} children)` : 'NOT FOUND');
    console.log('  Pricing sub-tab:', pricingSubTab ? `found (${pricingSubTab.childNodes.length} children)` : 'NOT FOUND');
    
    if (optionsContent && pricingSubTab) {
        // Check if already has content (skip if migrated)
        const hasTextContent = pricingSubTab.textContent.trim().length > 50;
        if (!hasTextContent) {
            while (optionsContent.firstChild) {
                pricingSubTab.appendChild(optionsContent.firstChild);
            }
            optionsContent.style.display = 'none';
            console.log('✅ Migrated Options → Analyze/Pricing');
        } else {
            console.log('⏭️ Pricing sub-tab already has content, skipping migration');
        }
    }
    
    // Monte Carlo sub-tab has built-in content directly in HTML
    // No migration needed - just log for debugging
    console.log('✅ Monte Carlo tab has built-in risk analysis UI');
    
    // Move Greeks tab content → analyze-greeks sub-tab
    const greeksContent = document.getElementById('greeks');
    const greeksSubTab = document.getElementById('analyze-greeks');
    console.log('  Greeks tab:', greeksContent ? `found (${greeksContent.childNodes.length} children)` : 'NOT FOUND');
    console.log('  Greeks sub-tab:', greeksSubTab ? `found (${greeksSubTab.childNodes.length} children)` : 'NOT FOUND');
    
    if (greeksContent && greeksSubTab) {
        const hasTextContent = greeksSubTab.textContent.trim().length > 50;
        if (!hasTextContent) {
            while (greeksContent.firstChild) {
                greeksSubTab.appendChild(greeksContent.firstChild);
            }
            greeksContent.style.display = 'none';
            console.log('✅ Migrated Greeks → Analyze/Greeks');
        } else {
            console.log('⏭️ Greeks sub-tab already has content, skipping migration');
        }
    }
    
    // Remove old tab buttons from the header
    const oldTabIds = ['options', 'simulator', 'greeks', 'data'];
    oldTabIds.forEach(tabId => {
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (btn) btn.style.display = 'none';
        // Also hide the tab content
        const content = document.getElementById(tabId);
        if (content && !['options', 'simulator', 'greeks'].includes(tabId)) {
            // Don't hide options/simulator/greeks - they're migrated
            content.style.display = 'none';
        }
    });
    
    console.log('🔄 Tab content migration complete');
}

/**
 * Setup tab switching
 */
function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.tab;
            
            // Update active states
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(targetId)?.classList.add('active');
            
            // Tab-specific initialization
            if (targetId === 'portfolio') {
                renderPortfolio(true); // Fetch fresh prices
                renderChallenges(); // Render challenges section in sidebar
                // Also fetch account balances
                if (window.fetchAccountBalances) window.fetchAccountBalances();
            } else if (targetId === 'pnl') {
                // Auto-run pricing if not already done
                if (!state.optionResults?.finalPrices) {
                    priceOptions().then(() => {
                        drawPnLChart();
                        drawProbabilityCone();
                        drawHeatMap();
                    });
                } else {
                    drawPnLChart();
                    drawProbabilityCone();
                    drawHeatMap();
                }
            } else if (targetId === 'greeks') {
                // Greeks will be drawn when pricing is run
            } else if (targetId === 'data') {
                updateDataTab();
            } else if (targetId === 'positions') {
                renderPositions();
                updatePortfolioSummary();
            } else if (targetId === 'challenges') {
                renderChallenges();
            } else if (targetId === 'analyze') {
                // Initialize first sub-tab if needed
                const activeSubTab = document.querySelector('#analyze .sub-tab-content.active');
                if (!activeSubTab) {
                    switchSubTab('analyze', 'analyze-pricing');
                }
            } else if (targetId === 'ideas') {
                // Ideas tab - check AI status and restore saved content
                checkAIStatus?.();
                // Try to restore X Sentiment first, then Trade Ideas
                const ideaContent = document.getElementById('ideaContentLarge');
                if (ideaContent && ideaContent.innerHTML.trim() === '') {
                    // First try X Sentiment (more likely what user wants)
                    if (!window.restoreXSentiment?.()) {
                        // Fall back to Trade Ideas
                        window.restoreSavedIdeas?.();
                    }
                }
            }
        });
    });
}

/**
 * Switch sub-tabs within a parent tab (e.g., Analyze)
 * @param {string} parentId - Parent tab container ID
 * @param {string} subTabId - Sub-tab content ID to activate
 */
function switchSubTab(parentId, subTabId) {
    const parent = document.getElementById(parentId);
    if (!parent) return;
    
    // Update button states
    parent.querySelectorAll('.sub-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.subtab === subTabId);
    });
    
    // Update content visibility
    parent.querySelectorAll('.sub-tab-content').forEach(content => {
        content.classList.toggle('active', content.id === subTabId);
    });
    
    // Sub-tab specific initialization
    if (subTabId === 'analyze-greeks') {
        drawGreeksPlots?.();
    } else if (subTabId === 'analyze-simulator') {
        // Initialize Monte Carlo tab with current position data
        window.initMonteCarloTab?.();
    }
}

// Make switchSubTab globally accessible for onclick handlers
window.switchSubTab = switchSubTab;

/**
 * Setup button event listeners
 */
function setupButtons() {
    // Simulator buttons
    const runSingleBtn = document.getElementById('runSingleBtn');
    const runBatchBtn = document.getElementById('runBatchBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    if (runSingleBtn) {
        runSingleBtn.addEventListener('click', () => {
            runSingle();
            updateResults();
        });
    }
    
    if (runBatchBtn) {
        runBatchBtn.addEventListener('click', () => {
            runBatch();
            updateResults();
        });
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetAll();
            updateResults();
        });
    }
    
    // Options pricing button
    const priceBtn = document.getElementById('priceBtn');
    if (priceBtn) {
        priceBtn.addEventListener('click', () => {
            priceOptions();
            drawPayoffChart();
        });
    }
    
    // Greeks button
    const greeksBtn = document.getElementById('greeksBtn');
    if (greeksBtn) {
        greeksBtn.addEventListener('click', calcGreeks);
    }
    
    // Ticker fetch button
    const fetchBtn = document.getElementById('fetchTickerBtn');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', () => {
            const ticker = document.getElementById('tickerInput')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol', 'warning');
            }
        });
    }
    
    // Heat map update button
    const updateHeatMapBtn = document.getElementById('heatMapUpdateBtn');
    if (updateHeatMapBtn) {
        updateHeatMapBtn.addEventListener('click', () => {
            const input = document.getElementById('heatMapSpot');
            const newSpot = parseFloat(input?.value);
            if (!isNaN(newSpot) && newSpot > 0) {
                state.spot = newSpot;
                
                // Update sliders
                const clampedSpot = Math.max(20, Math.min(500, Math.round(state.spot)));
                document.getElementById('spotSlider').value = clampedSpot;
                document.getElementById('spotInput').value = Math.round(state.spot);
                
                // Visual feedback
                input.style.borderColor = '#00ff88';
                setTimeout(() => input.style.borderColor = '', 300);
                
                // Redraw charts
                drawPnLChart();
                drawProbabilityCone();
                drawHeatMap();
            } else {
                input.style.borderColor = '#ff5252';
                setTimeout(() => input.style.borderColor = '', 500);
            }
        });
    }
    
    // Heat map fetch button
    const heatMapFetchBtn = document.getElementById('heatMapFetchBtn');
    if (heatMapFetchBtn) {
        heatMapFetchBtn.addEventListener('click', fetchHeatMapPrice);
    }
    
    // Position ticker fetch button
    const posFetchPriceBtn = document.getElementById('posFetchPriceBtn');
    if (posFetchPriceBtn) {
        posFetchPriceBtn.addEventListener('click', () => {
            const ticker = document.getElementById('posTicker')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchPositionTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol first', 'warning');
            }
        });
    }
    
    // Roll calculator button
    const rollBtn = document.getElementById('rollBtn');
    if (rollBtn) {
        rollBtn.addEventListener('click', calculateRoll);
    }
    
    // Suggest optimal roll button
    const suggestRollBtn = document.getElementById('suggestRollBtn');
    if (suggestRollBtn) {
        suggestRollBtn.addEventListener('click', suggestOptimalRoll);
    }
    
    // Add position button
    const addPosBtn = document.getElementById('addPositionBtn');
    if (addPosBtn) {
        addPosBtn.addEventListener('click', addPosition);
    }
    
    // Cancel edit button
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', cancelEdit);
    }
    
    // Roll position buttons
    const executeRollBtn = document.getElementById('executeRollBtn');
    if (executeRollBtn) {
        executeRollBtn.addEventListener('click', () => {
            if (window.executeRoll) window.executeRoll();
        });
    }
    
    const cancelRollBtn = document.getElementById('cancelRollBtn');
    if (cancelRollBtn) {
        cancelRollBtn.addEventListener('click', () => {
            if (window.cancelRoll) window.cancelRoll();
        });
    }
    
    // Close position buttons
    const executeCloseBtn = document.getElementById('executeCloseBtn');
    if (executeCloseBtn) {
        executeCloseBtn.addEventListener('click', () => {
            if (window.executeClose) window.executeClose();
        });
    }
    
    const cancelCloseBtn = document.getElementById('cancelCloseBtn');
    if (cancelCloseBtn) {
        cancelCloseBtn.addEventListener('click', () => {
            if (window.cancelClose) window.cancelClose();
        });
    }
    
    // Expose editPosition to window for inline onclick handlers
    window.editPosition = editPosition;
    
    // Portfolio refresh button
    const refreshPortfolioBtn = document.getElementById('refreshPortfolioBtn');
    if (refreshPortfolioBtn) {
        refreshPortfolioBtn.addEventListener('click', () => renderPortfolio(true));
    }
    
    // Add historical closed position button
    const addClosedBtn = document.getElementById('addClosedPositionBtn');
    if (addClosedBtn) {
        addClosedBtn.addEventListener('click', () => {
            if (window.addHistoricalClosedPosition) {
                window.addHistoricalClosedPosition();
            }
        });
    }
    
    // Sync to simulator button
    const syncBtn = document.getElementById('syncToSimBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', syncToSimulator);
    }
    
    // Clear position context button
    const clearContextBtn = document.getElementById('clearContextBtn');
    if (clearContextBtn) {
        clearContextBtn.addEventListener('click', () => {
            state.currentPositionContext = null;
            const contextEl = document.getElementById('positionContext');
            if (contextEl) contextEl.style.display = 'none';
            showNotification('Cleared position context', 'info');
        });
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AI STRATEGY ADVISOR
 * Analyzes ALL option strategies for a ticker and recommends the best one
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Store the last analysis result for staging
let lastStrategyAdvisorResult = null;

window.runStrategyAdvisor = async function() {
    const tickerInput = document.getElementById('strategyAdvisorTicker');
    const modelSelect = document.getElementById('strategyAdvisorModel');
    const bpInput = document.getElementById('strategyAdvisorBP');
    const riskSelect = document.getElementById('strategyAdvisorRisk');
    const expertModeCheckbox = document.getElementById('strategyAdvisorExpertMode');
    
    const ticker = tickerInput?.value?.trim().toUpperCase();
    if (!ticker) {
        showNotification('Enter a ticker symbol', 'error');
        tickerInput?.focus();
        return;
    }
    
    const model = modelSelect?.value || 'deepseek-r1:32b';
    const riskTolerance = riskSelect?.value || 'moderate';
    
    // Auto-enable Wall Street Mode for capable models (Grok, GPT-4, Claude)
    // User can still manually override via checkbox
    // Note: grok-4 is slowest (3-5 min), grok-4-1-fast is recommended
    const isCapableModel = model.includes('grok') || model.includes('gpt-4') || model.includes('claude');
    const expertMode = expertModeCheckbox?.checked || isCapableModel;
    
    // Sync checkbox state if auto-enabled
    if (isCapableModel && expertModeCheckbox && !expertModeCheckbox.checked) {
        expertModeCheckbox.checked = true;
        console.log(`[STRATEGY-ADVISOR] Auto-enabled Wall Street Mode for ${model}`);
    }
    
    // =========================================================================
    // PROP DESK SIZING: Use Conservative Kelly Base, NOT raw buying power
    // Kelly Base = Account Value + (25% × Available Margin)
    // Then apply Half-Kelly for even more conservative sizing
    // =========================================================================
    const buyingPower = AccountService.getBuyingPower() || parseFloat(bpInput?.value) || 25000;
    const accountValue = AccountService.getAccountValue() || buyingPower * 0.5; // Estimate if not available
    
    // Calculate conservative Kelly Base (same formula as Portfolio Analytics)
    let kellyBase = 0;
    if (accountValue > 0) {
        const availableMargin = Math.max(0, buyingPower - accountValue);
        kellyBase = accountValue + (availableMargin * 0.25);
    } else {
        kellyBase = buyingPower * 0.625; // Fallback: 50% + 25% of remaining 50%
    }
    
    // Apply Half-Kelly for conservative sizing (prop desks typically use 1/4 to 1/2 Kelly)
    const maxPositionSize = kellyBase * 0.5; // Half Kelly
    
    // Cap at 60% of max position size per trade (no single trade > 60% of Half-Kelly)
    const perTradeCap = maxPositionSize * 0.6;
    
    console.log(`[STRATEGY-ADVISOR] Prop Desk Sizing:`);
    console.log(`  Account Value: $${accountValue.toLocaleString()}`);
    console.log(`  Buying Power: $${buyingPower.toLocaleString()}`);
    console.log(`  Kelly Base: $${kellyBase.toLocaleString()}`);
    console.log(`  Half-Kelly Max: $${maxPositionSize.toLocaleString()}`);
    console.log(`  Per-Trade Cap (60%): $${perTradeCap.toLocaleString()}`);
    
    // Create and show loading modal
    const existingModal = document.getElementById('strategyAdvisorModal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'strategyAdvisorModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #0d0d1a 100%); border-radius:16px; max-width:900px; width:100%; max-height:90vh; display:flex; flex-direction:column; border:2px solid ${expertMode ? '#ffd700' : '#6d28d9'}; box-shadow:0 0 40px ${expertMode ? 'rgba(255,215,0,0.3)' : 'rgba(147,51,234,0.3)'};">
            <div style="background:linear-gradient(135deg, ${expertMode ? 'rgba(255,215,0,0.2)' : 'rgba(147,51,234,0.3)'} 0%, ${expertMode ? 'rgba(255,140,0,0.15)' : 'rgba(79,70,229,0.2)'} 100%); padding:16px 24px; border-bottom:1px solid ${expertMode ? '#ffd700' : '#6d28d9'}; flex-shrink:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <h2 style="margin:0; color:${expertMode ? '#ffd700' : '#a78bfa'}; font-size:20px;">${expertMode ? '🏛️ Wall Street Mode' : '🎓 Strategy Advisor'}: ${ticker}</h2>
                        <div id="strategyAdvisorMeta" style="font-size:11px; color:#888; margin-top:4px;">${expertMode ? 'Expert analysis' : 'Analyzing'} with ${model}...</div>
                    </div>
                    <button onclick="document.getElementById('strategyAdvisorModal').remove()" style="background:none; border:none; color:#888; font-size:28px; cursor:pointer; line-height:1;">&times;</button>
                </div>
            </div>
            <div id="strategyAdvisorContent" style="padding:24px; color:#ddd; font-size:13px; line-height:1.7; overflow-y:auto; flex:1;">
                <div style="text-align:center; padding:60px 20px;">
                    <div style="font-size:48px; margin-bottom:16px;">${expertMode ? '🏛️' : '🔮'}</div>
                    <div style="color:${expertMode ? '#ffd700' : '#a78bfa'}; font-weight:bold; font-size:16px;">${expertMode ? 'Senior Trader Analysis' : 'Analyzing All Strategies'} for ${ticker}...</div>
                    <div style="color:#666; font-size:12px; margin-top:8px;">${expertMode ? 'Wall Street methodology • Free-form analysis' : 'Fetching real-time data from Schwab • Calculating optimal position size'}</div>
                    <div style="margin-top:20px; height:4px; background:#333; border-radius:2px; overflow:hidden;">
                        <div style="height:100%; width:30%; background:linear-gradient(90deg, ${expertMode ? '#ffd700, #ff8c00' : '#9333ea, #6d28d9'}); animation:pulse 1.5s ease-in-out infinite;"></div>
                    </div>
                </div>
            </div>
            <div id="strategyAdvisorFooter" style="display:none; background:rgba(0,0,0,0.5); padding:16px 24px; border-top:1px solid ${expertMode ? '#ffd700' : '#6d28d9'}; flex-shrink:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:11px; color:#888;">💡 You can also stage alternatives using the buttons in each section above</div>
                    <div style="display:flex; gap:12px;">
                        <button onclick="document.getElementById('strategyAdvisorModal').remove()" style="padding:10px 20px; background:#333; border:1px solid #444; border-radius:8px; color:#ddd; font-size:13px; cursor:pointer;">
                            Close
                        </button>
                        <button onclick="window.stageStrategyAdvisorTrade(0);" style="padding:10px 24px; background:linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border:none; border-radius:8px; color:#fff; font-weight:bold; font-size:13px; cursor:pointer; box-shadow:0 4px 12px rgba(34,197,94,0.3);">
                            📥 Stage Primary
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Handle Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
    
    try {
        // Get existing positions for context
        const existingPositions = state.positions || [];
        
        // Check if user has holdings (shares) for this ticker - enables covered call recommendations
        const holdings = state.holdings || [];
        const tickerHolding = holdings.find(h => h.ticker?.toUpperCase() === ticker);
        const sharesOwned = tickerHolding?.shares || 0;
        const costBasis = tickerHolding?.costBasis || tickerHolding?.averageCost || 0;
        
        if (sharesOwned > 0) {
            console.log(`[STRATEGY-ADVISOR] User owns ${sharesOwned} shares of ${ticker} @ $${costBasis.toFixed(2)} cost basis`);
        }
        
        console.log(`[STRATEGY-ADVISOR] Analyzing ${ticker} with Kelly-capped BP=$${perTradeCap.toLocaleString()}${expertMode ? ' (EXPERT MODE)' : ''}...`);
        
        const response = await fetch('/api/ai/strategy-advisor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                model,
                buyingPower: perTradeCap,  // Send Kelly-capped amount, not raw BP
                accountValue,               // For context in prompt
                kellyBase,                  // For display
                sharesOwned,                // NEW: Share holdings for covered call eligibility
                costBasis,                  // NEW: Cost basis for breakeven calcs
                riskTolerance,
                existingPositions,
                expertMode                  // Wall Street Mode - free AI analysis
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Strategy analysis failed');
        }
        
        const data = await response.json();
        console.log('[STRATEGY-ADVISOR] Response:', data);
        
        // Store for staging
        lastStrategyAdvisorResult = data;
        
        // Update modal with results
        const contentDiv = document.getElementById('strategyAdvisorContent');
        const metaDiv = document.getElementById('strategyAdvisorMeta');
        const footerDiv = document.getElementById('strategyAdvisorFooter');
        
        // Build meta info with range position
        let metaHtml = '';
        if (data.expertMode) {
            metaHtml += `<span style="background:linear-gradient(90deg, #ffd700, #ff8c00); color:#000; padding:2px 6px; border-radius:4px; font-weight:bold; margin-right:8px;">🏛️ WALL STREET</span>`;
        }
        metaHtml += `<span>Spot: $${data.spot?.toFixed(2) || '?'}</span>`;
        if (data.stockData?.rangePosition !== undefined) {
            const rp = data.stockData.rangePosition;
            const rangeColor = rp < 25 ? '#22c55e' : (rp > 75 ? '#ff5252' : '#ffaa00');
            const rangeIcon = rp < 25 ? '🔻' : (rp > 75 ? '🔺' : '↔️');
            metaHtml += ` • <span style="color:${rangeColor}">${rangeIcon} Range: ${rp}%</span>`;
        }
        if (data.ivRank !== null && data.ivRank !== undefined) {
            const ivColor = data.ivRank > 60 ? '#ff5252' : (data.ivRank < 30 ? '#22c55e' : '#ffaa00');
            metaHtml += ` • <span style="color:${ivColor}">IV Rank: ${data.ivRank}%</span>`;
        }
        metaHtml += ` • <span>Data: ${data.dataSource || 'Unknown'}</span>`;
        metaHtml += ` • <span>Model: ${data.model}</span>`;
        if (metaDiv) metaDiv.innerHTML = metaHtml;
        
        // Build content - prepend range warning if present
        let contentHtml = '';
        if (data.rangeWarning) {
            contentHtml += `
                <div style="background:rgba(255,82,82,0.15); border:1px solid #ff5252; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#ff5252; font-weight:bold; margin-bottom:4px;">⚠️ AI May Have Ignored Range Position</div>
                    <div style="color:#ddd; font-size:12px;">${data.rangeWarning}</div>
                </div>
            `;
        }
        
        // Format response and inject Stage buttons after each trade section
        let formattedResponse = formatAIResponse(data.recommendation);
        
        // Inject "Stage This" buttons after PRIMARY, ALTERNATIVE #1, and ALTERNATIVE #2 sections
        // Look for the section headers and add a button before the next section or end
        const sections = [
            { marker: '🥇 PRIMARY RECOMMENDATION', index: 0, label: 'Primary' },
            { marker: '🥈 ALTERNATIVE #1', index: 1, label: 'Alt #1' },
            { marker: '🥉 ALTERNATIVE #2', index: 2, label: 'Alt #2' }
        ];
        
        sections.forEach(section => {
            const markerPos = formattedResponse.indexOf(section.marker);
            if (markerPos === -1) return;
            
            // Find where this section ends (next section header or end of document)
            const nextSectionMarkers = ['🥈 ALTERNATIVE', '🥉 ALTERNATIVE', '❌ STRATEGIES REJECTED', '════'];
            let sectionEndPos = formattedResponse.length;
            
            for (const nextMarker of nextSectionMarkers) {
                const nextPos = formattedResponse.indexOf(nextMarker, markerPos + section.marker.length);
                if (nextPos !== -1 && nextPos < sectionEndPos) {
                    sectionEndPos = nextPos;
                }
            }
            
            // Insert the Stage button just before the section ends
            const stageButton = `
                <div style="margin: 16px 0; text-align: right;">
                    <button onclick="window.stageStrategyAdvisorTrade(${section.index});" 
                        style="padding: 8px 16px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border: none; border-radius: 6px; color: #fff; font-weight: bold; font-size: 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(34,197,94,0.3);">
                        📥 Stage ${section.label}
                    </button>
                </div>
            `;
            
            formattedResponse = formattedResponse.slice(0, sectionEndPos) + stageButton + formattedResponse.slice(sectionEndPos);
        });
        
        contentHtml += formattedResponse;
        
        // Format the AI response (convert markdown to HTML)
        if (contentDiv) contentDiv.innerHTML = contentHtml;
        
        // Show the footer with Stage Trade button (now for Primary by default)
        if (footerDiv) footerDiv.style.display = 'block';
        
        showNotification(`✅ Strategy analysis complete for ${ticker}`, 'success');
        
    } catch (e) {
        console.error('[STRATEGY-ADVISOR] Error:', e);
        // Update modal with error
        const contentDiv = document.getElementById('strategyAdvisorContent');
        if (contentDiv) {
            contentDiv.innerHTML = `
                <div style="text-align:center; padding:40px;">
                    <div style="font-size:48px; margin-bottom:16px;">❌</div>
                    <div style="color:#ff5252; font-weight:bold; font-size:16px;">Analysis Failed</div>
                    <div style="color:#888; margin-top:8px;">${e.message}</div>
                </div>
            `;
        }
        showNotification(`❌ ${e.message}`, 'error');
    }
};

// Stage the recommended trade from Strategy Advisor
// sectionIndex: 0 = Primary, 1 = Alt #1, 2 = Alt #2
window.stageStrategyAdvisorTrade = async function(sectionIndex = 0) {
    if (!lastStrategyAdvisorResult) {
        showNotification('No strategy analysis to stage', 'error');
        return;
    }
    
    const { ticker, spot, recommendation, ivRank, model, stockData } = lastStrategyAdvisorResult;
    
    // Extract the specific section based on sectionIndex
    let sectionText = recommendation;
    const sectionMarkers = [
        { start: '🥇 PRIMARY RECOMMENDATION', end: '🥈 ALTERNATIVE' },
        { start: '🥈 ALTERNATIVE #1', end: '🥉 ALTERNATIVE' },
        { start: '🥉 ALTERNATIVE #2', end: '❌ STRATEGIES REJECTED' }
    ];
    
    if (sectionIndex >= 0 && sectionIndex < sectionMarkers.length) {
        const marker = sectionMarkers[sectionIndex];
        const startPos = recommendation.indexOf(marker.start);
        if (startPos !== -1) {
            let endPos = recommendation.indexOf(marker.end, startPos + marker.start.length);
            // If end marker not found, look for alternatives
            if (endPos === -1) endPos = recommendation.indexOf('❌ STRATEGIES', startPos);
            if (endPos === -1) endPos = recommendation.indexOf('════', startPos + marker.start.length);
            if (endPos === -1) endPos = recommendation.length;
            sectionText = recommendation.substring(startPos, endPos);
            console.log(`[STAGE] Extracted section ${sectionIndex}:`, sectionText.substring(0, 200) + '...');
        }
    }
    
    // Parse the AI recommendation to extract trade details
    // The AI outputs structured sections like "Sell: $90 put @ $2.50"
    let tradeType = 'short_put';
    let strike = Math.round(spot * 0.95); // Default: 5% OTM put
    let upperStrike = null;
    let premium = null;
    let expiry = null;
    let isCall = false;
    let isDebit = false;
    let contracts = 1;
    
    console.log('[STAGE] Parsing recommendation...');
    
    // Helper: Convert human-readable dates like "Feb 27 '26" or "Feb 27, 2026" to YYYY-MM-DD
    const parseHumanDate = (text) => {
        if (!text) return null;
        const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                         jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
        
        // Match "Feb 27 '26" or "Feb 27, 2026" or "February 27, 2026"
        const match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s*'?(\d{2,4}))?/i);
        if (match) {
            const month = months[match[1].toLowerCase().substring(0, 3)];
            const day = match[2].padStart(2, '0');
            let year = match[3] || new Date().getFullYear().toString();
            if (year.length === 2) year = '20' + year;
            return `${year}-${month}-${day}`;
        }
        return null;
    };
    
    // Method 1: Look for "Sell TICKER $XX/$XX Put Spread, DATE" format
    // Also handles "Bear Call Spread" and "Bull Put Spread" variations
    // Date can appear with or without "expiry" after it
    // Optional "Trade:" prefix to handle Strategy Advisor output
    let spreadMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
    
    // Try Wall Street format: "Sell TICKER Feb 9 $320/$315 Put Credit Spread" (date before strikes)
    // Year is optional - "Feb 9" or "Feb 9 '26" or "Feb 9, 2026"
    if (!spreadMatch) {
        const wsMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+(\w+)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:[,']?\s*'?\d{2,4})?)\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (wsMatch) {
            const humanDate = wsMatch[2];
            expiry = parseHumanDate(humanDate);
            spreadMatch = [null, wsMatch[3], wsMatch[4], wsMatch[5]];
            console.log('[STAGE] Matched Wall Street date format:', humanDate, '→', expiry);
        }
    }
    
    // Try alternate Wall Street format without dollar signs: "Sell TICKER Feb 9 320/315 Put Spread"
    if (!spreadMatch) {
        const wsNoDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+(\w+)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:[,']?\s*'?\d{2,4})?)\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (wsNoDollar) {
            const humanDate = wsNoDollar[2];
            expiry = parseHumanDate(humanDate);
            spreadMatch = [null, wsNoDollar[3], wsNoDollar[4], wsNoDollar[5]];
            console.log('[STAGE] Matched Wall Street format (no $):', humanDate, '→', expiry);
        }
    }

    // Try ISO date format WITH dollar signs: "Sell TICKER 2026-02-09 $320/$315 Put Credit Spread"
    if (!spreadMatch) {
        const isoWithDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (isoWithDollar) {
            expiry = isoWithDollar[1];
            spreadMatch = [null, isoWithDollar[2], isoWithDollar[3], isoWithDollar[4]];
            console.log('[STAGE] Matched ISO date with $ format, expiry:', expiry);
        }
    }
    
    // Try ISO date format WITHOUT dollar signs: "Sell TICKER 2026-02-09 320/315 Put Credit Spread"
    if (!spreadMatch) {
        const isoNoDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (isoNoDollar) {
            expiry = isoNoDollar[1];
            spreadMatch = [null, isoNoDollar[2], isoNoDollar[3], isoNoDollar[4]];
            console.log('[STAGE] Matched ISO date without $ format, expiry:', expiry);
        }
    }
    
    // Try format without dollar signs at end: "Sell TICKER $XX/$XX Put Spread 2026-02-09" or just "XX/XX"
    if (!spreadMatch) {
        const noDollarMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
        if (noDollarMatch) {
            spreadMatch = noDollarMatch;
            console.log('[STAGE] Matched spread without $ signs');
        }
    }
    
    // Debug: Log first 500 chars if no match found
    if (!spreadMatch) {
        console.log('[STAGE] No spread match found. Section preview:', sectionText?.substring(0, 500));
    }
    
    if (spreadMatch) {
        const strike1 = parseFloat(spreadMatch[1]);
        const strike2 = parseFloat(spreadMatch[2]);
        const optType = (spreadMatch[3] || 'put').toLowerCase();  // Default to put if missing
        let expDate = spreadMatch[4] || expiry;  // Use captured expiry if available
        
        // If no date in the header line, look for date elsewhere nearby
        if (!expDate) {
            const dateMatch = sectionText?.match(/(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)?/i);
            if (dateMatch) expDate = dateMatch[1];
        }
        
        if (optType === 'put') {
            tradeType = 'put_credit_spread';
            strike = Math.max(strike1, strike2);  // Sell higher strike
            upperStrike = Math.min(strike1, strike2);  // Buy lower strike
        } else {
            tradeType = 'call_credit_spread';
            isCall = true;
            strike = Math.min(strike1, strike2);  // Sell lower strike
            upperStrike = Math.max(strike1, strike2);  // Buy higher strike
        }
        
        if (expDate) expiry = expDate;
        console.log('[STAGE] Detected spread from header: ' + tradeType + ' $' + strike + '/$' + upperStrike + ' exp ' + (expiry || 'TBD'));
    }
    
    // Method 1b: Look for DEBIT spread format "Buy TICKER $XX Put / Sell TICKER $XX Put"
    // This is the Bear Put Spread or Bull Call Spread format (you pay to open)
    if (!spreadMatch) {
        let debitSpreadMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+(?:\.\d+)?)\s+(Put|Call)\s*\/\s*Sell\s+\w+\s+\$(\d+(?:\.\d+)?)\s+(Put|Call)[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
        
        // Pattern B: "Buy $XX/$XX Call Spread" (Bull Call Spread format)
        if (!debitSpreadMatch) {
            const bullCallMatch = sectionText?.match(/Buy\s+(?:\w+\s+)?\$?(\d+)\/\$?(\d+)\s+(Call|Put)\s+(?:Debit\s+)?Spread/i);
            if (bullCallMatch) {
                const strike1 = parseFloat(bullCallMatch[1]);
                const strike2 = parseFloat(bullCallMatch[2]);
                const optType = bullCallMatch[3].toLowerCase();
                debitSpreadMatch = [null, Math.min(strike1, strike2), optType, Math.max(strike1, strike2), optType, null];
                console.log('[STAGE] Matched Bull/Bear Debit Spread format');
            }
        }
        
        // Pattern C: "Bull Call Spread $XX/$XX" or "Bear Put Spread $XX/$XX"
        if (!debitSpreadMatch) {
            const namedSpreadMatch = sectionText?.match(/(Bull\s+Call|Bear\s+Put)\s+Spread[:\s]+\$?(\d+)\/\$?(\d+)/i);
            if (namedSpreadMatch) {
                const spreadType = namedSpreadMatch[1].toLowerCase();
                const strike1 = parseFloat(namedSpreadMatch[2]);
                const strike2 = parseFloat(namedSpreadMatch[3]);
                if (spreadType.includes('call')) {
                    debitSpreadMatch = [null, Math.min(strike1, strike2), 'call', Math.max(strike1, strike2), 'call', null];
                } else {
                    debitSpreadMatch = [null, Math.max(strike1, strike2), 'put', Math.min(strike1, strike2), 'put', null];
                }
                console.log('[STAGE] Matched named debit spread: ' + spreadType);
            }
        }
        
        if (debitSpreadMatch) {
            const buyStrike = parseFloat(debitSpreadMatch[1]);
            const buyType = (typeof debitSpreadMatch[2] === 'string' ? debitSpreadMatch[2] : 'call').toLowerCase();
            const sellStrike = parseFloat(debitSpreadMatch[3]);
            let expDate = debitSpreadMatch[5];
            
            // If no date in the header line, look for date elsewhere
            if (!expDate) {
                const dateMatch = sectionText?.match(/(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)/i);
                if (dateMatch) expDate = dateMatch[1];
            }
            
            if (buyType === 'put') {
                // Bear Put Spread: Buy higher put, sell lower put
                tradeType = 'put_debit_spread';
                strike = buyStrike;      // Buy strike (higher for bear put)
                upperStrike = sellStrike; // Sell strike (lower for bear put)
                isDebit = true;
            } else {
                // Bull Call Spread: Buy lower call, sell higher call
                tradeType = 'call_debit_spread';
                isCall = true;
                strike = buyStrike;      // Buy strike (lower for bull call)
                upperStrike = sellStrike; // Sell strike (higher for bull call)
                isDebit = true;
            }
            
            if (expDate) expiry = expDate;
            console.log('[STAGE] Detected DEBIT spread: ' + tradeType + ' $' + strike + '/$' + upperStrike + ' exp ' + (expiry || 'TBD'));
        }
    }
    
    // Method 2: Look for "Credit Received: $X.XX/share" or "Credit Received: $X.XX"
    const creditMatch = sectionText?.match(/Credit\s+Received:\s*\$(\d+(?:\.\d+)?)(?:\/share)?/i);
    if (creditMatch) {
        premium = parseFloat(creditMatch[1]);
        console.log('[STAGE] Found credit received: $' + premium);
    }
    
    // Method 2b: Look for "Net Debit: $X.XX" for debit spreads
    if (!premium && isDebit) {
        const debitMatch = sectionText?.match(/Net\s+Debit:\s*\$(\d+(?:\.\d+)?)(?:\s*per\s*share)?/i);
        if (debitMatch) {
            premium = parseFloat(debitMatch[1]);
            console.log('[STAGE] Found net debit: $' + premium);
        }
    }
    
    // Method 2c: Look for "Net Credit: $X.XX" (alternate format for credit spreads)
    if (!premium) {
        const netCreditMatch = sectionText?.match(/Net\s+Credit:\s*\$(\d+(?:\.\d+)?)(?:\s*per\s*share)?/i);
        if (netCreditMatch) {
            premium = parseFloat(netCreditMatch[1]);
            console.log('[STAGE] Found net credit: $' + premium);
        }
    }
    
    // Method 2d: Look for "Net Credit/Debit: $X.XX per share" (Wall Street Mode format)
    if (!premium) {
        const netCreditDebitMatch = sectionText?.match(/Net\s+Credit\/Debit:\s*\$(\d+(?:\.\d+)?)\s*per\s*share/i);
        if (netCreditDebitMatch) {
            premium = parseFloat(netCreditDebitMatch[1]);
            console.log('[STAGE] Found net credit/debit: $' + premium);
        }
    }
    
    // Method 3: Look for "Sell: $XX put @ $X.XX" pattern (alternate format)
    if (!premium) {
        const sellPutMatch = sectionText?.match(/Sell:\s*\$(\d+(?:\.\d+)?)\s*put\s*@\s*\$(\d+(?:\.\d+)?)/i);
        const buyPutMatch = sectionText?.match(/Buy:\s*\$(\d+(?:\.\d+)?)\s*put\s*@\s*\$(\d+(?:\.\d+)?)/i);
        
        if (sellPutMatch && buyPutMatch) {
            tradeType = 'put_credit_spread';
            strike = parseFloat(sellPutMatch[1]);
            upperStrike = parseFloat(buyPutMatch[1]);
            const sellPrem = parseFloat(sellPutMatch[2]);
            const buyPrem = parseFloat(buyPutMatch[2]);
            premium = Math.max(0.01, sellPrem - buyPrem);
            console.log('[STAGE] Detected put spread from Sell/Buy lines: $' + strike + '/$' + upperStrike);
        } else if (sellPutMatch) {
            tradeType = 'short_put';
            strike = parseFloat(sellPutMatch[1]);
            premium = parseFloat(sellPutMatch[2]);
            console.log('[STAGE] Detected short put: $' + strike + ' @ $' + premium);
        }
    }
    
    // Method 4: Look for single leg patterns "Sell $XX Put" without spread
    if (!spreadMatch && !premium) {
        const singlePutMatch = sectionText?.match(/Sell\s+(?:\w+\s+)?\$(\d+)\s+Put/i);
        const singleCallMatch = sectionText?.match(/Sell\s+(?:\w+\s+)?\$(\d+)\s+Call/i);
        
        if (singlePutMatch) {
            tradeType = 'short_put';
            strike = parseFloat(singlePutMatch[1]);
            console.log('[STAGE] Detected single short put: $' + strike);
        } else if (singleCallMatch) {
            tradeType = 'covered_call';
            isCall = true;
            strike = parseFloat(singleCallMatch[1]);
            console.log('[STAGE] Detected single covered call: $' + strike);
        }
    }
    
    // Method 5: Detect Iron Condor - multiple patterns
    // Pattern A: "Sell TICKER $XX/$XX/$XX/$XX Iron Condor"
    let ironCondorMatch = sectionText?.match(/Sell\s+\w+\s+\$(\d+)\/\$(\d+)\/\$(\d+)\/\$(\d+)\s+Iron\s+Condor/i);
    
    // Pattern B: "Sell TICKER XX/XX Call Credit Spread + XX/XX Put Credit Spread" (Wall Street format)
    if (!ironCondorMatch) {
        const icPatternB = sectionText?.match(/Sell\s+\w+\s+(\d+)\/(\d+)\s+Call\s+(?:Credit\s+)?Spread\s*\+\s*(\d+)\/(\d+)\s+Put\s+(?:Credit\s+)?Spread/i);
        if (icPatternB) {
            ironCondorMatch = icPatternB;
            console.log('[STAGE] Matched Iron Condor Wall Street format');
        }
    }
    
    // Pattern C: Alternative with $ signs - "$110/$115 Call ... + $100/$95 Put"
    if (!ironCondorMatch) {
        const icPatternC = sectionText?.match(/\$(\d+)\/\$(\d+)\s+Call\s+(?:Credit\s+)?Spread\s*\+\s*\$(\d+)\/\$(\d+)\s+Put\s+(?:Credit\s+)?Spread/i);
        if (icPatternC) {
            ironCondorMatch = icPatternC;
            console.log('[STAGE] Matched Iron Condor with $ signs');
        }
    }
    
    if (ironCondorMatch) {
        tradeType = 'iron_condor';
        // For call spread: sell lower, buy higher (bearish side)
        // For put spread: sell higher, buy lower (bullish side)
        const callSell = parseFloat(ironCondorMatch[1]);
        const callBuy = parseFloat(ironCondorMatch[2]);
        const putSell = parseFloat(ironCondorMatch[3]);
        const putBuy = parseFloat(ironCondorMatch[4]);
        
        // Store all four strikes for Iron Condor
        // Primary display: use put sell as "strike" and call sell as "upperStrike"
        strike = putSell;        // Put sell strike (lower wing)
        upperStrike = callSell;  // Call sell strike (upper wing)
        
        // Store full IC details in a way we can reconstruct
        // Format: putBuy/putSell/callSell/callBuy (lowest to highest)
        const sortedStrikes = [putBuy, putSell, callSell, callBuy].sort((a, b) => a - b);
        console.log('[STAGE] Detected Iron Condor: Put ' + putSell + '/' + putBuy + ' | Call ' + callSell + '/' + callBuy);
        console.log('[STAGE] IC strikes (low to high): ' + sortedStrikes.join('/'));
    }
    
    // Method 6: Detect Long Put (E) - "Buy TICKER $XX Put"
    const longPutMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+Put,?\s*(\d{4}-\d{2}-\d{2})?/i);
    if (longPutMatch && !sectionText?.match(/Spread/i)) {
        tradeType = 'long_put';
        isDebit = true;
        strike = parseFloat(longPutMatch[1]);
        if (longPutMatch[2]) expiry = longPutMatch[2];
        console.log('[STAGE] Detected Long Put: $' + strike);
    }
    
    // Method 7: Detect Long Call (F) - "Buy TICKER $XX Call"
    const longCallMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+Call,?\s*(\d{4}-\d{2}-\d{2})?/i);
    if (longCallMatch && !sectionText?.match(/Spread|SKIP|LEAPS|PMCC|Poor Man/i)) {
        tradeType = 'long_call';
        isCall = true;
        isDebit = true;
        strike = parseFloat(longCallMatch[1]);
        if (longCallMatch[2]) expiry = longCallMatch[2];
        console.log('[STAGE] Detected Long Call: $' + strike);
    }
    
    // Method 8: Detect SKIP™ (H) - "Buy TICKER $XX LEAPS Call + Buy $XX SKIP Call"
    const skipMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+LEAPS\s+Call.*?\+.*?Buy\s+\$(\d+)\s+SKIP\s+Call/i);
    if (skipMatch) {
        tradeType = 'skip_call';
        isCall = true;
        isDebit = true;
        strike = parseFloat(skipMatch[1]);  // LEAPS strike
        upperStrike = parseFloat(skipMatch[2]);  // SKIP strike
        console.log('[STAGE] Detected SKIP strategy: LEAPS $' + strike + ' + SKIP $' + upperStrike);
    }
    
    // Method 9: Detect PMCC (Poor Man's Covered Call) - "Buy TICKER $XX Call LEAP + Sell $XX Call"
    // Patterns: "Buy SLV Jan 2026 $85 Call LEAP + Sell 110 Call" or "Buy $85 LEAPS Call + Sell $110 Call"
    if (!tradeType.includes('skip')) {
        // Pattern A: "Buy TICKER DATE $XX Call LEAP + Sell XX Call"
        let pmccMatch = sectionText?.match(/Buy\s+\w+\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s+\$?(\d+)\s+Call\s+LEAPS?\s*\+\s*Sell\s+\$?(\d+)\s+Call/i);
        
        // Pattern B: "Buy $XX LEAPS Call + Sell $XX Call"
        if (!pmccMatch) {
            pmccMatch = sectionText?.match(/Buy\s+(?:\w+\s+)?\$?(\d+)\s+(?:LEAPS?\s+)?Call.*?\+\s*Sell\s+\$?(\d+)\s+Call/i);
        }
        
        // Pattern C: Look for PMCC/Poor Man's in the section header and extract strikes
        if (!pmccMatch && sectionText?.match(/Poor Man'?s?|PMCC/i)) {
            const leapsStrike = sectionText?.match(/Buy\s+(?:\w+\s+)?(?:.*?)?\$?(\d+)\s+(?:Call\s+)?LEAPS?/i);
            const sellStrike = sectionText?.match(/Sell\s+\$?(\d+)\s+Call/i);
            if (leapsStrike && sellStrike) {
                pmccMatch = [null, leapsStrike[1], sellStrike[1]];
            }
        }
        
        if (pmccMatch) {
            tradeType = 'pmcc';  // Poor Man's Covered Call
            isCall = true;
            isDebit = true;
            strike = parseFloat(pmccMatch[1]);      // LEAPS strike (buy)
            upperStrike = parseFloat(pmccMatch[2]); // Short call strike (sell)
            console.log('[STAGE] Detected PMCC: Buy $' + strike + ' LEAPS, Sell $' + upperStrike + ' Call');
        }
    }
    
    // Try to find premium from other patterns if still missing
    if (!premium) {
        // "Net Credit: $X.XX" or "Premium: $X.XX" or "Total Credit: $X.XX"
        const altPremMatch = sectionText?.match(/(?:Net\s+Credit|Premium|Credit|Total\s+Credit):\s*\$?(\d+(?:\.\d+)?)/i);
        if (altPremMatch) {
            premium = parseFloat(altPremMatch[1]);
            console.log('[STAGE] Found premium from alt pattern: $' + premium);
        }
    }
    
    // Method 9: For debit trades, look for "Debit Paid: $X.XX" or "Cost per contract: $XXX"
    if (!premium && isDebit) {
        const debitMatch = sectionText?.match(/(?:Debit\s+Paid|Cost\s+per\s+contract):\s*\$?(\d+(?:\.\d+)?)/i);
        if (debitMatch) {
            premium = parseFloat(debitMatch[1]);
            // If it's > 50, it's probably per-contract, convert to per-share
            if (premium > 50) premium = premium / 100;
            console.log('[STAGE] Found debit from pattern: $' + premium.toFixed(2) + '/share');
        }
    }
    
    // Method 10: Calculate from "Max Profit per contract: $XXX" or just "Max Profit: $XXX" (for spreads, premium = maxProfit/100)
    if (!premium && tradeType?.includes('_spread')) {
        // Try with "per contract" first
        let maxProfitMatch = sectionText?.match(/Max\s+Profit\s+per\s+contract:\s*\$?(\d+(?:,\d{3})*)/i);
        // Try without "per contract" (the post-processed format)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/Per\s+Contract:[\s\S]*?Max\s+Profit:\s*\$?(\d+(?:,\d{3})*)/i);
        }
        // Try simple "Max Profit:" pattern (first occurrence, typically per-contract)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/Max\s+Profit:\s*\$?(\d+(?:,\d{3})*)/i);
        }
        // Try table format "| Max Profit | $35 |" (Wall Street Mode)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/\|\s*Max\s+Profit\s*\|\s*\$?(\d+(?:,\d{3})*)/i);
        }
        if (maxProfitMatch) {
            const maxProfitPerContract = parseFloat(maxProfitMatch[1].replace(/,/g, ''));
            premium = maxProfitPerContract / 100;  // Convert back to per-share
            console.log('[STAGE] Calculated premium from max profit: $' + premium.toFixed(2) + '/share');
        }
    }
    
    // For Iron Condor, use total credit
    if (!premium && tradeType === 'iron_condor') {
        const totalCreditMatch = sectionText?.match(/Total\s+Credit:\s*\$?(\d+(?:\.\d+)?)/i);
        if (totalCreditMatch) {
            premium = parseFloat(totalCreditMatch[1]);
            console.log('[STAGE] Found Iron Condor total credit: $' + premium);
        }
    }
    
    // Extract recommended contracts from "Recommended Contracts: X" or "Contracts: X"
    const contractsMatch = sectionText?.match(/(?:Recommended\s+)?Contracts:\s*(\d+)/i);
    if (contractsMatch) {
        contracts = parseInt(contractsMatch[1]);
        console.log('[STAGE] Found contracts: ' + contracts);
    }
    
    // Extract expiration - look for various date patterns
    // Pattern: "Expiration: 2026-03-14" or dates in expirations list
    const expPatterns = [
        /Expiration:\s*(\d{4}-\d{2}-\d{2})/i,
        /Expiry:\s*(\d{4}-\d{2}-\d{2})/i,
        /expire(?:s)?\s*(?:on)?\s*(\d{4}-\d{2}-\d{2})/i,
        /(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)/i
    ];
    
    for (const pattern of expPatterns) {
        const match = sectionText?.match(pattern);
        if (match) {
            expiry = match[1];
            console.log('[STAGE] Found expiry: ' + expiry);
            break;
        }
    }
    
    // If still no expiry, try to find any YYYY-MM-DD date in the recommendation
    if (!expiry) {
        const anyDateMatch = sectionText?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
        if (anyDateMatch) {
            expiry = anyDateMatch[1];
            console.log('[STAGE] Found date: ' + expiry);
        }
    }
    
    // NEW: Try human-readable dates like "Feb 27 '26" or "Feb 27, 2026" (Wall Street Mode)
    if (!expiry) {
        const humanDate = parseHumanDate(recommendation);
        if (humanDate) {
            expiry = humanDate;
            console.log('[STAGE] Found human-readable date: ' + expiry);
        }
    }
    
    // Default expiry to ~45 days out if not found
    if (!expiry) {
        const defaultExpiry = new Date();
        defaultExpiry.setDate(defaultExpiry.getDate() + 45);
        // Find next Friday
        while (defaultExpiry.getDay() !== 5) {
            defaultExpiry.setDate(defaultExpiry.getDate() + 1);
        }
        expiry = defaultExpiry.toISOString().split('T')[0];
        console.log('[STAGE] Using default expiry: ' + expiry);
    }
    
    // =========================================================================
    // STRIKE VALIDATION: Fetch options chain and snap invalid strikes to valid ones
    // =========================================================================
    if (tradeType?.includes('_spread') && strike && upperStrike) {
        try {
            console.log('[STAGE] Validating strikes exist at expiry ' + expiry + '...');
            const chain = await window.fetchOptionsChain(ticker);
            if (chain) {
                const isPut = tradeType.includes('put');
                const options = isPut ? chain.puts : chain.calls;
                
                // Filter to target expiry
                const optsAtExpiry = options?.filter(o => o.expiration === expiry) || [];
                
                if (optsAtExpiry.length > 0) {
                    const validStrikes = [...new Set(optsAtExpiry.map(o => parseFloat(o.strike)))].sort((a, b) => a - b);
                    // Show only nearby strikes (±$20 from current strikes)
                    const nearbyStrikes = validStrikes.filter(s => 
                        Math.abs(s - strike) <= 20 || Math.abs(s - upperStrike) <= 20
                    );
                    console.log('[STAGE] Nearby valid strikes: $' + nearbyStrikes.join(', $'));
                    
                    // Helper to find nearest valid strike
                    const findNearest = (target) => {
                        return validStrikes.reduce((prev, curr) => 
                            Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
                        );
                    };
                    
                    // Validate sell strike
                    const originalSell = strike;
                    if (!validStrikes.includes(strike)) {
                        strike = findNearest(strike);
                        console.log('[STAGE] ⚠️ Sell strike $' + originalSell + ' not available, using nearest: $' + strike);
                    }
                    
                    // Validate buy strike
                    const originalBuy = upperStrike;
                    if (!validStrikes.includes(upperStrike)) {
                        upperStrike = findNearest(upperStrike);
                        console.log('[STAGE] ⚠️ Buy strike $' + originalBuy + ' not available, using nearest: $' + upperStrike);
                    }
                    
                    // Recalculate premium based on actual strikes
                    if (strike !== originalSell || upperStrike !== originalBuy) {
                        const sellOpt = optsAtExpiry.find(o => parseFloat(o.strike) === strike);
                        const buyOpt = optsAtExpiry.find(o => parseFloat(o.strike) === upperStrike);
                        
                        if (sellOpt && buyOpt) {
                            const sellMid = (parseFloat(sellOpt.bid) + parseFloat(sellOpt.ask)) / 2;
                            const buyMid = (parseFloat(buyOpt.bid) + parseFloat(buyOpt.ask)) / 2;
                            const newPremium = isPut ? (sellMid - buyMid) : (buyMid - sellMid);
                            premium = Math.max(0.01, newPremium);
                            console.log('[STAGE] ✅ Recalculated premium with valid strikes: $' + premium.toFixed(2) + '/share');
                        }
                    }
                } else {
                    console.log('[STAGE] ⚠️ No options found at expiry ' + expiry + ', using AI strikes as-is');
                }
            }
        } catch (err) {
            console.log('[STAGE] Could not validate strikes: ' + err.message);
        }
    }
    
    // Stage the trade - use same field names as other staging functions
    const now = Date.now();
    const isExpertMode = lastStrategyAdvisorResult?.expertMode || false;
    
    // For Wall Street Mode, build a thesis structure that preserves the full analysis
    // For Guided Mode, use the existing extractThesisSummary which parses spectrum format
    const openingThesis = {
        analyzedAt: new Date().toISOString(),
        priceAtAnalysis: spot,
        rangePosition: stockData?.rangePosition || null,
        iv: ivRank || null,  // IV rank at time of analysis
        modelUsed: model || 'unknown',
        expertMode: isExpertMode,
        aiSummary: isExpertMode 
            ? {
                // Wall Street Mode: store structured sections
                fullAnalysis: recommendation,
                marketAnalysis: extractSection(recommendation, 'MARKET ANALYSIS'),
                whyThisStrategy: extractSection(recommendation, 'WHY THIS STRATEGY'),
                theRisks: extractSection(recommendation, 'THE RISKS'),
                tradeManagement: extractSection(recommendation, 'TRADE MANAGEMENT'),
                rejectedStrategies: extractSection(recommendation, 'STRATEGIES I CONSIDERED BUT REJECTED')
            }
            : extractThesisSummary(recommendation)
    };
    
    const stagedTrade = {
        id: now,
        ticker,
        type: tradeType,
        strike,
        upperStrike,
        premium: premium || null,
        expiry,
        contracts: contracts,
        isCall,
        isDebit,
        source: isExpertMode ? 'Wall Street Mode' : 'Strategy Advisor',
        stagedAt: now,  // For display in render
        currentPrice: spot,
        openingThesis
    };
    
    // Add to pending trades in localStorage (not just window.pendingTrades)
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const isDuplicate = pending.some(p => 
        p.ticker === stagedTrade.ticker && 
        p.strike === stagedTrade.strike && 
        p.type === stagedTrade.type
    );
    
    if (isDuplicate) {
        showNotification(`${ticker} already staged with same strike/type`, 'info');
        return;
    }
    
    pending.unshift(stagedTrade);  // Add to front of array
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    renderPendingTrades();
    showNotification(`✅ Staged ${ticker} ${tradeType.replace(/_/g, ' ')} - check Ideas tab`, 'success');
};

/**
 * Ideas Tab: Discord Trade Analyzer (uses Ideas tab element IDs)
 * Directly calls the API instead of relying on element swapping
 */
window.analyzeDiscordTrade2 = async function() {
    const textarea = document.getElementById('pasteTradeInput2');
    const modelSelect = document.getElementById('discordModelSelect2');
    const tradeText = textarea?.value?.trim();
    
    if (!tradeText) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }
    
    // Use local override if set, otherwise fall back to global
    const model = modelSelect?.value || window.getSelectedAIModel?.() || 'deepseek-r1:32b';
    
    // Call analyzeDiscordTrade with the text directly
    window.analyzeDiscordTrade(tradeText, model);
};

/**
 * Alias for calling analyzeDiscordTrade with text directly
 */
window.analyzeDiscordTradeWithText = function(tradeText, model) {
    window.analyzeDiscordTrade(tradeText, model);
};

/**
 * Restore previously saved trade ideas from localStorage
 */
window.restoreSavedIdeas = function() {
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaResults || !ideaContent) return false;
    
    try {
        const saved = localStorage.getItem('wheelhouse_trade_ideas');
        if (!saved) return false;
        
        const data = JSON.parse(saved);
        if (!data.ideas) return false;
        
        // Check if less than 24 hours old
        const age = Date.now() - (data.timestamp || 0);
        if (age > 24 * 60 * 60 * 1000) {
            localStorage.removeItem('wheelhouse_trade_ideas');
            return false;
        }
        
        // Restore the data
        window._lastTradeIdeas = data.candidates || [];
        window._lastSuggestedTickers = extractSuggestedTickers(data.ideas);
        
        // Debug: log raw ideas to see format
        console.log('[Ideas] Raw saved ideas (first 300 chars):', data.ideas.substring(0, 300));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = data.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                console.log('[Ideas] Deep Dive match:', match, '→ Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show candidate pool
        const allCandidates = data.candidates || [];
        const discoveredNote = data.discoveredCount > 0 
            ? '(including <span style="color:#ffaa00;">' + data.discoveredCount + ' market movers</span>)'
            : '';
        
        let poolHtml = '<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">';
        poolHtml += '<div style="color:#888; margin-bottom:8px;">';
        poolHtml += '📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ' + (data.candidatesChecked || 0) + ' stocks scanned ';
        poolHtml += discoveredNote;
        poolHtml += ' <span style="margin-left:10px; color:#666;">Saved ' + Math.round(age / 60000) + ' min ago</span>';
        poolHtml += '</div>';
        poolHtml += '<div style="display:flex; flex-wrap:wrap; gap:4px;">';
        allCandidates.forEach(t => {
            const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
            const bg = isDiscovered ? '#4a3500' : '#333';
            const border = isDiscovered ? '1px solid #ffaa00' : 'none';
            poolHtml += '<span style="background:' + bg + '; border:' + border + '; padding:2px 6px; border-radius:3px; color:#ccc;">' + t.ticker + '</span>';
        });
        poolHtml += '</div></div>';
        
        // Add buttons
        formatted += poolHtml;
        formatted += `<div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeas2()" style="padding:8px 16px; background:#7a8a94; border:none; border-radius:5px; color:#fff; cursor:pointer; font-size:13px;">
                    🔄 Generate Fresh Ideas
                </button>
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; margin-left:10px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;">
                    🔀 Show Different Stocks
                </button>
            </div>`;
        
        ideaResults.style.display = 'block';
        ideaContent.innerHTML = formatted;
        console.log('[Ideas] Restored saved ideas from', Math.round(age / 60000), 'minutes ago');
        return true;
        
    } catch (e) {
        console.error('[Ideas] Failed to restore saved ideas:', e);
        return false;
    }
};

// Helper for template literal in restoreSavedIdeas
function extractSuggestedTickers(text) {
    const matches = text.match(/^\d+\.\s*([A-Z]{1,5})\s*@/gm) || [];
    return matches.map(m => m.match(/([A-Z]{1,5})/)?.[1]).filter(Boolean);
}

// ═══ TRADING WISDOM FUNCTIONS ═══

/**
 * Load and display wisdom count
 */
async function loadWisdomCount() {
    try {
        const res = await fetch('/api/wisdom');
        if (res.ok) {
            const data = await res.json();
            const countEl = document.getElementById('wisdomCount');
            if (countEl) {
                countEl.textContent = `${data.entries?.length || 0} entries`;
            }
        }
    } catch (e) {
        console.log('Wisdom load error:', e);
    }
}

// ============================================================
// SECTION: OLLAMA MANAGEMENT
// Functions: checkOllamaStatus, restartOllama
// ============================================================

/**
 * Check Ollama status and update UI
 */
window.checkOllamaStatus = async function() {
    const statusEl = document.getElementById('ollamaStatus');
    const modelListEl = document.getElementById('ollamaModelList');
    
    if (statusEl) statusEl.textContent = 'Checking...';
    if (statusEl) statusEl.style.background = '#333';
    if (statusEl) statusEl.style.color = '#888';
    
    try {
        const res = await fetch('/api/ai/status');
        const data = await res.json();
        
        if (data.available) {
            if (statusEl) {
                statusEl.textContent = `Running (${data.models?.length || 0} models)`;
                statusEl.style.background = 'rgba(34,197,94,0.2)';
                statusEl.style.color = '#22c55e';
            }
            
            if (modelListEl && data.models) {
                const modelNames = data.models.map(m => `${m.name} (${m.sizeGB}GB)`).join(', ');
                modelListEl.innerHTML = `<strong>Available:</strong> ${modelNames}`;
                
                if (data.loaded?.length > 0) {
                    const loaded = data.loaded.map(m => m.name).join(', ');
                    modelListEl.innerHTML += `<br><strong style="color:#22c55e;">Loaded in VRAM:</strong> ${loaded}`;
                }
            }
        } else {
            if (statusEl) {
                statusEl.textContent = 'Not Running';
                statusEl.style.background = 'rgba(255,82,82,0.2)';
                statusEl.style.color = '#ff5252';
            }
            if (modelListEl) {
                modelListEl.innerHTML = '<span style="color:#ff5252;">Ollama not running. Click Restart to start it.</span>';
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = 'Error';
            statusEl.style.background = 'rgba(255,82,82,0.2)';
            statusEl.style.color = '#ff5252';
        }
        if (modelListEl) {
            modelListEl.innerHTML = '<span style="color:#ff5252;">Could not connect to server</span>';
        }
    }
};

/**
 * Restart Ollama service
 */
window.restartOllama = async function() {
    const statusEl = document.getElementById('ollamaStatus');
    
    if (statusEl) {
        statusEl.textContent = 'Restarting...';
        statusEl.style.background = 'rgba(255,170,0,0.2)';
        statusEl.style.color = '#ffaa00';
    }
    
    showNotification('🔄 Restarting Ollama...', 'info');
    
    try {
        const res = await fetch('/api/ai/restart', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
            showNotification(`✅ Ollama restarted! ${data.models} models available`, 'success');
            window.checkOllamaStatus();
        } else {
            showNotification(`❌ Restart failed: ${data.error}`, 'error');
            window.checkOllamaStatus();
        }
    } catch (e) {
        showNotification(`❌ Error: ${e.message}`, 'error');
    }
};

// Check Ollama status on page load
setTimeout(window.checkOllamaStatus, 2000);

/**
 * Test which wisdom applies to different position types
 */
window.testWisdomForType = async function() {
    const positionTypes = [
        { type: 'short_put', label: 'Short Put / CSP' },
        { type: 'covered_call', label: 'Covered Call' },
        { type: 'buy_write', label: 'Buy/Write' },
        { type: 'leaps', label: 'LEAPS' },
        { type: 'call_debit_spread', label: 'Call Debit Spread' },
        { type: 'put_credit_spread', label: 'Put Credit Spread' },
        { type: 'long_call', label: 'Long Call' }
    ];
    
    let resultsHtml = '';
    
    for (const pt of positionTypes) {
        try {
            const res = await fetch('/api/wisdom/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ positionType: pt.type })
            });
            const data = await res.json();
            
            const color = data.matching > 0 ? '#22c55e' : '#666';
            const usedNote = data.matching > 5 ? ` (uses top 5)` : '';
            
            resultsHtml += `
                <div style="margin-bottom:15px; padding:10px; background:#1a1a2e; border-radius:6px; border-left:3px solid ${color};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#ddd; font-weight:bold;">${pt.label}</span>
                        <span style="color:${color}; font-size:12px;">${data.matching} entries match${usedNote}</span>
                    </div>
                    ${data.entries.length > 0 ? `
                        <div style="margin-top:8px; font-size:11px; color:#888;">
                            ${data.entries.slice(0, 3).map(e => `• [${e.category}] ${e.wisdom.substring(0, 60)}...`).join('<br>')}
                            ${data.entries.length > 3 ? `<br><span style="color:#666;">...and ${data.entries.length - 3} more</span>` : ''}
                        </div>
                    ` : '<div style="font-size:11px; color:#666; margin-top:4px;">No wisdom entries apply to this type</div>'}
                </div>
            `;
        } catch (e) {
            resultsHtml += `<div style="color:#ff5252;">Error: ${e.message}</div>`;
        }
    }
    
    // Get total count
    const totalRes = await fetch('/api/wisdom');
    const totalData = await totalRes.json();
    
    const modal = document.createElement('div');
    modal.id = 'wisdomTestModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#0d0d1a; border:1px solid #22c55e; border-radius:12px; padding:25px; max-width:600px; width:90%; max-height:80vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="color:#22c55e; margin:0;">🔍 Wisdom Coverage Test</h2>
                <button onclick="document.getElementById('wisdomTestModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">×</button>
            </div>
            <p style="color:#888; font-size:12px; margin-bottom:15px;">
                You have <strong style="color:#22c55e;">${totalData.entries?.length || 0}</strong> total wisdom entries. 
                Here's how they apply to each position type:
            </p>
            <div style="color:#666; font-size:11px; background:#1a1a2e; padding:10px; border-radius:6px; margin-bottom:15px;">
                💡 <strong>How it works:</strong> When you analyze a position, the AI receives up to 5 matching wisdom entries 
                in the prompt under "TRADER'S WISDOM". Entries with <code>appliesTo: ["all"]</code> match everything.
            </div>
            ${resultsHtml}
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Regenerate vector embeddings for all wisdom entries
 * Use this if you've edited existing wisdom text or if embeddings are missing
 */
window.regenerateWisdomEmbeddings = async function() {
    if (!confirm('This will regenerate vector embeddings for all wisdom entries.\n\nThis is only needed if:\n• You edited existing wisdom text\n• Embeddings are missing (Ollama was down when added)\n\nContinue?')) {
        return;
    }
    
    showNotification('🔄 Regenerating embeddings...', 'info');
    
    try {
        const res = await fetch('/api/wisdom/regenerate-embeddings', { method: 'POST' });
        const data = await res.json();
        
        if (data.error) {
            showNotification(`❌ Error: ${data.error}`, 'error');
        } else {
            showNotification(`✅ Regenerated ${data.updated} embeddings`, 'success');
        }
    } catch (e) {
        showNotification(`❌ Failed: ${e.message}`, 'error');
    }
};

/**
 * Handle wisdom image drag & drop
 */
window.handleWisdomImageDrop = function(event) {
    event.preventDefault();
    const dropZone = document.getElementById('wisdomImageDropZone');
    dropZone.style.borderColor = 'rgba(34,197,94,0.3)';
    dropZone.style.background = 'rgba(34,197,94,0.05)';
    
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        displayWisdomImagePreview(file);
    } else {
        showNotification('Please drop an image file', 'error');
    }
};

/**
 * Handle wisdom image upload from file input
 */
window.handleWisdomImageUpload = function(event) {
    const file = event.target.files[0];
    if (file && file.type.startsWith('image/')) {
        displayWisdomImagePreview(file);
    }
};

/**
 * Display wisdom image preview
 */
function displayWisdomImagePreview(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const preview = document.getElementById('wisdomImagePreview');
        const img = document.getElementById('wisdomPreviewImg');
        img.src = e.target.result;
        preview.style.display = 'block';
        // Store base64 for later parsing
        window.pendingWisdomImageData = e.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * Clear wisdom image preview
 */
window.clearWisdomImage = function(event) {
    if (event) event.stopPropagation();
    document.getElementById('wisdomImagePreview').style.display = 'none';
    document.getElementById('wisdomPreviewImg').src = '';
    document.getElementById('wisdomImageInput').value = '';
    document.getElementById('wisdomExtractedPreview').style.display = 'none';
    window.pendingWisdomImageData = null;
    window.extractedWisdomText = null;
};

/**
 * Extract text from wisdom image and show preview for editing
 */
window.extractWisdomFromImage = async function() {
    if (!window.pendingWisdomImageData) {
        showNotification('No image to extract from', 'error');
        return;
    }
    
    showNotification('📷 Extracting text from image...', 'info');
    
    try {
        const visionRes = await fetch('/api/ai/parse-wisdom-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                image: window.pendingWisdomImageData,
                model: 'minicpm-v:latest'
            })
        });
        
        const visionData = await visionRes.json();
        
        if (visionData.error) {
            showNotification(`❌ Vision error: ${visionData.error}`, 'error');
            return;
        }
        
        const extracted = visionData.extractedText || '';
        
        if (!extracted) {
            showNotification('Could not extract any text from image', 'error');
            return;
        }
        
        // Show the extracted text preview
        const previewDiv = document.getElementById('wisdomExtractedPreview');
        const textDiv = document.getElementById('wisdomExtractedText');
        
        if (previewDiv && textDiv) {
            textDiv.textContent = extracted;
            previewDiv.style.display = 'block';
            window.extractedWisdomText = extracted;
            showNotification('✅ Text extracted! Review and click "Process & Save"', 'success');
        }
        
        // Clear the image preview (keep extracted text)
        document.getElementById('wisdomImagePreview').style.display = 'none';
        window.pendingWisdomImageData = null;
        
    } catch (e) {
        showNotification(`❌ Vision error: ${e.message}`, 'error');
    }
};

/**
 * Add new wisdom from input (supports text, images, and extracted preview)
 */
window.addWisdom = async function() {
    const input = document.getElementById('wisdomInput');
    const extractedTextDiv = document.getElementById('wisdomExtractedText');
    
    const hasText = input && input.value.trim();
    const hasExtracted = window.extractedWisdomText || (extractedTextDiv && extractedTextDiv.textContent.trim());
    const hasImage = window.pendingWisdomImageData;
    
    if (!hasText && !hasImage && !hasExtracted) {
        showNotification('Please enter text or drop an image with trading advice', 'error');
        return;
    }
    
    let raw = '';
    
    // Use extracted text if available (from image preview)
    if (hasExtracted) {
        raw = extractedTextDiv ? extractedTextDiv.textContent.trim() : window.extractedWisdomText;
        // Clear the preview
        document.getElementById('wisdomExtractedPreview').style.display = 'none';
        window.extractedWisdomText = null;
    }
    // If we have an image but no extracted text, extract now
    else if (hasImage) {
        try {
            showNotification('📷 Extracting text from image...', 'info');
            
            const visionRes = await fetch('/api/ai/parse-wisdom-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    image: window.pendingWisdomImageData,
                    model: 'minicpm-v:latest'
                })
            });
            
            const visionData = await visionRes.json();
            
            if (visionData.error) {
                showNotification(`❌ Vision error: ${visionData.error}`, 'error');
                return;
            }
            
            raw = visionData.extractedText || '';
            
            if (!raw) {
                showNotification('Could not extract any text from image', 'error');
                return;
            }
            
            // Clear the image preview
            window.clearWisdomImage();
            
        } catch (e) {
            showNotification(`❌ Vision error: ${e.message}`, 'error');
            return;
        }
    }
    
    // Combine with any text input
    if (hasText) {
        raw = raw ? raw + '\n\n' + input.value.trim() : input.value.trim();
    }
    
    try {
        showNotification('🧠 Processing wisdom...', 'info');
        
        const res = await fetch('/api/wisdom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw, model: 'qwen2.5:7b' })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showNotification(`✅ Saved: "${data.entry.wisdom}"`, 'success');
            input.value = '';
            loadWisdomCount();
        } else {
            showNotification(`❌ ${data.error}`, 'error');
        }
    } catch (e) {
        showNotification(`❌ Error: ${e.message}`, 'error');
    }
};

/**
 * Show all wisdom entries in a modal
 */
window.showWisdomList = async function() {
    try {
        const res = await fetch('/api/wisdom');
        const data = await res.json();
        const entries = data.entries || [];
        
        const entriesHtml = entries.length === 0 
            ? '<p style="color:#666; text-align:center;">No wisdom saved yet. Add some trading advice above!</p>'
            : entries.map(e => `
                <div style="background:#1a1a2e; border-radius:6px; padding:12px; margin-bottom:10px; border-left:3px solid #22c55e;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="flex:1;">
                            <div style="color:#22c55e; font-weight:bold; font-size:13px;">${e.wisdom}</div>
                            <div style="color:#666; font-size:11px; margin-top:4px;">
                                [${e.category}] • Applies to: ${e.appliesTo.join(', ')} • Added: ${e.added}
                            </div>
                            <div style="color:#555; font-size:10px; margin-top:4px; font-style:italic;">
                                Original: "${e.raw.substring(0, 100)}${e.raw.length > 100 ? '...' : ''}"
                            </div>
                        </div>
                        <button onclick="window.deleteWisdom(${e.id})" style="background:#ff5252; border:none; border-radius:4px; color:#fff; padding:4px 8px; font-size:10px; cursor:pointer; margin-left:10px;">🗑️</button>
                    </div>
                </div>
            `).join('');
        
        const modal = document.createElement('div');
        modal.id = 'wisdomModal';
        modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10000;';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        
        modal.innerHTML = `
            <div style="background:#0d0d1a; border:1px solid #22c55e; border-radius:12px; padding:25px; max-width:700px; width:90%; max-height:80vh; overflow-y:auto;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h2 style="color:#22c55e; margin:0;">📚 Trading Wisdom Knowledge Base</h2>
                    <button onclick="document.getElementById('wisdomModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">×</button>
                </div>
                <p style="color:#888; font-size:12px; margin-bottom:15px;">
                    This wisdom is automatically included in AI trade analysis based on position type.
                </p>
                <div id="wisdomEntriesList">
                    ${entriesHtml}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
    } catch (e) {
        showNotification(`❌ Error: ${e.message}`, 'error');
    }
};

/**
 * Delete a wisdom entry
 */
window.deleteWisdom = async function(id) {
    try {
        const res = await fetch(`/api/wisdom/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showNotification('Wisdom deleted', 'success');
            loadWisdomCount();
            window.showWisdomList(); // Refresh modal
        }
    } catch (e) {
        showNotification(`❌ Error: ${e.message}`, 'error');
    }
};

// Load wisdom count on page load
setTimeout(loadWisdomCount, 1000);

/**
 * Ideas Tab: AI Trade Ideas Generator (uses Ideas tab element IDs)
 */
window.getTradeIdeas2 = async function() {
    const ideaBtn = document.getElementById('ideaBtn2');
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaBtn || !ideaResults || !ideaContent) {
        console.error('Ideas tab elements not found');
        return;
    }
    
    // Get inputs from Ideas tab
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC2')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid2')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect2')?.value || 'deepseek-r1:32b';
    
    // Check if X trending tickers should be included
    const useXTickers = document.getElementById('useXTickers2')?.checked;
    const xTrendingTickers = (useXTickers && window._xTrendingTickers?.length > 0) ? window._xTrendingTickers : [];
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaBtn.textContent = '⏳ Generating...';
    ideaResults.style.display = 'block';
    const xNote = xTrendingTickers.length > 0 ? ` (including ${xTrendingTickers.length} from X)` : '';
    ideaContent.innerHTML = `<span style="color:#888;">🔄 AI is researching trade ideas${xNote}... (15-30 seconds)</span>`;
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel,
                xTrendingTickers,  // Pass X tickers to backend
                portfolioContext: formatPortfolioContextForAI()  // Include portfolio context from audit
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Store candidates for deep dive and "Show Different" feature
        window._lastTradeIdeas = result.candidates || [];
        window._lastSuggestedTickers = extractSuggestedTickers(result.ideas);
        
        // Save to localStorage for persistence across tab switches
        localStorage.setItem('wheelhouse_trade_ideas', JSON.stringify({
            ideas: result.ideas,
            candidates: result.candidates,
            candidatesChecked: result.candidatesChecked,
            discoveredCount: result.discoveredCount,
            timestamp: Date.now()
        }));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show what stocks were in the candidate pool
        const allCandidates = result.candidates || [];
        const discoveredTickers = allCandidates.filter(c => c.sector === 'Active Today' || c.sector === 'Trending');
        const curatedTickers = allCandidates.filter(c => c.sector !== 'Active Today' && c.sector !== 'Trending');
        
        const poolNote = `<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">
            <div style="color:#888; margin-bottom:8px;">
                📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ${result.candidatesChecked || 0} stocks scanned
                ${result.discoveredCount > 0 ? `(including <span style="color:#ffaa00;">${result.discoveredCount} market movers</span>)` : ''}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${allCandidates.map(t => {
                    const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
                    const bg = isDiscovered ? '#4a3500' : '#333';
                    const border = isDiscovered ? '1px solid #ffaa00' : 'none';
                    return `<span style="background:${bg}; border:${border}; padding:2px 6px; border-radius:3px; color:#ccc;">${t.ticker}</span>`;
                }).join('')}
            </div>
        </div>`;
        
        // Add "Show Different Stocks" button at the end
        formatted += `
            ${poolNote}
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;" title="Get fresh suggestions from different stocks">
                    🔄 Show Different Stocks
                </button>
                <span style="margin-left:10px; color:#666; font-size:11px;">${result.candidatesChecked || 0} stocks scanned</span>
            </div>`;
        
        ideaContent.innerHTML = formatted;
        
    } catch (error) {
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${error.message}</span>`;
    } finally {
        ideaBtn.disabled = false;
        ideaBtn.textContent = '💡 Generate Trade Ideas';
    }
};

/**
 * "Show Different Stocks" - Re-run ideas excluding previously suggested tickers
 */
window.getTradeIdeasDifferent = async function() {
    const ideaBtn = document.getElementById('ideaBtn2');
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaBtn || !ideaResults || !ideaContent) return;
    
    // Get previously suggested tickers to exclude
    const excludeTickers = window._lastSuggestedTickers || [];
    console.log('[Ideas] Excluding previous picks:', excludeTickers);
    
    // Get inputs from Ideas tab
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC2')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid2')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect2')?.value || 'deepseek-r1:32b';
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaContent.innerHTML = '<span style="color:#888;">� Scanning fresh stocks from curated + active + trending... (20-40 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel,
                excludeTickers,  // Pass exclusion list
                portfolioContext: formatPortfolioContextForAI()  // Include portfolio context from audit
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Accumulate excluded tickers for next "Show Different"
        const newTickers = extractSuggestedTickers(result.ideas);
        window._lastSuggestedTickers = [...new Set([...excludeTickers, ...newTickers])];
        window._lastTradeIdeas = result.candidates || [];
        
        // Save to localStorage for persistence
        localStorage.setItem('wheelhouse_trade_ideas', JSON.stringify({
            ideas: result.ideas,
            candidates: result.candidates,
            candidatesChecked: result.candidatesChecked,
            discoveredCount: result.discoveredCount,
            timestamp: Date.now()
        }));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show what stocks were in the candidate pool
        const allCandidates = result.candidates || [];
        const poolNote = `<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">
            <div style="color:#888; margin-bottom:8px;">
                📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ${result.candidatesChecked || 0} stocks scanned
                ${result.discoveredCount > 0 ? `(including <span style="color:#ffaa00;">${result.discoveredCount} market movers</span>)` : ''}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${allCandidates.map(t => {
                    const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
                    const bg = isDiscovered ? '#4a3500' : '#333';
                    const border = isDiscovered ? '1px solid #ffaa00' : 'none';
                    return `<span style="background:${bg}; border:${border}; padding:2px 6px; border-radius:3px; color:#ccc;">${t.ticker}</span>`;
                }).join('')}
            </div>
        </div>`;
        
        // Add "Show Different" button + "Reset" option
        formatted += `
            ${poolNote}
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;">
                    🔄 Show More Different Stocks
                </button>
                <button onclick="window._lastSuggestedTickers=[]; window.getTradeIdeas2();" style="padding:8px 16px; margin-left:10px; background:#333; border:none; border-radius:5px; color:#888; cursor:pointer; font-size:13px;" title="Reset exclusions and start fresh">
                    ↩️ Reset
                </button>
                <span style="margin-left:10px; color:#666; font-size:11px;">${window._lastSuggestedTickers.length} excluded • ${result.candidatesChecked || 0} scanned</span>
            </div>`;
        
        ideaContent.innerHTML = formatted;
        
    } catch (error) {
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${error.message}</span>`;
    } finally {
        ideaBtn.disabled = false;
        ideaBtn.textContent = '💡 Generate Trade Ideas';
    }
};

// ============================================================
// SECTION: MONTE CARLO SIMULATION
// Functions: runMonteCarloRisk, initMonteCarloTab
// Lines: ~3603-4050
// ============================================================

/**
 * Monte Carlo Risk Analysis - Uses loaded position data to run real GBM simulation
 * Shows probability distributions, price cones, and risk scenarios
 */
window.runMonteCarloRisk = function() {
    const numPaths = parseInt(document.getElementById('mcPathCount')?.value) || 10000;
    
    // Get position parameters from state (set by Pricing tab or loadPositionToAnalyze)
    const spot = state.spot || 100;
    const strike = state.strike || 95;
    const dte = state.dte || 30;
    const iv = state.optVol || 0.3;
    const rate = state.rate || 0.045;
    
    // Check if we have a valid position loaded
    if (!state.spot || state.spot <= 0) {
        showNotification('No position loaded - go to Pricing tab first', 'error');
        return;
    }
    
    // Show running indicator
    const runBtn = document.getElementById('runMcBtn');
    const runningEl = document.getElementById('mcRunning');
    if (runBtn) runBtn.disabled = true;
    if (runningEl) {
        runningEl.textContent = `Simulating ${numPaths.toLocaleString()} paths...`;
        runningEl.style.display = 'block';
    }
    
    // Run simulation async (use setTimeout to allow UI update)
    setTimeout(() => {
        const results = runGBMSimulation(spot, strike, dte, iv, rate, numPaths);
        displayMonteCarloResults(results, spot, strike, dte, iv);
        
        if (runBtn) runBtn.disabled = false;
        if (runningEl) runningEl.style.display = 'none';
    }, 50);
};

/**
 * Run Geometric Brownian Motion simulation
 */
function runGBMSimulation(spot, strike, dte, vol, rate, numPaths) {
    const T = dte / 365;
    const dt = 1 / 365;  // Daily steps
    const steps = Math.ceil(dte);
    
    const finalPrices = [];
    const paths = [];  // Store subset for visualization
    const pathsToStore = Math.min(100, numPaths);  // Only store 100 paths for drawing
    
    // Run simulations
    for (let i = 0; i < numPaths; i++) {
        let S = spot;
        const path = [S];
        
        for (let t = 0; t < steps; t++) {
            // Standard GBM: dS = μSdt + σSdW
            const dW = Math.sqrt(dt) * gaussianRandom();
            S *= Math.exp((rate - 0.5 * vol * vol) * dt + vol * dW);
            
            if (i < pathsToStore) path.push(S);
        }
        
        finalPrices.push(S);
        if (i < pathsToStore) paths.push(path);
    }
    
    // Calculate statistics
    finalPrices.sort((a, b) => a - b);
    
    const belowStrike = finalPrices.filter(p => p < strike).length;
    const otmPercent = ((numPaths - belowStrike) / numPaths * 100).toFixed(1);
    const itmPercent = (belowStrike / numPaths * 100).toFixed(1);
    
    const median = finalPrices[Math.floor(numPaths / 2)];
    const mean = finalPrices.reduce((a, b) => a + b, 0) / numPaths;
    
    // Calculate percentiles
    const percentile = (arr, p) => arr[Math.floor(arr.length * p / 100)];
    const percentiles = {
        p5: percentile(finalPrices, 5),
        p10: percentile(finalPrices, 10),
        p25: percentile(finalPrices, 25),
        p50: percentile(finalPrices, 50),
        p75: percentile(finalPrices, 75),
        p90: percentile(finalPrices, 90),
        p95: percentile(finalPrices, 95)
    };
    
    // Expected move (1 std dev)
    const stdDev = Math.sqrt(finalPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / numPaths);
    const expectedMove = spot * vol * Math.sqrt(T);
    
    return {
        finalPrices,
        paths,
        otmPercent: parseFloat(otmPercent),
        itmPercent: parseFloat(itmPercent),
        median,
        mean,
        stdDev,
        expectedMove,
        percentiles,
        numPaths,
        spot,
        strike,
        dte
    };
}

/**
 * Standard normal random using Box-Muller
 */
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Display Monte Carlo results in the UI
 */
function displayMonteCarloResults(results, spot, strike, dte, iv) {
    // Show all hidden elements
    document.getElementById('mcTitle').style.display = 'block';
    document.getElementById('mcConeTitle').style.display = 'block';
    document.getElementById('mcDistributionCanvas').style.display = 'block';
    document.getElementById('mcConeCanvas').style.display = 'block';
    document.getElementById('mcStatsGrid').style.display = 'grid';
    document.getElementById('mcPercentiles').style.display = 'block';
    
    // Update stats
    document.getElementById('mcOtmPct').textContent = results.otmPercent.toFixed(1) + '%';
    document.getElementById('mcItmPct').textContent = results.itmPercent.toFixed(1) + '%';
    document.getElementById('mcMedianPrice').textContent = '$' + results.median.toFixed(2);
    document.getElementById('mcExpectedMove').textContent = '±$' + results.expectedMove.toFixed(2);
    
    // Update percentiles
    document.getElementById('mcP5').textContent = '$' + results.percentiles.p5.toFixed(2);
    document.getElementById('mcP10').textContent = '$' + results.percentiles.p10.toFixed(2);
    document.getElementById('mcP25').textContent = '$' + results.percentiles.p25.toFixed(2);
    document.getElementById('mcP50').textContent = '$' + results.percentiles.p50.toFixed(2);
    document.getElementById('mcP75').textContent = '$' + results.percentiles.p75.toFixed(2);
    document.getElementById('mcP90').textContent = '$' + results.percentiles.p90.toFixed(2);
    document.getElementById('mcP95').textContent = '$' + results.percentiles.p95.toFixed(2);
    
    // Color percentiles based on strike
    ['mcP5', 'mcP10', 'mcP25', 'mcP50', 'mcP75', 'mcP90', 'mcP95'].forEach(id => {
        const el = document.getElementById(id);
        const val = parseFloat(el.textContent.replace('$', ''));
        if (val < strike) {
            el.style.color = '#ff5252';  // ITM = red
        } else {
            el.style.color = '#00ff88';  // OTM = green
        }
    });
    
    // Draw distribution histogram
    drawDistributionHistogram(results, strike);
    
    // Draw probability cone
    drawProbabilityConeChart(results, spot, strike);
    
    // Update risk scenarios
    updateRiskScenarios(results, spot, strike);
    
    // Update profit analysis
    updateProfitAnalysis(results, spot, strike, dte);
}

/**
 * Draw price distribution histogram
 */
function drawDistributionHistogram(results, strike) {
    const canvas = document.getElementById('mcDistributionCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, W, H);
    
    // Create bins
    const prices = results.finalPrices;
    const minPrice = Math.min(...prices) * 0.95;
    const maxPrice = Math.max(...prices) * 1.05;
    const numBins = 50;
    const binWidth = (maxPrice - minPrice) / numBins;
    
    const bins = new Array(numBins).fill(0);
    prices.forEach(p => {
        const binIdx = Math.min(numBins - 1, Math.floor((p - minPrice) / binWidth));
        bins[binIdx]++;
    });
    
    const maxCount = Math.max(...bins);
    const barWidth = (W - 60) / numBins;
    
    // Draw bars
    bins.forEach((count, i) => {
        const x = 40 + i * barWidth;
        const barHeight = (count / maxCount) * (H - 40);
        const priceAtBin = minPrice + (i + 0.5) * binWidth;
        
        // Color based on strike
        if (priceAtBin < strike) {
            ctx.fillStyle = 'rgba(255,82,82,0.6)';  // ITM = red
        } else {
            ctx.fillStyle = 'rgba(0,255,136,0.6)';  // OTM = green
        }
        
        ctx.fillRect(x, H - 20 - barHeight, barWidth - 1, barHeight);
    });
    
    // Draw strike line
    const strikeX = 40 + ((strike - minPrice) / (maxPrice - minPrice)) * (W - 60);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(strikeX, 10);
    ctx.lineTo(strikeX, H - 20);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Label strike
    ctx.fillStyle = '#ffaa00';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Strike $' + strike.toFixed(0), strikeX, H - 5);
    
    // Axis labels
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('$' + minPrice.toFixed(0), 40, H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('$' + maxPrice.toFixed(0), W - 20, H - 5);
    
    // Median line
    const medianX = 40 + ((results.median - minPrice) / (maxPrice - minPrice)) * (W - 60);
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(medianX, 10);
    ctx.lineTo(medianX, H - 20);
    ctx.stroke();
    ctx.setLineDash([]);
}

/**
 * Draw probability cone showing percentile bands over time
 */
function drawProbabilityConeChart(results, spot, strike) {
    const canvas = document.getElementById('mcConeCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const padding = { left: 50, right: 20, top: 20, bottom: 25 };
    
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, W, H);
    
    const paths = results.paths;
    if (paths.length === 0) return;
    
    const steps = paths[0].length;
    const chartW = W - padding.left - padding.right;
    const chartH = H - padding.top - padding.bottom;
    
    // Calculate percentile bands at each time step
    const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    
    for (let t = 0; t < steps; t++) {
        const pricesAtT = paths.map(p => p[t]).sort((a, b) => a - b);
        const n = pricesAtT.length;
        bands.p5.push(pricesAtT[Math.floor(n * 0.05)]);
        bands.p25.push(pricesAtT[Math.floor(n * 0.25)]);
        bands.p50.push(pricesAtT[Math.floor(n * 0.50)]);
        bands.p75.push(pricesAtT[Math.floor(n * 0.75)]);
        bands.p95.push(pricesAtT[Math.floor(n * 0.95)]);
    }
    
    // Find price range
    const allPrices = [...bands.p5, ...bands.p95];
    const minP = Math.min(...allPrices) * 0.95;
    const maxP = Math.max(...allPrices) * 1.05;
    
    const toX = (t) => padding.left + (t / (steps - 1)) * chartW;
    const toY = (p) => padding.top + (1 - (p - minP) / (maxP - minP)) * chartH;
    
    // Draw 5-95 band (light fill)
    ctx.fillStyle = 'rgba(139,92,246,0.15)';
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p5[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p5[t]));
    for (let t = steps - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(bands.p95[t]));
    ctx.closePath();
    ctx.fill();
    
    // Draw 25-75 band (darker fill)
    ctx.fillStyle = 'rgba(139,92,246,0.3)';
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p25[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p25[t]));
    for (let t = steps - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(bands.p75[t]));
    ctx.closePath();
    ctx.fill();
    
    // Draw median line
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p50[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p50[t]));
    ctx.stroke();
    
    // Draw strike line
    if (strike >= minP && strike <= maxP) {
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(padding.left, toY(strike));
        ctx.lineTo(W - padding.right, toY(strike));
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Label
        ctx.fillStyle = '#ffaa00';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText('Strike $' + strike.toFixed(0), W - padding.right, toY(strike) - 3);
    }
    
    // Draw current spot line
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, toY(spot));
    ctx.lineTo(padding.left + 20, toY(spot));
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Axes
    ctx.fillStyle = '#888';
    ctx.font = '10px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('$' + maxP.toFixed(0), 5, padding.top + 10);
    ctx.fillText('$' + minP.toFixed(0), 5, H - padding.bottom);
    
    ctx.textAlign = 'center';
    ctx.fillText('Today', padding.left, H - 5);
    ctx.fillText('Expiry', W - padding.right, H - 5);
    
    // Legend
    ctx.fillStyle = '#7a8a94';
    ctx.fillText('50% of outcomes in dark band, 90% in light band', W / 2, 12);
}

/**
 * Update risk scenarios panel
 */
function updateRiskScenarios(results, spot, strike) {
    const el = document.getElementById('mcRiskScenarios');
    if (!el) return;
    
    const { percentiles, itmPercent } = results;
    
    // Worst case (5th percentile)
    const worstDrop = ((spot - percentiles.p5) / spot * 100).toFixed(1);
    const worstLoss = Math.max(0, (strike - percentiles.p5) * 100).toFixed(0);
    
    // 10th percentile drop
    const drop10 = ((spot - percentiles.p10) / spot * 100).toFixed(1);
    
    el.innerHTML = `
        <div style="margin-bottom:6px;">
            <span style="color:#ff5252;">🔻 5% worst case:</span> Stock at $${percentiles.p5.toFixed(2)} (−${worstDrop}%)
            ${percentiles.p5 < strike ? `<br>&nbsp;&nbsp;&nbsp;→ Assignment loss: ~$${worstLoss}/contract` : ''}
        </div>
        <div style="margin-bottom:6px;">
            <span style="color:#ffaa00;">⚠️ 10% bad case:</span> Stock at $${percentiles.p10.toFixed(2)} (−${drop10}%)
        </div>
        <div>
            <span style="color:#888;">📊 ITM probability:</span> ${itmPercent.toFixed(1)}% chance of assignment
        </div>
    `;
}

/**
 * Update profit analysis panel
 */
function updateProfitAnalysis(results, spot, strike, dte) {
    const el = document.getElementById('mcProfitAnalysis');
    if (!el) return;
    
    const { otmPercent, percentiles, median } = results;
    
    // Expected outcome
    const medianReturn = ((median - spot) / spot * 100).toFixed(1);
    const gainScenario = ((percentiles.p75 - spot) / spot * 100).toFixed(1);
    
    el.innerHTML = `
        <div style="margin-bottom:6px;">
            <span style="color:#00ff88;">✅ OTM probability:</span> ${otmPercent.toFixed(1)}% chance to keep full premium
        </div>
        <div style="margin-bottom:6px;">
            <span style="color:#00d9ff;">📊 Median outcome:</span> Stock at $${median.toFixed(2)} (${medianReturn >= 0 ? '+' : ''}${medianReturn}%)
        </div>
        <div>
            <span style="color:#00ff88;">🎯 75% best case:</span> Stock at $${percentiles.p75.toFixed(2)} or higher
        </div>
    `;
}

/**
 * Initialize Monte Carlo tab when activated
 */
window.initMonteCarloTab = function() {
    // Update UI with current state values
    const mcBanner = document.getElementById('mcPositionBanner');
    const mcNoPos = document.getElementById('mcNoPosition');
    const mcParams = document.getElementById('mcParamsBox');
    
    if (!state.spot || state.spot <= 0) {
        // No position loaded
        if (mcBanner) mcBanner.style.display = 'none';
        if (mcNoPos) mcNoPos.style.display = 'block';
        if (mcParams) mcParams.style.display = 'none';
        return;
    }
    
    // Position is loaded - show it
    if (mcBanner) mcBanner.style.display = 'block';
    if (mcNoPos) mcNoPos.style.display = 'none';
    if (mcParams) mcParams.style.display = 'block';
    
    // Update ticker info
    const ticker = state.currentTicker || 'Unknown';
    document.getElementById('mcPositionTicker').textContent = ticker;
    document.getElementById('mcPositionDetails').textContent = 
        `$${state.strike?.toFixed(2) || '—'} put, ${state.dte || '—'} DTE`;
    
    // Update params
    document.getElementById('mcSpot').textContent = '$' + (state.spot?.toFixed(2) || '—');
    document.getElementById('mcStrike').textContent = '$' + (state.strike?.toFixed(2) || '—');
    document.getElementById('mcIV').textContent = ((state.optVol || 0) * 100).toFixed(0) + '%';
    document.getElementById('mcDTE').textContent = (state.dte || '—') + ' days';
};

// ============================================================
// SECTION: UI UTILITIES (Collapsible Sections, State Persistence)
// Functions: toggleSection, toggleTickerGroup, restoreCollapsedStates
// Lines: ~4093-4150
// ============================================================

/**
 * Toggle collapsible sections in Portfolio tab
 * Saves state to localStorage for persistence
 */
window.toggleSection = function(sectionId) {
    const header = document.getElementById(sectionId + 'Header');
    const content = document.getElementById(sectionId + 'Content');
    
    if (!header || !content) return;
    
    const isCollapsed = header.classList.toggle('collapsed');
    content.classList.toggle('collapsed', isCollapsed);
    
    // Save state to localStorage
    const collapsedSections = JSON.parse(localStorage.getItem('wheelhouse_collapsed_sections') || '{}');
    collapsedSections[sectionId] = isCollapsed;
    localStorage.setItem('wheelhouse_collapsed_sections', JSON.stringify(collapsedSections));
};

/**
 * Toggle ticker group in closed positions
 */
window.toggleTickerGroup = function(ticker) {
    const header = document.querySelector(`.ticker-group-header[data-ticker="${ticker}"]`);
    const trades = document.querySelector(`.ticker-group-trades[data-ticker="${ticker}"]`);
    
    if (!header || !trades) return;
    
    header.classList.toggle('collapsed');
    trades.classList.toggle('collapsed');
    
    // Save state
    const collapsedTickers = JSON.parse(localStorage.getItem('wheelhouse_collapsed_tickers') || '{}');
    collapsedTickers[ticker] = header.classList.contains('collapsed');
    localStorage.setItem('wheelhouse_collapsed_tickers', JSON.stringify(collapsedTickers));
};

/**
 * Restore collapsed section states on page load
 */
window.restoreCollapsedStates = function() {
    const collapsedSections = JSON.parse(localStorage.getItem('wheelhouse_collapsed_sections') || '{}');
    
    Object.entries(collapsedSections).forEach(([sectionId, isCollapsed]) => {
        if (isCollapsed) {
            const header = document.getElementById(sectionId + 'Header');
            const content = document.getElementById(sectionId + 'Content');
            if (header && content) {
                header.classList.add('collapsed');
                content.classList.add('collapsed');
            }
        }
    });
};

// ============================================================================
// WHEEL SCANNER - Find stocks near 3-month lows for wheel entries
// ============================================================================

window.runWheelScanner = async function() {
    const resultsDiv = document.getElementById('scannerResults');
    const loadingDiv = document.getElementById('scannerLoading');
    const tableDiv = document.getElementById('scannerTable');
    const countSpan = document.getElementById('scannerCount');
    const timeSpan = document.getElementById('scannerTime');
    const btn = document.getElementById('scannerBtn');
    
    // Get filter values
    const maxRange = document.getElementById('scannerMaxRange')?.value || '10';
    const sector = document.getElementById('scannerSector')?.value || 'all';
    const cap = document.getElementById('scannerCap')?.value || 'all';
    const minPrice = document.getElementById('scannerMinPrice')?.value || '10';
    const maxPrice = document.getElementById('scannerMaxPrice')?.value || '500';
    
    // Show loading, hide results
    if (resultsDiv) resultsDiv.style.display = 'none';
    if (loadingDiv) loadingDiv.style.display = 'block';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Scanning...';
    }
    
    const startTime = Date.now();
    
    try {
        const url = `/api/scanner/wheel?maxRange=${maxRange}&sector=${sector}&cap=${cap}&minPrice=${minPrice}&maxPrice=${maxPrice}`;
        const response = await fetch(url);
        
        if (!response.ok) throw new Error('Scanner request failed');
        
        const data = await response.json();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // Hide loading, show results
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (resultsDiv) resultsDiv.style.display = 'block';
        
        if (countSpan) countSpan.textContent = `${data.count} candidates found`;
        if (timeSpan) timeSpan.textContent = `Scanned in ${elapsed}s`;
        
        if (data.results && data.results.length > 0) {
            // Build results table
            let html = `
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:1px solid #333; color:#888; font-size:10px; text-transform:uppercase;">
                            <th style="text-align:left; padding:6px 4px;">Ticker</th>
                            <th style="text-align:left; padding:6px 4px;">Sector</th>
                            <th style="text-align:right; padding:6px 4px;">Price</th>
                            <th style="text-align:right; padding:6px 4px;">3M Low</th>
                            <th style="text-align:center; padding:6px 4px;">Range</th>
                            <th style="text-align:right; padding:6px 4px;">IV</th>
                            <th style="text-align:right; padding:6px 4px;">~Put</th>
                            <th style="text-align:center; padding:6px 4px;">Action</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            data.results.forEach(r => {
                // Color code range position
                let rangeColor = '#00ff88'; // Green for very low
                let rangeIcon = '🔴';
                if (r.rangePosition > 5) { rangeColor = '#ffaa00'; rangeIcon = '🟠'; }
                if (r.rangePosition > 10) { rangeColor = '#ff9800'; rangeIcon = '🟡'; }
                if (r.rangePosition > 15) { rangeColor = '#888'; rangeIcon = '⚪'; }
                
                html += `
                    <tr style="border-bottom:1px solid #222; transition:background 0.2s;" 
                        onmouseover="this.style.background='rgba(0,217,255,0.1)'" 
                        onmouseout="this.style.background='transparent'">
                        <td style="padding:8px 4px; font-weight:bold; color:#00d9ff;">${r.ticker}</td>
                        <td style="padding:8px 4px; color:#888; font-size:10px;">${r.sector}</td>
                        <td style="padding:8px 4px; text-align:right; color:#ddd;">$${r.price.toFixed(2)}</td>
                        <td style="padding:8px 4px; text-align:right; color:#888;">$${r.low3m.toFixed(2)}</td>
                        <td style="padding:8px 4px; text-align:center;">
                            <span style="color:${rangeColor}; font-weight:bold;">${rangeIcon} ${r.rangePosition.toFixed(1)}%</span>
                        </td>
                        <td style="padding:8px 4px; text-align:right; color:${r.iv && r.iv > 50 ? '#ffaa00' : '#888'};">
                            ${r.iv ? r.iv.toFixed(0) + '%' : '-'}
                        </td>
                        <td style="padding:8px 4px; text-align:right; color:#00ff88;">
                            ${r.putPremium ? '$' + r.putPremium.toFixed(2) : '-'}
                        </td>
                        <td style="padding:8px 4px; text-align:center; white-space:nowrap;">
                            <button onclick="window.showTickerChart('${r.ticker}')" 
                                style="padding:4px 8px; background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.4); border-radius:4px; color:#ffaa00; font-size:10px; cursor:pointer; margin-right:4px;"
                                title="View 3-month chart with Bollinger Bands">
                                📊
                            </button>
                            <button onclick="window.scannerAnalyze('${r.ticker}')" 
                                style="padding:4px 8px; background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.4); border-radius:4px; color:#00d9ff; font-size:10px; cursor:pointer; margin-right:4px;"
                                title="Deep dive analysis">
                                🔍
                            </button>
                            <button onclick="window.scannerQuickAdd('${r.ticker}', ${r.price})" 
                                style="padding:4px 8px; background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.4); border-radius:4px; color:#00ff88; font-size:10px; cursor:pointer;"
                                title="Quick add to Discord analyzer">
                                +
                            </button>
                        </td>
                    </tr>
                `;
            });
            
            html += '</tbody></table>';
            if (tableDiv) tableDiv.innerHTML = html;
        } else {
            if (tableDiv) tableDiv.innerHTML = `
                <div style="text-align:center; padding:20px; color:#888;">
                    <div style="font-size:24px; margin-bottom:8px;">🔍</div>
                    <div>No candidates found matching your filters.</div>
                    <div style="font-size:11px; margin-top:8px;">Try increasing the range % or changing sector filters.</div>
                </div>
            `;
        }
        
    } catch (error) {
        console.error('[SCANNER] Error:', error);
        showNotification('Scanner failed: ' + error.message, 'error');
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (tableDiv) tableDiv.innerHTML = `
            <div style="text-align:center; padding:20px; color:#ff5252;">
                <div style="font-size:24px; margin-bottom:8px;">❌</div>
                <div>Scanner error: ${error.message}</div>
            </div>
        `;
        if (resultsDiv) resultsDiv.style.display = 'block';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🔄 Scan Now';
        }
    }
};

// Scanner helper: Send ticker to Strategy Advisor for deep analysis
window.scannerAnalyze = function(ticker) {
    // Set the ticker in Strategy Advisor and run it
    const tickerInput = document.getElementById('strategyAdvisorTicker');
    if (tickerInput) {
        tickerInput.value = ticker;
        // Scroll to Strategy Advisor section
        tickerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Optionally auto-run
        setTimeout(() => {
            window.runStrategyAdvisor();
        }, 300);
    }
};

// Scanner helper: Quick add to Discord analyzer
window.scannerQuickAdd = function(ticker, price) {
    const strike = Math.round(price * 0.95); // 5% below current price
    const tradeText = `Short put on ${ticker} $${strike} strike, 30-45 DTE`;
    
    const textArea = document.getElementById('pasteTradeInput2');
    if (textArea) {
        textArea.value = tradeText;
        textArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showNotification(`Added ${ticker} $${strike}P to analyzer`, 'success');
    }
};

/**
 * Open PMCC (Poor Man's Covered Call) Calculator
 * Analyzes existing LEAPS positions and models selling short calls against them
 */
window.openPMCCCalculator = function() {
    // Find all long call positions (potential LEAPS) - broader filter
    const longCalls = state.positions.filter(p => {
        // Accept any position that looks like a long call with 180+ DTE
        const isLongCall = p.type?.toLowerCase().includes('call') && 
                          !p.type?.toLowerCase().includes('short') &&
                          !p.type?.toLowerCase().includes('credit') &&
                          !p.type?.toLowerCase().includes('covered_call');  // Covered calls are different
        const hasTime = p.dte > 180;  // At least 6 months remaining
        const isOpen = p.status === 'open';
        
        return isLongCall && hasTime && isOpen;
    });
    
    console.log('[PMCC] Found long call positions:', longCalls.length, longCalls.map(p => ({ ticker: p.ticker, type: p.type, dte: p.dte })));
    
    const modal = document.createElement('div');
    modal.id = 'pmccModal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.9); display: flex; align-items: center;
        justify-content: center; z-index: 10001; backdrop-filter: blur(4px);
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build position selector options
    const positionOptions = longCalls.length > 0
        ? longCalls.map(p => `<option value="${p.id}">${p.ticker} $${p.strike} ${p.expiry} (${p.dte}d) - Cost: $${p.premium * 100}</option>`).join('')
        : '<option value="">No LEAPS positions found</option>';
    
    modal.innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 28px; border-radius: 16px; max-width: 700px; width: 90%; max-height: 90vh; overflow-y: auto; border: 2px solid #8b5cf6; box-shadow: 0 20px 60px rgba(139,92,246,0.3);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="color: #8b5cf6; margin: 0; font-size: 22px;">📊 PMCC Calculator</h2>
                <button onclick="this.closest('#pmccModal').remove()" style="background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;">&times;</button>
            </div>
            
            <div style="background: rgba(139,92,246,0.15); padding: 12px; border-radius: 8px; border: 1px solid rgba(139,92,246,0.3); margin-bottom: 20px; font-size: 13px; color: #ddd;">
                <strong style="color: #8b5cf6;">Poor Man's Covered Call:</strong> Sell short-term calls against a long-dated (LEAPS) call to generate income while maintaining long-term upside exposure.
            </div>
            
            <!-- LEAPS Position Selector -->
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: #8b5cf6; font-weight: bold; margin-bottom: 8px; font-size: 13px;">🎯 Select Existing LEAPS Position</label>
                <select id="pmccPositionSelect" onchange="window.loadPMCCPosition(this.value)" style="width: 100%; padding: 10px; background: #0d0d1a; border: 1px solid #8b5cf6; color: #fff; border-radius: 6px; font-size: 13px; cursor: pointer;">
                    <option value="">-- Select a position --</option>
                    ${positionOptions}
                    <option value="manual">✏️ Manual Entry (New Analysis)</option>
                </select>
            </div>
            
            <!-- LEAPS Details (Current Position) -->
            <div id="pmccLeapsSection" style="display: none;">
                <div style="background: linear-gradient(135deg, rgba(0,217,255,0.15), rgba(0,153,204,0.1)); padding: 16px; border-radius: 8px; border: 1px solid rgba(0,217,255,0.4); margin-bottom: 20px;">
                    <div style="color: #00d9ff; font-weight: bold; margin-bottom: 12px; font-size: 14px;">📈 Your LEAPS Position</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
                        <div>
                            <div style="color: #888; font-size: 11px;">Ticker</div>
                            <div id="pmccTicker" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Strike</div>
                            <div id="pmccStrike" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Expiry</div>
                            <div id="pmccExpiry" style="color: #fff; font-size: 13px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Original Cost</div>
                            <div id="pmccCost" style="color: #ff5252; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Current Value</div>
                            <div id="pmccCurrentValue" style="color: #00ff88; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Unrealized P&L</div>
                            <div id="pmccUnrealizedPnL" style="font-weight: bold; font-size: 14px;">-</div>
                        </div>
                    </div>
                    <!-- Breakeven Strike - CRITICAL for PMCC -->
                    <div style="margin-top: 12px; padding: 10px; background: linear-gradient(135deg, rgba(139,92,246,0.2), rgba(0,217,255,0.1)); border-radius: 6px; border: 1px solid rgba(139,92,246,0.4);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="color: #888; font-size: 11px;">Breakeven Strike (LEAPS strike + premium paid)</div>
                                <div id="pmccBreakevenStrike" style="color: #8b5cf6; font-weight: bold; font-size: 18px;">-</div>
                            </div>
                            <div style="text-align: right; font-size: 11px; color: #888; max-width: 180px;">
                                Sell calls ABOVE this to profit if assigned
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(0,217,255,0.2); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
                        <div>
                            <div style="color: #888; font-size: 11px;">Spot Price</div>
                            <div id="pmccSpot" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Intrinsic Value</div>
                            <div id="pmccIntrinsic" style="color: #00ff88; font-size: 13px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Time Value</div>
                            <div id="pmccTimeValue" style="color: #ffaa00; font-size: 13px;">-</div>
                        </div>
                    </div>
                </div>
                
                <!-- Short Call Inputs -->
                <div style="background: linear-gradient(135deg, rgba(255,82,82,0.15), rgba(255,170,0,0.1)); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,82,82,0.3); margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div style="color: #ff5252; font-weight: bold; font-size: 14px;">💰 Short Call to Sell</div>
                        <button onclick="window.loadPMCCChain()" style="padding: 4px 10px; background: rgba(0,217,255,0.2); border: 1px solid #00d9ff; color: #00d9ff; border-radius: 4px; cursor: pointer; font-size: 11px;">
                            🔄 Load Chain
                        </button>
                    </div>
                    <div id="pmccChainLoadingStatus" style="font-size: 11px; color: #888; margin-bottom: 8px; text-align: center;">
                        Click "Load Chain" to fetch strikes & premiums
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                        <div>
                            <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Strike Price</label>
                            <select id="pmccShortStrike" onchange="window.onPMCCStrikeChange()"
                                   style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ff5252; color: #fff; border-radius: 4px; font-size: 13px; cursor: pointer;">
                                <option value="">Select strike...</option>
                            </select>
                        </div>
                        <div>
                            <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Expiry Date</label>
                            <select id="pmccShortExpiry" onchange="window.onPMCCExpiryChange()"
                                   style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ff5252; color: #fff; border-radius: 4px; font-size: 13px; cursor: pointer;">
                                <option value="">Select expiry...</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Premium (per share) - Auto-filled from chain</label>
                        <input type="number" id="pmccShortPremium" step="0.01" placeholder="Will auto-fill from selected strike" oninput="window.calculatePMCC()"
                               style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #00ff88; color: #fff; border-radius: 4px; font-size: 13px;">
                    </div>
                </div>
                
                <!-- Results / What-If Scenarios -->
                <div id="pmccResults" style="display: none;">
                    <div style="background: rgba(0,0,0,0.3); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                        <div style="color: #00ff88; font-weight: bold; margin-bottom: 12px; font-size: 14px;">📊 Scenario Analysis</div>
                        
                        <!-- MOST LIKELY: Stock stays below strike -->
                        <div style="margin-bottom: 16px; padding: 12px; background: rgba(0,255,136,0.15); border-radius: 6px; border: 2px solid rgba(0,255,136,0.4);">
                            <div style="color: #00ff88; font-weight: bold; margin-bottom: 8px; font-size: 13px;">✅ If Stock Stays Below Strike (Most Likely)</div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px;">
                                <div>
                                    <div style="color: #888; font-size: 11px;">You Keep</div>
                                    <div id="pmccKeepPremium" style="color: #00ff88; font-weight: bold; font-size: 18px;">-</div>
                                </div>
                                <div>
                                    <div style="color: #888; font-size: 11px;">Your LEAPS</div>
                                    <div style="color: #fff; font-size: 13px;">Unchanged - sell another call!</div>
                                </div>
                            </div>
                            <div style="margin-top: 8px; padding: 6px 8px; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 11px; color: #888;">
                                Short call expires worthless → rinse & repeat for more income
                            </div>
                        </div>
                        
                        <!-- Monthly Yield -->
                        <div style="margin-bottom: 16px; padding: 12px; background: rgba(0,217,255,0.1); border-radius: 6px; border: 1px solid rgba(0,217,255,0.2);">
                            <div style="color: #888; font-size: 11px;">Monthly Yield on Capital</div>
                            <div id="pmccMonthlyYield" style="color: #00d9ff; font-size: 20px; font-weight: bold;">-</div>
                            <div id="pmccAnnualizedYield" style="color: #00d9ff; font-size: 12px; margin-top: 4px;">-</div>
                        </div>
                        
                        <!-- If Assigned Scenario -->
                        <div style="margin-bottom: 12px; padding: 12px; background: rgba(255,170,0,0.1); border-radius: 6px; border: 1px solid rgba(255,170,0,0.2);">
                            <div style="color: #ffaa00; font-weight: bold; margin-bottom: 12px; font-size: 13px;">⚠️ If Assigned (Stock Reaches Short Strike)</div>
                            
                            <!-- Option A: Exercise -->
                            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                                <div style="color: #fff; font-weight: bold; font-size: 12px; margin-bottom: 6px;">Option A: Exercise Your LEAPS</div>
                                <div style="color: #888; font-size: 11px; line-height: 1.5;">
                                    1. Use LEAPS to buy 100 shares at $<span id="pmccExerciseStrike">-</span><br>
                                    2. Deliver those shares at $<span id="pmccShortStrikeDisplay">-</span> (assignment)<br>
                                    3. Keep the premium you collected
                                </div>
                                <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: #888; font-size: 11px;">Net Profit:</span>
                                    <span id="pmccExerciseProfit" style="font-weight: bold; font-size: 16px;">-</span>
                                </div>
                                <div style="color: #ff5252; font-size: 10px; margin-top: 4px;">⚠️ Loses all remaining time value in your LEAPS</div>
                            </div>
                            
                            <!-- Option B: Close Both -->
                            <div style="background: rgba(0,255,136,0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(0,255,136,0.2);">
                                <div style="color: #00ff88; font-weight: bold; font-size: 12px; margin-bottom: 6px;">Option B: Close Both Positions (Usually Better)</div>
                                <div style="color: #888; font-size: 11px; line-height: 1.5;">
                                    1. Buy back short call (at a loss)<br>
                                    2. Sell your LEAPS at market value<br>
                                    3. Preserves LEAPS time value: $<span id="pmccTimeValueDisplay">-</span>
                                </div>
                                <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: #888; font-size: 11px;">Net Profit:</span>
                                    <span id="pmccCloseProfit" style="font-weight: bold; font-size: 16px;">-</span>
                                </div>
                            </div>
                            
                            <div id="pmccRecommendation" style="margin-top: 10px; padding: 8px; background: rgba(0,217,255,0.15); border-radius: 4px; font-size: 12px; color: #00d9ff; text-align: center;">
                                -
                            </div>
                        </div>
                        
                        <!-- Breakeven & Warnings -->
                        <div style="padding: 12px; background: rgba(139,92,246,0.1); border-radius: 6px; border: 1px solid rgba(139,92,246,0.2); font-size: 12px;">
                            <div style="margin-bottom: 6px;">
                                <span style="color: #888;">Your Breakeven:</span>
                                <span id="pmccBreakeven" style="color: #fff; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                            <div style="margin-bottom: 6px;">
                                <span style="color: #888;">Max Profit:</span>
                                <span id="pmccMaxProfit" style="color: #00ff88; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                            <div>
                                <span style="color: #888;">Max Profit at:</span>
                                <span id="pmccMaxProfitStrike" style="color: #fff; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Action Buttons -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <button onclick="window.stagePMCCTrade()" style="padding: 12px; background: linear-gradient(135deg, #00ff88 0%, #00cc66 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            📥 Stage New Short Call
                        </button>
                        <button onclick="window.showPMCCRollOptions()" style="padding: 12px; background: linear-gradient(135deg, #ffaa00 0%, #ff8800 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            🔄 Roll Short Call
                        </button>
                    </div>
                    
                    <!-- Roll Options Panel (hidden by default) -->
                    <div id="pmccRollPanel" style="display: none; margin-top: 16px; padding: 16px; background: linear-gradient(135deg, rgba(255,170,0,0.15), rgba(255,136,0,0.1)); border-radius: 8px; border: 1px solid rgba(255,170,0,0.3);">
                        <div style="color: #ffaa00; font-weight: bold; margin-bottom: 12px; font-size: 14px;">🔄 Roll to New Strike/Expiry</div>
                        <div style="color: #888; font-size: 11px; margin-bottom: 12px;">
                            Buy back current short call, sell new one at higher strike or later date
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                            <div>
                                <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">New Expiry</label>
                                <select id="pmccRollExpiry" onchange="window.onPMCCRollExpiryChange()" style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ffaa00; color: #fff; border-radius: 4px; font-size: 12px; cursor: pointer;">
                                    <option value="">Select expiry...</option>
                                </select>
                            </div>
                            <div>
                                <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">New Strike</label>
                                <select id="pmccRollStrike" onchange="window.onPMCCRollStrikeChange()" style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ffaa00; color: #fff; border-radius: 4px; font-size: 12px; cursor: pointer;">
                                    <option value="">Select strike...</option>
                                </select>
                            </div>
                        </div>
                        <div id="pmccRollSummary" style="display: none; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 12px;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; font-size: 12px; text-align: center;">
                                <div>
                                    <div style="color: #ff5252; font-size: 11px;">Buy Back</div>
                                    <div id="pmccRollBuyBack" style="color: #ff5252; font-weight: bold;">-</div>
                                </div>
                                <div>
                                    <div style="color: #00ff88; font-size: 11px;">New Premium</div>
                                    <div id="pmccRollNewPremium" style="color: #00ff88; font-weight: bold;">-</div>
                                </div>
                                <div>
                                    <div style="color: #00d9ff; font-size: 11px;">Net Credit/Debit</div>
                                    <div id="pmccRollNet" style="font-weight: bold;">-</div>
                                </div>
                            </div>
                        </div>
                        <button onclick="window.stagePMCCRoll()" style="width: 100%; padding: 10px; background: linear-gradient(135deg, #ffaa00 0%, #ff8800 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            📥 Stage Roll to Ideas Tab
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Load selected LEAPS position into PMCC calculator
 */
window.loadPMCCPosition = async function(positionId) {
    if (!positionId) {
        document.getElementById('pmccLeapsSection').style.display = 'none';
        return;
    }
    
    if (positionId === 'manual') {
        // TODO: Show manual entry form
        showNotification('Manual entry coming soon - select an existing position for now', 'info');
        document.getElementById('pmccPositionSelect').value = '';
        return;
    }
    
    const position = state.positions.find(p => p.id == positionId);
    if (!position) {
        showNotification('Position not found', 'error');
        return;
    }
    
    // Show LEAPS section
    document.getElementById('pmccLeapsSection').style.display = 'block';
    
    // Populate LEAPS details
    document.getElementById('pmccTicker').textContent = position.ticker;
    document.getElementById('pmccStrike').textContent = `$${position.strike}`;
    document.getElementById('pmccExpiry').textContent = position.expiry;
    
    const leapsCost = (position.premium || 0) * 100;
    const leapsPremiumPerShare = position.premium || 0;
    const breakevenStrike = position.strike + leapsPremiumPerShare;
    
    document.getElementById('pmccCost').textContent = `$${leapsCost.toFixed(0)}`;
    document.getElementById('pmccBreakevenStrike').textContent = `$${breakevenStrike.toFixed(2)}`;
    
    // Fetch current spot price - try Schwab first, then Yahoo as fallback
    let spotPrice = 0;
    try {
        // Try Schwab first (real-time)
        const schwabData = await fetch(`/api/schwab/quote/${position.ticker}`).then(r => r.json());
        spotPrice = schwabData[position.ticker]?.quote?.lastPrice || 0;
        
        if (!spotPrice) {
            // Fallback to Yahoo (15-min delayed)
            const yahooData = await fetch(`/api/yahoo/${position.ticker}`).then(r => r.json());
            spotPrice = yahooData.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
        }
    } catch (err) {
        console.warn('Could not fetch spot price:', err);
    }
    
    document.getElementById('pmccSpot').textContent = spotPrice ? `$${spotPrice.toFixed(2)}` : 'N/A';
    
    // Calculate intrinsic and time value
    const intrinsic = Math.max(0, (spotPrice - position.strike) * 100);
    document.getElementById('pmccIntrinsic').textContent = `$${intrinsic.toFixed(0)}`;
    
    // Fetch current option price from chain
    try {
        const chain = await window.fetchOptionsChain(position.ticker);
        if (chain && chain.calls) {
            const leapsOption = chain.calls.find(c => 
                Math.abs(c.strike - position.strike) < 0.01 && 
                c.expiration === position.expiry
            );
            
            if (leapsOption) {
                const currentValue = ((leapsOption.bid + leapsOption.ask) / 2) * 100;
                const timeValue = currentValue - intrinsic;
                const unrealizedPnL = currentValue - leapsCost;
                
                document.getElementById('pmccCurrentValue').textContent = `$${currentValue.toFixed(0)}`;
                document.getElementById('pmccTimeValue').textContent = `$${timeValue.toFixed(0)}`;
                
                const pnlEl = document.getElementById('pmccUnrealizedPnL');
                pnlEl.textContent = `$${unrealizedPnL.toFixed(0)}`;
                pnlEl.style.color = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
                
                // Store for calculations
                window.pmccData = {
                    position,
                    spotPrice,
                    leapsCost,
                    currentValue,
                    intrinsic,
                    timeValue,
                    breakevenStrike
                };
            }
        }
    } catch (err) {
        console.warn('Could not fetch current LEAPS value:', err);
    }
};

/**
 * Load options chain for PMCC calculator (uses same fetchOptionsChain as spread modal)
 */
window.loadPMCCChain = async function() {
    if (!window.pmccData) {
        showNotification('Select a LEAPS position first', 'warning');
        return;
    }
    
    const { position } = window.pmccData;
    const statusEl = document.getElementById('pmccChainLoadingStatus');
    
    statusEl.textContent = '⏳ Fetching options chain...';
    statusEl.style.color = '#00d9ff';
    
    try {
        // Use the same proven chain fetch as spread modal
        const chain = await window.fetchOptionsChain(position.ticker);
        
        if (!chain || !chain.calls || chain.calls.length === 0) {
            throw new Error('No call options data available');
        }
        
        const calls = chain.calls;
        window.pmccChainData = calls;
        
        // Get unique expiries (only future dates, sorted)
        const today = new Date();
        const expiries = [...new Set(calls.map(c => c.expiration))]
            .filter(exp => new Date(exp) > today)
            .sort((a, b) => new Date(a) - new Date(b))
            .slice(0, 12);  // Next 12 expiries
        
        if (expiries.length === 0) {
            throw new Error('No future expirations found');
        }
        
        // Populate expiry dropdown
        const expirySelect = document.getElementById('pmccShortExpiry');
        expirySelect.innerHTML = '<option value="">Select expiry...</option>' + 
            expiries.map(exp => {
                const date = new Date(exp);
                const dte = Math.round((date - today) / (1000 * 60 * 60 * 24));
                return `<option value="${exp}">${exp} (${dte}d)</option>`;
            }).join('');
        
        statusEl.textContent = `✅ Loaded ${calls.length} strikes across ${expiries.length} expiries`;
        statusEl.style.color = '#00ff88';
        
        console.log('[PMCC] Chain loaded:', calls.length, 'calls,', expiries.length, 'expiries');
    } catch (err) {
        console.error('[PMCC] Chain load failed:', err);
        statusEl.textContent = `⚠️ Failed to load chain: ${err.message}`;
        statusEl.style.color = '#ffaa00';
        showNotification('Failed to load options chain - try again', 'error');
    }
};

/**
 * When expiry changes, populate strikes for that expiry
 */
window.onPMCCExpiryChange = function() {
    const expiry = document.getElementById('pmccShortExpiry').value;
    if (!expiry || !window.pmccChainData) return;
    
    const strikeSelect = document.getElementById('pmccShortStrike');
    const { spotPrice, breakevenStrike } = window.pmccData;
    
    // Filter to selected expiry and get strikes above spot (OTM calls)
    const callsAtExpiry = window.pmccChainData
        .filter(c => c.expiration === expiry && c.strike >= spotPrice)
        .sort((a, b) => a.strike - b.strike);
    
    if (callsAtExpiry.length === 0) {
        strikeSelect.innerHTML = '<option value="">No OTM strikes available</option>';
        return;
    }
    
    // Build options with bid/ask - color code based on breakeven
    strikeSelect.innerHTML = '<option value="">Select strike...</option>' + 
        callsAtExpiry.map(c => {
            const mid = ((c.bid + c.ask) / 2).toFixed(2);
            const delta = c.delta ? ` Δ${(c.delta * 100).toFixed(0)}` : '';
            const isSafe = c.strike >= breakevenStrike;
            const prefix = isSafe ? '✅' : '⚠️';
            return `<option value="${c.strike}" data-premium="${mid}" ${!isSafe ? 'style="color: #ffaa00;"' : ''}>${prefix} $${c.strike} (bid $${c.bid} / ${mid}${delta})</option>`;
        }).join('');
    
    console.log('[PMCC] Populated', callsAtExpiry.length, 'strikes for', expiry);
};

/**
 * When strike changes, auto-fill premium
 */
window.onPMCCStrikeChange = function() {
    const strikeSelect = document.getElementById('pmccShortStrike');
    const selectedOption = strikeSelect.options[strikeSelect.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) return;
    
    const premium = selectedOption.getAttribute('data-premium');
    if (premium) {
        document.getElementById('pmccShortPremium').value = premium;
    }
    
    // Calculate DTE from selected expiry
    const expiry = document.getElementById('pmccShortExpiry').value;
    if (expiry) {
        const dte = Math.round((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24));
        // Store DTE for calculations (we removed the input field)
        window.pmccData.shortDTE = dte;
    }
    
    // Trigger calculation
    window.calculatePMCC();
};

/**
 * Calculate PMCC scenarios based on short call inputs
 */
window.calculatePMCC = function() {
    if (!window.pmccData) return;
    
    const shortStrike = parseFloat(document.getElementById('pmccShortStrike').value) || 0;
    const shortExpiry = document.getElementById('pmccShortExpiry').value;
    const shortPremium = parseFloat(document.getElementById('pmccShortPremium').value) || 0;
    
    if (!shortStrike || !shortPremium || !shortExpiry) {
        document.getElementById('pmccResults').style.display = 'none';
        return;
    }
    
    // Calculate DTE
    const shortDTE = Math.round((new Date(shortExpiry) - new Date()) / (1000 * 60 * 60 * 24));
    
    const { position, spotPrice, leapsCost, currentValue, intrinsic, timeValue } = window.pmccData;
    const leapsStrike = position.strike;
    
    // Premium you keep if stock stays below strike
    const premiumCollected = shortPremium * 100;
    document.getElementById('pmccKeepPremium').textContent = `$${premiumCollected.toFixed(0)}`;
    
    // Monthly yield calculation
    const monthlyYield = (premiumCollected / leapsCost * 100).toFixed(1);
    const daysToMonthly = shortDTE / 30;
    const annualizedYield = (monthlyYield / daysToMonthly * 12).toFixed(1);
    
    document.getElementById('pmccMonthlyYield').textContent = `${monthlyYield}%`;
    document.getElementById('pmccAnnualizedYield').textContent = `Annualized: ${annualizedYield}%`;
    
    // If assigned scenario (stock at short strike)
    // Populate the display fields
    document.getElementById('pmccExerciseStrike').textContent = leapsStrike;
    document.getElementById('pmccShortStrikeDisplay').textContent = shortStrike;
    document.getElementById('pmccTimeValueDisplay').textContent = timeValue.toFixed(0);
    
    // Option 1: Exercise LEAPS
    const exerciseProceeds = (shortStrike - leapsStrike) * 100;  // Buy at leapsStrike, sell at shortStrike
    const exerciseProfit = exerciseProceeds - leapsCost + premiumCollected;
    
    // Option 2: Close LEAPS at current value
    const closeProfit = currentValue - leapsCost + premiumCollected;
    
    const exerciseEl = document.getElementById('pmccExerciseProfit');
    exerciseEl.textContent = `$${exerciseProfit.toFixed(0)}`;
    exerciseEl.style.color = exerciseProfit >= 0 ? '#00ff88' : '#ff5252';
    
    const closeEl = document.getElementById('pmccCloseProfit');
    closeEl.textContent = `$${closeProfit.toFixed(0)}`;
    closeEl.style.color = closeProfit >= 0 ? '#00ff88' : '#ff5252';
    
    // Recommendation
    const recEl = document.getElementById('pmccRecommendation');
    if (exerciseProfit > closeProfit) {
        recEl.textContent = `✅ Exercise LEAPS for $${(exerciseProfit - closeProfit).toFixed(0)} more profit`;
    } else {
        recEl.textContent = `✅ Close LEAPS for $${(closeProfit - exerciseProfit).toFixed(0)} more profit (preserve time value: $${timeValue.toFixed(0)})`;
    }
    
    // Breakeven and max profit
    const breakeven = leapsCost / 100;  // Per share breakeven
    document.getElementById('pmccBreakeven').textContent = `$${breakeven.toFixed(2)}`;
    
    const maxProfit = Math.max(exerciseProfit, closeProfit);
    document.getElementById('pmccMaxProfit').textContent = `$${maxProfit.toFixed(0)}`;
    document.getElementById('pmccMaxProfitStrike').textContent = `$${shortStrike.toFixed(0)}`;
    
    // Show results
    document.getElementById('pmccResults').style.display = 'block';
};

/**
 * Stage the short call to Ideas tab for execution
 */
window.stagePMCCTrade = function() {
    if (!window.pmccData) return;
    
    const { position } = window.pmccData;
    const shortStrike = parseFloat(document.getElementById('pmccShortStrike').value);
    const expiry = document.getElementById('pmccShortExpiry').value;
    const shortPremium = parseFloat(document.getElementById('pmccShortPremium').value);
    
    if (!shortStrike || !shortPremium || !expiry) {
        showNotification('Select strike, expiry, and premium first', 'warning');
        return;
    }
    
    // Stage to pending - use correct field names for TradeCardService
    const trade = {
        newStrike: shortStrike,  // TradeCardService expects newStrike
        newExpiry: expiry,       // TradeCardService expects newExpiry  
        newType: 'CALL',         // Short call
        rationale: `PMCC: Short call against ${position.ticker} $${position.strike || position.leapsStrike} LEAPS. Yield: ${document.getElementById('pmccMonthlyYield')?.textContent || '?'}/month`
    };
    
    window.TradeCardService?.stageToPending(trade, {
        ticker: position.ticker,
        source: 'pmcc_calculator',
        badge: 'PMCC',
        parentPositionId: position.id  // Link to parent LEAPS for nesting
    });
    
    showNotification(`PMCC short call staged to Ideas tab`, 'success');
    document.getElementById('pmccModal')?.remove();
    
    // Switch to Ideas tab
    const ideasTab = document.querySelector('[data-tab="ideas"]');
    if (ideasTab) ideasTab.click();
};

/**
 * Show the roll options panel
 */
window.showPMCCRollOptions = function() {
    const panel = document.getElementById('pmccRollPanel');
    if (!panel) return;
    
    // Toggle visibility
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        
        // Populate expiry dropdown from cached chain data
        if (window.pmccChainData) {
            const today = new Date();
            const currentExpiry = document.getElementById('pmccShortExpiry').value;
            
            const expiries = [...new Set(window.pmccChainData.map(c => c.expiration))]
                .filter(exp => new Date(exp) > today)
                .sort((a, b) => new Date(a) - new Date(b))
                .slice(0, 12);
            
            const expirySelect = document.getElementById('pmccRollExpiry');
            expirySelect.innerHTML = '<option value="">Select expiry...</option>' + 
                expiries.map(exp => {
                    const date = new Date(exp);
                    const dte = Math.round((date - today) / (1000 * 60 * 60 * 24));
                    const isLater = exp > currentExpiry;
                    const prefix = isLater ? '📅' : '⚡';
                    return `<option value="${exp}">${prefix} ${exp} (${dte}d)</option>`;
                }).join('');
        }
    } else {
        panel.style.display = 'none';
    }
};

/**
 * When roll expiry changes, populate strikes
 */
window.onPMCCRollExpiryChange = function() {
    const expiry = document.getElementById('pmccRollExpiry').value;
    if (!expiry || !window.pmccChainData || !window.pmccData) return;
    
    const { spotPrice, breakevenStrike } = window.pmccData;
    const currentStrike = parseFloat(document.getElementById('pmccShortStrike').value) || 0;
    
    const callsAtExpiry = window.pmccChainData
        .filter(c => c.expiration === expiry && c.strike >= spotPrice)
        .sort((a, b) => a.strike - b.strike);
    
    const strikeSelect = document.getElementById('pmccRollStrike');
    strikeSelect.innerHTML = '<option value="">Select strike...</option>' + 
        callsAtExpiry.map(c => {
            const mid = ((c.bid + c.ask) / 2).toFixed(2);
            const isSafe = c.strike >= breakevenStrike;
            const isHigher = c.strike > currentStrike;
            const prefix = isSafe ? (isHigher ? '⬆️' : '✅') : '⚠️';
            return `<option value="${c.strike}" data-premium="${mid}">${prefix} $${c.strike} ($${mid})</option>`;
        }).join('');
    
    document.getElementById('pmccRollSummary').style.display = 'none';
};

/**
 * When roll strike changes, calculate net credit/debit
 */
window.onPMCCRollStrikeChange = function() {
    const strikeSelect = document.getElementById('pmccRollStrike');
    const selectedOption = strikeSelect.options[strikeSelect.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) {
        document.getElementById('pmccRollSummary').style.display = 'none';
        return;
    }
    
    const newPremium = parseFloat(selectedOption.getAttribute('data-premium')) || 0;
    const currentPremium = parseFloat(document.getElementById('pmccShortPremium').value) || 0;
    
    // Estimate buyback cost (current premium + a bit for spread)
    // In reality, need current market price of short call
    const buyBackCost = currentPremium * 1.1;  // Rough estimate - should fetch live price
    
    const netCreditDebit = newPremium - buyBackCost;
    
    document.getElementById('pmccRollBuyBack').textContent = `-$${(buyBackCost * 100).toFixed(0)}`;
    document.getElementById('pmccRollNewPremium').textContent = `+$${(newPremium * 100).toFixed(0)}`;
    
    const netEl = document.getElementById('pmccRollNet');
    const netAmount = netCreditDebit * 100;
    netEl.textContent = netAmount >= 0 ? `+$${netAmount.toFixed(0)} credit` : `-$${Math.abs(netAmount).toFixed(0)} debit`;
    netEl.style.color = netAmount >= 0 ? '#00ff88' : '#ff5252';
    
    document.getElementById('pmccRollSummary').style.display = 'block';
    
    // Store for staging
    window.pmccRollData = {
        newExpiry: document.getElementById('pmccRollExpiry').value,
        newStrike: parseFloat(selectedOption.value),
        newPremium,
        buyBackCost,
        netCreditDebit
    };
};

/**
 * Stage the roll to Ideas tab
 */
window.stagePMCCRoll = function() {
    if (!window.pmccData || !window.pmccRollData) {
        showNotification('Select new strike and expiry first', 'warning');
        return;
    }
    
    const { position } = window.pmccData;
    const currentStrike = parseFloat(document.getElementById('pmccShortStrike').value);
    const currentExpiry = document.getElementById('pmccShortExpiry').value;
    const { newExpiry, newStrike, newPremium, netCreditDebit } = window.pmccRollData;
    
    const netText = netCreditDebit >= 0 ? `$${(netCreditDebit * 100).toFixed(0)} credit` : `$${Math.abs(netCreditDebit * 100).toFixed(0)} debit`;
    
    const trade = {
        ticker: position.ticker,
        action: 'ROLL',
        type: 'short_call',
        closeStrike: currentStrike,
        closeExpiry: currentExpiry,
        newStrike,
        newExpiry,
        premium: newPremium,
        contracts: 1,
        source: 'pmcc_calculator',
        badge: 'ROLL',
        rationale: `PMCC Roll: $${currentStrike} → $${newStrike}, ${currentExpiry} → ${newExpiry}. Net: ${netText}`
    };
    
    window.TradeCardService?.stageToPending(trade, {
        ticker: position.ticker,
        source: 'pmcc_calculator',
        badge: 'ROLL'
    });
    
    showNotification(`PMCC roll staged to Ideas tab`, 'success');
    document.getElementById('pmccModal').remove();
    
    const ideasTab = document.querySelector('[data-tab="ideas"]');
    if (ideasTab) ideasTab.click();
};

// Export for potential external use
export { setupTabs, setupButtons };
