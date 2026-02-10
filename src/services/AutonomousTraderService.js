/**
 * AutonomousTraderService.js — The autonomous trading engine
 * 
 * Orchestrates:
 *   1. Morning market scan (Grok-4 X sentiment + Yahoo/Schwab data)
 *   2. Trade analysis (DeepSeek-R1:70b picks 5 plays)
 *   3. Paper trade execution
 *   4. Real-time position monitoring (via Schwab streamer)
 *   5. End-of-day review & self-reflection
 * 
 * Uses node-cron for scheduling, SQLite for persistence.
 */

const cron = require('node-cron');
const TraderDB = require('./TraderDatabase');

// Services injected via init()
let AIService, MarketDataService, DataService, DiscoveryService, promptBuilders;
let socketIO = null;
let streamingHook = null;

// State
let isRunning = false;
let isEnabled = false;
let cronJobs = [];
let monitorInterval = null;
let lastMonitorCheck = null;
const priceCache = new Map(); // ticker → { price, timestamp }

// ────────────────────────────────────────────────────────────
// Initialization
// ────────────────────────────────────────────────────────────

function init(deps) {
    AIService = deps.AIService;
    MarketDataService = deps.MarketDataService;
    DataService = deps.DataService;
    DiscoveryService = deps.DiscoveryService;
    promptBuilders = deps.promptBuilders;
    socketIO = deps.socketIO || null;

    // Initialize database
    const dbReady = TraderDB.initialize();
    if (!dbReady) {
        console.error('[AutoTrader] ❌ Database initialization failed');
        return;
    }

    // Check if enabled on startup
    isEnabled = TraderDB.getConfig('enabled') === 'true';

    if (isEnabled) {
        startScheduler();
        console.log('[AutoTrader] ✓ Autonomous Trader initialized and ENABLED');
    } else {
        console.log('[AutoTrader] ✓ Autonomous Trader initialized (disabled — enable via UI)');
    }
}

// ────────────────────────────────────────────────────────────
// Scheduler (node-cron)
// ────────────────────────────────────────────────────────────

function startScheduler() {
    stopScheduler(); // Clear any existing jobs

    // All times in ET (America/New_York)
    const tz = 'America/New_York';

    // Phase 1: Morning market scan — 6:00 AM ET (Mon-Fri)
    cronJobs.push(cron.schedule('0 6 * * 1-5', () => {
        log('⏰ CRON: Morning market scan triggered');
        runPhase1_GatherIntel().catch(err => logError('Phase 1 failed', err));
    }, { timezone: tz }));

    // Phase 2: Analysis + picks — 7:00 AM ET (Mon-Fri)
    cronJobs.push(cron.schedule('0 7 * * 1-5', () => {
        log('⏰ CRON: DeepSeek analysis triggered');
        runPhase2_AnalyzeAndPick().catch(err => logError('Phase 2 failed', err));
    }, { timezone: tz }));

    // Phase 3: Execute trades — 9:31 AM ET (Mon-Fri, 1 min after open)
    cronJobs.push(cron.schedule('31 9 * * 1-5', () => {
        log('⏰ CRON: Trade execution triggered');
        runPhase3_Execute().catch(err => logError('Phase 3 failed', err));
    }, { timezone: tz }));

    // Phase 4: End-of-day review — 4:01 PM ET (Mon-Fri)
    cronJobs.push(cron.schedule('1 16 * * 1-5', () => {
        log('⏰ CRON: End-of-day review triggered');
        runPhase4_EndOfDay().catch(err => logError('Phase 4 failed', err));
    }, { timezone: tz }));

    // Phase 5: Self-reflection — 4:30 PM ET (Mon-Fri)
    cronJobs.push(cron.schedule('30 16 * * 1-5', () => {
        log('⏰ CRON: Self-reflection triggered');
        runPhase5_SelfReflect().catch(err => logError('Phase 5 failed', err));
    }, { timezone: tz }));

    // Start real-time monitor
    startMonitor();

    isRunning = true;
    log('✓ Scheduler started — 5 cron jobs + real-time monitor');
    emitStatus();
}

function stopScheduler() {
    for (const job of cronJobs) {
        job.stop();
    }
    cronJobs = [];
    stopMonitor();
    isRunning = false;
    log('⏹ Scheduler stopped');
    emitStatus();
}

function enable() {
    TraderDB.setConfig('enabled', 'true');
    isEnabled = true;
    startScheduler();
    log('✅ Autonomous Trader ENABLED');
}

function disable() {
    TraderDB.setConfig('enabled', 'false');
    isEnabled = false;
    stopScheduler();
    log('🛑 Autonomous Trader DISABLED');
}

// ────────────────────────────────────────────────────────────
// Phase 1: Gather Market Intel (Grok-4 + Data)
// ────────────────────────────────────────────────────────────

async function runPhase1_GatherIntel() {
    const today = new Date().toISOString().split('T')[0];
    log(`📡 Phase 1: Gathering market intel for ${today}...`);
    emitProgress('phase1', 'starting', 'Gathering market intelligence...');

    try {
        // Step 1: Get SPY + VIX quotes for market context
        emitProgress('phase1', 'fetching', 'Fetching SPY + VIX...');
        let spyQuote, vixLevel;
        try {
            spyQuote = await MarketDataService.getQuote('SPY');
            const vixQuote = await MarketDataService.getQuote('VIX');
            vixLevel = vixQuote?.price || null;
        } catch (e) {
            log(`⚠️ Market quotes failed: ${e.message}`);
            spyQuote = { price: 0, changePercent: 0 };
        }

        // Step 2: Get trending/active stocks from Yahoo
        emitProgress('phase1', 'discovery', 'Discovering trending stocks...');
        let trendingTickers = [];
        let activeTickers = [];
        try {
            trendingTickers = await DiscoveryService.fetchTrendingStocks();
            activeTickers = await DiscoveryService.fetchMostActiveStocks();
        } catch (e) {
            log(`⚠️ Discovery failed: ${e.message}`);
        }

        // Step 3: Call Grok-4 for X sentiment scan
        emitProgress('phase1', 'grok', 'Scanning X/Twitter sentiment via Grok-4...');
        let grokResult = null;
        let grokCitations = [];
        try {
            const grokPrompt = buildMarketScanPrompt(spyQuote, vixLevel, trendingTickers, activeTickers);
            const grokResponse = await AIService.callGrokWithSearch(grokPrompt, {
                xSearch: true,
                webSearch: true,
                maxTokens: 3000,
                model: TraderDB.getConfig('grok_model') || 'grok-4'
            });
            // callGrokWithSearch returns { content, citations }, not a plain string
            grokResult = grokResponse?.content || grokResponse || '';
            grokCitations = grokResponse?.citations || [];
            if (typeof grokResult !== 'string') grokResult = JSON.stringify(grokResult);
        } catch (e) {
            logError('Grok scan failed', e);
        }

        // Step 4: Parse Grok response for structured data
        const parsedSentiment = parseGrokSentiment(grokResult || '');

        // Step 5: Store in database
        const scanId = TraderDB.insertMarketScan({
            scanDate: today,
            grokSentimentRaw: grokResult || 'Grok scan failed',
            marketMood: parsedSentiment.mood,
            trendingTickers: parsedSentiment.tickers,
            sectorMomentum: parsedSentiment.sectors,
            cautionFlags: parsedSentiment.cautions,
            vixLevel,
            spyPrice: spyQuote?.price || null,
            spyChangePercent: spyQuote?.changePercent || null,
            grokModel: TraderDB.getConfig('grok_model') || 'grok-4',
            deepseekModel: TraderDB.getConfig('deepseek_model') || 'deepseek-r1:70b'
        });

        log(`✅ Phase 1 complete. Scan ID: ${scanId}, Mood: ${parsedSentiment.mood}, Tickers found: ${parsedSentiment.tickers.length}`);
        emitProgress('phase1', 'complete', `Scan complete: ${parsedSentiment.mood} mood, ${parsedSentiment.tickers.length} tickers`);
        return scanId;

    } catch (error) {
        logError('Phase 1 failed', error);
        emitProgress('phase1', 'error', error.message);
        throw error;
    }
}

// ────────────────────────────────────────────────────────────
// Phase 2: DeepSeek Analysis + Pick 5 Trades
// ────────────────────────────────────────────────────────────

async function runPhase2_AnalyzeAndPick() {
    log('🧠 Phase 2: DeepSeek R1 analysis...');
    emitProgress('phase2', 'starting', 'DeepSeek analyzing candidates...');

    try {
        // Get today's scan
        const today = new Date().toISOString().split('T')[0];
        let scan = TraderDB.getMarketScan(today);
        if (!scan) {
            log('⚠️ No market scan for today — running Phase 1 first');
            await runPhase1_GatherIntel();
            scan = TraderDB.getMarketScan(today);
        }
        if (!scan) throw new Error('Failed to get market scan');

        // Parse trending tickers from scan
        const trendingTickers = safeParseJSON(scan.trending_tickers, []);
        const cautionFlags = safeParseJSON(scan.caution_flags, []);

        // Step 1: Build candidate pool (trending + curated + active)
        emitProgress('phase2', 'candidates', 'Building candidate pool...');
        const candidatePool = buildCandidatePool(trendingTickers);

        // Step 2: Fetch IV + price data for top candidates
        emitProgress('phase2', 'data', `Fetching data for ${candidatePool.length} candidates...`);
        const candidateData = await fetchCandidateData(candidatePool);

        // Step 3: Store candidates in scan
        TraderDB.insertMarketScan({
            ...scanToInsertObj(scan),
            candidatesRaw: candidateData
        });

        // Step 4: Build DeepSeek prompt with performance history
        emitProgress('phase2', 'ai', 'DeepSeek R1 selecting trades (this may take 2-3 min)...');
        const performanceContext = TraderDB.buildPerformanceContext();
        const config = TraderDB.getAllConfig();
        const portfolioMargin = calculatePortfolioMargin();
        const prompt = buildTradeSelectionPrompt(scan, candidateData, performanceContext, config, cautionFlags, portfolioMargin);

        // Step 5: Call DeepSeek R1 (needs high token limit for structured output + thinking)
        const model = TraderDB.getConfig('deepseek_model') || 'deepseek-r1:70b';
        const result = await AIService.callAI(prompt, model, 4000);

        if (!result) throw new Error('DeepSeek returned empty response');

        // Debug: log what DeepSeek actually returned
        log(`🔍 DeepSeek raw response length: ${result.length} chars`);
        log(`🔍 First 500 chars: ${result.slice(0, 500)}`);
        log(`🔍 Contains ===TRADE_: ${result.includes('===TRADE_')}`);
        log(`🔍 Contains TICKER:: ${result.includes('TICKER:')}`);

        // Step 6: Parse structured trade picks
        const picks = parseTradePicksFromAI(result);
        log(`🧠 DeepSeek selected ${picks.length} trades`);

        // Store picks in the scan
        TraderDB.insertMarketScan({
            ...scanToInsertObj(scan),
            picksRaw: picks
        });

        log(`✅ Phase 2 complete. ${picks.length} trades selected.`);
        emitProgress('phase2', 'complete', `${picks.length} trades selected`);
        return picks;

    } catch (error) {
        logError('Phase 2 failed', error);
        emitProgress('phase2', 'error', error.message);
        throw error;
    }
}

// ────────────────────────────────────────────────────────────
// Phase 3: Execute Paper Trades
// ────────────────────────────────────────────────────────────

async function runPhase3_Execute() {
    log('📝 Phase 3: Executing paper trades...');
    emitProgress('phase3', 'starting', 'Placing paper trades...');

    try {
        const today = new Date().toISOString().split('T')[0];
        const scan = TraderDB.getMarketScan(today);
        if (!scan) throw new Error('No market scan for today');

        let picks = safeParseJSON(scan.picks_raw, []);
        if (!picks.length) {
            log('⚠️ No picks found — running Phase 2');
            picks = await runPhase2_AnalyzeAndPick();
        }
        if (!picks.length) {
            log('⚠️ Still no picks — skipping execution');
            emitProgress('phase3', 'skipped', 'No viable trades found today');
            return;
        }

        // Check current open positions
        const openTrades = TraderDB.getOpenTrades();
        const maxPositions = TraderDB.getConfigNum('max_positions') || 5;
        const slotsAvailable = maxPositions - openTrades.length;

        if (slotsAvailable <= 0) {
            log(`⚠️ Already at max positions (${openTrades.length}/${maxPositions}) — skipping`);
            emitProgress('phase3', 'skipped', `At max positions (${maxPositions})`);
            return;
        }

        // Check capital constraints
        const paperBalance = TraderDB.getConfigNum('paper_balance') || 100000;
        const maxDailyRiskPct = TraderDB.getConfigNum('max_daily_risk_pct') || 20;
        const maxDailyRisk = paperBalance * (maxDailyRiskPct / 100);

        // CAPITAL PRESERVATION: Check total portfolio margin before placing any trades
        const portfolioMargin = calculatePortfolioMargin();
        log(`💰 Portfolio margin: $${portfolioMargin.totalMargin.toFixed(0)} / $${portfolioMargin.maxAllowed.toFixed(0)} (${portfolioMargin.marginPct.toFixed(1)}% of ${portfolioMargin.maxMarginPct}% cap)`);

        if (portfolioMargin.marginPct >= portfolioMargin.maxMarginPct) {
            log(`🛡️ MARGIN CAP: Portfolio at ${portfolioMargin.marginPct.toFixed(1)}% — exceeds ${portfolioMargin.maxMarginPct}% limit. No new trades until positions close.`);
            emitProgress('phase3', 'skipped', `Margin cap reached (${portfolioMargin.marginPct.toFixed(0)}% of ${portfolioMargin.maxMarginPct}%)`);
            return;
        }

        const config = TraderDB.getAllConfig();
        let capitalUsed = 0;
        let tradesPlaced = 0;

        // Build set of tickers we already have open positions on
        const openTickers = new Set(openTrades.map(t => t.ticker));

        // Build sector count map for diversification enforcement
        // Max N positions per sector — prevents correlated blowups
        const MAX_PER_SECTOR = TraderDB.getConfigNum('max_per_sector') || 2;
        const sectorCounts = {};
        for (const t of openTrades) {
            const sector = t.sector || getSector(t.ticker);
            sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
        }
        log(`📊 Current sector exposure: ${JSON.stringify(sectorCounts)}`);

        for (const pick of picks.slice(0, slotsAvailable)) {
            try {
                // Skip duplicate tickers — never open 2 positions on the same underlying
                if (openTickers.has(pick.ticker)) {
                    log(`⚠️ ${pick.ticker} already has an open position — skipping duplicate`);
                    continue;
                }

                // Enforce sector diversification — max 2 positions per sector
                const pickSector = pick.sector || getSector(pick.ticker);
                if ((sectorCounts[pickSector] || 0) >= MAX_PER_SECTOR) {
                    log(`⚠️ ${pick.ticker} [${pickSector}] — already ${sectorCounts[pickSector]} positions in ${pickSector} — skipping for diversification`);
                    continue;
                }

                // Fetch live price for validation
                const quote = await MarketDataService.getQuote(pick.ticker);
                if (!quote?.price) {
                    log(`⚠️ Can't get quote for ${pick.ticker} — skipping`);
                    continue;
                }

                // Validate the trade still makes sense
                const validation = validateTrade(pick, quote, config);
                if (!validation.valid) {
                    log(`⚠️ ${pick.ticker} failed validation: ${validation.reason}`);
                    continue;
                }

                // Fetch option pricing
                let optionData;
                try {
                    optionData = await MarketDataService.getOptionPremium(
                        pick.ticker, pick.strike, pick.expiry, 
                        pick.strategy === 'short_put' ? 'P' : 'C'
                    );
                } catch (e) {
                    log(`⚠️ Can't get option price for ${pick.ticker} ${pick.strike} — skipping`);
                    continue;
                }

                const entryPrice = optionData?.mid || optionData?.ask || pick.estimatedPremium || 0;
                if (entryPrice <= 0.05) {
                    log(`⚠️ ${pick.ticker} premium too low ($${entryPrice}) — skipping`);
                    continue;
                }

                // Calculate risk for this trade
                const tradeRisk = calculateTradeRisk(pick, entryPrice, config);
                if (capitalUsed + tradeRisk > maxDailyRisk) {
                    log(`⚠️ ${pick.ticker} would exceed daily risk limit — skipping`);
                    continue;
                }

                // CAPITAL PRESERVATION: Check if this trade would push total margin past the cap
                if (portfolioMargin.totalMargin + capitalUsed + tradeRisk > portfolioMargin.maxAllowed) {
                    const afterPct = ((portfolioMargin.totalMargin + capitalUsed + tradeRisk) / paperBalance * 100).toFixed(1);
                    log(`🛡️ ${pick.ticker} would push margin to ${afterPct}% (cap: ${portfolioMargin.maxMarginPct}%) — skipping for capital preservation`);
                    continue;
                }

                // Calculate stop-loss and profit target prices
                const stopLossMultiplier = config.stop_loss_multiplier || 2;
                const profitTargetPct = (config.profit_target_pct || 50) / 100;

                const stopLossPrice = entryPrice * (1 + stopLossMultiplier);  // for short: buy back at this price
                const profitTargetPrice = entryPrice * (1 - profitTargetPct); // take profit here

                // Calculate max profit / max loss
                let maxProfit, maxLoss;
                if (pick.strategy === 'short_put') {
                    maxProfit = entryPrice * 100 * (pick.contracts || 1);
                    maxLoss = (pick.strike - entryPrice) * 100 * (pick.contracts || 1); // assigned at zero (theoretical)
                } else if (pick.strategy === 'credit_spread') {
                    const width = pick.spreadWidth || 5;
                    maxProfit = entryPrice * 100 * (pick.contracts || 1);
                    maxLoss = (width - entryPrice) * 100 * (pick.contracts || 1);
                } else if (pick.strategy === 'covered_call') {
                    maxProfit = entryPrice * 100 * (pick.contracts || 1);
                    maxLoss = quote.price * 100 * (pick.contracts || 1); // stock goes to zero
                }

                // Insert trade
                const tradeId = TraderDB.insertTrade({
                    ticker: pick.ticker,
                    strategy: pick.strategy,
                    direction: 'short',
                    strike: pick.strike,
                    strikeSell: pick.strikeSell || pick.strike,
                    strikeBuy: pick.strikeBuy || null,
                    spreadWidth: pick.spreadWidth || null,
                    expiry: pick.expiry,
                    dte: pick.dte || calculateDTE(pick.expiry),
                    contracts: pick.contracts || 1,
                    entryPrice,
                    entryDate: today,
                    entrySpot: quote.price,
                    sector: pickSector,
                    entryIV: optionData?.iv || null,
                    entryDelta: optionData?.delta || null,
                    marketScanId: scan.id,
                    aiRationale: pick.rationale,
                    aiConfidence: pick.confidence,
                    modelUsed: TraderDB.getConfig('deepseek_model') || 'deepseek-r1:70b',
                    stopLossPrice,
                    profitTargetPrice,
                    maxProfit,
                    maxLoss
                });

                capitalUsed += tradeRisk;
                tradesPlaced++;
                openTickers.add(pick.ticker); // Prevent same ticker from being placed again this run
                sectorCounts[pickSector] = (sectorCounts[pickSector] || 0) + 1; // Track sector for diversification
                log(`✅ Trade placed: ${pick.ticker} [${pickSector}] ${pick.strategy} ${pick.strike} @ $${entryPrice.toFixed(2)} (ID: ${tradeId})`);
                emitTradeUpdate('opened', tradeId);

            } catch (err) {
                logError(`Failed to place trade for ${pick.ticker}`, err);
            }
        }

        log(`📝 Phase 3 complete. ${tradesPlaced} trades placed, $${capitalUsed.toFixed(0)} capital at risk.`);
        emitProgress('phase3', 'complete', `${tradesPlaced} trades placed`);

    } catch (error) {
        logError('Phase 3 failed', error);
        emitProgress('phase3', 'error', error.message);
        throw error;
    }
}

// ────────────────────────────────────────────────────────────
// Phase 4: End-of-Day Review
// ────────────────────────────────────────────────────────────

async function runPhase4_EndOfDay() {
    log('📊 Phase 4: End-of-day review...');
    emitProgress('phase4', 'starting', 'Reviewing positions...');

    try {
        const today = new Date().toISOString().split('T')[0];
        const openTrades = TraderDB.getOpenTrades();

        let closed = 0;
        for (const trade of openTrades) {
            const dte = calculateDTE(trade.expiry);

            // Close expired positions
            if (dte <= 0) {
                // Expired worthless = max profit for short positions
                TraderDB.closeTrade(trade.id, {
                    exitPrice: 0,
                    exitDate: today,
                    exitReason: 'expiry',
                    pnlDollars: trade.entry_price * 100 * trade.contracts,
                    pnlPercent: 100
                });
                log(`📋 Expired worthless: ${trade.ticker} ${trade.strategy} — full profit $${(trade.entry_price * 100 * trade.contracts).toFixed(2)}`);
                emitTradeUpdate('closed', trade.id);
                closed++;
                continue;
            }

            // Check if DTE is at or below manage threshold (safety net — monitor should catch this during market hours)
            const manageDTE = TraderDB.getConfigNum('manage_dte') || 21;
            if (manageDTE > 0 && dte <= manageDTE && dte > 0) {
                try {
                    const currentPrice = await getOptionMidPrice(trade);
                    if (currentPrice !== null) {
                        const pnl = (trade.entry_price - currentPrice) * 100 * trade.contracts;
                        const pnlPct = ((trade.entry_price - currentPrice) / trade.entry_price * 100);
                        const quote = await MarketDataService.getQuote(trade.ticker).catch(() => null);
                        TraderDB.closeTrade(trade.id, {
                            exitPrice: currentPrice,
                            exitDate: today,
                            exitSpot: quote?.price || null,
                            exitReason: 'dte_manage',
                            pnlDollars: pnl,
                            pnlPercent: pnlPct
                        });
                        log(`⏰ EOD DTE Management (${dte}d left): ${trade.ticker} ${trade.strategy} — P&L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
                        emitTradeUpdate('closed', trade.id);
                        closed++;
                    }
                } catch (e) {
                    logError(`Failed EOD DTE manage for ${trade.ticker}`, e);
                }
            }
        }

        // Update daily summary
        const closedToday = TraderDB.getClosedTrades(100).filter(t => t.exit_date === today);
        const wins = closedToday.filter(t => t.pnl_dollars > 0).length;
        const losses = closedToday.filter(t => t.pnl_dollars <= 0).length;
        const totalPnl = closedToday.reduce((s, t) => s + (t.pnl_dollars || 0), 0);

        const openNow = TraderDB.getOpenTrades();
        const equity = TraderDB.getEquityCurve();

        TraderDB.upsertDailySummary({
            date: today,
            tradesOpened: TraderDB.getAllTrades(100).filter(t => t.entry_date === today).length,
            tradesClosed: closedToday.length,
            wins,
            losses,
            totalPnl,
            accountValue: equity.currentValue,
            capitalAtRisk: openNow.reduce((s, t) => s + (t.max_loss || 0), 0)
        });

        log(`📊 Phase 4 complete. Closed: ${closed}, Open: ${openNow.length}`);
        emitProgress('phase4', 'complete', `${closed} positions closed`);

    } catch (error) {
        logError('Phase 4 failed', error);
        emitProgress('phase4', 'error', error.message);
    }
}

// ────────────────────────────────────────────────────────────
// Phase 5: Self-Reflection (AI learns from today)
// ────────────────────────────────────────────────────────────

async function runPhase5_SelfReflect() {
    log('🧠 Phase 5: Self-reflection...');
    emitProgress('phase5', 'starting', 'AI reviewing today\'s performance...');

    try {
        const today = new Date().toISOString().split('T')[0];
        const closedToday = TraderDB.getClosedTrades(100).filter(t => t.exit_date === today);

        // Review each closed trade
        for (const trade of closedToday) {
            const existingReviews = TraderDB.getTradeReviews(trade.id);
            if (existingReviews.length > 0) continue; // Already reviewed

            const scan = trade.market_scan_id ? TraderDB.getLatestMarketScan() : null;
            const reviewPrompt = buildTradeReviewPrompt(trade, scan);
            const model = TraderDB.getConfig('deepseek_model') || 'deepseek-r1:70b';

            try {
                const result = await AIService.callAI(reviewPrompt, model, 3000);
                const parsed = parseTradeReview(result || '');

                TraderDB.insertTradeReview({
                    tradeId: trade.id,
                    reviewText: result || 'Review failed',
                    lessonsLearned: parsed.lesson,
                    whatWorked: parsed.whatWorked,
                    whatFailed: parsed.whatFailed,
                    shouldRepeat: parsed.shouldRepeat,
                    modelUsed: model
                });

                // If a clear lesson emerged, add/update a learned rule
                if (parsed.newRule) {
                    TraderDB.insertLearnedRule({
                        ruleText: parsed.newRule,
                        category: parsed.ruleCategory || 'general',
                        sourceTradeIds: [trade.id],
                        confidence: 0.5
                    });
                    log(`📚 New rule learned: "${parsed.newRule}"`);
                }

                log(`📝 Reviewed: ${trade.ticker} ${trade.strategy} → ${parsed.lesson || 'no lesson'}`);
            } catch (e) {
                logError(`Failed to review trade ${trade.id}`, e);
            }
        }

        // Prune weak rules periodically (every Friday)
        if (new Date().getDay() === 5) {
            TraderDB.pruneWeakRules();
            log('🗑️ Pruned weak learned rules');
        }

        // Daily summary reflection
        const performanceContext = TraderDB.buildPerformanceContext();
        const reflectionPrompt = buildDailyReflectionPrompt(today, performanceContext);
        const model = TraderDB.getConfig('deepseek_model') || 'deepseek-r1:70b';

        try {
            const result = await AIService.callAI(reflectionPrompt, model, 3000);
            TraderDB.upsertDailySummary({
                date: today,
                dailyReflection: result || null,
                ...getDailySummaryFields(today)
            });
            log(`🧠 Daily reflection saved`);
        } catch (e) {
            logError('Daily reflection failed', e);
        }

        log('✅ Phase 5 complete.');
        emitProgress('phase5', 'complete', 'Self-reflection complete');

    } catch (error) {
        logError('Phase 5 failed', error);
        emitProgress('phase5', 'error', error.message);
    }
}

// ────────────────────────────────────────────────────────────
// Real-Time Monitor (runs during market hours)
// ────────────────────────────────────────────────────────────

function startMonitor() {
    stopMonitor();
    const intervalSec = TraderDB.getConfigNum('monitor_interval_sec') || 30;

    monitorInterval = setInterval(async () => {
        if (!isMarketHours()) return;
        await checkPositions();
    }, intervalSec * 1000);

    log(`📡 Real-time monitor started (every ${intervalSec}s during market hours)`);
}

function stopMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
}

/**
 * Called by streamingRoutes when an equity/option quote arrives.
 * This is the real-time feed — no polling needed.
 */
function onStreamingQuote(type, data) {
    if (type === 'equity') {
        priceCache.set(data.symbol, { price: data.last || data.price, timestamp: Date.now() });
    } else if (type === 'option') {
        priceCache.set(data.symbol, { bid: data.bid, ask: data.ask, mid: (data.bid + data.ask) / 2, timestamp: Date.now() });
    }
}

async function checkPositions() {
    const openTrades = TraderDB.getOpenTrades();
    if (!openTrades.length) return;

    lastMonitorCheck = new Date().toISOString();

    // Periodic margin health check (log only, no action — Phase 3 enforces the cap)
    const margin = calculatePortfolioMargin();
    if (margin.marginPct >= margin.maxMarginPct * 0.9) {
        log(`🛡️ MARGIN WARNING: ${margin.marginPct.toFixed(1)}% committed (cap: ${margin.maxMarginPct}%). $${margin.available.toFixed(0)} available.`);
    }

    for (const trade of openTrades) {
        try {
            // Try to get current option price
            const currentPrice = await getOptionMidPrice(trade);
            if (currentPrice === null) continue;

            const entryPrice = trade.entry_price;
            const pnlPerContract = (entryPrice - currentPrice) * 100; // for short positions
            const pnlPercent = ((entryPrice - currentPrice) / entryPrice) * 100;

            // Check stop-loss (2x credit = option price hits 3x entry)
            if (trade.stop_loss_price && currentPrice >= trade.stop_loss_price) {
                const totalPnl = pnlPerContract * trade.contracts;
                log(`🛑 STOP LOSS: ${trade.ticker} ${trade.strategy} @ $${currentPrice.toFixed(2)} (entry: $${entryPrice.toFixed(2)})`);

                const quote = await MarketDataService.getQuote(trade.ticker).catch(() => null);
                TraderDB.closeTrade(trade.id, {
                    exitPrice: currentPrice,
                    exitDate: new Date().toISOString().split('T')[0],
                    exitSpot: quote?.price || null,
                    exitReason: 'stop_loss',
                    pnlDollars: totalPnl,
                    pnlPercent
                });
                emitTradeUpdate('stop_loss', trade.id);
                continue;
            }

            // Check 21 DTE management rule (close before gamma risk spikes)
            const manageDTE = TraderDB.getConfigNum('manage_dte') || 21;
            const currentDTE = calculateDTE(trade.expiry);
            if (manageDTE > 0 && currentDTE <= manageDTE && currentDTE > 0) {
                const totalPnl = pnlPerContract * trade.contracts;
                const quote = await MarketDataService.getQuote(trade.ticker).catch(() => null);
                const reason = pnlPercent >= 0 ? 'Profit' : 'Loss';
                log(`⏰ DTE MANAGEMENT (${currentDTE}d left): Closing ${trade.ticker} ${trade.strategy} @ $${currentPrice.toFixed(2)} — ${reason}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% ($${totalPnl.toFixed(2)})`);

                TraderDB.closeTrade(trade.id, {
                    exitPrice: currentPrice,
                    exitDate: new Date().toISOString().split('T')[0],
                    exitSpot: quote?.price || null,
                    exitReason: 'dte_manage',
                    pnlDollars: totalPnl,
                    pnlPercent
                });
                emitTradeUpdate('dte_manage', trade.id);
                continue;
            }

            // Check profit target (50% of max profit = option price drops to 50% of entry)
            if (trade.profit_target_price && currentPrice <= trade.profit_target_price) {
                const totalPnl = pnlPerContract * trade.contracts;
                log(`💰 PROFIT TARGET: ${trade.ticker} ${trade.strategy} @ $${currentPrice.toFixed(2)} (entry: $${entryPrice.toFixed(2)})`);

                const quote = await MarketDataService.getQuote(trade.ticker).catch(() => null);
                TraderDB.closeTrade(trade.id, {
                    exitPrice: currentPrice,
                    exitDate: new Date().toISOString().split('T')[0],
                    exitSpot: quote?.price || null,
                    exitReason: 'profit_target',
                    pnlDollars: totalPnl,
                    pnlPercent
                });
                emitTradeUpdate('profit_target', trade.id);
                continue;
            }

            // Emit status update to UI
            emitPositionUpdate(trade.id, {
                currentPrice,
                pnlPerContract,
                pnlPercent,
                pnlTotal: pnlPerContract * trade.contracts
            });

        } catch (err) {
            // Don't spam logs — just skip this check
        }
    }
}

// ────────────────────────────────────────────────────────────
// Prompt Builders (specific to autonomous trader)
// ────────────────────────────────────────────────────────────

function buildMarketScanPrompt(spyQuote, vixLevel, trending, active) {
    return `You are the market intelligence module for an autonomous options trading system.
Your job is to scan the current market environment and identify opportunities.

CURRENT MARKET DATA:
- SPY: $${spyQuote?.price || 'N/A'} (${spyQuote?.changePercent || 0}% today)
- VIX: ${vixLevel || 'N/A'}
- Trending tickers (Yahoo): ${trending.slice(0, 20).join(', ') || 'none'}
- Most active (Yahoo): ${active.slice(0, 20).join(', ') || 'none'}

INSTRUCTIONS:
1. Search X/Twitter for current market sentiment — what are traders talking about?
2. Identify 15-20 tickers with HIGH SHORT-TERM OPTIONS POTENTIAL (next 1-10 days)
3. Focus on: earnings reactions, IV crush opportunities, oversold bounces, momentum plays
4. Flag any caution items (upcoming Fed events, major earnings, geopolitical risks)

RESPOND IN THIS EXACT FORMAT:

===MARKET_MOOD===
[bullish|bearish|neutral|mixed]
===END_MOOD===

===TRENDING_TICKERS===
TICKER1, TICKER2, TICKER3, ...
===END_TICKERS===

===SECTOR_MOMENTUM===
Technology: [bullish|bearish|neutral]
Finance: [bullish|bearish|neutral]
Energy: [bullish|bearish|neutral]
Healthcare: [bullish|bearish|neutral]
Consumer: [bullish|bearish|neutral]
===END_SECTORS===

===CAUTION_FLAGS===
- Flag 1
- Flag 2
===END_CAUTIONS===

===NARRATIVE===
[2-3 paragraph summary of market conditions and why you picked these tickers]
===END_NARRATIVE===`;
}

function buildTradeSelectionPrompt(scan, candidateData, performanceContext, config, cautionFlags, portfolioMargin) {
    const allowedStrategies = config.allowed_strategies || ['short_put', 'credit_spread', 'covered_call'];
    const maxDTE = config.max_dte || 45;
    const manageDTE = config.manage_dte || 21;
    const minDTE = Math.max(config.min_dte || 1, manageDTE + 7); // Must be > manage_dte so trades have active time
    const minSpreadWidth = config.min_spread_width || 5;
    const paperBalance = config.paper_balance || 100000;
    const maxPositions = config.max_positions || 5;

    return `You are DeepSeek R1, the analysis engine for an autonomous options trading system.
You must select exactly 5 trades from the candidate pool below.

${performanceContext}

TODAY'S MARKET CONTEXT:
- Market Mood: ${scan.market_mood || 'unknown'}
- VIX: ${scan.vix_level || 'N/A'}
- SPY: $${scan.spy_price || 'N/A'} (${scan.spy_change_percent || 0}%)
- Caution Flags: ${cautionFlags.join(', ') || 'none'}
- Grok Narrative: ${(scan.grok_sentiment_raw || '').slice(0, 2000)}

CANDIDATE POOL (with current data):
${formatCandidateData(candidateData)}

CONSTRAINTS:
- Paper account: $${paperBalance.toLocaleString()}
- Max positions: ${maxPositions}
- DTE range: ${minDTE}-${maxDTE} days
- PREFERRED DTE: 30-45 days (optimal theta decay sweet spot — strongly prefer this range)
- Short DTE (< 14 days) should be RARE and only for high-conviction plays
- Allowed strategies: ${allowedStrategies.join(', ')}
- Min spread width: $${minSpreadWidth} (for credit spreads)
- Stop loss: ${config.stop_loss_multiplier || 2}x credit received
- Profit target: ${config.profit_target_pct || 50}% of max profit
- **DTE MANAGEMENT**: Positions are AUTO-CLOSED at ${config.manage_dte || 21} DTE to avoid gamma risk.
  So with a 45 DTE entry, the trade has ~24 active days. Plan strike/premium accordingly.
  Do NOT pick expirations shorter than ${config.manage_dte || 21} DTE — they'd be closed immediately.
- AVOID tickers with earnings within DTE range
- Optimize for CAPITAL EFFICIENCY (max return per dollar of risk)
- **SECTOR DIVERSIFICATION IS MANDATORY**: Pick trades from at LEAST 3 different sectors.
  Maximum 2 trades from the same sector. Spread risk across Tech, Finance, Energy, Consumer, Healthcare, ETF, etc.
  If all 5 picks are from Tech, that is a FAILURE. One bad sector day would trigger all stop-losses.
  Each candidate shows its [Sector] tag — use it.
- **CAPITAL PRESERVATION**: Current portfolio margin is at ${((portfolioMargin?.marginPct) || 0).toFixed(0)}% of the ${((portfolioMargin?.maxMarginPct) || 70)}% cap.
  Available margin: $${((portfolioMargin?.available) || 0).toFixed(0)}. Prefer SMALLER strikes and credit spreads (defined risk) when margin is above 50%.
  NEVER suggest trades that would collectively exceed available margin. Capital preservation > premium chasing.

STRATEGY GUIDE:
- credit_spread: **PREFERRED DEFAULT.** Sell put spread for credit. Defined risk, capped downside.
  Use $${minSpreadWidth}-$10 wide spreads. A $5 spread risks $500 max vs $20,000+ for a naked put.
  In a market crash, spreads save the account. ALWAYS prefer spreads unless IV is exceptionally high.
- short_put: Naked OTM put, 20-30 delta. **ONLY for high-conviction plays** where IV is elevated
  enough that the premium justifies the unlimited downside risk. If you pick a naked put, explain
  WHY the premium is worth the extra risk vs a spread.
- covered_call: Only if we already "own" 100 shares in paper account (check context).

**SPREAD PREFERENCE RULE**: At least 3 of your 5 picks should be credit_spread. Naked puts are
the exception, not the rule. Capital preservation beats premium maximization.

FOR EACH TRADE, consider:
1. Is this consistent with your learned rules?
2. Does the market mood support this direction?
3. Is IV elevated enough to make premium worthwhile?
4. Is the risk/reward favorable?
5. Would a credit spread achieve similar return with far less risk?

RESPOND WITH EXACTLY THIS FORMAT (one block per trade):

===TRADE_1===
TICKER: AAPL
STRATEGY: credit_spread
STRIKE: 180
EXPIRY: 2026-03-20
DTE: 38
CONTRACTS: 1
ESTIMATED_PREMIUM: 1.20
SPREAD_WIDTH: 5
STRIKE_SELL: 180
STRIKE_BUY: 175
CONFIDENCE: 78
SECTOR: Tech
RATIONALE: Oversold bounce at 200-day MA, X sentiment bullish. $5 spread caps risk at $380 vs $18K naked...
===END_TRADE_1===

===TRADE_2===
...

If you cannot find 5 good trades, select fewer. NEVER force a bad trade just to fill slots.
Quality over quantity. Each trade MUST have a clear edge.`;
}

function buildTradeReviewPrompt(trade, scan) {
    const pnlStr = trade.pnl_dollars > 0 ? `+$${trade.pnl_dollars.toFixed(2)}` : `-$${Math.abs(trade.pnl_dollars).toFixed(2)}`;

    return `You are reviewing a completed trade by the autonomous trading system.

TRADE DETAILS:
- Ticker: ${trade.ticker}
- Strategy: ${trade.strategy}
- Strike: $${trade.strike}
- Entry Date: ${trade.entry_date}, Exit Date: ${trade.exit_date}
- Entry Price (premium): $${trade.entry_price?.toFixed(2)}, Exit Price: $${trade.exit_price?.toFixed(2)}
- Spot at Entry: $${trade.entry_spot?.toFixed(2) || 'N/A'}, Spot at Exit: $${trade.exit_spot?.toFixed(2) || 'N/A'}
- P&L: ${pnlStr} (${trade.pnl_percent?.toFixed(1)}%)
- Exit Reason: ${trade.exit_reason}
- AI Rationale at Entry: ${trade.ai_rationale || 'N/A'}
- Confidence at Entry: ${trade.ai_confidence || 'N/A'}%

MARKET CONTEXT AT ENTRY:
${scan ? `Mood: ${scan.market_mood}, VIX: ${scan.vix_level}, SPY: $${scan.spy_price}` : 'Not available'}

ANALYZE THIS TRADE:
1. What went right?
2. What went wrong?
3. Should this type of trade be repeated?
4. What is the ONE key lesson?
5. Should a new RULE be added to prevent mistakes or encourage good patterns?

RESPOND IN THIS FORMAT:

===REVIEW===
WHAT_WORKED: [one sentence]
WHAT_FAILED: [one sentence, or "Nothing" if it was a win]
LESSON: [one clear, actionable sentence]
SHOULD_REPEAT: [YES or NO]
NEW_RULE: [a rule to add, or "NONE" if no new rule needed]
RULE_CATEGORY: [entry|exit|risk|sector|timing]
FULL_REVIEW: [2-3 paragraph detailed analysis]
===END_REVIEW===`;
}

function buildDailyReflectionPrompt(today, performanceContext) {
    const openTrades = TraderDB.getOpenTrades();
    const closedToday = TraderDB.getClosedTrades(100).filter(t => t.exit_date === today);

    return `End-of-day reflection for the autonomous trading system.

DATE: ${today}

${performanceContext}

TODAY'S ACTIVITY:
- Trades opened today: ${TraderDB.getAllTrades(100).filter(t => t.entry_date === today).length}
- Trades closed today: ${closedToday.length}
- Today's P&L: $${closedToday.reduce((s, t) => s + (t.pnl_dollars || 0), 0).toFixed(2)}
- Open positions: ${openTrades.length}

${closedToday.length ? 'CLOSED TODAY:\n' + closedToday.map(t => 
    `- ${t.ticker} ${t.strategy} ${t.strike}: ${t.pnl_dollars > 0 ? '+' : ''}$${t.pnl_dollars?.toFixed(2)} (${t.exit_reason})`
).join('\n') : 'No trades closed today.'}

${openTrades.length ? 'STILL OPEN:\n' + openTrades.map(t => 
    `- ${t.ticker} ${t.strategy} ${t.strike} (${calculateDTE(t.expiry)} DTE)`
).join('\n') : 'No open positions.'}

Write a brief (3-5 sentence) daily reflection. Focus on:
1. What patterns are emerging?
2. Any adjustments needed for tomorrow?
3. Overall health of the paper account.`;
}

// ────────────────────────────────────────────────────────────
// Parsing Helpers
// ────────────────────────────────────────────────────────────

function parseGrokSentiment(content) {
    const result = { mood: 'neutral', tickers: [], sectors: {}, cautions: [] };

    // Parse mood
    const moodMatch = content.match(/===MARKET_MOOD===\s*([\s\S]*?)===END_MOOD===/);
    if (moodMatch) result.mood = moodMatch[1].trim().toLowerCase();

    // Parse tickers
    const tickerMatch = content.match(/===TRENDING_TICKERS===\s*([\s\S]*?)===END_TICKERS===/);
    if (tickerMatch) {
        result.tickers = tickerMatch[1].trim().split(/[,\n]/).map(t => t.trim().toUpperCase()).filter(t => t && t.length <= 5);
    }

    // Parse sectors
    const sectorMatch = content.match(/===SECTOR_MOMENTUM===\s*([\s\S]*?)===END_SECTORS===/);
    if (sectorMatch) {
        for (const line of sectorMatch[1].split('\n')) {
            const m = line.match(/(\w+):\s*(bullish|bearish|neutral)/i);
            if (m) result.sectors[m[1]] = m[2].toLowerCase();
        }
    }

    // Parse cautions
    const cautionMatch = content.match(/===CAUTION_FLAGS===\s*([\s\S]*?)===END_CAUTIONS===/);
    if (cautionMatch) {
        result.cautions = cautionMatch[1].split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);
    }

    return result;
}

function parseTradePicksFromAI(content) {
    const picks = [];
    
    // Try strict format: ===TRADE_1=== ... ===END_TRADE_1===
    let tradeRegex = /={3,}\s*TRADE[_\s]*(\d+)\s*={3,}\s*([\s\S]*?)={3,}\s*END[_\s]*TRADE[_\s]*\1\s*={3,}/gi;
    let match;

    while ((match = tradeRegex.exec(content)) !== null) {
        const pick = parseTradeBlock(match[2]);
        if (pick) picks.push(pick);
    }

    // Second try: ===TRADE_1=== blocks separated by next ===TRADE_N=== (no END delimiter)
    if (picks.length === 0) {
        const splitRegex = /={3,}\s*TRADE[_\s]*\d+\s*={3,}/gi;
        const blocks = content.split(splitRegex).filter(b => b.includes('TICKER:'));
        for (const block of blocks) {
            const pick = parseTradeBlock(block);
            if (pick) picks.push(pick);
        }
    }

    // Last resort: find TICKER:/STRATEGY: pairs without any delimiters
    if (picks.length === 0 && content.includes('TICKER:') && content.includes('STRATEGY:')) {
        log('🔄 No delimiters found, trying field-based parser...');
        const tickerBlocks = content.split(/(?=TICKER:\s*[A-Z])/i).filter(b => b.includes('TICKER:'));
        for (const block of tickerBlocks) {
            const pick = parseTradeBlock(block);
            if (pick) picks.push(pick);
        }
    }

    return picks;
}

function parseTradeBlock(block) {
    const pick = {};
    const fields = {
        'TICKER': 'ticker', 'STRATEGY': 'strategy', 'STRIKE': 'strike',
        'EXPIRY': 'expiry', 'DTE': 'dte', 'CONTRACTS': 'contracts',
        'ESTIMATED_PREMIUM': 'estimatedPremium', 'SPREAD_WIDTH': 'spreadWidth',
        'STRIKE_SELL': 'strikeSell', 'STRIKE_BUY': 'strikeBuy',
        'CONFIDENCE': 'confidence', 'SECTOR': 'sector', 'RATIONALE': 'rationale'
    };

    for (const [key, prop] of Object.entries(fields)) {
        const fieldMatch = block.match(new RegExp(`${key}:\\s*(.+)`, 'i'));
        if (fieldMatch) {
            let val = fieldMatch[1].trim();
            // Strip leading $ or % signs from numeric values
            val = val.replace(/^\$/, '');
            const numericFields = ['strike', 'dte', 'contracts', 'estimatedPremium', 'spreadWidth', 'strikeSell', 'strikeBuy', 'confidence'];
            pick[prop] = numericFields.includes(prop) ? parseFloat(val) || 0 : val;
        }
    }

    return (pick.ticker && pick.strategy) ? pick : null;
}

function parseTradeReview(content) {
    const result = { lesson: null, whatWorked: null, whatFailed: null, shouldRepeat: false, newRule: null, ruleCategory: null };

    const reviewMatch = content.match(/===REVIEW===\s*([\s\S]*?)===END_REVIEW===/);
    const block = reviewMatch ? reviewMatch[1] : content;

    const extract = (key) => {
        const m = block.match(new RegExp(`${key}:\\s*(.+)`, 'i'));
        return m ? m[1].trim() : null;
    };

    result.whatWorked = extract('WHAT_WORKED');
    result.whatFailed = extract('WHAT_FAILED');
    result.lesson = extract('LESSON');
    result.shouldRepeat = (extract('SHOULD_REPEAT') || '').toLowerCase() === 'yes';
    const newRule = extract('NEW_RULE');
    result.newRule = (newRule && newRule.toLowerCase() !== 'none') ? newRule : null;
    result.ruleCategory = extract('RULE_CATEGORY') || 'general';

    return result;
}

// ────────────────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────────────────

// Sector lookup map — built lazily from curated candidates for quick ticker→sector mapping
let SECTOR_MAP = null;

function ensureSectorMap() {
    if (SECTOR_MAP) return;
    SECTOR_MAP = {};
    (DiscoveryService?.CURATED_CANDIDATES || []).forEach(c => {
        if (c.ticker && c.sector) SECTOR_MAP[c.ticker] = c.sector;
    });
}

/**
 * Get sector for a ticker. Returns curated sector or 'Unknown'.
 */
function getSector(ticker) {
    ensureSectorMap();
    return SECTOR_MAP[ticker] || 'Unknown';
}

function buildCandidatePool(trendingTickers) {
    // Merge: Grok-recommended + curated wheel stocks + trending
    const curated = (DiscoveryService.CURATED_CANDIDATES || []).map(c => c.ticker || c);
    const all = [...new Set([...trendingTickers, ...curated])];
    // Shuffle and limit to 40 candidates
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, 40);
}

async function fetchCandidateData(tickers) {
    const results = [];
    // Fetch in batches of 5 to avoid hammering APIs
    for (let i = 0; i < tickers.length; i += 5) {
        const batch = tickers.slice(i, i + 5);
        const promises = batch.map(async (ticker) => {
            try {
                const quote = await MarketDataService.getQuote(ticker);
                return {
                    ticker,
                    price: quote?.price || null,
                    change: quote?.changePercent || null,
                    rangePosition: quote?.rangePosition || null,
                    high52: quote?.high52 || null,
                    low52: quote?.low52 || null,
                    source: quote?.source || 'unknown'
                };
            } catch {
                return { ticker, price: null, error: true };
            }
        });
        const batchResults = await Promise.all(promises);
        results.push(...batchResults.filter(r => r.price));
    }
    return results;
}

function formatCandidateData(candidates) {
    if (!candidates.length) return 'No candidate data available';
    return candidates.map(c => {
        const sector = getSector(c.ticker);
        return `${c.ticker} [${sector}]: $${c.price?.toFixed(2)} (${c.change > 0 ? '+' : ''}${c.change?.toFixed(1)}%) Range: ${c.rangePosition?.toFixed(0)}%`;
    }).join('\n');
}

function validateTrade(pick, quote, config) {
    // Credit spreads use strikeSell/strikeBuy instead of strike
    const effectiveStrike = pick.strike || pick.strikeSell;
    if (!pick.ticker || !pick.strategy || !effectiveStrike) {
        return { valid: false, reason: `Missing required fields (ticker=${pick.ticker}, strategy=${pick.strategy}, strike=${effectiveStrike})` };
    }
    // Normalize: set strike from strikeSell if missing
    if (!pick.strike && pick.strikeSell) pick.strike = pick.strikeSell;
    
    if (!config.allowed_strategies?.includes(pick.strategy)) {
        return { valid: false, reason: `Strategy ${pick.strategy} not allowed` };
    }
    const dte = calculateDTE(pick.expiry);
    if (dte < (config.min_dte || 1) || dte > (config.max_dte || 45)) {
        return { valid: false, reason: `DTE ${dte} out of range` };
    }
    if (pick.strategy === 'credit_spread' && (pick.spreadWidth || 0) < (config.min_spread_width || 5)) {
        return { valid: false, reason: `Spread width $${pick.spreadWidth} below minimum $${config.min_spread_width}` };
    }
    return { valid: true };
}

function calculateTradeRisk(pick, entryPrice, config) {
    if (pick.strategy === 'short_put') {
        // Naked put: risk = (strike - premium) * 100 * contracts (margin requirement ~20%)
        return (pick.strike * 0.20) * 100 * (pick.contracts || 1);
    } else if (pick.strategy === 'credit_spread') {
        // Spread: max loss = (width - premium) * 100 * contracts
        return ((pick.spreadWidth || 5) - entryPrice) * 100 * (pick.contracts || 1);
    } else if (pick.strategy === 'covered_call') {
        // Covered call: need to "own" 100 shares
        return pick.strike * 100 * (pick.contracts || 1);
    }
    return 5000; // fallback
}

/**
 * Calculate total margin committed across all open trades.
 * Returns { totalMargin, marginPct, paperBalance, available, maxMarginPct }
 */
function calculatePortfolioMargin() {
    const openTrades = TraderDB.getOpenTrades();
    const paperBalance = TraderDB.getConfigNum('paper_balance') || 100000;
    const maxMarginPct = TraderDB.getConfigNum('max_margin_pct') || 70;

    let totalMargin = 0;
    for (const trade of openTrades) {
        if (trade.strategy === 'short_put') {
            totalMargin += (trade.strike * 0.20) * 100 * (trade.contracts || 1);
        } else if (trade.strategy === 'credit_spread') {
            totalMargin += ((trade.spread_width || 5) - (trade.entry_price || 0)) * 100 * (trade.contracts || 1);
        } else if (trade.strategy === 'covered_call') {
            totalMargin += trade.strike * 100 * (trade.contracts || 1);
        } else {
            totalMargin += 5000; // fallback
        }
    }

    const marginPct = (totalMargin / paperBalance) * 100;
    const maxAllowed = paperBalance * (maxMarginPct / 100);
    const available = Math.max(0, maxAllowed - totalMargin);

    return { totalMargin, marginPct, paperBalance, available, maxMarginPct, maxAllowed, openCount: openTrades.length };
}

function calculateDTE(expiry) {
    if (!expiry) return 0;
    const exp = new Date(expiry + 'T16:00:00-05:00'); // ET close
    const now = new Date();
    return Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)));
}

async function getOptionMidPrice(trade) {
    try {
        const optType = trade.strategy === 'covered_call' ? 'C' : 'P';
        const data = await MarketDataService.getOptionPremium(
            trade.ticker, trade.strike, trade.expiry, optType
        );
        return data ? (data.bid + data.ask) / 2 : null;
    } catch {
        return null;
    }
}

function isMarketHours() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false; // Weekend
    const hours = et.getHours();
    const minutes = et.getMinutes();
    const time = hours * 60 + minutes;
    return time >= 570 && time <= 960; // 9:30 AM - 4:00 PM ET
}

function scanToInsertObj(scan) {
    return {
        scanDate: scan.scan_date,
        grokSentimentRaw: scan.grok_sentiment_raw,
        marketMood: scan.market_mood,
        trendingTickers: safeParseJSON(scan.trending_tickers, []),
        sectorMomentum: safeParseJSON(scan.sector_momentum, {}),
        cautionFlags: safeParseJSON(scan.caution_flags, []),
        vixLevel: scan.vix_level,
        spyPrice: scan.spy_price,
        spyChangePercent: scan.spy_change_percent,
        candidatesRaw: safeParseJSON(scan.candidates_raw, []),
        picksRaw: safeParseJSON(scan.picks_raw, []),
        grokModel: scan.grok_model,
        deepseekModel: scan.deepseek_model
    };
}

function getDailySummaryFields(today) {
    const closedToday = TraderDB.getClosedTrades(100).filter(t => t.exit_date === today);
    return {
        tradesOpened: TraderDB.getAllTrades(100).filter(t => t.entry_date === today).length,
        tradesClosed: closedToday.length,
        wins: closedToday.filter(t => t.pnl_dollars > 0).length,
        losses: closedToday.filter(t => t.pnl_dollars <= 0).length,
        totalPnl: closedToday.reduce((s, t) => s + (t.pnl_dollars || 0), 0)
    };
}

function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

// ────────────────────────────────────────────────────────────
// Socket.IO + Logging
// ────────────────────────────────────────────────────────────

function log(message) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[AutoTrader ${ts}] ${message}`);
    emitLog(message);
}

function logError(context, error) {
    console.error(`[AutoTrader] ❌ ${context}:`, error.message || error);
    emitLog(`❌ ${context}: ${error.message || error}`);
}

function emitStatus() {
    if (!socketIO) return;
    const openTrades = TraderDB.isReady() ? TraderDB.getOpenTrades() : [];
    const equity = TraderDB.isReady() ? TraderDB.getEquityCurve() : { currentValue: 100000, startingBalance: 100000 };
    socketIO.emit('autonomous-status', {
        enabled: isEnabled,
        running: isRunning,
        openPositions: openTrades.length,
        currentValue: equity.currentValue,
        startingBalance: equity.startingBalance,
        totalPnl: equity.currentValue - equity.startingBalance,
        lastMonitorCheck
    });
}

function emitProgress(phase, status, message) {
    if (socketIO) socketIO.emit('autonomous-progress', { phase, status, message, timestamp: Date.now() });
}

function emitTradeUpdate(action, tradeId) {
    if (socketIO) socketIO.emit('autonomous-trade', { action, tradeId, trade: TraderDB.getTrade(tradeId) });
}

function emitPositionUpdate(tradeId, data) {
    if (socketIO) socketIO.emit('autonomous-position-update', { tradeId, ...data });
}

function emitLog(message) {
    if (socketIO) socketIO.emit('autonomous-log', { message, timestamp: Date.now() });
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

function getStatus() {
    const openTrades = TraderDB.isReady() ? TraderDB.getOpenTrades() : [];
    const equity = TraderDB.isReady() ? TraderDB.getEquityCurve() : { currentValue: 100000, startingBalance: 100000 };
    const metrics = TraderDB.isReady() ? TraderDB.getPerformanceMetrics(30) : {};
    const margin = TraderDB.isReady() ? calculatePortfolioMargin() : { totalMargin: 0, marginPct: 0, maxMarginPct: 70, available: 100000 };

    return {
        enabled: isEnabled,
        running: isRunning,
        openPositions: openTrades.length,
        openTrades,
        currentValue: equity.currentValue,
        startingBalance: equity.startingBalance,
        totalPnl: Math.round((equity.currentValue - equity.startingBalance) * 100) / 100,
        equityCurve: equity.curve,
        metrics,
        margin: {
            totalCommitted: Math.round(margin.totalMargin),
            maxAllowed: Math.round(margin.maxAllowed),
            available: Math.round(margin.available),
            utilizationPct: Math.round(margin.marginPct * 10) / 10,
            capPct: margin.maxMarginPct
        },
        learnedRules: TraderDB.isReady() ? TraderDB.getActiveRules() : [],
        config: TraderDB.isReady() ? TraderDB.getAllConfig() : {},
        lastMonitorCheck,
        isMarketHours: isMarketHours()
    };
}

// Manual trigger for any phase (from the UI)
async function runPhase(phaseNumber) {
    switch (phaseNumber) {
        case 1: return runPhase1_GatherIntel();
        case 2: return runPhase2_AnalyzeAndPick();
        case 3: return runPhase3_Execute();
        case 4: return runPhase4_EndOfDay();
        case 5: return runPhase5_SelfReflect();
        default: throw new Error(`Unknown phase: ${phaseNumber}`);
    }
}

// Manual trade close
async function manualClose(tradeId, reason = 'manual') {
    const trade = TraderDB.getTrade(tradeId);
    if (!trade || trade.status !== 'open') throw new Error('Trade not found or already closed');

    const currentPrice = await getOptionMidPrice(trade);
    const quote = await MarketDataService.getQuote(trade.ticker).catch(() => null);

    const pnlPerContract = (trade.entry_price - (currentPrice || 0)) * 100;
    const pnlPercent = currentPrice ? ((trade.entry_price - currentPrice) / trade.entry_price * 100) : 0;

    TraderDB.closeTrade(tradeId, {
        exitPrice: currentPrice || 0,
        exitDate: new Date().toISOString().split('T')[0],
        exitSpot: quote?.price || null,
        exitReason: reason,
        pnlDollars: pnlPerContract * trade.contracts,
        pnlPercent
    });

    log(`📋 Manual close: ${trade.ticker} ${trade.strategy} — P&L: $${(pnlPerContract * trade.contracts).toFixed(2)}`);
    emitTradeUpdate('manual_close', tradeId);
    return TraderDB.getTrade(tradeId);
}

module.exports = {
    init,
    enable, disable,
    startScheduler, stopScheduler,
    getStatus,
    runPhase,
    manualClose,
    onStreamingQuote,
    calculatePortfolioMargin,
    // Expose for testing
    runPhase1_GatherIntel,
    runPhase2_AnalyzeAndPick,
    runPhase3_Execute,
    runPhase4_EndOfDay,
    runPhase5_SelfReflect
};
