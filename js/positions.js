// WheelHouse - Position Tracker Module
// localStorage-based position management

import { state, setPositionContext, clearPositionContext, getPositionsKey, getClosedKey, getHoldingsKey } from './state.js';
import { formatCurrency, formatPercent, getDteUrgency, showNotification, showUndoNotification, randomNormal, isDebitPosition, calculatePositionCredit, calculateRealizedPnL, getChainNetCredit as utilsGetChainNetCredit, hasRollHistory as utilsHasRollHistory, createModal, modalHeader, calculateGreeks } from './utils.js';
import { fetchPositionTickerPrice, fetchStockPrice, fetchStockPricesBatch } from './api.js';
import { drawPayoffChart } from './charts.js';
import { updateDteDisplay } from './ui.js';

// Dynamic storage keys based on account mode (real vs paper)
function getStorageKey() { return getPositionsKey(); }
function getHoldingsStorageKey() { return getHoldingsKey(); }
function getClosedStorageKey() { return getClosedKey(); }

// Dynamic checkpoint key - now account-aware to prevent false "data loss" warnings when switching accounts
function getCheckpointKey() {
    const mode = state.accountMode || 'real';
    if (mode === 'paper') {
        return 'wheelhouse_data_checkpoint_paper';
    }
    // For real accounts, include the account number to avoid false warnings
    const acct = state.selectedAccount;
    if (acct && acct.accountNumber) {
        return `wheelhouse_data_checkpoint_${acct.type || 'ACCT'}_${acct.accountNumber.slice(-4)}`;
    }
    return 'wheelhouse_data_checkpoint';
}

// Theme color helpers - read from CSS variables at render time
function getThemeColor(varName, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

const colors = {
    get cyan() { return getThemeColor('--accent-cyan', '#00d9ff'); },
    get green() { return getThemeColor('--accent-green', '#00ff88'); },
    get red() { return getThemeColor('--accent-red', '#ff5252'); },
    get orange() { return getThemeColor('--accent-orange', '#ffaa00'); },
    get purple() { return getThemeColor('--accent-purple', '#8b5cf6'); },
    get text() { return getThemeColor('--text-primary', '#fff'); },
    get muted() { return getThemeColor('--text-muted', '#888'); },
    get bgPrimary() { return getThemeColor('--bg-primary', '#1a1a2e'); },
    get bgSecondary() { return getThemeColor('--bg-secondary', '#0d0d1a'); }
};

// isDebitPosition is now imported from utils.js

// Cache for spot prices (refreshed every 5 minutes)
const spotPriceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cache for IV data (refreshed every 5 minutes)
const ivCache = new Map();

/**
 * Fetch real IV from CBOE for a ticker (cached)
 * @param {string} ticker - Stock ticker
 * @returns {number|null} IV as decimal (e.g., 0.45 for 45%) or null if unavailable
 */
async function getCachedIV(ticker) {
    if (!ticker) return null;
    ticker = ticker.toUpperCase();
    
    const cached = ivCache.get(ticker);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.iv;
    }
    
    try {
        const response = await fetch(`/api/iv/${ticker}`);
        if (response.ok) {
            const data = await response.json();
            if (data.atmIV) {
                const iv = parseFloat(data.atmIV) / 100; // Convert from 45.2% to 0.452
                ivCache.set(ticker, { iv, timestamp: Date.now() });
                console.log(`[IV] ✅ ${ticker}: ${(iv * 100).toFixed(1)}% from ${data.source}`);
                return iv;
            }
        }
    } catch (e) {
        console.warn(`[IV] Could not fetch IV for ${ticker}:`, e.message);
    }
    return null;
}

/**
 * Batch fetch IV for multiple tickers (for positions refresh)
 * @param {string[]} tickers - Array of ticker symbols
 * @returns {Map<string, number>} Map of ticker -> IV (decimal)
 */
async function batchFetchIV(tickers) {
    const uniqueTickers = [...new Set(tickers.map(t => t.toUpperCase()))];
    const results = new Map();
    
    // Fetch IVs in parallel (limit to 5 concurrent for rate limiting)
    const chunks = [];
    for (let i = 0; i < uniqueTickers.length; i += 5) {
        chunks.push(uniqueTickers.slice(i, i + 5));
    }
    
    for (const chunk of chunks) {
        await Promise.all(chunk.map(async (ticker) => {
            const iv = await getCachedIV(ticker);
            if (iv) results.set(ticker, iv);
        }));
    }
    
    return results;
}

/**
 * Fetch spot price with caching
 * Now uses CBOE first (reliable), falls back to Yahoo via fetchStockPrice
 */
async function getCachedSpotPrice(ticker) {
    const cached = spotPriceCache.get(ticker);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        const price = await fetchStockPrice(ticker);
        if (price) {
            spotPriceCache.set(ticker, { price, timestamp: Date.now() });
            return price;
        }
    } catch (e) {
        console.warn(`Could not fetch spot for ${ticker}:`, e.message);
    }
    return null;
}

/**
 * Calculate ITM probability using quick Monte Carlo
 * @param {number} spot - Current spot price
 * @param {number} strike - Strike price
 * @param {number} dte - Days to expiration
 * @param {number} vol - Implied volatility (default 0.5 = 50%)
 * @param {boolean} isPut - true for put, false for call
 * @returns {number} ITM probability as percentage (0-100)
 */
function quickMonteCarloRisk(spot, strike, dte, vol = 0.5, isPut = true) {
    const paths = 1000; // More paths for better accuracy
    const T = Math.max(dte, 1) / 365.25;
    const numSteps = 30;
    const dt = T / numSteps;
    const rate = state.rate || 0.05; // Use global rate, fallback to 5%
    
    let itmCount = 0;
    
    for (let i = 0; i < paths; i++) {
        let S = spot;
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormal() * Math.sqrt(dt);
            S *= Math.exp((rate - 0.5 * vol * vol) * dt + vol * dW);
        }
        
        if (isPut) {
            if (S < strike) itmCount++;
        } else {
            if (S > strike) itmCount++;
        }
    }
    
    return (itmCount / paths) * 100;
}

/**
 * Estimate volatility based on ticker characteristics (FALLBACK ONLY)
 * Use getCachedIV() for real IV from CBOE when available
 * Leveraged ETFs have much higher IV than regular stocks
 */
function estimateVolatility(ticker, fallback = 0.5) {
    const leveragedETFs = ['TSLL', 'TQQQ', 'SOXL', 'UPRO', 'SPXL', 'NVDL', 'FNGU', 'LABU', 'WEBL', 'TECL', 'FAS', 'TNA', 'JNUG', 'NUGT', 'UDOW', 'UMDD', 'URTY'];
    const highVolStocks = ['TSLA', 'NVDA', 'AMD', 'MSTR', 'COIN', 'GME', 'AMC', 'RIVN', 'LCID', 'NIO', 'PLTR', 'MARA', 'RIOT'];
    
    if (leveragedETFs.includes(ticker?.toUpperCase())) {
        return 0.85; // 85% IV typical for 2x/3x leveraged ETFs
    }
    if (highVolStocks.includes(ticker?.toUpperCase())) {
        return 0.65; // 65% IV for volatile growth stocks
    }
    return fallback; // Default 50% for normal stocks
}

/**
 * Determine position risk status based on ITM probability
 * Thresholds match the AI recommendation panel in analysis.js
 * @param {object} pos - Position object
 * @param {number|null} spotPrice - Current spot price (null if unavailable)
 * @param {number|null} realIV - Real IV from CBOE (optional - falls back to estimate)
 * @returns {object} { icon, text, color, needsAttention, itmPct }
 */
function calculatePositionRisk(pos, spotPrice, realIV = null) {
    // Check if this is a spread (has different strike requirements)
    const isSpread = pos.type?.includes('_spread');
    
    // If we don't have spot price, fall back to DTE-based status
    // For spreads, check sellStrike/buyStrike instead of strike
    const hasStrike = isSpread ? (pos.sellStrike && pos.buyStrike) : pos.strike;
    
    if (!spotPrice || !hasStrike) {
        if (pos.dte <= 5) {
            return { icon: '⏳', text: 'Check', color: colors.orange, needsAttention: true, itmPct: null };
        } else if (pos.dte <= 14) {
            return { icon: '⏳', text: 'Check', color: colors.muted, needsAttention: false, itmPct: null };
        }
        return { icon: '🟢', text: 'OK', color: colors.green, needsAttention: false, itmPct: null };
    }
    
    const isPut = pos.type?.includes('put');
    const isCall = pos.type?.includes('call');
    
    // Handle spreads - calculate risk based on short leg
    if (isSpread) {
        // Determine which strike is the short leg (at risk of assignment)
        let shortStrike;
        let isShortPut = false;
        let isShortCall = false;
        
        if (pos.type === 'put_credit_spread') {
            // Bull put spread: short the HIGHER strike put
            shortStrike = Math.max(pos.sellStrike, pos.buyStrike);
            isShortPut = true;
        } else if (pos.type === 'call_credit_spread') {
            // Bear call spread: short the LOWER strike call
            shortStrike = Math.min(pos.sellStrike, pos.buyStrike);
            isShortCall = true;
        } else if (pos.type === 'put_debit_spread') {
            // Bear put spread: you bought the higher strike, sold the lower
            // Short leg is the LOWER strike put
            shortStrike = Math.min(pos.sellStrike, pos.buyStrike);
            isShortPut = true;
        } else if (pos.type === 'call_debit_spread') {
            // Bull call spread: you bought the lower strike, sold the higher
            // Short leg is the HIGHER strike call
            shortStrike = Math.max(pos.sellStrike, pos.buyStrike);
            isShortCall = true;
        }
        
        if (shortStrike && spotPrice) {
            // Use realIV if provided, then pos.iv, then estimate
            const vol = realIV || pos.iv || estimateVolatility(pos.ticker);
            const itmPct = quickMonteCarloRisk(spotPrice, shortStrike, pos.dte, vol, isShortPut);
            
            // Check current ITM status (not probability, actual current state)
            // For credit spreads, being OTM RIGHT NOW is good even if probability is high
            const isCurrentlyITM = isShortPut 
                ? spotPrice < shortStrike   // Put is ITM when spot < strike
                : spotPrice > shortStrike;  // Call is ITM when spot > strike
            
            // Calculate how far OTM we are as a percentage
            const otmPct = isShortPut 
                ? ((spotPrice - shortStrike) / shortStrike) * 100
                : ((shortStrike - spotPrice) / shortStrike) * 100;
            
            // For credit spreads: if currently OTM, use more lenient thresholds
            // The Monte Carlo probability is forward-looking, but current state matters too
            const isCredit = pos.type?.includes('credit');
            
            // If it's a credit spread and currently OTM by at least 0.5%, be more lenient
            const currentlyOTM = !isCurrentlyITM && Math.abs(otmPct) >= 0.5;
            
            // Use same thresholds as single-leg options, but adjust for credit spreads that are currently safe
            const isLeaps = pos.dte >= 365;
            const isLongDated = pos.dte >= 180 && pos.dte < 365;
            const isMediumDated = pos.dte >= 30 && pos.dte < 180;
            
            // Base thresholds - match single-leg thresholds
            let thresholds = isLeaps 
                ? { safe: 60, watch: 70, caution: 80, danger: 90 }
                : isLongDated 
                ? { safe: 45, watch: 55, caution: 65, danger: 75 }
                : isMediumDated
                ? { safe: 40, watch: 50, caution: 60, danger: 70 }
                : { safe: 30, watch: 40, caution: 50, danger: 60 };
            
            // For credit spreads that are currently OTM, relax thresholds by 10%
            // This reflects that "currently safe" is different from "might become unsafe"
            if (isCredit && currentlyOTM) {
                thresholds = {
                    safe: thresholds.safe + 10,
                    watch: thresholds.watch + 10,
                    caution: thresholds.caution + 10,
                    danger: thresholds.danger + 10
                };
            }
            
            // Determine status with adjusted thresholds
            if (itmPct >= thresholds.caution) {
                return { icon: '🔴', text: `${itmPct.toFixed(0)}%`, color: colors.red, needsAttention: true, itmPct, currentlyOTM };
            } else if (itmPct >= thresholds.watch) {
                return { icon: '🟠', text: `${itmPct.toFixed(0)}%`, color: colors.orange, needsAttention: true, itmPct, currentlyOTM };
            } else if (itmPct >= thresholds.safe) {
                return { icon: '🟡', text: `${itmPct.toFixed(0)}%`, color: '#ffff00', needsAttention: false, itmPct, currentlyOTM };
            } else {
                return { icon: '🟢', text: `${itmPct.toFixed(0)}%`, color: colors.green, needsAttention: false, itmPct, currentlyOTM };
            }
        }
        
        // Fallback if we can't calculate
        return { icon: '📊', text: 'Spread', color: colors.purple, needsAttention: false, itmPct: null };
    }
    
    // Use realIV if provided, then stored IV, then estimate
    const vol = realIV || pos.iv || estimateVolatility(pos.ticker);
    
    // Calculate ITM probability
    const itmPct = quickMonteCarloRisk(spotPrice, pos.strike, pos.dte, vol, isPut);
    
    // Check if there's a holding with a saved strategy for this ticker
    // If strategy is "LET CALL", assignment is DESIRED, not a problem!
    const holding = (state.holdings || []).find(h => h.ticker === pos.ticker && h.savedStrategy);
    const strategy = holding?.savedStrategy?.recommendation;
    const wantsAssignment = strategy === 'LET CALL';
    
    // LEAPS (365+ days) have different risk thresholds
    // With 1-2 years of time, being at 50% ITM is basically ATM - totally normal
    const isLeaps = pos.dte >= 365;
    const isLongDated = pos.dte >= 180 && pos.dte < 365;
    const isMediumDated = pos.dte >= 30 && pos.dte < 180;  // 30-180 days
    
    // Thresholds vary by time horizon:
    // LEAPS (365+ days): 60% = safe, 70% = watch, 80% = caution
    // Long-dated (180-364 days): 45% = safe, 55% = watch, 65% = caution
    // Medium-dated (30-179 days): 40% = safe, 50% = watch, 60% = caution  
    // Short-dated (< 30 days): 30% = safe, 40% = watch, 50% = caution
    
    // Define thresholds based on time horizon
    const thresholds = isLeaps 
        ? { safe: 60, watch: 70, caution: 80, danger: 90 }   // LEAPS: Very relaxed
        : isLongDated 
        ? { safe: 45, watch: 55, caution: 65, danger: 75 }   // Long-dated: Relaxed
        : isMediumDated
        ? { safe: 40, watch: 50, caution: 60, danger: 70 }   // Medium-dated: Moderate
        : { safe: 30, watch: 40, caution: 50, danger: 60 };  // Short-dated: Original thresholds
    
    if (itmPct >= thresholds.caution) {
        if (wantsAssignment) {
            // Strategy says LET CALL - high assignment prob is GOOD!
            return { 
                icon: '🎯', 
                text: `${itmPct.toFixed(0)}%`, 
                color: '#00d9ff',  // Cyan - on track
                needsAttention: false, 
                itmPct,
                wantsAssignment: true
            };
        }
        // No strategy or different strategy - high risk warning
        return { 
            icon: '🔴', 
            text: `${itmPct.toFixed(0)}%`, 
            color: colors.red, 
            needsAttention: true, 
            itmPct,
            isLeaps  // Pass this so UI can show different message
        };
    } else if (itmPct >= thresholds.watch) {
        if (wantsAssignment) {
            // Wants assignment but not there yet
            return { 
                icon: '🎯', 
                text: `${itmPct.toFixed(0)}%`, 
                color: colors.orange,  // Getting there
                needsAttention: false, 
                itmPct,
                wantsAssignment: true
            };
        }
        // CAUTION - consider rolling
        return { 
            icon: '🟠', 
            text: `${itmPct.toFixed(0)}%`, 
            color: '#ff8800', 
            needsAttention: !isLeaps && !isLongDated,  // Only urgent for short-dated
            itmPct 
        };
    } else if (itmPct >= thresholds.safe) {
        // WATCH - moderate risk
        return { 
            icon: '🟡', 
            text: `${itmPct.toFixed(0)}%`, 
            color: colors.orange, 
            needsAttention: false,  // Yellow is "watch", not urgent
            itmPct 
        };
    } else {
        // HOLD - safe (or for LEAPS, "on track")
        return { 
            icon: isLeaps ? '📅' : '🟢',  // Calendar icon for LEAPS
            text: `${itmPct.toFixed(0)}%`, 
            color: colors.green, 
            needsAttention: false, 
            itmPct 
        };
    }
}

/**
 * Calculate breakeven price for a spread
 */
function calculateSpreadBreakeven(type, buyStrike, sellStrike, premium) {
    switch (type) {
        case 'call_debit_spread':
            // Breakeven = lower strike + premium paid
            return Math.min(buyStrike, sellStrike) + premium;
        case 'put_debit_spread':
            // Breakeven = higher strike - premium paid
            return Math.max(buyStrike, sellStrike) - premium;
        case 'call_credit_spread':
            // Breakeven = lower strike + premium received
            return Math.min(buyStrike, sellStrike) + premium;
        case 'put_credit_spread':
            // Breakeven = higher strike - premium received
            return Math.max(buyStrike, sellStrike) - premium;
        default:
            return null;
    }
}

/**
 * Get human-readable spread description for AI analysis
 */
export function getSpreadExplanation(pos) {
    if (!pos.type?.includes('_spread')) return null;
    
    const width = pos.spreadWidth || Math.abs(pos.sellStrike - pos.buyStrike);
    const maxProfitPerShare = pos.type.includes('credit') ? pos.premium : (width - pos.premium);
    const maxLossPerShare = pos.type.includes('debit') ? pos.premium : (width - pos.premium);
    const totalMaxProfit = maxProfitPerShare * 100 * (pos.contracts || 1);
    const totalMaxLoss = maxLossPerShare * 100 * (pos.contracts || 1);
    const breakeven = pos.breakeven || calculateSpreadBreakeven(pos.type, pos.buyStrike, pos.sellStrike, pos.premium);
    
    const explanations = {
        'call_debit_spread': {
            name: 'Call Debit Spread (Bull Call Spread)',
            direction: 'BULLISH',
            setup: `Buy $${pos.buyStrike} Call / Sell $${pos.sellStrike} Call`,
            cost: `Net Debit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} total)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes at or above $${pos.sellStrike} at expiry)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes at or below $${pos.buyStrike} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must rise above this to profit)`,
            howItWorks: `You paid $${pos.premium.toFixed(2)}/share for the right to profit if ${pos.ticker} goes up. Your profit is capped at $${pos.sellStrike} because you sold that call. The trade-off: lower cost than buying a naked call, but capped upside.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to make $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'put_debit_spread': {
            name: 'Put Debit Spread (Bear Put Spread)',
            direction: 'BEARISH',
            setup: `Buy $${Math.max(pos.buyStrike, pos.sellStrike)} Put / Sell $${Math.min(pos.buyStrike, pos.sellStrike)} Put`,
            cost: `Net Debit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} total)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes at or below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes at or above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must fall below this to profit)`,
            howItWorks: `You paid $${pos.premium.toFixed(2)}/share for the right to profit if ${pos.ticker} goes down. Your profit is capped because you sold the lower strike put.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to make $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'call_credit_spread': {
            name: 'Call Credit Spread (Bear Call Spread)',
            direction: 'BEARISH',
            setup: `Sell $${Math.min(pos.buyStrike, pos.sellStrike)} Call / Buy $${Math.max(pos.buyStrike, pos.sellStrike)} Call`,
            cost: `Net Credit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} received)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry - keep full premium)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must stay below this to profit)`,
            howItWorks: `You received $${pos.premium.toFixed(2)}/share upfront. You keep it all if ${pos.ticker} stays below $${Math.min(pos.buyStrike, pos.sellStrike)}. The long call at $${Math.max(pos.buyStrike, pos.sellStrike)} limits your max loss.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to keep $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'put_credit_spread': {
            name: 'Put Credit Spread (Bull Put Spread)',
            direction: 'BULLISH',
            setup: `Sell $${Math.max(pos.buyStrike, pos.sellStrike)} Put / Buy $${Math.min(pos.buyStrike, pos.sellStrike)} Put`,
            cost: `Net Credit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} received)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry - keep full premium)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must stay above this to profit)`,
            howItWorks: `You received $${pos.premium.toFixed(2)}/share upfront. You keep it all if ${pos.ticker} stays above $${Math.max(pos.buyStrike, pos.sellStrike)}. The long put at $${Math.min(pos.buyStrike, pos.sellStrike)} limits your max loss. This is the "Wheel-adjacent" bullish strategy!`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to keep $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        }
    };
    
    return explanations[pos.type] || null;
}

/**
 * Local wrapper for hasRollHistory that uses current state
 * (The utils.js version requires passing allPositions)
 */
function hasRollHistory(pos) {
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    return utilsHasRollHistory(pos, allPositions);
}

/**
 * Local wrapper for getChainNetCredit that uses current state
 * (The utils.js version requires passing allPositions)
 */
function getChainNetCredit(pos) {
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    return utilsGetChainNetCredit(pos, allPositions);
}

/**
 * Show roll history modal for a position chain
 */
window.showRollHistory = function(chainId) {
    // Find all positions in this chain (open + closed)
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    const chainPositions = allPositions
        .filter(p => (p.chainId || p.id) === chainId)
        .sort((a, b) => new Date(a.openDate || 0) - new Date(b.openDate || 0));
    
    if (chainPositions.length === 0) {
        console.error('No positions found for chain:', chainId);
        return;
    }
    
    // Calculate NET total: premium received MINUS cost to close (for rolled positions)
    // For open positions: just the premium
    // For closed positions: premium - closePrice (if rolled/closed early)
    let totalNetPremium = 0;
    let totalReceived = 0;
    let totalClosingCosts = 0;
    
    chainPositions.forEach(p => {
        const premiumReceived = (p.premium || 0) * 100 * (p.contracts || 1);
        totalReceived += premiumReceived;
        
        if (p.status === 'closed' && p.closePrice !== undefined && p.closePrice > 0) {
            const closingCost = p.closePrice * 100 * (p.contracts || 1);
            totalClosingCosts += closingCost;
        }
    });
    
    totalNetPremium = totalReceived - totalClosingCosts;
    const ticker = chainPositions[0]?.ticker || 'Unknown';
    
    const modal = document.createElement('div');
    modal.id = 'rollHistoryModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build timeline HTML
    let timelineHtml = '';
    chainPositions.forEach((pos, idx) => {
        const isOpen = pos.status === 'open';
        const isCurrent = idx === chainPositions.length - 1 && isOpen;
        const statusColor = isOpen ? colors.green : colors.muted;
        const statusText = isOpen ? 'OPEN' : (pos.closeReason || 'CLOSED');
        const premium = pos.premium * 100 * pos.contracts;
        
        // Determine if debit or credit
        const isDebit = isDebitPosition(pos.type);
        const premiumColor = isDebit ? colors.red : colors.green;
        const premiumSign = isDebit ? '-' : '+';
        
        // Calculate closing cost if this was rolled/closed
        const closingCost = (pos.closePrice || 0) * 100 * (pos.contracts || 1);
        const showClosingCost = pos.status === 'closed' && pos.closePrice && pos.closePrice > 0;
        
        // Strike display
        let strikeDisplay = '';
        if (pos.type?.includes('_spread')) {
            strikeDisplay = `$${pos.buyStrike}/$${pos.sellStrike}`;
        } else {
            strikeDisplay = `$${pos.strike}`;
        }
        
        // Check if this position is in closedPositions list
        const isInClosedList = (state.closedPositions || []).some(p => p.id === pos.id);
        
        // Show fix button if: middle position in chain that should be closed but missing close data
        // (missing closePrice, wrong status, or missing closeReason)
        const needsFix = idx < chainPositions.length - 1 && 
            (!pos.closePrice || pos.status !== 'closed' || !pos.closeReason);
        
        timelineHtml += `
            <div style="display:flex; align-items:flex-start; gap:15px; padding:15px 0; 
                        ${idx < chainPositions.length - 1 ? 'border-bottom:1px solid #333;' : ''}">
                <div style="width:30px; text-align:center;">
                    <div style="width:12px; height:12px; border-radius:50%; 
                                background:${isCurrent ? colors.cyan : statusColor}; 
                                margin:4px auto;
                                ${isCurrent ? `box-shadow: 0 0 10px ${colors.cyan};` : ''}"></div>
                    ${idx < chainPositions.length - 1 ? `
                    <div style="width:2px; height:30px; background:#333; margin:0 auto;"></div>
                    ` : ''}
                </div>
                <div style="flex:1;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="color:${colors.text}; font-weight:bold;">
                            ${idx === 0 ? '🎬 Original' : '🔄 Roll #' + idx}
                        </span>
                        <div style="display:flex; gap:8px; align-items:center;">
                            ${needsFix ? `<button onclick="window.fixRollCloseData(${pos.id}, ${isInClosedList})" 
                                style="background:#ff9800; color:#000; border:none; padding:2px 8px; border-radius:4px; 
                                       cursor:pointer; font-size:10px; font-weight:bold;">🔧 Fix</button>` : ''}
                            <span style="color:${statusColor}; font-size:11px; padding:2px 8px; 
                                         background:${statusColor}22; border-radius:10px;">
                                ${statusText}
                            </span>
                        </div>
                    </div>
                    <div style="color:#aaa; font-size:13px;">
                        <span style="color:${colors.muted};">${pos.type?.replace(/_/g, ' ').toUpperCase() || 'PUT'}</span>
                        &nbsp;•&nbsp; Strike: <span style="color:${colors.text};">${strikeDisplay}</span>
                        &nbsp;•&nbsp; Exp: <span style="color:${colors.text};">${pos.expiry || 'N/A'}</span>
                    </div>
                    <div style="margin-top:6px; display:flex; gap:20px; font-size:12px; flex-wrap:wrap;">
                        <span>Premium: <span style="color:${premiumColor}; font-weight:bold;">${premiumSign}$${premium.toFixed(0)}</span></span>
                        ${showClosingCost ? `<span>Buyback: <span style="color:${colors.red}; font-weight:bold;">-$${closingCost.toFixed(0)}</span></span>` : ''}
                        ${pos.openDate ? `<span style="color:#666;">Opened: ${pos.openDate}</span>` : ''}
                        ${pos.closeDate ? `<span style="color:#666;">Closed: ${pos.closeDate}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, ${colors.bgPrimary} 0%, #16213e 100%); border:1px solid #0096ff; 
                    border-radius:16px; padding:30px; width:90%; max-width:550px; max-height:85vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 150, 255, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:25px;">
                <span style="font-size:32px;">🔗</span>
                <div>
                    <h2 style="margin:0; color:${colors.text}; font-size:20px;">Roll History: ${ticker}</h2>
                    <div style="color:${colors.muted}; font-size:13px;">${chainPositions.length} position${chainPositions.length > 1 ? 's' : ''} in chain</div>
                </div>
            </div>
            
            <div style="background:${colors.bgSecondary}; border-radius:10px; padding:20px; margin-bottom:20px;">
                ${timelineHtml}
            </div>
            
            <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); 
                        border-radius:10px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">NET PREMIUM COLLECTED</div>
                <div style="color:${totalNetPremium >= 0 ? colors.green : colors.red}; font-size:24px; font-weight:bold;">
                    ${totalNetPremium >= 0 ? '+' : ''}$${totalNetPremium.toFixed(0)}
                </div>
                ${totalClosingCosts > 0 ? `
                <div style="color:${colors.muted}; font-size:10px; margin-top:8px;">
                    Premiums: +$${totalReceived.toFixed(0)} | Buybacks: -$${totalClosingCosts.toFixed(0)}
                </div>
                ` : ''}
            </div>
            
            <div id="critiqueContent" style="display:none; background:${colors.bgSecondary}; border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="color:${colors.muted}; font-size:11px; margin-bottom:8px;">🧠 AI TRADE CRITIQUE</div>
                <div id="critiqueText" style="color:#ddd; font-size:12px; line-height:1.6; white-space:pre-wrap;"></div>
            </div>
            
            <div style="display:flex; justify-content:center; gap:12px;">
                <button id="critiqueBtn" onclick="window.getCritique(${chainId})" 
                        style="background:linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%); border:none; color:${colors.text}; padding:12px 24px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;">
                    🔍 AI Critique
                </button>
                <button onclick="document.getElementById('rollHistoryModal').remove()" 
                        style="background:#0096ff; border:none; color:${colors.text}; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;">
                    Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Fix broken roll data - allows adding closePrice and status to positions
 * that were rolled but didn't get proper close data saved
 */
window.fixRollCloseData = function(positionId, inClosedList) {
    // Find the position
    const sourceList = inClosedList ? state.closedPositions : state.positions;
    const pos = sourceList.find(p => p.id === positionId);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const modal = document.createElement('div');
    modal.id = 'fixRollModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10001;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const currentClosePrice = pos.closePrice || pos.closingPrice || '';
    const currentStatus = pos.status || 'open';
    const currentCloseDate = pos.closeDate || '';
    const currentCloseReason = pos.closeReason || '';
    
    modal.innerHTML = `
        <div style="background:${colors.bgPrimary}; border:1px solid #ff9800; border-radius:12px; padding:25px; width:90%; max-width:400px;">
            <h3 style="margin:0 0 20px 0; color:#ff9800;">🔧 Fix Roll Close Data</h3>
            <div style="color:#aaa; font-size:12px; margin-bottom:15px;">
                <strong>${pos.ticker}</strong> $${pos.strike} - ${pos.expiry}
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa; font-size:12px; display:block; margin-bottom:5px;">Status</label>
                <select id="fixStatus" style="width:100%; padding:10px; background:#1a1a2e; color:white; border:1px solid #333; border-radius:6px;">
                    <option value="open" ${currentStatus === 'open' ? 'selected' : ''}>Open</option>
                    <option value="closed" ${currentStatus === 'closed' ? 'selected' : ''}>Closed</option>
                </select>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa; font-size:12px; display:block; margin-bottom:5px;">Close Reason</label>
                <select id="fixCloseReason" style="width:100%; padding:10px; background:#1a1a2e; color:white; border:1px solid #333; border-radius:6px;">
                    <option value="" ${!currentCloseReason ? 'selected' : ''}>Not Closed</option>
                    <option value="rolled" ${currentCloseReason === 'rolled' ? 'selected' : ''}>Rolled</option>
                    <option value="expired" ${currentCloseReason === 'expired' ? 'selected' : ''}>Expired</option>
                    <option value="assigned" ${currentCloseReason === 'assigned' ? 'selected' : ''}>Assigned</option>
                    <option value="called" ${currentCloseReason === 'called' ? 'selected' : ''}>Called Away</option>
                    <option value="closed" ${currentCloseReason === 'closed' ? 'selected' : ''}>Closed Early</option>
                </select>
            </div>
            
            <div style="margin-bottom:15px;">
                <label style="color:#aaa; font-size:12px; display:block; margin-bottom:5px;">Close/Buyback Price (per share)</label>
                <input type="number" id="fixClosePrice" step="0.01" value="${currentClosePrice}" 
                       style="width:100%; padding:10px; background:#1a1a2e; color:white; border:1px solid #333; border-radius:6px;" 
                       placeholder="0.00">
            </div>
            
            <div style="margin-bottom:20px;">
                <label style="color:#aaa; font-size:12px; display:block; margin-bottom:5px;">Close Date</label>
                <input type="date" id="fixCloseDate" value="${currentCloseDate}" 
                       style="width:100%; padding:10px; background:#1a1a2e; color:white; border:1px solid #333; border-radius:6px;">
            </div>
            
            <div style="display:flex; gap:10px;">
                <button onclick="window.applyRollFix(${positionId}, ${inClosedList})" 
                        style="flex:1; padding:12px; background:linear-gradient(135deg, #ff9800 0%, #ff5722 100%); color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">
                    Apply Fix
                </button>
                <button onclick="document.getElementById('fixRollModal').remove()" 
                        style="flex:1; padding:12px; background:#333; color:white; border:none; border-radius:6px; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

/**
 * Apply the roll fix
 */
window.applyRollFix = function(positionId, inClosedList) {
    const status = document.getElementById('fixStatus').value;
    const closeReason = document.getElementById('fixCloseReason').value;
    const closePrice = parseFloat(document.getElementById('fixClosePrice').value) || 0;
    const closeDate = document.getElementById('fixCloseDate').value;
    
    const sourceList = inClosedList ? state.closedPositions : state.positions;
    const pos = sourceList.find(p => p.id === positionId);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    // If changing from open to closed, we need to MOVE between lists
    const wasOpen = (pos.status === 'open' || !pos.status) && !inClosedList;
    const isNowClosed = status === 'closed';
    
    // Update the position fields
    pos.status = status;
    pos.closePrice = closePrice > 0 ? closePrice : undefined;
    if (pos.closingPrice) delete pos.closingPrice;  // Remove old field name
    pos.closeReason = closeReason || undefined;
    pos.closeDate = closeDate || undefined;
    
    // Calculate realized P&L if being closed
    if (isNowClosed && closePrice >= 0) {
        pos.realizedPnL = calculateRealizedPnL(pos, closePrice);
    }
    
    // Move between lists if needed
    if (wasOpen && isNowClosed) {
        // Move from positions to closedPositions
        state.positions = state.positions.filter(p => p.id !== positionId);
        if (!state.closedPositions) state.closedPositions = [];
        state.closedPositions.push(pos);
        savePositionsToStorage();
        saveClosedToStorage();
    } else {
        // Just save the appropriate list
        if (inClosedList) {
            saveClosedToStorage();
        } else {
            savePositionsToStorage();
        }
    }
    
    document.getElementById('fixRollModal').remove();
    document.getElementById('rollHistoryModal')?.remove();
    
    showNotification('Roll data fixed! Refresh roll history to see changes.', 'success');
    renderPositions();
};

/**
 * Get AI critique for a trade chain
 */
window.getCritique = async function(chainId) {
    const critiqueBtn = document.getElementById('critiqueBtn');
    const critiqueContent = document.getElementById('critiqueContent');
    const critiqueText = document.getElementById('critiqueText');
    
    if (!critiqueBtn || !critiqueContent || !critiqueText) return;
    
    // Show loading state
    critiqueBtn.disabled = true;
    critiqueBtn.textContent = '⏳ Analyzing...';
    critiqueContent.style.display = 'block';
    critiqueText.innerHTML = '<span style="color:#888;">🔄 AI is reviewing your trade... (10-20 seconds)</span>';
    
    try {
        // Gather all positions in this chain
        const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
        const chainPositions = allPositions
            .filter(p => (p.chainId || p.id) === chainId)
            .sort((a, b) => new Date(a.openDate || 0) - new Date(b.openDate || 0));
        
        if (chainPositions.length === 0) {
            critiqueText.innerHTML = '<span style="color:#ff5252;">No positions found for this chain.</span>';
            return;
        }
        
        const ticker = chainPositions[0]?.ticker || 'Unknown';
        
        // Calculate totals - NET premium (received minus buybacks)
        let totalReceived = 0;
        let totalBuybacks = 0;
        chainPositions.forEach(p => {
            const isDebit = p.type?.includes('long') || p.type?.includes('debit');
            const premium = p.premium * 100 * (p.contracts || 1);
            if (isDebit) {
                totalBuybacks += premium; // Debit trades are costs
            } else {
                totalReceived += premium; // Credit trades are income
            }
            // If position was rolled, subtract the buyback cost
            if (p.closeReason === 'rolled' && p.closePrice) {
                totalBuybacks += p.closePrice * 100 * (p.contracts || 1);
            }
        });
        const totalPremium = totalReceived - totalBuybacks; // NET premium
        
        const firstOpen = new Date(chainPositions[0]?.openDate || Date.now());
        const lastClose = chainPositions[chainPositions.length - 1]?.closeDate;
        const lastDate = lastClose ? new Date(lastClose) : new Date();
        const totalDays = Math.round((lastDate - firstOpen) / (1000 * 60 * 60 * 24));
        
        // Determine final outcome
        const lastPos = chainPositions[chainPositions.length - 1];
        let finalOutcome = 'Still open';
        if (lastPos.status === 'closed') {
            finalOutcome = lastPos.closeReason === 'expired' ? 'Expired worthless (max profit)' :
                          lastPos.closeReason === 'assigned' ? 'Assigned (bought shares)' :
                          lastPos.closeReason === 'called' ? 'Called away' :
                          lastPos.closeReason === 'rolled' ? 'Rolled (chain continues)' :
                          'Closed early';
        }
        
        // Get selected model (global with local override)
        const selectedModel = window.getSelectedAIModel?.('aiModelSelect') || 'qwen2.5:14b';
        
        // Call the critique API
        const response = await fetch('/api/ai/critique', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                chainHistory: chainPositions,
                totalPremium,
                totalDays,
                finalOutcome,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Format the critique with styling
        let formatted = result.critique
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Grade:\s*[A-F][+-]?)/gi, '<span style="color:#00ff88; font-weight:bold;">$1</span>')
            .replace(/(What went well|What could improve|Key lesson)/gi, '<span style="color:#ffaa00;">$1</span>');
        
        critiqueText.innerHTML = formatted;
        critiqueBtn.textContent = '✅ Critique Complete';
        
    } catch (e) {
        console.error('Critique error:', e);
        critiqueText.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>`;
        critiqueBtn.disabled = false;
        critiqueBtn.textContent = '🔍 Retry Critique';
    }
};

/**
 * Show AI-style spread explanation modal with live P/L and AI advisor
 */
window.showSpreadExplanation = async function(posId) {
    const pos = state.positions?.find(p => p.id === posId) || 
                state.closedPositions?.find(p => p.id === posId);
    
    if (!pos) {
        console.error('Position not found:', posId);
        return;
    }
    
    const explanation = getSpreadExplanation(pos);
    if (!explanation) {
        console.error('No spread explanation for:', pos.type);
        return;
    }
    
    // Determine direction color
    const dirColor = explanation.direction === 'BULLISH' ? colors.green : colors.red;
    const dirEmoji = explanation.direction === 'BULLISH' ? '📈' : '📉';
    
    // Calculate current P/L
    const currentSpread = pos.lastOptionPrice ?? pos.markedPrice ?? null;
    const entrySpread = pos.premium || 0;
    const isCredit = pos.type?.includes('credit');
    let unrealizedPnL = null;
    let pnlColor = colors.muted;
    let pnlSign = '';
    
    if (currentSpread !== null && entrySpread > 0) {
        if (isCredit) {
            // Credit spread: profit if current < entry
            unrealizedPnL = (entrySpread - currentSpread) * 100 * (pos.contracts || 1);
        } else {
            // Debit spread: profit if current > entry
            unrealizedPnL = (currentSpread - entrySpread) * 100 * (pos.contracts || 1);
        }
        pnlColor = unrealizedPnL >= 0 ? colors.green : colors.red;
        pnlSign = unrealizedPnL >= 0 ? '+' : '';
    }
    
    // Calculate DTE (normalize to midnight local time to avoid timezone issues)
    const today = new Date();
    today.setHours(0, 0, 0, 0);  // Midnight today local time
    const expDate = new Date(pos.expiry + 'T00:00:00');  // Parse as local midnight
    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
    
    // Get current spot price if available
    const spotPrice = pos.currentSpot || null;
    
    // Determine short leg strike for risk display
    const shortStrike = pos.type?.includes('credit') 
        ? (pos.type?.includes('put') ? pos.sellStrike : pos.sellStrike)
        : (pos.type?.includes('put') ? pos.buyStrike : pos.buyStrike);

        // Get ITM color logic for spot price - try to use cached IV
        const cachedIV = ivCache.get(pos.ticker?.toUpperCase());
        const realIV = cachedIV?.iv || null;
        const spotRisk = calculatePositionRisk(pos, spotPrice, realIV);
        const spotColor = spotRisk?.color || colors.text;
    
    const modal = document.createElement('div');
    modal.id = 'spreadExplanationModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, ${colors.bgPrimary} 0%, #16213e 100%); border:1px solid ${colors.purple}; 
                    border-radius:16px; padding:30px; width:90%; max-width:650px; max-height:90vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(139, 92, 246, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
                <span style="font-size:32px;">🤖</span>
                <div>
                    <h2 style="margin:0; color:${colors.text}; font-size:20px;">${explanation.name}</h2>
                    <div style="color:${colors.muted}; font-size:13px;">${pos.ticker} • ${pos.contracts} contract${pos.contracts > 1 ? 's' : ''} • Exp: ${pos.expiry}</div>
                </div>
                <span style="margin-left:auto; background:${dirColor}22; color:${dirColor}; 
                             padding:6px 14px; border-radius:20px; font-weight:bold; font-size:13px;">
                    ${dirEmoji} ${explanation.direction}
                </span>
            </div>
            
            <!-- Current Status Section -->
            <div style="background:linear-gradient(135deg, #1a1a3e 0%, #0d1b2a 100%); border:1px solid ${colors.cyan}44; 
                        border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="color:${colors.cyan}; font-size:12px; font-weight:bold; margin-bottom:12px; text-transform:uppercase;">
                    📊 Current Status
                </div>
                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px;">
                    <div style="text-align:center;">
                        <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">DTE</div>
                        <div style="color:${dte <= 7 ? colors.red : dte <= 21 ? colors.orange : colors.text}; font-size:16px; font-weight:bold;">${dte}d</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">Spot</div>
                        <div style="color:${colors.text}; font-size:16px; font-weight:bold;">${spotPrice ? '$' + spotPrice.toFixed(2) : '—'}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">Current</div>
                            <div style="color:${spotColor}; font-size:16px; font-weight:bold;">${spotPrice ? '$' + spotPrice.toFixed(2) : '—'}</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">Unrealized P/L</div>
                        <div style="color:${pnlColor}; font-size:16px; font-weight:bold;">${unrealizedPnL !== null ? pnlSign + '$' + Math.abs(unrealizedPnL).toFixed(0) : '—'}</div>
                    </div>
                </div>
            </div>
            
            <div style="background:${colors.bgSecondary}; border-radius:10px; padding:20px; margin-bottom:20px;">
                <div style="color:${colors.purple}; font-weight:bold; margin-bottom:8px; font-size:12px; text-transform:uppercase;">
                    📋 Setup
                </div>
                <div style="color:${colors.text}; font-size:16px; font-weight:bold;">${explanation.setup}</div>
                <div style="color:${colors.muted}; font-size:14px; margin-top:6px;">${explanation.cost}</div>
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:20px;">
                <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:${colors.green}; font-size:12px; font-weight:bold; margin-bottom:6px;">💰 MAX PROFIT</div>
                    <div style="color:${colors.text}; font-size:14px;">${explanation.maxProfit}</div>
                </div>
                <div style="background:rgba(255,82,82,0.1); border:1px solid rgba(255,82,82,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:${colors.red}; font-size:12px; font-weight:bold; margin-bottom:6px;">⚠️ MAX LOSS</div>
                    <div style="color:${colors.text}; font-size:14px;">${explanation.maxLoss}</div>
                </div>
            </div>
            
            <div style="background:${colors.bgSecondary}; border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="color:${colors.orange}; font-size:12px; font-weight:bold; margin-bottom:6px;">🎯 BREAKEVEN</div>
                <div style="color:${colors.text}; font-size:14px;">${explanation.breakeven}</div>
            </div>
            
            <div style="background:linear-gradient(135deg, #1e1e3f 0%, #2a1f4e 100%); 
                        border-radius:10px; padding:20px; margin-bottom:20px;">
                <div style="color:#b9f; font-size:12px; font-weight:bold; margin-bottom:10px;">
                    🧠 HOW THIS TRADE WORKS
                </div>
                <div style="color:#ddd; font-size:14px; line-height:1.6;">${explanation.howItWorks}</div>
            </div>
            
            <div style="background:rgba(139,92,246,0.15); border:1px solid rgba(139,92,246,0.4); 
                        border-radius:10px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="color:${colors.purple}; font-size:14px; font-weight:bold;">${explanation.riskReward}</div>
            </div>
            
            <!-- AI Advisor Section -->
            <div id="spreadAiAdvisor" style="background:linear-gradient(135deg, #1a2a1a 0%, #0d2818 100%); border:1px solid ${colors.green}44; 
                        border-radius:10px; padding:15px; margin-bottom:20px; display:none;">
                <div style="color:${colors.green}; font-size:12px; font-weight:bold; margin-bottom:10px; text-transform:uppercase;">
                    🤖 AI Recommendation
                </div>
                <div id="spreadAiContent" style="color:#ddd; font-size:14px; line-height:1.6;">
                    Loading...
                </div>
            </div>
            
            <div style="display:flex; justify-content:center; gap:12px;">
                <button onclick="document.getElementById('spreadExplanationModal').remove()" 
                        style="background:${colors.bgSecondary}; border:1px solid ${colors.purple}; color:${colors.text}; padding:12px 30px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;
                               transition: all 0.2s;">
                    Got it! 👍
                </button>
                <button id="spreadAskAiBtn" onclick="window.askSpreadAI(${pos.id})" 
                        style="background:linear-gradient(135deg, ${colors.green} 0%, #059669 100%); border:none; color:#000; padding:12px 30px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;
                               transition: all 0.2s;">
                    🧠 What Should I Do?
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Ask AI for spread position advice - calls backend /api/ai/spread-advisor endpoint
 */
window.askSpreadAI = async function(posId) {
    const pos = state.positions?.find(p => p.id === posId);
    if (!pos) return;
    
    const btn = document.getElementById('spreadAskAiBtn');
    const advisorSection = document.getElementById('spreadAiAdvisor');
    const contentDiv = document.getElementById('spreadAiContent');
    
    if (!btn || !advisorSection || !contentDiv) return;
    
    // Show loading state
    btn.disabled = true;
    btn.innerHTML = '⏳ Analyzing...';
    btn.style.opacity = '0.6';
    advisorSection.style.display = 'block';
    contentDiv.innerHTML = '<em style="color:#888;">Analyzing your spread position...</em>';
    
    try {
        // Get AI model (global with local override)
        const model = window.getSelectedAIModel?.('aiModelSelect') || 'qwen2.5:14b';
        
        // Get chain history if available
        const chainId = pos.chainId || pos.id;
        const chainHistory = [
            ...(state.closedPositions || []).filter(p => p.chainId === chainId),
            ...(state.positions || []).filter(p => p.chainId === chainId || p.id === chainId)
        ].map(p => ({
            strike: p.sellStrike || p.strike,
            buyStrike: p.buyStrike,
            expiry: p.expiry,
            premium: p.premium,
            closeReason: p.closeReason || 'open'
        }));
        
        // Call backend endpoint
        const response = await fetch('/api/ai/spread-advisor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: pos.ticker,
                positionType: pos.type,
                sellStrike: pos.sellStrike,
                buyStrike: pos.buyStrike,
                contracts: pos.contracts || 1,
                entryPremium: pos.premium || 0,
                expiry: pos.expiry,
                model,
                chainHistory,
                analysisHistory: pos.analysisHistory || [],
                openingThesis: pos.openingThesis || null
            })
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'AI request failed');
        }
        
        const data = await response.json();
        const insight = data.insight || 'No recommendation available';
        const { recommendation, spotPrice, dte, isITM, maxProfit, maxLoss } = data;
        
        // Parse recommendation type from response for styling
        let recColor = colors.text;
        let recIcon = '💡';
        if (recommendation === 'CLOSE') {
            recColor = colors.green;
            recIcon = '💰';
        } else if (recommendation === 'CLOSE_EARLY') {
            recColor = colors.orange;
            recIcon = '⚡';
        } else if (recommendation === 'HOLD') {
            recColor = colors.cyan;
            recIcon = '⏳';
        }
        
        // Format the response nicely
        const sentences = insight.split(/(?<=[.!?])\s+/);
        const headline = sentences[0] || insight;
        const details = sentences.slice(1).join(' ');
        
        const modelDisplay = (data.model || model).replace('qwen2.5:', 'Qwen ').replace('deepseek-r1:', 'DeepSeek ');
        
        contentDiv.innerHTML = `
            <div style="color:${recColor}; font-weight:bold; font-size:16px; margin-bottom:8px;">${recIcon} ${headline}</div>
            ${details ? `<div style="color:#bbb; font-size:13px; line-height:1.5;">${details}</div>` : ''}
            <div style="margin-top:10px; padding-top:10px; border-top:1px solid #333; font-size:11px; color:#666;">
                <span>Stock: $${spotPrice?.toFixed(2) || '?'}</span> · 
                <span>DTE: ${dte}</span> · 
                <span>${isITM ? '⚠️ ITM' : '✅ OTM'}</span> · 
                <span style="color:#00ff88;">Max Profit: $${maxProfit?.toFixed(0) || '?'}</span>
            </div>
            <div style="color:#666; font-size:11px; margin-top:8px; text-align:right;">via ${modelDisplay}</div>
        `;
        
        btn.innerHTML = '✓ Got Advice';
        btn.style.background = colors.bgSecondary;
        btn.style.opacity = '1';
        
    } catch (err) {
        console.error('Spread AI error:', err);
        contentDiv.innerHTML = `<span style="color:${colors.red};">❌ ${err.message || 'Could not get AI recommendation. Make sure Ollama is running.'}</span>`;
        btn.innerHTML = '🧠 Try Again';
        btn.disabled = false;
        btn.style.opacity = '1';
    }
};

/**
 * Show SKIP Call™ strategy explanation modal
 */
window.showSkipExplanation = function(posId) {
    const pos = state.positions?.find(p => p.id === posId) || 
                state.closedPositions?.find(p => p.id === posId);
    
    if (!pos || pos.type !== 'skip_call') {
        console.error('SKIP position not found:', posId);
        return;
    }
    
    // Calculate key metrics
    const totalInvestment = pos.totalInvestment || ((pos.leapsPremium + pos.skipPremium) * 100 * pos.contracts);
    const leapsDte = pos.leapsDte || Math.ceil((new Date(pos.leapsExpiry) - new Date()) / (1000 * 60 * 60 * 24));
    const skipDte = pos.skipDte || Math.ceil((new Date(pos.skipExpiry) - new Date()) / (1000 * 60 * 60 * 24));
    
    // Exit window status
    let exitStatus, exitStatusColor;
    if (skipDte < 45) {
        exitStatus = '🚨 PAST EXIT WINDOW - Close SKIP immediately!';
        exitStatusColor = colors.red;
    } else if (skipDte <= 60) {
        exitStatus = '⚠️ IN EXIT WINDOW (45-60 DTE) - Time to sell SKIP call';
        exitStatusColor = colors.orange;
    } else if (skipDte <= 90) {
        exitStatus = '📅 Approaching exit window - Monitor closely';
        exitStatusColor = colors.cyan;
    } else {
        exitStatus = '✅ SKIP call has time remaining - Hold';
        exitStatusColor = colors.green;
    }
    
    const modal = document.createElement('div');
    modal.id = 'skipExplanationModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, ${colors.bgPrimary} 0%, #0a2540 100%); border:1px solid ${colors.cyan}; 
                    border-radius:16px; padding:30px; width:90%; max-width:650px; max-height:90vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 217, 255, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
                <span style="font-size:32px;">🎯</span>
                <div>
                    <h2 style="margin:0; color:${colors.text}; font-size:20px;">SKIP Call™ Strategy</h2>
                    <div style="color:${colors.muted}; font-size:13px;">${pos.ticker} • ${pos.contracts} contract${pos.contracts > 1 ? 's' : ''} • "Safely Keep Increasing Profits"</div>
                </div>
                <span style="margin-left:auto; background:${colors.green}22; color:${colors.green}; 
                             padding:6px 14px; border-radius:20px; font-weight:bold; font-size:13px;">
                    📈 BULLISH
                </span>
            </div>
            
            <div style="background:${exitStatusColor}22; border:1px solid ${exitStatusColor}55; border-radius:10px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="color:${exitStatusColor}; font-weight:bold; font-size:14px;">${exitStatus}</div>
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:20px;">
                <div style="background:rgba(0,150,255,0.1); border:1px solid rgba(0,150,255,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:#6bf; font-size:12px; font-weight:bold; margin-bottom:6px;">📅 LEAPS (Long-Term)</div>
                    <div style="color:${colors.text}; font-size:16px; font-weight:bold;">$${pos.leapsStrike} strike</div>
                    <div style="color:${colors.muted}; font-size:13px;">Exp: ${pos.leapsExpiry}</div>
                    <div style="color:${colors.cyan}; font-size:13px; font-weight:bold;">${leapsDte} days remaining</div>
                    <div style="color:${colors.muted}; font-size:12px; margin-top:4px;">Premium: $${pos.leapsPremium?.toFixed(2) || '—'}</div>
                </div>
                <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:${colors.green}; font-size:12px; font-weight:bold; margin-bottom:6px;">⚡ SKIP Call (Overlay)</div>
                    <div style="color:${colors.text}; font-size:16px; font-weight:bold;">$${pos.skipStrike || pos.strike} strike</div>
                    <div style="color:${colors.muted}; font-size:13px;">Exp: ${pos.skipExpiry || pos.expiry}</div>
                    <div style="color:${skipDte <= 60 ? colors.orange : colors.cyan}; font-size:13px; font-weight:bold;">${skipDte} days remaining</div>
                    <div style="color:${colors.muted}; font-size:12px; margin-top:4px;">Premium: $${(pos.skipPremium || pos.premium)?.toFixed(2) || '—'}</div>
                </div>
            </div>
            
            <div style="background:${colors.bgSecondary}; border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="color:${colors.orange}; font-size:12px; font-weight:bold; margin-bottom:6px;">💰 TOTAL INVESTMENT</div>
                <div style="color:${colors.text}; font-size:20px; font-weight:bold;">$${totalInvestment.toFixed(0)}</div>
                <div style="color:${colors.muted}; font-size:12px; margin-top:4px;">
                    LEAPS: $${(pos.leapsPremium * 100 * pos.contracts).toFixed(0)} + SKIP: $${((pos.skipPremium || pos.premium) * 100 * pos.contracts).toFixed(0)}
                </div>
            </div>
            
            <div style="background:linear-gradient(135deg, #1e1e3f 0%, #0a2540 100%); 
                        border-radius:10px; padding:20px; margin-bottom:20px;">
                <div style="color:#0df; font-size:12px; font-weight:bold; margin-bottom:10px;">
                    🧠 HOW SKIP WORKS
                </div>
                <div style="color:#ddd; font-size:14px; line-height:1.7;">
                    <p style="margin-bottom:12px;"><strong>The Strategy:</strong> You own a LEAPS call (12+ months out) on ${pos.ticker}. To accelerate profits while the underlying moves up, you add a shorter-term "SKIP" call (3-9 months) at a higher strike.</p>
                    
                    <p style="margin-bottom:12px;"><strong>Why it works:</strong> When ${pos.ticker} rises, both calls gain value. The shorter SKIP call has higher gamma and moves faster on near-term price action. This lets you "skip ahead" and capture quicker profits.</p>
                    
                    <p style="margin-bottom:12px;"><strong>The Exit Rule:</strong> <span style="color:${colors.orange}; font-weight:bold;">Close the SKIP call when it reaches 45-60 DTE.</span> This locks in gains before rapid theta decay eats into your profits. Your LEAPS continues riding the longer trend.</p>
                    
                    <p style="margin:0;"><strong>Rinse & Repeat:</strong> After closing the SKIP, you can add a new SKIP call if the bullish thesis remains intact. Each successful SKIP reduces your LEAPS cost basis.</p>
                </div>
            </div>
            
            <div style="background:rgba(0,217,255,0.15); border:1px solid rgba(0,217,255,0.4); 
                        border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:15px; text-align:center;">
                    <div>
                        <div style="color:${colors.muted}; font-size:11px; text-transform:uppercase;">LEAPS DTE</div>
                        <div style="color:${colors.cyan}; font-size:18px; font-weight:bold;">${leapsDte}d</div>
                    </div>
                    <div>
                        <div style="color:${colors.muted}; font-size:11px; text-transform:uppercase;">SKIP DTE</div>
                        <div style="color:${skipDte <= 60 ? colors.orange : colors.green}; font-size:18px; font-weight:bold;">${skipDte}d</div>
                    </div>
                    <div>
                        <div style="color:${colors.muted}; font-size:11px; text-transform:uppercase;">Exit Window</div>
                        <div style="color:${skipDte <= 60 ? colors.orange : colors.muted}; font-size:18px; font-weight:bold;">${skipDte <= 60 ? 'NOW' : `In ${skipDte - 60}d`}</div>
                    </div>
                </div>
            </div>
            
            <div style="display:flex; justify-content:center; gap:10px;">
                <button onclick="document.getElementById('skipExplanationModal').remove()" 
                        style="background:${colors.cyan}; border:none; color:${colors.bgPrimary}; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;">
                    Got it! 👍
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

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
 * Check for data loss on startup
 */
function checkDataIntegrity() {
    const checkpointStr = localStorage.getItem(getCheckpointKey());
    if (!checkpointStr) return; // No checkpoint, first run
    
    try {
        const checkpoint = JSON.parse(checkpointStr);
        const currentClosed = (state.closedPositions || []).length;
        const expectedClosed = checkpoint.closedPositions || 0;
        
        // If we had closed positions but now have none/fewer, warn user
        if (expectedClosed > 5 && currentClosed < expectedClosed * 0.5) {
            console.warn(`⚠️ Data integrity warning: Expected ${expectedClosed} closed positions, found ${currentClosed}`);
            
            // Show recovery prompt
            setTimeout(() => {
                showDataRecoveryPrompt(expectedClosed, currentClosed);
            }, 500);
        }
    } catch (e) {
        console.warn('Checkpoint check failed:', e);
    }
}

/**
 * Show data recovery prompt to user
 */
function showDataRecoveryPrompt(expected, actual) {
    const msg = `⚠️ Data Loss Detected!\n\nExpected ${expected} closed positions but found only ${actual}.\n\nYour browser localStorage may have been cleared.\n\nClick "Import" to restore from your backup file:\n📁 C:\\WheelHouse\\examples\\wheelhouse_backup_2026-01-16 (1).json`;
    
    // Create a prominent banner
    const banner = document.createElement('div');
    banner.id = 'dataRecoveryBanner';
    banner.innerHTML = `
        <div style="background: linear-gradient(135deg, #ff5252, #ff1744); color: white; padding: 15px 20px; 
                    position: fixed; top: 0; left: 0; right: 0; z-index: 10000; 
                    display: flex; justify-content: space-between; align-items: center;
                    box-shadow: 0 4px 20px rgba(255,82,82,0.5);">
            <div>
                <strong>⚠️ Data Loss Detected!</strong> 
                Expected ${expected} closed positions, found ${actual}. 
                Your localStorage may have been cleared.
            </div>
            <div style="display: flex; gap: 10px;">
                <button onclick="document.getElementById('importBtn')?.click(); document.getElementById('dataRecoveryBanner')?.remove();" 
                        style="background: white; color: #ff1744; border: none; padding: 8px 16px; 
                               border-radius: 4px; font-weight: bold; cursor: pointer;">
                    📥 Restore from Backup
                </button>
                <button onclick="document.getElementById('dataRecoveryBanner')?.remove(); localStorage.setItem('${getCheckpointKey()}', JSON.stringify({closedPositions: ${actual}, timestamp: Date.now()}));" 
                        style="background: transparent; color: white; border: 1px solid white; 
                               padding: 8px 16px; border-radius: 4px; cursor: pointer;">
                    ✕ Dismiss
                </button>
            </div>
        </div>
    `;
    document.body.prepend(banner);
}

/**
 * Load positions from localStorage
 */
export function loadPositions() {
    try {
        const saved = localStorage.getItem(getStorageKey());
        if (saved) {
            state.positions = JSON.parse(saved) || [];
        } else {
            state.positions = [];
        }
    } catch (e) {
        console.warn('Failed to load positions:', e);
        state.positions = [];
    }
    
    // Load holdings (share ownership from assignments and buy/writes)
    try {
        const savedHoldings = localStorage.getItem(getHoldingsStorageKey());
        if (savedHoldings) {
            state.holdings = JSON.parse(savedHoldings) || [];
            
            // Load positions first so we can link holdings to them
            const savedPositions = localStorage.getItem(getStorageKey());
            const positions = savedPositions ? JSON.parse(savedPositions) : [];
            
            // Migrate old holdings - add missing fields for display compatibility
            let needsSave = false;
            state.holdings.forEach(h => {
                // Add totalCost if missing
                if (h.totalCost === undefined && h.costBasis && h.shares) {
                    h.totalCost = h.costBasis * h.shares;
                    needsSave = true;
                }
                
                // For Buy/Write holdings, try to find the linked position to get strike/premium
                if (h.source === 'buy_write') {
                    // Try to find linked position by ID or by ticker + type
                    let linkedPos = null;
                    if (h.linkedPositionId) {
                        linkedPos = positions.find(p => p.id === h.linkedPositionId);
                    }
                    if (!linkedPos) {
                        // Fall back to finding a buy_write position for this ticker
                        linkedPos = positions.find(p => p.ticker === h.ticker && p.type === 'buy_write');
                    }
                    
                    if (linkedPos) {
                        // Copy strike from position if missing
                        if (!h.strike && linkedPos.strike) {
                            h.strike = linkedPos.strike;
                            needsSave = true;
                        }
                        // Copy premium from position if missing
                        if (!h.premiumCredit && linkedPos.premium) {
                            h.premiumCredit = linkedPos.premium * 100 * (linkedPos.contracts || 1);
                            needsSave = true;
                        }
                        // Link the position if not already
                        if (!h.linkedPositionId) {
                            h.linkedPositionId = linkedPos.id;
                            needsSave = true;
                        }
                        // Calculate max profit if missing
                        if (!h.maxProfit && h.strike && h.costBasis) {
                            const gainOnShares = Math.max(0, (h.strike - h.costBasis) * h.shares);
                            h.maxProfit = gainOnShares + (h.premiumCredit || 0);
                            needsSave = true;
                        }
                    }
                }
                
                // Add premiumCredit if still missing (default to 0)
                if (h.premiumCredit === undefined) {
                    h.premiumCredit = 0;
                    needsSave = true;
                }
                
                // Use acquiredDate as assignedDate if missing
                if (!h.assignedDate && h.acquiredDate) {
                    h.assignedDate = h.acquiredDate;
                    needsSave = true;
                }
            });
            
            if (needsSave) {
                localStorage.setItem(getHoldingsStorageKey(), JSON.stringify(state.holdings));
                console.log('Migrated holdings with new fields from linked positions');
            }
        } else {
            state.holdings = [];
        }
    } catch (e) {
        console.warn('Failed to load holdings:', e);
        state.holdings = [];
    }
    
    // Load closed positions
    try {
        const savedClosed = localStorage.getItem(getClosedStorageKey());
        if (savedClosed) {
            state.closedPositions = JSON.parse(savedClosed) || [];
        } else {
            state.closedPositions = [];
        }
    } catch (e) {
        console.warn('Failed to load closed positions:', e);
        state.closedPositions = [];
    }
    
    // Check for data loss
    checkDataIntegrity();
    
    renderPositions();
    updatePortfolioSummary();
}

// Auto-save file handle (File System Access API)
let autoSaveFileHandle = null;
let autoSaveDebounceTimer = null;

/**
 * Save positions to localStorage AND auto-save file if enabled
 */
export function savePositionsToStorage() {
    try {
        localStorage.setItem(getStorageKey(), JSON.stringify(state.positions));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save positions:', e);
    }
}

/**
 * Save holdings to localStorage AND auto-save file if enabled
 */
export function saveHoldingsToStorage() {
    try {
        localStorage.setItem(getHoldingsStorageKey(), JSON.stringify(state.holdings));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save holdings:', e);
    }
}

/**
 * Save closed positions to localStorage (call this whenever closedPositions changes)
 */
export function saveClosedToStorage() {
    try {
        localStorage.setItem(getClosedStorageKey(), JSON.stringify(state.closedPositions));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save closed positions:', e);
    }
}

/**
 * Trigger auto-save with debounce (waits 2 seconds after last change)
 */
function triggerAutoSave() {
    if (!autoSaveFileHandle) return;
    
    // Debounce - wait for activity to stop
    if (autoSaveDebounceTimer) clearTimeout(autoSaveDebounceTimer);
    autoSaveDebounceTimer = setTimeout(() => {
        performAutoSave();
    }, 2000);
}

// Expose for portfolio.js to call
window.triggerAutoSave = triggerAutoSave;

/**
 * Actually write to the auto-save file
 */
async function performAutoSave() {
    if (!autoSaveFileHandle) return;
    
    try {
        const CLOSED_KEY = 'wheelhouse_closed_positions';
        const exportData = {
            version: 1,
            exportDate: new Date().toISOString(),
            positions: state.positions || [],
            holdings: state.holdings || [],
            closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
        };
        
        const writable = await autoSaveFileHandle.createWritable();
        await writable.write(JSON.stringify(exportData, null, 2));
        await writable.close();
        
        // Update status indicator
        updateAutoSaveStatus('saved');
        console.log('✅ Auto-saved to file');
    } catch (e) {
        console.warn('Auto-save failed:', e);
        updateAutoSaveStatus('error');
    }
}

/**
 * Setup auto-save - user picks a file location (or uses download fallback for Brave/Firefox)
 */
export async function setupAutoSave() {
    try {
        // Check if File System Access API is supported
        if (!('showSaveFilePicker' in window)) {
            // Fallback: Use periodic download-based save
            setupAutoSaveDownloadFallback();
            return;
        }
        
        const handle = await window.showSaveFilePicker({
            suggestedName: 'wheelhouse_autosave.json',
            types: [{
                description: 'JSON Files',
                accept: { 'application/json': ['.json'] }
            }]
        });
        
        autoSaveFileHandle = handle;
        
        // Do an immediate save
        await performAutoSave();
        
        updateAutoSaveStatus('enabled');
        showNotification('✅ Auto-save enabled! Your data will be saved automatically.', 'success', 4000);
        
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error('Setup auto-save failed:', e);
            showNotification('❌ Failed to setup auto-save: ' + e.message, 'error');
        }
    }
}

/**
 * Fallback auto-save for browsers without File System Access API (Brave, Firefox)
 * Saves to localStorage more aggressively and offers manual download
 */
let autoSaveDownloadInterval = null;

function setupAutoSaveDownloadFallback() {
    // Clear any existing interval
    if (autoSaveDownloadInterval) {
        clearInterval(autoSaveDownloadInterval);
    }
    
    // Save a backup copy every 2 minutes to a separate localStorage key
    autoSaveDownloadInterval = setInterval(() => {
        try {
            const CLOSED_KEY = 'wheelhouse_closed_positions';
            const backup = {
                version: 1,
                backupDate: new Date().toISOString(),
                positions: state.positions || [],
                holdings: state.holdings || [],
                closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
            };
            localStorage.setItem('wheelhouse_backup', JSON.stringify(backup));
            updateAutoSaveStatus('saved');
            console.log('📦 Auto-backup saved to localStorage');
        } catch (e) {
            console.warn('Auto-backup failed:', e);
            updateAutoSaveStatus('error');
        }
    }, 2 * 60 * 1000); // Every 2 minutes
    
    // Do an immediate backup
    try {
        const CLOSED_KEY = 'wheelhouse_closed_positions';
        const backup = {
            version: 1,
            backupDate: new Date().toISOString(),
            positions: state.positions || [],
            holdings: state.holdings || [],
            closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
        };
        localStorage.setItem('wheelhouse_backup', JSON.stringify(backup));
    } catch (e) {
        console.warn('Initial backup failed:', e);
    }
    
    updateAutoSaveStatus('enabled');
    showNotification('✅ Auto-backup enabled! Data saved to browser storage every 2 min.\n💡 Use "Export All" for file backup.', 'success', 5000);
}

/**
 * Download current data as a file (manual backup for Brave/Firefox users)
 */
window.downloadBackup = function() {
    try {
        const CLOSED_KEY = 'wheelhouse_closed_positions';
        const backup = {
            version: 1,
            exportDate: new Date().toISOString(),
            positions: state.positions || [],
            holdings: state.holdings || [],
            closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
        };
        
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wheelhouse_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification('✅ Backup downloaded!', 'success');
    } catch (e) {
        console.error('Download backup failed:', e);
        showNotification('❌ Download failed: ' + e.message, 'error');
    }
};

/**
 * Update the auto-save status indicator in UI
 */
function updateAutoSaveStatus(status) {
    const indicator = document.getElementById('autoSaveStatus');
    if (!indicator) return;
    
    switch (status) {
        case 'enabled':
            indicator.textContent = '🟢 Auto-save ON';
            indicator.style.color = colors.green;
            break;
        case 'saved':
            indicator.textContent = '🟢 Saved ' + new Date().toLocaleTimeString();
            indicator.style.color = colors.green;
            break;
        case 'error':
            indicator.textContent = '🔴 Save failed';
            indicator.style.color = colors.red;
            break;
        default:
            indicator.textContent = '⚪ Auto-save OFF';
            indicator.style.color = colors.muted;
    }
}

window.setupAutoSave = setupAutoSave;

/**
 * Add or update a position
 */
export async function addPosition() {
    const ticker = document.getElementById('posTicker').value.toUpperCase().trim();
    const type = document.getElementById('posType').value;
    const strike = parseFloat(document.getElementById('posStrike').value);
    const premium = parseFloat(document.getElementById('posPremium').value);
    const contracts = parseInt(document.getElementById('posContracts').value) || 1;
    const expiry = document.getElementById('posExpiry').value;
    const openDateInput = document.getElementById('posOpenDate').value;
    const openDate = openDateInput || new Date().toISOString().split('T')[0]; // Default to today
    const broker = document.getElementById('posBroker')?.value || 'Schwab';
    const delta = parseFloat(document.getElementById('posDelta')?.value) || null;
    
    // Buy/Write specific: stock purchase price
    const stockPriceInput = document.getElementById('posStockPrice');
    const stockPrice = stockPriceInput ? parseFloat(stockPriceInput.value) || null : null;
    
    // Spread specific fields
    const isSpread = type.includes('_spread');
    const buyStrike = isSpread ? parseFloat(document.getElementById('posBuyStrike')?.value) || null : null;
    const sellStrike = isSpread ? parseFloat(document.getElementById('posSellStrike')?.value) || null : null;
    
    // SKIP strategy specific fields
    const isSkip = type === 'skip_call';
    const leapsStrike = isSkip ? parseFloat(document.getElementById('posLeapsStrike')?.value) || null : null;
    const leapsPremium = isSkip ? parseFloat(document.getElementById('posLeapsPremium')?.value) || null : null;
    const leapsExpiry = isSkip ? document.getElementById('posLeapsExpiry')?.value || null : null;
    
    // Validation for spreads
    if (isSpread) {
        if (!ticker || !buyStrike || !sellStrike || !premium || !expiry) {
            showNotification('Please fill in all spread fields', 'error');
            return;
        }
        if (buyStrike === sellStrike) {
            showNotification('Buy and Sell strikes must be different', 'error');
            return;
        }
    } else if (isSkip) {
        // SKIP requires both LEAPS and SKIP call info
        if (!ticker || !strike || !premium || !expiry || !leapsStrike || !leapsPremium || !leapsExpiry) {
            showNotification('Please fill in all SKIP strategy fields', 'error');
            return;
        }
    } else if (!ticker || !strike || !premium || !expiry) {
        showNotification('Please fill in all fields', 'error');
        return;
    }
    
    // Validate Buy/Write has stock price
    if (type === 'buy_write' && !stockPrice) {
        showNotification('Buy/Write requires stock purchase price', 'error');
        return;
    }
    
    const today = new Date();
    const expiryDate = new Date(expiry);
    const dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    
    // Check if user wants to send to Schwab
    const sendToSchwab = document.getElementById('posSendToSchwab')?.checked || false;
    
    // If sending to Schwab, do that first (so we can abort if it fails)
    if (sendToSchwab && !isSpread) {
        const isPut = type.includes('put');
        const isLongTrade = type.startsWith('long_');
        const instruction = isLongTrade ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
        
        // Show loading state
        const addBtn = document.getElementById('addPositionBtn');
        const originalText = addBtn ? addBtn.textContent : '';
        if (addBtn) {
            addBtn.disabled = true;
            addBtn.textContent = '⏳ Sending to Schwab...';
            addBtn.style.background = '#888';
        }
        
        try {
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
                    limitPrice: premium,
                    confirm: true
                })
            });
            
            const result = await res.json();
            
            if (!res.ok || !result.success) {
                throw new Error(result.error || 'Order failed');
            }
            
            showNotification(`📤 Order sent to Schwab: ${ticker} $${strike} @ $${premium.toFixed(2)}`, 'success');
            
        } catch (e) {
            console.error('Schwab order error:', e);
            showNotification(`❌ Schwab order failed: ${e.message}`, 'error');
            
            // Re-enable button
            if (addBtn) {
                addBtn.disabled = false;
                addBtn.textContent = originalText;
                addBtn.style.background = '';
            }
            
            // Ask if they want to continue without Schwab
            if (!confirm('Schwab order failed. Add to positions anyway (for tracking)?')) {
                return;
            }
        } finally {
            // Reset button state
            if (addBtn) {
                addBtn.disabled = false;
                addBtn.textContent = originalText;
                addBtn.style.background = '';
            }
        }
    }
    
    // Check if we're editing an existing position
    if (state.editingPositionId !== null) {
        const idx = state.positions.findIndex(p => p.id === state.editingPositionId);
        if (idx !== -1) {
            // Update existing position
            state.positions[idx] = {
                ...state.positions[idx],
                ticker,
                type,
                strike: isSpread ? null : strike,
                premium,
                contracts,
                expiry,
                dte,
                openDate,
                broker,
                delta,
                // Buy/Write specific fields
                ...(type === 'buy_write' ? { stockPrice, costBasis: stockPrice - premium } : {}),
                // Spread specific fields
                ...(isSpread ? { buyStrike, sellStrike, spreadWidth: Math.abs(sellStrike - buyStrike) } : {}),
                // SKIP strategy fields
                ...(isSkip ? {
                    leapsStrike,
                    leapsPremium,
                    leapsExpiry,
                    skipStrike: strike,
                    skipPremium: premium,
                    skipExpiry: expiry,
                    totalInvestment: (leapsPremium + premium) * 100 * contracts,
                    leapsDte: Math.ceil((new Date(leapsExpiry) - today) / (1000 * 60 * 60 * 24)),
                    skipDte: dte
                } : {})
            };
            showNotification(`Updated ${ticker} ${type.replace(/_/g, ' ')} position`, 'success');
        }
        state.editingPositionId = null;
        updateAddButtonState();
    } else {
        // Create new position with a new chainId (fresh position, not a roll)
        const position = {
            id: Date.now(),
            chainId: Date.now(), // Each new position starts its own chain
            ticker,
            type,
            strike: isSpread ? null : strike,
            premium,
            contracts,
            expiry,
            dte,
            openDate,
            broker,
            delta,
            status: 'open',
            currentSpot: null,
            // Buy/Write specific fields
            ...(type === 'buy_write' ? { stockPrice, costBasis: stockPrice - premium } : {}),
            // Spread specific fields
            ...(isSpread ? { 
                buyStrike, 
                sellStrike, 
                spreadWidth: Math.abs(sellStrike - buyStrike),
                maxProfit: type.includes('credit') ? premium * 100 * contracts : (Math.abs(sellStrike - buyStrike) - premium) * 100 * contracts,
                maxLoss: type.includes('debit') ? premium * 100 * contracts : (Math.abs(sellStrike - buyStrike) - premium) * 100 * contracts,
                breakeven: calculateSpreadBreakeven(type, buyStrike, sellStrike, premium)
            } : {}),
            // SKIP strategy fields (LEAPS + shorter SKIP call)
            ...(isSkip ? {
                leapsStrike,
                leapsPremium,
                leapsExpiry,
                skipStrike: strike,      // The main strike is the SKIP call
                skipPremium: premium,    // The main premium is the SKIP call premium
                skipExpiry: expiry,      // The main expiry is the SKIP call expiry
                totalInvestment: (leapsPremium + premium) * 100 * contracts,
                leapsDte: Math.ceil((new Date(leapsExpiry) - today) / (1000 * 60 * 60 * 24)),
                skipDte: dte  // DTE for the SKIP call (45-60 day exit window)
            } : {})
        };
        
        // For Buy/Write, also add to holdings automatically
        if (type === 'buy_write') {
            const shares = contracts * 100;
            const holdingId = Date.now() + 1;
            const totalCostValue = stockPrice * shares;
            const premiumCollected = premium * 100 * contracts;
            
            // Max profit = (strike - stockPrice) * shares + premium collected
            // If stock rises to strike, you keep premium + gain on shares
            const maxProfitFromShares = Math.max(0, (strike - stockPrice) * shares);
            const maxProfitTotal = maxProfitFromShares + premiumCollected;
            
            const existingHolding = state.holdings.find(h => h.ticker === ticker && h.source === 'buy_write');
            if (existingHolding) {
                // Average into existing holding
                const newTotalShares = existingHolding.shares + shares;
                const newTotalCost = existingHolding.totalCost + totalCostValue;
                existingHolding.shares = newTotalShares;
                existingHolding.costBasis = newTotalCost / newTotalShares;
                existingHolding.totalCost = newTotalCost;
                existingHolding.premiumCredit = (existingHolding.premiumCredit || 0) + premiumCollected;
                existingHolding.maxProfit = (existingHolding.maxProfit || 0) + maxProfitTotal;
                existingHolding.linkedPositionId = position.id; // Link to newest position
            } else {
                state.holdings.push({
                    id: holdingId,
                    ticker,
                    shares,
                    costBasis: stockPrice,
                    totalCost: totalCostValue,
                    strike,
                    premiumCredit: premiumCollected,
                    netCostBasis: stockPrice - premium, // Effective cost after premium
                    maxProfit: maxProfitTotal,
                    acquiredDate: openDate,
                    assignedDate: openDate, // Use acquiredDate as assignedDate for display
                    source: 'buy_write',
                    linkedPositionId: position.id, // Link to the call position
                    contracts
                });
            }
            // Also store holding ID on the position for cross-reference
            position.linkedHoldingId = holdingId;
            localStorage.setItem(getHoldingsStorageKey(), JSON.stringify(state.holdings));
        }
        
        state.positions.push(position);
        showNotification(`Added ${ticker} ${type} position`, 'success');
    }
    
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    // Clear form
    document.getElementById('posTicker').value = '';
    document.getElementById('posStrike').value = '';
    document.getElementById('posPremium').value = '';
    document.getElementById('posContracts').value = '1';
    document.getElementById('posOpenDate').value = '';
    if (document.getElementById('posBroker')) document.getElementById('posBroker').value = 'Schwab';
    if (document.getElementById('posDelta')) document.getElementById('posDelta').value = '';
    if (document.getElementById('posStockPrice')) document.getElementById('posStockPrice').value = '';
    // Clear spread fields
    if (document.getElementById('posBuyStrike')) document.getElementById('posBuyStrike').value = '';
    if (document.getElementById('posSellStrike')) document.getElementById('posSellStrike').value = '';
    // Reset position type to default
    document.getElementById('posType').value = 'short_put';
    togglePositionTypeFields();
}

/**
 * Edit an existing position - load into form
 */
export function editPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    const isSpread = pos.type?.includes('_spread');
    const isSkip = pos.type === 'skip_call';
    
    // Populate form with position data
    document.getElementById('posTicker').value = pos.ticker;
    document.getElementById('posType').value = pos.type;
    document.getElementById('posStrike').value = isSpread ? '' : (isSkip ? pos.skipStrike : pos.strike);
    document.getElementById('posPremium').value = isSkip ? pos.skipPremium : pos.premium;
    document.getElementById('posContracts').value = pos.contracts;
    document.getElementById('posExpiry').value = isSkip ? pos.skipExpiry : pos.expiry;
    document.getElementById('posOpenDate').value = pos.openDate || '';
    if (document.getElementById('posBroker')) document.getElementById('posBroker').value = pos.broker || 'Schwab';
    if (document.getElementById('posDelta')) document.getElementById('posDelta').value = pos.delta || '';
    
    // Handle spread fields
    if (isSpread) {
        if (document.getElementById('posBuyStrike')) document.getElementById('posBuyStrike').value = pos.buyStrike || '';
        if (document.getElementById('posSellStrike')) document.getElementById('posSellStrike').value = pos.sellStrike || '';
    }
    
    // Handle SKIP fields
    if (isSkip) {
        if (document.getElementById('posLeapsStrike')) document.getElementById('posLeapsStrike').value = pos.leapsStrike || '';
        if (document.getElementById('posLeapsPremium')) document.getElementById('posLeapsPremium').value = pos.leapsPremium || '';
        if (document.getElementById('posLeapsExpiry')) document.getElementById('posLeapsExpiry').value = pos.leapsExpiry || '';
    }
    
    // Update form visibility for the position type
    togglePositionTypeFields();
    
    // Track that we're editing
    state.editingPositionId = id;
    updateAddButtonState();
    
    showNotification(`Editing ${pos.ticker} position - make changes and click Update`, 'info');
}

/**
 * Roll a position - show roll form panel
 */
export function rollPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    // Store which position we're rolling
    state.rollingPositionId = id;
    
    // Show the roll panel
    const rollPanel = document.getElementById('rollPanel');
    if (!rollPanel) return;
    
    rollPanel.style.display = 'block';
    
    // Populate current position info
    const infoEl = document.getElementById('rollCurrentInfo');
    if (infoEl) {
        infoEl.innerHTML = `
            <strong style="color:#ce93d8;">${pos.ticker}</strong> ${pos.type.replace('_', ' ').toUpperCase()}<br>
            Strike: <strong>$${pos.strike.toFixed(2)}</strong> | 
            Premium: <strong>$${pos.premium.toFixed(2)}</strong> | 
            Contracts: <strong>${pos.contracts}</strong> | 
            DTE: <strong>${pos.dte}d</strong>
        `;
    }
    
    // Pre-fill form with sensible defaults
    document.getElementById('rollClosingPrice').value = '0.00';
    document.getElementById('rollNewStrikeInput').value = pos.strike.toFixed(2);
    document.getElementById('rollNewPremium').value = pos.premium.toFixed(2);
    document.getElementById('rollNewExpiryInput').value = '';
    
    // Hide net display until calculated
    document.getElementById('rollNetDisplay').style.display = 'none';
    
    // Setup live net credit/debit calculation
    setupRollCalculation(pos);
    
    showNotification(`Rolling ${pos.ticker} - fill in new position details`, 'info');
}
window.rollPosition = rollPosition;

// Store the current option chain data
let currentOptionChain = null;

/**
 * Load option chain when ticker is entered
 */
async function loadOptionChainForAddPosition() {
    const ticker = document.getElementById('posTicker')?.value?.trim().toUpperCase();
    const type = document.getElementById('posType')?.value;
    const chainPicker = document.getElementById('optionChainPicker');
    const priceStatus = document.getElementById('posPriceStatus');
    const expirySelect = document.getElementById('posExpiry');
    const strikeContainer = document.getElementById('strikePickerContainer');
    
    if (!ticker) {
        if (chainPicker) chainPicker.style.display = 'none';
        return;
    }
    
    // Show loading state
    if (chainPicker) chainPicker.style.display = 'block';
    if (priceStatus) priceStatus.innerHTML = '<span style="color:#ffaa00;">⏳ Loading option chain...</span>';
    if (expirySelect) expirySelect.innerHTML = '<option value="">⏳ Loading expiries...</option>';
    if (strikeContainer) strikeContainer.style.display = 'none';
    
    // Get selected strike count (default 30)
    const strikeCountSelect = document.getElementById('strikeCountSelect');
    const strikeCount = strikeCountSelect?.value || '30';
    
    try {
        // Fetch quote and option chain in parallel
        const [quoteRes, chainRes] = await Promise.all([
            fetch(`/api/schwab/quote/${ticker}`),
            fetch(`/api/schwab/chains/${ticker}?strikeCount=${strikeCount}`)
        ]);
        
        const quoteData = await quoteRes.json();
        const chainData = await chainRes.json();
        
        console.log('Quote response:', quoteData);
        console.log('Chain response:', chainData);
        
        // Schwab returns data directly or with error field
        if (!quoteRes.ok || quoteData.error) {
            throw new Error(quoteData.error || 'Failed to fetch quote');
        }
        
        if (!chainRes.ok || chainData.error) {
            throw new Error(chainData.error || 'Failed to fetch option chain');
        }
        
        // Store chain data for later use
        currentOptionChain = chainData;
        
        // Schwab quote format: { TICKER: { quote: {...}, fundamental: {...} } }
        const quoteInfo = quoteData[ticker] || quoteData[ticker.toUpperCase()] || Object.values(quoteData)[0];
        const quote = quoteInfo?.quote || quoteInfo;
        const spotPrice = quote?.lastPrice || quote?.mark || quote?.closePrice;
        
        // Update price status
        if (priceStatus) {
            priceStatus.innerHTML = `<span style="color:#00ff88;">✓ ${ticker}: $${spotPrice?.toFixed(2)}</span>`;
        }
        
        // Update spot price display
        const spotDisplay = document.getElementById('chainSpotPrice');
        if (spotDisplay) {
            spotDisplay.innerHTML = `Spot: <span style="color:#00d9ff; font-weight:bold;">$${spotPrice?.toFixed(2)}</span>`;
        }
        
        // Populate expiry dropdown
        const isPut = type?.includes('put');
        const optionMap = isPut ? chainData.putExpDateMap : chainData.callExpDateMap;
        
        if (!optionMap || Object.keys(optionMap).length === 0) {
            throw new Error('No options available for this ticker');
        }
        
        const expiries = Object.keys(optionMap).map(key => key.split(':')[0]).filter(Boolean);
        
        expirySelect.innerHTML = '<option value="">Select expiry date...</option>';
        expiries.forEach(expiry => {
            const option = document.createElement('option');
            option.value = expiry;
            
            const expiryDate = new Date(expiry);
            const today = new Date();
            const dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
            
            option.textContent = `${expiry} (${dte} DTE)`;
            expirySelect.appendChild(option);
        });
        
        console.log(`Loaded ${expiries.length} expiry dates for ${ticker}`);
        
    } catch (e) {
        console.error('Option chain load error:', e);
        if (priceStatus) {
            priceStatus.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>`;
        }
        if (expirySelect) {
            expirySelect.innerHTML = '<option value="">⚠️ Failed to load</option>';
        }
    }
}
window.loadOptionChainForAddPosition = loadOptionChainForAddPosition;

/**
 * Load strikes when expiry is selected
 */
async function loadStrikesForExpiry() {
    const expiry = document.getElementById('posExpiry')?.value;
    const type = document.getElementById('posType')?.value;
    const strikeContainer = document.getElementById('strikePickerContainer');
    const strikePicker = document.getElementById('strikePicker');
    const selectedDisplay = document.getElementById('selectedStrikeDisplay');
    
    if (!expiry || !currentOptionChain) {
        if (strikeContainer) strikeContainer.style.display = 'none';
        return;
    }
    
    // Show strike picker
    if (strikeContainer) strikeContainer.style.display = 'block';
    if (selectedDisplay) selectedDisplay.style.display = 'none';
    
    const isPut = type?.includes('put');
    const isLong = type?.startsWith('long_');
    const optionMap = isPut ? currentOptionChain.putExpDateMap : currentOptionChain.callExpDateMap;
    
    // Find the expiry key that matches
    const expiryKey = Object.keys(optionMap || {}).find(k => k.startsWith(expiry));
    
    if (!expiryKey) {
        strikePicker.innerHTML = '<div style="padding:10px; color:#ff5252;">No strikes found for this expiry</div>';
        return;
    }
    
    const strikeMap = optionMap[expiryKey];
    console.log('Strike map for expiry:', expiryKey, strikeMap);
    
    // Keep original keys but sort by numeric value
    const strikeKeys = Object.keys(strikeMap);
    strikeKeys.sort((a, b) => parseFloat(a) - parseFloat(b));
    
    // Get spot price from the quote
    const spotPrice = currentOptionChain.underlyingPrice || 100;
    
    // Build strike list HTML
    let html = '';
    strikeKeys.forEach(strikeKey => {
        const strike = parseFloat(strikeKey);
        const strikeData = strikeMap[strikeKey];
        // Handle both array format [option] and direct object format
        const option = Array.isArray(strikeData) ? strikeData[0] : strikeData;
        
        if (!option) {
            console.warn('No option data for strike:', strike);
            return;
        }
        
        const bid = option.bid || 0;
        const ask = option.ask || 0;
        const mid = ((bid + ask) / 2);
        const delta = Math.abs(option.delta || 0);
        
        // ITM/OTM based on option type
        const itm = isPut ? (strike > spotPrice) : (strike < spotPrice);
        const itmLabel = itm ? 'ITM' : 'OTM';
        const itmColor = itm ? '#ffaa00' : '#00d9ff';
        
        // Visual styling: strikes BELOW spot have darker background only (text stays same)
        const belowSpot = strike < spotPrice;
        const bgColor = belowSpot ? 'rgba(40,40,50,0.6)' : 'rgba(0,217,255,0.08)';
        
        // For selling options, higher bid is better; for buying, lower ask is better
        const relevantPrice = isLong ? ask : bid;
        const priceLabel = isLong ? 'Ask' : 'Bid';
        
        html += `
            <div onclick="window.selectStrikeFromPicker(${strike}, ${mid}, ${delta})" 
                 style="padding:10px 12px; border-bottom:1px solid rgba(100,100,100,0.2); cursor:pointer; transition:background 0.15s; background:${bgColor};"
                 onmouseover="this.style.background='rgba(0,217,255,0.2)';"
                 onmouseout="this.style.background='${bgColor}';"
                 data-strike="${strike}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:#00d9ff; font-weight:bold; font-size:14px;">$${strike.toFixed(2)}</span>
                        <span style="color:${itmColor}; font-size:10px; margin-left:8px; padding:2px 6px; background:rgba(0,0,0,0.3); border-radius:3px;">${itmLabel}</span>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:12px;">
                            <span style="color:#00ff88;">Bid $${bid.toFixed(2)}</span>
                            <span style="color:#444;"> / </span>
                            <span style="color:#ffaa00;">Ask $${ask.toFixed(2)}</span>
                        </div>
                        <div style="font-size:10px; color:#888;">Mid $${mid.toFixed(2)} • Δ ${delta.toFixed(2)}</div>
                    </div>
                </div>
            </div>
        `;
    });
    
    strikePicker.innerHTML = html || '<div style="padding:10px; color:#888;">No strikes available</div>';
}
window.loadStrikesForExpiry = loadStrikesForExpiry;

/**
 * When user clicks a strike in the picker
 */
function selectStrikeFromPicker(strike, premium, delta) {
    // Fill in the form fields
    document.getElementById('posStrike').value = strike.toFixed(2);
    document.getElementById('posPremium').value = premium.toFixed(2);
    document.getElementById('posDelta').value = delta.toFixed(2);
    
    // Update the selected display
    updateAddPositionCredit();
    
    // Update Schwab preview if checked
    updateAddPositionSchwabPreview();
    
    // Highlight the selected row
    document.querySelectorAll('#strikePicker > div').forEach(row => {
        if (row.dataset.strike === strike.toString()) {
            row.style.background = 'rgba(0,255,136,0.15)';
            row.style.borderLeft = '3px solid #00ff88';
        } else {
            row.style.background = '';
            row.style.borderLeft = '';
        }
    });
    
    showNotification(`Selected $${strike.toFixed(2)} @ $${premium.toFixed(2)}`, 'success');
}
window.selectStrikeFromPicker = selectStrikeFromPicker;

/**
 * Update the credit/debit display when contracts change
 */
function updateAddPositionCredit() {
    const strike = parseFloat(document.getElementById('posStrike')?.value) || 0;
    const premium = parseFloat(document.getElementById('posPremium')?.value) || 0;
    const delta = parseFloat(document.getElementById('posDelta')?.value) || 0;
    const type = document.getElementById('posType')?.value;
    const contracts = parseInt(document.getElementById('posContracts')?.value) || 1;
    const expiry = document.getElementById('posExpiry')?.value;
    
    if (!strike || !premium) return;  // No strike selected yet
    
    const isLong = type?.startsWith('long_');
    const totalValue = premium * 100 * contracts;
    const creditOrDebit = isLong ? 'Debit' : 'Credit';
    const sign = isLong ? '-' : '+';
    const valueColor = isLong ? '#ff5252' : '#00ff88';
    
    const selectedDisplay = document.getElementById('selectedStrikeDisplay');
    if (selectedDisplay) {
        selectedDisplay.style.display = 'block';
        selectedDisplay.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="color:#00ff88; font-weight:bold; font-size:13px;">✓ Selected</div>
                    <div style="font-size:12px; margin-top:4px;">
                        <span style="color:#00d9ff; font-weight:bold;">$${strike.toFixed(2)}</span>
                        <span style="color:#888;"> @ </span>
                        <span style="color:#fff;">$${premium.toFixed(2)}</span>
                        <span style="color:#888;"> (Δ ${delta.toFixed(2)})</span>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:2px;">${expiry} • ${contracts} contract${contracts > 1 ? 's' : ''}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:10px; color:#888;">${creditOrDebit}</div>
                    <div style="color:${valueColor}; font-weight:bold; font-size:16px;">${sign}$${totalValue.toFixed(0)}</div>
                </div>
            </div>
            <button onclick="window.loadStrikesForExpiry()" 
                    style="margin-top:10px; padding:4px 10px; background:transparent; border:1px solid rgba(0,217,255,0.4); border-radius:4px; color:#00d9ff; cursor:pointer; font-size:11px;">
                ← Change Strike
            </button>
        `;
    }
    
    // Also update Schwab preview if shown
    updateAddPositionSchwabPreview();
}
window.updateAddPositionCredit = updateAddPositionCredit;

/**
 * Populate expiry dropdown when ticker/type are entered (LEGACY - kept for compatibility)
 */
async function populateAddPositionExpiries() {
    const ticker = document.getElementById('posTicker')?.value?.trim();
    const type = document.getElementById('posType')?.value;
    const expirySelect = document.getElementById('posExpiry');
    
    if (!ticker || !type || !expirySelect) return;
    
    console.log('Fetching expiry dates for', ticker);
    expirySelect.innerHTML = '<option value="">⏳ Loading expiries...</option>';
    
    try {
        const response = await fetch(`/api/schwab/chains/${ticker.toUpperCase()}?strikeCount=20`);
        const data = await response.json();
        
        console.log('Expiry chain response:', data);
        
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to fetch option chain');
        }
        
        const isPut = type.includes('put');
        const optionMap = isPut ? data.putExpDateMap : data.callExpDateMap;
        
        if (!optionMap) {
            throw new Error('No options available');
        }
        
        // Extract expiry dates from keys (format: "2026-02-21:45")
        const expiries = Object.keys(optionMap).map(key => key.split(':')[0]).filter(Boolean);
        
        expirySelect.innerHTML = '<option value="">Select expiry...</option>';
        expiries.forEach(expiry => {
            const option = document.createElement('option');
            option.value = expiry;
            
            // Calculate DTE
            const expiryDate = new Date(expiry);
            const today = new Date();
            const dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
            
            option.textContent = `${expiry} (${dte} DTE)`;
            expirySelect.appendChild(option);
        });
        
        console.log(`Loaded ${expiries.length} expiry dates`);
        
    } catch (e) {
        console.error('Expiry fetch error:', e);
        expirySelect.innerHTML = '<option value="">⚠️ Failed to load expiries</option>';
    }
}
window.populateAddPositionExpiries = populateAddPositionExpiries;

/**
 * Update Schwab preview for Add Position form - shows order details based on selected strike
 */
function updateAddPositionSchwabPreview() {
    const checkbox = document.getElementById('posSendToSchwab');
    const previewDiv = document.getElementById('posAddSchwabPreview');
    
    if (!checkbox?.checked) {
        if (previewDiv) previewDiv.style.display = 'none';
        return;
    }
    
    // Get form values
    const ticker = document.getElementById('posTicker')?.value?.trim().toUpperCase();
    const type = document.getElementById('posType')?.value;
    const expiry = document.getElementById('posExpiry')?.value;
    const strike = parseFloat(document.getElementById('posStrike')?.value) || 0;
    const premium = parseFloat(document.getElementById('posPremium')?.value) || 0;
    const contracts = parseInt(document.getElementById('posContracts')?.value) || 1;
    
    if (!previewDiv) return;
    previewDiv.style.display = 'block';
    
    // Check if we have all required fields
    if (!ticker || !type || !expiry || !strike || !premium) {
        previewDiv.innerHTML = `
            <div style="color:#888; font-size:12px;">
                <div style="color:#ffaa00;">⚠️ Select a strike from the chain above</div>
                <div style="margin-top:4px;">Order preview will appear once strike is selected</div>
            </div>
        `;
        return;
    }
    
    // Calculate order details
    const isPut = type.includes('put');
    const isLong = type.startsWith('long_');
    const optionType = isPut ? 'PUT' : 'CALL';
    const instruction = isLong ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
    const instructionDisplay = isLong ? 'Buy to Open' : 'Sell to Open';
    const totalValue = premium * 100 * contracts;
    const creditOrDebit = isLong ? 'Debit' : 'Credit';
    const valueColor = isLong ? '#ff5252' : '#00ff88';
    const sign = isLong ? '-' : '+';
    
    // Build option symbol (format: TICKER + YYMMDD + P/C + strike*1000)
    const expiryDate = new Date(expiry);
    const yy = expiryDate.getFullYear().toString().slice(-2);
    const mm = String(expiryDate.getMonth() + 1).padStart(2, '0');
    const dd = String(expiryDate.getDate()).padStart(2, '0');
    const strikeFormatted = String(Math.round(strike * 1000)).padStart(8, '0');
    const optionSymbol = `${ticker}${yy}${mm}${dd}${isPut ? 'P' : 'C'}${strikeFormatted}`;
    
    previewDiv.innerHTML = `
        <div style="font-size:12px;">
            <div style="color:#00d9ff; font-weight:bold; margin-bottom:10px;">📋 Order Preview</div>
            
            <div style="display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin-bottom:10px;">
                <span style="color:#888;">Symbol:</span>
                <span style="color:#fff; font-family:monospace; font-size:11px;">${optionSymbol}</span>
                
                <span style="color:#888;">Action:</span>
                <span style="color:${isLong ? '#ffaa00' : '#00ff88'};">${instructionDisplay}</span>
                
                <span style="color:#888;">Quantity:</span>
                <span style="color:#fff;">${contracts} contract${contracts > 1 ? 's' : ''}</span>
                
                <span style="color:#888;">Limit Price:</span>
                <span style="color:#fff;">$${premium.toFixed(2)} (mid)</span>
                
                <span style="color:#888;">Order Type:</span>
                <span style="color:#fff;">LIMIT • Day</span>
            </div>
            
            <div style="padding:8px; background:rgba(0,255,136,0.1); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#888;">Total ${creditOrDebit}:</span>
                <span style="color:${valueColor}; font-weight:bold; font-size:16px;">${sign}$${totalValue.toFixed(0)}</span>
            </div>
            
            <div style="margin-top:8px; font-size:10px; color:#888;">
                Order will be sent to Schwab as a limit order at mid price
            </div>
        </div>
    `;
}
window.updateAddPositionSchwabPreview = updateAddPositionSchwabPreview;

/**
 * Setup live calculation of roll net credit/debit
 */
function setupRollCalculation(pos) {
    const closingEl = document.getElementById('rollClosingPrice');
    const premiumEl = document.getElementById('rollNewPremium');
    const netDisplay = document.getElementById('rollNetDisplay');
    const netValueEl = document.getElementById('rollNetValue');
    
    const calculate = () => {
        const closingPrice = parseFloat(closingEl.value) || 0;
        const newPremium = parseFloat(premiumEl.value) || 0;
        const netCredit = newPremium - closingPrice;
        
        netDisplay.style.display = 'block';
        if (netCredit >= 0) {
            netValueEl.innerHTML = `<span style="color:${colors.green};">+$${netCredit.toFixed(2)} credit</span>`;
        } else {
            netValueEl.innerHTML = `<span style="color:${colors.red};">-$${Math.abs(netCredit).toFixed(2)} debit</span>`;
        }
    };
    
    closingEl.addEventListener('input', calculate);
    premiumEl.addEventListener('input', calculate);
}

/**
 * Execute the roll - close old position, create new one
 */
export function executeRoll() {
    const id = state.rollingPositionId;
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('No position selected for roll', 'error');
        return;
    }
    
    const closingPrice = parseFloat(document.getElementById('rollClosingPrice').value);
    const newStrike = parseFloat(document.getElementById('rollNewStrikeInput').value);
    const newPremium = parseFloat(document.getElementById('rollNewPremium').value);
    const newExpiry = document.getElementById('rollNewExpiryInput').value;
    
    if (isNaN(closingPrice) || closingPrice < 0) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    if (isNaN(newStrike) || newStrike <= 0) {
        showNotification('Invalid new strike', 'error');
        return;
    }
    if (isNaN(newPremium) || newPremium < 0) {
        showNotification('Invalid new premium', 'error');
        return;
    }
    if (!newExpiry) {
        showNotification('Please select new expiry date', 'error');
        return;
    }
    
    // Calculate P&L on old position
    const today = new Date().toISOString().split('T')[0];
    const realizedPnL = calculateRealizedPnL(pos, closingPrice);
    
    const openDate = new Date(pos.openDate || today);
    const closeDate = new Date(today);
    const daysHeld = Math.max(0, Math.ceil((closeDate - openDate) / (1000 * 60 * 60 * 24)));
    
    // Close old position
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...pos,
        status: 'closed',
        closeDate: today,
        daysHeld,
        closePrice: closingPrice,  // Use closePrice (not closingPrice) for consistency
        closeReason: 'rolled',
        realizedPnL,
        chainId: pos.chainId || pos.id, // Preserve chain ID
        rolledTo: `$${newStrike.toFixed(0)} exp ${newExpiry}`
    });
    saveClosedToStorage();
    
    // Remove old from open
    state.positions = state.positions.filter(p => p.id !== id);
    
    // Add new position - inherit the same chainId
    const expiryDate = new Date(newExpiry);
    const dte = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
    
    const newPosition = {
        id: Date.now(),
        chainId: pos.chainId || pos.id, // Inherit chain ID from previous position
        ticker: pos.ticker,
        type: pos.type,
        strike: newStrike,
        premium: newPremium,
        contracts: pos.contracts,
        expiry: newExpiry,
        dte,
        openDate: today,
        status: 'open',
        currentSpot: pos.currentSpot,
        rolledFrom: `$${pos.strike.toFixed(0)} @ $${pos.premium.toFixed(2)}`
    };
    state.positions.push(newPosition);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Calculate net credit/debit on roll
    const netCredit = newPremium - closingPrice;
    const netStr = netCredit >= 0 ? `+$${netCredit.toFixed(2)} credit` : `-$${Math.abs(netCredit).toFixed(2)} debit`;
    
    showNotification(
        `Rolled ${pos.ticker}: $${pos.strike} → $${newStrike} (${netStr})`, 
        netCredit >= 0 ? 'success' : 'warning'
    );
    
    // Hide roll panel and reset
    cancelRoll();
    
    renderPositions();
    updatePortfolioSummary();
}
window.executeRoll = executeRoll;

/**
 * Cancel roll and hide panel
 */
export function cancelRoll() {
    state.rollingPositionId = null;
    const rollPanel = document.getElementById('rollPanel');
    if (rollPanel) rollPanel.style.display = 'none';
}
window.cancelRoll = cancelRoll;

/**
 * Show modal to mark an old position as "rolled" to a new position
 * Use when: You did the roll at broker, then imported the new position,
 * but the old position is still showing as open.
 */
window.showMarkAsRolledModal = function(oldPositionId) {
    const oldPos = state.positions.find(p => p.id === oldPositionId);
    if (!oldPos) return;
    
    // Find other open positions with same ticker that could be the "new" position
    // Sort by most recent (highest ID = most recently added)
    const candidates = state.positions
        .filter(p => p.id !== oldPositionId && p.ticker === oldPos.ticker)
        .sort((a, b) => b.id - a.id);
    
    if (candidates.length === 0) {
        showNotification(`No other ${oldPos.ticker} positions found to link as roll target`, 'warning');
        return;
    }
    
    // Smart defaults - look for matching closed position from broker import
    // The broker import creates a closed position when it sees "Buy to Close"
    const closedPositions = state.closedPositions || [];
    const matchingClosed = closedPositions.find(cp => 
        cp.ticker === oldPos.ticker && 
        cp.strike === oldPos.strike &&
        cp.closePrice !== undefined &&
        // Match by close date being recent (within last 7 days)
        cp.closeDate && (new Date() - new Date(cp.closeDate)) < 7 * 24 * 60 * 60 * 1000
    );
    
    // Use matched close price, or current market price, or 0 if expired
    let defaultClosePrice = 0;
    let closePriceSource = '';
    
    if (matchingClosed?.closePrice !== undefined) {
        defaultClosePrice = matchingClosed.closePrice;
        closePriceSource = `<span style="color:#00ff88;">(from broker import)</span>`;
    } else if (oldPos.markedPrice !== undefined && oldPos.markedPrice > 0) {
        // User marked price (most reliable for recent close)
        defaultClosePrice = oldPos.markedPrice;
        closePriceSource = `<span style="color:#00ff88;">(your marked price)</span>`;
    } else if (oldPos.lastOptionPrice !== undefined && oldPos.lastOptionPrice > 0) {
        // CBOE current price
        defaultClosePrice = oldPos.lastOptionPrice;
        closePriceSource = `<span style="color:#ffaa00;">(current market price)</span>`;
    } else if (oldPos.dte <= 1) {
        defaultClosePrice = 0;
        closePriceSource = `<span style="color:#00ff88;">(Expired - $0)</span>`;
    } else {
        closePriceSource = `<span style="color:#888;">(enter from order confirmation)</span>`;
    }
    
    const defaultTarget = candidates[0]; // Most recent
    
    // Calculate what the net credit/debit would be
    const netCredit = defaultTarget.premium - defaultClosePrice;
    const netStr = netCredit >= 0 
        ? `<span style="color:#00ff88;">+$${netCredit.toFixed(2)} net credit</span>` 
        : `<span style="color:#ff5252;">-$${Math.abs(netCredit).toFixed(2)} net debit</span>`;
    
    const modal = document.createElement('div');
    modal.id = 'markAsRolledModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10001;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #ce93d8;border-radius:12px;padding:24px;max-width:550px;width:90%;">
            <h3 style="margin:0 0 16px 0;color:#ce93d8;">🔄 Link Roll: ${oldPos.ticker}</h3>
            
            <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:20px;">
                <!-- OLD Position -->
                <div style="background:rgba(255,82,82,0.15);border:1px solid rgba(255,82,82,0.4);padding:12px;border-radius:8px;text-align:center;">
                    <div style="color:#ff5252;font-size:11px;margin-bottom:4px;">CLOSED (Old)</div>
                    <div style="color:#fff;font-weight:bold;font-size:18px;">$${oldPos.strike}</div>
                    <div style="color:#888;font-size:11px;">${oldPos.type.replace(/_/g,' ')}</div>
                    <div style="color:#ffaa00;font-size:12px;margin-top:4px;">Prem: $${oldPos.premium}</div>
                    <div style="color:#666;font-size:10px;">${oldPos.dte}d DTE</div>
                </div>
                
                <!-- Arrow -->
                <div style="font-size:24px;color:#ce93d8;">→</div>
                
                <!-- NEW Position -->
                <div style="background:rgba(0,255,136,0.15);border:1px solid rgba(0,255,136,0.4);padding:12px;border-radius:8px;text-align:center;">
                    <div style="color:#00ff88;font-size:11px;margin-bottom:4px;">OPEN (New)</div>
                    <div style="color:#fff;font-weight:bold;font-size:18px;">$${defaultTarget.strike}</div>
                    <div style="color:#888;font-size:11px;">${defaultTarget.type.replace(/_/g,' ')}</div>
                    <div style="color:#ffaa00;font-size:12px;margin-top:4px;">Prem: $${defaultTarget.premium}</div>
                    <div style="color:#666;font-size:10px;">${defaultTarget.dte || '?'}d DTE</div>
                </div>
            </div>
            
            ${candidates.length > 1 ? `
            <div style="margin-bottom:16px;">
                <label style="color:#888;display:block;margin-bottom:4px;font-size:11px;">Different target?</label>
                <select id="rollTargetSelect" onchange="window.updateRollPreview(${oldPositionId})" 
                    style="width:100%;padding:8px;background:#333;border:1px solid #555;border-radius:4px;color:#fff;font-size:12px;">
                    ${candidates.map(p => `
                        <option value="${p.id}" ${p.id === defaultTarget.id ? 'selected' : ''}>
                            $${p.strike} ${p.type.replace(/_/g,' ')} - ${p.dte || '?'}d DTE (Prem: $${p.premium})
                        </option>
                    `).join('')}
                </select>
            </div>
            ` : `<input type="hidden" id="rollTargetSelect" value="${defaultTarget.id}">`}
            
            <div style="margin-bottom:16px;">
                <label style="color:#888;display:block;margin-bottom:4px;font-size:11px;">
                    Buyback cost for old position: ${closePriceSource}
                </label>
                <input type="number" id="rollClosePrice" step="0.01" value="${defaultClosePrice}" 
                    onchange="window.updateRollPreview(${oldPositionId})"
                    style="width:100%;padding:8px;background:#333;border:1px solid #555;border-radius:4px;color:#fff;">
            </div>
            
            <div id="rollNetSummary" style="background:#252540;padding:12px;border-radius:8px;margin-bottom:16px;text-align:center;">
                <div style="color:#888;font-size:11px;">Net on Roll</div>
                <div style="font-size:18px;font-weight:bold;">${netStr}</div>
                <div style="color:#666;font-size:10px;margin-top:4px;">
                    Old premium: $${oldPos.premium} | Close cost: $${defaultClosePrice} | New premium: $${defaultTarget.premium}
                </div>
            </div>
            
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="this.closest('#markAsRolledModal').remove()" 
                    style="padding:10px 20px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">
                    Cancel
                </button>
                <button onclick="window.executeMarkAsRolled(${oldPositionId})" 
                    style="padding:10px 20px;background:#00ff88;border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">
                    ✓ Confirm Roll Link
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Update the roll preview when target or close price changes
 */
window.updateRollPreview = function(oldPositionId) {
    const oldPos = state.positions.find(p => p.id === oldPositionId);
    const targetId = parseInt(document.getElementById('rollTargetSelect').value);
    const closePrice = parseFloat(document.getElementById('rollClosePrice').value) || 0;
    const newPos = state.positions.find(p => p.id === targetId);
    
    if (!oldPos || !newPos) return;
    
    const netCredit = newPos.premium - closePrice;
    const netStr = netCredit >= 0 
        ? `<span style="color:#00ff88;">+$${netCredit.toFixed(2)} net credit</span>` 
        : `<span style="color:#ff5252;">-$${Math.abs(netCredit).toFixed(2)} net debit</span>`;
    
    document.getElementById('rollNetSummary').innerHTML = `
        <div style="color:#888;font-size:11px;">Net on Roll</div>
        <div style="font-size:18px;font-weight:bold;">${netStr}</div>
        <div style="color:#666;font-size:10px;margin-top:4px;">
            Old premium: $${oldPos.premium} | Close cost: $${closePrice} | New premium: $${newPos.premium}
        </div>
    `;
};

/**
 * Execute the "mark as rolled" operation
 */
window.executeMarkAsRolled = function(oldPositionId) {
    const closePrice = parseFloat(document.getElementById('rollClosePrice').value) || 0;
    const targetId = parseInt(document.getElementById('rollTargetSelect').value);
    
    const oldPos = state.positions.find(p => p.id === oldPositionId);
    const newPos = state.positions.find(p => p.id === targetId);
    
    if (!oldPos || !newPos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const chainId = oldPos.chainId || oldPos.id;
    
    // Calculate P&L on old position
    const realizedPnL = calculateRealizedPnL(oldPos, closePrice);
    
    // Close old position and add to closedPositions
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...oldPos,
        status: 'closed',
        closeDate: today,
        closePrice: closePrice,
        closeReason: 'rolled',
        realizedPnL: realizedPnL,
        chainId: chainId,
        rolledTo: `$${newPos.strike} exp ${newPos.expiry}`
    });
    saveClosedToStorage();
    
    // Remove old from open positions
    state.positions = state.positions.filter(p => p.id !== oldPositionId);
    
    // Update new position to inherit chainId
    newPos.chainId = chainId;
    newPos.rolledFrom = `$${oldPos.strike} @ $${oldPos.premium.toFixed(2)}`;
    
    savePositionsToStorage();
    
    // Update any holdings that were linked to the old position → link to new position
    if (state.holdings && state.holdings.length > 0) {
        const holdingsUpdated = state.holdings.filter(h => h.linkedPositionId === oldPositionId);
        holdingsUpdated.forEach(h => {
            h.linkedPositionId = newPos.id;
            console.log(`[Roll Link] Updated holding ${h.ticker} to link to new position ${newPos.id}`);
        });
        if (holdingsUpdated.length > 0) {
            localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
        }
    }
    
    // Close modal
    document.getElementById('markAsRolledModal')?.remove();
    
    const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(0)}` : `-$${Math.abs(realizedPnL).toFixed(0)}`;
    showNotification(`Linked roll: ${oldPos.ticker} $${oldPos.strike} → $${newPos.strike} (${pnlStr})`, 'success');
    
    renderPositions();
    updatePortfolioSummary();
};

/**
 * Cancel editing and reset form
 */
export function cancelEdit() {
    state.editingPositionId = null;
    updateAddButtonState();
    
    // Clear form
    document.getElementById('posTicker').value = '';
    document.getElementById('posStrike').value = '';
    document.getElementById('posPremium').value = '';
    document.getElementById('posContracts').value = '1';
    
    showNotification('Edit cancelled', 'info');
}

/**
 * Update the Add/Update button text based on edit state
 */
function updateAddButtonState() {
    const btn = document.getElementById('addPositionBtn');
    const cancelBtn = document.getElementById('cancelEditBtn');
    
    if (state.editingPositionId !== null) {
        if (btn) {
            btn.textContent = '✓ Update Position';
            btn.style.background = '#00d9ff';
        }
        if (cancelBtn) cancelBtn.style.display = 'block';
    } else {
        if (btn) {
            btn.textContent = '➕ Add Position';
            btn.style.background = '';
        }
        if (cancelBtn) cancelBtn.style.display = 'none';
    }
}

/**
 * Delete a position
 */
export function deletePosition(id) {
    const idx = state.positions.findIndex(p => p.id === id);
    if (idx === -1) return;
    
    const pos = state.positions[idx];
    
    // Save undo state BEFORE deleting
    state.lastAction = {
        type: 'delete',
        position: {...pos},
        timestamp: Date.now()
    };
    
    state.positions.splice(idx, 1);
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    showUndoNotification(`Deleted ${pos.ticker} position`, 'warning');
}

/**
 * Close a position (mark as closed with P&L)
 */
export function closePosition(id, closePrice) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    pos.status = 'closed';
    pos.closePrice = closePrice;
    pos.closeDate = new Date().toISOString().split('T')[0];
    pos.realizedPnL = calculateRealizedPnL(pos, closePrice);
    
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    showNotification(`Closed ${pos.ticker} for ${pos.realizedPnL >= 0 ? 'profit' : 'loss'}`, 
                    pos.realizedPnL >= 0 ? 'success' : 'warning');
}

/**
 * Load position data into analyzer
 */
export function loadPositionToAnalyze(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    // For covered calls, get cost basis from the linked holding
    let costBasis = pos.costBasis || null;
    let holdingCostBasis = null;
    
    if (pos.type === 'covered_call' || pos.type?.includes('call')) {
        const holding = (state.holdings || []).find(h => h.ticker === pos.ticker);
        if (holding) {
            holdingCostBasis = holding.costBasis || holding.avgCost || null;
            // Use holding's cost basis if position doesn't have one
            if (!costBasis && holdingCostBasis) {
                costBasis = holdingCostBasis;
            }
        }
    }
    
    // Set position context for analysis
    setPositionContext({
        id: pos.id,
        ticker: pos.ticker,
        type: pos.type,
        strike: pos.strike,
        premium: pos.premium,
        contracts: pos.contracts,
        expiry: pos.expiry,
        dte: pos.dte,
        // Live pricing fields for AI advisor
        lastOptionPrice: pos.lastOptionPrice || null,
        markedPrice: pos.markedPrice || null,
        currentSpot: pos.currentSpot || null,
        // Buy/Write specific fields
        stockPrice: pos.stockPrice || null,
        costBasis: costBasis,
        holdingCostBasis: holdingCostBasis,  // Explicit holding cost basis
        linkedHoldingId: pos.linkedHoldingId || null
    });
    
    // Store ticker for Monte Carlo tab
    state.currentTicker = pos.ticker;
    
    // Update form fields
    document.getElementById('strikeInput').value = pos.strike;
    document.getElementById('strikeSlider').value = pos.strike;
    state.strike = pos.strike;
    
    // Update DTE
    const today = new Date();
    const expiryDate = new Date(pos.expiry);
    const dte = Math.max(1, Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24)));
    document.getElementById('dteSlider').value = Math.min(dte, 365);
    document.getElementById('dteInput').value = dte;
    state.dte = dte;
    
    // Update expiry date picker to match position's actual expiry
    const expiryPicker = document.getElementById('expiryDatePicker');
    if (expiryPicker && pos.expiry) {
        expiryPicker.value = pos.expiry;  // Format: YYYY-MM-DD
    }
    
    // Update the DTE display text (e.g., "5 days (0w 5d)")
    updateDteDisplay();
    
    // Update BARRIERS based on position type
    // SHORT PUT: Lower barrier = Strike (assignment level), Upper = spot + 20%
    // SHORT CALL: Lower = spot - 20%, Upper barrier = Strike (assignment level)
    const isPut = pos.type.includes('put');
    const estimatedSpot = pos.strike * 1.05; // Rough estimate until price fetches
    
    if (isPut) {
        state.lower = pos.strike;  // Strike is assignment level for puts
        state.upper = Math.round(estimatedSpot * 1.20);
    } else {
        state.lower = Math.round(estimatedSpot * 0.80);
        state.upper = pos.strike;  // Strike is assignment level for calls
    }
    
    // Update barrier UI
    const lowerSlider = document.getElementById('lowerSlider');
    const lowerInput = document.getElementById('lowerInput');
    const upperSlider = document.getElementById('upperSlider');
    const upperInput = document.getElementById('upperInput');
    
    if (lowerSlider) lowerSlider.value = state.lower;
    if (lowerInput) lowerInput.value = state.lower;
    if (upperSlider) upperSlider.value = state.upper;
    if (upperInput) upperInput.value = state.upper;
    
    // Fetch current price (this will update spot and recalculate barriers)
    fetchPositionTickerPrice(pos.ticker);
    
    // Pre-populate What-If Scenario calculator
    const whatIfDate = document.getElementById('whatIfDate');
    const whatIfIV = document.getElementById('whatIfIV');
    if (whatIfDate) {
        // Default to 30 days from now
        const defaultDate = new Date();
        defaultDate.setDate(defaultDate.getDate() + 30);
        whatIfDate.value = defaultDate.toISOString().split('T')[0];
    }
    if (whatIfIV) {
        // Use current IV if available (will be updated when price fetches)
        whatIfIV.value = Math.round(state.optVol || 30);
    }
    
    // Switch to Analyze tab → Pricing sub-tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    
    // Try new Analyze tab first, fall back to old Options tab
    const analyzeBtn = document.querySelector('[data-tab="analyze"]');
    const analyzeTab = document.getElementById('analyze');
    const optionsBtn = document.querySelector('[data-tab="options"]');
    const optionsTab = document.getElementById('options');
    
    if (analyzeBtn && analyzeTab) {
        analyzeBtn.classList.add('active');
        analyzeTab.classList.add('active');
        // Also activate the Pricing sub-tab
        if (window.switchSubTab) {
            window.switchSubTab('analyze', 'analyze-pricing');
        }
    } else if (optionsBtn && optionsTab) {
        // Fallback to old structure
        optionsBtn.classList.add('active');
        optionsTab.classList.add('active');
    }
    
    // Pre-populate Roll Calculator for this position
    const rollStrikeEl = document.getElementById('rollNewStrike');
    const rollDteEl = document.getElementById('rollNewDte');
    const rollExpiryEl = document.getElementById('rollNewExpiry');
    
    if (rollStrikeEl) rollStrikeEl.value = pos.strike;
    if (rollDteEl) rollDteEl.value = pos.dte || 45;
    
    // Set suggested expiry (4-6 weeks out)
    if (rollExpiryEl) {
        const suggestedExpiry = new Date();
        suggestedExpiry.setDate(suggestedExpiry.getDate() + 45);
        rollExpiryEl.value = suggestedExpiry.toISOString().split('T')[0];
    }
    
    // Update position info display - handle Buy/Write specially
    const posInfo = document.getElementById('positionInfo');
    const posTypeDisplay = pos.type === 'buy_write' ? 'BUY/WRITE' : pos.type.toUpperCase();
    const stockPriceInfo = pos.stockPrice ? ` | Stock: $${pos.stockPrice.toFixed(2)}` : '';
    
    if (posInfo) {
        posInfo.innerHTML = `
            <div style="background: #1a1a2e; padding: 10px; border-radius: 6px; margin-bottom: 15px; border-left: 3px solid #00d9ff;">
                <div style="color: #00d9ff; font-weight: bold; margin-bottom: 5px;">Analyzing Position:</div>
                <div style="color: #fff;">${pos.ticker} ${posTypeDisplay} @ $${pos.strike} (${pos.contracts} contract${pos.contracts > 1 ? 's' : ''})</div>
                <div style="color: #888; font-size: 12px;">Premium: $${pos.premium.toFixed(2)} | Expires: ${pos.expiry}${stockPriceInfo}</div>
            </div>
        `;
    }
    
    // Draw the payoff chart with updated state values
    drawPayoffChart();
    
    showNotification(`Loaded ${pos.ticker} ${pos.type} for analysis`, 'info');
}

/**
 * Render positions table
 */
export function renderPositions() {
    const container = document.getElementById('positionsTable');
    if (!container) return;
    
    // Ensure positions is an array
    if (!Array.isArray(state.positions)) {
        state.positions = [];
    }
    
    const openPositions = state.positions.filter(p => p.status === 'open');
    
    // Update collapsible header summary
    const summaryEl = document.getElementById('openPositionsSummary');
    if (summaryEl) {
        const totalPremium = openPositions.reduce((sum, p) => sum + ((p.premium || 0) * 100 * (p.contracts || 1)), 0);
        summaryEl.innerHTML = `
            <span>${openPositions.length} position${openPositions.length !== 1 ? 's' : ''}</span>
            <span class="value positive">$${totalPremium.toFixed(0)} premium</span>
        `;
    }
    
    if (openPositions.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <div style="font-size: 48px; margin-bottom: 10px;">📋</div>
                <div>No open positions</div>
                <div style="font-size: 12px; margin-top: 5px;">Add positions using the form above</div>
            </div>
        `;
        return;
    }
    
    // Update DTE for each position (normalize to midnight local time)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    openPositions.forEach(pos => {
        const expiryDate = new Date(pos.expiry + 'T00:00:00');
        pos.dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    });
    
    // Sort by DTE
    openPositions.sort((a, b) => a.dte - b.dte);
    
    // Render table with loading status indicators
    renderPositionsTable(container, openPositions);
    
    // Then fetch spot prices and update risk status asynchronously
    updatePositionRiskStatuses(openPositions);
}

/**
 * Render the positions table (sync, with placeholder statuses)
 */
function renderPositionsTable(container, openPositions) {
    let html = `
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: auto;">
            <thead>
                <tr style="background: #1a1a2e; color: #888;">
                    <th style="padding: 6px; text-align: left; white-space: nowrap;">Ticker</th>
                    <th style="padding: 6px; text-align: center; width: 45px;" title="ITM probability - click to analyze">Risk</th>
                    <th style="padding: 6px; text-align: left; width: 50px;">Broker</th>
                    <th style="padding: 6px; text-align: left; width: 65px;">Type</th>
                    <th style="padding: 6px; text-align: right; width: 50px;" title="Current stock price">Spot</th>
                    <th style="padding: 6px; text-align: right; width: 50px;">Strike</th>
                    <th style="padding: 6px; text-align: right; width: 50px;" title="Breakeven stock price if assigned or at expiry">B/E</th>
                    <th style="padding: 6px; text-align: center; width: 32px;" title="In-The-Money or Out-of-The-Money status">ITM</th>
                    <th style="padding: 6px; text-align: right; width: 45px;">Prem</th>
                    <th style="padding: 6px; text-align: right; width: 25px;">Qty</th>
                    <th style="padding: 6px; text-align: right; width: 35px;">DTE</th>
                    <th style="padding: 6px; text-align: right; width: 40px;" title="Position Delta - Directional exposure per $1 stock move">Δ</th>
                    <th style="padding: 6px; text-align: right; width: 50px;" title="Daily Theta - Premium decay you collect per day">Θ/day</th>
                    <th style="padding: 6px; text-align: right; width: 50px;" title="P&L Percentage - Profit/loss as % of entry">P/L %</th>
                    <th style="padding: 6px; text-align: right; width: 55px;" title="Today's P&L - Change in option value since market open">P/L Day</th>
                    <th style="padding: 6px; text-align: right; width: 60px;" title="Unrealized P&L - Total profit/loss since open">P/L Open</th>
                    <th style="padding: 6px; text-align: right; width: 50px;" title="Credit received (green) or Debit paid (red)">Cr/Dr</th>
                    <th style="padding: 6px; text-align: right; width: 45px;" title="Annualized Return on Capital">Ann%</th>
                    <th style="padding: 6px; text-align: left; white-space: nowrap;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // Group positions: LEAPS parents with their child short calls
    // Parents with children should appear at the DTE position of their earliest-expiring child
    const parentPositions = openPositions.filter(p => !p.parentPositionId);
    const childPositions = openPositions.filter(p => p.parentPositionId);
    
    // Build a map of parent ID -> children (sorted by child DTE)
    const childrenByParent = new Map();
    childPositions.forEach(child => {
        const parentId = child.parentPositionId;
        if (!childrenByParent.has(parentId)) {
            childrenByParent.set(parentId, []);
        }
        childrenByParent.get(parentId).push(child);
    });
    // Sort each parent's children by DTE
    childrenByParent.forEach(children => children.sort((a, b) => a.dte - b.dte));
    
    // For parents with children, use the earliest child's DTE for sorting
    const parentsWithSortKey = parentPositions.map(parent => {
        const children = childrenByParent.get(parent.id) || [];
        const sortDte = children.length > 0 ? Math.min(parent.dte, children[0].dte) : parent.dte;
        return { parent, children, sortDte };
    });
    
    // Sort parents by their effective DTE (considering children)
    parentsWithSortKey.sort((a, b) => a.sortDte - b.sortDte);
    
    // Build final grouped list
    const groupedPositions = [];
    const processedChildIds = new Set();
    
    parentsWithSortKey.forEach(({ parent, children }) => {
        // Add the parent position
        groupedPositions.push({ ...parent, _isChild: false, _hasChildren: children.length > 0 });
        
        // Add children right after parent
        children.forEach(child => {
            groupedPositions.push({ ...child, _isChild: true, _parentTicker: parent.ticker });
            processedChildIds.add(child.id);
        });
    });
    
    // Add any orphaned children (parent was closed or deleted)
    childPositions.forEach(child => {
        if (!processedChildIds.has(child.id)) {
            groupedPositions.push({ ...child, _isChild: true, _orphan: true });
        }
    });
    
    groupedPositions.forEach(pos => {
        const isChildRow = pos._isChild || false;
        const urgencyInfo = getDteUrgency(pos.dte);
        const dteColor = urgencyInfo.color;
        
        // Check if this is a spread
        const isSpread = pos.type?.includes('_spread');
        
        // Check if this is a long (debit) position
        const isLongPosition = isDebitPosition(pos.type);
        
        // Calculate credit/debit (premium × 100 × contracts)
        const credit = pos.premium * 100 * pos.contracts;
        
        // For LONG positions: calculate unrealized P&L using current option price
        let unrealizedPnL = 0;
        let unrealizedPnLPct = 0;
        let currentOptionPrice = pos.lastOptionPrice || pos.markedPrice || null;
        
        // Calculate P&L for ALL positions (both long and short)
        if (currentOptionPrice !== null && pos.premium > 0) {
            if (isLongPosition) {
                // LONG: You bought, profit if price goes UP
                // P&L = (current - entry) × 100 × contracts
                unrealizedPnL = (currentOptionPrice - pos.premium) * 100 * pos.contracts;
                unrealizedPnLPct = ((currentOptionPrice - pos.premium) / pos.premium) * 100;
            } else {
                // SHORT: You sold, profit if price goes DOWN
                // P&L = (entry - current) × 100 × contracts
                unrealizedPnL = (pos.premium - currentOptionPrice) * 100 * pos.contracts;
                unrealizedPnLPct = ((pos.premium - currentOptionPrice) / pos.premium) * 100;
            }
        }
        
        // Get chain net credit if position has roll history
        const chainInfo = getChainNetCredit(pos);
        const displayCredit = chainInfo.hasRolls ? chainInfo.netCredit : credit;
        const isChainCredit = chainInfo.hasRolls;
        
        // Calculate breakeven price for assignment
        // Short Put: Breakeven = Strike - Premium (if assigned, you buy at strike but received premium)
        // Covered Call: Breakeven = Cost Basis (if you own stock) or Strike - Premium
        // Put Credit Spread: Breakeven = Sell Strike - Net Credit
        // Call Credit Spread: Breakeven = Sell Strike + Net Credit
        // Long Call: Breakeven = Strike + Premium
        // Long Put: Breakeven = Strike - Premium
        let breakeven = null;
        if (isSpread) {
            const netCredit = pos.premium || 0;
            if (pos.type?.includes('put')) {
                // Put credit spread: breakeven = sell strike - net credit
                breakeven = (pos.sellStrike || pos.strike) - netCredit;
            } else {
                // Call credit spread: breakeven = sell strike + net credit
                breakeven = (pos.sellStrike || pos.strike) + netCredit;
            }
        } else if (pos.type === 'short_put' || pos.type === 'cash_secured_put') {
            breakeven = pos.strike - pos.premium;
        } else if (pos.type === 'covered_call') {
            // For covered calls, breakeven is more about when you lose money on the stock
            // If you have cost basis, breakeven = cost basis
            // Otherwise, breakeven = strike + premium (you profit up to strike + premium if assigned)
            breakeven = pos.costBasis || (pos.strike + pos.premium);
        } else if (pos.type === 'long_call' || pos.type === 'long_call_leaps' || pos.type === 'leap' || pos.type === 'leaps') {
            breakeven = pos.strike + pos.premium;
        } else if (pos.type === 'long_put') {
            breakeven = pos.strike - pos.premium;
        } else if (pos.type === 'buy_write') {
            breakeven = pos.costBasis || (pos.stockPrice - pos.premium);
        } else if (pos.type === 'skip_call') {
            // SKIP: Total investment / 100 = cost basis per share, breakeven = LEAPS strike + that
            const totalCost = (pos.leapsPremium || 0) + (pos.skipPremium || pos.premium || 0);
            breakeven = pos.leapsStrike + totalCost;
        } else if (pos.strike) {
            // Default for other short positions
            breakeven = pos.strike - pos.premium;
        }
        
        // Calculate ROC: Premium / Capital at Risk
        // For spreads: Capital at Risk = spread width or debit paid
        // For puts: Capital at Risk = Strike × 100 × Contracts
        // For calls: Capital at Risk = typically the stock value, but for covered calls we use strike
        // For long calls/puts: Capital at Risk = premium paid (the debit)
        let capitalAtRisk;
        if (isSpread) {
            capitalAtRisk = isDebitPosition(pos.type)
                ? credit  // Debit spread: risk is what you paid
                : (pos.spreadWidth - pos.premium) * 100 * pos.contracts;  // Credit spread: risk is width minus credit
        } else if (isLongPosition) {
            // Long call/put: risk is what you paid
            capitalAtRisk = credit;
        } else {
            capitalAtRisk = (pos.strike || 0) * 100 * pos.contracts;
        }
        const roc = capitalAtRisk > 0 ? (credit / capitalAtRisk) * 100 : 0;
        
        // For LONG positions with current price: calculate return %
        let longReturnPct = 0;
        let longAnnualReturn = 0;
        if (isLongPosition && currentOptionPrice !== null && pos.premium > 0) {
            longReturnPct = ((currentOptionPrice - pos.premium) / pos.premium) * 100;
            // Annualize based on days held (if openDate exists) or DTE
            const openDate = pos.openDate ? new Date(pos.openDate) : null;
            const daysHeld = openDate ? Math.max(1, Math.ceil((new Date() - openDate) / (1000 * 60 * 60 * 24))) : pos.dte;
            longAnnualReturn = daysHeld > 0 ? longReturnPct * (365 / daysHeld) : 0;
        }
        
        // Annualized ROC: ROC × (365 / DTE) - for credit positions
        const annualRoc = pos.dte > 0 ? roc * (365 / pos.dte) : 0;
        
        // Color code annual ROC (or long return for debit positions)
        const displayAnnualReturn = isLongPosition ? longAnnualReturn : annualRoc;
        const annualRocColor = displayAnnualReturn >= 50 ? colors.green : displayAnnualReturn >= 0 ? colors.orange : colors.red;
        
        // Check if this is a SKIP strategy
        const isSkip = pos.type === 'skip_call';
        
        // Check if this is a LEAPS (365+ days) or long-dated (180+ days) option
        const isLeaps = pos.dte >= 365 || pos.type === 'long_call_leaps';
        const isLongDated = pos.dte >= 180 && pos.dte < 365;
        
        // Format type for display
        let typeDisplay = pos.type.replace(/_/g, ' ').replace('short ', 'Short ').replace('long ', 'Long ');
        if (pos.type === 'buy_write') typeDisplay = 'Buy/Write';
        if (pos.type === 'long_call_leaps') typeDisplay = 'LEAPS Call';  // Special LEAPS type
        if (isSkip) typeDisplay = 'SKIP™';
        if (isSpread) {
            // Shorten spread names for display
            typeDisplay = pos.type.replace('_spread', '').replace('_', ' ').toUpperCase() + ' Spread';
        }
        
        // Add LEAPS/Long-dated indicator (unless already has LEAPS in name or is SKIP)
        if (isLeaps && !isSkip && pos.type !== 'long_call_leaps') {
            typeDisplay += ' 📅';  // LEAPS indicator
        } else if (isLongDated && !isSkip) {
            typeDisplay += ' ⏳';  // Long-dated indicator
        }
        
        // Type colors: 
        // - Cyan for buy/write and SKIP
        // - Purple for spreads
        // - Orange/gold for LONG positions (you paid, it's a debit)
        // - Red for puts (short puts)
        // - Green for covered calls (short calls)
        const isLongOption = pos.type === 'long_call' || pos.type === 'long_put';
        const typeColor = pos.type === 'buy_write' ? colors.cyan : 
                         isSkip ? '#00d9ff' :  // Cyan for SKIP
                         isSpread ? colors.purple :
                         isLongOption ? '#ffaa00' :  // Orange/gold for long options (debit)
                         pos.type.includes('put') ? colors.red : colors.green;
        
        // Strike display - different for spreads and SKIP
        const strikeDisplay = isSpread 
            ? `$${pos.buyStrike}/$${pos.sellStrike}`
            : isSkip 
            ? `L:$${pos.leapsStrike} S:$${pos.skipStrike}`  // LEAPS/SKIP strikes
            : `$${pos.strike?.toFixed(2) || '—'}`;
        
        // Buy/Write extra info
        const buyWriteInfo = pos.type === 'buy_write' && pos.stockPrice 
            ? ` | Stock: $${pos.stockPrice.toFixed(2)} | Basis: $${pos.costBasis.toFixed(2)}` 
            : '';
        
        // Spread extra info for tooltip
        const spreadInfo = isSpread && pos.breakeven
            ? ` | Breakeven: $${pos.breakeven.toFixed(2)} | Width: $${pos.spreadWidth}`
            : '';
        
        // SKIP strategy extra info for tooltip
        const skipInfo = isSkip && pos.leapsExpiry
            ? ` | LEAPS: $${pos.leapsStrike} exp ${pos.leapsExpiry} (${pos.leapsDte}d) | SKIP: $${pos.skipStrike} exp ${pos.skipExpiry} | Total: $${pos.totalInvestment?.toFixed(0)}`
            : '';
        
        // SKIP 45-60 DTE warning for exit window
        const skipDteWarning = isSkip && pos.skipDte <= 60 && pos.skipDte >= 45
            ? ' ⚠️ SKIP EXIT WINDOW (45-60 DTE)'
            : isSkip && pos.skipDte < 45
            ? ' 🚨 SKIP PAST EXIT - CLOSE IMMEDIATELY'
            : '';
        
        // Initial status - shows loading, will be updated async
        const initialStatusHtml = isSpread 
            ? `<span style="color: #8b5cf6; font-size: 11px;" title="Spread">📊</span>`
            : `<span id="risk-status-${pos.id}" style="color: #888; font-size: 10px;">⏳</span>`;
        
        // PMCC child row styling - visually nest under parent LEAPS
        const childRowBg = isChildRow ? 'background: rgba(139,92,246,0.08); border-left: 3px solid #8b5cf6;' : '';
        const childIndicator = isChildRow ? '<span style="color:#8b5cf6;margin-right:4px;" title="Covered by LEAPS above">└─</span>' : '';
        
        html += `
            <tr style="border-bottom: 1px solid #333;${childRowBg}${isSkip && pos.skipDte <= 60 ? ' background: rgba(255,140,0,0.15);' : ''}" title="${pos.delta ? 'Δ ' + pos.delta.toFixed(2) : ''}${pos.expiry ? ' | Expires: ' + pos.expiry : ''}${buyWriteInfo}${spreadInfo}${skipInfo}${skipDteWarning}${isChildRow ? ' | ↳ Covered by parent LEAPS' : ''}">
                <td style="padding: 6px; font-weight: bold; color: #00d9ff;">${childIndicator}${pos.ticker}${pos.openingThesis ? '<span style="margin-left:3px;font-size:9px;" title="Has thesis data for checkup">📋</span>' : ''}${isSkip && pos.skipDte <= 60 ? '<span style="margin-left:3px;font-size:9px;" title="' + (pos.skipDte < 45 ? 'PAST EXIT WINDOW!' : 'In 45-60 DTE exit window') + '">' + (pos.skipDte < 45 ? '🚨' : '⚠️') + '</span>' : ''}</td>
                <td style="padding: 4px; text-align: center;" id="risk-cell-${pos.id}">
                    ${initialStatusHtml}
                </td>
                <td style="padding: 6px; color: #aaa; font-size: 10px;">${pos.broker || 'Schwab'}</td>
                <td style="padding: 6px; color: ${typeColor}; font-size: 10px;" title="${isLeaps ? 'LEAPS (1+ year) - Evaluate thesis, not theta' : isLongDated ? 'Long-dated (6+ mo) - IV changes matter more' : ''}">${typeDisplay}${isSkip ? '<br><span style="font-size:8px;color:#888;">LEAPS+SKIP</span>' : ''}</td>
                <td id="spot-${pos.id}" style="padding: 6px; text-align: right; color: #888; font-size: 11px;">⏳</td>
                <td style="padding: 6px; text-align: right; ${isSpread || isSkip ? 'font-size:10px;' : ''}">${strikeDisplay}</td>
                <td style="padding: 6px; text-align: right; font-size: 11px; color: #ffaa00;" title="Breakeven if assigned">${breakeven ? '$' + breakeven.toFixed(2) : '—'}</td>
                <td id="itm-${pos.id}" style="padding: 6px; text-align: center;">⏳</td>
                <td style="padding: 6px; text-align: right;">${isDebitPosition(pos.type) ? '-' : ''}$${pos.premium.toFixed(2)}</td>
                <td style="padding: 6px; text-align: right;">${pos.contracts}</td>
                <td style="padding: 6px; text-align: right; color: ${dteColor}; font-weight: bold;">
                    ${isSkip ? `<span title="SKIP DTE">${pos.skipDte}d</span>` : pos.dte + 'd'}
                </td>
                <td id="delta-${pos.id}" style="padding: 6px; text-align: right; color: #888; font-size: 10px;">⏳</td>
                <td id="theta-${pos.id}" style="padding: 6px; text-align: right; color: #888; font-size: 10px;">⏳</td>
                ${(() => {
                    // P/L % column - just the percentage
                    const pctColor = unrealizedPnLPct >= 50 ? '#00d9ff' : (unrealizedPnLPct >= 0 ? '#00ff88' : '#ff5252');
                    const pctStyle = unrealizedPnLPct >= 50 ? 'text-shadow:0 0 4px #00d9ff;' : '';
                    if (currentOptionPrice === null) {
                        return `<td style="padding: 6px; text-align: right; font-size: 11px;"><span style="color:#666">⏳</span></td>`;
                    }
                    return `<td style="padding: 6px; text-align: right; font-size: 11px;" title="Entry: $${pos.premium.toFixed(2)} → Current: $${currentOptionPrice.toFixed(2)}">
                        <span style="color:${pctColor};font-weight:bold;${pctStyle}">${unrealizedPnLPct >= 50 ? '✓' : ''}${unrealizedPnLPct >= 0 ? '+' : ''}${unrealizedPnLPct.toFixed(0)}%</span>
                    </td>`;
                })()}
                ${(() => {
                    // P/L Day column - today's change in option value
                    // For SHORT positions: option price going DOWN = profit, so negate the change
                    // For LONG positions: option price going UP = profit, so keep the change
                    const dayChange = pos.dayChange || 0;
                    const pnlDay = isLongPosition ? (dayChange * 100 * pos.contracts) : (-dayChange * 100 * pos.contracts);
                    const pnlDayColor = pnlDay >= 0 ? '#00ff88' : '#ff5252';
                    if (dayChange === 0 && !pos.priceUpdatedAt) {
                        return `<td style="padding: 6px; text-align: right; font-size: 11px;"><span style="color:#666">—</span></td>`;
                    }
                    return `<td style="padding: 6px; text-align: right; font-size: 11px;" title="Option day change: ${dayChange >= 0 ? '+' : ''}$${dayChange.toFixed(2)}/share">
                        <span style="color:${pnlDayColor}">${pnlDay >= 0 ? '+' : ''}$${pnlDay.toFixed(0)}</span>
                    </td>`;
                })()}
                ${(() => {
                    // P/L Open column - total unrealized P/L since open
                    if (currentOptionPrice === null) {
                        return `<td style="padding: 6px; text-align: right; font-size: 11px;"><span style="color:#666">⏳</span></td>`;
                    }
                    const pnlColor = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
                    
                    // For spreads, add explanation tooltip
                    let spreadPnLTooltip = '';
                    if (isSpread) {
                        const isCreditSpread = pos.type.includes('credit');
                        const isPutSpread = pos.type.includes('put');
                        const shortStrike = isCreditSpread ? (isPutSpread ? pos.sellStrike || pos.strike : pos.sellStrike || pos.strike) : pos.buyStrike;
                        const longStrike = isCreditSpread ? pos.buyStrike : (pos.sellStrike || pos.strike);
                        
                        // For credit spreads:
                        // - Short leg: You SOLD, want it to decay (your profit)
                        // - Long leg: You BOUGHT, it decays too (your cost/protection)
                        // Net P&L = Short leg decay - Long leg decay
                        spreadPnLTooltip = isCreditSpread
                            ? `CREDIT SPREAD P&L Breakdown:&#10;&#10;` +
                              `📉 Short $${shortStrike} leg: You SOLD this (profit from decay)&#10;` +
                              `📈 Long $${longStrike} leg: You BOUGHT this (cost/protection)&#10;&#10;` +
                              `The short leg (closer to money) decays FASTER than the long leg.&#10;` +
                              `Net profit = Short decay - Long decay&#10;&#10;` +
                              `Current Net P&L: ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(0)}`
                            : `DEBIT SPREAD P&L Breakdown:&#10;&#10;` +
                              `📈 Long $${longStrike} leg: You BOUGHT this (your profit source)&#10;` +
                              `📉 Short $${shortStrike} leg: You SOLD this (offset cost)&#10;&#10;` +
                              `You profit when the spread WIDENS (stock moves in your favor).&#10;&#10;` +
                              `Current Net P&L: ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(0)}`;
                    }
                    
                    const tooltip = isSpread 
                        ? spreadPnLTooltip
                        : (pos.priceUpdatedAt ? 'Updated: ' + new Date(pos.priceUpdatedAt).toLocaleTimeString() : '');
                    
                    return `<td style="padding: 6px; text-align: right; font-size: 11px; ${isSpread ? 'cursor:help;' : ''}" title="${tooltip}">
                        <span style="color:${pnlColor}">${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(0)}</span>
                        ${isSpread ? '<span style="margin-left:2px;font-size:9px;opacity:0.6;">ⓘ</span>' : ''}
                    </td>`;
                })()}
                <td style="padding: 6px; text-align: right; color: ${isLongPosition ? '#ffaa00' : '#00ff88'};" title="${isLongPosition ? `Paid: $${credit.toFixed(0)}` : (isChainCredit ? `Chain NET: $${displayCredit.toFixed(0)}` : `Premium: $${credit.toFixed(0)}`)}">
                    ${isLongPosition 
                        ? `<span style="color:#ffaa00">-$${credit.toFixed(0)}</span>`
                        : (isSkip ? '-' : '') + '$' + (isSkip ? pos.totalInvestment?.toFixed(0) : displayCredit.toFixed(0)) + (isChainCredit ? '<span style="margin-left:2px;font-size:9px;color:#00d9ff;" title="Chain NET credit (includes roll history)">🔗</span>' : '')
                    }
                </td>
                <td style="padding: 6px; text-align: right; color: ${annualRocColor}; font-weight: bold;" title="${isLongPosition ? (currentOptionPrice !== null ? `Return: ${longReturnPct.toFixed(1)}% | Annualized: ${longAnnualReturn.toFixed(0)}%` : 'Mark current price to calculate') : `Annual ROC: ${annualRoc.toFixed(0)}%`}">
                    ${isSpread || isSkip ? '—' : (isLongPosition ? (currentOptionPrice !== null ? (longReturnPct >= 0 ? '+' : '') + longReturnPct.toFixed(0) + '%' : '⏳') : annualRoc.toFixed(0) + '%')}
                </td>
                <td style="padding: 4px; text-align: left;">
                    <div style="display: flex; flex-wrap: nowrap; gap: 4px; justify-content: flex-start; align-items: center; padding-left: 4px;">
                    ${isSkip ? `
                    <button onclick="window.showSkipExplanation(${pos.id})" 
                            style="width: 28px; background: rgba(0,217,255,0.3); border: 1px solid rgba(0,217,255,0.5); color: #0df; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="SKIP™ Strategy Explanation">🎯</button>
                    ` : isSpread ? `
                    <button onclick="window.showSpreadExplanation(${pos.id})" 
                            style="width: 28px; background: rgba(139,92,246,0.3); border: 1px solid rgba(139,92,246,0.5); color: #b9f; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="AI Spread Explanation">🤖</button>
                    ` : `
                    <button onclick="window.loadPositionToAnalyze(${pos.id})" 
                            style="width: 28px; background: rgba(0,180,220,0.3); border: 1px solid rgba(0,180,220,0.5); color: #6dd; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Analyze">📊</button>
                    `}
                    ${pos.openingThesis ? `
                    <button onclick="window.runPositionCheckup(${pos.id})" 
                            style="width: 28px; background: rgba(0,255,136,0.3); border: 1px solid rgba(0,255,136,0.5); color: #0f8; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Thesis Checkup - Compare opening assumptions to current state">🩺</button>
                    ` : `<div style="width: 28px;"></div>`}
                    <button onclick="window.showClosePanel(${pos.id})" 
                            style="width: 28px; background: rgba(80,180,80,0.3); border: 1px solid rgba(80,180,80,0.5); color: #6c6; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Close">✅</button>
                    ${pos.type.includes('put') ? `
                    <button onclick="window.assignPosition(${pos.id})" 
                            style="width: 28px; background: rgba(255,140,0,0.3); border: 1px solid rgba(255,140,0,0.5); color: #fa0; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Got Assigned - Take Shares">📦</button>
                    ` : `<div style="width: 28px;"></div>`}
                    ${pos.type.includes('call') && (state.holdings || []).some(h => h.ticker === pos.ticker) ? `
                    <button onclick="window.calledAway(${pos.id})" 
                            style="width: 28px; background: rgba(255,215,0,0.3); border: 1px solid rgba(255,215,0,0.5); color: #fd0; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Shares Called Away">🎯</button>
                    ` : `<div style="width: 28px;"></div>`}
                    <button onclick="window.rollPosition(${pos.id})" 
                            style="width: 28px; background: rgba(140,80,160,0.3); border: 1px solid rgba(140,80,160,0.5); color: #b9b; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Roll (enter new position details)">🔄</button>
                    ${state.positions.some(p => p.id !== pos.id && p.ticker === pos.ticker) ? `
                    <button onclick="window.showMarkAsRolledModal(${pos.id})" 
                            style="width: 28px; background: rgba(255,140,0,0.3); border: 1px solid rgba(255,140,0,0.5); color: #fa0; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Link to imported position (already rolled at broker)">🔗→</button>
                    ` : `<div style="width: 28px;"></div>`}
                    ${hasRollHistory(pos) ? `
                    <button onclick="window.showRollHistory(${pos.chainId || pos.id})" 
                            style="width: 28px; background: rgba(0,150,255,0.3); border: 1px solid rgba(0,150,255,0.5); color: #6bf; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="View Roll History">🔗</button>
                    ` : `<div style="width: 28px;"></div>`}
                    <button onclick="window.editPosition(${pos.id})" 
                            style="width: 28px; background: rgba(200,160,60,0.3); border: 1px solid rgba(200,160,60,0.5); color: #db9; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Edit">✏️</button>
                    <button onclick="window.deletePosition(${pos.id})" 
                            style="width: 28px; background: rgba(180,80,80,0.3); border: 1px solid rgba(180,80,80,0.5); color: #c88; padding: 2px 0; border-radius: 3px; cursor: pointer; font-size: 11px; text-align: center;"
                            title="Delete">✕</button>
                    </div>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    
    // Prevent vertical shrink during re-render by locking current height temporarily
    const currentHeight = container.offsetHeight;
    if (currentHeight > 0) {
        container.style.minHeight = currentHeight + 'px';
    }
    
    container.innerHTML = html;
    
    // Release the min-height lock after render completes
    requestAnimationFrame(() => {
        container.style.minHeight = '';
    });
    
    // Enable resizable columns
    enableResizableColumns(container);
}

/**
 * Enable drag-to-resize columns on the positions table
 * Widths are saved to localStorage and restored on next render
 */
function enableResizableColumns(container) {
    const table = container.querySelector('table');
    if (!table) return;
    
    const headers = table.querySelectorAll('thead th');
    const STORAGE_KEY = 'wheelhouse_column_widths';
    
    // Restore saved widths
    const savedWidths = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    
    headers.forEach((th, index) => {
        // Skip the Actions column (last one, has min-width)
        if (index === headers.length - 1) return;
        
        // Restore saved width if exists
        if (savedWidths[index]) {
            th.style.width = savedWidths[index] + 'px';
        }
        
        // Create resize handle
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        th.appendChild(handle);
        
        // Drag state
        let startX, startWidth;
        
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            startX = e.pageX;
            startWidth = th.offsetWidth;
            
            handle.classList.add('resizing');
            document.body.classList.add('resizing-columns');
            
            const onMouseMove = (e) => {
                const diff = e.pageX - startX;
                const newWidth = Math.max(30, startWidth + diff); // Min 30px
                th.style.width = newWidth + 'px';
            };
            
            const onMouseUp = () => {
                handle.classList.remove('resizing');
                document.body.classList.remove('resizing-columns');
                
                // Save widths to localStorage
                const widths = {};
                headers.forEach((h, i) => {
                    if (i < headers.length - 1) {
                        widths[i] = h.offsetWidth;
                    }
                });
                localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
                
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

/**
 * Fetch spot prices and update risk status for each position asynchronously
 * Uses BATCH API to fetch all prices in one request!
 */
async function updatePositionRiskStatuses(openPositions) {
    // Get unique tickers
    const tickers = [...new Set(openPositions.map(p => p.ticker))];
    
    // BATCH fetch all prices in ONE request (huge performance improvement!)
    const spotPrices = await fetchStockPricesBatch(tickers);
    
    // Update cache with fresh prices
    for (const [ticker, price] of Object.entries(spotPrices)) {
        spotPriceCache.set(ticker, { price, timestamp: Date.now() });
    }
    
    // Fetch IV data for each ticker (for accurate theta calculation)
    const ivData = {};
    await Promise.all(tickers.map(async ticker => {
        let ivValue = 0.50;
        let ivTimestamp = null;
        let ivLive = false;
        try {
            const res = await fetch(`/api/iv/${ticker}`);
            if (res.ok) {
                const data = await res.json();
                ivValue = parseFloat(data.atmIV) / 100 || 0.50;
                ivTimestamp = Date.now();
                ivLive = true;
            }
        } catch (e) {
            // Use higher default for volatile stocks
            ivValue = 0.50;
            ivTimestamp = null;
            ivLive = false;
        }
        ivData[ticker] = { value: ivValue, timestamp: ivTimestamp, live: ivLive };
    }));
    // Calculate and update Greeks for each position
    updatePositionGreeksDisplay(openPositions, spotPrices, ivData);
    
    // Update each position's risk status in the DOM
    for (const pos of openPositions) {
        const cell = document.getElementById(`risk-cell-${pos.id}`);
        const spotCell = document.getElementById(`spot-${pos.id}`);
        const itmCell = document.getElementById(`itm-${pos.id}`);
        if (!cell) continue;
        
        const spotPrice = spotPrices[pos.ticker];
        
        // Handle spreads - show spot price and calculate risk, but skip ITM (complex)
        if (pos.type?.includes('_spread')) {
            // Update Spot Price cell for spreads too
            if (spotCell && spotPrice) {
                // Use same color logic as ITM field for spreads
                const isPut = pos.type?.includes('put');
                const isCall = pos.type?.includes('call');
                const isLong = pos.type?.startsWith('long_') || pos.type === 'long_call_leaps' || pos.type === 'skip_call';
                const isShort = !isLong;
                
                // For spreads, use the short leg strike for color determination
                const shortStrike = pos.type?.includes('credit') 
                    ? (pos.type?.includes('put') ? pos.sellStrike : pos.sellStrike)
                    : (pos.type?.includes('put') ? pos.buyStrike : pos.buyStrike);
                
                if (shortStrike) {
                    // Determine ITM/OTM for color coding
                    // Puts: ITM when spot < strike
                    // Calls: ITM when spot > strike
                    let isITM = isPut ? spotPrice < shortStrike : spotPrice > shortStrike;
                    const distancePct = Math.abs((spotPrice - shortStrike) / shortStrike * 100);
                    const isATM = distancePct < 2; // Within 2% is "at the money"
                    
                    // Determine if ITM is GOOD or BAD for you
                    // Long options: ITM is GOOD (you can exercise profitably)
                    // Short options: ITM is BAD (you may get assigned)
                    let spotColor;
                    
                    if (isATM) {
                        spotColor = '#ffaa00'; // Orange for ATM
                    } else if (isITM) {
                        if (isLong) {
                            // Long + ITM = GOOD for you
                            spotColor = '#00ff88'; // Green
                        } else {
                            // Short + ITM = BAD for you (assignment risk)
                            spotColor = '#ff5252'; // Red
                        }
                    } else {
                        // OTM
                        if (isLong) {
                            // Long + OTM = not great (no intrinsic value yet)
                            spotColor = '#888'; // Gray/neutral
                        } else {
                            // Short + OTM = GOOD for you (will expire worthless)
                            spotColor = '#00ff88'; // Green
                        }
                    }
                    
                    spotCell.innerHTML = `<span style="color:${spotColor};">$${spotPrice.toFixed(2)}</span>`;
                } else {
                    spotCell.innerHTML = `<span style="color:#ccc;">$${spotPrice.toFixed(2)}</span>`;
                }
            }
            // ITM is complex for spreads - skip it
            if (itmCell) itmCell.innerHTML = '<span style="color:#888;font-size:10px;">—</span>';
            
            // Calculate risk for the spread's short leg - use real IV from CBOE!
            const realIV = ivData[pos.ticker]?.value || null;
            const risk = calculatePositionRisk(pos, spotPrice, realIV);
            
            if (risk.itmPct !== null) {
                // Show IV source in tooltip
                const ivSource = ivData[pos.ticker]?.live ? 'CBOE' : 'estimated';
                const ivPct = (realIV * 100).toFixed(0);
                const riskTooltip = `${risk.itmPct.toFixed(1)}% ITM probability (IV: ${ivPct}% ${ivSource}) - Click to view spread details`;
                
                // We have a real risk calculation
                if (risk.needsAttention) {
                    cell.innerHTML = `
                        <button onclick="window.showSpreadExplanation(${pos.id})" 
                                style="background: rgba(${risk.color === '#ff5252' ? '255,82,82' : '255,170,0'},0.2); border: 1px solid ${risk.color}; color: ${risk.color}; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px; white-space: nowrap;"
                                title="${riskTooltip}">
                            ${risk.icon} ${risk.text}
                        </button>
                    `;
                } else {
                    cell.innerHTML = `
                        <span style="color: ${risk.color}; font-size: 11px;" title="${riskTooltip}">
                            ${risk.icon} ${risk.text}
                        </span>
                    `;
                }
            } else {
                // Fallback - no risk calculated
                cell.innerHTML = `<span style="color: #8b5cf6; font-size: 11px;" title="Spread position">📊 Spread</span>`;
            }
            continue;
        }
        
        // Update Spot Price cell
        if (spotCell && spotPrice) {
            // Use same color logic as ITM field
            const isPut = pos.type?.includes('put');
            const isCall = pos.type?.includes('call');
            const isLong = pos.type?.startsWith('long_') || pos.type === 'long_call_leaps' || pos.type === 'skip_call';
            const isShort = !isLong;
            
            // Determine ITM/OTM for color coding
            // Puts: ITM when spot < strike
            // Calls: ITM when spot > strike
            let isITM = isPut ? spotPrice < pos.strike : spotPrice > pos.strike;
            const distancePct = Math.abs((spotPrice - pos.strike) / pos.strike * 100);
            const isATM = distancePct < 2; // Within 2% is "at the money"
            
            // Determine if ITM is GOOD or BAD for you
            // Long options: ITM is GOOD (you can exercise profitably)
            // Short options: ITM is BAD (you may get assigned)
            let spotColor;
            
            if (isATM) {
                spotColor = '#ffaa00'; // Orange for ATM
            } else if (isITM) {
                if (isLong) {
                    // Long + ITM = GOOD for you
                    spotColor = '#00ff88'; // Green
                } else {
                    // Short + ITM = BAD for you (assignment risk)
                    spotColor = '#ff5252'; // Red
                }
            } else {
                // OTM
                if (isLong) {
                    // Long + OTM = not great (no intrinsic value yet)
                    spotColor = '#888'; // Gray/neutral
                } else {
                    // Short + OTM = GOOD for you (will expire worthless)
                    spotColor = '#00ff88'; // Green
                }
            }
            
            spotCell.innerHTML = `<span style="color:${spotColor};">$${spotPrice.toFixed(2)}</span>`;
        }
        
        // Calculate ITM/OTM status and update cell
        if (itmCell && spotPrice && pos.strike) {
            const isPut = pos.type?.includes('put');
            const isCall = pos.type?.includes('call');
            const isLong = pos.type?.startsWith('long_') || pos.type === 'long_call_leaps' || pos.type === 'skip_call';
            const isShort = !isLong;
            
            // Determine ITM/OTM
            // Puts: ITM when spot < strike
            // Calls: ITM when spot > strike
            let isITM = isPut ? spotPrice < pos.strike : spotPrice > pos.strike;
            const distancePct = Math.abs((spotPrice - pos.strike) / pos.strike * 100);
            const isATM = distancePct < 2; // Within 2% is "at the money"
            
            // Determine if ITM is GOOD or BAD for you
            // Long options: ITM is GOOD (you can exercise profitably)
            // Short options: ITM is BAD (you may get assigned)
            let color, label, tooltip;
            
            if (isATM) {
                color = '#ffaa00'; // Orange for ATM
                label = 'ATM';
                tooltip = `At-the-money (${distancePct.toFixed(1)}% from strike)`;
            } else if (isITM) {
                if (isLong) {
                    // Long + ITM = GOOD for you
                    color = '#00ff88'; // Green
                    label = 'ITM';
                    tooltip = `In-the-money by ${distancePct.toFixed(1)}% - Good! Your option has intrinsic value.`;
                } else {
                    // Short + ITM = BAD for you (assignment risk)
                    color = '#ff5252'; // Red
                    label = 'ITM';
                    tooltip = `In-the-money by ${distancePct.toFixed(1)}% - Assignment risk! Consider rolling.`;
                }
            } else {
                // OTM
                if (isLong) {
                    // Long + OTM = not great (no intrinsic value yet)
                    color = '#888'; // Gray/neutral
                    label = 'OTM';
                    tooltip = `Out-of-the-money by ${distancePct.toFixed(1)}% - Need stock to move in your favor.`;
                } else {
                    // Short + OTM = GOOD for you (will expire worthless)
                    color = '#00ff88'; // Green
                    label = 'OTM';
                    tooltip = `Out-of-the-money by ${distancePct.toFixed(1)}% - Good! On track for max profit.`;
                }
            }
            
            itmCell.innerHTML = `<span style="color:${color};font-size:10px;font-weight:bold;" title="${tooltip}">${label}</span>`;
        }
        
        // Calculate risk using real IV from CBOE!
        const realIV = ivData[pos.ticker]?.value || null;
        const risk = calculatePositionRisk(pos, spotPrice, realIV);
        // Build tooltip showing IV source for transparency
        const ivSource = ivData[pos.ticker]?.live ? 'CBOE' : 'estimated';
        const ivPct = realIV ? (realIV * 100).toFixed(0) : 'N/A';
        
        if (risk.needsAttention) {
            // Clickable button for positions needing attention
            const riskTooltip = risk.itmPct 
                ? `${risk.itmPct.toFixed(1)}% ITM probability (IV: ${ivPct}% ${ivSource}) - Click to see roll suggestions` 
                : 'Click to analyze';
            cell.innerHTML = `
                <button onclick="window.loadPositionToAnalyze(${pos.id}); setTimeout(() => document.getElementById('suggestRollBtn')?.click(), 500);" 
                        style="background: rgba(${risk.color === '#ff5252' ? '255,82,82' : '255,170,0'},0.2); border: 1px solid ${risk.color}; color: ${risk.color}; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px; white-space: nowrap;"
                        title="${riskTooltip}">
                    ${risk.icon} ${risk.text}
                </button>
            `;
        } else {
            // Static indicator - different tooltips for strategy-aware vs normal
            const tooltipText = risk.wantsAssignment 
                ? `${risk.itmPct?.toFixed(1)}% assignment probability (IV: ${ivPct}% ${ivSource}) - Strategy: LET CALL ✓`
                : risk.itmPct 
                    ? `${risk.itmPct.toFixed(1)}% ITM probability (IV: ${ivPct}% ${ivSource}) - Looking good!` 
                    : 'Healthy position';
            
            cell.innerHTML = `
                <span style="color: ${risk.color}; font-size: 11px;" title="${tooltipText}">
                    ${risk.icon} ${risk.text}
                </span>
            `;
        }
    }
}

/**
 * Update Greeks display for each position in the table
 * Calculates per-position delta and theta with current spot prices
 */
async function updatePositionGreeksDisplay(positions, spotPrices, ivData = {}) {
    for (const pos of positions) {
        const deltaCell = document.getElementById(`delta-${pos.id}`);
        const thetaCell = document.getElementById(`theta-${pos.id}`);
        if (!deltaCell || !thetaCell) continue;
        
        const spot = spotPrices[pos.ticker] || pos.currentSpot || 100;
        const ivObj = ivData[pos.ticker] || { value: 0.50, timestamp: null, live: false };
        const iv = ivObj.value;
        const ivTimestamp = ivObj.timestamp;
        const ivLive = ivObj.live;
        const contracts = pos.contracts || 1;
        
        // Calculate DTE
        const expiry = new Date(pos.expiry);
        const now = new Date();
        const dte = Math.max(0, (expiry - now) / (1000 * 60 * 60 * 24));
        const T = dte / 365;
        
        // Handle spreads - calculate net Greeks from both legs
        if (pos.type?.includes('_spread')) {
            const sellStrike = pos.sellStrike || 0;
            const buyStrike = pos.buyStrike || 0;
            const isPutSpread = pos.type.includes('put');
            const isCredit = pos.type.includes('credit');
            
            if (!sellStrike || !buyStrike) {
                deltaCell.innerHTML = '<span style="color:#8b5cf6;font-size:10px;">—</span>';
                thetaCell.innerHTML = '<span style="color:#8b5cf6;font-size:10px;">—</span>';
                continue;
            }
            
            // Calculate Greeks for each leg
            // Short leg (we sold this - we're short)
            const shortGreeks = calculateGreeks(spot, sellStrike, T, 0.05, iv, isPutSpread, contracts);
            // Long leg (we bought this - we're long)
            const longGreeks = calculateGreeks(spot, buyStrike, T, 0.05, iv, isPutSpread, contracts);
            
            // Net Greeks: short leg is negative (we're short), long leg is positive (we're long)
            // For credit spreads: short the higher-premium option, long the lower-premium (protection)
            // For debit spreads: long the higher-premium option, short the lower-premium
            let netDelta, netTheta;
            if (isCredit) {
                // Credit spread: short sellStrike, long buyStrike
                netDelta = -shortGreeks.delta + longGreeks.delta;
                netTheta = -shortGreeks.theta + longGreeks.theta;
            } else {
                // Debit spread: long sellStrike (confusing naming), short buyStrike
                // Actually for debit spreads, we buy the more expensive option
                netDelta = shortGreeks.delta - longGreeks.delta;
                netTheta = shortGreeks.theta - longGreeks.theta;
            }
            
            // Delta tooltip for spreads
            const deltaTooltip = `Net spread delta: If ${pos.ticker} moves $1, P&L changes by ~$${Math.abs(netDelta).toFixed(0)}`;
            deltaCell.innerHTML = `<span style="color:#8b5cf6;font-size:10px;" title="${deltaTooltip}">${netDelta >= 0 ? '+' : ''}${netDelta.toFixed(0)}</span>`;
            
            // Theta tooltip for spreads
            const thetaColor = netTheta > 0 ? '#00ff88' : '#ffaa00';
            const thetaTooltip = netTheta > 0 
                ? `Net theta: Collecting $${Math.abs(netTheta).toFixed(2)}/day from time decay`
                : `Net theta: Paying $${Math.abs(netTheta).toFixed(2)}/day in time decay`;
            
            // Add IV information to tooltip
            let ivInfo = '';
            if (ivTimestamp) {
                const ivAge = Math.floor((Date.now() - ivTimestamp) / (1000 * 60));
                const ivTimeStr = ivAge < 1 ? 'just now' : `${ivAge}m ago`;
                ivInfo = `\nIV: ${(iv * 100).toFixed(1)}% (${ivTimeStr})`;
            }
            const fullThetaTooltip = thetaTooltip + ivInfo;
            
            // Format theta - show cents if under $1 for clarity
            const absNetTheta = Math.abs(netTheta);
            const netThetaDisplay = absNetTheta < 1 ? `$${absNetTheta.toFixed(2)}` : `$${absNetTheta.toFixed(0)}`;
            thetaCell.innerHTML = `<span style="color:${thetaColor};font-size:10px;" title="${fullThetaTooltip}">${netTheta >= 0 ? '+' : '-'}${netThetaDisplay}</span>`;
            
            // Store on position
            pos._delta = netDelta;
            pos._theta = netTheta;
            continue;
        }
        
        const strike = parseFloat(pos.strike) || 0;
        const isPut = pos.type?.includes('put');
        const isShort = pos.type?.includes('short') || pos.type === 'covered_call';
        const isLong = pos.type?.includes('long') || pos.type === 'LEAPS_Call';
        
        // Skip if no valid strike
        if (strike <= 0) {
            deltaCell.innerHTML = '<span style="color:#888;font-size:10px;">—</span>';
            thetaCell.innerHTML = '<span style="color:#888;font-size:10px;">—</span>';
            continue;
        }
        
        // Calculate Greeks
        const greeks = calculateGreeks(spot, strike, T, 0.05, iv, isPut, contracts);
        
        // Sign: short positions have inverted Greeks
        // For short puts: we want positive delta (stock goes up = good)
        // For long calls: delta is already positive from the function
        const sign = isShort ? -1 : 1;
        const delta = greeks.delta * sign;
        const theta = greeks.theta * sign;  // Short positions collect theta (positive), long positions pay (negative)
        
        // Delta: neutral color (pro style) - just show the number
        // For long options, delta is your directional exposure (how you profit)
        const deltaTooltip = isShort 
            ? `If ${pos.ticker} moves $1, your P&L changes by ~$${Math.abs(delta).toFixed(0)}`
            : `If ${pos.ticker} moves $1 ${isPut ? 'down' : 'up'}, you gain ~$${Math.abs(delta).toFixed(0)}`;
        deltaCell.innerHTML = `<span style="color:#ccc;font-size:10px;" title="${deltaTooltip}">${delta >= 0 ? '+' : ''}${delta.toFixed(0)}</span>`;
        
        // Theta: Different display for short (collect) vs long (pay)
        // Long options: theta is a COST but NOT a red flag - it's the expected cost of holding
        let thetaColor, thetaTooltip;
        
        // Detect deep ITM/OTM options - they have minimal extrinsic value → low theta
        const moneyness = isPut ? (strike - spot) / spot : (spot - strike) / spot;
        const isDeepITM = moneyness > 0.25;  // > 25% ITM
        const isDeepOTM = moneyness < -0.25; // > 25% OTM
        
        if (isShort) {
            // Short options COLLECT theta - green is good
            thetaColor = theta > 0 ? '#00ff88' : '#ff5252';
            if (isDeepITM || isDeepOTM) {
                thetaTooltip = `You collect $${Math.abs(theta).toFixed(2)}/day from time decay (low because ${isDeepITM ? 'deep ITM - mostly intrinsic value' : 'deep OTM - low premium'})`;
            } else {
                thetaTooltip = `You collect $${Math.abs(theta).toFixed(2)}/day from time decay`;
            }
        } else {
            // Long options PAY theta - use muted gold color (expected cost, not bad)
            thetaColor = '#ffaa00';  // Neutral amber - cost but not a warning
            thetaTooltip = `Time decay cost: $${Math.abs(theta).toFixed(2)}/day (expected for long options - you profit from DELTA, not theta)`;
        }
        
        // Add IV information to tooltip
        let ivInfo = '';
        if (ivTimestamp) {
            const ivAge = Math.floor((Date.now() - ivTimestamp) / (1000 * 60));
            const ivTimeStr = ivAge < 1 ? 'just now' : `${ivAge}m ago`;
            ivInfo = `\nIV: ${(iv * 100).toFixed(1)}% (${ivTimeStr})`;
        }
        const fullThetaTooltip = thetaTooltip + ivInfo;
        
        // Format theta - show cents if under $1 for clarity
        const absTheta = Math.abs(theta);
        const thetaDisplay = absTheta < 1 ? `$${absTheta.toFixed(2)}` : `$${absTheta.toFixed(0)}`;
        // IV timestamp display
        let ivTimeDisplay = '';
        if (ivLive && ivTimestamp) {
            const ageSec = (Date.now() - ivTimestamp) / 1000;
            if (ageSec < 120) {
                ivTimeDisplay = `<span style="color:#00d9ff;font-size:9px;font-weight:bold;animation:pulse 1s infinite alternate;">LIVE</span>`;
            } else {
                const mins = Math.floor(ageSec / 60);
                ivTimeDisplay = `<span style="color:#888;font-size:9px;">${mins}m ago</span>`;
            }
        } else {
            ivTimeDisplay = `<span style="color:#ffaa00;font-size:9px;">IV fallback</span>`;
        }
        // Tooltip fallback
        let thetaTooltipFinal = fullThetaTooltip;
        if (!ivLive) {
            thetaTooltipFinal += ' (Using last known IV – refresh for latest)';
        }
        thetaCell.innerHTML = `<span style="color:${thetaColor};font-size:10px;" title="${thetaTooltipFinal}">${theta >= 0 ? '+' : '-'}${thetaDisplay}</span> ${ivTimeDisplay}`;
        
        // Store on position object for reference
        pos._delta = delta;
        pos._theta = theta;
    }
}

/**
 * Update portfolio summary stats
 */
export function updatePortfolioSummary() {
    // Ensure positions is an array
    if (!Array.isArray(state.positions)) {
        state.positions = [];
    }
    
    const openPositions = state.positions.filter(p => p.status === 'open');
    const closedPositions = state.closedPositions || [];
    
    const totalOpen = openPositions.length;
    const totalContracts = openPositions.reduce((sum, p) => sum + p.contracts, 0);
    
    // Net Premium: must account for buybacks from roll chains
    // For each open position, calculate the CHAIN net premium (premiums - buybacks)
    const netPremium = openPositions.reduce((sum, p) => {
        // Get all positions in this chain (including closed rolled positions)
        const chainId = p.chainId || p.id;
        const chainPositions = [
            ...closedPositions.filter(cp => cp.chainId === chainId),
            ...state.positions.filter(sp => sp.chainId === chainId || sp.id === chainId)
        ].sort((a, b) => (a.openDate || '').localeCompare(b.openDate || ''));
        
        // Calculate net premium for the chain
        let chainNet = 0;
        chainPositions.forEach(cp => {
            const premium = (cp.premium || 0) * 100 * (cp.contracts || 1);
            const isDebit = isDebitPosition(cp.type);
            
            // Add or subtract premium based on position type
            chainNet += isDebit ? -premium : premium;
            
            // Subtract buyback cost if position was rolled
            if (cp.closeReason === 'rolled' && cp.closePrice) {
                chainNet -= cp.closePrice * 100 * (cp.contracts || 1);
            }
        });
        
        return sum + chainNet;
    }, 0);
    
    // Capital at Risk calculation
    // - Puts: strike × 100 × contracts (you might own shares at strike)
    // - Spreads: max loss = width - credit (for credit spreads) or debit paid (for debit spreads)
    // - Long calls/puts: max loss = premium paid
    const capitalAtRisk = openPositions.reduce((sum, p) => {
        const isSpread = p.type?.includes('_spread');
        
        if (isSpread) {
            // For spreads, max loss is already calculated or we compute it
            if (p.maxLoss) {
                return sum + p.maxLoss;
            }
            const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
            const premium = p.premium || 0;
            const maxLoss = isDebitPosition(p.type) 
                ? premium * 100 * p.contracts  // Debit spread: max loss = what you paid
                : (width - premium) * 100 * p.contracts;  // Credit spread: max loss = width - credit
            return sum + maxLoss;
        } else if (isDebitPosition(p.type)) {
            // Long call/put: max loss = premium paid
            return sum + ((p.premium || 0) * 100 * p.contracts);
        } else if (p.type === 'short_put' || p.type === 'buy_write') {
            return sum + ((p.strike || 0) * 100 * p.contracts);
        }
        return sum;
    }, 0);
    
    // Calculate Unrealized P/L - sum of all P/L values from the table
    // P/L = (entry premium - current price) * 100 * contracts for short positions
    // P/L = (current price - entry premium) * 100 * contracts for long positions
    const unrealizedPnL = openPositions.reduce((sum, p) => {
        const currentPrice = p.lastOptionPrice || p.markedPrice || p.premium;
        const entryPrice = p.premium || 0;
        const contracts = p.contracts || 1;
        
        if (isDebitPosition(p.type)) {
            // Long position: profit when current > entry
            return sum + ((currentPrice - entryPrice) * 100 * contracts);
        } else {
            // Short position: profit when current < entry
            return sum + ((entryPrice - currentPrice) * 100 * contracts);
        }
    }, 0);
    
    // Total P/L = Unrealized P/L only (NOT Net Premium + Unrealized)
    // Why? For credit positions, unrealized P/L already represents "premium received minus cost to close"
    // Adding Net Premium would double-count the premium.
    // Net Premium is shown separately for cash flow visibility.
    const totalPnL = unrealizedPnL;
    
    // Calculate ROC (Return on Capital) = Net Premium / Capital at Risk
    const roc = capitalAtRisk > 0 ? (netPremium / capitalAtRisk) * 100 : 0;
    
    // Calculate weighted average annualized ROC
    let weightedAnnROC = 0;
    if (capitalAtRisk > 0) {
        const totalWeightedROC = openPositions.reduce((sum, p) => {
            const isSpread = p.type?.includes('_spread');
            let posCapital;
            
            if (isSpread) {
                if (p.maxLoss) {
                    posCapital = p.maxLoss;
                } else {
                    const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
                    const premium = p.premium || 0;
                    posCapital = isDebitPosition(p.type)
                        ? premium * 100 * p.contracts
                        : (width - premium) * 100 * p.contracts;
                }
            } else if (isDebitPosition(p.type)) {
                // Long call/put: capital at risk = premium paid
                posCapital = (p.premium || 0) * 100 * p.contracts;
            } else if (p.type === 'short_put' || p.type === 'buy_write') {
                posCapital = (p.strike || 0) * 100 * p.contracts;
            } else {
                return sum; // Skip other types
            }
            
            if (posCapital <= 0) return sum;
            
            const posROC = (p.premium * 100 * p.contracts) / posCapital;
            const dte = Math.max(1, p.dte || 1);
            const annROC = posROC * (365 / dte);
            return sum + (annROC * posCapital);
        }, 0);
        weightedAnnROC = (totalWeightedROC / capitalAtRisk) * 100;
    }
    
    // Find closest expiration
    let closestDte = Infinity;
    openPositions.forEach(p => {
        if (p.dte < closestDte) closestDte = p.dte;
    });
    
    // Update summary elements
    const summaryEl = document.getElementById('portfolioSummary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="summary-grid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px;">
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">OPEN POSITIONS</div>
                    <div style="color: #00d9ff; font-size: 24px; font-weight: bold;">${totalOpen}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">TOTAL CONTRACTS</div>
                    <div style="color: #fff; font-size: 24px; font-weight: bold;">${totalContracts}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">CAPITAL AT RISK</div>
                    <div style="color: #ffaa00; font-size: 24px; font-weight: bold;">
                        ${formatCurrency(capitalAtRisk)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">NEXT EXPIRY</div>
                    <div style="color: ${closestDte <= 7 ? '#ff5252' : closestDte <= 21 ? '#ffaa00' : '#00ff88'}; 
                                font-size: 24px; font-weight: bold;">
                        ${closestDte === Infinity ? '—' : closestDte + 'd'}
                    </div>
                </div>
            </div>
            <div class="summary-grid" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; 
                        background: rgba(0,0,0,0.3); border-radius: 8px; padding: 12px;">
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;" title="Cash collected minus cash paid (includes roll buybacks)">NET PREMIUM</div>
                    <div style="color: ${netPremium >= 0 ? '#00ff88' : '#ff5252'}; font-size: 22px; font-weight: bold;">
                        ${netPremium >= 0 ? '+' : ''}${formatCurrency(netPremium)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center; border-left: 1px solid #333; padding-left: 12px;">
                    <div style="color: #888; font-size: 11px;" title="Current value vs entry price">UNREALIZED P/L</div>
                    <div style="color: ${unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'}; font-size: 22px; font-weight: bold;">
                        ${unrealizedPnL >= 0 ? '+' : ''}${formatCurrency(unrealizedPnL)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center; border-left: 1px solid #333; padding-left: 12px;">
                    <div style="color: #888; font-size: 11px;" title="Profit if closed now (premium kept minus cost to close)">TOTAL P/L</div>
                    <div style="color: ${totalPnL >= 0 ? '#00ff88' : '#ff5252'}; font-size: 22px; font-weight: bold;">
                        ${totalPnL >= 0 ? '+' : ''}${formatCurrency(totalPnL)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center; border-left: 1px solid #333; padding-left: 12px;">
                    <div style="color: #888; font-size: 11px;">ROC</div>
                    <div style="color: ${roc >= 0 ? '#00ff88' : '#ff5252'}; font-size: 22px; font-weight: bold;" 
                         title="Return on Capital: Net Premium ÷ Capital at Risk">
                        ${roc.toFixed(2)}%
                    </div>
                </div>
                <div class="summary-item" style="text-align: center; border-left: 1px solid #333; padding-left: 12px;">
                    <div style="color: #888; font-size: 11px;">AVG ANN. ROC</div>
                    <div style="color: ${weightedAnnROC >= 100 ? '#00ff88' : weightedAnnROC >= 50 ? '#ffaa00' : '#ff5252'}; 
                         font-size: 22px; font-weight: bold;" 
                         title="Weighted Average Annualized Return on Capital">
                        ${weightedAnnROC.toFixed(0)}%
                    </div>
                </div>
            </div>
        `;
    }
}

/**
 * Handle assignment - convert put to share ownership
 */
export function assignPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.type.includes('put')) {
        showNotification('Only puts can be assigned shares', 'error');
        return;
    }
    
    // Save undo state BEFORE making changes
    const originalPosition = {...pos};
    state.lastAction = {
        type: 'assign',
        position: originalPosition,
        timestamp: Date.now()
    };
    
    // Calculate cost basis: Strike - Premium received
    const premiumReceived = pos.premium;
    const costBasis = pos.strike - premiumReceived;
    const shares = 100 * (pos.contracts || 1);
    
    // Create holding record
    const holdingId = Date.now();
    const holding = {
        id: holdingId,
        ticker: pos.ticker,
        shares: shares,
        costBasis: costBasis,
        strike: pos.strike,
        premiumReceived: premiumReceived,
        assignedDate: new Date().toISOString().split('T')[0],
        fromPutId: pos.id,
        chainId: pos.chainId || pos.id,
        broker: pos.broker || 'Schwab',
        totalCost: costBasis * shares,
        premiumCredit: premiumReceived * 100 * (pos.contracts || 1)
    };
    
    // Store holding ID for undo
    state.lastAction.holdingId = holdingId;
    
    // Add to holdings
    if (!Array.isArray(state.holdings)) state.holdings = [];
    state.holdings.push(holding);
    saveHoldingsToStorage();
    
    // Close the put position as "assigned"
    pos.status = 'assigned';
    pos.closeDate = holding.assignedDate;
    pos.closePrice = 0; // Option expires worthless (ITM)
    pos.realizedPnL = premiumReceived * 100 * (pos.contracts || 1); // Keep the premium
    pos.daysHeld = pos.openDate ? 
        Math.ceil((new Date(holding.assignedDate) - new Date(pos.openDate)) / (1000 * 60 * 60 * 24)) : 0;
    
    // Move to closed positions
    if (!Array.isArray(state.closedPositions)) state.closedPositions = [];
    state.closedPositions.push({...pos});
    saveClosedToStorage();
    
    // Remove from open positions
    state.positions = state.positions.filter(p => p.id !== id);
    savePositionsToStorage();
    
    // Show undo notification instead of regular one
    showUndoNotification(
        `📦 Assigned ${shares} shares of ${pos.ticker}`, 
        'warning'
    );
    
    renderPositions();
    updatePortfolioSummary();
    
    // Trigger portfolio re-render if function exists
    if (window.renderHoldings) window.renderHoldings();
    if (window.renderPortfolio) window.renderPortfolio(false);
}

/**
 * Undo last destructive action
 */
export function undoLastAction() {
    const action = state.lastAction;
    if (!action) {
        showNotification('Nothing to undo', 'info');
        return;
    }
    
    // Check if action is too old (> 60 seconds)
    if (Date.now() - action.timestamp > 60000) {
        showNotification('Undo expired (> 60 seconds)', 'warning');
        state.lastAction = null;
        return;
    }
    
    switch (action.type) {
        case 'assign':
            // Restore the position
            const restoredPos = action.position;
            restoredPos.status = 'open';
            delete restoredPos.closeDate;
            delete restoredPos.closePrice;
            delete restoredPos.realizedPnL;
            delete restoredPos.daysHeld;
            
            // Add back to positions
            state.positions.push(restoredPos);
            savePositionsToStorage();
            
            // Remove the holding that was created
            if (action.holdingId) {
                state.holdings = (state.holdings || []).filter(h => h.id !== action.holdingId);
                saveHoldingsToStorage();
            }
            
            // Remove from closed positions
            state.closedPositions = (state.closedPositions || []).filter(p => p.id !== restoredPos.id);
            saveClosedToStorage();
            
            showNotification(`↩ Undone! ${restoredPos.ticker} position restored`, 'success');
            break;
            
        case 'close':
            // Restore closed position
            const closedPos = action.position;
            closedPos.status = 'open';
            delete closedPos.closeDate;
            delete closedPos.closePrice;
            delete closedPos.realizedPnL;
            delete closedPos.daysHeld;
            
            state.positions.push(closedPos);
            savePositionsToStorage();
            
            // Remove from closed
            state.closedPositions = (state.closedPositions || []).filter(p => p.id !== closedPos.id);
            saveClosedToStorage();
            
            showNotification(`↩ Undone! ${closedPos.ticker} position reopened`, 'success');
            break;
            
        case 'delete':
            // Restore deleted position
            state.positions.push(action.position);
            savePositionsToStorage();
            showNotification(`↩ Undone! ${action.position.ticker} position restored`, 'success');
            break;
            
        default:
            showNotification('Unknown action type', 'error');
            return;
    }
    
    // Clear the undo state
    state.lastAction = null;
    
    // Refresh UI
    renderPositions();
    updatePortfolioSummary();
    if (window.renderHoldings) window.renderHoldings();
    if (window.renderPortfolio) window.renderPortfolio(false);
}

// Export to window for HTML onclick handlers
window.addPosition = addPosition;
window.deletePosition = deletePosition;
window.loadPositionToAnalyze = loadPositionToAnalyze;
window.closePosition = closePosition;
window.assignPosition = assignPosition;
window.renderPositions = renderPositions;
window.updatePortfolioSummary = updatePortfolioSummary;
window.undoLastAction = undoLastAction;

/**
 * Export all data to a JSON file for backup
 */
export function exportAllData() {
    const CLOSED_KEY = 'wheelhouse_closed_positions';
    
    const exportData = {
        version: 1,
        exportDate: new Date().toISOString(),
        positions: state.positions || [],
        holdings: state.holdings || [],
        closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wheelhouse_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('✅ Backup exported successfully!', 'success');
}

/**
 * Import data from a JSON backup file
 */
export function importAllData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importData = JSON.parse(e.target.result);
            
            // Validate the import data
            if (!importData.positions && !importData.holdings && !importData.closedPositions) {
                showNotification('❌ Invalid backup file format', 'error');
                return;
            }
            
            // Confirm before overwriting
            const posCount = (importData.positions || []).length;
            const holdCount = (importData.holdings || []).length;
            const closedCount = (importData.closedPositions || []).length;
            
            const msg = `Import ${posCount} positions, ${holdCount} holdings, ${closedCount} closed positions?\\n\\nThis will REPLACE your current data.`;
            
            if (!confirm(msg)) {
                showNotification('Import cancelled', 'info');
                return;
            }
            
            // Import the data
            if (importData.positions) {
                state.positions = importData.positions;
                savePositionsToStorage();
            }
            
            if (importData.holdings) {
                state.holdings = importData.holdings;
                saveHoldingsToStorage();
            }
            
            if (importData.closedPositions) {
                state.closedPositions = importData.closedPositions;
                saveClosedToStorage();
            }
            
            // Refresh UI
            renderPositions();
            updatePortfolioSummary();
            if (window.renderHoldings) window.renderHoldings();
            if (window.renderPortfolio) window.renderPortfolio(false);
            
            showNotification(`✅ Imported ${posCount} positions, ${holdCount} holdings, ${closedCount} closed!`, 'success', 5000);
            
        } catch (err) {
            console.error('Import error:', err);
            showNotification('❌ Failed to parse backup file: ' + err.message, 'error');
        }
    };
    
    reader.readAsText(file);
    
    // Reset the file input so the same file can be imported again
    event.target.value = '';
}

/**
 * Toggle position type specific fields visibility
 */
function togglePositionTypeFields() {
    const type = document.getElementById('posType').value;
    const buyWriteFields = document.getElementById('buyWriteFields');
    const spreadFields = document.getElementById('spreadFields');
    const skipFields = document.getElementById('skipFields');
    const strikeField = document.getElementById('posStrike')?.parentElement;
    const premiumField = document.getElementById('posPremium')?.parentElement;
    const spreadExplanation = document.getElementById('spreadExplanation');
    
    const isSpread = type.includes('_spread');
    const isBuyWrite = type === 'buy_write';
    const isSkip = type === 'skip_call';
    const isLeaps = type === 'long_call_leaps';
    
    if (buyWriteFields) {
        buyWriteFields.style.display = isBuyWrite ? 'block' : 'none';
    }
    
    if (spreadFields) {
        spreadFields.style.display = isSpread ? 'block' : 'none';
    }
    
    if (skipFields) {
        skipFields.style.display = isSkip ? 'block' : 'none';
    }
    
    // For SKIP, the main strike/premium fields are for the SKIP call (shorter-dated)
    // LEAPS fields are in the skipFields section
    if (strikeField) {
        // Hide for spreads, show for everything else (including SKIP where it's the SKIP call strike)
        strikeField.style.display = isSpread ? 'none' : 'block';
        
        // Update label for SKIP
        const strikeLabel = strikeField.querySelector('label');
        if (strikeLabel) {
            strikeLabel.textContent = isSkip ? 'SKIP Strike $' : 'Strike $';
        }
    }
    
    if (premiumField) {
        // Update label for SKIP
        const premiumLabel = premiumField.querySelector('label');
        if (premiumLabel) {
            premiumLabel.textContent = isSkip ? 'SKIP Premium $' : 'Premium $';
        }
    }
    
    // Update spread explanation based on type
    if (spreadExplanation) {
        const explanations = {
            'call_debit_spread': '💡 Buy lower strike call, Sell higher strike call. Profit if stock goes UP. Max profit at sell strike.',
            'put_debit_spread': '💡 Buy higher strike put, Sell lower strike put. Profit if stock goes DOWN. Max profit at sell strike.',
            'call_credit_spread': '💡 Sell lower strike call, Buy higher strike call. Profit if stock stays BELOW sell strike.',
            'put_credit_spread': '💡 Sell higher strike put, Buy lower strike put. Profit if stock stays ABOVE sell strike.'
        };
        spreadExplanation.textContent = explanations[type] || '';
    }
}

// Legacy alias
function toggleBuyWriteFields() {
    togglePositionTypeFields();
}

window.exportAllData = exportAllData;
window.importAllData = importAllData;
window.toggleBuyWriteFields = toggleBuyWriteFields;
window.togglePositionTypeFields = togglePositionTypeFields;

/**
 * Save an AI analysis to a position's analysis history
 * @param {number} positionId - The position ID
 * @param {object} analysisData - The analysis to save
 * @param {string} analysisData.insight - The AI response text
 * @param {string} analysisData.model - Model used
 * @param {string} analysisData.recommendation - HOLD/ROLL/CLOSE extracted
 * @param {object} analysisData.snapshot - Market conditions at time of analysis
 */
export function saveAnalysisToPosition(positionId, analysisData) {
    const position = state.positions.find(p => p.id === positionId);
    if (!position) {
        console.warn('[Analysis] Position not found:', positionId);
        return false;
    }
    
    // Initialize analysisHistory if it doesn't exist
    if (!position.analysisHistory) {
        position.analysisHistory = [];
    }
    
    // Create analysis entry
    const entry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        model: analysisData.model || 'unknown',
        recommendation: analysisData.recommendation || 'UNKNOWN',
        insight: analysisData.insight || '',
        snapshot: analysisData.snapshot || {}
    };
    
    // Add to history (newest first)
    position.analysisHistory.unshift(entry);
    
    // Keep max 10 analyses per position
    if (position.analysisHistory.length > 10) {
        position.analysisHistory = position.analysisHistory.slice(0, 10);
    }
    
    // Save to localStorage
    savePositionsToStorage();
    console.log('[Analysis] Saved analysis for', position.ticker, '- now has', position.analysisHistory.length, 'entries');
    
    return true;
}

/**
 * Get the most recent analysis for a position
 * @param {number} positionId - The position ID
 * @returns {object|null} The most recent analysis or null
 */
export function getLatestAnalysis(positionId) {
    const position = state.positions.find(p => p.id === positionId);
    if (!position || !position.analysisHistory || position.analysisHistory.length === 0) {
        return null;
    }
    return position.analysisHistory[0];
}

/**
 * Get all analyses for a position
 * @param {number} positionId - The position ID
 * @returns {array} Array of analysis entries
 */
export function getAnalysisHistory(positionId) {
    const position = state.positions.find(p => p.id === positionId);
    if (!position || !position.analysisHistory) {
        return [];
    }
    return position.analysisHistory;
}

// Make available globally
window.saveAnalysisToPosition = saveAnalysisToPosition;
window.getLatestAnalysis = getLatestAnalysis;
window.getAnalysisHistory = getAnalysisHistory;
window.savePositionsToStorage = savePositionsToStorage;

// ============================================================
// RECONCILIATION WITH BROKERAGE
// ============================================================

/**
 * Show the reconciliation modal - compares WheelHouse data with Schwab transactions
 */
window.showReconcileModal = async function() {
    const modal = document.createElement('div');
    modal.id = 'reconcileModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.9); display:flex; align-items:center; 
        justify-content:center; z-index:10000; padding:20px;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:900px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0; color:#00d9ff;">🔄 Reconcile with Schwab</h2>
                <button onclick="document.getElementById('reconcileModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            
            <div style="margin-bottom:20px; padding:15px; background:rgba(0,217,255,0.1); border-radius:8px;">
                <div style="display:flex; gap:15px; align-items:center; flex-wrap:wrap;">
                    <div>
                        <label style="color:#888; font-size:11px;">Account:</label><br>
                        <select id="reconcileAccount" style="padding:8px; background:#0d0d1a; color:#fff; border:1px solid #333; border-radius:4px; min-width:200px;">
                            <option value="">Loading accounts...</option>
                        </select>
                    </div>
                    <div>
                        <label style="color:#888; font-size:11px;">Date Range:</label><br>
                        <select id="reconcileDays" style="padding:8px; background:#0d0d1a; color:#fff; border:1px solid #333; border-radius:4px;">
                            <option value="7">Last 7 days</option>
                            <option value="30" selected>Last 30 days</option>
                            <option value="90">Last 90 days</option>
                            <option value="180">Last 6 months</option>
                            <option value="365">Last year</option>
                        </select>
                    </div>
                    <button id="runReconcileBtn" onclick="window.runReconciliation()" 
                            style="padding:10px 20px; background:linear-gradient(135deg, #00d9ff 0%, #00ff88 100%); 
                                   border:none; border-radius:6px; color:#000; font-weight:bold; cursor:pointer;">
                        ⚡ Fetch & Compare
                    </button>
                </div>
            </div>
            
            <div id="reconcileResults" style="color:#ddd;">
                <div style="text-align:center; padding:40px; color:#666;">
                    Select an account and click "Fetch & Compare" to pull transactions from Schwab and compare with your WheelHouse data.
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Load accounts into dropdown
    await loadReconcileAccounts();
};

/**
 * Load Schwab accounts into the reconcile dropdown
 */
async function loadReconcileAccounts() {
    const select = document.getElementById('reconcileAccount');
    if (!select) return;
    
    try {
        // Fetch account numbers (has hashValue) and full accounts (has type/balance)
        const [numbersRes, accountsRes] = await Promise.all([
            fetch('/api/schwab/accounts/numbers'),
            fetch('/api/schwab/accounts')
        ]);
        
        if (!numbersRes.ok || !accountsRes.ok) {
            select.innerHTML = '<option value="">Schwab not connected</option>';
            return;
        }
        
        const numbers = await numbersRes.json();
        const accounts = await accountsRes.json();
        
        if (!numbers || numbers.length === 0) {
            select.innerHTML = '<option value="">No accounts found</option>';
            return;
        }
        
        // Build options with account type and last 4 digits
        select.innerHTML = '';
        numbers.forEach((num, idx) => {
            const fullAcct = accounts.find(a => a.securitiesAccount?.accountNumber === num.accountNumber);
            const type = fullAcct?.securitiesAccount?.type || 'Unknown';
            const lastFour = num.accountNumber.slice(-4);
            
            const option = document.createElement('option');
            option.value = num.hashValue;
            option.textContent = `${type} ...${lastFour}`;
            option.dataset.accountNumber = num.accountNumber;
            
            // Pre-select the preferred account or first margin account
            const preferredAccount = localStorage.getItem('wheelhouse_preferred_account');
            if (preferredAccount && num.accountNumber === preferredAccount) {
                option.selected = true;
            } else if (!preferredAccount && type === 'MARGIN' && !select.value) {
                option.selected = true;
            }
            
            select.appendChild(option);
        });
        
    } catch (e) {
        console.error('[Reconcile] Failed to load accounts:', e);
        select.innerHTML = '<option value="">Error loading accounts</option>';
    }
}

/**
 * Run the reconciliation - fetch Schwab transactions and compare
 */
window.runReconciliation = async function() {
    const resultsDiv = document.getElementById('reconcileResults');
    const runBtn = document.getElementById('runReconcileBtn');
    const days = parseInt(document.getElementById('reconcileDays').value) || 30;
    
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Fetching...';
    resultsDiv.innerHTML = '<div style="text-align:center; padding:40px; color:#00d9ff;">🔄 Fetching transactions from Schwab...</div>';
    
    try {
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date(endDate - days * 24 * 60 * 60 * 1000);
        
        // Get account hash from dropdown selection
        const accountSelect = document.getElementById('reconcileAccount');
        const accountHash = accountSelect?.value;
        const selectedOption = accountSelect?.selectedOptions[0];
        const accountNumber = selectedOption?.dataset?.accountNumber || 'Unknown';
        
        if (!accountHash) {
            throw new Error('Please select an account to reconcile.');
        }
        
        // Log which account we're using
        console.log('[Reconcile] Using account:', accountNumber, 'hash:', accountHash);
        
        const response = await fetch(`/api/schwab/accounts/${accountHash}/transactions?types=TRADE&startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`);
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `Schwab API error: ${response.status}`);
        }
        
        const transactions = await response.json();
        console.log('[Reconcile] Raw transactions count:', transactions?.length || 0);
        console.log('[Reconcile] Raw transactions:', transactions);
        
        // Debug: log what asset types we're seeing
        const assetTypes = (transactions || []).map(t => {
            const inst = t.transactionItem?.instrument;
            return inst?.assetType || t.type || 'NO_ASSET_TYPE';
        });
        console.log('[Reconcile] Asset types found:', [...new Set(assetTypes)]);
        
        // Also log first transaction structure for debugging
        if (transactions?.length > 0) {
            console.log('[Reconcile] First transaction structure:', JSON.stringify(transactions[0], null, 2));
        }
        
        // Filter to option trades only
        // Schwab API stores option data in transferItems array, not transactionItem
        const optionTrades = (transactions || []).map(t => {
            // Find the OPTION item in transferItems
            const optionItem = (t.transferItems || []).find(item => 
                item.instrument?.assetType === 'OPTION'
            );
            if (!optionItem) return null;
            
            // Return transaction with extracted option data for easy access
            return {
                ...t,
                _optionItem: optionItem,
                _inst: optionItem.instrument
            };
        }).filter(t => t !== null);
        
        console.log('[Reconcile] Option trades after filter:', optionTrades.length);
        if (optionTrades.length > 0) {
            console.log('[Reconcile] First option trade instrument:', optionTrades[0]._inst);
        }
        
        // Group transactions by underlying symbol
        const bySymbol = {};
        optionTrades.forEach(t => {
            const underlying = t._inst?.underlyingSymbol || 'UNKNOWN';
            if (!bySymbol[underlying]) bySymbol[underlying] = [];
            bySymbol[underlying].push(t);
        });
        
        // Get WheelHouse positions and closed positions for comparison
        const whPositions = [...(state.positions || []), ...(state.closedPositions || [])];
        
        // Build comparison results
        const results = {
            matched: [],
            schwabOnly: [],
            wheelHouseOnly: [],
            discrepancies: []
        };
        
        // Check each Schwab transaction
        optionTrades.forEach(t => {
            const inst = t._inst;
            const underlying = inst?.underlyingSymbol;
            const strike = parseFloat(inst?.strikePrice || 0);
            const putCall = inst?.putCall; // PUT or CALL
            const expiry = inst?.expirationDate?.split('T')[0]; // YYYY-MM-DD
            const qty = Math.abs(t._optionItem?.amount || 0);
            const price = Math.abs(t._optionItem?.price || 0);
            const positionEffect = t._optionItem?.positionEffect || 'UNKNOWN'; // OPENING or CLOSING
            const tradeDate = t.tradeDate?.split('T')[0];
            const description = t.description || '';
            
            // Calculate raw premium (price * contracts * 100) - excludes fees
            const schwabPremium = price * qty * 100;
            
            // Try to find matching WheelHouse position
            const matchingPos = whPositions.find(p => {
                const tickerMatch = p.ticker === underlying;
                const strikeMatch = Math.abs((p.strike || 0) - strike) < 0.01;
                const expiryMatch = p.expiry === expiry;
                const typeMatch = putCall === 'PUT' ? 
                    (p.type?.includes('put') || p.type === 'short_put') :
                    (p.type?.includes('call') || p.type === 'covered_call' || p.type === 'buy_write');
                return tickerMatch && strikeMatch && expiryMatch && typeMatch;
            });
            
            if (matchingPos) {
                // For OPENING trades, compare to WH opening premium
                // For CLOSING trades, compare to WH closePrice (if position is closed)
                const isClosingTrade = positionEffect === 'CLOSING';
                
                let whValue, comparisonType;
                if (isClosingTrade) {
                    // Closing trade - compare to closePrice if position is closed
                    if (matchingPos.status === 'closed' && matchingPos.closePrice != null) {
                        whValue = matchingPos.closePrice * 100 * matchingPos.contracts;
                        comparisonType = 'close';
                    } else {
                        // Position still open in WH but Schwab shows it closed - that's a matched close
                        results.matched.push({
                            ticker: underlying,
                            strike,
                            expiry,
                            type: putCall,
                            positionEffect,
                            schwabPremium,
                            note: 'Closing trade - position may need to be closed in WH',
                            position: matchingPos
                        });
                        return; // Skip further processing
                    }
                } else {
                    // Opening trade - compare to WH opening premium
                    whValue = matchingPos.premium * 100 * matchingPos.contracts;
                    comparisonType = 'open';
                }
                
                const premiumDiff = Math.abs(whValue - schwabPremium);
                
                if (premiumDiff > 5) { // More than $5 difference (allows for rounding)
                    results.discrepancies.push({
                        ticker: underlying,
                        strike,
                        expiry,
                        type: putCall,
                        tradeDate,
                        positionEffect,
                        comparisonType, // 'open' or 'close'
                        schwabPremium,
                        whPremium: whValue,
                        diff: schwabPremium - whValue,
                        position: matchingPos,
                        transaction: t
                    });
                } else {
                    results.matched.push({
                        ticker: underlying,
                        strike,
                        expiry,
                        type: putCall,
                        positionEffect,
                        schwabPremium,
                        position: matchingPos
                    });
                }
            } else {
                // Schwab has it, WheelHouse doesn't
                results.schwabOnly.push({
                    ticker: underlying,
                    strike,
                    expiry,
                    type: putCall,
                    tradeDate,
                    positionEffect,
                    schwabPremium,
                    qty,
                    price,
                    description,
                    transaction: t
                });
            }
        });
        
        // Check for WheelHouse positions not in Schwab (within date range)
        // Exclude positions that already matched or had discrepancies
        const matchedPositionIds = new Set([
            ...results.matched.map(m => m.position?.id),
            ...results.discrepancies.map(d => d.position?.id)
        ]);
        
        whPositions.forEach(p => {
            // Skip if already matched or had discrepancy
            if (matchedPositionIds.has(p.id)) return;
            
            const openDate = new Date(p.openDate);
            if (openDate >= startDate && openDate <= endDate) {
                const inSchwab = optionTrades.some(t => {
                    const inst = t._inst;
                    return inst?.underlyingSymbol === p.ticker &&
                           Math.abs((inst?.strikePrice || 0) - (p.strike || 0)) < 0.01 &&
                           inst?.expirationDate?.split('T')[0] === p.expiry;
                });
                if (!inSchwab && p.broker !== 'manual') {
                    results.wheelHouseOnly.push(p);
                }
            }
        });
        
        // Render results with account info
        renderReconcileResults(results, optionTrades.length, days, {
            accountNumber: accountNumber,
            rawTransactionCount: transactions?.length || 0
        });
        
    } catch (e) {
        console.error('[Reconcile] Error:', e);
        resultsDiv.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <div style="color:#ff5252; font-size:18px; margin-bottom:10px;">❌ Error</div>
                <div style="color:#888;">${e.message}</div>
            </div>
        `;
    } finally {
        runBtn.disabled = false;
        runBtn.textContent = '⚡ Fetch & Compare';
    }
};

/**
 * Render reconciliation results
 */
function renderReconcileResults(results, totalTrades, days, accountInfo = {}) {
    const resultsDiv = document.getElementById('reconcileResults');
    
    const matchCount = results.matched.length;
    const discrepCount = results.discrepancies.length;
    const schwabOnlyCount = results.schwabOnly.length;
    const whOnlyCount = results.wheelHouseOnly.length;
    
    const isClean = discrepCount === 0 && schwabOnlyCount === 0 && whOnlyCount === 0;
    
    let html = `
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:15px; margin-bottom:20px;">
            <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:8px; padding:15px; text-align:center;">
                <div style="font-size:28px; font-weight:bold; color:#00ff88;">${matchCount}</div>
                <div style="font-size:11px; color:#888;">✅ Matched</div>
            </div>
            <div style="background:rgba(255,82,82,0.1); border:1px solid rgba(255,82,82,0.3); border-radius:8px; padding:15px; text-align:center;">
                <div style="font-size:28px; font-weight:bold; color:#ff5252;">${discrepCount}</div>
                <div style="font-size:11px; color:#888;">⚠️ Discrepancies</div>
            </div>
            <div style="background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                <div style="font-size:28px; font-weight:bold; color:#ffaa00;">${schwabOnlyCount}</div>
                <div style="font-size:11px; color:#888;">📊 In Schwab Only</div>
            </div>
            <div style="background:rgba(139,92,246,0.1); border:1px solid rgba(139,92,246,0.3); border-radius:8px; padding:15px; text-align:center;">
                <div style="font-size:28px; font-weight:bold; color:#8b5cf6;">${whOnlyCount}</div>
                <div style="font-size:11px; color:#888;">📋 In WH Only</div>
            </div>
        </div>
    `;
    
    if (isClean) {
        html += `
            <div style="text-align:center; padding:30px; background:rgba(0,255,136,0.1); border-radius:8px; margin-bottom:20px;">
                <div style="font-size:36px; margin-bottom:10px;">✅</div>
                <div style="font-size:18px; color:#00ff88; font-weight:bold;">All Clear!</div>
                <div style="color:#888; margin-top:5px;">Your WheelHouse data matches Schwab for the last ${days} days.</div>
            </div>
        `;
    }
    
    // Show discrepancies
    if (discrepCount > 0) {
        html += `<h3 style="color:#ff5252; margin:20px 0 10px;">⚠️ Premium Discrepancies</h3>`;
        html += `<div style="font-size:11px; color:#888; margin-bottom:10px;">These trades matched by ticker/strike/expiry but the value differs by more than $5. Comparing: OPEN trades → WH opening premium, CLOSE trades → WH close price.</div>`;
        html += `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
            <tr style="background:#1a1a2e;">
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Ticker</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Strike</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Expiry</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Action</th>
                <th style="padding:8px; text-align:right; border-bottom:1px solid #333;">Schwab</th>
                <th style="padding:8px; text-align:right; border-bottom:1px solid #333;">WH (${`open/close`})</th>
                <th style="padding:8px; text-align:right; border-bottom:1px solid #333;">Diff</th>
            </tr>`;
        results.discrepancies.forEach(d => {
            const diffColor = d.diff > 0 ? '#00ff88' : '#ff5252';
            const actionLabel = d.positionEffect === 'OPENING' ? '🟢 OPEN' : 
                                d.positionEffect === 'CLOSING' ? '🔴 CLOSE' : '⚪ ???';
            const whLabel = d.comparisonType === 'close' ? 'close' : 'open';
            html += `
                <tr style="border-bottom:1px solid #222;">
                    <td style="padding:8px; color:#00d9ff; font-weight:bold;">${d.ticker}</td>
                    <td style="padding:8px;">$${d.strike}</td>
                    <td style="padding:8px;">${d.expiry}</td>
                    <td style="padding:8px; font-size:10px;">${actionLabel}</td>
                    <td style="padding:8px; text-align:right;">$${d.schwabPremium.toFixed(2)}</td>
                    <td style="padding:8px; text-align:right;">$${d.whPremium.toFixed(2)} <span style="font-size:9px;color:#888;">(${whLabel})</span></td>
                    <td style="padding:8px; text-align:right; color:${diffColor};">${d.diff > 0 ? '+' : ''}$${d.diff.toFixed(2)}</td>
                </tr>
            `;
        });
        html += `</table></div>`;
    }
    
    // Show Schwab-only trades
    if (schwabOnlyCount > 0) {
        html += `<h3 style="color:#ffaa00; margin:20px 0 10px;">📊 In Schwab Only (not in WheelHouse)</h3>`;
        html += `<div style="font-size:11px; color:#888; margin-bottom:10px;">These trades exist in Schwab but no matching WheelHouse position was found.</div>`;
        html += `<div style="overflow-x:auto;"><table style="width:100%; border-collapse:collapse; font-size:12px;">
            <tr style="background:#1a1a2e;">
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Date</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Ticker</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Type</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Strike</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Expiry</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;">Action</th>
                <th style="padding:8px; text-align:right; border-bottom:1px solid #333;">Premium</th>
                <th style="padding:8px; text-align:left; border-bottom:1px solid #333;"></th>
            </tr>`;
        results.schwabOnly.forEach(s => {
            const actionLabel = s.positionEffect === 'OPENING' ? '🟢 OPEN' : 
                                s.positionEffect === 'CLOSING' ? '🔴 CLOSE' : '⚪ ???';
            html += `
                <tr style="border-bottom:1px solid #222;">
                    <td style="padding:8px; color:#888;">${s.tradeDate}</td>
                    <td style="padding:8px; color:#00d9ff; font-weight:bold;">${s.ticker}</td>
                    <td style="padding:8px;">${s.type}</td>
                    <td style="padding:8px;">$${s.strike}</td>
                    <td style="padding:8px;">${s.expiry}</td>
                    <td style="padding:8px; font-size:10px;">${actionLabel}</td>
                    <td style="padding:8px; text-align:right; color:#00ff88;">$${s.schwabPremium.toFixed(2)}</td>
                    <td style="padding:8px;">
                        <button onclick="window.importSchwabTrade(${JSON.stringify(s).replace(/"/g, '&quot;')})" 
                                style="padding:4px 8px; background:#ffaa00; border:none; border-radius:4px; color:#000; cursor:pointer; font-size:10px;">
                            ➕ Import
                        </button>
                    </td>
                </tr>
            `;
        });
        html += `</table></div>`;
    }
    
    // Show WheelHouse-only
    if (whOnlyCount > 0) {
        html += `<h3 style="color:#8b5cf6; margin:20px 0 10px;">📋 In WheelHouse Only (not in Schwab)</h3>`;
        html += `<div style="font-size:11px; color:#888; margin-bottom:10px;">These positions were opened in the last ${days} days but no matching Schwab trade was found. They may have been added manually or imported from another source.</div>`;
        html += `<ul style="color:#ccc; font-size:12px;">`;
        results.wheelHouseOnly.forEach(p => {
            html += `<li>${p.ticker} $${p.strike} ${p.type} exp ${p.expiry}</li>`;
        });
        html += `</ul>`;
    }
    
    // Summary footer with account info
    const acctDisplay = accountInfo.accountNumber ? `...${accountInfo.accountNumber.slice(-4)}` : 'Unknown';
    const rawCount = accountInfo.rawTransactionCount || 0;
    html += `
        <div style="margin-top:20px; padding:15px; background:#0d0d1a; border-radius:8px; font-size:11px; color:#666;">
            📊 Analyzed ${totalTrades} option trades from Schwab over the last ${days} days.<br>
            🏦 Account queried: <span style="color:#00d9ff;">${acctDisplay}</span> (${rawCount} total transactions, ${totalTrades} were options)<br>
            Last reconciled: ${new Date().toLocaleString()}
        </div>
    `;
    
    resultsDiv.innerHTML = html;
}

/**
 * Import a single Schwab trade into WheelHouse
 */
window.importSchwabTrade = function(tradeData) {
    // Determine position type from the trade
    let posType = 'short_put';
    if (tradeData.type === 'CALL') {
        posType = tradeData.netAmount >= 0 ? 'covered_call' : 'long_call';
    } else {
        posType = tradeData.netAmount >= 0 ? 'short_put' : 'long_put';
    }
    
    const newPosition = {
        id: Date.now(),
        chainId: Date.now(),
        ticker: tradeData.ticker,
        type: posType,
        strike: tradeData.strike,
        premium: Math.abs(tradeData.price || tradeData.netAmount / 100 / tradeData.qty),
        contracts: tradeData.qty || 1,
        expiry: tradeData.expiry,
        openDate: tradeData.tradeDate,
        status: 'open',
        broker: 'Schwab',
        importedFromReconcile: true
    };
    
    state.positions.push(newPosition);
    savePositionsToStorage();
    showNotification(`Imported ${tradeData.ticker} ${tradeData.type} from Schwab`, 'success');
    
    // Re-run reconciliation to update the view
    window.runReconciliation();
};