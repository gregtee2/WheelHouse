/**
 * PositionsService.js - Single source of truth for position CRUD operations
 * 
 * USAGE:
 *   import PositionsService from './services/PositionsService.js';
 *   
 *   // Get all open positions
 *   const positions = PositionsService.getAll();
 *   
 *   // Find a specific position
 *   const pos = PositionsService.find(positionId);
 *   
 *   // Add a new position
 *   PositionsService.add(newPosition);
 *   
 *   // Update a position
 *   PositionsService.update(positionId, { strike: 95 });
 *   
 *   // Remove a position
 *   PositionsService.remove(positionId);
 *   
 *   // Get closed positions
 *   const closed = PositionsService.getClosed();
 * 
 * WHY THIS EXISTS:
 *   Before this service, localStorage access for positions was scattered across:
 *   - main.js (12+ places)
 *   - portfolio.js (4+ places)
 *   - positions.js (multiple places)
 *   - settings.js (2+ places)
 *   
 *   Each file read/wrote 'wheelhouse_positions' directly, leading to:
 *   - Inconsistent key names (some used account-specific keys, some didn't)
 *   - No normalization (realizedPnL vs closePnL confusion)
 *   - Race conditions when multiple operations happened
 *   
 *   This service centralizes ALL position access through one module.
 */

import { state, getPositionsKey, getClosedKey, getHoldingsKey } from '../state.js';

class PositionsService {
    
    // ========================================
    // OPEN POSITIONS
    // ========================================
    
    /**
     * Get all open positions
     * @returns {Array} Array of position objects
     */
    static getAll() {
        return state.positions || [];
    }
    
    /**
     * Find a position by ID
     * @param {number|string} id - Position ID
     * @returns {Object|undefined} Position or undefined if not found
     */
    static find(id) {
        const numId = Number(id);
        return state.positions?.find(p => p.id === numId);
    }
    
    /**
     * Find positions by ticker
     * @param {string} ticker - Stock ticker (case-insensitive)
     * @returns {Array} Matching positions
     */
    static findByTicker(ticker) {
        const upperTicker = ticker?.toUpperCase();
        return state.positions?.filter(p => p.ticker?.toUpperCase() === upperTicker) || [];
    }
    
    /**
     * Add a new position
     * @param {Object} position - Position object (id will be generated if not provided)
     * @returns {Object} The added position (with ID)
     */
    static add(position) {
        if (!position.id) {
            position.id = Date.now();
        }
        if (!position.chainId) {
            position.chainId = position.id; // Self-reference for new chains
        }
        
        // Normalize the position
        position = this._normalize(position);
        
        state.positions.push(position);
        this._saveOpen();
        
        console.log('[PositionsService] Added position:', position.id, position.ticker);
        return position;
    }
    
    /**
     * Update an existing position
     * @param {number|string} id - Position ID
     * @param {Object} updates - Fields to update
     * @returns {Object|null} Updated position or null if not found
     */
    static update(id, updates) {
        const numId = Number(id);
        const index = state.positions?.findIndex(p => p.id === numId);
        
        if (index === -1 || index === undefined) {
            console.warn('[PositionsService] Position not found for update:', id);
            return null;
        }
        
        // Apply updates
        Object.assign(state.positions[index], updates);
        
        // Re-normalize after update
        state.positions[index] = this._normalize(state.positions[index]);
        
        this._saveOpen();
        
        console.log('[PositionsService] Updated position:', id);
        return state.positions[index];
    }
    
    /**
     * Remove a position by ID
     * @param {number|string} id - Position ID
     * @returns {Object|null} Removed position or null if not found
     */
    static remove(id) {
        const numId = Number(id);
        const index = state.positions?.findIndex(p => p.id === numId);
        
        if (index === -1 || index === undefined) {
            console.warn('[PositionsService] Position not found for removal:', id);
            return null;
        }
        
        const removed = state.positions.splice(index, 1)[0];
        this._saveOpen();
        
        console.log('[PositionsService] Removed position:', id);
        return removed;
    }
    
    /**
     * Replace all positions (used for bulk operations like import)
     * @param {Array} positions - New positions array
     */
    static setAll(positions) {
        state.positions = positions.map(p => this._normalize(p));
        this._saveOpen();
        console.log('[PositionsService] Set all positions:', positions.length);
    }
    
    /**
     * Get position count
     * @returns {number}
     */
    static count() {
        return state.positions?.length || 0;
    }
    
    // ========================================
    // CLOSED POSITIONS
    // ========================================
    
    /**
     * Get all closed positions
     * @returns {Array}
     */
    static getClosed() {
        return state.closedPositions || [];
    }
    
    /**
     * Find a closed position by ID
     * @param {number|string} id
     * @returns {Object|undefined}
     */
    static findClosed(id) {
        const numId = Number(id);
        return state.closedPositions?.find(p => p.id === numId);
    }
    
    /**
     * Add a closed position
     * @param {Object} position
     * @returns {Object}
     */
    static addClosed(position) {
        position = this._normalize(position);
        position.status = 'closed';
        
        state.closedPositions.push(position);
        this._saveClosed();
        
        console.log('[PositionsService] Added closed position:', position.id);
        return position;
    }
    
    /**
     * Move a position from open to closed
     * @param {number|string} id - Position ID to close
     * @param {Object} closeData - Close details (closePrice, closeDate, closeReason, etc.)
     * @returns {Object|null} The closed position or null if not found
     */
    static close(id, closeData = {}) {
        const position = this.remove(id);
        if (!position) return null;
        
        // Apply close data
        position.status = 'closed';
        position.closeDate = closeData.closeDate || new Date().toISOString().split('T')[0];
        position.closePrice = closeData.closePrice ?? 0;
        position.closeReason = closeData.closeReason || 'closed';
        
        // Calculate realized P&L if not provided
        if (position.realizedPnL === undefined && closeData.realizedPnL === undefined) {
            const premium = position.premium || 0;
            const closePrice = position.closePrice || 0;
            const contracts = position.contracts || 1;
            
            // For short options: P&L = (premium received - cost to close) * 100 * contracts
            // For long options: P&L = (close price - premium paid) * 100 * contracts
            const isDebit = position.type?.includes('long') || position.type?.includes('debit');
            if (isDebit) {
                position.realizedPnL = (closePrice - premium) * 100 * contracts;
            } else {
                position.realizedPnL = (premium - closePrice) * 100 * contracts;
            }
        } else {
            position.realizedPnL = closeData.realizedPnL ?? position.realizedPnL ?? 0;
        }
        
        // Calculate days held
        if (position.openDate && position.closeDate) {
            const open = new Date(position.openDate);
            const close = new Date(position.closeDate);
            position.daysHeld = Math.max(1, Math.round((close - open) / (1000 * 60 * 60 * 24)));
        }
        
        return this.addClosed(position);
    }
    
    /**
     * Replace all closed positions
     * @param {Array} positions
     */
    static setAllClosed(positions) {
        state.closedPositions = positions.map(p => this._normalize(p));
        this._saveClosed();
        console.log('[PositionsService] Set all closed positions:', positions.length);
    }
    
    // ========================================
    // CHAIN OPERATIONS
    // ========================================
    
    /**
     * Get all positions in a chain (open + closed)
     * @param {number|string} chainId
     * @returns {Array} All positions sharing this chainId, sorted by openDate
     */
    static getChain(chainId) {
        const numChainId = Number(chainId);
        const all = [...(state.positions || []), ...(state.closedPositions || [])];
        
        return all
            .filter(p => (p.chainId || p.id) === numChainId)
            .sort((a, b) => new Date(a.openDate || 0) - new Date(b.openDate || 0));
    }
    
    /**
     * Check if a position has roll history
     * @param {number|string} positionId
     * @returns {boolean}
     */
    static hasRollHistory(positionId) {
        const pos = this.find(positionId) || this.findClosed(positionId);
        if (!pos) return false;
        
        const chain = this.getChain(pos.chainId || pos.id);
        return chain.length > 1;
    }
    
    /**
     * Calculate total premium collected across a chain
     * @param {number|string} chainId
     * @returns {number} Net premium (received - closing costs)
     */
    static getChainPremium(chainId) {
        const chain = this.getChain(chainId);
        
        let totalReceived = 0;
        let totalClosingCosts = 0;
        
        chain.forEach(p => {
            const premiumReceived = (p.premium || 0) * 100 * (p.contracts || 1);
            totalReceived += premiumReceived;
            
            if (p.status === 'closed' && p.closePrice > 0) {
                totalClosingCosts += p.closePrice * 100 * (p.contracts || 1);
            }
        });
        
        return totalReceived - totalClosingCosts;
    }
    
    // ========================================
    // HOLDINGS (Stock from assignments)
    // ========================================
    
    /**
     * Get all holdings
     * @returns {Array}
     */
    static getHoldings() {
        return state.holdings || [];
    }
    
    /**
     * Add a holding
     * @param {Object} holding
     * @returns {Object}
     */
    static addHolding(holding) {
        if (!holding.id) {
            holding.id = Date.now();
        }
        state.holdings.push(holding);
        this._saveHoldings();
        return holding;
    }
    
    /**
     * Remove a holding
     * @param {number|string} id
     * @returns {Object|null}
     */
    static removeHolding(id) {
        const numId = Number(id);
        const index = state.holdings?.findIndex(h => h.id === numId);
        if (index === -1 || index === undefined) return null;
        
        const removed = state.holdings.splice(index, 1)[0];
        this._saveHoldings();
        return removed;
    }
    
    /**
     * Replace all holdings
     * @param {Array} holdings
     */
    static setAllHoldings(holdings) {
        state.holdings = holdings;
        this._saveHoldings();
    }
    
    // ========================================
    // LOAD / SAVE
    // ========================================
    
    /**
     * Load all position data from localStorage into state
     * Call this on app startup
     */
    static load() {
        try {
            // Load open positions
            const positionsJson = localStorage.getItem(getPositionsKey());
            if (positionsJson) {
                state.positions = JSON.parse(positionsJson).map(p => this._normalize(p));
            } else {
                state.positions = [];
            }
            
            // Load closed positions
            const closedJson = localStorage.getItem(getClosedKey());
            if (closedJson) {
                state.closedPositions = JSON.parse(closedJson).map(p => this._normalize(p));
            } else {
                state.closedPositions = [];
            }
            
            // Load holdings
            const holdingsJson = localStorage.getItem(getHoldingsKey());
            if (holdingsJson) {
                state.holdings = JSON.parse(holdingsJson);
            } else {
                state.holdings = [];
            }
            
            console.log('[PositionsService] Loaded:', {
                open: state.positions.length,
                closed: state.closedPositions.length,
                holdings: state.holdings.length
            });
            
        } catch (e) {
            console.error('[PositionsService] Load error:', e);
            state.positions = [];
            state.closedPositions = [];
            state.holdings = [];
        }
    }
    
    /**
     * Force save all data to localStorage
     * Usually not needed - individual operations auto-save
     */
    static saveAll() {
        this._saveOpen();
        this._saveClosed();
        this._saveHoldings();
    }
    
    // ========================================
    // INTERNAL HELPERS
    // ========================================
    
    /**
     * Normalize a position object (fix inconsistencies)
     * @private
     */
    static _normalize(pos) {
        if (!pos) return pos;
        
        // Fix realizedPnL vs closePnL inconsistency
        if (pos.closePnL !== undefined && pos.realizedPnL === undefined) {
            pos.realizedPnL = pos.closePnL;
        }
        // Keep closePnL for backward compatibility but prefer realizedPnL
        
        // Ensure numeric fields are numbers
        if (pos.strike) pos.strike = Number(pos.strike);
        if (pos.premium) pos.premium = Number(pos.premium);
        if (pos.contracts) pos.contracts = Number(pos.contracts);
        if (pos.closePrice) pos.closePrice = Number(pos.closePrice);
        
        // Ensure chainId exists
        if (!pos.chainId && pos.id) {
            pos.chainId = pos.id;
        }
        
        return pos;
    }
    
    /**
     * Save open positions to localStorage
     * @private
     */
    static _saveOpen() {
        try {
            localStorage.setItem(getPositionsKey(), JSON.stringify(state.positions));
        } catch (e) {
            console.error('[PositionsService] Save error (open):', e);
        }
    }
    
    /**
     * Save closed positions to localStorage
     * @private
     */
    static _saveClosed() {
        try {
            localStorage.setItem(getClosedKey(), JSON.stringify(state.closedPositions));
        } catch (e) {
            console.error('[PositionsService] Save error (closed):', e);
        }
    }
    
    /**
     * Save holdings to localStorage
     * @private
     */
    static _saveHoldings() {
        try {
            localStorage.setItem(getHoldingsKey(), JSON.stringify(state.holdings));
        } catch (e) {
            console.error('[PositionsService] Save error (holdings):', e);
        }
    }
}

// Export as default for ES6 imports
export default PositionsService;

// Also attach to window for global access (for onclick handlers in HTML)
if (typeof window !== 'undefined') {
    window.PositionsService = PositionsService;
}
