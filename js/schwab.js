// WheelHouse - Schwab API Client (Frontend)
// Handles communication with backend Schwab proxy

const SchwabAPI = {
    // Base URL for Schwab API routes
    baseUrl: '/api/schwab',
    
    // Cached account hash
    _accountHash: null,
    
    // ============================================================
    // STATUS & AUTH
    // ============================================================
    
    /**
     * Check Schwab connection status
     */
    async getStatus() {
        const res = await fetch(`${this.baseUrl}/status`);
        return res.json();
    },
    
    /**
     * Get OAuth authorization URL
     */
    async getAuthorizeUrl() {
        const res = await fetch(`${this.baseUrl}/authorize-url`);
        return res.json();
    },
    
    /**
     * Complete OAuth flow with redirect URL
     */
    async completeOAuth(redirectUrl) {
        const res = await fetch(`${this.baseUrl}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ redirectUrl })
        });
        return res.json();
    },
    
    /**
     * Save Schwab credentials
     */
    async saveCredentials(appKey, appSecret, callbackUrl) {
        const res = await fetch(`${this.baseUrl}/credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appKey, appSecret, callbackUrl })
        });
        return res.json();
    },
    
    // ============================================================
    // ACCOUNTS
    // ============================================================
    
    /**
     * Get account numbers and hashes
     */
    async getAccountNumbers() {
        const res = await fetch(`${this.baseUrl}/accounts/numbers`);
        return res.json();
    },
    
    /**
     * Get primary account hash (cached)
     */
    async getAccountHash() {
        if (this._accountHash) return this._accountHash;
        
        const accounts = await this.getAccountNumbers();
        if (accounts && accounts.length > 0) {
            this._accountHash = accounts[0].hashValue;
            return this._accountHash;
        }
        throw new Error('No Schwab accounts found');
    },
    
    /**
     * Get all accounts with balances and positions
     */
    async getAccounts(fields = 'positions') {
        const res = await fetch(`${this.baseUrl}/accounts?fields=${fields}`);
        return res.json();
    },
    
    /**
     * Get specific account details
     */
    async getAccount(accountHash, fields = 'positions') {
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}?fields=${fields}`);
        return res.json();
    },
    
    /**
     * Get account balances
     */
    async getBalances() {
        const accounts = await this.getAccounts('positions');
        if (!accounts || accounts.length === 0) return null;
        
        const acct = accounts[0].securitiesAccount;
        return {
            accountNumber: acct.accountNumber,
            type: acct.type,
            cashBalance: acct.currentBalances?.cashBalance || 0,
            buyingPower: acct.currentBalances?.buyingPower || 0,
            liquidationValue: acct.currentBalances?.liquidationValue || 0,
            equity: acct.currentBalances?.equity || 0,
            longMarketValue: acct.currentBalances?.longMarketValue || 0,
            shortMarketValue: acct.currentBalances?.shortMarketValue || 0
        };
    },
    
    /**
     * Get positions from Schwab account
     * @param {string} accountHash - Optional account hash. If not provided, uses first account.
     */
    async getPositions(accountHash = null) {
        if (accountHash) {
            // Get specific account
            const account = await this.getAccount(accountHash, 'positions');
            if (!account || !account.securitiesAccount) return [];
            const positions = account.securitiesAccount.positions || [];
            return positions.map(pos => this._normalizePosition(pos));
        }
        
        // Default: use first account
        const accounts = await this.getAccounts('positions');
        if (!accounts || accounts.length === 0) return [];
        
        const positions = accounts[0].securitiesAccount?.positions || [];
        return positions.map(pos => this._normalizePosition(pos));
    },
    
    /**
     * Normalize Schwab position to WheelHouse format
     */
    _normalizePosition(pos) {
        const inst = pos.instrument || {};
        const isOption = inst.assetType === 'OPTION';
        
        if (isOption) {
            // Parse option symbol: "SLV   260123C00085500"
            // Format: SYMBOL (padded to 6 chars) + YYMMDD + P/C + strike*1000 (8 digits)
            const symbol = inst.symbol || '';
            const underlying = inst.underlyingSymbol || symbol.slice(0, 6).trim();
            const putCall = inst.putCall || (symbol.includes('P') ? 'PUT' : 'CALL');
            
            // Parse expiration date from symbol
            // Find the date portion - it's 6 digits after the ticker padding
            const match = symbol.match(/([A-Z]+)\s*(\d{6})([PC])(\d{8})/);
            let expiry = '';
            let strike = inst.strikePrice || 0;
            
            if (match) {
                const dateStr = match[2]; // YYMMDD
                const year = '20' + dateStr.slice(0, 2);
                const month = dateStr.slice(2, 4);
                const day = dateStr.slice(4, 6);
                expiry = `${year}-${month}-${day}`;
                
                // Also parse strike from symbol if not provided
                if (!strike) {
                    strike = parseInt(match[4]) / 1000;
                }
            }
            
            return {
                source: 'schwab',
                type: putCall === 'PUT' ? 'short_put' : 'covered_call',
                ticker: underlying,
                strike: strike,
                expiry: expiry,
                contracts: Math.abs(pos.shortQuantity || pos.longQuantity || 0),
                isShort: (pos.shortQuantity || 0) > 0,
                averagePrice: pos.averagePrice || 0,
                marketValue: pos.marketValue || 0,
                currentPrice: pos.currentDayProfitLoss ? 
                    (pos.marketValue / (Math.abs(pos.shortQuantity || pos.longQuantity) * 100)) : 
                    pos.averagePrice,
                dayPnL: pos.currentDayProfitLoss || 0,
                totalPnL: pos.currentDayProfitLoss || 0, // Schwab doesn't give total P&L directly
                symbol: inst.symbol,
                cusip: inst.cusip
            };
        } else {
            // Stock position
            return {
                source: 'schwab',
                type: 'stock',
                ticker: inst.symbol,
                shares: pos.longQuantity || pos.shortQuantity || 0,
                averagePrice: pos.averagePrice || 0,
                marketValue: pos.marketValue || 0,
                currentPrice: pos.marketValue / (pos.longQuantity || pos.shortQuantity || 1),
                dayPnL: pos.currentDayProfitLoss || 0,
                cusip: inst.cusip
            };
        }
    },
    
    // ============================================================
    // MARKET DATA
    // ============================================================
    
    /**
     * Get real-time quote for a symbol
     */
    async getQuote(symbol) {
        const res = await fetch(`${this.baseUrl}/quote/${symbol}`);
        const data = await res.json();
        
        // Normalize to simple format
        const quote = data[symbol]?.quote || data;
        return {
            symbol,
            price: quote.lastPrice || quote.mark || 0,
            bid: quote.bidPrice || 0,
            ask: quote.askPrice || 0,
            high: quote.highPrice || 0,
            low: quote.lowPrice || 0,
            volume: quote.totalVolume || 0,
            change: quote.netChange || 0,
            changePercent: quote.netPercentChange || 0,
            lastTradeTime: quote.quoteTime || Date.now()
        };
    },
    
    /**
     * Get multiple quotes at once
     */
    async getQuotes(symbols) {
        const symbolList = Array.isArray(symbols) ? symbols.join(',') : symbols;
        const res = await fetch(`${this.baseUrl}/quotes?symbols=${symbolList}`);
        const data = await res.json();
        
        const result = {};
        for (const [sym, info] of Object.entries(data)) {
            const quote = info.quote || info;
            result[sym] = {
                symbol: sym,
                price: quote.lastPrice || quote.mark || 0,
                bid: quote.bidPrice || 0,
                ask: quote.askPrice || 0,
                change: quote.netChange || 0,
                changePercent: quote.netPercentChange || 0,
                volume: quote.totalVolume || 0
            };
        }
        return result;
    },
    
    /**
     * Get options chain for a symbol
     */
    async getOptionsChain(symbol, options = {}) {
        const params = new URLSearchParams();
        Object.entries(options).forEach(([k, v]) => {
            if (v !== undefined && v !== null) params.append(k, v);
        });
        
        const queryString = params.toString();
        const url = `${this.baseUrl}/chains/${symbol}${queryString ? '?' + queryString : ''}`;
        
        const res = await fetch(url);
        return res.json();
    },
    
    /**
     * Get option expiration dates
     */
    async getExpirations(symbol) {
        const res = await fetch(`${this.baseUrl}/expirations/${symbol}`);
        const data = await res.json();
        return data.expirationList || [];
    },
    
    /**
     * Get price history for charting
     */
    async getPriceHistory(symbol, options = {}) {
        const params = new URLSearchParams();
        Object.entries(options).forEach(([k, v]) => {
            if (v !== undefined) params.append(k, v);
        });
        
        const queryString = params.toString();
        const res = await fetch(`${this.baseUrl}/pricehistory/${symbol}${queryString ? '?' + queryString : ''}`);
        return res.json();
    },
    
    // ============================================================
    // ORDERS
    // ============================================================
    
    /**
     * Get orders for account
     */
    async getOrders(options = {}) {
        const accountHash = await this.getAccountHash();
        const params = new URLSearchParams();
        Object.entries(options).forEach(([k, v]) => {
            if (v !== undefined) params.append(k, v);
        });
        
        const queryString = params.toString();
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}/orders${queryString ? '?' + queryString : ''}`);
        return res.json();
    },
    
    /**
     * Preview an order (dry run)
     */
    async previewOrder(orderObj) {
        const accountHash = await this.getAccountHash();
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}/previewOrder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderObj)
        });
        return res.json();
    },
    
    /**
     * Place an order
     */
    async placeOrder(orderObj) {
        const accountHash = await this.getAccountHash();
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderObj)
        });
        return res.json();
    },
    
    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        const accountHash = await this.getAccountHash();
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}/orders/${orderId}`, {
            method: 'DELETE'
        });
        return res.json();
    },
    
    // ============================================================
    // ORDER BUILDERS
    // ============================================================
    
    /**
     * Build a sell-to-open put order
     */
    buildSellPutOrder(symbol, strike, expiry, contracts, price, duration = 'DAY') {
        // Format option symbol: PLTR  260221P00070000
        const optionSymbol = this._formatOptionSymbol(symbol, expiry, 'P', strike);
        
        return {
            orderType: 'LIMIT',
            session: 'NORMAL',
            duration: duration,
            orderStrategyType: 'SINGLE',
            price: price.toFixed(2),
            orderLegCollection: [{
                instruction: 'SELL_TO_OPEN',
                quantity: contracts,
                instrument: {
                    symbol: optionSymbol,
                    assetType: 'OPTION'
                }
            }]
        };
    },
    
    /**
     * Build a sell-to-open call order (covered call)
     */
    buildSellCallOrder(symbol, strike, expiry, contracts, price, duration = 'DAY') {
        const optionSymbol = this._formatOptionSymbol(symbol, expiry, 'C', strike);
        
        return {
            orderType: 'LIMIT',
            session: 'NORMAL',
            duration: duration,
            orderStrategyType: 'SINGLE',
            price: price.toFixed(2),
            orderLegCollection: [{
                instruction: 'SELL_TO_OPEN',
                quantity: contracts,
                instrument: {
                    symbol: optionSymbol,
                    assetType: 'OPTION'
                }
            }]
        };
    },
    
    /**
     * Build a buy-to-close order
     */
    buildBuyToCloseOrder(symbol, strike, expiry, putCall, contracts, price, duration = 'DAY') {
        const optionSymbol = this._formatOptionSymbol(symbol, expiry, putCall === 'PUT' ? 'P' : 'C', strike);
        
        return {
            orderType: 'LIMIT',
            session: 'NORMAL',
            duration: duration,
            orderStrategyType: 'SINGLE',
            price: price.toFixed(2),
            orderLegCollection: [{
                instruction: 'BUY_TO_CLOSE',
                quantity: contracts,
                instrument: {
                    symbol: optionSymbol,
                    assetType: 'OPTION'
                }
            }]
        };
    },
    
    /**
     * Format option symbol for Schwab
     * Format: SYMBOL (padded to 6) + YYMMDD + P/C + strike*1000 (8 digits)
     */
    _formatOptionSymbol(underlying, expiry, putCall, strike) {
        // Pad underlying to 6 chars
        const sym = underlying.toUpperCase().padEnd(6, ' ');
        
        // Parse expiry date
        const date = new Date(expiry);
        const yy = String(date.getFullYear()).slice(-2);
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        
        // Format strike (multiply by 1000, pad to 8 digits)
        const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
        
        return `${sym}${yy}${mm}${dd}${putCall}${strikeStr}`;
    },
    
    // ============================================================
    // TRANSACTIONS
    // ============================================================
    
    /**
     * Get recent transactions
     */
    async getTransactions(options = {}) {
        const accountHash = await this.getAccountHash();
        const params = new URLSearchParams();
        Object.entries(options).forEach(([k, v]) => {
            if (v !== undefined) params.append(k, v);
        });
        
        const queryString = params.toString();
        const res = await fetch(`${this.baseUrl}/accounts/${accountHash}/transactions${queryString ? '?' + queryString : ''}`);
        return res.json();
    }
};

// Export for module use or attach to window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SchwabAPI;
} else {
    window.SchwabAPI = SchwabAPI;
}
