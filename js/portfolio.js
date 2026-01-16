// WheelHouse - Portfolio P&L Tracker
// Tracks actual P&L across all positions

import { state } from './state.js';
import { showNotification } from './utils.js';
import { fetchFromYahoo, fetchOptionsChain, findOption } from './api.js';

const STORAGE_KEY_CLOSED = 'wheelhouse_closed_positions';
const CHECKPOINT_KEY = 'wheelhouse_data_checkpoint';

/**
 * Trigger auto-save if enabled (calls the global function from positions.js)
 */
function triggerAutoSave() {
    if (window.triggerAutoSave) window.triggerAutoSave();
}

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
 * Load closed positions from storage
 */
export function loadClosedPositions() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY_CLOSED);
        state.closedPositions = saved ? JSON.parse(saved) : [];
    } catch (e) {
        state.closedPositions = [];
    }
}

/**
 * Save closed positions to storage
 */
function saveClosedPositions() {
    localStorage.setItem(STORAGE_KEY_CLOSED, JSON.stringify(state.closedPositions || []));
    saveDataCheckpoint(); // Track data count for integrity check
    triggerAutoSave();
}

/**
 * Fetch current option price for a position from CBOE (real market data)
 * Falls back to Black-Scholes if CBOE doesn't have the option
 */
async function fetchCurrentOptionPrice(position) {
    try {
        // Fetch stock price and options chain from CBOE
        const [stockResult, optionsChain] = await Promise.all([
            fetchFromYahoo(position.ticker),
            fetchOptionsChain(position.ticker).catch(() => null)
        ]);
        
        const spot = stockResult.meta?.regularMarketPrice;
        if (!spot) return { success: false };
        
        const isPut = position.type.toLowerCase().includes('put');
        const strike = position.strike;
        
        console.log(`[MATCH] ${position.ticker}: Looking for ${isPut ? 'PUT' : 'CALL'} @ $${strike}`);
        
        // Try to find the exact option in CBOE data
        if (optionsChain) {
            // Convert expiry to YYYY-MM-DD format
            let expDate = position.expiry;
            console.log(`[MATCH]   Original expiry: ${expDate}`);
            
            if (expDate && expDate.includes('/')) {
                const parts = expDate.split('/');
                if (parts.length === 3) {
                    expDate = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
                }
            }
            console.log(`[MATCH]   Normalized expiry: ${expDate}`);
            console.log(`[MATCH]   Available expirations: ${optionsChain.expirations.slice(0,5).join(', ')}...`);
            
            // Find the option
            const options = isPut ? optionsChain.puts : optionsChain.calls;
            console.log(`[MATCH]   ${options.length} ${isPut ? 'puts' : 'calls'} in chain`);
            
            let matchedOption = findOption(options, strike, expDate);
            
            // If no exact match, try nearest expiration
            if (!matchedOption && optionsChain.expirations.length > 0) {
                console.log(`[MATCH]   No exact match, finding nearest expiration...`);
                const targetTime = new Date(expDate).getTime();
                let closestExp = optionsChain.expirations[0];
                let closestDiff = Math.abs(new Date(closestExp).getTime() - targetTime);
                
                for (const exp of optionsChain.expirations) {
                    const diff = Math.abs(new Date(exp).getTime() - targetTime);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                        closestExp = exp;
                    }
                }
                console.log(`[MATCH]   Trying nearest: ${closestExp}`);
                matchedOption = findOption(options, strike, closestExp);
            }
            
            if (matchedOption) {
                // Prefer last trade price over mid-price (more accurate for stale data)
                const midPrice = (matchedOption.bid + matchedOption.ask) / 2;
                const lastPrice = matchedOption.lastPrice || 0;
                const usePrice = lastPrice > 0 ? lastPrice : midPrice;
                const priceSource = lastPrice > 0 ? 'last' : 'mid';
                
                console.log(`[MATCH]   ✅ FOUND: ${matchedOption.symbol || 'no symbol'}`);
                console.log(`[MATCH]   Strike: $${matchedOption.strike}, Exp: ${matchedOption.expiration}, Type: ${matchedOption.type}`);
                console.log(`[MATCH]   Bid: $${matchedOption.bid} | Ask: $${matchedOption.ask} | Mid: $${midPrice.toFixed(2)} | Last: $${lastPrice.toFixed(2)}`);
                console.log(`[MATCH]   Using ${priceSource} price: $${usePrice.toFixed(2)}`);
                console.log(`[MATCH]   Position expiry: ${position.expiry}, DTE: ${position.dte}`);
                
                // Check staleness - CBOE timestamp format: "2026-01-16 17:46:21"
                const cboeTimestamp = optionsChain.timestamp;
                let dataAgeMinutes = null;
                if (cboeTimestamp) {
                    const cboeTime = new Date(cboeTimestamp.replace(' ', 'T'));
                    dataAgeMinutes = Math.round((Date.now() - cboeTime.getTime()) / 60000);
                    console.log(`[MATCH]   Data age: ${dataAgeMinutes} minutes`);
                }
                
                return {
                    spot,
                    optionPrice: usePrice,
                    bid: matchedOption.bid,
                    ask: matchedOption.ask,
                    lastPrice: lastPrice,
                    priceSource: priceSource,
                    iv: matchedOption.impliedVolatility,
                    delta: matchedOption.delta,
                    isLive: true,
                    dataAgeMinutes: dataAgeMinutes,
                    cboeTimestamp: cboeTimestamp,
                    success: true
                };
            } else {
                console.log(`[MATCH]   ❌ No match found, using Black-Scholes fallback`);
                // Show sample of available strikes at nearest expiration
                const nearestExp = optionsChain.expirations[0];
                const sampleStrikes = options
                    .filter(o => o.expiration === nearestExp)
                    .map(o => o.strike)
                    .slice(0, 10);
                console.log(`[MATCH]   Sample strikes at ${nearestExp}: ${sampleStrikes.join(', ')}`);
            }
        }
        
        // Fallback to Black-Scholes with estimated IV
        const dte = Math.max(1, position.dte);
        const T = dte / 365;
        const r = 0.05;
        const sigma = 0.30; // Fallback IV
        
        const price = blackScholesPrice(spot, strike, T, r, sigma, isPut);
        
        return {
            spot,
            optionPrice: Math.max(0.01, price),
            isLive: false,
            success: true
        };
    } catch (e) {
        console.warn(`Failed to fetch price for ${position.ticker}:`, e.message);
    }
    return { success: false };
}

/**
 * Simple Black-Scholes pricing
 */
function blackScholesPrice(S, K, T, r, sigma, isPut) {
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    const Nd1 = normalCDF(d1);
    const Nd2 = normalCDF(d2);
    
    if (isPut) {
        return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
    } else {
        return S * Nd1 - K * Math.exp(-r * T) * Nd2;
    }
}

function normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

/**
 * Render the portfolio table with P&L
 */
export async function renderPortfolio(fetchPrices = false) {
    const tableEl = document.getElementById('portfolioTable');
    const loadingEl = document.getElementById('portfolioLoading');
    
    if (!tableEl) return;
    
    // Filter to only show OPEN positions (not closed ones)
    const positions = (state.positions || []).filter(p => p.status === 'open');
    
    if (positions.length === 0) {
        tableEl.innerHTML = `
            <div style="text-align:center; padding:40px; color:#888;">
                <div style="font-size:48px; margin-bottom:10px;">📋</div>
                <div>No open positions. Add positions in the Positions tab.</div>
            </div>
        `;
        updatePortfolioSummary([]);
        return;
    }
    
    // Show loading if fetching prices
    if (fetchPrices && loadingEl) {
        loadingEl.style.display = 'block';
    }
    
    // Build position data with P&L
    const positionData = [];
    let fetchSuccessCount = 0;
    let fetchFailCount = 0;
    
    for (const pos of positions) {
        // Prefer user's marked price over calculated price
        let currentPrice = pos.markedPrice || pos.lastOptionPrice || null;
        let currentSpot = pos.currentSpot || null;
        let isLivePrice = false;
        let optionIV = null;
        let optionDelta = null;
        let priceSource = null;
        
        let dataAgeMinutes = null;
        let isStale = false;
        
        if (fetchPrices) {
            const result = await fetchCurrentOptionPrice(pos);
            if (result.success) {
                fetchSuccessCount++;
                // Always update spot price
                currentSpot = result.spot;
                pos.currentSpot = currentSpot;
                
                // Track if this is live CBOE data
                isLivePrice = result.isLive || false;
                optionIV = result.iv || null;
                optionDelta = result.delta || null;
                dataAgeMinutes = result.dataAgeMinutes || null;
                priceSource = result.priceSource || null;
                isStale = dataAgeMinutes !== null && dataAgeMinutes > 15;
                
                console.log(`[RENDER] ${pos.ticker}: markedPrice=${pos.markedPrice}, result.optionPrice=${result.optionPrice?.toFixed(2)}, isLive=${result.isLive}, source=${priceSource}, age=${dataAgeMinutes}min, stale=${isStale}`);
                
                // Live CBOE data takes precedence over marked prices
                // Marked price is only used as fallback when live data unavailable
                if (isLivePrice) {
                    currentPrice = result.optionPrice;
                    pos.lastOptionPrice = currentPrice;
                    pos.isLivePrice = isLivePrice;
                    pos.optionIV = optionIV;
                    pos.optionDelta = optionDelta;
                    pos.dataAgeMinutes = dataAgeMinutes;
                    pos.isStale = isStale;
                    pos.priceSource = priceSource;
                    // Clear marked price when we have live data
                    if (pos.markedPrice) {
                        console.log(`[RENDER]   → Live ${priceSource} price $${currentPrice?.toFixed(2)} replaces marked price $${pos.markedPrice.toFixed(2)}`);
                        delete pos.markedPrice;
                    } else {
                        console.log(`[RENDER]   → Using live ${priceSource} price: $${currentPrice?.toFixed(2)}`);
                    }
                } else if (!pos.markedPrice) {
                    // Fallback: use calculated price if no marked price
                    currentPrice = result.optionPrice;
                    pos.lastOptionPrice = currentPrice;
                    console.log(`[RENDER]   → Using calculated price: $${currentPrice?.toFixed(2)}`);
                } else {
                    // Keep using user's marked price (only for non-live data)
                    currentPrice = pos.markedPrice;
                    console.log(`[RENDER]   → Using MARKED price: $${currentPrice?.toFixed(2)} (no live data)`);
                }
                
                // Save updated spot to localStorage
                localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
            } else {
                fetchFailCount++;
            }
        }
        
        // Calculate P&L: Premium received - current option value
        // For short options: we WANT the option price to go DOWN
        const premiumReceived = pos.premium * 100 * pos.contracts;
        const currentValue = currentPrice ? currentPrice * 100 * pos.contracts : null;
        const unrealizedPnL = currentValue !== null ? premiumReceived - currentValue : null;
        const pnlPercent = unrealizedPnL !== null ? (unrealizedPnL / premiumReceived) * 100 : null;
        
        positionData.push({
            ...pos,
            currentSpot,
            currentPrice,
            isLivePrice: isLivePrice || pos.isLivePrice || false,
            optionIV: optionIV || pos.optionIV || null,
            optionDelta: optionDelta || pos.optionDelta || null,
            dataAgeMinutes: dataAgeMinutes || pos.dataAgeMinutes || null,
            isStale: isStale || pos.isStale || false,
            priceSource: priceSource || pos.priceSource || null,
            premiumReceived,
            currentValue,
            unrealizedPnL,
            pnlPercent
        });
    }
    
    if (loadingEl) loadingEl.style.display = 'none';
    
    // Show fetch result notification
    if (fetchPrices) {
        const liveCount = positionData.filter(p => p.isLivePrice).length;
        if (fetchSuccessCount > 0) {
            if (liveCount > 0) {
                showNotification(`📡 Updated ${liveCount} with CBOE live prices`, 'success');
            } else {
                showNotification(`Updated ${fetchSuccessCount} position(s) (calculated)`, 'success');
            }
        } else if (fetchFailCount > 0) {
            showNotification(`Failed to fetch prices - try again`, 'error');
        }
    }
    
    // Render table
    tableEl.innerHTML = `
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead>
                <tr style="background:rgba(0,217,255,0.15); color:#00d9ff;">
                    <th style="padding:10px; text-align:left;">Ticker</th>
                    <th style="padding:10px; text-align:left;">Type</th>
                    <th style="padding:10px; text-align:right;">Strike</th>
                    <th style="padding:10px; text-align:right;">Spot</th>
                    <th style="padding:10px; text-align:right;">DTE</th>
                    <th style="padding:10px; text-align:right;">Premium</th>
                    <th style="padding:10px; text-align:right;" title="Price per contract when opened">Open</th>
                    <th style="padding:10px; text-align:right;" title="Current market price per contract">Current</th>
                    <th style="padding:10px; text-align:right;">P&L</th>
                    <th style="padding:10px; text-align:center;">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${positionData.map(pos => {
                    const pnlColor = pos.unrealizedPnL === null ? '#888' : 
                                     pos.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
                    const pnlBg = pos.unrealizedPnL === null ? '' :
                                  pos.unrealizedPnL >= 0 ? 'rgba(0,255,136,0.1)' : 'rgba(255,82,82,0.1)';
                    
                    // Check if ITM (in danger)
                    const isPut = pos.type.toLowerCase().includes('put');
                    const isITM = pos.currentSpot !== null && 
                                  (isPut ? pos.currentSpot < pos.strike : pos.currentSpot > pos.strike);
                    const itmWarning = isITM ? '⚠️' : '';
                    const totalPremium = pos.premium * 100 * pos.contracts;
                    
                    // Price change indicator (down is good for short options)
                    const priceChange = pos.currentPrice && pos.premium ? pos.currentPrice - pos.premium : null;
                    const priceChangeColor = priceChange === null ? '#888' : priceChange <= 0 ? '#00ff88' : '#ff5252';
                    
                    // Staleness indicator
                    const staleWarning = pos.isStale ? `<span style="color:#ff9800; font-size:10px;" title="Data is ${pos.dataAgeMinutes}+ min old"> ⚠️</span>` : '';
                    const freshCheck = !pos.isStale && pos.isLivePrice ? '<span style="color:#00ff88; font-size:10px;"> ✓</span>' : '';
                    const priceIndicator = pos.markedPrice ? '<span style="color:#00d9ff; font-size:10px;"> ✓</span>' : 
                                          pos.isLivePrice ? (staleWarning || freshCheck) :
                                          pos.currentPrice ? '<span style="color:#888; font-size:10px;"> ~</span>' : '';
                    
                    // Tooltip with age info
                    const currentTooltip = pos.markedPrice ? 'User-entered price' : 
                                          pos.isLivePrice ? `CBOE ${pos.priceSource || 'mid'}-price${pos.dataAgeMinutes ? ' (' + pos.dataAgeMinutes + ' min ago)' : ''}${pos.optionIV ? ' | IV: ' + (pos.optionIV * 100).toFixed(0) + '%' : ''}` : 
                                          'Calculated (BS model)';
                    
                    return `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.1); background:${pnlBg};">
                            <td style="padding:10px; font-weight:bold; color:#00d9ff;">${pos.ticker}</td>
                            <td style="padding:10px; color:${isPut ? '#ff5252' : '#00ff88'};">${pos.type.replace('_', ' ')}</td>
                            <td style="padding:10px; text-align:right;">$${pos.strike.toFixed(2)}</td>
                            <td style="padding:10px; text-align:right;">${pos.currentSpot ? '$' + pos.currentSpot.toFixed(2) + ' ' + itmWarning : '—'}</td>
                            <td style="padding:10px; text-align:right; color:${pos.dte <= 7 ? '#ff5252' : pos.dte <= 14 ? '#ffaa00' : '#888'};">${pos.dte}d</td>
                            <td style="padding:10px; text-align:right; color:#00ff88;" title="$${pos.premium.toFixed(2)} × ${pos.contracts} contracts">$${totalPremium.toFixed(0)}</td>
                            <td style="padding:10px; text-align:right; color:#888;" title="Price received when opened">$${pos.premium.toFixed(2)}</td>
                            <td style="padding:10px; text-align:right; color:${priceChangeColor};" title="${currentTooltip}">
                                ${pos.currentPrice ? '$' + pos.currentPrice.toFixed(2) : '—'}${priceIndicator}
                            </td>
                            <td style="padding:10px; text-align:right; font-weight:bold; color:${pnlColor};">
                                ${pos.unrealizedPnL !== null ? 
                                    (pos.unrealizedPnL >= 0 ? '+' : '') + '$' + pos.unrealizedPnL.toFixed(0) + 
                                    ' (' + (pos.pnlPercent >= 0 ? '+' : '') + pos.pnlPercent.toFixed(0) + '%)'
                                    : '—'}
                            </td>
                            <td style="padding:10px; text-align:center; white-space:nowrap;">
                                <button onclick="window.analyzeFromPortfolio(${pos.id})" 
                                        style="background:#8b5cf6; border:none; color:#fff; padding:4px 8px; 
                                               border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;"
                                        title="Get AI analysis for this position">
                                    🤖 AI
                                </button>
                                <button onclick="window.markPrice(${pos.id})" 
                                        style="background:#00d9ff; border:none; color:#000; padding:4px 8px; 
                                               border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;"
                                        title="Enter current option price from broker">
                                    ✎ Mark
                                </button>
                                <button onclick="window.showQuickLinkModal(${pos.id})" 
                                        style="background:${pos.challengeIds?.length ? '#8b5cf6' : 'rgba(139,92,246,0.3)'}; 
                                               border:none; color:#fff; padding:4px 8px; 
                                               border-radius:4px; cursor:pointer; font-size:11px;"
                                        title="${pos.challengeIds?.length ? 'Linked to ' + pos.challengeIds.length + ' challenge(s)' : 'Link to a challenge'}">
                                    🏆${pos.challengeIds?.length ? ' ' + pos.challengeIds.length : ''}
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
    
    // Render closed positions first (initializes year filter)
    renderClosedPositions();
    // Then update summary (uses the year filter for performance stats)
    updatePortfolioSummary(positionData);
    renderHoldings();
}

/**
 * Update portfolio summary stats
 */
function updatePortfolioSummary(positionData) {
    const openCount = positionData.length;
    const totalPremium = positionData.reduce((sum, p) => sum + p.premiumReceived, 0);
    const capitalRisk = positionData.reduce((sum, p) => sum + (p.strike * 100 * p.contracts), 0);
    const unrealizedPnL = positionData.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
    
    // Filter closed positions by selected year
    const allClosed = state.closedPositions || [];
    const yearFilter = state.closedYearFilter || 'all';
    const filteredClosed = yearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === yearFilter;
        });
    
    // Realized P&L from filtered closed positions (support both field names)
    const realizedPnL = filteredClosed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const totalPnL = unrealizedPnL + realizedPnL;
    
    // Update display
    setEl('portOpenCount', openCount.toString());
    setEl('portTotalPremium', '$' + totalPremium.toFixed(0));
    setEl('portCapitalRisk', '$' + capitalRisk.toLocaleString());
    
    const unrealEl = document.getElementById('portUnrealizedPnL');
    if (unrealEl) {
        unrealEl.textContent = (unrealizedPnL >= 0 ? '+$' : '-$') + Math.abs(unrealizedPnL).toFixed(0);
        unrealEl.style.color = unrealizedPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    const realEl = document.getElementById('portRealizedPnL');
    if (realEl) {
        realEl.textContent = (realizedPnL >= 0 ? '+$' : '-$') + Math.abs(realizedPnL).toFixed(0);
        realEl.style.color = realizedPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    const totalEl = document.getElementById('portTotalPnL');
    if (totalEl) {
        totalEl.textContent = (totalPnL >= 0 ? '+$' : '-$') + Math.abs(totalPnL).toFixed(0);
        totalEl.style.color = totalPnL >= 0 ? '#00ff88' : '#ff5252';
    }
    
    // Performance stats use the same filtered closed positions
    if (filteredClosed.length > 0) {
        // Helper to get P&L from either field name
        const getPnL = (p) => p.realizedPnL ?? p.closePnL ?? 0;
        
        // Helper to get days held - calculate from dates if not stored
        const getDaysHeld = (p) => {
            if (p.daysHeld) return p.daysHeld;
            if (p.openDate && p.closeDate) {
                const open = new Date(p.openDate);
                const close = new Date(p.closeDate);
                if (!isNaN(open) && !isNaN(close)) {
                    return Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
                }
            }
            return 0;
        };
        
        const wins = filteredClosed.filter(p => getPnL(p) >= 0).length;
        const winRate = (wins / filteredClosed.length) * 100;
        const avgDays = filteredClosed.reduce((sum, p) => sum + getDaysHeld(p), 0) / filteredClosed.length;
        
        // Find best and worst trades
        const bestTrade = filteredClosed.reduce((best, p) => getPnL(p) > getPnL(best) ? p : best, filteredClosed[0]);
        const worstTrade = filteredClosed.reduce((worst, p) => getPnL(p) < getPnL(worst) ? p : worst, filteredClosed[0]);
        
        setEl('portWinRate', winRate.toFixed(0) + '%');
        setEl('portAvgDays', avgDays.toFixed(0) + 'd');
        
        // Best trade (always positive, green)
        const bestEl = document.getElementById('portBestTrade');
        if (bestEl) {
            const bestPnL = getPnL(bestTrade);
            bestEl.textContent = (bestPnL >= 0 ? '+$' : '-$') + Math.abs(bestPnL).toFixed(0);
            bestEl.style.color = '#00ff88';
            bestEl.style.cursor = 'pointer';
            bestEl.title = `Click to see details`;
            bestEl.onclick = () => showTradeDetails(bestTrade, 'Best Trade');
        }
        
        // Worst trade (may be negative, red)
        const worstEl = document.getElementById('portWorstTrade');
        if (worstEl) {
            const worstPnL = getPnL(worstTrade);
            worstEl.textContent = (worstPnL >= 0 ? '+$' : '-$') + Math.abs(worstPnL).toFixed(0);
            worstEl.style.color = worstPnL >= 0 ? '#ffaa00' : '#ff5252';
            worstEl.style.cursor = 'pointer';
            worstEl.title = `Click to see details`;
            worstEl.onclick = () => showTradeDetails(worstTrade, 'Worst Trade');
        }
    } else {
        // No closed positions for this filter - show defaults
        setEl('portWinRate', '—');
        setEl('portAvgDays', '—');
        setEl('portBestTrade', '—');
        setEl('portWorstTrade', '—');
    }
}

/**
 * Show trade details in a notification or alert
 */
function showTradeDetails(trade, label) {
    const pnl = trade.realizedPnL ?? trade.closePnL ?? 0;
    const pnlStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(0);
    const msg = `${label}: ${trade.ticker} ${trade.type.replace('_', ' ')}\n` +
                `Strike: $${trade.strike.toFixed(2)}\n` +
                `Premium: $${trade.premium.toFixed(2)} × ${trade.contracts || 1}\n` +
                `Opened: ${trade.openDate || '?'} → Closed: ${trade.closeDate || '?'}\n` +
                `Days Held: ${trade.daysHeld || '?'}\n` +
                `P&L: ${pnlStr}`;
    
    // Show for 6 seconds since there's lots of info to read
    showNotification(msg.replace(/\n/g, ' | '), pnl >= 0 ? 'success' : 'warning', 6000);
}

function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

/**
 * Show the Close Position panel (no popups!)
 */
export function showClosePanel(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    state.closingPositionId = id;
    
    // Populate panel info
    const infoEl = document.getElementById('closeCurrentInfo');
    if (infoEl) {
        infoEl.innerHTML = `
            <strong style="color:#00ff88;">${pos.ticker}</strong> 
            ${pos.type.replace('_', ' ')} @ <strong>$${pos.strike.toFixed(2)}</strong>
            <br>Premium received: <strong>$${pos.premium.toFixed(2)}</strong> × ${pos.contracts} contract(s)
            <br>Opened: ${pos.openDate || 'Unknown'}
        `;
    }
    
    // Set defaults
    const closingPriceInput = document.getElementById('closeClosingPrice');
    if (closingPriceInput) {
        closingPriceInput.value = pos.markedPrice?.toFixed(2) || pos.lastOptionPrice?.toFixed(2) || '0.00';
    }
    
    const closeDateInput = document.getElementById('closeDate');
    if (closeDateInput) {
        closeDateInput.value = new Date().toISOString().split('T')[0];
    }
    
    // Update P&L preview
    updateClosePnLPreview();
    
    // Show panel
    const closePanel = document.getElementById('closePanel');
    if (closePanel) closePanel.style.display = 'block';
    
    // Hide roll panel if visible
    const rollPanel = document.getElementById('rollPanel');
    if (rollPanel) rollPanel.style.display = 'none';
    
    // Add live update listeners
    if (closingPriceInput) {
        closingPriceInput.oninput = updateClosePnLPreview;
    }
}
window.showClosePanel = showClosePanel;

/**
 * Update the P&L preview in the close panel
 */
function updateClosePnLPreview() {
    const pos = state.positions.find(p => p.id === state.closingPositionId);
    if (!pos) return;
    
    const closingPrice = parseFloat(document.getElementById('closeClosingPrice')?.value) || 0;
    const premiumReceived = pos.premium * 100 * pos.contracts;
    const closingCost = closingPrice * 100 * pos.contracts;
    const pnl = premiumReceived - closingCost;
    
    const pnlEl = document.getElementById('closePnLValue');
    if (pnlEl) {
        pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`;
        pnlEl.style.color = pnl >= 0 ? '#00ff88' : '#ff5252';
    }
}

/**
 * Execute the close from the panel
 */
export function executeClose() {
    const id = state.closingPositionId;
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const closingPrice = parseFloat(document.getElementById('closeClosingPrice')?.value);
    const closeDateValue = document.getElementById('closeDate')?.value;
    
    if (isNaN(closingPrice) || closingPrice < 0) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    
    if (!closeDateValue) {
        showNotification('Please enter a close date', 'error');
        return;
    }
    
    // Calculate realized P&L
    const premiumReceived = pos.premium * 100 * pos.contracts;
    const closingCost = closingPrice * 100 * pos.contracts;
    const realizedPnL = premiumReceived - closingCost;
    
    // Calculate days held
    const today = new Date().toISOString().split('T')[0];
    const openDate = new Date(pos.openDate || today);
    const closeDate = new Date(closeDateValue);
    const daysHeld = Math.max(0, Math.ceil((closeDate - openDate) / (1000 * 60 * 60 * 24)));
    
    // Add to closed positions
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        ...pos,
        closeDate: closeDateValue,
        daysHeld,
        closingPrice,
        realizedPnL
    });
    saveClosedPositions();
    
    // Remove from open positions
    state.positions = state.positions.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    showNotification(`Closed ${pos.ticker}: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)} P&L`, 
                     realizedPnL >= 0 ? 'success' : 'warning');
    
    // Hide panel and refresh
    cancelClose();
    renderPortfolio(false);
}
window.executeClose = executeClose;

/**
 * Cancel close and hide panel
 */
export function cancelClose() {
    state.closingPositionId = null;
    const closePanel = document.getElementById('closePanel');
    if (closePanel) closePanel.style.display = 'none';
}
window.cancelClose = cancelClose;

/**
 * Render closed positions history - grouped by chain for rolled positions
 */
function renderClosedPositions() {
    const el = document.getElementById('closedPositionsTable');
    if (!el) return;
    
    const allClosed = state.closedPositions || [];
    
    if (allClosed.length === 0) {
        el.innerHTML = '<div style="color:#888;">No closed positions yet.</div>';
        return;
    }
    
    // Get available years from closed positions
    const years = [...new Set(allClosed.map(p => {
        const closeDate = p.closeDate || '';
        // Extract 4-digit year from start of date string
        const match = closeDate.match(/^(\d{4})/);
        return match ? match[1] : null;
    }).filter(y => y))].sort().reverse();
    
    // Current filter (stored in state)
    // Default to current year if it has positions, otherwise 'all'
    const currentYear = new Date().getFullYear().toString();
    const hasCurrentYearPositions = allClosed.some(p => (p.closeDate || '').startsWith(currentYear));
    
    if (!state.closedYearFilter) {
        // First load - default to current year if it has data, otherwise show all
        state.closedYearFilter = hasCurrentYearPositions ? currentYear : 'all';
    }
    
    // Validate filter - if selected year doesn't exist in data, reset to 'all'
    if (state.closedYearFilter !== 'all' && !years.includes(state.closedYearFilter)) {
        state.closedYearFilter = 'all';
    }
    
    // Filter positions by selected year (based on CLOSE date for tax purposes)
    const closed = state.closedYearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === state.closedYearFilter;
        });
    
    // Calculate YTD P&L (current year only) - support both realizedPnL and closePnL
    const ytdPnL = allClosed
        .filter(p => (p.closeDate || '').startsWith(currentYear))
        .reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    
    // Build filter dropdown and export button
    let filterHtml = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <label style="color:#888; font-size:12px;">Tax Year:</label>
                <select id="closedYearFilter" style="padding:4px 8px; font-size:12px;">
                    <option value="all" ${state.closedYearFilter === 'all' ? 'selected' : ''}>All Years</option>
                    ${years.map(y => `<option value="${y}" ${state.closedYearFilter === y ? 'selected' : ''}>${y}</option>`).join('')}
                </select>
                <span style="color:#888; font-size:11px;">(${closed.length} trades)</span>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
                <span style="color:#888; font-size:11px;">YTD ${currentYear}:</span>
                <span style="font-weight:bold; color:${ytdPnL >= 0 ? '#00ff88' : '#ff5252'};">
                    ${ytdPnL >= 0 ? '+' : ''}$${ytdPnL.toFixed(0)}
                </span>
                <button onclick="window.exportClosedForTax()" 
                        style="padding:4px 8px; font-size:11px; background:#2a2a4e; border:1px solid #444; color:#aaa; border-radius:4px; cursor:pointer;"
                        title="Export filtered trades as CSV for tax records">
                    📥 Export CSV
                </button>
            </div>
        </div>
    `;
    
    if (closed.length === 0) {
        el.innerHTML = filterHtml + `<div style="color:#888; padding:20px; text-align:center;">No closed positions in ${state.closedYearFilter}.</div>`;
        // Attach filter listener
        setTimeout(() => attachYearFilterListener(), 0);
        return;
    }
    
    // Group positions by chainId (or use id if no chainId - legacy positions)
    const chains = {};
    closed.forEach(pos => {
        const chainKey = pos.chainId || pos.id;
        if (!chains[chainKey]) {
            chains[chainKey] = {
                positions: [],
                totalPnL: 0,
                ticker: pos.ticker,
                firstOpen: pos.openDate,
                lastClose: pos.closeDate,
                totalDays: 0
            };
        }
        chains[chainKey].positions.push(pos);
        // Support both realizedPnL (app-created) and closePnL (imported from broker)
        chains[chainKey].totalPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
        // Track date range
        if (pos.openDate && (!chains[chainKey].firstOpen || pos.openDate < chains[chainKey].firstOpen)) {
            chains[chainKey].firstOpen = pos.openDate;
        }
        if (pos.closeDate && (!chains[chainKey].lastClose || pos.closeDate > chains[chainKey].lastClose)) {
            chains[chainKey].lastClose = pos.closeDate;
        }
    });
    
    // Sort chains by last close date (newest first)
    const sortedChains = Object.values(chains).sort((a, b) => {
        const dateA = a.positions[a.positions.length - 1]?.closeDate || '';
        const dateB = b.positions[b.positions.length - 1]?.closeDate || '';
        return new Date(dateB) - new Date(dateA);
    });
    
    // Build HTML
    let html = filterHtml + `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
                <tr style="color:#888;">
                    <th style="padding:6px; text-align:left;">Ticker</th>
                    <th style="padding:6px; text-align:left;">Type</th>
                    <th style="padding:6px; text-align:right;">Strike</th>
                    <th style="padding:6px; text-align:right;">Premium</th>
                    <th style="padding:6px; text-align:center;">Opened</th>
                    <th style="padding:6px; text-align:center;">Closed</th>
                    <th style="padding:6px; text-align:center;">Expiry</th>
                    <th style="padding:6px; text-align:right;" title="Days position was held">Held</th>
                    <th style="padding:6px; text-align:right;" title="Days left until expiry when closed (how early you exited)">Left</th>
                    <th style="padding:6px; text-align:right;">P&L</th>
                    <th style="padding:6px; text-align:right;" title="Return on Capital at Risk">ROC%</th>
                    <th style="padding:6px; text-align:right;" title="Money left on table by closing early (max profit - actual). Assumes option would have expired OTM.">Left $</th>
                    <th style="padding:6px; text-align:center;" title="Link to another position's chain">🔗</th>
                    <th style="padding:6px; text-align:center;">🗑️</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    let chainCount = 0;
    const maxChains = 100; // Show up to 100 position chains
    for (const chain of sortedChains) {
        if (chainCount >= maxChains) break;
        chainCount++;
        
        const isMultiLeg = chain.positions.length > 1;
        
        // Sort positions within chain by close date (oldest first - chronological order)
        chain.positions.sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
        
        // If multi-leg chain, show a chain header
        if (isMultiLeg) {
            const pnlColor = chain.totalPnL >= 0 ? '#00ff88' : '#ff5252';
            // Calculate chain ROC based on first position's capital at risk
            const chainCapital = chain.positions.reduce((sum, p) => sum + (p.strike * 100 * (p.contracts || 1)), 0) / chain.positions.length;
            const chainRoc = chainCapital > 0 ? (chain.totalPnL / chainCapital) * 100 : 0;
            html += `
                <tr style="background:rgba(0,217,255,0.08); border-top:2px solid rgba(0,217,255,0.3);">
                    <td colspan="9" style="padding:8px; color:#00d9ff; font-weight:bold;">
                        🔗 ${chain.ticker} Chain (${chain.positions.length} legs)
                        <span style="color:#888; font-weight:normal; margin-left:10px;">
                            ${chain.firstOpen || '?'} → ${chain.lastClose || '?'}
                        </span>
                    </td>
                    <td style="padding:8px; text-align:right; font-weight:bold; color:${pnlColor}; font-size:13px;">
                        Σ ${chain.totalPnL >= 0 ? '+' : ''}$${chain.totalPnL.toFixed(0)}
                    </td>
                    <td style="padding:8px; text-align:right; color:${pnlColor};">
                        ${chainRoc >= 0 ? '+' : ''}${chainRoc.toFixed(1)}%
                    </td>
                    <td></td>
                    <td></td>
                    <td></td>
                </tr>
            `;
        }
        
        // Render each position in the chain
        chain.positions.forEach((pos, idx) => {
            const indentStyle = isMultiLeg ? 'padding-left:20px;' : '';
            const legLabel = isMultiLeg ? `<span style="color:#888; font-size:10px;">Leg ${idx + 1}</span> ` : '';
            const rowBorder = isMultiLeg && idx < chain.positions.length - 1 
                ? 'border-bottom:1px dashed rgba(255,255,255,0.1);' 
                : 'border-bottom:1px solid rgba(255,255,255,0.05);';
            
            // Calculate ROC%: P&L / Capital at Risk
            // Support both realizedPnL (app-created) and closePnL (imported from broker)
            const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
            const capitalAtRisk = pos.strike * 100 * (pos.contracts || 1);
            const roc = capitalAtRisk > 0 ? (pnl / capitalAtRisk) * 100 : 0;
            const rocColor = roc >= 0 ? '#00ff88' : '#ff5252';
            
            // Calculate "left on table" - what you could have made if expired worthless
            // Max profit = full premium received (option expires worthless)
            // Left on table = max profit - actual P&L
            const contracts = pos.contracts || 1;
            const maxProfit = pos.premium * 100 * contracts;  // Full premium if expired OTM
            const leftOnTable = maxProfit - pnl;
            // Color: red if significant, orange if moderate, gray if minimal
            let leftColor = '#888';
            if (leftOnTable > maxProfit * 0.5) leftColor = '#ff5252';  // Left more than 50%
            else if (leftOnTable > maxProfit * 0.25) leftColor = '#ff9800';  // Left 25-50%
            else if (leftOnTable > 0) leftColor = '#ffaa00';  // Left something
            // Note: if leftOnTable is negative, they made MORE than max (shouldn't happen for short options)
            
            // Calculate days held if missing but dates available
            let daysHeld = pos.daysHeld;
            if (!daysHeld && pos.openDate && pos.closeDate) {
                const open = new Date(pos.openDate);
                const close = new Date(pos.closeDate);
                daysHeld = Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
            }
            
            // Calculate days left until expiry when closed (how early you exited)
            let daysLeft = null;
            let daysLeftColor = '#888';
            if (pos.expiry && pos.closeDate) {
                const close = new Date(pos.closeDate);
                const expiry = new Date(pos.expiry);
                daysLeft = Math.ceil((expiry - close) / (1000 * 60 * 60 * 24));
                // Color code: green if closed well before expiry (good management), orange if close to expiry
                if (daysLeft > 14) daysLeftColor = '#00ff88';  // Exited with plenty of time
                else if (daysLeft > 7) daysLeftColor = '#ffaa00';  // Getting close
                else if (daysLeft > 0) daysLeftColor = '#ff9800';  // Very close to expiry
                else daysLeftColor = '#888';  // Held to or past expiry
            }
            
            // Format expiry for display (shorter format)
            const expiryDisplay = pos.expiry ? pos.expiry.substring(5) : '—'; // Show MM-DD only
            
            html += `
                <tr style="${rowBorder}">
                    <td style="padding:6px; ${indentStyle} color:#00d9ff;">${legLabel}${pos.ticker}</td>
                    <td style="padding:6px;">${pos.type.replace('_', ' ')}</td>
                    <td style="padding:6px; text-align:right;">$${pos.strike.toFixed(2)}</td>
                    <td style="padding:6px; text-align:right;" title="$${pos.premium.toFixed(2)} × ${pos.contracts || 1} contracts × 100 shares">
                        <span style="color:#00ff88; font-weight:bold;">$${(pos.premium * 100 * (pos.contracts || 1)).toFixed(0)}</span>
                        <span style="color:#666; font-size:10px; margin-left:4px;">(${pos.premium.toFixed(2)}×${pos.contracts || 1})</span>
                    </td>
                    <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.openDate || '—'}</td>
                    <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.closeDate}</td>
                    <td style="padding:6px; text-align:center; color:#888; font-size:11px;" title="${pos.expiry || 'No expiry date'}">${expiryDisplay}</td>
                    <td style="padding:6px; text-align:right;">${daysHeld ?? '—'}d</td>
                    <td style="padding:6px; text-align:right; color:${daysLeftColor};" title="Days remaining until expiry when you closed">${daysLeft !== null ? daysLeft + 'd' : '—'}</td>
                    <td style="padding:6px; text-align:right; font-weight:bold; color:${pnl >= 0 ? '#00ff88' : '#ff5252'};">
                        ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                    </td>
                    <td style="padding:6px; text-align:right; color:${rocColor};">
                        ${roc >= 0 ? '+' : ''}${roc.toFixed(1)}%
                    </td>
                    <td style="padding:6px; text-align:right; color:${leftColor}; font-size:11px;" 
                        title="Max profit if expired worthless: $${maxProfit.toFixed(0)}. You captured ${((pnl/maxProfit)*100).toFixed(0)}% of max.">
                        ${leftOnTable > 0 ? '-$' + leftOnTable.toFixed(0) : '—'}
                    </td>
                    <td style="padding:6px; text-align:center;">
                        <button onclick="window.showLinkToChainModal(${pos.id})" 
                                style="background:transparent; border:none; color:#6bf; cursor:pointer; font-size:11px;"
                                title="Link to another position's roll chain">
                            🔗
                        </button>
                    </td>
                    <td style="padding:6px; text-align:center;">
                        <button onclick="window.deleteClosedPosition(${pos.id})" 
                                style="background:transparent; border:none; color:#ff5252; cursor:pointer; font-size:11px;"
                                title="Delete this record">
                            ✕
                        </button>
                    </td>
                </tr>
            `;
        });
    }
    
    html += `
            </tbody>
        </table>
    `;
    
    if (sortedChains.length > maxChains) {
        html += `<div style="color:#888; font-size:11px; margin-top:8px;">Showing ${maxChains} of ${sortedChains.length} position chains</div>`;
    }
    
    // Add totals summary for filtered data - support both realizedPnL and closePnL
    const grandTotal = closed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const totalColor = grandTotal >= 0 ? '#00ff88' : '#ff5252';
    const yearLabel = state.closedYearFilter === 'all' ? 'All Time' : state.closedYearFilter;
    html += `
        <div style="margin-top:12px; padding:10px; background:rgba(255,255,255,0.03); border-radius:6px; text-align:right;">
            <span style="color:#888;">${yearLabel} Realized P&L:</span>
            <span style="font-size:16px; font-weight:bold; color:${totalColor}; margin-left:10px;">
                ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(0)}
            </span>
            <span style="color:#888; margin-left:15px;">(${closed.length} trades)</span>
        </div>
    `;
    
    el.innerHTML = html;
    
    // Attach year filter listener after DOM update
    setTimeout(() => attachYearFilterListener(), 0);
}

/**
 * Attach listener to year filter dropdown
 */
function attachYearFilterListener() {
    const filterEl = document.getElementById('closedYearFilter');
    if (filterEl) {
        filterEl.onchange = (e) => {
            state.closedYearFilter = e.target.value;
            renderClosedPositions();
            // Also update Portfolio Summary to reflect filtered stats
            renderPortfolio(false);
        };
    }
}

/**
 * Export closed positions as CSV for tax records
 */
export function exportClosedForTax() {
    const allClosed = state.closedPositions || [];
    const currentFilter = state.closedYearFilter || 'all';
    
    // Filter by selected year
    const toExport = currentFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => (p.closeDate || '').startsWith(currentFilter));
    
    if (toExport.length === 0) {
        showNotification('No trades to export', 'warning');
        return;
    }
    
    // Build CSV
    const headers = ['Ticker', 'Type', 'Strike', 'Premium', 'Contracts', 'Opened', 'Closed', 'Days Held', 'Realized P&L', 'Broker'];
    const rows = toExport.map(p => [
        p.ticker,
        p.type.replace('_', ' '),
        p.strike.toFixed(2),
        p.premium.toFixed(2),
        p.contracts || 1,
        p.openDate || '',
        p.closeDate || '',
        p.daysHeld || '',
        p.realizedPnL.toFixed(2),
        p.broker || ''
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wheelhouse_trades_${currentFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification(`Exported ${toExport.length} trades for ${currentFilter}`, 'success');
}
window.exportClosedForTax = exportClosedForTax;

/**
 * Mark current option price (manual entry from broker)
 */
export function markPrice(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) return;
    
    const currentVal = pos.markedPrice || pos.lastOptionPrice || '';
    const input = prompt(
        `Enter current option price for ${pos.ticker} $${pos.strike} ${pos.type}:\n\n` +
        `(Check your Schwab position for the current bid/ask)`,
        currentVal ? currentVal.toFixed(2) : ''
    );
    
    if (input === null) return; // Cancelled
    
    const price = parseFloat(input);
    if (isNaN(price) || price < 0) {
        showNotification('Invalid price entered', 'error');
        return;
    }
    
    // Save the marked price
    pos.markedPrice = price;
    pos.lastOptionPrice = price;
    pos.markedAt = new Date().toISOString();
    
    // Save to localStorage
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    showNotification(`Marked ${pos.ticker} at $${price.toFixed(2)}`, 'success');
    
    // Re-render without fetching (use cached prices)
    renderPortfolio(false);
}

// Expose to window for inline onclick
window.closePosition = closePosition;
window.markPrice = markPrice;

/**
 * Analyze position from Portfolio - loads data and switches to Options tab
 */
export function analyzeFromPortfolio(id) {
    const pos = state.positions.find(p => p.id === id);
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    // Load position into analyzer (uses the existing function from positions.js)
    if (window.loadPositionToAnalyze) {
        window.loadPositionToAnalyze(id);
    }
    
    // Switch to Options tab
    const optionsTab = document.querySelector('[data-tab="options"]');
    if (optionsTab) {
        optionsTab.click();
    }
    
    // Trigger price fetch for AI analysis (with slight delay for tab switch)
    setTimeout(() => {
        const fetchBtn = document.getElementById('fetchTickerBtn');
        if (fetchBtn) {
            fetchBtn.click();
        }
    }, 300);
    
    showNotification(`Analyzing ${pos.ticker} $${pos.strike} ${pos.type.replace('_', ' ')}...`, 'info');
}

window.analyzeFromPortfolio = analyzeFromPortfolio;

/**
 * Delete a closed position record
 */
export function deleteClosedPosition(id) {
    if (!confirm('Delete this closed position record?')) return;
    
    state.closedPositions = (state.closedPositions || []).filter(p => p.id !== id);
    saveClosedPositions();
    showNotification('Deleted closed position record', 'info');
    renderPortfolio(false);
}
window.deleteClosedPosition = deleteClosedPosition;

/**
 * Add a historical closed position manually
 */
export function addHistoricalClosedPosition() {
    // Simple prompt-based entry for now
    const ticker = prompt('Ticker symbol (e.g., TSLL):');
    if (!ticker) return;
    
    const type = prompt('Type (put or call):', 'put');
    if (!type || !['put', 'call'].includes(type.toLowerCase())) {
        showNotification('Type must be "put" or "call"', 'error');
        return;
    }
    
    const strike = parseFloat(prompt('Strike price:', '20'));
    if (isNaN(strike)) {
        showNotification('Invalid strike price', 'error');
        return;
    }
    
    const premium = parseFloat(prompt('Premium received per share:', '1.00'));
    if (isNaN(premium)) {
        showNotification('Invalid premium', 'error');
        return;
    }
    
    const contracts = parseInt(prompt('Number of contracts:', '1'));
    if (isNaN(contracts) || contracts < 1) {
        showNotification('Invalid contracts', 'error');
        return;
    }
    
    const openDate = prompt('Date opened (YYYY-MM-DD):', new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]);
    const closeDate = prompt('Date closed (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
    
    const closingPrice = parseFloat(prompt('Closing price paid (enter 0 if expired worthless):', '0'));
    if (isNaN(closingPrice)) {
        showNotification('Invalid closing price', 'error');
        return;
    }
    
    // Calculate P&L
    const premiumReceived = premium * 100 * contracts;
    const closingCost = closingPrice * 100 * contracts;
    const realizedPnL = premiumReceived - closingCost;
    
    // Calculate days held
    const open = new Date(openDate);
    const close = new Date(closeDate);
    const daysHeld = Math.ceil((close - open) / (1000 * 60 * 60 * 24));
    
    // Add to closed positions
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: ticker.toUpperCase(),
        type: type.toLowerCase(),
        strike,
        premium,
        contracts,
        openDate,
        closeDate,
        closingPrice,
        daysHeld,
        realizedPnL
    });
    saveClosedPositions();
    
    showNotification(`Added historical ${ticker} trade: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(0)}`, 
                     realizedPnL >= 0 ? 'success' : 'warning');
    renderPortfolio(false);
}
window.addHistoricalClosedPosition = addHistoricalClosedPosition;

/**
 * Render Holdings section - shares from assignments
 */
export function renderHoldings() {
    const section = document.getElementById('holdingsSection');
    const table = document.getElementById('holdingsTable');
    if (!section || !table) return;
    
    const holdings = state.holdings || [];
    
    if (holdings.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    
    let html = `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
                <tr style="color:#888;">
                    <th style="padding:6px; text-align:left;">Ticker</th>
                    <th style="padding:6px; text-align:right;">Shares</th>
                    <th style="padding:6px; text-align:right;">Cost Basis</th>
                    <th style="padding:6px; text-align:right;">Total Cost</th>
                    <th style="padding:6px; text-align:center;">Assigned</th>
                    <th style="padding:6px; text-align:right;">Premium Banked</th>
                    <th style="padding:6px; text-align:center;">Actions</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    holdings.forEach(h => {
        html += `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                <td style="padding:8px; font-weight:bold; color:#fa0;">${h.ticker}</td>
                <td style="padding:8px; text-align:right;">${h.shares}</td>
                <td style="padding:8px; text-align:right;">$${h.costBasis.toFixed(2)}</td>
                <td style="padding:8px; text-align:right;">$${h.totalCost.toFixed(0)}</td>
                <td style="padding:8px; text-align:center; color:#888;">${h.assignedDate || '—'}</td>
                <td style="padding:8px; text-align:right; color:#00ff88;">+$${h.premiumCredit.toFixed(0)}</td>
                <td style="padding:8px; text-align:center; white-space:nowrap;">
                    <button onclick="window.sellCoveredCall(${h.id})" 
                            style="background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.4); color:#0f8; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;"
                            title="Sell Covered Call on these shares">
                        📞 Sell CC
                    </button>
                    <button onclick="window.sellShares(${h.id})" 
                            style="background:rgba(255,82,82,0.2); border:1px solid rgba(255,82,82,0.4); color:#f55; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;"
                            title="Sell shares (exit wheel)">
                        💰 Sell
                    </button>
                </td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    
    // Summary
    const totalCost = holdings.reduce((sum, h) => sum + h.totalCost, 0);
    const totalPremium = holdings.reduce((sum, h) => sum + h.premiumCredit, 0);
    html += `
        <div style="margin-top:10px; padding:8px; background:rgba(255,140,0,0.1); border-radius:4px; text-align:right; font-size:12px;">
            <span style="color:#888;">Total Capital Deployed:</span>
            <span style="color:#fa0; font-weight:bold; margin-left:8px;">$${totalCost.toFixed(0)}</span>
            <span style="color:#888; margin-left:20px;">Premium Already Banked:</span>
            <span style="color:#00ff88; font-weight:bold; margin-left:8px;">+$${totalPremium.toFixed(0)}</span>
        </div>
    `;
    
    table.innerHTML = html;
}
window.renderHoldings = renderHoldings;

/**
 * Sell Covered Call - creates CC position linked to holding
 */
export function sellCoveredCall(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    // Pre-fill covered call data
    const suggestedStrike = Math.ceil(holding.costBasis * 1.05); // 5% above cost basis
    
    // Switch to Positions tab and pre-fill form
    const posTab = document.querySelector('[data-tab="positions"]');
    if (posTab) posTab.click();
    
    setTimeout(() => {
        // Pre-fill the add position form
        const tickerInput = document.getElementById('posTicker');
        const strikeInput = document.getElementById('posStrike');
        const typeSelect = document.getElementById('posType');
        const contractsInput = document.getElementById('posContracts');
        const brokerSelect = document.getElementById('posBroker');
        
        if (tickerInput) tickerInput.value = holding.ticker;
        if (strikeInput) strikeInput.value = suggestedStrike;
        if (typeSelect) typeSelect.value = 'short_call';
        if (contractsInput) contractsInput.value = holding.shares / 100;
        if (brokerSelect) brokerSelect.value = holding.broker || 'Schwab';
        
        showNotification(
            `Ready to sell CC on ${holding.ticker}! Enter premium and expiry, then click Add.`,
            'info',
            5000
        );
    }, 200);
}
window.sellCoveredCall = sellCoveredCall;

/**
 * Sell shares - exit the wheel position
 */
export function sellShares(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) {
        showNotification('Holding not found', 'error');
        return;
    }
    
    const salePrice = parseFloat(prompt(
        `Sell ${holding.shares} shares of ${holding.ticker}\n\n` +
        `Cost basis: $${holding.costBasis.toFixed(2)}/share\n` +
        `Enter sale price per share:`,
        holding.costBasis.toFixed(2)
    ));
    
    if (isNaN(salePrice) || salePrice <= 0) {
        showNotification('Invalid sale price', 'error');
        return;
    }
    
    // Calculate P&L from shares
    const sharePnL = (salePrice - holding.costBasis) * holding.shares;
    const totalPnL = sharePnL + holding.premiumCredit; // Include premium already banked
    
    // Record as closed wheel cycle
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: holding.ticker,
        type: 'wheel_cycle',
        strike: holding.strike,
        premium: holding.premiumReceived,
        contracts: holding.shares / 100,
        openDate: holding.assignedDate,
        closeDate: new Date().toISOString().split('T')[0],
        salePrice: salePrice,
        costBasis: holding.costBasis,
        sharePnL: sharePnL,
        realizedPnL: totalPnL,
        daysHeld: holding.assignedDate ? 
            Math.ceil((new Date() - new Date(holding.assignedDate)) / (1000 * 60 * 60 * 24)) : 0,
        chainId: holding.chainId
    });
    saveClosedPositions();
    
    // Remove from holdings
    state.holdings = state.holdings.filter(h => h.id !== holdingId);
    localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
    
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(0)}` : `-$${Math.abs(totalPnL).toFixed(0)}`;
    showNotification(
        `Sold ${holding.ticker} shares! Total wheel P&L: ${pnlStr}`,
        totalPnL >= 0 ? 'success' : 'warning',
        5000
    );
    
    renderHoldings();
    renderPortfolio(false);
}
window.sellShares = sellShares;

/**
 * Called Away - shares got called away from covered call
 */
export function calledAway(positionId) {
    const pos = state.positions.find(p => p.id === positionId);
    if (!pos || !pos.type.includes('call')) {
        showNotification('Invalid position for called away', 'error');
        return;
    }
    
    // Find the linked holding
    const holding = (state.holdings || []).find(h => 
        h.ticker === pos.ticker && h.shares >= 100 * (pos.contracts || 1)
    );
    
    if (!holding) {
        showNotification(`No ${pos.ticker} shares found to be called away`, 'error');
        return;
    }
    
    const sharesToCall = 100 * (pos.contracts || 1);
    const callPremium = pos.premium * 100 * (pos.contracts || 1);
    
    // P&L from being called:
    // Sell at strike + keep call premium + original put premium
    const saleProceeds = pos.strike * sharesToCall;
    const costBasisTotal = holding.costBasis * sharesToCall;
    const sharePnL = saleProceeds - costBasisTotal;
    const totalPnL = sharePnL + callPremium + (holding.premiumCredit * sharesToCall / holding.shares);
    
    // Record the completed wheel cycle
    if (!state.closedPositions) state.closedPositions = [];
    state.closedPositions.push({
        id: Date.now(),
        ticker: pos.ticker,
        type: 'wheel_complete',
        strike: pos.strike,
        premium: pos.premium,
        contracts: pos.contracts || 1,
        openDate: holding.assignedDate,
        closeDate: new Date().toISOString().split('T')[0],
        callPremium: callPremium,
        costBasis: holding.costBasis,
        sharePnL: sharePnL,
        realizedPnL: totalPnL,
        chainId: holding.chainId
    });
    saveClosedPositions();
    
    // Close the call position
    pos.status = 'called_away';
    pos.closeDate = new Date().toISOString().split('T')[0];
    pos.realizedPnL = callPremium;
    state.closedPositions.push({...pos});
    state.positions = state.positions.filter(p => p.id !== positionId);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Update holding (remove shares)
    if (holding.shares <= sharesToCall) {
        state.holdings = state.holdings.filter(h => h.id !== holding.id);
    } else {
        holding.shares -= sharesToCall;
    }
    localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
    
    const pnlStr = totalPnL >= 0 ? `+$${totalPnL.toFixed(0)}` : `-$${Math.abs(totalPnL).toFixed(0)}`;
    showNotification(
        `🎉 Wheel Complete! ${pos.ticker} called at $${pos.strike}. Total P&L: ${pnlStr}`,
        'success',
        6000
    );
    
    renderHoldings();
    renderPortfolio(false);
    if (window.renderPositions) window.renderPositions();
}
window.calledAway = calledAway;

/**
 * Show modal to link a closed position to another position's chain
 */
window.showLinkToChainModal = function(positionId) {
    // Find the position we're linking
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) {
        console.error('Position not found:', positionId);
        return;
    }
    
    // Find all other positions with the same ticker that could be linked
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    const sameTickerPositions = allPositions
        .filter(p => p.ticker === pos.ticker && p.id !== positionId)
        .sort((a, b) => new Date(b.openDate || 0) - new Date(a.openDate || 0));
    
    // Group by chainId to show chains
    const chains = {};
    sameTickerPositions.forEach(p => {
        const chainKey = p.chainId || p.id;
        if (!chains[chainKey]) {
            chains[chainKey] = {
                id: chainKey,
                positions: [],
                firstOpen: p.openDate,
                lastClose: p.closeDate
            };
        }
        chains[chainKey].positions.push(p);
        if (p.openDate < chains[chainKey].firstOpen) chains[chainKey].firstOpen = p.openDate;
        if (p.closeDate > chains[chainKey].lastClose) chains[chainKey].lastClose = p.closeDate;
    });
    
    const chainList = Object.values(chains);
    
    const modal = document.createElement('div');
    modal.id = 'linkChainModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build chain options
    let chainOptionsHtml = '';
    if (chainList.length === 0) {
        chainOptionsHtml = `
            <div style="color:#888; padding:20px; text-align:center;">
                No other ${pos.ticker} positions found to link with.
            </div>
        `;
    } else {
        chainOptionsHtml = chainList.map(chain => {
            const posCount = chain.positions.length;
            const dateRange = `${chain.firstOpen || '?'} → ${chain.lastClose || '?'}`;
            const strikes = [...new Set(chain.positions.map(p => '$' + p.strike))].join(', ');
            
            return `
                <div onclick="window.linkPositionToChain(${positionId}, ${chain.id})" 
                     style="padding:15px; background:#0d0d1a; border:1px solid #333; border-radius:8px; 
                            cursor:pointer; transition: all 0.2s; margin-bottom:10px;"
                     onmouseover="this.style.borderColor='#0096ff'; this.style.background='#1a1a3e';"
                     onmouseout="this.style.borderColor='#333'; this.style.background='#0d0d1a';">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#00d9ff; font-weight:bold;">
                            🔗 Chain with ${posCount} position${posCount > 1 ? 's' : ''}
                        </span>
                        <span style="color:#888; font-size:11px;">${dateRange}</span>
                    </div>
                    <div style="color:#aaa; font-size:12px; margin-top:6px;">
                        Strikes: ${strikes}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    // Current chain info
    const currentChainId = pos.chainId || pos.id;
    const currentChainPositions = allPositions.filter(p => (p.chainId || p.id) === currentChainId);
    const isAlreadyLinked = currentChainPositions.length > 1;
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #0096ff; 
                    border-radius:16px; padding:30px; width:90%; max-width:500px; max-height:80vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(0, 150, 255, 0.3);">
            
            <h2 style="margin:0 0 10px 0; color:#fff; font-size:18px;">🔗 Link Position to Chain</h2>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:20px;">
                <div style="color:#888; font-size:11px; margin-bottom:4px;">LINKING THIS POSITION:</div>
                <div style="color:#00d9ff; font-weight:bold;">
                    ${pos.ticker} • $${pos.strike} ${pos.type?.replace('_', ' ') || 'PUT'}
                </div>
                <div style="color:#888; font-size:12px;">
                    ${pos.openDate || '?'} → ${pos.closeDate || '?'}
                </div>
                ${isAlreadyLinked ? `
                <div style="margin-top:8px; padding:6px 10px; background:rgba(255,170,0,0.15); border-radius:4px; color:#ffaa00; font-size:11px;">
                    ⚠️ Already linked to a chain with ${currentChainPositions.length} positions
                </div>
                ` : ''}
            </div>
            
            <div style="color:#888; font-size:12px; margin-bottom:12px;">
                Select a chain to link this position to:
            </div>
            
            ${chainOptionsHtml}
            
            <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                ${isAlreadyLinked ? `
                <button onclick="window.unlinkPositionFromChain(${positionId})" 
                        style="background:#ff5252; border:none; color:#fff; padding:10px 20px; 
                               border-radius:6px; cursor:pointer; font-size:13px;">
                    Unlink from Chain
                </button>
                ` : ''}
                <button onclick="document.getElementById('linkChainModal').remove()" 
                        style="background:#333; border:none; color:#fff; padding:10px 20px; 
                               border-radius:6px; cursor:pointer; font-size:13px;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Link a position to an existing chain
 */
window.linkPositionToChain = function(positionId, targetChainId) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    pos.chainId = targetChainId;
    saveClosedPositions();
    
    document.getElementById('linkChainModal')?.remove();
    
    showNotification(`✅ Position linked to chain`, 'success');
    renderPortfolio(false);
};

/**
 * Unlink a position from its chain (give it its own unique chainId)
 */
window.unlinkPositionFromChain = function(positionId) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    // Give it a unique chainId (its own id)
    pos.chainId = pos.id;
    saveClosedPositions();
    
    document.getElementById('linkChainModal')?.remove();
    
    showNotification(`Position unlinked - now standalone`, 'info');
    renderPortfolio(false);
};
