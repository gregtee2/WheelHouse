/**
 * CacheService - Centralized caching for market data
 * Ensures consistent pricing across AI features
 */

// Cache storage
const tickerDataCache = new Map();  // ticker → { data, timestamp }
const optionPremiumCache = new Map();  // "TICKER|STRIKE|EXPIRY|TYPE" → { data, timestamp }

// Cache TTL (Time To Live)
const CACHE_TTL = 60000;  // 60 seconds - short enough to stay fresh, long enough for consistency

/**
 * Generate cache key for option premium
 * @param {string} ticker 
 * @param {number} strike 
 * @param {string} expiry 
 * @param {string} optionType 
 * @returns {string}
 */
function getCacheKey(ticker, strike, expiry, optionType) {
    return `${ticker}|${strike}|${expiry}|${optionType}`;
}

/**
 * Log cache action (for debugging)
 * @param {string} action - HIT, MISS, SET
 * @param {string} key - Cache key
 * @param {number} ageMs - Age in milliseconds (optional)
 */
function logCache(action, key, ageMs = null) {
    if (ageMs !== null) {
        console.log(`[CACHE] ${action}: ${key} (${Math.round(ageMs/1000)}s old)`);
    } else {
        console.log(`[CACHE] ${action}: ${key}`);
    }
}

// ============================================================================
// TICKER DATA CACHE
// ============================================================================

/**
 * Get cached ticker data
 * @param {string} ticker 
 * @returns {Object|null} Cached data or null if expired/missing
 */
function getTickerData(ticker) {
    const cached = tickerDataCache.get(ticker);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) {
        tickerDataCache.delete(ticker);
        return null;
    }
    
    logCache('HIT', ticker, age);
    return cached.data;
}

/**
 * Set ticker data in cache
 * @param {string} ticker 
 * @param {Object} data 
 */
function setTickerData(ticker, data) {
    tickerDataCache.set(ticker, { data, timestamp: Date.now() });
    logCache('SET', ticker);
}

// ============================================================================
// OPTION PREMIUM CACHE
// ============================================================================

/**
 * Get cached option premium
 * @param {string} ticker 
 * @param {number} strike 
 * @param {string} expiry 
 * @param {string} optionType 
 * @returns {Object|null} Cached data or null if expired/missing
 */
function getOptionPremium(ticker, strike, expiry, optionType) {
    const key = getCacheKey(ticker, strike, expiry, optionType);
    const cached = optionPremiumCache.get(key);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL) {
        optionPremiumCache.delete(key);
        return null;
    }
    
    logCache('HIT', key, age);
    return cached.data;
}

/**
 * Set option premium in cache
 * @param {string} ticker 
 * @param {number} strike 
 * @param {string} expiry 
 * @param {string} optionType 
 * @param {Object} data 
 */
function setOptionPremium(ticker, strike, expiry, optionType, data) {
    const key = getCacheKey(ticker, strike, expiry, optionType);
    optionPremiumCache.set(key, { data, timestamp: Date.now() });
    logCache('SET', key);
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/**
 * Clear all caches
 */
function clearAll() {
    tickerDataCache.clear();
    optionPremiumCache.clear();
    console.log('[CACHE] All caches cleared');
}

/**
 * Get cache statistics
 * @returns {Object}
 */
function getStats() {
    return {
        tickerCount: tickerDataCache.size,
        optionCount: optionPremiumCache.size,
        ttlSeconds: CACHE_TTL / 1000
    };
}

module.exports = {
    // Ticker data
    getTickerData,
    setTickerData,
    
    // Option premium
    getOptionPremium,
    setOptionPremium,
    getCacheKey,
    
    // Utility
    logCache,
    
    // Management
    clearAll,
    getStats,
    
    // Constants
    CACHE_TTL,
    
    // Direct access for legacy code (server.js backward compatibility)
    tickerDataCache,
    optionPremiumCache,
    _tickerDataCache: tickerDataCache,
    _optionPremiumCache: optionPremiumCache
};
