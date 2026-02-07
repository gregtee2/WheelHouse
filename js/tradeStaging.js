// WheelHouse - Trade Staging Module
// Extracted from main.js for maintainability
// Handles: pending trades queue, trade confirmation modals, close position flow,
//          margin checking, Schwab order integration

import { showNotification } from 'utils';
import AccountService from 'AccountService';

/**
 * Legacy stage function (without thesis)
 */
window.stageTrade = function(ticker, strike, expiry, currentPrice, premium) {
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade
    const trade = {
        id: Date.now(),
        ticker,
        type: 'short_put',  // Default staging is for puts
        strike: parseFloat(strike),
        expiry,
        currentPrice: parseFloat(currentPrice),
        premium: parseFloat(premium) || 0,
        isCall: false,
        isDebit: false,  // Short put = credit
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${ticker} $${strike} put, ${expiry}`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Render pending trades section
 */
window.renderPendingTrades = function() {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    let container = document.getElementById('pendingTradesSection');
    
    // Create container if it doesn't exist
    if (!container) {
        const positionsTab = document.getElementById('positions');
        if (!positionsTab) return;
        
        container = document.createElement('div');
        container.id = 'pendingTradesSection';
        positionsTab.insertBefore(container, positionsTab.firstChild);
    }
    
    if (pending.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    // Calculate DTE and annualized return for each pending trade
    const today = new Date();
    const pendingWithCalcs = pending.map(p => {
        // Parse expiry to calculate DTE
        const expiryDate = parseExpiryToDate(p.expiry);
        const expDate = expiryDate ? new Date(expiryDate) : null;
        const dte = expDate ? Math.ceil((expDate - today) / (1000 * 60 * 60 * 24)) : null;
        
        // Calculate credit/debit display (premium × 100)
        const credit = p.premium ? (p.premium * 100) : null;
        
        // Calculate annualized return based on trade type
        // Use minimum 1 DTE to avoid division by zero for 0 DTE trades
        let annReturn = null;
        const safeDte = Math.max(dte || 1, 1);
        if (p.premium && safeDte > 0) {
            const isSpread = p.type?.includes('_spread') || p.upperStrike;
            const isDebitSpread = p.isDebit || p.type?.includes('debit');
            
            if (isSpread && p.strike && p.upperStrike) {
                const spreadWidth = Math.abs(p.strike - p.upperStrike);
                
                if (isDebitSpread) {
                    // For DEBIT spreads: (Max Profit / Debit Paid) × (365 / DTE) × 100
                    // Max Profit = Spread Width - Debit
                    const maxProfit = (spreadWidth - p.premium) * 100;
                    const debitPaid = p.premium * 100;
                    if (debitPaid > 0) {
                        annReturn = ((maxProfit / debitPaid) * (365 / safeDte) * 100).toFixed(1);
                    }
                } else {
                    // For CREDIT spreads: (Premium / Spread Width) × (365 / DTE) × 100
                    const buyingPowerPerContract = spreadWidth * 100;
                    if (buyingPowerPerContract > 0) {
                        annReturn = ((p.premium * 100) / buyingPowerPerContract * (365 / safeDte) * 100).toFixed(1);
                    }
                }
            } else if (p.strike) {
                // For single legs: (premium / strike) × (365 / DTE) × 100
                annReturn = ((p.premium / p.strike) * (365 / safeDte) * 100).toFixed(1);
            }
        }
        
        return { ...p, dte, credit, annReturn };
    });
    
    container.innerHTML = `
        <div style="background:rgba(0,217,255,0.05); border:1px solid rgba(0,217,255,0.3); border-radius:8px; padding:16px; margin-bottom:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="color:#00d9ff; margin:0; font-size:14px;">📋 Pending Trades (${pending.length})</h3>
                ${pending.length >= 2 ? `<button onclick="window.runPortfolioFitAnalysis()" style="background:linear-gradient(135deg, #7a8a94, #5a6a74); color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:11px; font-weight:bold;">🧠 AI Portfolio Fit</button>` : ''}
            </div>
            <div style="font-size:11px; color:#888; margin-bottom:12px;">
                Staged from AI analysis - confirm when you execute with your broker
            </div>
            <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <thead>
                    <tr style="color:#888; text-align:left;">
                        <th style="padding:6px;">Ticker</th>
                        <th style="padding:6px;">Strike</th>
                        <th style="padding:6px;">Expiry</th>
                        <th style="padding:6px;">DTE</th>
                        <th style="padding:6px;">Cr/Dr</th>
                        <th style="padding:6px;">Ann%</th>
                        <th style="padding:6px;">Staged</th>
                        <th style="padding:6px; min-width:180px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${pendingWithCalcs.map(p => {
                        // Determine option type - SKIP is always calls
                        const isCall = p.isCall || p.type === 'skip_call' || p.type === 'long_call' || p.type?.includes('call');
                        const optionType = isCall ? 'C' : 'P';
                        const typeColor = isCall ? '#ffaa00' : '#00d9ff';
                        // Spreads and long positions are debits, short positions are credits
                        const isSpread = p.type?.includes('_spread') || p.upperStrike;
                        const isDebit = p.isDebit || p.type === 'skip_call' || p.type === 'long_call' || p.type?.includes('debit');
                        const crDrLabel = isDebit ? 'Dr' : 'Cr';
                        const crDrColor = isDebit ? '#ff9800' : '#00d9ff';  // Orange for debit, cyan for credit
                        // Badge priority: CLOSE > ROLL > SKIP > SPREAD
                        const closeBadge = p.isClose ? '<span style="background:#ff5252;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">CLOSE</span>' : '';
                        const rollBadge = !p.isClose && p.isRoll ? '<span style="background:#7a8a94;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">ROLL</span>' : '';
                        const skipBadge = p.isSkip ? '<span style="background:#8b5cf6;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">SKIP™</span>' : '';
                        const spreadBadge = isSpread && !p.isSkip ? '<span style="background:#00bcd4;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;margin-left:4px;">SPREAD</span>' : '';
                        
                        // Determine strike display based on trade type
                        let strikeDisplay, expiryDisplay, dteDisplay;
                        
                        if (p.isSkip && p.leapsStrike && p.skipStrike) {
                            // SKIP trades show both LEAPS and SKIP legs
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#ffaa00;">$${p.leapsStrike}<span style="color:#888;font-size:10px;">C</span> <span style="color:#888;font-size:9px;">LEAPS</span></div>
                                <div style="color:#ffaa00;">$${p.skipStrike}<span style="color:#888;font-size:10px;">C</span> <span style="color:#888;font-size:9px;">SKIP</span></div>
                            </div>`;
                            expiryDisplay = `<div style="line-height:1.3;">
                                <div>${p.leapsExpiry}</div>
                                <div>${p.skipExpiry}</div>
                            </div>`;
                            dteDisplay = `<div style="line-height:1.3;">
                                <div style="color:#888;">${p.leapsDte ?? '-'}</div>
                                <div style="color:#888;">${p.skipDte ?? '-'}</div>
                            </div>`;
                        } else if (isSpread && p.upperStrike) {
                            // Spread trades show buy/sell legs
                            const isBullSpread = p.type?.includes('debit') || (isCall && p.strike < p.upperStrike);
                            const buyStrike = isBullSpread ? p.strike : p.upperStrike;
                            const sellStrike = isBullSpread ? p.upperStrike : p.strike;
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#00ff88;">Buy $${buyStrike}<span style="color:#888;font-size:10px;">${optionType}</span></div>
                                <div style="color:#ff5252;">Sell $${sellStrike}<span style="color:#888;font-size:10px;">${optionType}</span></div>
                            </div>`;
                            expiryDisplay = p.expiry;
                            dteDisplay = p.dte ?? '-';
                        } else if (p.isRoll && p.rollFrom) {
                            // Roll trades show close/open legs
                            const rollType = p.isCall ? 'C' : 'P';
                            strikeDisplay = `<div style="line-height:1.3;">
                                <div style="color:#ff5252;">Close $${p.rollFrom.strike}<span style="color:#888;font-size:10px;">${rollType}</span></div>
                                <div style="color:#00ff88;">Open $${p.strike}<span style="color:#888;font-size:10px;">${rollType}</span></div>
                            </div>`;
                            expiryDisplay = `<div style="line-height:1.3;">
                                <div style="color:#888;text-decoration:line-through;">${p.rollFrom.expiry}</div>
                                <div>${p.expiry}</div>
                            </div>`;
                            dteDisplay = p.dte ?? '-';
                        } else {
                            // Single leg trades
                            strikeDisplay = `<span style="color:${typeColor};">$${p.strike}<span style="color:#888;font-size:10px;">${optionType}</span></span>`;
                            expiryDisplay = p.expiry;
                            dteDisplay = p.dte ?? '-';
                        }
                        // Calculate credit/debit display for rolls
                        let crDrDisplay = '-';
                        if (p.isRoll && p.netCost) {
                            // Show the net cost from AI (e.g. "-$930.00 debit")
                            crDrDisplay = `<span style="color:#ff9800;font-size:11px;">${p.netCost}</span>`;
                        } else if (p.credit) {
                            crDrDisplay = `<span style="color:${crDrColor};">$${p.credit.toFixed(0)} ${crDrLabel}</span>`;
                        }
                        
                        return `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:8px; color:#00ff88; font-weight:bold;">${p.ticker}${closeBadge}${rollBadge}${skipBadge}${spreadBadge}</td>
                            <td style="padding:8px;">${strikeDisplay}</td>
                            <td style="padding:8px;">${expiryDisplay}</td>
                            <td style="padding:8px;">${dteDisplay}</td>
                            <td style="padding:8px;">${crDrDisplay}</td>
                            <td style="padding:8px; color:${p.annReturn && parseFloat(p.annReturn) >= 25 ? '#00ff88' : '#ffaa00'};">${p.annReturn ? p.annReturn + '%' : '-'}</td>
                            <td style="padding:8px; color:#888;">${new Date(p.stagedAt).toLocaleDateString()}</td>
                            <td style="padding:8px;">
                                <div style="display:flex; flex-wrap:nowrap; gap:4px; justify-content:flex-start;">
                                    <button onclick="window.checkMarginForTrade('${p.ticker}', ${p.strike}, ${p.premium || 0}, ${p.isCall || false}, ${p.isRoll || false}, ${p.isDebit || false}, ${p.credit || 0}, ${p.isSkip || false}, '${p.type || ''}', ${p.upperStrike || 0})" 
                                            title="Check margin/cost"
                                            style="background:#ffaa00; color:#000; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        💳
                                    </button>
                                    <button onclick="window.showTickerChart('${p.ticker}')" 
                                            title="View 3-month chart"
                                            style="background:#00d9ff; color:#000; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        📊
                                    </button>
                                    <button onclick="window.confirmStagedTrade(${p.id})" 
                                            title="Confirm trade executed"
                                            style="background:#00ff88; color:#000; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        ✓ Confirm
                                    </button>
                                    <button onclick="window.removeStagedTrade(${p.id})" 
                                            title="Remove staged trade"
                                            style="background:#ff5252; color:#fff; border:none; padding:4px 6px; border-radius:4px; cursor:pointer; font-size:11px; white-space:nowrap;">
                                        ✕
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        </div>
    `;
};

/**
 * Show TradingView chart with Bollinger Bands for a ticker
 */
window.showTickerChart = function(ticker) {
    // Remove any existing chart modal
    document.getElementById('chartModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'chartModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.95); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Generate unique container ID
    const containerId = 'tradingview_' + Date.now();
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:90%; max-width:1000px; padding:24px; border:1px solid #00d9ff; max-height:90vh; overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h2 style="color:#00d9ff; margin:0;">📊 ${ticker} - 3 Month Chart with Bollinger Bands</h2>
                <button onclick="document.getElementById('chartModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:8px 16px; border-radius:8px; cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="${containerId}" style="height:500px; width:100%;"></div>
            <div style="margin-top:12px; font-size:11px; color:#888;">
                💡 <b>Bollinger Bands:</b> Price near lower band = potentially oversold (good for selling puts). 
                Price near upper band = potentially overbought (caution).
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Load TradingView widget script and create chart
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = function() {
        new TradingView.widget({
            "width": "100%",
            "height": 500,
            "symbol": ticker,
            "interval": "D",
            "timezone": "America/New_York",
            "theme": "dark",
            "style": "1",
            "locale": "en",
            "toolbar_bg": "#1a1a2e",
            "enable_publishing": false,
            "hide_side_toolbar": false,
            "allow_symbol_change": true,
            "range": "3M",
            "studies": ["BB@tv-basicstudies"],
            "container_id": containerId
        });
    };
    document.head.appendChild(script);
};

/**
 * Build trade summary HTML for confirm modal
 * Shows position details and AI rationale in a clear format
 * Uses IDs so it can be updated dynamically when contracts change
 */
function buildTradeSummaryHtml(trade, isSpread, isPut, sellStrike, buyStrike, expiry, tradeTypeDisplay) {
    // Store trade info globally so updateTradeSummary can access it
    window._confirmTradeInfo = {
        trade,
        isSpread,
        isPut,
        sellStrike,
        buyStrike,
        expiry,
        tradeTypeDisplay
    };
    
    // Extract AI rationale (one-sentence summary) - this doesn't change
    let aiRationale = '';
    const thesis = trade.openingThesis;
    
    if (thesis?.aiSummary) {
        const summary = thesis.aiSummary;
        
        // Try different sources for a one-liner
        if (summary.bottomLine) {
            aiRationale = summary.bottomLine;
        } else if (summary.moderate) {
            // Extract first sentence from moderate perspective
            aiRationale = summary.moderate.split(/[.!?]/)[0] + '.';
        } else if (summary.whyThisStrategy) {
            // Wall Street Mode: extract first sentence
            aiRationale = summary.whyThisStrategy.split(/[.!?]/)[0] + '.';
        } else if (summary.fullAnalysis) {
            // Try to extract a meaningful sentence from full analysis
            // Look for "WHY THIS STRATEGY" section or first substantive paragraph
            const whyMatch = summary.fullAnalysis.match(/WHY\s+THIS\s+STRATEGY[:\s]*([^.!?]+[.!?])/i);
            if (whyMatch) {
                aiRationale = whyMatch[1].trim();
            } else {
                // Just grab first meaningful sentence that's not a header
                const sentences = summary.fullAnalysis.split(/[.!?]/).filter(s => 
                    s.trim().length > 30 && !s.includes('===') && !s.includes('---')
                );
                if (sentences[0]) {
                    aiRationale = sentences[0].trim() + '.';
                }
            }
        }
        
        // Truncate if too long
        if (aiRationale.length > 200) {
            aiRationale = aiRationale.substring(0, 197) + '...';
        }
    }
    
    return `
        <div style="background:linear-gradient(135deg, rgba(0,255,136,0.1), rgba(0,217,255,0.05)); 
                    border:1px solid rgba(0,255,136,0.3); border-radius:8px; padding:12px; margin-bottom:16px;">
            <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">
                📋 Trade Summary
            </div>
            <div id="tradeSummaryPosition" style="color:#fff; font-size:13px; line-height:1.5; margin-bottom:${aiRationale ? '10px' : '0'};">
                <!-- Populated by updateTradeSummary() -->
            </div>
            ${aiRationale ? `
            <div style="color:#aaa; font-size:12px; font-style:italic; border-top:1px solid rgba(255,255,255,0.1); 
                        padding-top:8px; margin-top:4px;">
                <span style="color:#00d9ff;">🤖 AI:</span> ${aiRationale}
            </div>
            ` : ''}
        </div>
    `;
}

/**
 * Update the trade summary position description when contracts/strikes change
 */
window.updateTradeSummary = function() {
    const posEl = document.getElementById('tradeSummaryPosition');
    if (!posEl || !window._confirmTradeInfo) return;
    
    const { trade, isSpread, sellStrike, buyStrike, expiry, tradeTypeDisplay } = window._confirmTradeInfo;
    
    // Get current values from form
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const currentSellStrike = parseFloat(document.getElementById('confirmSellStrike')?.value) || 
                              parseFloat(document.getElementById('confirmStrike')?.value) || sellStrike;
    const currentBuyStrike = parseFloat(document.getElementById('confirmBuyStrike')?.value) || buyStrike;
    const expiryVal = document.getElementById('confirmExpiry')?.value || expiry;
    
    // Format expiry date for display
    const expiryDisplay = expiryVal ? new Date(expiryVal + 'T12:00:00').toLocaleDateString('en-US', { 
        month: 'short', day: 'numeric', year: 'numeric' 
    }) : 'TBD';
    
    const ticker = trade.ticker || '???';
    
    // Build position description
    let positionDesc = '';
    
    if (isSpread) {
        const spreadType = tradeTypeDisplay || 'Credit Spread';
        positionDesc = `<strong>Sell ${contracts}x ${ticker} $${currentSellStrike}/$${currentBuyStrike} ${spreadType}</strong> expiring ${expiryDisplay}`;
    } else if (trade.type === 'short_put') {
        positionDesc = `<strong>Sell ${contracts}x ${ticker} $${currentSellStrike} Put</strong> expiring ${expiryDisplay}`;
    } else if (trade.type === 'covered_call') {
        positionDesc = `<strong>Sell ${contracts}x ${ticker} $${currentSellStrike} Call</strong> expiring ${expiryDisplay}`;
    } else if (trade.type === 'long_put' || trade.type === 'long_call') {
        const optType = trade.type === 'long_put' ? 'Put' : 'Call';
        positionDesc = `<strong>Buy ${contracts}x ${ticker} $${currentSellStrike} ${optType}</strong> expiring ${expiryDisplay}`;
    } else if (trade.type === 'iron_condor') {
        positionDesc = `<strong>Iron Condor ${contracts}x ${ticker} $${currentBuyStrike}/$${currentSellStrike}</strong> expiring ${expiryDisplay}`;
    } else if (trade.type === 'skip_call' || trade.type === 'pmcc') {
        const stratName = trade.type === 'skip_call' ? 'SKIP™' : 'PMCC';
        positionDesc = `<strong>${stratName} ${contracts}x ${ticker} $${currentSellStrike}/$${currentBuyStrike}</strong> expiring ${expiryDisplay}`;
    } else {
        positionDesc = `<strong>${contracts}x ${ticker} $${currentSellStrike || ''} ${tradeTypeDisplay}</strong> expiring ${expiryDisplay}`;
    }
    
    // Calculate total credit/debit from actual premium inputs
    let premium = 0;
    const sellPremEl = document.getElementById('confirmSellPremium');
    const buyPremEl = document.getElementById('confirmBuyPremium');
    const singlePremEl = document.getElementById('confirmPremium');
    
    if (sellPremEl && buyPremEl) {
        // Spread: net credit = sell - buy
        premium = (parseFloat(sellPremEl.value) || 0) - (parseFloat(buyPremEl.value) || 0);
    } else if (singlePremEl) {
        premium = parseFloat(singlePremEl.value) || 0;
    }
    
    if (premium) {
        const totalCredit = Math.abs(premium) * 100 * contracts;
        const isDebit = trade.isDebit || premium < 0;
        const creditType = isDebit ? 'Debit' : 'Credit';
        positionDesc += ` — <span style="color:${isDebit ? '#ff5252' : '#00ff88'};">$${totalCredit.toLocaleString()} ${creditType}</span>`;
    }
    
    posEl.innerHTML = positionDesc;
};

/**
 * Confirm a staged trade - moves to real positions
 */
window.confirmStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // For CLOSE trades, show a simpler close confirmation
    if (trade.isClose) {
        window.confirmClosePosition(id);
        return;
    }
    
    // Detect if this is a spread trade
    const isSpread = trade.type?.includes('_spread') || trade.upperStrike;
    const isCredit = trade.type?.includes('credit') || (trade.type === 'put_credit_spread' || trade.type === 'call_credit_spread');
    const isPut = trade.type?.includes('put');
    
    // For put credit spread: strike = sell (higher), upperStrike = buy (lower)
    // For call credit spread: strike = sell (lower), upperStrike = buy (higher)
    const sellStrike = trade.strike || '';
    const buyStrike = trade.upperStrike || '';
    const expiry = parseExpiryToDate(trade.expiry);
    
    // Show modal to enter actual trade details
    const modal = document.createElement('div');
    modal.id = 'confirmTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Format trade type for display
    const tradeTypeDisplay = trade.type?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Short Put';
    
    // Build strike and premium fields based on trade type
    let strikeFieldsHtml = '';
    let premiumFieldsHtml = '';
    
    if (isSpread) {
        // Spread: two strikes (dropdowns) + shift arrows + two premiums + net credit display
        strikeFieldsHtml = `
            <div style="display:grid; grid-template-columns:1fr auto 1fr; gap:8px; align-items:end;">
                <div>
                    <label style="color:#ff5252; font-size:12px;">Sell Strike</label>
                    <select id="confirmSellStrike" 
                           onchange="window.onStrikeChange()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px; cursor:pointer;">
                        <option value="${sellStrike}">$${sellStrike} (loading...)</option>
                    </select>
                </div>
                <div style="display:flex; flex-direction:column; gap:2px; padding-bottom:2px;">
                    <button onclick="window.shiftSpread(1)" 
                            title="Shift spread UP (higher strikes)"
                            style="padding:4px 8px; background:#2a2a3e; border:1px solid #00d9ff; color:#00d9ff; border-radius:4px; cursor:pointer; font-size:14px; transition:all 0.2s;"
                            onmouseover="this.style.background='#00d9ff'; this.style.color='#000';" 
                            onmouseout="this.style.background='#2a2a3e'; this.style.color='#00d9ff';">▲</button>
                    <button onclick="window.shiftSpread(-1)" 
                            title="Shift spread DOWN (lower strikes)"
                            style="padding:4px 8px; background:#2a2a3e; border:1px solid #00d9ff; color:#00d9ff; border-radius:4px; cursor:pointer; font-size:14px; transition:all 0.2s;"
                            onmouseover="this.style.background='#00d9ff'; this.style.color='#000';" 
                            onmouseout="this.style.background='#2a2a3e'; this.style.color='#00d9ff';">▼</button>
                </div>
                <div>
                    <label style="color:#00ff88; font-size:12px;">Buy Strike (protection)</label>
                    <select id="confirmBuyStrike" 
                           onchange="window.onStrikeChange()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #00ff88; color:#fff; border-radius:4px; cursor:pointer;">
                        <option value="${buyStrike}">$${buyStrike} (loading...)</option>
                    </select>
                </div>
            </div>
            <div id="strikeLoadingStatus" style="color:#888; font-size:11px; text-align:center; margin-top:4px;">
                ⏳ Loading available strikes...
            </div>
        `;
        premiumFieldsHtml = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                    <label style="color:#ff5252; font-size:12px;">Sell Premium (received)</label>
                    <input id="confirmSellPremium" type="number" step="0.01" placeholder="e.g., 5.50"
                           oninput="window.updateNetCredit(); window.updateSpreadRisk(); window.updateTradeSummary();"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#00ff88; font-size:12px;">Buy Premium (paid)</label>
                    <input id="confirmBuyPremium" type="number" step="0.01" placeholder="e.g., 3.15"
                           oninput="window.updateNetCredit(); window.updateSpreadRisk(); window.updateTradeSummary();"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #00ff88; color:#fff; border-radius:4px;">
                </div>
            </div>
            <div style="background:#0d0d1a; padding:12px; border-radius:8px; border:1px solid #333;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span style="color:#888;">Net Credit (per share):</span>
                    <span id="netCreditPerShare" style="color:#888; font-size:14px;">${trade.premium ? '$' + trade.premium.toFixed(2) : '$0.00'}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:#00ff88; font-weight:bold;">Total Credit Received:</span>
                    <span id="netCreditDisplay" style="color:#00ff88; font-size:20px; font-weight:bold;">${trade.premium ? '$' + (trade.premium * 100).toFixed(0) : '$0'}</span>
                </div>
                <input type="hidden" id="confirmPremium" value="${trade.premium || 0}">
                ${trade.premium ? `<div style="color:#666; font-size:10px; margin-top:6px; text-align:center;">
                    💡 AI estimated ~$${trade.premium.toFixed(2)}/share net credit. Enter actual fill prices above.
                </div>` : ''}
            </div>
            <div id="spreadRiskDisplay" style="background:linear-gradient(135deg, rgba(255,82,82,0.15), rgba(255,170,0,0.1)); padding:12px; border-radius:8px; border:1px solid rgba(255,82,82,0.3); margin-top:4px;">
                <div style="font-size:11px; color:#888; margin-bottom:8px; text-transform:uppercase; letter-spacing:1px;">⚠️ Risk Analysis</div>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Spread Width:</span>
                        <div id="spreadWidthDisplay" style="color:#ffaa00; font-size:14px; font-weight:bold;">$${Math.abs(sellStrike - buyStrike).toFixed(0)}</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Risk:Reward Ratio - How much you risk to make $1. Lower is better. < 2:1 is good, > 3:1 is risky.">R:R Ratio: ℹ️</span>
                        <div id="spreadRiskRewardRatio" style="color:#00d9ff; font-size:14px; font-weight:bold; cursor:help;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Win Probability - Chance stock stays OTM at expiration. Based on delta of the sold strike. Higher is better.">Win Prob: ℹ️</span>
                        <div id="spreadWinProb" style="color:#00ff88; font-size:14px; font-weight:bold; cursor:help;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Max Loss <span id="maxLossContractCount" style="color:#666;">(1 contract)</span>:</span>
                        <div id="totalMaxLoss" style="color:#ff5252; font-size:18px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Breakeven:</span>
                        <div id="breakevenPrice" style="color:#ffaa00; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Implied Volatility - How 'expensive' premiums are. Higher IV = fatter premiums but more volatile stock. Low (<30%) | Normal (30-50%) | High (>50%)">IV: ℹ️</span>
                        <div id="spreadIvDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                </div>
            </div>
        `;
    } else {
        // Single leg: one strike dropdown + one premium + margin
        strikeFieldsHtml = `
            <div>
                <label style="color:#888; font-size:12px;">Strike Price</label>
                <select id="confirmStrike" 
                       onchange="window.onSingleStrikeChange()"
                       style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px; cursor:pointer;">
                    <option value="${trade.strike}">$${trade.strike} (loading...)</option>
                </select>
                <div id="strikeLoadingStatus" style="color:#888; font-size:11px; text-align:center; margin-top:4px;">
                    ⏳ Loading available strikes...
                </div>
            </div>
        `;
        const isCall = trade.isCall || trade.type?.includes('call');
        premiumFieldsHtml = `
            <div>
                <label style="color:#888; font-size:12px;">Premium (per share)</label>
                <div style="position:relative;">
                    <input id="confirmPremium" type="number" value="${trade.premium?.toFixed(2) || ''}" step="0.01" placeholder="Loading..."
                           oninput="window.updateSingleLegDisplay()"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    <div id="premiumLoadingSpinner" style="position:absolute; right:10px; top:50%; transform:translateY(-50%); color:#00d9ff; font-size:11px;">
                        ⏳
                    </div>
                </div>
            </div>
            <div id="singleLegSummary" style="background:#0d0d1a; padding:12px; border-radius:8px; border:1px solid #333; margin-top:8px;">
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Total Credit:</span>
                        <div id="totalCreditDisplay" style="color:#00ff88; font-size:18px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Ann. Return:</span>
                        <div id="annReturnDisplay" style="color:#ffaa00; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="How far stock can drop before you lose money. Higher = more cushion = safer.">Cushion: ℹ️</span>
                        <div id="cushionDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Probability stock stays above your strike at expiry (based on delta). Higher = more likely to win.">Win Prob: ℹ️</span>
                        <div id="winProbDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px; cursor:help;" title="Implied Volatility - How 'expensive' premiums are. Higher IV = fatter premiums but more volatile stock. Low (<30%) | Normal (30-50%) | High (>50%)">IV: ℹ️</span>
                        <div id="ivDisplay" style="color:#00d9ff; font-size:14px; font-weight:bold;">-</div>
                    </div>
                </div>
            </div>
            <div id="marginRequirementSection" style="background:linear-gradient(135deg, rgba(255,170,0,0.1), rgba(0,217,255,0.05)); padding:12px; border-radius:8px; border:1px solid rgba(255,170,0,0.3); margin-top:8px;">
                <div style="font-size:11px; color:#888; margin-bottom:6px; text-transform:uppercase; letter-spacing:1px;">💳 Margin Requirement</div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                    <div>
                        <span style="color:#888; font-size:11px;">Est. Margin:</span>
                        <div id="marginEstimate" style="color:#ffaa00; font-size:16px; font-weight:bold;">Calculating...</div>
                    </div>
                    <div>
                        <span style="color:#888; font-size:11px;">Buying Power:</span>
                        <div id="buyingPowerDisplay" style="color:#00d9ff; font-size:14px;">Loading...</div>
                    </div>
                </div>
                <div id="marginStatus" style="margin-top:8px; font-size:11px; color:#888;">
                    Checking margin...
                </div>
            </div>
            <input type="hidden" id="confirmSpotPrice" value="0">
            <input type="hidden" id="confirmIsPut" value="${isPut ? '1' : '0'}">
        `;
    }
    
    // Build trade summary section with position details and AI rationale
    const tradeSummaryHtml = buildTradeSummaryHtml(trade, isSpread, isPut, sellStrike, buyStrike, expiry, tradeTypeDisplay);
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:450px; padding:24px; border:1px solid #00ff88;">
            <h2 style="color:#00ff88; margin:0 0 8px 0;">✅ Confirm Trade Executed</h2>
            
            ${tradeSummaryHtml}
            
            <div style="color:#888; font-size:12px; margin-bottom:16px; padding:8px; background:rgba(0,0,0,0.3); border-radius:4px;">
                ${isSpread ? `📊 <span style="color:#8b5cf6;">${tradeTypeDisplay}</span> - enter both legs` : tradeTypeDisplay}
            </div>
            <div style="display:grid; gap:12px;">
                <div>
                    <label style="color:#888; font-size:12px;">Ticker</label>
                    <input id="confirmTicker" type="text" value="${trade.ticker}" readonly
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                ${strikeFieldsHtml}
                ${premiumFieldsHtml}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                    <div>
                        <label style="color:#888; font-size:12px;">Contracts</label>
                        <input id="confirmContracts" type="number" value="${trade.contracts || 1}" min="1"
                               oninput="window.updateNetCredit(); window.updateSpreadRisk(); window.updateMarginDisplay(); window.updateTradeSummary();"
                               style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    </div>
                    <div>
                        <label style="color:#888; font-size:12px;">Expiry Date</label>
                        <input id="confirmExpiry" type="date" value="${expiry}"
                               oninput="window.updateTradeSummary();"
                               onchange="window.onExpiryChange();"
                               style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                    </div>
                </div>
                <input type="hidden" id="confirmTradeType" value="${trade.type || 'short_put'}">
                <input type="hidden" id="confirmIsSpread" value="${isSpread ? '1' : '0'}">
                <div id="priceLoadingStatus" style="color:#888; font-size:11px; text-align:center; display:none;">
                    ⏳ Fetching market prices...
                </div>
            </div>
            
            <!-- Broker Integration -->
            <div id="schwabSendSection" style="margin-top:16px; padding:12px; background:rgba(0,217,255,0.08); border:1px solid rgba(0,217,255,0.3); border-radius:8px;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                    <input type="checkbox" id="sendToSchwabCheckbox" 
                           onchange="window.updateSchwabPreview()" 
                           style="width:18px; height:18px; cursor:pointer;">
                    <span style="color:#00d9ff; font-weight:bold;">📤 Also send order to Schwab</span>
                </label>
                <div id="schwabPreviewInfo" style="display:none; margin-top:10px; font-size:12px; color:#888;">
                    <div id="schwabOrderDetails" style="padding:8px; background:rgba(0,0,0,0.3); border-radius:4px;">Loading...</div>
                </div>
            </div>
            
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button onclick="window.finalizeConfirmedTrade(${id})" 
                        style="flex:1; background:#00ff88; color:#000; border:none; padding:12px; border-radius:8px; cursor:pointer; font-weight:bold;">
                    Add to Positions
                </button>
                <button onclick="this.closest('#confirmTradeModal').remove()" 
                        style="flex:1; background:#333; color:#888; border:none; padding:12px; border-radius:8px; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Initialize trade summary with current values
    window.updateTradeSummary();
    
    // Fetch option prices to pre-populate
    if (isSpread && trade.ticker && expiry) {
        fetchOptionPricesForModal(trade.ticker, sellStrike, buyStrike, expiry, isPut);
    } else if (!isSpread && trade.ticker && trade.strike && expiry) {
        fetchSingleOptionPrice(trade.ticker, trade.strike, expiry, isPut);
    }
};

/**
 * Update net credit display for spreads
 */
window.updateNetCredit = function() {
    // Only run for spreads (check if spread elements exist)
    const sellPremiumEl = document.getElementById('confirmSellPremium');
    const buyPremiumEl = document.getElementById('confirmBuyPremium');
    if (!sellPremiumEl || !buyPremiumEl) {
        // Not a spread - call single leg update instead
        window.updateSingleLegDisplay?.();
        return;
    }
    
    const sellPremium = parseFloat(sellPremiumEl.value) || 0;
    const buyPremium = parseFloat(buyPremiumEl.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const netCreditPerShare = sellPremium - buyPremium;
    const totalCredit = netCreditPerShare * 100 * contracts;
    
    const perShareDisplay = document.getElementById('netCreditPerShare');
    const totalDisplay = document.getElementById('netCreditDisplay');
    const hidden = document.getElementById('confirmPremium');
    
    if (perShareDisplay) {
        perShareDisplay.textContent = `$${netCreditPerShare.toFixed(2)}`;
    }
    if (totalDisplay) {
        totalDisplay.textContent = `$${totalCredit.toLocaleString()}`;
        totalDisplay.style.color = totalCredit >= 0 ? '#00ff88' : '#ff5252';
    }
    if (hidden) {
        hidden.value = netCreditPerShare;  // Store per-share for position
    }
};

/**
 * Update spread risk analysis display (max loss, risk:reward, breakeven)
 */
window.updateSpreadRisk = function() {
    const sellStrike = parseFloat(document.getElementById('confirmSellStrike')?.value) || 0;
    const buyStrike = parseFloat(document.getElementById('confirmBuyStrike')?.value) || 0;
    const sellPremium = parseFloat(document.getElementById('confirmSellPremium')?.value) || 0;
    const buyPremium = parseFloat(document.getElementById('confirmBuyPremium')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    
    const isPutSpread = tradeType.includes('put');
    const spreadWidth = Math.abs(sellStrike - buyStrike);
    const netCredit = sellPremium - buyPremium;
    const maxLossPerShare = spreadWidth - netCredit;  // For credit spreads
    const maxLossPerContract = maxLossPerShare * 100;
    const totalMaxLoss = maxLossPerContract * contracts;
    
    // Breakeven: for put credit spread = sell strike - net credit
    // For call credit spread = sell strike + net credit
    const breakeven = isPutSpread 
        ? (sellStrike - netCredit)
        : (sellStrike + netCredit);
    
    // Risk:Reward ratio (how much you risk to gain $1)
    const riskRewardRatio = netCredit > 0 ? (maxLossPerShare / netCredit).toFixed(2) : '-';
    const rewardRiskRatio = maxLossPerShare > 0 ? (netCredit / maxLossPerShare * 100).toFixed(0) : '-';  // As percentage return
    
    // Update displays
    const widthEl = document.getElementById('spreadWidthDisplay');
    const totalMaxLossEl = document.getElementById('totalMaxLoss');
    const contractCountEl = document.getElementById('maxLossContractCount');
    const ratioEl = document.getElementById('spreadRiskRewardRatio');
    const breakevenEl = document.getElementById('breakevenPrice');
    
    if (widthEl) widthEl.textContent = `$${spreadWidth.toFixed(0)}`;
    
    // Update contract count label
    if (contractCountEl) {
        contractCountEl.textContent = `(${contracts} contract${contracts > 1 ? 's' : ''})`;
    }
    
    if (totalMaxLossEl) {
        totalMaxLossEl.textContent = netCredit > 0 ? `$${totalMaxLoss.toLocaleString()}` : '-';
        // Color code based on severity
        if (totalMaxLoss > 5000) {
            totalMaxLossEl.style.color = '#ff5252';  // Red for large risk
        } else if (totalMaxLoss > 2000) {
            totalMaxLossEl.style.color = '#ffaa00';  // Orange for medium
        } else {
            totalMaxLossEl.style.color = '#00ff88';  // Green for manageable
        }
    }
    
    if (ratioEl) {
        if (riskRewardRatio !== '-') {
            ratioEl.textContent = `${riskRewardRatio}:1`;
            // Color code: < 2:1 is good, 2-3:1 is ok, > 3:1 is concerning
            const ratio = parseFloat(riskRewardRatio);
            let ratingText, ratingEmoji;
            if (ratio < 1.5) {
                ratioEl.style.color = '#00ff88';
                ratingText = 'Excellent';
                ratingEmoji = '🎯';
            } else if (ratio < 2) {
                ratioEl.style.color = '#00ff88';
                ratingText = 'Good';
                ratingEmoji = '✅';
            } else if (ratio < 3) {
                ratioEl.style.color = '#ffaa00';
                ratingText = 'Marginal';
                ratingEmoji = '⚠️';
            } else {
                ratioEl.style.color = '#ff5252';
                ratingText = 'Poor';
                ratingEmoji = '❌';
            }
            ratioEl.title = `${ratingEmoji} ${ratingText} - You risk $${riskRewardRatio} to make $1.\n\nIf you win, you keep $${netCredit.toFixed(2)}/share (${rewardRiskRatio}% return).\nIf you lose, max loss is $${maxLossPerShare.toFixed(2)}/share.\n\n< 1.5:1 = Excellent | < 2:1 = Good | 2-3:1 = Marginal | > 3:1 = Poor`;
        } else {
            ratioEl.textContent = '-';
            ratioEl.title = 'Risk:Reward ratio - Enter premium values to calculate';
        }
    }
    
    if (breakevenEl) {
        breakevenEl.textContent = netCredit > 0 ? `$${breakeven.toFixed(2)}` : '-';
    }
};

/**
 * Called when user changes strike dropdown - refresh prices for new strikes
 */
window.onStrikeChange = async function() {
    window.updateSpreadRisk();
    window.updateTradeSummary();
    
    const ticker = document.getElementById('confirmTicker')?.value;
    const sellStrike = document.getElementById('confirmSellStrike')?.value;
    const buyStrike = document.getElementById('confirmBuyStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    const isPut = tradeType.includes('put');
    
    // Fetch prices for new strikes
    await fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut);
};

/**
 * Shift both spread strikes up or down the chain while maintaining width
 * @param {number} direction - +1 for higher strikes, -1 for lower strikes
 */
window.shiftSpread = async function(direction) {
    const sellSelect = document.getElementById('confirmSellStrike');
    const buySelect = document.getElementById('confirmBuyStrike');
    
    if (!sellSelect || !buySelect) return;
    
    // Get current values
    const currentSellStrike = parseFloat(sellSelect.value);
    const currentBuyStrike = parseFloat(buySelect.value);
    
    // Get all available strikes from the dropdown options (sorted descending = high to low)
    const allStrikes = Array.from(sellSelect.options)
        .map(opt => parseFloat(opt.value))
        .filter(s => !isNaN(s))
        .sort((a, b) => b - a);  // Descending: 160, 155, 150, 145...
    
    if (allStrikes.length < 2) {
        console.warn('[SHIFT] Not enough strikes to shift');
        return;
    }
    
    // Find current indices
    const sellIdx = allStrikes.findIndex(s => Math.abs(s - currentSellStrike) < 0.01);
    const buyIdx = allStrikes.findIndex(s => Math.abs(s - currentBuyStrike) < 0.01);
    
    if (sellIdx === -1 || buyIdx === -1) {
        console.warn('[SHIFT] Current strikes not found in list');
        return;
    }
    
    // Calculate new indices
    // direction +1 = higher strikes = lower indices (since sorted descending)
    // direction -1 = lower strikes = higher indices
    const newSellIdx = sellIdx - direction;
    const newBuyIdx = buyIdx - direction;
    
    // Check bounds
    if (newSellIdx < 0 || newSellIdx >= allStrikes.length ||
        newBuyIdx < 0 || newBuyIdx >= allStrikes.length) {
        console.log('[SHIFT] Already at edge of chain');
        // Flash the buttons to indicate edge
        const buttons = document.querySelectorAll('#confirmModal button[onclick*="shiftSpread"]');
        buttons.forEach(btn => {
            btn.style.background = '#ff5252';
            btn.style.borderColor = '#ff5252';
            setTimeout(() => {
                btn.style.background = '#2a2a3e';
                btn.style.borderColor = '#00d9ff';
            }, 200);
        });
        return;
    }
    
    // Update dropdown values
    const newSellStrike = allStrikes[newSellIdx];
    const newBuyStrike = allStrikes[newBuyIdx];
    
    sellSelect.value = newSellStrike;
    buySelect.value = newBuyStrike;
    
    console.log(`[SHIFT] Moved spread: $${currentSellStrike}/$${currentBuyStrike} → $${newSellStrike}/$${newBuyStrike} (direction: ${direction > 0 ? 'UP' : 'DOWN'})`);
    
    // Trigger price refresh (this also updates risk analysis)
    await window.onStrikeChange();
};

/**
 * Called when user changes single-leg strike dropdown
 */
window.onSingleStrikeChange = async function() {
    const ticker = document.getElementById('confirmTicker')?.value;
    const strike = document.getElementById('confirmStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const isPut = document.getElementById('confirmIsPut')?.value === '1';
    
    if (!ticker || !strike || !expiry) return;
    
    // Fetch new price for this strike
    await fetchSingleOptionPrice(ticker, strike, expiry, isPut);
};

/**
 * Update margin display based on current values (for contract changes)
 */
window.updateMarginDisplay = function() {
    const spotPrice = parseFloat(document.getElementById('confirmSpotPrice')?.value) || 100;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const isPut = document.getElementById('confirmIsPut')?.value === '1';
    
    const marginEl = document.getElementById('marginEstimate');
    const marginStatusEl = document.getElementById('marginStatus');
    
    if (!marginEl) return;
    
    // Calculate margin for one contract
    const otmAmount = isPut ? Math.max(0, strike - spotPrice) : Math.max(0, spotPrice - strike);
    const marginOption1 = 0.25 * spotPrice * 100 - otmAmount * 100;
    const marginOption2 = 0.10 * strike * 100;
    const marginPerContract = Math.max(marginOption1, marginOption2);
    const totalMargin = marginPerContract * contracts;
    
    marginEl.textContent = `$${totalMargin.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
    
    // Update affordability check
    const buyingPower = window.AccountService?.getBuyingPower?.() || 0;
    if (marginStatusEl && buyingPower > 0) {
        if (buyingPower >= totalMargin) {
            const pctUsed = ((totalMargin / buyingPower) * 100).toFixed(1);
            marginStatusEl.innerHTML = `<span style="color:#00ff88;">✅ Affordable</span> - Uses ${pctUsed}% of buying power`;
        } else {
            marginStatusEl.innerHTML = `<span style="color:#ff5252;">⚠️ Insufficient margin</span> - Need $${(totalMargin - buyingPower).toLocaleString()} more`;
        }
    }
};

/**
 * Handle expiry date change - refresh strikes for the new date
 */
window.onExpiryChange = async function() {
    const newExpiry = document.getElementById('confirmExpiry')?.value;
    const isSpread = document.getElementById('confirmIsSpread')?.value === '1';
    const tradeInfo = window._confirmTradeInfo;
    
    if (!newExpiry || !tradeInfo?.trade?.ticker) return;
    
    const ticker = tradeInfo.trade.ticker;
    const isPut = tradeInfo.isPut;
    const currentStrike = parseFloat(document.getElementById('confirmStrike')?.value) || tradeInfo.trade.strike;
    
    console.log(`[UI] Expiry changed to ${newExpiry}, refreshing strikes for ${ticker}...`);
    
    // Show loading state
    const statusEl = document.getElementById('strikeLoadingStatus');
    const spinnerEl = document.getElementById('premiumLoadingSpinner');
    if (statusEl) {
        statusEl.textContent = '⏳ Loading strikes for new date...';
        statusEl.style.color = '#888';
        statusEl.style.display = 'block';
    }
    if (spinnerEl) spinnerEl.textContent = '⏳';
    
    try {
        // Fetch fresh option chain
        const chain = await window.fetchOptionsChain(ticker);
        if (!chain) throw new Error('No chain data');
        
        const options = isPut ? chain.puts : chain.calls;
        const spotPrice = chain.spotPrice || chain.underlyingPrice || 100;
        
        // Update spot price
        const spotInput = document.getElementById('confirmSpotPrice');
        if (spotInput) spotInput.value = spotPrice;
        
        // Repopulate strikes for new expiry
        if (options?.length) {
            window.populateSingleStrikeDropdown(options, newExpiry, currentStrike);
            
            // Update premium for the (possibly new) selected strike
            const selectedStrike = parseFloat(document.getElementById('confirmStrike')?.value) || currentStrike;
            const option = options.find(opt => 
                Math.abs(opt.strike - selectedStrike) < 0.01 && opt.expiration === newExpiry
            );
            
            if (option) {
                const premium = (option.bid + option.ask) / 2;
                const iv = option.impliedVolatility || 0;
                const delta = option.delta ? Math.abs(parseFloat(option.delta)) : 0;
                
                const premiumInput = document.getElementById('confirmPremium');
                if (premiumInput) premiumInput.value = premium.toFixed(2);
                
                // Update IV display
                const ivDisplay = document.getElementById('ivDisplay');
                if (ivDisplay && iv > 0) {
                    const ivPct = (iv * 100).toFixed(0);
                    ivDisplay.style.color = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
                    ivDisplay.textContent = `${ivPct}%`;
                }
                
                // Update Win Prob
                const winProbDisplay = document.getElementById('winProbDisplay');
                if (winProbDisplay && delta > 0) {
                    const winProb = Math.round((1 - delta) * 100);
                    winProbDisplay.textContent = `${winProb}%`;
                    winProbDisplay.style.color = winProb >= 70 ? '#00ff88' : winProb >= 50 ? '#ffaa00' : '#ff5252';
                }
            }
            
            if (spinnerEl) spinnerEl.textContent = '✓';
        } else {
            if (statusEl) {
                statusEl.textContent = '⚠️ No strikes for this expiry';
                statusEl.style.color = '#ffaa00';
            }
        }
        
        // Recalculate displays
        window.updateSingleLegDisplay?.();
        window.updateMarginDisplay?.();
        
    } catch (err) {
        console.warn('[UI] Error refreshing strikes:', err.message);
        if (statusEl) {
            statusEl.textContent = '⚠️ Could not load strikes';
            statusEl.style.color = '#ffaa00';
        }
        if (spinnerEl) spinnerEl.textContent = '⚠️';
    }
};

/**
 * Populate single-leg strike dropdown from chain data
 */
window.populateSingleStrikeDropdown = function(options, expiry, currentStrike) {
    const strikeSelect = document.getElementById('confirmStrike');
    const statusEl = document.getElementById('strikeLoadingStatus');
    
    if (!strikeSelect) return;
    
    // Filter to target expiry and get unique strikes
    const optsAtExpiry = options.filter(o => o.expiration === expiry);
    const strikes = [...new Set(optsAtExpiry.map(o => o.strike))].sort((a, b) => b - a);  // Descending
    
    if (strikes.length === 0) {
        if (statusEl) {
            statusEl.textContent = '⚠️ No strikes found for this expiry';
            statusEl.style.color = '#ffaa00';
        }
        return;
    }
    
    // Build options HTML with bid and delta
    const optionsHtml = strikes.map(s => {
        const opt = optsAtExpiry.find(o => o.strike === s);
        let info = '';
        if (opt) {
            const bid = opt.bid?.toFixed(2) || '?';
            const delta = opt.delta ? Math.abs(opt.delta).toFixed(2) : null;
            info = delta ? ` ($${bid} | Δ${delta})` : ` (bid $${bid})`;
        }
        const selected = Math.abs(s - parseFloat(currentStrike)) < 0.01 ? 'selected' : '';
        return `<option value="${s}" ${selected}>$${s}${info}</option>`;
    }).join('');
    
    strikeSelect.innerHTML = optionsHtml;
    
    if (statusEl) {
        statusEl.textContent = `✅ ${strikes.length} strikes available`;
        statusEl.style.color = '#00ff88';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    }
};

/**
 * Update single leg display (total credit, annualized return)
 */
window.updateSingleLegDisplay = function() {
    const premium = parseFloat(document.getElementById('confirmPremium')?.value) || 0;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const spotPrice = parseFloat(document.getElementById('confirmSpotPrice')?.value) || 0;
    
    const totalCredit = premium * 100 * contracts;
    
    // Calculate DTE
    const today = new Date();
    const expDate = expiry ? new Date(expiry) : null;
    const dte = expDate ? Math.max(1, Math.ceil((expDate - today) / (1000 * 60 * 60 * 24))) : 30;
    
    // Annualized return = (premium / strike) * (365 / DTE) * 100
    const annReturn = strike > 0 ? ((premium / strike) * (365 / dte) * 100).toFixed(1) : 0;
    
    // Cushion = (Spot - Breakeven) / Spot * 100 where Breakeven = Strike - Premium
    const breakeven = strike - premium;
    const cushion = spotPrice > 0 ? ((spotPrice - breakeven) / spotPrice * 100).toFixed(1) : 0;
    
    const totalDisplay = document.getElementById('totalCreditDisplay');
    const annDisplay = document.getElementById('annReturnDisplay');
    const cushionDisplay = document.getElementById('cushionDisplay');
    const winProbDisplay = document.getElementById('winProbDisplay');
    
    if (totalDisplay) {
        totalDisplay.textContent = `$${totalCredit.toLocaleString()}`;
    }
    if (annDisplay) {
        annDisplay.textContent = `${annReturn}%`;
        annDisplay.style.color = parseFloat(annReturn) >= 25 ? '#00ff88' : '#ffaa00';
    }
    if (cushionDisplay && spotPrice > 0) {
        cushionDisplay.textContent = `${cushion}%`;
        // Color code: >15% cushion = green, 10-15% = orange, <10% = red
        cushionDisplay.style.color = parseFloat(cushion) >= 15 ? '#00ff88' : parseFloat(cushion) >= 10 ? '#ffaa00' : '#ff5252';
        cushionDisplay.title = `Breakeven: $${breakeven.toFixed(2)} (stock can drop ${cushion}% before you lose)`;
    }
};

/**
 * Populate strike dropdowns with real chain data
 */
window.populateStrikeDropdowns = function(options, expiry, currentSellStrike, currentBuyStrike) {
    const sellSelect = document.getElementById('confirmSellStrike');
    const buySelect = document.getElementById('confirmBuyStrike');
    const statusEl = document.getElementById('strikeLoadingStatus');
    
    if (!sellSelect || !buySelect) return;
    
    // Filter to target expiry and get unique strikes
    const optsAtExpiry = options.filter(o => o.expiration === expiry);
    const strikes = [...new Set(optsAtExpiry.map(o => o.strike))].sort((a, b) => b - a);  // Descending (higher strikes first)
    
    if (strikes.length === 0) {
        if (statusEl) {
            statusEl.textContent = '⚠️ No strikes found for this expiry';
            statusEl.style.color = '#ffaa00';
        }
        return;
    }
    
    // Build options HTML
    const buildOptions = (selectedValue) => {
        return strikes.map(s => {
            const opt = optsAtExpiry.find(o => o.strike === s);
            const bidAsk = opt ? ` (bid $${opt.bid?.toFixed(2) || '?'})` : '';
            const selected = Math.abs(s - parseFloat(selectedValue)) < 0.01 ? 'selected' : '';
            return `<option value="${s}" ${selected}>$${s}${bidAsk}</option>`;
        }).join('');
    };
    
    sellSelect.innerHTML = buildOptions(currentSellStrike);
    buySelect.innerHTML = buildOptions(currentBuyStrike);
    
    if (statusEl) {
        statusEl.textContent = `✅ ${strikes.length} strikes available`;
        statusEl.style.color = '#00ff88';
        setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
    }
    
    console.log(`[CONFIRM] Populated dropdowns with ${strikes.length} strikes`);
};

/**
 * Refresh option prices when user changes strikes (legacy - kept for compatibility)
 */
window.refreshSpreadPrices = async function() {
    const ticker = document.getElementById('confirmTicker')?.value;
    const sellStrike = document.getElementById('confirmSellStrike')?.value;
    const buyStrike = document.getElementById('confirmBuyStrike')?.value;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'put_credit_spread';
    const isPut = tradeType.includes('put');
    
    try {
        await fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut);
        window.updateSpreadRisk();
    } catch (err) {
        console.warn('Error refreshing prices:', err);
    }
};

/**
 * Fetch option prices for spread and populate modal fields
 */
async function fetchOptionPricesForModal(ticker, sellStrike, buyStrike, expiry, isPut) {
    const statusEl = document.getElementById('priceLoadingStatus');
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = '⏳ Fetching market prices...';
    }
    
    try {
        const chain = await window.fetchOptionsChain(ticker);
        if (!chain) throw new Error('No chain data');
        
        const options = isPut ? chain.puts : chain.calls;
        if (!options?.length) throw new Error('No options data');
        
        console.log(`[CONFIRM] Looking for ${ticker} ${isPut ? 'PUT' : 'CALL'} strikes $${sellStrike}/$${buyStrike} exp ${expiry}`);
        
        // Populate strike dropdowns with all available strikes at this expiry
        window.populateStrikeDropdowns(options, expiry, sellStrike, buyStrike);
        
        // Show what strikes exist at target expiry
        const targetExpOptions = options.filter(o => o.expiration === expiry);
        
        // Find matching options - try exact match first
        let sellOption = options.find(opt => 
            Math.abs(opt.strike - parseFloat(sellStrike)) < 0.01 && opt.expiration === expiry
        );
        let buyOption = options.find(opt => 
            Math.abs(opt.strike - parseFloat(buyStrike)) < 0.01 && opt.expiration === expiry
        );
        
        // Track if strike doesn't exist at target expiry
        let sellExpiryMismatch = false;
        let buyExpiryMismatch = false;
        
        if (!sellOption && targetExpOptions.length > 0) {
            console.log(`[CONFIRM] ⚠️ Sell strike $${sellStrike} not found at ${expiry}`);
            sellExpiryMismatch = true;
        }
        if (!buyOption && targetExpOptions.length > 0) {
            console.log(`[CONFIRM] ⚠️ Buy strike $${buyStrike} not found at ${expiry}`);
            buyExpiryMismatch = true;
        }
        
        console.log(`[CONFIRM] Sell option:`, sellOption ? `$${sellOption.strike} bid=${sellOption.bid} ask=${sellOption.ask}` : 'NOT FOUND');
        console.log(`[CONFIRM] Buy option:`, buyOption ? `$${buyOption.strike} bid=${buyOption.bid} ask=${buyOption.ask}` : 'NOT FOUND');
        
        // Populate fields (use mid price: (bid+ask)/2)
        if (sellOption) {
            const sellMid = (sellOption.bid + sellOption.ask) / 2;
            document.getElementById('confirmSellPremium').value = sellMid.toFixed(2);
        }
        if (buyOption) {
            const buyMid = (buyOption.bid + buyOption.ask) / 2;
            document.getElementById('confirmBuyPremium').value = buyMid.toFixed(2);
        }
        
        // Update net credit display
        window.updateNetCredit();
        
        // Small delay to ensure DOM is updated before risk calculation
        await new Promise(r => setTimeout(r, 50));
        
        // Update risk analysis display
        window.updateSpreadRisk();
        
        // Update IV display for spreads
        const spreadIvDisplay = document.getElementById('spreadIvDisplay');
        if (spreadIvDisplay && sellOption) {
            const iv = sellOption.impliedVolatility || 0;
            if (iv > 0) {
                const ivPct = (iv * 100).toFixed(0);
                const ivColor = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
                spreadIvDisplay.style.color = ivColor;
                spreadIvDisplay.textContent = `${ivPct}%`;
            }
        }
        
        // Update Win Probability for spreads (based on sell strike delta)
        const spreadWinProbEl = document.getElementById('spreadWinProb');
        if (spreadWinProbEl && sellOption) {
            const delta = sellOption.delta || 0;
            if (delta !== 0) {
                // Win prob = 100% - |delta| (for short options, prob of staying OTM)
                const winProb = (100 - Math.abs(delta) * 100).toFixed(0);
                spreadWinProbEl.textContent = `${winProb}%`;
                
                // Color code: green >=70%, orange 50-70%, red <50%
                if (winProb >= 70) {
                    spreadWinProbEl.style.color = '#00ff88';
                } else if (winProb >= 50) {
                    spreadWinProbEl.style.color = '#ffaa00';
                } else {
                    spreadWinProbEl.style.color = '#ff5252';
                }
                
                spreadWinProbEl.title = `Delta: ${delta.toFixed(2)}\nProbability stock stays OTM at expiration: ${winProb}%\n\nHigher = safer but lower premium\nLower = riskier but higher premium`;
            } else {
                spreadWinProbEl.textContent = '-';
            }
        }
        
        // Show appropriate status
        if (sellExpiryMismatch || buyExpiryMismatch) {
            const missingStrikes = [];
            if (sellExpiryMismatch) missingStrikes.push(`$${sellStrike}`);
            if (buyExpiryMismatch) missingStrikes.push(`$${buyStrike}`);
            if (statusEl) {
                statusEl.textContent = `⚠️ Strike${missingStrikes.length > 1 ? 's' : ''} ${missingStrikes.join(' & ')} not available at ${expiry}`;
                statusEl.style.color = '#ffaa00';
            }
        } else if (sellOption && buyOption) {
            if (statusEl) {
                statusEl.textContent = '✅ Prices loaded from market data';
                statusEl.style.color = '#00ff88';
                setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
            }
        } else {
            if (statusEl) {
                statusEl.textContent = '⚠️ Some prices unavailable';
                statusEl.style.color = '#ffaa00';
            }
        }
    } catch (err) {
        console.warn('Could not fetch option prices:', err.message);
        if (statusEl) {
            statusEl.textContent = '⚠️ Enter prices manually (market data unavailable)';
            statusEl.style.color = '#ffaa00';
        }
    }
}

/**
 * Fetch single option price, margin requirement, and populate modal fields
 */
async function fetchSingleOptionPrice(ticker, strike, expiry, isPut) {
    const spinnerEl = document.getElementById('premiumLoadingSpinner');
    const marginEl = document.getElementById('marginEstimate');
    const bpEl = document.getElementById('buyingPowerDisplay');
    const marginStatusEl = document.getElementById('marginStatus');
    const strikeLoadingEl = document.getElementById('strikeLoadingStatus');
    
    try {
        // Fetch option chain for premium
        const chain = await window.fetchOptionsChain(ticker);
        if (!chain) throw new Error('No chain data');
        
        const options = isPut ? chain.puts : chain.calls;
        const spotPrice = chain.spotPrice || chain.underlyingPrice || 100;
        
        // Store spot price for margin recalculations
        const spotInput = document.getElementById('confirmSpotPrice');
        if (spotInput) spotInput.value = spotPrice;
        
        // Populate strike dropdown with available strikes (like spreads do)
        if (window.populateSingleStrikeDropdown && options?.length) {
            window.populateSingleStrikeDropdown(options, expiry, strike);
        }
        
        // Find matching option for selected strike
        let premium = 0;
        let iv = 0;
        let delta = 0;
        const selectedStrike = parseFloat(document.getElementById('confirmStrike')?.value) || parseFloat(strike);
        if (options?.length) {
            const option = options.find(opt => 
                Math.abs(opt.strike - selectedStrike) < 0.01 && opt.expiration === expiry
            );
            if (option) {
                premium = (option.bid + option.ask) / 2;
                iv = option.impliedVolatility || 0;
                delta = option.delta ? Math.abs(parseFloat(option.delta)) : 0;
                const premiumInput = document.getElementById('confirmPremium');
                if (premiumInput) premiumInput.value = premium.toFixed(2);
            }
        }
        
        // Update IV display
        const ivDisplay = document.getElementById('ivDisplay');
        if (ivDisplay) {
            if (iv > 0) {
                const ivPct = (iv * 100).toFixed(0);
                // Color code: <30% blue (low), 30-50% white (normal), >50% orange (high)
                const ivColor = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
                ivDisplay.style.color = ivColor;
                ivDisplay.textContent = `${ivPct}%`;
            } else {
                ivDisplay.textContent = '-';
            }
        }
        
        // Update Win Probability display (for short options, win prob = 1 - |delta|)
        const winProbDisplay = document.getElementById('winProbDisplay');
        if (winProbDisplay) {
            if (delta > 0) {
                const winProb = Math.round((1 - delta) * 100);
                winProbDisplay.textContent = `${winProb}%`;
                // Color code: >70% green, 50-70% orange, <50% red
                winProbDisplay.style.color = winProb >= 70 ? '#00ff88' : winProb >= 50 ? '#ffaa00' : '#ff5252';
                winProbDisplay.title = `Based on delta (${(delta * 100).toFixed(0)}Δ). Higher delta = higher assignment risk, lower win prob.`;
            } else {
                winProbDisplay.textContent = '-';
            }
        }
        
        // Update display
        if (spinnerEl) spinnerEl.textContent = '✓';
        window.updateSingleLegDisplay();
        
        // Calculate margin requirement for short put/call
        // Standard formula: Max(25% × Underlying - OTM Amount, 10% × Strike) + Premium
        const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
        const otmAmount = isPut ? Math.max(0, selectedStrike - spotPrice) : Math.max(0, spotPrice - selectedStrike);
        const marginOption1 = 0.25 * spotPrice * 100 - otmAmount * 100;
        const marginOption2 = 0.10 * selectedStrike * 100;
        const marginPerContract = Math.max(marginOption1, marginOption2);
        const marginReq = marginPerContract * contracts;
        
        if (marginEl) {
            marginEl.textContent = `$${marginReq.toLocaleString(undefined, {maximumFractionDigits: 0})}`;
        }
        
        // Fetch buying power from AccountService
        const buyingPower = window.AccountService?.getBuyingPower?.() || 0;
        if (bpEl) {
            bpEl.textContent = buyingPower > 0 ? `$${buyingPower.toLocaleString(undefined, {maximumFractionDigits: 0})}` : 'N/A';
        }
        
        // Check if trade is affordable
        if (marginStatusEl) {
            if (buyingPower > 0) {
                if (buyingPower >= marginReq) {
                    const pctUsed = ((marginReq / buyingPower) * 100).toFixed(1);
                    marginStatusEl.innerHTML = `<span style="color:#00ff88;">✅ Affordable</span> - Uses ${pctUsed}% of buying power`;
                } else {
                    marginStatusEl.innerHTML = `<span style="color:#ff5252;">⚠️ Insufficient margin</span> - Need $${(marginReq - buyingPower).toLocaleString()} more`;
                }
            } else {
                marginStatusEl.textContent = '💡 Sync portfolio to check margin';
            }
        }
        
    } catch (err) {
        console.warn('Could not fetch option price:', err.message);
        if (spinnerEl) spinnerEl.textContent = '⚠️';
        if (marginStatusEl) marginStatusEl.textContent = '⚠️ Enter price manually';
        if (strikeLoadingEl) {
            strikeLoadingEl.textContent = '⚠️ Enter strike manually';
            strikeLoadingEl.style.color = '#ffaa00';
        }
    }
}

/**
 * Parse "Feb 20" or "Mar 21" to YYYY-MM-DD
 */
function parseExpiryToDate(expiry) {
    if (!expiry) return '';
    
    // If already ISO format (2026-02-27), return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        return expiry;
    }
    
    // Parse "Feb 27" or "Feb 27, 2026" format
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const match = expiry.match(/(\w+)\s+(\d+)(?:,?\s*(\d{4}))?/);
    if (!match) return '';
    const month = monthMap[match[1]] || '01';
    const day = match[2].padStart(2, '0');
    const year = match[3] || '2026';
    return `${year}-${month}-${day}`;
}

/**
 * Confirm closing an existing position (from CLOSE staged trade)
 */
window.confirmClosePosition = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Find the original position we're closing
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const originalPos = positions.find(p => p.id === trade.rollFrom?.positionId);
    
    const isSpread = trade.type?.includes('_spread');
    const isPut = trade.type?.includes('put') || trade.isCall === false;
    const optionType = isPut ? 'PUT' : 'CALL';
    
    // Display details
    let positionDetails = '';
    if (isSpread) {
        const sellStrike = trade.strike || trade.sellStrike;
        const buyStrike = trade.buyStrike || trade.upperStrike;
        positionDetails = `$${sellStrike}/$${buyStrike} ${optionType} Spread`;
    } else {
        positionDetails = `$${trade.strike} ${optionType}`;
    }
    
    // Original premium received
    const origPremium = originalPos?.premium || 0;
    const contracts = trade.contracts || 1;
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'confirmCloseModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:400px; padding:24px; border:1px solid #ff5252;">
            <h2 style="color:#ff5252; margin:0 0 16px 0;">🔴 Close Position</h2>
            
            <div style="background:rgba(255,82,82,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <div style="font-size:24px; font-weight:bold; color:#00ff88;">${trade.ticker}</div>
                <div style="color:#888; font-size:14px;">${positionDetails}</div>
                <div style="color:#666; font-size:12px;">Exp: ${trade.expiry}</div>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="color:#888; font-size:12px;">Original Premium Received (per share)</label>
                <div style="color:#00ff88; font-size:18px; padding:8px; background:#0d0d1a; border-radius:4px;">
                    $${origPremium.toFixed(2)} Cr
                </div>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="color:#ff5252; font-size:12px;">Close Price (per share) - what you paid to buy back</label>
                <input id="closePrice" type="number" step="0.01" value="${trade.premium?.toFixed(2) || ''}" placeholder="e.g., 4.95"
                       oninput="window.updateClosePnL(${origPremium}, ${contracts})"
                       style="width:100%; padding:12px; background:#0d0d1a; border:1px solid #ff5252; color:#fff; border-radius:4px; font-size:16px;">
                ${trade.premium ? `<div style="color:#00d9ff; font-size:10px; margin-top:4px;">📊 Current market: $${trade.premium.toFixed(2)}/share (CBOE). Adjust if your fill differs.</div>` : ''}
            </div>
            
            <div style="background:rgba(0,0,0,0.3); padding:12px; border-radius:8px; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Net P&L (per share):</span>
                    <span id="closePnLPerShare" style="color:#888;">-</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#888; font-weight:bold;">Total P&L (${contracts} contracts):</span>
                    <span id="closePnLTotal" style="font-size:20px; font-weight:bold; color:#888;">-</span>
                </div>
            </div>
            
            <div style="display:flex; gap:12px;">
                <button onclick="window.executeClosePosition(${id})" 
                        style="flex:1; padding:12px; background:linear-gradient(135deg, #ff5252, #ff1744); border:none; border-radius:8px; color:#fff; font-weight:bold; cursor:pointer;">
                    Close Position
                </button>
                <button onclick="document.getElementById('confirmCloseModal').remove()" 
                        style="flex:1; padding:12px; background:#333; border:none; border-radius:8px; color:#888; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Trigger initial P&L calculation
    setTimeout(() => window.updateClosePnL(origPremium, contracts), 100);
};

/**
 * Update the close P&L display
 */
window.updateClosePnL = function(origPremium, contracts) {
    const closePrice = parseFloat(document.getElementById('closePrice')?.value) || 0;
    const pnlPerShare = origPremium - closePrice;  // Received - paid = profit
    const totalPnL = pnlPerShare * 100 * contracts;
    
    const perShareEl = document.getElementById('closePnLPerShare');
    const totalEl = document.getElementById('closePnLTotal');
    
    if (perShareEl) {
        perShareEl.textContent = `$${pnlPerShare.toFixed(2)}`;
        perShareEl.style.color = pnlPerShare >= 0 ? '#00ff88' : '#ff5252';
    }
    if (totalEl) {
        totalEl.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}`;
        totalEl.style.color = totalPnL >= 0 ? '#00ff88' : '#ff5252';
    }
};

/**
 * Execute closing the position
 */
window.executeClosePosition = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    const closePrice = parseFloat(document.getElementById('closePrice')?.value);
    if (!closePrice && closePrice !== 0) {
        showNotification('Enter close price', 'error');
        return;
    }
    
    // Find and close the original position
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const posIndex = positions.findIndex(p => p.id === trade.rollFrom?.positionId);
    
    if (posIndex === -1) {
        showNotification('Original position not found', 'error');
        return;
    }
    
    const pos = positions[posIndex];
    const origPremium = pos.premium || 0;
    const contracts = pos.contracts || 1;
    const pnlPerShare = origPremium - closePrice;
    const realizedPnL = pnlPerShare * 100 * contracts;
    
    // Move to closed positions
    const closedPos = {
        ...pos,
        status: 'closed',
        closeDate: new Date().toISOString().split('T')[0],
        closePrice: closePrice,
        closeReason: 'closed',
        realizedPnL: realizedPnL,
        daysHeld: Math.ceil((new Date() - new Date(pos.openDate || pos.stagedAt)) / (1000 * 60 * 60 * 24))
    };
    
    // Add to closed positions
    let closed = JSON.parse(localStorage.getItem('wheelhouse_closed') || '[]');
    closed.unshift(closedPos);
    localStorage.setItem('wheelhouse_closed', JSON.stringify(closed));
    
    // Remove from open positions
    positions.splice(posIndex, 1);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
    
    // Remove from pending trades
    const updatedPending = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updatedPending));
    
    // Update state
    if (window.state) {
        window.state.positions = positions;
        window.state.closedPositions = closed;
    }
    
    // Close modal
    document.getElementById('confirmCloseModal')?.remove();
    
    // Refresh UI
    if (typeof window.renderPositions === 'function') window.renderPositions();
    if (typeof window.renderPendingTrades === 'function') window.renderPendingTrades();
    
    const pnlSign = realizedPnL >= 0 ? '+' : '';
    showNotification(`✅ Closed ${trade.ticker} for ${pnlSign}$${realizedPnL.toFixed(0)}`, realizedPnL >= 0 ? 'success' : 'error');
};

/**
 * Finalize the confirmed trade - add to positions
 */
window.finalizeConfirmedTrade = async function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Check if user wants to send to Schwab
    const sendToSchwab = document.getElementById('sendToSchwabCheckbox')?.checked || false;
    
    // Get values from modal
    const ticker = document.getElementById('confirmTicker').value;
    const premium = parseFloat(document.getElementById('confirmPremium').value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts').value) || 1;
    const expiry = document.getElementById('confirmExpiry').value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'short_put';
    const isSpread = document.getElementById('confirmIsSpread')?.value === '1';
    
    // If sending to Schwab, do that first (so we can abort if it fails)
    if (sendToSchwab && !isSpread) {
        const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
        const isPut = tradeType.includes('put');
        const instruction = tradeType.startsWith('long_') ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
        
        // Use live pricing if we have it from the preview
        const livePricing = window._schwabLivePricing;
        const orderPrice = livePricing?.hasLivePricing ? livePricing.suggestedPrice : premium;
        
        try {
            // Show loading state
            const btn = document.querySelector('#confirmTradeModal button[onclick*="finalizeConfirmedTrade"]');
            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Sending to Schwab...';
                btn.style.background = '#888';
            }
            
            const res = await fetch('/api/schwab/place-option-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ticker,
                    strike,
                    expiry,
                    type: isPut ? 'P' : 'C',
                    instruction,
                    quantity: contracts,
                    limitPrice: orderPrice,
                    confirm: true
                })
            });
            
            const result = await res.json();
            
            if (!res.ok || !result.success) {
                throw new Error(result.error || 'Order failed');
            }
            
            showNotification(`📤 Order sent to Schwab: ${ticker} $${strike} @ $${orderPrice.toFixed(2)}`, 'success');
            
            // Clear live pricing
            window._schwabLivePricing = null;
            
        } catch (e) {
            console.error('Schwab order error:', e);
            showNotification(`❌ Schwab order failed: ${e.message}`, 'error');
            
            // Re-enable button
            const btn = document.querySelector('#confirmTradeModal button[onclick*="finalizeConfirmedTrade"]');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add to Positions';
                btn.style.background = '#00ff88';
            }
            
            // Ask if they want to continue without Schwab
            if (!confirm('Schwab order failed. Add to positions anyway (for tracking)?')) {
                return;
            }
        }
    }
    
    // Create position object
    let position = {
        id: Date.now(),
        chainId: Date.now(),
        ticker,
        type: tradeType,
        premium,
        contracts,
        expiry,
        openDate: new Date().toISOString().split('T')[0],
        status: 'open',
        broker: 'Manual',
        openingThesis: trade.openingThesis || null,
        // PMCC: Link to parent LEAPS position for nesting in UI
        parentPositionId: trade.parentPositionId || null
    };
    
    // Handle spread vs single-leg positions
    if (isSpread) {
        const sellStrike = parseFloat(document.getElementById('confirmSellStrike').value);
        const buyStrike = parseFloat(document.getElementById('confirmBuyStrike').value);
        const sellPremium = parseFloat(document.getElementById('confirmSellPremium')?.value) || 0;
        const buyPremium = parseFloat(document.getElementById('confirmBuyPremium')?.value) || 0;
        
        // For spreads, use sellStrike/buyStrike format matching positions.js
        position.sellStrike = sellStrike;
        position.buyStrike = buyStrike;
        position.spreadWidth = Math.abs(sellStrike - buyStrike);
        
        // Store individual leg premiums for record-keeping
        position.sellPremium = sellPremium;
        position.buyPremium = buyPremium;
        
        // Calculate max profit/loss for the spread
        const spreadWidth = position.spreadWidth;
        position.maxProfit = premium * 100 * contracts;
        position.maxLoss = (spreadWidth - premium) * 100 * contracts;
        
        // Calculate breakeven based on spread type
        if (tradeType === 'put_credit_spread') {
            position.breakeven = sellStrike - premium;
        } else if (tradeType === 'call_credit_spread') {
            position.breakeven = sellStrike + premium;
        }
        
        console.log(`[CONFIRM] Created ${tradeType}: Sell $${sellStrike}@${sellPremium} / Buy $${buyStrike}@${buyPremium}, net: $${premium}`);
    } else {
        // Single leg - just one strike
        const strike = parseFloat(document.getElementById('confirmStrike').value);
        position.strike = strike;
    }
    
    // Add to positions using the correct storage key based on account mode
    const { getPositionsKey } = window.state ? { getPositionsKey: () => window.state.accountMode === 'paper' ? 'wheelhouse_paper_positions' : 'wheelhouse_positions' } : { getPositionsKey: () => 'wheelhouse_positions' };
    const storageKey = getPositionsKey();
    
    const positions = JSON.parse(localStorage.getItem(storageKey) || '[]');
    positions.push(position);
    localStorage.setItem(storageKey, JSON.stringify(positions));
    
    // Remove from pending
    const updatedPending = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updatedPending));
    
    // Close modal
    document.getElementById('confirmTradeModal')?.remove();
    
    // Refresh displays
    renderPendingTrades();
    
    // Reload positions from localStorage to show the new one
    if (window.loadPositions) {
        window.loadPositions();
    }
    
    // Format success message based on trade type
    const strikeDisplay = isSpread 
        ? `$${position.sellStrike}/$${position.buyStrike} spread` 
        : `$${position.strike} ${tradeType.includes('put') ? 'put' : 'call'}`;
    
    showNotification(`✅ Added ${ticker} ${strikeDisplay} to positions!`, 'success');
};

/**
 * Update Schwab preview when checkbox is toggled
 */
window.updateSchwabPreview = async function() {
    const checkbox = document.getElementById('sendToSchwabCheckbox');
    const previewDiv = document.getElementById('schwabPreviewInfo');
    const detailsDiv = document.getElementById('schwabOrderDetails');
    const isSpread = document.getElementById('confirmIsSpread')?.value === '1';
    
    if (!checkbox?.checked) {
        if (previewDiv) previewDiv.style.display = 'none';
        return;
    }
    
    // Show preview section
    if (previewDiv) previewDiv.style.display = 'block';
    if (detailsDiv) detailsDiv.innerHTML = '⏳ Checking order requirements...';
    
    // Spreads not supported yet
    if (isSpread) {
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="color:#ffaa00;">⚠️ Spread orders not yet supported for broker integration</div>
                <div style="color:#888; font-size:11px; margin-top:4px;">This trade will be added to positions only (for tracking)</div>
            `;
        }
        return;
    }
    
    // Get trade details
    const ticker = document.getElementById('confirmTicker')?.value;
    const strike = parseFloat(document.getElementById('confirmStrike')?.value) || 0;
    const premium = parseFloat(document.getElementById('confirmPremium')?.value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts')?.value) || 1;
    const expiry = document.getElementById('confirmExpiry')?.value;
    const tradeType = document.getElementById('confirmTradeType')?.value || 'short_put';
    const isPut = tradeType.includes('put');
    const instruction = tradeType.startsWith('long_') ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
    const isSell = instruction === 'SELL_TO_OPEN';
    
    // Check if this short call is covered by a LEAPS or stock position
    let isCovered = false;
    let coverReason = '';
    if (!isPut && isSell) {
        // For short calls, check if user owns:
        // 1. A LEAPS call on this ticker (for PMCC)
        // 2. 100+ shares of stock (for covered call)
        const positions = window.state?.positions || JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
        const holdings = window.state?.holdings || JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
        
        console.log(`[SCHWAB] Checking coverage for ${ticker} $${strike} short call...`);
        console.log(`[SCHWAB] Found ${positions.length} positions, ${holdings.length} holdings`);
        
        // Check for LEAPS or long call that covers this short call
        const coveringPosition = positions.find(p => {
            if (p.ticker?.toUpperCase() !== ticker.toUpperCase()) return false;
            
            // For PMCC/SKIP positions, check leapsStrike
            if ((p.type === 'pmcc' || p.type === 'skip_call') && p.leapsStrike) {
                const covers = p.leapsStrike <= strike;
                if (covers) console.log(`[SCHWAB] Found covering PMCC/SKIP: LEAPS $${p.leapsStrike} covers $${strike}`);
                return covers;
            }
            
            // For long_call positions, check strike
            if (p.type === 'long_call') {
                const covers = p.strike <= strike;
                if (covers) console.log(`[SCHWAB] Found covering long call: $${p.strike} covers $${strike}`);
                return covers;
            }
            
            // Covered call means they have shares
            if (p.type === 'covered_call') {
                console.log(`[SCHWAB] Found covered_call position - implies shares owned`);
                return true;
            }
            
            return false;
        });
        
        // Check for 100+ shares in holdings
        const coveringHolding = holdings.find(h => 
            h.ticker?.toUpperCase() === ticker.toUpperCase() &&
            (h.shares || 0) >= 100
        );
        
        if (coveringHolding) {
            console.log(`[SCHWAB] Found ${coveringHolding.shares} shares of ${ticker}`);
        }
        
        isCovered = !!(coveringPosition || coveringHolding);
        coverReason = coveringPosition ? 
            (coveringPosition.type === 'long_call' ? 'LEAPS call' : coveringPosition.type.toUpperCase()) : 
            (coveringHolding ? `${coveringHolding.shares} shares` : '');
            
        if (isCovered) {
            console.log(`[SCHWAB] ✅ Short call is COVERED by ${coverReason}`);
        } else {
            console.log(`[SCHWAB] ⚠️ No covering position found - treating as naked`);
        }
    }
    
    try {
        const res = await fetch('/api/schwab/preview-option-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                strike,
                expiry,
                covered: isCovered,  // Tell backend this is a covered position
                type: isPut ? 'P' : 'C',
                instruction,
                quantity: contracts,
                limitPrice: premium
            })
        });
        
        const result = await res.json();
        
        if (!res.ok || result.error) {
            throw new Error(result.error || 'Preview failed');
        }
        
        const collateralOk = result.buyingPower >= result.collateralRequired;
        
        // Use live pricing if available
        const hasLivePricing = result.liveBid !== null && result.liveAsk !== null;
        const liveBid = result.liveBid || 0;
        const liveAsk = result.liveAsk || 0;
        const liveMid = result.liveMid || 0;
        const suggestedPrice = isSell ? liveBid : liveAsk; // For sells, get bid; for buys, get ask
        const credit = (hasLivePricing ? suggestedPrice : premium) * 100 * contracts;
        
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="font-size:11px; font-family:monospace; color:#888; margin-bottom:6px;">
                    OCC: ${result.occSymbol}
                </div>
                ${hasLivePricing ? `
                    <div style="background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:4px; padding:8px; margin-bottom:8px;">
                        <div style="font-size:10px; color:#888; text-transform:uppercase; margin-bottom:4px;">📈 Live Schwab Pricing</div>
                        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center;">
                            <div>
                                <div style="color:#888; font-size:10px;">Bid</div>
                                <div style="color:#00ff88; font-size:16px; font-weight:bold;">$${liveBid.toFixed(2)}</div>
                            </div>
                            <div>
                                <div style="color:#888; font-size:10px;">Mid</div>
                                <div style="color:#00d9ff; font-size:16px;">$${liveMid.toFixed(2)}</div>
                            </div>
                            <div>
                                <div style="color:#888; font-size:10px;">Ask</div>
                                <div style="color:#ffaa00; font-size:16px;">$${liveAsk.toFixed(2)}</div>
                            </div>
                        </div>
                    </div>
                ` : `
                    <div style="color:#ffaa00; font-size:11px; margin-bottom:8px;">
                        ⚠️ Using staged price ($${premium.toFixed(2)}) - live quote unavailable
                    </div>
                `}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                    <div>
                        <span style="color:#888;">Order:</span>
                        <span style="color:#00d9ff;">${isSell ? 'SELL' : 'BUY'} ${contracts}x @ $${(hasLivePricing ? suggestedPrice : premium).toFixed(2)}</span>
                    </div>
                    <div>
                        <span style="color:#888;">${isSell ? 'Credit' : 'Debit'}:</span>
                        <span style="color:${isSell ? '#00ff88' : '#ff5252'};">$${credit.toLocaleString()}</span>
                    </div>
                    <div>
                        <span style="color:#888;">Collateral:</span>
                        <span style="color:#ffaa00;">$${result.collateralRequired?.toLocaleString() || '?'}</span>
                    </div>
                    <div>
                        <span style="color:#888;">Buying Power:</span>
                        <span style="color:${collateralOk ? '#00ff88' : '#ff5252'};">$${result.buyingPower?.toLocaleString() || '?'}</span>
                    </div>
                </div>
                ${!collateralOk ? `
                    <div style="color:#ff5252; margin-top:8px; font-size:11px;">
                        ⚠️ Insufficient buying power - order may be rejected
                    </div>
                ` : `
                    <div style="color:#00ff88; margin-top:8px; font-size:11px;">
                        ✅ Buying power OK - order will be sent as LIMIT, DAY
                    </div>
                `}
            `;
        }
        
        // Store live pricing for use when sending order
        window._schwabLivePricing = {
            hasLivePricing,
            suggestedPrice: hasLivePricing ? suggestedPrice : premium,
            liveBid,
            liveAsk,
            liveMid
        };
        
    } catch (e) {
        if (detailsDiv) {
            detailsDiv.innerHTML = `
                <div style="color:#ff5252;">❌ ${e.message}</div>
                <div style="color:#888; font-size:11px; margin-top:4px;">Check Schwab connection in Settings</div>
            `;
        }
    }
};

/**
 * Remove a staged trade
 */
window.removeStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const updated = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updated));
    renderPendingTrades();
    showNotification('Staged trade removed', 'info');
};

/**
 * Check margin requirement for a pending trade
 */
window.checkMarginForTrade = async function(ticker, strike, premium, isCall = false, isRoll = false, isDebit = false, totalCost = 0, isSkip = false, tradeType = '', upperStrike = 0) {
    // Detect debit trades from type if flag not set (for backwards compatibility)
    const isDebitTrade = isDebit || 
        tradeType.includes('debit') || 
        tradeType.includes('long_') || 
        tradeType === 'skip_call';
    
    const isSpread = tradeType.includes('_spread') || upperStrike > 0;
    
    // DEBIT TRADES (long calls, debit spreads, SKIP) - no margin, just need cash
    if (isDebitTrade) {
        // Get buying power from AccountService (single source of truth)
        let buyingPower = AccountService.getBuyingPower();
        if (!buyingPower) {
            await AccountService.refresh();
            buyingPower = AccountService.getBuyingPower();
        }
        
        const cost = totalCost || (premium * 100);  // Use totalCost if provided, else premium × 100
        const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        
        let verdict, verdictColor, verdictBg;
        if (buyingPower !== null) {
            const afterTrade = buyingPower - cost;
            if (afterTrade < 0) {
                verdict = `❌ INSUFFICIENT - Need ${fmt(Math.abs(afterTrade))} more`;
                verdictColor = '#ff5252';
                verdictBg = 'rgba(255,82,82,0.2)';
            } else {
                verdict = `✅ OK - ${fmt(afterTrade)} remaining after purchase`;
                verdictColor = '#00ff88';
                verdictBg = 'rgba(0,255,136,0.2)';
            }
        } else {
            verdict = '💡 Connect Schwab to check buying power';
            verdictColor = '#888';
            verdictBg = 'rgba(255,255,255,0.1)';
        }
        
        // Show debit modal
        document.getElementById('marginCheckModal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'marginCheckModal';
        modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        
        const tradeType = isSkip ? 'SKIP™ (LEAPS + Call)' : 
                          isSpread ? (isCall ? 'Call Debit Spread' : 'Put Debit Spread') :
                          isCall ? 'Long Call' : 'Long Put';
        const badgeColor = isSkip ? '#8b5cf6' : isSpread ? '#00bcd4' : '#ff9800';
        const strikeDisplay = isSpread && upperStrike ? `$${strike} / $${upperStrike}` : `$${strike}`;
        
        modal.innerHTML = `
            <div style="background:#1a1a2e; border-radius:12px; padding:24px; border:2px solid ${badgeColor}; max-width:400px; width:90%;">
                <h3 style="color:${badgeColor}; margin:0 0 16px 0;">
                    💳 Cost Check: ${ticker} <span style="background:${badgeColor};color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:6px;">DEBIT</span>
                </h3>
                
                <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Trade Type:</span>
                        <span style="color:#fff;">${tradeType}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Strike(s):</span>
                        <span style="color:#ffaa00;">${strikeDisplay}</span>
                    </div>
                    ${isSpread ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Max Loss:</span>
                        <span style="color:#ff9800;">${fmt(cost)} (the debit paid)</span>
                    </div>
                    ` : ''}
                    <div style="border-top:1px solid #333; padding-top:8px; margin-top:8px;">
                        <div style="display:flex; justify-content:space-between;">
                            <span style="color:#888;">Total Cost (Debit):</span>
                            <span style="color:#ff9800; font-weight:bold; font-size:16px;">${fmt(cost)}</span>
                        </div>
                    </div>
                </div>
                
                <div style="font-size:12px; color:#888; margin-bottom:12px;">${isSpread ? '💡 Spread - long leg covers short leg. No shares needed, no margin!' : '💡 Debit trade - you pay upfront, no margin required'}</div>
                
                ${buyingPower !== null ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
                        <span style="color:#888;">Your Buying Power:</span>
                        <span style="color:#00d9ff;">${fmt(buyingPower)}</span>
                    </div>
                ` : ''}
                
                <div style="background:${verdictBg}; border:1px solid ${verdictColor}; border-radius:8px; padding:12px; text-align:center; margin-bottom:16px;">
                    <span style="color:${verdictColor}; font-weight:bold;">${verdict}</span>
                </div>
                
                <button onclick="document.getElementById('marginCheckModal').remove()" 
                        style="width:100%; padding:12px; background:#333; color:#fff; border:none; border-radius:8px; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        document.body.appendChild(modal);
        return;
    }
    
    // CREDIT TRADES (short puts, covered calls) - margin calculation
    // CREDIT TRADES (short puts, covered calls) - margin calculation
    // First fetch current stock price
    let spot = null;
    try {
        // Try Schwab first
        const schwabRes = await fetch(`/api/schwab/quotes?symbols=${ticker}`);
        if (schwabRes.ok) {
            const data = await schwabRes.json();
            const quote = data[ticker]?.quote;
            // Use extended hours price if available
            spot = quote?.postMarketLastPrice || quote?.preMarketLastPrice || quote?.lastPrice || quote?.mark;
        }
        
        // Fallback to Yahoo
        if (!spot) {
            const yahooRes = await fetch(`/api/yahoo/quote/${ticker}`);
            if (yahooRes.ok) {
                const data = await yahooRes.json();
                spot = data.price;
            }
        }
    } catch (e) {
        console.log('[MARGIN] Price fetch error:', e);
    }
    
    if (!spot) {
        showNotification(`Could not fetch ${ticker} price`, 'error');
        return;
    }
    
    // Determine position type and margin
    const optionType = isCall ? 'Call' : 'Put';
    let marginRequired = 0;
    let marginNote = '';
    let isCovered = false;
    
    // Check if user owns shares (would make the call "covered")
    const holdings = JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
    const ownsShares = holdings.some(h => h.ticker?.toUpperCase() === ticker.toUpperCase() && h.shares >= 100);
    
    if (isCall && ownsShares) {
        // COVERED CALL - no margin required!
        isCovered = true;
        marginRequired = 0;
        marginNote = '✅ Covered by shares you own - no margin needed';
    } else if (isCall && !ownsShares) {
        // NAKED CALL - very high margin (treat like short stock)
        const otmAmount = Math.max(0, strike - spot);  // Positive if OTM
        const optionA = (0.20 * spot - otmAmount + premium) * 100;
        const optionB = (0.10 * strike + premium) * 100;
        marginRequired = Math.max(optionA, optionB);
        marginNote = '⚠️ Naked call - high margin. Consider owning shares first.';
    } else {
        // SHORT PUT - standard margin calculation
        const otmAmount = Math.max(0, spot - strike);  // Positive if OTM
        const optionA = (0.20 * spot - otmAmount + premium) * 100;
        const optionB = (0.10 * strike + premium) * 100;
        marginRequired = Math.max(optionA, optionB);
    }
    
    // For ROLLS, the net margin change is typically zero or near-zero
    // because you're closing one position and opening another of similar size
    let rollNote = '';
    if (isRoll) {
        if (isCovered) {
            rollNote = '🔄 Rolling covered call - no additional margin needed';
            marginRequired = 0;
        } else {
            rollNote = '🔄 Roll trade - actual margin impact will be ~$0 (closing and opening offset)';
            // For rolls, show a nominal amount but explain it's offset
        }
    }
    
    // Get buying power from AccountService (single source of truth)
    let buyingPower = AccountService.getBuyingPower();
    if (!buyingPower) {
        await AccountService.refresh();
        buyingPower = AccountService.getBuyingPower();
    }
    
    // Format helper
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    // Build verdict
    let verdict, verdictColor, verdictBg;
    
    if (isCovered || (isRoll && isCovered)) {
        // Covered or covered roll - always OK
        verdict = '✅ No margin required - covered by shares';
        verdictColor = '#00ff88';
        verdictBg = 'rgba(0,255,136,0.2)';
    } else if (isRoll) {
        // Roll (not covered) - explain the offset
        verdict = '🔄 Roll - closes old position, opens new. Net margin change ~$0';
        verdictColor = '#00d9ff';
        verdictBg = 'rgba(0,217,255,0.2)';
    } else if (buyingPower !== null) {
        const afterTrade = buyingPower - marginRequired;
        const utilization = (marginRequired / buyingPower) * 100;
        
        if (afterTrade < 0) {
            verdict = `❌ INSUFFICIENT - Need ${fmt(Math.abs(afterTrade))} more BP`;
            verdictColor = '#ff5252';
            verdictBg = 'rgba(255,82,82,0.2)';
        } else if (utilization > 50) {
            verdict = `⚠️ HIGH - Uses ${utilization.toFixed(0)}% of BP (${fmt(afterTrade)} left)`;
            verdictColor = '#ffaa00';
            verdictBg = 'rgba(255,170,0,0.2)';
        } else {
            verdict = `✅ OK - Uses ${utilization.toFixed(0)}% of BP (${fmt(afterTrade)} left)`;
            verdictColor = '#00ff88';
            verdictBg = 'rgba(0,255,136,0.2)';
        }
    } else {
        verdict = '💡 Connect Schwab to check if you can afford this';
        verdictColor = '#888';
        verdictBg = 'rgba(255,255,255,0.1)';
    }
    
    // Show modal
    document.getElementById('marginCheckModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'marginCheckModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:24px; border:2px solid ${isRoll ? '#7a8a94' : '#ffaa00'}; max-width:400px; width:90%;">
            <h3 style="color:${isRoll ? '#7a8a94' : '#ffaa00'}; margin:0 0 16px 0;">
                💳 Margin Check: ${ticker} ${isRoll ? '<span style="background:#7a8a94;color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:6px;">ROLL</span>' : ''}
            </h3>
            
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Stock Price:</span>
                    <span style="color:#fff;">${fmt(spot)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">${optionType} Strike:</span>
                    <span style="color:${isCall ? '#ffaa00' : '#00d9ff'};">${fmt(strike)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Premium:</span>
                    <span style="color:#00ff88;">$${premium.toFixed(2)}</span>
                </div>
                ${isCovered ? `
                    <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                        <span style="color:#888;">Coverage:</span>
                        <span style="color:#00ff88;">✅ Own shares</span>
                    </div>
                ` : ''}
                <div style="border-top:1px solid #333; padding-top:8px; margin-top:8px;">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#888;">${isRoll ? 'Net Margin Change:' : 'Margin Required:'}</span>
                        <span style="color:#fff; font-weight:bold; font-size:16px;">${isRoll && isCovered ? '$0' : fmt(marginRequired)}</span>
                    </div>
                </div>
            </div>
            
            ${marginNote ? `<div style="font-size:12px; color:#888; margin-bottom:12px;">${marginNote}</div>` : ''}
            ${rollNote ? `<div style="font-size:12px; color:#7a8a94; margin-bottom:12px;">${rollNote}</div>` : ''}
            
            ${buyingPower !== null && !isCovered && !isRoll ? `
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#888;">Your Buying Power:</span>
                    <span style="color:#00d9ff;">${fmt(buyingPower)}</span>
                </div>
            ` : ''}
            
            <div style="background:${verdictBg}; border-radius:8px; padding:12px; text-align:center; color:${verdictColor}; font-weight:bold;">
                ${verdict}
            </div>
            
            <div style="margin-top:16px; text-align:center;">
                <button onclick="document.getElementById('marginCheckModal').remove()" 
                        style="background:#333; color:#fff; border:none; padding:10px 24px; border-radius:6px; cursor:pointer;">
                    Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

// Export for direct imports from other modules
export const renderPendingTrades = window.renderPendingTrades;
