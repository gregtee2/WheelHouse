/**
 * Position Checkup Module
 * AI-powered position analysis - checkup, notes, and roll staging
 * 
 * Extracted from main.js
 */

import { showNotification } from 'utils';
import { state } from 'state';
import AccountService from './services/AccountService.js';
import PositionsService from './services/PositionsService.js';
import { renderPendingTrades } from 'tradeStaging';
import { formatAIResponse, extractThesisSummary } from 'aiHelpers';
import TradeCardService from './services/TradeCardService.js';

/**
 * Save a user note to a position (for strategy intent)
 */
window.savePositionNote = function(positionId) {
    const noteInput = document.getElementById('positionNoteInput');
    if (!noteInput) {
        showNotification('Note input not found', 'error');
        return;
    }
    
    const note = noteInput.value.trim();
    
    // Find and update the position - check both localStorage AND in-memory state
    const isPaperMode = window.state?.accountMode === 'paper';
    const storageKey = isPaperMode ? 'wheelhouse_paper_positions' : 'wheelhouse_positions';
    let positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    
    let posIdx = positions.findIndex(p => String(p.id) === String(positionId));
    
    // If not found in localStorage, check window.state.positions (Schwab-synced positions)
    if (posIdx < 0 && window.state?.positions) {
        const statePos = window.state.positions.find(p => String(p.id) === String(positionId));
        if (statePos) {
            // Add this position to localStorage
            statePos.userNotes = note || null;
            positions.push(statePos);
            posIdx = positions.length - 1;
        }
    }
    
    if (posIdx < 0) {
        showNotification('Position not found in any source', 'error');
        return;
    }
    
    // Save the note
    positions[posIdx].userNotes = note || null;
    localStorage.setItem(storageKey, JSON.stringify(positions));
    
    // Also update in-memory state
    if (window.state?.positions) {
        const statePos = window.state.positions.find(p => String(p.id) === String(positionId));
        if (statePos) {
            statePos.userNotes = note || null;
        }
    }
    
    showNotification(note ? '📝 Strategy note saved!' : '📝 Note cleared', 'success');
    
    // Visual feedback using direct IDs
    const noteSection = document.getElementById('notesSectionContainer');
    const header = document.getElementById('notesHeader');
    const saveBtn = document.getElementById('saveNoteBtn');
    
    // Flash the section green
    if (noteSection) {
        noteSection.style.borderColor = '#00ff88';
        noteSection.style.boxShadow = '0 0 15px rgba(0,255,136,0.5)';
        setTimeout(() => {
            noteSection.style.borderColor = note ? '#00ff88' : '#333';
            noteSection.style.boxShadow = 'none';
        }, 1500);
    }
    
    // Update header
    if (header) {
        header.innerHTML = `📝 My Strategy Notes <span style="color:#00ff88;font-weight:bold;">(✓ SAVED)</span>`;
    }
    
    // Update button with confirmation
    if (saveBtn) {
        const originalText = saveBtn.innerHTML;
        const originalBg = saveBtn.style.background;
        saveBtn.innerHTML = '✅ SAVED!';
        saveBtn.style.background = '#00ff88';
        saveBtn.style.color = '#000';
        setTimeout(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.style.background = originalBg;
        }, 2000);
    }
};

/**
 * Run Monte Carlo simulation for a position to get probability estimates
 * @param {Object} pos - The position object
 * @param {number} spotPrice - Current spot price
 * @param {number} iv - Implied volatility (decimal, e.g., 0.45 for 45%)
 * @returns {Object} Probability data for AI
 */
function runPositionMonteCarlo(pos, spotPrice, iv = 0.35) {
    const numPaths = 5000;  // Fast but accurate enough
    const numSteps = 50;
    
    // Calculate DTE
    const expDate = new Date(pos.expiry);
    const dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
    const T = dte / 365.25;  // Time in years
    const dt = T / numSteps;
    const rate = 0.04;  // Risk-free rate ~4%
    
    const isSpread = pos.type?.includes('_spread');
    const isPut = pos.type?.toLowerCase().includes('put');
    const isCredit = pos.type?.includes('credit');
    
    // Determine key price levels
    let shortStrike, longStrike, breakeven;
    
    if (isSpread) {
        shortStrike = pos.sellStrike || pos.strike;
        longStrike = pos.buyStrike;
        
        // Calculate breakeven for spreads
        const netCredit = pos.premium || 2.00;  // Fallback if missing
        if (isPut && isCredit) {
            // Put credit spread: breakeven = short strike - net credit
            breakeven = shortStrike - netCredit;
        } else if (!isPut && isCredit) {
            // Call credit spread: breakeven = short strike + net credit
            breakeven = shortStrike + netCredit;
        } else if (isPut && !isCredit) {
            // Put debit spread: breakeven = long strike - net debit
            breakeven = longStrike - netCredit;
        } else {
            // Call debit spread: breakeven = long strike + net debit
            breakeven = longStrike + netCredit;
        }
    } else {
        shortStrike = pos.strike;
        longStrike = null;
        breakeven = isPut ? pos.strike - (pos.premium || 0) : pos.strike + (pos.premium || 0);
    }
    
    // Run simulation
    let aboveShortStrike = 0;
    let belowShortStrike = 0;
    let maxProfitCount = 0;
    let maxLossCount = 0;
    let profitableCount = 0;
    const finalPrices = [];
    
    for (let i = 0; i < numPaths; i++) {
        let S = spotPrice;
        
        // Simulate GBM path
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormalMC() * Math.sqrt(dt);
            S *= Math.exp((rate - 0.5 * iv * iv) * dt + iv * dW);
        }
        
        finalPrices.push(S);
        
        if (S > shortStrike) aboveShortStrike++;
        if (S < shortStrike) belowShortStrike++;
        
        // Calculate profit/loss scenarios
        if (isSpread) {
            if (isPut && isCredit) {
                // Put credit spread
                if (S >= shortStrike) maxProfitCount++;  // Keep full credit
                if (S <= longStrike) maxLossCount++;      // Max loss
                if (S >= breakeven) profitableCount++;
            } else if (!isPut && isCredit) {
                // Call credit spread
                if (S <= shortStrike) maxProfitCount++;
                if (S >= longStrike) maxLossCount++;
                if (S <= breakeven) profitableCount++;
            }
        } else {
            // Single leg options
            if (isPut) {
                if (S >= shortStrike) maxProfitCount++;  // Put expires worthless
                if (S < breakeven) maxLossCount++;
                if (S >= breakeven) profitableCount++;
            } else {
                if (S <= shortStrike) maxProfitCount++;  // Call expires worthless
                if (S > breakeven) maxLossCount++;
                if (S <= breakeven) profitableCount++;
            }
        }
    }
    
    // Calculate percentiles
    finalPrices.sort((a, b) => a - b);
    const p10 = finalPrices[Math.floor(numPaths * 0.10)];
    const p25 = finalPrices[Math.floor(numPaths * 0.25)];
    const p50 = finalPrices[Math.floor(numPaths * 0.50)];  // Median
    const p75 = finalPrices[Math.floor(numPaths * 0.75)];
    const p90 = finalPrices[Math.floor(numPaths * 0.90)];
    
    return {
        numPaths,
        dte,
        iv: (iv * 100).toFixed(0) + '%',
        spotPrice: spotPrice.toFixed(2),
        probabilities: {
            aboveShortStrike: ((aboveShortStrike / numPaths) * 100).toFixed(1) + '%',
            belowShortStrike: ((belowShortStrike / numPaths) * 100).toFixed(1) + '%',
            maxProfit: ((maxProfitCount / numPaths) * 100).toFixed(1) + '%',
            maxLoss: ((maxLossCount / numPaths) * 100).toFixed(1) + '%',
            profitable: ((profitableCount / numPaths) * 100).toFixed(1) + '%'
        },
        priceRange: {
            p10: '$' + p10.toFixed(2),
            p25: '$' + p25.toFixed(2),
            median: '$' + p50.toFixed(2),
            p75: '$' + p75.toFixed(2),
            p90: '$' + p90.toFixed(2)
        },
        strikes: {
            short: shortStrike,
            long: longStrike,
            breakeven: breakeven?.toFixed(2)
        }
    };
}

// Simple normal random for Monte Carlo (Box-Muller)
function randomNormalMC() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Run a checkup on a position - compares opening thesis to current market conditions
 */
window.runPositionCheckup = async function(positionId) {
    // Find the position - check both real and paper accounts
    const isPaperMode = window.state?.accountMode === 'paper';
    const storageKey = isPaperMode ? 'wheelhouse_paper_positions' : 'wheelhouse_positions';
    let positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    
    // Convert to string for comparison (IDs can be numbers or strings)
    const searchId = String(positionId);
    let pos = positions.find(p => String(p.id) === searchId);
    
    // If not found in current mode, try the other storage (position might have been created in different mode)
    if (!pos) {
        const altKey = isPaperMode ? 'wheelhouse_positions' : 'wheelhouse_paper_positions';
        const altPositions = JSON.parse(localStorage.getItem(altKey) || '[]');
        pos = altPositions.find(p => String(p.id) === searchId);
    }
    
    // Still not found? Try state.positions (in-memory, might not be synced to localStorage yet)
    if (!pos && window.state?.positions) {
        pos = window.state.positions.find(p => String(p.id) === searchId);
    }
    
    if (!pos) {
        console.error('[Checkup] Position not found:', positionId, 'SearchId:', searchId);
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.openingThesis) {
        showNotification('No thesis data for this position', 'error');
        return;
    }
    
    // Use global model selector (with local aiModelSelect as override)
    const model = window.getSelectedAIModel?.('aiModelSelect') || 'deepseek-r1:32b';
    
    // Create loading modal - does NOT close on outside click (user must click X)
    const modal = document.createElement('div');
    modal.id = 'checkupModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);
        display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;`;
    // Removed: modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border-radius:12px;max-width:800px;width:100%;max-height:90vh;
            overflow-y:auto;padding:25px;border:1px solid #333;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h2 style="margin:0;color:#00d9ff;">🩺 Position Checkup: ${pos.ticker}</h2>
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:8px 15px;border-radius:6px;cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="checkupContent" style="color:#ccc;">
                <div style="text-align:center;padding:40px;">
                    <div class="spinner" style="width:50px;height:50px;border:3px solid #333;
                        border-top:3px solid #00d9ff;border-radius:50%;animation:spin 1s linear infinite;
                        margin:0 auto 20px;"></div>
                    <p>Running position checkup with ${model}...</p>
                    <p style="font-size:12px;color:#666;">Comparing opening thesis to current market conditions</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Add spinner animation if not already present
    if (!document.getElementById('spinnerStyle')) {
        const style = document.createElement('style');
        style.id = 'spinnerStyle';
        style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }
    
    try {
        // First, get current spot price for Monte Carlo
        let spotPrice = pos.currentSpot || pos.lastPrice || 0;
        let iv = 0.35;  // Default 35% IV
        
        // Always fetch fresh spot price and IV for accurate Monte Carlo
        try {
            // Try Schwab first (includes extended hours)
            let gotSpot = false;
            const schwabRes = await fetch(`/api/schwab/quotes?symbols=${pos.ticker}`);
            if (schwabRes.ok) {
                const data = await schwabRes.json();
                const quote = data[pos.ticker]?.quote;
                // Use extended hours price if available
                const schwabPrice = quote?.postMarketLastPrice || quote?.preMarketLastPrice || quote?.lastPrice || quote?.mark;
                if (schwabPrice) {
                    spotPrice = schwabPrice;
                    gotSpot = true;
                    console.log('[Checkup] Got spot price from Schwab:', spotPrice);
                }
            }
            
            // Fallback to Yahoo if Schwab failed
            if (!gotSpot) {
                const quoteRes = await fetch(`/api/yahoo/${pos.ticker}`);
                const quoteData = await quoteRes.json();
                const yahooPrice = quoteData.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (yahooPrice) {
                    spotPrice = yahooPrice;
                    console.log('[Checkup] Got spot price from Yahoo:', spotPrice);
                }
            }
            
            // Fetch IV separately
            const ivRes = await fetch(`/api/iv/${pos.ticker}`);
            const ivData = await ivRes.json();
            if (ivData.atmIV) {
                iv = ivData.atmIV / 100;  // Convert from percentage (e.g., 45 -> 0.45)
                console.log('[Checkup] Got IV:', (iv * 100).toFixed(1) + '%');
            }
        } catch (e) {
            console.warn('[Checkup] Could not fetch market data, using fallback:', e.message);
        }
        
        // Run Monte Carlo simulation for probability estimates
        let monteCarlo = null;
        if (spotPrice > 0) {
            monteCarlo = runPositionMonteCarlo(pos, spotPrice, iv);
            console.log('[Checkup] Monte Carlo results:', monteCarlo);
        } else {
            console.warn('[Checkup] No spot price available, skipping Monte Carlo');
        }
        
        // Call checkup API - include positionType so AI knows if long or short!
        // For spreads, send both strikes
        const isSpread = pos.type?.includes('_spread');
        const response = await fetch('/api/ai/checkup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: pos.ticker,
                strike: isSpread ? pos.sellStrike : pos.strike,  // Use sellStrike for spreads
                buyStrike: isSpread ? pos.buyStrike : null,      // Include protection strike
                spreadWidth: isSpread ? pos.spreadWidth : null,
                isSpread: isSpread,
                expiry: pos.expiry,
                openingThesis: pos.openingThesis,
                analysisHistory: pos.analysisHistory || [],  // Include prior checkups!
                userNotes: pos.userNotes || null,  // User's strategy intent
                positionType: pos.type,  // Important for long vs short evaluation!
                monteCarlo: monteCarlo,  // Include probability data!
                model
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Extract recommendation from AI response (HOLD, ROLL, CLOSE)
        const checkupText = data.checkup || '';
        let recommendation = 'HOLD';  // default
        if (/\b(ROLL|roll)\b/.test(checkupText) && !/don't roll|no roll|shouldn't roll/i.test(checkupText)) {
            recommendation = 'ROLL';
        } else if (/\b(CLOSE|close now|exit)\b/i.test(checkupText) && !/don't close|shouldn't close/i.test(checkupText)) {
            recommendation = 'CLOSE';
        }
        
        // Parse suggested trade from AI response
        let suggestedTrade = null;
        const tradeMatch = checkupText.match(/===SUGGESTED_TRADE===([\s\S]*?)===END_TRADE===/);
        if (tradeMatch && recommendation !== 'HOLD') {
            const tradeBlock = tradeMatch[1];
            const action = tradeBlock.match(/ACTION:\s*(\S+)/)?.[1] || 'NONE';
            
            // Skip if action is NONE or HOLD
            if (action !== 'NONE' && action !== 'HOLD') {
                // Helper to filter out placeholder text (starts with [ or contains "e.g.")
                const cleanValue = (val) => {
                    if (!val) return null;
                    if (val.startsWith('[') || val.includes('e.g.') || val === 'N/A') return null;
                    return val;
                };
                
                suggestedTrade = {
                    action: action,
                    closeStrike: parseFloat(tradeBlock.match(/CLOSE_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                    closeExpiry: tradeBlock.match(/CLOSE_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                    closeType: tradeBlock.match(/CLOSE_TYPE:\s*(\S+)/)?.[1] || null,
                    newStrike: parseFloat(tradeBlock.match(/NEW_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                    newExpiry: tradeBlock.match(/NEW_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                    newType: tradeBlock.match(/NEW_TYPE:\s*(\S+)/)?.[1] || null,
                    estimatedDebit: cleanValue(tradeBlock.match(/ESTIMATED_DEBIT:\s*(.+)/)?.[1]?.trim()),
                    estimatedCredit: cleanValue(tradeBlock.match(/ESTIMATED_CREDIT:\s*(.+)/)?.[1]?.trim()),
                    netCost: cleanValue(tradeBlock.match(/NET_COST:\s*(.+)/)?.[1]?.trim()),
                    rationale: cleanValue(tradeBlock.match(/RATIONALE:\s*(.+)/)?.[1]?.trim()),
                    ticker: pos.ticker,
                    originalPositionId: positionId,
                    // Include current option premium from API for staging
                    currentPremium: data.currentPremium
                };
                console.log('[CHECKUP] Parsed suggested trade:', suggestedTrade);
                // Store for staging
                window._lastCheckupSuggestedTrade = suggestedTrade;
            }
        }
        
        // Log AI prediction for accuracy tracking
        if (window.logAIPrediction) {
            window.logAIPrediction({
                type: 'checkup',
                ticker: pos.ticker,
                strike: pos.strike,
                expiry: pos.expiry,
                positionType: pos.type,
                recommendation: recommendation,
                model: model,
                spot: data.currentData?.price || null,
                positionId: positionId
            });
        }
        
        // Save to position's analysisHistory
        if (!pos.analysisHistory) pos.analysisHistory = [];
        pos.analysisHistory.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            model: model,
            recommendation: recommendation,
            insight: checkupText.substring(0, 2000),  // First 2000 chars (was 500)
            snapshot: {
                spot: parseFloat(data.currentData?.price) || null,
                strike: pos.strike,
                dte: Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24)),
                iv: parseFloat(data.currentData?.iv) || null,
                currentPremium: parseFloat(data.currentPremium?.mid) || null,
                pnlPercent: data.currentPremium?.mid && pos.premium ? 
                    Math.round((1 - data.currentPremium.mid / pos.premium) * 100) : null
            }
        });
        
        // Save updated position
        const posIdx = positions.findIndex(p => p.id === positionId);
        if (posIdx >= 0) {
            positions[posIdx] = pos;
            localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
        }
        
        // Calculate DTE
        const dte = Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        
        // Build position display string (handle spreads vs single-leg)
        // Note: isSpread already declared above at line ~4053
        const strikeDisplay = isSpread 
            ? `$${pos.sellStrike}/$${pos.buyStrike}` 
            : `$${pos.strike}`;
        const typeDisplay = pos.type?.includes('put') ? 'P' : 'C';
        
        // Display result
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;text-align:center;">
                    <div>
                        <div style="font-size:12px;color:#888;">Position</div>
                        <div style="font-size:18px;font-weight:bold;color:#00d9ff;">
                            ${pos.ticker} ${strikeDisplay}${typeDisplay}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Days to Expiry</div>
                        <div style="font-size:18px;font-weight:bold;color:${dte < 7 ? '#ff5252' : dte < 21 ? '#ffaa00' : '#00ff88'};">
                            ${dte} days
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Entry Price</div>
                        <div style="font-size:18px;font-weight:bold;">
                            $${parseFloat(pos.openingThesis.priceAtAnalysis)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Current Price</div>
                        <div style="font-size:18px;font-weight:bold;color:${parseFloat(data.currentData?.price) > parseFloat(pos.openingThesis.priceAtAnalysis) ? '#00ff88' : '#ff5252'};">
                            $${parseFloat(data.currentData?.price)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <h4 style="margin:0 0 10px;color:#888;font-size:12px;text-transform:uppercase;">
                    Original Entry Thesis (${new Date(pos.openingThesis.analyzedAt).toLocaleDateString()})
                    ${pos.openingThesis.modelUsed ? `<span style="color:#666;margin-left:10px;">${pos.openingThesis.modelUsed}</span>` : ''}
                </h4>
                ${pos.openingThesis.aiSummary?.bottomLine ? `
                    <div style="color:#ffaa00;font-weight:bold;margin-bottom:8px;">
                        📊 ${pos.openingThesis.aiSummary.bottomLine}
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.probability ? `
                    <div style="color:#00d9ff;font-size:13px;margin-bottom:8px;">
                        🎯 ${pos.openingThesis.aiSummary.probability}% probability of max profit
                    </div>
                ` : ''}
                <div style="display:grid;gap:8px;font-size:12px;">
                    ${pos.openingThesis.aiSummary?.aggressive ? `
                        <div style="background:rgba(0,255,136,0.1);padding:8px;border-radius:4px;border-left:3px solid #00ff88;">
                            <span style="color:#00ff88;font-weight:bold;">🟢 AGGRESSIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.aggressive.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                    ${pos.openingThesis.aiSummary?.conservative ? `
                        <div style="background:rgba(255,82,82,0.1);padding:8px;border-radius:4px;border-left:3px solid #ff5252;">
                            <span style="color:#ff5252;font-weight:bold;">🔴 CONSERVATIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.conservative.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                </div>
                ${pos.openingThesis.iv ? `
                    <div style="margin-top:8px;font-size:11px;color:#666;">
                        IV at entry: ${pos.openingThesis.iv}% | Range: ${pos.openingThesis.rangePosition}% | 
                        Price: $${pos.openingThesis.priceAtAnalysis}
                    </div>
                ` : ''}
                ${pos.openingThesis.selectionRationale?.summary ? `
                    <div style="margin-top:8px;background:rgba(0,217,255,0.1);padding:8px;border-radius:4px;border-left:3px solid #00d9ff;font-size:11px;">
                        <span style="color:#00d9ff;">🧠 Why this expiry:</span>
                        <span style="color:#aaa;">${pos.openingThesis.selectionRationale.summary}</span>
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.fullAnalysis ? `
                    <div style="margin-top:12px;">
                        <button onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none'; this.textContent = el.style.display === 'none' ? '📄 View Full Entry Analysis' : '📄 Hide Full Analysis';"
                            style="background:#1a1a2e;border:1px solid #333;color:#00d9ff;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px;">
                            📄 View Full Entry Analysis
                        </button>
                        <div style="display:none;margin-top:10px;background:#1a1a2e;padding:12px;border-radius:6px;border:1px solid #333;max-height:300px;overflow-y:auto;">
                            <div style="white-space:pre-wrap;line-height:1.5;font-size:12px;color:#ccc;">
${pos.openingThesis.aiSummary.fullAnalysis}
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
            
            <!-- User Notes Section -->
            <div id="notesSectionContainer" style="background:#1a1a2e;padding:15px;border-radius:8px;margin-bottom:15px;border:1px solid ${pos.userNotes ? '#ffaa00' : '#333'};">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <h4 id="notesHeader" style="margin:0;color:#ffaa00;font-size:12px;text-transform:uppercase;">
                        📝 My Strategy Notes ${pos.userNotes ? '(Saved)' : ''}
                    </h4>
                    <button id="saveNoteBtn" onclick="window.savePositionNote('${pos.id}')" 
                        style="background:#ffaa00;border:none;color:#000;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold;">
                        💾 Save Note
                    </button>
                </div>
                <textarea id="positionNoteInput" 
                    placeholder="Add your strategy intent here... e.g., 'Decided to take assignment and wheel the shares' or 'Letting this ride to expiry, comfortable with assignment'"
                    style="width:100%;height:60px;background:#0d0d1a;border:1px solid #444;border-radius:6px;color:#ccc;padding:10px;font-size:12px;resize:vertical;box-sizing:border-box;"
                >${pos.userNotes || ''}</textarea>
                <div style="font-size:10px;color:#666;margin-top:5px;">
                    💡 This note is shown to AI during checkups to adjust recommendations to your strategy.
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:20px;border-radius:8px;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">AI Checkup Analysis</h4>
                <div style="white-space:pre-wrap;line-height:1.6;font-size:14px;">
                    ${formatAIResponse(data.checkup
                        .replace(/===SUGGESTED_TRADE===[\s\S]*?===END_TRADE===/g, '')
                        .replace(/\*?\*?6\.\s*SUGGESTED TRADE\*?\*?\s*$/gm, '')
                        .replace(/\*?\*?6\.\s*SUGGESTED TRADE\*?\*?\s*\n\s*$/gm, '')
                        .trim()
                    )}
                </div>
            </div>
            
            ${suggestedTrade && suggestedTrade.action !== 'NONE' ? `
            <div style="background:linear-gradient(135deg, #1a2a3a 0%, #0d1a2a 100%);padding:20px;border-radius:8px;margin-top:15px;border:1px solid #00d9ff;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">📋 Suggested Trade</h4>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;">
                    <div style="background:#0d0d1a;padding:12px;border-radius:6px;">
                        <div style="font-size:11px;color:#888;margin-bottom:5px;">CLOSE (Buy Back)</div>
                        <div style="font-size:16px;font-weight:bold;color:#ff5252;">
                            ${pos.ticker} $${suggestedTrade.closeStrike} ${suggestedTrade.closeType}
                        </div>
                        <div style="font-size:12px;color:#888;">Exp: ${suggestedTrade.closeExpiry}</div>
                        <div style="font-size:12px;color:#ffaa00;margin-top:5px;">Est. Cost: ${suggestedTrade.estimatedDebit || 'N/A'}</div>
                    </div>
                    ${suggestedTrade.newStrike ? `
                    <div style="background:#0d0d1a;padding:12px;border-radius:6px;">
                        <div style="font-size:11px;color:#888;margin-bottom:5px;">OPEN (Sell New)</div>
                        <div style="font-size:16px;font-weight:bold;color:#00ff88;">
                            ${pos.ticker} $${suggestedTrade.newStrike} ${suggestedTrade.newType}
                        </div>
                        <div style="font-size:12px;color:#888;">Exp: ${suggestedTrade.newExpiry}</div>
                        <div style="font-size:12px;color:#00ff88;margin-top:5px;">Est. Credit: ${suggestedTrade.estimatedCredit || 'N/A'}</div>
                    </div>
                    ` : '<div></div>'}
                </div>
                <div style="margin-top:15px;padding:12px;background:#0d0d1a;border-radius:6px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div>
                            <span style="font-size:12px;color:#888;">Net Cost:</span>
                            <span style="font-size:18px;font-weight:bold;color:${suggestedTrade.netCost?.includes('credit') ? '#00ff88' : '#ffaa00'};margin-left:10px;">
                                ${suggestedTrade.netCost || 'N/A'}
                            </span>
                        </div>
                    </div>
                    <div style="font-size:12px;color:#aaa;margin-top:8px;">
                        💡 ${suggestedTrade.rationale || 'AI-suggested trade based on current conditions'}
                    </div>
                </div>
            </div>
            ` : ''}
            
            <div style="margin-top:15px;display:flex;gap:10px;justify-content:flex-end;">
                ${suggestedTrade && suggestedTrade.action !== 'NONE' ? `
                <button onclick="window.stageCheckupSuggestedTrade()" 
                    style="background:linear-gradient(135deg, #00d9ff 0%, #0099cc 100%);border:none;color:#000;padding:10px 20px;border-radius:6px;cursor:pointer;font-weight:bold;">
                    📥 Stage ${suggestedTrade.action === 'ROLL' ? 'Roll' : suggestedTrade.action}
                </button>
                ` : ''}
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:10px 20px;border-radius:6px;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#3a1a1a;padding:20px;border-radius:8px;border:1px solid #ff5252;">
                <h4 style="color:#ff5252;margin:0 0 10px;">❌ Checkup Failed</h4>
                <p style="color:#ccc;margin:0;">${err.message}</p>
            </div>
        `;
    }
};

/**
 * Stage the suggested trade from a checkup into pending trades
 */
window.stageCheckupSuggestedTrade = function() {
    const trade = window._lastCheckupSuggestedTrade;
    if (!trade) {
        showNotification('No suggested trade available', 'error');
        return;
    }
    
    // Get positions to find the original position details
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const originalPos = positions.find(p => p.id === trade.originalPositionId);
    
    // Check if this is a CLOSE action (not a roll to new position)
    const isCloseOnly = trade.action === 'CLOSE' || !trade.newStrike || trade.newStrike === 'N/A';
    
    // Determine the trade type for the NEW position (if rolling)
    let newType = 'short_put';  // default
    if (!isCloseOnly && trade.newType === 'CALL') {
        newType = originalPos?.type?.includes('covered') ? 'covered_call' : 'short_call';
    } else if (!isCloseOnly && trade.newType === 'PUT') {
        newType = 'short_put';
    }
    
    // Parse premium from AI estimates
    // For CLOSE: use estimatedDebit (cost to buy back), fallback to currentPremium from API
    // For ROLL: try to parse netCost
    let premium = null;
    if (isCloseOnly) {
        if (trade.estimatedDebit) {
            // Parse "$1.20" or "1.20" to number
            const parsed = parseFloat(trade.estimatedDebit.replace(/[$,]/g, ''));
            if (!isNaN(parsed)) premium = parsed;
        }
        // Fallback to actual current premium from checkup API
        if (!premium && trade.currentPremium) {
            premium = trade.currentPremium;
        }
    } else if (trade.netCost) {
        // Try to extract credit/debit amount from netCost like "$1.30 credit" or "$0.50 debit"
        const match = trade.netCost.match(/\$?([\d.]+)/);
        if (match) premium = parseFloat(match[1]);
    }
    
    // Check if original position is a spread
    const isSpread = originalPos?.type?.includes('_spread');
    
    // Create staged trade
    const now = Date.now();
    const stagedTrade = {
        id: now,
        ticker: trade.ticker,
        type: isCloseOnly ? (originalPos?.type || 'close') : newType,
        // For CLOSE: use closeStrike; for ROLL: use newStrike
        strike: isCloseOnly ? trade.closeStrike : trade.newStrike,
        expiry: isCloseOnly ? trade.closeExpiry : trade.newExpiry,
        premium: premium,  // From AI estimates
        contracts: originalPos?.contracts || 1,
        isCall: isCloseOnly ? (trade.closeType === 'CALL') : (trade.newType === 'CALL'),
        isDebit: isCloseOnly ? true : false,  // Closing is a debit (buy back)
        source: 'AI Checkup',
        stagedAt: now,
        currentPrice: null,
        // Mark as close or roll
        isRoll: !isCloseOnly,
        isClose: isCloseOnly,
        // For spreads: include both strikes from original position
        upperStrike: isSpread ? originalPos.buyStrike : null,
        sellStrike: isSpread ? originalPos.sellStrike : null,
        buyStrike: isSpread ? originalPos.buyStrike : null,
        spreadWidth: isSpread ? originalPos.spreadWidth : null,
        rollFrom: {
            positionId: trade.originalPositionId,
            strike: trade.closeStrike,
            expiry: trade.closeExpiry,
            type: trade.closeType
        },
        // Opening thesis from AI checkup recommendation
        openingThesis: {
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: null,
            rationale: trade.rationale,
            netCost: trade.netCost,
            modelUsed: 'AI Checkup',
            aiSummary: {
                bottomLine: isCloseOnly 
                    ? `CLOSE: Buy back $${trade.closeStrike} ${trade.closeType} at ${trade.netCost || 'market'}`
                    : `${trade.action}: Roll from $${trade.closeStrike} to $${trade.newStrike} ${trade.newType}`,
                fullAnalysis: trade.rationale
            }
        }
    };
    
    // Add to pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const isDuplicate = pending.some(p => 
        p.ticker === stagedTrade.ticker && 
        p.strike === stagedTrade.strike && 
        p.expiry === stagedTrade.expiry
    );
    
    if (isDuplicate) {
        const strikeDisplay = isCloseOnly ? trade.closeStrike : trade.newStrike;
        showNotification(`${trade.ticker} $${strikeDisplay} already staged`, 'info');
        return;
    }
    
    pending.unshift(stagedTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // Close the checkup modal
    document.getElementById('checkupModal')?.remove();
    
    // Render pending trades
    renderPendingTrades();
    
    // Different notification for CLOSE vs ROLL
    if (isCloseOnly) {
        showNotification(`📥 Staged close: ${trade.ticker} $${trade.closeStrike} ${trade.closeType}`, 'success');
    } else {
        showNotification(`📥 Staged roll: ${trade.ticker} $${trade.closeStrike} → $${trade.newStrike} ${trade.newType}`, 'success');
    }
};

export const savePositionNote = window.savePositionNote;
export const runPositionCheckup = window.runPositionCheckup;
export const stageCheckupSuggestedTrade = window.stageCheckupSuggestedTrade;
