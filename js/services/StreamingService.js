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

import { formatPnLPercent, formatPnLDollar, getPnLColor, getPnLStyle } from '../utils/formatters.js';

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
        this.futuresQuotes = new Map(); // futures symbol -> quote data (e.g., /ES, /NQ)
        
        // DOM update tracking
        this.updateQueue = [];
        this.rafScheduled = false;
        
        // Debounced gauge update (don't update every tick, just every 2 seconds)
        this.gaugeUpdateScheduled = false;
        this.gaugeUpdateDelay = 2000; // 2 seconds
    }
    
    /**
     * Check if streaming is fully connected (Socket.IO + Python streamer)
     */
    isConnected() {
        return this.connected && this.streamerConnected;
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
            
            // Request current streamer status immediately
            this.socket.emit('get-streamer-status');
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
        
        // Futures quote updates (e.g., /ES, /NQ, /YM, /RTY)
        this.socket.on('futures-quote', (data) => {
            this.futuresQuotes.set(data.symbol, data);
            this._emit('futures-quote', data);
            
            // Queue DOM update for futures panel
            this.queueDOMUpdate('futures', data);
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
            } else if (update.type === 'futures') {
                this.updateFuturesPanel(update.data);
            }
        }
        
        // Schedule a debounced update of the leverage gauge
        // This prevents updating 100 times per second, but keeps it reactive
        this.scheduleGaugeUpdate();
    }
    
    /**
     * Debounced leverage gauge update
     * Updates the gauge at most once every 2 seconds to avoid flickering
     */
    scheduleGaugeUpdate() {
        if (this.gaugeUpdateScheduled) return;
        
        this.gaugeUpdateScheduled = true;
        setTimeout(() => {
            this.gaugeUpdateScheduled = false;
            
            // Only update if Portfolio Summary function exists and we're on the Positions tab
            if (window.updatePortfolioSummary && 
                document.querySelector('#positions')?.classList.contains('active')) {
                window.updatePortfolioSummary();
            }
        }, this.gaugeUpdateDelay);
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
        
        // Compute mid price from bid/ask, or use mark, or fall back to last
        const midPrice = (quote.bid !== undefined && quote.ask !== undefined)
            ? (quote.bid + quote.ask) / 2
            : (quote.mark ?? quote.last);
        
        // Update position state (if state object is available)
        if (positionId && window.state?.positions) {
            const pos = window.state.positions.find(p => String(p.id) === positionId);
            if (pos && midPrice !== undefined) {
                const oldPrice = pos.lastOptionPrice;
                pos.lastOptionPrice = midPrice;
                pos.priceUpdatedAt = Date.now();
                
                // Update delta/theta if provided
                if (quote.delta !== undefined) pos.delta = quote.delta;
                if (quote.theta !== undefined) pos.theta = quote.theta;
                
                // Update P/L cells (calculated from lastOptionPrice)
                this._updatePLCells(row, pos, oldPrice, midPrice);
            }
        }
        
        // Update delta cell
        const deltaCell = row.querySelector('[data-field="delta"]');
        if (deltaCell && quote.delta !== undefined) {
            // Get position info for proper calculation
            const posId = row.dataset.positionId;
            const pos = window.state?.positions?.find(p => String(p.id) === posId);
            const contracts = pos?.contracts || 1;
            
            // Delta per share * 100 shares * contracts = total delta exposure
            const isShort = pos?.type?.includes('short') || pos?.type === 'covered_call';
            const sign = isShort ? -1 : 1;
            const totalDelta = quote.delta * 100 * contracts * sign;
            
            const deltaTooltip = `If stock moves $1, your P&L changes by ~$${Math.abs(totalDelta).toFixed(0)}`;
            deltaCell.innerHTML = `<span style="color:#ccc;font-size:10px;" title="${deltaTooltip}">${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(0)}</span>`;
        }
        
        // Update theta cell - show $/day rate
        const thetaCell = row.querySelector('[data-field="theta"]');
        if (thetaCell && quote.theta !== undefined) {
            const posId = row.dataset.positionId;
            const pos = window.state?.positions?.find(p => String(p.id) === posId);
            const contracts = pos?.contracts || 1;
            
            // Theta per share * 100 shares * contracts = total $/day decay
            const isShort = pos?.type?.includes('short') || pos?.type === 'covered_call';
            const isLong = pos?.type?.includes('long') || pos?.type === 'LEAPS_Call';
            const sign = isShort ? -1 : 1;
            const totalTheta = quote.theta * 100 * contracts * sign;
            
            // Color: green for collecting (positive), amber for paying (negative/long)
            let thetaColor;
            if (isShort) {
                thetaColor = totalTheta > 0 ? '#00ff88' : '#ff5252';
            } else {
                thetaColor = '#ffaa00';  // Amber for long positions (expected cost)
            }
            
            // Format: show dollars with cents if under $1
            const absTheta = Math.abs(totalTheta);
            const thetaDisplay = absTheta < 1 ? `$${absTheta.toFixed(2)}` : `$${absTheta.toFixed(0)}`;
            const thetaSign = totalTheta >= 0 ? '+' : '-';
            
            const thetaTooltip = isShort 
                ? `You collect ${thetaDisplay}/day from time decay`
                : `Time decay cost: ${thetaDisplay}/day`;
            
            // Add LIVE indicator
            thetaCell.innerHTML = `<span style="color:${thetaColor};font-size:10px;" title="${thetaTooltip}">${thetaSign}${thetaDisplay}</span> <span style="color:#00d9ff;font-size:9px;font-weight:bold;">LIVE</span>`;
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
            const pctColor = getPnLColor(unrealizedPnLPct);
            const pctStyle = getPnLStyle(unrealizedPnLPct);
            const checkmark = unrealizedPnLPct >= 50 ? '✓' : '';
            pctCell.innerHTML = `<span style="color:${pctColor};font-weight:bold;${pctStyle}">${checkmark}${formatPnLPercent(unrealizedPnLPct)}</span>`;
            
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
            const pnlColor = getPnLColor(unrealizedPnL, 0);
            openCell.innerHTML = `<span style="color:${pnlColor}">${formatPnLDollar(unrealizedPnL)}</span>`;
        }
    }
    
    /**
     * Update spot price for a ticker
     */
    updateSpotPrice(quote) {
        // Guard: need a valid price
        if (quote.last === undefined && quote.price === undefined) return;
        const price = quote.last ?? quote.price;
        if (typeof price !== 'number' || isNaN(price)) return;
        
        // Update all rows for this ticker
        const rows = document.querySelectorAll(`tr[data-ticker="${quote.symbol}"]`);
        
        for (const row of rows) {
            const spotCell = row.querySelector('[data-field="spot"]');
            if (spotCell) {
                const oldValue = parseFloat(spotCell.textContent.replace(/[^0-9.-]/g, ''));
                const newPrice = price;
                
                // Get position data from row to determine color
                const strike = parseFloat(row.dataset.strike) || 0;
                const posType = row.dataset.posType || '';
                
                // Determine ITM/OTM color coding
                let spotColor = '#ccc'; // Default gray
                
                if (strike > 0 && posType) {
                    const isPut = posType.includes('put');
                    const isLong = posType.startsWith('long_') || posType === 'long_call_leaps' || posType === 'skip_call';
                    
                    // ITM: Puts when spot < strike, Calls when spot > strike
                    const isITM = isPut ? newPrice < strike : newPrice > strike;
                    const distancePct = Math.abs((newPrice - strike) / strike * 100);
                    const isATM = distancePct < 2;
                    
                    if (isATM) {
                        spotColor = '#ffaa00'; // Orange for ATM
                    } else if (isITM) {
                        spotColor = isLong ? '#00ff88' : '#ff5252'; // Green if long, Red if short
                    } else {
                        // OTM
                        spotColor = isLong ? '#888' : '#00ff88'; // Gray if long, Green if short
                    }
                }
                
                spotCell.innerHTML = `<span style="color:${spotColor};">$${newPrice.toFixed(2)}</span>`;
                
                // Flash animation
                if (Math.abs(newPrice - oldValue) > 0.01) {
                    spotCell.classList.remove('flash-green', 'flash-red');
                    void spotCell.offsetWidth;
                    spotCell.classList.add(newPrice > oldValue ? 'flash-green' : 'flash-red');
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
     * Update futures panel with latest quote
     */
    updateFuturesPanel(quote) {
        // Find the futures tile for this symbol
        const tile = document.querySelector(`[data-futures-symbol="${quote.symbol}"]`);
        if (!tile) return;
        
        // Update price
        const priceEl = tile.querySelector('.futures-price');
        if (priceEl) {
            const oldValue = parseFloat(priceEl.textContent.replace(/[^0-9.-]/g, ''));
            const newValue = quote.last || quote.mark || quote.bid;
            
            if (newValue) {
                priceEl.textContent = newValue.toLocaleString('en-US', { 
                    minimumFractionDigits: 2, 
                    maximumFractionDigits: 2 
                });
                
                // Flash animation
                if (Math.abs(newValue - oldValue) > 0.01) {
                    priceEl.classList.remove('flash-green', 'flash-red');
                    void priceEl.offsetWidth;
                    priceEl.classList.add(newValue > oldValue ? 'flash-green' : 'flash-red');
                }
            }
        }
        
        // Update change
        const changeEl = tile.querySelector('.futures-change');
        if (changeEl && quote.netChange !== undefined) {
            const change = quote.netChange;
            const pctChange = quote.netChangePercent || 0;
            const sign = change >= 0 ? '+' : '';
            const color = change >= 0 ? '#00ff88' : '#ff5252';
            
            changeEl.innerHTML = `
                <span style="color:${color}">${sign}${change.toFixed(2)}</span>
                <span style="color:${color};opacity:0.7;margin-left:4px">(${sign}${pctChange.toFixed(2)}%)</span>
            `;
        }
        
        // Update bid/ask if displayed
        const bidEl = tile.querySelector('.futures-bid');
        const askEl = tile.querySelector('.futures-ask');
        if (bidEl && quote.bid) bidEl.textContent = quote.bid.toFixed(2);
        if (askEl && quote.ask) askEl.textContent = quote.ask.toFixed(2);
    }
    
    /**
     * Subscribe to futures symbols
     * @param {string[]} symbols - e.g., ['/ES', '/NQ', '/YM', '/RTY']
     */
    async subscribeFutures(symbols) {
        if (!symbols || symbols.length === 0) return false;
        
        try {
            const res = await fetch('/api/streaming/futures', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols })
            });
            const data = await res.json();
            console.log(`[STREAMING] Subscribed to futures: ${symbols.join(', ')}`, data);
            return data.success;
        } catch (e) {
            console.error('[STREAMING] Failed to subscribe to futures:', e);
            return false;
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
     * Get latest quote for a futures symbol (from cache)
     * @param {string} symbol - e.g., '/ES'
     */
    getFuturesQuote(symbol) {
        return this.futuresQuotes.get(symbol);
    }
    
    /**
     * Get all cached futures quotes
     */
    getAllFuturesQuotes() {
        return Object.fromEntries(this.futuresQuotes);
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
            cachedEquities: this.equityQuotes.size,
            cachedFutures: this.futuresQuotes.size
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
