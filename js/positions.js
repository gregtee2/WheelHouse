// WheelHouse - Position Tracker Module
// localStorage-based position management

import { state, setPositionContext, clearPositionContext } from './state.js';
import { formatCurrency, formatPercent, getDteUrgency, showNotification, showUndoNotification } from './utils.js';
import { fetchPositionTickerPrice } from './api.js';
import { drawPayoffChart } from './charts.js';

const STORAGE_KEY = 'wheelhouse_positions';
const HOLDINGS_KEY = 'wheelhouse_holdings';
const CLOSED_KEY = 'wheelhouse_closed_positions';
const CHECKPOINT_KEY = 'wheelhouse_data_checkpoint';

/**
 * Calculate breakeven price for a spread
 */
function calculateSpreadBreakeven(type, buyStrike, sellStrike, premium) {
    switch (type) {
        case 'call_debit_spread':
            // Breakeven = lower strike + premium paid
            return Math.min(buyStrike, sellStrike) + premium;
        case 'put_debit_spread':
            // Breakeven = higher strike - premium paid
            return Math.max(buyStrike, sellStrike) - premium;
        case 'call_credit_spread':
            // Breakeven = lower strike + premium received
            return Math.min(buyStrike, sellStrike) + premium;
        case 'put_credit_spread':
            // Breakeven = higher strike - premium received
            return Math.max(buyStrike, sellStrike) - premium;
        default:
            return null;
    }
}

/**
 * Get human-readable spread description for AI analysis
 */
export function getSpreadExplanation(pos) {
    if (!pos.type?.includes('_spread')) return null;
    
    const width = pos.spreadWidth || Math.abs(pos.sellStrike - pos.buyStrike);
    const maxProfitPerShare = pos.type.includes('credit') ? pos.premium : (width - pos.premium);
    const maxLossPerShare = pos.type.includes('debit') ? pos.premium : (width - pos.premium);
    const totalMaxProfit = maxProfitPerShare * 100 * (pos.contracts || 1);
    const totalMaxLoss = maxLossPerShare * 100 * (pos.contracts || 1);
    const breakeven = pos.breakeven || calculateSpreadBreakeven(pos.type, pos.buyStrike, pos.sellStrike, pos.premium);
    
    const explanations = {
        'call_debit_spread': {
            name: 'Call Debit Spread (Bull Call Spread)',
            direction: 'BULLISH',
            setup: `Buy $${pos.buyStrike} Call / Sell $${pos.sellStrike} Call`,
            cost: `Net Debit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} total)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes at or above $${pos.sellStrike} at expiry)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes at or below $${pos.buyStrike} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must rise above this to profit)`,
            howItWorks: `You paid $${pos.premium.toFixed(2)}/share for the right to profit if ${pos.ticker} goes up. Your profit is capped at $${pos.sellStrike} because you sold that call. The trade-off: lower cost than buying a naked call, but capped upside.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to make $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'put_debit_spread': {
            name: 'Put Debit Spread (Bear Put Spread)',
            direction: 'BEARISH',
            setup: `Buy $${Math.max(pos.buyStrike, pos.sellStrike)} Put / Sell $${Math.min(pos.buyStrike, pos.sellStrike)} Put`,
            cost: `Net Debit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} total)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes at or below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes at or above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must fall below this to profit)`,
            howItWorks: `You paid $${pos.premium.toFixed(2)}/share for the right to profit if ${pos.ticker} goes down. Your profit is capped because you sold the lower strike put.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to make $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'call_credit_spread': {
            name: 'Call Credit Spread (Bear Call Spread)',
            direction: 'BEARISH',
            setup: `Sell $${Math.min(pos.buyStrike, pos.sellStrike)} Call / Buy $${Math.max(pos.buyStrike, pos.sellStrike)} Call`,
            cost: `Net Credit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} received)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry - keep full premium)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must stay below this to profit)`,
            howItWorks: `You received $${pos.premium.toFixed(2)}/share upfront. You keep it all if ${pos.ticker} stays below $${Math.min(pos.buyStrike, pos.sellStrike)}. The long call at $${Math.max(pos.buyStrike, pos.sellStrike)} limits your max loss.`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to keep $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        },
        'put_credit_spread': {
            name: 'Put Credit Spread (Bull Put Spread)',
            direction: 'BULLISH',
            setup: `Sell $${Math.max(pos.buyStrike, pos.sellStrike)} Put / Buy $${Math.min(pos.buyStrike, pos.sellStrike)} Put`,
            cost: `Net Credit: $${pos.premium.toFixed(2)}/share ($${(pos.premium * 100 * pos.contracts).toFixed(0)} received)`,
            maxProfit: `$${totalMaxProfit.toFixed(0)} (if ${pos.ticker} closes above $${Math.max(pos.buyStrike, pos.sellStrike)} at expiry - keep full premium)`,
            maxLoss: `$${totalMaxLoss.toFixed(0)} (if ${pos.ticker} closes below $${Math.min(pos.buyStrike, pos.sellStrike)} at expiry)`,
            breakeven: `$${breakeven.toFixed(2)} (${pos.ticker} must stay above this to profit)`,
            howItWorks: `You received $${pos.premium.toFixed(2)}/share upfront. You keep it all if ${pos.ticker} stays above $${Math.max(pos.buyStrike, pos.sellStrike)}. The long put at $${Math.min(pos.buyStrike, pos.sellStrike)} limits your max loss. This is the "Wheel-adjacent" bullish strategy!`,
            riskReward: `Risk $${totalMaxLoss.toFixed(0)} to keep $${totalMaxProfit.toFixed(0)} = ${(totalMaxProfit/totalMaxLoss).toFixed(1)}:1 reward/risk`
        }
    };
    
    return explanations[pos.type] || null;
}

/**
 * Check if a position has roll history (other positions in its chain)
 */
function hasRollHistory(pos) {
    const chainId = pos.chainId || pos.id;
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    return allPositions.filter(p => (p.chainId || p.id) === chainId).length > 1;
}

/**
 * Show roll history modal for a position chain
 */
window.showRollHistory = function(chainId) {
    // Find all positions in this chain (open + closed)
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    const chainPositions = allPositions
        .filter(p => (p.chainId || p.id) === chainId)
        .sort((a, b) => new Date(a.openDate || 0) - new Date(b.openDate || 0));
    
    if (chainPositions.length === 0) {
        console.error('No positions found for chain:', chainId);
        return;
    }
    
    // Calculate total premium collected across the chain
    const totalPremium = chainPositions.reduce((sum, p) => sum + (p.premium * 100 * p.contracts), 0);
    const ticker = chainPositions[0]?.ticker || 'Unknown';
    
    const modal = document.createElement('div');
    modal.id = 'rollHistoryModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build timeline HTML
    let timelineHtml = '';
    chainPositions.forEach((pos, idx) => {
        const isOpen = pos.status === 'open';
        const isCurrent = idx === chainPositions.length - 1 && isOpen;
        const statusColor = isOpen ? '#00ff88' : '#888';
        const statusText = isOpen ? 'OPEN' : (pos.closeReason || 'CLOSED');
        const premium = pos.premium * 100 * pos.contracts;
        
        // Determine if debit or credit
        const isDebit = pos.type?.includes('debit');
        const premiumColor = isDebit ? '#ff5252' : '#00ff88';
        const premiumSign = isDebit ? '-' : '+';
        
        // Strike display
        let strikeDisplay = '';
        if (pos.type?.includes('_spread')) {
            strikeDisplay = `$${pos.buyStrike}/$${pos.sellStrike}`;
        } else {
            strikeDisplay = `$${pos.strike}`;
        }
        
        timelineHtml += `
            <div style="display:flex; align-items:flex-start; gap:15px; padding:15px 0; 
                        ${idx < chainPositions.length - 1 ? 'border-bottom:1px solid #333;' : ''}">
                <div style="width:30px; text-align:center;">
                    <div style="width:12px; height:12px; border-radius:50%; 
                                background:${isCurrent ? '#00d9ff' : statusColor}; 
                                margin:4px auto;
                                ${isCurrent ? 'box-shadow: 0 0 10px #00d9ff;' : ''}"></div>
                    ${idx < chainPositions.length - 1 ? `
                    <div style="width:2px; height:30px; background:#333; margin:0 auto;"></div>
                    ` : ''}
                </div>
                <div style="flex:1;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="color:#fff; font-weight:bold;">
                            ${idx === 0 ? '🎬 Original' : '🔄 Roll #' + idx}
                        </span>
                        <span style="color:${statusColor}; font-size:11px; padding:2px 8px; 
                                     background:${statusColor}22; border-radius:10px;">
                            ${statusText}
                        </span>
                    </div>
                    <div style="color:#aaa; font-size:13px;">
                        <span style="color:#888;">${pos.type?.replace(/_/g, ' ').toUpperCase() || 'PUT'}</span>
                        &nbsp;•&nbsp; Strike: <span style="color:#fff;">${strikeDisplay}</span>
                        &nbsp;•&nbsp; Exp: <span style="color:#fff;">${pos.expiry || 'N/A'}</span>
                    </div>
                    <div style="margin-top:6px; display:flex; gap:20px; font-size:12px;">
                        <span>Premium: <span style="color:${premiumColor}; font-weight:bold;">${premiumSign}$${premium.toFixed(0)}</span></span>
                        ${pos.openDate ? `<span style="color:#666;">Opened: ${pos.openDate}</span>` : ''}
                        ${pos.closeDate ? `<span style="color:#666;">Closed: ${pos.closeDate}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #0096ff; 
                    border-radius:16px; padding:30px; width:90%; max-width:550px; max-height:85vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 150, 255, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:25px;">
                <span style="font-size:32px;">🔗</span>
                <div>
                    <h2 style="margin:0; color:#fff; font-size:20px;">Roll History: ${ticker}</h2>
                    <div style="color:#888; font-size:13px;">${chainPositions.length} position${chainPositions.length > 1 ? 's' : ''} in chain</div>
                </div>
            </div>
            
            <div style="background:#0d0d1a; border-radius:10px; padding:20px; margin-bottom:20px;">
                ${timelineHtml}
            </div>
            
            <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); 
                        border-radius:10px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="color:#888; font-size:11px; margin-bottom:4px;">TOTAL PREMIUM COLLECTED</div>
                <div style="color:#00ff88; font-size:24px; font-weight:bold;">$${totalPremium.toFixed(0)}</div>
            </div>
            
            <div style="display:flex; justify-content:center;">
                <button onclick="document.getElementById('rollHistoryModal').remove()" 
                        style="background:#0096ff; border:none; color:#fff; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;">
                    Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Show AI-style spread explanation modal
 */
window.showSpreadExplanation = function(posId) {
    const pos = state.positions?.find(p => p.id === posId) || 
                state.closedPositions?.find(p => p.id === posId);
    
    if (!pos) {
        console.error('Position not found:', posId);
        return;
    }
    
    const explanation = getSpreadExplanation(pos);
    if (!explanation) {
        console.error('No spread explanation for:', pos.type);
        return;
    }
    
    // Determine direction color
    const dirColor = explanation.direction === 'BULLISH' ? '#00ff88' : '#ff5252';
    const dirEmoji = explanation.direction === 'BULLISH' ? '📈' : '📉';
    
    const modal = document.createElement('div');
    modal.id = 'spreadExplanationModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #8b5cf6; 
                    border-radius:16px; padding:30px; width:90%; max-width:600px; max-height:90vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(139, 92, 246, 0.3);">
            
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
                <span style="font-size:32px;">🤖</span>
                <div>
                    <h2 style="margin:0; color:#fff; font-size:20px;">${explanation.name}</h2>
                    <div style="color:#888; font-size:13px;">${pos.ticker} • ${pos.contracts} contract${pos.contracts > 1 ? 's' : ''} • Exp: ${pos.expiry}</div>
                </div>
                <span style="margin-left:auto; background:${dirColor}22; color:${dirColor}; 
                             padding:6px 14px; border-radius:20px; font-weight:bold; font-size:13px;">
                    ${dirEmoji} ${explanation.direction}
                </span>
            </div>
            
            <div style="background:#0d0d1a; border-radius:10px; padding:20px; margin-bottom:20px;">
                <div style="color:#8b5cf6; font-weight:bold; margin-bottom:8px; font-size:12px; text-transform:uppercase;">
                    📋 Setup
                </div>
                <div style="color:#fff; font-size:16px; font-weight:bold;">${explanation.setup}</div>
                <div style="color:#888; font-size:14px; margin-top:6px;">${explanation.cost}</div>
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:20px;">
                <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:#00ff88; font-size:12px; font-weight:bold; margin-bottom:6px;">💰 MAX PROFIT</div>
                    <div style="color:#fff; font-size:14px;">${explanation.maxProfit}</div>
                </div>
                <div style="background:rgba(255,82,82,0.1); border:1px solid rgba(255,82,82,0.3); 
                            border-radius:10px; padding:15px;">
                    <div style="color:#ff5252; font-size:12px; font-weight:bold; margin-bottom:6px;">⚠️ MAX LOSS</div>
                    <div style="color:#fff; font-size:14px;">${explanation.maxLoss}</div>
                </div>
            </div>
            
            <div style="background:#0d0d1a; border-radius:10px; padding:15px; margin-bottom:20px;">
                <div style="color:#ffaa00; font-size:12px; font-weight:bold; margin-bottom:6px;">🎯 BREAKEVEN</div>
                <div style="color:#fff; font-size:14px;">${explanation.breakeven}</div>
            </div>
            
            <div style="background:linear-gradient(135deg, #1e1e3f 0%, #2a1f4e 100%); 
                        border-radius:10px; padding:20px; margin-bottom:20px;">
                <div style="color:#b9f; font-size:12px; font-weight:bold; margin-bottom:10px;">
                    🧠 HOW THIS TRADE WORKS
                </div>
                <div style="color:#ddd; font-size:14px; line-height:1.6;">${explanation.howItWorks}</div>
            </div>
            
            <div style="background:rgba(139,92,246,0.15); border:1px solid rgba(139,92,246,0.4); 
                        border-radius:10px; padding:15px; margin-bottom:20px; text-align:center;">
                <div style="color:#8b5cf6; font-size:14px; font-weight:bold;">${explanation.riskReward}</div>
            </div>
            
            <div style="display:flex; justify-content:center;">
                <button onclick="document.getElementById('spreadExplanationModal').remove()" 
                        style="background:#8b5cf6; border:none; color:#fff; padding:12px 40px; 
                               border-radius:8px; cursor:pointer; font-weight:bold; font-size:14px;
                               transition: all 0.2s;">
                    Got it! 👍
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Save a checkpoint of data counts - used to detect data loss
 */
function saveDataCheckpoint() {
    const checkpoint = {
        positions: (state.positions || []).length,
        holdings: (state.holdings || []).length,
        closedPositions: (state.closedPositions || []).length,
        timestamp: Date.now()
    };
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

/**
 * Check for data loss on startup
 */
function checkDataIntegrity() {
    const checkpointStr = localStorage.getItem(CHECKPOINT_KEY);
    if (!checkpointStr) return; // No checkpoint, first run
    
    try {
        const checkpoint = JSON.parse(checkpointStr);
        const currentClosed = (state.closedPositions || []).length;
        const expectedClosed = checkpoint.closedPositions || 0;
        
        // If we had closed positions but now have none/fewer, warn user
        if (expectedClosed > 5 && currentClosed < expectedClosed * 0.5) {
            console.warn(`⚠️ Data integrity warning: Expected ${expectedClosed} closed positions, found ${currentClosed}`);
            
            // Show recovery prompt
            setTimeout(() => {
                showDataRecoveryPrompt(expectedClosed, currentClosed);
            }, 500);
        }
    } catch (e) {
        console.warn('Checkpoint check failed:', e);
    }
}

/**
 * Show data recovery prompt to user
 */
function showDataRecoveryPrompt(expected, actual) {
    const msg = `⚠️ Data Loss Detected!\n\nExpected ${expected} closed positions but found only ${actual}.\n\nYour browser localStorage may have been cleared.\n\nClick "Import" to restore from your backup file:\n📁 C:\\WheelHouse\\examples\\wheelhouse_backup_2026-01-16 (1).json`;
    
    // Create a prominent banner
    const banner = document.createElement('div');
    banner.id = 'dataRecoveryBanner';
    banner.innerHTML = `
        <div style="background: linear-gradient(135deg, #ff5252, #ff1744); color: white; padding: 15px 20px; 
                    position: fixed; top: 0; left: 0; right: 0; z-index: 10000; 
                    display: flex; justify-content: space-between; align-items: center;
                    box-shadow: 0 4px 20px rgba(255,82,82,0.5);">
            <div>
                <strong>⚠️ Data Loss Detected!</strong> 
                Expected ${expected} closed positions, found ${actual}. 
                Your localStorage may have been cleared.
            </div>
            <div style="display: flex; gap: 10px;">
                <button onclick="document.getElementById('importBtn')?.click(); document.getElementById('dataRecoveryBanner')?.remove();" 
                        style="background: white; color: #ff1744; border: none; padding: 8px 16px; 
                               border-radius: 4px; font-weight: bold; cursor: pointer;">
                    📥 Restore from Backup
                </button>
                <button onclick="document.getElementById('dataRecoveryBanner')?.remove(); localStorage.setItem('${CHECKPOINT_KEY}', JSON.stringify({closedPositions: ${actual}, timestamp: Date.now()}));" 
                        style="background: transparent; color: white; border: 1px solid white; 
                               padding: 8px 16px; border-radius: 4px; cursor: pointer;">
                    ✕ Dismiss
                </button>
            </div>
        </div>
    `;
    document.body.prepend(banner);
}

/**
 * Load positions from localStorage
 */
export function loadPositions() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            state.positions = JSON.parse(saved) || [];
        } else {
            state.positions = [];
        }
    } catch (e) {
        console.warn('Failed to load positions:', e);
        state.positions = [];
    }
    
    // Load holdings (share ownership from assignments)
    try {
        const savedHoldings = localStorage.getItem(HOLDINGS_KEY);
        if (savedHoldings) {
            state.holdings = JSON.parse(savedHoldings) || [];
        } else {
            state.holdings = [];
        }
    } catch (e) {
        console.warn('Failed to load holdings:', e);
        state.holdings = [];
    }
    
    // Load closed positions
    try {
        const savedClosed = localStorage.getItem(CLOSED_KEY);
        if (savedClosed) {
            state.closedPositions = JSON.parse(savedClosed) || [];
        } else {
            state.closedPositions = [];
        }
    } catch (e) {
        console.warn('Failed to load closed positions:', e);
        state.closedPositions = [];
    }
    
    // Check for data loss
    checkDataIntegrity();
    
    renderPositions();
    updatePortfolioSummary();
}

// Auto-save file handle (File System Access API)
let autoSaveFileHandle = null;
let autoSaveDebounceTimer = null;

/**
 * Save positions to localStorage AND auto-save file if enabled
 */
export function savePositionsToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.positions));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save positions:', e);
    }
}

/**
 * Save holdings to localStorage AND auto-save file if enabled
 */
export function saveHoldingsToStorage() {
    try {
        localStorage.setItem(HOLDINGS_KEY, JSON.stringify(state.holdings));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save holdings:', e);
    }
}

/**
 * Save closed positions to localStorage (call this whenever closedPositions changes)
 */
export function saveClosedToStorage() {
    try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify(state.closedPositions));
        saveDataCheckpoint(); // Track data count for integrity check
        triggerAutoSave();
    } catch (e) {
        console.warn('Failed to save closed positions:', e);
    }
}

/**
 * Trigger auto-save with debounce (waits 2 seconds after last change)
 */
function triggerAutoSave() {
    if (!autoSaveFileHandle) return;
    
    // Debounce - wait for activity to stop
    if (autoSaveDebounceTimer) clearTimeout(autoSaveDebounceTimer);
    autoSaveDebounceTimer = setTimeout(() => {
        performAutoSave();
    }, 2000);
}

// Expose for portfolio.js to call
window.triggerAutoSave = triggerAutoSave;

/**
 * Actually write to the auto-save file
 */
async function performAutoSave() {
    if (!autoSaveFileHandle) return;
    
    try {
        const CLOSED_KEY = 'wheelhouse_closed_positions';
        const exportData = {
            version: 1,
            exportDate: new Date().toISOString(),
            positions: state.positions || [],
            holdings: state.holdings || [],
            closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
        };
        
        const writable = await autoSaveFileHandle.createWritable();
        await writable.write(JSON.stringify(exportData, null, 2));
        await writable.close();
        
        // Update status indicator
        updateAutoSaveStatus('saved');
        console.log('✅ Auto-saved to file');
    } catch (e) {
        console.warn('Auto-save failed:', e);
        updateAutoSaveStatus('error');
    }
}

/**
 * Setup auto-save - user picks a file location
 */
export async function setupAutoSave() {
    try {
        // Check if File System Access API is supported
        if (!('showSaveFilePicker' in window)) {
            showNotification('❌ Auto-save not supported in this browser. Use Chrome or Edge.', 'error');
            return;
        }
        
        const handle = await window.showSaveFilePicker({
            suggestedName: 'wheelhouse_autosave.json',
            types: [{
                description: 'JSON Files',
                accept: { 'application/json': ['.json'] }
            }]
        });
        
        autoSaveFileHandle = handle;
        
        // Do an immediate save
        await performAutoSave();
        
        updateAutoSaveStatus('enabled');
        showNotification('✅ Auto-save enabled! Your data will be saved automatically.', 'success', 4000);
        
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error('Setup auto-save failed:', e);
            showNotification('❌ Failed to setup auto-save: ' + e.message, 'error');
        }
    }
}

/**
 * Update the auto-save status indicator in UI
 */
function updateAutoSaveStatus(status) {
    const indicator = document.getElementById('autoSaveStatus');
    if (!indicator) return;
    
    switch (status) {
        case 'enabled':
            indicator.textContent = '🟢 Auto-save ON';
            indicator.style.color = '#00ff88';
            break;
        case 'saved':
            indicator.textContent = '🟢 Saved ' + new Date().toLocaleTimeString();
            indicator.style.color = '#00ff88';
            break;
        case 'error':
            indicator.textContent = '🔴 Save failed';
            indicator.style.color = '#ff5252';
            break;
        default:
            indicator.textContent = '⚪ Auto-save OFF';
            indicator.style.color = '#888';
    }
}

window.setupAutoSave = setupAutoSave;

/**
 * Add or update a position
 */
export function addPosition() {
    const ticker = document.getElementById('posTicker').value.toUpperCase().trim();
    const type = document.getElementById('posType').value;
    const strike = parseFloat(document.getElementById('posStrike').value);
    const premium = parseFloat(document.getElementById('posPremium').value);
    const contracts = parseInt(document.getElementById('posContracts').value) || 1;
    const expiry = document.getElementById('posExpiry').value;
    const openDateInput = document.getElementById('posOpenDate').value;
    const openDate = openDateInput || new Date().toISOString().split('T')[0]; // Default to today
    const broker = document.getElementById('posBroker')?.value || 'Schwab';
    const delta = parseFloat(document.getElementById('posDelta')?.value) || null;
    
    // Buy/Write specific: stock purchase price
    const stockPriceInput = document.getElementById('posStockPrice');
    const stockPrice = stockPriceInput ? parseFloat(stockPriceInput.value) || null : null;
    
    // Spread specific fields
    const isSpread = type.includes('_spread');
    const buyStrike = isSpread ? parseFloat(document.getElementById('posBuyStrike')?.value) || null : null;
    const sellStrike = isSpread ? parseFloat(document.getElementById('posSellStrike')?.value) || null : null;
    
    // Validation for spreads
    if (isSpread) {
        if (!ticker || !buyStrike || !sellStrike || !premium || !expiry) {
            showNotification('Please fill in all spread fields', 'error');
            return;
        }
        if (buyStrike === sellStrike) {
            showNotification('Buy and Sell strikes must be different', 'error');
            return;
        }
    } else if (!ticker || !strike || !premium || !expiry) {
        showNotification('Please fill in all fields', 'error');
        return;
    }
    
    // Validate Buy/Write has stock price
    if (type === 'buy_write' && !stockPrice) {
        showNotification('Buy/Write requires stock purchase price', 'error');
        return;
    }
    
    const today = new Date();
    const expiryDate = new Date(expiry);
    const dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    
    // Check if we're editing an existing position
    if (state.editingPositionId !== null) {
        const idx = state.positions.findIndex(p => p.id === state.editingPositionId);
        if (idx !== -1) {
            // Update existing position
            state.positions[idx] = {
                ...state.positions[idx],
                ticker,
                type,
                strike: isSpread ? null : strike,
                premium,
                contracts,
                expiry,
                dte,
                openDate,
                broker,
                delta,
                // Buy/Write specific fields
                ...(type === 'buy_write' ? { stockPrice, costBasis: stockPrice - premium } : {}),
                // Spread specific fields
                ...(isSpread ? { buyStrike, sellStrike, spreadWidth: Math.abs(sellStrike - buyStrike) } : {})
            };
            showNotification(`Updated ${ticker} ${type.replace(/_/g, ' ')} position`, 'success');
        }
        state.editingPositionId = null;
        updateAddButtonState();
    } else {
        // Create new position with a new chainId (fresh position, not a roll)
        const position = {
            id: Date.now(),
            chainId: Date.now(), // Each new position starts its own chain
            ticker,
            type,
            strike: isSpread ? null : strike,
            premium,
            contracts,
            expiry,
            dte,
            openDate,
            broker,
            delta,
            status: 'open',
            currentSpot: null,
            // Buy/Write specific fields
            ...(type === 'buy_write' ? { stockPrice, costBasis: stockPrice - premium } : {}),
            // Spread specific fields
            ...(isSpread ? { 
                buyStrike, 
                sellStrike, 
                spreadWidth: Math.abs(sellStrike - buyStrike),
                maxProfit: type.includes('credit') ? premium * 100 * contracts : (Math.abs(sellStrike - buyStrike) - premium) * 100 * contracts,
                maxLoss: type.includes('debit') ? premium * 100 * contracts : (Math.abs(sellStrike - buyStrike) - premium) * 100 * contracts,
                breakeven: calculateSpreadBreakeven(type, buyStrike, sellStrike, premium)
            } : {})
        };
        
        // For Buy/Write, also add to holdings automatically
        if (type === 'buy_write') {
            const shares = contracts * 100;
            const existingHolding = state.holdings.find(h => h.ticker === ticker);
            if (existingHolding) {
                // Average into existing holding
                const totalShares = existingHolding.shares + shares;
                const totalCost = (existingHolding.costBasis * existingHolding.shares) + (stockPrice * shares);
                existingHolding.shares = totalShares;
                existingHolding.costBasis = totalCost / totalShares;
            } else {
                state.holdings.push({
                    id: Date.now() + 1,
                    ticker,
                    shares,
                    costBasis: stockPrice,
                    acquiredDate: openDate,
                    source: 'buy_write'
                });
            }
            localStorage.setItem(HOLDINGS_KEY, JSON.stringify(state.holdings));
        }
        
        state.positions.push(position);
        showNotification(`Added ${ticker} ${type} position`, 'success');
    }
    
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    // Clear form
    document.getElementById('posTicker').value = '';
    document.getElementById('posStrike').value = '';
    document.getElementById('posPremium').value = '';
    document.getElementById('posContracts').value = '1';
    document.getElementById('posOpenDate').value = '';
    if (document.getElementById('posBroker')) document.getElementById('posBroker').value = 'Schwab';
    if (document.getElementById('posDelta')) document.getElementById('posDelta').value = '';
    if (document.getElementById('posStockPrice')) document.getElementById('posStockPrice').value = '';
    // Clear spread fields
    if (document.getElementById('posBuyStrike')) document.getElementById('posBuyStrike').value = '';
    if (document.getElementById('posSellStrike')) document.getElementById('posSellStrike').value = '';
    // Reset position type to default
    document.getElementById('posType').value = 'short_put';
    togglePositionTypeFields();
}

/**
 * Edit an existing position - load into form
 */
export function editPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    const isSpread = pos.type?.includes('_spread');
    
    // Populate form with position data
    document.getElementById('posTicker').value = pos.ticker;
    document.getElementById('posType').value = pos.type;
    document.getElementById('posStrike').value = isSpread ? '' : pos.strike;
    document.getElementById('posPremium').value = pos.premium;
    document.getElementById('posContracts').value = pos.contracts;
    document.getElementById('posExpiry').value = pos.expiry;
    document.getElementById('posOpenDate').value = pos.openDate || '';
    if (document.getElementById('posBroker')) document.getElementById('posBroker').value = pos.broker || 'Schwab';
    if (document.getElementById('posDelta')) document.getElementById('posDelta').value = pos.delta || '';
    
    // Handle spread fields
    if (isSpread) {
        if (document.getElementById('posBuyStrike')) document.getElementById('posBuyStrike').value = pos.buyStrike || '';
        if (document.getElementById('posSellStrike')) document.getElementById('posSellStrike').value = pos.sellStrike || '';
    }
    
    // Update form visibility for the position type
    togglePositionTypeFields();
    
    // Track that we're editing
    state.editingPositionId = id;
    updateAddButtonState();
    
    showNotification(`Editing ${pos.ticker} position - make changes and click Update`, 'info');
}

/**
 * Roll a position - show roll form panel
 */
export function rollPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    // Store which position we're rolling
    state.rollingPositionId = id;
    
    // Show the roll panel
    const rollPanel = document.getElementById('rollPanel');
    if (!rollPanel) return;
    
    rollPanel.style.display = 'block';
    
    // Populate current position info
    const infoEl = document.getElementById('rollCurrentInfo');
    if (infoEl) {
        infoEl.innerHTML = `
            <strong style="color:#ce93d8;">${pos.ticker}</strong> ${pos.type.replace('_', ' ').toUpperCase()}<br>
            Strike: <strong>$${pos.strike.toFixed(2)}</strong> | 
            Premium: <strong>$${pos.premium.toFixed(2)}</strong> | 
            Contracts: <strong>${pos.contracts}</strong> | 
            DTE: <strong>${pos.dte}d</strong>
        `;
    }
    
    // Pre-fill form with sensible defaults
    document.getElementById('rollClosingPrice').value = '0.00';
    document.getElementById('rollNewStrikeInput').value = pos.strike.toFixed(2);
    document.getElementById('rollNewPremium').value = pos.premium.toFixed(2);
    document.getElementById('rollNewExpiryInput').value = '';
    
    // Hide net display until calculated
    document.getElementById('rollNetDisplay').style.display = 'none';
    
    // Setup live net credit/debit calculation
    setupRollCalculation(pos);
    
    showNotification(`Rolling ${pos.ticker} - fill in new position details`, 'info');
}
window.rollPosition = rollPosition;

/**
 * Setup live calculation of roll net credit/debit
 */
function setupRollCalculation(pos) {
    const closingEl = document.getElementById('rollClosingPrice');
    const premiumEl = document.getElementById('rollNewPremium');
    const netDisplay = document.getElementById('rollNetDisplay');
    const netValueEl = document.getElementById('rollNetValue');
    
    const calculate = () => {
        const closingPrice = parseFloat(closingEl.value) || 0;
        const newPremium = parseFloat(premiumEl.value) || 0;
        const netCredit = newPremium - closingPrice;
        
        netDisplay.style.display = 'block';
        if (netCredit >= 0) {
            netValueEl.innerHTML = `<span style="color:#00ff88;">+$${netCredit.toFixed(2)} credit</span>`;
        } else {
            netValueEl.innerHTML = `<span style="color:#ff5252;">-$${Math.abs(netCredit).toFixed(2)} debit</span>`;
        }
    };
    
    closingEl.addEventListener('input', calculate);
    premiumEl.addEventListener('input', calculate);
}

/**
 * Execute the roll - close old position, create new one
 */
export function executeRoll() {
    const id = state.rollingPositionId;
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('No position selected for roll', 'error');
        return;
    }
    
    const closingPrice = parseFloat(document.getElementById('rollClosingPrice').value);
    const newStrike = parseFloat(document.getElementById('rollNewStrikeInput').value);
    const newPremium = parseFloat(document.getElementById('rollNewPremium').value);
    const newExpiry = document.getElementById('rollNewExpiryInput').value;
    
    if (isNaN(closingPrice) || closingPrice < 0) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    if (isNaN(newStrike) || newStrike <= 0) {
        showNotification('Invalid new strike', 'error');
        return;
    }
    if (isNaN(newPremium) || newPremium < 0) {
        showNotification('Invalid new premium', 'error');
        return;
    }
    if (!newExpiry) {
        showNotification('Please select new expiry date', 'error');
        return;
    }
    
    // Calculate P&L on old position
    const today = new Date().toISOString().split('T')[0];
    const premiumReceived = pos.premium * 100 * pos.contracts;
    const closingCost = closingPrice * 100 * pos.contracts;
    const realizedPnL = premiumReceived - closingCost;
    
    const openDate = new Date(pos.openDate || today);
    const closeDate = new Date(today);
    const daysHeld = Math.max(0, Math.ceil((closeDate - openDate) / (1000 * 60 * 60 * 24)));
    
    // Close old position
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...pos,
        closeDate: today,
        daysHeld,
        closingPrice,
        realizedPnL,
        chainId: pos.chainId || pos.id, // Preserve chain ID
        rolledTo: `$${newStrike.toFixed(0)} exp ${newExpiry}`
    });
    saveClosedToStorage();
    
    // Remove old from open
    state.positions = state.positions.filter(p => p.id !== id);
    
    // Add new position - inherit the same chainId
    const expiryDate = new Date(newExpiry);
    const dte = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
    
    const newPosition = {
        id: Date.now(),
        chainId: pos.chainId || pos.id, // Inherit chain ID from previous position
        ticker: pos.ticker,
        type: pos.type,
        strike: newStrike,
        premium: newPremium,
        contracts: pos.contracts,
        expiry: newExpiry,
        dte,
        openDate: today,
        status: 'open',
        currentSpot: pos.currentSpot,
        rolledFrom: `$${pos.strike.toFixed(0)} @ $${pos.premium.toFixed(2)}`
    };
    state.positions.push(newPosition);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Calculate net credit/debit on roll
    const netCredit = newPremium - closingPrice;
    const netStr = netCredit >= 0 ? `+$${netCredit.toFixed(2)} credit` : `-$${Math.abs(netCredit).toFixed(2)} debit`;
    
    showNotification(
        `Rolled ${pos.ticker}: $${pos.strike} → $${newStrike} (${netStr})`, 
        netCredit >= 0 ? 'success' : 'warning'
    );
    
    // Hide roll panel and reset
    cancelRoll();
    
    renderPositions();
    updatePortfolioSummary();
}
window.executeRoll = executeRoll;

/**
 * Cancel roll and hide panel
 */
export function cancelRoll() {
    state.rollingPositionId = null;
    const rollPanel = document.getElementById('rollPanel');
    if (rollPanel) rollPanel.style.display = 'none';
}
window.cancelRoll = cancelRoll;

/**
 * Cancel editing and reset form
 */
export function cancelEdit() {
    state.editingPositionId = null;
    updateAddButtonState();
    
    // Clear form
    document.getElementById('posTicker').value = '';
    document.getElementById('posStrike').value = '';
    document.getElementById('posPremium').value = '';
    document.getElementById('posContracts').value = '1';
    
    showNotification('Edit cancelled', 'info');
}

/**
 * Update the Add/Update button text based on edit state
 */
function updateAddButtonState() {
    const btn = document.getElementById('addPositionBtn');
    const cancelBtn = document.getElementById('cancelEditBtn');
    
    if (state.editingPositionId !== null) {
        if (btn) {
            btn.textContent = '✓ Update Position';
            btn.style.background = '#00d9ff';
        }
        if (cancelBtn) cancelBtn.style.display = 'block';
    } else {
        if (btn) {
            btn.textContent = '➕ Add Position';
            btn.style.background = '';
        }
        if (cancelBtn) cancelBtn.style.display = 'none';
    }
}

/**
 * Delete a position
 */
export function deletePosition(id) {
    const idx = state.positions.findIndex(p => p.id === id);
    if (idx === -1) return;
    
    const pos = state.positions[idx];
    
    // Save undo state BEFORE deleting
    state.lastAction = {
        type: 'delete',
        position: {...pos},
        timestamp: Date.now()
    };
    
    state.positions.splice(idx, 1);
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    showUndoNotification(`Deleted ${pos.ticker} position`, 'warning');
}

/**
 * Close a position (mark as closed with P&L)
 */
export function closePosition(id, closePrice) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    pos.status = 'closed';
    pos.closePrice = closePrice;
    pos.closeDate = new Date().toISOString().split('T')[0];
    pos.realizedPnL = (pos.premium - closePrice) * 100 * pos.contracts;
    
    savePositionsToStorage();
    renderPositions();
    updatePortfolioSummary();
    
    showNotification(`Closed ${pos.ticker} for ${pos.realizedPnL >= 0 ? 'profit' : 'loss'}`, 
                    pos.realizedPnL >= 0 ? 'success' : 'warning');
}

/**
 * Load position data into analyzer
 */
export function loadPositionToAnalyze(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    // Set position context for analysis
    setPositionContext({
        id: pos.id,
        ticker: pos.ticker,
        type: pos.type,
        strike: pos.strike,
        premium: pos.premium,
        contracts: pos.contracts,
        expiry: pos.expiry,
        dte: pos.dte
    });
    
    // Update form fields
    document.getElementById('strikeInput').value = pos.strike;
    document.getElementById('strikeSlider').value = pos.strike;
    state.strike = pos.strike;
    
    // Update DTE
    const today = new Date();
    const expiryDate = new Date(pos.expiry);
    const dte = Math.max(1, Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24)));
    document.getElementById('dteSlider').value = Math.min(dte, 365);
    document.getElementById('dteInput').value = dte;
    state.dte = dte;
    
    // Update BARRIERS based on position type
    // SHORT PUT: Lower barrier = Strike (assignment level), Upper = spot + 20%
    // SHORT CALL: Lower = spot - 20%, Upper barrier = Strike (assignment level)
    const isPut = pos.type.includes('put');
    const estimatedSpot = pos.strike * 1.05; // Rough estimate until price fetches
    
    if (isPut) {
        state.lower = pos.strike;  // Strike is assignment level for puts
        state.upper = Math.round(estimatedSpot * 1.20);
    } else {
        state.lower = Math.round(estimatedSpot * 0.80);
        state.upper = pos.strike;  // Strike is assignment level for calls
    }
    
    // Update barrier UI
    const lowerSlider = document.getElementById('lowerSlider');
    const lowerInput = document.getElementById('lowerInput');
    const upperSlider = document.getElementById('upperSlider');
    const upperInput = document.getElementById('upperInput');
    
    if (lowerSlider) lowerSlider.value = state.lower;
    if (lowerInput) lowerInput.value = state.lower;
    if (upperSlider) upperSlider.value = state.upper;
    if (upperInput) upperInput.value = state.upper;
    
    // Fetch current price (this will update spot and recalculate barriers)
    fetchPositionTickerPrice(pos.ticker);
    
    // Switch to Options tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.querySelector('[data-tab="options"]').classList.add('active');
    document.getElementById('options').classList.add('active');
    
    // Update position info display
    const posInfo = document.getElementById('positionInfo');
    if (posInfo) {
        posInfo.innerHTML = `
            <div style="background: #1a1a2e; padding: 10px; border-radius: 6px; margin-bottom: 15px; border-left: 3px solid #00d9ff;">
                <div style="color: #00d9ff; font-weight: bold; margin-bottom: 5px;">Analyzing Position:</div>
                <div style="color: #fff;">${pos.ticker} ${pos.type.toUpperCase()} @ $${pos.strike} (${pos.contracts} contract${pos.contracts > 1 ? 's' : ''})</div>
                <div style="color: #888; font-size: 12px;">Premium: $${pos.premium.toFixed(2)} | Expires: ${pos.expiry}</div>
            </div>
        `;
    }
    
    // Draw the payoff chart with updated state values
    drawPayoffChart();
    
    showNotification(`Loaded ${pos.ticker} ${pos.type} for analysis`, 'info');
}

/**
 * Render positions table
 */
export function renderPositions() {
    const container = document.getElementById('positionsTable');
    if (!container) return;
    
    // Ensure positions is an array
    if (!Array.isArray(state.positions)) {
        state.positions = [];
    }
    
    const openPositions = state.positions.filter(p => p.status === 'open');
    
    if (openPositions.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #666; padding: 40px;">
                <div style="font-size: 48px; margin-bottom: 10px;">📋</div>
                <div>No open positions</div>
                <div style="font-size: 12px; margin-top: 5px;">Add positions using the form above</div>
            </div>
        `;
        return;
    }
    
    // Update DTE for each position
    const today = new Date();
    openPositions.forEach(pos => {
        const expiryDate = new Date(pos.expiry);
        pos.dte = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    });
    
    // Sort by DTE
    openPositions.sort((a, b) => a.dte - b.dte);
    
    let html = `
        <table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed;">
            <thead>
                <tr style="background: #1a1a2e; color: #888;">
                    <th style="padding: 6px; text-align: left; width: 55px;">Ticker</th>
                    <th style="padding: 6px; text-align: left; width: 60px;">Broker</th>
                    <th style="padding: 6px; text-align: left; width: 70px;">Type</th>
                    <th style="padding: 6px; text-align: right; width: 50px;">Strike</th>
                    <th style="padding: 6px; text-align: right; width: 45px;">Prem</th>
                    <th style="padding: 6px; text-align: right; width: 30px;">Qty</th>
                    <th style="padding: 6px; text-align: right; width: 35px;">DTE</th>
                    <th style="padding: 6px; text-align: right; width: 50px;">Credit</th>
                    <th style="padding: 6px; text-align: right; width: 45px;" title="Annualized Return on Capital">Ann%</th>
                    <th style="padding: 6px; text-align: center; width: 110px;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    openPositions.forEach(pos => {
        const urgency = getDteUrgency(pos.dte);
        const dteColor = urgency === 'critical' ? '#ff5252' : 
                        urgency === 'warning' ? '#ffaa00' : '#00ff88';
        
        // Check if this is a spread
        const isSpread = pos.type?.includes('_spread');
        
        // Calculate credit/debit (premium × 100 × contracts)
        const credit = pos.premium * 100 * pos.contracts;
        
        // Calculate ROC: Premium / Capital at Risk
        // For spreads: Capital at Risk = spread width or debit paid
        // For puts: Capital at Risk = Strike × 100 × Contracts
        // For calls: Capital at Risk = typically the stock value, but for covered calls we use strike
        let capitalAtRisk;
        if (isSpread) {
            capitalAtRisk = pos.type.includes('debit') 
                ? credit  // Debit spread: risk is what you paid
                : (pos.spreadWidth - pos.premium) * 100 * pos.contracts;  // Credit spread: risk is width minus credit
        } else {
            capitalAtRisk = (pos.strike || 0) * 100 * pos.contracts;
        }
        const roc = capitalAtRisk > 0 ? (credit / capitalAtRisk) * 100 : 0;
        
        // Annualized ROC: ROC × (365 / DTE)
        const annualRoc = pos.dte > 0 ? roc * (365 / pos.dte) : 0;
        
        // Color code annual ROC
        const annualRocColor = annualRoc >= 50 ? '#00ff88' : annualRoc >= 25 ? '#ffaa00' : '#888';
        
        // Format type for display
        let typeDisplay = pos.type.replace(/_/g, ' ').replace('short ', 'Short ').replace('long ', 'Long ');
        if (pos.type === 'buy_write') typeDisplay = 'Buy/Write';
        if (isSpread) {
            // Shorten spread names for display
            typeDisplay = pos.type.replace('_spread', '').replace('_', ' ').toUpperCase() + ' Spread';
        }
        const typeColor = pos.type === 'buy_write' ? '#00d9ff' : 
                         isSpread ? '#8b5cf6' :
                         pos.type.includes('put') ? '#ff5252' : '#00ff88';
        
        // Strike display - different for spreads
        const strikeDisplay = isSpread 
            ? `$${pos.buyStrike}/$${pos.sellStrike}`
            : `$${pos.strike?.toFixed(0) || '—'}`;
        
        // Buy/Write extra info
        const buyWriteInfo = pos.type === 'buy_write' && pos.stockPrice 
            ? ` | Stock: $${pos.stockPrice.toFixed(2)} | Basis: $${pos.costBasis.toFixed(2)}` 
            : '';
        
        // Spread extra info for tooltip
        const spreadInfo = isSpread && pos.breakeven
            ? ` | Breakeven: $${pos.breakeven.toFixed(2)} | Width: $${pos.spreadWidth}`
            : '';
        
        html += `
            <tr style="border-bottom: 1px solid #333;" title="${pos.delta ? 'Δ ' + pos.delta.toFixed(2) : ''}${pos.openDate ? ' | Opened: ' + pos.openDate : ''}${buyWriteInfo}${spreadInfo}">
                <td style="padding: 6px; font-weight: bold; color: #00d9ff;">${pos.ticker}</td>
                <td style="padding: 6px; color: #aaa; font-size: 10px;">${pos.broker || 'Schwab'}</td>
                <td style="padding: 6px; color: ${typeColor}; font-size: 10px;">${typeDisplay}</td>
                <td style="padding: 6px; text-align: right; ${isSpread ? 'font-size:10px;' : ''}">${strikeDisplay}</td>
                <td style="padding: 6px; text-align: right;">${isSpread && pos.type.includes('debit') ? '-' : ''}$${pos.premium.toFixed(2)}</td>
                <td style="padding: 6px; text-align: right;">${pos.contracts}</td>
                <td style="padding: 6px; text-align: right; color: ${dteColor}; font-weight: bold;">
                    ${pos.dte}d
                </td>
                <td style="padding: 6px; text-align: right; color: ${pos.type.includes('debit') ? '#ff5252' : '#00ff88'};">
                    ${pos.type.includes('debit') ? '-' : ''}$${credit.toFixed(0)}
                </td>
                <td style="padding: 6px; text-align: right; color: ${annualRocColor}; font-weight: bold;">
                    ${isSpread ? '—' : annualRoc.toFixed(0) + '%'}
                </td>
                <td style="padding: 4px; text-align: center; white-space: nowrap;">
                    ${isSpread ? `
                    <button onclick="window.showSpreadExplanation(${pos.id})" 
                            style="display:inline-block; background: rgba(139,92,246,0.3); border: 1px solid rgba(139,92,246,0.5); color: #b9f; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="AI Spread Explanation">🤖</button>
                    ` : `
                    <button onclick="window.loadPositionToAnalyze(${pos.id})" 
                            style="display:inline-block; background: rgba(0,180,220,0.3); border: 1px solid rgba(0,180,220,0.5); color: #6dd; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Analyze">📊</button>
                    `}
                    <button onclick="window.showClosePanel(${pos.id})" 
                            style="display:inline-block; background: rgba(80,180,80,0.3); border: 1px solid rgba(80,180,80,0.5); color: #6c6; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Close">✅</button>
                    ${pos.type.includes('put') ? `
                    <button onclick="window.assignPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(255,140,0,0.3); border: 1px solid rgba(255,140,0,0.5); color: #fa0; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Got Assigned - Take Shares">📦</button>
                    ` : ''}
                    ${pos.type.includes('call') && (state.holdings || []).some(h => h.ticker === pos.ticker) ? `
                    <button onclick="window.calledAway(${pos.id})" 
                            style="display:inline-block; background: rgba(255,215,0,0.3); border: 1px solid rgba(255,215,0,0.5); color: #fd0; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Shares Called Away">🎯</button>
                    ` : ''}
                    <button onclick="window.rollPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(140,80,160,0.3); border: 1px solid rgba(140,80,160,0.5); color: #b9b; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Roll">🔄</button>
                    ${hasRollHistory(pos) ? `
                    <button onclick="window.showRollHistory(${pos.chainId || pos.id})" 
                            style="display:inline-block; background: rgba(0,150,255,0.3); border: 1px solid rgba(0,150,255,0.5); color: #6bf; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="View Roll History">🔗</button>
                    ` : ''}
                    <button onclick="window.editPosition(${pos.id})" 
                            style="display:inline-block; background: rgba(200,160,60,0.3); border: 1px solid rgba(200,160,60,0.5); color: #db9; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Edit">✏️</button>
                    <button onclick="window.deletePosition(${pos.id})" 
                            style="display:inline-block; background: rgba(180,80,80,0.3); border: 1px solid rgba(180,80,80,0.5); color: #c88; padding: 2px 5px; border-radius: 3px; cursor: pointer; font-size: 11px; vertical-align: middle;"
                            title="Delete">✕</button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

/**
 * Update portfolio summary stats
 */
export function updatePortfolioSummary() {
    // Ensure positions is an array
    if (!Array.isArray(state.positions)) {
        state.positions = [];
    }
    
    const openPositions = state.positions.filter(p => p.status === 'open');
    
    const totalOpen = openPositions.length;
    const totalContracts = openPositions.reduce((sum, p) => sum + p.contracts, 0);
    const totalPremium = openPositions.reduce((sum, p) => sum + (p.premium * 100 * p.contracts), 0);
    
    // Capital at Risk calculation
    // - Puts: strike × 100 × contracts (you might own shares at strike)
    // - Spreads: max loss = width - credit (for credit spreads) or debit paid (for debit spreads)
    const capitalAtRisk = openPositions.reduce((sum, p) => {
        const isSpread = p.type?.includes('_spread');
        
        if (isSpread) {
            // For spreads, max loss is already calculated or we compute it
            if (p.maxLoss) {
                return sum + p.maxLoss;
            }
            const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
            const premium = p.premium || 0;
            const maxLoss = p.type.includes('debit') 
                ? premium * 100 * p.contracts  // Debit spread: max loss = what you paid
                : (width - premium) * 100 * p.contracts;  // Credit spread: max loss = width - credit
            return sum + maxLoss;
        } else if (p.type === 'short_put' || p.type === 'buy_write') {
            return sum + ((p.strike || 0) * 100 * p.contracts);
        }
        return sum;
    }, 0);
    
    // Calculate ROC (Return on Capital) = Premium / Capital at Risk
    const roc = capitalAtRisk > 0 ? (totalPremium / capitalAtRisk) * 100 : 0;
    
    // Calculate weighted average annualized ROC
    let weightedAnnROC = 0;
    if (capitalAtRisk > 0) {
        const totalWeightedROC = openPositions.reduce((sum, p) => {
            const isSpread = p.type?.includes('_spread');
            let posCapital;
            
            if (isSpread) {
                if (p.maxLoss) {
                    posCapital = p.maxLoss;
                } else {
                    const width = p.spreadWidth || Math.abs((p.sellStrike || 0) - (p.buyStrike || 0));
                    const premium = p.premium || 0;
                    posCapital = p.type.includes('debit')
                        ? premium * 100 * p.contracts
                        : (width - premium) * 100 * p.contracts;
                }
            } else if (p.type === 'short_put' || p.type === 'buy_write') {
                posCapital = (p.strike || 0) * 100 * p.contracts;
            } else {
                return sum; // Skip other types
            }
            
            if (posCapital <= 0) return sum;
            
            const posROC = (p.premium * 100 * p.contracts) / posCapital;
            const dte = Math.max(1, p.dte || 1);
            const annROC = posROC * (365 / dte);
            return sum + (annROC * posCapital);
        }, 0);
        weightedAnnROC = (totalWeightedROC / capitalAtRisk) * 100;
    }
    
    // Find closest expiration
    let closestDte = Infinity;
    openPositions.forEach(p => {
        if (p.dte < closestDte) closestDte = p.dte;
    });
    
    // Update summary elements
    const summaryEl = document.getElementById('portfolioSummary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="summary-grid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px;">
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">OPEN POSITIONS</div>
                    <div style="color: #00d9ff; font-size: 24px; font-weight: bold;">${totalOpen}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">TOTAL CONTRACTS</div>
                    <div style="color: #fff; font-size: 24px; font-weight: bold;">${totalContracts}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">PREMIUM COLLECTED</div>
                    <div style="color: #00ff88; font-size: 24px; font-weight: bold;">${formatCurrency(totalPremium)}</div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">CAPITAL AT RISK</div>
                    <div style="color: #ffaa00; font-size: 24px; font-weight: bold;">
                        ${formatCurrency(capitalAtRisk)}
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">ROC</div>
                    <div style="color: #00ff88; font-size: 24px; font-weight: bold;" 
                         title="Return on Capital: Premium ÷ Capital at Risk">
                        ${roc.toFixed(2)}%
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">AVG ANN. ROC</div>
                    <div style="color: ${weightedAnnROC >= 100 ? '#00ff88' : weightedAnnROC >= 50 ? '#ffaa00' : '#ff5252'}; 
                         font-size: 24px; font-weight: bold;" 
                         title="Weighted Average Annualized Return on Capital">
                        ${weightedAnnROC.toFixed(0)}%
                    </div>
                </div>
                <div class="summary-item" style="text-align: center;">
                    <div style="color: #888; font-size: 11px;">NEXT EXPIRY</div>
                    <div style="color: ${closestDte <= 7 ? '#ff5252' : closestDte <= 21 ? '#ffaa00' : '#00ff88'}; 
                                font-size: 24px; font-weight: bold;">
                        ${closestDte === Infinity ? '—' : closestDte + 'd'}
                    </div>
                </div>
            </div>
        `;
    }
}

/**
 * Handle assignment - convert put to share ownership
 */
export function assignPosition(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.type.includes('put')) {
        showNotification('Only puts can be assigned shares', 'error');
        return;
    }
    
    // Save undo state BEFORE making changes
    const originalPosition = {...pos};
    state.lastAction = {
        type: 'assign',
        position: originalPosition,
        timestamp: Date.now()
    };
    
    // Calculate cost basis: Strike - Premium received
    const premiumReceived = pos.premium;
    const costBasis = pos.strike - premiumReceived;
    const shares = 100 * (pos.contracts || 1);
    
    // Create holding record
    const holdingId = Date.now();
    const holding = {
        id: holdingId,
        ticker: pos.ticker,
        shares: shares,
        costBasis: costBasis,
        strike: pos.strike,
        premiumReceived: premiumReceived,
        assignedDate: new Date().toISOString().split('T')[0],
        fromPutId: pos.id,
        chainId: pos.chainId || pos.id,
        broker: pos.broker || 'Schwab',
        totalCost: costBasis * shares,
        premiumCredit: premiumReceived * 100 * (pos.contracts || 1)
    };
    
    // Store holding ID for undo
    state.lastAction.holdingId = holdingId;
    
    // Add to holdings
    if (!Array.isArray(state.holdings)) state.holdings = [];
    state.holdings.push(holding);
    saveHoldingsToStorage();
    
    // Close the put position as "assigned"
    pos.status = 'assigned';
    pos.closeDate = holding.assignedDate;
    pos.closePrice = 0; // Option expires worthless (ITM)
    pos.realizedPnL = premiumReceived * 100 * (pos.contracts || 1); // Keep the premium
    pos.daysHeld = pos.openDate ? 
        Math.ceil((new Date(holding.assignedDate) - new Date(pos.openDate)) / (1000 * 60 * 60 * 24)) : 0;
    
    // Move to closed positions
    if (!Array.isArray(state.closedPositions)) state.closedPositions = [];
    state.closedPositions.push({...pos});
    saveClosedToStorage();
    
    // Remove from open positions
    state.positions = state.positions.filter(p => p.id !== id);
    savePositionsToStorage();
    
    // Show undo notification instead of regular one
    showUndoNotification(
        `📦 Assigned ${shares} shares of ${pos.ticker}`, 
        'warning'
    );
    
    renderPositions();
    updatePortfolioSummary();
    
    // Trigger portfolio re-render if function exists
    if (window.renderHoldings) window.renderHoldings();
    if (window.renderPortfolio) window.renderPortfolio(false);
}

/**
 * Undo last destructive action
 */
export function undoLastAction() {
    const action = state.lastAction;
    if (!action) {
        showNotification('Nothing to undo', 'info');
        return;
    }
    
    // Check if action is too old (> 60 seconds)
    if (Date.now() - action.timestamp > 60000) {
        showNotification('Undo expired (> 60 seconds)', 'warning');
        state.lastAction = null;
        return;
    }
    
    switch (action.type) {
        case 'assign':
            // Restore the position
            const restoredPos = action.position;
            restoredPos.status = 'open';
            delete restoredPos.closeDate;
            delete restoredPos.closePrice;
            delete restoredPos.realizedPnL;
            delete restoredPos.daysHeld;
            
            // Add back to positions
            state.positions.push(restoredPos);
            savePositionsToStorage();
            
            // Remove the holding that was created
            if (action.holdingId) {
                state.holdings = (state.holdings || []).filter(h => h.id !== action.holdingId);
                saveHoldingsToStorage();
            }
            
            // Remove from closed positions
            state.closedPositions = (state.closedPositions || []).filter(p => p.id !== restoredPos.id);
            saveClosedToStorage();
            
            showNotification(`↩ Undone! ${restoredPos.ticker} position restored`, 'success');
            break;
            
        case 'close':
            // Restore closed position
            const closedPos = action.position;
            closedPos.status = 'open';
            delete closedPos.closeDate;
            delete closedPos.closePrice;
            delete closedPos.realizedPnL;
            delete closedPos.daysHeld;
            
            state.positions.push(closedPos);
            savePositionsToStorage();
            
            // Remove from closed
            state.closedPositions = (state.closedPositions || []).filter(p => p.id !== closedPos.id);
            saveClosedToStorage();
            
            showNotification(`↩ Undone! ${closedPos.ticker} position reopened`, 'success');
            break;
            
        case 'delete':
            // Restore deleted position
            state.positions.push(action.position);
            savePositionsToStorage();
            showNotification(`↩ Undone! ${action.position.ticker} position restored`, 'success');
            break;
            
        default:
            showNotification('Unknown action type', 'error');
            return;
    }
    
    // Clear the undo state
    state.lastAction = null;
    
    // Refresh UI
    renderPositions();
    updatePortfolioSummary();
    if (window.renderHoldings) window.renderHoldings();
    if (window.renderPortfolio) window.renderPortfolio(false);
}

// Export to window for HTML onclick handlers
window.addPosition = addPosition;
window.deletePosition = deletePosition;
window.loadPositionToAnalyze = loadPositionToAnalyze;
window.closePosition = closePosition;
window.assignPosition = assignPosition;
window.renderPositions = renderPositions;
window.undoLastAction = undoLastAction;

/**
 * Export all data to a JSON file for backup
 */
export function exportAllData() {
    const CLOSED_KEY = 'wheelhouse_closed_positions';
    
    const exportData = {
        version: 1,
        exportDate: new Date().toISOString(),
        positions: state.positions || [],
        holdings: state.holdings || [],
        closedPositions: JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')
    };
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wheelhouse_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotification('✅ Backup exported successfully!', 'success');
}

/**
 * Import data from a JSON backup file
 */
export function importAllData(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importData = JSON.parse(e.target.result);
            
            // Validate the import data
            if (!importData.positions && !importData.holdings && !importData.closedPositions) {
                showNotification('❌ Invalid backup file format', 'error');
                return;
            }
            
            // Confirm before overwriting
            const posCount = (importData.positions || []).length;
            const holdCount = (importData.holdings || []).length;
            const closedCount = (importData.closedPositions || []).length;
            
            const msg = `Import ${posCount} positions, ${holdCount} holdings, ${closedCount} closed positions?\\n\\nThis will REPLACE your current data.`;
            
            if (!confirm(msg)) {
                showNotification('Import cancelled', 'info');
                return;
            }
            
            // Import the data
            if (importData.positions) {
                state.positions = importData.positions;
                savePositionsToStorage();
            }
            
            if (importData.holdings) {
                state.holdings = importData.holdings;
                saveHoldingsToStorage();
            }
            
            if (importData.closedPositions) {
                state.closedPositions = importData.closedPositions;
                saveClosedToStorage();
            }
            
            // Refresh UI
            renderPositions();
            updatePortfolioSummary();
            if (window.renderHoldings) window.renderHoldings();
            if (window.renderPortfolio) window.renderPortfolio(false);
            
            showNotification(`✅ Imported ${posCount} positions, ${holdCount} holdings, ${closedCount} closed!`, 'success', 5000);
            
        } catch (err) {
            console.error('Import error:', err);
            showNotification('❌ Failed to parse backup file: ' + err.message, 'error');
        }
    };
    
    reader.readAsText(file);
    
    // Reset the file input so the same file can be imported again
    event.target.value = '';
}

/**
 * Toggle position type specific fields visibility
 */
function togglePositionTypeFields() {
    const type = document.getElementById('posType').value;
    const buyWriteFields = document.getElementById('buyWriteFields');
    const spreadFields = document.getElementById('spreadFields');
    const strikeField = document.getElementById('posStrike')?.parentElement;
    const spreadExplanation = document.getElementById('spreadExplanation');
    
    const isSpread = type.includes('_spread');
    const isBuyWrite = type === 'buy_write';
    
    if (buyWriteFields) {
        buyWriteFields.style.display = isBuyWrite ? 'block' : 'none';
    }
    
    if (spreadFields) {
        spreadFields.style.display = isSpread ? 'block' : 'none';
    }
    
    // Hide single strike field for spreads
    if (strikeField) {
        strikeField.style.display = isSpread ? 'none' : 'block';
    }
    
    // Update spread explanation based on type
    if (spreadExplanation) {
        const explanations = {
            'call_debit_spread': '💡 Buy lower strike call, Sell higher strike call. Profit if stock goes UP. Max profit at sell strike.',
            'put_debit_spread': '💡 Buy higher strike put, Sell lower strike put. Profit if stock goes DOWN. Max profit at sell strike.',
            'call_credit_spread': '💡 Sell lower strike call, Buy higher strike call. Profit if stock stays BELOW sell strike.',
            'put_credit_spread': '💡 Sell higher strike put, Buy lower strike put. Profit if stock stays ABOVE sell strike.'
        };
        spreadExplanation.textContent = explanations[type] || '';
    }
}

// Legacy alias
function toggleBuyWriteFields() {
    togglePositionTypeFields();
}

window.exportAllData = exportAllData;
window.importAllData = importAllData;
window.toggleBuyWriteFields = toggleBuyWriteFields;
window.togglePositionTypeFields = togglePositionTypeFields;