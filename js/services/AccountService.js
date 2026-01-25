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
const CACHE_TTL = 60000; // 1 minute cache

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
        try {
            const res = await fetch('/api/schwab/accounts');
            if (!res.ok) {
                console.log('[AccountService] Schwab not connected');
                return null;
            }
            
            const accounts = await res.json();
            
            // Find margin account or highest equity account
            let account = accounts.find(a => a.securitiesAccount?.type === 'MARGIN');
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
            
            this.updateCache({
                buyingPower: bal.buyingPower,
                accountValue: bal.equity || bal.liquidationValue,
                cashAvailable: bal.availableFunds || bal.cashBalance,
                marginUsed: bal.marginBalance,
                dayTradeBP: bal.dayTradingBuyingPower,
                accountType: acct.type,
                accountNumber: acct.accountNumber
            });
            
            return balanceCache;
            
        } catch (e) {
            console.error('[AccountService] Refresh failed:', e.message);
            return null;
        }
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
