// WheelHouse - Portfolio P&L Tracker
// Tracks actual P&L across all positions

import { state } from './state.js';
import { showNotification } from './utils.js';
import { fetchStockPrice, fetchStockPricesBatch, fetchOptionsChain, findOption } from './api.js';

const STORAGE_KEY_CLOSED = 'wheelhouse_closed_positions';
const CHECKPOINT_KEY = 'wheelhouse_data_checkpoint';

/**
 * Check if a position type is a debit (you pay premium)
 * Debit positions: long_call, long_put, debit spreads
 * Credit positions: short_call, short_put, covered_call, buy_write, credit spreads
 */
function isDebitPosition(type) {
    if (!type) return false;
    return type.includes('debit') || type === 'long_call' || type === 'long_put';
}

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
 * Now uses CBOE for BOTH stock price and options - no Yahoo needed!
 */
async function fetchCurrentOptionPrice(position) {
    try {
        // Fetch options chain from CBOE (includes stock price!)
        const optionsChain = await fetchOptionsChain(position.ticker).catch(() => null);
        
        // Get stock price from CBOE (no more Yahoo dependency!)
        let spot = optionsChain?.currentPrice;
        
        // If CBOE doesn't have it, use fetchStockPrice helper
        if (!spot) {
            spot = await fetchStockPrice(position.ticker);
        }
        
        if (!spot) return { success: false };
        
        console.log(`[MATCH] ${position.ticker}: $${spot.toFixed(2)} from ${optionsChain?.currentPrice ? 'CBOE' : 'fallback'}`);
        
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
        
        // Calculate P&L based on position type
        // For SHORT options (credit): P&L = Premium received - current value (we want price to go DOWN)
        // For LONG options (debit): P&L = Current value - premium paid (we want price to go UP)
        const isDebit = isDebitPosition(pos.type);
        const premiumAmount = pos.premium * 100 * pos.contracts;
        const currentValue = currentPrice ? currentPrice * 100 * pos.contracts : null;
        
        let unrealizedPnL = null;
        let pnlPercent = null;
        
        if (currentValue !== null) {
            if (isDebit) {
                // Long option: profit when current value > what we paid
                unrealizedPnL = currentValue - premiumAmount;
            } else {
                // Short option: profit when current value < what we received
                unrealizedPnL = premiumAmount - currentValue;
            }
            pnlPercent = (unrealizedPnL / premiumAmount) * 100;
        }
        
        positionData.push({
            ...pos,
            currentSpot,
            currentPrice,
            isDebit,
            premiumAmount,
            isLivePrice: isLivePrice || pos.isLivePrice || false,
            optionIV: optionIV || pos.optionIV || null,
            optionDelta: optionDelta || pos.optionDelta || null,
            dataAgeMinutes: dataAgeMinutes || pos.dataAgeMinutes || null,
            isStale: isStale || pos.isStale || false,
            priceSource: priceSource || pos.priceSource || null,
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
                    
                    // Check if ITM (in danger for shorts, in profit for longs)
                    const isPut = pos.type.toLowerCase().includes('put');
                    const isITM = pos.currentSpot !== null && 
                                  (isPut ? pos.currentSpot < pos.strike : pos.currentSpot > pos.strike);
                    // ITM warning only for short options (for longs, ITM is good!)
                    const itmWarning = isITM && !pos.isDebit ? '⚠️' : '';
                    const totalPremium = pos.premium * 100 * pos.contracts;
                    
                    // Premium display: debit = negative/red, credit = positive/green
                    const premiumColor = pos.isDebit ? '#ff5252' : '#00ff88';
                    const premiumSign = pos.isDebit ? '-' : '';
                    const premiumTooltip = pos.isDebit ? 'Premium paid' : 'Premium received';
                    
                    // Price change indicator
                    // For short options: down is good (want to buy back cheaper)
                    // For long options: up is good (want to sell higher)
                    const priceChange = pos.currentPrice && pos.premium ? pos.currentPrice - pos.premium : null;
                    let priceChangeColor = '#888';
                    if (priceChange !== null) {
                        if (pos.isDebit) {
                            priceChangeColor = priceChange >= 0 ? '#00ff88' : '#ff5252'; // Long: up is good
                        } else {
                            priceChangeColor = priceChange <= 0 ? '#00ff88' : '#ff5252'; // Short: down is good
                        }
                    }
                    
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
                            <td style="padding:10px; text-align:right; color:${premiumColor};" title="${premiumTooltip}: $${pos.premium.toFixed(2)} × ${pos.contracts} contracts">${premiumSign}$${totalPremium.toFixed(0)}</td>
                            <td style="padding:10px; text-align:right; color:#888;" title="${premiumTooltip}">$${pos.premium.toFixed(2)}</td>
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
    
    // Net premium: credits add, debits subtract
    const netPremium = positionData.reduce((sum, p) => {
        return sum + (p.isDebit ? -p.premiumAmount : p.premiumAmount);
    }, 0);
    
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
    
    // Net premium with sign and color
    const premEl = document.getElementById('portTotalPremium');
    if (premEl) {
        premEl.textContent = (netPremium >= 0 ? '$' : '-$') + Math.abs(netPremium).toFixed(0);
        premEl.style.color = netPremium >= 0 ? '#00ff88' : '#ff5252';
    }
    
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
 * Render closed positions history - grouped by TICKER with collapsible rows
 */
function renderClosedPositions() {
    const el = document.getElementById('closedPositionsTable');
    if (!el) return;
    
    const allClosed = state.closedPositions || [];
    
    // Update summary in collapsible header
    const summaryEl = document.getElementById('closedPositionsSummary');
    if (summaryEl) {
        const totalPnL = allClosed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
        const pnlColor = totalPnL >= 0 ? 'positive' : 'negative';
        summaryEl.innerHTML = `
            <span>${allClosed.length} trades</span>
            <span class="value ${pnlColor}">${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}</span>
        `;
    }
    
    if (allClosed.length === 0) {
        el.innerHTML = '<div style="color:#888;">No closed positions yet.</div>';
        return;
    }
    
    // Get available years from closed positions
    const years = [...new Set(allClosed.map(p => {
        const closeDate = p.closeDate || '';
        const match = closeDate.match(/^(\d{4})/);
        return match ? match[1] : null;
    }).filter(y => y))].sort().reverse();
    
    const currentYear = new Date().getFullYear().toString();
    const hasCurrentYearPositions = allClosed.some(p => (p.closeDate || '').startsWith(currentYear));
    
    if (!state.closedYearFilter) {
        state.closedYearFilter = hasCurrentYearPositions ? currentYear : 'all';
    }
    
    if (state.closedYearFilter !== 'all' && !years.includes(state.closedYearFilter)) {
        state.closedYearFilter = 'all';
    }
    
    const closed = state.closedYearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => {
            const closeDate = p.closeDate || '';
            const match = closeDate.match(/^(\d{4})/);
            return match && match[1] === state.closedYearFilter;
        });
    
    const ytdPnL = allClosed
        .filter(p => (p.closeDate || '').startsWith(currentYear))
        .reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    
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
        setTimeout(() => attachYearFilterListener(), 0);
        return;
    }
    
    // GROUP BY TICKER instead of chain
    const tickerGroups = {};
    closed.forEach(pos => {
        const ticker = pos.ticker || 'Unknown';
        if (!tickerGroups[ticker]) {
            tickerGroups[ticker] = {
                positions: [],
                totalPnL: 0,
                totalPremium: 0,
                tradeCount: 0
            };
        }
        tickerGroups[ticker].positions.push(pos);
        tickerGroups[ticker].totalPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
        tickerGroups[ticker].totalPremium += (pos.premium || 0) * 100 * (pos.contracts || 1);
        tickerGroups[ticker].tradeCount++;
    });
    
    // Sort tickers by total P&L (biggest winners first)
    const sortedTickers = Object.entries(tickerGroups)
        .sort((a, b) => b[1].totalPnL - a[1].totalPnL);
    
    // Get collapsed state from localStorage
    const collapsedTickers = JSON.parse(localStorage.getItem('wheelhouse_collapsed_tickers') || '{}');
    
    let html = filterHtml + `
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
                <tr style="color:#888;">
                    <th style="padding:6px; text-align:left;">Ticker</th>
                    <th style="padding:6px; text-align:left;">Type</th>
                    <th style="padding:6px; text-align:right;">Strike</th>
                    <th style="padding:6px; text-align:right;">Premium</th>
                    <th style="padding:6px; text-align:center;">Closed</th>
                    <th style="padding:6px; text-align:right;">Held</th>
                    <th style="padding:6px; text-align:right;">P&L</th>
                    <th style="padding:6px; text-align:right;">ROC%</th>
                    <th style="padding:6px; text-align:center;">🔗</th>
                    <th style="padding:6px; text-align:center;">🗑️</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    for (const [ticker, group] of sortedTickers) {
        const pnlColor = group.totalPnL >= 0 ? '#00ff88' : '#ff5252';
        const isCollapsed = collapsedTickers[ticker] || false;
        const arrowClass = isCollapsed ? 'collapsed' : '';
        
        // Ticker group header row (clickable)
        html += `
            <tr class="ticker-group-header ${arrowClass}" data-ticker="${ticker}" onclick="window.toggleTickerGroup('${ticker}')">
                <td style="font-weight:bold; color:#8b5cf6;">
                    <span class="ticker-group-arrow">▼</span>
                    ${ticker}
                </td>
                <td style="color:#888;">${group.tradeCount} trade${group.tradeCount > 1 ? 's' : ''}</td>
                <td></td>
                <td style="text-align:right; color:#00ff88;">$${group.totalPremium.toFixed(0)}</td>
                <td></td>
                <td></td>
                <td style="text-align:right; font-weight:bold; color:${pnlColor}; font-size:13px;">
                    ${group.totalPnL >= 0 ? '+' : ''}$${group.totalPnL.toFixed(0)}
                </td>
                <td></td>
                <td></td>
                <td></td>
            </tr>
        `;
        
        // Individual trades (collapsible tbody)
        const tradesClass = isCollapsed ? 'collapsed' : '';
        html += `</tbody><tbody class="ticker-group-trades ${tradesClass}" data-ticker="${ticker}">`;
        
        // Group positions by chainId within this ticker
        const chains = {};
        group.positions.forEach(pos => {
            const chainKey = pos.chainId || pos.id;
            if (!chains[chainKey]) {
                chains[chainKey] = {
                    positions: [],
                    totalPnL: 0,
                    firstOpen: pos.openDate,
                    lastClose: pos.closeDate
                };
            }
            chains[chainKey].positions.push(pos);
            chains[chainKey].totalPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
            if (pos.openDate < chains[chainKey].firstOpen) chains[chainKey].firstOpen = pos.openDate;
            if (pos.closeDate > chains[chainKey].lastClose) chains[chainKey].lastClose = pos.closeDate;
        });
        
        // Sort chains by last close date (newest first)
        const sortedChains = Object.values(chains).sort((a, b) => 
            new Date(b.lastClose) - new Date(a.lastClose)
        );
        
        // Render each chain
        for (const chain of sortedChains) {
            const isMultiLeg = chain.positions.length > 1;
            
            // Sort positions within chain chronologically (oldest first)
            chain.positions.sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));
            
            // Show chain header for multi-leg (rolled) positions
            if (isMultiLeg) {
                const chainPnlColor = chain.totalPnL >= 0 ? '#00ff88' : '#ff5252';
                html += `
                    <tr style="background:rgba(0,217,255,0.08); border-left:3px solid #00d9ff;">
                        <td colspan="6" style="padding:6px 6px 6px 20px; color:#00d9ff; font-size:11px;">
                            🔗 Rolled ${chain.positions.length}× 
                            <span style="color:#888;">(${chain.firstOpen} → ${chain.lastClose})</span>
                        </td>
                        <td style="padding:6px; text-align:right; font-weight:bold; color:${chainPnlColor}; font-size:12px;">
                            Σ ${chain.totalPnL >= 0 ? '+' : ''}$${chain.totalPnL.toFixed(0)}
                        </td>
                        <td colspan="3"></td>
                    </tr>
                `;
            }
            
            // Render each position in the chain
            chain.positions.forEach((pos, idx) => {
                const pnl = pos.realizedPnL ?? pos.closePnL ?? 0;
                const capitalAtRisk = pos.strike * 100 * (pos.contracts || 1);
                const roc = capitalAtRisk > 0 ? (pnl / capitalAtRisk) * 100 : 0;
                const rocColor = roc >= 0 ? '#00ff88' : '#ff5252';
                
                let daysHeld = pos.daysHeld;
                if (!daysHeld && pos.openDate && pos.closeDate) {
                    const open = new Date(pos.openDate);
                    const close = new Date(pos.closeDate);
                    daysHeld = Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
                }
                
                // Indent and style differently for chain members
                const indent = isMultiLeg ? 'padding-left:35px;' : 'padding-left:25px;';
                const legLabel = isMultiLeg ? `<span style="color:#00d9ff; font-size:9px; margin-right:4px;">L${idx+1}</span>` : '';
                const rowBorder = isMultiLeg && idx < chain.positions.length - 1 
                    ? 'border-bottom:1px dashed rgba(0,217,255,0.2);' 
                    : 'border-bottom:1px solid rgba(255,255,255,0.05);';
                
                html += `
                    <tr style="${rowBorder}">
                        <td style="padding:6px; ${indent} color:#888; font-size:11px;">${legLabel}${pos.closeDate?.substring(5) || '—'}</td>
                        <td style="padding:6px; color:#aaa;">${pos.type?.replace('_', ' ') || '—'}</td>
                        <td style="padding:6px; text-align:right;">$${pos.strike?.toFixed(2) || '—'}</td>
                        <td style="padding:6px; text-align:right;">
                            <span style="color:#00ff88;">$${((pos.premium || 0) * 100 * (pos.contracts || 1)).toFixed(0)}</span>
                            <span style="color:#666; font-size:10px;"> ×${pos.contracts || 1}</span>
                        </td>
                        <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.closeDate || '—'}</td>
                        <td style="padding:6px; text-align:right; color:#888;">${daysHeld ?? '—'}d</td>
                        <td style="padding:6px; text-align:right; font-weight:bold; color:${pnl >= 0 ? '#00ff88' : '#ff5252'};">
                            ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                        </td>
                        <td style="padding:6px; text-align:right; color:${rocColor};">
                            ${roc >= 0 ? '+' : ''}${roc.toFixed(1)}%
                        </td>
                        <td style="padding:6px; text-align:center;">
                            <button onclick="event.stopPropagation(); window.showLinkToChainModal(${pos.id})" 
                                    style="background:transparent; border:none; color:#6bf; cursor:pointer; font-size:11px;"
                                    title="${isMultiLeg ? 'Part of roll chain' : 'Link to chain'}">
                                ${isMultiLeg ? '🔗' : '🔗'}
                            </button>
                        </td>
                        <td style="padding:6px; text-align:center;">
                            <button onclick="event.stopPropagation(); window.deleteClosedPosition(${pos.id})" 
                                    style="background:transparent; border:none; color:#ff5252; cursor:pointer; font-size:11px;">
                                ✕
                            </button>
                        </td>
                    </tr>
                `;
            });
        }
        
        html += `</tbody><tbody>`;
    }
    
    html += `
            </tbody>
        </table>
    `;
    
    const grandTotal = closed.reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
    const totalColor = grandTotal >= 0 ? '#00ff88' : '#ff5252';
    const yearLabel = state.closedYearFilter === 'all' ? 'All Time' : state.closedYearFilter;
    html += `
        <div style="margin-top:12px; padding:10px; background:rgba(255,255,255,0.03); border-radius:6px; text-align:right;">
            <span style="color:#888;">${yearLabel} Realized P&L:</span>
            <span style="font-size:16px; font-weight:bold; color:${totalColor}; margin-left:10px;">
                ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(0)}
            </span>
            <span style="color:#888; margin-left:15px;">(${closed.length} trades across ${sortedTickers.length} tickers)</span>
        </div>
    `;
    
    el.innerHTML = html;
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
    // This already handles tab switching to Analyze → Pricing
    if (window.loadPositionToAnalyze) {
        window.loadPositionToAnalyze(id);
    }
    
    // Switch to Analyze tab → Pricing sub-tab (fallback if loadPositionToAnalyze didn't do it)
    const analyzeTab = document.querySelector('[data-tab="analyze"]');
    const optionsTab = document.querySelector('[data-tab="options"]');
    if (analyzeTab) {
        analyzeTab.click();
        // Activate Pricing sub-tab
        if (window.switchSubTab) {
            window.switchSubTab('analyze', 'analyze-pricing');
        }
    } else if (optionsTab) {
        optionsTab.click();
    }
    
    // Trigger price fetch, then auto-run pricing analysis
    setTimeout(() => {
        const fetchBtn = document.getElementById('fetchTickerBtn');
        if (fetchBtn) {
            fetchBtn.click();
            
            // After fetch completes, automatically run pricing
            setTimeout(() => {
                const priceBtn = document.getElementById('priceBtn');
                if (priceBtn) {
                    priceBtn.click();
                }
            }, 800); // Wait for fetch to complete
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
    
    // Update collapsible header summary
    const summaryEl = document.getElementById('holdingsSummary');
    if (summaryEl) {
        const totalShares = holdings.reduce((sum, h) => sum + (h.shares || 100), 0);
        const totalValue = holdings.reduce((sum, h) => sum + ((h.shares || 100) * (h.costBasis || 0)), 0);
        summaryEl.innerHTML = holdings.length > 0 
            ? `<span>${holdings.length} holding${holdings.length !== 1 ? 's'  : ''} (${totalShares} shares)</span>
               <span class="value" style="color:#ff8c00;">~$${totalValue.toFixed(0)}</span>`
            : `<span style="color:#888;">No holdings</span>`;
    }
    
    if (holdings.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    
    // Build comprehensive holdings display - card-based layout for clarity
    let html = `
        <div style="font-size:10px; color:#666; margin-bottom:10px; padding:0 8px;">
            Shares from Buy/Writes and Put Assignments
        </div>
    `;
    
    // Store holding data for summary calculation after price fetch
    const holdingData = [];
    
    holdings.forEach(h => {
        const isBuyWrite = h.source === 'buy_write';
        const sourceLabel = isBuyWrite ? 'Buy/Write' : 'Assigned';
        const sourceColor = isBuyWrite ? '#00d9ff' : '#fa0';
        
        // Get key values
        const costBasis = h.costBasis || 0;  // Per-share cost
        const shares = h.shares || 100;
        const totalCost = h.totalCost || (costBasis * shares);
        
        // Try to find linked position for strike/premium if missing
        let strike = h.strike;
        let premiumTotal = h.premiumCredit || 0;
        
        if (isBuyWrite && h.linkedPositionId) {
            const linkedPos = state.positions.find(p => p.id === h.linkedPositionId);
            if (linkedPos) {
                strike = strike || linkedPos.strike;
                if (!premiumTotal && linkedPos.premium) {
                    premiumTotal = linkedPos.premium * 100 * (linkedPos.contracts || 1);
                }
            }
        }
        
        // Calculate max profit if called away
        let maxProfit = h.maxProfit || 0;
        if (!maxProfit && strike && costBasis) {
            const gainOnShares = Math.max(0, (strike - costBasis) * shares);
            maxProfit = gainOnShares + premiumTotal;
        }
        
        // Net cost basis (breakeven price)
        const netBasis = h.netCostBasis || (costBasis - (premiumTotal / shares));
        
        // Store for summary
        holdingData.push({
            id: h.id,
            ticker: h.ticker,
            shares,
            costBasis,
            totalCost,
            strike: strike || 0,
            premium: premiumTotal,
            netBasis,
            maxProfit,
            isBuyWrite,
            linkedPositionId: h.linkedPositionId
        });
        
        // Unique IDs for async updates
        const rowId = `holding-row-${h.id}`;
        const priceId = `hp-${h.id}`;
        const stockPnLId = `hspnl-${h.id}`;
        const totalReturnId = `htr-${h.id}`;
        const onTableId = `hot-${h.id}`;
        const actionId = `hact-${h.id}`;
        
        const strikeDisplay = strike ? `$${strike.toFixed(2)}` : '—';
        
        // Card-based layout - cleaner and more scannable
        html += `
            <div id="${rowId}" style="background:#1a1a2e; border-radius:8px; padding:12px; margin-bottom:8px; border:1px solid #333;">
                <!-- Header Row: Ticker + Buttons -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:18px; font-weight:bold; color:${sourceColor};">${h.ticker}</span>
                        <span style="font-size:11px; color:#888; background:rgba(0,0,0,0.3); padding:2px 8px; border-radius:4px;">
                            ${sourceLabel} · ${shares} shares · Call @ ${strikeDisplay}
                        </span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        ${isBuyWrite && h.linkedPositionId ? `
                        <button onclick="window.aiHoldingSuggestion(${h.id})" 
                                style="background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.4); color:#ffaa00; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="AI suggestions for this holding">
                            🤖 AI
                        </button>
                        <button onclick="window.analyzeHolding(${h.id})" 
                                style="background:rgba(139,92,246,0.2); border:1px solid rgba(139,92,246,0.4); color:#8b5cf6; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Analyze in P&L tab">
                            🔬
                        </button>
                        ` : ''}
                        <button onclick="window.sellShares(${h.id})" 
                                style="background:rgba(255,82,82,0.2); border:1px solid rgba(255,82,82,0.4); color:#f55; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                                title="Sell shares">
                            💰 Sell
                        </button>
                    </div>
                </div>
                
                <!-- Stats Grid -->
                <div style="display:grid; grid-template-columns:repeat(6, 1fr); gap:8px; text-align:center;">
                    <!-- Cost Basis -->
                    <div style="background:rgba(255,255,255,0.05); padding:8px; border-radius:6px; cursor:pointer;" 
                         onclick="window.editHoldingCostBasis(${h.id})"
                         title="Click to edit cost basis">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">COST BASIS ✏️</div>
                        <div id="hcb-${h.id}" style="font-size:14px; font-weight:bold; color:#ccc;">$${costBasis.toFixed(2)}</div>
                        <div style="font-size:10px; color:#888;">per share</div>
                    </div>
                    
                    <!-- Stock Value -->
                    <div style="background:rgba(0,0,0,0.2); padding:8px; border-radius:6px;">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">STOCK VALUE</div>
                        <div id="${priceId}" style="font-size:14px; font-weight:bold; color:#fff;">Loading...</div>
                        <div id="${stockPnLId}" style="font-size:10px; color:#888;"></div>
                    </div>
                    
                    <!-- Premium Collected -->
                    <div style="background:rgba(0,255,136,0.08); padding:8px; border-radius:6px;">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">PREMIUM</div>
                        <div style="font-size:14px; font-weight:bold; color:#00ff88;">+$${premiumTotal.toFixed(0)}</div>
                        <div style="font-size:10px; color:#888;">$${(premiumTotal/shares).toFixed(2)}/sh</div>
                    </div>
                    
                    <!-- Total Return -->
                    <div style="background:rgba(0,0,0,0.2); padding:8px; border-radius:6px;">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">TOTAL RETURN</div>
                        <div id="${totalReturnId}" style="font-size:14px; font-weight:bold;">—</div>
                    </div>
                    
                    <!-- If Called -->
                    <div style="background:rgba(0,217,255,0.08); padding:8px; border-radius:6px;">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">IF CALLED</div>
                        <div style="font-size:14px; font-weight:bold; color:#00d9ff;">${maxProfit > 0 ? `+$${maxProfit.toFixed(0)}` : '—'}</div>
                        ${strike ? `<div style="font-size:10px; color:#888;">@ $${strike}</div>` : ''}
                    </div>
                    
                    <!-- Cushion/On Table -->
                    <div id="${onTableId}" style="background:rgba(0,0,0,0.2); padding:8px; border-radius:6px;">
                        <div style="font-size:9px; color:#666; margin-bottom:2px;">CUSHION</div>
                        <div style="font-size:14px; font-weight:bold; color:#888;">—</div>
                    </div>
                </div>
            </div>
        `;
    });
    
    // Summary section - will be updated after price fetch
    html += `
        <div id="holdingsSummary" style="margin-top:12px; padding:12px; background:rgba(255,140,0,0.1); border-radius:8px; border:1px solid rgba(255,140,0,0.3);">
            <div style="font-size:10px; color:#fa0; margin-bottom:8px; font-weight:bold;">📊 PORTFOLIO TOTALS</div>
            <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:12px; text-align:center;">
                <div>
                    <div style="color:#888; font-size:10px;">Capital Invested</div>
                    <div id="sumCapital" style="color:#fa0; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Current Value</div>
                    <div id="sumValue" style="color:#fff; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Stock P&L</div>
                    <div id="sumStockPnL" style="font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Premium Banked</div>
                    <div id="sumPremium" style="color:#00ff88; font-weight:bold; font-size:14px;">—</div>
                </div>
                <div>
                    <div style="color:#888; font-size:10px;">Total Return</div>
                    <div id="sumTotalReturn" style="font-weight:bold; font-size:14px;">—</div>
                </div>
            </div>
        </div>
    `;
    
    table.innerHTML = html;
    
    // Store holding data globally for price fetch to use
    window._holdingData = holdingData;
    
    // Fetch current prices for all holdings async
    fetchHoldingPrices(holdingData);
}
window.renderHoldings = renderHoldings;

/**
 * Edit the cost basis for a holding
 */
window.editHoldingCostBasis = function(holdingId) {
    const holding = state.holdings?.find(h => h.id === holdingId);
    if (!holding) return;
    
    const currentBasis = holding.costBasis || 0;
    const newBasisStr = prompt(`Enter new cost basis for ${holding.ticker} (current: $${currentBasis.toFixed(2)}):`, currentBasis.toFixed(2));
    
    if (newBasisStr === null) return; // Cancelled
    
    const newBasis = parseFloat(newBasisStr);
    if (isNaN(newBasis) || newBasis < 0) {
        alert('Invalid cost basis. Please enter a positive number.');
        return;
    }
    
    // Update the holding
    holding.costBasis = newBasis;
    holding.totalCost = newBasis * (holding.shares || 100);
    
    // Recalculate net cost basis if we have premium
    if (holding.premiumCredit) {
        holding.netCostBasis = newBasis - (holding.premiumCredit / (holding.shares || 100));
    }
    
    // Save and re-render
    saveHoldingsToStorage();
    renderHoldings();
    
    showNotification(`Updated ${holding.ticker} cost basis to $${newBasis.toFixed(2)}`, 'success');
};

/**
 * Fetch current prices for holdings and calculate all metrics
 * This is where the magic happens - we show traders what they need to know
 * Now uses Schwab BATCH API (single request for all tickers!)
 */
async function fetchHoldingPrices(holdingData) {
    if (!holdingData || holdingData.length === 0) return;
    
    const tickers = [...new Set(holdingData.map(h => h.ticker))];
    
    // BATCH fetch all prices in ONE request!
    const priceMap = await fetchStockPricesBatch(tickers);
    console.log(`[HOLDINGS] Fetched ${Object.keys(priceMap).length} prices for holdings`);
    
    // Summary totals
    let sumCapital = 0;
    let sumCurrentValue = 0;
    let sumStockPnL = 0;
    let sumPremium = 0;
    let sumOnTable = 0;
    let hasPrices = false;  // Track if we got any valid prices
    
    // Update each holding row with calculated metrics
    for (const h of holdingData) {
        const currentPrice = priceMap[h.ticker] || 0;
        
        // Always add capital and premium to summary (we know these)
        sumCapital += h.totalCost;
        sumPremium += h.premium;
        
        // Only calculate current value metrics if we have a valid price
        if (currentPrice > 0) {
            hasPrices = true;
            const currentValue = currentPrice * h.shares;
            const stockPnL = currentValue - h.totalCost;
            const totalReturn = stockPnL + h.premium;
            const moneyOnTable = h.strike > 0 && currentPrice > h.strike 
                ? (currentPrice - h.strike) * h.shares 
                : 0;
            
            sumCurrentValue += currentValue;
            sumStockPnL += stockPnL;
            sumOnTable += moneyOnTable;
            
            // Update row with calculated values
            updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable);
        } else {
            // Price fetch failed - show error state
            showHoldingError(h);
        }
    }
    
    // Update summary row (only if we have prices)
    updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumOnTable, hasPrices);
}

/**
 * Update a single holding row with calculated values
 */
function updateHoldingRow(h, currentPrice, currentValue, stockPnL, totalReturn, moneyOnTable) {
    // Stock Value column
    const priceEl = document.getElementById(`hp-${h.id}`);
    const stockPnLEl = document.getElementById(`hspnl-${h.id}`);
    
    if (priceEl) {
        priceEl.textContent = `$${currentValue.toFixed(0)}`;
        priceEl.style.color = '#fff';
    }
    
    if (stockPnLEl) {
        const pnlColor = stockPnL >= 0 ? '#00ff88' : '#ff5252';
        const pnlSign = stockPnL >= 0 ? '+' : '';
        const pnlPct = h.totalCost > 0 ? ((stockPnL / h.totalCost) * 100).toFixed(1) : 0;
        stockPnLEl.innerHTML = `<span style="color:${pnlColor};">${pnlSign}$${stockPnL.toFixed(0)} (${pnlSign}${pnlPct}%)</span>`;
    }
    
    // Total Return column
    const totalReturnEl = document.getElementById(`htr-${h.id}`);
    if (totalReturnEl) {
        const trColor = totalReturn >= 0 ? '#00ff88' : '#ff5252';
        const trSign = totalReturn >= 0 ? '+' : '';
        const trPct = h.totalCost > 0 ? ((totalReturn / h.totalCost) * 100).toFixed(1) : 0;
        totalReturnEl.innerHTML = `
            <div style="font-size:14px; font-weight:bold; color:${trColor};">${trSign}$${totalReturn.toFixed(0)}</div>
            <div style="font-size:10px; color:${trColor};">${trSign}${trPct}%</div>
        `;
    }
    
    // Money On Table / Cushion column
    const onTableEl = document.getElementById(`hot-${h.id}`);
    if (onTableEl) {
        if (moneyOnTable > 0) {
            onTableEl.innerHTML = `
                <div style="font-size:9px; color:#666; margin-bottom:2px;">ON TABLE</div>
                <div style="font-size:14px; font-weight:bold; color:#ff9800;">$${moneyOnTable.toFixed(0)}</div>
                <div style="font-size:10px; color:#ff5252;">⚠️ Roll UP!</div>
            `;
            onTableEl.style.background = 'rgba(255,152,0,0.15)';
        } else if (h.strike > 0) {
            const distToStrike = h.strike - currentPrice;
            const distPct = ((distToStrike / currentPrice) * 100).toFixed(1);
            if (distToStrike > 0) {
                onTableEl.innerHTML = `
                    <div style="font-size:9px; color:#666; margin-bottom:2px;">CUSHION</div>
                    <div style="font-size:14px; font-weight:bold; color:#00ff88;">${distPct}%</div>
                    <div style="font-size:10px; color:#888;">Safe zone</div>
                `;
                onTableEl.style.background = 'rgba(0,255,136,0.08)';
            } else {
                onTableEl.innerHTML = `
                    <div style="font-size:9px; color:#666; margin-bottom:2px;">STATUS</div>
                    <div style="font-size:14px; font-weight:bold; color:#00d9ff;">ITM</div>
                    <div style="font-size:10px; color:#888;">Will be called</div>
                `;
                onTableEl.style.background = 'rgba(0,217,255,0.1)';
            }
        } else {
            onTableEl.innerHTML = `
                <div style="font-size:9px; color:#666; margin-bottom:2px;">CUSHION</div>
                <div style="font-size:14px; font-weight:bold; color:#888;">—</div>
            `;
        }
    }
}

/**
 * Show error state for a holding when price fetch fails
 */
function showHoldingError(h) {
    const priceEl = document.getElementById(`hp-${h.id}`);
    const stockPnLEl = document.getElementById(`hspnl-${h.id}`);
    const totalReturnEl = document.getElementById(`htr-${h.id}`);
    const onTableEl = document.getElementById(`hot-${h.id}`);
    
    if (priceEl) {
        priceEl.innerHTML = `<span style="color:#ff5252; font-size:12px;">⚠️ No price</span>`;
    }
    if (stockPnLEl) {
        stockPnLEl.innerHTML = '';
    }
    if (totalReturnEl) {
        totalReturnEl.innerHTML = `<div style="font-size:14px; color:#888;">—</div>`;
    }
    if (onTableEl) {
        onTableEl.innerHTML = `
            <div style="font-size:9px; color:#666; margin-bottom:2px;">CUSHION</div>
            <div style="font-size:14px; font-weight:bold; color:#888;">—</div>
        `;
    }
}

/**
 * Update the holdings summary row
 */
function updateHoldingSummary(sumCapital, sumCurrentValue, sumStockPnL, sumPremium, sumOnTable, hasPrices) {
    const updateSum = (id, value, color) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = value;
            if (color) el.style.color = color;
        }
    };
    
    updateSum('sumCapital', `$${sumCapital.toFixed(0)}`, '#fa0');
    updateSum('sumPremium', `+$${sumPremium.toFixed(0)}`, '#00ff88');
    
    if (hasPrices) {
        const sumTotalReturn = sumStockPnL + sumPremium;
        const returnPct = sumCapital > 0 ? ((sumTotalReturn / sumCapital) * 100).toFixed(1) : 0;
        
        updateSum('sumValue', `$${sumCurrentValue.toFixed(0)}`, '#fff');
        updateSum('sumStockPnL', `${sumStockPnL >= 0 ? '+' : ''}$${sumStockPnL.toFixed(0)}`, sumStockPnL >= 0 ? '#00ff88' : '#ff5252');
        updateSum('sumTotalReturn', `${sumTotalReturn >= 0 ? '+' : ''}$${sumTotalReturn.toFixed(0)} (${returnPct}%)`, sumTotalReturn >= 0 ? '#00ff88' : '#ff5252');
        
        // Add "on table" warning if significant
        if (sumOnTable > 100) {
            const summaryEl = document.getElementById('holdingsSummary');
            if (summaryEl && !summaryEl.innerHTML.includes('On Table')) {
                const warningHtml = `
                    <div style="margin-top:10px; padding:8px; background:rgba(255,152,0,0.2); border:1px solid rgba(255,152,0,0.4); border-radius:4px;">
                        <span style="color:#ff9800; font-weight:bold;">⚠️ $${sumOnTable.toFixed(0)} On Table</span>
                        <span style="color:#888; margin-left:10px; font-size:11px;">Consider rolling up to capture more upside</span>
                    </div>
                `;
                summaryEl.insertAdjacentHTML('beforeend', warningHtml);
            }
        }
    } else {
        // No prices available
        updateSum('sumValue', '⚠️ No prices', '#ff5252');
        updateSum('sumStockPnL', '—', '#888');
        updateSum('sumTotalReturn', '—', '#888');
    }
}

/**
 * Get AI suggestions for a holding (roll up, sell, hold, etc.)
 */
window.aiHoldingSuggestion = async function(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) return;
    
    // Find linked position - first try the stored linkedPositionId
    let position = holding.linkedPositionId 
        ? state.positions.find(p => p.id === holding.linkedPositionId)
        : null;
    
    // If not found (position may have been rolled/closed), find the current OPEN position for this ticker
    if (!position) {
        // Look for any open covered_call or buy_write for this ticker
        position = state.positions.find(p => 
            p.ticker === holding.ticker && 
            (p.type === 'covered_call' || p.type === 'buy_write') &&
            p.status !== 'closed'
        );
        
        // If found, update the holding's link
        if (position && holding.linkedPositionId !== position.id) {
            console.log(`[AI] Auto-linking ${holding.ticker} holding to position ${position.id}`);
            holding.linkedPositionId = position.id;
            localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
        }
    }
    
    const shares = holding.shares || 100;
    const strike = position?.strike || holding.strike || 0;
    const premium = holding.premiumCredit || (position?.premium * 100) || 0;
    const costBasis = holding.stockPrice || holding.costBasis || 0;
    const dte = position?.expiry ? Math.max(0, Math.round((new Date(position.expiry) - new Date()) / 86400000)) : 0;
    const expiry = position?.expiry || 'unknown';
    
    // Show loading modal immediately
    const modal = document.createElement('div');
    modal.id = 'aiHoldingModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10001;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #ffaa00;border-radius:12px;padding:24px;max-width:650px;width:90%;max-height:85vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            <div style="text-align:center;padding:40px;color:#888;">
                <div style="font-size:24px;margin-bottom:10px;">🔄</div>
                <div>Fetching current price...</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Fetch current stock price
    let currentPrice = 0;
    try {
        const quoteRes = await fetch(`/api/schwab/quote/${holding.ticker}`);
        if (quoteRes.ok) {
            const quoteData = await quoteRes.json();
            currentPrice = quoteData.lastPrice || quoteData.price || quoteData.regularMarketLastPrice || 0;
        }
    } catch (e) {
        console.warn('Failed to fetch Schwab quote, trying Yahoo');
    }
    
    // Try Yahoo Finance (different endpoint format)
    if (!currentPrice) {
        try {
            const yahooRes = await fetch(`/api/yahoo/${holding.ticker}`);
            if (yahooRes.ok) {
                const yahooData = await yahooRes.json();
                // Yahoo returns nested structure
                currentPrice = yahooData.chart?.result?.[0]?.meta?.regularMarketPrice || 0;
            }
        } catch (e) {
            console.warn('Failed to fetch Yahoo quote');
        }
    }
    
    // Try CBOE as last resort (the same endpoint used for options)
    if (!currentPrice) {
        try {
            const cboeRes = await fetch(`/api/cboe/quote/${holding.ticker}`);
            if (cboeRes.ok) {
                const cboeData = await cboeRes.json();
                currentPrice = cboeData.currentPrice || cboeData.underlyingPrice || cboeData.data?.underlying_price || 0;
            }
        } catch (e) {
            console.warn('Failed to fetch CBOE quote');
        }
    }
    
    if (!currentPrice) {
        document.querySelector('#aiHoldingModal > div').innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ff5252;">❌ Price Error</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            <p style="color:#888;">Could not fetch current price for ${holding.ticker}.</p>
            <p style="color:#666;font-size:11px;">Check your Schwab connection or try again.</p>
        `;
        return;
    }
    
    // Update modal to show analyzing
    document.querySelector('#aiHoldingModal > div > div:last-child').innerHTML = `
        <div style="font-size:24px;margin-bottom:10px;">🤔</div>
        <div>Analyzing position...</div>
    `;
    
    // Calculate metrics with real per-share price
    const stockValue = currentPrice * shares;
    const stockGainLoss = costBasis > 0 ? (currentPrice - costBasis) * shares : 0;
    const onTable = strike && currentPrice > strike ? (currentPrice - strike) * shares : 0;
    const cushion = strike && currentPrice < strike ? (strike - currentPrice) * shares : 0;
    const ifCalled = strike ? (strike - costBasis) * shares + premium : 0;
    const breakeven = costBasis - (premium / shares);
    
    // Determine situation
    const isITM = currentPrice > strike;
    const isOTM = currentPrice < strike;
    const isDeep = isITM ? (currentPrice - strike) / strike > 0.05 : (strike - currentPrice) / strike > 0.1;
    
    // Build detailed prompt
    const prompt = `You are a wheel strategy options expert. Analyze this covered call position and give SPECIFIC, ACTIONABLE advice.

=== POSITION DETAILS ===
Ticker: ${holding.ticker}
Shares: ${shares} @ $${costBasis.toFixed(2)} cost basis (Total: $${(costBasis * shares).toFixed(0)})
Current stock price: $${currentPrice.toFixed(2)}
Covered call: $${strike.toFixed(2)} strike, expires ${expiry} (${dte} DTE)
Premium collected: $${premium.toFixed(0)} total ($${(premium/shares).toFixed(2)}/share)
Breakeven: $${breakeven.toFixed(2)}

=== CURRENT STATUS ===
Stock P&L: ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss.toFixed(0)} (${((stockGainLoss / (costBasis * shares)) * 100).toFixed(1)}%)
Option status: ${isITM ? 'IN THE MONEY (ITM)' : 'OUT OF THE MONEY (OTM)'}
${isITM ? `Money on table (above strike): $${onTable.toFixed(0)}` : `Cushion to strike: $${cushion.toFixed(0)} (${((strike - currentPrice) / currentPrice * 100).toFixed(1)}%)`}
If called at expiry: +$${ifCalled.toFixed(0)} total profit

=== YOUR TASK ===
Provide a COMPLETE analysis with these sections:

**SITUATION SUMMARY**
Explain what's happening with this position in 2-3 sentences. Is the covered call working as intended? What's the risk?

**RECOMMENDATION** 
Choose ONE: HOLD / ROLL UP / ROLL OUT / ROLL UP & OUT / LET IT GET CALLED / BUY BACK THE CALL
Explain WHY this is the best action right now.

**SPECIFIC ACTION**
If holding: Explain what price levels would change your recommendation.
If rolling: Suggest specific new strike (e.g., "$31 or $32") and timeframe (e.g., "30-45 DTE").
If letting call: Explain what to expect at expiration.

**KEY RISK**
One important risk or thing to watch.

Be specific with dollar amounts and percentages. Don't be vague.`;

    // Store context for retry with different model
    window._aiHoldingContext = {
        holding, position, currentPrice, strike, premium, costBasis, dte, expiry,
        shares, stockValue, stockGainLoss, onTable, cushion, ifCalled, breakeven,
        isITM, isOTM, isDeep, prompt
    };
    
    // Run analysis with Grok by default (better quality)
    await runHoldingAnalysis('grok');
};

/**
 * Run the holding analysis with specified model (called by toggle)
 */
async function runHoldingAnalysis(modelType) {
    const ctx = window._aiHoldingContext;
    if (!ctx) return;
    
    const { holding, position, currentPrice, strike, premium, costBasis, dte, 
            stockGainLoss, onTable, cushion, ifCalled, isITM, prompt, shares } = ctx;
    
    // Update modal to show loading
    const contentDiv = document.querySelector('#aiHoldingModal > div');
    if (!contentDiv) return;
    
    contentDiv.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker}</h3>
            <button onclick="this.closest('#aiHoldingModal').remove()" 
                style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
        </div>
        
        <!-- Model toggle -->
        <div style="display:flex;gap:8px;margin-bottom:16px;">
            <button id="btnOllama" onclick="runHoldingAnalysis('ollama')" 
                style="flex:1;padding:8px;border:1px solid ${modelType === 'ollama' ? '#00ff88' : '#444'};
                       background:${modelType === 'ollama' ? 'rgba(0,255,136,0.15)' : '#252540'};
                       color:${modelType === 'ollama' ? '#00ff88' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                🦙 Ollama (32B) - Free
            </button>
            <button id="btnGrok" onclick="runHoldingAnalysis('grok')" 
                style="flex:1;padding:8px;border:1px solid ${modelType === 'grok' ? '#1da1f2' : '#444'};
                       background:${modelType === 'grok' ? 'rgba(29,161,242,0.15)' : '#252540'};
                       color:${modelType === 'grok' ? '#1da1f2' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                🔥 Grok - ~$0.02
            </button>
        </div>
        
        <div style="text-align:center;padding:40px;color:#888;">
            <div style="font-size:24px;margin-bottom:10px;">🔄</div>
            <div>Analyzing with ${modelType === 'grok' ? 'Grok' : 'Ollama 32B'}...</div>
        </div>
    `;
    
    try {
        let response, result, analysis;
        
        if (modelType === 'grok') {
            response = await fetch('/api/ai/grok', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, maxTokens: 800 })
            });
        } else {
            response = await fetch('/api/ai/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker: holding.ticker,
                    customPrompt: prompt,
                    model: 'qwen2.5:32b'
                })
            });
        }
        
        if (!response.ok) throw new Error('AI analysis failed');
        
        result = await response.json();
        analysis = result.insight || result.analysis || 'No analysis returned';
        
        // Better formatting for section headers
        const formatted = analysis
            // Bold text
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#ffaa00;">$1</strong>')
            // Section headers like "**SITUATION SUMMARY**" or "SITUATION SUMMARY"
            .replace(/^[\*]*\s*(SITUATION SUMMARY|RECOMMENDATION|SPECIFIC ACTION|KEY RISK)[:\*]*/gim, 
                '<div style="color:#00d9ff;font-weight:bold;font-size:14px;margin-top:16px;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;">$1</div>')
            // Numbered headers like "1. SITUATION"
            .replace(/^(\d+)\.\s*(SITUATION|RECOMMENDATION|SPECIFIC|KEY|RISK)/gim,
                '<div style="color:#00d9ff;font-weight:bold;font-size:14px;margin-top:16px;margin-bottom:6px;border-bottom:1px solid #333;padding-bottom:4px;">$2</div>')
            // Line breaks
            .replace(/\n/g, '<br>');
        
        const modelBadge = modelType === 'grok' 
            ? '<span style="background:rgba(29,161,242,0.2);color:#1da1f2;padding:2px 8px;border-radius:4px;font-size:10px;margin-left:8px;">🔥 Grok</span>'
            : '<span style="background:rgba(0,255,136,0.2);color:#00ff88;padding:2px 8px;border-radius:4px;font-size:10px;margin-left:8px;">🦙 Ollama</span>';
        
        contentDiv.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ffaa00;">🤖 AI Suggestion: ${holding.ticker} ${modelBadge}</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <!-- Model toggle -->
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <button onclick="runHoldingAnalysis('ollama')" 
                    style="flex:1;padding:8px;border:1px solid ${modelType === 'ollama' ? '#00ff88' : '#444'};
                           background:${modelType === 'ollama' ? 'rgba(0,255,136,0.15)' : '#252540'};
                           color:${modelType === 'ollama' ? '#00ff88' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                    🦙 Ollama (32B) - Free
                </button>
                <button onclick="runHoldingAnalysis('grok')" 
                    style="flex:1;padding:8px;border:1px solid ${modelType === 'grok' ? '#1da1f2' : '#444'};
                           background:${modelType === 'grok' ? 'rgba(29,161,242,0.15)' : '#252540'};
                           color:${modelType === 'grok' ? '#1da1f2' : '#888'};border-radius:6px;cursor:pointer;font-size:11px;">
                    🔥 Grok - ~$0.02
                </button>
            </div>
            
            <!-- Position snapshot -->
            <div style="background:#252540;padding:12px;border-radius:8px;margin-bottom:16px;">
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12px;margin-bottom:10px;">
                    <div><span style="color:#666;">Stock:</span> <span style="color:#fff;">$${currentPrice.toFixed(2)}</span></div>
                    <div><span style="color:#666;">Strike:</span> <span style="color:#fff;">$${strike.toFixed(2)}</span></div>
                    <div><span style="color:#666;">Cost:</span> <span style="color:#fff;">$${costBasis.toFixed(2)}</span></div>
                    <div><span style="color:#666;">DTE:</span> <span style="color:#fff;">${dte} days</span></div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center;padding-top:10px;border-top:1px solid #333;">
                    <div>
                        <div style="font-size:9px;color:#666;">STOCK P&L</div>
                        <div style="font-weight:bold;color:${stockGainLoss >= 0 ? '#00ff88' : '#ff5252'};">
                            ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss.toFixed(0)}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">PREMIUM</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${premium.toFixed(0)}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">${isITM ? 'ON TABLE' : 'CUSHION'}</div>
                        <div style="font-weight:bold;color:${isITM ? '#ffaa00' : '#00d9ff'};">
                            ${isITM ? '$' + onTable.toFixed(0) : '$' + cushion.toFixed(0)}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:9px;color:#666;">IF CALLED</div>
                        <div style="font-weight:bold;color:#00ff88;">+$${ifCalled.toFixed(0)}</div>
                    </div>
                </div>
            </div>
            
            <!-- Status badge -->
            <div style="margin-bottom:12px;">
                <span style="background:${isITM ? 'rgba(255,152,0,0.2)' : 'rgba(0,217,255,0.2)'}; 
                       color:${isITM ? '#ff9800' : '#00d9ff'}; 
                       padding:4px 12px; border-radius:12px; font-size:11px; font-weight:bold;">
                    ${isITM ? '⚠️ IN THE MONEY' : '✅ OUT OF THE MONEY'}
                </span>
            </div>
            
            <!-- AI Analysis -->
            <div style="line-height:1.7;font-size:13px;">
                ${formatted}
            </div>
            
            <div style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
                ${position ? `
                <button onclick="window.rollPosition(${position.id});this.closest('#aiHoldingModal').remove();" 
                    style="padding:10px 16px;background:#ce93d8;border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">
                    🔄 Roll This Call
                </button>
                ` : ''}
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="padding:10px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
    } catch (e) {
        console.error('AI Holding suggestion error:', e);
        contentDiv.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;color:#ff5252;">❌ AI Error</h3>
                <button onclick="this.closest('#aiHoldingModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <!-- Model toggle for retry -->
            <div style="display:flex;gap:8px;margin-bottom:16px;">
                <button onclick="runHoldingAnalysis('ollama')" 
                    style="flex:1;padding:8px;border:1px solid #444;background:#252540;color:#888;border-radius:6px;cursor:pointer;font-size:11px;">
                    🦙 Retry with Ollama
                </button>
                <button onclick="runHoldingAnalysis('grok')" 
                    style="flex:1;padding:8px;border:1px solid #444;background:#252540;color:#888;border-radius:6px;cursor:pointer;font-size:11px;">
                    🔥 Retry with Grok
                </button>
            </div>
            
            <p style="color:#888;">Failed to get AI analysis: ${e.message}</p>
            <p style="color:#666;font-size:11px;">${modelType === 'grok' ? 'Check your Grok API key in Settings.' : 'Make sure Ollama is running with qwen2.5:32b loaded.'}</p>
        `;
    }
}
window.runHoldingAnalysis = runHoldingAnalysis;

/**
 * Analyze a Buy/Write holding - loads linked position into P&L tab
 */
window.analyzeHolding = function(holdingId) {
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding || !holding.linkedPositionId) {
        showNotification('No linked position found', 'warning');
        return;
    }
    
    // Find the linked Buy/Write position
    const position = state.positions.find(p => p.id === holding.linkedPositionId);
    if (!position) {
        showNotification('Linked position not found - may be closed', 'warning');
        return;
    }
    
    // Load position into analyzer - this switches to Options tab
    // User can see the position loaded, then click Run Monte Carlo
    if (window.loadPositionToAnalyze) {
        window.loadPositionToAnalyze(position.id);
        // loadPositionToAnalyze already switches to Options tab and shows notification
    }
};

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

/**
 * Show modal to link a closed position to a challenge
 */
window.showLinkToChallengeModal = function(positionId) {
    // Find the position
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) {
        console.error('Position not found:', positionId);
        return;
    }
    
    const challenges = state.challenges || [];
    const linkedChallengeIds = pos.challengeIds || [];
    
    const modal = document.createElement('div');
    modal.id = 'linkChallengeModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.85); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Build challenge options
    let challengeOptionsHtml = '';
    if (challenges.length === 0) {
        challengeOptionsHtml = `
            <div style="color:#888; padding:20px; text-align:center;">
                No challenges created yet.<br>
                <span style="font-size:11px;">Create a challenge in the Challenges tab first.</span>
            </div>
        `;
    } else {
        challengeOptionsHtml = challenges.map(ch => {
            const isLinked = linkedChallengeIds.includes(ch.id);
            const statusBadge = ch.status === 'completed' ? '✅' : ch.status === 'archived' ? '📦' : '🎯';
            const dateRange = `${ch.startDate} → ${ch.endDate}`;
            
            return `
                <div style="padding:12px; background:#0d0d1a; border:1px solid ${isLinked ? '#ffd700' : '#333'}; border-radius:8px; 
                            margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:${isLinked ? '#ffd700' : '#fff'}; font-weight:bold;">
                            ${statusBadge} ${ch.name}
                        </span>
                        <div style="color:#888; font-size:11px; margin-top:4px;">${dateRange}</div>
                    </div>
                    <button onclick="window.togglePositionChallenge(${positionId}, ${ch.id}, ${isLinked})"
                            style="padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;
                                   background:${isLinked ? '#ff5252' : '#00d9ff'}; 
                                   color:${isLinked ? '#fff' : '#000'}; border:none;">
                        ${isLinked ? 'Remove' : 'Add'}
                    </button>
                </div>
            `;
        }).join('');
    }
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border:1px solid #ffd700; 
                    border-radius:16px; padding:30px; width:90%; max-width:450px; max-height:80vh; overflow-y:auto;
                    box-shadow: 0 0 40px rgba(255, 215, 0, 0.2);">
            
            <h2 style="margin:0 0 10px 0; color:#fff; font-size:18px;">🏆 Link to Challenge</h2>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:20px;">
                <div style="color:#00d9ff; font-weight:bold; font-size:14px;">${pos.ticker}</div>
                <div style="color:#888; font-size:12px;">
                    ${pos.type.replace('_', ' ')} • $${pos.strike} • Closed ${pos.closeDate}
                </div>
            </div>
            
            <div style="color:#aaa; font-size:12px; margin-bottom:15px;">
                Select challenges to link this position to:
            </div>
            
            <div style="max-height:300px; overflow-y:auto;">
                ${challengeOptionsHtml}
            </div>
            
            <div style="margin-top:20px; text-align:right;">
                <button onclick="document.getElementById('linkChallengeModal').remove()"
                        style="padding:10px 20px; background:#333; color:#fff; border:none; border-radius:8px; cursor:pointer;">
                    Done
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Toggle a position's link to a challenge
 */
window.togglePositionChallenge = function(positionId, challengeId, isCurrentlyLinked) {
    const pos = (state.closedPositions || []).find(p => p.id === positionId);
    if (!pos) return;
    
    if (!pos.challengeIds) pos.challengeIds = [];
    
    if (isCurrentlyLinked) {
        // Remove from challenge
        pos.challengeIds = pos.challengeIds.filter(cid => cid !== challengeId);
        showNotification('Removed from challenge', 'info');
    } else {
        // Add to challenge
        if (!pos.challengeIds.includes(challengeId)) {
            pos.challengeIds.push(challengeId);
        }
        showNotification('✅ Added to challenge', 'success');
    }
    
    saveClosedPositions();
    
    // Refresh the modal to show updated state
    document.getElementById('linkChallengeModal')?.remove();
    window.showLinkToChallengeModal(positionId);
    
    // Refresh the table in background
    renderClosedPositions();
};
