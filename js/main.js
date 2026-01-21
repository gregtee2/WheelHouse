// WheelHouse - Main Entry Point
// Initialization and tab management

import { state, resetSimulation } from './state.js';
import { draw, drawPayoffChart, drawHistogram, drawPnLChart, drawProbabilityCone, drawHeatMap, drawGreeksChart } from './charts.js';
import { runSingle, runBatch, resetAll } from './simulation.js';
import { priceOptions, calcGreeks } from './pricing.js';
import { calculateRoll, generateRecommendation, suggestOptimalRoll } from './analysis.js';
import { fetchTickerPrice, fetchHeatMapPrice, fetchPositionTickerPrice } from './api.js';
import { loadPositions, addPosition, editPosition, cancelEdit, renderPositions, updatePortfolioSummary } from './positions.js';
import { loadClosedPositions, renderPortfolio, renderHoldings } from './portfolio.js';
import { initChallenges, renderChallenges } from './challenges.js';
import { setupSliders, setupDatePicker, setupPositionDatePicker, setupRollDatePicker, updateDteDisplay, updateResults, updateDataTab, syncToSimulator } from './ui.js';
import { showNotification } from './utils.js';

/**
 * Main initialization
 */
export function init() {
    console.log('🏠 WheelHouse - Wheel Strategy Options Analyzer');
    
    // Setup tabs
    setupTabs();
    
    // Setup sliders and controls
    setupSliders();
    setupDatePicker();
    setupPositionDatePicker();
    setupRollDatePicker();
    
    // Setup buttons
    setupButtons();
    
    // Initial draws
    draw();
    drawPayoffChart();
    updateDteDisplay();
    
    // Load saved positions
    loadPositions();
    loadClosedPositions();
    initChallenges();
    
    // Expose loadPositions to window for staged trade confirmation
    window.loadPositions = loadPositions;
    
    // Render pending trades if any
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
    
    // Check for updates (after a short delay to not block init)
    setTimeout(checkForUpdates, 2000);
    
    // Check AI availability (show/hide AI panel)
    setTimeout(checkAIAvailability, 1000);
    
    console.log('✅ Initialization complete');
}

/**
 * Check if AI Trade Advisor (Ollama) is available
 */
async function checkAIAvailability() {
    const aiPanel = document.getElementById('aiInsightsPanel');
    const aiBtn = document.getElementById('aiInsightBtn');
    const aiContent = document.getElementById('aiInsightContent');
    const modelSelect = document.getElementById('aiModelSelect');
    const modelStatus = document.getElementById('aiModelStatus');
    
    if (!aiPanel) return;
    
    // Restore saved model preference
    const savedModel = localStorage.getItem('wheelhouse_ai_model') || 'qwen2.5:7b';
    if (modelSelect) {
        modelSelect.value = savedModel;
    }
    
    try {
        const res = await fetch('/api/ai/status');
        if (!res.ok) throw new Error('API error');
        
        const data = await res.json();
        
        if (data.available) {
            // AI is ready - show which models are available
            const models = data.models || [];
            const modelNames = models.map(m => m.name);
            console.log('🧠 AI Trade Advisor: Ready. Available models:', modelNames.join(', '));
            
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '1';
            
            // Update model dropdown to show installed status
            if (modelSelect) {
                Array.from(modelSelect.options).forEach(opt => {
                    const isInstalled = modelNames.some(m => m.startsWith(opt.value.split(':')[0]));
                    opt.textContent = opt.textContent.replace(' ✓', '').replace(' (not installed)', '');
                    if (isInstalled) {
                        opt.textContent += ' ✓';
                        opt.disabled = false;
                    } else {
                        opt.textContent += ' (not installed)';
                        opt.disabled = true;
                    }
                });
            }
            
            if (aiContent) {
                aiContent.innerHTML = `Click <b>Get Insight</b> after loading a position for AI-powered analysis.`;
            }
        } else {
            // Ollama not running
            console.log('🧠 AI Trade Advisor: Ollama not running (AI features disabled)');
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '0.5';
            if (aiContent) {
                aiContent.innerHTML = `<span style="color:#888;">AI not available.</span><br>
                    <span style="font-size:10px;">Install Ollama from <a href="https://ollama.com" target="_blank" style="color:#00d9ff;">ollama.com</a> for AI insights.</span>`;
            }
            if (aiBtn) {
                aiBtn.disabled = true;
                aiBtn.title = 'Ollama not running';
            }
            if (modelSelect) modelSelect.disabled = true;
        }
    } catch (e) {
        // Server doesn't support AI endpoint - hide panel entirely
        console.log('🧠 AI Trade Advisor: Not available');
        if (aiPanel) aiPanel.style.display = 'none';
    }
}

/**
 * Save AI model preference to localStorage
 */
window.saveAIModelPreference = function() {
    const modelSelect = document.getElementById('aiModelSelect');
    if (modelSelect) {
        localStorage.setItem('wheelhouse_ai_model', modelSelect.value);
        console.log('AI model preference saved:', modelSelect.value);
    }
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
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'qwen2.5:32b';
    
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
    ideaContent.innerHTML = '<span style="color:#888;">🔄 AI is researching trade ideas... (15-30 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel
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
        
        // First, add Deep Dive buttons BEFORE applying styling
        // Handle both "1. TICKER" and "1. **TICKER" formats (AI sometimes bolds)
        let formatted = result.ideas.replace(/^(\d+\.)\s*\*{0,2}([A-Z]{2,5})\s*@\s*\$[\d.]+\s*-\s*Sell\s*\$[\d.]+\s*put[^*]*\*{0,2}/gm, 
            (match, num, ticker) => {
                console.log('Matched:', match.substring(0, 60), 'Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#8b5cf6; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
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
    const expiry = expiryMatch ? expiryMatch[1] : 'Feb 21';
    
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'qwen2.5:32b';
    
    // Show modal with loading state
    const modal = document.createElement('div');
    modal.id = 'deepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#8b5cf6;">🔍 Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#deepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div style="color:#888; margin-bottom:16px;">
                Analyzing: Sell $${strike} put, ${expiry} | Current: $${candidate.price}
            </div>
            <div id="deepDiveContent" style="color:#ddd; font-size:13px; line-height:1.7;">
                <div style="text-align:center; padding:40px; color:#888;">
                    ⏳ Running comprehensive analysis... (30-60 seconds)
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                strike,
                expiry,
                currentPrice: candidate.price,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
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
            .replace(/(Bull case|Base case|Bear case|Disaster case)/gi, '<span style="color:#8b5cf6; font-weight:bold;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Add premium info if available
        let premiumHtml = '';
        if (result.premium) {
            const p = result.premium;
            premiumHtml = `
                <div style="background:#1e3a5f; border:1px solid #00d9ff; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#00d9ff; font-weight:bold; margin-bottom:8px;">💰 Live CBOE Pricing</div>
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; font-size:12px;">
                        <div>Bid: <span style="color:#00ff88;">$${p.bid.toFixed(2)}</span></div>
                        <div>Ask: <span style="color:#ffaa00;">$${p.ask.toFixed(2)}</span></div>
                        <div>Mid: <span style="color:#fff;">$${p.mid.toFixed(2)}</span></div>
                        <div>Volume: ${p.volume}</div>
                        <div>OI: ${p.openInterest}</div>
                        ${p.iv ? `<div>IV: ${p.iv}%</div>` : ''}
                    </div>
                    <div style="margin-top:8px; color:#888; font-size:11px;">
                        Premium: $${(p.mid * 100).toFixed(0)} per contract | If assigned, cost basis: $${(parseFloat(strike) - p.mid).toFixed(2)}/share
                    </div>
                </div>`;
        }
        
        // Store thesis data for staging
        const price = parseFloat(candidate.price);
        const rangeHigh = result.tickerData?.threeMonthHigh;
        const rangeLow = result.tickerData?.threeMonthLow;
        const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
            Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
        
        window._currentThesis = {
            ticker,
            strike: parseFloat(strike),
            expiry,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: price,
            premium: result.premium || null,
            tickerData: result.tickerData || {},
            aiAnalysis: result.analysis,
            // Extract key thesis points
            support: result.tickerData?.recentSupport || [],
            sma20: result.tickerData?.sma20,
            sma50: result.tickerData?.sma50,
            earnings: result.tickerData?.earnings,
            rangeHigh,
            rangeLow,
            rangePosition  // 0% = at low, 100% = at high
        };
        
        // Add Stage Trade button
        const stageButtonHtml = `
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageTradeWithThesis()" 
                        style="background:#8b5cf6; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#deepDiveModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>`;
        
        document.getElementById('deepDiveContent').innerHTML = premiumHtml + formatted + stageButtonHtml;
        
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
 */
window.analyzeDiscordTrade = async function() {
    const textarea = document.getElementById('pasteTradeInput');
    const tradeText = textarea?.value?.trim();
    
    if (!tradeText) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }
    
    // Get selected model
    const modelSelect = document.getElementById('aiModelSelect');
    const model = modelSelect?.value || 'qwen2.5:7b';
    
    // Create modal with loading state
    const modal = document.createElement('div');
    modal.id = 'discordTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:25px; border:1px solid rgba(139,92,246,0.5);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="margin:0; color:#b9f;">📋 Discord Trade Analysis</h2>
                <button onclick="this.closest('#discordTradeModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="discordTradeContent" style="color:#ccc;">
                <div style="text-align:center; padding:40px;">
                    <div class="spinner" style="width:50px; height:50px; border:3px solid #333; border-top:3px solid #b9f; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 20px;"></div>
                    <p>Parsing trade callout with ${model}...</p>
                    <p style="font-size:12px; color:#666;">Step 1: Extract trade details → Step 2: Fetch market data → Step 3: AI analysis</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const response = await fetch('/api/ai/parse-trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeText, model })
        });
        
        const result = await response.json();
        
        if (result.error) {
            throw new Error(result.error);
        }
        
        const { parsed, tickerData, premium, analysis } = result;
        
        // Format the analysis
        const formatted = analysis
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#b9f;">$1</strong>')
            .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
            .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
            .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
            .replace(/\n/g, '<br>');
        
        // Build strike display
        const isSpread = parsed.buyStrike || parsed.sellStrike;
        const strikeDisplay = isSpread 
            ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
            : `$${parsed.strike}`;
        
        // Store parsed data for staging
        window._currentParsedTrade = {
            ticker: parsed.ticker,
            strike: parsed.strike || parsed.sellStrike,
            buyStrike: parsed.buyStrike,
            sellStrike: parsed.sellStrike,
            expiry: parsed.expiry,
            strategy: parsed.strategy,
            isSpread,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(tickerData.price),
            premium: premium || { mid: parseFloat(parsed.premium) || 0 },
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
        const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                          parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
        let premiumHtml = '';
        if (premium) {
            let entryQuality = '';
            if (parsed.premium && premium.mid) {
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
            const discrepancy = Math.abs(premium.mid - parsed.premium) > 0.5;
            premiumHtml = `
                <div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:15px; border:1px solid rgba(139,92,246,0.3);">
                    <div style="font-weight:bold; color:#b9f; margin-bottom:6px;">💰 Live CBOE Pricing</div>
                    <div style="font-size:13px;">
                        Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
                        ${premium.iv ? ` | IV: ${premium.iv}%` : ''}
                        ${parsed.premium ? `<br>Callout Entry: $${parsed.premium} ${entryQuality}` : ''}
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
                        <div style="font-size:14px; font-weight:bold; color:#b9f;">${parsed.strategy?.replace(/_/g, ' ') || 'Unknown'}</div>
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
                <h4 style="margin:0 0 15px; color:#b9f;">AI Analysis</h4>
                <div style="white-space:pre-wrap; line-height:1.6; font-size:14px;">${formatted}</div>
            </div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageDiscordTrade()" 
                        style="background:#8b5cf6; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#discordTradeModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
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
    
    // Create pending trade with thesis
    const pendingTrade = {
        id: Date.now(),
        ticker: trade.ticker,
        type: posType,
        strike: trade.strike,
        buyStrike: trade.buyStrike,
        sellStrike: trade.sellStrike,
        expiry: trade.expiry,
        currentPrice: trade.priceAtAnalysis,
        premium: trade.premium?.mid || 0,
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
 * Stage a trade with thesis from Deep Dive
 */
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
        strike: thesis.strike,
        expiry: thesis.expiry,
        currentPrice: thesis.priceAtAnalysis,
        premium: thesis.premium?.mid || 0,
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
            aiSummary: extractThesisSummary(thesis.aiAnalysis)
        }
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${thesis.ticker} $${thesis.strike} put, ${thesis.expiry} (with thesis)`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Clear current thesis
    window._currentThesis = null;
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Extract key points from AI analysis for storage
 */
function extractThesisSummary(analysis) {
    if (!analysis) return null;
    
    // Extract verdict line
    const verdictMatch = analysis.match(/(✅ ENTER TRADE|⚠️ WAIT|❌ AVOID)[^\n]*/);
    const verdict = verdictMatch ? verdictMatch[0] : null;
    
    // Extract summary (usually after verdict)
    const summaryMatch = analysis.match(/Summary:([^\n]+)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : null;
    
    // Keep it short - just the key reasoning
    return {
        verdict,
        summary,
        // Store first 500 chars of analysis for reference
        analysisPreview: analysis.substring(0, 500)
    };
}

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
        strike: parseFloat(strike),
        expiry,
        currentPrice: parseFloat(currentPrice),
        premium: parseFloat(premium) || 0,
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
        
        // Calculate credit (premium × 100)
        const credit = p.premium ? (p.premium * 100) : null;
        
        // Calculate annualized return: (premium / strike) × (365 / DTE) × 100
        const annReturn = (p.premium && p.strike && dte > 0) 
            ? ((p.premium / p.strike) * (365 / dte) * 100).toFixed(1)
            : null;
        
        return { ...p, dte, credit, annReturn };
    });
    
    container.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #2d1f3d 100%); border:1px solid #8b5cf6; border-radius:8px; padding:16px; margin-bottom:20px;">
            <h3 style="color:#8b5cf6; margin:0 0 12px 0; font-size:14px;">📋 Pending Trades (${pending.length})</h3>
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
                        <th style="padding:6px;">Credit</th>
                        <th style="padding:6px;">Ann%</th>
                        <th style="padding:6px;">Staged</th>
                        <th style="padding:6px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${pendingWithCalcs.map(p => `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:8px; color:#00ff88; font-weight:bold;">${p.ticker}</td>
                            <td style="padding:8px; color:#ffaa00;">$${p.strike}</td>
                            <td style="padding:8px;">${p.expiry}</td>
                            <td style="padding:8px; color:#888;">${p.dte ?? '-'}</td>
                            <td style="padding:8px; color:#00d9ff;">${p.credit ? '$' + p.credit.toFixed(0) : '-'}</td>
                            <td style="padding:8px; color:${p.annReturn && parseFloat(p.annReturn) >= 25 ? '#00ff88' : '#ffaa00'};">${p.annReturn ? p.annReturn + '%' : '-'}</td>
                            <td style="padding:8px; color:#888;">${new Date(p.stagedAt).toLocaleDateString()}</td>
                            <td style="padding:8px;">
                                <button onclick="window.confirmStagedTrade(${p.id})" 
                                        style="background:#00ff88; color:#000; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;">
                                    ✓ Confirm
                                </button>
                                <button onclick="window.removeStagedTrade(${p.id})" 
                                        style="background:#ff5252; color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;">
                                    ✕
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
};

/**
 * Confirm a staged trade - moves to real positions
 */
window.confirmStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Show modal to enter actual trade details
    const modal = document.createElement('div');
    modal.id = 'confirmTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:400px; padding:24px; border:1px solid #00ff88;">
            <h2 style="color:#00ff88; margin:0 0 16px 0;">✅ Confirm Trade Executed</h2>
            <p style="color:#888; margin-bottom:16px; font-size:13px;">
                Enter the actual details from your broker:
            </p>
            <div style="display:grid; gap:12px;">
                <div>
                    <label style="color:#888; font-size:12px;">Ticker</label>
                    <input id="confirmTicker" type="text" value="${trade.ticker}" readonly
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Strike Price</label>
                    <input id="confirmStrike" type="number" value="${trade.strike}" step="0.5"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Premium Received (per share)</label>
                    <input id="confirmPremium" type="number" value="${trade.premium?.toFixed(2) || ''}" step="0.01" placeholder="e.g., 1.50"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Contracts</label>
                    <input id="confirmContracts" type="number" value="1" min="1"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Expiry Date</label>
                    <input id="confirmExpiry" type="date" value="${parseExpiryToDate(trade.expiry)}"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
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
};

/**
 * Parse "Feb 20" or "Mar 21" to YYYY-MM-DD
 */
function parseExpiryToDate(expiry) {
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const match = expiry.match(/(\w+)\s+(\d+)/);
    if (!match) return '';
    const month = monthMap[match[1]] || '01';
    const day = match[2].padStart(2, '0');
    return `2026-${month}-${day}`;
}

/**
 * Finalize the confirmed trade - add to positions
 */
window.finalizeConfirmedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Get values from modal
    const ticker = document.getElementById('confirmTicker').value;
    const strike = parseFloat(document.getElementById('confirmStrike').value);
    const premium = parseFloat(document.getElementById('confirmPremium').value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts').value) || 1;
    const expiry = document.getElementById('confirmExpiry').value;
    
    // Create position object with thesis if available
    const position = {
        id: Date.now(),
        chainId: Date.now(),
        ticker,
        type: 'short_put',
        strike,
        premium,
        contracts,
        expiry,
        openDate: new Date().toISOString().split('T')[0],
        status: 'open',
        broker: 'Manual',
        // Include thesis if it was staged with one
        openingThesis: trade.openingThesis || null
    };
    
    // Add to positions
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    positions.push(position);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
    
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
    
    showNotification(`✅ Added ${ticker} $${strike} put to positions!`, 'success');
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
 * Run a checkup on a position - compares opening thesis to current market conditions
 */
window.runPositionCheckup = async function(positionId) {
    // Find the position
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const pos = positions.find(p => p.id === positionId);
    
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.openingThesis) {
        showNotification('No thesis data for this position', 'error');
        return;
    }
    
    // Get selected model
    const modelSelect = document.getElementById('ollamaModel');
    const model = modelSelect?.value || 'qwen2.5:7b';
    
    // Create loading modal
    const modal = document.createElement('div');
    modal.id = 'checkupModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);
        display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
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
        // Call checkup API
        const response = await fetch('/api/ai/checkup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: pos.ticker,
                strike: pos.strike,
                expiry: pos.expiry,
                openingThesis: pos.openingThesis,
                model
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Calculate DTE
        const dte = Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        
        // Display result
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;text-align:center;">
                    <div>
                        <div style="font-size:12px;color:#888;">Position</div>
                        <div style="font-size:18px;font-weight:bold;color:#00d9ff;">
                            ${pos.ticker} $${pos.strike}P
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
                </h4>
                <div style="color:#ffaa00;font-weight:bold;">
                    ${pos.openingThesis.aiSummary?.verdict || 'N/A'}
                </div>
                <div style="color:#aaa;font-size:13px;margin-top:5px;">
                    ${pos.openingThesis.aiSummary?.summary || 'No summary available'}
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:20px;border-radius:8px;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">AI Checkup Analysis</h4>
                <div style="white-space:pre-wrap;line-height:1.6;font-size:14px;">
                    ${formatAIResponse(data.checkup)}
                </div>
            </div>
            
            <div style="margin-top:15px;display:flex;gap:10px;justify-content:flex-end;">
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
 * Format AI response with proper styling
 */
function formatAIResponse(text) {
    if (!text) return '';
    return text
        .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
        .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
        .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
        .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
        .replace(/🟢/g, '<span style="color:#00ff88;">🟢</span>')
        .replace(/🟡/g, '<span style="color:#ffaa00;">🟡</span>')
        .replace(/🔴/g, '<span style="color:#ff5252;">🔴</span>')
        .replace(/📈/g, '<span style="color:#00ff88;">📈</span>')
        .replace(/📉/g, '<span style="color:#ff5252;">📉</span>');
}

/**
 * Check for updates from GitHub
 */
async function checkForUpdates() {
    try {
        const res = await fetch('/api/update/check');
        if (!res.ok) return;
        
        const data = await res.json();
        if (data.updateAvailable) {
            console.log(`🆕 Update available: v${data.localVersion} → v${data.remoteVersion}`);
            showUpdateToast(data);
        } else {
            console.log(`✅ WheelHouse v${data.localVersion} is up to date`);
        }
    } catch (e) {
        console.log('Could not check for updates:', e.message);
    }
}

/**
 * Restart the server (called from UI button)
 */
window.restartServer = async function() {
    const btn = document.getElementById('restartBtn');
    if (btn) {
        btn.style.opacity = '0.3';
        btn.disabled = true;
        btn.innerHTML = '⏳';
    }
    
    try {
        showNotification('Restarting server...', 'info');
        const res = await fetch('/api/restart', { method: 'POST' });
        
        if (res.ok) {
            // Server is restarting - wait a moment then reload
            showNotification('Server restarting, reloading page...', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            throw new Error('Restart failed');
        }
    } catch (e) {
        showNotification('Restart failed: ' + e.message, 'error');
        if (btn) {
            btn.style.opacity = '0.6';
            btn.disabled = false;
            btn.innerHTML = '🔄';
        }
    }
};

/**
 * Show update notification toast
 */
function showUpdateToast(data) {
    // Remove existing toast if any
    const existing = document.getElementById('update-toast');
    if (existing) existing.remove();
    
    // Parse changelog to get the latest version's changes
    const changelogSummary = parseChangelog(data.changelog, data.remoteVersion);
    
    const toast = document.createElement('div');
    toast.id = 'update-toast';
    toast.innerHTML = `
        <div class="update-toast-header">
            <span class="update-toast-icon">🆕</span>
            <span class="update-toast-title">Update Available!</span>
            <button class="update-toast-close" onclick="this.closest('#update-toast').remove()">✕</button>
        </div>
        <div class="update-toast-version">
            v${data.localVersion} → <span style="color: #00ff88;">v${data.remoteVersion}</span>
        </div>
        <div class="update-toast-changelog">
            ${changelogSummary}
        </div>
        <div class="update-toast-actions">
            <button class="update-toast-btn update-btn-primary" onclick="applyUpdate()">
                ⬇️ Update Now
            </button>
            <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse/releases', '_blank')">
                📋 View on GitHub
            </button>
            <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                Later
            </button>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => toast.classList.add('show'));
}

/**
 * Parse changelog to extract latest version's changes
 */
function parseChangelog(changelog, version) {
    if (!changelog) return '<em>No changelog available</em>';
    
    // Find the section for this version
    const versionPattern = new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\][^#]*`, 's');
    const match = changelog.match(versionPattern);
    
    if (match) {
        let section = match[0];
        // Convert markdown to simple HTML
        section = section
            .replace(/^## \[.*?\].*$/m, '') // Remove version header
            .replace(/### (.*)/g, '<strong>$1</strong>') // Convert ### headers
            .replace(/- \*\*(.*?)\*\*/g, '• <strong>$1</strong>') // Bold items
            .replace(/- (.*)/g, '• $1') // Convert list items
            .replace(/\n\n+/g, '<br>') // Convert double newlines
            .replace(/\n/g, ' ') // Remove single newlines
            .trim();
        
        // Limit length
        if (section.length > 400) {
            section = section.substring(0, 400) + '...';
        }
        return section || '<em>See GitHub for details</em>';
    }
    
    return '<em>See GitHub for full changelog</em>';
}

/**
 * Apply update via git pull
 */
window.applyUpdate = async function() {
    const toast = document.getElementById('update-toast');
    const actionsDiv = toast?.querySelector('.update-toast-actions');
    
    if (actionsDiv) {
        actionsDiv.innerHTML = `
            <div style="color: #00d9ff; display: flex; align-items: center; gap: 8px;">
                <div class="update-spinner"></div>
                Updating...
            </div>
        `;
    }
    
    try {
        const res = await fetch('/api/update/apply', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
            if (actionsDiv) {
                actionsDiv.innerHTML = `
                    <div style="color: #00ff88;">
                        ✅ Updated to v${data.newVersion}!
                    </div>
                    <button class="update-toast-btn update-btn-primary" onclick="location.reload()">
                        🔄 Reload Page
                    </button>
                `;
            }
            showNotification(`Updated to v${data.newVersion}! Reload to apply.`, 'success');
        } else {
            throw new Error(data.error || 'Update failed');
        }
    } catch (e) {
        if (actionsDiv) {
            actionsDiv.innerHTML = `
                <div style="color: #ff5252; margin-bottom: 8px;">
                    ❌ ${e.message}
                </div>
                <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse', '_blank')">
                    📥 Manual Download
                </button>
                <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                    Close
                </button>
            `;
        }
        showNotification('Update failed: ' + e.message, 'error');
    }
};

/**
 * Setup tab switching
 */
function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.tab;
            
            // Update active states
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(targetId)?.classList.add('active');
            
            // Tab-specific initialization
            if (targetId === 'portfolio') {
                renderPortfolio(true); // Fetch fresh prices
            } else if (targetId === 'pnl') {
                // Auto-run pricing if not already done
                if (!state.optionResults?.finalPrices) {
                    priceOptions().then(() => {
                        drawPnLChart();
                        drawProbabilityCone();
                        drawHeatMap();
                    });
                } else {
                    drawPnLChart();
                    drawProbabilityCone();
                    drawHeatMap();
                }
            } else if (targetId === 'greeks') {
                // Greeks will be drawn when pricing is run
            } else if (targetId === 'data') {
                updateDataTab();
            } else if (targetId === 'positions') {
                renderPositions();
                updatePortfolioSummary();
            } else if (targetId === 'challenges') {
                renderChallenges();
            }
        });
    });
}

/**
 * Setup button event listeners
 */
function setupButtons() {
    // Simulator buttons
    const runSingleBtn = document.getElementById('runSingleBtn');
    const runBatchBtn = document.getElementById('runBatchBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    if (runSingleBtn) {
        runSingleBtn.addEventListener('click', () => {
            runSingle();
            updateResults();
        });
    }
    
    if (runBatchBtn) {
        runBatchBtn.addEventListener('click', () => {
            runBatch();
            updateResults();
        });
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetAll();
            updateResults();
        });
    }
    
    // Options pricing button
    const priceBtn = document.getElementById('priceBtn');
    if (priceBtn) {
        priceBtn.addEventListener('click', () => {
            priceOptions();
            drawPayoffChart();
        });
    }
    
    // Greeks button
    const greeksBtn = document.getElementById('greeksBtn');
    if (greeksBtn) {
        greeksBtn.addEventListener('click', calcGreeks);
    }
    
    // Ticker fetch button
    const fetchBtn = document.getElementById('fetchTickerBtn');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', () => {
            const ticker = document.getElementById('tickerInput')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol', 'warning');
            }
        });
    }
    
    // Heat map update button
    const updateHeatMapBtn = document.getElementById('heatMapUpdateBtn');
    if (updateHeatMapBtn) {
        updateHeatMapBtn.addEventListener('click', () => {
            const input = document.getElementById('heatMapSpot');
            const newSpot = parseFloat(input?.value);
            if (!isNaN(newSpot) && newSpot > 0) {
                state.spot = newSpot;
                
                // Update sliders
                const clampedSpot = Math.max(20, Math.min(500, Math.round(state.spot)));
                document.getElementById('spotSlider').value = clampedSpot;
                document.getElementById('spotInput').value = Math.round(state.spot);
                
                // Visual feedback
                input.style.borderColor = '#00ff88';
                setTimeout(() => input.style.borderColor = '', 300);
                
                // Redraw charts
                drawPnLChart();
                drawProbabilityCone();
                drawHeatMap();
            } else {
                input.style.borderColor = '#ff5252';
                setTimeout(() => input.style.borderColor = '', 500);
            }
        });
    }
    
    // Heat map fetch button
    const heatMapFetchBtn = document.getElementById('heatMapFetchBtn');
    if (heatMapFetchBtn) {
        heatMapFetchBtn.addEventListener('click', fetchHeatMapPrice);
    }
    
    // Position ticker fetch button
    const posFetchPriceBtn = document.getElementById('posFetchPriceBtn');
    if (posFetchPriceBtn) {
        posFetchPriceBtn.addEventListener('click', () => {
            const ticker = document.getElementById('posTicker')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchPositionTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol first', 'warning');
            }
        });
    }
    
    // Roll calculator button
    const rollBtn = document.getElementById('rollBtn');
    if (rollBtn) {
        rollBtn.addEventListener('click', calculateRoll);
    }
    
    // Suggest optimal roll button
    const suggestRollBtn = document.getElementById('suggestRollBtn');
    if (suggestRollBtn) {
        suggestRollBtn.addEventListener('click', suggestOptimalRoll);
    }
    
    // Add position button
    const addPosBtn = document.getElementById('addPositionBtn');
    if (addPosBtn) {
        addPosBtn.addEventListener('click', addPosition);
    }
    
    // Cancel edit button
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', cancelEdit);
    }
    
    // Roll position buttons
    const executeRollBtn = document.getElementById('executeRollBtn');
    if (executeRollBtn) {
        executeRollBtn.addEventListener('click', () => {
            if (window.executeRoll) window.executeRoll();
        });
    }
    
    const cancelRollBtn = document.getElementById('cancelRollBtn');
    if (cancelRollBtn) {
        cancelRollBtn.addEventListener('click', () => {
            if (window.cancelRoll) window.cancelRoll();
        });
    }
    
    // Close position buttons
    const executeCloseBtn = document.getElementById('executeCloseBtn');
    if (executeCloseBtn) {
        executeCloseBtn.addEventListener('click', () => {
            if (window.executeClose) window.executeClose();
        });
    }
    
    const cancelCloseBtn = document.getElementById('cancelCloseBtn');
    if (cancelCloseBtn) {
        cancelCloseBtn.addEventListener('click', () => {
            if (window.cancelClose) window.cancelClose();
        });
    }
    
    // Expose editPosition to window for inline onclick handlers
    window.editPosition = editPosition;
    
    // Portfolio refresh button
    const refreshPortfolioBtn = document.getElementById('refreshPortfolioBtn');
    if (refreshPortfolioBtn) {
        refreshPortfolioBtn.addEventListener('click', () => renderPortfolio(true));
    }
    
    // Add historical closed position button
    const addClosedBtn = document.getElementById('addClosedPositionBtn');
    if (addClosedBtn) {
        addClosedBtn.addEventListener('click', () => {
            if (window.addHistoricalClosedPosition) {
                window.addHistoricalClosedPosition();
            }
        });
    }
    
    // Sync to simulator button
    const syncBtn = document.getElementById('syncToSimBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', syncToSimulator);
    }
    
    // Clear position context button
    const clearContextBtn = document.getElementById('clearContextBtn');
    if (clearContextBtn) {
        clearContextBtn.addEventListener('click', () => {
            state.currentPositionContext = null;
            const contextEl = document.getElementById('positionContext');
            if (contextEl) contextEl.style.display = 'none';
            showNotification('Cleared position context', 'info');
        });
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for potential external use
export { setupTabs, setupButtons };
