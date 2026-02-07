/**
 * WeeklySummaryService.js - Week Ending Summary UI & Logic
 * 
 * Provides:
 * - Modal for viewing current week's summary
 * - AI analysis of performance
 * - Historical summary view
 * - Save/export functionality
 */

console.log('[SUMMARY] WeeklySummaryService.js loading...');

class WeeklySummaryService {
    constructor() {
        this.currentSummary = null;
        this.history = [];
        console.log('[SUMMARY] Service instance created');
    }
    
    /**
     * Generate and show the weekly summary modal
     */
    async show() {
        // Get account value from AccountService
        let accountValue = 0;
        if (window.AccountService) {
            accountValue = window.AccountService.getAccountValue() || 0;
        }
        
        // Show loading modal
        this.showModal(this.buildLoadingContent());
        
        try {
            // ============================================
            // READ FROM FRONTEND STATE (localStorage)
            // NOT from server autosave - they're different!
            // ============================================
            
            // Get closed positions from frontend state (account-specific localStorage)
            const allClosed = window.state?.closedPositions || [];
            const allHoldings = window.state?.holdings || [];
            const allPositions = window.state?.positions || [];
            
            console.log('[SUMMARY] Frontend state:', {
                closedPositions: allClosed.length,
                holdings: allHoldings.length,
                positions: allPositions.length
            });
            
            // Filter for trades closed THIS WEEK (Sunday 12:00 AM to now)
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - dayOfWeek);
            startOfWeek.setHours(0, 0, 0, 0);
            
            const closedThisWeek = allClosed.filter(pos => {
                if (!pos.closeDate) return false;
                const closeDate = new Date(pos.closeDate);
                return closeDate >= startOfWeek && closeDate <= now;
            });
            
            const holdings = allHoldings;
            
            console.log('[SUMMARY] Week filter:', {
                startOfWeek: startOfWeek.toISOString(),
                now: now.toISOString(),
                allClosed: allClosed.length,
                closedThisWeek: closedThisWeek.length
            });
            console.log('[SUMMARY] Closed this week:', closedThisWeek.map(p => `${p.ticker} $${p.strike} closed ${p.closeDate}`));
            
            // Get the latest X Sentiment report if available (from "Trending on X" feature)
            let xSentimentData = null;
            try {
                const saved = localStorage.getItem('wheelhouse_x_sentiment');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    // Only use if less than 24 hours old
                    const ageHours = (Date.now() - parsed.timestamp) / (1000 * 60 * 60);
                    if (ageHours < 24) {
                        xSentimentData = {
                            html: parsed.html,
                            tickers: parsed.tickers,
                            timestamp: new Date(parsed.timestamp).toLocaleString(),
                            ageHours: ageHours.toFixed(1)
                        };
                        console.log('[SUMMARY] Including X Sentiment data:', {
                            tickers: xSentimentData.tickers?.length,
                            age: `${xSentimentData.ageHours} hours old`
                        });
                    } else {
                        console.log('[SUMMARY] X Sentiment data too old (', ageHours.toFixed(1), 'hours), skipping');
                    }
                }
            } catch (e) {
                console.log('[SUMMARY] No X Sentiment data available');
            }
            
            // Generate summary from server
            // Include options positions for AI analysis
            const res = await fetch('/api/summary/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    accountValue, 
                    closedThisWeek, 
                    holdings,
                    positions: allPositions,  // Open options positions
                    xSentiment: xSentimentData // X/Twitter sentiment if available
                })
            });
            const data = await res.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Failed to generate summary');
            }
            
            this.currentSummary = data.summary;
            
            // Load history for context
            await this.loadHistory();
            
            // Update modal with summary content
            this.updateModalContent(this.buildSummaryContent(this.currentSummary));
            
        } catch (e) {
            console.error('[SUMMARY] Error:', e);
            this.updateModalContent(`
                <div style="text-align:center; padding:40px;">
                    <div style="font-size:48px; margin-bottom:20px;">❌</div>
                    <div style="color:#ff5252; font-size:18px; margin-bottom:10px;">Error Generating Summary</div>
                    <div style="color:#888;">${e.message}</div>
                </div>
            `);
        }
    }
    
    /**
     * Load summary history
     */
    async loadHistory() {
        try {
            const res = await fetch('/api/summary/history');
            const data = await res.json();
            if (data.success) {
                this.history = data.summaries || [];
            }
        } catch (e) {
            console.error('[SUMMARY] Error loading history:', e);
        }
    }
    
    /**
     * Build loading content
     */
    buildLoadingContent() {
        return `
            <div style="text-align:center; padding:60px;">
                <div class="spinner" style="width:40px; height:40px; margin:0 auto 20px;"></div>
                <div style="color:#00d9ff; font-size:16px;">Generating Week Summary...</div>
                <div style="color:#888; font-size:12px; margin-top:8px;">Calculating P&L for all positions</div>
            </div>
        `;
    }
    
    /**
     * Build the summary content HTML
     */
    buildSummaryContent(summary) {
        const weekChange = this.getWeekChange(summary);
        const positions = summary.positions || [];
        const sorted = [...positions].sort((a, b) => a.unrealizedPnL - b.unrealizedPnL);
        
        return `
            <div style="padding:20px;" onclick="event.stopPropagation();">
                <!-- Header -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid #333;">
                    <div style="display:flex; align-items:center; gap:15px;">
                        <button type="button" id="weekSummaryCloseBtn" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer; padding:0; line-height:1;">&times;</button>
                        <div>
                            <h2 style="margin:0; color:#fff;">📊 Week Ending Summary</h2>
                            <div style="color:#888; font-size:12px; margin-top:4px;">${summary.weekEnding}</div>
                        </div>
                    </div>
                    <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
                        <div style="display:flex; gap:10px;">
                            <button type="button" id="summaryAIBtn" class="btn-primary" style="padding:8px 16px;">
                                🤖 AI Analysis
                            </button>
                            <button type="button" id="summarySaveBtn" class="btn-primary" style="padding:8px 16px; background:linear-gradient(135deg, rgba(0,255,136,0.2), rgba(0,255,136,0.1)); border-color:rgba(0,255,136,0.4);">
                                💾 Save to History
                            </button>
                            <button type="button" id="summaryPrintBtn" class="btn-primary" style="padding:8px 16px; background:linear-gradient(135deg, rgba(100,100,255,0.2), rgba(100,100,255,0.1)); border-color:rgba(100,100,255,0.4);">
                                🖨️ Print Report
                            </button>
                        </div>
                        <div id="xSentimentHint" style="font-size:11px; transition:all 0.2s;"></div>
                    </div>
                </div>
                
                <!-- Key Metrics Grid -->
                <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:15px; margin-bottom:25px;">
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Account Value</div>
                        <div style="font-size:24px; font-weight:600; color:#fff;">$${(summary.accountValue || 0).toLocaleString()}</div>
                        ${weekChange !== null ? `<div style="font-size:12px; color:${weekChange >= 0 ? '#00ff88' : '#ff5252'}; margin-top:4px;">${weekChange >= 0 ? '+' : ''}$${weekChange.toLocaleString()} this week</div>` : ''}
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Unrealized P&L</div>
                        <div style="font-size:24px; font-weight:600; color:${summary.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">${summary.unrealizedPnL >= 0 ? '+' : ''}$${(summary.unrealizedPnL || 0).toLocaleString()}</div>
                        <div style="font-size:11px; color:#666; margin-top:4px;">Open positions</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Realized P&L</div>
                        <div style="font-size:24px; font-weight:600; color:${(summary.realizedPnL || 0) >= 0 ? '#00ff88' : '#ff5252'};">${(summary.realizedPnL || 0) >= 0 ? '+' : ''}$${(summary.realizedPnL || 0).toLocaleString()}</div>
                        <div style="font-size:11px; color:#666; margin-top:4px;">${(summary.closedThisWeek || []).length} closed</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Leverage</div>
                        <div style="font-size:24px; font-weight:600; color:${this.getLeverageColor(summary.leverageRatio)};">${summary.leverageRatio || 0}%</div>
                        <div style="font-size:11px; color:#888; margin-top:4px;">$${(summary.capitalAtRisk || 0).toLocaleString()} at risk</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Positions</div>
                        <div style="font-size:24px; font-weight:600; color:#00d9ff;">${summary.totalOpenPositions || 0}</div>
                        <div style="font-size:11px; color:#888; margin-top:4px;">
                            <span style="color:#00ff88;">${summary.positionsInProfit || 0}↑</span> 
                            <span style="color:#ff5252;">${summary.positionsAtLoss || 0}↓</span>
                        </div>
                    </div>
                </div>
                
                <!-- Closed This Week (if any) -->
                ${(summary.closedThisWeek || []).length > 0 ? `
                <div style="margin-bottom:20px;">
                    <h3 style="color:#00ff88; font-size:13px; text-transform:uppercase; margin-bottom:10px;">💰 Realized This Week (${summary.closedThisWeek.length} trades)</h3>
                    <div style="display:grid; gap:8px;">
                        ${summary.closedThisWeek.map(pos => `
                            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,255,136,0.05); border-radius:6px; padding:10px 15px; border-left:3px solid ${(pos.realizedPnL || 0) >= 0 ? '#00ff88' : '#ff5252'};">
                                <div>
                                    <span style="font-weight:600; color:#fff;">${pos.ticker}</span>
                                    <span style="color:#888; font-size:12px; margin-left:8px;">$${pos.strike} ${this.formatType(pos.type)}</span>
                                    <span style="color:#666; font-size:11px; margin-left:8px;">${pos.closeReason || 'closed'}</span>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-weight:600; color:${(pos.realizedPnL || 0) >= 0 ? '#00ff88' : '#ff5252'};">
                                        ${(pos.realizedPnL || 0) >= 0 ? '+' : ''}$${(pos.realizedPnL || 0).toLocaleString()}
                                    </div>
                                    <div style="font-size:11px; color:#888;">${pos.closeDate || ''}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- Open Positions (compact cards) -->
                <div style="margin-bottom:20px;">
                    <h3 style="color:#888; font-size:13px; text-transform:uppercase; margin-bottom:10px;">📋 Open Positions (${sorted.length})</h3>
                    <div style="display:grid; gap:8px;">
                        ${sorted.map(pos => `
                            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); border-radius:6px; padding:10px 15px; border-left:3px solid ${pos.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">
                                <div>
                                    <span style="font-weight:600; color:#fff;">${pos.ticker}</span>
                                    <span style="color:#888; font-size:12px; margin-left:8px;">$${pos.strike} ${this.formatType(pos.type)}</span>
                                    <span style="color:${pos.dte <= 7 ? '#ff5252' : pos.dte <= 21 ? '#ffaa00' : '#666'}; font-size:11px; margin-left:8px;">${pos.dte || '—'} DTE</span>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-weight:600; color:${pos.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">
                                        ${pos.unrealizedPnL >= 0 ? '+' : ''}$${(pos.unrealizedPnL || 0).toLocaleString()}
                                    </div>
                                    <div style="font-size:11px; color:#888;">${pos.pnlPercent || 0}%</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <!-- AI Analysis Section (initially hidden) -->
                <div id="summaryAISection" style="display:none; margin-top:20px;">
                    <h3 style="color:#888; font-size:13px; text-transform:uppercase; margin-bottom:10px;">🤖 AI Analysis</h3>
                    <div id="summaryAIContent" style="background:rgba(0,0,0,0.2); border:1px solid #333; border-radius:8px; padding:20px;">
                        <!-- AI content will be inserted here -->
                    </div>
                </div>
                
                <!-- History Section -->
                ${this.history.length > 0 ? `
                <div style="margin-top:25px; padding-top:20px; border-top:1px solid #333;">
                    <h3 style="color:#888; font-size:13px; text-transform:uppercase; margin-bottom:10px;">📈 Saved History (click to view)</h3>
                    <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px;">
                        ${this.history.slice(-12).reverse().map((h, idx) => `
                            <div class="history-card" data-week="${h.weekEnding}" style="background:rgba(0,0,0,0.2); border-radius:6px; padding:12px; text-align:center; cursor:pointer; transition:all 0.2s; border:1px solid transparent;" onmouseover="this.style.borderColor='#00d9ff'; this.style.background='rgba(0,217,255,0.1)';" onmouseout="this.style.borderColor='transparent'; this.style.background='rgba(0,0,0,0.2)';">
                                <div style="font-size:10px; color:#888;">${h.weekEnding}</div>
                                <div style="font-size:16px; font-weight:600; color:#fff; margin:4px 0;">$${(h.accountValue || 0).toLocaleString()}</div>
                                <div style="font-size:12px; color:${h.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">${h.unrealizedPnL >= 0 ? '+' : ''}$${(h.unrealizedPnL || 0).toLocaleString()}</div>
                                ${h.aiAnalysis ? '<div style="font-size:10px; color:#00d9ff; margin-top:4px;">🤖 AI saved</div>' : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }
    
    /**
     * Get week-over-week change
     */
    getWeekChange(summary) {
        if (this.history.length === 0) return null;
        const prevWeek = this.history[this.history.length - 1];
        if (!prevWeek || prevWeek.weekEnding === summary.weekEnding) {
            // Same week or no history
            if (this.history.length > 1) {
                const olderWeek = this.history[this.history.length - 2];
                return summary.accountValue - (olderWeek.accountValue || 0);
            }
            return null;
        }
        return summary.accountValue - (prevWeek.accountValue || 0);
    }
    
    /**
     * Get leverage zone color
     */
    getLeverageColor(ratio) {
        if (ratio <= 100) return '#00ff88';
        if (ratio <= 200) return '#ffaa00';
        if (ratio <= 300) return '#ff7744';
        return '#ff5252';
    }
    
    /**
     * Update X/Twitter sentiment hint based on current model selection
     */
    updateXSentimentHint() {
        const hintEl = document.getElementById('xSentimentHint');
        if (!hintEl) return;
        
        const modelSelect = document.getElementById('globalAiModelSelect');
        const model = modelSelect?.value || '';
        const isGrok = model.toLowerCase().startsWith('grok');
        
        if (isGrok) {
            // Grok selected - show enabled badge
            hintEl.innerHTML = `<span style="color:#1DA1F2;">✓ <strong>𝕏</strong> Live sentiment enabled</span>`;
            hintEl.style.cursor = 'default';
            hintEl.onclick = null;
        } else {
            // Not Grok - show hint to switch
            hintEl.innerHTML = `<span style="color:#888;">🐦 <a href="#" id="switchToGrokLink" style="color:#1DA1F2; text-decoration:underline;">Switch to Grok</a> for live 𝕏 sentiment</span>`;
            hintEl.style.cursor = 'pointer';
            
            // Add click handler to switch to Grok
            setTimeout(() => {
                const link = document.getElementById('switchToGrokLink');
                if (link) {
                    link.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const select = document.getElementById('globalAiModelSelect');
                        if (select) {
                            // Find first Grok option
                            const grokOption = Array.from(select.options).find(opt => 
                                opt.value.toLowerCase().startsWith('grok')
                            );
                            if (grokOption) {
                                select.value = grokOption.value;
                                select.dispatchEvent(new Event('change'));
                                this.updateXSentimentHint();
                            } else {
                                alert('Grok models are not available. Check Settings → AI to configure your Grok API key.');
                            }
                        }
                    };
                }
            }, 0);
        }
    }
    
    /**
     * Format position type for display
     */
    formatType(type) {
        const map = {
            'short_put': 'Short Put',
            'covered_call': 'Covered Call',
            'long_call': 'Long Call',
            'long_put': 'Long Put',
            'call_credit_spread': 'Call Credit',
            'put_credit_spread': 'Put Credit',
            'call_debit_spread': 'Call Debit',
            'put_debit_spread': 'Put Debit'
        };
        return map[type] || type;
    }
    
    /**
     * Show a historical summary (when clicking on a history card)
     */
    showHistoricalSummary(weekEnding) {
        const historicalData = this.history.find(h => h.weekEnding === weekEnding);
        if (!historicalData) {
            alert('Could not find summary for ' + weekEnding);
            return;
        }
        
        this.updateModalContent(this.buildHistoricalContent(historicalData));
    }
    
    /**
     * Build content for viewing a historical summary
     */
    buildHistoricalContent(summary) {
        const positions = summary.positions || [];
        const sorted = [...positions].sort((a, b) => a.unrealizedPnL - b.unrealizedPnL);
        
        return `
            <div style="padding:20px;" onclick="event.stopPropagation();">
                <!-- Header -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid #333;">
                    <div style="display:flex; align-items:center; gap:15px;">
                        <button type="button" id="weekSummaryCloseBtn" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer; padding:0; line-height:1;">&times;</button>
                        <div>
                            <h2 style="margin:0; color:#fff;">📜 Historical Summary</h2>
                            <div style="color:#00d9ff; font-size:14px; margin-top:4px;">${summary.weekEnding}</div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button type="button" id="backToCurrentBtn" class="btn-primary" style="padding:8px 16px;">
                            ← Back to Current Week
                        </button>
                    </div>
                </div>
                
                <!-- Key Metrics Grid -->
                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:15px; margin-bottom:25px;">
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Account Value</div>
                        <div style="font-size:24px; font-weight:600; color:#fff;">$${(summary.accountValue || 0).toLocaleString()}</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Unrealized P&L</div>
                        <div style="font-size:24px; font-weight:600; color:${summary.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">${summary.unrealizedPnL >= 0 ? '+' : ''}$${(summary.unrealizedPnL || 0).toLocaleString()}</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Leverage</div>
                        <div style="font-size:24px; font-weight:600; color:${this.getLeverageColor(summary.leverageRatio)};">${summary.leverageRatio || 0}%</div>
                        <div style="font-size:11px; color:#888; margin-top:4px;">$${(summary.capitalAtRisk || 0).toLocaleString()} at risk</div>
                    </div>
                    <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; text-align:center;">
                        <div style="font-size:11px; color:#888; text-transform:uppercase; margin-bottom:5px;">Positions</div>
                        <div style="font-size:24px; font-weight:600; color:#fff;">${positions.length}</div>
                        <div style="font-size:11px; color:#888; margin-top:4px;">${summary.winnersCount || 0} 🟢 ${summary.losersCount || 0} 🔴</div>
                    </div>
                </div>
                
                ${summary.aiAnalysis ? `
                <!-- Saved AI Analysis -->
                <div style="margin-bottom:25px; background:linear-gradient(135deg, rgba(0,217,255,0.1), rgba(0,217,255,0.02)); border:1px solid rgba(0,217,255,0.3); border-radius:8px; padding:20px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:15px;">
                        <span style="font-size:20px;">🤖</span>
                        <h3 style="margin:0; color:#00d9ff; font-size:14px;">AI Analysis (saved ${summary.aiAnalysisDate ? new Date(summary.aiAnalysisDate).toLocaleDateString() : ''})</h3>
                    </div>
                    <div style="color:#e0e0e0; line-height:1.7; white-space:pre-wrap; font-size:14px;">${summary.aiAnalysis}</div>
                </div>
                ` : `
                <div style="margin-bottom:25px; background:rgba(100,100,100,0.1); border:1px solid #444; border-radius:8px; padding:20px; text-align:center;">
                    <div style="color:#888;">No AI analysis was saved for this week</div>
                </div>
                `}
                
                <!-- Positions at that time -->
                ${positions.length > 0 ? `
                <div style="margin-bottom:25px;">
                    <h3 style="color:#888; font-size:13px; text-transform:uppercase; margin-bottom:10px;">📋 Positions That Week</h3>
                    <div style="display:grid; gap:8px;">
                        ${sorted.map(pos => `
                            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); border-radius:6px; padding:10px 15px; border-left:3px solid ${pos.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">
                                <div>
                                    <span style="font-weight:600; color:#fff;">${pos.ticker}</span>
                                    <span style="color:#888; font-size:12px; margin-left:8px;">$${pos.strike} ${this.formatType(pos.type)}</span>
                                    <span style="color:#666; font-size:11px; margin-left:8px;">${pos.expiry}</span>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-weight:600; color:${pos.unrealizedPnL >= 0 ? '#00ff88' : '#ff5252'};">
                                        ${pos.unrealizedPnL >= 0 ? '+' : ''}$${(pos.unrealizedPnL || 0).toLocaleString()}
                                    </div>
                                    <div style="font-size:11px; color:#888;">${pos.pnlPercent || 0}%</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- Back to history list -->
                <div style="margin-top:25px; padding-top:20px; border-top:1px solid #333; text-align:center;">
                    <button type="button" id="backToCurrentBtn2" class="btn-primary" style="padding:10px 24px;">
                        ← Back to Current Week
                    </button>
                </div>
            </div>
        `;
    }
    
    /**
     * Run AI analysis - Multi-step deep analysis pipeline with SSE progress
     */
    async runAIAnalysis() {
        console.log('[SUMMARY] runAIAnalysis called, currentSummary:', !!this.currentSummary);
        
        let btn, section, content;
        
        try {
            if (!this.currentSummary) {
                console.log('[SUMMARY] No currentSummary, aborting');
                alert('No summary data available. Please wait for the summary to load.');
                return;
            }
            
            btn = document.getElementById('summaryAIBtn');
            section = document.getElementById('summaryAISection');
            content = document.getElementById('summaryAIContent');
            
            console.log('[SUMMARY] Elements found:', { btn: !!btn, section: !!section, content: !!content });
            
            if (!section || !content) {
                console.error('[SUMMARY] Missing DOM elements for AI section');
                alert('UI error: AI section not found. Please re-open the modal.');
                return;
            }
            
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner" style="width:14px; height:14px; display:inline-block; margin-right:6px;"></span> Analyzing...';
            }
            
            section.style.display = 'block';
            
            // Build progress UI - 4 steps
            content.innerHTML = `
                <div id="aiProgressContainer" style="padding:20px;">
                    <div style="margin-bottom:20px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                            <span style="color:#888; font-size:12px;">Deep Analysis Pipeline</span>
                            <span id="aiProgressPercent" style="color:#00d9ff; font-size:12px;">0%</span>
                        </div>
                        <div style="background:rgba(0,0,0,0.3); border-radius:4px; height:8px; overflow:hidden;">
                            <div id="aiProgressBar" style="background:linear-gradient(90deg, #00d9ff, #00ff88); height:100%; width:0%; transition:width 0.3s;"></div>
                        </div>
                    </div>
                    <div id="aiStepsList" style="font-size:13px;">
                        <div id="step1" class="ai-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                            <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                            <span>Identifying at-risk positions...</span>
                        </div>
                        <div id="step2" class="ai-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                            <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                            <span>Running position checkups...</span>
                        </div>
                        <div id="step3" class="ai-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                            <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                            <span>Running portfolio audit...</span>
                        </div>
                        <div id="step4" class="ai-step" style="display:flex; align-items:center; gap:10px; padding:8px 0; opacity:0.5;">
                            <span class="step-icon" style="width:20px; text-align:center;">⏳</span>
                            <span>Creating comprehensive report...</span>
                        </div>
                    </div>
                </div>
            `;
            
            // Get selected model
            const modelSelect = document.getElementById('globalAiModelSelect');
            const model = modelSelect?.value || 'qwen2.5:14b';
            console.log('[SUMMARY] Calling deep analysis with model:', model);
            
            // Use SSE for progress updates
            const response = await fetch('/api/summary/analyze-deep', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({ summary: this.currentSummary, model })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Process SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.substring(6));
                            
                            if (data.type === 'progress') {
                                // Update progress UI
                                this.updateProgress(data.step, data.message, data.totalSteps || 4, data);
                            } else if (data.type === 'complete') {
                                finalResult = data;
                            } else if (data.type === 'error') {
                                throw new Error(data.error);
                            }
                        } catch (parseErr) {
                            console.log('[SUMMARY] SSE parse error:', parseErr);
                        }
                    }
                }
            }
            
            if (!finalResult) {
                throw new Error('No result received from analysis pipeline');
            }
            
            console.log('[SUMMARY] Deep analysis complete:', finalResult.success);
            
            // Display final report with pipeline details
            this.displayDeepAnalysisResult(content, finalResult);
            
            // Store AI analysis in summary
            this.currentSummary.aiAnalysis = finalResult.analysis;
            this.currentSummary.pipelineData = finalResult.pipeline;
            
        } catch (e) {
            console.error('[SUMMARY] AI error:', e);
            if (content) {
                content.innerHTML = `
                    <div style="color:#ff5252; text-align:center; padding:20px;">
                        ❌ ${e.message}
                    </div>
                `;
            } else {
                alert('Error running AI analysis: ' + e.message);
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '🤖 AI Analysis';
            }
        }
    }
    
    /**
     * Update progress UI during SSE stream
     */
    updateProgress(step, message, totalSteps, data) {
        const progressBar = document.getElementById('aiProgressBar');
        const progressPercent = document.getElementById('aiProgressPercent');
        const stepEl = document.getElementById(`step${step}`);
        
        // Update progress bar
        const pct = Math.round((step / totalSteps) * 100);
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (progressPercent) progressPercent.textContent = `${pct}%`;
        
        // Mark previous steps as complete
        for (let i = 1; i < step; i++) {
            const prevStep = document.getElementById(`step${i}`);
            if (prevStep) {
                prevStep.style.opacity = '1';
                prevStep.querySelector('.step-icon').textContent = '✅';
            }
        }
        
        // Update current step
        if (stepEl) {
            stepEl.style.opacity = '1';
            stepEl.querySelector('.step-icon').innerHTML = '<span class="spinner" style="width:16px; height:16px; display:inline-block;"></span>';
            
            // Update step message with details
            let detailMsg = message;
            if (data.atRiskCount !== undefined && step === 2) {
                if (data.atRiskCount === 0) {
                    detailMsg = 'All positions healthy - skipping checkups';
                } else {
                    detailMsg = `Analyzing ${data.atRiskCount} at-risk positions...`;
                }
            }
            stepEl.querySelector('span:last-child').textContent = detailMsg;
        }
    }
    
    /**
     * Display the deep analysis result with expandable sections
     */
    displayDeepAnalysisResult(container, result) {
        const pipeline = result.pipeline || {};
        const atRisk = pipeline.atRiskPositions || [];
        
        // Helper for urgency colors
        const getUrgencyStyle = (urgency) => {
            if (urgency === 'URGENT') return { bg: 'rgba(255,82,82,0.2)', border: '#ff5252', icon: '🔴' };
            if (urgency === 'ACTION') return { bg: 'rgba(255,152,0,0.2)', border: '#ff9800', icon: '🟠' };
            return { bg: 'rgba(255,235,59,0.15)', border: '#ffeb3b', icon: '🟡' }; // WATCH
        };
        
        container.innerHTML = `
            <!-- Main Report -->
            <div style="white-space:pre-wrap; line-height:1.6; color:#ddd; margin-bottom:25px;">
                ${this.formatAIResponse(result.analysis || '')}
            </div>
            
            <!-- Expandable Pipeline Details -->
            <details style="margin-top:20px; border-top:1px solid #333; padding-top:15px;">
                <summary style="cursor:pointer; color:#888; font-size:12px; padding:5px 0;">
                    🔬 View Analysis Details (${atRisk.length} positions reviewed)
                </summary>
                
                <div style="margin-top:15px; padding:15px; background:rgba(0,0,0,0.2); border-radius:8px;">
                    ${atRisk.length > 0 ? `
                    <div style="margin-bottom:20px;">
                        <h4 style="color:#888; margin:0 0 10px;">📊 Positions Reviewed</h4>
                        <div style="font-size:10px; color:#666; margin-bottom:10px;">
                            🔴 URGENT (≤7 DTE) &nbsp;|&nbsp; 🟠 ACTION (8-21 DTE) &nbsp;|&nbsp; 🟡 WATCH (22+ DTE)
                        </div>
                        ${atRisk.map(p => {
                            const style = getUrgencyStyle(p.urgency);
                            return `
                            <div style="background:${style.bg}; border-left:3px solid ${style.border}; margin-bottom:8px; padding:10px; border-radius:4px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <span style="color:#fff; font-weight:600;">${style.icon} ${p.ticker} $${p.strike} (${p.type?.replace('_', ' ')})</span>
                                    <div style="text-align:right;">
                                        <span style="color:${p.pnl >= 0 ? '#00ff88' : '#ff5252'}; font-weight:600;">${p.pnl >= 0 ? '+' : ''}$${p.pnl}</span>
                                        <span style="color:#888; font-size:11px; margin-left:8px;">${p.dte || '?'} DTE</span>
                                    </div>
                                </div>
                                <div style="font-size:11px; color:#aaa; margin-top:4px;">${p.reasons?.join(' • ') || ''}</div>
                            </div>
                        `}).join('')}
                    </div>
                    ` : '<div style="color:#00ff88; margin-bottom:15px;">✅ No positions need attention right now!</div>'}
                    
                    ${pipeline.positionCheckups ? `
                    <details style="margin-bottom:15px;">
                        <summary style="cursor:pointer; color:#00d9ff; font-size:12px;">📋 Position Checkups (AI #1)</summary>
                        <div style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.2); border-radius:4px; white-space:pre-wrap; font-size:12px; color:#aaa;">
                            ${this.formatAIResponse(pipeline.positionCheckups)}
                        </div>
                    </details>
                    ` : ''}
                    
                    ${pipeline.portfolioAudit ? `
                    <details style="margin-bottom:15px;">
                        <summary style="cursor:pointer; color:#00d9ff; font-size:12px;">🏛️ Portfolio Audit (AI #2)</summary>
                        <div style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.2); border-radius:4px; white-space:pre-wrap; font-size:12px; color:#aaa;">
                            ${this.formatAIResponse(pipeline.portfolioAudit)}
                        </div>
                    </details>
                    ` : ''}
                </div>
            </details>
            
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; font-size:11px; color:#666;">
                Model: ${result.model} • 3-stage pipeline (checkups → audit → synthesis)
            </div>
        `;
    }
    
    /**
     * Format AI response with basic markdown
     */
    formatAIResponse(text) {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#fff;">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/^### (.*?)$/gm, '<h4 style="color:#00d9ff; margin:15px 0 8px;">$1</h4>')
            .replace(/^## (.*?)$/gm, '<h3 style="color:#00d9ff; margin:20px 0 10px;">$1</h3>')
            .replace(/^# (.*?)$/gm, '<h2 style="color:#00d9ff; margin:20px 0 10px;">$1</h2>')
            .replace(/^- (.*?)$/gm, '<div style="margin-left:15px;">• $1</div>')
            .replace(/^(\d+)\. (.*?)$/gm, '<div style="margin-left:15px;">$1. $2</div>');
    }
    
    /**
     * Format AI response for print (clean, black & white friendly)
     */
    formatForPrint(text) {
        if (!text) return '';
        
        return text
            // Headers with emoji - make them section titles with proper styling
            .replace(/^###\s*([📊💰⚠️📈📋🎯🤖📌🔴🟠🟡✅❌⭐🏆💡🔥📉📈🚀💎🐦]?\s*.*?)$/gm, 
                '<h3 style="color:#0066cc; font-size:13pt; margin:20px 0 10px; padding-bottom:5px; border-bottom:1px solid #ccc;">$1</h3>')
            .replace(/^##\s*([📊💰⚠️📈📋🎯🤖📌🔴🟠🟡✅❌⭐🏆💡🔥📉📈🚀💎🐦]?\s*.*?)$/gm, 
                '<h2 style="color:#000; font-size:14pt; margin:25px 0 12px; padding-bottom:5px; border-bottom:2px solid #333;">$1</h2>')
            .replace(/^#\s*([📊💰⚠️📈📋🎯🤖📌🔴🟠🟡✅❌⭐🏆💡🔥📉📈🚀💎🐦]?\s*.*?)$/gm, 
                '<h1 style="color:#000; font-size:16pt; margin:25px 0 15px;">$1</h1>')
            // Bold text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            // Italic text
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            // Bullet points
            .replace(/^[•\-]\s+(.*?)$/gm, '<li style="margin-left:20px; margin-bottom:6px;">$1</li>')
            // Numbered lists
            .replace(/^(\d+)\.\s+(.*?)$/gm, '<li style="margin-left:20px; margin-bottom:6px;"><strong>$1.</strong> $2</li>')
            // Wrap consecutive list items in <ul>
            .replace(/(<li[^>]*>.*?<\/li>\n?)+/g, '<ul style="list-style:none; padding:0; margin:10px 0;">$&</ul>')
            // Paragraphs - double newlines become paragraph breaks
            .replace(/\n\n+/g, '</p><p style="margin:12px 0; line-height:1.6;">')
            // Single newlines in remaining text become line breaks
            .replace(/\n/g, '<br>')
            // Wrap in paragraph
            .replace(/^(.+)/, '<p style="margin:12px 0; line-height:1.6;">$1')
            .replace(/(.+)$/, '$1</p>')
            // Clean up empty paragraphs
            .replace(/<p[^>]*>\s*<\/p>/g, '')
            // Clean up nested ul issues
            .replace(/<\/ul>\s*<ul[^>]*>/g, '');
    }
    
    /**
     * Save summary to history
     */
    async saveSummary() {
        if (!this.currentSummary) return;
        
        const btn = document.getElementById('summarySaveBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '💾 Saving...';
        }
        
        try {
            const res = await fetch('/api/summary/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ summary: this.currentSummary })
            });
            
            const data = await res.json();
            
            if (!data.success) {
                throw new Error(data.error || 'Save failed');
            }
            
            // Reload history
            await this.loadHistory();
            
            if (window.showNotification) {
                window.showNotification('Summary saved to history!', 'success');
            }
            
            if (btn) {
                btn.innerHTML = '✅ Saved!';
                setTimeout(() => {
                    btn.innerHTML = '💾 Save to History';
                    btn.disabled = false;
                }, 2000);
            }
            
        } catch (e) {
            console.error('[SUMMARY] Save error:', e);
            if (window.showNotification) {
                window.showNotification('Failed to save: ' + e.message, 'error');
            }
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '💾 Save to History';
            }
        }
    }
    
    /**
     * Print the Week Summary report
     */
    printReport() {
        if (!this.currentSummary) {
            alert('No summary to print. Please generate a summary first.');
            return;
        }
        
        const summary = this.currentSummary;
        const modal = document.getElementById('weekSummaryModal');
        
        // Get the AI analysis content if available
        const contentDiv = modal?.querySelector('#weekSummaryContent');
        let aiAnalysisHtml = '';
        
        // Try to get the AI analysis section (the main report)
        const reportDiv = contentDiv?.querySelector('[style*="white-space:pre-wrap"]');
        if (reportDiv) {
            // Get raw text and reformat for print
            aiAnalysisHtml = this.formatForPrint(summary.aiAnalysis || reportDiv.textContent);
        } else if (summary.aiAnalysis) {
            aiAnalysisHtml = this.formatForPrint(summary.aiAnalysis);
        }
        
        // Build print-friendly HTML
        const printContent = `
<!DOCTYPE html>
<html>
<head>
    <title>Week Ending Summary - ${summary.weekEnding}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 12pt;
            line-height: 1.5;
            color: #333;
            padding: 20px;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 {
            font-size: 18pt;
            margin-bottom: 5px;
            color: #000;
        }
        .subtitle {
            color: #666;
            font-size: 11pt;
            margin-bottom: 20px;
        }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin-bottom: 25px;
        }
        .metric-box {
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 12px;
            text-align: center;
        }
        .metric-label {
            font-size: 9pt;
            color: #666;
            text-transform: uppercase;
            margin-bottom: 3px;
        }
        .metric-value {
            font-size: 16pt;
            font-weight: 600;
        }
        .positive { color: #0a0; }
        .negative { color: #c00; }
        .warning { color: #c80; }
        
        .ai-report {
            margin-top: 20px;
            padding-top: 15px;
            border-top: 2px solid #333;
        }
        .ai-report h2, .ai-report h3, .ai-report h4 {
            margin-top: 18px;
            margin-bottom: 8px;
            color: #000;
        }
        .ai-report h2 { font-size: 14pt; }
        .ai-report h3 { font-size: 12pt; }
        .ai-report h4 { font-size: 11pt; }
        .ai-report p, .ai-report div {
            margin-bottom: 8px;
        }
        .ai-report strong {
            font-weight: 600;
        }
        
        .footer {
            margin-top: 30px;
            padding-top: 15px;
            border-top: 1px solid #ddd;
            font-size: 9pt;
            color: #888;
            text-align: center;
        }
        
        @media print {
            body {
                padding: 0;
            }
            .no-print {
                display: none;
            }
        }
    </style>
</head>
<body>
    <h1>📊 Week Ending Summary</h1>
    <div class="subtitle">${summary.weekEnding}</div>
    
    <div class="metrics-grid">
        <div class="metric-box">
            <div class="metric-label">Account Value</div>
            <div class="metric-value">$${(summary.accountValue || 0).toLocaleString()}</div>
        </div>
        <div class="metric-box">
            <div class="metric-label">Unrealized P&L</div>
            <div class="metric-value ${summary.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${summary.unrealizedPnL >= 0 ? '+' : ''}$${(summary.unrealizedPnL || 0).toLocaleString()}</div>
        </div>
        <div class="metric-box">
            <div class="metric-label">Realized P&L</div>
            <div class="metric-value ${(summary.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">${(summary.realizedPnL || 0) >= 0 ? '+' : ''}$${(summary.realizedPnL || 0).toLocaleString()}</div>
        </div>
        <div class="metric-box">
            <div class="metric-label">Leverage</div>
            <div class="metric-value ${summary.leverageRatio > 150 ? 'negative' : summary.leverageRatio > 100 ? 'warning' : ''}">${summary.leverageRatio || 0}%</div>
        </div>
    </div>
    
    ${aiAnalysisHtml ? `
    <div class="ai-report">
        <h2>🤖 AI Analysis</h2>
        ${aiAnalysisHtml}
    </div>
    ` : `
    <div style="color:#666; font-style:italic;">No AI analysis generated yet. Click "AI Analysis" to generate.</div>
    `}
    
    <div class="footer">
        Generated by WheelHouse • ${new Date().toLocaleString()}
    </div>
    
    <script>
        // Auto-print when loaded
        window.onload = function() {
            window.print();
        };
    </script>
</body>
</html>
        `;
        
        // Close the summary modal temporarily
        const summaryModal = document.getElementById('weekSummaryModal');
        if (summaryModal) summaryModal.style.display = 'none';
        
        // Create print preview overlay
        const printOverlay = document.createElement('div');
        printOverlay.id = 'printPreviewOverlay';
        printOverlay.innerHTML = `
            <style>
                #printPreviewOverlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: #fff;
                    z-index: 99999;
                    overflow-y: auto;
                    padding: 20px;
                }
                #printPreviewOverlay .print-controls {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    display: flex;
                    gap: 10px;
                    z-index: 100000;
                }
                #printPreviewOverlay .print-controls button {
                    padding: 10px 20px;
                    font-size: 14px;
                    cursor: pointer;
                    border-radius: 6px;
                    border: none;
                }
                #printPreviewOverlay .print-btn {
                    background: #0066cc;
                    color: white;
                }
                #printPreviewOverlay .cancel-btn {
                    background: #666;
                    color: white;
                }
                @media print {
                    #printPreviewOverlay .print-controls {
                        display: none !important;
                    }
                    #printPreviewOverlay {
                        position: static;
                        padding: 0;
                    }
                }
            </style>
            <div class="print-controls">
                <button class="print-btn" onclick="window.print()">🖨️ Print</button>
                <button class="cancel-btn" id="closePrintPreview">✕ Close</button>
            </div>
            <div id="printContent">
                <h1 style="font-size:18pt; margin-bottom:5px; color:#000;">📊 Week Ending Summary</h1>
                <div style="color:#666; font-size:11pt; margin-bottom:20px;">${summary.weekEnding}</div>
                
                <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:15px; margin-bottom:25px;">
                    <div style="border:1px solid #ddd; border-radius:6px; padding:12px; text-align:center;">
                        <div style="font-size:9pt; color:#666; text-transform:uppercase; margin-bottom:3px;">Account Value</div>
                        <div style="font-size:16pt; font-weight:600;">$${(summary.accountValue || 0).toLocaleString()}</div>
                    </div>
                    <div style="border:1px solid #ddd; border-radius:6px; padding:12px; text-align:center;">
                        <div style="font-size:9pt; color:#666; text-transform:uppercase; margin-bottom:3px;">Unrealized P&L</div>
                        <div style="font-size:16pt; font-weight:600; color:${summary.unrealizedPnL >= 0 ? '#0a0' : '#c00'};">${summary.unrealizedPnL >= 0 ? '+' : ''}$${(summary.unrealizedPnL || 0).toLocaleString()}</div>
                    </div>
                    <div style="border:1px solid #ddd; border-radius:6px; padding:12px; text-align:center;">
                        <div style="font-size:9pt; color:#666; text-transform:uppercase; margin-bottom:3px;">Realized P&L</div>
                        <div style="font-size:16pt; font-weight:600; color:${(summary.realizedPnL || 0) >= 0 ? '#0a0' : '#c00'};">${(summary.realizedPnL || 0) >= 0 ? '+' : ''}$${(summary.realizedPnL || 0).toLocaleString()}</div>
                    </div>
                    <div style="border:1px solid #ddd; border-radius:6px; padding:12px; text-align:center;">
                        <div style="font-size:9pt; color:#666; text-transform:uppercase; margin-bottom:3px;">Leverage</div>
                        <div style="font-size:16pt; font-weight:600; color:${summary.leverageRatio > 150 ? '#c00' : summary.leverageRatio > 100 ? '#c80' : '#000'};">${summary.leverageRatio || 0}%</div>
                    </div>
                </div>
                
                ${aiAnalysisHtml ? `
                <div style="margin-top:20px; padding-top:15px; border-top:2px solid #333;">
                    <h2 style="font-size:14pt; margin-bottom:10px; color:#000;">🤖 AI Analysis</h2>
                    <div style="font-size:11pt; line-height:1.6; color:#333;">${aiAnalysisHtml}</div>
                </div>
                ` : `
                <div style="color:#666; font-style:italic;">No AI analysis generated yet.</div>
                `}
                
                <div style="margin-top:30px; padding-top:15px; border-top:1px solid #ddd; font-size:9pt; color:#888; text-align:center;">
                    Generated by WheelHouse • ${new Date().toLocaleString()}
                </div>
            </div>
        `;
        
        document.body.appendChild(printOverlay);
        
        // Close button handler
        document.getElementById('closePrintPreview').onclick = () => {
            printOverlay.remove();
            if (summaryModal) summaryModal.style.display = 'flex';
        };
    }
    
    /**
     * Show the modal
     */
    showModal(content) {
        // Remove existing modal if any
        const existing = document.getElementById('weekSummaryModal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.id = 'weekSummaryModal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.9);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow-y: auto;
            padding: 20px;
        `;
        
        modal.innerHTML = `
            <div onclick="console.log('[MODAL] Inner div clicked'); event.stopPropagation();" style="background:#1a1a2e; border:1px solid #333; border-radius:12px; max-width:900px; width:100%; max-height:90vh; overflow-y:auto; position:relative;">
                <div id="weekSummaryContent">
                    ${content}
                </div>
            </div>
        `;
        
        // Log ALL clicks on the modal to debug
        modal.addEventListener('click', (e) => {
            console.log('[MODAL-DEBUG] Click on:', e.target.tagName, 'id:', e.target.id, 'class:', e.target.className, 'text:', e.target.textContent?.substring(0, 30));
        }, true);  // Use capture phase to see all clicks
        
        modal.onclick = (e) => {
            console.log('[MODAL] Modal backdrop clicked, target:', e.target.id || e.target.tagName, 'is modal?', e.target === modal);
            if (e.target === modal) {
                console.log('[MODAL] Closing because backdrop was clicked');
                modal.remove();
            }
        };
        
        document.body.appendChild(modal);
        console.log('[MODAL] Modal added to DOM');
        
        // Use setTimeout to ensure DOM is fully parsed before attaching listeners
        setTimeout(() => {
            // Query within the modal element, not the whole document
            const closeBtn = modal.querySelector('#weekSummaryCloseBtn');
            const aiBtn = modal.querySelector('#summaryAIBtn');
            const saveBtn = modal.querySelector('#summarySaveBtn');
            
            // Initialize X sentiment hint and watch for model changes
            this.updateXSentimentHint();
            const modelSelect = document.getElementById('globalAiModelSelect');
            if (modelSelect) {
                modelSelect.addEventListener('change', () => this.updateXSentimentHint());
            }
            
            console.log('[MODAL] Button elements found:', { closeBtn: !!closeBtn, aiBtn: !!aiBtn, saveBtn: !!saveBtn });
            
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    console.log('[MODAL] Close button clicked');
                    e.stopPropagation();
                    modal.remove();
                });
            }
            
            if (aiBtn) {
                console.log('[MODAL] Adding AI button listener');
                aiBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] AI button clicked via addEventListener');
                    e.stopPropagation();
                    e.preventDefault();
                    console.log('[SUMMARY] About to call runAIAnalysis...');
                    this.runAIAnalysis().catch(err => {
                        console.error('[SUMMARY] AI error:', err);
                        alert('AI Analysis Error: ' + err.message);
                    });
                });
            } else {
                console.error('[MODAL] AI button NOT FOUND! Check if summaryAIBtn exists in the DOM');
            }
            
            if (saveBtn) {
                saveBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] Save button clicked via addEventListener');
                    e.stopPropagation();
                    e.preventDefault();
                    this.saveSummary().catch(err => {
                        console.error('[SUMMARY] Save error:', err);
                        alert('Save Error: ' + err.message);
                    });
                });
            }
            
            const printBtn = modal.querySelector('#summaryPrintBtn');
            if (printBtn) {
                printBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] Print button clicked');
                    e.stopPropagation();
                    e.preventDefault();
                    this.printReport();
                });
            }
        }, 0);  // setTimeout 0 lets DOM finish parsing
    }
    
    /**
     * Attach button event listeners (called after content is rendered)
     */
    attachButtonListeners() {
        const modal = document.getElementById('weekSummaryModal');
        if (!modal) return;
        
        setTimeout(() => {
            const closeBtn = modal.querySelector('#weekSummaryCloseBtn');
            const aiBtn = modal.querySelector('#summaryAIBtn');
            const saveBtn = modal.querySelector('#summarySaveBtn');
            
            console.log('[MODAL] attachButtonListeners - found:', { closeBtn: !!closeBtn, aiBtn: !!aiBtn, saveBtn: !!saveBtn });
            
            if (closeBtn) {
                console.log('[MODAL] Attaching Close button listener');
                closeBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] Close button clicked!');
                    e.stopPropagation();
                    e.preventDefault();
                    modal.remove();
                });
            }
            
            if (aiBtn) {
                console.log('[MODAL] Attaching AI button listener');
                aiBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] AI button clicked!');
                    e.stopPropagation();
                    e.preventDefault();
                    this.runAIAnalysis().catch(err => {
                        console.error('[SUMMARY] AI error:', err);
                        alert('AI Analysis Error: ' + err.message);
                    });
                });
            }
            
            if (saveBtn) {
                console.log('[MODAL] Attaching Save button listener');
                saveBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] Save button clicked!');
                    e.stopPropagation();
                    e.preventDefault();
                    this.saveSummary().catch(err => {
                        console.error('[SUMMARY] Save error:', err);
                        alert('Save Error: ' + err.message);
                    });
                });
            }
            
            const printBtn = modal.querySelector('#summaryPrintBtn');
            if (printBtn) {
                console.log('[MODAL] Attaching Print button listener');
                printBtn.addEventListener('click', (e) => {
                    console.log('[SUMMARY] Print button clicked!');
                    e.stopPropagation();
                    e.preventDefault();
                    this.printReport();
                });
            }
            
            // Attach history card click handlers
            const historyCards = modal.querySelectorAll('.history-card');
            historyCards.forEach(card => {
                card.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const weekEnding = card.dataset.week;
                    console.log('[SUMMARY] History card clicked:', weekEnding);
                    this.showHistoricalSummary(weekEnding);
                });
            });
            
            // Back to current button(s)
            const backBtns = modal.querySelectorAll('#backToCurrentBtn, #backToCurrentBtn2');
            backBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.updateModalContent(this.buildSummaryContent(this.currentSummary));
                });
            });
        }, 10);
    }
    
    /**
     * Update modal content
     */
    updateModalContent(content) {
        const container = document.getElementById('weekSummaryContent');
        if (container) {
            container.innerHTML = content;
            // Re-attach listeners after content update
            this.attachButtonListeners();
        }
    }
}

// Create singleton instance
window.WeeklySummaryService = new WeeklySummaryService();

// Global function for button onclick
window.showWeekSummary = () => window.WeeklySummaryService.show();
