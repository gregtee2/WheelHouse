/**
 * summaryRoutes.js - Week Ending Summary API
 * 
 * Generates weekly portfolio summaries with:
 * - Account value tracking
 * - Position P&L breakdown
 * - Biggest winners/losers
 * - AI analysis of what went wrong/right
 * - Cumulative history storage
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Injected dependencies
let AIService, promptBuilders;

const SUMMARIES_FILE = path.join(__dirname, '../../saved_positions/weekly_summaries.json');
const POSITIONS_FILE = path.join(__dirname, '../../saved_positions/wheelhouse_autosave.json');

/**
 * Initialize with dependencies
 */
function init(deps) {
    AIService = deps.AIService;
    promptBuilders = deps.promptBuilders;
}

/**
 * Load summaries history from disk
 */
function loadSummaries() {
    try {
        if (fs.existsSync(SUMMARIES_FILE)) {
            return JSON.parse(fs.readFileSync(SUMMARIES_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[SUMMARY] Error loading summaries:', e.message);
    }
    return { version: 1, summaries: [] };
}

/**
 * Save summaries history to disk
 */
function saveSummaries(data) {
    try {
        fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error('[SUMMARY] Error saving summaries:', e.message);
        return false;
    }
}

/**
 * Load current positions
/**
 * Load entire autosave file (positions, holdings, closedPositions)
 */
function loadAutosaveFile() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[SUMMARY] Error loading autosave file:', e.message);
    }
    return { positions: [], holdings: [], closedPositions: [] };
}

/**
 * Save autosave file
 */
function saveAutosaveFile(data) {
    try {
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('[SUMMARY] Error saving autosave file:', e.message);
        return false;
    }
}

/**
 * Get sector info for a ticker - comprehensive mapping
 * Returns { sector: string, keywords: string[] }
 */
function getSectorInfo(ticker) {
    if (!ticker) return { sector: null, keywords: [] };
    
    const t = ticker.toUpperCase();
    
    // Comprehensive sector mappings
    const sectors = {
        // Crypto Mining
        'IREN': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'BTC miners', 'cryptocurrency'] },
        'CIFR': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Cipher Mining', 'BTC miners'] },
        'MARA': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Marathon Digital', 'BTC miners'] },
        'RIOT': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Riot Platforms', 'BTC miners'] },
        'HUT': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Hut 8 Mining'] },
        'CLSK': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'CleanSpark'] },
        'BTBT': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Bit Digital'] },
        'BITF': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'Bitfarms'] },
        'WULF': { sector: 'Crypto Mining', keywords: ['Bitcoin mining', 'crypto mining', 'TeraWulf'] },
        'COIN': { sector: 'Crypto Exchange', keywords: ['cryptocurrency', 'crypto exchange', 'Bitcoin', 'Coinbase'] },
        'HOOD': { sector: 'Fintech', keywords: ['crypto trading', 'retail trading', 'Robinhood'] },
        
        // Semiconductors
        'NVDA': { sector: 'Semiconductors', keywords: ['AI chips', 'GPU', 'semiconductors', 'Nvidia'] },
        'AMD': { sector: 'Semiconductors', keywords: ['chip stocks', 'semiconductors', 'AI chips', 'AMD'] },
        'INTC': { sector: 'Semiconductors', keywords: ['chip stocks', 'semiconductors', 'Intel', 'foundry'] },
        'TSM': { sector: 'Semiconductors', keywords: ['chip stocks', 'semiconductors', 'TSMC', 'chip foundry'] },
        'AVGO': { sector: 'Semiconductors', keywords: ['semiconductors', 'Broadcom', 'networking chips'] },
        'QCOM': { sector: 'Semiconductors', keywords: ['semiconductors', '5G chips', 'Qualcomm', 'mobile chips'] },
        'MU': { sector: 'Semiconductors', keywords: ['semiconductors', 'memory chips', 'Micron', 'DRAM'] },
        'ARM': { sector: 'Semiconductors', keywords: ['semiconductors', 'chip design', 'ARM', 'mobile processors'] },
        'MRVL': { sector: 'Semiconductors', keywords: ['semiconductors', 'data infrastructure', 'Marvell'] },
        'ASML': { sector: 'Semiconductors', keywords: ['semiconductors', 'chip equipment', 'lithography', 'ASML'] },
        'LRCX': { sector: 'Semiconductors', keywords: ['semiconductors', 'chip equipment', 'Lam Research'] },
        'AMAT': { sector: 'Semiconductors', keywords: ['semiconductors', 'chip equipment', 'Applied Materials'] },
        'KLAC': { sector: 'Semiconductors', keywords: ['semiconductors', 'chip equipment', 'KLA Corp'] },
        'SOXL': { sector: 'Leveraged ETFs', keywords: ['semiconductors', 'chip stocks', 'leveraged ETF'] },
        'SOXS': { sector: 'Leveraged ETFs', keywords: ['semiconductors', 'chip stocks', 'inverse ETF'] },
        
        // Precious Metals
        'SLV': { sector: 'Precious Metals', keywords: ['silver', 'precious metals', 'silver ETF', 'commodities'] },
        'GLD': { sector: 'Precious Metals', keywords: ['gold', 'precious metals', 'gold ETF', 'commodities'] },
        'AG': { sector: 'Precious Metals', keywords: ['silver miners', 'precious metals', 'First Majestic'] },
        'GDX': { sector: 'Precious Metals', keywords: ['gold miners', 'precious metals', 'mining stocks'] },
        'GOLD': { sector: 'Precious Metals', keywords: ['gold miners', 'Barrick Gold', 'precious metals'] },
        'NEM': { sector: 'Precious Metals', keywords: ['gold miners', 'Newmont', 'precious metals'] },
        
        // Electric Vehicles
        'TSLA': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'EV stocks', 'Tesla', 'Elon Musk'] },
        'TSLL': { sector: 'Leveraged ETFs', keywords: ['Tesla', 'TSLA', 'electric vehicles', 'leveraged ETF'] },
        'RIVN': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'EV stocks', 'Rivian', 'EV trucks'] },
        'LCID': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'EV stocks', 'Lucid', 'luxury EV'] },
        'NIO': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'EV stocks', 'China EV', 'NIO'] },
        'XPEV': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'China EV', 'XPeng'] },
        'LI': { sector: 'Electric Vehicles', keywords: ['electric vehicles', 'China EV', 'Li Auto'] },
        'F': { sector: 'Automotive', keywords: ['electric vehicles', 'Ford', 'auto stocks', 'EV trucks'] },
        'GM': { sector: 'Automotive', keywords: ['electric vehicles', 'General Motors', 'auto stocks'] },
        
        // Clean Energy
        'ENPH': { sector: 'Clean Energy', keywords: ['solar stocks', 'clean energy', 'Enphase', 'solar inverters'] },
        'SEDG': { sector: 'Clean Energy', keywords: ['solar stocks', 'clean energy', 'SolarEdge'] },
        'FSLR': { sector: 'Clean Energy', keywords: ['solar stocks', 'clean energy', 'First Solar'] },
        'RUN': { sector: 'Clean Energy', keywords: ['solar stocks', 'residential solar', 'Sunrun'] },
        'ICLN': { sector: 'Clean Energy', keywords: ['clean energy', 'renewable energy', 'green energy ETF'] },
        
        // Big Tech
        'AAPL': { sector: 'Big Tech', keywords: ['Apple', 'iPhone', 'big tech', 'FAANG'] },
        'MSFT': { sector: 'Big Tech', keywords: ['Microsoft', 'AI', 'cloud computing', 'big tech'] },
        'GOOGL': { sector: 'Big Tech', keywords: ['Google', 'Alphabet', 'AI', 'big tech', 'search'] },
        'GOOG': { sector: 'Big Tech', keywords: ['Google', 'Alphabet', 'AI', 'big tech'] },
        'AMZN': { sector: 'Big Tech', keywords: ['Amazon', 'cloud computing', 'AWS', 'big tech'] },
        'META': { sector: 'Big Tech', keywords: ['Meta', 'Facebook', 'AI', 'big tech', 'social media'] },
        'NFLX': { sector: 'Big Tech', keywords: ['Netflix', 'streaming', 'big tech'] },
        'TQQQ': { sector: 'Leveraged ETFs', keywords: ['Nasdaq', 'tech stocks', 'QQQ', 'leveraged ETF'] },
        'SQQQ': { sector: 'Leveraged ETFs', keywords: ['Nasdaq', 'tech stocks', 'inverse ETF'] },
        'NVDL': { sector: 'Leveraged ETFs', keywords: ['Nvidia', 'NVDA', 'AI chips', 'leveraged ETF'] },
        
        // China Tech
        'BABA': { sector: 'China Tech', keywords: ['China tech', 'Alibaba', 'China stocks', 'e-commerce'] },
        'JD': { sector: 'China Tech', keywords: ['China tech', 'JD.com', 'China stocks', 'e-commerce'] },
        'PDD': { sector: 'China Tech', keywords: ['China tech', 'Pinduoduo', 'Temu', 'China stocks'] },
        'BIDU': { sector: 'China Tech', keywords: ['China tech', 'Baidu', 'China AI', 'search'] },
        'KWEB': { sector: 'China Tech', keywords: ['China tech', 'China internet', 'China ETF'] },
        
        // Fintech & Banks
        'SQ': { sector: 'Fintech', keywords: ['fintech', 'Block', 'payments', 'Square'] },
        'PYPL': { sector: 'Fintech', keywords: ['fintech', 'PayPal', 'payments', 'digital payments'] },
        'SOFI': { sector: 'Fintech', keywords: ['fintech', 'SoFi', 'digital banking', 'student loans'] },
        'AFRM': { sector: 'Fintech', keywords: ['fintech', 'Affirm', 'buy now pay later', 'BNPL'] },
        'V': { sector: 'Fintech', keywords: ['payments', 'Visa', 'credit cards'] },
        'MA': { sector: 'Fintech', keywords: ['payments', 'Mastercard', 'credit cards'] },
        'JPM': { sector: 'Banks', keywords: ['banking', 'JPMorgan', 'big banks', 'financials'] },
        'BAC': { sector: 'Banks', keywords: ['banking', 'Bank of America', 'big banks', 'financials'] },
        'GS': { sector: 'Banks', keywords: ['banking', 'Goldman Sachs', 'investment banking'] },
        
        // Aerospace & Defense
        'BA': { sector: 'Aerospace', keywords: ['Boeing', 'aerospace', 'airlines', 'aviation'] },
        'LMT': { sector: 'Defense', keywords: ['defense', 'Lockheed Martin', 'aerospace', 'military'] },
        'RTX': { sector: 'Defense', keywords: ['defense', 'Raytheon', 'aerospace', 'missiles'] },
        'NOC': { sector: 'Defense', keywords: ['defense', 'Northrop Grumman', 'aerospace'] },
        'GD': { sector: 'Defense', keywords: ['defense', 'General Dynamics', 'military'] },
        
        // Oil & Energy
        'XOM': { sector: 'Oil & Gas', keywords: ['oil stocks', 'energy', 'Exxon', 'crude oil'] },
        'CVX': { sector: 'Oil & Gas', keywords: ['oil stocks', 'energy', 'Chevron', 'crude oil'] },
        'OXY': { sector: 'Oil & Gas', keywords: ['oil stocks', 'energy', 'Occidental', 'crude oil'] },
        'XLE': { sector: 'Oil & Gas', keywords: ['oil stocks', 'energy sector', 'energy ETF'] },
        'USO': { sector: 'Oil & Gas', keywords: ['crude oil', 'oil ETF', 'WTI'] },
        
        // Meme Stocks
        'GME': { sector: 'Meme Stocks', keywords: ['meme stocks', 'GameStop', 'reddit', 'WSB'] },
        'AMC': { sector: 'Meme Stocks', keywords: ['meme stocks', 'AMC', 'reddit', 'WSB', 'theaters'] },
        'DJT': { sector: 'Meme Stocks', keywords: ['Trump Media', 'DWAC', 'meme stocks', 'politics'] },
        'BBBY': { sector: 'Meme Stocks', keywords: ['meme stocks', 'Bed Bath', 'reddit'] },
        
        // Biotech
        'MRNA': { sector: 'Biotech', keywords: ['biotech', 'Moderna', 'mRNA', 'vaccines'] },
        'BNTX': { sector: 'Biotech', keywords: ['biotech', 'BioNTech', 'mRNA', 'vaccines'] },
        'PFE': { sector: 'Pharma', keywords: ['pharma', 'Pfizer', 'healthcare', 'vaccines'] },
        'ABBV': { sector: 'Pharma', keywords: ['pharma', 'AbbVie', 'healthcare'] },
        'JNJ': { sector: 'Pharma', keywords: ['pharma', 'Johnson & Johnson', 'healthcare'] },
        'XBI': { sector: 'Biotech', keywords: ['biotech', 'biotech ETF', 'healthcare'] },
        
        // AI & Robotics
        'PLTR': { sector: 'AI/Defense', keywords: ['AI stocks', 'Palantir', 'defense', 'data analytics'] },
        'SNOW': { sector: 'Cloud/AI', keywords: ['cloud computing', 'Snowflake', 'data', 'AI'] },
        'AI': { sector: 'AI', keywords: ['AI stocks', 'C3.ai', 'artificial intelligence'] },
        'UPST': { sector: 'AI/Fintech', keywords: ['AI lending', 'Upstart', 'fintech'] },
        'ISRG': { sector: 'Robotics', keywords: ['robotics', 'Intuitive Surgical', 'medical devices'] },
        
        // Other Notable Stocks
        'SPY': { sector: 'Index ETF', keywords: ['S&P 500', 'stock market', 'index fund'] },
        'QQQ': { sector: 'Index ETF', keywords: ['Nasdaq', 'tech stocks', 'index fund'] },
        'IWM': { sector: 'Index ETF', keywords: ['Russell 2000', 'small caps', 'index fund'] },
        'VIX': { sector: 'Volatility', keywords: ['volatility', 'VIX', 'fear index', 'options'] },
        'UVXY': { sector: 'Volatility', keywords: ['volatility', 'VIX', 'leveraged volatility'] },
        'DIS': { sector: 'Entertainment', keywords: ['Disney', 'streaming', 'entertainment', 'theme parks'] },
        'WMT': { sector: 'Retail', keywords: ['Walmart', 'retail', 'consumer staples'] },
        'COST': { sector: 'Retail', keywords: ['Costco', 'retail', 'consumer staples'] },
        'TGT': { sector: 'Retail', keywords: ['Target', 'retail', 'consumer discretionary'] },
        'HD': { sector: 'Retail', keywords: ['Home Depot', 'retail', 'housing market'] },
        'LOW': { sector: 'Retail', keywords: ['Lowes', 'retail', 'housing market'] },
        'NBIS': { sector: 'AI Data', keywords: ['Nebius', 'AI infrastructure', 'cloud computing'] },
    };
    
    return sectors[t] || { sector: null, keywords: [] };
}

/**
 * Tag positions with sector info (for migration)
 */
function tagPositionsWithSectors(positions) {
    if (!Array.isArray(positions)) return 0;
    
    let taggedCount = 0;
    for (const pos of positions) {
        if (!pos.sector && pos.ticker) {
            const info = getSectorInfo(pos.ticker);
            if (info.sector) {
                pos.sector = info.sector;
                pos.sectorKeywords = info.keywords;
                taggedCount++;
            }
        }
    }
    return taggedCount;
}

/**
 * Load positions
 */
function loadPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
            return data.positions || [];
        }
    } catch (e) {
        console.error('[SUMMARY] Error loading positions:', e.message);
    }
    return [];
}

/**
 * Load closed positions
 */
function loadClosedPositions() {
    try {
        if (fs.existsSync(POSITIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
            return data.closedPositions || [];
        }
    } catch (e) {
        console.error('[SUMMARY] Error loading closed positions:', e.message);
    }
    return [];
}

/**
 * Get positions closed within the current week (Mon-Sun)
 * Week ending = this coming Sunday (or today if it's Sunday)
 */
function getClosedThisWeek() {
    const closed = loadClosedPositions();
    const now = new Date();
    
    // Find start of this week (Monday)
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysFromMonday);
    weekStart.setHours(0, 0, 0, 0);
    
    // Filter for positions closed this week
    return closed.filter(pos => {
        if (!pos.closeDate) return false;
        const closeDate = new Date(pos.closeDate);
        return closeDate >= weekStart && closeDate <= now;
    });
}

/**
 * Calculate P&L for a position
 */
function calculatePositionPnL(pos) {
    const entry = (pos.premium || 0) * 100 * (pos.contracts || 1);
    const current = (pos.lastOptionPrice || pos.premium || 0) * 100 * (pos.contracts || 1);
    const isLong = pos.type?.includes('long') || pos.type?.includes('debit');
    const pnl = isLong ? current - entry : entry - current;
    
    return {
        ticker: pos.ticker,
        type: pos.type,
        strike: pos.strike,
        contracts: pos.contracts,
        expiry: pos.expiry,
        dte: pos.dte,
        entryPremium: pos.premium,
        currentPrice: pos.lastOptionPrice || pos.premium,
        entryValue: Math.round(entry),
        currentValue: Math.round(current),
        unrealizedPnL: Math.round(pnl),
        pnlPercent: entry > 0 ? Math.round((pnl / entry) * 100) : 0
    };
}

/**
 * Generate a weekly summary
 */
function generateSummary(positions, accountValue, closedThisWeek = [], holdings = []) {
    const openPositions = positions.filter(p => p.status === 'open');
    
    // Calculate P&L for all open positions
    const positionsPnL = openPositions.map(calculatePositionPnL);
    
    // Sort by P&L to find winners/losers
    const sorted = [...positionsPnL].sort((a, b) => a.unrealizedPnL - b.unrealizedPnL);
    
    // Calculate totals
    const totalUnrealizedPnL = positionsPnL.reduce((sum, p) => sum + p.unrealizedPnL, 0);
    const totalCapitalAtRisk = openPositions.reduce((sum, p) => {
        if (p.type?.includes('spread')) {
            return sum + (p.maxLoss || 0);
        } else if (p.type === 'short_put' || p.type === 'buy_write') {
            return sum + ((p.strike || 0) * 100 * (p.contracts || 1));
        } else if (p.type?.includes('long')) {
            return sum + ((p.premium || 0) * 100 * (p.contracts || 1));
        }
        return sum;
    }, 0);
    
    // Get closed positions P&L this week
    // Calculate P&L if not stored: (premium - closePrice) * 100 * contracts for short options
    const realizedPnL = closedThisWeek.reduce((sum, p) => {
        // First try stored P&L
        if (p.realizedPnL !== null && p.realizedPnL !== undefined) return sum + p.realizedPnL;
        if (p.closePnL !== null && p.closePnL !== undefined) return sum + p.closePnL;
        
        // Calculate from premium/closePrice if available
        const premium = p.premium || 0;
        const closePrice = p.closePrice || 0;
        const contracts = p.contracts || 1;
        
        if (premium > 0) {
            // For short options: P&L = (premium received - close price paid) * 100 * contracts
            const calculatedPnL = (premium - closePrice) * 100 * contracts;
            return sum + calculatedPnL;
        }
        
        return sum;
    }, 0);
    
    // Identify biggest winner and loser
    const biggestLoser = sorted[0] || null;
    const biggestWinner = sorted[sorted.length - 1] || null;
    
    // Count positions by status
    const inProfit = positionsPnL.filter(p => p.unrealizedPnL > 0).length;
    const atLoss = positionsPnL.filter(p => p.unrealizedPnL < 0).length;
    const breakeven = positionsPnL.filter(p => p.unrealizedPnL === 0).length;
    
    // Calculate leverage
    const leverageRatio = accountValue > 0 ? (totalCapitalAtRisk / accountValue) * 100 : 0;
    
    // Process holdings (stock positions)
    const holdingsData = holdings.map(h => ({
        ticker: h.ticker,
        shares: h.shares || h.quantity || 0,
        costBasis: h.costBasis || h.avgCost || 0,
        currentPrice: h.currentPrice || h.lastPrice || 0,
        marketValue: (h.shares || h.quantity || 0) * (h.currentPrice || h.lastPrice || 0),
        unrealizedPnL: ((h.currentPrice || h.lastPrice || 0) - (h.costBasis || h.avgCost || 0)) * (h.shares || h.quantity || 0)
    })).filter(h => h.shares > 0); // Filter out zero-share holdings
    
    const holdingsUnrealizedPnL = holdingsData.reduce((sum, h) => sum + h.unrealizedPnL, 0);
    const holdingsMarketValue = holdingsData.reduce((sum, h) => sum + h.marketValue, 0);
    
    return {
        weekEnding: new Date().toISOString().split('T')[0],
        generatedAt: new Date().toISOString(),
        
        // Account metrics
        accountValue: accountValue,
        capitalAtRisk: totalCapitalAtRisk,
        leverageRatio: Math.round(leverageRatio),
        
        // P&L summary (options only)
        unrealizedPnL: totalUnrealizedPnL,
        realizedPnL: realizedPnL,
        totalPnL: totalUnrealizedPnL + realizedPnL,
        
        // Position counts (options)
        totalOpenPositions: openPositions.length,
        positionsInProfit: inProfit,
        positionsAtLoss: atLoss,
        positionsBreakeven: breakeven,
        closedThisWeekCount: closedThisWeek.length,
        
        // Stock holdings summary
        holdingsCount: holdingsData.length,
        holdingsMarketValue: Math.round(holdingsMarketValue),
        holdingsUnrealizedPnL: Math.round(holdingsUnrealizedPnL),
        holdings: holdingsData,
        
        // Winners and losers
        biggestWinner: biggestWinner ? {
            ticker: biggestWinner.ticker,
            type: biggestWinner.type,
            strike: biggestWinner.strike,
            pnl: biggestWinner.unrealizedPnL,
            pnlPercent: biggestWinner.pnlPercent
        } : null,
        biggestLoser: biggestLoser ? {
            ticker: biggestLoser.ticker,
            type: biggestLoser.type,
            strike: biggestLoser.strike,
            pnl: biggestLoser.unrealizedPnL,
            pnlPercent: biggestLoser.pnlPercent
        } : null,
        
        // Full position breakdown (for detail view)
        positions: positionsPnL,
        
        // Closed positions this week (for realized P&L detail)
        closedThisWeek: closedThisWeek.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            contracts: p.contracts,
            closeDate: p.closeDate,
            closeReason: p.closeReason || 'closed',
            realizedPnL: p.realizedPnL || p.closePnL || 0
        })),
        
        // AI analysis placeholder (filled in by separate call)
        aiAnalysis: null
    };
}

/**
 * Build AI prompt for weekly analysis
 */
function buildWeeklyAnalysisPrompt(summary, history) {
    const prevWeek = history.length > 0 ? history[history.length - 1] : null;
    const weekChange = prevWeek ? summary.accountValue - prevWeek.accountValue : null;
    
    let prompt = `You are a trading coach reviewing a trader's weekly performance. Be direct and actionable.

## This Week's Summary (Week Ending ${summary.weekEnding})

**Account Value**: $${summary.accountValue?.toLocaleString() || 'Unknown'}
${weekChange !== null ? `**Week's Change**: ${weekChange >= 0 ? '+' : ''}$${weekChange.toLocaleString()}` : ''}
**Leverage**: ${summary.leverageRatio}% (Capital at Risk: $${summary.capitalAtRisk?.toLocaleString()})

**Unrealized P&L** (open positions): ${summary.unrealizedPnL >= 0 ? '+' : ''}$${summary.unrealizedPnL?.toLocaleString()}
**Realized P&L** (closed this week): ${summary.realizedPnL >= 0 ? '+' : ''}$${summary.realizedPnL?.toLocaleString()}

**Positions**: ${summary.totalOpenPositions} open (${summary.positionsInProfit} profitable, ${summary.positionsAtLoss} losing)

## Open Positions (sorted by P&L - these are UNREALIZED)
`;

    // Add each open position
    const sorted = [...summary.positions].sort((a, b) => a.unrealizedPnL - b.unrealizedPnL);
    for (const pos of sorted) {
        const sign = pos.unrealizedPnL >= 0 ? '+' : '';
        prompt += `- ${pos.ticker} ${pos.type} $${pos.strike} x${pos.contracts} (${pos.dte} DTE): ${sign}$${pos.unrealizedPnL} (${sign}${pos.pnlPercent}%) [UNREALIZED]\n`;
    }

    // Add closed positions this week (REALIZED)
    const closedThisWeek = summary.closedThisWeek || [];
    if (closedThisWeek.length > 0) {
        prompt += `\n## Closed This Week (REALIZED P&L)\n`;
        for (const pos of closedThisWeek) {
            // Calculate P&L if not stored
            let pnl = pos.realizedPnL ?? pos.closePnL ?? null;
            if (pnl === null && pos.premium && pos.closePrice !== undefined) {
                pnl = Math.round((pos.premium - (pos.closePrice || 0)) * 100 * (pos.contracts || 1));
            }
            pnl = pnl || 0;
            const sign = pnl >= 0 ? '+' : '';
            prompt += `- ${pos.ticker} ${pos.type} $${pos.strike} x${pos.contracts || 1}: ${sign}$${pnl} (${pos.closeReason || 'closed'}) [REALIZED]\n`;
        }
    }

    if (summary.biggestLoser && summary.biggestLoser.pnl < 0) {
        prompt += `\n## 🔴 BIGGEST UNREALIZED LOSER: ${summary.biggestLoser.ticker} ${summary.biggestLoser.type} $${summary.biggestLoser.strike}
Currently down $${Math.abs(summary.biggestLoser.pnl)} (${summary.biggestLoser.pnlPercent}% of entry premium) - NOT YET REALIZED
`;
    }

    if (summary.biggestWinner && summary.biggestWinner.pnl > 0) {
        prompt += `\n## 🟢 BIGGEST UNREALIZED WINNER: ${summary.biggestWinner.ticker} ${summary.biggestWinner.type} $${summary.biggestWinner.strike}
Currently up +$${summary.biggestWinner.pnl} (+${summary.biggestWinner.pnlPercent}% of entry premium) - NOT YET REALIZED
`;
    }

    // Add historical context if available
    if (history.length > 0) {
        prompt += `\n## Recent History (last ${Math.min(4, history.length)} weeks)\n`;
        const recentWeeks = history.slice(-4);
        for (const week of recentWeeks) {
            const sign = week.unrealizedPnL >= 0 ? '+' : '';
            prompt += `- ${week.weekEnding}: $${week.accountValue?.toLocaleString()} | Unrealized: ${sign}$${week.unrealizedPnL?.toLocaleString()}`;
            if (week.biggestLoser) {
                prompt += ` | Biggest loss: ${week.biggestLoser.ticker}`;
            }
            prompt += '\n';
        }
    }

    prompt += `
## Your Task

Provide a brief weekly review (3-4 paragraphs max):

1. **What Happened**: Summarize the week's performance. What positions hurt? What helped?

2. **The Pattern**: Do you see any patterns in the losing trades? (e.g., too much size, wrong delta, same sector exposure, selling into weakness)

3. **Action Items**: 2-3 specific, actionable recommendations for next week.

Keep it conversational but direct. No fluff.`;

    return prompt;
}

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * POST /api/summary/generate - Generate current week's summary
 * Body: { accountValue, closedThisWeek, holdings }
/**
 * GET /api/summary/all-holdings - Single source of truth for all positions
 * Returns both OPTIONS positions AND stock HOLDINGS from the autosave file
 */
router.get('/all-holdings', async (req, res) => {
    try {
        const data = loadAutosaveFile();
        
        const options = (data.positions || []).filter(p => p.status === 'open');
        const holdings = data.holdings || [];
        const closedPositions = data.closedPositions || [];
        
        // Get unique tickers from options
        const optionsTickers = [...new Set(options.map(p => p.ticker).filter(Boolean))];
        
        // Get unique tickers from holdings (filter out money markets, CUSIPs)
        const holdingsTickers = [...new Set(holdings
            .map(h => h.ticker)
            .filter(t => t && t.length <= 5 && !/^\d/.test(t) && !t.includes('XX'))
        )];
        
        // Get closed this week
        const now = new Date();
        const dayOfWeek = now.getDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - daysFromMonday);
        weekStart.setHours(0, 0, 0, 0);
        
        const closedThisWeek = closedPositions.filter(p => {
            if (!p.closeDate) return false;
            const closeDate = new Date(p.closeDate);
            return closeDate >= weekStart && closeDate <= now;
        });
        
        // Extract sector keywords from positions (tagged at creation time)
        const positionSectorKeywords = new Set();
        options.forEach(p => {
            if (p.sectorKeywords && Array.isArray(p.sectorKeywords)) {
                p.sectorKeywords.forEach(kw => positionSectorKeywords.add(kw));
            }
        });
        holdings.forEach(h => {
            if (h.sectorKeywords && Array.isArray(h.sectorKeywords)) {
                h.sectorKeywords.forEach(kw => positionSectorKeywords.add(kw));
            }
        });
        
        // Also include static lookup as fallback for untagged positions
        const staticKeywords = buildSectorKeywords([...optionsTickers, ...holdingsTickers]);
        const combinedKeywords = [...new Set([...positionSectorKeywords, ...staticKeywords])];
        
        res.json({
            success: true,
            data: {
                options: {
                    count: options.length,
                    tickers: optionsTickers,
                    positions: options
                },
                holdings: {
                    count: holdings.length,
                    tickers: holdingsTickers,
                    positions: holdings
                },
                closedThisWeek: {
                    count: closedThisWeek.length,
                    positions: closedThisWeek
                },
                // Convenience: all tickers combined
                allTickers: [...new Set([...optionsTickers, ...holdingsTickers])],
                sectorKeywords: combinedKeywords
            }
        });
    } catch (e) {
        console.error('[SUMMARY] All holdings error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/summary/migrate-sectors - Tag all positions/holdings with sector info
 * This is a one-time migration to add sector tags to existing data
 */
router.post('/migrate-sectors', async (req, res) => {
    try {
        const data = loadAutosaveFile();
        
        let taggedPositions = 0;
        let taggedHoldings = 0;
        let taggedClosed = 0;
        
        // Tag open positions
        if (data.positions && Array.isArray(data.positions)) {
            taggedPositions = tagPositionsWithSectors(data.positions);
        }
        
        // Tag holdings
        if (data.holdings && Array.isArray(data.holdings)) {
            taggedHoldings = tagPositionsWithSectors(data.holdings);
        }
        
        // Tag closed positions
        if (data.closedPositions && Array.isArray(data.closedPositions)) {
            taggedClosed = tagPositionsWithSectors(data.closedPositions);
        }
        
        const totalTagged = taggedPositions + taggedHoldings + taggedClosed;
        
        if (totalTagged > 0) {
            saveAutosaveFile(data);
            console.log(`[SUMMARY] Sector migration complete: ${taggedPositions} positions, ${taggedHoldings} holdings, ${taggedClosed} closed`);
        }
        
        res.json({
            success: true,
            message: `Tagged ${totalTagged} items with sector info`,
            details: {
                positions: taggedPositions,
                holdings: taggedHoldings,
                closed: taggedClosed
            }
        });
    } catch (e) {
        console.error('[SUMMARY] Sector migration error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/summary/generate - Generate weekly summary
 */
router.post('/generate', async (req, res) => {
    try {
        // Frontend now sends ALL data - no need to read from autosave
        const { accountValue = 0, closedThisWeek = [], holdings = [], positions = [] } = req.body;
        
        console.log(`[SUMMARY] Received from frontend:`, {
            closedThisWeek: closedThisWeek.length,
            holdings: holdings.length,
            positions: positions.length,
            accountValue
        });
        
        // Use positions from frontend, not from autosave
        const summary = generateSummary(positions, accountValue, closedThisWeek, holdings);
        
        res.json({ success: true, summary });
    } catch (e) {
        console.error('[SUMMARY] Generate error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Legacy GET endpoint for compatibility
router.get('/generate', async (req, res) => {
    try {
        const positions = loadPositions();
        const accountValue = parseFloat(req.query.accountValue) || 0;
        const closedThisWeek = getClosedThisWeek(); // Fallback to autosave file
        
        const summary = generateSummary(positions, accountValue, closedThisWeek);
        
        res.json({ success: true, summary });
    } catch (e) {
        console.error('[SUMMARY] Generate error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/summary/save - Save current summary to history
 */
router.post('/save', async (req, res) => {
    try {
        const { summary } = req.body;
        if (!summary) {
            return res.status(400).json({ error: 'No summary provided' });
        }
        
        const data = loadSummaries();
        
        // Check if we already have a summary for this week
        const existingIdx = data.summaries.findIndex(s => s.weekEnding === summary.weekEnding);
        if (existingIdx >= 0) {
            // Update existing
            data.summaries[existingIdx] = summary;
        } else {
            // Add new
            data.summaries.push(summary);
        }
        
        // Keep only last 52 weeks
        if (data.summaries.length > 52) {
            data.summaries = data.summaries.slice(-52);
        }
        
        saveSummaries(data);
        
        res.json({ success: true, message: 'Summary saved', totalWeeks: data.summaries.length });
    } catch (e) {
        console.error('[SUMMARY] Save error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/summary/history - Get all saved summaries
 */
router.get('/history', (req, res) => {
    try {
        const data = loadSummaries();
        res.json({ success: true, summaries: data.summaries });
    } catch (e) {
        console.error('[SUMMARY] History error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/summary/analyze - Get AI analysis for a summary
 */
router.post('/analyze', async (req, res) => {
    try {
        const { summary, model } = req.body;
        if (!summary) {
            return res.status(400).json({ error: 'No summary provided' });
        }
        
        // Load history for context
        const data = loadSummaries();
        const history = data.summaries.filter(s => s.weekEnding !== summary.weekEnding);
        
        // Build prompt
        const prompt = buildWeeklyAnalysisPrompt(summary, history);
        
        // Call AI
        const aiModel = model || 'qwen2.5:14b';
        const result = await AIService.callAI(prompt, aiModel);
        
        res.json({ success: true, analysis: result.response || result, model: aiModel });
    } catch (e) {
        console.error('[SUMMARY] Analyze error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /api/summary/:weekEnding - Delete a specific week's summary
 */
router.delete('/:weekEnding', (req, res) => {
    try {
        const { weekEnding } = req.params;
        const data = loadSummaries();
        
        const before = data.summaries.length;
        data.summaries = data.summaries.filter(s => s.weekEnding !== weekEnding);
        
        if (data.summaries.length === before) {
            return res.status(404).json({ error: 'Summary not found' });
        }
        
        saveSummaries(data);
        res.json({ success: true, message: 'Summary deleted' });
    } catch (e) {
        console.error('[SUMMARY] Delete error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// DEEP ANALYSIS - Multi-Step AI Pipeline
// ============================================================================

/**
 * Identify at-risk positions that need individual checkups
 * 
 * WHEEL STRATEGY DTE CONTEXT:
 * - 45+ DTE: Too early to worry - theta barely started, stock has time
 * - 21-44 DTE: Watch zone - only flag if deeply underwater (>100% loss)
 * - 7-21 DTE: Decision window - flag if losing or near strike
 * - <7 DTE: Expiration week - need decision NOW
 * 
 * Categories:
 * - URGENT: DTE ≤ 7 AND losing money
 * - ACTION: DTE 8-21 AND loss > 50%
 * - WATCH: DTE > 21 AND loss > 100% (doubled against you)
 */
function identifyAtRiskPositions(summary) {
    const positions = summary.positions || [];
    const atRisk = [];
    
    for (const pos of positions) {
        const reasons = [];
        const dte = pos.dte || 999;
        const lossPercent = pos.pnlPercent || 0;
        
        // URGENT: Expiring this week AND in trouble
        if (dte <= 7) {
            if (lossPercent < -20) {
                reasons.push(`URGENT: only ${dte} DTE with ${lossPercent}% loss`);
            } else if (lossPercent < 50) {
                // Even if not losing much, expiring soon needs a decision
                reasons.push(`Expiring in ${dte} days - decision needed`);
            }
            // If profitable and expiring, that's fine - let it expire OTM
        }
        
        // ACTION WINDOW: 8-21 DTE with significant loss
        else if (dte <= 21 && dte > 7) {
            if (lossPercent < -50) {
                reasons.push(`${dte} DTE with ${lossPercent}% loss - roll window`);
            }
            // Near breakeven with 2-3 weeks left is fine
        }
        
        // WATCH: >21 DTE but doubled against you
        else if (dte > 21) {
            // Only flag if loss > 100% (premium doubled against you)
            if (lossPercent < -100) {
                reasons.push(`WATCH: ${lossPercent}% loss (${dte} DTE remaining)`);
            }
            // Loss < 100% with 3+ weeks? Not urgent - theta will work
        }
        
        // Large size amplifies risk
        if ((pos.contracts || 1) >= 5 && lossPercent < -30) {
            reasons.push('large position at loss');
        }
        
        if (reasons.length > 0) {
            atRisk.push({
                ...pos,
                riskReasons: reasons,
                urgency: dte <= 7 ? 'URGENT' : dte <= 21 ? 'ACTION' : 'WATCH'
            });
        }
    }
    
    // Sort by urgency (URGENT first), then by P&L
    const urgencyOrder = { 'URGENT': 0, 'ACTION': 1, 'WATCH': 2 };
    return atRisk.sort((a, b) => {
        const urgDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
        if (urgDiff !== 0) return urgDiff;
        return a.unrealizedPnL - b.unrealizedPnL;
    });
}

/**
 * Build prompt for individual position checkups
 */
function buildPositionCheckupsPrompt(atRiskPositions, summary) {
    if (atRiskPositions.length === 0) {
        return null; // No at-risk positions to check
    }
    
    let prompt = `You are a wheel strategy trading coach. Review these flagged positions and give brief recommendations.

## CRITICAL: DTE Context for Wheel Trading
- **45+ DTE**: Too early to panic. Theta barely started. Stock has time to recover. Unless deeply ITM, recommend HOLD.
- **21-45 DTE**: Watch zone. Only recommend action if position is significantly underwater (>100% loss).
- **7-21 DTE**: Decision window. Time to roll if ITM or take profits if >50%.
- **<7 DTE**: Expiration week. Need decision NOW - roll, close, or let expire/assign.

## Portfolio Context
- Account Value: $${summary.accountValue?.toLocaleString() || 'Unknown'}
- Leverage: ${summary.leverageRatio}%
- Total Positions: ${summary.totalOpenPositions}

## Positions Flagged for Review

`;
    
    for (const pos of atRiskPositions) {
        const urgencyIcon = pos.urgency === 'URGENT' ? '🔴' : pos.urgency === 'ACTION' ? '🟠' : '🟡';
        prompt += `### ${urgencyIcon} ${pos.ticker} ${pos.type?.replace('_', ' ')} $${pos.strike} x${pos.contracts || 1}
- P&L: ${pos.unrealizedPnL >= 0 ? '+' : ''}$${pos.unrealizedPnL} (${pos.pnlPercent}%)
- DTE: ${pos.dte || 'unknown'} days
- Status: ${pos.urgency} - ${pos.riskReasons.join('; ')}
- Entry: $${pos.entryPremium?.toFixed(2) || '?'} → Current: $${pos.currentPrice?.toFixed(2) || '?'}

`;
    }
    
    prompt += `
## Your Task
For each position, provide:
1. **Verdict**: HOLD / ROLL / CLOSE
2. **Reason**: One sentence explaining why, RESPECTING the DTE context above

IMPORTANT: 
- Don't recommend closing a 45+ DTE position just because it's down - that's premature
- "WATCH" status positions (high DTE) should usually get HOLD unless there's a specific catalyst
- Only recommend immediate action for URGENT positions (<7 DTE)

Format: **TICKER $STRIKE**: VERDICT - Reason`;

    return prompt;
}

/**
 * Build prompt for portfolio-level audit
 */
function buildPortfolioAuditPrompt(summary) {
    const positions = summary.positions || [];
    
    // Calculate sector/ticker concentration
    const tickerCounts = {};
    const tickerExposure = {};
    for (const pos of positions) {
        tickerCounts[pos.ticker] = (tickerCounts[pos.ticker] || 0) + 1;
        tickerExposure[pos.ticker] = (tickerExposure[pos.ticker] || 0) + Math.abs(pos.currentValue || 0);
    }
    
    const sortedByExposure = Object.entries(tickerExposure)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    
    // Count position types
    const typeCounts = {};
    for (const pos of positions) {
        typeCounts[pos.type] = (typeCounts[pos.type] || 0) + 1;
    }
    
    let prompt = `You are analyzing a trader's portfolio for structural risks. Be specific and actionable.

## Portfolio Structure

**Account Value**: $${summary.accountValue?.toLocaleString() || 'Unknown'}
**Leverage**: ${summary.leverageRatio}% ($${summary.capitalAtRisk?.toLocaleString()} at risk)
**Positions**: ${summary.totalOpenPositions} open (${summary.positionsInProfit} winning, ${summary.positionsAtLoss} losing)
**Unrealized P&L**: ${summary.unrealizedPnL >= 0 ? '+' : ''}$${summary.unrealizedPnL?.toLocaleString()}

## Concentration Analysis

**Top Exposures by Dollar Value:**
${sortedByExposure.map(([ticker, exposure]) => {
    const pct = ((exposure / summary.capitalAtRisk) * 100).toFixed(0);
    return `- ${ticker}: $${exposure.toLocaleString()} (${pct}% of capital at risk)`;
}).join('\n')}

**Position Type Mix:**
${Object.entries(typeCounts).map(([type, count]) => `- ${type.replace('_', ' ')}: ${count} positions`).join('\n')}

## Current P&L Distribution
- Profitable: ${summary.positionsInProfit} positions
- Losing: ${summary.positionsAtLoss} positions  
- Breakeven: ${summary.positionsBreakeven} positions
${summary.biggestLoser ? `- Worst: ${summary.biggestLoser.ticker} at -$${Math.abs(summary.biggestLoser.pnl)}` : ''}
${summary.biggestWinner ? `- Best: ${summary.biggestWinner.ticker} at +$${summary.biggestWinner.pnl}` : ''}

## Your Task

Analyze for portfolio-level risks:
1. **Concentration Risk**: Is the portfolio too concentrated in one ticker/sector?
2. **Leverage Assessment**: Is the leverage appropriate for the account size?
3. **Directional Bias**: Is the portfolio too bullish/bearish?
4. **Size Issues**: Any positions too large relative to account?

Provide 2-3 specific warnings or recommendations. Be direct.`;

    return prompt;
}

/**
 * Build sector keywords for X sentiment search based on tickers
 * Returns related search terms that could affect these positions
 */
function buildSectorKeywords(tickers) {
    // Known sector mappings - ticker to related search terms
    const sectorMap = {
        // Crypto miners - heavily affected by Bitcoin/crypto news
        'IREN': ['Bitcoin mining', 'crypto mining', 'BTC miners'],
        'CIFR': ['Bitcoin mining', 'crypto mining', 'Cipher Mining'],
        'MARA': ['Bitcoin mining', 'crypto mining', 'Marathon Digital'],
        'RIOT': ['Bitcoin mining', 'crypto mining', 'Riot Platforms'],
        'HUT': ['Bitcoin mining', 'crypto mining'],
        'CLSK': ['Bitcoin mining', 'crypto mining', 'CleanSpark'],
        'BTBT': ['Bitcoin mining', 'crypto mining'],
        'COIN': ['crypto exchange', 'Bitcoin', 'cryptocurrency'],
        
        // Semiconductors
        'INTC': ['chip stocks', 'semiconductors', 'Intel'],
        'AMD': ['chip stocks', 'semiconductors', 'AI chips'],
        'NVDA': ['AI chips', 'semiconductors', 'GPU'],
        'TSM': ['chip stocks', 'semiconductors', 'TSMC'],
        'AVGO': ['semiconductors', 'Broadcom'],
        'QCOM': ['semiconductors', '5G chips'],
        
        // Silver/Gold miners
        'SLV': ['silver', 'precious metals', 'silver ETF'],
        'GLD': ['gold', 'precious metals', 'gold ETF'],
        'AG': ['silver miners', 'precious metals'],
        
        // EV and clean energy
        'TSLA': ['electric vehicles', 'EV stocks', 'Tesla'],
        'RIVN': ['electric vehicles', 'EV stocks', 'Rivian'],
        'LCID': ['electric vehicles', 'EV stocks', 'Lucid'],
        'NIO': ['electric vehicles', 'EV stocks', 'China EV'],
        'ENPH': ['solar stocks', 'clean energy', 'Enphase'],
        'SEDG': ['solar stocks', 'clean energy'],
        
        // Leveraged ETFs - track underlying
        'TSLL': ['Tesla', 'TSLA', 'electric vehicles'],
        'NVDL': ['Nvidia', 'NVDA', 'AI chips'],
        'SOXL': ['semiconductors', 'chip stocks'],
        'TQQQ': ['Nasdaq', 'tech stocks', 'QQQ'],
        
        // China tech
        'BABA': ['China tech', 'Alibaba', 'China stocks'],
        'JD': ['China tech', 'JD.com', 'China stocks'],
        'PDD': ['China tech', 'Pinduoduo', 'China stocks'],
        
        // Other sectors
        'BA': ['Boeing', 'aerospace', 'airlines'],
        'XOM': ['oil stocks', 'energy', 'Exxon'],
        'DJT': ['Trump Media', 'DWAC', 'meme stocks']
    };
    
    const keywords = new Set();
    
    for (const ticker of tickers) {
        const related = sectorMap[ticker.toUpperCase()];
        if (related) {
            related.forEach(kw => keywords.add(kw));
        }
    }
    
    return [...keywords];
}

/**
 * Build synthesis prompt that combines all analyses
 * @param {boolean} isGrok - If true, adds instructions to use X/Twitter sentiment
 */
function buildSynthesisPrompt(summary, positionCheckups, portfolioAudit, history, isGrok = false) {
    const prevWeek = history.length > 0 ? history[history.length - 1] : null;
    const weekChange = prevWeek ? summary.accountValue - prevWeek.accountValue : null;
    const closedThisWeek = summary.closedThisWeek || [];
    
    // Get unique tickers from OPTIONS positions
    const optionsTickers = [...new Set((summary.positions || []).map(p => p.ticker))];
    
    // Get unique tickers from stock HOLDINGS (filter out money market funds, CUSIPs, etc.)
    const holdingsTickers = [...new Set((summary.holdings || [])
        .map(h => h.ticker)
        .filter(t => t && t.length <= 5 && !/^\d/.test(t) && !t.includes('XX'))  // Filter out CUSIPs, money markets
    )];
    
    // Combine all tickers for X sentiment lookup
    const allTickers = [...new Set([...optionsTickers, ...holdingsTickers])];
    
    // Build historical trend data (last 4 weeks)
    const recentHistory = history.slice(-4);
    let trendData = null;
    if (recentHistory.length >= 2) {
        const accountValues = recentHistory.map(h => h.accountValue || 0);
        const leverages = recentHistory.map(h => h.leverageRatio || 0);
        const realizedPnLs = recentHistory.map(h => h.realizedPnL || 0);
        
        // Calculate trends
        const avgLeverage = leverages.reduce((a, b) => a + b, 0) / leverages.length;
        const totalRealized = realizedPnLs.reduce((a, b) => a + b, 0);
        const accountTrend = accountValues[accountValues.length - 1] - accountValues[0];
        
        // Count winning vs losing weeks
        const winningWeeks = realizedPnLs.filter(p => p > 0).length;
        const losingWeeks = realizedPnLs.filter(p => p < 0).length;
        
        trendData = {
            weeksAnalyzed: recentHistory.length,
            accountTrend,
            avgLeverage: Math.round(avgLeverage),
            totalRealized,
            winningWeeks,
            losingWeeks,
            weeks: recentHistory.map(h => ({
                date: h.weekEnding,
                accountValue: h.accountValue,
                realized: h.realizedPnL,
                leverage: h.leverageRatio,
                openPositions: h.totalOpenPositions
            }))
        };
    }
    
    let prompt = `You are creating a comprehensive Week-Ending Summary for a trader. You have access to multiple analyses - synthesize them into ONE cohesive report.`;
    
    // Add X sentiment instructions for Grok
    if (isGrok && allTickers.length > 0) {
        // Extract sector keywords from POSITIONS (tagged at creation time)
        const positionSectorKeywords = new Set();
        (summary.positions || []).forEach(p => {
            if (p.sectorKeywords && Array.isArray(p.sectorKeywords)) {
                p.sectorKeywords.forEach(kw => positionSectorKeywords.add(kw));
            }
        });
        // Also get from HOLDINGS (if tagged)
        (summary.holdings || []).forEach(h => {
            if (h.sectorKeywords && Array.isArray(h.sectorKeywords)) {
                h.sectorKeywords.forEach(kw => positionSectorKeywords.add(kw));
            }
        });
        
        // Fall back to static lookup for any positions without tags
        const staticKeywords = buildSectorKeywords(allTickers);
        
        // Combine both (position tags + static lookup for coverage)
        const sectorKeywords = [...new Set([...positionSectorKeywords, ...staticKeywords])];
        
        prompt += `

## 🔍 IMPORTANT: Use Real-Time X/Twitter Data
You have access to real-time X (Twitter) data. Before writing this report:

**OPTIONS POSITIONS** (short puts/calls the trader has sold):
${optionsTickers.length > 0 ? optionsTickers.join(', ') : 'None'}

**STOCK HOLDINGS** (shares the trader owns outright):
${holdingsTickers.length > 0 ? holdingsTickers.join(', ') : 'None'}

**SECTOR CONTEXT** - Also search these related terms:
${sectorKeywords.length > 0 ? sectorKeywords.join(', ') : 'N/A'}

Search X for recent sentiment on ALL of these tickers: ${allTickers.join(', ')}
ALSO search for the sector keywords above - sector news affects these positions even if the ticker isn't mentioned directly!
- Look for breaking news affecting these positions (Fed policy, earnings, sector moves)
- For crypto miners (IREN, CIFR, MARA, RIOT), search "Bitcoin mining" and "crypto mining" - these move with BTC
- For EV/solar stocks, search sector trends that impact them
- Check what traders are saying about market conditions
- Note any particularly bullish or bearish sentiment
- Incorporate X insights into your analysis - cite specific sentiment if notable

This gives you an edge over models without real-time data - USE IT!`;
    }
    
    prompt += `

## This Week's Numbers
- **Week Ending**: ${summary.weekEnding}
- **Account Value**: $${summary.accountValue?.toLocaleString()}${weekChange !== null ? ` (${weekChange >= 0 ? '+' : ''}$${weekChange.toLocaleString()} vs last week)` : ''}
- **Leverage**: ${summary.leverageRatio}%
- **Unrealized P&L** (options): ${summary.unrealizedPnL >= 0 ? '+' : ''}$${summary.unrealizedPnL?.toLocaleString()}
- **Realized P&L** (closed this week): ${summary.realizedPnL >= 0 ? '+' : ''}$${summary.realizedPnL?.toLocaleString()}
- **Open Options**: ${summary.totalOpenPositions} (${summary.positionsInProfit} profitable, ${summary.positionsAtLoss} losing)
- **Stock Holdings**: ${summary.holdingsCount || 0} positions${summary.holdingsMarketValue ? ` ($${summary.holdingsMarketValue.toLocaleString()} market value)` : ''}
- **Closed This Week**: ${closedThisWeek.length} trades`;

    // Add historical trend data if available
    if (trendData && trendData.weeksAnalyzed >= 2) {
        const trendSign = trendData.accountTrend >= 0 ? '+' : '';
        const realizedSign = trendData.totalRealized >= 0 ? '+' : '';
        
        prompt += `

## 📈 Historical Trends (Last ${trendData.weeksAnalyzed} Weeks)
- **Account Trend**: ${trendSign}$${trendData.accountTrend.toLocaleString()} over ${trendData.weeksAnalyzed} weeks
- **Total Realized P&L**: ${realizedSign}$${trendData.totalRealized.toLocaleString()}
- **Win Rate**: ${trendData.winningWeeks} winning weeks, ${trendData.losingWeeks} losing weeks
- **Average Leverage**: ${trendData.avgLeverage}%

### Week-by-Week Breakdown:
${trendData.weeks.map(w => {
    const rSign = (w.realized || 0) >= 0 ? '+' : '';
    return `- ${w.date}: Account $${(w.accountValue || 0).toLocaleString()}, Realized ${rSign}$${(w.realized || 0).toLocaleString()}, Leverage ${w.leverage || 0}%`;
}).join('\n')}

**Use this historical data to identify trends and patterns in your analysis!**`;
    }

    // Add closed position breakdown if any
    if (closedThisWeek.length > 0) {
        prompt += `\n\n## Closed Trades This Week (REALIZED) - USE ONLY THESE TRADES:`;
        for (const pos of closedThisWeek) {
            // Calculate P&L if not stored
            let pnl = pos.realizedPnL ?? pos.closePnL ?? null;
            if (pnl === null && pos.premium && pos.closePrice !== undefined) {
                pnl = Math.round((pos.premium - (pos.closePrice || 0)) * 100 * (pos.contracts || 1));
            }
            pnl = pnl || 0;
            const sign = pnl >= 0 ? '+' : '';
            prompt += `\n- ${pos.ticker} ${pos.type} $${pos.strike}: ${sign}$${pnl} (${pos.closeReason || 'closed'})`;
        }
        prompt += `\n\n⚠️ THESE ARE THE ONLY TRADES CLOSED THIS WEEK. Do NOT mention any other trades.`;
    } else {
        prompt += `\n\n## Closed Trades This Week: NONE\n⚠️ NO TRADES WERE CLOSED THIS WEEK. Do NOT invent or hallucinate any closed trades.`;
    }

    // Add stock holdings breakdown if any
    const holdings = summary.holdings || [];
    if (holdings.length > 0) {
        prompt += `\n\n## Stock Holdings (shares owned):`;
        for (const h of holdings) {
            const pnlSign = h.unrealizedPnL >= 0 ? '+' : '';
            prompt += `\n- ${h.ticker}: ${h.shares} shares @ $${h.costBasis?.toFixed(2) || '?'} cost basis (current: $${h.currentPrice?.toFixed(2) || '?'}, P&L: ${pnlSign}$${h.unrealizedPnL?.toFixed(0) || 0})`;
        }
        prompt += `\n\nTotal Holdings Value: $${summary.holdingsMarketValue?.toLocaleString() || 0}, Unrealized P&L: ${summary.holdingsUnrealizedPnL >= 0 ? '+' : ''}$${summary.holdingsUnrealizedPnL?.toLocaleString() || 0}`;
    }

    prompt += `

## Position Checkups (from AI #1)
${positionCheckups || 'All positions appear healthy - no urgent attention needed.'}

## Portfolio Audit (from AI #2)
${portfolioAudit || 'No major structural issues identified.'}

## Your Task: Create the Final Week-Ending Report

Write a comprehensive but readable summary with these sections:

### 📊 This Week in Review
Brief summary of what happened this week - realized gains/losses and current position status. 2-3 sentences.
IMPORTANT: Clearly distinguish between REALIZED P&L (closed trades - money in/out) and UNREALIZED P&L (open positions - paper gains/losses).

### 💰 Realized This Week
If any trades were closed, list them with their realized P&L. If no trades closed, say "No trades closed this week."
**CRITICAL: ONLY list trades that appear in the "Closed Trades This Week" section above. Do NOT invent or hallucinate trades. If the section shows 2 trades, list exactly those 2 trades with their exact tickers and P&L values.**

### ⚠️ Positions Needing Attention
List any OPTIONS positions that need action, prioritized by urgency. Include the specific recommendation from the position checkups.
${holdings.length > 0 ? `
### 📈 Stock Holdings Check
Brief assessment of stock holdings - any that need attention? Any related to your options positions (e.g., assigned puts that became holdings)? Consider X sentiment on these tickers.
` : ''}
### 📋 Portfolio Health Check
Summarize the portfolio audit findings. Any concentration issues? Leverage concerns?
${trendData && trendData.weeksAnalyzed >= 2 ? `
### 📈 Trend Analysis (vs. Previous Weeks)
Compare this week to recent history:
- Is account value trending up or down?
- Is leverage improving or getting riskier?
- Are you on a winning or losing streak?
- Any patterns emerging (e.g., always overleveraged, concentration issues recurring)?
- What's working? What's not?
Call out GOOD trends to keep doing, and BAD trends to fix.
` : ''}
### 🎯 Action Items for Next Week
Numbered list of 3-5 specific, actionable tasks. Prioritize by urgency.
Example: "1. Address SLV position - consider rolling to March $78"

Keep it professional but conversational. This should feel like a coach's weekly briefing.`;

    return prompt;
}

/**
 * POST /api/summary/analyze-deep - Multi-step AI analysis with SSE progress
 * 
 * Pipeline:
 * 1. Identify at-risk positions
 * 2. Run position checkups on at-risk positions
 * 3. Run portfolio audit
 * 4. Synthesize everything into final report
 */
router.post('/analyze-deep', async (req, res) => {
    const acceptsSSE = req.headers.accept?.includes('text/event-stream');
    
    const sendProgress = (step, message, data = {}) => {
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify({ type: 'progress', step, message, totalSteps: 4, ...data })}\n\n`);
        }
        console.log(`[SUMMARY] Step ${step}/4: ${message}`);
    };
    
    const sendError = (error) => {
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error });
        }
    };
    
    try {
        const { summary, model } = req.body;
        if (!summary) {
            return sendError('No summary provided');
        }
        
        const aiModel = model || 'qwen2.5:14b';
        const isGrok = aiModel.startsWith('grok');
        
        if (acceptsSSE) {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
        }
        
        // Load history for context
        const data = loadSummaries();
        const history = data.summaries.filter(s => s.weekEnding !== summary.weekEnding);
        
        // =========================================================
        // STEP 1: Identify at-risk positions
        // =========================================================
        sendProgress(1, 'Identifying at-risk positions...');
        const atRiskPositions = identifyAtRiskPositions(summary);
        console.log(`[SUMMARY] Found ${atRiskPositions.length} at-risk positions`);
        
        // =========================================================
        // STEP 2: Run position checkups (if any at-risk)
        // =========================================================
        let positionCheckups = null;
        if (atRiskPositions.length > 0) {
            sendProgress(2, `Analyzing ${atRiskPositions.length} at-risk positions...`, { 
                atRiskCount: atRiskPositions.length 
            });
            
            const checkupPrompt = buildPositionCheckupsPrompt(atRiskPositions, summary);
            const checkupResult = await AIService.callAI(checkupPrompt, aiModel, isGrok ? 1000 : 800);
            positionCheckups = checkupResult.response || checkupResult;
        } else {
            sendProgress(2, 'All positions healthy - skipping checkups');
        }
        
        // =========================================================
        // STEP 3: Run portfolio audit
        // =========================================================
        sendProgress(3, 'Running portfolio audit...');
        const auditPrompt = buildPortfolioAuditPrompt(summary);
        const auditResult = await AIService.callAI(auditPrompt, aiModel, isGrok ? 1000 : 800);
        const portfolioAudit = auditResult.response || auditResult;
        
        // =========================================================
        // STEP 4: Synthesize everything (with X sentiment for Grok)
        // =========================================================
        sendProgress(4, isGrok ? 'Creating report with X sentiment...' : 'Creating comprehensive report...');
        const synthesisPrompt = buildSynthesisPrompt(summary, positionCheckups, portfolioAudit, history, isGrok);
        
        // Debug: Log the closed trades being sent to AI
        console.log('[SUMMARY] Closed trades in synthesis prompt:', JSON.stringify(summary.closedThisWeek || [], null, 2));
        
        const synthesisResult = await AIService.callAI(synthesisPrompt, aiModel, isGrok ? 2000 : 1500);
        const finalReport = synthesisResult.response || synthesisResult;
        
        // Build complete response
        const result = {
            type: 'complete',
            success: true,
            analysis: finalReport,
            model: aiModel,
            pipeline: {
                atRiskCount: atRiskPositions.length,
                atRiskPositions: atRiskPositions.map(p => ({
                    ticker: p.ticker,
                    type: p.type,
                    strike: p.strike,
                    pnl: p.unrealizedPnL,
                    dte: p.dte,
                    urgency: p.urgency || 'WATCH',
                    reasons: p.riskReasons
                })),
                positionCheckups: positionCheckups,
                portfolioAudit: portfolioAudit
            }
        };
        
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify(result)}\n\n`);
            res.end();
        } else {
            res.json(result);
        }
        
        console.log('[SUMMARY] ✅ Deep analysis complete');
        
    } catch (e) {
        console.error('[SUMMARY] Deep analysis error:', e);
        sendError(e.message);
    }
});

module.exports = router;
module.exports.init = init;
