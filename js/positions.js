// WheelHouse - Position Tracker Module
// localStorage-based position management

import { state, setPositionContext, clearPositionContext } from './state.js';
import { formatCurrency, formatPercent, getDteUrgency, showNotification, showUndoNotification, randomNormal } from './utils.js';
import { fetchPositionTickerPrice, fetchStockPrice, fetchStockPricesBatch } from './api.js';
import { drawPayoffChart } from './charts.js';
import { updateDteDisplay } from './ui.js';

const STORAGE_KEY = 'wheelhouse_positions';
const HOLDINGS_KEY = 'wheelhouse_holdings';
const CLOSED_KEY = 'wheelhouse_closed_positions';
const CHECKPOINT_KEY = 'wheelhouse_data_checkpoint';

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

/**
 * Check if a position type is a debit (you pay premium)
 * Debit positions: long_call, long_put, debit spreads
 * Credit positions: short_call, short_put, covered_call, buy_write, credit spreads
 */
function isDebitPosition(type) {
    if (!type) return false;
    // SKIP is a debit position (you pay for both LEAPS and SKIP calls)
    return type.includes('debit') || type === 'long_call' || type === 'long_put' || type === 'skip_call';
}

// Cache for spot prices (refreshed every 5 minutes)
const spotPriceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    const rate = 0.05; // Risk-free rate assumption
    
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
 * Estimate volatility based on ticker characteristics
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
 * @returns {object} { icon, text, color, needsAttention, itmPct }
 */
function calculatePositionRisk(pos, spotPrice) {
    // If we don't have spot price, fall back to DTE-based status
    if (!spotPrice || !pos.strike) {
        if (pos.dte <= 5) {
            return { icon: '⏳', text: 'Check', color: colors.orange, needsAttention: true, itmPct: null };
        } else if (pos.dte <= 14) {
            return { icon: '⏳', text: 'Check', color: colors.muted, needsAttention: false, itmPct: null };
        }
        return { icon: '🟢', text: 'OK', color: colors.green, needsAttention: false, itmPct: null };
    }
    
    const isPut = pos.type?.includes('put');
    const isCall = pos.type?.includes('call');
    
    // Skip spreads for now - they have complex risk profiles
    if (pos.type?.includes('_spread')) {
        return { icon: '📊', text: 'Spread', color: colors.purple, needsAttention: false, itmPct: null };
    }
    
    // Use stored IV if available, otherwise estimate based on ticker
    const vol = pos.iv || estimateVolatility(pos.ticker);
    
    // Calculate ITM probability
    const itmPct = quickMonteCarloRisk(spotPrice, pos.strike, pos.dte, vol, isPut);
    
    // Thresholds match analysis.js recommendation panel:
    // < 30% = HOLD (safe)
    // 30-40% = WATCH (moderate)
    // 40-50% = CAUTION (consider rolling)
    // 50-60% = HIGH RISK (roll now!)
    // > 60% = DANGER (close immediately)
    
    if (itmPct >= 50) {
        // HIGH RISK or DANGER - needs immediate attention
        return { 
            icon: '🔴', 
            text: `${itmPct.toFixed(0)}%`, 
            color: colors.red, 
            needsAttention: true, 
            itmPct 
        };
    } else if (itmPct >= 40) {
        // CAUTION - consider rolling
        return { 
            icon: '🟠', 
            text: `${itmPct.toFixed(0)}%`, 
            color: '#ff8800', 
            needsAttention: true, 
            itmPct 
        };
    } else if (itmPct >= 30) {
        // WATCH - moderate risk
        return { 
            icon: '🟡', 
            text: `${itmPct.toFixed(0)}%`, 
            color: colors.orange, 
            needsAttention: false,  // Yellow is "watch", not urgent
            itmPct 
        };
    } else {
        // HOLD - safe
        return { 
            icon: '🟢', 
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
 * Check if a position has roll history (other positions in its chain)
 */
function hasRollHistory(pos) {
    const chainId = pos.chainId || pos.id;
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    return allPositions.filter(p => (p.chainId || p.id) === chainId).length > 1;
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
    
    // Calculate total premium collected across the chain
    const totalPremium = chainPositions.reduce((sum, p) => sum + (p.premium * 100 * p.contracts), 0);
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
        
        // Strike display
        let strikeDisplay = '';
        if (pos.type?.includes('_spread')) {
            strikeDisplay = `$${pos.buyStrike}/$${pos.sellStrike}`;
        } else {
            strikeDisplay = `$${pos.strike}`;
        }
        
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
                        <span style="color:${statusColor}; font-size:11px; padding:2px 8px; 
                                     background:${statusColor}22; border-radius:10px;">
                            ${statusText}
                        </span>
                    </div>
                    <div style="color:#aaa; font-size:13px;">
                        <span style="color:${colors.muted};">${pos.type?.replace(/_/g, ' ').toUpperCase() || 'PUT'}</span>
                        &nbsp;•&nbsp; Strike: <span style="color:${colors.text};">${strikeDisplay}</span>
                        &nbsp;•&nbsp; Exp: <span style="color:${colors.text};">${pos.expiry || 'N/A'}</span>
                    </div>
                    <div style="margin-top:6px; display:flex; gap:20px; font-size:12px;">
                        <span>Premium: <span style="color:${premiumColor}; font-weight:bold;">${premiumSign}$${premium.toFixed(0)}</span></span>
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
                <div style="color:${colors.muted}; font-size:11px; margin-bottom:4px;">TOTAL PREMIUM COLLECTED</div>
                <div style="color:${colors.green}; font-size:24px; font-weight:bold;">$${totalPremium.toFixed(0)}</div>
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
        
        // Calculate totals
        const totalPremium = chainPositions.reduce((sum, p) => {
            const isDebit = p.type?.includes('long') || p.type?.includes('debit');
            const premium = p.premium * 100 * (p.contracts || 1);
            return sum + (isDebit ? -premium : premium);
        }, 0);
        
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
        
        // Get selected model
        const modelSelect = document.getElementById('aiModelSelect');
        const selectedModel = modelSelect?.value || 'qwen2.5:14b';
        
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
 * Show AI-style spread explanation modal
 */
window.showSpreadExplanation = function(posId) {
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
                    border-radius:16px; padding:30px; width:90%; max-width:600px; max-height:90vh; overflow-y:auto;
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
            
            <div style="display:flex; justify-content:center;">
                <button onclick="document.getElementById('spreadExplanationModal').remove()" 
                        style="background:${colors.purple}; border:none; color:${colors.text}; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;
                               transition: all 0.2s;">
                    Got it! 👍
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
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
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

/**
 * Check for data loss on startup
 */
function checkDataIntegrity() {
    const checkpointStr = localStorage.getItem(CHECKPOINT_KEY);
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
                <button onclick="document.getElementById('dataRecoveryBanner')?.remove(); localStorage.setItem('${CHECKPOINT_KEY}', JSON.stringify({closedPositions: ${actual}, timestamp: Date.now()}));" 
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
        const saved = localStorage.getItem(STORAGE_KEY);
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
        const savedHoldings = localStorage.getItem(HOLDINGS_KEY);
        if (savedHoldings) {
            state.holdings = JSON.parse(savedHoldings) || [];
            
            // Load positions first so we can link holdings to them
            const savedPositions = localStorage.getItem(STORAGE_KEY);
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
                localStorage.setItem(HOLDINGS_KEY, JSON.stringify(state.holdings));
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
        const savedClosed = localStorage.getItem(CLOSED_KEY);
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.positions));
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
        localStorage.setItem(HOLDINGS_KEY, JSON.stringify(state.holdings));
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
        localStorage.setItem(CLOSED_KEY, JSON.stringify(state.closedPositions));
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
 * Setup auto-save - user picks a file location
 */
export async function setupAutoSave() {
    try {
        // Check if File System Access API is supported
        if (!('showSaveFilePicker' in window)) {
            showNotification('❌ Auto-save not supported in this browser. Use Chrome or Edge.', 'error');
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
export function addPosition() {
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
            localStorage.setItem(HOLDINGS_KEY, JSON.stringify(state.holdings));
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
    const premiumReceived = pos.premium * 100 * pos.contracts;
    const closingCost = closingPrice * 100 * pos.contracts;
    const realizedPnL = premiumReceived - closingCost;
    
    const openDate = new Date(pos.openDate || today);
    const closeDate = new Date(today);
    const daysHeld = Math.max(0, Math.ceil((closeDate - openDate) / (1000 * 60 * 60 * 24)));
    
    // Close old position
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...pos,
        closeDate: today,
        daysHeld,
        closingPrice,
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
    const premiumReceived = oldPos.premium * 100 * oldPos.contracts;
    const closingCost = closePrice * 100 * oldPos.contracts;
    const realizedPnL = premiumReceived - closingCost;
    
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
    pos.realizedPnL = (pos.premium - closePrice) * 100 * pos.contracts;
    
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
        // Buy/Write specific fields
        stockPrice: pos.stockPrice || null,
        costBasis: pos.costBasis || null,
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
    
    // Update DTE for each position
    const today = new Date();
    openPositions.forEach(pos => {
        const expiryDate = new Date(pos.expiry);
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
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;">
            <thead>
                <tr style="background: #1a1a2e; color: #888;">
                    <th style="padding: 6px; text-align: left; width: 55px;">Ticker</th>
                    <th style="padding: 6px; text-align: center; width: 55px;" title="ITM probability - click to analyze">Risk</th>
                    <th style="padding: 6px; text-align: left; width: 55px;">Broker</th>
                    <th style="padding: 6px; text-align: left; width: 65px;">Type</th>
                    <th style="padding: 6px; text-align: right; width: 50px;">Strike</th>
                    <th style="padding: 6px; text-align: right; width: 40px;">Prem</th>
                    <th style="padding: 6px; text-align: right; width: 25px;">Qty</th>
                    <th style="padding: 6px; text-align: right; width: 30px;">DTE</th>
                    <th style="padding: 6px; text-align: right; width: 45px;">Credit</th>
                    <th style="padding: 6px; text-align: right; width: 40px;" title="Annualized Return on Capital">Ann%</th>
                    <th style="padding: 6px; text-align: center; width: 100px;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    openPositions.forEach(pos => {
        const urgencyInfo = getDteUrgency(pos.dte);
        const dteColor = urgencyInfo.color;
        
        // Check if this is a spread
        const isSpread = pos.type?.includes('_spread');
        
        // Calculate credit/debit (premium × 100 × contracts)
        const credit = pos.premium * 100 * pos.contracts;
        
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
        } else if (isDebitPosition(pos.type)) {
            // Long call/put: risk is what you paid
            capitalAtRisk = credit;
        } else {
            capitalAtRisk = (pos.strike || 0) * 100 * pos.contracts;
        }
        const roc = capitalAtRisk > 0 ? (credit / capitalAtRisk) * 100 : 0;
        
        // Annualized ROC: ROC × (365 / DTE)
        const annualRoc = pos.dte > 0 ? roc * (365 / pos.dte) : 0;
        
        // Color code annual ROC
        const annualRocColor = annualRoc >= 50 ? colors.green : annualRoc >= 25 ? colors.orange : colors.muted;
        
        // Check if this is a SKIP strategy
        const isSkip = pos.type === 'skip_call';
        
        // Format type for display
        let typeDisplay = pos.type.replace(/_/g, ' ').replace('short ', 'Short ').replace('long ', 'Long ');
        if (pos.type === 'buy_write') typeDisplay = 'Buy/Write';
        if (isSkip) typeDisplay = 'SKIP™';
        if (isSpread) {
            // Shorten spread names for display
            typeDisplay = pos.type.replace('_spread', '').replace('_', ' ').toUpperCase() + ' Spread';
        }
        const typeColor = pos.type === 'buy_write' ? colors.cyan : 
                         isSkip ? '#00d9ff' :  // Cyan for SKIP
                         isSpread ? colors.purple :
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
        
        html += `
            <tr style="border-bottom: 1px solid #333;${isSkip && pos.skipDte <= 60 ? ' background: rgba(255,140,0,0.15);' : ''}" title="${pos.delta ? 'Δ ' + pos.delta.toFixed(2) : ''}${pos.openDate ? ' | Opened: ' + pos.openDate : ''}${buyWriteInfo}${spreadInfo}${skipInfo}${skipDteWarning}">
                <td style="padding: 6px; font-weight: bold; color: #00d9ff;">${pos.ticker}${pos.openingThesis ? '<span style="margin-left:3px;font-size:9px;" title="Has thesis data for checkup">📋</span>' : ''}${isSkip && pos.skipDte <= 60 ? '<span style="margin-left:3px;font-size:9px;" title="' + (pos.skipDte < 45 ? 'PAST EXIT WINDOW!' : 'In 45-60 DTE exit window') + '">' + (pos.skipDte < 45 ? '🚨' : '⚠️') + '</span>' : ''}</td>
                <td style="padding: 4px; text-align: center;" id="risk-cell-${pos.id}">
                    ${initialStatusHtml}
                </td>
                <td style="padding: 6px; color: #aaa; font-size: 10px;">${pos.broker || 'Schwab'}</td>
                <td style="padding: 6px; color: ${typeColor}; font-size: 10px;">${typeDisplay}${isSkip ? '<br><span style="font-size:8px;color:#888;">LEAPS+SKIP</span>' : ''}</td>
                <td style="padding: 6px; text-align: right; ${isSpread || isSkip ? 'font-size:10px;' : ''}">${strikeDisplay}</td>
                <td style="padding: 6px; text-align: right;">${isDebitPosition(pos.type) ? '-' : ''}$${pos.premium.toFixed(2)}</td>
                <td style="padding: 6px; text-align: right;">${pos.contracts}</td>
                <td style="padding: 6px; text-align: right; color: ${dteColor}; font-weight: bold;">
                    ${isSkip ? `<span title="SKIP DTE">${pos.skipDte}d</span>` : pos.dte + 'd'}
                </td>
                <td style="padding: 6px; text-align: right; color: ${isDebitPosition(pos.type) ? '#ff5252' : '#00ff88'};">
                    ${isDebitPosition(pos.type) || isSkip ? '-' : ''}$${isSkip ? pos.totalInvestment?.toFixed(0) : credit.toFixed(0)}
                </td>
                <td style="padding: 6px; text-align: right; color: ${annualRocColor}; font-weight: bold;">
                    ${isSpread || isDebitPosition(pos.type) || isSkip ? '—' : annualRoc.toFixed(0) + '%'}
                </td>
                <td style="padding: 4px; text-align: center; white-space: nowrap;">
                    ${isSkip ? `
                    <button onclick="window.showSkipExplanation(${pos.id})" 
                            style="display:inline-block; background: rgba(0,217,255,0.3); border: 1px solid rgba(0,217,255,0.5); color: #0df; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="SKIP™ Strategy Explanation">🎯</button>
                    ` : isSpread ? `
                    <button onclick="window.showSpreadExplanation(${pos.id})" 
                            style="display:inline-block; background: rgba(139,92,246,0.3); border: 1px solid rgba(139,92,246,0.5); color: #b9f; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="AI Spread Explanation">🤖</button>
                    ` : `
                    <button onclick="window.loadPositionToAnalyze(${pos.id})" 
                            style="display:inline-block; background: rgba(0,180,220,0.3); border: 1px solid rgba(0,180,220,0.5); color: #6dd; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Analyze">📊</button>
                    `}
                    ${pos.openingThesis ? `
                    <button onclick="window.runPositionCheckup(${pos.id})" 
                            style="display:inline-block; background: rgba(0,255,136,0.3); border: 1px solid rgba(0,255,136,0.5); color: #0f8; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Thesis Checkup - Compare opening assumptions to current state">🩺</button>
                    ` : ''}
                    <button onclick="window.showClosePanel(${pos.id})" 
                            style="display:inline-block; background: rgba(80,180,80,0.3); border: 1px solid rgba(80,180,80,0.5); color: #6c6; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Close">✅</button>
                    ${pos.type.includes('put') ? `
                    <button onclick="window.assignPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(255,140,0,0.3); border: 1px solid rgba(255,140,0,0.5); color: #fa0; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Got Assigned - Take Shares">📦</button>
                    ` : ''}
                    ${pos.type.includes('call') && (state.holdings || []).some(h => h.ticker === pos.ticker) ? `
                    <button onclick="window.calledAway(${pos.id})" 
                            style="display:inline-block; background: rgba(255,215,0,0.3); border: 1px solid rgba(255,215,0,0.5); color: #fd0; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Shares Called Away">🎯</button>
                    ` : ''}
                    <button onclick="window.rollPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(140,80,160,0.3); border: 1px solid rgba(140,80,160,0.5); color: #b9b; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Roll (enter new position details)">🔄</button>
                    ${state.positions.some(p => p.id !== pos.id && p.ticker === pos.ticker) ? `
                    <button onclick="window.showMarkAsRolledModal(${pos.id})" 
                            style="display:inline-block; background: rgba(255,140,0,0.3); border: 1px solid rgba(255,140,0,0.5); color: #fa0; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Link to imported position (already rolled at broker)">🔗→</button>
                    ` : ''}
                    ${hasRollHistory(pos) ? `
                    <button onclick="window.showRollHistory(${pos.chainId || pos.id})" 
                            style="display:inline-block; background: rgba(0,150,255,0.3); border: 1px solid rgba(0,150,255,0.5); color: #6bf; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="View Roll History">🔗</button>
                    ` : ''}
                    <button onclick="window.editPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(200,160,60,0.3); border: 1px solid rgba(200,160,60,0.5); color: #db9; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Edit">✏️</button>
                    <button onclick="window.deletePosition(${pos.id})" 
                            style="display:inline-block; background: rgba(180,80,80,0.3); border: 1px solid rgba(180,80,80,0.5); color: #c88; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Delete">✕</button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
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
    
    // Update each position's risk status in the DOM
    for (const pos of openPositions) {
        const cell = document.getElementById(`risk-cell-${pos.id}`);
        if (!cell) continue;
        
        // Skip spreads - already showing static indicator
        if (pos.type?.includes('_spread')) continue;
        
        const spotPrice = spotPrices[pos.ticker];
        const risk = calculatePositionRisk(pos, spotPrice);
        
        if (risk.needsAttention) {
            // Clickable button for positions needing attention
            cell.innerHTML = `
                <button onclick="window.loadPositionToAnalyze(${pos.id}); setTimeout(() => document.getElementById('suggestRollBtn')?.click(), 500);" 
                        style="background: rgba(${risk.color === '#ff5252' ? '255,82,82' : '255,170,0'},0.2); border: 1px solid ${risk.color}; color: ${risk.color}; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px; white-space: nowrap;"
                        title="${risk.itmPct ? `${risk.itmPct.toFixed(1)}% ITM probability - Click to see roll suggestions` : 'Click to analyze'}">
                    ${risk.icon} ${risk.text}
                </button>
            `;
        } else {
            // Static indicator for healthy positions
            cell.innerHTML = `
                <span style="color: ${risk.color}; font-size: 11px;" title="${risk.itmPct ? `${risk.itmPct.toFixed(1)}% ITM probability - Looking good!` : 'Healthy position'}">
                    ${risk.icon} ${risk.text}
                </span>
            `;
        }
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
    
    const totalOpen = openPositions.length;
    const totalContracts = openPositions.reduce((sum, p) => sum + p.contracts, 0);
    
    // Net Premium: credits are positive, debits are negative
    const netPremium = openPositions.reduce((sum, p) => {
        const premiumAmount = (p.premium || 0) * 100 * p.contracts;
        return sum + (isDebitPosition(p.type) ? -premiumAmount : premiumAmount);
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
            <div class="summary-grid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px;">
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">OPEN POSITIONS</div>
                    <div style="color: #00d9ff; font-size: 24px; font-weight: bold;">${totalOpen}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">TOTAL CONTRACTS</div>
                    <div style="color: #fff; font-size: 24px; font-weight: bold;">${totalContracts}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">NET PREMIUM</div>
                    <div style="color: ${netPremium >= 0 ? '#00ff88' : '#ff5252'}; font-size: 24px; font-weight: bold;">${netPremium >= 0 ? '' : '-'}${formatCurrency(Math.abs(netPremium))}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">CAPITAL AT RISK</div>
                    <div style="color: #ffaa00; font-size: 24px; font-weight: bold;">
                        ${formatCurrency(capitalAtRisk)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">ROC</div>
                    <div style="color: ${roc >= 0 ? '#00ff88' : '#ff5252'}; font-size: 24px; font-weight: bold;" 
                         title="Return on Capital: Net Premium ÷ Capital at Risk">
                        ${roc.toFixed(2)}%
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">AVG ANN. ROC</div>
                    <div style="color: ${weightedAnnROC >= 100 ? '#00ff88' : weightedAnnROC >= 50 ? '#ffaa00' : '#ff5252'}; 
                         font-size: 24px; font-weight: bold;" 
                         title="Weighted Average Annualized Return on Capital">
                        ${weightedAnnROC.toFixed(0)}%
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