/**
 * AI Functions Module
 * AI integration for trade analysis: Discord analyzer, Deep Dive, X sentiment,
 * Trade Ideas, AI status/warmup, and thesis management
 * 
 * Extracted from main.js
 */

import { showNotification } from 'utils';
import { state } from 'state';
import AccountService from './services/AccountService.js';
import PositionsService from './services/PositionsService.js';
import { renderPendingTrades } from 'tradeStaging';
import { extractThesisSummary } from 'aiHelpers';
import TradeCardService from './services/TradeCardService.js';

/**
 * Save AI model preference to localStorage
 */
window.saveAIModelPreference = function() {
    const modelSelect = document.getElementById('aiModelSelect');
    if (modelSelect) {
        localStorage.setItem('wheelhouse_ai_model', modelSelect.value);
        console.log('AI model preference saved:', modelSelect.value);
        // Check if this model is loaded
        checkAIStatus();
    }
};

/**
 * Save wisdom toggle preference to localStorage and update UI
 */
window.saveWisdomPreference = function() {
    const wisdomToggle = document.getElementById('aiWisdomToggle');
    const wisdomStatus = document.getElementById('wisdomStatus');
    if (wisdomToggle) {
        const isEnabled = wisdomToggle.checked;
        localStorage.setItem('wheelhouse_wisdom_enabled', isEnabled ? 'true' : 'false');
        console.log('Wisdom preference saved:', isEnabled ? 'enabled' : 'disabled (pure mode)');
        
        // Update status indicator
        if (wisdomStatus) {
            if (isEnabled) {
                wisdomStatus.textContent = '✓ Rules active';
                wisdomStatus.style.color = '#4ade80';
            } else {
                wisdomStatus.textContent = '⚡ Pure mode';
                wisdomStatus.style.color = '#fbbf24';
            }
        }
    }
};

/**
 * Load wisdom toggle preference from localStorage
 */
window.loadWisdomPreference = function() {
    const wisdomToggle = document.getElementById('aiWisdomToggle');
    if (wisdomToggle) {
        const saved = localStorage.getItem('wheelhouse_wisdom_enabled');
        // Default to enabled if not set
        wisdomToggle.checked = saved !== 'false';
        // Update status indicator
        saveWisdomPreference();
    }
};

/**
 * Check AI/Ollama status and show what's loaded
 */
window.checkAIStatus = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    if (!statusEl) return;
    
    try {
        const response = await fetch('/api/ai/status');
        const status = await response.json();
        
        if (!status.available) {
            statusEl.textContent = '❌ Ollama not running';
            statusEl.style.color = '#ff5252';
            return;
        }
        
        // Use global model selector (local aiModelSelect is an override)
        const selectedModel = window.getSelectedAIModel('aiModelSelect');
        const isLoaded = status.loaded?.some(m => m.name === selectedModel);
        
        if (isLoaded) {
            const loaded = status.loaded.find(m => m.name === selectedModel);
            statusEl.textContent = `✅ Loaded (${loaded.sizeVramGB}GB VRAM)`;
            statusEl.style.color = '#00ff88';
            if (warmupBtn) {
                warmupBtn.style.background = '#1a3a1a';
                warmupBtn.style.color = '#00ff88';
                warmupBtn.textContent = '✓ Ready';
            }
        } else if (status.loaded?.length > 0) {
            const other = status.loaded[0];
            statusEl.textContent = `⚠️ ${other.name} loaded, not ${selectedModel.split(':')[1]}`;
            statusEl.style.color = '#ffaa00';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#ffaa00';
                warmupBtn.textContent = '🔥 Load';
            }
        } else {
            statusEl.textContent = '💤 Cold (click Warmup)';
            statusEl.style.color = '#888';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#888';
                warmupBtn.textContent = '🔥 Warmup';
            }
        }
    } catch (e) {
        statusEl.textContent = '❌ Error';
        statusEl.style.color = '#ff5252';
    }
};

/**
 * Warmup (pre-load) the selected AI model into GPU memory
 */
window.warmupAIModel = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    // Use global model selector (local aiModelSelect is an override)
    const selectedModel = window.getSelectedAIModel('aiModelSelect');
    
    if (warmupBtn) {
        warmupBtn.disabled = true;
        warmupBtn.innerHTML = '⏳ 0s';
        warmupBtn.style.color = '#8a9aa8';
        warmupBtn.style.minWidth = '60px';
    }
    if (statusEl) {
        statusEl.textContent = `Loading ${selectedModel}...`;
        statusEl.style.color = '#8a9aa8';
    }
    
    const startTime = Date.now();
    
    try {
        const response = await fetch('/api/ai/warmup', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ model: selectedModel })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        if (warmupBtn) warmupBtn.innerHTML = `⏳ ${elapsed}s`;
                        if (statusEl) statusEl.textContent = data.message;
                    } else if (data.type === 'complete') {
                        if (statusEl) {
                            statusEl.textContent = `✅ ${data.message}`;
                            statusEl.style.color = '#00ff88';
                        }
                        if (warmupBtn) {
                            warmupBtn.innerHTML = '✓ Ready';
                            warmupBtn.style.background = '#1a3a1a';
                            warmupBtn.style.color = '#00ff88';
                        }
                        showNotification(`🧠 ${selectedModel} loaded and ready!`, 'success');
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = `❌ ${e.message}`;
            statusEl.style.color = '#ff5252';
        }
        if (warmupBtn) {
            warmupBtn.innerHTML = '🔥 Retry';
            warmupBtn.style.color = '#ff5252';
        }
        showNotification(`Failed to load model: ${e.message}`, 'error');
    } finally {
        if (warmupBtn) warmupBtn.disabled = false;
    }
};

// Check AI status on page load and periodically
setTimeout(() => window.checkAIStatus?.(), 2000);
setInterval(() => window.checkAIStatus?.(), 30000); // Refresh every 30 seconds

/**
 * Show/hide X Sentiment button based on model selection
 */
function updateXSentimentButton() {
    // Handle both Ideas panels (Ideas tab and Positions tab)
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    const xBtn1 = document.getElementById('xSentimentBtn');
    const xBtn2 = document.getElementById('xSentimentBtn2');
    
    if (modelSelect1 && xBtn1) {
        const isGrok = modelSelect1.value?.startsWith('grok');
        xBtn1.style.display = isGrok ? 'block' : 'none';
    }
    if (modelSelect2 && xBtn2) {
        const isGrok = modelSelect2.value?.startsWith('grok');
        xBtn2.style.display = isGrok ? 'block' : 'none';
    }
}

// Listen for model changes - run immediately since DOM is likely ready
(function setupXSentimentToggle() {
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    
    if (modelSelect1 || modelSelect2) {
        if (modelSelect1) modelSelect1.addEventListener('change', updateXSentimentButton);
        if (modelSelect2) modelSelect2.addEventListener('change', updateXSentimentButton);
        updateXSentimentButton(); // Check immediately
    } else {
        // DOM not ready, wait a bit
        setTimeout(setupXSentimentToggle, 500);
    }
})();

/**
 * Restore X Sentiment from localStorage (persists across tab switches)
 */
window.restoreXSentiment = function() {
    try {
        const saved = localStorage.getItem('wheelhouse_x_sentiment');
        if (!saved) return false;
        
        const data = JSON.parse(saved);
        if (!data.html || !data.tickers) return false;
        
        // Check if data is less than 4 hours old
        const ageMs = Date.now() - data.timestamp;
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > 4) {
            console.log('[X Sentiment] Cached data too old, clearing');
            localStorage.removeItem('wheelhouse_x_sentiment');
            return false;
        }
        
        // Restore to both panels
        const ageMinutes = Math.round(ageMs / 60000);
        const ageDisplay = ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes/60)}h ago`;
        
        // Update header with age indicator
        let html = data.html.replace(
            /\([\d:]+\s*[AP]M\)/i, 
            `(${data.timeString} - <span style="color:#ffaa00;">${ageDisplay}</span>)`
        );
        
        // Restore to Ideas tab
        const ideaContentLarge = document.getElementById('ideaContentLarge');
        const ideaResultsLarge = document.getElementById('ideaResultsLarge');
        if (ideaContentLarge && ideaResultsLarge) {
            ideaContentLarge.innerHTML = html;
            ideaResultsLarge.style.display = 'block';
        }
        
        // Restore to Positions tab
        const ideaContent = document.getElementById('ideaContent');
        const ideaResults = document.getElementById('ideaResults');
        if (ideaContent && ideaResults) {
            ideaContent.innerHTML = html;
            ideaResults.style.display = 'block';
        }
        
        // Restore tickers for Trade Ideas integration
        window._xTrendingTickers = data.tickers;
        
        // Show X tickers integration checkbox
        const tickerCount = data.tickers.length;
        ['', '2'].forEach(suffix => {
            const optionDiv = document.getElementById('xTickersOption' + suffix);
            const countSpan = document.getElementById('xTickerCount' + suffix);
            if (optionDiv && tickerCount > 0) {
                optionDiv.style.display = 'block';
                if (countSpan) countSpan.textContent = tickerCount;
            }
        });
        
        console.log(`[X Sentiment] Restored from cache (${ageDisplay}):`, data.tickers);
        return true;
    } catch (e) {
        console.error('[X Sentiment] Restore failed:', e);
        return false;
    }
};

// Restore X Sentiment on page load
setTimeout(() => window.restoreXSentiment(), 1000);

/**
 * Save X Sentiment to history for trend comparison (keep last 10)
 */
window.saveXSentimentToHistory = function(data) {
    try {
        let history = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]');
        
        // Add new entry
        history.unshift({
            timestamp: data.timestamp,
            timeString: data.timeString,
            tickers: data.tickers,
            rawText: data.rawText
        });
        
        // Keep only last 10
        if (history.length > 10) history = history.slice(0, 10);
        
        localStorage.setItem('wheelhouse_x_sentiment_history', JSON.stringify(history));
        console.log(`[X Sentiment] History saved (${history.length} entries)`);
    } catch (e) {
        console.error('[X Sentiment] History save failed:', e);
    }
};

/**
 * Show X Sentiment history comparison modal
 */
window.showXSentimentHistory = function() {
    const history = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]');
    
    if (history.length < 2) {
        showNotification('Need at least 2 sentiment runs to compare. Run X Sentiment again later!', 'info');
        return;
    }
    
    // Analyze trends across history
    const tickerCounts = {};
    history.forEach((entry, idx) => {
        (entry.tickers || []).forEach(t => {
            if (!tickerCounts[t]) tickerCounts[t] = { count: 0, appearances: [] };
            tickerCounts[t].count++;
            tickerCounts[t].appearances.push(idx);
        });
    });
    
    // Sort by frequency (most mentioned across runs)
    const sorted = Object.entries(tickerCounts)
        .sort((a, b) => b[1].count - a[1].count);
    
    const persistent = sorted.filter(([_, data]) => data.count >= 2);
    const oneTime = sorted.filter(([_, data]) => data.count === 1);
    
    // Build comparison between latest and previous
    const latest = history[0];
    const previous = history[1];
    const latestTickers = new Set(latest.tickers || []);
    const prevTickers = new Set(previous.tickers || []);
    
    const newTickers = [...latestTickers].filter(t => !prevTickers.has(t));
    const droppedTickers = [...prevTickers].filter(t => !latestTickers.has(t));
    const stillTrending = [...latestTickers].filter(t => prevTickers.has(t));
    
    const timeDiff = latest.timestamp - previous.timestamp;
    const hoursDiff = Math.round(timeDiff / (1000 * 60 * 60) * 10) / 10;
    
    const modal = document.createElement('div');
    modal.id = 'xHistoryModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;z-index:10001;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #1da1f2;border-radius:12px;padding:24px;max-width:700px;width:90%;max-height:85vh;overflow-y:auto;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h2 style="margin:0;color:#1da1f2;">📊 X Sentiment Trend Analysis</h2>
                <button onclick="this.closest('#xHistoryModal').remove()" 
                    style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">×</button>
            </div>
            
            <div style="background:rgba(29,161,242,0.1);padding:12px;border-radius:8px;margin-bottom:16px;">
                <strong>Comparing:</strong> ${latest.timeString} vs ${previous.timeString} 
                <span style="color:#888;">(${hoursDiff} hours apart)</span>
            </div>
            
            ${stillTrending.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#00ff88;margin:0 0 8px 0;">🔥 Still Trending (Persistent Buzz)</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${stillTrending.map(t => `
                        <span onclick="window.xDeepDive('${t}')" 
                            style="background:#00ff88;color:#000;padding:6px 12px;border-radius:16px;cursor:pointer;font-weight:bold;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    💡 These tickers appeared in both scans - sustained interest!
                </div>
            </div>
            ` : ''}
            
            ${newTickers.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#ffaa00;margin:0 0 8px 0;">🆕 Newly Trending</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${newTickers.map(t => `
                        <span onclick="window.xDeepDive('${t}')" 
                            style="background:#ffaa00;color:#000;padding:6px 12px;border-radius:16px;cursor:pointer;font-weight:bold;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    ⚡ New in latest scan - emerging momentum
                </div>
            </div>
            ` : ''}
            
            ${droppedTickers.length > 0 ? `
            <div style="margin-bottom:16px;">
                <h3 style="color:#888;margin:0 0 8px 0;">📉 Dropped Off</h3>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    ${droppedTickers.map(t => `
                        <span style="background:#333;color:#888;padding:6px 12px;border-radius:16px;">
                            ${t}
                        </span>
                    `).join('')}
                </div>
                <div style="color:#888;font-size:11px;margin-top:4px;">
                    Yesterday's news - buzz faded
                </div>
            </div>
            ` : ''}
            
            <div style="margin-top:20px;padding-top:16px;border-top:1px solid #333;">
                <h3 style="color:#1da1f2;margin:0 0 12px 0;">📈 All-Time Frequency (Last ${history.length} Scans)</h3>
                <table style="width:100%;font-size:12px;">
                    <tr style="color:#888;">
                        <th style="text-align:left;padding:4px;">Ticker</th>
                        <th style="text-align:center;padding:4px;">Mentions</th>
                        <th style="text-align:left;padding:4px;">Status</th>
                    </tr>
                    ${persistent.slice(0, 10).map(([ticker, data]) => `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:6px;color:#00d9ff;font-weight:bold;cursor:pointer;" 
                                onclick="window.xDeepDive('${ticker}')">${ticker}</td>
                            <td style="padding:6px;text-align:center;">${data.count}x</td>
                            <td style="padding:6px;color:${latestTickers.has(ticker) ? '#00ff88' : '#888'};">
                                ${latestTickers.has(ticker) ? '🔥 Active' : '💤 Quiet'}
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
            
            <div style="margin-top:20px;text-align:center;">
                <button onclick="this.closest('#xHistoryModal').remove()" 
                    style="padding:10px 24px;background:#1da1f2;border:none;border-radius:6px;color:#fff;font-weight:bold;cursor:pointer;">
                    Got It
                </button>
                <button onclick="if(confirm('Clear all sentiment history?')){localStorage.removeItem('wheelhouse_x_sentiment_history');this.closest('#xHistoryModal').remove();showNotification('History cleared','info');}" 
                    style="padding:10px 24px;background:#333;border:none;border-radius:6px;color:#888;cursor:pointer;margin-left:10px;">
                    Clear History
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

/**
 * Helper to update X Sentiment progress UI
 */
function updateXProgress(step, message, totalSteps) {
    const progressBar = document.getElementById('xProgressBar');
    const stepEl = document.getElementById(`xStep${step}`);
    
    // Update progress bar
    const pct = Math.round((step / totalSteps) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    
    // Mark previous steps as complete
    for (let i = 1; i < step; i++) {
        const prevStep = document.getElementById(`xStep${i}`);
        if (prevStep) {
            prevStep.style.opacity = '1';
            const icon = prevStep.querySelector('.step-icon');
            if (icon) icon.textContent = '✅';
        }
    }
    
    // Update current step with spinner
    if (stepEl) {
        stepEl.style.opacity = '1';
        const icon = stepEl.querySelector('.step-icon');
        if (icon) {
            icon.innerHTML = '<span class="spinner" style="width:14px; height:14px; display:inline-block; border:2px solid #333; border-top-color:#1da1f2; border-radius:50%; animation:spin 1s linear infinite;"></span>';
        }
        // Update message if provided
        if (message) {
            const msgSpan = stepEl.querySelector('span:last-child');
            if (msgSpan) msgSpan.textContent = message;
        }
    }
}

/**
 * Get X/Twitter sentiment via Grok (Grok-only feature)
 */
window.getXSentiment = async function() {
    // Try both panels - Ideas tab uses "Large" suffix, Positions tab doesn't
    const ideaBtn = document.getElementById('xSentimentBtn2') || document.getElementById('xSentimentBtn');
    const ideaResults = document.getElementById('ideaResultsLarge') || document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContentLarge') || document.getElementById('ideaContent');
    
    if (!ideaResults || !ideaContent) {
        console.error('Could not find result containers');
        return;
    }
    
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 
                        parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    
    // Get STOCK holdings for impact check
    const holdings = (state.holdings || []).map(h => ({
        ticker: h.ticker,
        shares: h.shares || h.quantity || 100,
        costBasis: h.costBasis || h.avgCost,
        type: 'stock'
    }));
    
    // Get OPTIONS positions - these are just as important!
    const optionsPositions = (state.positions || []).map(p => ({
        ticker: p.ticker,
        strike: p.strike,
        expiry: p.expiry,
        type: p.type || 'short_put',
        premium: p.premium,
        contracts: p.contracts || 1,
        sector: p.sector,
        sectorKeywords: p.sectorKeywords
    }));
    
    // Combine all tickers for X sentiment search
    const allTickers = [...new Set([
        ...holdings.map(h => h.ticker),
        ...optionsPositions.map(p => p.ticker)
    ])].filter(t => t && t.length <= 5 && !/^\d/.test(t)); // Filter out CUSIPs, money markets
    
    // Collect sector keywords from positions
    const sectorKeywords = [...new Set(
        optionsPositions
            .filter(p => p.sectorKeywords)
            .flatMap(p => p.sectorKeywords)
    )];
    
    // Get previous runs for trend comparison (last 5 runs)
    const previousRuns = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]').slice(0, 5);
    
    // DEBUG: Log what we're sending
    console.log(`[X Sentiment] Holdings:`, holdings.map(h => h.ticker));
    console.log(`[X Sentiment] Options:`, optionsPositions.map(p => `${p.ticker} $${p.strike}`));
    console.log(`[X Sentiment] All Tickers:`, allTickers);
    console.log(`[X Sentiment] Sector Keywords:`, sectorKeywords);
    console.log(`[X Sentiment] Sending ${previousRuns.length} previous runs, ${holdings.length} holdings, ${optionsPositions.length} options, ${sectorKeywords.length} sector keywords`);
    
    // Show loading with progress animation
    if (ideaBtn) {
        ideaBtn.disabled = true;
        ideaBtn.textContent = '⏳ Scanning X...';
    }
    ideaResults.style.display = 'block';
    
    // Build progress UI similar to Week Summary
    ideaContent.innerHTML = `
        <div style="padding:20px;">
            <div style="text-align:center; margin-bottom:20px;">
                <div style="font-size:24px; margin-bottom:10px;">🐦</div>
                <div style="color:#1da1f2; font-weight:bold;">Scanning X/Twitter...</div>
                <div style="color:#666; font-size:11px; margin-top:4px;">${allTickers.length} tickers • ${holdings.length} stocks • ${optionsPositions.length} options</div>
            </div>
            
            <!-- Progress bar -->
            <div style="background:#1a1a2e; border-radius:8px; height:6px; margin-bottom:20px; overflow:hidden;">
                <div id="xProgressBar" style="background:linear-gradient(90deg,#1da1f2,#00ff88); height:100%; width:0%; transition:width 0.5s ease;"></div>
            </div>
            
            <!-- Steps -->
            <div style="font-size:12px;">
                <div id="xStep1" class="x-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                    <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                    <span>Analyzing your ${allTickers.length} positions...</span>
                </div>
                <div id="xStep2" class="x-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                    <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                    <span>Searching X for your tickers...</span>
                </div>
                <div id="xStep3" class="x-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                    <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                    <span>Checking sector trends...</span>
                </div>
                <div id="xStep4" class="x-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                    <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                    <span>Generating report...</span>
                </div>
            </div>
        </div>
    `;
    
    try {
        const response = await fetch('/api/ai/x-sentiment', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'  // Request SSE streaming
            },
            body: JSON.stringify({ 
                buyingPower, 
                holdings,           // Stock holdings
                optionsPositions,   // Options positions (NEW!)
                allTickers,         // Combined unique tickers
                sectorKeywords,     // Sector search terms (NEW!)
                previousRuns 
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        // Process SSE stream for progress updates
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        
                        if (data.type === 'progress') {
                            // Update progress UI
                            updateXProgress(data.step, data.message, data.totalSteps || 4);
                        } else if (data.type === 'complete') {
                            result = data;
                        } else if (data.type === 'error') {
                            throw new Error(data.error);
                        }
                    } catch (parseErr) {
                        // Ignore parse errors for incomplete chunks
                    }
                }
            }
        }
        
        if (!result) {
            throw new Error('No result received from X sentiment scan');
        }
        
        // Extract tickers from the response for Deep Dive and Trade Ideas integration
        // Multiple patterns to catch different formats:
        // 1. **TICKER** @ $XX.XX (bold with price)
        // 2. **TICKER** (just bold)
        // 3. - TICKER @ $XX (list item with price)
        // 4. TICKER followed by context words
        const foundTickers = new Set();
        
        // Pattern 1: Bold tickers like **AMD** or **ORCL**
        const boldPattern = /\*\*([A-Z]{2,5})\*\*/g;
        let match;
        while ((match = boldPattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Pattern 2: Ticker @ $price like "AMD @ $96.50" or "- CSCO @ $56.00"
        const pricePattern = /\b([A-Z]{2,5})\s*@\s*\$/g;
        while ((match = pricePattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Pattern 3: Context patterns (original, as backup)
        const contextPattern = /\b([A-Z]{2,5})\b(?:\s*-\s*[A-Za-z]|\s+is\s|\s+has\s|\s+could|\s+looks|\s+breaking)/g;
        while ((match = contextPattern.exec(result.sentiment)) !== null) {
            foundTickers.add(match[1]);
        }
        
        // Filter out common words that look like tickers
        const excludeWords = ['AI', 'IV', 'OTM', 'ATM', 'ITM', 'ETF', 'EV', 'CEO', 'CFO', 'IPO', 'PE', 'EPS', 'GDP', 'CPI', 'FED', 'SEC', 'USD', 'EUR', 'NOW', 'ANY', 'ALL', 'PUT', 'CALL', 'BUY', 'SELL'];
        excludeWords.forEach(word => foundTickers.delete(word));
        
        // Store for Trade Ideas integration
        window._xTrendingTickers = Array.from(foundTickers);
        console.log('[X Sentiment] Extracted tickers:', window._xTrendingTickers);
        
        // Format the response with nice styling
        let formatted = result.sentiment
            .replace(/\n/g, '<br>')  // Convert newlines to HTML breaks FIRST
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#1da1f2;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(🔥|📢|⚠️|💰|🚀|🆕|📉)/g, '<span style="font-size:14px;">$1</span>')
            .replace(/^- /gm, '• ');  // Convert markdown bullets to nice bullets
        
        // Make tickers clickable for Deep Dive
        window._xTrendingTickers.forEach(ticker => {
            const tickerRegex = new RegExp(`\\b(${ticker})\\b`, 'g');
            formatted = formatted.replace(tickerRegex, 
                `<span class="x-ticker" onclick="window.xDeepDive('${ticker}')" style="color:#00ff88; cursor:pointer; text-decoration:underline; font-weight:bold;" title="Click for Deep Dive on ${ticker}">$1</span>`);
        });
        
        // Add header with refresh button and history button
        const timestamp = new Date().toLocaleTimeString();
        const historyCount = JSON.parse(localStorage.getItem('wheelhouse_x_sentiment_history') || '[]').length;
        const usageCount = parseInt(localStorage.getItem('wheelhouse_x_sentiment_usage') || '0') + 1; // +1 because we haven't saved yet
        const historyBtn = historyCount >= 2 
            ? `<button onclick="window.showXSentimentHistory()" style="font-size:10px; padding:3px 8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer; margin-right:6px;" title="Compare with previous scans">📊 Trends (${historyCount})</button>`
            : '';
        const header = `<div style="color:#1da1f2; font-weight:bold; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center;">
            <span>🔥 Live from X/Twitter <span style="color:#666; font-size:10px;">(${timestamp})</span></span>
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:9px; color:#666; background:rgba(29,161,242,0.15); padding:2px 6px; border-radius:3px;" title="Total Grok API calls">📊 #${usageCount}</span>
                ${historyBtn}
                <button onclick="window.getXSentiment()" style="font-size:10px; padding:3px 8px; background:#1da1f2; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔄 Refresh</button>
            </div>
        </div>
        <div style="font-size:10px; color:#888; margin-bottom:10px; padding:6px; background:rgba(0,255,136,0.1); border-radius:4px;">
            💡 <strong style="color:#00ff88;">Click any ticker</strong> for Deep Dive analysis | Found: ${window._xTrendingTickers.join(', ')}
        </div>`;
        
        const fullHtml = header + formatted;
        ideaContent.innerHTML = fullHtml;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Trending on X (Grok)';
            ideaBtn.disabled = false;
        }
        
        // Save to localStorage for persistence across tab switches
        const sentimentData = {
            html: fullHtml,
            tickers: window._xTrendingTickers,
            timestamp: Date.now(),
            timeString: timestamp,
            rawText: result.insight  // Store raw text for comparison
        };
        localStorage.setItem('wheelhouse_x_sentiment', JSON.stringify(sentimentData));
        
        // Save the incremented usage counter (usageCount already calculated above)
        localStorage.setItem('wheelhouse_x_sentiment_usage', usageCount.toString());
        console.log(`[X Sentiment] API call #${usageCount}`);
        
        // Also save to history (keep last 10 runs)
        window.saveXSentimentToHistory(sentimentData);
        console.log('[X Sentiment] Saved to localStorage and history');
        
        // Show the X tickers integration checkbox
        const tickerCount = window._xTrendingTickers.length;
        ['', '2'].forEach(suffix => {
            const optionDiv = document.getElementById('xTickersOption' + suffix);
            const countSpan = document.getElementById('xTickerCount' + suffix);
            if (optionDiv && tickerCount > 0) {
                optionDiv.style.display = 'block';
                if (countSpan) countSpan.textContent = tickerCount;
            }
        });
        
    } catch (e) {
        console.error('X Sentiment error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">X Sentiment requires Grok API. Make sure it's configured in Settings.</span>`;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Retry';
            ideaBtn.disabled = false;
        }
    }
};

/**
 * Deep Dive from X Sentiment - fetches live price and runs analysis
 */
window.xDeepDive = async function(ticker) {
    // Use global model selector - prefer non-reasoning models for cleaner output
    // deepseek-r1 models show chain-of-thought which is verbose
    const selectedModel = window.getSelectedAIModel?.('globalAiModelSelect') || 
                          window.getSelectedAIModel?.('ideaModelSelect2') || 
                          window.getSelectedAIModel?.('ideaModelSelect') || 
                          'qwen2.5:32b';  // Default to non-reasoning model
    
    console.log(`[xDeepDive] Using model: ${selectedModel}`);
    
    // Show loading modal
    const modal = document.createElement('div');
    modal.id = 'xDeepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#1da1f2;">🔥 X → Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#xDeepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="xDeepDiveContent" style="color:#ddd; line-height:1.7;">
                <div style="text-align:center; padding:40px;">
                    <div style="font-size:24px; margin-bottom:10px;">⏳</div>
                    <div style="color:#1da1f2;">Fetching ${ticker} data and running analysis...</div>
                    <div style="color:#666; font-size:12px; margin-top:8px;">Using ${selectedModel}</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        // Backend fetches real options chain and finds best ~0.20 delta put at ~30 DTE
        console.log(`[xDeepDive] Requesting real options analysis for ${ticker}...`);
        
        // Call Deep Dive API - let backend find the best strike/expiry from real chain
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                ticker, 
                model: selectedModel,
                targetDelta: 0.20  // Conservative 0.20 delta
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Deep Dive failed');
        }
        
        const result = await response.json();
        
        // Get the REAL strike/expiry/price from the backend (from real options chain)
        const strike = result.strike;
        let expiry = result.expiry;
        const price = result.currentPrice;
        const premium = result.premium;
        const selectionRationale = result.selectionRationale;
        
        // Format expiry for display (ISO date -> "Feb 28, 2026")
        const formatExpiry = (exp) => {
            if (!exp) return 'N/A';
            // If already formatted like "Feb 28", return as-is
            if (/^[A-Z][a-z]{2}\s\d+/.test(exp)) return exp;
            // ISO format: 2026-02-28
            const match = exp.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (match) {
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return `${months[parseInt(match[2]) - 1]} ${parseInt(match[3])}, ${match[1]}`;
            }
            return exp;
        };
        const expiryDisplay = formatExpiry(expiry);
        
        // Format the analysis
        let formatted = result.analysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#7a8a94;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(🎯|⚠️|💡|📊)/g, '<span style="font-size:14px;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Show premium info with delta (from real chain data)
        const premiumInfo = premium ? 
            `<div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <strong style="color:#7a8a94;">Current Premium:</strong> $${premium.mid?.toFixed(2) || premium.bid?.toFixed(2) || '?'} per share
                <span style="color:#666; margin-left:10px;">(bid $${premium.bid?.toFixed(2)} / ask $${premium.ask?.toFixed(2)})</span>
                ${premium.delta ? `<span style="margin-left:15px; color:#00d9ff;">Δ ${(Math.abs(premium.delta) * 100).toFixed(0)}%</span>` : ''}
                ${premium.iv ? `<span style="margin-left:15px; color:#ffaa00;">IV ${premium.iv}%</span>` : ''}
            </div>` : '';
        
        // Show selection rationale (why this DTE was chosen)
        const rationaleInfo = selectionRationale?.summary ? 
            `<div style="background:rgba(0,217,255,0.1); padding:10px 12px; border-radius:6px; margin-bottom:16px; border-left:3px solid #00d9ff;">
                <span style="color:#00d9ff; font-size:12px;">🧠 <strong>Why this expiry?</strong></span>
                <span style="color:#aaa; font-size:12px; margin-left:8px;">${selectionRationale.summary}</span>
            </div>` : '';
        
        document.getElementById('xDeepDiveContent').innerHTML = `
            <div style="background:rgba(29,161,242,0.1); padding:12px; border-radius:8px; margin-bottom:16px;">
                <strong style="color:#1da1f2;">${ticker}</strong> @ $${price?.toFixed(2) || '?'}
                <span style="margin-left:20px;">Analyzing: <span style="color:#00ff88;">Sell $${strike} Put</span> expiring ${expiryDisplay}</span>
                <span style="color:#666; font-size:10px; margin-left:10px;">(real chain data)</span>
            </div>
            ${rationaleInfo}
            ${premiumInfo}
            <div style="white-space:pre-wrap;">${formatted}</div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:10px;">
                <button id="xDeepDiveStageBtn" 
                    style="padding:10px 20px; background:#00ff88; border:none; border-radius:6px; color:#000; font-weight:bold; cursor:pointer;">
                    📋 Stage This Trade
                </button>
                <button onclick="this.closest('#xDeepDiveModal').remove()" 
                    style="padding:10px 20px; background:#333; border:none; border-radius:6px; color:#fff; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        
        // Attach click handler with closure to preserve analysis text and premium
        document.getElementById('xDeepDiveStageBtn').onclick = () => {
            window.stageFromXSentiment(ticker, price, strike, expiry, result.analysis, premium?.mid || premium?.bid);
            document.getElementById('xDeepDiveModal')?.remove();
        };
        
    } catch (e) {
        console.error('X Deep Dive error:', e);
        document.getElementById('xDeepDiveContent').innerHTML = `
            <div style="color:#ff5252; text-align:center; padding:20px;">
                ❌ ${e.message}
                <br><br>
                <button onclick="this.closest('#xDeepDiveModal').remove()" 
                    style="padding:8px 16px; background:#333; border:none; border-radius:6px; color:#fff; cursor:pointer;">
                    Close
                </button>
            </div>
        `;
    }
};

/**
 * Stage a trade from X Sentiment Deep Dive
 */
window.stageFromXSentiment = function(ticker, price, strike, expiry, analysis, cboPremium) {
    console.log('[Stage] Starting stage for', ticker, strike, expiry, 'premium:', cboPremium);
    
    // Close modal
    document.getElementById('xDeepDiveModal')?.remove();
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade with X Sentiment source
    const trade = {
        id: Date.now(),
        ticker: ticker,
        type: 'short_put',
        strike: parseFloat(strike),
        expiry: expiry,
        currentPrice: parseFloat(price),
        premium: cboPremium ? parseFloat(cboPremium) : 0,  // Use CBOE premium if available
        isCall: false,  // Short put
        isDebit: false, // Sold = credit
        stagedAt: new Date().toISOString(),
        source: 'x-sentiment',
        // Store thesis if analysis provided
        openingThesis: analysis ? {
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(price),
            source: 'X/Twitter Sentiment → Deep Dive',
            aiSummary: {
                fullAnalysis: analysis
            }
        } : null
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${ticker} $${strike} put, ${expiry} (with thesis)`, 'success');
    
    // Switch to Positions tab
    const positionsTab = document.querySelector('.tab-btn[data-tab="positions"]');
    if (positionsTab) positionsTab.click();
    
    // Render pending trades
    setTimeout(() => {
        window.renderPendingTrades?.();
    }, 100);
};

/**
 * Get AI-powered trade ideas
 */
window.getTradeIdeas = async function() {
    const ideaBtn = document.getElementById('ideaBtn');
    const ideaResults = document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContent');
    
    if (!ideaBtn || !ideaResults || !ideaContent) return;
    
    // Get inputs
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid')?.value || '';
    const selectedModel = window.getSelectedAIModel?.('ideaModelSelect') || 'qwen2.5:32b';
    
    // Check if X trending tickers should be included
    const useXTickers = document.getElementById('useXTickers')?.checked;
    const xTrendingTickers = (useXTickers && window._xTrendingTickers?.length > 0) ? window._xTrendingTickers : [];
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaBtn.textContent = '⏳ Generating...';
    ideaResults.style.display = 'block';
    const xNote = xTrendingTickers.length > 0 ? ` (including ${xTrendingTickers.length} from X)` : '';
    ideaContent.innerHTML = `<span style="color:#888;">🔄 AI is researching trade ideas${xNote}... (15-30 seconds)</span>`;
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel,
                xTrendingTickers,  // Pass X tickers to backend
                portfolioContext: formatPortfolioContextForAI()  // Include portfolio context from audit
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Store candidates for deep dive
        window._lastTradeIdeas = result.candidates || [];
        
        // Debug: log raw response to see exact format
        console.log('Raw AI response:', result.ideas.substring(0, 500));
        
        // Add Deep Dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                console.log('Deep Dive match:', match, 'Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#7a8a94; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
            });
        
        // Now apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/<span class="dd-ticker" data-ticker="([^"]+)">([^<]+)<\/span>/g, '<span style="color:#00ff88; font-weight:bold;">$2</span>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>');
        
        ideaContent.innerHTML = formatted;
        ideaBtn.textContent = '💡 Generate Ideas';
        ideaBtn.disabled = false;
        
    } catch (e) {
        console.error('Trade ideas error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">Make sure Ollama is running with the selected model installed.</span>`;
        ideaBtn.textContent = '💡 Retry';
        ideaBtn.disabled = false;
    }
};

/**
 * Deep Dive - comprehensive analysis of a single trade
 */
window.deepDive = async function(ticker) {
    // Find the candidate data
    const candidates = window._lastTradeIdeas || [];
    const candidate = candidates.find(c => c.ticker === ticker);
    
    if (!candidate) {
        showNotification(`No data found for ${ticker}`, 'error');
        return;
    }
    
    // Parse the current ideas to find the proposed strike/expiry
    const ideaContent = document.getElementById('ideaContent');
    const ideaText = ideaContent?.textContent || '';
    
    // Try to extract strike and expiry from the idea text
    const strikeMatch = ideaText.match(new RegExp(`${ticker}[^]*?Sell\\s*\\$?(\\d+)\\s*put`, 'i'));
    const expiryMatch = ideaText.match(new RegExp(`${ticker}[^]*?put,?\\s*([A-Z][a-z]+\\s+\\d+)`, 'i'));
    
    const strike = strikeMatch ? strikeMatch[1] : Math.floor(parseFloat(candidate.price) * 0.9);
    
    // Snap expiry to valid Friday (options never expire on weekends)
    // If we can't parse expiry, use 3rd Friday of next month
    const rawExpiry = expiryMatch ? expiryMatch[1] : null;
    let expiry = snapToFriday(rawExpiry);
    
    // Validate expiry is in proper format (Mon DD or Mon DD, YYYY)
    // If it looks wrong, fall back to third Friday
    if (!/^[A-Z][a-z]{2}\s+\d{1,2}/.test(expiry)) {
        console.log(`[Deep Dive] Invalid expiry "${expiry}", using third Friday fallback`);
        expiry = formatExpiryShort(getThirdFriday(1));
    }
    
    const selectedModel = window.getSelectedAIModel?.('globalAiModelSelect') || 
                          window.getSelectedAIModel?.('ideaModelSelect2') || 
                          window.getSelectedAIModel?.('ideaModelSelect') || 
                          'qwen2.5:32b';
    
    console.log(`[Deep Dive] Using model: ${selectedModel}`);
    
    // Show modal with loading state
    const modal = document.createElement('div');
    modal.id = 'deepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#7a8a94;">🔍 Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#deepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div class="deepdive-header-info" style="color:#888; margin-bottom:16px;">
                Analyzing ${ticker}... (backend selecting optimal strike/expiry)
            </div>
            <div id="deepDiveRationale"></div>
            <div id="deepDiveContent" style="color:#ddd; font-size:13px; line-height:1.7;">
                <div style="text-align:center; padding:40px; color:#888;">
                    ⏳ Running comprehensive analysis with smart expiry selection...
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        // Let backend do smart expiry selection - don't send expiry
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                // Don't send strike or expiry - let backend find optimal based on ROC
                currentPrice: candidate.price,
                model: selectedModel,
                targetDelta: 0.20  // Conservative delta target
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Use backend-selected strike and expiry (from smart ROC analysis)
        const actualStrike = result.strike || strike;
        const actualExpiry = result.expiry || expiry;
        const selectionRationale = result.selectionRationale;
        
        // Format expiry for display
        const formatExp = (exp) => {
            if (!exp) return 'N/A';
            if (/^[A-Z][a-z]{2}\s\d+/.test(exp)) return exp;
            const match = exp.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (match) {
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return `${months[parseInt(match[2]) - 1]} ${parseInt(match[3])}`;
            }
            return exp;
        };
        
        // Update modal header with actual backend-selected values
        const headerEl = modal.querySelector('.deepdive-header-info');
        if (headerEl) {
            headerEl.innerHTML = `Analyzing: <span style="color:#00ff88;">Sell $${actualStrike} put</span>, ${formatExp(actualExpiry)} | Current: $${candidate.price}`;
        }
        
        // Show selection rationale (why this expiry was chosen)
        const rationaleEl = document.getElementById('deepDiveRationale');
        if (rationaleEl && selectionRationale?.summary) {
            rationaleEl.innerHTML = `
                <div style="background:rgba(0,217,255,0.1); padding:10px 12px; border-radius:6px; margin-bottom:16px; border-left:3px solid #00d9ff;">
                    <span style="color:#00d9ff; font-size:12px;">🧠 <strong>Why this expiry?</strong></span>
                    <span style="color:#aaa; font-size:12px; margin-left:8px;">${selectionRationale.summary}</span>
                </div>`;
        }
        
        // Format the analysis
        let formatted = result.analysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(✅ ENTER TRADE)/g, '<span style="color:#00ff88; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(⚠️ WAIT)/g, '<span style="color:#ffaa00; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(❌ AVOID)/g, '<span style="color:#ff5252; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(Strong Buy|Buy|Neutral|Avoid)/g, (match) => {
                const colors = { 'Strong Buy': '#00ff88', 'Buy': '#00d9ff', 'Neutral': '#ffaa00', 'Avoid': '#ff5252' };
                return `<span style="color:${colors[match] || '#fff'}; font-weight:bold;">${match}</span>`;
            })
            .replace(/(Bull case|Base case|Bear case|Disaster case)/gi, '<span style="color:#7a8a94; font-weight:bold;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Add premium info if available
        let premiumHtml = '';
        if (result.premium) {
            const p = result.premium;
            const source = p.source === 'schwab' ? '🔴 Schwab (real-time)' : '🔵 CBOE (15-min delay)';
            
            // Use backend-selected actual strike
            const strikeNote = '';  // Backend already picked optimal strike
            
            // Calculate DTE from backend-selected expiry
            let dte = selectionRationale?.dte || 30;
            let annualizedRoc = selectionRationale?.annualizedROC || 0;
            
            // Fallback calculation if not in rationale
            if (!annualizedRoc && actualExpiry) {
                const expiryMatch = actualExpiry.match(/(\d{4})-(\d{2})-(\d{2})/);
                if (expiryMatch) {
                    const expDate = new Date(expiryMatch[1], parseInt(expiryMatch[2]) - 1, expiryMatch[3]);
                    dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
                }
                const roc = (p.mid / actualStrike) * 100;
                annualizedRoc = (roc * (365 / dte)).toFixed(1);
            }
            
            const roc = (p.mid / actualStrike) * 100;
            
            // Probability of profit from delta
            let probProfit = '';
            if (p.delta) {
                const pop = ((1 - Math.abs(p.delta)) * 100).toFixed(0);
                probProfit = `<div style="color:#00ff88;">Win Prob: ~${pop}%</div>`;
            }
            
            premiumHtml = `
                <div style="background:#1e3a5f; border:1px solid #00d9ff; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#00d9ff; font-weight:bold; margin-bottom:8px;">💰 ${source}</div>
                    ${strikeNote}
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; font-size:12px;">
                        <div>Bid: <span style="color:#00ff88;">$${p.bid.toFixed(2)}</span></div>
                        <div>Ask: <span style="color:#ffaa00;">$${p.ask.toFixed(2)}</span></div>
                        <div>Mid: <span style="color:#fff;">$${p.mid.toFixed(2)}</span></div>
                        <div>Volume: ${p.volume}</div>
                        <div>OI: ${p.openInterest}</div>
                        ${p.iv ? `<div>IV: ${p.iv}%</div>` : ''}
                        ${probProfit}
                        ${p.delta ? `<div>Delta: ${p.delta.toFixed(2)}</div>` : ''}
                        ${p.theta ? `<div>Theta: ${p.theta.toFixed(3)}</div>` : ''}
                    </div>
                    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #335577; display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; font-size:12px;">
                        <div>Premium: <span style="color:#00ff88;">$${(p.mid * 100).toFixed(0)}</span>/contract</div>
                        <div>ROC: <span style="color:#00ff88;">${roc.toFixed(2)}%</span> (${typeof annualizedRoc === 'number' ? annualizedRoc.toFixed(0) : annualizedRoc}% ann.)</div>
                        <div>DTE: ${dte} days</div>
                        <div>Cost Basis: <span style="color:#ffaa00;">$${(actualStrike - p.mid).toFixed(2)}</span>/sh</div>
                    </div>
                </div>`;
        }
        
        // Store thesis data for staging (using backend-selected values)
        const price = parseFloat(candidate.price);
        const rangeHigh = result.tickerData?.threeMonthHigh;
        const rangeLow = result.tickerData?.threeMonthLow;
        const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
            Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
        
        window._currentThesis = {
            ticker,
            strike: parseFloat(actualStrike),
            expiry: actualExpiry,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: price,
            premium: result.premium || null,
            tickerData: result.tickerData || {},
            aiAnalysis: result.analysis,
            selectionRationale: selectionRationale || null,
            // Extract key thesis points
            support: result.tickerData?.recentSupport || [],
            sma20: result.tickerData?.sma20,
            sma50: result.tickerData?.sma50,
            earnings: result.tickerData?.earnings,
            rangeHigh,
            rangeLow,
            rangePosition  // 0% = at low, 100% = at high
        };
        
        // Build alert buttons for Fibonacci levels
        let alertSectionHtml = '';
        const ta = result.tickerData?.technicalAnalysis;
        if (ta?.fibonacci?.fibLevels) {
            const fibLevels = ta.fibonacci.fibLevels
                .filter(f => f.price < price)  // Only support levels below current price
                .sort((a, b) => b.price - a.price)  // Highest to lowest
                .slice(0, 4);  // Top 4 support levels
            
            if (fibLevels.length > 0) {
                const alertButtons = fibLevels.map(fib => {
                    const suggestedStrike = Math.floor(fib.price / 5) * 5;  // Round down to nearest $5
                    return `
                        <button onclick="window.addPriceAlert('${ticker}', ${fib.price.toFixed(2)}, '${fib.level}', ${suggestedStrike})"
                                style="background:#1a1a2e; border:1px solid #ffaa00; color:#ffaa00; padding:8px 12px; border-radius:6px; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;">
                            <span>🔔</span>
                            <span>$${fib.price.toFixed(2)} <span style="opacity:0.7">(${fib.level})</span></span>
                        </button>`;
                }).join('');
                
                alertSectionHtml = `
                    <div style="background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3); border-radius:8px; padding:12px; margin-top:16px;">
                        <div style="color:#ffaa00; font-weight:bold; margin-bottom:8px; font-size:13px;">
                            🎯 Set Price Alert (notify when ${ticker} approaches support)
                        </div>
                        <div style="display:flex; flex-wrap:wrap; gap:8px;">
                            ${alertButtons}
                        </div>
                        <div style="color:#888; font-size:11px; margin-top:8px;">
                            Alerts trigger when price is within 3% of target
                        </div>
                    </div>`;
            }
        }
        
        // Add Stage Trade button
        const stageButtonHtml = `
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageTradeWithThesis()" 
                        style="background:#7a8a94; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#deepDiveModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>`;
        
        document.getElementById('deepDiveContent').innerHTML = premiumHtml + formatted + alertSectionHtml + stageButtonHtml;
        
    } catch (e) {
        document.getElementById('deepDiveContent').innerHTML = `
            <div style="color:#ff5252; text-align:center; padding:20px;">
                ❌ ${e.message}
            </div>
        `;
    }
};

/**
 * Analyze a Discord trade callout
 * Parses the trade text, fetches data, and runs AI analysis
 * @param {string} tradeTextOverride - Optional: pass text directly instead of reading from DOM
 * @param {string} modelOverride - Optional: pass model directly instead of reading from DOM
 */
window.analyzeDiscordTrade = async function(tradeTextOverride, modelOverride) {
    // Use overrides if provided, otherwise read from DOM
    let tradeText, model;
    
    if (tradeTextOverride) {
        tradeText = tradeTextOverride;
        model = modelOverride || 'deepseek-r1:32b';
    } else {
        const textarea = document.getElementById('pasteTradeInput');
        tradeText = textarea?.value?.trim();
        // Discord has its own selector, but falls back to global
        const discordModelSelect = document.getElementById('discordModelSelect');
        model = discordModelSelect?.value || window.getSelectedAIModel?.() || 'deepseek-r1:32b';
    }
    
    if (!tradeText) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }

    // Create modal with loading state
    const modal = document.createElement('div');
    modal.id = 'discordTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Progress steps for display
    const stepLabels = [
        'Extract trade details',
        'Fetch market data', 
        'Get CBOE pricing',
        'AI analysis'
    ];
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:25px; border:1px solid rgba(139,92,246,0.5);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="margin:0; color:#8a9aa8;">📋 Discord Trade Analysis</h2>
                <button onclick="this.closest('#discordTradeModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="discordTradeContent" style="color:#ccc;">
                <div style="text-align:center; padding:40px;">
                    <div class="spinner" style="width:50px; height:50px; border:3px solid #333; border-top:3px solid #8a9aa8; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 20px;"></div>
                    <p id="discordProgressText" style="font-size:16px; color:#8a9aa8;">Initializing...</p>
                    <div id="discordProgressSteps" style="margin-top:20px; text-align:left; display:inline-block;">
                        ${stepLabels.map((label, i) => `
                            <div id="discordStep${i+1}" style="padding:6px 0; color:#666;">
                                <span style="display:inline-block; width:24px; text-align:center;">○</span> ${label}
                            </div>
                        `).join('')}
                    </div>
                    <p id="discordElapsed" style="font-size:12px; color:#555; margin-top:15px;">Elapsed: 0s</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Start elapsed timer
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const elapsedEl = document.getElementById('discordElapsed');
        if (elapsedEl) {
            elapsedEl.textContent = `Elapsed: ${elapsed}s`;
            if (elapsed > 30) {
                elapsedEl.style.color = '#ffaa00';
                elapsedEl.textContent += ' (larger models take longer to load)';
            }
        }
    }, 1000);
    
    // Helper to update step UI
    const updateStep = (stepNum, status, message) => {
        const stepEl = document.getElementById(`discordStep${stepNum}`);
        const progressText = document.getElementById('discordProgressText');
        if (stepEl) {
            const icon = status === 'done' ? '✓' : status === 'active' ? '●' : '○';
            const color = status === 'done' ? '#00ff88' : status === 'active' ? '#8a9aa8' : '#666';
            stepEl.style.color = color;
            stepEl.querySelector('span').textContent = icon;
        }
        if (progressText && message) {
            progressText.textContent = message;
        }
    };
    
    try {
        // Gather closed positions summary for pattern matching
        // The server will use this to provide historical context
        const closedPositions = state.closedPositions || [];
        const closedSummary = closedPositions.length > 0 ? closedPositions.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            pnl: p.realizedPnL ?? p.closePnL ?? 0,
            closeDate: p.closeDate
        })) : null;
        
        // Use SSE for real-time progress
        const response = await fetch('/api/ai/parse-trade', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ tradeText, model, closedSummary })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // Keep incomplete chunk
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        // Mark previous steps as done
                        for (let i = 1; i < data.step; i++) {
                            updateStep(i, 'done');
                        }
                        // Mark current step as active
                        updateStep(data.step, 'active', data.message);
                    } else if (data.type === 'complete') {
                        // All steps done
                        for (let i = 1; i <= 4; i++) updateStep(i, 'done');
                        result = data;
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
        
        clearInterval(timerInterval);
        
        if (!result || result.error) {
            throw new Error(result?.error || 'No response received');
        }
        
        const { parsed, tickerData, premium, analysis } = result;
        
        // Helper: Convert markdown tables to HTML tables
        const convertMarkdownTables = (text) => {
            // More robust regex - handles various whitespace and separator formats
            // Pattern: header row | col | col |, separator row |---|---|, data rows
            const lines = text.split('\n');
            let result = [];
            let i = 0;
            
            while (i < lines.length) {
                const line = lines[i];
                
                // Check if this line looks like a table header (starts and ends with |, has multiple |)
                if (line.trim().startsWith('|') && line.trim().endsWith('|') && (line.match(/\|/g) || []).length >= 3) {
                    // Check if next line is separator (contains only |, -, :, spaces)
                    const nextLine = lines[i + 1] || '';
                    if (/^\|[\s\-:|]+\|$/.test(nextLine.trim())) {
                        // This is a table! Collect all rows
                        const tableLines = [line];
                        let j = i + 1;
                        
                        // Skip separator and collect data rows
                        while (j < lines.length && lines[j].trim().startsWith('|')) {
                            tableLines.push(lines[j]);
                            j++;
                        }
                        
                        // Parse and convert to HTML
                        if (tableLines.length >= 3) {
                            const headerCells = tableLines[0].split('|').map(c => c.trim()).filter(c => c);
                            const dataRows = tableLines.slice(2).map(row => 
                                row.split('|').map(c => c.trim()).filter(c => c)
                            ).filter(row => row.length > 0);
                            
                            let html = `<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:13px; background:#0a0a14;">`;
                            html += `<thead><tr style="background:#1a1a2e;">`;
                            headerCells.forEach(cell => {
                                html += `<th style="padding:10px 14px; border:1px solid #333; text-align:left; color:#8a9aa8; font-weight:600;">${cell}</th>`;
                            });
                            html += `</tr></thead><tbody>`;
                            
                            dataRows.forEach(row => {
                                html += `<tr style="background:#0d0d1a;">`;
                                row.forEach(cell => {
                                    html += `<td style="padding:10px 14px; border:1px solid #333; color:#ccc;">${cell}</td>`;
                                });
                                html += `</tr>`;
                            });
                            
                            html += `</tbody></table>`;
                            result.push(html);
                            i = j;
                            continue;
                        }
                    }
                }
                
                result.push(line);
                i++;
            }
            
            return result.join('\n');
        };
        
        // Format the analysis
        const formatted = convertMarkdownTables(analysis)
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#8a9aa8;">$1</strong>')
            .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
            .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
            .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
            .replace(/\n/g, '<br>');
        
        // Build strike display
        const isSpread = parsed.buyStrike || parsed.sellStrike;
        const strikeDisplay = isSpread 
            ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
            : `$${parsed.strike}`;
        
        // Validate callout premium: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumForStorage = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50 
            ? parseFloat(parsed.premium) 
            : null;
        
        // Get the model used for this analysis (Discord override or global)
        const discordModelSelect = document.getElementById('discordModelSelect');
        const modelUsed = discordModelSelect?.value || window.getSelectedAIModel?.() || 'deepseek-r1:32b';
        
        // Store parsed data for staging
        window._currentParsedTrade = {
            ticker: parsed.ticker,
            strike: parsed.strike || parsed.sellStrike,
            buyStrike: parsed.buyStrike,
            sellStrike: parsed.sellStrike,
            expiry: parsed.expiry,
            strategy: parsed.strategy,
            contracts: parsed.contracts || 1,
            isSpread,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(tickerData.price),
            premium: premium || { mid: calloutPremiumForStorage || 0 },
            calloutPremium: calloutPremiumForStorage,  // Store separately for clarity
            iv: premium?.iv || null,  // Store IV at time of analysis
            modelUsed,  // Store which AI model was used
            tickerData,
            aiAnalysis: analysis,
            support: tickerData.recentSupport || [],
            sma20: tickerData.sma20,
            sma50: tickerData.sma50,
            earnings: tickerData.earnings,
            rangeHigh: tickerData.threeMonthHigh,
            rangeLow: tickerData.threeMonthLow
        };
        
        // Premium section - logic differs for selling vs buying
        // Validate: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumValid = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50;
        const effectivePremium = calloutPremiumValid ? parseFloat(parsed.premium) : (premium?.mid || 0);
        
        const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                          parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
        let premiumHtml = '';
        if (premium) {
            let entryQuality = '';
            if (calloutPremiumValid && premium.mid) {
                if (isSelling) {
                    // Selling: want to get MORE than mid
                    entryQuality = parsed.premium >= premium.mid 
                        ? '✅ got ≥ mid' 
                        : `⚠️ got ${Math.round((1 - parsed.premium/premium.mid) * 100)}% less than mid`;
                } else {
                    // Buying: want to pay LESS than mid  
                    entryQuality = parsed.premium <= premium.mid 
                        ? '✅ paid ≤ mid' 
                        : `⚠️ paid ${Math.round((parsed.premium/premium.mid - 1) * 100)}% more than mid`;
                }
            }
            const discrepancy = calloutPremiumValid && Math.abs(premium.mid - parsed.premium) > 0.5;
            premiumHtml = `
                <div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:15px; border:1px solid rgba(139,92,246,0.3);">
                    <div style="font-weight:bold; color:#8a9aa8; margin-bottom:6px;">💰 Live CBOE Pricing</div>
                    <div style="font-size:13px;">
                        Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
                        ${premium.iv ? ` | IV: ${premium.iv}%` : ''}
                        ${calloutPremiumValid ? `<br>Callout Entry: $${parsed.premium} ${entryQuality}` : '<br>Callout Entry: Not specified - using live mid'}
                        ${discrepancy ? '<br><span style="color:#ff5252;">⚠️ Large discrepancy - callout may be stale!</span>' : ''}
                    </div>
                </div>`;
        }
        
        // Show results
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#0d0d1a; padding:15px; border-radius:8px; margin-bottom:15px;">
                <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:15px; text-align:center;">
                    <div>
                        <div style="font-size:12px; color:#888;">Ticker</div>
                        <div style="font-size:20px; font-weight:bold; color:#00d9ff;">${parsed.ticker}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strategy</div>
                        <div style="font-size:14px; font-weight:bold; color:#8a9aa8;">${parsed.strategy?.replace(/_/g, ' ') || 'Unknown'}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strike</div>
                        <div style="font-size:16px; font-weight:bold;">${strikeDisplay}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Expiry</div>
                        <div style="font-size:16px; font-weight:bold;">${parsed.expiry}</div>
                    </div>
                </div>
                <div style="margin-top:10px; text-align:center; font-size:13px;">
                    Current Price: <strong style="color:#00d9ff;">$${parseFloat(tickerData.price).toFixed(2)}</strong>
                </div>
            </div>
            ${premiumHtml}
            <div style="background:#0d0d1a; padding:20px; border-radius:8px;">
                <h4 style="margin:0 0 15px; color:#8a9aa8;">AI Analysis</h4>
                <div style="white-space:pre-wrap; line-height:1.6; font-size:14px;">${formatted}</div>
            </div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <button onclick="window.stageDiscordTrade()" 
                        style="background:#7a8a94; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="window.attachThesisToPosition()" 
                        style="background:#00d9ff; color:#000; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    🔗 Attach to Existing Position
                </button>
                <button onclick="this.closest('#discordTradeModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        clearInterval(timerInterval);
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#3a1a1a; padding:20px; border-radius:8px; border:1px solid #ff5252;">
                <h4 style="color:#ff5252; margin:0 0 10px;">❌ Analysis Failed</h4>
                <p style="color:#ccc; margin:0;">${err.message}</p>
                <p style="color:#888; font-size:12px; margin-top:10px;">Try a clearer format like:<br>
                Ticker: XYZ<br>Strategy: Short Put<br>Strike: $100<br>Expiry: Feb 21<br>Entry: $2.50</p>
            </div>
        `;
    }
};

/**
 * Stage a trade from Discord callout analysis
 */
window.stageDiscordTrade = function() {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === trade.ticker && p.strike === trade.strike && p.expiry === trade.expiry);
    if (exists) {
        showNotification(`${trade.ticker} $${trade.strike} already staged`, 'info');
        return;
    }
    
    // Calculate range position
    const price = trade.priceAtAnalysis;
    const rangeHigh = parseFloat(trade.rangeHigh) || 0;
    const rangeLow = parseFloat(trade.rangeLow) || 0;
    const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
        Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
    
    // Determine position type
    let posType = 'short_put'; // default
    if (trade.strategy) {
        const strat = trade.strategy.toLowerCase();
        if (strat.includes('bull_put') || strat.includes('put_credit')) posType = 'put_credit_spread';
        else if (strat.includes('bear_call') || strat.includes('call_credit')) posType = 'call_credit_spread';
        else if (strat.includes('call_debit') || strat.includes('bull_call')) posType = 'call_debit_spread';
        else if (strat.includes('put_debit') || strat.includes('bear_put')) posType = 'put_debit_spread';
        else if (strat.includes('short_call') || strat.includes('covered')) posType = 'short_call';
        else if (strat.includes('short_put') || strat.includes('cash')) posType = 'short_put';
    }
    
    // Determine if call or put, debit or credit
    const isCallType = posType.includes('call');
    const isDebitType = posType.includes('long') || posType.includes('debit');
    const isSpread = posType.includes('_spread');
    
    // For spreads, calculate proper strike (sell) and upperStrike (buy) based on spread type
    // - Credit spreads: you SELL the more expensive strike (closer to spot) and BUY the cheaper one
    // - Put credit spread: sell higher strike, buy lower strike
    // - Call credit spread: sell lower strike, buy higher strike
    // - Debit spreads: opposite (you BUY the more expensive strike)
    let finalStrike = trade.strike;
    let finalUpperStrike = trade.buyStrike || trade.sellStrike;
    
    if (isSpread && trade.buyStrike && trade.sellStrike) {
        const buyNum = parseFloat(trade.buyStrike);
        const sellNum = parseFloat(trade.sellStrike);
        
        if (posType === 'put_credit_spread') {
            // Sell higher put, buy lower put
            finalStrike = Math.max(buyNum, sellNum);
            finalUpperStrike = Math.min(buyNum, sellNum);
        } else if (posType === 'call_credit_spread') {
            // Sell lower call, buy higher call  
            finalStrike = Math.min(buyNum, sellNum);
            finalUpperStrike = Math.max(buyNum, sellNum);
        } else if (posType === 'put_debit_spread') {
            // Buy higher put, sell lower put (bear put spread)
            finalStrike = Math.max(buyNum, sellNum);  // Buy strike
            finalUpperStrike = Math.min(buyNum, sellNum);  // Sell strike
        } else if (posType === 'call_debit_spread') {
            // Buy lower call, sell higher call (bull call spread)
            finalStrike = Math.min(buyNum, sellNum);  // Buy strike
            finalUpperStrike = Math.max(buyNum, sellNum);  // Sell strike
        }
        console.log(`[STAGE-DISCORD] Spread staging: ${posType} strike=$${finalStrike}, upperStrike=$${finalUpperStrike}`);
    } else if (isSpread && trade.sellStrike) {
        // Fallback if only sellStrike is provided
        finalStrike = parseFloat(trade.sellStrike);
        console.log(`[STAGE-DISCORD] Spread staging fallback: strike=$${finalStrike}`);
    }
    
    // Create pending trade with thesis
    const pendingTrade = {
        id: Date.now(),
        ticker: trade.ticker,
        type: posType,
        strike: finalStrike,
        buyStrike: trade.buyStrike,
        sellStrike: trade.sellStrike,
        upperStrike: finalUpperStrike,  // For spread display
        expiry: trade.expiry,
        currentPrice: trade.priceAtAnalysis,
        premium: trade.premium?.mid || trade.calloutPremium || 0,
        contracts: trade.contracts || 1,
        isCall: isCallType,
        isDebit: isDebitType,
        stagedAt: new Date().toISOString(),
        source: 'discord', // Mark as Discord import
        // THESIS DATA
        openingThesis: {
            analyzedAt: trade.analyzedAt,
            priceAtAnalysis: trade.priceAtAnalysis,
            support: trade.support,
            sma20: trade.sma20,
            sma50: trade.sma50,
            earnings: trade.earnings,
            rangeHigh: trade.rangeHigh,
            rangeLow: trade.rangeLow,
            rangePosition,
            premium: trade.premium,
            iv: trade.iv,  // IV at time of analysis
            modelUsed: trade.modelUsed,  // AI model used
            aiSummary: extractThesisSummary(trade.aiAnalysis)
        }
    };
    
    pending.push(pendingTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged from Discord: ${trade.ticker} ${posType.replace(/_/g, ' ')}`, 'success');
    
    // Close modal and clear
    document.getElementById('discordTradeModal')?.remove();
    window._currentParsedTrade = null;
    
    // Clear textarea
    const textarea = document.getElementById('pasteTradeInput');
    if (textarea) textarea.value = '';
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Attach thesis from Discord analysis to an existing position
 */
window.attachThesisToPosition = function() {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Get positions from localStorage
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    
    // Find matching positions (same ticker)
    const matchingPositions = positions.filter(p => 
        p.ticker.toUpperCase() === trade.ticker.toUpperCase() && 
        p.status !== 'closed'
    );
    
    if (matchingPositions.length === 0) {
        showNotification(`No open positions found for ${trade.ticker}`, 'error');
        return;
    }
    
    // If only one match, attach directly
    if (matchingPositions.length === 1) {
        attachThesisToPositionById(matchingPositions[0].id);
        return;
    }
    
    // Multiple matches - show picker modal
    const pickerModal = document.createElement('div');
    pickerModal.id = 'thesisPickerModal';
    pickerModal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10001;';
    pickerModal.onclick = (e) => { if (e.target === pickerModal) pickerModal.remove(); };
    
    const positionButtons = matchingPositions.map(p => {
        const typeDisplay = p.type.replace(/_/g, ' ').toUpperCase();
        const dte = Math.ceil((new Date(p.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        return `
            <button onclick="window.attachThesisToPositionById(${p.id}); this.closest('#thesisPickerModal').remove();"
                    style="background:#1a1a2e; border:1px solid #7a8a94; color:#fff; padding:15px; border-radius:8px; cursor:pointer; text-align:left; width:100%;">
                <div style="font-weight:bold; color:#7a8a94;">${p.ticker} $${p.strike} ${typeDisplay}</div>
                <div style="font-size:12px; color:#888;">Expires: ${p.expiry} (${dte} DTE) | ${p.contracts} contract${p.contracts > 1 ? 's' : ''}</div>
            </button>
        `;
    }).join('');
    
    pickerModal.innerHTML = `
        <div style="background:#0d0d1a; border-radius:12px; max-width:500px; width:100%; padding:25px; border:1px solid #7a8a94;">
            <h3 style="color:#7a8a94; margin:0 0 15px;">🔗 Select Position to Attach Thesis</h3>
            <p style="color:#888; margin-bottom:15px;">Multiple ${trade.ticker} positions found. Select one:</p>
            <div style="display:flex; flex-direction:column; gap:10px;">
                ${positionButtons}
            </div>
            <button onclick="this.closest('#thesisPickerModal').remove()" 
                    style="margin-top:15px; background:#333; color:#888; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; width:100%;">
                Cancel
            </button>
        </div>
    `;
    
    document.body.appendChild(pickerModal);
};

/**
 * Attach thesis to a specific position by ID
 */
window.attachThesisToPositionById = function(positionId) {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Get positions from state (the source of truth)
    const positions = window.state?.positions || JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const posIdx = positions.findIndex(p => p.id === positionId);
    
    if (posIdx < 0) {
        showNotification('Position not found', 'error');
        return;
    }
    
    const pos = positions[posIdx];
    
    // Calculate range position
    const price = trade.priceAtAnalysis;
    const rangeHigh = parseFloat(trade.rangeHigh) || 0;
    const rangeLow = parseFloat(trade.rangeLow) || 0;
    const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
        Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
    
    // Build opening thesis object
    pos.openingThesis = {
        analyzedAt: new Date().toISOString(),
        priceAtAnalysis: price,
        rangePosition: rangePosition,
        iv: trade.iv || null,
        modelUsed: trade.model || 'deepseek-r1:32b',
        aiSummary: {
            aggressive: trade.spectrum?.aggressive || '',
            moderate: trade.spectrum?.moderate || '',
            conservative: trade.spectrum?.conservative || '',
            bottomLine: trade.spectrum?.bottomLine || '',
            probability: trade.probability || null,
            fullAnalysis: trade.analysis || ''
        }
    };
    
    // Update state and save
    if (window.state?.positions) {
        window.state.positions[posIdx] = pos;
    }
    
    // Save to localStorage - ALWAYS save directly as well for reliability
    try {
        const toSave = window.state?.positions || positions;
        localStorage.setItem('wheelhouse_positions', JSON.stringify(toSave));
        console.log(`[AttachThesis] Saved ${pos.ticker} with thesis to localStorage`);
        console.log('[AttachThesis] Thesis preview:', JSON.stringify(pos.openingThesis).substring(0, 200));
        
        // Also trigger auto-save to file if available
        if (window.savePositionsToStorage) {
            window.savePositionsToStorage();
        }
    } catch (e) {
        console.error('[AttachThesis] Failed to save:', e);
    }
    
    showNotification(`✅ Thesis attached to ${pos.ticker} $${pos.strike}`, 'success');
    
    // Re-render positions table to show the 🩺 button
    if (window.renderPositions) {
        window.renderPositions();
    }
    
    // Close modals
    document.getElementById('discordTradeModal')?.remove();
    document.getElementById('thesisPickerModal')?.remove();
    window._currentParsedTrade = null;
    
    // Clear textarea
    const textarea = document.getElementById('pasteTradeInput');
    if (textarea) textarea.value = '';
};


// ============================================================
// stageTradeWithThesis - stages trade from Deep Dive with thesis data
// ============================================================

window.stageTradeWithThesis = function() {
    const thesis = window._currentThesis;
    if (!thesis) {
        showNotification('No thesis data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === thesis.ticker && p.strike === thesis.strike && p.expiry === thesis.expiry);
    if (exists) {
        showNotification(`${thesis.ticker} $${thesis.strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade with full thesis
    const trade = {
        id: Date.now(),
        ticker: thesis.ticker,
        type: 'short_put',  // Deep dive is typically for puts
        strike: thesis.strike,
        expiry: thesis.expiry,
        currentPrice: thesis.priceAtAnalysis,
        premium: thesis.premium?.mid || 0,
        isCall: false,
        isDebit: false,  // Short put = credit
        stagedAt: new Date().toISOString(),
        // THESIS DATA - for checkup later
        openingThesis: {
            analyzedAt: thesis.analyzedAt,
            priceAtAnalysis: thesis.priceAtAnalysis,
            support: thesis.support,
            sma20: thesis.sma20,
            sma50: thesis.sma50,
            earnings: thesis.earnings,
            rangeHigh: thesis.rangeHigh,
            rangeLow: thesis.rangeLow,
            rangePosition: thesis.rangePosition,  // 0% = at 3mo low, 100% = at 3mo high
            premium: thesis.premium,
            iv: thesis.premium?.iv || thesis.tickerData?.iv || null,
            selectionRationale: thesis.selectionRationale || null,  // Why this expiry was chosen
            aiSummary: extractThesisSummary(thesis.aiAnalysis),
            // Store full technical analysis for reference
            technicalAnalysis: thesis.tickerData?.technicalAnalysis || null,
            fibonacci: thesis.tickerData?.technicalAnalysis?.fibonacci || null
        }
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // Log AI prediction for accuracy tracking
    if (window.logAIPrediction) {
        window.logAIPrediction({
            type: 'entry',
            ticker: thesis.ticker,
            strike: thesis.strike,
            expiry: thesis.expiry,
            positionType: 'short_put',
            recommendation: 'ENTER',
            confidence: trade.openingThesis?.aiSummary?.probability || null,
            model: thesis.model || 'ollama',
            spot: thesis.priceAtAnalysis,
            premium: thesis.premium?.mid || 0
        });
    }
    
    showNotification(`📥 Staged: ${thesis.ticker} $${thesis.strike} put, ${thesis.expiry} (with thesis)`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Clear current thesis
    window._currentThesis = null;
    
    // Render pending trades
    renderPendingTrades();
};

// ES module exports
export const saveAIModelPreference = window.saveAIModelPreference;
export const checkAIStatus = window.checkAIStatus;
export const warmupAIModel = window.warmupAIModel;
export const getXSentiment = window.getXSentiment;
export const xDeepDive = window.xDeepDive;
export const getTradeIdeas = window.getTradeIdeas;
export const deepDive = window.deepDive;
export const analyzeDiscordTrade = window.analyzeDiscordTrade;
export const stageDiscordTrade = window.stageDiscordTrade;
export const stageTradeWithThesis = window.stageTradeWithThesis;
