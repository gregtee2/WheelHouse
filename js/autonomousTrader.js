/**
 * autonomousTrader.js — Autonomous AI Trader Frontend
 * 
 * Handles the 🤖 Auto tab: real-time position updates, equity curve,
 * trade journal, learned rules, market scans, and config management.
 * 
 * Backend: AutonomousTraderService.js + TraderDatabase.js
 * API: /api/autonomous/*
 * Socket events: autonomous-status, autonomous-progress, autonomous-trade,
 *                autonomous-position-update, autonomous-log
 */

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────────────────
    let autoState = {
        enabled: false,
        phase: 'idle',
        openTrades: [],
        closedTrades: [],
        metrics: null,
        equityCurve: [],
        rules: [],
        scans: [],
        dailySummaries: [],
        logEntries: [],
        config: {}
    };

    const MAX_LOG_ENTRIES = 200;

    // ─── Helpers ─────────────────────────────────────────────────────────

    function fmt$(val) {
        if (val == null || isNaN(val)) return '—';
        const n = Number(val);
        const sign = n < 0 ? '-' : '';
        return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtPct(val) {
        if (val == null || isNaN(val)) return '—';
        return (Number(val) * 100).toFixed(1) + '%';
    }

    function fmtTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function pnlColor(val) {
        if (val == null) return '#888';
        return Number(val) >= 0 ? '#00ff88' : '#ff5252';
    }

    async function apiCall(path, method = 'GET', body = null) {
        const opts = { method, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        try {
            const res = await fetch('/api/autonomous' + path, opts);
            return await res.json();
        } catch (e) {
            console.error('[AutoTrader] API error:', path, e);
            return { error: e.message };
        }
    }

    // ─── Socket.IO Listeners ─────────────────────────────────────────────

    function setupSocketListeners() {
        const socket = window.io?.();
        if (!socket) {
            // Retry after Socket.IO loads
            setTimeout(setupSocketListeners, 2000);
            return;
        }

        // Use existing socket if available
        const sock = window.wheelSocket || socket;

        sock.on('autonomous-status', (data) => {
            autoState.enabled = data.enabled;
            autoState.phase = data.phase || 'idle';
            updateStatusBadge();
        });

        sock.on('autonomous-progress', (data) => {
            addLogEntry(`⚡ ${data.phase}: ${data.message}`, 'progress');
            updatePhaseBadge(data.phase);
        });

        sock.on('autonomous-trade', (data) => {
            const t = data.trade || {};
            const ticker = t.ticker || 'unknown';
            const strategy = t.strategy || '';
            const price = t.entry_price ? `@ $${Number(t.entry_price).toFixed(2)}` : '';
            addLogEntry(`📊 ${data.action}: ${ticker} ${strategy} ${t.strike || ''} ${price}`, data.action === 'opened' ? 'trade-open' : 'trade-close');
            refreshDashboardData();
        });

        sock.on('autonomous-position-update', (data) => {
            // Real-time price updates for open positions
            updatePositionInPlace(data);
        });

        sock.on('autonomous-log', (data) => {
            addLogEntry(data.message, data.level || 'info');
        });
    }

    // ─── Dashboard Refresh ───────────────────────────────────────────────

    async function refreshDashboardData() {
        const [statusRes, tradesRes, metricsRes, rulesRes, scansRes] = await Promise.all([
            apiCall('/status'),
            apiCall('/trades?status=open'),
            apiCall('/metrics'),
            apiCall('/rules'),
            apiCall('/scans?limit=10')
        ]);

        if (!statusRes.error) {
            autoState.enabled = statusRes.enabled;
            autoState.phase = statusRes.phase || 'idle';
            autoState.config = statusRes.config || {};
        }
        if (!tradesRes.error) autoState.openTrades = tradesRes.trades || [];
        if (!metricsRes.error) autoState.metrics = metricsRes;
        if (!rulesRes.error) autoState.rules = rulesRes.rules || [];
        if (!scansRes.error) autoState.scans = scansRes.scans || [];

        // Sync auto trades into main Positions tab
        syncAutoTradesToPositions(autoState.openTrades);

        renderPerfCards();
        renderOpenPositions();
        renderRules();
        renderMarketScans();
        updateStatusBadge();
        refreshEquityCurve();
        refreshJournal();
        refreshDailySummaries();
    }

    window.refreshAutoTraderDashboard = refreshDashboardData;

    // ─── Status Badge ────────────────────────────────────────────────────

    function updateStatusBadge() {
        const badge = document.getElementById('autoTraderStatusBadge');
        const btn = document.getElementById('autoTraderToggleBtn');
        if (!badge) return;

        if (autoState.enabled) {
            badge.style.background = 'rgba(0,255,136,0.2)';
            badge.style.color = '#00ff88';
            badge.style.borderColor = 'rgba(0,255,136,0.4)';
            badge.textContent = '● ENABLED';
            if (btn) {
                btn.textContent = '⏸ Disable Trader';
                btn.style.background = 'rgba(255,170,0,0.15)';
                btn.style.borderColor = 'rgba(255,170,0,0.4)';
                btn.style.color = '#ffaa00';
            }
        } else {
            badge.style.background = 'rgba(255,82,82,0.2)';
            badge.style.color = '#ff5252';
            badge.style.borderColor = 'rgba(255,82,82,0.4)';
            badge.textContent = '● DISABLED';
            if (btn) {
                btn.textContent = '▶ Enable Trader';
                btn.style.background = 'rgba(0,255,136,0.15)';
                btn.style.borderColor = 'rgba(0,255,136,0.4)';
                btn.style.color = '#00ff88';
            }
        }
    }

    function updatePhaseBadge(phase) {
        const el = document.getElementById('autoTraderPhaseBadge');
        if (!el) return;
        const phaseLabels = {
            'idle': 'Idle',
            'phase1_gathering': '🌐 Gathering Intel (Grok)',
            'phase2_analyzing': '🧠 Analyzing (DeepSeek R1)',
            'phase3_executing': '⚡ Executing Trades',
            'phase4_eod_review': '📊 End-of-Day Review',
            'phase5_reflecting': '💭 Self-Reflecting',
            'monitoring': '👁️ Monitoring Positions'
        };
        el.textContent = 'Phase: ' + (phaseLabels[phase] || phase);
    }

    // ─── Performance Cards ───────────────────────────────────────────────

    function renderPerfCards() {
        const m = autoState.metrics || {};
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const setColor = (id, val) => { const el = document.getElementById(id); if (el) el.style.color = pnlColor(val); };

        const balance = (autoState.config?.paper_balance || 100000) + (m.total_pnl || 0);
        set('autoPaperBalance', fmt$(balance));
        setColor('autoPaperBalance', balance - 100000);

        set('autoTotalPnl', fmt$(m.total_pnl));
        setColor('autoTotalPnl', m.total_pnl);

        set('autoWinRate', m.total_trades > 0 ? ((m.wins / m.total_trades) * 100).toFixed(1) + '%' : '—');
        set('autoTotalTrades', m.total_trades || 0);
        set('autoOpenCount', `${autoState.openTrades.length} / ${autoState.config?.max_positions || 5}`);

        set('autoAvgPnl', m.total_trades > 0 ? fmt$(m.total_pnl / m.total_trades) : '—');
        setColor('autoAvgPnl', m.total_trades > 0 ? m.total_pnl / m.total_trades : null);

        set('autoBestTrade', fmt$(m.best_trade));
        setColor('autoBestTrade', m.best_trade);

        set('autoWorstTrade', fmt$(m.worst_trade));
        setColor('autoWorstTrade', m.worst_trade);

        // Margin utilization gauge (from /status endpoint)
        renderMarginGauge();
    }

    async function renderMarginGauge() {
        const statusRes = await apiCall('/status');
        if (statusRes.error || !statusRes.margin) return;

        const mg = statusRes.margin;
        const pctEl = document.getElementById('autoMarginPct');
        const barEl = document.getElementById('autoMarginBar');
        const detailEl = document.getElementById('autoMarginDetail');
        const cardEl = document.getElementById('autoMarginCard');
        if (!pctEl) return;

        const pct = mg.utilizationPct || 0;
        pctEl.textContent = pct.toFixed(1) + '% / ' + mg.capPct + '%';

        // Color: green < 50%, yellow 50-70%, orange 70-85%, red > 85%
        let color = '#00ff88';
        let borderColor = 'rgba(0,255,136,0.3)';
        if (pct >= 85) { color = '#ff5252'; borderColor = 'rgba(255,82,82,0.4)'; }
        else if (pct >= 70) { color = '#ff9800'; borderColor = 'rgba(255,152,0,0.4)'; }
        else if (pct >= 50) { color = '#ffaa00'; borderColor = 'rgba(255,170,0,0.3)'; }

        pctEl.style.color = color;
        if (barEl) { barEl.style.width = Math.min(pct / mg.capPct * 100, 100) + '%'; barEl.style.background = color; }
        if (detailEl) detailEl.textContent = `$${mg.totalCommitted.toLocaleString()} / $${mg.maxAllowed.toLocaleString()} (avail: $${mg.available.toLocaleString()})`;
        if (cardEl) cardEl.style.borderColor = borderColor;
    }

    // ─── Sync Auto Trades → Main Positions Tab ───────────────────────────

    function syncAutoTradesToPositions(autoTrades) {
        if (!window.state?.positions) return;

        const AUTO_ID_OFFSET = 9000000000000; // High offset to avoid collisions with Date.now() IDs

        // Remove old auto-synced positions (always clean up, regardless of account mode)
        window.state.positions = window.state.positions.filter(p => !p._autoTrade);

        // Only inject auto trades when viewing Paper Trading account
        // These are PAPER trades — they must NOT appear in real margin account
        if (window.state.accountMode !== 'paper') {
            // Still re-render to remove stale auto trades if user just switched accounts
            if (typeof window.renderPositions === 'function') {
                try { window.renderPositions(); } catch (e) { /* tab may not be active */ }
            }
            return;
        }

        // Convert each auto trade to main positions format
        autoTrades.forEach(t => {
            const pos = {
                id: AUTO_ID_OFFSET + t.id,
                chainId: AUTO_ID_OFFSET + t.id,
                ticker: t.ticker,
                type: t.strategy || 'short_put',
                strike: t.strike,
                buyStrike: t.strike_buy || null,
                sellStrike: t.strike_sell || t.strike,
                spreadWidth: t.spread_width || null,
                premium: t.entry_price || 0,
                contracts: t.contracts || 1,
                expiry: t.expiry,
                openDate: t.entry_date,
                status: 'open',
                broker: '🤖 Auto',
                delta: t.entry_delta || null,
                currentSpot: t.entry_spot || null,
                entrySpot: t.entry_spot || null,
                lastOptionPrice: null,
                markedPrice: null,
                _autoTrade: true,       // Marker: this came from autonomous trader
                _autoTradeId: t.id,     // Original SQLite ID
                aiRationale: t.ai_rationale,
                aiConfidence: t.ai_confidence,
                stopLossPrice: t.stop_loss_price,
                profitTargetPrice: t.profit_target_price,
                maxProfit: t.max_profit,
                maxLoss: t.max_loss,
                sector: t.sector || null
            };

            // Handle spread types
            if (t.strategy === 'credit_spread') {
                pos.type = 'put_credit_spread';
                pos.buyStrike = t.strike_buy;
                pos.sellStrike = t.strike_sell || t.strike;
            }

            window.state.positions.push(pos);
        });

        // Re-render the main positions table if visible
        if (typeof window.renderPositions === 'function') {
            try { window.renderPositions(); } catch (e) { /* tab may not be active */ }
        }

        // Re-subscribe streaming so auto trades get real-time Schwab updates too
        if (window.StreamingService?.subscribePositions && window.state.positions.length > 0) {
            try { window.StreamingService.subscribePositions(window.state.positions); } catch (e) { /* streaming may not be active */ }
        }
    }

    // ─── Open Positions ──────────────────────────────────────────────────

    function renderOpenPositions() {
        const container = document.getElementById('autoPositionsContainer');
        if (!container) return;

        if (autoState.openTrades.length === 0) {
            container.innerHTML = '<div style="color:#555; text-align:center; padding:40px 0; font-size:13px;">No open positions. Enable trader to begin.</div>';
            return;
        }

        let html = '';
        let totalUnrealized = 0;

        autoState.openTrades.forEach(t => {
            const unrealized = t.unrealized_pnl || 0;
            totalUnrealized += unrealized;
            const pnlPct = t.max_profit > 0 ? (unrealized / t.max_profit * 100).toFixed(0) : '—';
            const dte = t.expiry ? Math.max(0, Math.ceil((new Date(t.expiry) - new Date()) / 86400000)) : '?';
            const stopLoss = t.stop_loss_price || 0;
            const profitTarget = t.profit_target_price || 0;

            html += `
            <div class="auto-position-row" data-trade-id="${t.id}">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span style="color:#00d9ff; font-weight:600;">${t.ticker}</span>
                        <span style="color:#888; font-size:11px; margin-left:8px;">${(t.strategy || '').replace(/_/g, ' ')}</span>
                    </div>
                    <div style="color:${pnlColor(unrealized)}; font-weight:600; font-size:13px;">
                        ${fmt$(unrealized)} <span style="font-size:11px; color:#888;">(${pnlPct}%)</span>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:11px; color:#888;">
                    <span>Strike: $${t.strike || '—'} ${t.spread_width ? '/ $' + (t.strike + t.spread_width) : ''}</span>
                    <span>DTE: ${dte}d</span>
                    <span>Credit: ${fmt$(t.premium_received)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-top:3px; font-size:10px;">
                    <span style="color:#ff5252;">Stop: ${fmt$(stopLoss)}</span>
                    <span style="color:#00ff88;">Target: ${fmt$(profitTarget)}</span>
                    <button onclick="window.closeAutoTrade(${t.id})" style="background:rgba(255,82,82,0.2); border:1px solid rgba(255,82,82,0.3); color:#ff5252; padding:2px 8px; border-radius:4px; cursor:pointer; font-size:10px;">Close</button>
                </div>
            </div>`;
        });

        container.innerHTML = html;

        const totalEl = document.getElementById('autoOpenPnlTotal');
        if (totalEl) {
            totalEl.textContent = `Unrealized: ${fmt$(totalUnrealized)}`;
            totalEl.style.color = pnlColor(totalUnrealized);
        }
    }

    function updatePositionInPlace(data) {
        // Update a single position's display without full re-render
        const row = document.querySelector(`.auto-position-row[data-trade-id="${data.tradeId}"]`);
        if (!row) return;
        // Just refresh all positions on any update (simpler, fast enough)
        const trade = autoState.openTrades.find(t => t.id === data.tradeId);
        if (trade) {
            trade.current_price = data.currentPrice;
            trade.unrealized_pnl = data.unrealizedPnl;
        }
        renderOpenPositions();
    }

    // ─── Activity Log ────────────────────────────────────────────────────

    function addLogEntry(message, level = 'info') {
        const container = document.getElementById('autoActivityLog');
        if (!container) return;

        // Clear placeholder
        if (autoState.logEntries.length === 0) {
            container.innerHTML = '';
        }

        const entry = { message, level, time: Date.now() };
        autoState.logEntries.unshift(entry);
        if (autoState.logEntries.length > MAX_LOG_ENTRIES) autoState.logEntries.pop();

        const colorMap = {
            'info': '#aaa',
            'progress': '#00d9ff',
            'trade-open': '#00ff88',
            'trade-close': '#ffaa00',
            'warning': '#ff9800',
            'error': '#ff5252'
        };

        const div = document.createElement('div');
        div.style.cssText = `padding:4px 0; border-bottom:1px solid #222; color:${colorMap[level] || '#aaa'}; font-size:12px;`;
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        div.innerHTML = `<span style="color:#555; margin-right:6px;">${timeStr}</span>${message}`;

        container.insertBefore(div, container.firstChild);

        // Trim DOM
        while (container.children.length > MAX_LOG_ENTRIES) {
            container.removeChild(container.lastChild);
        }
    }

    window.clearAutoLog = function () {
        autoState.logEntries = [];
        const container = document.getElementById('autoActivityLog');
        if (container) container.innerHTML = '<div style="color:#555; text-align:center; padding:40px 0;">Log cleared.</div>';
    };

    // ─── Equity Curve Chart ──────────────────────────────────────────────

    async function refreshEquityCurve() {
        const res = await apiCall('/equity-curve');
        if (res.error || !res.curve?.length) return;
        autoState.equityCurve = res.curve;
        drawEquityCurve();
    }

    window.refreshEquityCurve = refreshEquityCurve;

    function drawEquityCurve() {
        const canvas = document.getElementById('autoEquityCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const data = autoState.equityCurve;
        if (!data || data.length < 2) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#555';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Not enough data for equity curve yet.', canvas.width / 2, canvas.height / 2);
            return;
        }

        const W = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
        const H = canvas.height = 250 * (window.devicePixelRatio || 1);
        ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
        const w = canvas.offsetWidth;
        const h = 250;
        const pad = { top: 20, right: 20, bottom: 30, left: 70 };

        const balances = data.map(d => d.running_balance);
        const minB = Math.min(...balances) * 0.995;
        const maxB = Math.max(...balances) * 1.005;
        const rangeB = maxB - minB || 1;

        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(0, 0, w, h);

        // Grid lines
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (i / 4) * (h - pad.top - pad.bottom);
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(w - pad.right, y);
            ctx.stroke();
            const val = maxB - (i / 4) * rangeB;
            ctx.fillStyle = '#555';
            ctx.font = '11px monospace';
            ctx.textAlign = 'right';
            ctx.fillText('$' + val.toLocaleString('en-US', { maximumFractionDigits: 0 }), pad.left - 8, y + 4);
        }

        // Starting balance reference line
        const startBalance = autoState.config?.paper_balance || 100000;
        const startY = pad.top + (1 - (startBalance - minB) / rangeB) * (h - pad.top - pad.bottom);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, startY);
        ctx.lineTo(w - pad.right, startY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Equity line
        const xStep = (w - pad.left - pad.right) / (data.length - 1);
        ctx.beginPath();
        data.forEach((d, i) => {
            const x = pad.left + i * xStep;
            const y = pad.top + (1 - (d.running_balance - minB) / rangeB) * (h - pad.top - pad.bottom);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        const lastBalance = balances[balances.length - 1];
        ctx.strokeStyle = lastBalance >= startBalance ? '#00ff88' : '#ff5252';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Fill under curve
        const lastX = pad.left + (data.length - 1) * xStep;
        ctx.lineTo(lastX, h - pad.bottom);
        ctx.lineTo(pad.left, h - pad.bottom);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
        if (lastBalance >= startBalance) {
            grad.addColorStop(0, 'rgba(0,255,136,0.15)');
            grad.addColorStop(1, 'rgba(0,255,136,0)');
        } else {
            grad.addColorStop(0, 'rgba(255,82,82,0.15)');
            grad.addColorStop(1, 'rgba(255,82,82,0)');
        }
        ctx.fillStyle = grad;
        ctx.fill();

        // Date labels
        ctx.fillStyle = '#555';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        const labelStep = Math.max(1, Math.floor(data.length / 6));
        for (let i = 0; i < data.length; i += labelStep) {
            const x = pad.left + i * xStep;
            const dateStr = new Date(data[i].trade_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            ctx.fillText(dateStr, x, h - 8);
        }
    }

    // ─── Trade Journal ───────────────────────────────────────────────────

    async function refreshJournal(filter = 'all') {
        const res = await apiCall('/journal?limit=50');
        if (res.error) return;
        autoState.closedTrades = res.trades || [];
        renderJournal(filter);
    }

    function renderJournal(filter = 'all') {
        const container = document.getElementById('autoJournalContainer');
        if (!container) return;

        let trades = autoState.closedTrades;
        if (filter === 'win') trades = trades.filter(t => (t.realized_pnl || 0) > 0);
        if (filter === 'loss') trades = trades.filter(t => (t.realized_pnl || 0) <= 0);

        if (trades.length === 0) {
            container.innerHTML = '<div style="color:#555; text-align:center; padding:30px 0; font-size:12px;">No closed trades yet.</div>';
            return;
        }

        container.innerHTML = trades.map(t => {
            const exitReasonBadge = {
                'profit_target': '💰 Target',
                'stop_loss': '🛑 Stop',
                'expiry': '📋 Expired',
                'dte_manage': '⏰ DTE Mgmt',
                'manual': '✋ Manual'
            }[t.exit_reason] || t.exit_reason || '';
            const exitColor = {
                'profit_target': '#00ff88',
                'stop_loss': '#ff5252',
                'expiry': '#00d9ff',
                'dte_manage': '#ffaa00',
                'manual': '#888'
            }[t.exit_reason] || '#888';
            return `
            <div style="padding:8px 0; border-bottom:1px solid #222;">
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#00d9ff; font-weight:600;">${t.ticker}</span>
                    <span style="color:${pnlColor(t.realized_pnl)}; font-weight:600;">${fmt$(t.realized_pnl)}</span>
                </div>
                <div style="font-size:11px; color:#888; margin-top:2px;">
                    ${(t.strategy || '').replace(/_/g, ' ')} · ${fmtDate(t.opened_at)} → ${fmtDate(t.closed_at)}
                    <span style="color:${exitColor}; margin-left:6px; font-size:10px;">${exitReasonBadge}</span>
                </div>
                ${t.ai_review ? `<div style="font-size:10px; color:#bb86fc; margin-top:4px; cursor:pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none';">💭 AI Review ▸</div><div style="display:none; font-size:11px; color:#aaa; margin-top:4px; padding:6px; background:#111; border-radius:4px;">${t.ai_review}</div>` : ''}
            </div>`;
        }).join('');
    }

    window.filterAutoJournal = function (filter) {
        renderJournal(filter);
    };

    // ─── Learned Rules ───────────────────────────────────────────────────

    function renderRules() {
        const container = document.getElementById('autoRulesContainer');
        const countEl = document.getElementById('autoRulesCount');
        if (!container) return;

        if (countEl) countEl.textContent = `${autoState.rules.length} rules`;

        if (autoState.rules.length === 0) {
            container.innerHTML = '<div style="color:#555; text-align:center; padding:30px 0; font-size:12px;">AI will learn rules from trades.</div>';
            return;
        }

        container.innerHTML = autoState.rules.map(r => {
            const confColor = r.confidence > 70 ? '#00ff88' : r.confidence > 40 ? '#ffaa00' : '#ff5252';
            const typeIcon = { 'avoid': '🚫', 'prefer': '✅', 'risk': '⚠️', 'timing': '⏰', 'strategy': '🎯' }[r.rule_type] || '📌';
            return `
            <div style="padding:6px 0; border-bottom:1px solid #222; font-size:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${typeIcon} ${r.rule_text}</span>
                    <span style="color:${confColor}; font-size:10px;">${r.confidence}%</span>
                </div>
                <div style="font-size:10px; color:#555; margin-top:2px;">
                    Source: ${r.source_trades || 0} trades · ${fmtDate(r.created_at)}
                    <span style="cursor:pointer; color:#ff5252; margin-left:8px;" onclick="window.deleteAutoRule(${r.id})" title="Delete rule">×</span>
                </div>
            </div>`;
        }).join('');
    }

    window.deleteAutoRule = async function (ruleId) {
        if (!confirm('Delete this learned rule?')) return;
        await apiCall(`/rules/${ruleId}`, 'DELETE');
        autoState.rules = autoState.rules.filter(r => r.id !== ruleId);
        renderRules();
    };

    // ─── Market Scans ────────────────────────────────────────────────────

    function renderMarketScans() {
        const container = document.getElementById('autoScansContainer');
        const lastEl = document.getElementById('autoLastScan');
        if (!container) return;

        if (autoState.scans.length === 0) {
            container.innerHTML = '<div style="color:#555; text-align:center; padding:30px 0; font-size:12px;">Grok scans market daily at 6 AM.</div>';
            return;
        }

        if (lastEl) lastEl.textContent = 'Last: ' + fmtTime(autoState.scans[0]?.scanned_at);

        container.innerHTML = autoState.scans.map(s => {
            const sentiment = s.sentiment_summary || 'N/A';
            const sentColor = sentiment.toLowerCase().includes('bull') ? '#00ff88' : sentiment.toLowerCase().includes('bear') ? '#ff5252' : '#ffaa00';
            return `
            <div style="padding:6px 0; border-bottom:1px solid #222; font-size:12px;">
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#4fc3f7;">${fmtDate(s.scanned_at)}</span>
                    <span style="color:${sentColor}; font-size:11px;">${sentiment}</span>
                </div>
                <div style="font-size:11px; color:#888; margin-top:3px;">
                    Candidates: ${s.candidate_tickers || '—'}
                </div>
                ${s.scan_data ? `<div style="font-size:10px; color:#666; margin-top:2px; cursor:pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none';">📋 Details ▸</div><div style="display:none; font-size:11px; color:#aaa; margin-top:3px; padding:6px; background:#111; border-radius:4px; max-height:200px; overflow-y:auto; white-space:pre-wrap;">${typeof s.scan_data === 'string' ? s.scan_data : JSON.stringify(s.scan_data, null, 2)}</div>` : ''}
            </div>`;
        }).join('');
    }

    // ─── Daily Summaries ─────────────────────────────────────────────────

    async function refreshDailySummaries() {
        const res = await apiCall('/daily-summaries?limit=14');
        if (res.error) return;
        autoState.dailySummaries = res.summaries || [];
        renderDailySummaries();
    }

    function renderDailySummaries() {
        const container = document.getElementById('autoDailySummaries');
        if (!container) return;

        if (autoState.dailySummaries.length === 0) {
            container.innerHTML = '<div style="color:#555; text-align:center; padding:30px 0; font-size:12px;">Daily reflections will appear after trading days.</div>';
            return;
        }

        container.innerHTML = autoState.dailySummaries.map(s => `
            <div style="background:#0d0d1a; border-radius:8px; padding:12px; margin-bottom:10px; border:1px solid #222;">
                <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                    <span style="color:#ce93d8; font-weight:600;">${fmtDate(s.trade_date)}</span>
                    <span style="color:${pnlColor(s.day_pnl)}; font-weight:600;">${fmt$(s.day_pnl)}</span>
                </div>
                <div style="font-size:12px; color:#888;">
                    Trades: ${s.trades_opened || 0} opened, ${s.trades_closed || 0} closed · 
                    W/L: <span style="color:#00ff88;">${s.wins || 0}W</span> / <span style="color:#ff5252;">${s.losses || 0}L</span>
                </div>
                ${s.reflection ? `
                <div style="margin-top:8px; font-size:11px; color:#aaa; border-top:1px solid #222; padding-top:8px; white-space:pre-wrap;">${s.reflection}</div>
                ` : ''}
            </div>
        `).join('');
    }

    // ─── Controls ────────────────────────────────────────────────────────

    window.toggleAutonomousTrader = async function () {
        if (autoState.enabled) {
            const res = await apiCall('/disable', 'POST');
            if (!res.error) {
                autoState.enabled = false;
                addLogEntry('🛑 Autonomous Trader DISABLED', 'warning');
            }
        } else {
            const res = await apiCall('/enable', 'POST');
            if (!res.error) {
                autoState.enabled = true;
                addLogEntry('✅ Autonomous Trader ENABLED — cron schedules active', 'info');
            }
        }
        updateStatusBadge();
    };

    window.killSwitchAutonomous = async function () {
        if (!confirm('🛑 KILL SWITCH: This will disable the trader AND close all open positions at market price. Are you sure?')) return;
        
        // Disable first
        await apiCall('/disable', 'POST');
        autoState.enabled = false;
        
        // Close all open positions
        for (const trade of autoState.openTrades) {
            await apiCall(`/close-trade/${trade.id}`, 'POST', { reason: 'kill_switch', close_price: trade.current_price || trade.premium_received });
        }
        
        addLogEntry('🛑 KILL SWITCH ACTIVATED — All positions closed, trader disabled', 'error');
        updateStatusBadge();
        await refreshDashboardData();
    };

    window.showRunPhaseMenu = function () {
        // Create a dropdown menu for manual phase execution
        const existing = document.getElementById('autoPhaseMenu');
        if (existing) { existing.remove(); return; }

        const btn = document.getElementById('autoTraderRunPhaseBtn');
        const rect = btn.getBoundingClientRect();

        const menu = document.createElement('div');
        menu.id = 'autoPhaseMenu';
        menu.style.cssText = `position:fixed; top:${rect.bottom + 4}px; left:${rect.left}px; background:#1a1a2e; border:1px solid #444; border-radius:8px; padding:6px; z-index:10000; min-width:220px; box-shadow:0 4px 16px rgba(0,0,0,0.5);`;

        const phases = [
            { id: 1, label: '🌐 Phase 1: Gather Intel (Grok)', desc: 'Scan X sentiment + market data' },
            { id: 2, label: '🧠 Phase 2: Analyze & Pick (DeepSeek)', desc: 'Select 5 trade candidates' },
            { id: 3, label: '⚡ Phase 3: Execute Trades', desc: 'Validate & place paper trades' },
            { id: 4, label: '📊 Phase 4: End-of-Day Review', desc: 'Close expired, update summary' },
            { id: 5, label: '💭 Phase 5: Self-Reflect', desc: 'AI reviews trades, writes rules' }
        ];

        phases.forEach(p => {
            const item = document.createElement('div');
            item.style.cssText = 'padding:8px 12px; cursor:pointer; border-radius:4px; transition:background 0.15s;';
            item.innerHTML = `<div style="color:#00d9ff; font-size:13px;">${p.label}</div><div style="color:#666; font-size:11px;">${p.desc}</div>`;
            item.onmouseenter = () => item.style.background = 'rgba(0,217,255,0.1)';
            item.onmouseleave = () => item.style.background = 'none';
            item.onclick = async () => {
                menu.remove();
                addLogEntry(`⚡ Manually running Phase ${p.id}...`, 'progress');
                const res = await apiCall('/run-phase', 'POST', { phase: p.id });
                if (res.error) {
                    addLogEntry(`❌ Phase ${p.id} failed: ${res.error}`, 'error');
                } else {
                    addLogEntry(`✅ Phase ${p.id} complete`, 'info');
                    await refreshDashboardData();
                }
            };
            menu.appendChild(item);
        });

        document.body.appendChild(menu);

        // Close on click outside
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && e.target !== btn) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 50);
    };

    window.closeAutoTrade = async function (tradeId) {
        if (!confirm('Close this autonomous trade?')) return;
        const res = await apiCall(`/close-trade/${tradeId}`, 'POST', { reason: 'manual_close' });
        if (!res.error) {
            addLogEntry(`📤 Manually closed trade #${tradeId}`, 'trade-close');
            await refreshDashboardData();
        }
    };

    // ─── Config Modal ────────────────────────────────────────────────────

    window.showAutoTraderConfig = async function () {
        const res = await apiCall('/config');
        const cfg = res.config || autoState.config || {};

        const modal = document.createElement('div');
        modal.id = 'autoConfigModal';
        modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10000;';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

        modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:24px; width:450px; max-height:80vh; overflow-y:auto; border:1px solid #444;">
            <h3 style="color:#00d9ff; margin:0 0 16px 0;">⚙️ Autonomous Trader Config</h3>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Paper Balance ($)</label>
                    <input id="cfgPaperBalance" type="number" value="${cfg.paper_balance || 100000}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Max Positions</label>
                    <input id="cfgMaxPositions" type="number" value="${cfg.max_positions || 5}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Max DTE</label>
                    <input id="cfgMaxDte" type="number" value="${cfg.max_dte || 10}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Stop-Loss Multiplier (x credit)</label>
                    <input id="cfgStopLoss" type="number" step="0.1" value="${cfg.stop_loss_multiplier || 2}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Profit Target (%)</label>
                    <input id="cfgProfitTarget" type="number" value="${cfg.profit_target_pct || 50}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">Max Daily Capital (%)</label>
                    <input id="cfgMaxCapital" type="number" value="${cfg.max_daily_capital_pct || 20}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">🛡️ Max Margin Cap (%)</label>
                    <input id="cfgMaxMarginPct" type="number" value="${cfg.max_margin_pct || 70}" min="20" max="100" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                    <div style="font-size:9px; color:#555; margin-top:2px;">Stops new trades above this % of paper balance</div>
                </div>
                <div>
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">⏰ Manage at DTE</label>
                    <input id="cfgManageDte" type="number" value="${cfg.manage_dte || 21}" min="0" max="30" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                    <div style="font-size:9px; color:#555; margin-top:2px;">Auto-close positions at this DTE (0 = disabled). Avoids gamma risk.</div>
                </div>
                <div style="grid-column:1/-1;">
                    <label style="color:#888; font-size:11px; display:block; margin-bottom:4px;">DeepSeek Model</label>
                    <input id="cfgDeepseekModel" type="text" value="${cfg.deepseek_model || 'deepseek-r1:70b'}" style="width:100%; background:#0d0d1a; border:1px solid #444; color:#fff; padding:6px; border-radius:4px;">
                </div>
            </div>

            <div style="margin-top:12px; padding:10px; background:#111; border-radius:6px; font-size:11px; color:#888;">
                <strong style="color:#ffaa00;">⏰ Schedule (ET, Mon-Fri):</strong><br>
                6:00 AM — Grok gathers market intel from X<br>
                7:00 AM — DeepSeek R1 analyzes and picks 5 trades<br>
                9:31 AM — Execute trades at market open<br>
                4:01 PM — End-of-day review and close expired<br>
                4:30 PM — AI self-reflects and writes learned rules
            </div>

            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:16px;">
                <button onclick="this.closest('#autoConfigModal').remove()" style="background:rgba(100,100,100,0.3); border:1px solid #444; color:#aaa; padding:8px 16px; border-radius:6px; cursor:pointer;">Cancel</button>
                <button onclick="window.saveAutoConfig()" style="background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.4); color:#00ff88; padding:8px 16px; border-radius:6px; cursor:pointer;">💾 Save Config</button>
            </div>
        </div>`;

        document.body.appendChild(modal);
    };

    window.saveAutoConfig = async function () {
        const cfg = {
            paper_balance: Number(document.getElementById('cfgPaperBalance').value),
            max_positions: Number(document.getElementById('cfgMaxPositions').value),
            max_dte: Number(document.getElementById('cfgMaxDte').value),
            stop_loss_multiplier: Number(document.getElementById('cfgStopLoss').value),
            profit_target_pct: Number(document.getElementById('cfgProfitTarget').value),
            max_daily_capital_pct: Number(document.getElementById('cfgMaxCapital').value),
            max_margin_pct: Number(document.getElementById('cfgMaxMarginPct').value),
            manage_dte: Number(document.getElementById('cfgManageDte').value),
            deepseek_model: document.getElementById('cfgDeepseekModel').value
        };

        const res = await apiCall('/config', 'POST', cfg);
        if (!res.error) {
            autoState.config = cfg;
            addLogEntry('⚙️ Config saved', 'info');
            renderPerfCards();
        }
        document.getElementById('autoConfigModal')?.remove();
    };

    // ─── Initialize ──────────────────────────────────────────────────────

    function init() {
        setupSocketListeners();
        
        // Defer initial data load until tab is first shown
        // (refreshAutoTraderDashboard is called from main.js tab handler)
        
        // Resize equity canvas on window resize
        window.addEventListener('resize', () => {
            if (document.getElementById('autonomous')?.classList.contains('active')) {
                drawEquityCurve();
            }
        });
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
