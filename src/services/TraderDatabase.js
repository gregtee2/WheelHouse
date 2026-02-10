/**
 * TraderDatabase.js — SQLite persistence layer for the Autonomous Trader
 * 
 * Tables:
 *   trades          — every trade the AI places (entry, exit, P&L, rationale)
 *   market_scans    — daily Grok sentiment + market context
 *   trade_reviews   — AI self-assessment after each trade closes
 *   daily_summaries — aggregate metrics per day
 *   learned_rules   — rules the AI has derived from its own performance
 *   config          — runtime configuration (risk params, schedule, etc.)
 */

const path = require('path');
const fs = require('fs');

// Lazy-load better-sqlite3 (native module)
let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    console.error('[TraderDB] ❌ Failed to load better-sqlite3:', e.message);
}

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DB_DIR, 'autonomous-trader.db');

let db = null;

// ────────────────────────────────────────────────────────────
// Initialization
// ────────────────────────────────────────────────────────────

function initialize() {
    if (!Database) {
        console.error('[TraderDB] ❌ better-sqlite3 not available');
        return false;
    }

    // Ensure data/ directory exists
    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // Write-Ahead Logging for performance
    db.pragma('foreign_keys = ON');

    createTables();
    migrateSchema();
    seedDefaults();

    console.log(`[TraderDB] ✓ Database initialized at ${DB_PATH}`);
    return true;
}

function createTables() {
    db.exec(`
        -- Every trade the AI makes
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            strategy TEXT NOT NULL,           -- 'short_put', 'credit_spread', 'covered_call'
            direction TEXT DEFAULT 'short',    -- 'short' or 'long'
            strike REAL,
            strike_sell REAL,                  -- for spreads
            strike_buy REAL,                   -- for spreads
            spread_width REAL,                 -- for spreads
            expiry TEXT,                       -- ISO date
            dte INTEGER,
            contracts INTEGER DEFAULT 1,
            
            -- Entry
            entry_price REAL,                  -- premium received/paid
            entry_date TEXT NOT NULL,
            entry_spot REAL,                   -- underlying price at entry
            entry_iv REAL,                     -- IV at entry
            entry_delta REAL,                  -- delta at entry
            
            -- Exit (null while open)
            exit_price REAL,
            exit_date TEXT,
            exit_spot REAL,
            exit_reason TEXT,                  -- 'profit_target', 'stop_loss', 'expiry', 'manual', 'dte_close'
            
            -- P&L
            pnl_dollars REAL,
            pnl_percent REAL,                  -- % of credit received
            max_profit REAL,                   -- theoretical max
            max_loss REAL,                     -- theoretical max loss
            
            -- Context
            market_scan_id INTEGER,
            ai_rationale TEXT,                 -- why the AI picked this trade
            ai_confidence INTEGER,             -- 0-100
            model_used TEXT DEFAULT 'deepseek-r1:70b',
            
            -- Sector (for diversification)
            sector TEXT,                       -- 'Tech', 'Finance', 'Energy', 'Consumer', 'Healthcare', 'ETF', 'High IV'
            
            -- Risk management
            stop_loss_price REAL,              -- calculated stop-loss trigger
            profit_target_price REAL,          -- calculated profit target trigger
            
            -- Status
            status TEXT DEFAULT 'open',        -- 'open', 'closed', 'cancelled'
            
            -- Timestamps
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            
            FOREIGN KEY (market_scan_id) REFERENCES market_scans(id)
        );

        -- Daily market scans (Grok sentiment + data)
        CREATE TABLE IF NOT EXISTS market_scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_date TEXT NOT NULL UNIQUE,     -- ISO date (one per day)
            
            -- Grok sentiment data
            grok_sentiment_raw TEXT,            -- full Grok response
            market_mood TEXT,                   -- 'bullish', 'bearish', 'neutral', 'mixed'
            trending_tickers TEXT,              -- JSON array of trending tickers
            sector_momentum TEXT,               -- JSON object of sector trends
            caution_flags TEXT,                 -- JSON array of warnings
            
            -- Market data
            vix_level REAL,
            spy_price REAL,
            spy_change_percent REAL,
            
            -- Candidate pool
            candidates_raw TEXT,               -- JSON array of all candidates evaluated
            picks_raw TEXT,                    -- JSON array of 5 selected trades (DeepSeek output)
            
            -- Model info
            grok_model TEXT DEFAULT 'grok-4',
            deepseek_model TEXT DEFAULT 'deepseek-r1:70b',
            
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- AI self-assessment after each trade closes
        CREATE TABLE IF NOT EXISTS trade_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_id INTEGER NOT NULL,
            
            review_text TEXT,                  -- AI's full analysis of the trade
            lessons_learned TEXT,              -- key takeaway
            what_worked TEXT,
            what_failed TEXT,
            should_repeat INTEGER DEFAULT 0,   -- 1 = yes, try this again; 0 = no
            
            model_used TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            
            FOREIGN KEY (trade_id) REFERENCES trades(id)
        );

        -- Aggregate metrics per day
        CREATE TABLE IF NOT EXISTS daily_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            summary_date TEXT NOT NULL UNIQUE,
            
            -- Performance
            trades_opened INTEGER DEFAULT 0,
            trades_closed INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0,
            losses INTEGER DEFAULT 0,
            total_pnl REAL DEFAULT 0,
            
            -- Portfolio state
            account_value REAL,
            buying_power REAL,
            capital_at_risk REAL,
            
            -- AI reflection
            daily_reflection TEXT,             -- end-of-day AI summary
            
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- Rules the AI has derived from its own performance
        CREATE TABLE IF NOT EXISTS learned_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_text TEXT NOT NULL,
            category TEXT,                     -- 'entry', 'exit', 'risk', 'sector', 'timing'
            source_trade_ids TEXT,             -- JSON array of trade IDs that led to this rule
            confidence REAL DEFAULT 0.5,       -- 0-1, how confident the AI is in this rule
            times_applied INTEGER DEFAULT 0,
            times_helpful INTEGER DEFAULT 0,   -- when applied, did it help?
            active INTEGER DEFAULT 1,          -- 0 = pruned/deprecated
            
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- Runtime configuration
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        -- Indices for common queries
        CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
        CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
        CREATE INDEX IF NOT EXISTS idx_trades_entry_date ON trades(entry_date);
        CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
        CREATE INDEX IF NOT EXISTS idx_market_scans_date ON market_scans(scan_date);
        CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(summary_date);
    `);
}

/**
 * Safe schema migrations - adds columns that may not exist in older DBs
 */
function migrateSchema() {
    // Add sector column to trades if it doesn't exist (added v1.19.94)
    try {
        const cols = db.prepare("PRAGMA table_info(trades)").all();
        const colNames = cols.map(c => c.name);
        if (!colNames.includes('sector')) {
            db.exec("ALTER TABLE trades ADD COLUMN sector TEXT");
            console.log('[TraderDB] ✓ Migration: added sector column to trades');
        }
    } catch (e) {
        console.error('[TraderDB] Migration warning:', e.message);
    }
}

function seedDefaults() {
    const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
    const defaults = {
        'enabled': 'false',
        'paper_balance': '100000',
        'max_positions': '5',
        'max_daily_risk_pct': '20',
        'stop_loss_multiplier': '2',           // 2x credit received
        'profit_target_pct': '50',             // 50% of max profit
        'min_dte': '1',
        'max_dte': '45',
        'allowed_strategies': JSON.stringify(['short_put', 'credit_spread', 'covered_call']),
        'min_spread_width': '5',               // $5 minimum for spreads
        'blacklist_earnings_dte': '3',         // skip if ER within 3 days of expiry
        'morning_scan_time': '06:00',          // ET
        'analysis_time': '07:00',
        'execution_time': '09:31',
        'eod_review_time': '16:01',
        'reflection_time': '16:30',
        'monitor_interval_sec': '30',          // real-time monitor check interval
        'max_per_sector': '2',                  // max positions per sector (diversification)
        'max_margin_pct': '70',                    // max % of paper balance that can be committed (capital preservation)
        'deepseek_model': 'deepseek-r1:70b',
        'grok_model': 'grok-4'
    };

    const tx = db.transaction(() => {
        for (const [key, value] of Object.entries(defaults)) {
            insertConfig.run(key, value);
        }
        // Fix: upgrade max_dte from overly-restrictive v1 default of 10
        db.prepare("UPDATE config SET value = '45' WHERE key = 'max_dte' AND value = '10'").run();
    });
    tx();
}

// ────────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────────

function getConfig(key) {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
}

function getConfigNum(key) {
    const val = getConfig(key);
    return val !== null ? parseFloat(val) : null;
}

function getConfigJSON(key) {
    const val = getConfig(key);
    try { return val ? JSON.parse(val) : null; } catch { return null; }
}

function setConfig(key, value) {
    db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, String(value));
}

function getAllConfig() {
    const rows = db.prepare('SELECT key, value FROM config').all();
    const config = {};
    for (const row of rows) {
        // Try to parse JSON/numbers
        try {
            config[row.key] = JSON.parse(row.value);
        } catch {
            config[row.key] = row.value;
        }
    }
    return config;
}

// ────────────────────────────────────────────────────────────
// Trade CRUD
// ────────────────────────────────────────────────────────────

function insertTrade(trade) {
    const stmt = db.prepare(`
        INSERT INTO trades (ticker, strategy, direction, strike, strike_sell, strike_buy,
            spread_width, expiry, dte, contracts, entry_price, entry_date, entry_spot,
            entry_iv, entry_delta, market_scan_id, ai_rationale, ai_confidence, model_used,
            stop_loss_price, profit_target_price, max_profit, max_loss, sector, status)
        VALUES (@ticker, @strategy, @direction, @strike, @strikeSell, @strikeBuy,
            @spreadWidth, @expiry, @dte, @contracts, @entryPrice, @entryDate, @entrySpot,
            @entryIV, @entryDelta, @marketScanId, @aiRationale, @aiConfidence, @modelUsed,
            @stopLossPrice, @profitTargetPrice, @maxProfit, @maxLoss, @sector, 'open')
    `);
    const result = stmt.run({
        ticker: trade.ticker,
        strategy: trade.strategy,
        direction: trade.direction || 'short',
        strike: trade.strike || null,
        strikeSell: trade.strikeSell || null,
        strikeBuy: trade.strikeBuy || null,
        spreadWidth: trade.spreadWidth || null,
        expiry: trade.expiry,
        dte: trade.dte,
        contracts: trade.contracts || 1,
        entryPrice: trade.entryPrice,
        entryDate: trade.entryDate,
        entrySpot: trade.entrySpot || null,
        entryIV: trade.entryIV || null,
        entryDelta: trade.entryDelta || null,
        marketScanId: trade.marketScanId || null,
        aiRationale: trade.aiRationale || null,
        aiConfidence: trade.aiConfidence || null,
        modelUsed: trade.modelUsed || 'deepseek-r1:70b',
        stopLossPrice: trade.stopLossPrice || null,
        profitTargetPrice: trade.profitTargetPrice || null,
        maxProfit: trade.maxProfit || null,
        maxLoss: trade.maxLoss || null,
        sector: trade.sector || null
    });
    return result.lastInsertRowid;
}

function closeTrade(tradeId, closeData) {
    db.prepare(`
        UPDATE trades SET 
            exit_price = ?, exit_date = ?, exit_spot = ?, exit_reason = ?,
            pnl_dollars = ?, pnl_percent = ?, status = 'closed',
            updated_at = datetime('now')
        WHERE id = ?
    `).run(
        closeData.exitPrice,
        closeData.exitDate || new Date().toISOString().split('T')[0],
        closeData.exitSpot || null,
        closeData.exitReason,
        closeData.pnlDollars,
        closeData.pnlPercent,
        tradeId
    );
}

function getOpenTrades() {
    return db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY entry_date DESC').all('open');
}

function getClosedTrades(limit = 100) {
    return db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY exit_date DESC LIMIT ?').all('closed', limit);
}

function getTrade(tradeId) {
    return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
}

function deleteTrade(tradeId) {
    return db.prepare('DELETE FROM trades WHERE id = ?').run(tradeId);
}

function getAllTrades(limit = 500) {
    return db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getTradesByTicker(ticker, limit = 50) {
    return db.prepare('SELECT * FROM trades WHERE ticker = ? ORDER BY created_at DESC LIMIT ?').all(ticker, limit);
}

function getTradesByStrategy(strategy, limit = 50) {
    return db.prepare('SELECT * FROM trades WHERE strategy = ? ORDER BY created_at DESC LIMIT ?').all(strategy, limit);
}

function updateTradePrice(tradeId, currentPrice) {
    db.prepare("UPDATE trades SET updated_at = datetime('now') WHERE id = ?").run(tradeId);
}

// ────────────────────────────────────────────────────────────
// Market Scans
// ────────────────────────────────────────────────────────────

function insertMarketScan(scan) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO market_scans (scan_date, grok_sentiment_raw, market_mood,
            trending_tickers, sector_momentum, caution_flags, vix_level, spy_price,
            spy_change_percent, candidates_raw, picks_raw, grok_model, deepseek_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        scan.scanDate,
        scan.grokSentimentRaw || null,
        scan.marketMood || null,
        JSON.stringify(scan.trendingTickers || []),
        JSON.stringify(scan.sectorMomentum || {}),
        JSON.stringify(scan.cautionFlags || []),
        scan.vixLevel || null,
        scan.spyPrice || null,
        scan.spyChangePercent || null,
        JSON.stringify(scan.candidatesRaw || []),
        JSON.stringify(scan.picksRaw || []),
        scan.grokModel || 'grok-4',
        scan.deepseekModel || 'deepseek-r1:70b'
    );
    return result.lastInsertRowid;
}

function getLatestMarketScan() {
    return db.prepare('SELECT * FROM market_scans ORDER BY scan_date DESC LIMIT 1').get();
}

function getMarketScan(date) {
    return db.prepare('SELECT * FROM market_scans WHERE scan_date = ?').get(date);
}

// ────────────────────────────────────────────────────────────
// Trade Reviews
// ────────────────────────────────────────────────────────────

function insertTradeReview(review) {
    db.prepare(`
        INSERT INTO trade_reviews (trade_id, review_text, lessons_learned, 
            what_worked, what_failed, should_repeat, model_used)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        review.tradeId,
        review.reviewText,
        review.lessonsLearned || null,
        review.whatWorked || null,
        review.whatFailed || null,
        review.shouldRepeat ? 1 : 0,
        review.modelUsed || 'deepseek-r1:70b'
    );
}

function getTradeReviews(tradeId) {
    return db.prepare('SELECT * FROM trade_reviews WHERE trade_id = ? ORDER BY created_at DESC').all(tradeId);
}

// ────────────────────────────────────────────────────────────
// Daily Summaries
// ────────────────────────────────────────────────────────────

function upsertDailySummary(summary) {
    db.prepare(`
        INSERT OR REPLACE INTO daily_summaries (summary_date, trades_opened, trades_closed,
            wins, losses, total_pnl, account_value, buying_power, capital_at_risk, daily_reflection)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        summary.date,
        summary.tradesOpened || 0,
        summary.tradesClosed || 0,
        summary.wins || 0,
        summary.losses || 0,
        summary.totalPnl || 0,
        summary.accountValue || null,
        summary.buyingPower || null,
        summary.capitalAtRisk || null,
        summary.dailyReflection || null
    );
}

function getDailySummaries(limit = 30) {
    return db.prepare('SELECT * FROM daily_summaries ORDER BY summary_date DESC LIMIT ?').all(limit);
}

// ────────────────────────────────────────────────────────────
// Learned Rules
// ────────────────────────────────────────────────────────────

function insertLearnedRule(rule) {
    const result = db.prepare(`
        INSERT INTO learned_rules (rule_text, category, source_trade_ids, confidence)
        VALUES (?, ?, ?, ?)
    `).run(
        rule.ruleText,
        rule.category || 'general',
        JSON.stringify(rule.sourceTradeIds || []),
        rule.confidence || 0.5
    );
    return result.lastInsertRowid;
}

function getActiveRules() {
    return db.prepare('SELECT * FROM learned_rules WHERE active = 1 ORDER BY confidence DESC').all();
}

function updateRuleEffectiveness(ruleId, wasHelpful) {
    const field = wasHelpful ? 'times_helpful' : 'times_applied';
    db.prepare(`
        UPDATE learned_rules SET 
            times_applied = times_applied + 1,
            ${wasHelpful ? 'times_helpful = times_helpful + 1,' : ''}
            confidence = CASE 
                WHEN times_applied > 5 AND CAST(times_helpful AS REAL) / times_applied < 0.3 
                THEN MAX(confidence - 0.1, 0.1)
                WHEN times_applied > 5 AND CAST(times_helpful AS REAL) / times_applied > 0.7 
                THEN MIN(confidence + 0.1, 1.0)
                ELSE confidence
            END,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(ruleId);
}

function pruneWeakRules() {
    // Deactivate rules that have been applied 10+ times with <25% helpfulness
    db.prepare(`
        UPDATE learned_rules SET active = 0, updated_at = datetime('now')
        WHERE times_applied >= 10 AND CAST(times_helpful AS REAL) / times_applied < 0.25
    `).run();
}

// ────────────────────────────────────────────────────────────
// Performance Analytics
// ────────────────────────────────────────────────────────────

function getPerformanceMetrics(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const closed = db.prepare(`
        SELECT * FROM trades WHERE status = 'closed' AND exit_date >= ?
    `).all(since);

    const wins = closed.filter(t => (t.pnl_dollars || 0) > 0);
    const losses = closed.filter(t => (t.pnl_dollars || 0) <= 0);

    const totalPnl = closed.reduce((sum, t) => sum + (t.pnl_dollars || 0), 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_dollars, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_dollars, 0) / losses.length : 0;

    // Strategy breakdown
    const byStrategy = {};
    for (const t of closed) {
        if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
        if (t.pnl_dollars > 0) byStrategy[t.strategy].wins++;
        else byStrategy[t.strategy].losses++;
        byStrategy[t.strategy].pnl += t.pnl_dollars || 0;
    }

    // Ticker breakdown
    const byTicker = {};
    for (const t of closed) {
        if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, pnl: 0 };
        if (t.pnl_dollars > 0) byTicker[t.ticker].wins++;
        else byTicker[t.ticker].losses++;
        byTicker[t.ticker].pnl += t.pnl_dollars || 0;
    }

    // Best and worst trades
    const sortedByPnl = [...closed].sort((a, b) => (b.pnl_dollars || 0) - (a.pnl_dollars || 0));
    const bestTrade = sortedByPnl[0] || null;
    const worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;

    // Daily P&L series for equity curve
    const dailyPnl = db.prepare(`
        SELECT exit_date, SUM(pnl_dollars) as daily_pnl 
        FROM trades WHERE status = 'closed' AND exit_date >= ?
        GROUP BY exit_date ORDER BY exit_date
    `).all(since);

    return {
        period: `${days}d`,
        totalTrades: closed.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) : '0.0',
        totalPnl: Math.round(totalPnl * 100) / 100,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss).toFixed(2) : 'N/A',
        byStrategy,
        byTicker,
        bestTrade,
        worstTrade,
        dailyPnl,
        expectancy: closed.length 
            ? Math.round(((wins.length / closed.length * avgWin) + (losses.length / closed.length * avgLoss)) * 100) / 100 
            : 0
    };
}

function getEquityCurve() {
    const startingBalance = getConfigNum('paper_balance') || 100000;
    const trades = db.prepare(`
        SELECT exit_date, pnl_dollars FROM trades 
        WHERE status = 'closed' ORDER BY exit_date, id
    `).all();

    let cumulative = startingBalance;
    const curve = [{ date: 'start', value: startingBalance }];

    for (const t of trades) {
        cumulative += (t.pnl_dollars || 0);
        curve.push({ date: t.exit_date, value: Math.round(cumulative * 100) / 100 });
    }

    return { startingBalance, currentValue: cumulative, curve };
}

// Build the performance context string that gets injected into DeepSeek prompts
function buildPerformanceContext() {
    const metrics = getPerformanceMetrics(30);
    const rules = getActiveRules();
    const recentReviews = db.prepare(`
        SELECT tr.*, t.ticker, t.strategy, t.pnl_dollars 
        FROM trade_reviews tr JOIN trades t ON tr.trade_id = t.id 
        ORDER BY tr.created_at DESC LIMIT 10
    `).all();

    let context = `📊 YOUR TRADING RECORD (Last 30 days):\n`;
    context += `- Total Trades: ${metrics.totalTrades}\n`;
    context += `- Win Rate: ${metrics.winRate}% (${metrics.wins}W / ${metrics.losses}L)\n`;
    context += `- Total P&L: $${metrics.totalPnl.toFixed(2)}\n`;
    context += `- Avg Win: $${metrics.avgWin.toFixed(2)}, Avg Loss: $${metrics.avgLoss.toFixed(2)}\n`;
    context += `- Profit Factor: ${metrics.profitFactor}\n`;
    context += `- Expectancy per trade: $${metrics.expectancy.toFixed(2)}\n\n`;

    // Strategy breakdown
    context += `📋 BY STRATEGY:\n`;
    for (const [strategy, data] of Object.entries(metrics.byStrategy)) {
        const wr = data.wins + data.losses > 0 ? (data.wins / (data.wins + data.losses) * 100).toFixed(0) : '0';
        context += `- ${strategy}: ${wr}% win rate (${data.wins}W/${data.losses}L), P&L: $${data.pnl.toFixed(2)}\n`;
    }
    context += '\n';

    // Ticker breakdown (top 5 by trade count)
    const tickerEntries = Object.entries(metrics.byTicker).sort((a, b) => 
        (b[1].wins + b[1].losses) - (a[1].wins + a[1].losses)
    ).slice(0, 5);
    if (tickerEntries.length) {
        context += `📈 TOP TICKERS:\n`;
        for (const [ticker, data] of tickerEntries) {
            const wr = (data.wins / (data.wins + data.losses) * 100).toFixed(0);
            context += `- ${ticker}: ${wr}% win rate, P&L: $${data.pnl.toFixed(2)}\n`;
        }
        context += '\n';
    }

    // Learned rules
    if (rules.length) {
        context += `⚠️ RULES YOU'VE LEARNED (Do NOT violate without strong reason):\n`;
        rules.forEach((r, i) => {
            const effectiveness = r.times_applied > 0 
                ? ` (${r.times_helpful}/${r.times_applied} times helpful)` 
                : '';
            context += `${i + 1}. [${r.category}] ${r.rule_text}${effectiveness}\n`;
        });
        context += '\n';
    }

    // Recent lessons
    if (recentReviews.length) {
        context += `📝 RECENT LESSONS:\n`;
        for (const r of recentReviews.slice(0, 5)) {
            const outcome = r.pnl_dollars > 0 ? `+$${r.pnl_dollars.toFixed(0)}` : `-$${Math.abs(r.pnl_dollars).toFixed(0)}`;
            context += `- ${r.ticker} ${r.strategy} (${outcome}): ${r.lessons_learned || 'No lesson recorded'}\n`;
        }
    }

    return context;
}

// ────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────

function close() {
    if (db) {
        db.close();
        db = null;
        console.log('[TraderDB] Database closed');
    }
}

function isReady() {
    return db !== null;
}

module.exports = {
    initialize,
    close,
    isReady,
    // Config
    getConfig, getConfigNum, getConfigJSON, setConfig, getAllConfig,
    // Trades
    insertTrade, closeTrade, getOpenTrades, getClosedTrades, getTrade, deleteTrade,
    getAllTrades, getTradesByTicker, getTradesByStrategy, updateTradePrice,
    // Market scans
    insertMarketScan, getLatestMarketScan, getMarketScan,
    // Reviews
    insertTradeReview, getTradeReviews,
    // Summaries
    upsertDailySummary, getDailySummaries,
    // Learned rules
    insertLearnedRule, getActiveRules, updateRuleEffectiveness, pruneWeakRules,
    // Analytics
    getPerformanceMetrics, getEquityCurve, buildPerformanceContext
};
