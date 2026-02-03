/**
 * Centralized formatting utilities for consistent display across the app
 * All P/L, price, and percentage formatting should use these functions
 */

/**
 * Format P/L percentage with sign and 1 decimal place
 * @param {number} pct - Percentage value
 * @returns {string} Formatted string like "+39.2%" or "-12.5%"
 */
export function formatPnLPercent(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return '—';
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Format P/L dollar amount with sign and 2 decimal places
 * @param {number} pnl - Dollar amount
 * @returns {string} Formatted string like "+$127.50" or "-$45.00"
 */
export function formatPnLDollar(pnl) {
    if (pnl === null || pnl === undefined || isNaN(pnl)) return '—';
    const sign = pnl >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(pnl).toFixed(2)}`;
}

/**
 * Format price with 2 decimal places
 * @param {number} price - Price value
 * @returns {string} Formatted string like "$127.50"
 */
export function formatPrice(price) {
    if (price === null || price === undefined || isNaN(price)) return '—';
    return `$${price.toFixed(2)}`;
}

/**
 * Format price change with sign and 2 decimal places
 * @param {number} change - Price change value
 * @returns {string} Formatted string like "+$1.25" or "-$0.50"
 */
export function formatPriceChange(change) {
    if (change === null || change === undefined || isNaN(change)) return '—';
    const sign = change >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(change).toFixed(2)}`;
}

/**
 * Format percentage change with sign and 2 decimal places
 * @param {number} pct - Percentage value
 * @returns {string} Formatted string like "+1.25%" or "-0.50%"
 */
export function formatPercentChange(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return '—';
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Format whole dollar amount (no decimals) with sign
 * @param {number} amount - Dollar amount
 * @returns {string} Formatted string like "+$128" or "-$45"
 */
export function formatWholeDollar(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '—';
    const sign = amount >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(amount).toFixed(0)}`;
}

/**
 * Format credit/debit amount (always positive display, context determines meaning)
 * @param {number} amount - Dollar amount
 * @returns {string} Formatted string like "$127.50"
 */
export function formatCredit(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) return '—';
    return `$${Math.abs(amount).toFixed(0)}`;
}

/**
 * Get P/L color based on value
 * @param {number} pnl - P/L value
 * @param {number} threshold - Optional threshold for special color (default 50 for cyan glow)
 * @returns {string} CSS color value
 */
export function getPnLColor(pnl, threshold = 50) {
    if (pnl >= threshold) return '#00d9ff';  // Cyan for big wins
    if (pnl >= 0) return '#00ff88';          // Green for profit
    return '#ff5252';                         // Red for loss
}

/**
 * Get P/L style (for glow effect on big wins)
 * @param {number} pnl - P/L value
 * @param {number} threshold - Threshold for glow effect
 * @returns {string} CSS style string
 */
export function getPnLStyle(pnl, threshold = 50) {
    if (pnl >= threshold) return 'text-shadow:0 0 4px #00d9ff;';
    return '';
}

/**
 * Format P/L percent with full styling (checkmark, color, glow)
 * @param {number} pct - Percentage value
 * @returns {object} { text, color, style, checkmark }
 */
export function formatPnLPercentStyled(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) {
        return { text: '—', color: '#666', style: '', checkmark: '' };
    }
    return {
        text: formatPnLPercent(pct),
        color: getPnLColor(pct),
        style: getPnLStyle(pct),
        checkmark: pct >= 50 ? '✓' : ''
    };
}
