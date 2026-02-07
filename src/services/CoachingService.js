/**
 * CoachingService.js - Trading Pattern Analysis & Coaching
 * 
 * Analyzes closed trade history to extract patterns, track win rates by
 * ticker/strategy, and generate coaching insights that feed into all AI prompts.
 * 
 * Think of it as a personal trading coach that remembers every trade you've made
 * and spots patterns you might miss.
 * 
 * @module CoachingService
 */

const fs = require('fs');
const path = require('path');

// Persistent coaching file
const COACHING_FILE = path.join(__dirname, '../../data/coaching.json');

// Cache computed patterns (refresh when positions change)
let patternCache = null;
let lastPositionHash = null;

/**
 * Compute a simple hash of positions to detect changes
 */
function hashPositions(positions) {
    if (!positions || positions.length === 0) return 'empty';
    return `${positions.length}_${positions[positions.length - 1]?.id || 0}`;
}

/**
 * Analyze all closed positions and extract patterns
 * This is the core computation - everything else builds on this
 * 
 * @param {Array} closedPositions - All closed positions from the user's history
 * @returns {Object} Complete pattern analysis
 */
function analyzePatterns(closedPositions) {
    if (!closedPositions || closedPositions.length === 0) {
        return { 
            generated: new Date().toISOString(),
            totalTrades: 0,
            overallStats: null,
            byTicker: {},
            byStrategy: {},
            byTickerStrategy: {},
            behavioral: null,
            sweetSpots: [],
            dangerZones: [],
            streaks: null
        };
    }

    const hash = hashPositions(closedPositions);
    if (patternCache && lastPositionHash === hash) {
        return patternCache;
    }

    // ── Overall Stats ──
    const overallStats = computeGroupStats(closedPositions, 'Overall');

    // ── Per-Ticker Stats ──
    const byTicker = {};
    const tickerGroups = groupBy(closedPositions, p => (p.ticker || 'Unknown').toUpperCase());
    for (const [ticker, positions] of Object.entries(tickerGroups)) {
        if (positions.length >= 1) {
            byTicker[ticker] = computeGroupStats(positions, ticker);
        }
    }

    // ── Per-Strategy Stats ──
    const byStrategy = {};
    const strategyGroups = groupBy(closedPositions, p => normalizeType(p.type));
    for (const [strategy, positions] of Object.entries(strategyGroups)) {
        if (positions.length >= 1) {
            byStrategy[strategy] = computeGroupStats(positions, strategy);
        }
    }

    // ── Per-Ticker+Strategy Combo Stats ──
    const byTickerStrategy = {};
    const comboGroups = groupBy(closedPositions, p => 
        `${(p.ticker || 'Unknown').toUpperCase()}_${normalizeType(p.type)}`
    );
    for (const [combo, positions] of Object.entries(comboGroups)) {
        if (positions.length >= 2) { // Only track combos with 2+ trades
            byTickerStrategy[combo] = computeGroupStats(positions, combo);
        }
    }

    // ── Behavioral Patterns ──
    const behavioral = computeBehavioralPatterns(closedPositions);

    // ── Sweet Spots (high win rate combos) ──
    const sweetSpots = [];
    for (const [combo, stats] of Object.entries(byTickerStrategy)) {
        if (stats.count >= 3 && stats.winRate >= 70) {
            sweetSpots.push({ combo, ...stats });
        }
    }
    // Also check pure ticker stats
    for (const [ticker, stats] of Object.entries(byTicker)) {
        if (stats.count >= 4 && stats.winRate >= 75) {
            sweetSpots.push({ combo: ticker, ...stats, type: 'ticker' });
        }
    }
    sweetSpots.sort((a, b) => b.winRate - a.winRate);

    // ── Danger Zones (low win rate combos) ──
    const dangerZones = [];
    for (const [combo, stats] of Object.entries(byTickerStrategy)) {
        if (stats.count >= 3 && stats.winRate < 40) {
            dangerZones.push({ combo, ...stats });
        }
    }
    for (const [ticker, stats] of Object.entries(byTicker)) {
        if (stats.count >= 3 && stats.winRate < 35) {
            dangerZones.push({ combo: ticker, ...stats, type: 'ticker' });
        }
    }
    dangerZones.sort((a, b) => a.winRate - b.winRate);

    // ── Current Streaks ──
    const streaks = computeStreaks(closedPositions);

    const result = {
        generated: new Date().toISOString(),
        totalTrades: closedPositions.length,
        overallStats,
        byTicker,
        byStrategy,
        byTickerStrategy,
        behavioral,
        sweetSpots: sweetSpots.slice(0, 10),
        dangerZones: dangerZones.slice(0, 10),
        streaks
    };

    // Cache
    patternCache = result;
    lastPositionHash = hash;

    return result;
}

/**
 * Compute stats for a group of positions
 */
function computeGroupStats(positions, label) {
    const wins = positions.filter(p => getPnL(p) >= 0);
    const losses = positions.filter(p => getPnL(p) < 0);
    const totalPnL = positions.reduce((sum, p) => sum + getPnL(p), 0);
    const avgPnL = totalPnL / positions.length;
    const avgWin = wins.length > 0 
        ? wins.reduce((sum, p) => sum + getPnL(p), 0) / wins.length 
        : 0;
    const avgLoss = losses.length > 0 
        ? losses.reduce((sum, p) => sum + getPnL(p), 0) / losses.length 
        : 0;
    const profitFactor = avgLoss !== 0 
        ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)) 
        : wins.length > 0 ? Infinity : 0;
    
    // Avg hold time
    const holdTimes = positions
        .filter(p => p.openDate && p.closeDate)
        .map(p => Math.round((new Date(p.closeDate) - new Date(p.openDate)) / (1000 * 60 * 60 * 24)));
    const avgHoldDays = holdTimes.length > 0 
        ? Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length)
        : null;

    // Rolls
    const rolled = positions.filter(p => p.closeReason === 'rolled');
    const rollRate = positions.length > 0 
        ? Math.round(rolled.length / positions.length * 100) 
        : 0;

    // Best and worst
    const sorted = [...positions].sort((a, b) => getPnL(b) - getPnL(a));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    // Recent trend (last 5 trades)
    const recent = positions.slice(-5);
    const recentWins = recent.filter(p => getPnL(p) >= 0).length;
    const recentTrend = recent.length >= 3 
        ? (recentWins / recent.length >= 0.6 ? 'improving' : 
           recentWins / recent.length <= 0.4 ? 'declining' : 'steady')
        : null;

    return {
        label,
        count: positions.length,
        wins: wins.length,
        losses: losses.length,
        winRate: Math.round(wins.length / positions.length * 100),
        totalPnL: Math.round(totalPnL),
        avgPnL: Math.round(avgPnL),
        avgWin: Math.round(avgWin),
        avgLoss: Math.round(avgLoss),
        profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
        avgHoldDays,
        rollRate,
        recentTrend,
        bestTrade: best ? { ticker: best.ticker, pnl: Math.round(getPnL(best)), strike: best.strike } : null,
        worstTrade: worst ? { ticker: worst.ticker, pnl: Math.round(getPnL(worst)), strike: worst.strike } : null
    };
}

/**
 * Compute behavioral patterns across all trades
 */
function computeBehavioralPatterns(positions) {
    // Assignment rate
    const assigned = positions.filter(p => p.closeReason === 'assigned' || p.closeReason === 'called');
    const assignmentRate = Math.round(assigned.length / positions.length * 100);

    // Early close rate (closed before 7 DTE remaining)
    const earlyClosed = positions.filter(p => {
        if (p.closeReason !== 'closed') return false;
        const dteAtClose = p.expiry && p.closeDate 
            ? Math.ceil((new Date(p.expiry) - new Date(p.closeDate)) / (1000 * 60 * 60 * 24))
            : null;
        return dteAtClose !== null && dteAtClose > 7;
    });
    const earlyCloseRate = Math.round(earlyClosed.length / positions.length * 100);

    // Win rate by position size
    const small = positions.filter(p => (p.contracts || 1) <= 2);
    const large = positions.filter(p => (p.contracts || 1) >= 5);
    const smallWinRate = small.length >= 3 
        ? Math.round(small.filter(p => getPnL(p) >= 0).length / small.length * 100) 
        : null;
    const largeWinRate = large.length >= 3 
        ? Math.round(large.filter(p => getPnL(p) >= 0).length / large.length * 100)
        : null;

    // Win rate by month (seasonality)
    const byMonth = {};
    for (const p of positions) {
        if (!p.openDate) continue;
        const month = new Date(p.openDate).getMonth(); // 0-11
        const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month];
        if (!byMonth[monthName]) byMonth[monthName] = { wins: 0, total: 0 };
        byMonth[monthName].total++;
        if (getPnL(p) >= 0) byMonth[monthName].wins++;
    }
    const seasonality = {};
    for (const [month, data] of Object.entries(byMonth)) {
        if (data.total >= 3) {
            seasonality[month] = { winRate: Math.round(data.wins / data.total * 100), count: data.total };
        }
    }

    return {
        assignmentRate,
        earlyCloseRate,
        smallPositionWinRate: smallWinRate,
        largePositionWinRate: largeWinRate,
        sizeEdge: smallWinRate && largeWinRate 
            ? (smallWinRate > largeWinRate + 10 ? 'Smaller positions perform better' :
               largeWinRate > smallWinRate + 10 ? 'Larger positions perform better' : 'No significant size edge')
            : null,
        seasonality: Object.keys(seasonality).length > 0 ? seasonality : null
    };
}

/**
 * Compute win/loss streaks
 */
function computeStreaks(positions) {
    if (positions.length < 2) return null;

    // Sort by close date
    const sorted = [...positions]
        .filter(p => p.closeDate)
        .sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));

    let currentStreak = 0;
    let currentStreakType = null;
    let maxWinStreak = 0;
    let maxLossStreak = 0;

    for (const p of sorted) {
        const isWin = getPnL(p) >= 0;
        if (isWin) {
            if (currentStreakType === 'win') {
                currentStreak++;
            } else {
                currentStreak = 1;
                currentStreakType = 'win';
            }
            maxWinStreak = Math.max(maxWinStreak, currentStreak);
        } else {
            if (currentStreakType === 'loss') {
                currentStreak++;
            } else {
                currentStreak = 1;
                currentStreakType = 'loss';
            }
            maxLossStreak = Math.max(maxLossStreak, currentStreak);
        }
    }

    return {
        current: { type: currentStreakType, length: currentStreak },
        maxWinStreak,
        maxLossStreak
    };
}

/**
 * Build a coaching context string for AI prompts
 * This is the key function - it generates the text that gets injected into prompts
 * 
 * @param {Array} closedPositions - All closed positions
 * @param {string} ticker - Current ticker being evaluated
 * @param {string} positionType - Current position type being considered
 * @returns {string} Formatted coaching context for AI prompt injection
 */
function buildCoachingContext(closedPositions, ticker, positionType) {
    const patterns = analyzePatterns(closedPositions);
    if (patterns.totalTrades < 3) return ''; // Not enough history to coach

    const tickerUpper = (ticker || '').toUpperCase();
    const typeNorm = normalizeType(positionType);
    const comboKey = `${tickerUpper}_${typeNorm}`;

    let context = `\n═══ TRADING COACH (based on ${patterns.totalTrades} closed trades) ═══\n`;

    // Overall record
    const o = patterns.overallStats;
    context += `Overall: ${o.winRate}% win rate (${o.wins}W/${o.losses}L) | Avg P&L: $${o.avgPnL} | Profit Factor: ${o.profitFactor}\n`;

    // Current streak
    if (patterns.streaks?.current) {
        const s = patterns.streaks.current;
        if (s.length >= 3) {
            context += s.type === 'win' 
                ? `🔥 On a ${s.length}-trade WIN streak\n`
                : `⚠️ On a ${s.length}-trade LOSS streak — exercise extra caution\n`;
        }
    }

    // Ticker-specific record
    const tickerStats = patterns.byTicker[tickerUpper];
    if (tickerStats && tickerStats.count >= 2) {
        const emoji = tickerStats.winRate >= 60 ? '✅' : tickerStats.winRate <= 40 ? '🚨' : '📊';
        context += `\n${emoji} ${tickerUpper} record: ${tickerStats.winRate}% win rate (${tickerStats.wins}W/${tickerStats.losses}L from ${tickerStats.count} trades) | Net: $${tickerStats.totalPnL}\n`;
        if (tickerStats.recentTrend) {
            context += `   Recent trend: ${tickerStats.recentTrend}\n`;
        }
    }

    // Combo-specific record (ticker + strategy)
    const comboStats = patterns.byTickerStrategy[comboKey];
    if (comboStats && comboStats.count >= 2) {
        const emoji = comboStats.winRate >= 60 ? '✅' : comboStats.winRate <= 40 ? '🚨' : '📊';
        context += `${emoji} ${tickerUpper} ${typeNorm.replace(/_/g, ' ')}: ${comboStats.winRate}% win rate (${comboStats.count} trades) | Avg: $${comboStats.avgPnL}\n`;
        if (comboStats.avgHoldDays) {
            context += `   Avg hold: ${comboStats.avgHoldDays} days | Roll rate: ${comboStats.rollRate}%\n`;
        }
    }

    // Strategy-specific record
    const stratStats = patterns.byStrategy[typeNorm];
    if (stratStats && stratStats.count >= 3) {
        context += `📋 ${typeNorm.replace(/_/g, ' ')} overall: ${stratStats.winRate}% win rate (${stratStats.count} trades) | Profit Factor: ${stratStats.profitFactor}\n`;
    }

    // Danger zone warnings
    const isDangerTicker = patterns.dangerZones.find(d => d.combo === tickerUpper || d.combo === comboKey);
    if (isDangerTicker) {
        context += `\n🚨 DANGER ZONE: ${isDangerTicker.combo.replace(/_/g, ' ')} has a ${isDangerTicker.winRate}% win rate over ${isDangerTicker.count} trades ($${isDangerTicker.totalPnL} net). Consider AVOIDING this trade or sizing down significantly.\n`;
    }

    // Sweet spot encouragement
    const isSweetSpot = patterns.sweetSpots.find(s => s.combo === tickerUpper || s.combo === comboKey);
    if (isSweetSpot) {
        context += `\n✅ SWEET SPOT: ${isSweetSpot.combo.replace(/_/g, ' ')} has a ${isSweetSpot.winRate}% win rate over ${isSweetSpot.count} trades ($${isSweetSpot.totalPnL} net). This is a proven winner — consider normal or slightly larger sizing.\n`;
    }

    // Behavioral warnings
    const beh = patterns.behavioral;
    if (beh) {
        if (beh.sizeEdge && beh.sizeEdge !== 'No significant size edge') {
            context += `📐 Size insight: ${beh.sizeEdge}\n`;
        }
        if (beh.assignmentRate > 20) {
            context += `⚠️ High assignment rate (${beh.assignmentRate}%) — strikes may be too aggressive\n`;
        }
    }

    context += `═══════════════════════════════════════════════════\n`;
    
    // Coaching instruction for AI
    context += `\nINSTRUCTIONS FOR AI: Factor the above track record into your recommendation.\n`;
    context += `- If this is a DANGER ZONE trade, raise the bar — only recommend STAGE if the setup is exceptional.\n`;
    context += `- If this is a SWEET SPOT, note the positive history but don't ignore current conditions.\n`;
    context += `- If there's a loss streak, recommend more conservative sizing.\n`;
    context += `- CITE specific record stats when they influence your recommendation.\n\n`;

    return context;
}

/**
 * Get coaching data for API response (frontend display)
 */
function getCoachingReport(closedPositions) {
    return analyzePatterns(closedPositions);
}

/**
 * Get advice for a specific ticker/strategy combo
 */
function getAdvice(closedPositions, ticker, positionType) {
    const patterns = analyzePatterns(closedPositions);
    const tickerUpper = (ticker || '').toUpperCase();
    const typeNorm = normalizeType(positionType);
    const comboKey = `${tickerUpper}_${typeNorm}`;

    return {
        ticker: tickerUpper,
        strategy: typeNorm,
        tickerStats: patterns.byTicker[tickerUpper] || null,
        comboStats: patterns.byTickerStrategy[comboKey] || null,
        strategyStats: patterns.byStrategy[typeNorm] || null,
        isDangerZone: patterns.dangerZones.some(d => d.combo === tickerUpper || d.combo === comboKey),
        isSweetSpot: patterns.sweetSpots.some(s => s.combo === tickerUpper || s.combo === comboKey),
        overallStats: patterns.overallStats,
        streaks: patterns.streaks
    };
}

/**
 * Save AI-generated coaching insight (from critique or manual entry)
 */
function saveCoachingInsight(insight) {
    let coaching = loadCoachingFile();
    if (!coaching.insights) coaching.insights = [];
    
    coaching.insights.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        ...insight
    });

    // Keep last 100 insights
    if (coaching.insights.length > 100) {
        coaching.insights = coaching.insights.slice(-100);
    }

    saveCoachingFile(coaching);
    return coaching.insights[coaching.insights.length - 1];
}

/**
 * Get stored coaching insights
 */
function getCoachingInsights() {
    const coaching = loadCoachingFile();
    return coaching.insights || [];
}

// ── Helpers ──

function getPnL(p) {
    return p.realizedPnL ?? p.closePnL ?? p.pnl ?? 0;
}

function normalizeType(type) {
    return (type || 'unknown').toLowerCase().replace(/\s+/g, '_');
}

function groupBy(array, keyFn) {
    const groups = {};
    for (const item of array) {
        const key = keyFn(item);
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }
    return groups;
}

function loadCoachingFile() {
    try {
        const dir = path.dirname(COACHING_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(COACHING_FILE)) {
            return JSON.parse(fs.readFileSync(COACHING_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('[COACHING] Error loading file:', e.message);
    }
    return { insights: [] };
}

function saveCoachingFile(data) {
    try {
        const dir = path.dirname(COACHING_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(COACHING_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('[COACHING] Error saving file:', e.message);
    }
}

// Clear cache when positions change
function invalidateCache() {
    patternCache = null;
    lastPositionHash = null;
}

module.exports = {
    analyzePatterns,
    buildCoachingContext,
    getCoachingReport,
    getAdvice,
    saveCoachingInsight,
    getCoachingInsights,
    invalidateCache
};
