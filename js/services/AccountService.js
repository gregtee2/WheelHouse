/**
 * AccountService - Single source of truth for Schwab account balances
 * 
 * USAGE:
 *   import AccountService from './services/AccountService.js';
 * 
 *   // Get cached balances (returns null if not loaded yet)
 *   const balances = AccountService.getBalances();
 *   // { buyingPower, accountValue, cashAvailable, marginUsed, dayTradeBP, accountType, accountNumber, lastUpdated }
 * 
 *   // Get just buying power (with fallback)
 *   const bp = AccountService.getBuyingPower() || 25000;
 * 
 *   // Force refresh from Schwab
 *   await AccountService.refresh();
 */

// Cache of account balances
let balanceCache = null;
let lastFetchTime = 0;
let lastErrorTime = 0;  // Track when we last got an error
let errorCount = 0;     // Track consecutive errors for backoff
let refreshInProgress = false; // Prevent concurrent refresh calls
const CACHE_TTL = 60000; // 1 minute cache
const MIN_REFRESH_INTERVAL = 10000; // At least 10 seconds between refreshes
const ERROR_BACKOFF_BASE = 30000; // Base backoff on error (30 sec)
const MAX_BACKOFF = 300000; // Max backoff 5 minutes

const AccountService = {
    
    /**
     * Get cached account balances
     * @returns {Object|null} Balances object or null if not loaded
     */
    getBalances() {
        return balanceCache;
    },
    
    /**
     * Get just buying power (most common use case)
     * @returns {number|null} Buying power or null
     */
    getBuyingPower() {
        return balanceCache?.buyingPower || null;
    },
    
    /**
     * Get account value (equity/liquidation value)
     * @returns {number|null}
     */
    getAccountValue() {
        return balanceCache?.accountValue || null;
    },
    
    /**
     * Get cash available for trading
     * @returns {number|null}
     */
    getCashAvailable() {
        return balanceCache?.cashAvailable || null;
    },
    
    /**
     * Check if balances are stale (older than TTL)
     * @returns {boolean}
     */
    isStale() {
        return Date.now() - lastFetchTime > CACHE_TTL;
    },
    
    /**
     * Update the cache (called by Portfolio when it fetches balances)
     * @param {Object} balances - The balance data to cache
     */
    updateCache(balances) {
        balanceCache = {
            buyingPower: balances.buyingPower || 0,
            accountValue: balances.accountValue || balances.equity || balances.liquidationValue || 0,
            cashAvailable: balances.cashAvailable || balances.availableFunds || balances.cashBalance || 0,
            marginUsed: balances.marginUsed || balances.marginBalance || 0,
            dayTradeBP: balances.dayTradeBP || balances.dayTradingBuyingPower || 0,
            accountType: balances.accountType || 'Unknown',
            accountNumber: balances.accountNumber || null,
            lastUpdated: new Date()
        };
        lastFetchTime = Date.now();
        
        console.log('[AccountService] Cache updated:', {
            buyingPower: balanceCache.buyingPower,
            accountValue: balanceCache.accountValue,
            account: balanceCache.accountNumber?.slice(-4)
        });
    },
    
    /**
     * Fetch fresh balances from Schwab (use sparingly - prefer getBalances())
     * @returns {Promise<Object|null>}
     */
    async refresh() {
        // Prevent concurrent refresh calls
        if (refreshInProgress) {
            console.log('[AccountService] Refresh already in progress, skipping');
            return null;
        }
        
        // Rate limiting: check minimum interval
        const now = Date.now();
        const timeSinceLastFetch = now - lastFetchTime;
        if (timeSinceLastFetch < MIN_REFRESH_INTERVAL) {
            console.log(`[AccountService] Rate limited - wait ${Math.ceil((MIN_REFRESH_INTERVAL - timeSinceLastFetch) / 1000)}s`);
            return null;
        }
        
        // Exponential backoff after errors
        if (errorCount > 0) {
            const backoffTime = Math.min(ERROR_BACKOFF_BASE * Math.pow(2, errorCount - 1), MAX_BACKOFF);
            const timeSinceError = now - lastErrorTime;
            if (timeSinceError < backoffTime) {
                console.log(`[AccountService] In error backoff - wait ${Math.ceil((backoffTime - timeSinceError) / 1000)}s`);
                return null;
            }
        }
        
        refreshInProgress = true;
        lastFetchTime = now;
        
        try {
            const res = await fetch('/api/schwab/accounts');
            if (!res.ok) {
                errorCount++;
                lastErrorTime = now;
                refreshInProgress = false;
                console.log(`[AccountService] Schwab error (${res.status}), backoff ${errorCount}`);
                return null;
            }
            
            // Success - reset error count
            errorCount = 0;
            
            const accounts = await res.json();
            
            // IMPORTANT: Use the selected account from state, not just any margin account
            // This ensures the leverage gauge shows data for the account the user is viewing
            let account = null;
            
            // 1. First try to match selectedAccount from state
            if (window.state?.selectedAccount?.accountNumber) {
                const selectedId = window.state.selectedAccount.accountNumber;
                account = accounts.find(a => {
                    const acctNum = a.securitiesAccount?.accountNumber;
                    if (!acctNum) return false;
                    // Match by full account ID or partial (last 4 digits)
                    return acctNum === selectedId || 
                           selectedId.includes(acctNum) || 
                           acctNum.endsWith(selectedId.replace(/\D/g, '').slice(-4));
                });
                if (account) {
                    const bal = account.securitiesAccount?.currentBalances;
                    console.log('[AccountService] Using selected account:', selectedId, 
                        '| equity:', bal?.equity || bal?.liquidationValue);
                }
            }
            
            // 2. Fall back to margin account with highest equity, or any account with highest equity
            if (!account) {
                const marginAccounts = accounts.filter(a => a.securitiesAccount?.type === 'MARGIN');
                if (marginAccounts.length > 0) {
                    // Pick the margin account with highest equity
                    account = marginAccounts.sort((a, b) => {
                        const eqA = a.securitiesAccount?.currentBalances?.equity || a.securitiesAccount?.currentBalances?.liquidationValue || 0;
                        const eqB = b.securitiesAccount?.currentBalances?.equity || b.securitiesAccount?.currentBalances?.liquidationValue || 0;
                        return eqB - eqA;
                    })[0];
                    console.log('[AccountService] Using MARGIN account with highest equity:', account.securitiesAccount?.accountNumber?.slice(-4));
                }
            }
            if (!account) {
                account = accounts
                    .filter(a => a.securitiesAccount?.currentBalances)
                    .sort((a, b) => {
                        const eqA = a.securitiesAccount?.currentBalances?.equity || 0;
                        const eqB = b.securitiesAccount?.currentBalances?.equity || 0;
                        return eqB - eqA;
                    })[0];
            }
            
            if (!account?.securitiesAccount?.currentBalances) {
                console.log('[AccountService] No balance data');
                return null;
            }
            
            const bal = account.securitiesAccount.currentBalances;
            const acct = account.securitiesAccount;
            
            // Prefer liquidationValue (Net Liquidating Value) over equity for accurate leverage calc
            this.updateCache({
                buyingPower: bal.buyingPower,
                accountValue: bal.liquidationValue || bal.equity,
                cashAvailable: bal.availableFunds || bal.cashBalance,
                marginUsed: bal.marginBalance,
                dayTradeBP: bal.dayTradingBuyingPower,
                accountType: acct.type,
                accountNumber: acct.accountNumber
            });
            
            return balanceCache;
            
        } catch (e) {
            errorCount++;
            lastErrorTime = Date.now();
            console.error('[AccountService] Refresh failed:', e.message);
            return null;
        } finally {
            refreshInProgress = false;
        }
    },
    
    /**
     * Get current rate limit status (for debugging)
     */
    getRateLimitStatus() {
        const now = Date.now();
        return {
            errorCount,
            inBackoff: errorCount > 0,
            backoffRemaining: errorCount > 0 ? 
                Math.max(0, Math.min(ERROR_BACKOFF_BASE * Math.pow(2, errorCount - 1), MAX_BACKOFF) - (now - lastErrorTime)) : 0,
            canRefresh: !refreshInProgress && 
                        (now - lastFetchTime >= MIN_REFRESH_INTERVAL) &&
                        (errorCount === 0 || now - lastErrorTime >= Math.min(ERROR_BACKOFF_BASE * Math.pow(2, errorCount - 1), MAX_BACKOFF))
        };
    },
    
    /**
     * Reset error state (call after user re-authenticates)
     */
    resetErrors() {
        errorCount = 0;
        lastErrorTime = 0;
        console.log('[AccountService] Error state reset');
    },
    
    /**
     * Clear the cache (for logout, etc.)
     */
    clear() {
        balanceCache = null;
        lastFetchTime = 0;
    }
};

// Make available globally for non-module scripts
window.AccountService = AccountService;

export default AccountService;
