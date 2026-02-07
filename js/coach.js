/**
 * coach.js - Trading Coach Frontend Module
 * 
 * Displays pattern analysis, win rates, danger zones, sweet spots,
 * and AI coaching insights in a modal panel.
 * 
 * @module coach
 */

import { state } from './state.js';

/**
 * Show the Trading Coach modal with pattern analysis
 */
window.showCoachPanel = async function() {
    // Gather closed positions
    const closedPositions = state.closedPositions || [];
    
    if (closedPositions.length < 3) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(255,170,0,0.3);border-radius:12px;padding:30px;max-width:500px;text-align:center;">
                <h2 style="color:#ffaa00;margin-top:0;">🎯 Trading Coach</h2>
                <p style="color:#ccc;">You need at least <strong style="color:#00d9ff;">3 closed trades</strong> before the coach can spot patterns.</p>
                <p style="color:#888;font-size:13px;">Current closed trades: ${closedPositions.length}</p>
                <button onclick="this.closest('.modal-overlay').remove()" class="btn-primary" style="margin-top:15px;padding:8px 20px;">Got It</button>
            </div>
        `;
        document.body.appendChild(modal);
        return;
    }

    // Show loading
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'coachModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid rgba(255,170,0,0.3);border-radius:12px;padding:30px;max-width:900px;width:90%;max-height:85vh;overflow-y:auto;">
            <div style="text-align:center;padding:30px;color:#ffaa00;">
                <div class="spinner" style="display:inline-block;margin-right:10px;"></div>
                Analyzing ${closedPositions.length} closed trades...
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    try {
        // Send to backend for analysis
        const closedSummary = closedPositions.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike || p.sellStrike,
            pnl: p.realizedPnL ?? p.closePnL ?? 0,
            closeDate: p.closeDate,
            openDate: p.openDate,
            closeReason: p.closeReason,
            contracts: p.contracts,
            expiry: p.expiry
        }));

        const response = await fetch('/api/coaching/patterns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ closedPositions: closedSummary })
        });

        if (!response.ok) throw new Error('Failed to analyze patterns');
        const data = await response.json();
        const p = data.patterns;

        // Render the coach panel
        const content = modal.querySelector('div > div') || modal.firstElementChild;
        content.innerHTML = buildCoachHTML(p, closedPositions.length);

    } catch (err) {
        const content = modal.querySelector('div > div') || modal.firstElementChild;
        content.innerHTML = `
            <h2 style="color:#ff5252;margin-top:0;">❌ Coach Error</h2>
            <p style="color:#ccc;">${err.message}</p>
            <button onclick="this.closest('.modal-overlay').remove()" class="btn-primary" style="margin-top:15px;padding:8px 20px;">Close</button>
        `;
    }
};

/**
 * Build the complete coach HTML from pattern data
 */
function buildCoachHTML(p, totalClosed) {
    const o = p.overallStats;
    if (!o) return '<p style="color:#888;">No data to analyze.</p>';

    let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <h2 style="color:#ffaa00;margin:0;">🎯 Trading Coach</h2>
            <button onclick="this.closest('.modal-overlay').remove()" style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;">✕</button>
        </div>
    `;

    // ── Overall Stats Banner ──
    const winColor = o.winRate >= 60 ? '#00ff88' : o.winRate >= 45 ? '#ffaa00' : '#ff5252';
    html += `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px;padding:15px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.2);border-radius:10px;">
            <div style="text-align:center;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;">Total Trades</div>
                <div style="font-size:24px;font-weight:700;color:#00d9ff;">${o.count}</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;">Win Rate</div>
                <div style="font-size:24px;font-weight:700;color:${winColor};">${o.winRate}%</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;">Net P&L</div>
                <div style="font-size:24px;font-weight:700;color:${o.totalPnL >= 0 ? '#00ff88' : '#ff5252'};">$${o.totalPnL.toLocaleString()}</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;">Avg P&L</div>
                <div style="font-size:24px;font-weight:700;color:${o.avgPnL >= 0 ? '#00ff88' : '#ff5252'};">$${o.avgPnL}</div>
            </div>
            <div style="text-align:center;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;">Profit Factor</div>
                <div style="font-size:24px;font-weight:700;color:#fff;">${o.profitFactor}</div>
            </div>
        </div>
    `;

    // ── Streaks ──
    if (p.streaks) {
        const s = p.streaks.current;
        const streakColor = s.type === 'win' ? '#00ff88' : '#ff5252';
        const streakIcon = s.type === 'win' ? '🔥' : '❄️';
        html += `
            <div style="display:flex;gap:15px;margin-bottom:20px;">
                <div style="flex:1;padding:10px;background:rgba(${s.type === 'win' ? '0,255,136' : '255,82,82'},0.1);border:1px solid ${streakColor}40;border-radius:8px;text-align:center;">
                    <span style="font-size:14px;color:${streakColor};">${streakIcon} Current: ${s.length}-trade ${s.type} streak</span>
                </div>
                <div style="flex:1;padding:10px;background:rgba(0,217,255,0.06);border:1px solid rgba(0,217,255,0.2);border-radius:8px;text-align:center;">
                    <span style="font-size:13px;color:#888;">Max Win: ${p.streaks.maxWinStreak} | Max Loss: ${p.streaks.maxLossStreak}</span>
                </div>
            </div>
        `;
    }

    // ── Sweet Spots ──
    if (p.sweetSpots && p.sweetSpots.length > 0) {
        html += `
            <div style="margin-bottom:20px;">
                <h3 style="color:#00ff88;margin:0 0 10px 0;font-size:15px;">✅ Sweet Spots (High Win Rate)</h3>
                <div style="display:grid;gap:6px;">
        `;
        for (const s of p.sweetSpots.slice(0, 5)) {
            const label = s.combo.replace(/_/g, ' ');
            html += `
                <div style="padding:8px 12px;background:rgba(0,255,136,0.06);border:1px solid rgba(0,255,136,0.2);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#00ff88;font-weight:600;">${label}</span>
                    <span style="color:#ccc;">${s.winRate}% win (${s.count} trades) | $${s.totalPnL.toLocaleString()}</span>
                </div>
            `;
        }
        html += `</div></div>`;
    }

    // ── Danger Zones ──
    if (p.dangerZones && p.dangerZones.length > 0) {
        html += `
            <div style="margin-bottom:20px;">
                <h3 style="color:#ff5252;margin:0 0 10px 0;font-size:15px;">🚨 Danger Zones (Low Win Rate)</h3>
                <div style="display:grid;gap:6px;">
        `;
        for (const d of p.dangerZones.slice(0, 5)) {
            const label = d.combo.replace(/_/g, ' ');
            html += `
                <div style="padding:8px 12px;background:rgba(255,82,82,0.06);border:1px solid rgba(255,82,82,0.2);border-radius:6px;display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#ff5252;font-weight:600;">${label}</span>
                    <span style="color:#ccc;">${d.winRate}% win (${d.count} trades) | $${d.totalPnL.toLocaleString()}</span>
                </div>
            `;
        }
        html += `</div></div>`;
    }

    // ── By Strategy ──
    const strategies = Object.entries(p.byStrategy).sort((a, b) => b[1].count - a[1].count);
    if (strategies.length > 0) {
        html += `
            <div style="margin-bottom:20px;">
                <h3 style="color:#00d9ff;margin:0 0 10px 0;font-size:15px;">📋 Performance by Strategy</h3>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <tr style="color:#888;border-bottom:1px solid #333;">
                        <th style="text-align:left;padding:6px;">Strategy</th>
                        <th style="text-align:center;padding:6px;">Trades</th>
                        <th style="text-align:center;padding:6px;">Win%</th>
                        <th style="text-align:right;padding:6px;">Net P&L</th>
                        <th style="text-align:right;padding:6px;">Avg P&L</th>
                        <th style="text-align:center;padding:6px;">PF</th>
                    </tr>
        `;
        for (const [name, s] of strategies) {
            const wr = s.winRate >= 60 ? '#00ff88' : s.winRate >= 45 ? '#ffaa00' : '#ff5252';
            html += `
                    <tr style="border-bottom:1px solid #222;">
                        <td style="padding:6px;color:#ccc;">${name.replace(/_/g, ' ')}</td>
                        <td style="text-align:center;padding:6px;color:#888;">${s.count}</td>
                        <td style="text-align:center;padding:6px;color:${wr};font-weight:600;">${s.winRate}%</td>
                        <td style="text-align:right;padding:6px;color:${s.totalPnL >= 0 ? '#00ff88' : '#ff5252'};">$${s.totalPnL.toLocaleString()}</td>
                        <td style="text-align:right;padding:6px;color:${s.avgPnL >= 0 ? '#00ff88' : '#ff5252'};">$${s.avgPnL}</td>
                        <td style="text-align:center;padding:6px;color:#888;">${s.profitFactor}</td>
                    </tr>
            `;
        }
        html += `</table></div>`;
    }

    // ── By Ticker (top 10) ──
    const tickers = Object.entries(p.byTicker)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10);
    if (tickers.length > 0) {
        html += `
            <div style="margin-bottom:20px;">
                <h3 style="color:#00d9ff;margin:0 0 10px 0;font-size:15px;">📈 Performance by Ticker (Top 10)</h3>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <tr style="color:#888;border-bottom:1px solid #333;">
                        <th style="text-align:left;padding:6px;">Ticker</th>
                        <th style="text-align:center;padding:6px;">Trades</th>
                        <th style="text-align:center;padding:6px;">Win%</th>
                        <th style="text-align:right;padding:6px;">Net P&L</th>
                        <th style="text-align:center;padding:6px;">Trend</th>
                    </tr>
        `;
        for (const [ticker, s] of tickers) {
            const wr = s.winRate >= 60 ? '#00ff88' : s.winRate >= 45 ? '#ffaa00' : '#ff5252';
            const trendIcon = s.recentTrend === 'improving' ? '📈' : s.recentTrend === 'declining' ? '📉' : '➡️';
            html += `
                    <tr style="border-bottom:1px solid #222;">
                        <td style="padding:6px;color:#00d9ff;font-weight:600;">${ticker}</td>
                        <td style="text-align:center;padding:6px;color:#888;">${s.count}</td>
                        <td style="text-align:center;padding:6px;color:${wr};font-weight:600;">${s.winRate}%</td>
                        <td style="text-align:right;padding:6px;color:${s.totalPnL >= 0 ? '#00ff88' : '#ff5252'};">$${s.totalPnL.toLocaleString()}</td>
                        <td style="text-align:center;padding:6px;">${trendIcon} ${s.recentTrend || '—'}</td>
                    </tr>
            `;
        }
        html += `</table></div>`;
    }

    // ── Behavioral Insights ──
    if (p.behavioral) {
        const b = p.behavioral;
        html += `
            <div style="margin-bottom:20px;">
                <h3 style="color:#ffaa00;margin:0 0 10px 0;font-size:15px;">🧠 Behavioral Insights</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        `;
        if (b.assignmentRate !== undefined) {
            html += `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:6px;"><span style="color:#888;">Assignment Rate:</span> <span style="color:#ccc;">${b.assignmentRate}%</span></div>`;
        }
        if (b.earlyCloseRate !== undefined) {
            html += `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:6px;"><span style="color:#888;">Early Close Rate:</span> <span style="color:#ccc;">${b.earlyCloseRate}%</span></div>`;
        }
        if (b.sizeEdge) {
            html += `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:6px;grid-column:span 2;"><span style="color:#888;">Position Sizing:</span> <span style="color:#ffaa00;">${b.sizeEdge}</span></div>`;
        }
        if (b.smallPositionWinRate !== null && b.smallPositionWinRate !== undefined) {
            html += `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:6px;"><span style="color:#888;">Small (1-2 contracts):</span> <span style="color:#ccc;">${b.smallPositionWinRate}% win</span></div>`;
        }
        if (b.largePositionWinRate !== null && b.largePositionWinRate !== undefined) {
            html += `<div style="padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:6px;"><span style="color:#888;">Large (5+ contracts):</span> <span style="color:#ccc;">${b.largePositionWinRate}% win</span></div>`;
        }
        html += `</div></div>`;

        // Seasonality
        if (b.seasonality) {
            const months = Object.entries(b.seasonality);
            if (months.length > 0) {
                html += `
                    <div style="margin-bottom:20px;">
                        <h3 style="color:#00d9ff;margin:0 0 10px 0;font-size:15px;">📅 Seasonality (Win Rate by Month)</h3>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;">
                `;
                for (const [month, data] of months) {
                    const color = data.winRate >= 60 ? '#00ff88' : data.winRate >= 45 ? '#ffaa00' : '#ff5252';
                    html += `
                        <div style="padding:6px 10px;background:rgba(${data.winRate >= 60 ? '0,255,136' : data.winRate >= 45 ? '255,170,0' : '255,82,82'},0.1);border:1px solid ${color}40;border-radius:6px;text-align:center;min-width:60px;">
                            <div style="font-size:11px;color:#888;">${month}</div>
                            <div style="font-size:16px;font-weight:700;color:${color};">${data.winRate}%</div>
                            <div style="font-size:10px;color:#666;">${data.count} trades</div>
                        </div>
                    `;
                }
                html += `</div></div>`;
            }
        }
    }

    // ── Footer ──
    html += `
        <div style="text-align:center;padding-top:15px;border-top:1px solid #333;margin-top:15px;">
            <p style="color:#666;font-size:11px;margin:0;">
                Analysis based on ${totalClosed} closed trades | Generated ${new Date().toLocaleDateString()}
            </p>
            <p style="color:#555;font-size:10px;margin:5px 0 0 0;">
                🎯 Coaching context is automatically injected into all AI prompts (Trade Advisor, Discord Analyzer, Strategy Advisor)
            </p>
        </div>
    `;

    return html;
}

export const showCoachPanel = window.showCoachPanel;
