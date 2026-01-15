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
