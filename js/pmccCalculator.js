/**
 * PMCC Calculator Module
 * Poor Man's Covered Call Calculator - analyzes LEAPS positions
 * and models selling short calls against them
 * 
 * Extracted from main.js
 */

import { showNotification } from 'utils';
import { state } from 'state';
import TradeCardService from './services/TradeCardService.js';

/**
 * Open PMCC (Poor Man's Covered Call) Calculator
 * Analyzes existing LEAPS positions and models selling short calls against them
 */
window.openPMCCCalculator = function() {
    // Find all long call positions (potential LEAPS) - broader filter
    const longCalls = state.positions.filter(p => {
        // Accept any position that looks like a long call with 180+ DTE
        const isLongCall = p.type?.toLowerCase().includes('call') && 
                          !p.type?.toLowerCase().includes('short') &&
                          !p.type?.toLowerCase().includes('credit') &&
                          !p.type?.toLowerCase().includes('covered_call');  // Covered calls are different
        const hasTime = p.dte > 180;  // At least 6 months remaining
        const isOpen = p.status === 'open';
        
        return isLongCall && hasTime && isOpen;
    });
    
    console.log('[PMCC] Found long call positions:', longCalls.length, longCalls.map(p => ({ ticker: p.ticker, type: p.type, dte: p.dte })));
    
    const modal = document.createElement('div');
    modal.id = 'pmccModal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.9); display: flex; align-items: center;
        justify-content: center; z-index: 10001; backdrop-filter: blur(4px);
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build position selector options
    const positionOptions = longCalls.length > 0
        ? longCalls.map(p => `<option value="${p.id}">${p.ticker} $${p.strike} ${p.expiry} (${p.dte}d) - Cost: $${p.premium * 100}</option>`).join('')
        : '<option value="">No LEAPS positions found</option>';
    
    modal.innerHTML = `
        <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 28px; border-radius: 16px; max-width: 700px; width: 90%; max-height: 90vh; overflow-y: auto; border: 2px solid #8b5cf6; box-shadow: 0 20px 60px rgba(139,92,246,0.3);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h2 style="color: #8b5cf6; margin: 0; font-size: 22px;">📊 PMCC Calculator</h2>
                <button onclick="this.closest('#pmccModal').remove()" style="background: none; border: none; color: #888; font-size: 28px; cursor: pointer; padding: 0; line-height: 1;">&times;</button>
            </div>
            
            <div style="background: rgba(139,92,246,0.15); padding: 12px; border-radius: 8px; border: 1px solid rgba(139,92,246,0.3); margin-bottom: 20px; font-size: 13px; color: #ddd;">
                <strong style="color: #8b5cf6;">Poor Man's Covered Call:</strong> Sell short-term calls against a long-dated (LEAPS) call to generate income while maintaining long-term upside exposure.
            </div>
            
            <!-- LEAPS Position Selector -->
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: #8b5cf6; font-weight: bold; margin-bottom: 8px; font-size: 13px;">🎯 Select Existing LEAPS Position</label>
                <select id="pmccPositionSelect" onchange="window.loadPMCCPosition(this.value)" style="width: 100%; padding: 10px; background: #0d0d1a; border: 1px solid #8b5cf6; color: #fff; border-radius: 6px; font-size: 13px; cursor: pointer;">
                    <option value="">-- Select a position --</option>
                    ${positionOptions}
                    <option value="manual">✏️ Manual Entry (New Analysis)</option>
                </select>
            </div>
            
            <!-- LEAPS Details (Current Position) -->
            <div id="pmccLeapsSection" style="display: none;">
                <div style="background: linear-gradient(135deg, rgba(0,217,255,0.15), rgba(0,153,204,0.1)); padding: 16px; border-radius: 8px; border: 1px solid rgba(0,217,255,0.4); margin-bottom: 20px;">
                    <div style="color: #00d9ff; font-weight: bold; margin-bottom: 12px; font-size: 14px;">📈 Your LEAPS Position</div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
                        <div>
                            <div style="color: #888; font-size: 11px;">Ticker</div>
                            <div id="pmccTicker" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Strike</div>
                            <div id="pmccStrike" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Expiry</div>
                            <div id="pmccExpiry" style="color: #fff; font-size: 13px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Original Cost</div>
                            <div id="pmccCost" style="color: #ff5252; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Current Value</div>
                            <div id="pmccCurrentValue" style="color: #00ff88; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Unrealized P&L</div>
                            <div id="pmccUnrealizedPnL" style="font-weight: bold; font-size: 14px;">-</div>
                        </div>
                    </div>
                    <!-- Breakeven Strike - CRITICAL for PMCC -->
                    <div style="margin-top: 12px; padding: 10px; background: linear-gradient(135deg, rgba(139,92,246,0.2), rgba(0,217,255,0.1)); border-radius: 6px; border: 1px solid rgba(139,92,246,0.4);">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="color: #888; font-size: 11px;">Breakeven Strike (LEAPS strike + premium paid)</div>
                                <div id="pmccBreakevenStrike" style="color: #8b5cf6; font-weight: bold; font-size: 18px;">-</div>
                            </div>
                            <div style="text-align: right; font-size: 11px; color: #888; max-width: 180px;">
                                Sell calls ABOVE this to profit if assigned
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(0,217,255,0.2); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
                        <div>
                            <div style="color: #888; font-size: 11px;">Spot Price</div>
                            <div id="pmccSpot" style="color: #fff; font-weight: bold; font-size: 14px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Intrinsic Value</div>
                            <div id="pmccIntrinsic" style="color: #00ff88; font-size: 13px;">-</div>
                        </div>
                        <div>
                            <div style="color: #888; font-size: 11px;">Time Value</div>
                            <div id="pmccTimeValue" style="color: #ffaa00; font-size: 13px;">-</div>
                        </div>
                    </div>
                </div>
                
                <!-- Short Call Inputs -->
                <div style="background: linear-gradient(135deg, rgba(255,82,82,0.15), rgba(255,170,0,0.1)); padding: 16px; border-radius: 8px; border: 1px solid rgba(255,82,82,0.3); margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div style="color: #ff5252; font-weight: bold; font-size: 14px;">💰 Short Call to Sell</div>
                        <button onclick="window.loadPMCCChain()" style="padding: 4px 10px; background: rgba(0,217,255,0.2); border: 1px solid #00d9ff; color: #00d9ff; border-radius: 4px; cursor: pointer; font-size: 11px;">
                            🔄 Load Chain
                        </button>
                    </div>
                    <div id="pmccChainLoadingStatus" style="font-size: 11px; color: #888; margin-bottom: 8px; text-align: center;">
                        Click "Load Chain" to fetch strikes & premiums
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                        <div>
                            <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Strike Price</label>
                            <select id="pmccShortStrike" onchange="window.onPMCCStrikeChange()"
                                   style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ff5252; color: #fff; border-radius: 4px; font-size: 13px; cursor: pointer;">
                                <option value="">Select strike...</option>
                            </select>
                        </div>
                        <div>
                            <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Expiry Date</label>
                            <select id="pmccShortExpiry" onchange="window.onPMCCExpiryChange()"
                                   style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ff5252; color: #fff; border-radius: 4px; font-size: 13px; cursor: pointer;">
                                <option value="">Select expiry...</option>
                            </select>
                        </div>
                    </div>
                    <div>
                        <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">Premium (per share) - Auto-filled from chain</label>
                        <input type="number" id="pmccShortPremium" step="0.01" placeholder="Will auto-fill from selected strike" oninput="window.calculatePMCC()"
                               style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #00ff88; color: #fff; border-radius: 4px; font-size: 13px;">
                    </div>
                </div>
                
                <!-- Results / What-If Scenarios -->
                <div id="pmccResults" style="display: none;">
                    <div style="background: rgba(0,0,0,0.3); padding: 16px; border-radius: 8px; margin-bottom: 16px;">
                        <div style="color: #00ff88; font-weight: bold; margin-bottom: 12px; font-size: 14px;">📊 Scenario Analysis</div>
                        
                        <!-- MOST LIKELY: Stock stays below strike -->
                        <div style="margin-bottom: 16px; padding: 12px; background: rgba(0,255,136,0.15); border-radius: 6px; border: 2px solid rgba(0,255,136,0.4);">
                            <div style="color: #00ff88; font-weight: bold; margin-bottom: 8px; font-size: 13px;">✅ If Stock Stays Below Strike (Most Likely)</div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px;">
                                <div>
                                    <div style="color: #888; font-size: 11px;">You Keep</div>
                                    <div id="pmccKeepPremium" style="color: #00ff88; font-weight: bold; font-size: 18px;">-</div>
                                </div>
                                <div>
                                    <div style="color: #888; font-size: 11px;">Your LEAPS</div>
                                    <div style="color: #fff; font-size: 13px;">Unchanged - sell another call!</div>
                                </div>
                            </div>
                            <div style="margin-top: 8px; padding: 6px 8px; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 11px; color: #888;">
                                Short call expires worthless → rinse & repeat for more income
                            </div>
                        </div>
                        
                        <!-- Monthly Yield -->
                        <div style="margin-bottom: 16px; padding: 12px; background: rgba(0,217,255,0.1); border-radius: 6px; border: 1px solid rgba(0,217,255,0.2);">
                            <div style="color: #888; font-size: 11px;">Monthly Yield on Capital</div>
                            <div id="pmccMonthlyYield" style="color: #00d9ff; font-size: 20px; font-weight: bold;">-</div>
                            <div id="pmccAnnualizedYield" style="color: #00d9ff; font-size: 12px; margin-top: 4px;">-</div>
                        </div>
                        
                        <!-- If Assigned Scenario -->
                        <div style="margin-bottom: 12px; padding: 12px; background: rgba(255,170,0,0.1); border-radius: 6px; border: 1px solid rgba(255,170,0,0.2);">
                            <div style="color: #ffaa00; font-weight: bold; margin-bottom: 12px; font-size: 13px;">⚠️ If Assigned (Stock Reaches Short Strike)</div>
                            
                            <!-- Option A: Exercise -->
                            <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                                <div style="color: #fff; font-weight: bold; font-size: 12px; margin-bottom: 6px;">Option A: Exercise Your LEAPS</div>
                                <div style="color: #888; font-size: 11px; line-height: 1.5;">
                                    1. Use LEAPS to buy 100 shares at $<span id="pmccExerciseStrike">-</span><br>
                                    2. Deliver those shares at $<span id="pmccShortStrikeDisplay">-</span> (assignment)<br>
                                    3. Keep the premium you collected
                                </div>
                                <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: #888; font-size: 11px;">Net Profit:</span>
                                    <span id="pmccExerciseProfit" style="font-weight: bold; font-size: 16px;">-</span>
                                </div>
                                <div style="color: #ff5252; font-size: 10px; margin-top: 4px;">⚠️ Loses all remaining time value in your LEAPS</div>
                            </div>
                            
                            <!-- Option B: Close Both -->
                            <div style="background: rgba(0,255,136,0.1); padding: 10px; border-radius: 6px; border: 1px solid rgba(0,255,136,0.2);">
                                <div style="color: #00ff88; font-weight: bold; font-size: 12px; margin-bottom: 6px;">Option B: Close Both Positions (Usually Better)</div>
                                <div style="color: #888; font-size: 11px; line-height: 1.5;">
                                    1. Buy back short call (at a loss)<br>
                                    2. Sell your LEAPS at market value<br>
                                    3. Preserves LEAPS time value: $<span id="pmccTimeValueDisplay">-</span>
                                </div>
                                <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <span style="color: #888; font-size: 11px;">Net Profit:</span>
                                    <span id="pmccCloseProfit" style="font-weight: bold; font-size: 16px;">-</span>
                                </div>
                            </div>
                            
                            <div id="pmccRecommendation" style="margin-top: 10px; padding: 8px; background: rgba(0,217,255,0.15); border-radius: 4px; font-size: 12px; color: #00d9ff; text-align: center;">
                                -
                            </div>
                        </div>
                        
                        <!-- Breakeven & Warnings -->
                        <div style="padding: 12px; background: rgba(139,92,246,0.1); border-radius: 6px; border: 1px solid rgba(139,92,246,0.2); font-size: 12px;">
                            <div style="margin-bottom: 6px;">
                                <span style="color: #888;">Your Breakeven:</span>
                                <span id="pmccBreakeven" style="color: #fff; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                            <div style="margin-bottom: 6px;">
                                <span style="color: #888;">Max Profit:</span>
                                <span id="pmccMaxProfit" style="color: #00ff88; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                            <div>
                                <span style="color: #888;">Max Profit at:</span>
                                <span id="pmccMaxProfitStrike" style="color: #fff; font-weight: bold; margin-left: 8px;">-</span>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Action Buttons -->
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <button onclick="window.stagePMCCTrade()" style="padding: 12px; background: linear-gradient(135deg, #00ff88 0%, #00cc66 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            📥 Stage New Short Call
                        </button>
                        <button onclick="window.showPMCCRollOptions()" style="padding: 12px; background: linear-gradient(135deg, #ffaa00 0%, #ff8800 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            🔄 Roll Short Call
                        </button>
                    </div>
                    
                    <!-- Roll Options Panel (hidden by default) -->
                    <div id="pmccRollPanel" style="display: none; margin-top: 16px; padding: 16px; background: linear-gradient(135deg, rgba(255,170,0,0.15), rgba(255,136,0,0.1)); border-radius: 8px; border: 1px solid rgba(255,170,0,0.3);">
                        <div style="color: #ffaa00; font-weight: bold; margin-bottom: 12px; font-size: 14px;">🔄 Roll to New Strike/Expiry</div>
                        <div style="color: #888; font-size: 11px; margin-bottom: 12px;">
                            Buy back current short call, sell new one at higher strike or later date
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                            <div>
                                <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">New Expiry</label>
                                <select id="pmccRollExpiry" onchange="window.onPMCCRollExpiryChange()" style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ffaa00; color: #fff; border-radius: 4px; font-size: 12px; cursor: pointer;">
                                    <option value="">Select expiry...</option>
                                </select>
                            </div>
                            <div>
                                <label style="color: #888; font-size: 11px; display: block; margin-bottom: 4px;">New Strike</label>
                                <select id="pmccRollStrike" onchange="window.onPMCCRollStrikeChange()" style="width: 100%; padding: 8px; background: #0d0d1a; border: 1px solid #ffaa00; color: #fff; border-radius: 4px; font-size: 12px; cursor: pointer;">
                                    <option value="">Select strike...</option>
                                </select>
                            </div>
                        </div>
                        <div id="pmccRollSummary" style="display: none; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 12px;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; font-size: 12px; text-align: center;">
                                <div>
                                    <div style="color: #ff5252; font-size: 11px;">Buy Back</div>
                                    <div id="pmccRollBuyBack" style="color: #ff5252; font-weight: bold;">-</div>
                                </div>
                                <div>
                                    <div style="color: #00ff88; font-size: 11px;">New Premium</div>
                                    <div id="pmccRollNewPremium" style="color: #00ff88; font-weight: bold;">-</div>
                                </div>
                                <div>
                                    <div style="color: #00d9ff; font-size: 11px;">Net Credit/Debit</div>
                                    <div id="pmccRollNet" style="font-weight: bold;">-</div>
                                </div>
                            </div>
                        </div>
                        <button onclick="window.stagePMCCRoll()" style="width: 100%; padding: 10px; background: linear-gradient(135deg, #ffaa00 0%, #ff8800 100%); border: none; border-radius: 6px; color: #000; font-weight: bold; cursor: pointer; font-size: 13px;">
                            📥 Stage Roll to Ideas Tab
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Load selected LEAPS position into PMCC calculator
 */
window.loadPMCCPosition = async function(positionId) {
    if (!positionId) {
        document.getElementById('pmccLeapsSection').style.display = 'none';
        return;
    }
    
    if (positionId === 'manual') {
        // TODO: Show manual entry form
        showNotification('Manual entry coming soon - select an existing position for now', 'info');
        document.getElementById('pmccPositionSelect').value = '';
        return;
    }
    
    const position = state.positions.find(p => p.id == positionId);
    if (!position) {
        showNotification('Position not found', 'error');
        return;
    }
    
    // Show LEAPS section
    document.getElementById('pmccLeapsSection').style.display = 'block';
    
    // Populate LEAPS details
    document.getElementById('pmccTicker').textContent = position.ticker;
    document.getElementById('pmccStrike').textContent = `$${position.strike}`;
    document.getElementById('pmccExpiry').textContent = position.expiry;
    
    const leapsCost = (position.premium || 0) * 100;
    const leapsPremiumPerShare = position.premium || 0;
    const breakevenStrike = position.strike + leapsPremiumPerShare;
    
    document.getElementById('pmccCost').textContent = `$${leapsCost.toFixed(0)}`;
    document.getElementById('pmccBreakevenStrike').textContent = `$${breakevenStrike.toFixed(2)}`;
    
    // Fetch current spot price - try Schwab first (with extended hours), then Yahoo as fallback
    let spotPrice = 0;
    try {
        // Try Schwab first (real-time, includes extended hours)
        const schwabData = await fetch(`/api/schwab/quote/${position.ticker}`).then(r => r.json());
        const quote = schwabData[position.ticker]?.quote;
        // Use extended hours price if available
        spotPrice = quote?.postMarketLastPrice || quote?.preMarketLastPrice || quote?.lastPrice || 0;
        
        if (!spotPrice) {
            // Fallback to Yahoo (15-min delayed, regular session only)
            const yahooData = await fetch(`/api/yahoo/${position.ticker}`).then(r => r.json());
            spotPrice = yahooData.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
        }
    } catch (err) {
        console.warn('Could not fetch spot price:', err);
    }
    
    document.getElementById('pmccSpot').textContent = spotPrice ? `$${spotPrice.toFixed(2)}` : 'N/A';
    
    // Calculate intrinsic and time value
    const intrinsic = Math.max(0, (spotPrice - position.strike) * 100);
    document.getElementById('pmccIntrinsic').textContent = `$${intrinsic.toFixed(0)}`;
    
    // Fetch current option price from chain
    try {
        const chain = await window.fetchOptionsChain(position.ticker);
        if (chain && chain.calls) {
            const leapsOption = chain.calls.find(c => 
                Math.abs(c.strike - position.strike) < 0.01 && 
                c.expiration === position.expiry
            );
            
            if (leapsOption) {
                const currentValue = ((leapsOption.bid + leapsOption.ask) / 2) * 100;
                const timeValue = currentValue - intrinsic;
                const unrealizedPnL = currentValue - leapsCost;
                
                document.getElementById('pmccCurrentValue').textContent = `$${currentValue.toFixed(0)}`;
                document.getElementById('pmccTimeValue').textContent = `$${timeValue.toFixed(0)}`;
                
                const pnlEl = document.getElementById('pmccUnrealizedPnL');
                pnlEl.textContent = `$${unrealizedPnL.toFixed(0)}`;
                pnlEl.style.color = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
                
                // Store for calculations
                window.pmccData = {
                    position,
                    spotPrice,
                    leapsCost,
                    currentValue,
                    intrinsic,
                    timeValue,
                    breakevenStrike
                };
            }
        }
    } catch (err) {
        console.warn('Could not fetch current LEAPS value:', err);
    }
};

/**
 * Load options chain for PMCC calculator (uses same fetchOptionsChain as spread modal)
 */
window.loadPMCCChain = async function() {
    if (!window.pmccData) {
        showNotification('Select a LEAPS position first', 'warning');
        return;
    }
    
    const { position } = window.pmccData;
    const statusEl = document.getElementById('pmccChainLoadingStatus');
    
    statusEl.textContent = '⏳ Fetching options chain...';
    statusEl.style.color = '#00d9ff';
    
    try {
        // Use the same proven chain fetch as spread modal
        const chain = await window.fetchOptionsChain(position.ticker);
        
        if (!chain || !chain.calls || chain.calls.length === 0) {
            throw new Error('No call options data available');
        }
        
        const calls = chain.calls;
        window.pmccChainData = calls;
        
        // Get unique expiries (only future dates, sorted)
        const today = new Date();
        const expiries = [...new Set(calls.map(c => c.expiration))]
            .filter(exp => new Date(exp) > today)
            .sort((a, b) => new Date(a) - new Date(b))
            .slice(0, 12);  // Next 12 expiries
        
        if (expiries.length === 0) {
            throw new Error('No future expirations found');
        }
        
        // Populate expiry dropdown
        const expirySelect = document.getElementById('pmccShortExpiry');
        expirySelect.innerHTML = '<option value="">Select expiry...</option>' + 
            expiries.map(exp => {
                const date = new Date(exp);
                const dte = Math.round((date - today) / (1000 * 60 * 60 * 24));
                return `<option value="${exp}">${exp} (${dte}d)</option>`;
            }).join('');
        
        statusEl.textContent = `✅ Loaded ${calls.length} strikes across ${expiries.length} expiries`;
        statusEl.style.color = '#00ff88';
        
        console.log('[PMCC] Chain loaded:', calls.length, 'calls,', expiries.length, 'expiries');
    } catch (err) {
        console.error('[PMCC] Chain load failed:', err);
        statusEl.textContent = `⚠️ Failed to load chain: ${err.message}`;
        statusEl.style.color = '#ffaa00';
        showNotification('Failed to load options chain - try again', 'error');
    }
};

/**
 * When expiry changes, populate strikes for that expiry
 */
window.onPMCCExpiryChange = function() {
    const expiry = document.getElementById('pmccShortExpiry').value;
    if (!expiry || !window.pmccChainData) return;
    
    const strikeSelect = document.getElementById('pmccShortStrike');
    const { spotPrice, breakevenStrike } = window.pmccData;
    
    // Filter to selected expiry and get strikes above spot (OTM calls)
    const callsAtExpiry = window.pmccChainData
        .filter(c => c.expiration === expiry && c.strike >= spotPrice)
        .sort((a, b) => a.strike - b.strike);
    
    if (callsAtExpiry.length === 0) {
        strikeSelect.innerHTML = '<option value="">No OTM strikes available</option>';
        return;
    }
    
    // Build options with bid/ask - color code based on breakeven
    strikeSelect.innerHTML = '<option value="">Select strike...</option>' + 
        callsAtExpiry.map(c => {
            const mid = ((c.bid + c.ask) / 2).toFixed(2);
            const delta = c.delta ? ` Δ${(c.delta * 100).toFixed(0)}` : '';
            const isSafe = c.strike >= breakevenStrike;
            const prefix = isSafe ? '✅' : '⚠️';
            return `<option value="${c.strike}" data-premium="${mid}" ${!isSafe ? 'style="color: #ffaa00;"' : ''}>${prefix} $${c.strike} (bid $${c.bid} / ${mid}${delta})</option>`;
        }).join('');
    
    console.log('[PMCC] Populated', callsAtExpiry.length, 'strikes for', expiry);
};

/**
 * When strike changes, auto-fill premium
 */
window.onPMCCStrikeChange = function() {
    const strikeSelect = document.getElementById('pmccShortStrike');
    const selectedOption = strikeSelect.options[strikeSelect.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) return;
    
    const premium = selectedOption.getAttribute('data-premium');
    if (premium) {
        document.getElementById('pmccShortPremium').value = premium;
    }
    
    // Calculate DTE from selected expiry
    const expiry = document.getElementById('pmccShortExpiry').value;
    if (expiry) {
        const dte = Math.round((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24));
        // Store DTE for calculations (we removed the input field)
        window.pmccData.shortDTE = dte;
    }
    
    // Trigger calculation
    window.calculatePMCC();
};

/**
 * Calculate PMCC scenarios based on short call inputs
 */
window.calculatePMCC = function() {
    if (!window.pmccData) return;
    
    const shortStrike = parseFloat(document.getElementById('pmccShortStrike').value) || 0;
    const shortExpiry = document.getElementById('pmccShortExpiry').value;
    const shortPremium = parseFloat(document.getElementById('pmccShortPremium').value) || 0;
    
    if (!shortStrike || !shortPremium || !shortExpiry) {
        document.getElementById('pmccResults').style.display = 'none';
        return;
    }
    
    // Calculate DTE
    const shortDTE = Math.round((new Date(shortExpiry) - new Date()) / (1000 * 60 * 60 * 24));
    
    const { position, spotPrice, leapsCost, currentValue, intrinsic, timeValue } = window.pmccData;
    const leapsStrike = position.strike;
    
    // Premium you keep if stock stays below strike
    const premiumCollected = shortPremium * 100;
    document.getElementById('pmccKeepPremium').textContent = `$${premiumCollected.toFixed(0)}`;
    
    // Monthly yield calculation
    const monthlyYield = (premiumCollected / leapsCost * 100).toFixed(1);
    const daysToMonthly = shortDTE / 30;
    const annualizedYield = (monthlyYield / daysToMonthly * 12).toFixed(1);
    
    document.getElementById('pmccMonthlyYield').textContent = `${monthlyYield}%`;
    document.getElementById('pmccAnnualizedYield').textContent = `Annualized: ${annualizedYield}%`;
    
    // If assigned scenario (stock at short strike)
    // Populate the display fields
    document.getElementById('pmccExerciseStrike').textContent = leapsStrike;
    document.getElementById('pmccShortStrikeDisplay').textContent = shortStrike;
    document.getElementById('pmccTimeValueDisplay').textContent = timeValue.toFixed(0);
    
    // Option 1: Exercise LEAPS
    const exerciseProceeds = (shortStrike - leapsStrike) * 100;  // Buy at leapsStrike, sell at shortStrike
    const exerciseProfit = exerciseProceeds - leapsCost + premiumCollected;
    
    // Option 2: Close LEAPS at current value
    const closeProfit = currentValue - leapsCost + premiumCollected;
    
    const exerciseEl = document.getElementById('pmccExerciseProfit');
    exerciseEl.textContent = `$${exerciseProfit.toFixed(0)}`;
    exerciseEl.style.color = exerciseProfit >= 0 ? '#00ff88' : '#ff5252';
    
    const closeEl = document.getElementById('pmccCloseProfit');
    closeEl.textContent = `$${closeProfit.toFixed(0)}`;
    closeEl.style.color = closeProfit >= 0 ? '#00ff88' : '#ff5252';
    
    // Recommendation
    const recEl = document.getElementById('pmccRecommendation');
    if (exerciseProfit > closeProfit) {
        recEl.textContent = `✅ Exercise LEAPS for $${(exerciseProfit - closeProfit).toFixed(0)} more profit`;
    } else {
        recEl.textContent = `✅ Close LEAPS for $${(closeProfit - exerciseProfit).toFixed(0)} more profit (preserve time value: $${timeValue.toFixed(0)})`;
    }
    
    // Breakeven and max profit
    const breakeven = leapsCost / 100;  // Per share breakeven
    document.getElementById('pmccBreakeven').textContent = `$${breakeven.toFixed(2)}`;
    
    const maxProfit = Math.max(exerciseProfit, closeProfit);
    document.getElementById('pmccMaxProfit').textContent = `$${maxProfit.toFixed(0)}`;
    document.getElementById('pmccMaxProfitStrike').textContent = `$${shortStrike.toFixed(0)}`;
    
    // Show results
    document.getElementById('pmccResults').style.display = 'block';
};

/**
 * Stage the short call to Ideas tab for execution
 */
window.stagePMCCTrade = function() {
    if (!window.pmccData) return;
    
    const { position } = window.pmccData;
    const shortStrike = parseFloat(document.getElementById('pmccShortStrike').value);
    const expiry = document.getElementById('pmccShortExpiry').value;
    const shortPremium = parseFloat(document.getElementById('pmccShortPremium').value);
    
    if (!shortStrike || !shortPremium || !expiry) {
        showNotification('Select strike, expiry, and premium first', 'warning');
        return;
    }
    
    // Stage to pending - use correct field names for TradeCardService
    const trade = {
        newStrike: shortStrike,  // TradeCardService expects newStrike
        newExpiry: expiry,       // TradeCardService expects newExpiry  
        newType: 'CALL',         // Short call
        rationale: `PMCC: Short call against ${position.ticker} $${position.strike || position.leapsStrike} LEAPS. Yield: ${document.getElementById('pmccMonthlyYield')?.textContent || '?'}/month`
    };
    
    window.TradeCardService?.stageToPending(trade, {
        ticker: position.ticker,
        source: 'pmcc_calculator',
        badge: 'PMCC',
        parentPositionId: position.id  // Link to parent LEAPS for nesting
    });
    
    showNotification(`PMCC short call staged to Ideas tab`, 'success');
    document.getElementById('pmccModal')?.remove();
    
    // Switch to Ideas tab
    const ideasTab = document.querySelector('[data-tab="ideas"]');
    if (ideasTab) ideasTab.click();
};

/**
 * Show the roll options panel
 */
window.showPMCCRollOptions = function() {
    const panel = document.getElementById('pmccRollPanel');
    if (!panel) return;
    
    // Toggle visibility
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        
        // Populate expiry dropdown from cached chain data
        if (window.pmccChainData) {
            const today = new Date();
            const currentExpiry = document.getElementById('pmccShortExpiry').value;
            
            const expiries = [...new Set(window.pmccChainData.map(c => c.expiration))]
                .filter(exp => new Date(exp) > today)
                .sort((a, b) => new Date(a) - new Date(b))
                .slice(0, 12);
            
            const expirySelect = document.getElementById('pmccRollExpiry');
            expirySelect.innerHTML = '<option value="">Select expiry...</option>' + 
                expiries.map(exp => {
                    const date = new Date(exp);
                    const dte = Math.round((date - today) / (1000 * 60 * 60 * 24));
                    const isLater = exp > currentExpiry;
                    const prefix = isLater ? '📅' : '⚡';
                    return `<option value="${exp}">${prefix} ${exp} (${dte}d)</option>`;
                }).join('');
        }
    } else {
        panel.style.display = 'none';
    }
};

/**
 * When roll expiry changes, populate strikes
 */
window.onPMCCRollExpiryChange = function() {
    const expiry = document.getElementById('pmccRollExpiry').value;
    if (!expiry || !window.pmccChainData || !window.pmccData) return;
    
    const { spotPrice, breakevenStrike } = window.pmccData;
    const currentStrike = parseFloat(document.getElementById('pmccShortStrike').value) || 0;
    
    const callsAtExpiry = window.pmccChainData
        .filter(c => c.expiration === expiry && c.strike >= spotPrice)
        .sort((a, b) => a.strike - b.strike);
    
    const strikeSelect = document.getElementById('pmccRollStrike');
    strikeSelect.innerHTML = '<option value="">Select strike...</option>' + 
        callsAtExpiry.map(c => {
            const mid = ((c.bid + c.ask) / 2).toFixed(2);
            const isSafe = c.strike >= breakevenStrike;
            const isHigher = c.strike > currentStrike;
            const prefix = isSafe ? (isHigher ? '⬆️' : '✅') : '⚠️';
            return `<option value="${c.strike}" data-premium="${mid}">${prefix} $${c.strike} ($${mid})</option>`;
        }).join('');
    
    document.getElementById('pmccRollSummary').style.display = 'none';
};

/**
 * When roll strike changes, calculate net credit/debit
 */
window.onPMCCRollStrikeChange = function() {
    const strikeSelect = document.getElementById('pmccRollStrike');
    const selectedOption = strikeSelect.options[strikeSelect.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) {
        document.getElementById('pmccRollSummary').style.display = 'none';
        return;
    }
    
    const newPremium = parseFloat(selectedOption.getAttribute('data-premium')) || 0;
    const currentPremium = parseFloat(document.getElementById('pmccShortPremium').value) || 0;
    
    // Estimate buyback cost (current premium + a bit for spread)
    // In reality, need current market price of short call
    const buyBackCost = currentPremium * 1.1;  // Rough estimate - should fetch live price
    
    const netCreditDebit = newPremium - buyBackCost;
    
    document.getElementById('pmccRollBuyBack').textContent = `-$${(buyBackCost * 100).toFixed(0)}`;
    document.getElementById('pmccRollNewPremium').textContent = `+$${(newPremium * 100).toFixed(0)}`;
    
    const netEl = document.getElementById('pmccRollNet');
    const netAmount = netCreditDebit * 100;
    netEl.textContent = netAmount >= 0 ? `+$${netAmount.toFixed(0)} credit` : `-$${Math.abs(netAmount).toFixed(0)} debit`;
    netEl.style.color = netAmount >= 0 ? '#00ff88' : '#ff5252';
    
    document.getElementById('pmccRollSummary').style.display = 'block';
    
    // Store for staging
    window.pmccRollData = {
        newExpiry: document.getElementById('pmccRollExpiry').value,
        newStrike: parseFloat(selectedOption.value),
        newPremium,
        buyBackCost,
        netCreditDebit
    };
};

/**
 * Stage the roll to Ideas tab
 */
window.stagePMCCRoll = function() {
    if (!window.pmccData || !window.pmccRollData) {
        showNotification('Select new strike and expiry first', 'warning');
        return;
    }
    
    const { position } = window.pmccData;
    const currentStrike = parseFloat(document.getElementById('pmccShortStrike').value);
    const currentExpiry = document.getElementById('pmccShortExpiry').value;
    const { newExpiry, newStrike, newPremium, netCreditDebit } = window.pmccRollData;
    
    const netText = netCreditDebit >= 0 ? `$${(netCreditDebit * 100).toFixed(0)} credit` : `$${Math.abs(netCreditDebit * 100).toFixed(0)} debit`;
    
    const trade = {
        ticker: position.ticker,
        action: 'ROLL',
        type: 'short_call',
        closeStrike: currentStrike,
        closeExpiry: currentExpiry,
        newStrike,
        newExpiry,
        premium: newPremium,
        contracts: 1,
        source: 'pmcc_calculator',
        badge: 'ROLL',
        rationale: `PMCC Roll: $${currentStrike} → $${newStrike}, ${currentExpiry} → ${newExpiry}. Net: ${netText}`
    };
    
    window.TradeCardService?.stageToPending(trade, {
        ticker: position.ticker,
        source: 'pmcc_calculator',
        badge: 'ROLL'
    });
    
    showNotification(`PMCC roll staged to Ideas tab`, 'success');
    document.getElementById('pmccModal').remove();
    
    const ideasTab = document.querySelector('[data-tab="ideas"]');
    if (ideasTab) ideasTab.click();
};

// ES module exports
export const openPMCCCalculator = window.openPMCCCalculator;
export const loadPMCCPosition = window.loadPMCCPosition;
export const loadPMCCChain = window.loadPMCCChain;
export const calculatePMCC = window.calculatePMCC;
export const stagePMCCTrade = window.stagePMCCTrade;
export const showPMCCRollOptions = window.showPMCCRollOptions;
export const stagePMCCRoll = window.stagePMCCRoll;
