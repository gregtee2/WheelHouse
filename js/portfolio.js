// WheelHouse - Portfolio P&L Tracker
// Tracks actual P&L across all positions

import { state, getClosedKey } from 'state';
import { showNotification, isDebitPosition, calculateRealizedPnL, colors, createModal, modalHeader, calculatePortfolioGreeks } from 'utils';
import { fetchStockPrice, fetchStockPricesBatch, fetchOptionsChain, findOption } from 'api';
import { saveHoldingsToStorage, renderPositions } from 'positions';
import AccountService from 'AccountService';
import StreamingService from 'StreamingService';
import { formatPnLPercent, formatPnLDollar, getPnLColor } from 'formatters';

// Dynamic storage key based on account mode
function getClosedStorageKey() { return getClosedKey(); }

// Dynamic checkpoint key based on account mode
function getCheckpointKey() {
    const mode = state.accountMode || 'real';
    return mode === 'paper' ? 'wheelhouse_data_checkpoint_paper' : 'wheelhouse_data_checkpoint';
}

const AI_LOG_KEY = 'wheelhouse_ai_predictions';

// Set to true for verbose price refresh logging
const VERBOSE_PRICE_LOGS = false;

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
 * Calculate Capital at Risk from open positions
 * Same logic as positions.js buildLeverageGauge
 */
function calculateCapitalAtRisk() {
    const positions = state.positions || [];
    const openPositions = positions.filter(p => p.status === 'open');
    
    return openPositions.reduce((sum, p) => {
        const isSpread = p.type?.includes('_spread');
        const isDebit = isDebitPosition(p.type);
        
        if (isSpread) {
            if (p.maxLoss) return sum + p.maxLoss;
            const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
            const premium = p.premium || 0;
            const maxLoss = isDebit 
                ? premium * 100 * p.contracts
                : (width - premium) * 100 * p.contracts;
            return sum + maxLoss;
        } else if (isDebit) {
            return sum + ((p.premium || 0) * 100 * p.contracts);
        } else if (p.type === 'short_put' || p.type === 'buy_write') {
            return sum + ((p.strike || 0) * 100 * p.contracts);
        }
        return sum;
    }, 0);
}

/**
 * Update Capital at Risk display in balances banner
 */
function updateCapitalAtRiskDisplay() {
    const carEl = document.getElementById('balCapitalAtRisk');
    if (carEl) {
        const capitalAtRisk = calculateCapitalAtRisk();
        const formatted = '$' + capitalAtRisk.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        carEl.textContent = formatted;
    }
}

/**
 * Fetch and display Schwab account balances
 * Now respects state.selectedAccount from the header account switcher
 */
export async function fetchAccountBalances() {
    const banner = document.getElementById('accountBalancesBanner');
    if (!banner) return;
    
    try {
        // Check if we have a selected account from the header dropdown
        const selectedAcct = state.selectedAccount;
        
        // Handle Paper Trading mode - don't fetch real balances
        // Check BOTH selectedAccount.hashValue === 'paper' AND state.accountMode === 'paper'
        // because setSelectedAccount(null) is called when switching to paper mode
        if (state.accountMode === 'paper' || (selectedAcct && selectedAcct.hashValue === 'paper')) {
            console.log('[BALANCES] Paper Trading mode - skipping Schwab fetch');
            // Still update Capital at Risk display (works with local positions)
            updateCapitalAtRiskDisplay();
            // Paper trading balances are managed by updatePaperAccountBalances() in main.js
            return;
        }
        
        // If user selected a specific account, fetch ONLY that account's balances
        if (selectedAcct && selectedAcct.hashValue) {
            console.log('[BALANCES] Using selected account from header:', selectedAcct.accountNumber?.slice(-4));
            
            const res = await fetch(`/api/schwab/accounts/${selectedAcct.hashValue}`);
            if (!res.ok) {
                console.log('[BALANCES] Failed to fetch selected account');
                return;
            }
            
            const data = await res.json();
            const bal = data.securitiesAccount?.currentBalances || {};
            
            // Update display
            const fmt = (v) => {
                if (v === undefined || v === null) return '—';
                return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            };
            
            document.getElementById('balCashAvailable').textContent = fmt(bal.availableFunds ?? bal.cashBalance);
            document.getElementById('balBuyingPower').textContent = fmt(bal.buyingPower);
            document.getElementById('balAccountValue').textContent = fmt(bal.liquidationValue ?? bal.equity);
            document.getElementById('balMarginUsed').textContent = fmt(bal.marginBalance || 0);
            document.getElementById('balDayTradeBP').textContent = fmt(bal.dayTradingBuyingPower);
            updateCapitalAtRiskDisplay();
            
            // Update AccountService cache
            AccountService.updateCache({
                buyingPower: bal.buyingPower,
                accountValue: bal.liquidationValue || bal.equity,
                cashAvailable: bal.availableFunds || bal.cashBalance,
                marginUsed: bal.marginBalance,
                dayTradeBP: bal.dayTradingBuyingPower,
                accountType: selectedAcct.type,
                accountNumber: selectedAcct.accountNumber
            });
            
            // Show banner
            banner.style.display = 'block';
            return;
        }
        
        // Fallback: No specific account selected, use old logic
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
            // Try MARGIN type first - but pick the one with highest equity if multiple
            const marginAccounts = accounts.filter(a => a.securitiesAccount?.type === 'MARGIN');
            if (marginAccounts.length > 0) {
                // Sort by equity descending and pick the largest
                account = marginAccounts.sort((a, b) => {
                    const eqA = a.securitiesAccount?.currentBalances?.equity || a.securitiesAccount?.currentBalances?.liquidationValue || 0;
                    const eqB = b.securitiesAccount?.currentBalances?.equity || b.securitiesAccount?.currentBalances?.liquidationValue || 0;
                    return eqB - eqA;
                })[0];
                console.log('[BALANCES] Found MARGIN account with highest equity:', account.securitiesAccount?.accountNumber?.slice(-4));
            }
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
        
        // Update display - use correct Schwab field names (liquidationValue = Net Liquidating Value)
        document.getElementById('balCashAvailable').textContent = fmt(bal.availableFunds ?? bal.cashBalance);
        document.getElementById('balBuyingPower').textContent = fmt(bal.buyingPower);
        document.getElementById('balAccountValue').textContent = fmt(bal.liquidationValue ?? bal.equity);
        document.getElementById('balMarginUsed').textContent = fmt(bal.marginBalance || 0);
        document.getElementById('balDayTradeBP').textContent = fmt(bal.dayTradingBuyingPower);
        updateCapitalAtRiskDisplay();
        
        // Timestamp with account info
        const now = new Date();
        const lastDigits = accountNumber ? `...${accountNumber.slice(-4)}` : '';
        document.getElementById('balanceLastUpdated').innerHTML = `
            <span style="color:#00d9ff;">${accountType}</span> ${lastDigits} · Updated ${now.toLocaleTimeString()}
            ${accounts.length > 1 ? `<button onclick="window.showAccountSwitcher()" style="margin-left:8px; background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.4); color:#00d9ff; padding:2px 6px; border-radius:4px; cursor:pointer; font-size:10px;">Switch</button>` : ''}
        `;
        
        // Store accounts for switcher
        window._schwabAccounts = accounts;
        
        // Update AccountService cache (single source of truth)
        AccountService.updateCache({
            buyingPower: bal.buyingPower,
            accountValue: bal.liquidationValue || bal.equity,
            cashAvailable: bal.availableFunds || bal.cashBalance,
            marginUsed: bal.marginBalance,
            dayTradeBP: bal.dayTradingBuyingPower,
            accountType: accountType,
            accountNumber: accountNumber
        });
        
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
        const equity = bal.liquidationValue || bal.equity || 0;
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
 * Now integrates with the main account switching system
 */
window.selectAccount = function(accountNumber) {
    // Close the modal
    document.getElementById('accountSwitcher')?.remove();
    
    // Use the main account switcher
    const select = document.getElementById('accountModeSelect');
    if (select) {
        select.value = accountNumber;
        window.handleAccountChange?.(accountNumber);
    } else {
        // Fallback to old behavior if main switcher not available
        localStorage.setItem(PREFERRED_ACCOUNT_KEY, accountNumber);
        fetchAccountBalances();
        showNotification(`Switched to account ...${accountNumber.slice(-4)}`, 'success');
    }
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
    localStorage.setItem(getCheckpointKey(), JSON.stringify(checkpoint));
}

/**
 * Load closed positions from storage
 */
export function loadClosedPositions() {
    try {
        const saved = localStorage.getItem(getClosedStorageKey());
        state.closedPositions = saved ? JSON.parse(saved) : [];
    } catch (e) {
        state.closedPositions = [];
    }
}

/**
 * Save closed positions to storage
 */
function saveClosedPositions() {
    localStorage.setItem(getClosedStorageKey(), JSON.stringify(state.closedPositions || []));
    saveDataCheckpoint(); // Track data count for integrity check
    triggerAutoSave();
}

/**
 * Analyze historical patterns to provide context for a new trade
 * Returns insights about past performance with similar trades
 * @param {string} ticker - Stock ticker symbol
 * @param {string} type - Strategy type (short_put, covered_call, etc.)
 * @param {number} strike - Strike price
 * @param {number} spot - Current stock price
 * @param {number} dte - Days to expiration
 * @returns {object} Pattern analysis with warnings and encouragements
 */
export function analyzeHistoricalPattern(ticker, type, strike, spot, dte) {
    const closed = state.closedPositions || [];
    if (closed.length === 0) {
        return { hasHistory: false, message: 'No historical trades to analyze.' };
    }
    
    // Normalize type for comparison
    const normalizedType = type?.toLowerCase().replace(/\s+/g, '_') || '';
    
    // 1. Find all trades with this exact ticker + type combo
    const sameTickerType = closed.filter(p => 
        p.ticker?.toUpperCase() === ticker?.toUpperCase() && 
        p.type?.toLowerCase().replace(/\s+/g, '_') === normalizedType
    );
    
    // 2. Find all trades with just this ticker (any strategy)
    const sameTicker = closed.filter(p => 
        p.ticker?.toUpperCase() === ticker?.toUpperCase()
    );
    
    // 3. Find all trades with same strategy type (any ticker)
    const sameType = closed.filter(p => 
        p.type?.toLowerCase().replace(/\s+/g, '_') === normalizedType
    );
    
    // Calculate stats for each group
    const calcStats = (trades) => {
        if (trades.length === 0) return null;
        const totalPnL = trades.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
        const winners = trades.filter(p => (p.realizedPnL ?? p.closePnL ?? 0) >= 0);
        const losers = trades.filter(p => (p.realizedPnL ?? p.closePnL ?? 0) < 0);
        const avgPnL = totalPnL / trades.length;
        const winRate = (winners.length / trades.length * 100);
        
        // Find biggest win and loss
        const sorted = [...trades].sort((a, b) => (b.realizedPnL ?? b.closePnL ?? 0) - (a.realizedPnL ?? a.closePnL ?? 0));
        const biggestWin = sorted[0];
        const biggestLoss = sorted[sorted.length - 1];
        
        return {
            count: trades.length,
            totalPnL,
            avgPnL,
            winRate,
            winnersCount: winners.length,
            losersCount: losers.length,
            biggestWin: biggestWin ? (biggestWin.realizedPnL ?? biggestWin.closePnL ?? 0) : 0,
            biggestLoss: biggestLoss ? (biggestLoss.realizedPnL ?? biggestLoss.closePnL ?? 0) : 0
        };
    };
    
    const tickerTypeStats = calcStats(sameTickerType);
    const tickerStats = calcStats(sameTicker);
    const typeStats = calcStats(sameType);
    
    // Calculate OTM % for pattern matching
    const otmPercent = spot > 0 ? ((spot - strike) / spot * 100) : 0;
    const isOTM = type?.includes('put') ? strike < spot : strike > spot;
    
    // Build analysis result
    const result = {
        hasHistory: true,
        ticker,
        type,
        strike,
        spot,
        dte,
        otmPercent: Math.abs(otmPercent).toFixed(1),
        isOTM,
        
        // Stats by category
        tickerTypeStats,  // Same ticker + same strategy
        tickerStats,      // Same ticker, any strategy  
        typeStats,        // Same strategy, any ticker
        
        // Warnings and encouragements
        warnings: [],
        encouragements: [],
        summary: ''
    };
    
    // Generate warnings based on patterns
    if (tickerTypeStats && tickerTypeStats.count >= 2) {
        // We have history with this exact combo
        if (tickerTypeStats.winRate < 40) {
            result.warnings.push(`⚠️ LOW WIN RATE: You have a ${tickerTypeStats.winRate.toFixed(0)}% win rate on ${ticker} ${type.replace('_',' ')} (${tickerTypeStats.count} trades, avg $${tickerTypeStats.avgPnL.toFixed(0)})`);
        }
        if (tickerTypeStats.totalPnL < -500) {
            result.warnings.push(`🚨 LOSING PATTERN: You've lost $${Math.abs(tickerTypeStats.totalPnL).toFixed(0)} total on ${ticker} ${type.replace('_',' ')} positions`);
        }
        if (tickerTypeStats.biggestLoss < -500) {
            result.warnings.push(`⚠️ BIG LOSS HISTORY: Your biggest loss on ${ticker} ${type.replace('_',' ')} was $${tickerTypeStats.biggestLoss.toFixed(0)}`);
        }
        
        // Encouragements
        if (tickerTypeStats.winRate >= 75) {
            result.encouragements.push(`✅ STRONG PATTERN: ${tickerTypeStats.winRate.toFixed(0)}% win rate on ${ticker} ${type.replace('_',' ')} (${tickerTypeStats.count} trades)`);
        }
        if (tickerTypeStats.avgPnL > 100) {
            result.encouragements.push(`💰 PROFITABLE: Average $${tickerTypeStats.avgPnL.toFixed(0)} profit on ${ticker} ${type.replace('_',' ')}`);
        }
    }
    
    // Check ticker-level patterns (any strategy)
    if (tickerStats && tickerStats.count >= 3 && !tickerTypeStats) {
        if (tickerStats.winRate < 40) {
            result.warnings.push(`⚠️ ${ticker} HAS BEEN DIFFICULT: ${tickerStats.winRate.toFixed(0)}% win rate across ${tickerStats.count} trades`);
        }
        if (tickerStats.winRate >= 70) {
            result.encouragements.push(`✅ ${ticker} WORKS FOR YOU: ${tickerStats.winRate.toFixed(0)}% win rate across ${tickerStats.count} trades`);
        }
    }
    
    // Check strategy-level patterns
    if (typeStats && typeStats.count >= 5) {
        if (typeStats.winRate < 50 && type?.includes('long')) {
            result.warnings.push(`⚠️ ${type.replace('_',' ')} UNDERPERFORMING: Only ${typeStats.winRate.toFixed(0)}% win rate on this strategy`);
        }
        if (typeStats.winRate >= 70) {
            result.encouragements.push(`✅ ${type.replace('_',' ')} IS YOUR STRENGTH: ${typeStats.winRate.toFixed(0)}% win rate (${typeStats.count} trades)`);
        }
    }
    
    // Build summary
    if (result.warnings.length > 0 && result.encouragements.length === 0) {
        result.summary = `⚠️ CAUTION: Historical patterns suggest this may be a risky trade for you.`;
    } else if (result.encouragements.length > 0 && result.warnings.length === 0) {
        result.summary = `✅ FAVORABLE: This trade matches patterns that have worked well for you.`;
    } else if (result.warnings.length > 0 && result.encouragements.length > 0) {
        result.summary = `⚖️ MIXED SIGNALS: Some patterns are favorable, others concerning.`;
    } else if (tickerTypeStats || tickerStats || typeStats) {
        result.summary = `📊 NEUTRAL: Limited historical pattern data, but some trade history exists.`;
    } else {
        result.summary = `🆕 NEW TERRITORY: No similar trades in your history.`;
    }
    
    return result;
}
window.analyzeHistoricalPattern = analyzeHistoricalPattern;

/**
 * Format pattern analysis for AI consumption
 * @param {object} pattern - Result from analyzeHistoricalPattern
 * @returns {string} Formatted string for AI prompt
 */
export function formatPatternForAI(pattern) {
    if (!pattern || !pattern.hasHistory) {
        return 'No historical trade data available for pattern matching.';
    }
    
    let text = `## HISTORICAL PATTERN ANALYSIS FOR THIS TRADER\n`;
    text += `Analyzing: ${pattern.ticker} ${pattern.type?.replace('_',' ')} at $${pattern.strike}\n\n`;
    
    if (pattern.tickerTypeStats) {
        const s = pattern.tickerTypeStats;
        text += `### Same Ticker + Same Strategy (${pattern.ticker} ${pattern.type?.replace('_',' ')})\n`;
        text += `- ${s.count} historical trades\n`;
        text += `- Win rate: ${s.winRate.toFixed(0)}%\n`;
        text += `- Total P&L: $${s.totalPnL.toFixed(0)}\n`;
        text += `- Average P&L: $${s.avgPnL.toFixed(0)}\n`;
        text += `- Biggest win: $${s.biggestWin.toFixed(0)}, Biggest loss: $${s.biggestLoss.toFixed(0)}\n\n`;
    }
    
    if (pattern.tickerStats) {
        const s = pattern.tickerStats;
        text += `### All ${pattern.ticker} Trades (any strategy)\n`;
        text += `- ${s.count} historical trades, ${s.winRate.toFixed(0)}% win rate, $${s.totalPnL.toFixed(0)} total P&L\n\n`;
    }
    
    if (pattern.typeStats) {
        const s = pattern.typeStats;
        text += `### All ${pattern.type?.replace('_',' ')} Trades (any ticker)\n`;
        text += `- ${s.count} historical trades, ${s.winRate.toFixed(0)}% win rate, $${s.avgPnL.toFixed(0)} avg P&L\n\n`;
    }
    
    if (pattern.warnings.length > 0) {
        text += `### ⚠️ WARNINGS FROM HISTORY\n`;
        pattern.warnings.forEach(w => text += `${w}\n`);
        text += '\n';
    }
    
    if (pattern.encouragements.length > 0) {
        text += `### ✅ POSITIVE PATTERNS\n`;
        pattern.encouragements.forEach(e => text += `${e}\n`);
        text += '\n';
    }
    
    text += `### SUMMARY: ${pattern.summary}\n`;
    
    return text;
}
window.formatPatternForAI = formatPatternForAI;

/**
 * Surgically update price-related cells for a position (no full table re-render)
 * This prevents flicker when prices update
 */
function updatePositionPriceCells(pos) {
    const row = document.querySelector(`tr[data-position-id="${pos.id}"]`);
    if (!row) return;
    
    // Update P/L Open cell
    const plOpenCell = row.querySelector('[data-col="pl-open"]');
    if (plOpenCell && pos.lastOptionPrice !== undefined) {
        const isDebit = isDebitPosition(pos.type);
        const entryValue = pos.premium * 100 * (pos.contracts || 1);
        const currentValue = pos.lastOptionPrice * 100 * (pos.contracts || 1);
        const unrealizedPnL = isDebit ? currentValue - entryValue : entryValue - currentValue;
        
        plOpenCell.textContent = formatPnLDollar(unrealizedPnL);
        plOpenCell.style.color = getPnLColor(unrealizedPnL, 0);
    }
    
    // Update P/L % cell
    const plPctCell = row.querySelector('[data-col="pl-pct"]');
    if (plPctCell && pos.lastOptionPrice !== undefined && pos.premium > 0) {
        const isDebit = isDebitPosition(pos.type);
        const pctChange = isDebit 
            ? ((pos.lastOptionPrice - pos.premium) / pos.premium) * 100
            : ((pos.premium - pos.lastOptionPrice) / pos.premium) * 100;
        
        plPctCell.textContent = formatPnLPercent(pctChange);
        plPctCell.style.color = getPnLColor(pctChange);
    }
    
    // Update P/L Day cell if we have day change data
    const plDayCell = row.querySelector('[data-col="pl-day"]');
    if (plDayCell && pos.dayChange !== undefined) {
        // For SHORT positions: option price going DOWN = profit, so NEGATE the change
        // For LONG positions: option price going UP = profit, so keep the change as-is
        const isLong = isDebitPosition(pos.type);
        const dayPnL = isLong 
            ? (pos.dayChange * 100 * (pos.contracts || 1))
            : (-pos.dayChange * 100 * (pos.contracts || 1));
        const color = dayPnL >= 0 ? '#00ff88' : '#ff5252';
        const sign = dayPnL >= 0 ? '+' : '';
        plDayCell.textContent = `${sign}$${Math.abs(dayPnL).toFixed(0)}`;
        plDayCell.style.color = color;
    }
    
    // Update Cr/Dr cell
    const crDrCell = row.querySelector('[data-col="cr-dr"]');
    if (crDrCell && pos.lastOptionPrice !== undefined) {
        const isDebit = isDebitPosition(pos.type);
        if (isDebit) {
            // Long position: show current value
            const currentValue = pos.lastOptionPrice * 100 * (pos.contracts || 1);
            crDrCell.textContent = `$${currentValue.toFixed(0)}`;
        }
        // Short positions keep original premium, no update needed
    }
}

/**
 * Refresh prices for ALL open positions from Schwab (or CBOE fallback)
 * Updates lastOptionPrice and markedPrice on each position
 */
async function refreshAllPositionPrices() {
    const positions = state.positions || [];
    if (positions.length === 0) {
        if (VERBOSE_PRICE_LOGS) console.log('[REFRESH] No positions to update');
        return;
    }
    
    if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] Updating prices for ${positions.length} positions...`);
    
    // Check if Schwab is connected for real-time data
    let hasSchwab = false;
    try {
        if (window.SchwabAPI) {
            const status = await window.SchwabAPI.getStatus();
            hasSchwab = status.hasRefreshToken;
            if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] Schwab status: ${hasSchwab ? 'Connected (real-time)' : 'Not connected (using CBOE delayed)'}`);
        }
    } catch (e) {
        if (VERBOSE_PRICE_LOGS) console.log('[REFRESH] Could not check Schwab status:', e.message);
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
                if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] No chain data for ${ticker}`);
                failed += tickerPos.length;
                continue;
            }
            
            if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] ${ticker}: Got ${chain.calls?.length || 0} calls, ${chain.puts?.length || 0} puts from ${hasSchwab ? 'Schwab' : 'CBOE'}`);
            
            // Update each position with this ticker
            for (const pos of tickerPos) {
                const isPut = pos.type?.toLowerCase().includes('put');
                const isCall = pos.type?.toLowerCase().includes('call');
                const isSpread = pos.type?.includes('_spread');
                const options = isPut ? chain.puts : (isCall ? chain.calls : null);
                
                if (!options) {
                    if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] ${ticker} ${pos.type}: Unknown option type`);
                    failed++;
                    continue;
                }
                
                const expiry = pos.expiry; // YYYY-MM-DD format
                
                // Helper function to find option by strike
                const findOption = (strike) => {
                    let matched = options.find(o => 
                        Math.abs(o.strike - strike) < 0.01 && 
                        o.expiration === expiry
                    );
                    // If no exact match, try different date formats
                    if (!matched) {
                        matched = options.find(o => {
                            if (Math.abs(o.strike - strike) > 0.01) return false;
                            const oExp = new Date(o.expiration).toISOString().split('T')[0];
                            const pExp = new Date(expiry).toISOString().split('T')[0];
                            return oExp === pExp;
                        });
                    }
                    return matched;
                };
                
                // SPREAD HANDLING: Need to get both legs and calculate net value
                if (isSpread && pos.sellStrike && pos.buyStrike) {
                    const sellOption = findOption(pos.sellStrike);
                    const buyOption = findOption(pos.buyStrike);
                    
                    if (sellOption && buyOption) {
                        const sellMid = sellOption.mid || ((sellOption.bid + sellOption.ask) / 2);
                        const buyMid = buyOption.mid || ((buyOption.bid + buyOption.ask) / 2);
                        
                        // For credit spread: net value = sell leg - buy leg
                        // This represents what you'd PAY to close the spread
                        const netSpreadValue = sellMid - buyMid;
                        
                        // Calculate daily change for spread (sell leg change - buy leg change)
                        const sellDayChange = sellOption.netChange || 0;
                        const buyDayChange = buyOption.netChange || 0;
                        const spreadDayChange = sellDayChange - buyDayChange;
                        
                        if (netSpreadValue >= 0) {
                            const oldPrice = pos.lastOptionPrice;
                            pos.lastOptionPrice = netSpreadValue;
                            pos.markedPrice = netSpreadValue;
                            pos.priceUpdatedAt = new Date().toISOString();
                            // Also store individual leg prices for reference
                            pos.sellLegPrice = sellMid;
                            pos.buyLegPrice = buyMid;
                            // Store daily change for P/L Day column
                            pos.dayChange = spreadDayChange;
                            updated++;
                            // Always log spread updates so we can verify they're happening
                            console.log(`[REFRESH] ${ticker} $${pos.sellStrike}/$${pos.buyStrike} spread: $${oldPrice?.toFixed(2) || '?'} → $${netSpreadValue.toFixed(2)} (sell: $${sellMid.toFixed(2)}, buy: $${buyMid.toFixed(2)}, day: ${spreadDayChange >= 0 ? '+' : ''}$${spreadDayChange.toFixed(2)})`);
                        }
                    } else {
                        console.log(`[REFRESH] ${ticker} spread: Could not find both legs (sell: ${!!sellOption}, buy: ${!!buyOption})`);
                        failed++;
                    }
                } else {
                    // SINGLE LEG: Original logic
                    const strike = pos.strike;
                    const matchedOption = findOption(strike);
                
                    if (matchedOption) {
                        // Use mid price (between bid and ask) for most accurate current value
                        const mid = matchedOption.mid || ((matchedOption.bid + matchedOption.ask) / 2);
                        const last = matchedOption.last || mid;
                        const price = mid > 0 ? mid : last;
                        // Store daily change for P/L Day column
                        const dayChange = matchedOption.netChange || 0;
                    
                        if (price > 0) {
                            const oldPrice = pos.lastOptionPrice;
                            pos.lastOptionPrice = price;
                            pos.markedPrice = price;
                            pos.priceUpdatedAt = new Date().toISOString();
                            pos.dayChange = dayChange;
                            updated++;
                            // Debug: always log CIFR to diagnose P/L Day issue
                            if (ticker === 'CIFR') {
                                console.log(`[DEBUG CIFR] $${strike} ${isPut ? 'put' : 'call'}: price=$${price.toFixed(2)}, netChange=${dayChange >= 0 ? '+' : ''}$${dayChange.toFixed(2)}/share, calculated P/L Day = ${pos.type?.includes('long') || pos.type?.includes('debit') ? '' : '-'}${dayChange}*100*${pos.contracts} = $${(pos.type?.includes('long') || pos.type?.includes('debit') ? dayChange : -dayChange) * 100 * pos.contracts}`);
                            }
                            if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] ${ticker} $${strike} ${isPut ? 'put' : 'call'}: $${oldPrice?.toFixed(2) || '?'} → $${price.toFixed(2)} (day: ${dayChange >= 0 ? '+' : ''}$${dayChange.toFixed(2)})`);
                        }
                    } else {
                        if (VERBOSE_PRICE_LOGS) console.log(`[REFRESH] ${ticker} $${strike} ${expiry}: No matching option found in chain`);
                        failed++;
                    }
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
        
        // Do SURGICAL updates to price cells instead of full re-render (prevents flicker)
        for (const pos of positions) {
            updatePositionPriceCells(pos);
        }
        
        // Also update the portfolio summary bar
        if (window.updatePortfolioSummary) {
            window.updatePortfolioSummary();
        }
    }
    
    console.log(`[REFRESH] ✅ Complete: ${updated} updated, ${failed} failed`);
    return { updated, failed };
}

// Export for use in other modules
window.refreshAllPositionPrices = refreshAllPositionPrices;

// ============================================================
// AUTO-REFRESH PRICES (30-second interval)
// ============================================================

let autoRefreshPricesInterval = null;
let streamingSkipCount = 0;  // Counter for REST catch-up cycles during streaming
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
    
    console.log('🔄 Auto-refresh started (every 30s)');
    
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
        
        // When streaming is connected, do a REST catch-up every 4th cycle (~2 min)
        // to ensure illiquid options with rare streaming updates stay fresh
        if (StreamingService.isConnected()) {
            streamingSkipCount++;
            if (streamingSkipCount % 4 !== 0) {
                // Just update the timestamp to show streaming is working
                updatePriceLastUpdated();
                return;
            }
            console.log('🔄 REST catch-up refresh (streaming connected, periodic sync)...');
        } else {
            console.log('🔄 Auto-refreshing prices (streaming not connected)...');
        }
        
        try {
            await refreshAllPositionPrices();
            updatePriceLastUpdated();
        } catch (err) {
            console.error('Auto-refresh failed:', err);
        }
    }, AUTO_REFRESH_INTERVAL);
    
    // Do an immediate refresh when starting ONLY if streaming not connected
    if (!StreamingService.isConnected()) {
        refreshAllPositionPrices().then(() => {
            updatePriceLastUpdated();
        });
    } else {
        console.log('⚡ Streaming connected - skipping initial price fetch');
        updatePriceLastUpdated();
    }
}

/**
 * Stop auto-refreshing prices
 */
function stopAutoRefreshPrices() {
    if (autoRefreshPricesInterval) {
        if (VERBOSE_PRICE_LOGS) console.log('⏹️ Stopping auto-refresh prices');
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
    
    // Load saved preference - DEFAULT TO ON if never set
    const saved = localStorage.getItem('wheelhouse_autoRefreshPrices');
    const shouldAutoRefresh = saved === null ? true : saved === 'true';  // Default ON
    
    if (shouldAutoRefresh) {
        checkbox.checked = true;
        startAutoRefreshPrices();
        console.log('✅ Auto-refresh prices enabled (every 30s)');
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
        
        if (VERBOSE_PRICE_LOGS) console.log(`[MATCH] ${position.ticker}: $${spot.toFixed(2)} from ${optionsChain?.currentPrice ? 'CBOE' : 'fallback'}`);
        
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
                if (VERBOSE_PRICE_LOGS) console.log(`[MATCH]   Bid: $${matchedOption.bid} | Ask: $${matchedOption.ask} | Mid: $${midPrice.toFixed(2)} | Last: $${lastPrice.toFixed(2)}`);
                if (VERBOSE_PRICE_LOGS) console.log(`[MATCH]   Using ${priceSource} price: $${usePrice.toFixed(2)}`);
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
        const r = state.rate || 0.05; // Use global rate
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
    
    // Net Premium: must account for buybacks from roll chains
    // This matches the Positions footer calculation
    const closedPositions = state.closedPositions || [];
    const openPositions = state.positions || [];
    
    // Track which chainIds we've already processed to avoid double-counting
    const processedChains = new Set();
    
    let netPremium = 0;
    let premiumCollected = 0;
    let premiumPaid = 0;
    
    positionData.forEach(p => {
        const chainId = p.chainId || p.id;
        
        // Skip if we've already processed this chain
        if (processedChains.has(chainId)) return;
        processedChains.add(chainId);
        
        // Get all positions in this chain (including closed rolled positions)
        const chainPositions = [
            ...closedPositions.filter(cp => cp.chainId === chainId),
            ...openPositions.filter(sp => sp.chainId === chainId || sp.id === chainId)
        ];
        
        // Calculate net premium for the chain
        chainPositions.forEach(cp => {
            const premium = (cp.premium || 0) * 100 * (cp.contracts || 1);
            const isDebit = isDebitPosition(cp.type);
            
            // Track collected vs paid
            if (isDebit) {
                premiumPaid += premium;
            } else {
                premiumCollected += premium;
            }
            
            // Subtract buyback cost if position was rolled
            if (cp.closeReason === 'rolled' && cp.closePrice) {
                premiumPaid += cp.closePrice * 100 * (cp.contracts || 1);
            }
        });
    });
    
    netPremium = premiumCollected - premiumPaid;
    
    // Capital at Risk - matches Positions footer calculation
    const capitalAtRisk = positionData.reduce((sum, p) => {
        const type = (p.type || '').toLowerCase();
        const isSpread = type.includes('_spread');
        
        if (isSpread) {
            // For spreads, use maxLoss or calculate it
            if (p.maxLoss) return sum + p.maxLoss;
            const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
            const premium = p.premium || 0;
            const maxLoss = isDebitPosition(p.type) 
                ? premium * 100 * (p.contracts || 1)
                : (width - premium) * 100 * (p.contracts || 1);
            return sum + maxLoss;
        } else if (isDebitPosition(p.type)) {
            // Long call/put: max loss = premium paid
            return sum + ((p.premium || 0) * 100 * (p.contracts || 1));
        } else if (type.includes('short_put') || type === 'buy_write') {
            // Cash-secured put or buy-write: strike × 100 × contracts
            return sum + ((p.strike || 0) * 100 * (p.contracts || 1));
        }
        // Covered calls: $0 (shares cover it)
        return sum;
    }, 0);
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
    
    // Net premium with sign, color, and tooltip breakdown
    const premEl = document.getElementById('portTotalPremium');
    if (premEl) {
        premEl.textContent = (netPremium >= 0 ? '$' : '-$') + Math.abs(netPremium).toFixed(0);
        premEl.style.color = netPremium >= 0 ? '#00ff88' : '#ff5252';
        // Show breakdown on hover
        premEl.title = `Collected: $${premiumCollected.toFixed(0)} | Paid: $${premiumPaid.toFixed(0)} | Net: $${netPremium.toFixed(0)}`;
    }
    
    setEl('portCapitalRisk', '$' + capitalAtRisk.toLocaleString());
    
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
    
    // Update all dashboard components (analytics, win rate, P&L chart, calendar)
    // Note: Old "Performance" panel removed - Win Rate Dashboard now provides chain-aware metrics
    refreshAllDashboards();
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
        const isSpread = pos.type?.includes('_spread');
        const strikeDisplay = isSpread 
            ? `$${pos.sellStrike}/$${pos.buyStrike}` 
            : `$${(pos.strike || 0).toFixed(2)}`;
        const premiumLabel = isSpread ? 'Net credit' : 'Premium received';
        
        infoEl.innerHTML = `
            <strong style="color:#00ff88;">${pos.ticker}</strong> 
            ${pos.type.replace(/_/g, ' ')} @ <strong>${strikeDisplay}</strong>
            <br>${premiumLabel}: <strong>$${(pos.premium || 0).toFixed(2)}</strong> × ${pos.contracts} contract(s)
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
    
    // Reset Schwab checkbox
    const schwabCheckbox = document.getElementById('closeSendToSchwab');
    if (schwabCheckbox) schwabCheckbox.checked = false;
    const schwabPreview = document.getElementById('closeSchwabPreview');
    if (schwabPreview) schwabPreview.style.display = 'none';
    
    // Clear cached live pricing
    window._closeLivePricing = null;
}
window.showClosePanel = showClosePanel;

/**
 * Update Schwab preview when checkbox is toggled
 */
window.updateClosePreview = async function() {
    const checkbox = document.getElementById('closeSendToSchwab');
    const previewDiv = document.getElementById('closeSchwabPreview');
    
    if (!checkbox || !previewDiv) return;
    
    if (!checkbox.checked) {
        previewDiv.style.display = 'none';
        window._closeLivePricing = null;
        return;
    }
    
    previewDiv.style.display = 'block';
    previewDiv.innerHTML = '<div style="color:#888; font-size:11px;">⏳ Loading Schwab preview...</div>';
    
    // Get the position we're closing
    const pos = state.positions.find(p => p.id === state.closingPositionId);
    if (!pos) {
        previewDiv.innerHTML = '<div style="color:#ff5252;">❌ Position not found</div>';
        return;
    }
    
    // Check if spread (not supported yet)
    if (pos.type?.includes('_spread')) {
        previewDiv.innerHTML = '<div style="color:#ffaa00;">⚠️ Spread orders not yet supported</div>';
        return;
    }
    
    // Determine option type
    const isPut = pos.type?.includes('put') || pos.isCall === false;
    const optionType = isPut ? 'P' : 'C';
    
    // Build preview request
    const previewData = {
        ticker: pos.ticker,
        expiry: pos.expiry,
        strike: pos.strike,
        type: optionType,
        action: 'BUY_TO_CLOSE',  // Closing a short = BUY_TO_CLOSE
        quantity: pos.contracts || 1,
        limitPrice: parseFloat(document.getElementById('closeClosingPrice')?.value) || 0
    };
    
    try {
        const res = await fetch('/api/schwab/preview-option-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(previewData)
        });
        
        const data = await res.json();
        
        if (!data.success) {
            previewDiv.innerHTML = `<div style="color:#ff5252;">❌ ${data.error || 'Preview failed'}</div>`;
            return;
        }
        
        // Store live pricing for use when executing
        window._closeLivePricing = {
            hasLivePricing: data.hasLivePricing,
            suggestedPrice: data.suggestedLimit,
            liveBid: data.liveBid,
            liveAsk: data.liveAsk,
            liveMid: data.liveMid,
            occSymbol: data.occSymbol
        };
        
        // Update the closing price input with live ask (for buy orders)
        if (data.hasLivePricing && data.suggestedLimit) {
            const priceInput = document.getElementById('closeClosingPrice');
            if (priceInput) {
                priceInput.value = data.suggestedLimit.toFixed(2);
                updateClosePnLPreview();
            }
        }
        
        // Build preview HTML with live pricing
        const totalCost = (data.suggestedLimit || previewData.limitPrice) * 100 * previewData.quantity;
        
        let pricingHtml = '';
        if (data.hasLivePricing) {
            pricingHtml = `
                <div style="margin-bottom:8px;">
                    <div style="font-size:10px; color:#888; margin-bottom:4px;">📈 Live Schwab Pricing</div>
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; text-align:center;">
                        <div style="background:rgba(0,255,136,0.1); padding:4px; border-radius:4px;">
                            <div style="font-size:9px; color:#888;">Bid</div>
                            <div style="color:#00ff88; font-weight:bold;">$${data.liveBid?.toFixed(2) || '—'}</div>
                        </div>
                        <div style="background:rgba(255,255,255,0.05); padding:4px; border-radius:4px;">
                            <div style="font-size:9px; color:#888;">Mid</div>
                            <div style="color:#fff;">$${data.liveMid?.toFixed(2) || '—'}</div>
                        </div>
                        <div style="background:rgba(255,82,82,0.1); padding:4px; border-radius:4px;">
                            <div style="font-size:9px; color:#888;">Ask</div>
                            <div style="color:#ff5252; font-weight:bold;">$${data.liveAsk?.toFixed(2) || '—'}</div>
                        </div>
                    </div>
                </div>
            `;
        }
        
        previewDiv.innerHTML = `
            ${pricingHtml}
            <div style="font-size:11px; color:#aaa; display:grid; grid-template-columns:auto 1fr; gap:4px 12px;">
                <span style="color:#888;">Symbol:</span>
                <span style="font-family:monospace; color:#00d9ff;">${data.occSymbol}</span>
                <span style="color:#888;">Action:</span>
                <span style="color:#ff5252;">BUY TO CLOSE</span>
                <span style="color:#888;">Limit:</span>
                <span style="color:#fff; font-weight:bold;">$${(data.suggestedLimit || previewData.limitPrice).toFixed(2)} ${data.hasLivePricing ? '(ask)' : ''}</span>
                <span style="color:#888;">Total Debit:</span>
                <span style="color:#ff5252; font-weight:bold;">$${totalCost.toFixed(0)}</span>
            </div>
            <div style="margin-top:6px; font-size:10px; color:#ffaa00;">
                ⚠️ Will send LIMIT order to Schwab when you confirm
            </div>
        `;
        
    } catch (err) {
        console.error('Close preview error:', err);
        previewDiv.innerHTML = `<div style="color:#ff5252;">❌ Error: ${err.message}</div>`;
    }
};

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
export async function executeClose() {
    const id = state.closingPositionId;
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const closingPrice = parseFloat(document.getElementById('closeClosingPrice')?.value);
    const closeDateValue = document.getElementById('closeDate')?.value;
    const sendToSchwab = document.getElementById('closeSendToSchwab')?.checked;
    
    if (isNaN(closingPrice) || closingPrice < 0) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    
    if (!closeDateValue) {
        showNotification('Please enter a close date', 'error');
        return;
    }
    
    // If sending to Schwab, do that first
    if (sendToSchwab) {
        const livePricing = window._closeLivePricing;
        const isPut = pos.type?.includes('put') || pos.isCall === false;
        const optionType = isPut ? 'P' : 'C';
        
        // Use live ask price if available, otherwise use entered price
        const orderPrice = livePricing?.hasLivePricing ? livePricing.suggestedPrice : closingPrice;
        
        const orderData = {
            ticker: pos.ticker,
            expiry: pos.expiry,
            strike: pos.strike,
            type: optionType,
            action: 'BUY_TO_CLOSE',
            quantity: pos.contracts || 1,
            limitPrice: orderPrice,
            confirm: true  // Actually place the order
        };
        
        try {
            showNotification('📤 Sending order to Schwab...', 'info');
            
            const res = await fetch('/api/schwab/place-option-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData)
            });
            
            const data = await res.json();
            
            if (!data.success) {
                showNotification(`❌ Schwab order failed: ${data.error}`, 'error');
                return;  // Don't close position if order failed
            }
            
            showNotification(`✅ Schwab order placed: BUY TO CLOSE ${pos.ticker} @ $${orderPrice.toFixed(2)}`, 'success');
            
        } catch (err) {
            console.error('Schwab order error:', err);
            showNotification(`❌ Error sending to Schwab: ${err.message}`, 'error');
            return;  // Don't close position if order failed
        }
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
        realizedPnL,
        sentToSchwab: sendToSchwab  // Track that this was sent to broker
    });
    saveClosedPositions();
    
    // Remove from open positions
    state.positions = state.positions.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Clear live pricing cache
    window._closeLivePricing = null;
    
    showNotification(`Closed ${pos.ticker}: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)} P&L${sendToSchwab ? ' (order sent to Schwab)' : ''}`, 
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
    
    if (state.closedYearFilter !== 'all' && state.closedYearFilter !== 'custom' && !years.includes(state.closedYearFilter)) {
        state.closedYearFilter = 'all';
    }
    
    // Filter closed positions based on selection
    let closed;
    if (state.closedYearFilter === 'all') {
        closed = allClosed;
    } else if (state.closedYearFilter === 'custom' && state.closedDateFrom && state.closedDateTo) {
        // Custom date range filtering
        const fromDate = new Date(state.closedDateFrom);
        const toDate = new Date(state.closedDateTo);
        toDate.setHours(23, 59, 59, 999); // Include full end day
        closed = allClosed.filter(p => {
            const closeDate = p.closeDate ? new Date(p.closeDate) : null;
            if (!closeDate) return false;
            return closeDate >= fromDate && closeDate <= toDate;
        });
    } else if (state.closedYearFilter === 'custom') {
        // Custom selected but no dates yet - show empty
        closed = [];
    } else {
        // Year filter
        closed = allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === state.closedYearFilter;
        });
    }
    
    const ytdPnL = allClosed
        .filter(p => (p.closeDate || '').startsWith(currentYear))
        .reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    
    let filterHtml = `
        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:12px; padding:10px; background:rgba(0,0,0,0.2); border-radius:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <label style="color:#888; font-size:12px;">Filter:</label>
                    <select id="closedYearFilter" style="padding:4px 8px; font-size:12px; background:#1a1a2e; color:#ddd; border:1px solid #444; border-radius:4px;">
                        <option value="all" ${state.closedYearFilter === 'all' ? 'selected' : ''}>All Years</option>
                        ${years.map(y => `<option value="${y}" ${state.closedYearFilter === y ? 'selected' : ''}>${y}</option>`).join('')}
                        <option value="custom" ${state.closedYearFilter === 'custom' ? 'selected' : ''}>📅 Custom Range</option>
                    </select>
                    <span style="color:#888; font-size:11px;">(${closed.length} trades)</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <span style="color:#888; font-size:11px;">YTD ${currentYear}:</span>
                    <span style="font-weight:bold; color:${ytdPnL >= 0 ? '#00ff88' : '#ff5252'};">
                        ${ytdPnL >= 0 ? '+' : ''}$${ytdPnL.toFixed(0)}
                    </span>
                </div>
            </div>
            
            <!-- Custom Date Range Row (hidden unless custom selected) -->
            <div id="customDateRangeRow" style="display:${state.closedYearFilter === 'custom' ? 'flex' : 'none'}; align-items:center; gap:10px; flex-wrap:wrap;">
                <label style="color:#888; font-size:11px;">From:</label>
                <input type="date" id="closedDateFrom" value="${state.closedDateFrom || ''}" 
                    style="padding:4px 8px; font-size:11px; background:#1a1a2e; color:#ddd; border:1px solid #444; border-radius:4px;">
                <label style="color:#888; font-size:11px;">To:</label>
                <input type="date" id="closedDateTo" value="${state.closedDateTo || ''}" 
                    style="padding:4px 8px; font-size:11px; background:#1a1a2e; color:#ddd; border:1px solid #444; border-radius:4px;">
                <button onclick="window.applyCustomDateRange()" 
                    style="padding:4px 12px; font-size:11px; background:#00d9ff; color:#000; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">
                    Apply
                </button>
                <button onclick="window.clearCustomDateRange()" 
                    style="padding:4px 8px; font-size:11px; background:#333; color:#888; border:1px solid #444; border-radius:4px; cursor:pointer;">
                    Clear
                </button>
            </div>
            
            <!-- Action Buttons Row -->
            <div style="display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap;">
                <div style="display:flex; gap:8px;">
                    <button onclick="window.runHistoricalAudit()" 
                            style="padding:6px 12px; font-size:11px; background:rgba(139,92,246,0.3); border:1px solid rgba(139,92,246,0.5); color:#a78bfa; border-radius:4px; cursor:pointer;"
                            title="AI analyzes trading patterns and performance in the filtered date range">
                        🤖 AI Historical Audit
                    </button>
                    <button onclick="window.exportClosedForTax()" 
                            style="padding:6px 12px; font-size:11px; background:#2a2a4e; border:1px solid #444; color:#aaa; border-radius:4px; cursor:pointer;"
                            title="Export filtered trades as CSV for tax records">
                        📥 Export CSV
                    </button>
                </div>
                <div style="font-size:10px; color:#666;">
                    ${state.closedYearFilter === 'custom' && state.closedDateFrom && state.closedDateTo 
                        ? `📅 ${state.closedDateFrom} to ${state.closedDateTo}` 
                        : ''}
                </div>
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
    
    // Build label based on filter type
    let yearLabel;
    if (state.closedYearFilter === 'all') {
        yearLabel = 'All Time';
    } else if (state.closedYearFilter === 'custom' && state.closedDateFrom && state.closedDateTo) {
        yearLabel = `${state.closedDateFrom} to ${state.closedDateTo}`;
    } else if (state.closedYearFilter === 'custom') {
        yearLabel = 'Custom Range (select dates)';
    } else {
        yearLabel = state.closedYearFilter;
    }
    
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
    const customRow = document.getElementById('customDateRangeRow');
    
    if (filterEl) {
        // Show/hide custom date row based on selection
        if (customRow) {
            customRow.style.display = filterEl.value === 'custom' ? 'flex' : 'none';
        }
        
        filterEl.onchange = (e) => {
            state.closedYearFilter = e.target.value;
            
            // Show/hide custom date range row
            if (customRow) {
                customRow.style.display = e.target.value === 'custom' ? 'flex' : 'none';
            }
            
            // If not custom, clear custom dates and re-render
            if (e.target.value !== 'custom') {
                state.closedDateFrom = null;
                state.closedDateTo = null;
                renderClosedPositions();
                renderPortfolio(false);
            }
        };
    }
}

/**
 * Apply custom date range filter
 */
window.applyCustomDateRange = function() {
    const fromEl = document.getElementById('closedDateFrom');
    const toEl = document.getElementById('closedDateTo');
    
    if (!fromEl?.value || !toEl?.value) {
        showNotification('Please select both From and To dates', 'warning');
        return;
    }
    
    const fromDate = new Date(fromEl.value);
    const toDate = new Date(toEl.value);
    
    if (fromDate > toDate) {
        showNotification('From date must be before To date', 'error');
        return;
    }
    
    state.closedDateFrom = fromEl.value;
    state.closedDateTo = toEl.value;
    state.closedYearFilter = 'custom';
    
    renderClosedPositions();
    renderPortfolio(false);
    
    showNotification(`Showing trades from ${fromEl.value} to ${toEl.value}`, 'success');
};

/**
 * Clear custom date range and reset to all
 */
window.clearCustomDateRange = function() {
    state.closedDateFrom = null;
    state.closedDateTo = null;
    state.closedYearFilter = 'all';
    
    const filterEl = document.getElementById('closedYearFilter');
    if (filterEl) filterEl.value = 'all';
    
    const customRow = document.getElementById('customDateRangeRow');
    if (customRow) customRow.style.display = 'none';
    
    renderClosedPositions();
    renderPortfolio(false);
};

/**
 * Run AI Historical Audit on the currently filtered closed positions
 */
window.runHistoricalAudit = async function() {
    const allClosed = state.closedPositions || [];
    const currentFilter = state.closedYearFilter || 'all';
    
    // Get filtered positions matching current view
    let filtered;
    if (currentFilter === 'all') {
        filtered = allClosed;
    } else if (currentFilter === 'custom' && state.closedDateFrom && state.closedDateTo) {
        const fromDate = new Date(state.closedDateFrom);
        const toDate = new Date(state.closedDateTo);
        toDate.setHours(23, 59, 59, 999);
        filtered = allClosed.filter(p => {
            const closeDate = p.closeDate ? new Date(p.closeDate) : null;
            if (!closeDate) return false;
            return closeDate >= fromDate && closeDate <= toDate;
        });
    } else {
        // Year filter
        filtered = allClosed.filter(p => (p.closeDate || '').startsWith(currentFilter));
    }
    
    if (filtered.length === 0) {
        showNotification('No trades in selected range to analyze', 'warning');
        return;
    }
    
    // Build period label
    let periodLabel;
    if (currentFilter === 'all') {
        periodLabel = 'All Time';
    } else if (currentFilter === 'custom' && state.closedDateFrom && state.closedDateTo) {
        periodLabel = `${state.closedDateFrom} to ${state.closedDateTo}`;
    } else {
        periodLabel = currentFilter;
    }
    
    // Calculate summary stats for the AI
    const totalPnL = filtered.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const winners = filtered.filter(p => (p.realizedPnL ?? p.closePnL ?? 0) >= 0);
    const losers = filtered.filter(p => (p.realizedPnL ?? p.closePnL ?? 0) < 0);
    const winRate = (winners.length / filtered.length * 100).toFixed(1);
    
    // Group by ticker
    const byTicker = {};
    filtered.forEach(p => {
        if (!byTicker[p.ticker]) byTicker[p.ticker] = { trades: 0, pnl: 0 };
        byTicker[p.ticker].trades++;
        byTicker[p.ticker].pnl += (p.realizedPnL ?? p.closePnL ?? 0);
    });
    
    // Sort tickers by P&L
    const tickerSummary = Object.entries(byTicker)
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .slice(0, 10)
        .map(([t, d]) => `${t}: ${d.trades} trades, $${d.pnl.toFixed(0)}`);
    
    // Group by type
    const byType = {};
    filtered.forEach(p => {
        const type = p.type || 'unknown';
        if (!byType[type]) byType[type] = { trades: 0, pnl: 0 };
        byType[type].trades++;
        byType[type].pnl += (p.realizedPnL ?? p.closePnL ?? 0);
    });
    
    const typeSummary = Object.entries(byType)
        .sort((a, b) => b[1].pnl - a[1].pnl)
        .map(([t, d]) => `${t.replace('_', ' ')}: ${d.trades} trades, $${d.pnl.toFixed(0)}`);
    
    // Find biggest winners and losers
    const sortedByPnL = [...filtered].sort((a, b) => (b.realizedPnL ?? b.closePnL ?? 0) - (a.realizedPnL ?? a.closePnL ?? 0));
    const topWinners = sortedByPnL.slice(0, 5).map(p => 
        `${p.ticker} ${p.type?.replace('_',' ')} $${p.strike}: +$${(p.realizedPnL ?? p.closePnL ?? 0).toFixed(0)}`
    );
    const topLosers = sortedByPnL.slice(-5).reverse().filter(p => (p.realizedPnL ?? p.closePnL ?? 0) < 0).map(p =>
        `${p.ticker} ${p.type?.replace('_',' ')} $${p.strike}: $${(p.realizedPnL ?? p.closePnL ?? 0).toFixed(0)}`
    );
    
    // Show loading modal
    const modalHtml = `
        <div id="historicalAuditModal" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10001;">
            <div style="background:#1a1a2e; border:1px solid #333; border-radius:12px; width:90%; max-width:800px; max-height:90vh; overflow:auto; padding:25px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h2 style="margin:0; color:#00d9ff;">📊 AI Historical Audit: ${periodLabel}</h2>
                    <button onclick="document.getElementById('historicalAuditModal').remove()" style="background:transparent; border:none; color:#888; font-size:24px; cursor:pointer;">×</button>
                </div>
                <div style="margin-bottom:15px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px;">
                    <span style="color:#888;">Period:</span> <span style="color:#fff;">${periodLabel}</span> &nbsp;|&nbsp;
                    <span style="color:#888;">Trades:</span> <span style="color:#fff;">${filtered.length}</span> &nbsp;|&nbsp;
                    <span style="color:#888;">Win Rate:</span> <span style="color:${parseFloat(winRate) >= 50 ? '#00ff88' : '#ff5252'};">${winRate}%</span> &nbsp;|&nbsp;
                    <span style="color:#888;">Total P&L:</span> <span style="color:${totalPnL >= 0 ? '#00ff88' : '#ff5252'};">${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}</span>
                </div>
                <div id="historicalAuditContent" style="min-height:200px; display:flex; align-items:center; justify-content:center;">
                    <div style="text-align:center;">
                        <div style="font-size:32px; margin-bottom:10px;">🤖</div>
                        <div style="color:#00d9ff;">Analyzing ${filtered.length} trades...</div>
                        <div style="color:#888; font-size:12px; margin-top:5px;">This may take a moment</div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    try {
        const response = await fetch('/api/ai/historical-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                periodLabel,
                totalTrades: filtered.length,
                totalPnL,
                winRate,
                winnersCount: winners.length,
                losersCount: losers.length,
                tickerSummary,
                typeSummary,
                topWinners,
                topLosers,
                trades: filtered.slice(0, 50) // Send up to 50 trades for context
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        const contentEl = document.getElementById('historicalAuditContent');
        if (contentEl) {
            contentEl.innerHTML = `
                <div style="white-space:pre-wrap; line-height:1.6; color:#e0e0e0; font-size:14px;">
                    ${data.analysis || data.insight || 'No analysis available'}
                </div>
            `;
        }
    } catch (err) {
        console.error('Historical audit error:', err);
        const contentEl = document.getElementById('historicalAuditContent');
        if (contentEl) {
            contentEl.innerHTML = `
                <div style="color:#ff5252; text-align:center;">
                    <div style="font-size:32px; margin-bottom:10px;">❌</div>
                    <div>Failed to get AI analysis</div>
                    <div style="color:#888; font-size:12px; margin-top:5px;">${err.message}</div>
                </div>
            `;
        }
    }
};

/**
 * Export closed positions as CSV for tax records
 */
export function exportClosedForTax() {
    const allClosed = state.closedPositions || [];
    const currentFilter = state.closedYearFilter || 'all';
    
    // Filter by selected filter type
    let toExport;
    let filterLabel;
    
    if (currentFilter === 'all') {
        toExport = allClosed;
        filterLabel = 'all_time';
    } else if (currentFilter === 'custom' && state.closedDateFrom && state.closedDateTo) {
        const fromDate = new Date(state.closedDateFrom);
        const toDate = new Date(state.closedDateTo);
        toDate.setHours(23, 59, 59, 999);
        toExport = allClosed.filter(p => {
            const closeDate = p.closeDate ? new Date(p.closeDate) : null;
            if (!closeDate) return false;
            return closeDate >= fromDate && closeDate <= toDate;
        });
        filterLabel = `${state.closedDateFrom}_to_${state.closedDateTo}`;
    } else {
        toExport = allClosed.filter(p => (p.closeDate || '').startsWith(currentFilter));
        filterLabel = currentFilter;
    }
    
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
    a.download = `wheelhouse_trades_${filterLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification(`Exported ${toExport.length} trades for ${filterLabel.replace(/_/g, ' ')}`, 'success');
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
            linkedPositionId: h.linkedPositionId,
            acquiredDate: h.acquiredDate || h.assignedDate || null
        });
        
        // Unique IDs for async updates
        const rowId = `holding-row-${h.id}`;
        const priceId = `hp-${h.id}`;
        const stockPnLId = `hspnl-${h.id}`;
        const totalReturnId = `htr-${h.id}`;
        const onTableId = `hot-${h.id}`;
        const actionId = `hact-${h.id}`;
        const dividendId = `hdiv-${h.id}`;
        
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
                        <button onclick="window.sellCallAgainstShares(${h.id})" 
                                style="background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.4); color:#ffaa00; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Sell a covered call against these shares (links to wheel chain)">
                            📞 Sell Call
                        </button>
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
                
                <!-- Row 2: The Option + Dividends -->
                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; text-align:center; margin-top:8px;">
                    <!-- Premium Collected -->
                    <div style="background:rgba(0,255,136,0.08); padding:10px; border-radius:6px; border:1px solid rgba(0,255,136,0.2);">
                        <div style="font-size:9px; color:#00ff88; margin-bottom:4px;">✅ CALL PREMIUM</div>
                        <div style="font-size:16px; font-weight:bold; color:#00ff88;">+$${premiumTotal.toFixed(0)}</div>
                        <div style="font-size:10px; color:#666;">yours to keep</div>
                    </div>
                    
                    <!-- Dividends Received -->
                    <div id="${dividendId}" style="background:rgba(139,92,246,0.08); padding:10px; border-radius:6px; border:1px solid rgba(139,92,246,0.2);">
                        <div style="font-size:9px; color:#8b5cf6; margin-bottom:4px;">💰 DIVIDENDS</div>
                        <div style="font-size:16px; font-weight:bold; color:#888;">—</div>
                        <div style="font-size:10px; color:#666;">loading...</div>
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
            <div style="display:grid; grid-template-columns:repeat(6, 1fr); gap:12px; text-align:center;">
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
                    <div style="color:#888; font-size:10px;">Dividends</div>
                    <div id="sumDividends" style="color:#8b5cf6; font-weight:bold; font-size:14px;">—</div>
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
    
    // BATCH fetch prices AND dividends in parallel!
    const [priceMap, dividendMap] = await Promise.all([
        fetchStockPricesBatch(tickers),
        fetchHoldingDividends(holdingData)
    ]);
    if (VERBOSE_PRICE_LOGS) console.log(`[HOLDINGS] Fetched ${Object.keys(priceMap).length} prices, ${Object.keys(dividendMap).length} dividend records`);
    
    // Summary totals
    let sumCapital = 0;
    let sumCurrentValue = 0;
    let sumStockPnL = 0;
    let sumPremium = 0;
    let sumDividends = 0;
    let sumOnTable = 0;
    let hasPrices = false;  // Track if we got any valid prices
    
    // Update each holding row with calculated metrics
    for (const h of holdingData) {
        const currentPrice = priceMap[h.ticker] || 0;
        const divData = dividendMap[h.ticker?.toUpperCase()] || { total: 0, payments: [] };
        const dividendTotal = divData.total || 0;
        
        // Always add capital, premium, dividends to summary (we know these)
        sumCapital += h.totalCost;
        sumPremium += h.premium;
        sumDividends += dividendTotal;
        
        // Update dividend cell regardless of price
        updateHoldingDividendCell(h, dividendTotal, divData.payments || []);
        
        // Only calculate current value metrics if we have a valid price
        if (currentPrice > 0) {
            hasPrices = true;
            const currentValue = currentPrice * h.shares;
            const stockPnL = currentValue - h.totalCost;
            const totalReturn = stockPnL + h.premium + dividendTotal;
            const moneyOnTable = h.strike > 0 && currentPrice > h.strike 
                ? (currentPrice - h.strike) * h.shares 
                : 0;
            
            sumCurrentValue += currentValue;
            sumStockPnL += stockPnL;
            sumOnTable += moneyOnTable;
            
            // Update row with calculated values (now includes dividends)
            updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable, dividendTotal);
        } else {
            // Price fetch failed - show error state
            showHoldingError(h);
        }
    }
    
    // Update summary row (only if we have prices)
    updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumDividends, sumOnTable, hasPrices);
}

/**
 * Fetch dividend history for all holdings from Schwab
 * Returns { TICKER: { total, payments[] } }
 */
async function fetchHoldingDividends(holdingData) {
    try {
        const tickers = [...new Set(holdingData.map(h => h.ticker).filter(Boolean))];
        if (tickers.length === 0) return {};
        
        // Find earliest acquisition date across all holdings
        let earliestDate = null;
        for (const h of holdingData) {
            const d = h.acquiredDate;
            if (d) {
                const dt = new Date(d);
                if (!earliestDate || dt < earliestDate) earliestDate = dt;
            }
        }
        // Default to 2 years ago if no dates
        const since = earliestDate 
            ? earliestDate.toISOString() 
            : new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
        
        const response = await fetch('/api/schwab/dividends', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers, since })
        });
        
        if (!response.ok) {
            if (VERBOSE_PRICE_LOGS) console.log('[HOLDINGS] Dividend fetch failed:', response.status);
            return {};
        }
        
        return await response.json();
    } catch (e) {
        // Schwab may not be connected - fail silently
        if (VERBOSE_PRICE_LOGS) console.log('[HOLDINGS] Dividend fetch error:', e.message);
        return {};
    }
}

/**
 * Update the dividend cell for a single holding
 */
function updateHoldingDividendCell(h, dividendTotal, payments) {
    const divEl = document.getElementById(`hdiv-${h.id}`);
    if (!divEl) return;
    
    if (dividendTotal > 0) {
        const paymentCount = payments.length;
        const lastPayment = payments[0]; // Already sorted newest first
        const lastDateStr = lastPayment?.date 
            ? new Date(lastPayment.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
        
        divEl.innerHTML = `
            <div style="font-size:9px; color:#8b5cf6; margin-bottom:4px;">💰 DIVIDENDS</div>
            <div style="font-size:16px; font-weight:bold; color:#8b5cf6;">+$${dividendTotal.toFixed(2)}</div>
            <div style="font-size:10px; color:#666;">${paymentCount} payment${paymentCount !== 1 ? 's' : ''}${lastDateStr ? ' · last ' + lastDateStr : ''}</div>
        `;
        divEl.style.background = 'rgba(139,92,246,0.12)';
        divEl.style.borderColor = 'rgba(139,92,246,0.35)';
    } else {
        divEl.innerHTML = `
            <div style="font-size:9px; color:#8b5cf6; margin-bottom:4px;">💰 DIVIDENDS</div>
            <div style="font-size:16px; font-weight:bold; color:#555;">$0</div>
            <div style="font-size:10px; color:#555;">none received</div>
        `;
    }
}

/**
 * Update a single holding row with calculated values
 */
function updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable, dividendTotal = 0) {
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
    
    // TOTAL RETURN bar at bottom (now includes dividends)
    const totalReturnEl = document.getElementById(`htr-${h.id}`);
    if (totalReturnEl) {
        const trColor = totalReturn >= 0 ? '#00ff88' : '#ff5252';
        const trSign = totalReturn >= 0 ? '+' : '';
        const trPct = h.totalCost > 0 ? ((totalReturn / h.totalCost) * 100).toFixed(1) : 0;
        const divPart = dividendTotal > 0 ? ` + Div +$${dividendTotal.toFixed(0)}` : '';
        totalReturnEl.innerHTML = `
            <span style="color:#888; font-size:11px;">TOTAL RETURN: </span>
            <span style="font-weight:bold; font-size:14px; color:${trColor};">${trSign}$${totalReturn.toFixed(0)} (${trSign}${trPct}%)</span>
            <span style="color:#666; font-size:10px; margin-left:10px;">= Stock ${stockPnLSign}$${stockPnL.toFixed(0)} + Premium +$${h.premium.toFixed(0)}${divPart}</span>
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
function updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumDividends, sumOnTable, hasPrices) {
    const updateSum = (id, value, color) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = value;
            if (color) el.style.color = color;
        }
    };
    
    updateSum('sumCapital', `$${sumCapital.toFixed(0)}`, '#fa0');
    updateSum('sumPremium', `+$${sumPremium.toFixed(0)}`, '#00ff88');
    updateSum('sumDividends', sumDividends > 0 ? `+$${sumDividends.toFixed(0)}` : '$0', sumDividends > 0 ? '#8b5cf6' : '#555');
    
    if (hasPrices) {
        const sumTotalReturn = sumStockPnL + sumPremium + sumDividends;
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
 * Now calls backend /api/ai/holding-suggestion endpoint with unified context
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
    const costBasis = holding.stockPrice || holding.costBasis || 0;
    const expiry = position?.expiry || holding.expiry || null;
    
    // Calculate NET premium from entire chain (all rolls, minus buyback costs)
    let premium = 0;
    let chainHistory = [];
    if (position) {
        const chainId = position.chainId || position.id;
        const closedPositions = state.closedPositions || [];
        const openPositions = state.positions || [];
        
        // Get all positions in this chain
        const chainPositions = [
            ...closedPositions.filter(cp => cp.chainId === chainId),
            ...openPositions.filter(sp => sp.chainId === chainId || sp.id === chainId)
        ];
        
        let premiumCollected = 0;
        let premiumPaid = 0;
        
        chainPositions.forEach(cp => {
            const posPremium = (cp.premium || 0) * 100 * (cp.contracts || 1);
            const isDebit = (cp.type || '').includes('long_') || (cp.type || '').includes('_debit_');
            
            if (isDebit) {
                premiumPaid += posPremium;
            } else {
                premiumCollected += posPremium;
            }
            
            // Subtract buyback cost if position was rolled
            if (cp.closeReason === 'rolled' && cp.closePrice) {
                premiumPaid += cp.closePrice * 100 * (cp.contracts || 1);
            }
            
            // Build chain history for AI context
            chainHistory.push({
                strike: cp.strike,
                expiry: cp.expiry,
                premium: cp.premium,
                closeReason: cp.closeReason || 'open',
                openDate: cp.openDate,
                closeDate: cp.closeDate
            });
        });
        
        premium = premiumCollected - premiumPaid;
        console.log(`[AI] Chain premium for ${holding.ticker}: collected $${premiumCollected}, paid $${premiumPaid}, net $${premium}`);
    } else {
        premium = holding.premiumCredit || 0;
    }
    
    // Get analysis history from position
    const analysisHistory = position?.analysisHistory || [];
    const openingThesis = position?.openingThesis || null;
    
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
                <div>Choose AI model to analyze...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Store context for model selection
    window._aiHoldingContext = {
        holding, position, strike, premium, costBasis, expiry, shares,
        chainHistory, analysisHistory, openingThesis
    };
    
    // Show model picker
    const contentDiv = document.querySelector('#aiHoldingModal > div');
    contentDiv.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
            <button onclick="this.closest('#aiHoldingModal').remove()" 
                style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
        </div>
        
        <!-- Position Summary -->
        <div style="background:#0d0d1a;padding:12px;border-radius:8px;margin-bottom:16px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px;">
                <div><span style="color:#888;">Strike:</span> <span style="color:#fff;font-weight:bold;">$${strike?.toFixed(2) || '?'}</span></div>
                <div><span style="color:#888;">Cost:</span> <span style="color:#fff;">$${costBasis?.toFixed(2) || '?'}</span></div>
                <div><span style="color:#888;">Expiry:</span> <span style="color:#fff;">${expiry || '?'}</span></div>
                <div><span style="color:#888;">Premium:</span> <span style="color:#00ff88;">$${premium.toFixed(0)}</span></div>
            </div>
            ${chainHistory.length > 1 ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333;font-size:11px;color:#888;">📊 Part of wheel chain (${chainHistory.length} positions)</div>` : ''}
        </div>
        
        <!-- Model Selection -->
        <div style="text-align:center;padding:20px 0;">
            <div style="color:#888;margin-bottom:16px;font-size:13px;">Choose AI model to analyze:</div>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button onclick="runHoldingAnalysis('ollama')" 
                    style="padding:14px 28px;background:linear-gradient(135deg, #1a3a1a 0%, #0d1a0d 100%);border:2px solid #00ff88;border-radius:8px;color:#00ff88;font-weight:bold;cursor:pointer;font-size:14px;min-width:180px;">
                    🦙 Ollama (32B)<br><span style="font-size:10px;font-weight:normal;opacity:0.7;">Free - Local</span>
                </button>
                <button onclick="runHoldingAnalysis('grok')" 
                    style="padding:14px 28px;background:linear-gradient(135deg, #3a2a1a 0%, #1a0d0d 100%);border:2px solid #ff6600;border-radius:8px;color:#ff6600;font-weight:bold;cursor:pointer;font-size:14px;min-width:180px;">
                    🔥 Grok<br><span style="font-size:10px;font-weight:normal;opacity:0.7;">~$0.02 - Cloud</span>
                </button>
            </div>
        </div>
    `;
};

/**
 * Run the holding analysis with specified model - calls backend endpoint
 */
async function runHoldingAnalysis(modelType) {
    const ctx = window._aiHoldingContext;
    if (!ctx) return;
    
    const { holding, position, strike, premium, costBasis, expiry, shares,
            chainHistory, analysisHistory, openingThesis } = ctx;
    
    const contentDiv = document.querySelector('#aiHoldingModal > div');
    if (!contentDiv) return;
    
    // Show loading
    contentDiv.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
            <button onclick="this.closest('#aiHoldingModal').remove()" 
                style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
        </div>
        <div style="text-align:center;padding:40px;color:#888;">
            <div style="font-size:24px;margin-bottom:10px;">🔄</div>
            <div>Analyzing with ${modelType === 'grok' ? 'Grok' : 'Ollama 32B'}...</div>
        </div>
    `;
    
    try {
        // Call backend endpoint
        const response = await fetch('/api/ai/holding-suggestion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: holding.ticker,
                shares,
                costBasis,
                strike,
                expiry,
                premium,
                model: modelType === 'grok' ? 'grok' : 'deepseek-r1:32b',
                chainHistory,
                analysisHistory,
                openingThesis
            })
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'AI analysis failed');
        }
        
        const result = await response.json();
        const { analysis, currentPrice, isITM, stockGainLoss, onTable, cushion, ifCalled, 
                wheelPutStrike, wheelPutStrikeAlt, suggestedTrade, newRecommendation, dte } = result;
        
        // Store for staging
        window._aiHoldingContext.currentPrice = currentPrice;
        window._aiHoldingContext.suggestedTrade = suggestedTrade;
        window._aiHoldingContext.lastAnalysis = analysis;
        window._aiHoldingContext.lastModel = modelType;
        
        // Format analysis for display (remove trade block)
        const displayAnalysis = analysis.replace(/===SUGGESTED_TRADE===[\s\S]*?===END_TRADE===/g, '');
        const formatted = displayAnalysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#ffaa00;">$1</strong>')
            .replace(/^[\*]*\s*(SITUATION SUMMARY|RECOMMENDATION|SPECIFIC ACTION|KEY RISK)[:\*]*/gim, 
                '<div style="color:#00d9ff;font-weight:bold;font-size:14px;margin-top:16px;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;">$1</div>')
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
                    🦙 Ollama - Free
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
                    <div><span style="color:#666;">Stock:</span> <span style="color:#fff;">$${currentPrice?.toFixed(2) || '?'}</span></div>
                    <div><span style="color:#666;">Strike:</span> <span style="color:#fff;">$${strike?.toFixed(2) || '?'}</span></div>
                    <div><span style="color:#666;">Cost:</span> <span style="color:#fff;">$${costBasis?.toFixed(2) || '?'}</span></div>
                    <div><span style="color:#666;">DTE:</span> <span style="color:#fff;">${dte} days</span></div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center;padding-top:10px;border-top:1px solid #333;">
                    <div>
                        <div style="font-size:9px;color:#666;">STOCK P&L</div>
                        <div style="font-weight:bold;color:${stockGainLoss >= 0 ? '#00ff88' : '#ff5252'};">
                            ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss?.toFixed(0) || '0'}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">PREMIUM</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${premium?.toFixed(0) || '0'}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">${isITM ? 'ON TABLE' : 'CUSHION'}</div>
                        <div style="font-weight:bold;color:${isITM ? '#ffaa00' : '#00d9ff'};">
                            $${(isITM ? onTable : cushion)?.toFixed(0) || '0'}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">IF CALLED</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${ifCalled?.toFixed(0) || '0'}</div>
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
            <div style="line-height:1.7;font-size:13px;">${formatted}</div>
            
            ${suggestedTrade && suggestedTrade.action !== 'HOLD' && suggestedTrade.newStrike ? `
            <!-- Suggested Trade Card -->
            <div style="background:linear-gradient(135deg, #1a2a3a 0%, #0d1a2a 100%);padding:16px;border-radius:8px;margin-top:16px;border:1px solid #00d9ff;">
                <h4 style="margin:0 0 12px;color:#00d9ff;font-size:13px;">📋 Suggested Trade</h4>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                    <div style="background:#0d0d1a;padding:10px;border-radius:6px;">
                        <div style="font-size:10px;color:#888;margin-bottom:4px;">${suggestedTrade.action === 'WHEEL_CONTINUATION' ? 'LET ASSIGN' : 'CLOSE (Buy Back)'}</div>
                        <div style="font-size:14px;font-weight:bold;color:${suggestedTrade.action === 'WHEEL_CONTINUATION' ? '#00ff88' : '#ff5252'};">
                            ${holding.ticker} $${suggestedTrade.closeStrike} ${suggestedTrade.closeType}
                        </div>
                        <div style="font-size:11px;color:#888;">Exp: ${suggestedTrade.closeExpiry}</div>
                    </div>
                    <div style="background:#0d0d1a;padding:10px;border-radius:6px;">
                        <div style="font-size:10px;color:#888;margin-bottom:4px;">OPEN (Sell New)</div>
                        <div style="font-size:14px;font-weight:bold;color:#00ff88;">
                            ${holding.ticker} $${suggestedTrade.newStrike} ${suggestedTrade.newType}
                        </div>
                        <div style="font-size:11px;color:#888;">Exp: ${suggestedTrade.newExpiry}</div>
                    </div>
                </div>
                <div style="margin-top:10px;padding:10px;background:#0d0d1a;border-radius:6px;">
                    <span style="font-size:11px;color:#888;">Net:</span>
                    <span style="font-size:16px;font-weight:bold;color:${suggestedTrade.netCost?.includes('credit') ? '#00ff88' : '#ffaa00'};margin-left:8px;">
                        ${suggestedTrade.netCost || 'N/A'}
                    </span>
                </div>
                <div style="font-size:11px;color:#aaa;margin-top:8px;">💡 ${suggestedTrade.rationale || 'AI-suggested trade'}</div>
            </div>
            ` : ''}
            
            <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
                ${suggestedTrade && suggestedTrade.action !== 'HOLD' && suggestedTrade.newStrike ? `
                <button onclick="window.stageHoldingSuggestedTrade()" 
                    style="padding:10px 16px;background:linear-gradient(135deg, #00d9ff 0%, #0099cc 100%);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">
                    📥 Stage Trade
                </button>
                ` : ''}
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
            <p style="color:#666;font-size:11px;">${modelType === 'grok' ? 'Check your Grok API key in Settings.' : 'Make sure Ollama is running.'}</p>
        `;
    }
}
window.runHoldingAnalysis = runHoldingAnalysis;

/**
 * Stage the AI-suggested trade from holding analysis to pending trades
 */
window.stageHoldingSuggestedTrade = function() {
    const ctx = window._aiHoldingContext;
    if (!ctx || !ctx.suggestedTrade) {
        showNotification('No suggested trade to stage', 'warning');
        return;
    }
    
    const { suggestedTrade, position } = ctx;
    
    // Format the pending trade - use the position context
    const holding = position || ctx.holding;
    const isCall = suggestedTrade.newType?.toLowerCase().includes('call');
    
    const pendingTrade = {
        id: Date.now(),
        ticker: holding?.ticker || 'UNKNOWN',
        strike: parseFloat(suggestedTrade.newStrike),
        expiry: suggestedTrade.newExpiry,
        type: isCall ? 'covered_call' : 'short_put',
        isCall: isCall,
        isRoll: true,
        premium: null, // Will need to fetch real premium
        source: 'ai_holding_suggestion',
        stagedAt: new Date().toISOString(),
        rollFrom: {
            strike: parseFloat(suggestedTrade.closeStrike),
            expiry: suggestedTrade.closeExpiry,
            type: suggestedTrade.closeType,
            estimatedDebit: suggestedTrade.estimatedDebit
        },
        netCost: suggestedTrade.netCost,
        aiRationale: suggestedTrade.rationale,
        badge: 'ROLL'
    };
    
    // Load existing pending trades
    let pendingTrades = [];
    try {
        pendingTrades = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    } catch (e) {
        pendingTrades = [];
    }
    
    // Check for duplicate
    const exists = pendingTrades.some(t => 
        t.ticker === pendingTrade.ticker && 
        t.strike === pendingTrade.strike && 
        t.expiry === pendingTrade.expiry
    );
    
    if (exists) {
        showNotification('This trade is already staged', 'warning');
        return;
    }
    
    pendingTrades.push(pendingTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pendingTrades));
    
    showNotification(`📥 Staged: ${pendingTrade.ticker} $${pendingTrade.strike} ${pendingTrade.expiry}`, 'success');
    
    // Close the modal
    document.getElementById('aiHoldingModal')?.remove();
    
    // Refresh Ideas tab if it has a render function
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
};

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
 * Uses the unified /api/ai/holding-checkup endpoint for position flow context
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
    
    // Get chain history if this is part of a wheel
    const chainId = holding.chainId || position?.chainId;
    let chainHistory = [];
    if (chainId) {
        const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
        chainHistory = allPositions.filter(p => p.chainId === chainId).sort((a, b) => 
            new Date(a.openDate || a.createdAt || 0) - new Date(b.openDate || b.createdAt || 0)
        );
    }
    
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
        // Call the unified backend endpoint
        const response = await fetch('/api/ai/holding-checkup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: holding.ticker,
                strike: position.strike || holding.strike,
                expiry: position.expiry,
                costBasis: holding.costBasis,
                shares: holding.shares || 100,
                premium: (position.premium || 0) * 100 * (position.contracts || 1),
                savedStrategy: strategy,
                chainHistory: chainHistory,
                model: window.getSelectedAIModel?.('globalModelSelect') || 'qwen2.5:7b'
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Checkup failed');
        }
        
        const result = await response.json();
        const checkupAnalysis = result.checkup || 'No checkup returned';
        const { 
            currentPrice, savedStockPrice, priceChange, dte, isITM, ifCalled,
            newRecommendation, recommendationChanged, savedRecommendation 
        } = result;
        
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
                        <span style="color:#888;text-decoration:line-through;">${savedRecommendation}</span>
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
        
        // Get snapshot values from result or strategy
        const snapshot = strategy.snapshot || {};
        const savedDte = snapshot.dte ?? 'N/A';
        const savedIsITM = snapshot.isITM ?? false;
        
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
                        <div>Stock: $${(savedStockPrice || 0).toFixed(2)}</div>
                        <div>DTE: ${savedDte} days</div>
                        <div>ITM: ${savedIsITM ? 'Yes' : 'No'}</div>
                        <div style="margin-top:8px;color:#00ff88;font-weight:bold;">→ ${savedRecommendation}</div>
                    </div>
                </div>
                <div style="background:rgba(0,217,255,0.1);padding:12px;border-radius:8px;border:1px solid rgba(0,217,255,0.3);">
                    <div style="color:#00d9ff;font-weight:bold;font-size:11px;margin-bottom:8px;">📊 CURRENT</div>
                    <div style="font-size:12px;color:#ccc;">
                        <div>Stock: $${(currentPrice || 0).toFixed(2)} <span style="color:${currentPrice > savedStockPrice ? '#00ff88' : '#ff5252'};">(${priceChange !== 'N/A' ? (currentPrice > savedStockPrice ? '+' : '') + priceChange : 'N/A'}%)</span></div>
                        <div>DTE: ${dte} days</div>
                        <div>ITM: ${isITM ? 'Yes' : 'No'}</div>
                        <div style="margin-top:8px;">If Called: +$${(ifCalled || 0).toFixed(0)}</div>
                    </div>
                </div>
            </div>
            
            ${chainHistory.length > 1 ? `
            <div style="background:rgba(139,92,246,0.1);padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:11px;color:#8b5cf6;">
                🔗 Part of wheel chain with ${chainHistory.length} positions (${chainHistory.filter(p => p.closeReason === 'rolled').length} rolls)
            </div>
            ` : ''}
            
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
 * Sell a covered call against shares from assignment - links to wheel chain
 */
export function sellCallAgainstShares(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    // Get the chain ID from the holding
    const chainId = holding.chainId || holding.fromPutId || holding.id;
    const contracts = Math.floor((holding.shares || 100) / 100);
    
    // Calculate suggested strike (at or slightly above cost basis)
    const costBasis = holding.costBasis || holding.strike || 0;
    const suggestedStrike = Math.ceil(costBasis);  // Round up to nearest dollar
    
    // Store holding data for chain loading
    window.ccHoldingData = { holding, costBasis, contracts, chainId };
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'sellCallModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:420px; padding:24px; border:1px solid #ffaa00;">
            <h2 style="color:#ffaa00; margin:0 0 16px 0;">📞 Sell Covered Call</h2>
            
            <div style="background:rgba(255,170,0,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <div style="font-size:24px; font-weight:bold; color:#00ff88;">${holding.ticker}</div>
                <div style="color:#888; font-size:14px;">${holding.shares} shares @ $${costBasis.toFixed(2)} cost basis</div>
                <div style="color:#666; font-size:11px; margin-top:4px;">🔗 Links to wheel chain (premium reduces cost basis)</div>
            </div>
            
            <!-- Strike Range + Load Chain -->
            <div style="margin-bottom:16px;">
                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <select id="ccStrikeRange" style="flex:0 0 auto; padding:8px; background:#0d0d1a; border:1px solid #333; color:#aaa; border-radius:6px; font-size:12px; cursor:pointer;" title="How many strikes to fetch from Schwab">
                        <option value="30">Nearby (30)</option>
                        <option value="60" selected>Wide (60)</option>
                        <option value="100">Extra Wide (100)</option>
                        <option value="ALL">All Strikes</option>
                    </select>
                    <button onclick="window.loadCCChain('${holding.ticker}')" 
                            style="flex:1; padding:10px; background:rgba(0,217,255,0.2); border:1px solid #00d9ff; color:#00d9ff; border-radius:6px; cursor:pointer; font-size:13px; font-weight:bold;">
                        🔄 Load Options Chain
                    </button>
                </div>
                <div id="ccChainStatus" style="text-align:center; font-size:11px; color:#888;">Click to load live strikes & premiums</div>
            </div>
            
            <div style="margin-bottom:12px;">
                <label style="color:#888; font-size:12px;">Expiration Date</label>
                <select id="ccExpiry" onchange="window.onCCExpiryChange(${costBasis})"
                        style="width:100%; padding:10px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px; font-size:14px; cursor:pointer;">
                    <option value="">Load chain first or enter manually...</option>
                </select>
            </div>
            
            <div style="margin-bottom:12px;">
                <label style="color:#888; font-size:12px;">Strike Price</label>
                <select id="ccStrike" onchange="window.onCCStrikeChange()"
                        style="width:100%; padding:10px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px; font-size:14px; cursor:pointer;">
                    <option value="">Select expiry first...</option>
                </select>
            </div>
            
            <div style="margin-bottom:12px;">
                <label style="color:#888; font-size:12px;">Premium Received (per share)</label>
                <input id="ccPremium" type="number" step="0.01" placeholder="e.g., 1.50"
                       oninput="window.updateCCPreview(${costBasis}, ${contracts})"
                       style="width:100%; padding:10px; background:#0d0d1a; border:1px solid #00ff88; color:#00ff88; border-radius:4px; font-size:16px;">
            </div>
            
            <div style="margin-bottom:12px;">
                <label style="color:#888; font-size:12px;">Contracts</label>
                <input id="ccContracts" type="number" min="1" value="${contracts}" 
                       style="width:100%; padding:10px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px; font-size:16px;">
            </div>
            
            <div id="ccPreview" style="background:rgba(0,255,136,0.1); padding:12px; border-radius:8px; margin-bottom:16px; border:1px solid rgba(0,255,136,0.3);">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span style="color:#888;">Total Premium:</span>
                    <span id="ccTotalPremium" style="color:#00ff88; font-weight:bold;">$0</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#888;">New Cost Basis:</span>
                    <span id="ccNewBasis" style="color:#00d9ff; font-weight:bold;">$${costBasis.toFixed(2)}</span>
                </div>
            </div>
            
            <div style="display:flex; gap:12px;">
                <button onclick="window.confirmSellCall(${holdingId}, ${chainId})" 
                        style="flex:1; padding:12px; background:linear-gradient(135deg, #ffaa00, #ff8c00); border:none; border-radius:8px; color:#000; font-weight:bold; cursor:pointer;">
                    Sell Call
                </button>
                <button onclick="document.getElementById('sellCallModal').remove()" 
                        style="flex:1; padding:12px; background:#333; border:none; border-radius:8px; color:#888; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Auto-load chain
    setTimeout(() => window.loadCCChain(holding.ticker), 100);
}
window.sellCallAgainstShares = sellCallAgainstShares;

/**
 * Load options chain for covered call modal
 */
window.loadCCChain = async function(ticker) {
    const statusEl = document.getElementById('ccChainStatus');
    if (!statusEl) return;
    
    statusEl.textContent = '⏳ Loading options chain...';
    statusEl.style.color = '#00d9ff';
    
    try {
        // Get user's selected strike range
        const rangeVal = document.getElementById('ccStrikeRange')?.value || '60';
        const chainOptions = rangeVal === 'ALL' ? { range: 'ALL' } : { strikeCount: rangeVal };
        const chain = await window.fetchOptionsChain(ticker, chainOptions);
        
        if (!chain || !chain.calls || chain.calls.length === 0) {
            throw new Error('No call options available');
        }
        
        window.ccChainData = chain.calls;
        
        // Fetch spot price for filtering OTM calls - try Schwab first (includes extended hours)
        let spotPrice = null;
        try {
            const quoteRes = await fetch(`/api/schwab/quote/${ticker}`);
            if (quoteRes.ok) {
                const quoteData = await quoteRes.json();
                const quote = quoteData?.quote || quoteData;
                // Use extended hours price if available
                spotPrice = quote?.postMarketLastPrice || quote?.preMarketLastPrice || quote?.lastPrice;
            }
        } catch (e) { /* fallback below */ }
        
        if (!spotPrice) {
            try {
                const yahooRes = await fetch(`/api/yahoo/${ticker}`);
                if (yahooRes.ok) {
                    const yahooData = await yahooRes.json();
                    spotPrice = yahooData?.chart?.result?.[0]?.meta?.regularMarketPrice;
                }
            } catch (e) { /* use cost basis as fallback */ }
        }
        
        window.ccSpotPrice = spotPrice;
        
        // Get unique expiries (future dates only)
        const today = new Date();
        const expiries = [...new Set(chain.calls.map(c => c.expiration))]
            .filter(exp => new Date(exp) > today)
            .sort((a, b) => new Date(a) - new Date(b))
            .slice(0, 12);
        
        if (expiries.length === 0) {
            throw new Error('No future expirations found');
        }
        
        // Populate expiry dropdown
        const expirySelect = document.getElementById('ccExpiry');
        expirySelect.innerHTML = '<option value="">Select expiry...</option>' +
            expiries.map(exp => {
                const dte = Math.round((new Date(exp) - today) / (1000 * 60 * 60 * 24));
                return `<option value="${exp}">${exp} (${dte}d)</option>`;
            }).join('');
        
        const spotInfo = spotPrice ? ` | Spot: $${spotPrice.toFixed(2)}` : '';
        statusEl.textContent = `✅ Loaded ${chain.calls.length} strikes${spotInfo}`;
        statusEl.style.color = '#00ff88';
        
    } catch (err) {
        console.error('[CC] Chain load failed:', err);
        statusEl.textContent = `⚠️ ${err.message} - enter manually`;
        statusEl.style.color = '#ffaa00';
    }
};

/**
 * When CC expiry changes, populate strikes
 */
window.onCCExpiryChange = function(costBasis) {
    const expiry = document.getElementById('ccExpiry').value;
    if (!expiry || !window.ccChainData) return;
    
    // Get spot price (fetched during chain load) - fallback to cost basis if unavailable
    const spotPrice = window.ccSpotPrice || costBasis;
    
    // Filter to selected expiry, show strikes from 10% below spot UP TO at least cost basis + 10%
    // This ensures users can always see strikes at/above their cost basis for profitable assignment
    const minStrike = spotPrice * 0.90;
    const maxStrike = Math.max(costBasis * 1.10, spotPrice * 1.30);  // Whichever is higher
    const callsAtExpiry = window.ccChainData
        .filter(c => c.expiration === expiry && c.strike >= minStrike && c.strike <= maxStrike)
        .sort((a, b) => a.strike - b.strike);
    
    const strikeSelect = document.getElementById('ccStrike');
    
    if (callsAtExpiry.length === 0) {
        strikeSelect.innerHTML = '<option value="">No strikes available</option>';
        return;
    }
    
    strikeSelect.innerHTML = '<option value="">Select strike...</option>' +
        callsAtExpiry.map(c => {
            const mid = ((c.bid + c.ask) / 2).toFixed(2);
            const delta = c.delta ? ` Δ${(Math.abs(c.delta) * 100).toFixed(0)}` : '';
            const isOTM = c.strike > spotPrice;
            const isAboveCost = c.strike >= costBasis;
            // OTM and above cost = safest (won't get called, profit if assigned)
            // ITM but above cost = will get called but profit
            // Below cost = risky (would lose on shares)
            let prefix = '⚠️';  // Below cost basis
            if (isOTM && isAboveCost) prefix = '✅';  // OTM and profitable = best
            else if (isOTM) prefix = '📍';  // OTM but below cost = unusual
            else if (isAboveCost) prefix = '⚡';  // ITM but profitable = will assign
            return `<option value="${c.strike}" data-premium="${mid}">${prefix} $${c.strike} ($${c.bid} bid | ${mid}${delta})</option>`;
        }).join('');
};

/**
 * When CC strike changes, auto-fill premium
 */
window.onCCStrikeChange = function() {
    const strikeSelect = document.getElementById('ccStrike');
    const selected = strikeSelect.options[strikeSelect.selectedIndex];
    
    if (!selected || !selected.value) return;
    
    const premium = selected.getAttribute('data-premium');
    if (premium) {
        document.getElementById('ccPremium').value = premium;
        // Trigger preview update
        const { costBasis, contracts } = window.ccHoldingData || {};
        if (costBasis && contracts) {
            window.updateCCPreview(costBasis, contracts);
        }
    }
};

/**
 * Update the covered call preview display
 */
window.updateCCPreview = function(costBasis, contracts) {
    const premium = parseFloat(document.getElementById('ccPremium')?.value) || 0;
    const numContracts = parseInt(document.getElementById('ccContracts')?.value) || contracts;
    const totalPremium = premium * 100 * numContracts;
    const newBasis = costBasis - (totalPremium / (numContracts * 100));
    
    const totalEl = document.getElementById('ccTotalPremium');
    const basisEl = document.getElementById('ccNewBasis');
    
    if (totalEl) totalEl.textContent = `+$${totalPremium.toFixed(0)}`;
    if (basisEl) basisEl.textContent = `$${newBasis.toFixed(2)}`;
};

/**
 * Confirm and create the covered call position linked to chain
 */
window.confirmSellCall = function(holdingId, chainId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) return;
    
    const strike = parseFloat(document.getElementById('ccStrike')?.value);
    const premium = parseFloat(document.getElementById('ccPremium')?.value);
    const expiry = document.getElementById('ccExpiry')?.value;
    const contracts = parseInt(document.getElementById('ccContracts')?.value) || 1;
    
    if (!strike || !premium || !expiry) {
        showNotification('Please fill in all fields', 'error');
        return;
    }
    
    // Calculate DTE
    const expiryDate = new Date(expiry);
    const today = new Date();
    const dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    
    // Create the covered call position with the SAME chainId
    const position = {
        id: Date.now(),
        chainId: chainId,  // KEY: Links to the wheel chain!
        ticker: holding.ticker,
        type: 'covered_call',
        strike: strike,
        premium: premium,
        contracts: contracts,
        expiry: expiry,
        dte: dte,
        openDate: new Date().toISOString().split('T')[0],
        status: 'open',
        broker: holding.broker || 'Schwab',
        linkedHoldingId: holdingId,
        isCall: true,
        costBasis: holding.costBasis  // Track what our shares cost
    };
    
    // Add to positions
    if (!Array.isArray(state.positions)) state.positions = [];
    state.positions.push(position);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Update holding to link to this call
    holding.linkedCallId = position.id;
    localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
    
    // Close modal
    document.getElementById('sellCallModal')?.remove();
    
    // Refresh displays
    if (typeof renderPositions === 'function') renderPositions();
    renderHoldings();
    
    const totalPremium = premium * 100 * contracts;
    showNotification(`📞 Sold ${holding.ticker} $${strike} call for +$${totalPremium.toFixed(0)} (linked to wheel chain)`, 'success');
};

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
        // Get balances from AccountService (single source of truth)
        const buyingPower = AccountService.getBuyingPower() || 0;
        const accountValue = AccountService.getAccountValue() || 0;
        
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
 * Uses CHAIN-BASED accounting - roll chains count as 1 trade, not multiple
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
    
    // Group by chainId for chain-aware calculations
    const chainPnL = {};
    closed.forEach(p => {
        const chainId = p.chainId || p.id;
        if (!chainPnL[chainId]) {
            chainPnL[chainId] = { 
                ticker: p.ticker, 
                totalPnL: 0, 
                legs: 0,
                totalPremium: 0,
                totalDaysHeld: 0,
                daysHeldCount: 0
            };
        }
        chainPnL[chainId].totalPnL += getPnL(p);
        chainPnL[chainId].legs++;
        if (p.premium > 0) {
            chainPnL[chainId].totalPremium += p.premium * 100 * (p.contracts || 1);
        }
        if (p.daysHeld != null) {
            chainPnL[chainId].totalDaysHeld += p.daysHeld;
            chainPnL[chainId].daysHeldCount++;
        }
    });
    
    // Convert to array
    const chains = Object.entries(chainPnL).map(([chainId, data]) => ({
        chainId,
        ...data,
        isChain: data.legs > 1
    }));
    
    // Win/Loss by CHAIN (not individual legs)
    const chainWins = chains.filter(c => c.totalPnL > 0);
    const chainLosses = chains.filter(c => c.totalPnL < 0);
    const chainCount = chains.length;
    
    // Win rate based on chains
    const winRate = chainCount > 0 ? (chainWins.length / chainCount * 100).toFixed(1) : 0;
    setEl('dashWinRate', `${winRate}% (${chainWins.length}W/${chainLosses.length}L)`);
    setEl('dashTotalTrades', `${chainCount} chains`);
    
    // Average DTE held (sum across all legs in chains)
    const totalDaysHeld = chains.reduce((sum, c) => sum + c.totalDaysHeld, 0);
    const daysHeldCount = chains.reduce((sum, c) => sum + c.daysHeldCount, 0);
    const avgDTE = daysHeldCount > 0 
        ? (totalDaysHeld / daysHeldCount).toFixed(1) 
        : '—';
    setEl('dashAvgDTE', avgDTE + ' days');
    
    // Average premium per chain
    const totalPremium = chains.reduce((sum, c) => sum + c.totalPremium, 0);
    const avgPremium = chainCount > 0 ? (totalPremium / chainCount).toFixed(0) : 0;
    setEl('dashAvgPremium', '$' + Number(avgPremium).toLocaleString());
    
    // Group by ticker (using chain totals)
    const byTicker = {};
    chains.forEach(c => {
        const ticker = c.ticker || 'Unknown';
        if (!byTicker[ticker]) byTicker[ticker] = { wins: 0, losses: 0, totalPnL: 0 };
        if (c.totalPnL > 0) byTicker[ticker].wins++;
        else if (c.totalPnL < 0) byTicker[ticker].losses++;
        byTicker[ticker].totalPnL += c.totalPnL;
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
    
    // Biggest win/loss BY CHAIN
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
        const positions = (state.positions || []).filter(p => p.status === 'open').map(p => {
            const isSpread = p.type?.includes('_spread');
            const isDebit = ['long_call', 'long_put', 'long_call_leaps', 'skip_call', 'call_debit_spread', 'put_debit_spread'].includes(p.type);
            
            // Calculate unrealized P/L
            let unrealizedPnL = null;
            let unrealizedPnLPct = null;
            if (p.lastOptionPrice !== undefined && p.premium > 0) {
                const entryValue = p.premium * 100 * (p.contracts || 1);
                const currentValue = p.lastOptionPrice * 100 * (p.contracts || 1);
                unrealizedPnL = isDebit ? currentValue - entryValue : entryValue - currentValue;
                unrealizedPnLPct = isDebit 
                    ? ((p.lastOptionPrice - p.premium) / p.premium) * 100
                    : ((p.premium - p.lastOptionPrice) / p.premium) * 100;
            }
            
            return {
                ticker: p.ticker,
                type: p.type,
                strike: p.strike,
                // Include spread-specific fields
                sellStrike: p.sellStrike,
                buyStrike: p.buyStrike,
                spreadWidth: isSpread ? Math.abs((p.sellStrike || 0) - (p.buyStrike || 0)) : null,
                expiry: p.expiry,
                dte: p.dte,
                contracts: p.contracts,
                premium: p.premium,
                // Current option price and P/L
                lastOptionPrice: p.lastOptionPrice || null,
                unrealizedPnL: unrealizedPnL,
                unrealizedPnLPct: unrealizedPnLPct,
                // For spreads, calculate max profit/loss
                maxProfit: isSpread ? (p.type?.includes('credit') 
                    ? p.premium * 100 * (p.contracts || 1) 
                    : (Math.abs((p.sellStrike || 0) - (p.buyStrike || 0)) - p.premium) * 100 * (p.contracts || 1)) : null,
                maxLoss: isSpread ? (p.type?.includes('credit')
                    ? (Math.abs((p.sellStrike || 0) - (p.buyStrike || 0)) - p.premium) * 100 * (p.contracts || 1)
                    : p.premium * 100 * (p.contracts || 1)) : null,
                delta: p._delta || 0,
                theta: p._theta || 0,
                currentSpot: p.currentSpot || null,
                riskPercent: parseFloat(document.getElementById(`risk-cell-${p.id}`)?.textContent?.match(/\\d+/)?.[0] || 0)
            };
        });
        
        // Get selected AI model (global with local override)
        const selectedModel = window.getSelectedAIModel?.('aiModelSelect') || 'qwen2.5:14b';
        
        // Get buying power for diversification recommendations
        const buyingPower = AccountService.getBuyingPower() || 25000;
        
        // Call AI audit endpoint
        const res = await fetch('/api/ai/portfolio-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                positions,
                buyingPower,
                includeDiversification: true,
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
        
        // Show audit results in modal (pass diversification candidates for order buttons)
        showAuditModal(result.audit, result.model, result.diversificationCandidates);
        
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
 * @param {string} audit - AI audit text
 * @param {string} model - Model used
 * @param {Array} diversificationCandidates - Optional structured data for order buttons
 */
function showAuditModal(audit, model, diversificationCandidates = []) {
    // Store candidates globally for order functions
    window._diversificationCandidates = diversificationCandidates;
    
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
    
    // Build diversification cards with order buttons
    let diversificationHtml = '';
    if (diversificationCandidates && diversificationCandidates.length > 0) {
        diversificationHtml = `
            <div style="margin-top:20px; padding-top:15px; border-top:1px solid rgba(255,255,255,0.1);">
                <h2 style="color:#ffaa00; margin:0 0 15px 0;">🎯 Diversification Opportunities</h2>
                <p style="color:#888; font-size:12px; margin-bottom:15px;">Click "Preview Order" to see full details before sending to Schwab.</p>
                <div style="display:flex; flex-direction:column; gap:10px;">
                    ${diversificationCandidates.map((c, i) => {
                        const rangeColor = c.rangePosition < 30 ? '#00ff88' : c.rangePosition > 70 ? '#ff5252' : '#ffaa00';
                        const rangeLabel = c.rangePosition < 30 ? 'Near lows' : c.rangePosition > 70 ? 'Near highs' : 'Mid-range';
                        return `
                            <div style="background:rgba(139,92,246,0.1); border:1px solid rgba(139,92,246,0.3); border-radius:8px; padding:12px;">
                                <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
                                    <div style="flex:1; min-width:200px;">
                                        <div style="font-size:14px; font-weight:bold; color:#fff; margin-bottom:6px;">
                                            ${c.ticker} <span style="color:#888; font-weight:normal;">(${c.sector})</span>
                                            <span style="font-size:11px; color:${rangeColor}; margin-left:8px;">${rangeLabel}</span>
                                        </div>
                                        <div style="font-size:12px; color:#ddd;">
                                            Sell <strong style="color:#00d9ff;">$${c.suggestedStrike} PUT</strong> exp ${c.expiry} (${c.dte}d)
                                        </div>
                                        <div style="font-size:11px; color:#888; margin-top:4px;">
                                            Premium: <span style="color:#00ff88;">$${c.putPremium?.toFixed(2) || '?'}</span> | 
                                            <span style="color:#ffaa00;">${c.annualizedYield}% ann.</span> | 
                                            ${c.cushionPct}% cushion
                                            ${c.putDelta ? ` | Δ${Math.round(c.putDelta * 100)}` : ''}
                                        </div>
                                        <div style="font-size:11px; color:#666; margin-top:2px;">
                                            Collateral: $${c.collateral?.toLocaleString() || '?'}
                                        </div>
                                    </div>
                                    <div style="display:flex; gap:6px;">
                                        <button onclick="window.previewSchwabOrder(${i})" 
                                            style="font-size:11px; padding:6px 12px; background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.5); color:#00d9ff; border-radius:4px; cursor:pointer;">
                                            📋 Preview
                                        </button>
                                        <button onclick="window.sendToSchwab(${i})" 
                                            style="font-size:11px; padding:6px 12px; background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.5); color:#00ff88; border-radius:4px; cursor:pointer;">
                                            📤 Send
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
                <p style="color:#666; font-size:10px; margin-top:10px; font-style:italic;">
                    ⚠️ Always verify earnings dates. Orders sent as LIMIT at displayed premium.
                </p>
            </div>
        `;
    }
    
    // Remove diversification section from audit text (we render it separately with buttons)
    let auditText = audit;
    const divOpportunityIdx = audit.indexOf('## 🎯 DIVERSIFICATION OPPORTUNITIES');
    if (divOpportunityIdx > -1) {
        auditText = audit.substring(0, divOpportunityIdx).trim();
    }
    
    const modal = createModal('portfolioAuditModal');
    modal.innerHTML = `
        <div style="background:#1a1a2e; border:1px solid rgba(139,92,246,0.5); border-radius:10px; max-width:750px; max-height:85vh; overflow:hidden; display:flex; flex-direction:column;">
            ${modalHeader('🤖 AI Portfolio Audit', 'portfolioAuditModal')}
            <div style="padding:20px; overflow-y:auto; flex:1;">
                <div style="background:rgba(139,92,246,0.1); padding:10px 12px; border-radius:6px; margin-bottom:15px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label style="font-size:11px; color:#888;">Model:</label>
                        <select id="auditModelSelect" style="font-size:11px; padding:4px 8px; background:#0d0d1a; color:#ddd; border:1px solid #444; border-radius:4px;">
                            <option value="qwen2.5:7b">Qwen 7B ⭐</option>
                            <option value="qwen2.5:14b">Qwen 14B</option>
                            <option value="qwen2.5:32b">Qwen 32B</option>
                            <option value="deepseek-r1:32b">DeepSeek-R1 32B 🧮</option>
                            <option value="llama3.1:8b">Llama 3.1 8B</option>
                            <option value="mistral:7b">Mistral 7B</option>
                            <option value="grok-3">🚀 Grok-3 (Cloud)</option>
                            <option value="grok-4">🧠 Grok-4 (Reasoning)</option>
                            <option value="grok-4-1-fast">⚡ Grok 4.1 Fast</option>
                            <option value="grok-3-mini">🚀 Grok-3 Mini</option>
                        </select>
                        <button id="rerunAuditBtn" onclick="window.rerunAuditWithModel()" style="font-size:10px; padding:4px 10px; background:#8b5cf6; color:#fff; border:none; border-radius:4px; cursor:pointer;">🔄 Re-run</button>
                    </div>
                    <span style="font-size:10px; color:#666;">Last run: <span style="color:#8b5cf6;">${model}</span></span>
                </div>
                <div id="auditContent" style="color:#ddd; line-height:1.6; font-size:13px;">
                    ${formatAudit(auditText)}
                </div>
                ${diversificationHtml}
            </div>
            <div style="padding:15px; border-top:1px solid rgba(255,255,255,0.1); text-align:right;">
                <button onclick="document.getElementById('portfolioAuditModal').remove()" style="background:rgba(139,92,246,0.3); border:1px solid rgba(139,92,246,0.5); color:#fff; padding:8px 20px; border-radius:6px; cursor:pointer;">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Set the dropdown to the model that was used
    const select = document.getElementById('auditModelSelect');
    if (select) {
        select.value = model;
    }
}

/**
 * Re-run portfolio audit with selected model from the modal dropdown
 */
window.rerunAuditWithModel = async function() {
    const select = document.getElementById('auditModelSelect');
    const btn = document.getElementById('rerunAuditBtn');
    const content = document.getElementById('auditContent');
    
    if (!select || !content) return;
    
    const selectedModel = select.value;
    
    // Show loading state
    if (btn) {
        btn.textContent = '⏳ Running...';
        btn.disabled = true;
    }
    content.innerHTML = '<div style="text-align:center; padding:40px; color:#888;">🔄 Running audit with ' + selectedModel + '...</div>';
    
    try {
        // Get current Greeks
        const greeks = window._lastPortfolioGreeks || { delta: 0, theta: 0, gamma: 0, vega: 0 };
        
        // Get positions
        const positions = (state.positions || []).filter(p => p.status === 'open').map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            expiry: p.expiry,
            dte: p.dte,
            contracts: p.contracts,
            premium: p.premium,
            delta: p._delta || 0,
            theta: p._theta || 0
        }));
        
        // Get closed stats
        const closed = state.closedPositions || [];
        const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
        const wins = closed.filter(p => getPnL(p) > 0);
        const losses = closed.filter(p => getPnL(p) < 0);
        const totalWins = wins.reduce((sum, p) => sum + getPnL(p), 0);
        const totalLosses = Math.abs(losses.reduce((sum, p) => sum + getPnL(p), 0));
        
        const res = await fetch('/api/ai/portfolio-audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: selectedModel,
                positions,
                greeks,
                closedStats: {
                    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
                    profitFactor: totalLosses > 0 ? totalWins / totalLosses : 0,
                    avgWin: wins.length > 0 ? totalWins / wins.length : 0,
                    avgLoss: losses.length > 0 ? totalLosses / losses.length : 0,
                    totalTrades: closed.length
                }
            })
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'AI audit failed');
        }
        
        const result = await res.json();
        
        // Format and display
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
        
        content.innerHTML = formatAudit(result.audit);
        
        // Update the "Last run" label
        const modal = document.getElementById('portfolioAuditModal');
        if (modal) {
            const lastRunSpan = modal.querySelector('span[style*="color:#8b5cf6"]');
            if (lastRunSpan) lastRunSpan.textContent = result.model;
        }
        
    } catch (err) {
        content.innerHTML = `<div style="color:#ff5252;">❌ Error: ${err.message}</div>`;
    } finally {
        if (btn) {
            btn.textContent = '🔄 Re-run';
            btn.disabled = false;
        }
    }
};

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

// ============================================================
// SCHWAB ORDER INTEGRATION
// ============================================================

/**
 * Preview a Schwab order from diversification candidates
 * Shows order details before execution
 */
window.previewSchwabOrder = async function(candidateIndex) {
    const candidates = window._diversificationCandidates || [];
    const candidate = candidates[candidateIndex];
    
    if (!candidate) {
        showNotification('Candidate not found', 'error');
        return;
    }
    
    // Show loading state
    const existingModal = document.getElementById('schwabOrderModal');
    if (existingModal) existingModal.remove();
    
    const modal = createModal('schwabOrderModal');
    modal.innerHTML = `
        <div style="background:#1a1a2e; border:1px solid rgba(0,217,255,0.5); border-radius:10px; max-width:500px; padding:20px;">
            ${modalHeader('📋 Order Preview', 'schwabOrderModal')}
            <div style="padding:20px; text-align:center; color:#888;">
                <div style="font-size:24px; margin-bottom:10px;">⏳</div>
                Loading order preview for ${candidate.ticker}...
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const res = await fetch('/api/schwab/preview-option-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: candidate.ticker,
                strike: candidate.suggestedStrike,
                expiry: candidate.expiry,
                type: 'P',
                instruction: 'SELL_TO_OPEN',
                quantity: 1,
                limitPrice: candidate.putPremium
            })
        });
        
        const result = await res.json();
        
        if (!res.ok || result.error) {
            throw new Error(result.error || 'Preview failed');
        }
        
        // Use live pricing if available
        const hasLivePricing = result.liveBid !== null && result.liveAsk !== null && result.liveBid > 0;
        const liveBid = result.liveBid || 0;
        const liveAsk = result.liveAsk || 0;
        const liveMid = result.liveMid || 0;
        const suggestedPrice = hasLivePricing ? liveBid : candidate.putPremium; // For sells, use bid
        const totalCredit = suggestedPrice * 100;
        
        // Store live pricing for when sending order
        window._schwabLivePricing = {
            candidateIndex,
            hasLivePricing,
            suggestedPrice,
            liveBid,
            liveAsk,
            liveMid
        };
        
        // Update modal with preview details
        const collateralOk = result.buyingPower >= result.collateralRequired;
        
        modal.innerHTML = `
            <div style="background:#1a1a2e; border:1px solid rgba(0,217,255,0.5); border-radius:10px; max-width:550px;">
                ${modalHeader('📋 Order Preview - ' + candidate.ticker, 'schwabOrderModal')}
                <div style="padding:20px;">
                    <div style="background:rgba(0,217,255,0.1); border:1px solid rgba(0,217,255,0.3); border-radius:8px; padding:15px; margin-bottom:15px;">
                        <div style="font-size:16px; font-weight:bold; color:#00d9ff; margin-bottom:10px;">
                            SELL_TO_OPEN 1x ${candidate.ticker} $${candidate.suggestedStrike} P exp ${candidate.expiry} @ $${suggestedPrice?.toFixed(2)}
                        </div>
                        <div style="font-size:12px; color:#888; font-family:monospace;">
                            OCC Symbol: ${result.occSymbol}
                        </div>
                    </div>
                    
                    ${hasLivePricing ? `
                        <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:8px; padding:12px; margin-bottom:15px;">
                            <div style="font-size:10px; color:#888; text-transform:uppercase; margin-bottom:6px;">📈 Live Schwab Pricing</div>
                            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
                                <div>
                                    <div style="color:#888; font-size:10px;">Bid</div>
                                    <div style="color:#00ff88; font-size:18px; font-weight:bold;">$${liveBid.toFixed(2)}</div>
                                </div>
                                <div>
                                    <div style="color:#888; font-size:10px;">Mid</div>
                                    <div style="color:#00d9ff; font-size:18px;">$${liveMid.toFixed(2)}</div>
                                </div>
                                <div>
                                    <div style="color:#888; font-size:10px;">Ask</div>
                                    <div style="color:#ffaa00; font-size:18px;">$${liveAsk.toFixed(2)}</div>
                                </div>
                            </div>
                        </div>
                    ` : `
                        <div style="background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3); border-radius:8px; padding:10px; margin-bottom:15px;">
                            <div style="color:#ffaa00; font-size:12px;">⚠️ Using staged price ($${candidate.putPremium?.toFixed(2)}) - live quote unavailable</div>
                        </div>
                    `}
                    
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                            <div style="font-size:11px; color:#888;">Limit Price (Bid)</div>
                            <div style="font-size:18px; color:#00ff88;">$${suggestedPrice?.toFixed(2) || '?'}</div>
                        </div>
                        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                            <div style="font-size:11px; color:#888;">Total Credit</div>
                            <div style="font-size:18px; color:#00ff88;">$${totalCredit.toFixed(0)}</div>
                        </div>
                        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                            <div style="font-size:11px; color:#888;">Collateral Required</div>
                            <div style="font-size:18px; color:#ffaa00;">$${result.collateralRequired?.toLocaleString()}</div>
                        </div>
                        <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
                            <div style="font-size:11px; color:#888;">Buying Power</div>
                            <div style="font-size:18px; color:${collateralOk ? '#00ff88' : '#ff5252'};">$${result.buyingPower?.toLocaleString()}</div>
                        </div>
                    </div>
                    
                    ${result.previewError ? `
                        <div style="background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3); border-radius:6px; padding:10px; margin-bottom:15px;">
                            <div style="font-size:11px; color:#ffaa00;">⚠️ Preview Warning</div>
                            <div style="font-size:12px; color:#ddd;">${result.previewError}</div>
                        </div>
                    ` : ''}
                    
                    ${!collateralOk ? `
                        <div style="background:rgba(255,82,82,0.1); border:1px solid rgba(255,82,82,0.3); border-radius:6px; padding:10px; margin-bottom:15px;">
                            <div style="font-size:12px; color:#ff5252;">❌ Insufficient buying power for this trade</div>
                        </div>
                    ` : ''}
                    
                    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                        <button onclick="document.getElementById('schwabOrderModal').remove()" 
                            style="padding:10px 20px; background:rgba(136,136,136,0.2); border:1px solid #666; color:#ddd; border-radius:6px; cursor:pointer;">
                            Cancel
                        </button>
                        <button onclick="window.confirmSchwabOrder(${candidateIndex})" 
                            style="padding:10px 20px; background:${collateralOk ? 'rgba(0,255,136,0.2)' : 'rgba(136,136,136,0.2)'}; border:1px solid ${collateralOk ? '#00ff88' : '#666'}; color:${collateralOk ? '#00ff88' : '#888'}; border-radius:6px; cursor:pointer; ${!collateralOk ? 'pointer-events:none;' : ''}"
                            ${!collateralOk ? 'disabled' : ''}>
                            📤 Send to Schwab
                        </button>
                    </div>
                </div>
            </div>
        `;
        
    } catch (e) {
        modal.innerHTML = `
            <div style="background:#1a1a2e; border:1px solid rgba(255,82,82,0.5); border-radius:10px; max-width:450px; padding:20px;">
                ${modalHeader('❌ Preview Failed', 'schwabOrderModal')}
                <div style="padding:20px;">
                    <div style="color:#ff5252; margin-bottom:15px;">${e.message}</div>
                    <div style="color:#888; font-size:12px; margin-bottom:20px;">
                        Make sure you're connected to Schwab in the Settings tab.
                    </div>
                    <button onclick="document.getElementById('schwabOrderModal').remove()" 
                        style="padding:8px 16px; background:rgba(136,136,136,0.2); border:1px solid #666; color:#ddd; border-radius:6px; cursor:pointer;">
                        Close
                    </button>
                </div>
            </div>
        `;
    }
};

/**
 * Skip preview and go straight to confirmation (for quick send)
 */
window.sendToSchwab = async function(candidateIndex) {
    // Just call preview for now - user clicks "Send to Schwab" in the preview modal
    await window.previewSchwabOrder(candidateIndex);
};

/**
 * Actually execute the order after confirmation
 */
window.confirmSchwabOrder = async function(candidateIndex) {
    const candidates = window._diversificationCandidates || [];
    const candidate = candidates[candidateIndex];
    
    if (!candidate) {
        showNotification('Candidate not found', 'error');
        return;
    }
    
    // Update modal to show loading
    const modal = document.getElementById('schwabOrderModal');
    if (modal) {
        modal.querySelector('div').innerHTML = `
            ${modalHeader('📤 Sending Order...', 'schwabOrderModal')}
            <div style="padding:40px; text-align:center;">
                <div style="font-size:32px; margin-bottom:15px;">⏳</div>
                <div style="color:#00d9ff;">Sending order to Schwab...</div>
                <div style="color:#888; font-size:12px; margin-top:10px;">${candidate.ticker} $${candidate.suggestedStrike} PUT</div>
            </div>
        `;
    }
    
    // Use live pricing if available from preview
    const livePricing = window._schwabLivePricing;
    const orderPrice = (livePricing?.candidateIndex === candidateIndex && livePricing?.hasLivePricing) 
        ? livePricing.suggestedPrice 
        : candidate.putPremium;
    
    try {
        const res = await fetch('/api/schwab/place-option-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: candidate.ticker,
                strike: candidate.suggestedStrike,
                expiry: candidate.expiry,
                type: 'P',
                instruction: 'SELL_TO_OPEN',
                quantity: 1,
                limitPrice: orderPrice,
                confirm: true  // Required safety flag
            })
        });
        
        const result = await res.json();
        
        if (!res.ok || !result.success) {
            throw new Error(result.error || 'Order failed');
        }
        
        // Clear live pricing
        window._schwabLivePricing = null;
        
        // Show success
        if (modal) {
            modal.querySelector('div').innerHTML = `
                ${modalHeader('✅ Order Sent!', 'schwabOrderModal')}
                <div style="padding:30px; text-align:center;">
                    <div style="font-size:48px; margin-bottom:15px;">✅</div>
                    <div style="font-size:16px; color:#00ff88; margin-bottom:10px;">Order sent to Schwab</div>
                    <div style="color:#888; font-size:13px; margin-bottom:20px;">
                        ${result.message}<br>
                        <span style="font-size:11px;">Check Schwab for order status (may be PENDING)</span>
                    </div>
                    <button onclick="document.getElementById('schwabOrderModal').remove()" 
                        style="padding:10px 25px; background:rgba(0,255,136,0.2); border:1px solid #00ff88; color:#00ff88; border-radius:6px; cursor:pointer;">
                        Done
                    </button>
                </div>
            `;
        }
        
        showNotification(`Order sent: ${candidate.ticker} $${candidate.suggestedStrike} PUT @ $${orderPrice.toFixed(2)}`, 'success');
        
    } catch (e) {
        console.error('Schwab order error:', e);
        
        if (modal) {
            modal.querySelector('div').innerHTML = `
                ${modalHeader('❌ Order Failed', 'schwabOrderModal')}
                <div style="padding:30px; text-align:center;">
                    <div style="font-size:48px; margin-bottom:15px;">❌</div>
                    <div style="font-size:14px; color:#ff5252; margin-bottom:15px;">${e.message}</div>
                    <div style="color:#888; font-size:12px; margin-bottom:20px;">
                        The order was not executed. Check Schwab for details.
                    </div>
                    <button onclick="document.getElementById('schwabOrderModal').remove()" 
                        style="padding:10px 25px; background:rgba(136,136,136,0.2); border:1px solid #666; color:#ddd; border-radius:6px; cursor:pointer;">
                        Close
                    </button>
                </div>
            `;
        }
        
        showNotification(`Order failed: ${e.message}`, 'error');
    }
};
