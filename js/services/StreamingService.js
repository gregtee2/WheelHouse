/**
 * StreamingService.js - Real-time option quotes via WebSocket
 * 
 * Connects to server's Socket.IO for live streaming quotes.
 * Provides surgical DOM updates without full table re-renders.
 * 
 * Usage:
 *   import StreamingService from './services/StreamingService.js';
 *   
 *   // Initialize with positions
 *   StreamingService.connect();
 *   StreamingService.subscribePositions(state.positions);
 *   
 *   // Listen for updates
 *   StreamingService.on('option-quote', (data) => {
 *       // data = { symbol, bid, ask, last, delta, gamma, theta, vega, iv, timestamp }
 *   });
 */

class StreamingServiceClass {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.streamerConnected = false;
        this.listeners = {};
        this.subscribedSymbols = [];
        
        // Quote cache for quick lookups
        this.optionQuotes = new Map(); // OCC symbol -> quote data
        this.equityQuotes = new Map(); // ticker -> quote data
        
        // DOM update tracking
        this.updateQueue = [];
        this.rafScheduled = false;
    }
    
    /**
     * Connect to Socket.IO server
     */
    connect() {
        if (this.socket) return;
        
        // Use Socket.IO client (loaded via CDN in index.html)
        if (typeof io === 'undefined') {
            console.warn('[STREAMING] Socket.IO client not loaded');
            return;
        }
        
        this.socket = io({
            transports: ['websocket', 'polling']
        });
        
        this.socket.on('connect', () => {
            this.connected = true;
            console.log('[STREAMING] Connected to server');
            this._emit('connected');
        });
        
        this.socket.on('disconnect', () => {
            this.connected = false;
            this.streamerConnected = false;
            console.log('[STREAMING] Disconnected from server');
            this._emit('disconnected');
        });
        
        // Streamer status (Python service connection)
        this.socket.on('streamer-status', (data) => {
            this.streamerConnected = data.connected;
            this.subscribedSymbols = data.subscribedSymbols || [];
            console.log(`[STREAMING] Streamer ${data.connected ? '✓ connected' : '✗ disconnected'}`);
            this._emit('streamer-status', data);
        });
        
        // Option quote updates (the good stuff!)
        this.socket.on('option-quote', (data) => {
            this.optionQuotes.set(data.symbol, data);
            this._emit('option-quote', data);
            
            // Queue DOM update
            this.queueDOMUpdate('option', data);
        });
        
        // Equity quote updates
        this.socket.on('equity-quote', (data) => {
            this.equityQuotes.set(data.symbol, data);
            this._emit('equity-quote', data);
            
            // Queue DOM update for spot price
            this.queueDOMUpdate('equity', data);
        });
        
        // Account activity (fills, etc)
        this.socket.on('account-activity', (data) => {
            this._emit('account-activity', data);
        });
    }
    
    /**
     * Subscribe to quotes for open positions
     */
    subscribePositions(positions) {
        if (!this.socket || !positions || positions.length === 0) return;
        
        this.socket.emit('subscribe-positions', positions);
        console.log(`[STREAMING] Subscribing to ${positions.length} positions`);
    }
    
    /**
     * Queue a DOM update (batched via requestAnimationFrame)
     */
    queueDOMUpdate(type, data) {
        this.updateQueue.push({ type, data, timestamp: Date.now() });
        
        if (!this.rafScheduled) {
            this.rafScheduled = true;
            requestAnimationFrame(() => this.processDOMUpdates());
        }
    }
    
    /**
     * Process queued DOM updates in a single batch
     */
    processDOMUpdates() {
        this.rafScheduled = false;
        
        const updates = this.updateQueue.splice(0); // Take all queued updates
        
        for (const update of updates) {
            if (update.type === 'option') {
                this.updatePositionRow(update.data);
            } else if (update.type === 'equity') {
                this.updateSpotPrice(update.data);
            }
        }
    }
    
    /**
     * Surgically update a position row in the table
     * No innerHTML replacement - just individual cell updates
     */
    updatePositionRow(quote) {
        // Find row by OCC symbol data attribute
        const row = document.querySelector(`tr[data-occ-symbol="${quote.symbol}"]`);
        if (!row) return;
        
        const positionId = row.dataset.positionId;
        
        // Update position state (if state object is available)
        if (positionId && window.state?.positions) {
            const pos = window.state.positions.find(p => String(p.id) === positionId);
            if (pos && quote.mid !== undefined) {
                const oldPrice = pos.lastOptionPrice;
                pos.lastOptionPrice = quote.mid;
                pos.priceUpdatedAt = Date.now();
                
                // Update delta/theta if provided
                if (quote.delta !== undefined) pos.delta = quote.delta;
                if (quote.theta !== undefined) pos.theta = quote.theta;
                
                // Update P/L cells (calculated from lastOptionPrice)
                this._updatePLCells(row, pos, oldPrice, quote.mid);
            }
        }
        
        // Update delta cell
        const deltaCell = row.querySelector('[data-field="delta"]');
        if (deltaCell && quote.delta !== undefined) {
            deltaCell.textContent = quote.delta.toFixed(2);
            deltaCell.style.color = Math.abs(quote.delta) > 0.4 ? '#ffaa00' : '#888';
        }
        
        // Update theta cell
        const thetaCell = row.querySelector('[data-field="theta"]');
        if (thetaCell && quote.theta !== undefined) {
            thetaCell.textContent = quote.theta.toFixed(2);
        }
    }
    
    /**
     * Update P/L cells for a position row
     */
    _updatePLCells(row, pos, oldPrice, newPrice) {
        const positionId = pos.id;
        
        // Find P/L cells by ID pattern
        // The existing code uses inline IIFEs for P/L, so we need to find by structure
        // P/L columns: P/L %, P/L Day, P/L Open
        
        // Calculate unrealized P/L
        const isLong = ['long_call', 'long_put', 'call_debit_spread', 'put_debit_spread'].includes(pos.type);
        const priceDiff = isLong ? (newPrice - pos.premium) : (pos.premium - newPrice);
        const unrealizedPnL = priceDiff * 100 * pos.contracts;
        const unrealizedPnLPct = (priceDiff / pos.premium) * 100;
        
        // Find P/L cells - they're after theta cell
        const cells = row.querySelectorAll('td');
        const thetaCell = row.querySelector('[data-field="theta"]');
        if (!thetaCell) return;
        
        // Get index of theta cell, P/L columns are next 3
        const thetaIndex = Array.from(cells).indexOf(thetaCell);
        if (thetaIndex < 0) return;
        
        // P/L % is at thetaIndex + 1
        const pctCell = cells[thetaIndex + 1];
        if (pctCell) {
            const pctColor = unrealizedPnLPct >= 50 ? '#00d9ff' : (unrealizedPnLPct >= 0 ? '#00ff88' : '#ff5252');
            const checkmark = unrealizedPnLPct >= 50 ? '✓' : '';
            const sign = unrealizedPnLPct >= 0 ? '+' : '';
            pctCell.innerHTML = `<span style="color:${pctColor};font-weight:bold;${unrealizedPnLPct >= 50 ? 'text-shadow:0 0 4px #00d9ff;' : ''}">${checkmark}${sign}${unrealizedPnLPct.toFixed(0)}%</span>`;
            
            // Flash on change
            if (Math.abs(newPrice - oldPrice) > 0.001) {
                pctCell.classList.remove('flash-green', 'flash-red');
                void pctCell.offsetWidth;
                pctCell.classList.add(newPrice < oldPrice ? 'flash-green' : 'flash-red'); // Short positions profit when price goes down
            }
        }
        
        // P/L Open is at thetaIndex + 3
        const openCell = cells[thetaIndex + 3];
        if (openCell) {
            const pnlColor = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
            const sign = unrealizedPnL >= 0 ? '+' : '';
            openCell.innerHTML = `<span style="color:${pnlColor}">${sign}$${unrealizedPnL.toFixed(0)}</span>`;
        }
    }
    
    /**
     * Update spot price for a ticker
     */
    updateSpotPrice(quote) {
        // Update all rows for this ticker
        const rows = document.querySelectorAll(`tr[data-ticker="${quote.symbol}"]`);
        
        for (const row of rows) {
            const spotCell = row.querySelector('[data-field="spot"]');
            if (spotCell) {
                const oldValue = parseFloat(spotCell.textContent);
                spotCell.textContent = `$${quote.last.toFixed(2)}`;
                
                // Flash animation
                if (Math.abs(quote.last - oldValue) > 0.01) {
                    spotCell.classList.remove('flash-green', 'flash-red');
                    void spotCell.offsetWidth;
                    spotCell.classList.add(quote.last > oldValue ? 'flash-green' : 'flash-red');
                }
            }
        }
        
        // Also update any spot price displays outside the table
        const spotDisplays = document.querySelectorAll(`[data-ticker-spot="${quote.symbol}"]`);
        for (const el of spotDisplays) {
            el.textContent = `$${quote.last.toFixed(2)}`;
        }
    }
    
    /**
     * Get latest quote for an option (from cache)
     */
    getOptionQuote(occSymbol) {
        return this.optionQuotes.get(occSymbol);
    }
    
    /**
     * Get latest quote for an equity (from cache)
     */
    getEquityQuote(ticker) {
        return this.equityQuotes.get(ticker);
    }
    
    /**
     * Register event listener
     */
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }
    
    /**
     * Remove event listener
     */
    off(event, callback) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }
    }
    
    /**
     * Emit event to listeners
     */
    _emit(event, data) {
        if (this.listeners[event]) {
            for (const callback of this.listeners[event]) {
                try {
                    callback(data);
                } catch (e) {
                    console.error(`[STREAMING] Listener error for ${event}:`, e);
                }
            }
        }
    }
    
    /**
     * Get connection status
     */
    getStatus() {
        return {
            connected: this.connected,
            streamerConnected: this.streamerConnected,
            subscribedSymbols: this.subscribedSymbols.length,
            cachedOptions: this.optionQuotes.size,
            cachedEquities: this.equityQuotes.size
        };
    }
    
    /**
     * Force fetch status from server
     */
    async fetchStatus() {
        try {
            const res = await fetch('/api/streaming/status');
            return await res.json();
        } catch (e) {
            return { error: e.message };
        }
    }
}

// Singleton export
const StreamingService = new StreamingServiceClass();
export default StreamingService;
