// WheelHouse - Utility Functions
// Math helpers, formatting, and common utilities

/**
 * Generate a random number from standard normal distribution
 * Uses Box-Muller transform
 */
export function randomNormal() {
    let u1 = Math.random(), u2 = Math.random();
    while (u1 === 0) u1 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Error function approximation (for Black-Scholes)
 */
export function erf(x) {
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p*x);
    const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x*x);
    return sign * y;
}

/**
 * Standard normal CDF
 */
export function normCDF(x) {
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/**
 * Standard normal PDF
 */
export function normPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate Black-Scholes Greeks for a single option
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiry in years
 * @param {number} r - Risk-free rate (default 0.05)
 * @param {number} sigma - Implied volatility (decimal, e.g. 0.30 for 30%)
 * @param {boolean} isPut - True for put, false for call
 * @param {number} contracts - Number of contracts (default 1)
 * @returns {Object} { delta, gamma, theta, vega, rho }
 */
export function calculateGreeks(S, K, T, r = 0.05, sigma, isPut = true, contracts = 1) {
    // Handle edge cases
    if (T <= 0.001 || sigma <= 0 || S <= 0 || K <= 0) {
        // At expiration - return intrinsic delta
        const intrinsicDelta = isPut ? (S < K ? -1 : 0) : (S > K ? 1 : 0);
        return {
            delta: intrinsicDelta * contracts * 100,
            gamma: 0,
            theta: 0,
            vega: 0,
            rho: 0
        };
    }
    
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    
    const Nd1 = normCDF(d1);
    const Nd2 = normCDF(d2);
    const nd1 = normPDF(d1);
    
    // Greeks per share
    let delta, theta;
    
    if (isPut) {
        delta = Nd1 - 1;  // Put delta is negative
        theta = (-S * nd1 * sigma / (2 * sqrtT)) + (r * K * Math.exp(-r * T) * (1 - Nd2));
    } else {
        delta = Nd1;  // Call delta is positive
        theta = (-S * nd1 * sigma / (2 * sqrtT)) - (r * K * Math.exp(-r * T) * Nd2);
    }
    
    // Gamma and Vega are same for calls and puts
    const gamma = nd1 / (S * sigma * sqrtT);
    const vega = S * nd1 * sqrtT / 100;  // Per 1% change in IV
    
    // Rho (per 1% change in rate)
    const rho = isPut ? 
        -K * T * Math.exp(-r * T) * (1 - Nd2) / 100 :
        K * T * Math.exp(-r * T) * Nd2 / 100;
    
    // Scale by contracts (100 shares per contract)
    const multiplier = contracts * 100;
    
    // Theta is typically shown as daily decay (divide annual by 365)
    return {
        delta: delta * multiplier,
        gamma: gamma * multiplier,
        theta: (theta / 365) * multiplier,  // Daily theta in $
        vega: vega * multiplier,             // $ change per 1% IV move
        rho: rho * multiplier
    };
}

/**
 * Calculate portfolio-level Greeks by summing across all positions
 * @param {Array} positions - Array of position objects
 * @param {Object} spotPrices - Map of ticker -> current price
 * @param {Object} ivData - Map of ticker -> IV (decimal)
 * @returns {Object} { delta, gamma, theta, vega, positionGreeks }
 */
export function calculatePortfolioGreeks(positions, spotPrices = {}, ivData = {}) {
    let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0;
    const positionGreeks = [];
    
    for (const pos of positions) {
        if (pos.status === 'closed') continue;
        
        const spot = spotPrices[pos.ticker] || pos.currentSpot || pos.stockPrice || 100;
        const iv = ivData[pos.ticker] || pos.iv || 0.30;  // Default 30% IV
        const strike = pos.strike || 0;
        const contracts = pos.contracts || 1;
        const isPut = pos.type?.includes('put');
        const isShort = pos.type?.includes('short') || pos.type === 'covered_call';
        
        // Days to expiry
        const expiry = new Date(pos.expiry);
        const now = new Date();
        const dte = Math.max(0, (expiry - now) / (1000 * 60 * 60 * 24));
        const T = dte / 365;
        
        const greeks = calculateGreeks(spot, strike, T, 0.05, iv, isPut, contracts);
        
        // If short, Greeks are inverted
        const sign = isShort ? -1 : 1;
        
        const posGreeks = {
            id: pos.id,
            ticker: pos.ticker,
            strike: strike,
            expiry: pos.expiry,
            type: pos.type,
            contracts: contracts,
            dte: Math.round(dte),
            spot: spot,
            iv: iv,
            delta: greeks.delta * sign,
            gamma: greeks.gamma * sign,
            theta: greeks.theta * sign,  // Short positions have positive theta (collect premium)
            vega: greeks.vega * sign
        };
        
        positionGreeks.push(posGreeks);
        
        totalDelta += posGreeks.delta;
        totalGamma += posGreeks.gamma;
        totalTheta += posGreeks.theta;
        totalVega += posGreeks.vega;
    }
    
    return {
        delta: totalDelta,
        gamma: totalGamma,
        theta: totalTheta,
        vega: totalVega,
        positionGreeks
    };
}

/**
 * Download helper for exporting data
 */
export function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Format currency
 */
export function formatCurrency(value, decimals = 2) {
    return '$' + value.toFixed(decimals);
}

/**
 * Format percentage
 */
export function formatPercent(value, decimals = 1) {
    return value.toFixed(decimals) + '%';
}

/**
 * Calculate days between two dates
 */
export function daysBetween(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    d1.setHours(0, 0, 0, 0);
    d2.setHours(0, 0, 0, 0);
    return Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
}

/**
 * Clamp a value between min and max
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Show a notification toast
 * @param {string} message - The message to display
 * @param {string} type - 'success', 'warning', 'error', or 'info'
 * @param {number} duration - How long to show (default 4000ms)
 */
export function showNotification(message, type = 'success', duration = 4000) {
    // If type is a number, it's actually duration (old API compatibility)
    if (typeof type === 'number') {
        duration = type;
        type = 'success';
    }
    
    // Color schemes based on type
    const colors = {
        success: { bg: '#00ff88', text: '#1a1a2e', shadow: 'rgba(0,255,136,0.4)' },
        warning: { bg: '#ffaa00', text: '#1a1a2e', shadow: 'rgba(255,170,0,0.4)' },
        error:   { bg: '#ff5252', text: '#fff', shadow: 'rgba(255,82,82,0.4)' },
        info:    { bg: '#00d9ff', text: '#1a1a2e', shadow: 'rgba(0,217,255,0.4)' }
    };
    const c = colors[type] || colors.success;
    
    const notification = document.createElement('div');
    notification.style.cssText = `position:fixed;top:20px;right:20px;background:${c.bg};color:${c.text};padding:15px 20px;border-radius:8px;font-weight:bold;z-index:9999;box-shadow:0 4px 12px ${c.shadow};max-width:400px;word-wrap:break-word;`;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), duration);
}

/**
 * Show notification with Undo button
 */
export function showUndoNotification(message, type = 'warning') {
    // Remove any existing undo notification
    const existing = document.getElementById('undoNotification');
    if (existing) existing.remove();
    
    const colors = {
        success: { bg: '#00ff88', text: '#1a1a2e' },
        warning: { bg: '#ffaa00', text: '#1a1a2e' },
        error:   { bg: '#ff5252', text: '#fff' },
        info:    { bg: '#00d9ff', text: '#1a1a2e' }
    };
    const c = colors[type] || colors.warning;
    
    const notification = document.createElement('div');
    notification.id = 'undoNotification';
    notification.style.cssText = `position:fixed;top:20px;right:20px;background:${c.bg};color:${c.text};padding:15px 20px;border-radius:8px;font-weight:bold;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;align-items:center;gap:15px;`;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    
    const undoBtn = document.createElement('button');
    undoBtn.textContent = '↩ Undo';
    undoBtn.style.cssText = `background:#1a1a2e;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;`;
    undoBtn.onclick = () => {
        if (window.undoLastAction) window.undoLastAction();
        notification.remove();
    };
    
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '✕';
    dismissBtn.style.cssText = `background:transparent;color:${c.text};border:none;padding:4px 8px;cursor:pointer;font-size:16px;opacity:0.7;`;
    dismissBtn.onclick = () => notification.remove();
    
    notification.appendChild(textSpan);
    notification.appendChild(undoBtn);
    notification.appendChild(dismissBtn);
    document.body.appendChild(notification);
    
    // Auto-dismiss after 10 seconds
    setTimeout(() => notification.remove(), 10000);
}

/**
 * Get urgency color based on DTE
 */
export function getDteUrgency(dte) {
    if (dte <= 5) return { color: '#ff5252', text: 'EXPIRES THIS WEEK!' };
    if (dte <= 14) return { color: '#ffaa00', text: 'expiring soon' };
    if (dte <= 30) return { color: '#00d9ff', text: 'moderate timeframe' };
    return { color: '#00ff88', text: 'plenty of time' };
}

/**
 * Format date for display
 */
export function formatDate(date) {
    return new Date(date).toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric', 
        year: 'numeric' 
    });
}

// ============================================================
// POSITION UTILITIES (DRY - used across multiple files)
// ============================================================

/**
 * Check if a position type is a debit (you pay premium)
 * Debit positions: long_call, long_put, long_call_leaps, debit spreads, skip_call
 * Credit positions: short_call, short_put, covered_call, buy_write, credit spreads
 */
export function isDebitPosition(type) {
    if (!type) return false;
    return type.includes('debit') || type === 'long_call' || type === 'long_put' || type === 'long_call_leaps' || type === 'skip_call';
}

/**
 * Calculate position credit/debit amount
 * @param {object} pos - Position object with premium, contracts
 * @returns {number} - Positive for credit, negative for debit
 */
export function calculatePositionCredit(pos) {
    if (!pos) return 0;
    const premium = (pos.premium || 0) * 100 * (pos.contracts || 1);
    return isDebitPosition(pos.type) ? -premium : premium;
}

/**
 * Calculate realized P&L when closing a position
 * Handles both credit positions (short options) and debit positions (long options)
 * 
 * Credit positions: premium received - close price paid = profit if positive
 * Debit positions: close price received - premium paid = profit if positive
 * 
 * @param {object} pos - Position object with type, premium, contracts
 * @param {number} closePrice - Price per share to close the position
 * @returns {number} - Realized P&L (positive = profit, negative = loss)
 */
export function calculateRealizedPnL(pos, closePrice) {
    if (!pos) return 0;
    const premium = (pos.premium || 0);
    const contracts = (pos.contracts || 1);
    const multiplier = 100 * contracts;
    
    if (isDebitPosition(pos.type)) {
        // Debit position: you paid premium, now selling at closePrice
        // Profit = (what you got - what you paid) × multiplier
        return (closePrice - premium) * multiplier;
    } else {
        // Credit position: you received premium, now buying back at closePrice
        // Profit = (what you got - what you paid) × multiplier
        return (premium - closePrice) * multiplier;
    }
}

/**
 * Calculate chain net credit (for rolled positions)
 * @param {object} pos - Any position in the chain
 * @param {array} allPositions - All positions (open + closed)
 * @returns {object} - { netCredit, totalReceived, totalBuybacks, hasRolls, chainPositions }
 */
export function getChainNetCredit(pos, allPositions) {
    const chainId = pos.chainId || pos.id;
    const chainPositions = allPositions.filter(p => (p.chainId || p.id) === chainId);
    
    let totalReceived = 0;
    let totalBuybacks = 0;
    
    chainPositions.forEach(p => {
        const premium = (p.premium || 0) * 100 * (p.contracts || 1);
        
        if (isDebitPosition(p.type)) {
            totalBuybacks += premium;
        } else {
            totalReceived += premium;
        }
        
        // Add buyback cost for rolled positions
        if (p.closeReason === 'rolled' && p.closePrice) {
            totalBuybacks += p.closePrice * 100 * (p.contracts || 1);
        }
    });
    
    return {
        netCredit: totalReceived - totalBuybacks,
        totalReceived,
        totalBuybacks,
        hasRolls: chainPositions.length > 1,
        chainPositions
    };
}

/**
 * Check if a position has roll history
 */
export function hasRollHistory(pos, allPositions) {
    const chainId = pos.chainId || pos.id;
    return allPositions.filter(p => (p.chainId || p.id) === chainId).length > 1;
}

// ============================================================
// MODAL UTILITIES (DRY - 33 modals use similar patterns)
// ============================================================

/**
 * Standard color scheme for the app
 */
export const colors = {
    green: '#00ff88',
    red: '#ff5252',
    orange: '#ffaa00',
    cyan: '#00d9ff',
    purple: '#8b5cf6',
    muted: '#888',
    bg: '#1a1a2e',
    bgDark: '#0d0d1a',
    border: '#333'
};

/**
 * Create a modal overlay with standard styling
 * @param {string} id - Modal element ID
 * @param {string} content - Inner HTML content
 * @param {object} options - { width, onClose }
 * @returns {HTMLElement} - The modal element (already appended to body)
 */
export function createModal(id, content, options = {}) {
    const { width = '600px', onClose } = options;
    
    // Remove existing modal with same ID
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    
    const modal = document.createElement('div');
    modal.id = id;
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.85); display: flex; align-items: center;
        justify-content: center; z-index: 10000;
    `;
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.remove();
            if (onClose) onClose();
        }
    };
    
    modal.innerHTML = `
        <div style="background: ${colors.bgDark}; border: 1px solid ${colors.border}; 
                    border-radius: 12px; padding: 24px; max-width: ${width}; 
                    width: 90%; max-height: 85vh; overflow-y: auto; color: #fff;">
            ${content}
        </div>
    `;
    
    document.body.appendChild(modal);
    return modal;
}

/**
 * Create modal header with title and close button
 */
export function modalHeader(title, icon = '') {
    return `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid ${colors.border}; padding-bottom: 12px;">
            <h2 style="margin: 0; color: ${colors.cyan};">${icon} ${title}</h2>
            <button onclick="this.closest('[id]').remove()" 
                    style="background: none; border: none; color: ${colors.muted}; font-size: 24px; cursor: pointer;">&times;</button>
        </div>
    `;
}
