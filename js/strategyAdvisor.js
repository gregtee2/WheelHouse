/**
 * Strategy Advisor Module
 * AI-powered strategy analysis for any ticker - recommends optimal option strategy
 * 
 * Extracted from main.js
 */

import { showNotification } from 'utils';
import { state } from 'state';
import AccountService from './services/AccountService.js';
import { renderPendingTrades } from 'tradeStaging';
import { formatAIResponse, extractThesisSummary, extractSection } from 'aiHelpers';

// Store the last analysis result for staging
let lastStrategyAdvisorResult = null;

window.runStrategyAdvisor = async function() {
    const tickerInput = document.getElementById('strategyAdvisorTicker');
    const modelSelect = document.getElementById('strategyAdvisorModel');
    const bpInput = document.getElementById('strategyAdvisorBP');
    const riskSelect = document.getElementById('strategyAdvisorRisk');
    const expertModeCheckbox = document.getElementById('strategyAdvisorExpertMode');
    
    const ticker = tickerInput?.value?.trim().toUpperCase();
    if (!ticker) {
        showNotification('Enter a ticker symbol', 'error');
        tickerInput?.focus();
        return;
    }
    
    const model = modelSelect?.value || 'deepseek-r1:32b';
    const riskTolerance = riskSelect?.value || 'moderate';
    
    // Auto-enable Wall Street Mode for capable models (Grok, GPT-4, Claude)
    // User can still manually override via checkbox
    // Note: grok-4 is slowest (3-5 min), grok-4-1-fast is recommended
    const isCapableModel = model.includes('grok') || model.includes('gpt-4') || model.includes('claude');
    const expertMode = expertModeCheckbox?.checked || isCapableModel;
    
    // Sync checkbox state if auto-enabled
    if (isCapableModel && expertModeCheckbox && !expertModeCheckbox.checked) {
        expertModeCheckbox.checked = true;
        console.log(`[STRATEGY-ADVISOR] Auto-enabled Wall Street Mode for ${model}`);
    }
    
    // =========================================================================
    // PROP DESK SIZING: Use Conservative Kelly Base, NOT raw buying power
    // Kelly Base = Account Value + (25% × Available Margin)
    // Then apply Half-Kelly for even more conservative sizing
    // =========================================================================
    const buyingPower = AccountService.getBuyingPower() || parseFloat(bpInput?.value) || 25000;
    const accountValue = AccountService.getAccountValue() || buyingPower * 0.5; // Estimate if not available
    
    // Calculate conservative Kelly Base (same formula as Portfolio Analytics)
    let kellyBase = 0;
    if (accountValue > 0) {
        const availableMargin = Math.max(0, buyingPower - accountValue);
        kellyBase = accountValue + (availableMargin * 0.25);
    } else {
        kellyBase = buyingPower * 0.625; // Fallback: 50% + 25% of remaining 50%
    }
    
    // Apply Half-Kelly for conservative sizing (prop desks typically use 1/4 to 1/2 Kelly)
    const maxPositionSize = kellyBase * 0.5; // Half Kelly
    
    // Cap at 60% of max position size per trade (no single trade > 60% of Half-Kelly)
    const perTradeCap = maxPositionSize * 0.6;
    
    console.log(`[STRATEGY-ADVISOR] Prop Desk Sizing:`);
    console.log(`  Account Value: $${accountValue.toLocaleString()}`);
    console.log(`  Buying Power: $${buyingPower.toLocaleString()}`);
    console.log(`  Kelly Base: $${kellyBase.toLocaleString()}`);
    console.log(`  Half-Kelly Max: $${maxPositionSize.toLocaleString()}`);
    console.log(`  Per-Trade Cap (60%): $${perTradeCap.toLocaleString()}`);
    
    // Create and show loading modal
    const existingModal = document.getElementById('strategyAdvisorModal');
    if (existingModal) existingModal.remove();
    
    const modal = document.createElement('div');
    modal.id = 'strategyAdvisorModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #0d0d1a 100%); border-radius:16px; max-width:900px; width:100%; max-height:90vh; display:flex; flex-direction:column; border:2px solid ${expertMode ? '#ffd700' : '#6d28d9'}; box-shadow:0 0 40px ${expertMode ? 'rgba(255,215,0,0.3)' : 'rgba(147,51,234,0.3)'};">
            <div style="background:linear-gradient(135deg, ${expertMode ? 'rgba(255,215,0,0.2)' : 'rgba(147,51,234,0.3)'} 0%, ${expertMode ? 'rgba(255,140,0,0.15)' : 'rgba(79,70,229,0.2)'} 100%); padding:16px 24px; border-bottom:1px solid ${expertMode ? '#ffd700' : '#6d28d9'}; flex-shrink:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <h2 style="margin:0; color:${expertMode ? '#ffd700' : '#a78bfa'}; font-size:20px;">${expertMode ? '🏛️ Wall Street Mode' : '🎓 Strategy Advisor'}: ${ticker}</h2>
                        <div id="strategyAdvisorMeta" style="font-size:11px; color:#888; margin-top:4px;">${expertMode ? 'Expert analysis' : 'Analyzing'} with ${model}...</div>
                    </div>
                    <button onclick="document.getElementById('strategyAdvisorModal').remove()" style="background:none; border:none; color:#888; font-size:28px; cursor:pointer; line-height:1;">&times;</button>
                </div>
            </div>
            <div id="strategyAdvisorContent" style="padding:24px; color:#ddd; font-size:13px; line-height:1.7; overflow-y:auto; flex:1;">
                <div style="text-align:center; padding:60px 20px;">
                    <div style="font-size:48px; margin-bottom:16px;">${expertMode ? '🏛️' : '🔮'}</div>
                    <div style="color:${expertMode ? '#ffd700' : '#a78bfa'}; font-weight:bold; font-size:16px;">${expertMode ? 'Senior Trader Analysis' : 'Analyzing All Strategies'} for ${ticker}...</div>
                    <div style="color:#666; font-size:12px; margin-top:8px;">${expertMode ? 'Wall Street methodology • Free-form analysis' : 'Fetching real-time data from Schwab • Calculating optimal position size'}</div>
                    <div style="margin-top:20px; height:4px; background:#333; border-radius:2px; overflow:hidden;">
                        <div style="height:100%; width:30%; background:linear-gradient(90deg, ${expertMode ? '#ffd700, #ff8c00' : '#9333ea, #6d28d9'}); animation:pulse 1.5s ease-in-out infinite;"></div>
                    </div>
                </div>
            </div>
            <div id="strategyAdvisorFooter" style="display:none; background:rgba(0,0,0,0.5); padding:16px 24px; border-top:1px solid ${expertMode ? '#ffd700' : '#6d28d9'}; flex-shrink:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-size:11px; color:#888;">💡 You can also stage alternatives using the buttons in each section above</div>
                    <div style="display:flex; gap:12px;">
                        <button onclick="document.getElementById('strategyAdvisorModal').remove()" style="padding:10px 20px; background:#333; border:1px solid #444; border-radius:8px; color:#ddd; font-size:13px; cursor:pointer;">
                            Close
                        </button>
                        <button onclick="window.stageStrategyAdvisorTrade(0);" style="padding:10px 24px; background:linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border:none; border-radius:8px; color:#fff; font-weight:bold; font-size:13px; cursor:pointer; box-shadow:0 4px 12px rgba(34,197,94,0.3);">
                            📥 Stage Primary
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Handle Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
    
    try {
        // Get existing positions for context
        const existingPositions = state.positions || [];
        
        // Check if user has holdings (shares) for this ticker - enables covered call recommendations
        const holdings = state.holdings || [];
        const tickerHolding = holdings.find(h => h.ticker?.toUpperCase() === ticker);
        const sharesOwned = tickerHolding?.shares || 0;
        const costBasis = tickerHolding?.costBasis || tickerHolding?.averageCost || 0;
        
        if (sharesOwned > 0) {
            console.log(`[STRATEGY-ADVISOR] User owns ${sharesOwned} shares of ${ticker} @ $${costBasis.toFixed(2)} cost basis`);
        }
        
        console.log(`[STRATEGY-ADVISOR] Analyzing ${ticker} with Kelly-capped BP=$${perTradeCap.toLocaleString()}${expertMode ? ' (EXPERT MODE)' : ''}...`);
        
        // Build closed summary for coaching context
        const closedPositions = state.closedPositions || [];
        const closedSummary = closedPositions.length > 0 ? closedPositions.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            pnl: p.realizedPnL ?? p.closePnL ?? 0,
            closeDate: p.closeDate,
            openDate: p.openDate,
            closeReason: p.closeReason,
            contracts: p.contracts
        })) : null;
        
        const response = await fetch('/api/ai/strategy-advisor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                model,
                buyingPower: perTradeCap,  // Send Kelly-capped amount, not raw BP
                accountValue,               // For context in prompt
                kellyBase,                  // For display
                sharesOwned,                // NEW: Share holdings for covered call eligibility
                costBasis,                  // NEW: Cost basis for breakeven calcs
                riskTolerance,
                existingPositions,
                expertMode,                 // Wall Street Mode - free AI analysis
                closedSummary               // For coaching pattern analysis
            })
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Strategy analysis failed');
        }
        
        const data = await response.json();
        console.log('[STRATEGY-ADVISOR] Response:', data);
        
        // Store for staging
        lastStrategyAdvisorResult = data;
        
        // Update modal with results
        const contentDiv = document.getElementById('strategyAdvisorContent');
        const metaDiv = document.getElementById('strategyAdvisorMeta');
        const footerDiv = document.getElementById('strategyAdvisorFooter');
        
        // Build meta info with range position
        let metaHtml = '';
        if (data.expertMode) {
            metaHtml += `<span style="background:linear-gradient(90deg, #ffd700, #ff8c00); color:#000; padding:2px 6px; border-radius:4px; font-weight:bold; margin-right:8px;">🏛️ WALL STREET</span>`;
        }
        metaHtml += `<span>Spot: $${data.spot?.toFixed(2) || '?'}</span>`;
        if (data.stockData?.rangePosition !== undefined) {
            const rp = data.stockData.rangePosition;
            const rangeColor = rp < 25 ? '#22c55e' : (rp > 75 ? '#ff5252' : '#ffaa00');
            const rangeIcon = rp < 25 ? '🔻' : (rp > 75 ? '🔺' : '↔️');
            metaHtml += ` • <span style="color:${rangeColor}">${rangeIcon} Range: ${rp}%</span>`;
        }
        if (data.ivRank !== null && data.ivRank !== undefined) {
            const ivColor = data.ivRank > 60 ? '#ff5252' : (data.ivRank < 30 ? '#22c55e' : '#ffaa00');
            metaHtml += ` • <span style="color:${ivColor}">IV Rank: ${data.ivRank}%</span>`;
        }
        metaHtml += ` • <span>Data: ${data.dataSource || 'Unknown'}</span>`;
        metaHtml += ` • <span>Model: ${data.model}</span>`;
        if (metaDiv) metaDiv.innerHTML = metaHtml;
        
        // Build content - prepend range warning if present
        let contentHtml = '';
        if (data.rangeWarning) {
            contentHtml += `
                <div style="background:rgba(255,82,82,0.15); border:1px solid #ff5252; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#ff5252; font-weight:bold; margin-bottom:4px;">⚠️ AI May Have Ignored Range Position</div>
                    <div style="color:#ddd; font-size:12px;">${data.rangeWarning}</div>
                </div>
            `;
        }
        
        // Show capital efficiency analysis if available
        if (data.selectionRationale) {
            const sr = data.selectionRationale;
            
            // Format strike display based on strategy type
            const strikeDisplay = sr.spreadWidth 
                ? `$${sr.strike}/$${sr.longStrike} Spread` 
                : `$${sr.strike} Put`;
            const strategyLabel = sr.strategyLabel || 'Cash-Secured Put';
            const capitalLabel = sr.spreadWidth ? `$${sr.spreadWidth} width` : `$${sr.strike} capital`;
            
            contentHtml += `
                <div style="background:rgba(34,197,94,0.1); border:1px solid #22c55e; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <div style="color:#22c55e; font-weight:bold;">📊 Capital Efficiency: ${strikeDisplay}</div>
                        <div style="color:#00ff88; font-size:14px; font-weight:bold;">${sr.annualizedROC.toFixed(0)}% Ann. ROC</div>
                    </div>
                    <div style="color:#888; font-size:11px; margin-bottom:4px;">Strategy: ${strategyLabel} • Capital: ${capitalLabel}</div>
                    <div style="color:#aaa; font-size:12px; margin-bottom:8px;">${sr.summary}</div>
                    ${sr.allCandidates && sr.allCandidates.length > 1 ? `
                        <div style="margin-top:8px;">
                            <table style="width:100%; font-size:11px; color:#aaa; border-collapse:collapse;">
                                <thead>
                                    <tr style="border-bottom:1px solid #333;">
                                        <th style="padding:4px 8px; text-align:left;">Expiry</th>
                                        <th style="padding:4px 8px; text-align:right;">DTE</th>
                                        <th style="padding:4px 8px; text-align:right;">Premium</th>
                                        <th style="padding:4px 8px; text-align:right;">ROC</th>
                                        <th style="padding:4px 8px; text-align:right;">Ann. ROC</th>
                                        <th style="padding:4px 8px; text-align:right;">Score</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${sr.allCandidates.map((c, i) => {
                                        const score = c.score ?? c.annualizedROC;  // Fallback if backend hasn't calculated score
                                        return `
                                        <tr style="${i === 0 ? 'background:rgba(34,197,94,0.15); color:#22c55e;' : ''}">
                                            <td style="padding:4px 8px;">${c.expiry}${i === 0 ? ' ✓' : ''}</td>
                                            <td style="padding:4px 8px; text-align:right;">${c.dte}d${c.gammaPenalized ? ' ⚠️' : ''}</td>
                                            <td style="padding:4px 8px; text-align:right;">$${c.premium.toFixed(2)}</td>
                                            <td style="padding:4px 8px; text-align:right;">${c.roc.toFixed(2)}%</td>
                                            <td style="padding:4px 8px; text-align:right;">${c.annualizedROC.toFixed(0)}%${c.gammaPenalized ? '*' : ''}</td>
                                            <td style="padding:4px 8px; text-align:right; font-weight:${i === 0 ? 'bold' : 'normal'}; color:${i === 0 ? '#22c55e' : (c.gammaPenalized ? '#f59e0b' : '#aaa')};">${score.toFixed(0)}%</td>
                                        </tr>
                                    `}).join('')}
                                </tbody>
                                ${sr.allCandidates.some(c => c.gammaPenalized) ? '<tfoot><tr><td colspan="6" style="padding:4px 8px; font-size:10px; color:#888;">⚠️ *Under 21 DTE = 15% gamma penalty applied to score</td></tr></tfoot>' : ''}
                            </table>
                        </div>
                    ` : ''}
                </div>
            `;
        }
        
        // Format response and inject Stage buttons after each trade section
        let formattedResponse = formatAIResponse(data.recommendation);
        
        // Inject "Stage This" buttons after PRIMARY, ALTERNATIVE #1, and ALTERNATIVE #2 sections
        // Look for the section headers and add a button before the next section or end
        const sections = [
            { marker: '🥇 PRIMARY RECOMMENDATION', index: 0, label: 'Primary' },
            { marker: '🥈 ALTERNATIVE #1', index: 1, label: 'Alt #1' },
            { marker: '🥉 ALTERNATIVE #2', index: 2, label: 'Alt #2' }
        ];
        
        sections.forEach(section => {
            const markerPos = formattedResponse.indexOf(section.marker);
            if (markerPos === -1) return;
            
            // Find where this section ends (next section header or end of document)
            const nextSectionMarkers = ['🥈 ALTERNATIVE', '🥉 ALTERNATIVE', '❌ STRATEGIES REJECTED', '════'];
            let sectionEndPos = formattedResponse.length;
            
            for (const nextMarker of nextSectionMarkers) {
                const nextPos = formattedResponse.indexOf(nextMarker, markerPos + section.marker.length);
                if (nextPos !== -1 && nextPos < sectionEndPos) {
                    sectionEndPos = nextPos;
                }
            }
            
            // Insert the Stage button just before the section ends
            const stageButton = `
                <div style="margin: 16px 0; text-align: right;">
                    <button onclick="window.stageStrategyAdvisorTrade(${section.index});" 
                        style="padding: 8px 16px; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); border: none; border-radius: 6px; color: #fff; font-weight: bold; font-size: 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(34,197,94,0.3);">
                        📥 Stage ${section.label}
                    </button>
                </div>
            `;
            
            formattedResponse = formattedResponse.slice(0, sectionEndPos) + stageButton + formattedResponse.slice(sectionEndPos);
        });
        
        contentHtml += formattedResponse;
        
        // Format the AI response (convert markdown to HTML)
        if (contentDiv) contentDiv.innerHTML = contentHtml;
        
        // Show the footer with Stage Trade button (now for Primary by default)
        if (footerDiv) footerDiv.style.display = 'block';
        
        showNotification(`✅ Strategy analysis complete for ${ticker}`, 'success');
        
    } catch (e) {
        console.error('[STRATEGY-ADVISOR] Error:', e);
        // Update modal with error
        const contentDiv = document.getElementById('strategyAdvisorContent');
        if (contentDiv) {
            contentDiv.innerHTML = `
                <div style="text-align:center; padding:40px;">
                    <div style="font-size:48px; margin-bottom:16px;">❌</div>
                    <div style="color:#ff5252; font-weight:bold; font-size:16px;">Analysis Failed</div>
                    <div style="color:#888; margin-top:8px;">${e.message}</div>
                </div>
            `;
        }
        showNotification(`❌ ${e.message}`, 'error');
    }
};

// Stage the recommended trade from Strategy Advisor
// sectionIndex: 0 = Primary, 1 = Alt #1, 2 = Alt #2
window.stageStrategyAdvisorTrade = async function(sectionIndex = 0) {
    if (!lastStrategyAdvisorResult) {
        showNotification('No strategy analysis to stage', 'error');
        return;
    }
    
    const { ticker, spot, recommendation, ivRank, model, stockData } = lastStrategyAdvisorResult;
    
    // Extract the specific section based on sectionIndex
    let sectionText = recommendation;
    const sectionMarkers = [
        { start: '🥇 PRIMARY RECOMMENDATION', end: '🥈 ALTERNATIVE' },
        { start: '🥈 ALTERNATIVE #1', end: '🥉 ALTERNATIVE' },
        { start: '🥉 ALTERNATIVE #2', end: '❌ STRATEGIES REJECTED' }
    ];
    
    if (sectionIndex >= 0 && sectionIndex < sectionMarkers.length) {
        const marker = sectionMarkers[sectionIndex];
        const startPos = recommendation.indexOf(marker.start);
        if (startPos !== -1) {
            let endPos = recommendation.indexOf(marker.end, startPos + marker.start.length);
            // If end marker not found, look for alternatives
            if (endPos === -1) endPos = recommendation.indexOf('❌ STRATEGIES', startPos);
            if (endPos === -1) endPos = recommendation.indexOf('════', startPos + marker.start.length);
            if (endPos === -1) endPos = recommendation.length;
            sectionText = recommendation.substring(startPos, endPos);
            console.log(`[STAGE] Extracted section ${sectionIndex}:`, sectionText.substring(0, 200) + '...');
        }
    }
    
    // Parse the AI recommendation to extract trade details
    // The AI outputs structured sections like "Sell: $90 put @ $2.50"
    let tradeType = 'short_put';
    let strike = Math.round(spot * 0.95); // Default: 5% OTM put
    let upperStrike = null;
    let premium = null;
    let expiry = null;
    let isCall = false;
    let isDebit = false;
    let contracts = 1;
    
    console.log('[STAGE] Parsing recommendation...');
    
    // Helper: Convert human-readable dates like "Feb 27 '26" or "Feb 27, 2026" to YYYY-MM-DD
    const parseHumanDate = (text) => {
        if (!text) return null;
        const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                         jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
        
        // Match "Feb 27 '26" or "Feb 27, 2026" or "February 27, 2026"
        const match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s*'?(\d{2,4}))?/i);
        if (match) {
            const month = months[match[1].toLowerCase().substring(0, 3)];
            const day = match[2].padStart(2, '0');
            let year = match[3] || new Date().getFullYear().toString();
            if (year.length === 2) year = '20' + year;
            return `${year}-${month}-${day}`;
        }
        return null;
    };
    
    // Method 1: Look for "Sell TICKER $XX/$XX Put Spread, DATE" format
    // Also handles "Bear Call Spread" and "Bull Put Spread" variations
    // Date can appear with or without "expiry" after it
    // Optional "Trade:" prefix to handle Strategy Advisor output
    let spreadMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
    
    // Try Wall Street format: "Sell TICKER Feb 9 $320/$315 Put Credit Spread" (date before strikes)
    // Year is optional - "Feb 9" or "Feb 9 '26" or "Feb 9, 2026"
    if (!spreadMatch) {
        const wsMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+(\w+)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:[,']?\s*'?\d{2,4})?)\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (wsMatch) {
            const humanDate = wsMatch[2];
            expiry = parseHumanDate(humanDate);
            spreadMatch = [null, wsMatch[3], wsMatch[4], wsMatch[5]];
            console.log('[STAGE] Matched Wall Street date format:', humanDate, '→', expiry);
        }
    }
    
    // Try alternate Wall Street format without dollar signs: "Sell TICKER Feb 9 320/315 Put Spread"
    if (!spreadMatch) {
        const wsNoDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+(\w+)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:[,']?\s*'?\d{2,4})?)\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (wsNoDollar) {
            const humanDate = wsNoDollar[2];
            expiry = parseHumanDate(humanDate);
            spreadMatch = [null, wsNoDollar[3], wsNoDollar[4], wsNoDollar[5]];
            console.log('[STAGE] Matched Wall Street format (no $):', humanDate, '→', expiry);
        }
    }

    // Try ISO date format WITH dollar signs: "Sell TICKER 2026-02-09 $320/$315 Put Credit Spread"
    if (!spreadMatch) {
        const isoWithDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (isoWithDollar) {
            expiry = isoWithDollar[1];
            spreadMatch = [null, isoWithDollar[2], isoWithDollar[3], isoWithDollar[4]];
            console.log('[STAGE] Matched ISO date with $ format, expiry:', expiry);
        }
    }
    
    // Try ISO date format WITHOUT dollar signs: "Sell TICKER 2026-02-09 320/315 Put Credit Spread"
    if (!spreadMatch) {
        const isoNoDollar = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread/i);
        if (isoNoDollar) {
            expiry = isoNoDollar[1];
            spreadMatch = [null, isoNoDollar[2], isoNoDollar[3], isoNoDollar[4]];
            console.log('[STAGE] Matched ISO date without $ format, expiry:', expiry);
        }
    }
    
    // Try format without dollar signs at end: "Sell TICKER $XX/$XX Put Spread 2026-02-09" or just "XX/XX"
    if (!spreadMatch) {
        const noDollarMatch = sectionText?.match(/(?:Trade:\s*)?Sell\s+\w+\s+(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(?:Bear\s+|Bull\s+)?(Put|Call)\s+(?:Credit\s+)?Spread[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
        if (noDollarMatch) {
            spreadMatch = noDollarMatch;
            console.log('[STAGE] Matched spread without $ signs');
        }
    }
    
    // Debug: Log first 500 chars if no match found
    if (!spreadMatch) {
        console.log('[STAGE] No spread match found. Section preview:', sectionText?.substring(0, 500));
    }
    
    if (spreadMatch) {
        const strike1 = parseFloat(spreadMatch[1]);
        const strike2 = parseFloat(spreadMatch[2]);
        const optType = (spreadMatch[3] || 'put').toLowerCase();  // Default to put if missing
        let expDate = spreadMatch[4] || expiry;  // Use captured expiry if available
        
        // If no date in the header line, look for date elsewhere nearby
        if (!expDate) {
            const dateMatch = sectionText?.match(/(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)?/i);
            if (dateMatch) expDate = dateMatch[1];
        }
        
        if (optType === 'put') {
            tradeType = 'put_credit_spread';
            strike = Math.max(strike1, strike2);  // Sell higher strike
            upperStrike = Math.min(strike1, strike2);  // Buy lower strike
        } else {
            tradeType = 'call_credit_spread';
            isCall = true;
            strike = Math.min(strike1, strike2);  // Sell lower strike
            upperStrike = Math.max(strike1, strike2);  // Buy higher strike
        }
        
        if (expDate) expiry = expDate;
        console.log('[STAGE] Detected spread from header: ' + tradeType + ' $' + strike + '/$' + upperStrike + ' exp ' + (expiry || 'TBD'));
    }
    
    // Method 1b: Look for DEBIT spread format "Buy TICKER $XX Put / Sell TICKER $XX Put"
    // This is the Bear Put Spread or Bull Call Spread format (you pay to open)
    if (!spreadMatch) {
        let debitSpreadMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+(?:\.\d+)?)\s+(Put|Call)\s*\/\s*Sell\s+\w+\s+\$(\d+(?:\.\d+)?)\s+(Put|Call)[,.]?\s*(\d{4}-\d{2}-\d{2})?/i);
        
        // Pattern B: "Buy $XX/$XX Call Spread" (Bull Call Spread format)
        if (!debitSpreadMatch) {
            const bullCallMatch = sectionText?.match(/Buy\s+(?:\w+\s+)?\$?(\d+)\/\$?(\d+)\s+(Call|Put)\s+(?:Debit\s+)?Spread/i);
            if (bullCallMatch) {
                const strike1 = parseFloat(bullCallMatch[1]);
                const strike2 = parseFloat(bullCallMatch[2]);
                const optType = bullCallMatch[3].toLowerCase();
                debitSpreadMatch = [null, Math.min(strike1, strike2), optType, Math.max(strike1, strike2), optType, null];
                console.log('[STAGE] Matched Bull/Bear Debit Spread format');
            }
        }
        
        // Pattern C: "Bull Call Spread $XX/$XX" or "Bear Put Spread $XX/$XX"
        if (!debitSpreadMatch) {
            const namedSpreadMatch = sectionText?.match(/(Bull\s+Call|Bear\s+Put)\s+Spread[:\s]+\$?(\d+)\/\$?(\d+)/i);
            if (namedSpreadMatch) {
                const spreadType = namedSpreadMatch[1].toLowerCase();
                const strike1 = parseFloat(namedSpreadMatch[2]);
                const strike2 = parseFloat(namedSpreadMatch[3]);
                if (spreadType.includes('call')) {
                    debitSpreadMatch = [null, Math.min(strike1, strike2), 'call', Math.max(strike1, strike2), 'call', null];
                } else {
                    debitSpreadMatch = [null, Math.max(strike1, strike2), 'put', Math.min(strike1, strike2), 'put', null];
                }
                console.log('[STAGE] Matched named debit spread: ' + spreadType);
            }
        }
        
        if (debitSpreadMatch) {
            const buyStrike = parseFloat(debitSpreadMatch[1]);
            const buyType = (typeof debitSpreadMatch[2] === 'string' ? debitSpreadMatch[2] : 'call').toLowerCase();
            const sellStrike = parseFloat(debitSpreadMatch[3]);
            let expDate = debitSpreadMatch[5];
            
            // If no date in the header line, look for date elsewhere
            if (!expDate) {
                const dateMatch = sectionText?.match(/(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)/i);
                if (dateMatch) expDate = dateMatch[1];
            }
            
            if (buyType === 'put') {
                // Bear Put Spread: Buy higher put, sell lower put
                tradeType = 'put_debit_spread';
                strike = buyStrike;      // Buy strike (higher for bear put)
                upperStrike = sellStrike; // Sell strike (lower for bear put)
                isDebit = true;
            } else {
                // Bull Call Spread: Buy lower call, sell higher call
                tradeType = 'call_debit_spread';
                isCall = true;
                strike = buyStrike;      // Buy strike (lower for bull call)
                upperStrike = sellStrike; // Sell strike (higher for bull call)
                isDebit = true;
            }
            
            if (expDate) expiry = expDate;
            console.log('[STAGE] Detected DEBIT spread: ' + tradeType + ' $' + strike + '/$' + upperStrike + ' exp ' + (expiry || 'TBD'));
        }
    }
    
    // Method 2: Look for "Credit Received: $X.XX/share" or "Credit Received: $X.XX"
    const creditMatch = sectionText?.match(/Credit\s+Received:\s*\$(\d+(?:\.\d+)?)(?:\/share)?/i);
    if (creditMatch) {
        premium = parseFloat(creditMatch[1]);
        console.log('[STAGE] Found credit received: $' + premium);
    }
    
    // Method 2b: Look for "Net Debit: $X.XX" for debit spreads
    if (!premium && isDebit) {
        const debitMatch = sectionText?.match(/Net\s+Debit:\s*\$(\d+(?:\.\d+)?)(?:\s*per\s*share)?/i);
        if (debitMatch) {
            premium = parseFloat(debitMatch[1]);
            console.log('[STAGE] Found net debit: $' + premium);
        }
    }
    
    // Method 2c: Look for "Net Credit: $X.XX" (alternate format for credit spreads)
    if (!premium) {
        const netCreditMatch = sectionText?.match(/Net\s+Credit:\s*\$(\d+(?:\.\d+)?)(?:\s*per\s*share)?/i);
        if (netCreditMatch) {
            premium = parseFloat(netCreditMatch[1]);
            console.log('[STAGE] Found net credit: $' + premium);
        }
    }
    
    // Method 2d: Look for "Net Credit/Debit: $X.XX per share" (Wall Street Mode format)
    if (!premium) {
        const netCreditDebitMatch = sectionText?.match(/Net\s+Credit\/Debit:\s*\$(\d+(?:\.\d+)?)\s*per\s*share/i);
        if (netCreditDebitMatch) {
            premium = parseFloat(netCreditDebitMatch[1]);
            console.log('[STAGE] Found net credit/debit: $' + premium);
        }
    }
    
    // Method 3: Look for "Sell: $XX put @ $X.XX" pattern (alternate format)
    if (!premium) {
        const sellPutMatch = sectionText?.match(/Sell:\s*\$(\d+(?:\.\d+)?)\s*put\s*@\s*\$(\d+(?:\.\d+)?)/i);
        const buyPutMatch = sectionText?.match(/Buy:\s*\$(\d+(?:\.\d+)?)\s*put\s*@\s*\$(\d+(?:\.\d+)?)/i);
        
        if (sellPutMatch && buyPutMatch) {
            tradeType = 'put_credit_spread';
            strike = parseFloat(sellPutMatch[1]);
            upperStrike = parseFloat(buyPutMatch[1]);
            const sellPrem = parseFloat(sellPutMatch[2]);
            const buyPrem = parseFloat(buyPutMatch[2]);
            premium = Math.max(0.01, sellPrem - buyPrem);
            console.log('[STAGE] Detected put spread from Sell/Buy lines: $' + strike + '/$' + upperStrike);
        } else if (sellPutMatch) {
            tradeType = 'short_put';
            strike = parseFloat(sellPutMatch[1]);
            premium = parseFloat(sellPutMatch[2]);
            console.log('[STAGE] Detected short put: $' + strike + ' @ $' + premium);
        }
    }
    
    // Method 4: Look for single leg patterns "Sell $XX Put" without spread
    if (!spreadMatch && !premium) {
        const singlePutMatch = sectionText?.match(/Sell\s+(?:\w+\s+)?\$(\d+)\s+Put/i);
        const singleCallMatch = sectionText?.match(/Sell\s+(?:\w+\s+)?\$(\d+)\s+Call/i);
        
        if (singlePutMatch) {
            tradeType = 'short_put';
            strike = parseFloat(singlePutMatch[1]);
            console.log('[STAGE] Detected single short put: $' + strike);
        } else if (singleCallMatch) {
            tradeType = 'covered_call';
            isCall = true;
            strike = parseFloat(singleCallMatch[1]);
            console.log('[STAGE] Detected single covered call: $' + strike);
        }
    }
    
    // Method 5: Detect Iron Condor - multiple patterns
    // Pattern A: "Sell TICKER $XX/$XX/$XX/$XX Iron Condor"
    let ironCondorMatch = sectionText?.match(/Sell\s+\w+\s+\$(\d+)\/\$(\d+)\/\$(\d+)\/\$(\d+)\s+Iron\s+Condor/i);
    
    // Pattern B: "Sell TICKER XX/XX Call Credit Spread + XX/XX Put Credit Spread" (Wall Street format)
    if (!ironCondorMatch) {
        const icPatternB = sectionText?.match(/Sell\s+\w+\s+(\d+)\/(\d+)\s+Call\s+(?:Credit\s+)?Spread\s*\+\s*(\d+)\/(\d+)\s+Put\s+(?:Credit\s+)?Spread/i);
        if (icPatternB) {
            ironCondorMatch = icPatternB;
            console.log('[STAGE] Matched Iron Condor Wall Street format');
        }
    }
    
    // Pattern C: Alternative with $ signs - "$110/$115 Call ... + $100/$95 Put"
    if (!ironCondorMatch) {
        const icPatternC = sectionText?.match(/\$(\d+)\/\$(\d+)\s+Call\s+(?:Credit\s+)?Spread\s*\+\s*\$(\d+)\/\$(\d+)\s+Put\s+(?:Credit\s+)?Spread/i);
        if (icPatternC) {
            ironCondorMatch = icPatternC;
            console.log('[STAGE] Matched Iron Condor with $ signs');
        }
    }
    
    if (ironCondorMatch) {
        tradeType = 'iron_condor';
        // For call spread: sell lower, buy higher (bearish side)
        // For put spread: sell higher, buy lower (bullish side)
        const callSell = parseFloat(ironCondorMatch[1]);
        const callBuy = parseFloat(ironCondorMatch[2]);
        const putSell = parseFloat(ironCondorMatch[3]);
        const putBuy = parseFloat(ironCondorMatch[4]);
        
        // Store all four strikes for Iron Condor
        // Primary display: use put sell as "strike" and call sell as "upperStrike"
        strike = putSell;        // Put sell strike (lower wing)
        upperStrike = callSell;  // Call sell strike (upper wing)
        
        // Store full IC details in a way we can reconstruct
        // Format: putBuy/putSell/callSell/callBuy (lowest to highest)
        const sortedStrikes = [putBuy, putSell, callSell, callBuy].sort((a, b) => a - b);
        console.log('[STAGE] Detected Iron Condor: Put ' + putSell + '/' + putBuy + ' | Call ' + callSell + '/' + callBuy);
        console.log('[STAGE] IC strikes (low to high): ' + sortedStrikes.join('/'));
    }
    
    // Method 6: Detect Long Put (E) - "Buy TICKER $XX Put"
    const longPutMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+Put,?\s*(\d{4}-\d{2}-\d{2})?/i);
    if (longPutMatch && !sectionText?.match(/Spread/i)) {
        tradeType = 'long_put';
        isDebit = true;
        strike = parseFloat(longPutMatch[1]);
        if (longPutMatch[2]) expiry = longPutMatch[2];
        console.log('[STAGE] Detected Long Put: $' + strike);
    }
    
    // Method 7: Detect Long Call (F) - "Buy TICKER $XX Call"
    const longCallMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+Call,?\s*(\d{4}-\d{2}-\d{2})?/i);
    if (longCallMatch && !sectionText?.match(/Spread|SKIP|LEAPS|PMCC|Poor Man/i)) {
        tradeType = 'long_call';
        isCall = true;
        isDebit = true;
        strike = parseFloat(longCallMatch[1]);
        if (longCallMatch[2]) expiry = longCallMatch[2];
        console.log('[STAGE] Detected Long Call: $' + strike);
    }
    
    // Method 8: Detect SKIP™ (H) - "Buy TICKER $XX LEAPS Call + Buy $XX SKIP Call"
    const skipMatch = sectionText?.match(/Buy\s+\w+\s+\$(\d+)\s+LEAPS\s+Call.*?\+.*?Buy\s+\$(\d+)\s+SKIP\s+Call/i);
    if (skipMatch) {
        tradeType = 'skip_call';
        isCall = true;
        isDebit = true;
        strike = parseFloat(skipMatch[1]);  // LEAPS strike
        upperStrike = parseFloat(skipMatch[2]);  // SKIP strike
        console.log('[STAGE] Detected SKIP strategy: LEAPS $' + strike + ' + SKIP $' + upperStrike);
    }
    
    // Method 9: Detect PMCC (Poor Man's Covered Call) - "Buy TICKER $XX Call LEAP + Sell $XX Call"
    // Patterns: "Buy SLV Jan 2026 $85 Call LEAP + Sell 110 Call" or "Buy $85 LEAPS Call + Sell $110 Call"
    if (!tradeType.includes('skip')) {
        // Pattern A: "Buy TICKER DATE $XX Call LEAP + Sell XX Call"
        let pmccMatch = sectionText?.match(/Buy\s+\w+\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s+\$?(\d+)\s+Call\s+LEAPS?\s*\+\s*Sell\s+\$?(\d+)\s+Call/i);
        
        // Pattern B: "Buy $XX LEAPS Call + Sell $XX Call"
        if (!pmccMatch) {
            pmccMatch = sectionText?.match(/Buy\s+(?:\w+\s+)?\$?(\d+)\s+(?:LEAPS?\s+)?Call.*?\+\s*Sell\s+\$?(\d+)\s+Call/i);
        }
        
        // Pattern C: Look for PMCC/Poor Man's in the section header and extract strikes
        if (!pmccMatch && sectionText?.match(/Poor Man'?s?|PMCC/i)) {
            const leapsStrike = sectionText?.match(/Buy\s+(?:\w+\s+)?(?:.*?)?\$?(\d+)\s+(?:Call\s+)?LEAPS?/i);
            const sellStrike = sectionText?.match(/Sell\s+\$?(\d+)\s+Call/i);
            if (leapsStrike && sellStrike) {
                pmccMatch = [null, leapsStrike[1], sellStrike[1]];
            }
        }
        
        if (pmccMatch) {
            tradeType = 'pmcc';  // Poor Man's Covered Call
            isCall = true;
            isDebit = true;
            strike = parseFloat(pmccMatch[1]);      // LEAPS strike (buy)
            upperStrike = parseFloat(pmccMatch[2]); // Short call strike (sell)
            console.log('[STAGE] Detected PMCC: Buy $' + strike + ' LEAPS, Sell $' + upperStrike + ' Call');
        }
    }
    
    // Try to find premium from other patterns if still missing
    if (!premium) {
        // "Net Credit: $X.XX" or "Premium: $X.XX" or "Total Credit: $X.XX"
        const altPremMatch = sectionText?.match(/(?:Net\s+Credit|Premium|Credit|Total\s+Credit):\s*\$?(\d+(?:\.\d+)?)/i);
        if (altPremMatch) {
            premium = parseFloat(altPremMatch[1]);
            console.log('[STAGE] Found premium from alt pattern: $' + premium);
        }
    }
    
    // Method 9: For debit trades, look for "Debit Paid: $X.XX" or "Cost per contract: $XXX"
    if (!premium && isDebit) {
        const debitMatch = sectionText?.match(/(?:Debit\s+Paid|Cost\s+per\s+contract):\s*\$?(\d+(?:\.\d+)?)/i);
        if (debitMatch) {
            premium = parseFloat(debitMatch[1]);
            // If it's > 50, it's probably per-contract, convert to per-share
            if (premium > 50) premium = premium / 100;
            console.log('[STAGE] Found debit from pattern: $' + premium.toFixed(2) + '/share');
        }
    }
    
    // Method 10: Calculate from "Max Profit per contract: $XXX" or just "Max Profit: $XXX" (for spreads, premium = maxProfit/100)
    if (!premium && tradeType?.includes('_spread')) {
        // Try with "per contract" first
        let maxProfitMatch = sectionText?.match(/Max\s+Profit\s+per\s+contract:\s*\$?(\d+(?:,\d{3})*)/i);
        // Try without "per contract" (the post-processed format)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/Per\s+Contract:[\s\S]*?Max\s+Profit:\s*\$?(\d+(?:,\d{3})*)/i);
        }
        // Try simple "Max Profit:" pattern (first occurrence, typically per-contract)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/Max\s+Profit:\s*\$?(\d+(?:,\d{3})*)/i);
        }
        // Try table format "| Max Profit | $35 |" (Wall Street Mode)
        if (!maxProfitMatch) {
            maxProfitMatch = sectionText?.match(/\|\s*Max\s+Profit\s*\|\s*\$?(\d+(?:,\d{3})*)/i);
        }
        if (maxProfitMatch) {
            const maxProfitPerContract = parseFloat(maxProfitMatch[1].replace(/,/g, ''));
            premium = maxProfitPerContract / 100;  // Convert back to per-share
            console.log('[STAGE] Calculated premium from max profit: $' + premium.toFixed(2) + '/share');
        }
    }
    
    // For Iron Condor, use total credit
    if (!premium && tradeType === 'iron_condor') {
        const totalCreditMatch = sectionText?.match(/Total\s+Credit:\s*\$?(\d+(?:\.\d+)?)/i);
        if (totalCreditMatch) {
            premium = parseFloat(totalCreditMatch[1]);
            console.log('[STAGE] Found Iron Condor total credit: $' + premium);
        }
    }
    
    // Extract recommended contracts from "Recommended Contracts: X" or "Contracts: X"
    const contractsMatch = sectionText?.match(/(?:Recommended\s+)?Contracts:\s*(\d+)/i);
    if (contractsMatch) {
        contracts = parseInt(contractsMatch[1]);
        console.log('[STAGE] Found contracts: ' + contracts);
    }
    
    // Extract expiration - look for various date patterns
    // Pattern: "Expiration: 2026-03-14" or dates in expirations list
    const expPatterns = [
        /Expiration:\s*(\d{4}-\d{2}-\d{2})/i,
        /Expiry:\s*(\d{4}-\d{2}-\d{2})/i,
        /expire(?:s)?\s*(?:on)?\s*(\d{4}-\d{2}-\d{2})/i,
        /(\d{4}-\d{2}-\d{2})\s*(?:expir|exp)/i
    ];
    
    for (const pattern of expPatterns) {
        const match = sectionText?.match(pattern);
        if (match) {
            expiry = match[1];
            console.log('[STAGE] Found expiry: ' + expiry);
            break;
        }
    }
    
    // If still no expiry, try to find any YYYY-MM-DD date in the recommendation
    if (!expiry) {
        const anyDateMatch = sectionText?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
        if (anyDateMatch) {
            expiry = anyDateMatch[1];
            console.log('[STAGE] Found date: ' + expiry);
        }
    }
    
    // NEW: Try human-readable dates like "Feb 27 '26" or "Feb 27, 2026" (Wall Street Mode)
    if (!expiry) {
        const humanDate = parseHumanDate(recommendation);
        if (humanDate) {
            expiry = humanDate;
            console.log('[STAGE] Found human-readable date: ' + expiry);
        }
    }
    
    // Default expiry to ~45 days out if not found
    if (!expiry) {
        const defaultExpiry = new Date();
        defaultExpiry.setDate(defaultExpiry.getDate() + 45);
        // Find next Friday
        while (defaultExpiry.getDay() !== 5) {
            defaultExpiry.setDate(defaultExpiry.getDate() + 1);
        }
        expiry = defaultExpiry.toISOString().split('T')[0];
        console.log('[STAGE] Using default expiry: ' + expiry);
    }
    
    // =========================================================================
    // STRIKE VALIDATION: Fetch options chain and snap invalid strikes to valid ones
    // =========================================================================
    if (tradeType?.includes('_spread') && strike && upperStrike) {
        try {
            console.log('[STAGE] Validating strikes exist at expiry ' + expiry + '...');
            const chain = await window.fetchOptionsChain(ticker);
            if (chain) {
                const isPut = tradeType.includes('put');
                const options = isPut ? chain.puts : chain.calls;
                
                // Filter to target expiry
                const optsAtExpiry = options?.filter(o => o.expiration === expiry) || [];
                
                if (optsAtExpiry.length > 0) {
                    const validStrikes = [...new Set(optsAtExpiry.map(o => parseFloat(o.strike)))].sort((a, b) => a - b);
                    // Show only nearby strikes (±$20 from current strikes)
                    const nearbyStrikes = validStrikes.filter(s => 
                        Math.abs(s - strike) <= 20 || Math.abs(s - upperStrike) <= 20
                    );
                    console.log('[STAGE] Nearby valid strikes: $' + nearbyStrikes.join(', $'));
                    
                    // Helper to find nearest valid strike
                    const findNearest = (target) => {
                        return validStrikes.reduce((prev, curr) => 
                            Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
                        );
                    };
                    
                    // Validate sell strike
                    const originalSell = strike;
                    if (!validStrikes.includes(strike)) {
                        strike = findNearest(strike);
                        console.log('[STAGE] ⚠️ Sell strike $' + originalSell + ' not available, using nearest: $' + strike);
                    }
                    
                    // Validate buy strike
                    const originalBuy = upperStrike;
                    if (!validStrikes.includes(upperStrike)) {
                        upperStrike = findNearest(upperStrike);
                        console.log('[STAGE] ⚠️ Buy strike $' + originalBuy + ' not available, using nearest: $' + upperStrike);
                    }
                    
                    // Recalculate premium based on actual strikes
                    if (strike !== originalSell || upperStrike !== originalBuy) {
                        const sellOpt = optsAtExpiry.find(o => parseFloat(o.strike) === strike);
                        const buyOpt = optsAtExpiry.find(o => parseFloat(o.strike) === upperStrike);
                        
                        if (sellOpt && buyOpt) {
                            const sellMid = (parseFloat(sellOpt.bid) + parseFloat(sellOpt.ask)) / 2;
                            const buyMid = (parseFloat(buyOpt.bid) + parseFloat(buyOpt.ask)) / 2;
                            const newPremium = isPut ? (sellMid - buyMid) : (buyMid - sellMid);
                            premium = Math.max(0.01, newPremium);
                            console.log('[STAGE] ✅ Recalculated premium with valid strikes: $' + premium.toFixed(2) + '/share');
                        }
                    }
                } else {
                    console.log('[STAGE] ⚠️ No options found at expiry ' + expiry + ', using AI strikes as-is');
                }
            }
        } catch (err) {
            console.log('[STAGE] Could not validate strikes: ' + err.message);
        }
    }
    
    // Stage the trade - use same field names as other staging functions
    const now = Date.now();
    const isExpertMode = lastStrategyAdvisorResult?.expertMode || false;
    
    // For Wall Street Mode, build a thesis structure that preserves the full analysis
    // For Guided Mode, use the existing extractThesisSummary which parses spectrum format
    const openingThesis = {
        analyzedAt: new Date().toISOString(),
        priceAtAnalysis: spot,
        rangePosition: stockData?.rangePosition || null,
        iv: ivRank || null,  // IV rank at time of analysis
        modelUsed: model || 'unknown',
        expertMode: isExpertMode,
        aiSummary: isExpertMode 
            ? {
                // Wall Street Mode: store structured sections
                fullAnalysis: recommendation,
                marketAnalysis: extractSection(recommendation, 'MARKET ANALYSIS'),
                whyThisStrategy: extractSection(recommendation, 'WHY THIS STRATEGY'),
                theRisks: extractSection(recommendation, 'THE RISKS'),
                tradeManagement: extractSection(recommendation, 'TRADE MANAGEMENT'),
                rejectedStrategies: extractSection(recommendation, 'STRATEGIES I CONSIDERED BUT REJECTED')
            }
            : extractThesisSummary(recommendation)
    };
    
    const stagedTrade = {
        id: now,
        ticker,
        type: tradeType,
        strike,
        upperStrike,
        premium: premium || null,
        expiry,
        contracts: contracts,
        isCall,
        isDebit,
        source: isExpertMode ? 'Wall Street Mode' : 'Strategy Advisor',
        stagedAt: now,  // For display in render
        currentPrice: spot,
        openingThesis
    };
    
    // Add to pending trades in localStorage (not just window.pendingTrades)
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const isDuplicate = pending.some(p => 
        p.ticker === stagedTrade.ticker && 
        p.strike === stagedTrade.strike && 
        p.type === stagedTrade.type
    );
    
    if (isDuplicate) {
        showNotification(`${ticker} already staged with same strike/type`, 'info');
        return;
    }
    
    pending.unshift(stagedTrade);  // Add to front of array
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    renderPendingTrades();
    showNotification(`✅ Staged ${ticker} ${tradeType.replace(/_/g, ' ')} - check Ideas tab`, 'success');
};

export const runStrategyAdvisor = window.runStrategyAdvisor;
export const stageStrategyAdvisorTrade = window.stageStrategyAdvisorTrade;
