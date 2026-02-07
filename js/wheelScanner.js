/**
 * Wheel Scanner Module
 * Finds stocks near 3-month lows for optimal wheel strategy entries
 * 
 * Extracted from main.js
 */

import { showNotification } from 'utils';

// ============================================================================
// WHEEL SCANNER - Find stocks near 3-month lows for wheel entries
// ============================================================================

window.runWheelScanner = async function() {
    const resultsDiv = document.getElementById('scannerResults');
    const loadingDiv = document.getElementById('scannerLoading');
    const tableDiv = document.getElementById('scannerTable');
    const countSpan = document.getElementById('scannerCount');
    const timeSpan = document.getElementById('scannerTime');
    const btn = document.getElementById('scannerBtn');
    
    // Get filter values
    const maxRange = document.getElementById('scannerMaxRange')?.value || '10';
    const sector = document.getElementById('scannerSector')?.value || 'all';
    const cap = document.getElementById('scannerCap')?.value || 'all';
    const minPrice = document.getElementById('scannerMinPrice')?.value || '10';
    const maxPrice = document.getElementById('scannerMaxPrice')?.value || '500';
    
    // Show loading, hide results
    if (resultsDiv) resultsDiv.style.display = 'none';
    if (loadingDiv) loadingDiv.style.display = 'block';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Scanning...';
    }
    
    const startTime = Date.now();
    
    try {
        const url = `/api/scanner/wheel?maxRange=${maxRange}&sector=${sector}&cap=${cap}&minPrice=${minPrice}&maxPrice=${maxPrice}`;
        const response = await fetch(url);
        
        if (!response.ok) throw new Error('Scanner request failed');
        
        const data = await response.json();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        // Hide loading, show results
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (resultsDiv) resultsDiv.style.display = 'block';
        
        if (countSpan) countSpan.textContent = `${data.count} candidates found`;
        if (timeSpan) timeSpan.textContent = `Scanned in ${elapsed}s`;
        
        if (data.results && data.results.length > 0) {
            // Build results table
            let html = `
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:1px solid #333; color:#888; font-size:10px; text-transform:uppercase;">
                            <th style="text-align:left; padding:6px 4px;">Ticker</th>
                            <th style="text-align:left; padding:6px 4px;">Sector</th>
                            <th style="text-align:right; padding:6px 4px;">Price</th>
                            <th style="text-align:right; padding:6px 4px;">3M Low</th>
                            <th style="text-align:center; padding:6px 4px;">Range</th>
                            <th style="text-align:right; padding:6px 4px;">IV</th>
                            <th style="text-align:right; padding:6px 4px;">~Put</th>
                            <th style="text-align:center; padding:6px 4px;">Action</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            data.results.forEach(r => {
                // Color code range position
                let rangeColor = '#00ff88'; // Green for very low
                let rangeIcon = '🔴';
                if (r.rangePosition > 5) { rangeColor = '#ffaa00'; rangeIcon = '🟠'; }
                if (r.rangePosition > 10) { rangeColor = '#ff9800'; rangeIcon = '🟡'; }
                if (r.rangePosition > 15) { rangeColor = '#888'; rangeIcon = '⚪'; }
                
                html += `
                    <tr style="border-bottom:1px solid #222; transition:background 0.2s;" 
                        onmouseover="this.style.background='rgba(0,217,255,0.1)'" 
                        onmouseout="this.style.background='transparent'">
                        <td style="padding:8px 4px; font-weight:bold; color:#00d9ff;">${r.ticker}</td>
                        <td style="padding:8px 4px; color:#888; font-size:10px;">${r.sector}</td>
                        <td style="padding:8px 4px; text-align:right; color:#ddd;">$${r.price.toFixed(2)}</td>
                        <td style="padding:8px 4px; text-align:right; color:#888;">$${r.low3m.toFixed(2)}</td>
                        <td style="padding:8px 4px; text-align:center;">
                            <span style="color:${rangeColor}; font-weight:bold;">${rangeIcon} ${r.rangePosition.toFixed(1)}%</span>
                        </td>
                        <td style="padding:8px 4px; text-align:right; color:${r.iv && r.iv > 50 ? '#ffaa00' : '#888'};">
                            ${r.iv ? r.iv.toFixed(0) + '%' : '-'}
                        </td>
                        <td style="padding:8px 4px; text-align:right; color:#00ff88;">
                            ${r.putPremium ? '$' + r.putPremium.toFixed(2) : '-'}
                        </td>
                        <td style="padding:8px 4px; text-align:center; white-space:nowrap;">
                            <button onclick="window.showTickerChart('${r.ticker}')" 
                                style="padding:4px 8px; background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.4); border-radius:4px; color:#ffaa00; font-size:10px; cursor:pointer; margin-right:4px;"
                                title="View 3-month chart with Bollinger Bands">
                                📊
                            </button>
                            <button onclick="window.scannerAnalyze('${r.ticker}')" 
                                style="padding:4px 8px; background:rgba(0,217,255,0.2); border:1px solid rgba(0,217,255,0.4); border-radius:4px; color:#00d9ff; font-size:10px; cursor:pointer; margin-right:4px;"
                                title="Deep dive analysis">
                                🔍
                            </button>
                            <button onclick="window.scannerQuickAdd('${r.ticker}', ${r.price})" 
                                style="padding:4px 8px; background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.4); border-radius:4px; color:#00ff88; font-size:10px; cursor:pointer;"
                                title="Quick add to Discord analyzer">
                                +
                            </button>
                        </td>
                    </tr>
                `;
            });
            
            html += '</tbody></table>';
            if (tableDiv) tableDiv.innerHTML = html;
        } else {
            if (tableDiv) tableDiv.innerHTML = `
                <div style="text-align:center; padding:20px; color:#888;">
                    <div style="font-size:24px; margin-bottom:8px;">🔍</div>
                    <div>No candidates found matching your filters.</div>
                    <div style="font-size:11px; margin-top:8px;">Try increasing the range % or changing sector filters.</div>
                </div>
            `;
        }
        
    } catch (error) {
        console.error('[SCANNER] Error:', error);
        showNotification('Scanner failed: ' + error.message, 'error');
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (tableDiv) tableDiv.innerHTML = `
            <div style="text-align:center; padding:20px; color:#ff5252;">
                <div style="font-size:24px; margin-bottom:8px;">❌</div>
                <div>Scanner error: ${error.message}</div>
            </div>
        `;
        if (resultsDiv) resultsDiv.style.display = 'block';
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🔄 Scan Now';
        }
    }
};

// Scanner helper: Send ticker to Strategy Advisor for deep analysis
window.scannerAnalyze = function(ticker) {
    // Set the ticker in Strategy Advisor and run it
    const tickerInput = document.getElementById('strategyAdvisorTicker');
    if (tickerInput) {
        tickerInput.value = ticker;
        // Scroll to Strategy Advisor section
        tickerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Optionally auto-run
        setTimeout(() => {
            window.runStrategyAdvisor();
        }, 300);
    }
};

// Scanner helper: Quick add to Discord analyzer
window.scannerQuickAdd = function(ticker, price) {
    const strike = Math.round(price * 0.95); // 5% below current price
    const tradeText = `Short put on ${ticker} $${strike} strike, 30-45 DTE`;
    
    const textArea = document.getElementById('pasteTradeInput2');
    if (textArea) {
        textArea.value = tradeText;
        textArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        showNotification(`Added ${ticker} $${strike}P to analyzer`, 'success');
    }
};

// ES module exports
export const runWheelScanner = window.runWheelScanner;
export const scannerAnalyze = window.scannerAnalyze;
export const scannerQuickAdd = window.scannerQuickAdd;
