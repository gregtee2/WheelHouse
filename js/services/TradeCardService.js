/**
 * TradeCardService.js - Shared trade card rendering and staging logic
 * 
 * Consolidates duplicated code from:
 * - main.js (Position Checkup, Discord Analyzer)
 * - portfolio.js (AI Holding Suggestion)
 * - analysis.js (Roll Calculator, Alternative Strategies)
 * 
 * Usage:
 *   import TradeCardService from './services/TradeCardService.js';
 *   
 *   // Parse AI response for suggested trade
 *   const trade = TradeCardService.parseSuggestedTrade(aiResponse);
 *   
 *   // Render a trade card
 *   const html = TradeCardService.renderTradeCard(trade, { ticker: 'AAPL' });
 *   
 *   // Stage to pending trades
 *   TradeCardService.stageToPending(trade, 'ai_checkup');
 */

import { showNotification } from '../utils.js';

class TradeCardService {
    
    /**
     * Parse the ===SUGGESTED_TRADE=== block from AI response
     * @param {string} aiResponse - Raw AI response text
     * @returns {object|null} Parsed trade object or null if no trade found
     */
    static parseSuggestedTrade(aiResponse) {
        if (!aiResponse) return null;
        
        const tradeMatch = aiResponse.match(/===SUGGESTED_TRADE===([\s\S]*?)===END_TRADE===/);
        if (!tradeMatch) return null;
        
        const tradeBlock = tradeMatch[1];
        
        // Parse each field
        const parseField = (name) => {
            const match = tradeBlock.match(new RegExp(`${name}:\\s*(.+)`));
            return match ? match[1].trim() : null;
        };
        
        const action = parseField('ACTION');
        
        // If action is HOLD or NONE, no trade to stage
        if (!action || action === 'HOLD' || action === 'NONE') {
            return { action: action || 'HOLD' };
        }
        
        return {
            action,
            closeStrike: parseField('CLOSE_STRIKE'),
            closeExpiry: parseField('CLOSE_EXPIRY'),
            closeType: parseField('CLOSE_TYPE'),
            newStrike: parseField('NEW_STRIKE'),
            newExpiry: parseField('NEW_EXPIRY'),
            newType: parseField('NEW_TYPE'),
            estimatedDebit: parseField('ESTIMATED_DEBIT'),
            estimatedCredit: parseField('ESTIMATED_CREDIT'),
            netCost: parseField('NET_COST'),
            rationale: parseField('RATIONALE')
        };
    }
    
    /**
     * Remove the ===SUGGESTED_TRADE=== block from AI response for display
     * @param {string} aiResponse - Raw AI response
     * @returns {string} Response with trade block removed
     */
    static stripTradeBlock(aiResponse) {
        if (!aiResponse) return '';
        return aiResponse.replace(/===SUGGESTED_TRADE===[\s\S]*?===END_TRADE===/g, '').trim();
    }
    
    /**
     * Render a suggested trade card HTML
     * @param {object} trade - Parsed trade object from parseSuggestedTrade
     * @param {object} options - Additional options
     * @param {string} options.ticker - Stock ticker symbol
     * @param {string} options.onStageClick - onclick handler for stage button (optional)
     * @param {boolean} options.showStageButton - Whether to show stage button (default: true)
     * @param {string} options.stageButtonText - Button text (default: '📥 Stage Roll')
     * @returns {string} HTML string for the trade card
     */
    static renderTradeCard(trade, options = {}) {
        if (!trade || trade.action === 'HOLD' || trade.action === 'NONE' || !trade.newStrike) {
            return '';
        }
        
        const {
            ticker = 'UNKNOWN',
            onStageClick = '',
            showStageButton = true,
            stageButtonText = '📥 Stage Roll'
        } = options;
        
        const netCostColor = trade.netCost?.toLowerCase().includes('credit') ? '#00ff88' : '#ffaa00';
        
        return `
        <div class="trade-card" style="background:linear-gradient(135deg, #1a2a3a 0%, #0d1a2a 100%);padding:16px;border-radius:8px;margin-top:16px;border:1px solid #00d9ff;">
            <h4 style="margin:0 0 12px;color:#00d9ff;font-size:13px;">📋 Suggested Trade</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <!-- Close Leg -->
                <div style="background:#0d0d1a;padding:10px;border-radius:6px;">
                    <div style="font-size:10px;color:#888;margin-bottom:4px;">CLOSE (Buy Back)</div>
                    <div style="font-size:14px;font-weight:bold;color:#ff5252;">
                        ${ticker} $${trade.closeStrike} ${trade.closeType || 'PUT'}
                    </div>
                    <div style="font-size:11px;color:#888;">Exp: ${trade.closeExpiry || 'N/A'}</div>
                    <div style="font-size:11px;color:#ffaa00;margin-top:4px;">Est: ${trade.estimatedDebit || 'N/A'}</div>
                </div>
                <!-- Open Leg -->
                <div style="background:#0d0d1a;padding:10px;border-radius:6px;">
                    <div style="font-size:10px;color:#888;margin-bottom:4px;">OPEN (Sell New)</div>
                    <div style="font-size:14px;font-weight:bold;color:#00ff88;">
                        ${ticker} $${trade.newStrike} ${trade.newType || 'PUT'}
                    </div>
                    <div style="font-size:11px;color:#888;">Exp: ${trade.newExpiry || 'N/A'}</div>
                    <div style="font-size:11px;color:#00ff88;margin-top:4px;">Est: ${trade.estimatedCredit || 'N/A'}</div>
                </div>
            </div>
            <!-- Net Cost -->
            <div style="margin-top:10px;padding:10px;background:#0d0d1a;border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <span style="font-size:11px;color:#888;">Net Cost:</span>
                    <span style="font-size:16px;font-weight:bold;color:${netCostColor};margin-left:8px;">
                        ${trade.netCost || 'N/A'}
                    </span>
                </div>
                ${showStageButton && onStageClick ? `
                <button onclick="${onStageClick}" 
                    style="padding:8px 14px;background:linear-gradient(135deg, #00d9ff 0%, #0099cc 100%);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;font-size:12px;">
                    ${stageButtonText}
                </button>
                ` : ''}
            </div>
            <!-- Rationale -->
            <div style="font-size:11px;color:#aaa;margin-top:8px;">
                💡 ${trade.rationale || 'AI-suggested trade based on current conditions'}
            </div>
        </div>
        `;
    }
    
    /**
     * Stage a trade to pending trades (localStorage)
     * @param {object} trade - Trade object to stage
     * @param {object} options - Additional options
     * @param {string} options.ticker - Stock ticker
     * @param {string} options.source - Source identifier (ai_checkup, ai_holding, roll_calc, discord, etc.)
     * @param {string} options.badge - Badge to show (ROLL, NEW, SKIP, etc.)
     * @param {number} options.originalPositionId - ID of position being rolled (optional)
     * @param {number} options.holdingId - ID of holding (optional)
     * @param {object} options.rollFrom - Info about position being closed (optional)
     * @returns {boolean} True if staged successfully
     */
    static stageToPending(trade, options = {}) {
        if (!trade || !trade.newStrike) {
            showNotification('No trade to stage', 'warning');
            return false;
        }
        
        const {
            ticker = 'UNKNOWN',
            source = 'ai_suggestion',
            badge = 'ROLL',
            originalPositionId = null,
            holdingId = null,
            rollFrom = null,
            parentPositionId = null  // PMCC: ID of covering LEAPS position
        } = options;
        
        // Determine trade type
        const typeStr = (trade.newType || 'put').toLowerCase();
        let tradeType = 'short_put';
        if (typeStr.includes('call')) {
            tradeType = typeStr.includes('long') ? 'long_call' : 'covered_call';
        } else if (typeStr.includes('put')) {
            tradeType = typeStr.includes('long') ? 'long_put' : 'short_put';
        }
        
        const pendingTrade = {
            id: Date.now(),
            ticker,
            strike: parseFloat(trade.newStrike),
            expiry: trade.newExpiry,
            type: tradeType,
            premium: null, // Will be fetched from CBOE/Schwab
            source,
            stagedAt: new Date().toISOString(),
            badge,
            aiRationale: trade.rationale,
            estimatedCredit: trade.estimatedCredit,
            estimatedDebit: trade.estimatedDebit,
            netCost: trade.netCost
        };
        
        // Add rollFrom info if this is a roll
        if (trade.closeStrike) {
            pendingTrade.rollFrom = rollFrom || {
                strike: parseFloat(trade.closeStrike),
                expiry: trade.closeExpiry,
                type: trade.closeType,
                estimatedDebit: trade.estimatedDebit
            };
        }
        
        // Add position/holding references
        if (originalPositionId) pendingTrade.originalPositionId = originalPositionId;
        if (holdingId) pendingTrade.holdingId = holdingId;
        if (parentPositionId) pendingTrade.parentPositionId = parentPositionId;
        
        // Load existing pending trades
        let pending = [];
        try {
            pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
        } catch (e) {
            pending = [];
        }
        
        // Check for duplicates
        const exists = pending.some(t => 
            t.ticker === pendingTrade.ticker && 
            t.strike === pendingTrade.strike && 
            t.expiry === pendingTrade.expiry
        );
        
        if (exists) {
            showNotification(`${ticker} $${pendingTrade.strike} ${trade.newExpiry} already staged`, 'info');
            return false;
        }
        
        pending.push(pendingTrade);
        localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
        
        showNotification(`📥 Staged: ${ticker} $${pendingTrade.strike} ${trade.newExpiry}`, 'success');
        
        // Trigger re-render of pending trades if available
        if (typeof window.renderPendingTrades === 'function') {
            window.renderPendingTrades();
        }
        
        return true;
    }
    
    /**
     * Get all pending trades from localStorage
     * @returns {Array} Array of pending trades
     */
    static getPendingTrades() {
        try {
            return JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
        } catch (e) {
            return [];
        }
    }
    
    /**
     * Remove a pending trade by ID
     * @param {number} tradeId - ID of trade to remove
     * @returns {boolean} True if removed
     */
    static removePendingTrade(tradeId) {
        let pending = this.getPendingTrades();
        const before = pending.length;
        pending = pending.filter(t => t.id !== tradeId);
        
        if (pending.length < before) {
            localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
            if (typeof window.renderPendingTrades === 'function') {
                window.renderPendingTrades();
            }
            return true;
        }
        return false;
    }
    
    /**
     * Clear all pending trades
     */
    static clearPendingTrades() {
        localStorage.setItem('wheelhouse_pending', '[]');
        if (typeof window.renderPendingTrades === 'function') {
            window.renderPendingTrades();
        }
    }
}

// Also expose on window for inline onclick handlers
window.TradeCardService = TradeCardService;

export default TradeCardService;
