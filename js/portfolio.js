// WheelHouse - Portfolio P&L Tracker
// Tracks actual P&L across all positions

import { state } from './state.js';
import { showNotification } from './utils.js';
import { fetchFromYahoo } from './api.js';

const STORAGE_KEY_CLOSED = 'wheelhouse_closed_positions';

/**
 * Trigger auto-save if enabled (calls the global function from positions.js)
 */
function triggerAutoSave() {
    if (window.triggerAutoSave) window.triggerAutoSave();
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
    triggerAutoSave();
}

/**
 * Fetch current option price for a position using Black-Scholes
 * Returns the theoretical price based on current spot
 */
async function fetchCurrentOptionPrice(position) {
    try {
        // Fetch current stock price using shared API function
        const result = await fetchFromYahoo(position.ticker);
        const spot = result.meta?.regularMarketPrice;
        
        if (spot) {
            // Calculate theoretical option price using Black-Scholes approximation
            const strike = position.strike;
            const dte = Math.max(1, position.dte);
            const T = dte / 365;
            const r = 0.05; // Risk-free rate
            const sigma = 0.30; // Assume 30% IV (could be fetched or estimated)
            
            const isPut = position.type.toLowerCase().includes('put');
            const price = blackScholesPrice(spot, strike, T, r, sigma, isPut);
            
            return {
                spot,
                optionPrice: Math.max(0.01, price),
                success: true
            };
        }
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
        
        if (fetchPrices) {
            const result = await fetchCurrentOptionPrice(pos);
            if (result.success) {
                fetchSuccessCount++;
                // Always update spot price
                currentSpot = result.spot;
                pos.currentSpot = currentSpot;
                
                // Only use calculated price if user hasn't marked a price
                if (!pos.markedPrice) {
                    currentPrice = result.optionPrice;
                    pos.lastOptionPrice = currentPrice;
                } else {
                    // Keep using user's marked price
                    currentPrice = pos.markedPrice;
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
            premiumReceived,
            currentValue,
            unrealizedPnL,
            pnlPercent
        });
    }
    
    if (loadingEl) loadingEl.style.display = 'none';
    
    // Show fetch result notification
    if (fetchPrices) {
        if (fetchSuccessCount > 0) {
            showNotification(`Updated ${fetchSuccessCount} position(s)`, 'success');
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
                    <th style="padding:10px; text-align:right;">Current</th>
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
                    
                    return `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.1); background:${pnlBg};">
                            <td style="padding:10px; font-weight:bold; color:#00d9ff;">${pos.ticker}</td>
                            <td style="padding:10px; color:${isPut ? '#ff5252' : '#00ff88'};">${pos.type.replace('_', ' ')}</td>
                            <td style="padding:10px; text-align:right;">$${pos.strike.toFixed(2)}</td>
                            <td style="padding:10px; text-align:right;">${pos.currentSpot ? '$' + pos.currentSpot.toFixed(2) + ' ' + itmWarning : '—'}</td>
                            <td style="padding:10px; text-align:right; color:${pos.dte <= 7 ? '#ff5252' : pos.dte <= 14 ? '#ffaa00' : '#888'};">${pos.dte}d</td>
                            <td style="padding:10px; text-align:right; color:#00ff88;">$${pos.premium.toFixed(2)} × ${pos.contracts}</td>
                            <td style="padding:10px; text-align:right;" title="${pos.markedPrice ? 'User-entered price' : 'Calculated (may be inaccurate)'}">
                                ${pos.currentPrice ? '$' + pos.currentPrice.toFixed(2) : '—'}
                                ${pos.markedPrice ? '<span style="color:#00d9ff; font-size:10px;"> ✓</span>' : 
                                  pos.currentPrice ? '<span style="color:#888; font-size:10px;"> ~</span>' : ''}
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
                                               border-radius:4px; cursor:pointer; font-size:11px;"
                                        title="Enter current option price from broker">
                                    ✎ Mark
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
    
    updatePortfolioSummary(positionData);
    renderHoldings();
    renderClosedPositions();
}

/**
 * Update portfolio summary stats
 */
function updatePortfolioSummary(positionData) {
    const openCount = positionData.length;
    const totalPremium = positionData.reduce((sum, p) => sum + p.premiumReceived, 0);
    const capitalRisk = positionData.reduce((sum, p) => sum + (p.strike * 100 * p.contracts), 0);
    const unrealizedPnL = positionData.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
    
    // Realized P&L from closed positions (support both realizedPnL and closePnL field names)
    const realizedPnL = (state.closedPositions || []).reduce((sum, p) => sum + (p.realizedPnL ?? p.closePnL ?? 0), 0);
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
    
    // Performance stats from closed positions
    const closed = state.closedPositions || [];
    if (closed.length > 0) {
        const wins = closed.filter(p => p.realizedPnL >= 0).length;
        const winRate = (wins / closed.length) * 100;
        const avgDays = closed.reduce((sum, p) => sum + (p.daysHeld || 0), 0) / closed.length;
        
        // Find best and worst trades
        const bestTrade = closed.reduce((best, p) => (p.realizedPnL || 0) > (best.realizedPnL || 0) ? p : best, closed[0]);
        const worstTrade = closed.reduce((worst, p) => (p.realizedPnL || 0) < (worst.realizedPnL || 0) ? p : worst, closed[0]);
        
        setEl('portWinRate', winRate.toFixed(0) + '%');
        setEl('portAvgDays', avgDays.toFixed(0) + 'd');
        
        // Best trade (always positive, green)
        const bestEl = document.getElementById('portBestTrade');
        if (bestEl) {
            const bestPnL = bestTrade.realizedPnL || 0;
            bestEl.textContent = (bestPnL >= 0 ? '+$' : '-$') + Math.abs(bestPnL).toFixed(0);
            bestEl.style.color = '#00ff88';
            bestEl.style.cursor = 'pointer';
            bestEl.title = `Click to see details`;
            bestEl.onclick = () => showTradeDetails(bestTrade, 'Best Trade');
        }
        
        // Worst trade (may be negative, red)
        const worstEl = document.getElementById('portWorstTrade');
        if (worstEl) {
            const worstPnL = worstTrade.realizedPnL || 0;
            worstEl.textContent = (worstPnL >= 0 ? '+$' : '-$') + Math.abs(worstPnL).toFixed(0);
            worstEl.style.color = worstPnL >= 0 ? '#ffaa00' : '#ff5252';
            worstEl.style.cursor = 'pointer';
            worstEl.title = `Click to see details`;
            worstEl.onclick = () => showTradeDetails(worstTrade, 'Worst Trade');
        }
    }
}

/**
 * Show trade details in a notification or alert
 */
function showTradeDetails(trade, label) {
    const pnl = trade.realizedPnL || 0;
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
        return closeDate.split('-')[0];
    }).filter(y => y))].sort().reverse();
    
    // Current filter (stored in state or default to current year)
    const currentYear = new Date().getFullYear().toString();
    state.closedYearFilter = state.closedYearFilter || currentYear;
    
    // Filter positions by selected year (based on CLOSE date for tax purposes)
    const closed = state.closedYearFilter === 'all' 
        ? allClosed 
        : allClosed.filter(p => (p.closeDate || '').startsWith(state.closedYearFilter));
    
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
        chains[chainKey].totalPnL += pos.realizedPnL || 0;
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
                    <th style="padding:6px; text-align:right;">Days</th>
                    <th style="padding:6px; text-align:right;">P&L</th>
                    <th style="padding:6px; text-align:right;" title="Return on Capital at Risk">ROC%</th>
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
                    <td colspan="7" style="padding:8px; color:#00d9ff; font-weight:bold;">
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
            
            // Calculate days held if missing but dates available
            let daysHeld = pos.daysHeld;
            if (!daysHeld && pos.openDate && pos.closeDate) {
                const open = new Date(pos.openDate);
                const close = new Date(pos.closeDate);
                daysHeld = Math.max(0, Math.ceil((close - open) / (1000 * 60 * 60 * 24)));
            }
            
            html += `
                <tr style="${rowBorder}">
                    <td style="padding:6px; ${indentStyle} color:#00d9ff;">${legLabel}${pos.ticker}</td>
                    <td style="padding:6px;">${pos.type.replace('_', ' ')}</td>
                    <td style="padding:6px; text-align:right;">$${pos.strike.toFixed(2)}</td>
                    <td style="padding:6px; text-align:right;">$${pos.premium.toFixed(2)} × ${pos.contracts || 1}</td>
                    <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.openDate || '—'}</td>
                    <td style="padding:6px; text-align:center; color:#888; font-size:11px;">${pos.closeDate}</td>
                    <td style="padding:6px; text-align:right;">${daysHeld ?? '—'}d</td>
                    <td style="padding:6px; text-align:right; font-weight:bold; color:${pnl >= 0 ? '#00ff88' : '#ff5252'};">
                        ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}
                    </td>
                    <td style="padding:6px; text-align:right; color:${rocColor};">
                        ${roc >= 0 ? '+' : ''}${roc.toFixed(1)}%
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
