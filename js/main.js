// WheelHouse - Main Entry Point
// Initialization and tab management

// Using import map aliases - versions managed in index.html
import { state, resetSimulation, setAccountMode, updatePaperModeIndicator, setPaperAccountBalance, getPaperAccountBalance, setSelectedAccount, getAccountDisplayName } from 'state';
import { draw, drawPayoffChart, drawHistogram, drawPnLChart, drawProbabilityCone, drawHeatMap, drawGreeksChart } from 'charts';
import { runSingle, runBatch, resetAll } from 'simulation';
import { priceOptions, calcGreeks } from 'pricing';
import { calculateRoll, generateRecommendation, suggestOptimalRoll } from 'analysis';
import { fetchTickerPrice, fetchHeatMapPrice, fetchPositionTickerPrice } from 'api';
import { loadPositions, addPosition, editPosition, cancelEdit, renderPositions, updatePortfolioSummary } from 'positions';
import { loadClosedPositions, renderPortfolio, renderHoldings, formatPortfolioContextForAI } from 'portfolio';
import { initChallenges, renderChallenges } from 'challenges';
import { setupSliders, setupDatePicker, setupPositionDatePicker, setupRollDatePicker, updateDteDisplay, updateResults, updateDataTab, syncToSimulator } from 'ui';
import { showNotification } from 'utils';
import AccountService from 'AccountService';
import TradeCardService from 'TradeCardService';
import StreamingService from 'StreamingService';
import PositionsService from 'PositionsService';
import AlertService from 'AlertService';
import { renderPendingTrades } from 'tradeStaging';
import { formatAIResponse, extractThesisSummary, extractSection } from 'aiHelpers';
import 'aiFunctions';
import 'positionCheckup';
import 'strategyAdvisor';
import 'monteCarlo';
import 'wheelScanner';
import 'pmccCalculator';
import 'coach';
import SparkChartService from 'SparkChartService';

// =============================================================================
// PAPER TRADING BALANCE CALCULATIONS
// =============================================================================

/**
 * Calculate realistic paper trading balances with proper margin math
 * Uses the same logic as real margin accounts:
 * - Account Value = Your equity (what you set as balance)
 * - Capital at Risk = Sum of max loss on all positions
 * - Margin Used = Capital at Risk - Account Value (if negative, means using margin)
 * - Buying Power = Account Value * 2 - Capital at Risk (for margin accounts)
 * 
 * @param {number} accountValue - The paper account balance (equity)
 * @returns {Object} { accountValue, buyingPower, capitalAtRisk, marginUsed, cashAvailable }
 */
function calculatePaperBalances(accountValue) {
    // Calculate capital at risk from current positions
    const positions = state.positions || [];
    const openPositions = positions.filter(p => p.status === 'open');
    
    let capitalAtRisk = 0;
    for (const p of openPositions) {
        const isSpread = p.type?.includes('_spread');
        const isDebit = p.type?.includes('debit') || p.type?.includes('long_call') || p.type?.includes('long_put');
        
        if (isSpread) {
            if (p.maxLoss) {
                capitalAtRisk += p.maxLoss;
            } else {
                const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
                const premium = p.premium || 0;
                const maxLoss = isDebit 
                    ? premium * 100 * p.contracts
                    : (width - premium) * 100 * p.contracts;
                capitalAtRisk += maxLoss;
            }
        } else if (isDebit) {
            capitalAtRisk += ((p.premium || 0) * 100 * p.contracts);
        } else if (p.type === 'short_put' || p.type === 'buy_write') {
            capitalAtRisk += ((p.strike || 0) * 100 * p.contracts);
        }
    }
    
    // Margin used = how much capital at risk exceeds account value
    const marginUsed = Math.max(0, capitalAtRisk - accountValue);
    
    // Buying power for margin account = 2x equity minus capital already at risk
    // But cap at 2x account value (can't have more BP than margin allows)
    const maxBuyingPower = accountValue * 2;
    const buyingPower = Math.max(0, maxBuyingPower - capitalAtRisk);
    
    // Cash available = account value minus what's tied up (simplified)
    const cashAvailable = Math.max(0, accountValue - (capitalAtRisk / 2));
    
    return {
        accountValue,
        buyingPower,
        capitalAtRisk,
        marginUsed,
        cashAvailable,
        dayTradeBP: buyingPower * 2  // Day trade BP is typically 4x equity, or 2x buying power
    };
}

/**
 * Update balance display AND AccountService cache for paper trading
 * @param {number} accountValue - The paper account balance
 */
function updatePaperAccountBalances(accountValue) {
    const balances = calculatePaperBalances(accountValue);
    
    // Update DOM display
    updateBalanceDisplay(
        balances.buyingPower,
        balances.accountValue,
        balances.cashAvailable,
        balances.marginUsed,
        balances.dayTradeBP,
        'Paper',
        'PAPER'
    );
    
    // Update AccountService cache so leverage gauge gets correct values
    AccountService.updateCache({
        buyingPower: balances.buyingPower,
        accountValue: balances.accountValue,
        cashAvailable: balances.cashAvailable,
        marginUsed: balances.marginUsed,
        dayTradeBP: balances.dayTradeBP,
        accountType: 'PAPER',
        accountNumber: 'PAPER'
    });
    
    console.log('[Paper] Updated balances:', balances);
}

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
    
    console.log('[Account] initAccountDropdown starting, state.accountMode =', state.accountMode);
    
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
        console.log('[Account] Restoring selection, state.accountMode =', state.accountMode, 'state.selectedAccount =', state.selectedAccount);
        if (state.accountMode === 'paper') {
            console.log('[Account] Detected paper mode, setting dropdown and updating balances');
            select.value = 'paper';
            showPaperModeUI(true);
            // Update paper balances with proper margin math
            // Delay slightly to ensure positions are loaded
            setTimeout(() => {
                const accountValue = getPaperAccountBalance();
                updatePaperAccountBalances(accountValue);
                console.log('[Account] Paper mode restored, balances updated');
            }, 100);
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
        
        // Show paper balance with proper margin calculations
        const accountValue = getPaperAccountBalance();
        updatePaperAccountBalances(accountValue);
        
        showNotification(`📝 Switched to Paper Trading - $${accountValue.toLocaleString()} balance`, 'info');
        
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
        
        console.log('[Balances] Raw from Schwab:', {
            buyingPower: bal.buyingPower,
            marginBalance: bal.marginBalance,
            equity: bal.equity,
            liquidationValue: bal.liquidationValue
        });
        
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
 * Auto-link PMCC positions: Find covered calls that should be linked to LEAPS
 * This runs after Schwab sync to detect and preserve PMCC nesting
 */
function autoLinkPMCCPositions() {
    const positions = state.positions || [];
    let linked = 0;
    
    // Find all LEAPS (long calls with 1+ year to expiry)
    const leapsPositions = positions.filter(p => 
        (p.type === 'long_call' || p.type === 'long_call_leaps') &&
        p.dte >= 180  // At least 6 months out
    );
    
    // Find covered calls that might be part of PMCC
    const coveredCalls = positions.filter(p => 
        p.type === 'covered_call' &&
        !p.parentPositionId  // Not already linked
    );
    
    // For each covered call, see if there's a matching LEAPS on same ticker
    for (const cc of coveredCalls) {
        const matchingLeaps = leapsPositions.find(leaps => 
            leaps.ticker === cc.ticker &&
            leaps.strike < cc.strike  // LEAPS should have lower strike than short call
        );
        
        if (matchingLeaps) {
            cc.parentPositionId = matchingLeaps.id;
            linked++;
            console.log(`[PMCC] Auto-linked ${cc.ticker} CC $${cc.strike} → LEAPS $${matchingLeaps.strike}`);
        }
    }
    
    if (linked > 0) {
        // Save the updated positions
        import('state').then(({ getPositionsKey }) => {
            localStorage.setItem(getPositionsKey(), JSON.stringify(positions));
        });
        console.log(`[PMCC] Auto-linked ${linked} covered call(s) to LEAPS`);
    }
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
        
        // DETECT POSITIONS CLOSED ON SCHWAB
        // Find positions that exist locally but are no longer in Schwab
        const { getPositionsKey, getHoldingsKey, getClosedKey } = await import('state');
        let closedPositions = JSON.parse(localStorage.getItem(getClosedKey()) || '[]');
        let movedToClosed = 0;
        const positionsToRemove = [];
        
        for (const localPos of existingPositions) {
            // Skip if already marked closed
            if (localPos.status === 'closed') continue;
            // Skip if not from Schwab sync originally
            if (localPos.source !== 'schwab_sync' && localPos.broker !== 'Schwab') continue;
            
            // Check if this position still exists in Schwab
            const stillInSchwab = optionPositions.some(sp => 
                sp.ticker === localPos.ticker &&
                sp.strike === localPos.strike &&
                sp.expiry === localPos.expiry
            );
            
            if (!stillInSchwab) {
                // Position no longer in Schwab - move to closed
                console.log(`[Sync] Position closed on Schwab: ${localPos.ticker} $${localPos.strike} ${localPos.expiry}`);
                
                const closedPos = {
                    ...localPos,
                    status: 'closed',
                    closeDate: new Date().toISOString().split('T')[0],
                    closeReason: 'schwab_sync_detected',
                    closePrice: localPos.lastOptionPrice || 0,
                    realizedPnL: localPos.premium ? 
                        (localPos.premium - (localPos.lastOptionPrice || 0)) * 100 * localPos.contracts : 0
                };
                
                closedPositions.push(closedPos);
                positionsToRemove.push(localPos.id);
                movedToClosed++;
            }
        }
        
        // Remove closed positions from open list
        if (positionsToRemove.length > 0) {
            console.log(`[Sync] Removing ${movedToClosed} closed positions from open list`);
            existingPositions = existingPositions.filter(p => !positionsToRemove.includes(p.id));
            localStorage.setItem(getClosedKey(), JSON.stringify(closedPositions));
        }
        
        // Save to account-specific storage
        state.positions = existingPositions;
        state.holdings = existingHoldings;
        
        localStorage.setItem(getPositionsKey(), JSON.stringify(existingPositions));
        localStorage.setItem(getHoldingsKey(), JSON.stringify(existingHoldings));
        
        // Auto-link PMCC positions (covered calls to their parent LEAPS)
        autoLinkPMCCPositions();
        
        // Refresh UI
        loadPositions();
        renderHoldings();
        await fetchAccountBalancesForAccount(acct);
        
        // Show result
        const msg = [];
        if (imported > 0) msg.push(`${imported} new positions`);
        if (skipped > 0) msg.push(`${skipped} updated`);
        if (movedToClosed > 0) msg.push(`${movedToClosed} closed`);
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
    
    // Create modal (Electron doesn't support prompt())
    const modal = document.createElement('div');
    modal.id = 'paperBalanceModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #8b5cf6;border-radius:12px;padding:24px;width:350px;text-align:center;">
            <h3 style="margin:0 0 16px;color:#b9f;">💵 Paper Trading Balance</h3>
            <p style="color:#888;font-size:13px;margin-bottom:16px;">Set your starting balance for paper trading simulation.</p>
            <input type="text" id="paperBalanceInput" value="${currentBalance.toLocaleString()}" 
                   style="width:100%;padding:12px;font-size:18px;text-align:center;background:#0d0d1a;border:1px solid #444;border-radius:6px;color:#fff;margin-bottom:16px;"
                   onkeydown="if(event.key==='Enter')document.getElementById('confirmPaperBalance').click()">
            <div style="display:flex;gap:12px;justify-content:center;">
                <button onclick="document.getElementById('paperBalanceModal').remove()" 
                        style="padding:10px 24px;background:#333;color:#888;border:none;border-radius:6px;cursor:pointer;">
                    Cancel
                </button>
                <button id="confirmPaperBalance" onclick="window.confirmPaperBalance()" 
                        style="padding:10px 24px;background:#8b5cf6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">
                    Set Balance
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Focus and select input
    setTimeout(() => {
        const input = document.getElementById('paperBalanceInput');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);
};

/**
 * Confirm paper balance from modal
 */
window.confirmPaperBalance = function() {
    const input = document.getElementById('paperBalanceInput');
    if (!input) return;
    
    const newBalance = parseFloat(input.value.replace(/[,$]/g, ''));
    if (isNaN(newBalance) || newBalance <= 0) {
        showNotification('Invalid amount. Please enter a positive number.', 'error');
        return;
    }
    
    setPaperAccountBalance(newBalance);
    
    // Update display with proper margin calculations if in paper mode
    if (state.accountMode === 'paper') {
        updatePaperAccountBalances(newBalance);
    }
    
    // Close modal
    document.getElementById('paperBalanceModal')?.remove();
    
    showNotification(`📝 Paper account set to $${newBalance.toLocaleString()} - balances updated with positions`, 'success');
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
    
    // Note: Paper balance calculation moved to init() AFTER loadPositions()
    // to ensure positions are available for capital-at-risk calculation
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
window.drawPayoffChart = drawPayoffChart;  // For T+X controls and inline handlers

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
    
    // PRE-populate AccountService with paper balance BEFORE loadPositions
    // This ensures leverage gauge has something when renderPositions() runs
    // Will be recalculated with actual positions afterwards
    if (state.accountMode === 'paper') {
        const accountValue = getPaperAccountBalance();
        AccountService.updateCache({
            buyingPower: accountValue * 2,  // Initial estimate
            accountValue: accountValue,
            cashAvailable: accountValue,
            marginUsed: 0,
            dayTradeBP: accountValue * 4,
            accountType: 'PAPER',
            accountNumber: 'PAPER'
        });
        console.log('[Paper] Pre-populated AccountService before loading positions');
    }
    
    // Load saved positions
    loadPositions();
    loadClosedPositions();
    initChallenges();
    
    // If in paper mode, recalculate with actual positions now loaded
    if (state.accountMode === 'paper') {
        const accountValue = getPaperAccountBalance();
        updatePaperAccountBalances(accountValue);
        console.log('[Paper] Recalculated paper balances with loaded positions');
        // Re-render positions to update leverage gauge with correct data
        if (typeof renderPositions === 'function') {
            renderPositions();
        }
    }
    
    // Initialize real-time streaming for option quotes
    initStreamingService();
    
    // Restore collapsed section states
    setTimeout(() => window.restoreCollapsedStates?.(), 100);
    
    // Expose loadPositions to window for staged trade confirmation
    window.loadPositions = loadPositions;
    
    // Render pending trades if any
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
    
    // Initialize price alerts panel
    if (typeof window.renderAlertsPanel === 'function') {
        window.renderAlertsPanel();
    }
    
    // Request notification permission for price alerts
    if (typeof window.requestAlertPermission === 'function') {
        window.requestAlertPermission();
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

/**
 * Initialize real-time streaming service for option quotes
 */
function initStreamingService() {
    try {
        // Connect to Socket.IO server
        StreamingService.connect();
        
        // Listen for streamer status changes
        StreamingService.on('streamer-status', (status) => {
            console.log('[STREAMING] Status:', status.connected ? '✓ Connected' : '✗ Disconnected');
            updateStreamingIndicator(status.connected);
        });
        
        // Listen for option quotes
        StreamingService.on('option-quote', (quote) => {
            // StreamingService handles DOM updates automatically
            // Just log for debugging
            if (state.debugMode) {
                console.log('[QUOTE]', quote.symbol, `$${quote.mid?.toFixed(2) || '?'}`);
            }
        });
        
        // Subscribe to current positions after a short delay
        setTimeout(() => {
            if (state.positions && state.positions.length > 0) {
                StreamingService.subscribePositions(state.positions);
            }
        }, 1000);
        
        console.log('[STREAMING] Service initialized');
    } catch (e) {
        console.warn('[STREAMING] Init failed:', e.message);
    }
}

/**
 * Update streaming indicator in the header
 */
function updateStreamingIndicator(connected) {
    let indicator = document.getElementById('streamingIndicator');
    
    // Create indicator if it doesn't exist
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'streamingIndicator';
        indicator.className = 'streaming-status disconnected';
        indicator.innerHTML = `
            <span class="streaming-dot" style="width:6px; height:6px; border-radius:50%; background:#888;"></span>
            <span>STREAM</span>
        `;
        indicator.title = 'Real-time streaming status';
        
        // Insert before the account switcher
        const accountSwitcher = document.getElementById('accountSwitcherHeader');
        if (accountSwitcher && accountSwitcher.parentNode) {
            accountSwitcher.parentNode.insertBefore(indicator, accountSwitcher);
        }
    }
    
    // Update status
    if (connected) {
        indicator.className = 'streaming-status connected';
        indicator.querySelector('.streaming-dot').style.background = '#00ff88';
    } else {
        indicator.className = 'streaming-status disconnected';
        indicator.querySelector('.streaming-dot').style.background = '#ff5252';
    }
}

// Expose for global access
window.StreamingService = StreamingService;

/**
 * Subscribe to real-time futures quotes (/ES, /NQ, /YM, /RTY)
 */
window.subscribeFutures = async function() {
    const statusEl = document.getElementById('futuresStatus');
    const btn = document.querySelector('[onclick="window.subscribeFutures()"]');
    
    try {
        if (statusEl) statusEl.textContent = 'Connecting...';
        if (btn) btn.disabled = true;
        
        const success = await StreamingService.subscribeFutures(['/ES', '/NQ', '/YM', '/RTY']);
        
        if (success) {
            if (statusEl) {
                // Check if it's weekend (markets closed)
                const now = new Date();
                const day = now.getDay(); // 0 = Sunday, 6 = Saturday
                const hour = now.getHours();
                // Futures trade Sun 6pm - Fri 5pm ET. Simplified check:
                const isWeekend = (day === 6) || (day === 0 && hour < 18);
                
                statusEl.textContent = isWeekend ? '📺 Waiting (markets closed)' : '🟢 Live';
                statusEl.style.color = isWeekend ? '#ffaa00' : '#00ff88';
            }
            if (btn) {
                btn.textContent = '✓ Subscribed';
                btn.style.background = 'rgba(0,255,136,0.2)';
                btn.style.color = '#00ff88';
            }
            console.log('[FUTURES] Subscribed to /ES, /NQ, /YM, /RTY');
        } else {
            if (statusEl) {
                statusEl.textContent = '⚠️ Streamer offline';
                statusEl.style.color = '#ffaa00';
            }
        }
    } catch (e) {
        console.error('[FUTURES] Subscribe failed:', e);
        if (statusEl) {
            statusEl.textContent = '❌ Error';
            statusEl.style.color = '#ff5252';
        }
    }
    
    if (btn) btn.disabled = false;
};

/**
 * Listen for futures quote updates
 */
StreamingService.on('futures-quote', (quote) => {
    // StreamingService handles DOM updates automatically via updateFuturesPanel
    // Update status to show we're receiving data
    const statusEl = document.getElementById('futuresStatus');
    if (statusEl && statusEl.textContent.includes('Waiting')) {
        statusEl.textContent = '🟢 Live';
        statusEl.style.color = '#00ff88';
    }
    
    // Log for debugging
    if (state.debugMode) {
        console.log('[FUTURES]', quote.symbol, `$${quote.last?.toFixed(2) || quote.mark?.toFixed(2) || '?'}`);
    }
});

// Update status indicator when streamer connects/disconnects
StreamingService.on('streamer-status', (status) => {
    const statusEl = document.getElementById('futuresStatus');
    
    if (status.connected) {
        // Update status to show connected
        if (statusEl) {
            // Check if it's weekend (markets closed)
            const now = new Date();
            const day = now.getDay(); // 0 = Sunday, 6 = Saturday
            const hour = now.getHours();
            const isWeekend = (day === 6) || (day === 0 && hour < 18);
            
            statusEl.textContent = isWeekend ? '📺 Waiting (markets closed)' : '🟢 Connected';
            statusEl.style.color = isWeekend ? '#ffaa00' : '#00ff88';
        }
        
        // Auto-subscribe to futures if not already subscribed
        setTimeout(() => {
            if (StreamingService.futuresQuotes.size === 0) {
                window.subscribeFutures();
            }
        }, 1000);
    } else {
        // Update status to show disconnected
        if (statusEl) {
            statusEl.textContent = 'Disconnected';
            statusEl.style.color = '#666';
        }
    }
});

// =============================================================================
// MARKET INTERNALS - Breadth, TICK, TRIN, VIX
// =============================================================================

/**
 * Fetch and display market internals from Schwab
 * Symbols: $TICK, $ADD, $VOLD, $TRIN, $VIX
 */
window.refreshMarketInternals = async function() {
    const statusEl = document.getElementById('internalsStatus');
    if (statusEl) statusEl.textContent = 'Fetching...';
    
    try {
        // Schwab symbols for market internals
        // $ADD/$VOLD don't work - need to fetch components and calculate
        // $ADVN = advancing, $DECL = declining (A/D = ADVN - DECL)
        // $UVOL = up volume, $DVOL = down volume (VOL Δ = UVOL - DVOL)
        const symbols = '$TICK,$ADVN,$DECL,$UVOL,$DVOL,$TRIN,$VIX';
        
        const res = await fetch(`/api/schwab/quotes?symbols=${encodeURIComponent(symbols)}&fields=quote`);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        
        const data = await res.json();
        
        // Update TICK
        updateInternalTile('$TICK', data['$TICK'], { 
            extreme: 1000, 
            format: 'int',
            colorLogic: (v) => v > 500 ? '#00ff88' : v < -500 ? '#ff5252' : '#fff'
        });
        const tickVal = data['$TICK']?.quote?.lastPrice;
        if (tickVal !== undefined) SparkChartService.update('$TICK', tickVal);
        
        // Calculate A/D from ADVN - DECL
        const advn = data['$ADVN']?.quote?.lastPrice ?? 0;
        const decl = data['$DECL']?.quote?.lastPrice ?? 0;
        const adValue = advn - decl;
        updateInternalTile('$ADD', { quote: { lastPrice: adValue } }, { 
            format: 'int',
            colorLogic: (v) => v > 500 ? '#00ff88' : v < -500 ? '#ff5252' : '#fff'
        });
        SparkChartService.update('$ADD', adValue);
        
        // Calculate VOL Δ from UVOL - DVOL (in billions of shares)
        const uvol = data['$UVOL']?.quote?.lastPrice ?? 0;
        const dvol = data['$DVOL']?.quote?.lastPrice ?? 0;
        const volDelta = uvol - dvol;
        updateInternalTile('$VOLD', { quote: { lastPrice: volDelta } }, { 
            format: 'billions',
            colorLogic: (v) => v > 0 ? '#00ff88' : v < 0 ? '#ff5252' : '#fff'
        });
        SparkChartService.update('$VOLD', volDelta);
        
        // TRIN
        updateInternalTile('$TRIN', data['$TRIN'], { 
            format: 'decimal',
            colorLogic: (v) => v < 0.8 ? '#00ff88' : v > 1.2 ? '#ff5252' : '#ffaa00'
        });
        const trinVal = data['$TRIN']?.quote?.lastPrice;
        if (trinVal !== undefined) SparkChartService.update('$TRIN', trinVal);
        
        // VIX (use $VIX not $VIX.X)
        updateInternalTile('$VIX', data['$VIX'], { 
            format: 'decimal',
            colorLogic: (v) => v < 15 ? '#00ff88' : v > 25 ? '#ff5252' : '#ffaa00'
        });
        const vixVal = data['$VIX']?.quote?.lastPrice;
        if (vixVal !== undefined) SparkChartService.update('$VIX', vixVal);
        
        // Calculate overall market mood (pass computed values)
        calculateMarketMood({
            '$TICK': data['$TICK'],
            '$ADD': { quote: { lastPrice: adValue } },
            '$VOLD': { quote: { lastPrice: volDelta } },
            '$TRIN': data['$TRIN'],
            '$VIX': data['$VIX']
        });
        
        if (statusEl) {
            const now = new Date();
            statusEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            statusEl.style.color = '#555';
        }
        
    } catch (e) {
        console.error('[INTERNALS] Fetch failed:', e);
        if (statusEl) {
            statusEl.textContent = '⚠ Error';
            statusEl.style.color = '#ff5252';
        }
    }
};

/**
 * Update a single internal indicator tile
 */
function updateInternalTile(symbol, data, options = {}) {
    const tile = document.querySelector(`[data-internal="${symbol}"]`);
    if (!tile) return;
    
    const valueEl = tile.querySelector('.internal-value');
    if (!valueEl) return;
    
    // Get value from quote data
    let value = data?.quote?.lastPrice ?? data?.lastPrice ?? data?.quote?.mark ?? null;
    
    if (value === null || value === undefined) {
        valueEl.textContent = '--';
        valueEl.style.color = '#666';
        return;
    }
    
    // Format based on type
    let displayValue;
    switch (options.format) {
        case 'int':
            displayValue = Math.round(value).toLocaleString();
            if (value > 0) displayValue = '+' + displayValue;
            break;
        case 'millions':
            // Convert to millions
            const inMillions = value / 1000000;
            displayValue = (inMillions >= 0 ? '+' : '') + inMillions.toFixed(0) + 'M';
            break;
        case 'billions':
            // Convert to billions (for volume delta which is in shares)
            const inBillions = value / 1000000000;
            displayValue = (inBillions >= 0 ? '+' : '') + inBillions.toFixed(1) + 'B';
            break;
        case 'decimal':
            displayValue = value.toFixed(2);
            break;
        default:
            displayValue = value.toString();
    }
    
    valueEl.textContent = displayValue;
    
    // Apply color logic
    if (options.colorLogic) {
        valueEl.style.color = options.colorLogic(value);
    }
    
    // Add extreme indicator for TICK
    if (symbol === '$TICK' && options.extreme) {
        if (Math.abs(value) >= options.extreme) {
            valueEl.style.fontWeight = 'bold';
            valueEl.style.textShadow = value > 0 ? '0 0 5px #00ff88' : '0 0 5px #ff5252';
        } else {
            valueEl.style.fontWeight = 'normal';
            valueEl.style.textShadow = 'none';
        }
    }
}

/**
 * Calculate overall market mood based on internals
 */
function calculateMarketMood(data) {
    const moodIndicator = document.getElementById('moodIndicator');
    const moodText = document.getElementById('moodText');
    if (!moodIndicator || !moodText) return;
    
    let bullScore = 0;
    let bearScore = 0;
    
    // TICK scoring
    const tick = data['$TICK']?.quote?.lastPrice ?? data['$TICK']?.lastPrice;
    if (tick !== undefined) {
        if (tick > 500) bullScore += 2;
        else if (tick > 0) bullScore += 1;
        else if (tick < -500) bearScore += 2;
        else if (tick < 0) bearScore += 1;
    }
    
    // A/D scoring
    const add = data['$ADD']?.quote?.lastPrice ?? data['$ADD']?.lastPrice;
    if (add !== undefined) {
        if (add > 1000) bullScore += 2;
        else if (add > 0) bullScore += 1;
        else if (add < -1000) bearScore += 2;
        else if (add < 0) bearScore += 1;
    }
    
    // VOLD scoring
    const vold = data['$VOLD']?.quote?.lastPrice ?? data['$VOLD']?.lastPrice;
    if (vold !== undefined) {
        if (vold > 0) bullScore += 1;
        else bearScore += 1;
    }
    
    // TRIN scoring (inverted - low TRIN = bullish)
    const trin = data['$TRIN']?.quote?.lastPrice ?? data['$TRIN']?.lastPrice;
    if (trin !== undefined) {
        if (trin < 0.8) bullScore += 2;
        else if (trin < 1.0) bullScore += 1;
        else if (trin > 1.2) bearScore += 2;
        else bearScore += 1;
    }
    
    // VIX scoring (inverted - low VIX = bullish)
    const vixData = data['$VIX.X'] || data['$VIX'];
    const vix = vixData?.quote?.lastPrice ?? vixData?.lastPrice;
    if (vix !== undefined) {
        if (vix < 15) bullScore += 1;
        else if (vix > 25) bearScore += 2;
        else if (vix > 20) bearScore += 1;
    }
    
    // Determine mood
    const netScore = bullScore - bearScore;
    
    if (netScore >= 5) {
        moodIndicator.textContent = '🟢';
        moodText.textContent = 'Strong Bull';
        moodText.style.color = '#00ff88';
    } else if (netScore >= 2) {
        moodIndicator.textContent = '🟡';
        moodText.textContent = 'Bullish';
        moodText.style.color = '#aaff88';
    } else if (netScore <= -5) {
        moodIndicator.textContent = '🔴';
        moodText.textContent = 'Strong Bear';
        moodText.style.color = '#ff5252';
    } else if (netScore <= -2) {
        moodIndicator.textContent = '🟠';
        moodText.textContent = 'Bearish';
        moodText.style.color = '#ffaa00';
    } else {
        moodIndicator.textContent = '⚪';
        moodText.textContent = 'Neutral';
        moodText.style.color = '#888';
    }
}

// Auto-refresh internals every 30 seconds during market hours
let internalsInterval = null;

function startInternalsRefresh() {
    // Initial fetch
    window.refreshMarketInternals();
    
    // Set up interval (every 30 seconds)
    if (internalsInterval) clearInterval(internalsInterval);
    internalsInterval = setInterval(() => {
        // Only refresh during market hours (9:30 AM - 4:00 PM ET, weekdays)
        // IMPORTANT: Use Eastern Time, not local time!
        const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const etDate = new Date(nowET);
        const day = etDate.getDay();
        const hour = etDate.getHours();
        const minute = etDate.getMinutes();
        const timeInMinutes = hour * 60 + minute;
        
        // Market hours: 9:30 AM (570 min) to 4:00 PM (960 min), Mon-Fri (ET)
        const isMarketHours = day >= 1 && day <= 5 && timeInMinutes >= 570 && timeInMinutes <= 960;
        
        if (isMarketHours) {
            window.refreshMarketInternals();
        }
    }, 30000);
}

// Start internals refresh when page loads (after a short delay for auth)
setTimeout(startInternalsRefresh, 3000);

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


// SECTION: AI FUNCTIONS -> Moved to js/aiFunctions.js

// =============================================================================
// PRICE ALERT SYSTEM
// =============================================================================

/**
 * Add a price alert from Deep Dive modal
 */
window.addPriceAlert = function(ticker, targetPrice, levelName, suggestedStrike) {
    const AlertService = window.AlertService;
    if (!AlertService) {
        showNotification('Alert service not available', 'error');
        return;
    }
    
    const alert = AlertService.add({
        ticker,
        targetPrice,
        levelName,
        suggestedStrike,
        proximityPercent: 3,  // Default 3% zone
        direction: 'below',
        note: `Auto-created from Deep Dive analysis`
    });
    
    const zone = AlertService.constructor.getZone(targetPrice, 3);
    showNotification(`🔔 Alert set: ${ticker} @ $${targetPrice} (zone: $${zone.lower}-$${zone.upper})`, 'success', 3000);
    
    // Refresh alerts panel if visible
    if (typeof window.renderAlertsPanel === 'function') {
        window.renderAlertsPanel();
    }
};

/**
 * Remove a price alert
 */
window.removePriceAlert = function(id) {
    const AlertService = window.AlertService;
    if (AlertService?.remove(id)) {
        showNotification('Alert removed', 'info', 2000);
        window.renderAlertsPanel?.();
    }
};

/**
 * Reset a triggered alert (re-enable it)
 */
window.resetPriceAlert = function(id) {
    const AlertService = window.AlertService;
    if (AlertService?.reset(id)) {
        showNotification('Alert re-enabled', 'success', 2000);
        window.renderAlertsPanel?.();
    }
};

/**
 * Render the alerts panel in the Ideas tab
 */
window.renderAlertsPanel = function() {
    const container = document.getElementById('alertsPanelContent');
    if (!container) return;
    
    const AlertService = window.AlertService;
    if (!AlertService) {
        container.innerHTML = '<div style="color:#888; padding:12px;">Alert service loading...</div>';
        return;
    }
    
    const alerts = AlertService.getAll();
    
    if (alerts.length === 0) {
        container.innerHTML = `
            <div style="color:#888; padding:16px; text-align:center;">
                <div style="font-size:24px; margin-bottom:8px;">🔔</div>
                <div>No price alerts set</div>
                <div style="font-size:12px; margin-top:4px;">Run a Deep Dive to add support level alerts</div>
            </div>`;
        return;
    }
    
    // Group by active vs triggered
    const active = alerts.filter(a => !a.triggered && a.enabled);
    const triggered = alerts.filter(a => a.triggered);
    const disabled = alerts.filter(a => !a.triggered && !a.enabled);
    
    let html = '';
    
    // Active alerts
    if (active.length > 0) {
        html += `<div style="color:#00ff88; font-size:12px; font-weight:bold; margin-bottom:8px;">ACTIVE (${active.length})</div>`;
        html += active.map(a => renderAlertRow(a, 'active')).join('');
    }
    
    // Triggered alerts
    if (triggered.length > 0) {
        html += `<div style="color:#ffaa00; font-size:12px; font-weight:bold; margin-top:12px; margin-bottom:8px;">TRIGGERED (${triggered.length})</div>`;
        html += triggered.map(a => renderAlertRow(a, 'triggered')).join('');
    }
    
    // Disabled alerts
    if (disabled.length > 0) {
        html += `<div style="color:#888; font-size:12px; font-weight:bold; margin-top:12px; margin-bottom:8px;">PAUSED (${disabled.length})</div>`;
        html += disabled.map(a => renderAlertRow(a, 'disabled')).join('');
    }
    
    container.innerHTML = html;
};

/**
 * Render a single alert row
 */
function renderAlertRow(alert, status) {
    const zone = window.AlertService?.constructor?.getZone(alert.targetPrice, alert.proximityPercent) || {};
    const statusColors = {
        active: { bg: 'rgba(0,255,136,0.1)', border: 'rgba(0,255,136,0.3)', icon: '🔔' },
        triggered: { bg: 'rgba(255,170,0,0.1)', border: 'rgba(255,170,0,0.3)', icon: '✅' },
        disabled: { bg: 'rgba(136,136,136,0.1)', border: 'rgba(136,136,136,0.3)', icon: '⏸️' }
    };
    const style = statusColors[status];
    
    let actionButtons = '';
    if (status === 'active') {
        actionButtons = `
            <button onclick="window.removePriceAlert(${alert.id})" title="Delete" style="background:none; border:none; color:#ff5252; cursor:pointer; font-size:14px;">✕</button>`;
    } else if (status === 'triggered') {
        actionButtons = `
            <button onclick="window.resetPriceAlert(${alert.id})" title="Re-enable" style="background:none; border:none; color:#00d9ff; cursor:pointer; font-size:12px;">↺</button>
            <button onclick="window.removePriceAlert(${alert.id})" title="Delete" style="background:none; border:none; color:#ff5252; cursor:pointer; font-size:14px;">✕</button>`;
    } else {
        actionButtons = `
            <button onclick="window.AlertService?.toggle(${alert.id}); window.renderAlertsPanel();" title="Enable" style="background:none; border:none; color:#00ff88; cursor:pointer; font-size:12px;">▶</button>
            <button onclick="window.removePriceAlert(${alert.id})" title="Delete" style="background:none; border:none; color:#ff5252; cursor:pointer; font-size:14px;">✕</button>`;
    }
    
    // Show triggered info
    let triggeredInfo = '';
    if (alert.triggered && alert.triggeredPrice) {
        const diff = ((alert.triggeredPrice - alert.targetPrice) / alert.targetPrice * 100).toFixed(1);
        triggeredInfo = `<div style="font-size:10px; color:#ffaa00;">Triggered @ $${alert.triggeredPrice.toFixed(2)} (${diff > 0 ? '+' : ''}${diff}%)</div>`;
    }
    
    return `
        <div style="background:${style.bg}; border:1px solid ${style.border}; border-radius:6px; padding:10px; margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:16px;">${style.icon}</span>
                <div>
                    <div style="font-weight:bold; color:#fff;">${alert.ticker} <span style="color:#888; font-weight:normal;">@ $${alert.targetPrice.toFixed(2)}</span></div>
                    <div style="font-size:11px; color:#888;">${alert.levelName || ''} • Zone: $${zone.lower}-$${zone.upper}</div>
                    ${alert.suggestedStrike ? `<div style="font-size:11px; color:#00d9ff;">Strike: $${alert.suggestedStrike}</div>` : ''}
                    ${triggeredInfo}
                </div>
            </div>
            <div style="display:flex; gap:4px;">
                ${actionButtons}
            </div>
        </div>`;
}

/**
 * Check streaming prices against alerts
 * Called from StreamingService when prices update
 */
window.checkPriceAlerts = function(ticker, price) {
    const AlertService = window.AlertService;
    if (!AlertService) return;
    
    const result = AlertService.checkPrice(ticker, price);
    if (result) {
        // Alert triggered! Show notification
        const { alert, currentPrice, distancePercent } = result;
        
        // Browser notification
        showNotification(
            `🔔 ${alert.ticker} hit $${currentPrice.toFixed(2)} (target: $${alert.targetPrice.toFixed(2)}, ${alert.levelName})`,
            'success',
            10000  // Show for 10 seconds
        );
        
        // Play sound - try file first, fall back to Web Audio beep
        try {
            const audio = new Audio('/sounds/alert.mp3');
            audio.volume = 0.5;
            audio.play().catch(() => {
                // Fallback: generate a beep using Web Audio API
                playAlertBeep();
            });
        } catch (e) {
            playAlertBeep();
        }
        
        // Browser notification (if permitted)
        if (Notification?.permission === 'granted') {
            new Notification(`🔔 ${alert.ticker} Alert!`, {
                body: `Price: $${currentPrice.toFixed(2)} (target: $${alert.targetPrice.toFixed(2)})`,
                icon: '/favicon.ico'
            });
        }
        
        // Refresh panel
        window.renderAlertsPanel?.();
    }
};

/**
 * Play a simple beep sound using Web Audio API
 */
function playAlertBeep() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.type = 'sine';
        oscillator.frequency.value = 880;  // A5 note
        gainNode.gain.value = 0.3;
        
        oscillator.start();
        
        // Fade out over 200ms
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
        
        // Stop after 200ms
        setTimeout(() => oscillator.stop(), 200);
    } catch (e) {
        console.log('[ALERT] Could not play sound:', e);
    }
}

/**
 * Request browser notification permission
 */
window.requestAlertPermission = function() {
    if (Notification && Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                showNotification('✅ Browser notifications enabled', 'success');
            }
        });
    }
};


// stageTradeWithThesis, extractThesisSummary, extractSection -> Moved to js/aiFunctions.js and js/aiHelpers.js

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
        const AccountService = (await import('AccountService')).default;
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
// SECTION: TRADE STAGING -> Moved to js/tradeStaging.js
// ============================================================


// SECTION: POSITION CHECKUP -> Moved to js/positionCheckup.js
// formatAIResponse, extractThesisSummary, extractSection -> Moved to js/aiHelpers.js


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
    
    // Add Position form - trigger Schwab preview on field changes
    const posTickerInput = document.getElementById('posTicker');
    const posTypeSelect = document.getElementById('posType');
    const posStrikeInput = document.getElementById('posStrike');
    const posExpiryInput = document.getElementById('posExpiry');
    const posPremiumInput = document.getElementById('posPremium');
    const posContractsInput = document.getElementById('posContracts');
    
    const triggerPreview = () => {
        if (window.updateAddPositionSchwabPreview) {
            window.updateAddPositionSchwabPreview();
        }
    };
    
    const triggerExpiryLoad = () => {
        if (window.populateAddPositionExpiries) {
            window.populateAddPositionExpiries();
        }
    };
    
    if (posTickerInput) {
        posTickerInput.addEventListener('blur', triggerExpiryLoad);
        posTickerInput.addEventListener('blur', triggerPreview);
    }
    if (posTypeSelect) {
        posTypeSelect.addEventListener('change', triggerExpiryLoad);
        posTypeSelect.addEventListener('change', triggerPreview);
    }
    if (posStrikeInput) posStrikeInput.addEventListener('change', triggerPreview);
    if (posExpiryInput) posExpiryInput.addEventListener('change', triggerPreview);
    if (posPremiumInput) posPremiumInput.addEventListener('change', triggerPreview);
    if (posContractsInput) posContractsInput.addEventListener('change', triggerPreview);
    
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

// SECTION: AI STRATEGY ADVISOR -> Moved to js/strategyAdvisor.js


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
    const selectedModel = window.getSelectedAIModel?.('ideaModelSelect2') || 'qwen2.5:32b';
    
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
    const selectedModel = window.getSelectedAIModel?.('ideaModelSelect2') || 'qwen2.5:32b';
    
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


// SECTION: MONTE CARLO SIMULATION -> Moved to js/monteCarlo.js

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


// SECTION: WHEEL SCANNER -> Moved to js/wheelScanner.js



// SECTION: PMCC CALCULATOR -> Moved to js/pmccCalculator.js

// Export for potential external use
export { setupTabs, setupButtons };
