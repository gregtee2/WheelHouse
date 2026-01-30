/**
 * promptBuilders.js - AI Prompt Templates for WheelHouse
 * 
 * Contains all the prompt-building functions for AI analysis features.
 * These functions generate structured prompts for Ollama/Grok LLMs.
 * 
 * @module promptBuilders
 */

const { parseExpiryDate } = require('../utils/dateHelpers');
const { searchWisdom } = require('./WisdomService');

// ═══════════════════════════════════════════════════════════════════════════
// POSITION FLOW STAGES - Unified Context System
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Position Lifecycle Stages:
 * 
 * 1. DISCOVERY  - Finding trade ideas (Trade Ideas, Strategy Advisor, screeners)
 * 2. ANALYSIS   - Evaluating a specific trade before entry (Deep Dive, Discord Analyzer)
 * 3. ENTRY      - Position just opened, setting initial thesis
 * 4. ACTIVE     - Position is open, monitoring (Holding checkups, roll decisions)
 * 5. CLOSING    - Position being closed or assigned
 * 6. REVIEW     - Position closed, learning from it (Critique)
 * 
 * Each AI prompt should know:
 * - What stage we're in
 * - What previous AI recommendations exist for this position/ticker
 * - The full chain history if applicable
 * - Portfolio context (other positions, buying power, risk exposure)
 */

const POSITION_STAGES = {
    DISCOVERY: 'discovery',   // Finding ideas
    ANALYSIS: 'analysis',     // Evaluating before entry
    ENTRY: 'entry',           // Just opened
    ACTIVE: 'active',         // Monitoring open position
    CLOSING: 'closing',       // About to close/assign
    REVIEW: 'review'          // Post-mortem
};

// Standard recommendation vocabulary by stage
const RECOMMENDATIONS = {
    // Pre-entry (DISCOVERY, ANALYSIS)
    preEntry: ['STAGE', 'SKIP', 'WATCH', 'NEEDS_MORE_INFO'],
    
    // Active position (ENTRY, ACTIVE, CLOSING)
    active: ['HOLD', 'ROLL', 'LET_ASSIGN', 'BUY_BACK', 'CLOSE', 'SELL_CALL', 'TAKE_PROFIT'],
    
    // Post-close (REVIEW)
    review: ['GOOD_TRADE', 'LESSON_LEARNED', 'AVOID_PATTERN']
};

/**
 * Build unified position context for any AI prompt
 * This ensures all AI calls have awareness of the position's lifecycle
 * 
 * @param {Object} params
 * @param {string} params.stage - Current lifecycle stage (DISCOVERY, ANALYSIS, ACTIVE, etc.)
 * @param {string} params.ticker - The ticker symbol
 * @param {Object} params.position - Current position data (if exists)
 * @param {Object} params.portfolio - Portfolio context (optional)
 * @param {Array} params.chainHistory - Previous positions in this wheel chain (optional)
 * @param {Array} params.aiHistory - Previous AI recommendations for this position (optional)
 * @param {Object} params.openingThesis - Original thesis when position was opened (optional)
 * @returns {string} Formatted context block for prompts
 */
function buildPositionFlowContext(params) {
    const { 
        stage = POSITION_STAGES.ANALYSIS, 
        ticker,
        position,
        portfolio,
        chainHistory = [],
        aiHistory = [],
        openingThesis
    } = params;
    
    let context = `\n═══ POSITION LIFECYCLE CONTEXT ═══\n`;
    context += `CURRENT STAGE: ${stage.toUpperCase()}\n`;
    
    // Stage-specific guidance
    const stageGuidance = {
        [POSITION_STAGES.DISCOVERY]: 'You are helping find NEW trade opportunities. Focus on risk/reward and portfolio fit.',
        [POSITION_STAGES.ANALYSIS]: 'You are evaluating a SPECIFIC trade before entry. Give clear STAGE or SKIP recommendation.',
        [POSITION_STAGES.ENTRY]: 'Position just opened. Establish the thesis and key levels to watch.',
        [POSITION_STAGES.ACTIVE]: 'Position is OPEN. Evaluate current conditions vs. entry thesis. What action now?',
        [POSITION_STAGES.CLOSING]: 'Position is being closed or assigned. Focus on execution and next steps.',
        [POSITION_STAGES.REVIEW]: 'Position is CLOSED. Focus on lessons learned, not regret.'
    };
    context += `GUIDANCE: ${stageGuidance[stage] || stageGuidance[POSITION_STAGES.ANALYSIS]}\n`;
    
    // Add valid recommendations for this stage
    let validRecs = RECOMMENDATIONS.active;
    if (stage === POSITION_STAGES.DISCOVERY || stage === POSITION_STAGES.ANALYSIS) {
        validRecs = RECOMMENDATIONS.preEntry;
    } else if (stage === POSITION_STAGES.REVIEW) {
        validRecs = RECOMMENDATIONS.review;
    }
    context += `VALID RECOMMENDATIONS: ${validRecs.join(', ')}\n`;
    
    // Chain history (wheel continuity)
    if (chainHistory.length > 0) {
        context += `\n── WHEEL CHAIN HISTORY (${chainHistory.length} positions) ──\n`;
        let totalPremium = 0;
        chainHistory.forEach((p, i) => {
            const prem = (p.premium || 0) * 100 * (p.contracts || 1);
            const close = (p.closePrice || 0) * 100 * (p.contracts || 1);
            totalPremium += prem - close;
            context += `${i + 1}. ${p.type} $${p.strike} ${p.expiry} - Premium: $${prem.toFixed(0)}`;
            if (p.status === 'closed') {
                context += ` → ${p.closeReason || 'closed'} (P&L: $${(p.realizedPnL || p.closePnL || 0).toFixed(0)})`;
            }
            context += '\n';
        });
        context += `NET PREMIUM COLLECTED: $${totalPremium.toFixed(0)}\n`;
        context += `ROLLS IN CHAIN: ${chainHistory.filter(p => p.closeReason === 'rolled').length}\n`;
    }
    
    // Previous AI recommendations for this position
    if (aiHistory.length > 0) {
        context += `\n── PREVIOUS AI RECOMMENDATIONS ──\n`;
        // Show last 3 AI calls
        aiHistory.slice(-3).forEach((ai, i) => {
            const date = ai.timestamp ? new Date(ai.timestamp).toLocaleDateString() : 'Unknown';
            context += `${date}: ${ai.recommendation || 'N/A'}`;
            if (ai.model) context += ` (${ai.model})`;
            context += '\n';
        });
        
        // Note if recommendation changed
        if (aiHistory.length > 1) {
            const last = aiHistory[aiHistory.length - 1]?.recommendation;
            const prev = aiHistory[aiHistory.length - 2]?.recommendation;
            if (last && prev && last !== prev) {
                context += `⚠️ Last AI changed from ${prev} → ${last}\n`;
            }
        }
    }
    
    // Opening thesis (what was the original plan?)
    if (openingThesis) {
        context += `\n── OPENING THESIS ──\n`;
        context += `Opened: ${openingThesis.analyzedAt ? new Date(openingThesis.analyzedAt).toLocaleDateString() : 'Unknown'}\n`;
        if (openingThesis.priceAtAnalysis) context += `Entry price: $${openingThesis.priceAtAnalysis}\n`;
        if (openingThesis.iv) context += `Entry IV: ${openingThesis.iv}%\n`;
        if (openingThesis.aiSummary?.bottomLine) {
            context += `Original thesis: ${openingThesis.aiSummary.bottomLine}\n`;
        }
    }
    
    // Portfolio context (what else do we own?)
    if (portfolio) {
        context += `\n── PORTFOLIO CONTEXT ──\n`;
        if (portfolio.buyingPower) context += `Buying Power: $${portfolio.buyingPower.toLocaleString()}\n`;
        if (portfolio.netDelta !== undefined) context += `Portfolio Delta: ${portfolio.netDelta > 0 ? '+' : ''}${portfolio.netDelta}\n`;
        if (portfolio.positionCount) context += `Open Positions: ${portfolio.positionCount}\n`;
        
        // Note if we already have positions in this ticker
        if (portfolio.tickerPositions && portfolio.tickerPositions.length > 0) {
            context += `⚠️ Already have ${portfolio.tickerPositions.length} position(s) in ${ticker}\n`;
        }
    }
    
    context += `═══════════════════════════════════\n\n`;
    return context;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEEP DIVE ANALYSIS PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build deep dive analysis prompt for wheel strategy trades
 * @param {Object} tradeData - Trade parameters (ticker, strike, expiry, currentPrice)
 * @param {Object} tickerData - Market data for ticker
 * @returns {string} Formatted prompt
 */
function buildDeepDivePrompt(tradeData, tickerData) {
    const { ticker, strike, expiry, currentPrice, quickMode } = tradeData;
    const t = tickerData;
    
    const strikeNum = parseFloat(strike);
    const priceNum = parseFloat(currentPrice || t.price);
    const otmPercent = ((priceNum - strikeNum) / priceNum * 100).toFixed(1);
    const assignmentCost = strikeNum * 100;
    
    // Format premium data if available
    let premiumSection = '';
    if (t.premium) {
        const p = t.premium;
        const premiumPerShare = p.mid.toFixed(2);
        const totalPremium = (p.mid * 100).toFixed(0);
        const costBasis = (strikeNum - p.mid).toFixed(2);
        const roc = ((p.mid / strikeNum) * 100).toFixed(2);
        
        // Calculate DTE for annualized ROC
        const expiryParts = expiry.match(/(\w+)\s+(\d+)/);
        let dte = 30; // Default
        if (expiryParts) {
            const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
            const expMonth = monthMap[expiryParts[1]];
            const expDay = parseInt(expiryParts[2]);
            const expYear = expMonth < new Date().getMonth() ? new Date().getFullYear() + 1 : new Date().getFullYear();
            const expDate = new Date(expYear, expMonth, expDay);
            dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
        }
        const annualizedRoc = ((p.mid / strikeNum) * (365 / dte) * 100).toFixed(1);
        
        // Probability of profit from delta (if available)
        let probProfit = '';
        if (p.delta) {
            const pop = ((1 - Math.abs(p.delta)) * 100).toFixed(0);
            probProfit = ` | Win Prob: ~${pop}%`;
        }
        
        premiumSection = `
LIVE PREMIUM (CBOE): Bid $${p.bid.toFixed(2)} / Ask $${p.ask.toFixed(2)}${probProfit}
ROC: ${roc}% for ${dte} days (${annualizedRoc}% annualized)`;
    }
    
    // Concise prompt - straight to the point, no rambling
    return `QUICK WHEEL ANALYSIS for ${ticker}

STOCK: ${ticker} @ $${currentPrice || t.price}
EXAMPLE TRADE: Sell $${strike} put (${otmPercent}% OTM), expiry ${expiry}
52-Week: $${t.yearLow} - $${t.yearHigh}
Support Levels: $${t.recentSupport.join(', $')}
${t.sma20 ? `20-Day SMA: $${t.sma20} (${t.aboveSMA20 ? 'above' : 'BELOW'})` : ''}
${t.earnings ? `⚠️ Earnings: ${t.earnings}` : 'No upcoming earnings'}
${premiumSection}

Give me a CONCISE analysis. NO rambling, NO "let me think about this", NO chain-of-thought. Just the facts:

📊 **THE SETUP** (2-3 sentences max)
Quick take on ${ticker} right now - trend, recent price action, any catalysts.

🎯 **STRIKE OPTIONS** (be specific with numbers)
- SAFE: $XX strike (XX% OTM) - for cautious traders
- BALANCED: $XX strike (XX% OTM) - good risk/reward
- AGGRESSIVE: $XX strike (XX% OTM) - more premium, more risk

⏰ **TIMING**
Is now a good entry? Any reason to wait (earnings, technicals, etc.)?

${t.premium ? `💰 **THIS SPECIFIC TRADE ($${strike} put)**
Is this strike/expiry good? Quick yes/no with one reason.` : ''}

**VERDICT**: ✅ ENTER / ⚠️ WAIT / ❌ AVOID
One sentence why.

Keep your ENTIRE response under 250 words. Be decisive.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION CHECKUP PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for position checkup - compares opening thesis to current state
 * @param {Object} tradeData - Position info (ticker, strike, expiry, positionType)
 * @param {Object} openingThesis - State when position was opened
 * @param {Object} currentData - Current market data
 * @param {Object} currentPremium - Current option pricing
 * @param {Array} analysisHistory - Prior checkup results (optional)
 * @param {string} userNotes - User's strategy notes/intent (optional)
 * @returns {string} Formatted prompt
 */
function buildCheckupPrompt(tradeData, openingThesis, currentData, currentPremium, analysisHistory = [], userNotes = null, monteCarlo = null) {
    const { ticker, strike, expiry, positionType, buyStrike, spreadWidth, isSpread } = tradeData;
    const o = openingThesis; // Opening state
    const c = currentData;   // Current state
    const history = analysisHistory || [];
    const notes = userNotes?.trim() || null;
    const mc = monteCarlo;   // Monte Carlo probability data
    
    // Determine if this is a LONG (debit) position - different evaluation!
    const isLongPosition = ['long_call', 'long_put', 'long_call_leaps', 'skip_call', 'call_debit_spread', 'put_debit_spread'].includes(positionType);
    const isCall = positionType?.includes('call');
    const isCreditSpread = ['call_credit_spread', 'put_credit_spread'].includes(positionType);
    const isDebitSpread = ['call_debit_spread', 'put_debit_spread'].includes(positionType);
    
    // Build position description - handle spreads
    let positionDesc;
    if (isSpread || isCreditSpread || isDebitSpread) {
        // For spreads, show both strikes
        const spreadName = positionType?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        positionDesc = `${spreadName} - Sell $${strike} / Buy $${buyStrike} (${spreadWidth || Math.abs(strike - buyStrike)}w)`;
    } else if (isLongPosition) {
        positionDesc = `Long $${strike} ${isCall ? 'call' : 'put'}`;
    } else {
        positionDesc = `Short $${strike} ${isCall ? 'call' : 'put'}`;
    }
    
    // Parse prices as numbers (they might come as strings from API)
    const currentPrice = parseFloat(c.price) || 0;
    const entryPrice = parseFloat(o.priceAtAnalysis) || 0;
    
    // Calculate changes
    const priceChange = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : 0;
    const priceDirection = priceChange >= 0 ? '📈 UP' : '📉 DOWN';
    
    // Range position: 0% = at low, 100% = at high
    const openingRange = o.rangePosition !== undefined ? o.rangePosition : 'N/A';
    const threeMonthHigh = parseFloat(c.threeMonthHigh) || 0;
    const threeMonthLow = parseFloat(c.threeMonthLow) || 0;
    const currentRange = (threeMonthHigh && threeMonthLow && threeMonthHigh !== threeMonthLow) ? 
        (((currentPrice - threeMonthLow) / (threeMonthHigh - threeMonthLow)) * 100).toFixed(0) : 'N/A';
    
    // Days since analysis
    const daysSinceOpen = Math.floor((Date.now() - new Date(o.analyzedAt).getTime()) / (1000 * 60 * 60 * 24));
    
    // DTE calculation
    const expDate = new Date(expiry);
    const dte = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));
    
    // Format premium comparison - opposite meaning for long vs short!
    let premiumChange = '';
    if (o.premium && currentPremium) {
        const openMid = parseFloat(o.premium.mid) || 0;
        const currMid = parseFloat(currentPremium.mid) || 0;
        const pctChange = openMid > 0 ? ((currMid - openMid) / openMid * 100).toFixed(0) : 0;
        
        // For LONG options: you want premium to INCREASE (buy low, sell high)
        // For SHORT options: you want premium to DECREASE (sell high, buy back low)
        const profitMessage = isLongPosition
            ? (currMid > openMid ? '✅ Premium has INCREASED - position is PROFITABLE' : '⚠️ Premium has DECREASED - position is underwater')
            : (currMid < openMid ? '✅ Premium has DECAYED - trade is profitable' : '⚠️ Premium has INCREASED - trade is underwater');
        
        premiumChange = `
OPTION PREMIUM MOVEMENT:
At Entry: $${openMid.toFixed(2)} mid
Now: $${currMid.toFixed(2)} mid (${pctChange >= 0 ? '+' : ''}${pctChange}%)
${profitMessage}`;
    }
    
    // Determine win condition based on position type
    const isPut = positionType?.toLowerCase().includes('put');
    const isShortPosition = !isLongPosition;
    let winCondition = '';
    
    // Handle spreads first
    if (isCreditSpread) {
        if (isPut) {
            // Put credit spread - win if stock stays ABOVE the short put strike
            winCondition = `🎯 WIN CONDITION (Credit Spread): Stock must stay ABOVE $${strike} (short strike) for max profit ($${spreadWidth || Math.abs(strike - buyStrike)} per share). Currently ${currentPrice > strike ? '✅ ABOVE short strike (good!)' : '⚠️ BELOW short strike (in trouble!)'}`;
        } else {
            // Call credit spread - win if stock stays BELOW the short call strike
            winCondition = `🎯 WIN CONDITION (Credit Spread): Stock must stay BELOW $${strike} (short strike) for max profit. Currently ${currentPrice < strike ? '✅ BELOW short strike (good!)' : '⚠️ ABOVE short strike (in trouble!)'}`;
        }
    } else if (isDebitSpread) {
        if (isPut) {
            // Put debit spread - win if stock goes BELOW the short put strike
            winCondition = `🎯 WIN CONDITION (Debit Spread): Stock must fall BELOW $${buyStrike} for max profit. Currently ${currentPrice < buyStrike ? '✅ BELOW long strike (max profit!)' : '⚠️ ABOVE long strike'}`;
        } else {
            // Call debit spread - win if stock goes ABOVE the short call strike
            winCondition = `🎯 WIN CONDITION (Debit Spread): Stock must rise ABOVE $${strike} for max profit. Currently ${currentPrice > strike ? '✅ ABOVE short strike (max profit!)' : '⚠️ BELOW short strike'}`;
        }
    } else if (isShortPosition && isPut) {
        winCondition = `🎯 WIN CONDITION: Stock must stay ABOVE $${strike} for put to expire worthless. Currently ${currentPrice > strike ? '✅ ABOVE strike (good!)' : '⚠️ BELOW strike (in trouble!)'}`;
    } else if (isShortPosition && !isPut) {
        winCondition = `🎯 WIN CONDITION: Stock must stay BELOW $${strike} for call to expire worthless. Currently ${currentPrice < strike ? '✅ BELOW strike (good!)' : '⚠️ ABOVE strike (in trouble!)'}`;
    } else if (isLongPosition && isCall) {
        winCondition = `🎯 WIN CONDITION: Stock must rise ABOVE $${strike} + premium for profit. Currently ${currentPrice > strike ? '✅ ITM' : '⚠️ OTM'}`;
    } else if (isLongPosition && !isCall) {
        winCondition = `🎯 WIN CONDITION: Stock must fall BELOW $${strike} - premium for profit. Currently ${currentPrice < strike ? '✅ ITM' : '⚠️ OTM'}`;
    }
    
    // Build instruction block (for AI understanding, NOT to be echoed in output)
    let aiInstructions = '';
    if (isCreditSpread && isPut) {
        aiInstructions = `
═══ IMPORTANT INSTRUCTIONS (DO NOT ECHO THESE IN YOUR RESPONSE) ═══
For this PUT CREDIT SPREAD position (Sell $${strike} / Buy $${buyStrike}):
- Max profit achieved if stock stays ABOVE $${strike} (short strike) at expiry
- Max loss if stock falls BELOW $${buyStrike} (long strike) at expiry
- The thesis is VALID if stock is ABOVE $${strike}, at risk if between strikes, INVALID if BELOW $${buyStrike}
- Current stock: $${currentPrice} → ${currentPrice > strike ? 'ABOVE short strike = MAX PROFIT ZONE' : currentPrice > buyStrike ? 'BETWEEN strikes = PARTIAL' : 'BELOW long strike = MAX LOSS'}
- In your response, state the current profit/loss status based on where stock is relative to BOTH strikes
═══ END INSTRUCTIONS ═══
`;
    } else if (isCreditSpread && !isPut) {
        aiInstructions = `
═══ IMPORTANT INSTRUCTIONS (DO NOT ECHO THESE IN YOUR RESPONSE) ═══
For this CALL CREDIT SPREAD position (Sell $${strike} / Buy $${buyStrike}):
- Max profit achieved if stock stays BELOW $${strike} (short strike) at expiry
- Max loss if stock rises ABOVE $${buyStrike} (long strike) at expiry
- The thesis is VALID if stock is BELOW $${strike}, at risk if between strikes, INVALID if ABOVE $${buyStrike}
- Current stock: $${currentPrice} → ${currentPrice < strike ? 'BELOW short strike = MAX PROFIT ZONE' : currentPrice < buyStrike ? 'BETWEEN strikes = PARTIAL' : 'ABOVE long strike = MAX LOSS'}
- In your response, state the current profit/loss status based on where stock is relative to BOTH strikes
═══ END INSTRUCTIONS ═══
`;
    } else if (isShortPosition && isPut) {
        aiInstructions = `
═══ IMPORTANT INSTRUCTIONS (DO NOT ECHO THESE IN YOUR RESPONSE) ═══
For this SHORT PUT position:
- The thesis is VALID if stock is ABOVE $${strike}, INVALID if BELOW $${strike}
- Current stock: $${currentPrice} → ${currentPrice > strike ? 'ABOVE strike = THESIS VALID' : 'BELOW strike = THESIS BROKEN'}
- Price movement from entry is NOT relevant to thesis validity - only the strike matters
- Do NOT say "thesis invalidated because price dropped" if stock is still above strike
- In your response, simply state whether thesis is valid/invalid based on stock vs strike
═══ END INSTRUCTIONS ═══
`;
    } else if (isShortPosition && !isPut) {
        aiInstructions = `
═══ IMPORTANT INSTRUCTIONS (DO NOT ECHO THESE IN YOUR RESPONSE) ═══
For this SHORT CALL position:
- The thesis is VALID if stock is BELOW $${strike}, INVALID if ABOVE $${strike}
- Current stock: $${currentPrice} → ${currentPrice < strike ? 'BELOW strike = THESIS VALID' : 'ABOVE strike = THESIS BROKEN'}
- Price movement from entry is NOT relevant to thesis validity - only the strike matters
- In your response, simply state whether thesis is valid/invalid based on stock vs strike
═══ END INSTRUCTIONS ═══
`;
    }
    
    // Build strikes display based on position type
    const strikesDisplay = (isSpread || isCreditSpread || isDebitSpread)
        ? `Sell Strike: $${strike}\nBuy Strike: $${buyStrike}\nSpread Width: $${spreadWidth || Math.abs(strike - buyStrike)}`
        : `Strike: $${strike}`;
    
    // Build user notes section if present
    const userNotesSection = notes ? `
═══ ⚠️ USER'S STRATEGY INTENT ═══
The trader has explicitly noted their strategy for this position:
"${notes}"

🚨 CRITICAL: This overrides default recommendations! 
- If user says "take assignment and wheel", do NOT recommend closing to avoid assignment
- If user says "letting it ride", do NOT suggest early exit unless catastrophic
- Align your recommendation with THEIR stated strategy, not generic advice
- You may WARN about risks, but respect their decision

` : '';
    
    return `You are conducting a POSITION CHECKUP for ${isLongPosition ? 'a LONG option position' : isCreditSpread || isDebitSpread ? 'an option spread' : 'a wheel trade'}. Compare the opening thesis to current conditions.
${aiInstructions}${userNotesSection}═══ THE POSITION ═══
Ticker: ${ticker}
Trade: ${positionDesc}, expiry ${expiry}
Position Type: ${isCreditSpread ? '🔷 CREDIT SPREAD - Collected premium, max profit if expires OTM' : isDebitSpread ? '🔶 DEBIT SPREAD - Paid premium, max profit if expires deep ITM' : isLongPosition ? '🟠 LONG (debit) - You PAID premium and profit from DIRECTION, not theta!' : '🟢 SHORT (credit) - You collected premium and profit from theta decay'}
${winCondition}
${strikesDisplay}
Days to Expiry: ${dte}
Days Held: ${daysSinceOpen}

═══ THEN vs NOW ═══

PRICE MOVEMENT:
At Entry (${new Date(o.analyzedAt).toLocaleDateString()}): $${entryPrice.toFixed(2)}
Now: $${currentPrice.toFixed(2)} (${priceDirection} ${Math.abs(priceChange)}%)

RANGE POSITION (0% = 3mo low, 100% = 3mo high):
At Entry: ${openingRange}% of range
Now: ${currentRange}% of range
${currentRange !== 'N/A' && openingRange !== 'N/A' ? (
  parseFloat(currentRange) > parseFloat(openingRange) 
    ? (isLongPosition && isCall ? '📈 Stock has moved UP in range (GOOD for long call!)' : isLongPosition ? '📈 Stock has moved UP in range (bad for long put)' : '📈 Stock has moved UP in range (good for short put)')
    : parseFloat(currentRange) < parseFloat(openingRange) 
    ? (isLongPosition && isCall ? '📉 Stock has moved DOWN in range (bad for long call)' : isLongPosition ? '📉 Stock has moved DOWN in range (GOOD for long put!)' : '📉 Stock has moved DOWN in range (closer to strike)')
    : '➡️ Roughly the same position'
) : ''}

TECHNICAL LEVELS:
Entry SMA20: $${o.sma20 || 'N/A'} | Now: $${c.sma20 || 'N/A'}
Entry SMA50: $${o.sma50 || 'N/A'} | Now: $${c.sma50 || 'N/A'}
Entry Support: $${o.support?.join(', $') || 'N/A'}
Current Support: $${c.recentSupport?.join(', $') || 'N/A'}

IMPLIED VOLATILITY:
At Entry: ${o.iv ? o.iv + '%' : 'N/A'}
Now: ${c.currentIV ? c.currentIV + '% (from ' + (c.ivSource || 'CBOE') + ')' : 'N/A'}
${o.iv && c.currentIV ? (parseFloat(c.currentIV) > parseFloat(o.iv) 
    ? `📈 IV has INCREASED by ${(parseFloat(c.currentIV) - parseFloat(o.iv)).toFixed(1)}% - ${isLongPosition ? 'Good for you (vega gain)!' : 'Option more expensive to close'}`
    : parseFloat(c.currentIV) < parseFloat(o.iv)
    ? `📉 IV has DECREASED by ${(parseFloat(o.iv) - parseFloat(c.currentIV)).toFixed(1)}% - ${isLongPosition ? 'Bad for you (vega loss)' : 'Good for you! Cheaper to close'}`
    : '➡️ IV roughly unchanged') : ''}
${premiumChange}

CALENDAR EVENTS:
Entry Earnings: ${o.earnings || 'None scheduled'}
Current Earnings: ${c.earnings || 'None scheduled'}
${o.earnings && !c.earnings ? '✅ Earnings have PASSED - thesis event resolved' : ''}
${!o.earnings && c.earnings ? '⚠️ NEW earnings date appeared!' : ''}

═══ ORIGINAL ENTRY THESIS ═══
📊 MARKET CONDITIONS AT ENTRY (${new Date(o.analyzedAt).toLocaleDateString()})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Stock Price: $${entryPrice.toFixed(2)}
IV at Entry: ${o.iv || 'N/A'}%
Range Position: ${openingRange}% (0%=3mo low, 100%=3mo high)
Model Used: ${o.modelUsed || 'N/A'}
${o.expertMode ? `
📝 WALL STREET MODE ANALYSIS:
MARKET ANALYSIS: ${o.aiSummary?.marketAnalysis || 'N/A'}
WHY THIS STRATEGY: ${o.aiSummary?.whyThisStrategy || 'N/A'}
RISKS IDENTIFIED: ${o.aiSummary?.theRisks || 'N/A'}
TRADE MANAGEMENT: ${o.aiSummary?.tradeManagement || 'N/A'}
` : (o.aiSummary?.aggressive?.trim() || o.aiSummary?.bottomLine?.trim()) ? `
📝 ENTRY THESIS SPECTRUM:
🟢 AGGRESSIVE: ${o.aiSummary?.aggressive?.trim() || 'N/A'}
🟡 MODERATE: ${o.aiSummary?.moderate?.trim() || 'N/A'}
🔴 CONSERVATIVE: ${o.aiSummary?.conservative?.trim() || 'N/A'}
📌 BOTTOM LINE: ${o.aiSummary?.bottomLine?.trim() || 'N/A'}
${o.aiSummary?.probability ? `WIN PROBABILITY: ${o.aiSummary.probability}%` : ''}
` : o.aiSummary?.fullAnalysis?.trim() ? `
📝 ENTRY ANALYSIS:
${o.aiSummary.fullAnalysis.substring(0, 500)}
` : `
📝 ENTRY ANALYSIS: No detailed AI analysis was captured at entry. Use the market conditions above to assess whether original thesis is still valid.
`}
${history.length > 0 ? `
═══ PRIOR CHECKUPS (${history.length} total) ═══
${history.slice(-5).map((h, i) => {
    const checkDate = new Date(h.timestamp).toLocaleDateString();
    const daysAgo = Math.floor((Date.now() - new Date(h.timestamp).getTime()) / (1000 * 60 * 60 * 24));
    return `
📋 CHECKUP #${history.length - (history.slice(-5).length - 1 - i)} (${checkDate} - ${daysAgo} days ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Recommendation: ${h.recommendation || 'N/A'}
Stock Price: $${h.snapshot?.spot?.toFixed(2) || 'N/A'} | DTE: ${h.snapshot?.dte || 'N/A'}
Insight: ${h.insight?.substring(0, 200) || 'N/A'}...`;
}).join('\n')}

⚠️ IMPORTANT: Consider the TREND of prior checkups. Is the position getting healthier or deteriorating?
` : ''}
${mc ? `
═══ 🎲 MONTE CARLO SIMULATION (${mc.numPaths?.toLocaleString() || '5,000'} paths) ═══
📊 PROBABILITY ESTIMATES USING ${mc.iv || 'N/A'} IMPLIED VOLATILITY

SIMULATED PRICE DISTRIBUTION AT EXPIRY (${mc.dte || 'N/A'} DTE):
┌─────────────────────────────────────────┐
│ 10th percentile: ${mc.priceRange?.p10 || 'N/A'} (bearish scenario)
│ 25th percentile: ${mc.priceRange?.p25 || 'N/A'}
│ 50th percentile: ${mc.priceRange?.median || 'N/A'} (expected/median)
│ 75th percentile: ${mc.priceRange?.p75 || 'N/A'}
│ 90th percentile: ${mc.priceRange?.p90 || 'N/A'} (bullish scenario)
└─────────────────────────────────────────┘

OUTCOME PROBABILITIES:
🎯 Probability of MAX PROFIT: ${mc.probabilities?.maxProfit || 'N/A'}
${isCreditSpread || isDebitSpread ? `   (Stock ${isPut ? 'stays above' : 'stays below'} short strike $${strike})` : 
  `   (Option expires worthless, keep full premium)`}

✅ Probability of PROFIT: ${mc.probabilities?.profitable || 'N/A'}
   (Stock finishes ${isPut ? 'above' : 'below'} breakeven $${mc.strikes?.breakeven || 'N/A'})

❌ Probability of MAX LOSS: ${mc.probabilities?.maxLoss || 'N/A'}
${isCreditSpread || isDebitSpread ? `   (Stock ${isPut ? 'falls below' : 'rises above'} long strike $${buyStrike})` : 
  `   (Deep ITM at expiry)`}

📈 Stock finishes ABOVE short strike ($${strike}): ${mc.probabilities?.aboveShortStrike || 'N/A'}
📉 Stock finishes BELOW short strike ($${strike}): ${mc.probabilities?.belowShortStrike || 'N/A'}

🚨 USE THESE PROBABILITIES to inform your recommendation!
- If max profit probability > 70%, likely HOLD
- If max loss probability > 40%, consider CLOSE or ROLL
- If profitable probability < 50%, position is at risk
` : ''}
═══ YOUR CHECKUP ASSESSMENT ═══

**1. THESIS STATUS**
${isShortPosition && isPut ? 
    (currentPrice > strike ? 
        `Stock at $${currentPrice} is ABOVE $${strike} strike → Thesis is VALID. Assess if it will stay above strike through expiry.` : 
        `Stock at $${currentPrice} is BELOW $${strike} strike → Thesis is BROKEN. Assignment risk is high.`)
: isShortPosition && !isPut ? 
    (currentPrice < strike ? 
        `Stock at $${currentPrice} is BELOW $${strike} strike → Thesis is VALID. Assess if it will stay below strike through expiry.` : 
        `Stock at $${currentPrice} is ABOVE $${strike} strike → Thesis is BROKEN. Assignment risk is high.`)
: `Has the original reason for entry been validated, invalidated, or is it still playing out?`}

**2. RISK ASSESSMENT**
${isShortPosition && isPut ? `
🎯 SHORT PUT RISK CHECK: 
- Stock MUST STAY ABOVE $${strike} for put to expire worthless!
- Current: $${currentPrice} | Strike: $${strike} | Buffer: $${(currentPrice - strike).toFixed(2)} ${currentPrice > strike ? '✅ (safe zone)' : '❌ (IN THE MONEY - assignment risk!)'}
- Entry price was: $${o.priceAtAnalysis || 'unknown'} → Stock moved ${currentPrice > (o.priceAtAnalysis || currentPrice) ? '⬆️ UP (good for short put)' : '⬇️ DOWN (bad for short put)'}
- Key question: Are support levels holding? If stock breaks below $${strike}, you WILL be assigned.`
: isShortPosition && isCall ? `
🎯 SHORT CALL RISK CHECK:
- Stock MUST STAY BELOW $${strike} for call to expire worthless!
- Current: $${currentPrice} | Strike: $${strike} | Buffer: $${(strike - currentPrice).toFixed(2)} ${currentPrice < strike ? '✅ (safe zone)' : '❌ (IN THE MONEY - assignment risk!)'}
- Key question: Will the stock stay below $${strike}?`
: `
- Distance from strike: Is the stock now closer or further from $${strike}?`}
- Support levels: Have they held or broken?
- Probability of assignment: ${isShortPosition ? 'Higher, lower, or same as at entry?' : 'N/A for long positions'}

**3. TIME DECAY / THETA**
With ${dte} days remaining:
${isLongPosition ? `⚠️ IMPORTANT: This is a LONG (debit) position - theta works AGAINST you!
- Negative theta is EXPECTED and NOT a problem - it's the cost of holding the position.
- You profit from DELTA (directional move), not theta decay.
- ${dte >= 365 ? '📅 LEAPS: Daily theta is tiny! Focus on thesis, not time decay.' : dte >= 180 ? '⏳ Long-dated: Theta decay is slow. Direction matters more.' : 'Theta accelerates under 45 DTE - time is working against you.'}` : dte >= 365 ? `- 📅 LEAPS EVALUATION: Daily theta is MINIMAL for long-dated options!
- Focus on: Has the THESIS played out? Stock direction matters more than time decay.
- VEGA matters: Has IV changed significantly since entry?` : dte >= 180 ? `- ⏳ LONG-DATED: Theta decay is slow. Focus on directional thesis and IV changes.` : `- Is theta working for you? (Short options COLLECT theta)
- How much of the original premium has decayed?`}

**4. ACTION RECOMMENDATION**
${!isLongPosition && isCall && currentPrice > strike ? `
⚠️ YOUR COVERED CALL IS ITM - Consider ALL options, not just rolling!

ALTERNATIVES TO ROLLING:
• 🎯 LET IT GET CALLED - Take your profit and redeploy capital
• 📈 BUY A LONG CALL - Buy a call above current price to capture more upside
• 📊 BUY A CALL DEBIT SPREAD - Defined risk way to participate in further rally
• 💰 SELL PUTS BELOW - Add bullish exposure if you'd buy more on a pullback
• 🔄 ROLL UP & OUT - Traditional approach, but may be fighting the trend

Pick ONE:
- ✅ HOLD - Let position get called away (take the win!)
- 📈 ADD UPSIDE - Buy a long call or call spread to capture more gains
- 💰 ADD EXPOSURE - Sell puts below to add bullish delta
- 🔄 ROLL - Roll up/out (explain why this beats taking assignment)
- ⚠️ CLOSE EARLY - Buy back call to keep shares (expensive but keeps upside)` : `Pick ONE:
${dte >= 365 ? `- ✅ HOLD - LEAPS are meant to be held; thesis still valid
- 🔄 ROLL UP/DOWN - Adjust strike if stock moved significantly (not for time!)
- 💰 CLOSE - Take profit if thesis achieved or invalidated
- 📈 ADD - Consider adding on pullback if thesis strengthening` : `- ✅ HOLD - Thesis intact, let it ride
- 🔄 ROLL - Consider rolling (specify why - expiry, strike, or both)
- 💰 CLOSE - Take profit/loss now (specify when)
- ⚠️ WATCH - Position needs monitoring (specify triggers)`}`}

**5. CHECKUP VERDICT**
Rate the position health:
- 🟢 HEALTHY - On track, no action needed
- 🟡 STABLE - Minor concerns but manageable
- 🔴 AT RISK - Original thesis weakening, action may be needed

Give a 2-3 sentence summary of how the position has evolved since entry.

**6. SUGGESTED TRADE**
If you recommend ROLL, CLOSE, ADD, or WATCH with a specific action trigger, provide trade details.
If recommending HOLD with no changes, output: "No trade action required - HOLD position."
Otherwise, format EXACTLY like this (we will parse it):

===SUGGESTED_TRADE===
ACTION: ROLL|CLOSE|ADD_CALL|ADD_PUT|NONE
CLOSE_STRIKE: ${strike}
CLOSE_EXPIRY: ${expiry}
CLOSE_TYPE: ${isCall ? 'CALL' : 'PUT'}
NEW_STRIKE: [new strike price, or "N/A" if just closing]
NEW_EXPIRY: [new expiry YYYY-MM-DD, or "N/A" if just closing]
NEW_TYPE: CALL|PUT|N/A
ESTIMATED_DEBIT: [estimated cost to execute, e.g. "$1.50" or "N/A"]
ESTIMATED_CREDIT: [estimated credit received, e.g. "$3.50" or "N/A"]
NET_COST: [net debit/credit, e.g. "-$1.50 debit" or "+$2.00 credit"]
RATIONALE: [One sentence explaining why this specific trade]
===END_TRADE===

Example for rolling a $87 call up to $110:
===SUGGESTED_TRADE===
ACTION: ROLL
CLOSE_STRIKE: 87
CLOSE_EXPIRY: 2026-03-06
CLOSE_TYPE: CALL
NEW_STRIKE: 110
NEW_EXPIRY: 2026-05-15
NEW_TYPE: CALL
ESTIMATED_DEBIT: $20.00
ESTIMATED_CREDIT: $4.00
NET_COST: -$16.00 debit
RATIONALE: Roll up to capture additional upside while collecting new premium
===END_TRADE===`;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCORD TRADE PARSING PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt to parse Discord/chat trade callout into structured JSON
 * @param {string} tradeText - Raw trade callout text
 * @returns {string} Formatted prompt
 */
function buildTradeParsePrompt(tradeText) {
    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;
    
    return `Parse this trade callout into JSON. Extract the key fields.

TODAY'S DATE: ${new Date().toISOString().split('T')[0]} (use this for context)

TRADE CALLOUT:
${tradeText}

INSTRUCTIONS:
1. Extract: ticker, strategy, expiry, strike(s), premium/entry price
2. For spreads, use "buyStrike" and "sellStrike" - KEEP THEM EXACTLY AS STATED
   - If callout says "Buy 400 / Sell 410", then buyStrike=400, sellStrike=410
   - Do NOT swap or reorder the strikes
3. Normalize strategy to: "short_put", "short_call", "covered_call", "bull_put_spread", "bear_call_spread", "call_debit_spread", "put_debit_spread", "long_call", "long_put", "long_call_leaps", "long_put_leaps"
   - LEAPS are options with expiry 1+ year out - use "long_call_leaps" or "long_put_leaps" if mentioned
4. Format expiry as "YYYY-MM-DD" - EXPIRY MUST BE IN THE FUTURE!
   - We are in ${currentYear}. Use ${currentYear} or ${nextYear} for the year unless explicitly stated otherwise.
   - If date says "2/9" or "Feb 9" without year, assume ${currentYear} (or ${nextYear} if that date has passed)
   - If year is "26", interpret as 2026. If "27", interpret as 2027. If "28", interpret as 2028.
   - NEVER return a date in the past like 2024 or 2025 unless explicitly stated
5. Premium should be the OPTION premium (what you pay/receive for the option), NOT the stock price
   - If callout says "PLTR @ $167 - Sell $150 put" → $167 is STOCK PRICE, not premium. Premium is unknown.
   - If callout says "Sell $150 put for $4.85" → Premium is 4.85
   - If no premium mentioned, set premium to null
6. IMPORTANT: Stock prices are typically $50-$500+, option premiums are typically $0.50-$15
   - If you see "@" followed by a price, that's usually the stock price, NOT the option premium
7. Look for contract count (e.g., "10 contracts", "3x", "x5"). If not specified, use 1.

RESPOND WITH ONLY JSON, no explanation:
{
    "ticker": "SYMBOL",
    "strategy": "strategy_type",
    "expiry": "${currentYear}-02-21",
    "strike": 100,
    "buyStrike": null,
    "sellStrike": null,
    "premium": null,
    "contracts": 1,
    "stockPrice": 167.00,
    "notes": "any additional context from the callout"
}

For spreads, strike should be null and buyStrike/sellStrike should have values.
For single-leg options, strike should have a value and buyStrike/sellStrike should be null.
If premium is not explicitly stated, set it to null (we'll fetch live pricing).`;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCORD TRADE ANALYSIS PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt to analyze a Discord trade callout
 * @param {Object} parsed - Parsed trade data
 * @param {Object} tickerData - Market data for ticker
 * @param {Object} premium - Option pricing data
 * @param {string|null} patternContext - Historical pattern context
 * @param {Array} alternativeStrikes - Real alternative strikes from CBOE
 * @returns {string} Formatted prompt
 */
function buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium, patternContext = null, alternativeStrikes = []) {
    const t = tickerData;
    const isSpread = parsed.buyStrike || parsed.sellStrike;
    const strikeDisplay = isSpread 
        ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
        : `$${parsed.strike}`;
    
    // Calculate OTM distance
    const price = parseFloat(t.price) || 0;
    const strike = parseFloat(parsed.strike || parsed.sellStrike) || 0;
    const otmPercent = price > 0 ? ((price - strike) / price * 100).toFixed(1) : 'N/A';
    
    // Calculate range position (0% = at 3-month low, 100% = at 3-month high)
    const threeMonthHigh = parseFloat(t.threeMonthHigh) || 0;
    const threeMonthLow = parseFloat(t.threeMonthLow) || 0;
    let rangePosition = 'N/A';
    let rangeContext = '';
    if (threeMonthHigh > threeMonthLow && price > 0) {
        const pct = Math.round(((price - threeMonthLow) / (threeMonthHigh - threeMonthLow)) * 100);
        rangePosition = pct;
        if (pct <= 20) {
            rangeContext = '🟢 NEAR 3-MONTH LOW - Stock has pulled back, good entry for short puts';
        } else if (pct <= 40) {
            rangeContext = '🟡 Lower half of range - Decent entry point';
        } else if (pct <= 60) {
            rangeContext = '⚪ Mid-range - Neutral positioning';
        } else if (pct <= 80) {
            rangeContext = '🟠 Upper half of range - Caution for short puts';
        } else {
            rangeContext = '🔴 NEAR 3-MONTH HIGH - Risky entry, stock may be topping';
        }
    }
    
    // Calculate DTE (days to expiry)
    let dte = 'unknown';
    let dteNum = 0;
    let dteWarning = '';
    if (parsed.expiry) {
        const expDate = parseExpiryDate(parsed.expiry);
        if (expDate) {
            const now = new Date();
            const diffMs = expDate - now;
            dte = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            dteNum = dte;
            
            // Add warnings for short DTE and notes for LEAPS
            if (dte <= 0) {
                dteWarning = '🚨 EXPIRED OR EXPIRING TODAY - DO NOT ENTER';
            } else if (dte <= 3) {
                dteWarning = '🚨 VERY SHORT DTE - High gamma risk, small moves = big swings';
            } else if (dte <= 7) {
                dteWarning = '⚠️ SHORT DTE - Limited time for thesis to play out';
            } else if (dte <= 14) {
                dteWarning = 'ℹ️ 2 weeks or less - Theta accelerating';
            } else if (dte >= 365) {
                dteWarning = '📅 LEAPS (1+ year) - Long-term position, evaluate as stock proxy. Daily theta is minimal, but VEGA (IV sensitivity) matters more.';
            } else if (dte >= 180) {
                dteWarning = '📅 LONG-DATED (6+ months) - Extended horizon means IV changes matter more than daily theta.';
            }
        }
    }
    
    // Build CATALYST WARNING based on IV and earnings
    let catalystWarning = '';
    const liveIV = premium?.iv ? parseFloat(premium.iv) : null;
    const hasEarningsDate = t.earnings && t.earnings !== 'null' && t.earnings !== 'undefined';
    
    // Check if earnings is within 30 days of expiry (tail risk even if after expiry)
    let earningsNearExpiry = false;
    let earningsBeforeExpiry = false;
    let daysFromExpiryToEarnings = null;
    if (hasEarningsDate && parsed.expiry) {
        try {
            const earningsDate = new Date(t.earnings);
            const expiryDate = parseExpiryDate(parsed.expiry);
            if (earningsDate && expiryDate) {
                daysFromExpiryToEarnings = Math.round((earningsDate - expiryDate) / (1000 * 60 * 60 * 24));
                earningsBeforeExpiry = daysFromExpiryToEarnings < 0;
                earningsNearExpiry = Math.abs(daysFromExpiryToEarnings) <= 30;
            }
        } catch (e) { /* ignore date parse errors */ }
    }
    
    // High IV + short DTE = likely binary event
    if (liveIV && liveIV > 60 && dteNum > 0 && dteNum <= 45) {
        catalystWarning = `
═══ ⚠️ CATALYST WARNING ═══
🔥 HIGH IV ALERT: ${liveIV.toFixed(1)}% IV with ${dteNum} DTE suggests a binary event (earnings, FDA, etc.)
${hasEarningsDate ? `📅 CONFIRMED EARNINGS: ${t.earnings}${earningsBeforeExpiry ? ' (BEFORE EXPIRY!)' : ''}` : '❓ Earnings date not found - CHECK MANUALLY before entering!'}
${!hasEarningsDate ? `🔍 Search: "${parsed.ticker} earnings date" to verify` : ''}
💡 High IV means market expects BIG move. Consider:
   - Reduced position size (risk of gap up/down)
   - Waiting until after the event
   - Wider strike cushion than normal
`;
    } else if (hasEarningsDate && earningsNearExpiry) {
        // Earnings within 30 days of expiry - always mention for tail risk
        catalystWarning = `
═══ UPCOMING CATALYST ═══
📅 Earnings: ${t.earnings}
${earningsBeforeExpiry 
    ? `⚠️ EARNINGS ${Math.abs(daysFromExpiryToEarnings)} DAYS BEFORE EXPIRY - Position will experience event risk!` 
    : `ℹ️ Earnings ${daysFromExpiryToEarnings} days AFTER expiry - IV may still be elevated (tail risk), but no direct event exposure`}
`;
    } else if (hasEarningsDate) {
        // Earnings exists but far from expiry - brief mention
        catalystWarning = `
📅 Next Earnings: ${t.earnings} (${daysFromExpiryToEarnings > 0 ? daysFromExpiryToEarnings + ' days after expiry' : 'well before expiry'})
`;
    }
    
    // Calculate risk/reward - DIFFERENT FOR SPREADS vs SINGLE LEG
    let riskRewardSection = '';
    
    // Validate premium: stock prices are >$50, option premiums typically $0.50-$15
    const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                      parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
    const calloutPremiumValid = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50;
    const effectivePremium = calloutPremiumValid ? parseFloat(parsed.premium) : (premium?.mid || 0);
    
    if (isSpread && parsed.buyStrike && parsed.sellStrike) {
        // SPREAD RISK/REWARD
        const buyStrike = parseFloat(parsed.buyStrike);
        const sellStrike = parseFloat(parsed.sellStrike);
        const spreadWidth = Math.abs(sellStrike - buyStrike);
        const maxProfit = effectivePremium * 100;
        const maxLoss = (spreadWidth - effectivePremium) * 100;
        const capitalRequired = maxLoss; // For credit spreads, capital = max loss
        const returnOnRisk = maxLoss > 0 ? (maxProfit / maxLoss * 100).toFixed(1) : 'N/A';
        const premiumVsWidth = ((effectivePremium / spreadWidth) * 100).toFixed(1);
        
        // Breakeven for credit spreads
        const isBullPut = parsed.strategy?.includes('bull') || parsed.strategy?.includes('put_credit');
        const breakeven = isBullPut 
            ? sellStrike - effectivePremium  // Bull put: short strike - premium
            : sellStrike + effectivePremium; // Bear call: short strike + premium
        
        riskRewardSection = `
═══ SPREAD RISK/REWARD MATH ═══
Strategy: ${parsed.strategy?.toUpperCase()}
Spread Width: $${spreadWidth} ($${buyStrike} to $${sellStrike})
Premium: $${effectivePremium.toFixed(2)} (${premiumVsWidth}% of spread width)${!calloutPremiumValid ? ' [using live mid]' : ''}
Max Profit: $${maxProfit.toFixed(0)} (keep full credit if OTM at expiry)
Max Loss: $${maxLoss.toFixed(0)} (spread width - premium)
Return on Risk: ${returnOnRisk}% ($${maxProfit.toFixed(0)} profit / $${maxLoss.toFixed(0)} risk)
Capital Required: $${capitalRequired.toFixed(0)} (margin = max loss for spreads)
Breakeven: $${breakeven.toFixed(2)}

💡 SPREAD GUIDELINES:
- Good spreads collect ≥30% of width as premium
- This trade collects ${premiumVsWidth}% ${parseFloat(premiumVsWidth) >= 30 ? '✅' : '⚠️ (below 30%)'}`;
        
    } else if (effectivePremium && strike) {
        // SINGLE LEG (naked put, covered call, etc.)
        const maxProfit = effectivePremium * 100;
        const maxRisk = (strike - effectivePremium) * 100;
        const riskRewardRatio = maxRisk > 0 ? (maxProfit / maxRisk * 100).toFixed(2) : 'N/A';
        
        // Add DTE context for LEAPS
        const dteContext = dte >= 365 ? '\n📅 LEAPS NOTE: High premium is expected - contains significant time value. Evaluate cost basis after premium vs holding stock directly.' :
                           dte >= 180 ? '\n⏳ LONG-DATED NOTE: Premium reflects extended time value. Good for cost basis reduction on covered calls.' : '';
        
        riskRewardSection = `
═══ SINGLE-LEG RISK/REWARD MATH ═══
Premium: $${effectivePremium.toFixed(2)}${!calloutPremiumValid ? ' [using live mid price]' : ''}
Max Profit: $${maxProfit.toFixed(0)} (keep full premium if OTM at expiry)
Max Risk: $${maxRisk.toFixed(0)} (if stock goes to $0)
Risk/Reward: ${riskRewardRatio}% return on risk
Capital Required: $${(strike * 100).toFixed(0)} (to secure 1 contract)${dteContext}`;
    }
    
    // Format premium section
    let premiumSection = '';
    if (premium) {
        let entryQuality = '';
        // Only compare if callout had a premium AND it looks like an option premium (not stock price)
        if (premium.mid && calloutPremiumValid) {
            if (isSelling) {
                // Selling: want to get MORE than mid
                entryQuality = parsed.premium >= premium.mid 
                    ? '(got ≥ mid ✅)' 
                    : `(got ${((1 - parsed.premium/premium.mid) * 100).toFixed(0)}% LESS than mid ⚠️)`;
            } else {
                // Buying: want to pay LESS than mid
                entryQuality = parsed.premium <= premium.mid 
                    ? '(paid ≤ mid ✅)' 
                    : `(paid ${((parsed.premium/premium.mid - 1) * 100).toFixed(0)}% MORE than mid ⚠️)`;
            }
        }
        
        // Only show discrepancy if we have a valid callout premium to compare
        const showDiscrepancy = calloutPremiumValid && Math.abs(premium.mid - parsed.premium) > 0.5;
        
        premiumSection = `
LIVE CBOE PRICING:
Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
${premium.iv ? `IV: ${premium.iv}%` : ''}
${calloutPremiumValid ? `Callout Entry: $${parsed.premium} ${entryQuality}` : 'Callout Entry: Not specified - using live mid price for calculations'}
${showDiscrepancy ? '⚠️ LARGE DISCREPANCY between callout entry and current mid - trade may be stale!' : ''}`;
    } else if (calloutPremiumValid) {
        premiumSection = `\nCALLOUT ENTRY PRICE: $${parsed.premium}`;
    }
    
    // Build pattern context section if available
    let patternSection = '';
    if (patternContext) {
        patternSection = `
═══ YOUR HISTORICAL TRADING PATTERNS ═══
⚠️ IMPORTANT: This data is from YOUR OWN past trades. Use it to inform your decision!

${patternContext}
`;
    }

    return `You are a senior options desk analyst with 20 years of derivatives experience. Your job is to evaluate trade setups with cold, objective analysis - assessing risk/reward, identifying red flags, and giving clear recommendations. The source of a trade idea is irrelevant; only the quality of the setup matters. Be honest and dispassionate.

IMPORTANT REMINDERS:
- SHORT PUTS are BULLISH (you want the stock to go UP or stay flat)
- SHORT CALLS are BEARISH (you want the stock to go DOWN or stay flat)
- For puts: LOWER strike = MORE cushion (further OTM)
- For calls: HIGHER strike = MORE cushion (further OTM)

═══ THE CALLOUT ═══
Ticker: ${parsed.ticker}
Strategy: ${parsed.strategy}
Strike: ${strikeDisplay}
Expiry: ${parsed.expiry} (${dte} days to expiry)
${dteWarning ? dteWarning : ''}
Entry Premium: ${calloutPremiumValid ? '$' + parsed.premium : 'Not specified in callout'}
${parsed.notes ? `Notes: ${parsed.notes}` : ''}
${riskRewardSection}

═══ CURRENT MARKET DATA ═══
Current Price: $${t.price}
📊 RANGE POSITION: ${rangePosition}% ${rangeContext}
${strike ? `OTM Distance: ${otmPercent}%` : ''}
52-Week Range: $${t.yearLow} - $${t.yearHigh}
3-Month Range: $${t.threeMonthLow} - $${t.threeMonthHigh}
20-Day SMA: $${t.sma20} (price ${t.aboveSMA20 ? 'ABOVE ✅' : 'BELOW ⚠️'})
${t.sma50 ? `50-Day SMA: $${t.sma50}` : ''}
Support Levels: $${t.recentSupport?.join(', $') || 'N/A'}
${premiumSection}
${catalystWarning}
${patternSection}
${alternativeStrikes.length > 0 ? `
═══ REAL ALTERNATIVE STRIKES (from CBOE - use THESE numbers!) ═══
${alternativeStrikes.map((alt, i) => 
`📈 Alternative #${i+1}: $${alt.strike} strike | ${alt.cushion} OTM | Bid: $${alt.bid?.toFixed(2)} | Ask: $${alt.ask?.toFixed(2)} | Mid: $${alt.mid?.toFixed(2)} | DTE: ${alt.dte}`
).join('\n')}
` : ''}
═══ YOUR ANALYSIS ═══

**START WITH THE GRADE** (This MUST be the first thing you output!)
## TRADE GRADE: [A/B/C/D/F] - [One sentence verdict]

Example: "## TRADE GRADE: C - Decent setup but poor risk/reward ratio limits upside"
Example: "## TRADE GRADE: A - Strong entry at support with excellent premium capture"
Example: "## TRADE GRADE: F - Avoid - strike too close, expiry too short, terrible R/R"

Be DECISIVE. Don't hedge with "it depends" - commit to a grade.

---
${patternContext ? `
**0. PATTERN CHECK** (IMPORTANT - Look at YOUR HISTORICAL TRADING PATTERNS above!)
- Does this trade match a WINNING pattern from your history? Mention it!
- Does this trade resemble a LOSING pattern? WARN about it!
- If no history exists for this ticker/strategy, say so.
` : ''}
**1. TRADE SETUP REVIEW** (Keep brief - 2-3 sentences max)
- Strike selection vs support/resistance
- Premium worth the risk?
${dte <= 7 ? '- ⚠️ ONLY ' + dte + ' DAYS - enough time?' : ''}
${dte >= 365 ? '- 📅 LEAPS - evaluate as stock proxy with defined risk' : ''}

**2. CATALYST CHECK** (CRITICAL for short-dated or high-IV trades!)
${liveIV && liveIV > 50 ? `- IV is ${liveIV.toFixed(0)}% - WHY is it elevated? Check for earnings, FDA, court dates, etc.` : '- IV seems normal - still verify no surprise catalysts'}
${dteNum <= 45 ? `- With ${dteNum} DTE, any catalyst WILL impact this trade` : '- Longer timeframe gives buffer for events'}
- ALWAYS state next earnings date if within 30 days of expiry (even if AFTER expiry - tail risk!)
- Explicitly state: "I verified earnings date is [DATE]" or "No earnings found in next 30 days"

**3. KEY NUMBERS**
- Max Risk: $X,XXX
- Max Profit: $XXX  
- R/R Ratio: X.X%
- Win Probability: ~XX%

**4. RED FLAGS** (List only if they exist, otherwise skip)

**5. VERDICT SPECTRUM** (One sentence each - no rambling!)

🟢 **AGGRESSIVE**: [One sentence bull case]
🟡 **MODERATE**: [One sentence balanced take]  
🔴 **CONSERVATIVE**: [One sentence bear case]

**6. BETTER ALTERNATIVES** (REQUIRED if you gave grade C or worse!)
If grade is C, D, or F, look at the REAL ALTERNATIVE STRIKES section above and recommend one.
Use the EXACT numbers from the data - do NOT make up premiums!

📈 **RECOMMENDED ALTERNATIVE:**
| Strike | Expiry | REAL Premium | Cushion |
|--------|--------|--------------|---------|
| $XX    | from data | $X.XX (bid/ask from data) | XX% OTM |
**Why better:** [One sentence explaining improved R/R]

If no alternatives are shown above, or the original trade is grade A/B, simply state:
"Original setup is sound - no changes recommended."

---
**BOTTOM LINE**: One decisive sentence - "Take it" or "Pass" and why.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE CRITIQUE PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a critique prompt for analyzing a closed trade
 * @param {Object} data - Trade data including chainHistory, totalPremium, etc.
 * @returns {string} Formatted prompt
 */
function buildCritiquePrompt(data) {
    const { ticker, chainHistory, totalPremium, totalDays, finalOutcome } = data;
    
    if (!chainHistory || chainHistory.length === 0) {
        return `No trade history provided for ${ticker}. Cannot critique.`;
    }
    
    // Format the chain history as a timeline (include buyback costs for rolls)
    let timeline = '';
    chainHistory.forEach((pos, idx) => {
        const action = idx === 0 ? 'OPENED' : 'ROLLED';
        const premium = (pos.premium * 100 * (pos.contracts || 1)).toFixed(0);
        const isDebit = pos.type?.includes('long') || pos.type?.includes('debit');
        const premiumStr = isDebit ? `-$${premium} paid` : `+$${premium} received`;
        
        // Include buyback cost if position was rolled
        let buybackStr = '';
        if (pos.closeReason === 'rolled' && pos.closePrice) {
            const buyback = (pos.closePrice * 100 * (pos.contracts || 1)).toFixed(0);
            buybackStr = `\n   Buyback cost: -$${buyback}`;
        }
        
        timeline += `${idx + 1}. ${action}: ${pos.openDate || 'Unknown date'}
   Strike: $${pos.strike || pos.sellStrike || 'N/A'} ${pos.type || 'option'}
   Premium: ${premiumStr}${buybackStr}
   Expiry: ${pos.expiry || 'N/A'}
   ${pos.closeDate ? `Closed: ${pos.closeDate} (${pos.closeReason || 'closed'})` : 'Status: OPEN'}
   ${pos.spotAtOpen ? `Spot at open: $${pos.spotAtOpen}` : ''}
   
`;
    });
    
    return `You are an expert options trading coach. Analyze this completed trade and provide constructive feedback.

═══ TRADE SUMMARY ═══
Ticker: ${ticker}
Total positions in chain: ${chainHistory.length}
NET premium collected: $${totalPremium?.toFixed(0) || 'N/A'} (premiums received minus buyback costs)
Total days in trade: ${totalDays || 'N/A'}
Final outcome: ${finalOutcome || 'Unknown'}

═══ TRADE TIMELINE ═══
${timeline}

═══ YOUR ANALYSIS ═══
Provide a thoughtful critique in this format:

1. **What went well** - Identify 1-2 good decisions (entry timing, strike selection, roll timing, etc.)

2. **What could improve** - Identify 1-2 areas for improvement. Be specific - "rolled too early" or "strike was too aggressive" with reasoning.

3. **Key lesson** - One actionable takeaway for future trades.

4. **Grade** - Rate this trade: A (excellent), B (good), C (acceptable), D (poor), F (disaster)

Be honest but constructive. Focus on the PROCESS, not just the outcome. A losing trade can still have good process, and a winning trade can have poor process.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE ADVISOR PROMPT (Main AI advisor with wisdom integration)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a structured prompt for the AI trade advisor
 * Supports semantic search for wisdom and skipWisdom parameter
 * 
 * @param {Object} data - Complete position and context data
 * @param {boolean} isLargeModel - Whether using a larger model
 * @returns {Promise<string>} Formatted prompt (async due to wisdom search)
 */
async function buildTradePrompt(data, isLargeModel = false) {
    const {
        ticker, positionType, strike, premium, dte, contracts,
        spot, costBasis, breakeven, maxProfit, maxLoss,
        iv, riskPercent, winProbability, costToClose,
        rollOptions, expertRecommendation, previousAnalysis,
        portfolioContext,  // Portfolio context from audit
        chainHistory,      // Array of previous positions in this chain
        totalPremiumCollected,  // Net premium across all rolls
        skipWisdom,        // Skip wisdom for "pure" analysis
        closedSummary      // Historical closed positions for pattern matching
    } = data;
    
    // Load relevant wisdom using semantic search (unless skipped)
    let wisdomSection = '';
    let wisdomUsed = [];
    
    if (!skipWisdom) {
        try {
            // Build a query from the position context
            const query = `${ticker} ${positionType?.replace(/_/g, ' ')} strike ${strike} ${dte} days to expiry ${riskPercent > 50 ? 'high risk' : 'low risk'} ${spot > strike ? 'ITM' : 'OTM'}`;
            
            // Use semantic search (with category fallback)
            const searchResults = await searchWisdom(query, positionType, 5);
            
            if (searchResults.length > 0) {
                wisdomUsed = searchResults.map(r => r.entry);
                const wisdomList = searchResults.map(r => {
                    const relevanceTag = r.score > 0.7 ? '🎯' : r.score > 0.5 ? '📌' : '📚';
                    return `${relevanceTag} [${r.entry.category}] ${r.entry.wisdom}`;
                }).join('\n');
                
                wisdomSection = `
═══ YOUR TRADING RULES (MANDATORY) ═══
These are YOUR personal rules from your knowledge base. You MUST:
1. Follow these unless there's a COMPELLING reason not to
2. CITE which rule(s) influenced your recommendation  
3. If you contradict a rule, EXPLAIN WHY the situation warrants an exception

${wisdomList}

At the END of your response, include:
📚 Rules Applied: [list which rules you followed]
📚 Rules Overridden: [list any rules you deviated from and why]
`;
            }
        } catch (e) {
            console.log('[WISDOM] Search error:', e.message);
        }
    }
    
    // Store wisdom in function result metadata
    buildTradePrompt._lastWisdomUsed = wisdomUsed;
    
    // Determine position characteristics
    const isLongCall = positionType === 'long_call';
    const isLongPut = positionType === 'long_put';
    const isLong = isLongCall || isLongPut;
    const isCall = isLongCall || positionType === 'buy_write' || positionType === 'covered_call' || positionType === 'short_call';
    const isCoveredCall = positionType === 'covered_call' || positionType === 'buy_write';
    const isShortPut = positionType === 'short_put';
    
    // Generate historical pattern context if closed summary is available
    let patternContext = '';
    if (closedSummary && closedSummary.length > 0) {
        const tickerUpper = ticker?.toUpperCase();
        const typeNormalized = positionType?.toLowerCase().replace(/\s+/g, '_') || '';
        
        // Find matching trades
        const sameTickerType = closedSummary.filter(p => 
            p.ticker?.toUpperCase() === tickerUpper && 
            p.type?.toLowerCase().replace(/\s+/g, '_') === typeNormalized
        );
        const sameTicker = closedSummary.filter(p => p.ticker?.toUpperCase() === tickerUpper);
        const sameType = closedSummary.filter(p => p.type?.toLowerCase().replace(/\s+/g, '_') === typeNormalized);
        
        const calcStats = (trades) => {
            if (trades.length === 0) return null;
            const totalPnL = trades.reduce((sum, p) => sum + (p.pnl || 0), 0);
            const winners = trades.filter(p => (p.pnl || 0) >= 0);
            return { count: trades.length, totalPnL, winRate: (winners.length / trades.length * 100), avgPnL: totalPnL / trades.length };
        };
        
        const tickerTypeStats = calcStats(sameTickerType);
        const tickerStats = calcStats(sameTicker);
        const typeStats = calcStats(sameType);
        
        let patternText = '';
        const warnings = [];
        const encouragements = [];
        
        if (tickerTypeStats && tickerTypeStats.count >= 2) {
            patternText += `• ${tickerUpper} ${typeNormalized.replace(/_/g,' ')}: ${tickerTypeStats.count} trades, ${tickerTypeStats.winRate.toFixed(0)}% win, $${tickerTypeStats.totalPnL.toFixed(0)} total\n`;
            if (tickerTypeStats.winRate < 40) warnings.push(`LOW WIN RATE on ${tickerUpper} ${typeNormalized.replace(/_/g,' ')}`);
            if (tickerTypeStats.totalPnL < -500) warnings.push(`NET LOSING on this exact setup (-$${Math.abs(tickerTypeStats.totalPnL).toFixed(0)})`);
            if (tickerTypeStats.winRate >= 75) encouragements.push(`STRONG WIN RATE (${tickerTypeStats.winRate.toFixed(0)}%) on this setup`);
            if (tickerTypeStats.avgPnL > 100) encouragements.push(`PROFITABLE pattern ($${tickerTypeStats.avgPnL.toFixed(0)} avg)`);
        }
        
        if (tickerStats && tickerStats.count >= 3 && !tickerTypeStats) {
            patternText += `• All ${tickerUpper}: ${tickerStats.count} trades, ${tickerStats.winRate.toFixed(0)}% win rate\n`;
            if (tickerStats.winRate < 40) warnings.push(`${tickerUpper} HAS BEEN DIFFICULT overall`);
            if (tickerStats.winRate >= 70) encouragements.push(`${tickerUpper} WORKS WELL for you`);
        }
        
        if (typeStats && typeStats.count >= 5) {
            patternText += `• All ${typeNormalized.replace(/_/g,' ')}: ${typeStats.count} trades, ${typeStats.winRate.toFixed(0)}% win rate\n`;
            if (typeStats.winRate < 50 && typeNormalized.includes('long')) warnings.push(`${typeNormalized.replace(/_/g,' ')} UNDERPERFORMING`);
            if (typeStats.winRate >= 70) encouragements.push(`${typeNormalized.replace(/_/g,' ')} IS YOUR STRENGTH`);
        }
        
        if (patternText || warnings.length > 0 || encouragements.length > 0) {
            patternContext = `
═══ YOUR HISTORICAL PATTERNS ═══
${patternText}${warnings.length > 0 ? '⚠️ WARNINGS: ' + warnings.join(', ') + '\n' : ''}${encouragements.length > 0 ? '✅ POSITIVE: ' + encouragements.join(', ') + '\n' : ''}
**Use this history to inform your recommendation!**
`;
        }
    }
    
    // Calculate assignment scenario for covered calls
    let assignmentProfit = null;
    let assignmentAnalysis = '';
    if (isCoveredCall && costBasis && strike && spot) {
        const stockGain = (strike - costBasis) * 100 * contracts;
        const premiumGain = (totalPremiumCollected || premium * 100 * contracts);
        assignmentProfit = stockGain + premiumGain;
        const missedUpside = spot > strike ? ((spot - strike) * 100 * contracts).toFixed(0) : 0;
        assignmentAnalysis = `
═══ ASSIGNMENT SCENARIO (Let it get called) ═══
If assigned at $${strike}:
• Stock gain: $${stockGain.toFixed(0)} ($${strike} - $${costBasis.toFixed(2)} cost basis × ${contracts * 100} shares)
• Premium collected: $${premiumGain.toFixed(0)}${chainHistory?.length > 1 ? ` (across ${chainHistory.length} rolls)` : ''}
• TOTAL PROFIT: $${assignmentProfit.toFixed(0)}
${spot > strike ? `• Upside you'd miss: $${missedUpside} (stock at $${spot.toFixed(2)} vs $${strike} strike)` : '• Stock is below strike - assignment unlikely'}

⚠️ IMPORTANT: Assignment is not always bad! If you've collected good premium and the stock is above your strike, 
getting called away can be a WIN. Consider: Is this profit acceptable, or is the upside worth chasing?`;
    }
    
    // Calculate chain context if available
    let chainContext = '';
    if (chainHistory?.length > 1) {
        const rollCount = chainHistory.length - 1;
        const firstOpen = chainHistory[0]?.openDate;
        const daysInTrade = firstOpen ? Math.floor((Date.now() - new Date(firstOpen).getTime()) / (1000 * 60 * 60 * 24)) : null;
        chainContext = `
═══ ROLL HISTORY ═══
This position has been rolled ${rollCount} time${rollCount > 1 ? 's' : ''}.
Original open: ${firstOpen || 'Unknown'}${daysInTrade ? ` (${daysInTrade} days ago)` : ''}
Net premium collected: $${totalPremiumCollected?.toFixed(0) || 'N/A'}
${rollCount >= 3 ? '⚠️ Multiple rolls - consider if continuing to roll is the best use of capital vs. taking assignment or closing.' : ''}`;
    }
    
    // Build alternative strategies section for covered calls in bullish scenarios
    let alternativeStrategies = '';
    let scorecardStrategies = [];  // Dynamic list based on situation
    
    if (isCoveredCall && spot > strike) {
        // Stock is above strike - ITM covered call, bullish scenario
        const upsideMissed = ((spot - strike) / strike * 100).toFixed(1);
        const itmPercent = ((spot - strike) / strike * 100).toFixed(1);
        
        // Calculate wheel continuation put strike (slightly below current call strike for lower re-entry)
        const wheelPutStrike = Math.floor((strike * 0.95) / 5) * 5;  // ~5% below call strike
        const wheelPutStrikeAlt = Math.floor((strike * 0.90) / 5) * 5;  // ~10% below for more cushion
        
        // Build dynamic strategy list based on situation
        scorecardStrategies = [
            { name: 'LET ASSIGN', detail: `($${assignmentProfit?.toFixed(0) || '???'} profit)`, always: true },
            { name: 'WHEEL CONTINUATION', detail: `(LET ASSIGN + SELL $${wheelPutStrike} PUT)`, always: true, highlight: true },
            { name: 'ROLL UP+OUT', detail: '(higher strike, further out)', always: true },
        ];
        
        // Add bullish strategies if stock has momentum (significantly ITM)
        if (parseFloat(itmPercent) > 3) {
            scorecardStrategies.push({ name: 'SKIP™ STRATEGY', detail: '(LEAPS 12+ mo + SKIP call 3-9 mo)', reason: 'Stock has momentum' });
            scorecardStrategies.push({ name: 'BUY LONG CALL', detail: `($${Math.ceil(spot / 5) * 5} call, 60-90 DTE)`, reason: 'Capture upside' });
            scorecardStrategies.push({ name: 'BUY CALL SPREAD', detail: `($${Math.ceil(spot / 5) * 5}/$${Math.ceil(spot / 5) * 5 + 5})`, reason: 'Defined risk upside' });
        }
        
        // Add put selling if still bullish on underlying
        scorecardStrategies.push({ name: 'SELL PUT', detail: `($${Math.floor((spot * 0.9) / 5) * 5} strike)`, reason: 'Add bullish exposure' });
        
        // Add protective strategies if concerned about pullback
        if (parseFloat(itmPercent) > 8) {
            scorecardStrategies.push({ name: 'COLLAR', detail: '(buy put + sell higher call)', reason: 'Lock in gains, worried about pullback' });
        }
        
        // Add close entirely option
        scorecardStrategies.push({ name: 'CLOSE ENTIRELY', detail: '(buy back call + sell stock)', reason: 'Take profits, redeploy capital' });
        
        alternativeStrategies = `
═══ ALTERNATIVE STRATEGIES (Think Beyond Rolling!) ═══
Your covered call is ITM with the stock at $${spot.toFixed(2)} vs $${strike} strike (${itmPercent}% ITM).

STRATEGY MENU (evaluate each that applies to this situation):

🔄 WHEEL CONTINUATION (COMBO STRATEGY - Often the BEST play!):
• LET ASSIGN + SELL PUT - Take assignment profit ($${assignmentProfit?.toFixed(0) || '???'}), THEN immediately sell a put at $${wheelPutStrike} or $${wheelPutStrikeAlt}
  - You collect EXTRA premium from the put NOW (while still holding shares)
  - When called away, you keep assignment profit + put premium
  - If stock drops to put strike, you re-enter at LOWER cost basis than current
  - This is the WHEEL STRATEGY continuing - not a new position, but the next leg
  - RISK: Only if stock crashes below put strike before assignment
  - BEST WHEN: You're bullish, want to stay in the name, but happy to take profits first

📈 BULLISH STRATEGIES (if you think stock continues higher):
• SKIP™ STRATEGY - Buy LEAPS (12+ mo) + SKIP call (3-9 mo, higher strike). Exit SKIP at 45-60 DTE.
• BUY LONG CALL - Buy $${Math.ceil(spot / 5) * 5} call 60-90 DTE to ride further upside
• BUY CALL SPREAD - Buy $${Math.ceil(spot / 5) * 5}/$${Math.ceil(spot / 5) * 5 + 5} spread for defined risk upside
• DIAGONAL SPREAD - Sell near-term call, buy longer-dated higher strike call

📊 NEUTRAL STRATEGIES (if you think stock will consolidate):
• ROLL UP+OUT - Buy back call, sell higher strike further out
• CALENDAR SPREAD - Sell near-term call, buy same strike longer-dated (theta play)
• JADE LIZARD - Sell put + sell call spread (collect premium, no upside risk)

🛡️ PROTECTIVE STRATEGIES (if worried about pullback):
• COLLAR - Buy protective put below, sell call above (locks in gain range)
• CLOSE ENTIRELY - Buy back call + sell stock, take profits, redeploy capital

🟢 TAKE THE WIN:
• LET ASSIGN - Collect $${assignmentProfit?.toFixed(0) || '???'} profit, free up capital

💡 KEY INSIGHT: You're missing ${upsideMissed}% of upside ($${spot.toFixed(2)} vs $${strike} cap).
Pick strategies that match YOUR outlook on ${ticker}.
⭐ WHEEL CONTINUATION is often overlooked but combines the safety of taking profits with continued premium collection.`;

    } else if (isCoveredCall && spot <= strike) {
        // OTM or ATM covered call - winning position, theta working
        const otmPercent = ((strike - spot) / strike * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'HOLD', detail: '(let expire worthless)', always: true },
            { name: 'CLOSE EARLY', detail: '(buy back cheap, lock in profit)', always: true },
            { name: 'ROLL DOWN', detail: '(lower strike for more premium)', reason: 'Collect more if bearish' },
        ];
        
        if (dte <= 14) {
            scorecardStrategies.push({ name: 'LET EXPIRE', detail: '(collect 100% premium)', reason: 'Close to expiry' });
        }
        
        alternativeStrategies = `
═══ POSITION STATUS: OTM COVERED CALL (WINNING) ═══
Your call is ${otmPercent}% OTM - theta is working in your favor.

STRATEGY OPTIONS:
• HOLD - Let time decay work, collect full premium at expiration
• CLOSE EARLY - Buy back at 50-80% profit, free up the position for new trades
• ROLL DOWN - If bearish, roll to lower strike for more premium (increases assignment risk)
${dte <= 14 ? '• LET EXPIRE - Only ' + dte + ' DTE, likely to expire worthless' : ''}

Usually best to just HOLD when OTM and winning.`;

    } else if (isShortPut && spot < strike) {
        // Short put ITM - stock falling scenario
        const itmPercent = ((strike - spot) / strike * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'TAKE ASSIGNMENT', detail: `(buy shares at $${strike}, basis $${(strike - premium).toFixed(2)})`, always: true },
            { name: 'ROLL DOWN+OUT', detail: '(lower strike, further out)', always: true },
            { name: 'CONVERT TO SPREAD', detail: '(buy lower put to cap loss)', reason: 'Define max loss' },
            { name: 'CLOSE FOR LOSS', detail: '(cut losses, move on)', reason: 'Thesis broken' },
        ];
        
        // Add repair strategies for deep ITM
        if (parseFloat(itmPercent) > 10) {
            scorecardStrategies.push({ name: 'RATIO SPREAD', detail: '(sell 2x puts at lower strike, buy back current)', reason: 'Attempt to recover' });
        }
        
        alternativeStrategies = `
═══ ALTERNATIVE STRATEGIES (ITM Short Put) ═══
Your short put is ITM with stock at $${spot.toFixed(2)} vs $${strike} strike (${itmPercent}% ITM).

STRATEGY OPTIONS:
🟢 TAKE ASSIGNMENT - Buy shares at $${strike}, effective basis $${(strike - premium).toFixed(2)}, then sell calls
🔄 ROLL DOWN+OUT - Buy back put, sell lower strike further out for credit
🛡️ CONVERT TO SPREAD - Buy $${Math.floor(spot * 0.9 / 5) * 5} put to cap max loss (turns into bull put spread)
✂️ CLOSE FOR LOSS - Buy back put, take the loss, free up capital
${parseFloat(itmPercent) > 10 ? '⚠️ RATIO SPREAD - Sell 2 lower puts, buy back current (risky, for recovery)' : ''}

Pick based on whether you still want to own ${ticker} at these prices.`;

    } else if (isShortPut && spot >= strike) {
        // OTM short put - winning position
        const otmPercent = ((spot - strike) / spot * 100).toFixed(1);
        
        scorecardStrategies = [
            { name: 'HOLD', detail: '(let expire worthless)', always: true },
            { name: 'CLOSE EARLY', detail: '(buy back cheap)', reason: 'Lock in 50-80% profit' },
            { name: 'ROLL UP', detail: '(higher strike for more premium)', reason: 'If still bullish' },
        ];
        
        alternativeStrategies = `
═══ POSITION STATUS: OTM SHORT PUT (WINNING) ═══
Your put is ${otmPercent}% OTM - theta working, low assignment risk.

STRATEGY OPTIONS:
• HOLD - Let expire worthless for max profit
• CLOSE EARLY - Buy back at 50-80% profit if you want to redeploy capital
• ROLL UP - If bullish, roll to higher strike for more premium (but more risk)

Usually best to HOLD when winning.`;
    }
    
    // Format position type nicely
    const typeLabel = positionType === 'buy_write' ? 'Buy/Write (covered call)' :
                      positionType === 'short_put' ? 'Cash-secured put' :
                      positionType === 'covered_call' ? 'Covered call' :
                      positionType === 'short_call' ? 'Short call' :
                      positionType === 'long_call' ? 'Long call' :
                      positionType === 'long_put' ? 'Long put' :
                      positionType || 'Option position';
    
    // Determine moneyness (ITM means profitable direction for the holder)
    const isITM = isCall ? (spot > strike) : (spot < strike);
    const moneynessLabel = isITM ? 'ITM' : (Math.abs(spot - strike) / strike < 0.02 ? 'ATM' : 'OTM');
    
    // Risk label differs for long vs short
    const riskLabel = isLong ? 'Expire worthless probability' : 'Assignment risk';
    const premiumLabel = isLong ? 'Premium paid' : 'Premium received';
    
    // Build risk reduction options text
    let riskReductionText = 'None available.';
    if (rollOptions?.riskReduction?.length > 0) {
        riskReductionText = rollOptions.riskReduction.map((r, i) => 
            `  ${i+1}. $${r.strike} ${r.expiry || ''} - ${r.isCredit ? '$' + r.amount + ' credit' : '$' + r.amount + ' debit'} (↓${r.riskChange}% risk${r.delta ? ', Δ' + r.delta : ''})`
        ).join('\n');
    }
    
    // Build credit roll options text
    let creditRollsText = 'None available.';
    if (rollOptions?.creditRolls?.length > 0) {
        creditRollsText = rollOptions.creditRolls.map((r, i) => 
            `  ${i+1}. $${r.strike} ${r.expiry || ''} - $${r.amount} credit (↓${r.riskChange}% risk${r.delta ? ', Δ' + r.delta : ''})`
        ).join('\n');
    }
    
    const hasRollOptions = (rollOptions?.riskReduction?.length > 0) || (rollOptions?.creditRolls?.length > 0);
    
    // Roll instructions differ for long vs short options
    const rollInstructions = isLong 
        ? 'For long options: SELL TO CLOSE current position, BUY TO OPEN new position'
        : 'For short options: BUY TO CLOSE current position, SELL TO OPEN new position';
    
    // Critical warning for long options - AI models often confuse this
    const longOptionWarning = isLong ? `
⚠️ CRITICAL: This is a LONG ${isLongCall ? 'CALL' : 'PUT'} - the trader OWNS this option.
- There is ZERO assignment risk. You CANNOT be assigned on a long option.
- The only risk is the option EXPIRING WORTHLESS and losing the premium paid.
- Do NOT mention "assignment" or "being assigned" - that only applies to SHORT options.
- The ${riskPercent?.toFixed(1) || 'N/A'}% risk means chance of expiring worthless, NOT assignment.
` : '';
    
    return `You are an expert options trading advisor. Analyze this position and recommend a SPECIFIC action.
${longOptionWarning}
═══ CURRENT POSITION ═══
${ticker} ${typeLabel}${dte >= 365 ? ' 📅 LEAPS' : dte >= 180 ? ' ⏳ LONG-DATED' : ''}
Strike: $${strike} | Spot: $${spot?.toFixed(2) || 'N/A'} (${moneynessLabel})
${premiumLabel}: $${premium}/share | Contracts: ${contracts}
DTE: ${dte} days${dte >= 365 ? ' (treat as stock proxy, daily theta minimal)' : dte >= 180 ? ' (extended horizon, IV matters more)' : ''}
${costBasis ? `Cost basis: $${costBasis.toFixed(2)}` : ''}
${breakeven ? `Break-even: $${breakeven.toFixed(2)}` : ''}
${isLong ? `Max loss: $${(premium * 100 * contracts).toFixed(0)} (premium paid)` : ''}
${costToClose ? `Current option price: $${costToClose}` : ''}

═══ RISK METRICS ═══
${riskLabel}: ${riskPercent ? riskPercent.toFixed(1) + '%' : 'N/A'}
Win probability: ${winProbability ? winProbability.toFixed(1) + '%' : 'N/A'}
IV: ${iv ? iv.toFixed(0) + '%' : 'N/A'}
${isLong ? (dte >= 365 ? 'Note: LEAPS have minimal daily theta. Focus on directional thesis and IV changes (vega exposure).' : dte >= 180 ? 'Note: Long-dated options have slow theta decay. IV changes matter more than daily time decay.' : 'Note: Time decay (theta) works AGAINST long options. You lose value daily.') : (dte >= 365 ? 'Note: LEAPS covered calls provide consistent income. Assignment is not imminent - focus on cost basis reduction.' : '')}
${chainContext}${patternContext}${assignmentAnalysis}${alternativeStrategies}
═══ AVAILABLE ROLL OPTIONS ═══
${rollInstructions}

RISK REDUCTION ROLLS:
${riskReductionText}

CREDIT ROLLS:
${creditRollsText}

═══ SYSTEM ANALYSIS ═══
${expertRecommendation || 'No system recommendation'}
${wisdomSection}
${portfolioContext ? `═══ PORTFOLIO CONTEXT ═══
${portfolioContext}
` : ''}${previousAnalysis ? `═══ PREVIOUS ANALYSIS ═══
On ${new Date(previousAnalysis.timestamp).toLocaleDateString()}, you recommended: ${previousAnalysis.recommendation}

At that time:
• Spot: $${previousAnalysis.snapshot?.spot?.toFixed(2) || 'N/A'}
• DTE: ${previousAnalysis.snapshot?.dte || 'N/A'} days
• IV: ${previousAnalysis.snapshot?.iv?.toFixed(0) || 'N/A'}%
• Risk: ${previousAnalysis.snapshot?.riskPercent?.toFixed(1) || 'N/A'}%

Your previous reasoning:
"${previousAnalysis.insight?.substring(0, 300)}${previousAnalysis.insight?.length > 300 ? '...' : ''}"

⚠️ COMPARE: Has anything changed significantly? If your thesis is still valid, confirm it. If conditions changed, explain what's different.
` : ''}═══ DECISION GUIDANCE ═══
${dte >= 365 ? `📅 LEAPS EVALUATION CRITERIA:
• LEAPS are long-term bets on direction, NOT theta plays
• Don't roll for time - you have plenty. Only roll for strike adjustment if stock moved significantly
• Key question: Is the original THESIS still valid?
• If selling covered calls against LEAPS: Focus on reducing cost basis over time
• Assignment on LEAPS is RARE - only worry if deeply ITM near expiration` : dte >= 180 ? `⏳ LONG-DATED OPTION CRITERIA:
• Extended timeframe means IV changes matter more than daily theta
• Only roll if thesis changed or to capture significant strike adjustment
• Don't panic on short-term moves - you have time for recovery` : `FIRST: Decide if you should roll at all!
• If the position is OTM, low risk (<35%), and approaching expiration → "HOLD - let theta work" is often best
• If the Expert Analysis says "on track for max profit" → you probably DON'T need to roll
• Only roll if: (a) position is ITM/troubled, (b) risk is high (>50%), or (c) you want to extend for more premium`}

IF you do need to roll, compare options CAREFULLY:
• Credit roll (you get paid) that reduces risk = ALWAYS better than debit roll (you pay) with same risk
• Getting paid AND reducing risk = obvious winner
• Debit rolls only make sense if you're desperate to cut risk and no credit option exists

═══ YOUR TASK ═══
${(scorecardStrategies && scorecardStrategies.length > 0) ? `🚨 MANDATORY: Evaluate EACH strategy before recommending.

These strategies were selected because they're relevant to YOUR specific situation.

**STRATEGY SCORECARD** (Rate each 1-10, where 10 = best choice)

| Strategy | Score | Reasoning |
|----------|-------|-----------|
${scorecardStrategies.map((s, i) => `| ${i + 1}. ${s.name} ${s.detail} | ?/10 | [Your reasoning] |`).join('\n')}

After completing the scorecard, provide:

**WINNER:** [Highest scoring strategy] 
**Trade Details:** [Specific action - strike, expiry, premium if applicable]
**Why This Beats Alternatives:** [Why winner is better than 2nd place]
**Key Risk:** [Main downside to watch]

IMPORTANT NOTES:
• If you recommend SKIP™, include BOTH legs (LEAPS strike/expiry + SKIP call strike/expiry)
• If you recommend a SPREAD, specify both strikes and expiry
• If you recommend COLLAR, specify put strike to buy and call strike to sell
• Be specific with trade execution details` : hasRollOptions ? `First, decide: Should you roll, or just HOLD and let this expire?

If HOLD is best, respond:
1. HOLD - Let position expire worthless for max profit
2. [Why] - Position is OTM with X% win probability, theta is working in your favor
3. [Watch] - What price level would change this advice

If rolling IS needed, respond:
1. [Your pick] - "Roll to $XXX [date like Feb 20] - $XXX ${isLong ? 'debit' : 'credit'}"
2. [Why this one] - 1-2 sentences comparing to alternatives
3. [Key risk] - Main risk with this trade` 
: `No roll options available. Respond in this format:

1. [Action] - ${isLong ? 'Hold for rally, take profits, or cut losses' : 'Hold, close, or wait'}

2. [Why] - 1-2 sentences explaining your reasoning

3. [Risk] - One key thing to watch`}

Be specific. Use the actual numbers provided. No headers or bullet points - just the numbered items.${isLargeModel ? `

Since you're a larger model, provide additional insight:
5. [Greeks] - Brief comment on theta/delta implications
6. [Market context] - Any broader market factors to consider (if relevant)` : ''}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE IDEAS PROMPT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a prompt for generating trade ideas (with real prices!)
 * @param {Object} data - Account data and preferences
 * @param {Array} realPrices - Array of ticker price data
 * @param {Array} xTrendingTickers - Tickers trending on X/Twitter
 * @returns {string} Formatted prompt
 */
function buildIdeaPrompt(data, realPrices = [], xTrendingTickers = []) {
    const { buyingPower, targetAnnualROC, currentPositions, sectorsToAvoid, portfolioContext } = data;
    
    // Calculate upcoming monthly expiry dates (3rd Friday of month)
    const getThirdFriday = (year, month) => {
        const firstDay = new Date(year, month, 1);
        const dayOfWeek = firstDay.getDay();
        const firstFriday = dayOfWeek <= 5 ? (5 - dayOfWeek + 1) : (12 - dayOfWeek + 1);
        return new Date(year, month, firstFriday + 14);
    };
    
    const today = new Date();
    const expiryDates = [];
    for (let i = 0; i < 3; i++) {
        const targetMonth = today.getMonth() + i;
        const targetYear = today.getFullYear() + Math.floor(targetMonth / 12);
        const friday = getThirdFriday(targetYear, targetMonth % 12);
        if (friday > today) {
            const dte = Math.ceil((friday - today) / (1000 * 60 * 60 * 24));
            expiryDates.push({
                date: friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                dte: dte
            });
        }
    }
    const expiryStr = expiryDates.map(e => `${e.date} (${e.dte} DTE)`).join(', ');
    
    // Format current positions
    let currentTickers = [];
    if (currentPositions && currentPositions.length > 0) {
        currentTickers = currentPositions.map(p => p.ticker);
    }
    
    // Format real prices with context data
    let priceData = 'No price data available';
    if (realPrices.length > 0) {
        priceData = realPrices.map(p => {
            // Calculate a reasonable strike (~10% below current)
            const suggestedStrike = Math.floor(parseFloat(p.price) * 0.9);
            const putCapital = suggestedStrike * 100;
            
            let line = `${p.ticker}: $${p.price}`;
            line += ` | Range: $${p.monthLow}-$${p.monthHigh}`;
            line += ` | ${p.monthChange > 0 ? '+' : ''}${p.monthChange}% this month`;
            line += ` | ${p.rangePosition}% of range`;
            if (p.earnings) line += ` | ⚠️ Earnings: ${p.earnings}`;
            line += ` | 10% OTM strike: $${suggestedStrike} → Capital: $${putCapital.toLocaleString()}`;
            return line;
        }).join('\n');
    }
    
    return `You are a WHEEL STRATEGY advisor. Analyze the data below and pick 10 SHORT PUT trades.
PRIORITIZE variety - pick from DIFFERENT sectors. Spread across all available sectors.
If you see "Active Today" or "Trending" stocks, INCLUDE at least 2-3 of them - these are today's movers!
${xTrendingTickers.length > 0 ? `\n🔥 X/TWITTER PRIORITY: ${xTrendingTickers.join(', ')} - These are trending on FinTwit right now! Include at least 2-3 if they meet criteria!` : ''}

═══ CRITICAL RULES ═══
⚠️ NEVER pick stocks above 70% of range - they are EXTENDED and risky for puts!
⚠️ PREFER stocks 0-50% of range - these are near SUPPORT = safer put entries
⚠️ Negative month change is GOOD - pullbacks = better premium capture

═══ ACCOUNT ═══
Buying Power: $${buyingPower?.toLocaleString() || '25,000'}
Target ROC: ${targetAnnualROC || 25}%/year
Today: ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
Expiries: ${expiryStr}
${currentTickers.length > 0 ? `Already have positions in: ${currentTickers.join(', ')}` : ''}
${sectorsToAvoid ? `Avoid sectors: ${sectorsToAvoid}` : ''}
${portfolioContext ? `
═══ PORTFOLIO CONTEXT (from recent audit) ═══
${portfolioContext}
⚠️ PRIORITIZE trades that BALANCE the portfolio - reduce concentration, balance delta!` : ''}

═══ CANDIDATE DATA (real-time) ═══
${priceData}

═══ WHEEL STRATEGY CRITERIA ═══
✅ IDEAL candidates (PICK THESE):
- Range 0-40%: NEAR LOWS = excellent put entry
- Negative month change: pullback = juicy premium
- NO earnings before expiry
- Strike ~10% below current

⚠️ OKAY candidates (use judgment):
- Range 40-65%: mid-range = acceptable if other factors align
- Small positive month gain (<5%): not ideal but workable

❌ DO NOT PICK (skip these entirely):
- Range 70%+: EXTENDED, high risk of assignment
- Range 100%: AT MONTHLY HIGH - worst possible put entry
- Large positive month gain (>10%): chasing momentum

═══ EXPIRY DATES (use EXACTLY these - they are Fridays) ═══
Near-term: ${expiryDates[0]?.date || 'Feb 20'} (${expiryDates[0]?.dte || 30} DTE)
Mid-term: ${expiryDates[1]?.date || 'Mar 20'} (${expiryDates[1]?.dte || 60} DTE)

═══ FORMAT (exactly like this) ═══
1. [TICKER] @ $XX.XX - Sell $XX put, ${expiryDates[0]?.date || 'Feb 20'}
   Entry: [Why NOW is good timing - use the data: range position, month change, support level]
   Risk: [Specific risk - earnings date, sector issue, or technical concern]
   Capital: $X,XXX (COPY from data above - it's strike × 100)

2. ... (continue through 10)

Give me 10 different ideas from DIFFERENT sectors. USE THE DATA. Copy the Capital value from the candidate data.
SKIP any stock above 70% of range - those are extended and risky!
USE ONLY the expiry dates listed above - they are valid Friday expirations.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ADVISOR PROMPT - Analyzes all strategies and recommends best
// ═══════════════════════════════════════════════════════════════════════════
function buildStrategyAdvisorPrompt(context) {
    const { ticker, spot, stockData, ivRank, expirations, sampleOptions, buyingPower, accountValue, kellyBase, riskTolerance, existingPositions, dataSource } = context;
    
    // =========================================================================
    // HELPER: Round strike to valid increment ($1 for stocks > $50, $0.50 for < $50)
    // =========================================================================
    const roundStrike = (price) => {
        const increment = spot >= 50 ? 1 : 0.5;
        return Math.round(price / increment) * increment;
    };
    
    // =========================================================================
    // EXTRACT SPECIFIC STRIKES - Use REAL chain data with proper rounding
    // =========================================================================
    const puts = sampleOptions?.filter(o => o.option_type === 'P').sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike)) || [];
    const calls = sampleOptions?.filter(o => o.option_type === 'C').sort((a, b) => parseFloat(a.strike) - parseFloat(b.strike)) || [];
    
    console.log(`[STRATEGY-ADVISOR] Processing ${puts.length} puts, ${calls.length} calls for spot $${spot.toFixed(2)}`);
    // Debug: Show available put strikes
    const putStrikes = puts.map(p => `$${p.strike}`).join(', ');
    console.log(`[STRATEGY-ADVISOR] Available put strikes: ${putStrikes || 'NONE'}`);
    
    // =========================================================================
    // OTM BUFFER: Ensure short strikes are properly OTM for credit spreads
    // For puts: sell 3-5% below spot (not ATM!)
    // For calls: sell 3-5% above spot (not ATM!)
    // =========================================================================
    const otmBuffer = spot >= 100 ? 0.03 : 0.05; // 3% for stocks >$100, 5% for cheaper stocks
    const targetSellPutStrike = roundStrike(spot * (1 - otmBuffer)); // e.g., $165 * 0.97 = $160
    const targetSellCallStrike = roundStrike(spot * (1 + otmBuffer)); // e.g., $165 * 1.03 = $170
    
    console.log(`[STRATEGY-ADVISOR] OTM targets: Sell Put @ $${targetSellPutStrike}, Sell Call @ $${targetSellCallStrike} (${(otmBuffer * 100).toFixed(0)}% buffer)`);
    
    // Find ATM put (just below spot) - used for cash-secured puts (Setup A)
    const atmPut = puts.find(p => parseFloat(p.strike) <= spot) || puts[0];
    if (atmPut) {
        console.log(`[STRATEGY-ADVISOR] ATM put: $${atmPut.strike} @ $${atmPut.bid}/$${atmPut.ask}`);
    }
    
    // Find OTM put for SELLING in credit spreads (3-5% below spot)
    const spreadWidth = spot >= 100 ? 5 : (spot >= 50 ? 5 : 2.5);
    let otmPutToSell = puts.find(p => {
        const strike = parseFloat(p.strike);
        return Math.abs(strike - targetSellPutStrike) <= 2 && (p.bid > 0 || p.ask > 0);
    });
    // Fallback: find any put 3%+ below spot
    if (!otmPutToSell) {
        otmPutToSell = puts.find(p => parseFloat(p.strike) <= targetSellPutStrike && (p.bid > 0 || p.ask > 0));
    }
    // Last resort: use ATM (but log warning)
    if (!otmPutToSell) {
        otmPutToSell = atmPut;
        console.log(`[STRATEGY-ADVISOR] ⚠️ No OTM puts found, falling back to ATM for spread`);
    } else {
        console.log(`[STRATEGY-ADVISOR] ✅ OTM put to SELL: $${otmPutToSell.strike} @ $${otmPutToSell.bid}/$${otmPutToSell.ask}`);
    }
    
    // Find further OTM put for BUYING in credit spreads ($5 below sell strike)
    const targetBuyPutStrike = otmPutToSell ? parseFloat(otmPutToSell.strike) - spreadWidth : targetSellPutStrike - spreadWidth;
    let otmPutToBuy = puts.find(p => {
        const strike = parseFloat(p.strike);
        return Math.abs(strike - targetBuyPutStrike) <= 1 && p !== otmPutToSell && (p.bid > 0 || p.ask > 0);
    });
    // Fallback: find next lower strike
    if (!otmPutToBuy) {
        otmPutToBuy = puts.find(p => {
            const strike = parseFloat(p.strike);
            return strike < parseFloat(otmPutToSell?.strike || spot) - 2 && p !== otmPutToSell && (p.bid > 0 || p.ask > 0);
        });
    }
    // If STILL no OTM put, create synthetic
    if (!otmPutToBuy && otmPutToSell) {
        const syntheticStrike = roundStrike(parseFloat(otmPutToSell.strike) - spreadWidth);
        const sellMid = (parseFloat(otmPutToSell.bid) + parseFloat(otmPutToSell.ask)) / 2;
        otmPutToBuy = { strike: syntheticStrike, bid: sellMid * 0.55, ask: sellMid * 0.65, synthetic: true };
        console.log(`[STRATEGY-ADVISOR] ⚠️ Created SYNTHETIC buy put: $${syntheticStrike}`);
    } else if (otmPutToBuy) {
        console.log(`[STRATEGY-ADVISOR] ✅ OTM put to BUY: $${otmPutToBuy.strike} @ $${otmPutToBuy.bid}/$${otmPutToBuy.ask}`);
    }
    
    // Find ATM call (just above spot) - used for covered calls (Setup C)
    const atmCall = calls.find(c => parseFloat(c.strike) >= spot) || calls[0];
    
    // Find OTM call for SELLING in credit spreads (3-5% above spot)
    let otmCallToSell = calls.find(c => {
        const strike = parseFloat(c.strike);
        return Math.abs(strike - targetSellCallStrike) <= 2 && (c.bid > 0 || c.ask > 0);
    });
    if (!otmCallToSell) {
        otmCallToSell = calls.find(c => parseFloat(c.strike) >= targetSellCallStrike && (c.bid > 0 || c.ask > 0));
    }
    if (!otmCallToSell) {
        otmCallToSell = atmCall;
        console.log(`[STRATEGY-ADVISOR] ⚠️ No OTM calls found, falling back to ATM for spread`);
    } else {
        console.log(`[STRATEGY-ADVISOR] ✅ OTM call to SELL: $${otmCallToSell.strike} @ $${otmCallToSell.bid}/$${otmCallToSell.ask}`);
    }
    
    // Find further OTM call for BUYING in credit spreads ($5 above sell strike)
    const targetBuyCallStrike = otmCallToSell ? parseFloat(otmCallToSell.strike) + spreadWidth : targetSellCallStrike + spreadWidth;
    let otmCallToBuy = calls.find(c => {
        const strike = parseFloat(c.strike);
        return Math.abs(strike - targetBuyCallStrike) <= 1 && c !== otmCallToSell && (c.bid > 0 || c.ask > 0);
    });
    if (!otmCallToBuy) {
        otmCallToBuy = calls.find(c => {
            const strike = parseFloat(c.strike);
            return strike > parseFloat(otmCallToSell?.strike || spot) + 2 && c !== otmCallToSell && (c.bid > 0 || c.ask > 0);
        });
    }
    if (!otmCallToBuy && otmCallToSell) {
        const syntheticStrike = roundStrike(parseFloat(otmCallToSell.strike) + spreadWidth);
        const sellMid = (parseFloat(otmCallToSell.bid) + parseFloat(otmCallToSell.ask)) / 2;
        otmCallToBuy = { strike: syntheticStrike, bid: sellMid * 0.55, ask: sellMid * 0.65, synthetic: true };
        console.log(`[STRATEGY-ADVISOR] ⚠️ Created SYNTHETIC buy call: $${syntheticStrike}`);
    } else if (otmCallToBuy) {
        console.log(`[STRATEGY-ADVISOR] ✅ OTM call to BUY: $${otmCallToBuy.strike} @ $${otmCallToBuy.bid}/$${otmCallToBuy.ask}`);
    }
    
    // =========================================================================
    // FINAL STRIKE ASSIGNMENTS
    // - Setup A (Cash-Secured Put): Uses ATM put
    // - Setup B (Put Credit Spread): Sell OTM put, Buy further OTM put
    // - Setup C (Covered Call): Uses ATM call
    // - Setup D (Call Credit Spread): Sell OTM call, Buy further OTM call
    // =========================================================================
    const sellPutStrike = otmPutToSell ? parseFloat(otmPutToSell.strike) : roundStrike(spot * 0.97);
    const buyPutStrike = otmPutToBuy ? parseFloat(otmPutToBuy.strike) : roundStrike(sellPutStrike - spreadWidth);
    const sellCallStrike = otmCallToSell ? parseFloat(otmCallToSell.strike) : roundStrike(spot * 1.03);
    const buyCallStrike = otmCallToBuy ? parseFloat(otmCallToBuy.strike) : roundStrike(sellCallStrike + spreadWidth);
    
    // For Setup A (cash-secured put), use ATM strike for higher premium
    const cashSecuredPutStrike = atmPut ? parseFloat(atmPut.strike) : roundStrike(spot - 1);
    // For Setup C (covered call), use ATM strike
    const coveredCallStrike = atmCall ? parseFloat(atmCall.strike) : roundStrike(spot + 1);
    
    console.log(`[STRATEGY-ADVISOR] Final strikes:`);
    console.log(`  Put Credit Spread: Sell $${sellPutStrike} / Buy $${buyPutStrike}`);
    console.log(`  Call Credit Spread: Sell $${sellCallStrike} / Buy $${buyCallStrike}`);
    console.log(`  Cash-Secured Put: $${cashSecuredPutStrike}`);
    console.log(`  Covered Call: $${coveredCallStrike}`);
    
    // Calculate ACTUAL spread width (may differ from target due to available strikes)
    const putSpreadWidth = sellPutStrike - buyPutStrike;
    const callSpreadWidth = buyCallStrike - sellCallStrike;
    
    // Calculate premiums - use the OTM options for spreads
    const otmPutSellMid = otmPutToSell ? (parseFloat(otmPutToSell.bid) + parseFloat(otmPutToSell.ask)) / 2 : 1.50;
    const otmPutBuyMid = otmPutToBuy ? (parseFloat(otmPutToBuy.bid) + parseFloat(otmPutToBuy.ask)) / 2 : otmPutSellMid * 0.5;
    const putSpreadCredit = Math.max(0.10, otmPutSellMid - otmPutBuyMid);
    
    const otmCallSellMid = otmCallToSell ? (parseFloat(otmCallToSell.bid) + parseFloat(otmCallToSell.ask)) / 2 : 1.50;
    const otmCallBuyMid = otmCallToBuy ? (parseFloat(otmCallToBuy.bid) + parseFloat(otmCallToBuy.ask)) / 2 : otmCallSellMid * 0.5;
    const callSpreadCredit = Math.max(0.10, otmCallSellMid - otmCallBuyMid);
    
    // Calculate Risk:Reward ratios for spreads
    const putMaxLossPerShare = putSpreadWidth - putSpreadCredit;
    const putRiskReward = putSpreadCredit > 0 ? (putMaxLossPerShare / putSpreadCredit).toFixed(2) : 999;
    const putRiskRewardRating = parseFloat(putRiskReward) < 1.5 ? '🎯 Excellent' : 
                                 parseFloat(putRiskReward) < 2 ? '✅ Good' : 
                                 parseFloat(putRiskReward) < 3 ? '⚠️ Marginal' : '❌ Poor';
    
    const callMaxLossPerShare = callSpreadWidth - callSpreadCredit;
    const callRiskReward = callSpreadCredit > 0 ? (callMaxLossPerShare / callSpreadCredit).toFixed(2) : 999;
    const callRiskRewardRating = parseFloat(callRiskReward) < 1.5 ? '🎯 Excellent' : 
                                  parseFloat(callRiskReward) < 2 ? '✅ Good' : 
                                  parseFloat(callRiskReward) < 3 ? '⚠️ Marginal' : '❌ Poor';
    
    console.log(`[STRATEGY-ADVISOR] Risk:Reward - Put Spread: ${putRiskReward}:1 (${putRiskRewardRating}), Call Spread: ${callRiskReward}:1 (${callRiskRewardRating})`);
    
    // ATM premiums for cash-secured put and covered call
    const atmPutMid = atmPut ? (parseFloat(atmPut.bid) + parseFloat(atmPut.ask)) / 2 : 2.00;
    const atmCallMid = atmCall ? (parseFloat(atmCall.bid) + parseFloat(atmCall.ask)) / 2 : 2.00;
    
    // =========================================================================
    // NEW STRATEGIES: Additional strike calculations for E, F, G, H
    // =========================================================================
    
    // For Long Put (E) and Long Call (F) - find slightly OTM options to buy
    // Use strikes about 3-5% OTM for reasonable premium cost
    const longPutStrike = roundStrike(spot * 0.97);  // 3% OTM put
    const longCallStrike = roundStrike(spot * 1.03); // 3% OTM call
    
    // Find actual options near these strikes
    const longPut = puts.find(p => Math.abs(parseFloat(p.strike) - longPutStrike) <= 2) || 
                    { strike: longPutStrike, bid: atmPutMid * 0.6, ask: atmPutMid * 0.7 };
    const longCall = calls.find(c => Math.abs(parseFloat(c.strike) - longCallStrike) <= 2) ||
                     { strike: longCallStrike, bid: atmCallMid * 0.6, ask: atmCallMid * 0.7 };
    
    const longPutPremium = (parseFloat(longPut.bid) + parseFloat(longPut.ask)) / 2;
    const longCallPremium = (parseFloat(longCall.bid) + parseFloat(longCall.ask)) / 2;
    const longPutStrikeActual = parseFloat(longPut.strike);
    const longCallStrikeActual = parseFloat(longCall.strike);
    
    // Find ideal expiration: target 30-45 DTE for wheel strategies
    // Weeklies (< 7 days) have too much gamma risk and not enough premium
    // IMPORTANT: Define this BEFORE LEAPS/SKIP calculations that use it as fallback
    let targetExpiry = expirations?.[0] || 'next monthly';
    if (expirations && expirations.length > 1) {
        const today = new Date();
        for (const exp of expirations) {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            if (dte >= 21) { // Prefer 21+ DTE for premium decay
                targetExpiry = exp;
                break;
            }
        }
        // If no 21+ DTE found, use the furthest available
        if (targetExpiry === expirations[0]) {
            targetExpiry = expirations[expirations.length - 1];
        }
    }
    const firstExpiry = targetExpiry;
    
    // For Iron Condor (G) - use same strikes as B and D combined
    // Put side: sell ATM put, buy OTM put (same as B)
    // Call side: sell ATM call, buy OTM call (same as D)
    const ironCondorCredit = putSpreadCredit + callSpreadCredit;
    const ironCondorMaxLoss = Math.max(putSpreadWidth, callSpreadWidth) - ironCondorCredit;
    const ironCondorPutBreakeven = sellPutStrike - ironCondorCredit;
    const ironCondorCallBreakeven = sellCallStrike + ironCondorCredit;
    
    // For SKIP™ (H) - find LEAPS (longest expiry) and shorter-term call
    const leapsExpiry = expirations?.find(exp => {
        const dte = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
        return dte >= 180; // 6+ months
    }) || expirations?.[expirations.length - 1] || firstExpiry;
    
    const skipCallExpiry = expirations?.find(exp => {
        const dte = Math.ceil((new Date(exp) - new Date()) / (1000 * 60 * 60 * 24));
        return dte >= 45 && dte <= 120; // 45-120 DTE for SKIP call
    }) || firstExpiry;
    
    // LEAPS: ATM or slightly ITM call (better delta)
    const leapsStrike = roundStrike(spot * 0.95); // 5% ITM for good delta
    const leapsPremium = atmCallMid * 2.5; // LEAPS cost more (rough estimate)
    
    // SKIP call: OTM call (5-10% above spot)
    const skipStrike = roundStrike(spot * 1.07); // 7% OTM
    const skipPremium = atmCallMid * 0.4; // OTM shorter-term call
    
    // Calculate deltas (BULL PUT = POSITIVE delta, BEAR CALL = NEGATIVE delta)
    const atmPutDelta = atmPut?.delta ? parseFloat(atmPut.delta) : -0.45; // ATM put delta ~-0.45
    const otmPutDelta = otmPut?.delta ? parseFloat(otmPut.delta) : -0.25; // OTM put delta ~-0.25
    // Bull put spread net delta = |short put delta| - |long put delta| = POSITIVE
    const putSpreadDelta = Math.abs(atmPutDelta) - Math.abs(otmPutDelta); // ~+0.20 per contract
    
    const atmCallDelta = atmCall?.delta ? parseFloat(atmCall.delta) : 0.45;
    const otmCallDelta = otmCall?.delta ? parseFloat(otmCall.delta) : 0.25;
    // Bear call spread net delta = -(short call delta - long call delta) = NEGATIVE  
    const callSpreadDelta = -(atmCallDelta - otmCallDelta); // ~-0.20 per contract
    
    // =========================================================================
    // PROP DESK WARNINGS - Professional risk management checks
    // =========================================================================
    const propDeskWarnings = [];
    
    // 1. Calculate DTE for gamma warning
    const today = new Date();
    let targetDTE = 30;
    if (firstExpiry && firstExpiry !== 'next monthly') {
        const expDate = new Date(firstExpiry);
        targetDTE = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
    }
    
    // Gamma alert: Short DTE + wide spread = high gamma risk
    if (targetDTE < 14 && putSpreadWidth >= spot * 0.03) {
        propDeskWarnings.push(`⚠️ HIGH GAMMA RISK: ${targetDTE} DTE with $${putSpreadWidth} spread. Short expiry amplifies losses on gaps.`);
    }
    
    // 2. IV vs estimated HV check (rough approximation)
    // High IV may persist in volatile assets
    if (ivRank > 70) {
        propDeskWarnings.push(`📊 IV ELEVATED (${ivRank}%): Good for selling, but vol could persist or spike on news. Set stops.`);
    } else if (ivRank < 30) {
        propDeskWarnings.push(`📉 IV LOW (${ivRank}%): Options are cheap. Favor buying strategies or wait for vol spike.`);
    }
    
    // 3. Position sizing guidance
    const marginPerSpread = putSpreadWidth * 100;
    const maxContractsByKelly = buyingPower > 0 ? Math.floor(buyingPower / marginPerSpread) : 10;
    const conservativeContracts = Math.max(1, Math.floor(maxContractsByKelly * 0.6)); // 60% of max
    propDeskWarnings.push(`💰 POSITION SIZE: Max ${maxContractsByKelly} contracts by Kelly, recommend ${conservativeContracts} (60% for safety buffer).`);
    
    // 4. Liquidity check (approximate - we'd need OI data for real check)
    // Flag if using very low-priced options
    if (atmPutMid < 0.50 || otmPutMid < 0.20) {
        propDeskWarnings.push(`💧 LIQUIDITY NOTE: Low premium options may have wide bid/ask spreads. Consider legging in.`);
    }
    
    // 5. Win probability from delta
    const winProbability = Math.round((1 - Math.abs(atmPutDelta)) * 100);
    
    // DEBUG: Log what we're sending to AI
    console.log(`[STRATEGY-ADVISOR] Pre-calculated values for AI prompt:`);
    console.log(`  ATM Put: $${atmPut?.strike} bid=${atmPut?.bid} ask=${atmPut?.ask} → mid=$${atmPutMid.toFixed(2)}`);
    console.log(`  OTM Put: $${otmPut?.strike} bid=${otmPut?.bid} ask=${otmPut?.ask} → mid=$${otmPutMid.toFixed(2)}`);
    console.log(`  Sell Put: $${sellPutStrike}, Buy Put: $${buyPutStrike}, Width: $${putSpreadWidth}`);
    console.log(`  Put Spread Credit: $${putSpreadCredit.toFixed(2)} (sell $${atmPutMid.toFixed(2)} - buy $${otmPutMid.toFixed(2)})`);
    console.log(`  Sell Call: $${sellCallStrike}, Buy Call: $${buyCallStrike}, Width: $${callSpreadWidth}`);
    console.log(`  Call Spread Credit: $${callSpreadCredit.toFixed(2)}`);
    console.log(`  Put Spread Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)`);
    console.log(`  First Expiry: ${firstExpiry}`);
    console.log(`  Options in chain: ${sampleOptions?.length || 0}, Puts: ${puts.length}, Calls: ${calls.length}`);
    
    // DEBUG: Log the exact TOTALS being sent (to verify AI isn't hallucinating)
    const totalMaxProfit = putSpreadCredit * 100 * conservativeContracts;
    const totalMaxLoss = (putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts;
    console.log(`[STRATEGY-ADVISOR] 💰 EXACT TOTALS BEING SENT TO AI:`);
    console.log(`  Conservative contracts: ${conservativeContracts}`);
    console.log(`  Max Profit per contract: $${(putSpreadCredit * 100).toFixed(0)}`);
    console.log(`  Max Loss per contract: $${((putSpreadWidth - putSpreadCredit) * 100).toFixed(0)}`);
    console.log(`  TOTAL MAX PROFIT: $${totalMaxProfit.toLocaleString()} ← AI MUST output this EXACT number`);
    console.log(`  TOTAL MAX LOSS: $${totalMaxLoss.toLocaleString()} ← AI MUST output this EXACT number`);
    
    // Format sample options for context - CRYSTAL CLEAR format to prevent AI confusion
    let optionsContext = '';
    let availableStrikes = { puts: [], calls: [] };
    
    if (sampleOptions && sampleOptions.length > 0) {
        // Group by type for clarity
        const putOptions = sampleOptions.filter(o => o.option_type === 'P');
        const callOptions = sampleOptions.filter(o => o.option_type === 'C');
        
        // Extract unique strikes for explicit constraint
        availableStrikes.puts = [...new Set(putOptions.map(o => parseFloat(o.strike)))].sort((a, b) => b - a);
        availableStrikes.calls = [...new Set(callOptions.map(o => parseFloat(o.strike)))].sort((a, b) => a - b);
        
        // Calculate strike increment
        const strikeIncrement = availableStrikes.puts.length > 1 
            ? Math.abs(availableStrikes.puts[0] - availableStrikes.puts[1]) 
            : 5;
        
        optionsContext = `═══════════════════════════════════════════════════════════════
⚠️ CRITICAL: STRIKE PRICE ≈ STOCK PRICE ($${spot.toFixed(0)}), PREMIUM = SMALL ($1-$5)
═══════════════════════════════════════════════════════════════

🔒 AVAILABLE STRIKES (YOU MUST ONLY USE THESE - others don't exist!):
   Strike increment: $${strikeIncrement}
   PUT STRIKES: ${availableStrikes.puts.map(s => '$' + s).join(', ')}
   CALL STRIKES: ${availableStrikes.calls.map(s => '$' + s).join(', ')}

`;
        
        if (putOptions.length > 0) {
            optionsContext += `PUT OPTIONS (for selling puts or put spreads):\n`;
            optionsContext += putOptions.slice(0, 8).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? Math.abs(parseFloat(o.delta)).toFixed(2) : '?';
                return `  • STRIKE $${strike.toFixed(0)} put → You receive $${mid}/share premium (Δ${delta})`;
            }).join('\n');
            optionsContext += '\n\n';
        }
        
        if (callOptions.length > 0) {
            optionsContext += `CALL OPTIONS (for covered calls or call spreads):\n`;
            optionsContext += callOptions.slice(0, 8).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? Math.abs(parseFloat(o.delta)).toFixed(2) : '?';
                return `  • STRIKE $${strike.toFixed(0)} call → You receive $${mid}/share premium (Δ${delta})`;
            }).join('\n');
        }
        
        optionsContext += `\n\n🚨 REMEMBER: Use ONLY strikes from the list above! Do NOT invent strikes like $156 if only $155 and $160 exist.`;
    } else {
        optionsContext = 'No options data available - use estimated strikes near current price.';
    }
    
    // Format existing positions
    let positionsContext = 'None';
    if (existingPositions && existingPositions.length > 0) {
        const tickerPositions = existingPositions.filter(p => p.ticker?.toUpperCase() === ticker.toUpperCase());
        if (tickerPositions.length > 0) {
            positionsContext = tickerPositions.map(p => `  - ${p.type}: $${p.strike} exp ${p.expiry}`).join('\n');
        } else {
            positionsContext = 'None for this ticker (but user has other positions)';
        }
    }
    
    // Calculate range position description
    let rangeDesc = '';
    if (stockData.rangePosition !== undefined) {
        if (stockData.rangePosition < 25) rangeDesc = 'Near 3-month LOW (potentially oversold)';
        else if (stockData.rangePosition < 50) rangeDesc = 'Lower half of 3-month range';
        else if (stockData.rangePosition < 75) rangeDesc = 'Upper half of 3-month range';
        else rangeDesc = 'Near 3-month HIGH (potentially overbought)';
    }
    
    // IV context
    let ivDesc = 'Unknown';
    if (ivRank !== null) {
        if (ivRank < 20) ivDesc = `Low (${ivRank}%) - options are cheap, favor BUYING strategies`;
        else if (ivRank < 40) ivDesc = `Below average (${ivRank}%) - slightly favors buying`;
        else if (ivRank < 60) ivDesc = `Moderate (${ivRank}%) - neutral`;
        else if (ivRank < 80) ivDesc = `Elevated (${ivRank}%) - favors SELLING strategies`;
        else ivDesc = `High (${ivRank}%) - options are expensive, strongly favor SELLING`;
    }
    
    const promptText = `You are an expert options strategist helping a trader who is NEW to complex strategies beyond basic puts and calls.

═══════════════════════════════════════════════════════════════════════════
TICKER: ${ticker}
CURRENT PRICE: $${spot.toFixed(2)}
DATA SOURCE: ${dataSource}
═══════════════════════════════════════════════════════════════════════════

MARKET CONTEXT:
• 3-Month Range: $${stockData.low3mo?.toFixed(2) || '?'} - $${stockData.high3mo?.toFixed(2) || '?'}
• Position in Range: ${stockData.rangePosition || '?'}% (${rangeDesc})
• IV Rank: ${ivDesc}
• Available Expirations: ${expirations?.slice(0, 4).join(', ') || 'Unknown'}

REAL OPTIONS CHAIN DATA (USE THESE EXACT STRIKES AND PREMIUMS!):
⚠️ STRIKE = the price level where option activates (near current price of $${spot.toFixed(2)})
⚠️ PREMIUM = what you pay/receive for the option (the bid/ask prices below)
${optionsContext || 'Options data not available'}

USER PROFILE:
• Available Capital: $${buyingPower.toLocaleString()} (Kelly-adjusted, Half-Kelly of account)${kellyBase ? `\n• Kelly Base: $${kellyBase.toLocaleString()} (Account Value + 25% margin)` : ''}${accountValue ? `\n• Account Value: $${accountValue.toLocaleString()}` : ''}
• Risk Tolerance: ${riskTolerance}
• Existing ${ticker} Positions:
${positionsContext}

═══════════════════════════════════════════════════════════════════════════
🏦 PROP DESK RISK CHECKS:
═══════════════════════════════════════════════════════════════════════════
${propDeskWarnings.join('\n')}

═══════════════════════════════════════════════════════════════════════════
PRE-CALCULATED SPREAD VALUES (USE THESE EXACT NUMBERS!):
═══════════════════════════════════════════════════════════════════════════
PUT CREDIT SPREAD (Bull Put):
• Sell: $${sellPutStrike} put @ $${atmPutMid.toFixed(2)}
• Buy: $${buyPutStrike} put @ $${otmPutMid.toFixed(2)}
• Net Credit: $${putSpreadCredit.toFixed(2)} per share ($${(putSpreadCredit * 100).toFixed(0)} per contract)
• Spread Width: $${putSpreadWidth}
• Max Loss: $${(putSpreadWidth - putSpreadCredit).toFixed(2)} per share
• Breakeven: $${(sellPutStrike - putSpreadCredit).toFixed(2)}
• Net Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)
• Win Probability: ~${winProbability}%
• Recommended Contracts: ${conservativeContracts}

CALL CREDIT SPREAD (Bear Call):
• Sell: $${sellCallStrike} call
• Buy: $${buyCallStrike} call
• Net Credit: $${callSpreadCredit.toFixed(2)} per share
• Net Delta: ${(callSpreadDelta * 100).toFixed(0)} per contract (BEARISH)

═══════════════════════════════════════════════════════════════════════════
STRATEGIES TO EVALUATE (analyze ALL of these):
═══════════════════════════════════════════════════════════════════════════

1. SHORT PUT (Cash-Secured Put)
   📱 Schwab App: "Single" → Put → Sell
   - Sell a put, collect premium, may get assigned stock
   - Bullish strategy, unlimited risk if stock crashes

2. COVERED CALL (if user owns shares)
   📱 Schwab App: "Single" → Call → Sell (must own 100 shares)
   - Sell a call against shares you own
   - Neutral/slightly bullish, caps upside

3. LONG CALL
   📱 Schwab App: "Single" → Call → Buy
   - Buy a call for leveraged upside
   - Very bullish, lose entire premium if wrong

4. PUT CREDIT SPREAD (Bull Put Spread)
   📱 Schwab App: "Vertical" → Put → Sell higher strike, Buy lower strike
   - Sell higher put, buy lower put for protection
   - Bullish with DEFINED RISK (max loss = width - credit)

5. CALL DEBIT SPREAD (Bull Call Spread)
   📱 Schwab App: "Vertical" → Call → Buy lower strike, Sell higher strike
   - Buy lower call, sell higher call to reduce cost
   - Bullish with defined risk/reward

6. CALL CREDIT SPREAD (Bear Call Spread)
   📱 Schwab App: "Vertical" → Call → Sell lower strike, Buy higher strike
   - Sell lower call, buy higher call for protection
   - Bearish with defined risk

7. PUT DEBIT SPREAD (Bear Put Spread)
   📱 Schwab App: "Vertical" → Put → Buy higher strike, Sell lower strike
   - Buy higher put, sell lower put
   - Bearish with defined risk

8. IRON CONDOR
   📱 Schwab App: "Iron Condor" (4 legs)
   - Sell put spread + call spread
   - Neutral - profits if stock stays in range

9. SKIP™ (Long LEAPS + Short-term Call)
   📱 Schwab App: "Diagonal" (2 calls, different expirations)
   - Buy long-dated call (12+ months) + shorter call (3-6 months)
   - Long-term bullish with reduced cost basis

═══════════════════════════════════════════════════════════════════════════
YOUR TASK: Recommend THE BEST strategy for this situation
═══════════════════════════════════════════════════════════════════════════

⚠️ RISK:REWARD FILTER (MANDATORY):
• Credit spreads with R:R > 3:1 should be REJECTED or replaced with better alternatives
• 🎯 Excellent (<1.5:1) = Highly recommend if market view matches
• ✅ Good (1.5-2:1) = Acceptable for most traders
• ⚠️ Marginal (2-3:1) = Only if high win probability justifies it
• ❌ Poor (>3:1) = DO NOT recommend - risk too high for reward

🚨🚨🚨 MANDATORY STRIKE PRICES (valid CBOE strikes near $${spot.toFixed(0)}):
   
   FOR PUTS:  Sell the $${sellPutStrike} strike, Buy the $${buyPutStrike} strike (${putSpreadWidth} point spread)
   FOR CALLS: Sell the $${sellCallStrike} strike, Buy the $${buyCallStrike} strike (${callSpreadWidth} point spread)
   EXPIRATION: ${firstExpiry}

VALID TRADE SETUPS (these are the ONLY options - pick ONE):

SETUP A - Short Put (Cash-Secured) - Schwab: "Single" → Put → Sell:
  Trade: Sell ${ticker} $${cashSecuredPutStrike} Put, ${firstExpiry}
  Credit Received: $${atmPutMid.toFixed(2)}/share
  ⚠️ NOTE: Uses ATM strike ($${cashSecuredPutStrike}) for higher premium. More aggressive than spread.
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(atmPutMid * 100).toFixed(0)} (keep all premium)
  • Max Loss per contract: $${((cashSecuredPutStrike - atmPutMid) * 100).toFixed(0)} (assigned at $${cashSecuredPutStrike} minus premium)
  • Breakeven: $${(cashSecuredPutStrike - atmPutMid).toFixed(2)}
  • Buying Power per contract: $${(cashSecuredPutStrike * 100).toLocaleString()} (cash-secured)
  • Max contracts with $${buyingPower.toLocaleString()}: ${Math.floor(buyingPower / (cashSecuredPutStrike * 100))}
  • Recommended contracts: ${Math.max(1, Math.floor(Math.floor(buyingPower / (cashSecuredPutStrike * 100)) * 0.6))} (60% of max)
  
  💰 TOTALS FOR ${Math.max(1, Math.floor(Math.floor(buyingPower / (cashSecuredPutStrike * 100)) * 0.6))} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(atmPutMid * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (cashSecuredPutStrike * 100)) * 0.6))).toLocaleString()}
  • TOTAL MAX LOSS: $${((cashSecuredPutStrike - atmPutMid) * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (cashSecuredPutStrike * 100)) * 0.6))).toLocaleString()} (if stock goes to $0)
  • TOTAL BUYING POWER USED: $${(cashSecuredPutStrike * 100 * Math.max(1, Math.floor(Math.floor(buyingPower / (cashSecuredPutStrike * 100)) * 0.6))).toLocaleString()}
  
  • Delta: +${Math.abs(atmPutDelta * 100).toFixed(0)} per contract (BULLISH)
  • Win Probability: ~${Math.round((1 - Math.abs(atmPutDelta)) * 100)}%
  ⚠️ RISK: Unlimited loss if stock crashes. Requires significant buying power.

SETUP B - Put Credit Spread (Bull Put) - Schwab: "Vertical" → Put:
  Trade: Sell ${ticker} $${sellPutStrike}/$${buyPutStrike} Put Spread, ${firstExpiry}
  Spread Width: $${putSpreadWidth.toFixed(2)}
  Credit Received: $${putSpreadCredit.toFixed(2)}/share
  ✅ OTM BUFFER: Short strike $${sellPutStrike} is ${((1 - sellPutStrike/spot) * 100).toFixed(1)}% below spot ($${spot.toFixed(2)})
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(putSpreadCredit * 100).toFixed(0)}
  • Max Loss per contract: $${((putSpreadWidth - putSpreadCredit) * 100).toFixed(0)}
  • Breakeven: $${(sellPutStrike - putSpreadCredit).toFixed(2)}
  • Buying Power per contract: $${(putSpreadWidth * 100).toFixed(0)}
  • Recommended contracts: ${conservativeContracts} (60% of Kelly)
  
  💰 TOTALS FOR ${conservativeContracts} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(putSpreadCredit * 100 * conservativeContracts).toLocaleString()}
  • TOTAL MAX LOSS: $${((putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts).toLocaleString()}
  • TOTAL BUYING POWER USED: $${(putSpreadWidth * 100 * conservativeContracts).toLocaleString()}
  
  • Risk/Reward Ratio: ${putRiskReward}:1 ${putRiskRewardRating}
  • Delta: +${(putSpreadDelta * 100).toFixed(0)} per contract (BULLISH)
  • Win Probability: ~${winProbability}%
  ${parseFloat(putRiskReward) >= 3 ? '❌ WARNING: Poor R:R ratio (>3:1) - consider different strikes or strategy!' : ''}

SETUP C - Covered Call - Schwab: "Single" → Call → Sell (must own shares):
  Trade: Sell ${ticker} $${coveredCallStrike} Call, ${firstExpiry}
  Credit: ~$${atmCallMid.toFixed(2)}/share
  ⚠️ REQUIREMENT: Must own 100 shares of ${ticker} per contract
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(atmCallMid * 100).toFixed(0)} premium + stock gains up to strike
  • Max upside if called: $${((coveredCallStrike - spot + atmCallMid) * 100).toFixed(0)} (stock at $${coveredCallStrike} + premium)
  • Breakeven: $${(spot - atmCallMid).toFixed(2)} (stock cost - premium)
  • Stock ownership required: 100 shares at ~$${spot.toFixed(2)} = $${(spot * 100).toLocaleString()} per contract
  
  💰 FOR 1 CONTRACT (100 shares):
  • PREMIUM COLLECTED: $${(atmCallMid * 100).toFixed(0)}
  • MAX PROFIT IF CALLED: $${((coveredCallStrike - spot + atmCallMid) * 100).toFixed(0)}
  
  • Delta: -${Math.abs(atmCallDelta * 100).toFixed(0)} per contract (reduces long delta from shares)
  ⚠️ NOTE: Only valid if user OWNS ${ticker} shares. Caps upside above $${coveredCallStrike}.

SETUP D - Call Credit Spread (Bear Call) - Schwab: "Vertical" → Call:
  Trade: Sell ${ticker} $${sellCallStrike}/$${buyCallStrike} Call Spread, ${firstExpiry}
  Spread Width: $${callSpreadWidth.toFixed(2)}
  Credit Received: $${callSpreadCredit.toFixed(2)}/share
  ✅ OTM BUFFER: Short strike $${sellCallStrike} is ${((sellCallStrike/spot - 1) * 100).toFixed(1)}% above spot ($${spot.toFixed(2)})
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(callSpreadCredit * 100).toFixed(0)}
  • Max Loss per contract: $${((callSpreadWidth - callSpreadCredit) * 100).toFixed(0)}
  • Breakeven: $${(sellCallStrike + callSpreadCredit).toFixed(2)}
  • Buying Power per contract: $${(callSpreadWidth * 100).toFixed(0)}
  • Recommended contracts: ${conservativeContracts} (60% of Kelly)
  
  💰 TOTALS FOR ${conservativeContracts} CONTRACTS (COPY EXACTLY):
  • TOTAL MAX PROFIT: $${(callSpreadCredit * 100 * conservativeContracts).toLocaleString()}
  • TOTAL MAX LOSS: $${((callSpreadWidth - callSpreadCredit) * 100 * conservativeContracts).toLocaleString()}
  • TOTAL BUYING POWER USED: $${(callSpreadWidth * 100 * conservativeContracts).toLocaleString()}
  
  • Risk/Reward Ratio: ${callRiskReward}:1 ${callRiskRewardRating}
  • Delta: ${(callSpreadDelta * 100).toFixed(0)} per contract (BEARISH)
  • Win Probability: ~${Math.round((1 - Math.abs(atmCallDelta)) * 100)}%
  ${parseFloat(callRiskReward) >= 3 ? '❌ WARNING: Poor R:R ratio (>3:1) - consider different strikes or strategy!' : ''}

SETUP E - Long Put - Schwab: "Single" → Put → Buy:
  Trade: Buy ${ticker} $${longPutStrikeActual.toFixed(0)} Put, ${firstExpiry}
  Debit Paid: $${longPutPremium.toFixed(2)}/share
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: UNLIMITED (stock to $0 = $${(longPutStrikeActual * 100).toLocaleString()})
  • Max Loss per contract: $${(longPutPremium * 100).toFixed(0)} (premium paid)
  • Breakeven: $${(longPutStrikeActual - longPutPremium).toFixed(2)}
  • Cost per contract: $${(longPutPremium * 100).toFixed(0)}
  • Recommended contracts: ${Math.max(1, Math.floor(buyingPower / (longPutPremium * 100) * 0.3))} (30% of max - speculative)
  
  💰 TOTALS FOR ${Math.max(1, Math.floor(buyingPower / (longPutPremium * 100) * 0.3))} CONTRACTS:
  • TOTAL COST: $${(longPutPremium * 100 * Math.max(1, Math.floor(buyingPower / (longPutPremium * 100) * 0.3))).toLocaleString()}
  • TOTAL MAX LOSS: $${(longPutPremium * 100 * Math.max(1, Math.floor(buyingPower / (longPutPremium * 100) * 0.3))).toLocaleString()} (if stock stays above $${longPutStrikeActual.toFixed(0)})
  
  • Delta: ${(otmPutDelta * 100).toFixed(0)} per contract (BEARISH)
  ⚠️ RISK: Lose entire premium if stock doesn't drop. Time decay works AGAINST you.
  ✅ WHEN TO USE: Strong bearish conviction, expecting significant drop. Cheaper than shorting stock.

SETUP F - Long Call (Bullish, Defined Risk) - Schwab: "Single" → Call → Buy - ALL MATH PRE-CALCULATED:
  Trade: Buy ${ticker} $${longCallStrikeActual.toFixed(0)} Call, ${firstExpiry}
  Debit Paid: $${longCallPremium.toFixed(2)}/share
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: UNLIMITED (stock to moon)
  • Max Loss per contract: $${(longCallPremium * 100).toFixed(0)} (premium paid)
  • Breakeven: $${(longCallStrikeActual + longCallPremium).toFixed(2)}
  • Cost per contract: $${(longCallPremium * 100).toFixed(0)}
  • Recommended contracts: ${Math.max(1, Math.floor(buyingPower / (longCallPremium * 100) * 0.3))} (30% of max - speculative)
  
  💰 TOTALS FOR ${Math.max(1, Math.floor(buyingPower / (longCallPremium * 100) * 0.3))} CONTRACTS:
  • TOTAL COST: $${(longCallPremium * 100 * Math.max(1, Math.floor(buyingPower / (longCallPremium * 100) * 0.3))).toLocaleString()}
  • TOTAL MAX LOSS: $${(longCallPremium * 100 * Math.max(1, Math.floor(buyingPower / (longCallPremium * 100) * 0.3))).toLocaleString()} (if stock stays below $${longCallStrikeActual.toFixed(0)})
  
  • Delta: +${(otmCallDelta * 100).toFixed(0)} per contract (BULLISH)
  ⚠️ RISK: Lose entire premium if stock doesn't rise. Time decay works AGAINST you.
  ✅ WHEN TO USE: Strong bullish conviction, expecting significant rise. Cheaper than buying stock.

SETUP G - Iron Condor (Neutral, Range-Bound) - Schwab: "Iron Condor" - ALL MATH PRE-CALCULATED:
  Trade: Sell ${ticker} $${sellPutStrike}/$${buyPutStrike}/$${sellCallStrike}/$${buyCallStrike} Iron Condor, ${firstExpiry}
  Put Spread: $${sellPutStrike}/$${buyPutStrike} (Bull Put) - ${((1 - sellPutStrike/spot) * 100).toFixed(1)}% below spot
  Call Spread: $${sellCallStrike}/$${buyCallStrike} (Bear Call) - ${((sellCallStrike/spot - 1) * 100).toFixed(1)}% above spot
  Total Credit: $${ironCondorCredit.toFixed(2)}/share
  ✅ OTM BUFFER: Both short strikes are ~3% away from spot ($${spot.toFixed(2)})
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Max Profit per contract: $${(ironCondorCredit * 100).toFixed(0)} (keep all premium if stock stays in range)
  • Max Loss per contract: $${(ironCondorMaxLoss * 100).toFixed(0)} (if stock breaks through either spread)
  • Breakeven Low: $${ironCondorPutBreakeven.toFixed(2)}
  • Breakeven High: $${ironCondorCallBreakeven.toFixed(2)}
  • Profit Zone: $${ironCondorPutBreakeven.toFixed(2)} to $${ironCondorCallBreakeven.toFixed(2)}
  • Buying Power per contract: $${(Math.max(putSpreadWidth, callSpreadWidth) * 100).toFixed(0)}
  • Recommended contracts: ${conservativeContracts} (60% of Kelly)
  
  💰 TOTALS FOR ${conservativeContracts} CONTRACTS:
  • TOTAL MAX PROFIT: $${(ironCondorCredit * 100 * conservativeContracts).toLocaleString()}
  • TOTAL MAX LOSS: $${(ironCondorMaxLoss * 100 * conservativeContracts).toLocaleString()}
  • TOTAL BUYING POWER USED: $${(Math.max(putSpreadWidth, callSpreadWidth) * 100 * conservativeContracts).toLocaleString()}
  
  • Risk/Reward Ratio: ${(ironCondorMaxLoss / ironCondorCredit).toFixed(1)}:1 ${(ironCondorMaxLoss / ironCondorCredit) < 1.5 ? '🎯 Excellent' : (ironCondorMaxLoss / ironCondorCredit) < 2 ? '✅ Good' : (ironCondorMaxLoss / ironCondorCredit) < 3 ? '⚠️ Marginal' : '❌ Poor'}
  • Delta: ~0 (NEUTRAL - profits from time decay)
  • Win Probability: ~${Math.round((1 - Math.abs(atmPutDelta)) * (1 - Math.abs(atmCallDelta)) * 100)}%
  ${(ironCondorMaxLoss / ironCondorCredit) >= 3 ? '❌ WARNING: Poor R:R ratio (>3:1) - consider tighter strikes or different strategy!' : ''}
  ⚠️ RISK: Lose on EITHER side if stock moves too much. Double exposure.
  ✅ WHEN TO USE: Low IV, expecting stock to stay in tight range. Collect double premium.

SETUP H - SKIP™ Strategy (Long-Term Bullish with Cost Reduction) - Schwab: Two "Single" Calls at different expirations:
  Trade: Buy ${ticker} $${leapsStrike.toFixed(0)} LEAPS Call (${leapsExpiry}) + Buy $${skipStrike.toFixed(0)} SKIP Call (${skipCallExpiry})
  LEAPS Call: $${leapsStrike.toFixed(0)} strike, ~${leapsExpiry} expiry, ~$${leapsPremium.toFixed(2)}/share
  SKIP Call: $${skipStrike.toFixed(0)} strike, ~${skipCallExpiry} expiry, ~$${skipPremium.toFixed(2)}/share
  
  📐 EXACT NUMBERS (COPY THESE VERBATIM - do NOT recalculate!):
  • Total Investment per contract: $${((leapsPremium + skipPremium) * 100).toFixed(0)}
  • LEAPS Cost: $${(leapsPremium * 100).toFixed(0)}
  • SKIP Cost: $${(skipPremium * 100).toFixed(0)}
  • Max Loss: $${((leapsPremium + skipPremium) * 100).toFixed(0)} (both expire worthless)
  • Breakeven: $${(leapsStrike + leapsPremium + skipPremium).toFixed(2)} (at LEAPS expiry)
  • Recommended contracts: ${Math.max(1, Math.floor(buyingPower / ((leapsPremium + skipPremium) * 100) * 0.5))} (50% allocation)
  
  💰 FOR ${Math.max(1, Math.floor(buyingPower / ((leapsPremium + skipPremium) * 100) * 0.5))} CONTRACTS:
  • TOTAL INVESTMENT: $${((leapsPremium + skipPremium) * 100 * Math.max(1, Math.floor(buyingPower / ((leapsPremium + skipPremium) * 100) * 0.5))).toLocaleString()}
  
  • Combined Delta: High (LEAPS + SKIP = leveraged upside)
  ⚠️ RISK: Both options can expire worthless. Complex exit strategy required.
  ✅ WHEN TO USE: Long-term bullish on stock with 6+ month outlook. Exit SKIP at 45-60 DTE.
  📚 SKIP = "Safely Keep Increasing Profits" - Exit the SKIP call early to lock in gains.

YOUR JOB: Pick ONE setup (A through H) based on the market conditions below:

⚠️ VARIETY INSTRUCTION: Consider ALL 8 strategies, not just B!
   • A (Short Put): High conviction bullish + large buying power
   • B (Put Credit Spread): Moderately bullish + defined risk
   • C (Covered Call): Own shares + want income
   • D (Call Credit Spread): Bearish or overbought stock
   • E (Long Put): Strong bearish conviction, expecting big drop
   • F (Long Call): Strong bullish conviction, expecting big move up
   • G (Iron Condor): Neutral, expecting stock to stay in range
   • H (SKIP™): Long-term bullish, 6+ month outlook

═══════════════════════════════════════════════════════════════════════════
🚨🚨🚨 MANDATORY DIRECTIONAL GUIDANCE - YOU MUST FOLLOW THIS 🚨🚨🚨
═══════════════════════════════════════════════════════════════════════════

RANGE POSITION: ${stockData?.rangePosition ?? '?'}% (0% = 3-month low, 100% = 3-month high)
${stockData?.rangePosition !== undefined && stockData?.rangePosition < 25 ? `
████████████████████████████████████████████████████████████████████████████
█  ⬆️ BULLISH REQUIRED: Stock is at ${stockData?.rangePosition}% of 3-month range = NEAR THE LOW!
█  
█  🟢 PICK FROM: A (Short Put), B (Put Credit Spread), F (Long Call), H (SKIP™)
█  🔴 DO NOT PICK: D (Call Credit Spread), E (Long Put), G (Iron Condor)
█  
█  Iron Condor is WRONG for oversold stocks - they tend to bounce, not chop.
█  Call Credit Spread is WRONG - you'd be betting against recovery.
████████████████████████████████████████████████████████████████████████████
` : stockData?.rangePosition !== undefined && stockData?.rangePosition > 75 ? `
████████████████████████████████████████████████████████████████████████████
█  ⬇️ BEARISH REQUIRED: Stock is at ${stockData?.rangePosition}% of 3-month range = NEAR THE HIGH!
█  
█  🟢 PICK FROM: D (Call Credit Spread), E (Long Put)
█  🟠 MAYBE: G (Iron Condor) if expecting sideways
█  🔴 DO NOT PICK: A (Short Put), B (Put Credit Spread), F (Long Call)
█  
█  Short puts are WRONG for extended stocks - high risk of pullback and assignment.
█  Put Credit Spread is WRONG - you'd be betting on more upside in overbought stock.
████████████████████████████████████████████████████████████████████████████
` : `
↔️ NEUTRAL ZONE: Stock at ${stockData?.rangePosition ?? '?'}% = mid-range
   → Consider risk/reward and IV to choose direction
   → G (Iron Condor) is acceptable here if you expect range-bound action
   → B or D can work depending on your directional thesis
`}

🎯 ADDITIONAL DECISION CRITERIA:
• IV Rank ${ivRank}%: ${ivRank > 50 ? 'ELEVATED - favors SELLING strategies (A, B, C, D)' : 'LOW - options are cheap, spreads help manage this'}
• Risk Tolerance: ${riskTolerance} - ${riskTolerance === 'conservative' ? 'favor defined risk (B, D)' : riskTolerance === 'aggressive' ? 'A is fine if bullish' : 'B or D for balanced risk/reward'}
• Buying Power: $${buyingPower.toLocaleString()} - ${buyingPower < sellPutStrike * 100 ? 'Too low for A, use spreads (B or D)' : 'Enough for any strategy'}

🚨🚨🚨 CRITICAL MATH WARNING 🚨🚨🚨
The dollar amounts for Max Profit, Max Loss, and P&L are ALREADY CALCULATED in each SETUP above.
DO NOT DO ANY MULTIPLICATION - just COPY the exact numbers from the SETUP you chose.
🚨🚨🚨 END MATH WARNING 🚨🚨🚨

Respond with this format:

## 🏆 RECOMMENDED: [Setup Letter] - [Strategy Name]

### THE TRADE
[Copy the EXACT trade line from the setup you chose, including ticker, strikes and expiry]

### WHY THIS STRATEGY
• [Reason 1 - tie to IV level]
• [Reason 2 - tie to stock's position in range]
• [Reason 3 - tie to risk/capital management]

### THE RISKS
• ⚠️ [Risk 1 - when you lose money]
• ⚠️ [Risk 2 - market scenario that hurts]
${propDeskWarnings.length > 0 ? '\n### 🏦 PROP DESK RISK NOTES\n' + propDeskWarnings.map(w => `• ${w}`).join('\n') : ''}

### THE NUMBERS
Copy the numbers from your chosen SETUP above. Format as:

**Per Contract:**
• Max Profit: $X
• Max Loss: $X  
• Breakeven: $X.XX
• Buying Power: $X

**For [N] Contracts:**
• Total Max Profit: $X
• Total Max Loss: $X
• Total Buying Power: $X

### 📊 P&L AT EXPIRATION
| Stock Price | Result | P&L |
|-------------|--------|-----|
| Above $[upper strike] | Max Profit | +$X |
| At $[breakeven] | Breakeven | $0 |
| Below $[lower strike] | Max Loss | -$X |

### OTHER STRATEGIES CONSIDERED
For each rejected strategy, include letter AND name:
• A (Short Put): [1-line reason why not ideal]
• B (Put Credit Spread): [1-line reason why not ideal]
• C (Covered Call): [1-line reason why not ideal]
• D (Call Credit Spread): [1-line reason why not ideal]
• E (Long Put): [1-line reason why not ideal]
• F (Long Call): [1-line reason why not ideal]
• G (Iron Condor): [1-line reason why not ideal]
• H (SKIP™): [1-line reason why not ideal]
(Skip the one you recommended - only list rejected strategies)

### 💡 FOR BEGINNERS
[2-3 sentences explaining this strategy in plain English for someone new to options]`;
    
    // Return both the prompt AND the calculated values for post-processing
    return {
        prompt: promptText,
        calculatedValues: {
            conservativeContracts,
            putSpreadCredit,
            putSpreadWidth,
            callSpreadCredit,
            callSpreadWidth,
            sellPutStrike,
            buyPutStrike,
            sellCallStrike,
            buyCallStrike,
            atmPutMid,
            atmCallMid,
            totalPutMaxProfit: Math.round(putSpreadCredit * 100 * conservativeContracts),
            totalPutMaxLoss: Math.round((putSpreadWidth - putSpreadCredit) * 100 * conservativeContracts),
            totalCallMaxProfit: Math.round(callSpreadCredit * 100 * conservativeContracts),
            totalCallMaxLoss: Math.round((callSpreadWidth - callSpreadCredit) * 100 * conservativeContracts),
            totalBuyingPower: Math.round(putSpreadWidth * 100 * conservativeContracts),
            shortPutMaxProfit: Math.round(atmPutMid * 100),
            shortPutBuyingPower: sellPutStrike * 100,
            coveredCallCredit: Math.round(atmCallMid * 100)
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPERT MODE STRATEGY ADVISOR - Maximum AI freedom with structured output
// ═══════════════════════════════════════════════════════════════════════════
function buildExpertModePrompt(context) {
    const { ticker, spot, stockData, ivRank, expirations, sampleOptions, buyingPower, accountValue, riskTolerance, existingPositions, sharesOwned, costBasis, dataSource, model } = context;
    
    // Detect if this is a Grok model - use "lite" mode (no options chain) for faster response
    // Grok 4 is incredibly smart but also slow when given huge prompts
    // Lite mode: AI picks strategy based on spot/IV/range, staging validates strikes
    const isGrokModel = model?.toLowerCase().includes('grok');
    const useLiteMode = isGrokModel;
    
    // Build full options chain summary (only for non-Grok models)
    let chainSummary = '';
    if (!useLiteMode && sampleOptions?.length > 0) {
        const puts = sampleOptions.filter(o => o.option_type === 'P').sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike));
        const calls = sampleOptions.filter(o => o.option_type === 'C').sort((a, b) => parseFloat(a.strike) - parseFloat(b.strike));
        
        if (puts.length > 0) {
            chainSummary += 'PUT OPTIONS (sorted high to low strike):\n';
            chainSummary += puts.slice(0, 15).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? parseFloat(o.delta).toFixed(2) : 'N/A';
                const iv = o.iv ? (parseFloat(o.iv) * 100).toFixed(1) + '%' : 'N/A';
                return `  $${strike.toFixed(0)} PUT: bid $${bid.toFixed(2)} / ask $${ask.toFixed(2)} (mid $${mid}) | Δ${delta} | IV ${iv}`;
            }).join('\n');
        }
        
        if (calls.length > 0) {
            chainSummary += '\n\nCALL OPTIONS (sorted low to high strike):\n';
            chainSummary += calls.slice(0, 15).map(o => {
                const strike = parseFloat(o.strike);
                const bid = parseFloat(o.bid) || 0;
                const ask = parseFloat(o.ask) || 0;
                const mid = ((bid + ask) / 2).toFixed(2);
                const delta = o.delta ? parseFloat(o.delta).toFixed(2) : 'N/A';
                const iv = o.iv ? (parseFloat(o.iv) * 100).toFixed(1) + '%' : 'N/A';
                return `  $${strike.toFixed(0)} CALL: bid $${bid.toFixed(2)} / ask $${ask.toFixed(2)} (mid $${mid}) | Δ${delta} | IV ${iv}`;
            }).join('\n');
        }
    }
    
    // Format existing positions
    let positionsContext = 'None';
    if (existingPositions && existingPositions.length > 0) {
        const tickerPositions = existingPositions.filter(p => p.ticker?.toUpperCase() === ticker.toUpperCase());
        if (tickerPositions.length > 0) {
            positionsContext = tickerPositions.map(p => `  • ${p.type}: $${p.strike} exp ${p.expiry}`).join('\n');
        }
    }
    
    // Format share holdings (enables covered call recommendations)
    let sharesContext = '';
    if (sharesOwned > 0) {
        const coveredCallContracts = Math.floor(sharesOwned / 100);
        sharesContext = `
🎯 IMPORTANT - CLIENT OWNS SHARES:
• Shares Owned: ${sharesOwned} shares of ${ticker}
• Cost Basis: $${costBasis?.toFixed(2) || 'Unknown'}
• Covered Call Eligibility: ${coveredCallContracts} contract${coveredCallContracts !== 1 ? 's' : ''} (${coveredCallContracts * 100} shares)
${sharesOwned % 100 > 0 ? `• Uncovered Shares: ${sharesOwned % 100} (not enough for another contract)` : ''}
• Assignment Breakeven: $${costBasis?.toFixed(2) || 'Unknown'} (strike must be ABOVE this to profit on assignment)

→ COVERED CALLS should be your PRIMARY or TOP ALTERNATIVE recommendation when client owns shares!
→ Strike selection: Above cost basis = guaranteed profit if called away`;
    }
    
    // Available expirations
    const expirationsText = expirations?.slice(0, 6).map(exp => {
        const expDate = new Date(exp);
        const today = new Date();
        const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        return `${exp} (${dte} DTE)`;
    }).join(', ') || 'Not available';
    
    // Lite mode: explain that we'll validate strikes later
    const liteModeNote = useLiteMode ? `

NOTE: You are running in LITE MODE (faster response). I don't have the exact options chain, 
but I know ${ticker} is a liquid stock with standard strike intervals. Pick strikes that make 
sense for the current price ($${spot.toFixed(2)}). Our trading desk will validate and 
adjust strikes to actual available options before execution.

For premium estimates, use these rules of thumb based on IV Rank ${ivRank || 50}%:
• ATM options: ~2-4% of stock price for 30-45 DTE
• 1 strike OTM: ~1-2% of stock price
• 2 strikes OTM: ~0.5-1% of stock price
• Credit spreads: typically $1-3 wide, collecting 25-35% of spread width
` : '';
    
    // Build options chain section
    const optionsChainSection = useLiteMode 
        ? `OPTIONS CHAIN: Not provided (LITE MODE - pick reasonable strikes based on spot price)${liteModeNote}`
        : `OPTIONS CHAIN (First Available Expiration):\n${chainSummary || 'No options data available'}`;
    
    const prompt = `════════════════════════════════════════════════════════════════════════════════
                      WALL STREET DERIVATIVES DESK - TRADE RECOMMENDATION
════════════════════════════════════════════════════════════════════════════════

You are a Senior Options Strategist with 20 years of experience at a major Wall Street derivatives desk (Goldman Sachs, Morgan Stanley, or JPMorgan level). You've traded through multiple market cycles, managed institutional portfolios, and specialized in volatility strategies, earnings plays, and risk-defined income trades.

A high-net-worth client has asked you to analyze ${ticker} and recommend options trades given current market conditions.

════════════════════════════════════════════════════════════════════════════════
                           CLIENT TRADING PHILOSOPHY
════════════════════════════════════════════════════════════════════════════════

You have FULL DISCRETION to recommend ANY strategy that fits the situation. Pick the BEST trade, not just premium-selling defaults. Use your 20 years of experience.

📊 FULL STRATEGY TOOLKIT (use what fits):

BULLISH STRATEGIES:
• Bull Put Spread (Put Credit Spread) - Sell higher put, buy lower put, collect credit
• Cash-Secured Put - Wheel entry, want to own shares if assigned
• Bull Call Spread (Call Debit Spread) - Buy lower call, sell higher call, pay debit
• Poor Man's Covered Call (PMCC) - Buy deep ITM LEAPS (0.80+ delta), sell OTM short-term calls
• Long Call - Strong directional conviction (use sparingly, theta risk)

BEARISH STRATEGIES:
• Bear Call Spread (Call Credit Spread) - Sell lower call, buy higher call, collect credit
• Bear Put Spread (Put Debit Spread) - Buy higher put, sell lower put, pay debit

NEUTRAL/INCOME STRATEGIES:
• Covered Call - On existing holdings only
• Iron Condor - Sell OTM put spread + OTM call spread (range-bound)
• Calendar Spread - Same strike, different expirations (theta play)

💡 SITUATION-BASED GUIDANCE:
• Stock at ALL-TIME HIGHS + strong momentum → Consider Bull Call Spread or PMCC (ride the trend)
• Stock at ALL-TIME HIGHS + extended/overbought → Consider Put Credit Spread (bet it holds)
• High IV environment → Favor credit strategies (selling premium)
• Low IV environment → Favor debit strategies (buying cheap options)
• Expensive stock → PMCC over covered calls (capital efficient)

⛔ HARD RULE - NO INFINITE RISK:
• NO naked calls
• NO naked puts on margin
• ALL positions must have DEFINED MAX LOSS

🎯 PROBABILITY GUIDANCE:
• PRIMARY trade: 55-75% probability of profit (adjust based on risk/reward)
• Show probability AND reward-to-risk ratio for context

🔄 WHEEL CANDIDATE CHECK:
For put-selling strategies: "Would client want to own 100 shares if assigned?"
• YES → CSP or put credit spread
• NO → Only spreads (no assignment risk)

════════════════════════════════════════════════════════════════════════════════
                              RAW MARKET DATA
════════════════════════════════════════════════════════════════════════════════

TICKER: ${ticker}
CURRENT SPOT PRICE: $${spot.toFixed(2)}
DATA SOURCE: ${dataSource} (${dataSource === 'schwab' ? 'Real-time' : 'Delayed 15-20 min'})

PRICE ACTION & RANGE:
• 52-Week High: $${stockData.high52?.toFixed(2) || 'N/A'}
• 52-Week Low: $${stockData.low52?.toFixed(2) || 'N/A'}
• 3-Month High: $${stockData.high3mo?.toFixed(2) || 'N/A'}
• 3-Month Low: $${stockData.low3mo?.toFixed(2) || 'N/A'}
• Position in 3-Month Range: ${stockData.rangePosition?.toFixed(1) || 'N/A'}% (0% = at low, 100% = at high)
• Recent Price Change: ${stockData.changePercent?.toFixed(2) || 'N/A'}%

VOLATILITY:
• IV Rank: ${ivRank !== null ? ivRank + '%' : 'N/A'} (percentile vs past year)
• Interpretation: ${ivRank !== null ? (ivRank < 30 ? 'LOW - options are cheap, consider buying' : ivRank < 50 ? 'MODERATE - neutral' : ivRank < 70 ? 'ELEVATED - favor selling premium' : 'HIGH - options expensive, strongly favor selling') : 'Unknown'}

AVAILABLE EXPIRATIONS:
${expirationsText}

${optionsChainSection}

════════════════════════════════════════════════════════════════════════════════
                              CLIENT CONSTRAINTS
════════════════════════════════════════════════════════════════════════════════

• Available Buying Power: $${buyingPower?.toLocaleString() || '25,000'}
• Account Value: $${accountValue?.toLocaleString() || 'N/A'}
• Risk Tolerance: ${riskTolerance || 'Moderate'}
• HARD REQUIREMENTS:
  1. NO INFINITE RISK - Position must have defined max loss (no naked calls, no naked puts on margin)
  2. DTE ≤ 45 days preferred (can go longer only with strong justification)
  3. Must be executable as a single strategy (not multiple unrelated trades)

EXISTING POSITIONS IN ${ticker}:
${positionsContext}
${sharesContext}

════════════════════════════════════════════════════════════════════════════════
                              YOUR TASK
════════════════════════════════════════════════════════════════════════════════

Analyze this situation using your 20 years of derivatives expertise. Consider:

1. DIRECTIONAL BIAS: Is this stock bullish, bearish, or range-bound? Why?
2. VOLATILITY PLAY: Is IV high enough to sell premium, or low enough to buy options?
3. RISK/REWARD: What's the optimal balance for this client's constraints?
4. TIMING: Any known catalysts (earnings, events) that affect DTE selection?
5. STRIKE SELECTION: Based on the range and support/resistance, where should strikes be placed?
6. WHEEL SUITABILITY: Is this a stock the client would want to own long-term?

Provide 2-3 RANKED trade options: a primary high-probability play AND 1-2 alternatives.

════════════════════════════════════════════════════════════════════════════════
                         REQUIRED OUTPUT FORMAT
════════════════════════════════════════════════════════════════════════════════

You MUST structure your response EXACTLY as follows (this format is parsed by our system):

## 🧠 CHANSPLANATION (TL;DR)

[2-3 sentences MAX. Explain like you're texting a friend who asked "what's the play?" Include: the trade direction (bullish/bearish/neutral), the strategy in plain English, and why it makes sense RIGHT NOW. No jargon, no numbers - just the vibe.]

---

## 🦴 CAVEMAN CORNER (ELI5)

[Explain this trade like you're talking to someone who has ZERO financial knowledge. Use analogies to everyday things. NO JARGON ALLOWED - don't say: IV, spot, delta, premium, strike, expiry, OTM, ITM, theta, credit, debit, spread, contracts. Instead use plain words like: price, bet, win, lose, money, stock goes up/down, waiting, time. Example format:

"We're betting that [COMPANY] stock stays above $XX. Think of it like getting paid to promise you'll buy something if it goes on sale - but you don't think it will. If the stock stays where it is or goes up, we keep the money we got paid. If it crashes below $XX, we have to buy shares at that price. We have until [DATE] to find out."

Keep it to 3-4 sentences. Use "we" not "you". Make a 10-year-old understand it.]

---

## 📊 MARKET ANALYSIS

[2-3 paragraphs explaining your read on the stock: price action, range, momentum, any known catalysts. Is this a good wheel candidate (would you want to own shares)? What does IV suggest about strategy selection?]

---

## 🥇 PRIMARY RECOMMENDATION: [Strategy Name]

**Trade:** [Exact order, e.g., "Sell ${ticker} $XX/$XX Put Credit Spread, [date] expiry"]
**Contracts:** [Number]
**Net Credit/Debit:** $X.XX per share ($XXX per contract)
**Probability of Profit:** ~XX%

| Metric | Per Contract | Total ([N] contracts) |
|--------|--------------|----------------------|
| Max Profit | $XXX | $X,XXX |
| Max Loss | $XXX | $X,XXX |
| Breakeven | $XXX.XX | — |
| Buying Power | $XXX | $X,XXX |

**Why This Trade:**
• [Key reason 1 - tie to probability/premium selling philosophy]
• [Key reason 2 - tie to IV environment]
• [Key reason 3 - tie to support levels or range position]

**Risks:** [Primary risk scenario in 1-2 sentences]

**Management:** [When to take profits, when to cut losses]

---

## 🥈 ALTERNATIVE #1: [Strategy Name]

**Trade:** [Exact order]
**Contracts:** [Number]
**Net Credit/Debit:** $X.XX per share
**Probability of Profit:** ~XX%

| Metric | Per Contract | Total |
|--------|--------------|-------|
| Max Profit | $XXX | $X,XXX |
| Max Loss | $XXX | $X,XXX |
| Breakeven | $XXX.XX | — |

**Why Consider This:** [1-2 sentences - when would this be better than primary?]

---

## 🥉 ALTERNATIVE #2: [Strategy Name] (Optional - include if meaningfully different)

**Trade:** [Exact order]
**Net Credit/Debit:** $X.XX per share
**Probability of Profit:** ~XX%
**Max Profit / Max Loss:** $XXX / $XXX per contract
**Why Consider This:** [1-2 sentences]

---

## ❌ STRATEGIES REJECTED

• [Strategy 1]: [Why not optimal - 1 sentence]
• [Strategy 2]: [Why not optimal - 1 sentence]
• [Strategy 3]: [Why not optimal - 1 sentence]

════════════════════════════════════════════════════════════════════════════════
                              FINAL NOTES
════════════════════════════════════════════════════════════════════════════════
${useLiteMode ? `
⚠️ LITE MODE: Pick strikes that make sense for $${spot.toFixed(2)} spot price. Use standard intervals 
   ($1 for stocks under $50, $2.50 or $5 for $50-200, $5 or $10 for $200+).
   Our trading desk will validate and adjust to actual available strikes.

⚠️ PREMIUM ESTIMATES: Your estimates don't need to be exact - we'll fetch real bid/ask at execution.
   Focus on strategy selection and strike positioning.
` : `
⚠️ CRITICAL: Use ONLY strikes from the options chain provided above. Do not invent strikes that don't exist.
`}
⚠️ PROBABILITY FIRST: The PRIMARY recommendation should be the highest-probability trade that 
   fits this client's wheel-focused philosophy. Save speculative/directional plays for alternatives.

⚠️ MATH CHECK: Double-check all P&L calculations. For credit spreads:
   Max Profit = Credit Received × 100
   Max Loss = (Spread Width - Credit) × 100
   Probability ≈ (1 - (Distance to Breakeven / Current Price)) for rough estimate

⚠️ WHEEL MINDSET: This client collects premium consistently. A 70% win rate with small gains 
   beats a 50% win rate with larger gains. Prioritize probability over max profit.

Think like the senior trader you are. What would you actually recommend to a premium-selling client?`;

    return {
        prompt,
        calculatedValues: null,  // Expert mode doesn't pre-calculate - AI does the math
        expertMode: true,
        liteMode: useLiteMode  // Track if lite mode was used
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// PORTFOLIO FIT ANALYZER - Evaluate candidates against current portfolio
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build prompt for analyzing how pending trade candidates fit the portfolio
 * @param {Object} context - Portfolio context with positions, candidates, balances
 */
function buildPortfolioFitPrompt(context) {
    const { 
        openPositions = [], 
        closedPositions = [],
        pendingTrades = [], 
        accountBalances = {},
        tickerPatterns = {}
    } = context;
    
    // Calculate current sector exposure from open positions
    const sectorMap = {
        // Tech
        'AAPL': 'Technology', 'MSFT': 'Technology', 'NVDA': 'Technology', 'AMD': 'Technology', 
        'GOOGL': 'Technology', 'GOOG': 'Technology', 'META': 'Technology', 'AMZN': 'Technology',
        'TSLA': 'Technology', 'PLTR': 'Technology', 'SMCI': 'Technology', 'AVGO': 'Technology',
        'CRM': 'Technology', 'ORCL': 'Technology', 'ADBE': 'Technology', 'INTC': 'Technology',
        'MU': 'Technology', 'QCOM': 'Technology', 'NOW': 'Technology', 'SNOW': 'Technology',
        // Financials
        'JPM': 'Financials', 'BAC': 'Financials', 'GS': 'Financials', 'MS': 'Financials',
        'WFC': 'Financials', 'C': 'Financials', 'AXP': 'Financials', 'V': 'Financials',
        'MA': 'Financials', 'SCHW': 'Financials', 'BLK': 'Financials', 'COIN': 'Financials',
        // Healthcare
        'JNJ': 'Healthcare', 'UNH': 'Healthcare', 'PFE': 'Healthcare', 'MRK': 'Healthcare',
        'ABBV': 'Healthcare', 'LLY': 'Healthcare', 'BMY': 'Healthcare', 'TMO': 'Healthcare',
        // Energy
        'XOM': 'Energy', 'CVX': 'Energy', 'COP': 'Energy', 'SLB': 'Energy', 'OXY': 'Energy',
        'XLE': 'Energy', 'VDE': 'Energy', 'HAL': 'Energy',
        // Consumer
        'WMT': 'Consumer', 'COST': 'Consumer', 'TGT': 'Consumer', 'HD': 'Consumer',
        'MCD': 'Consumer', 'SBUX': 'Consumer', 'NKE': 'Consumer', 'DIS': 'Consumer',
        // Industrial
        'CAT': 'Industrial', 'DE': 'Industrial', 'BA': 'Industrial', 'UPS': 'Industrial',
        'HON': 'Industrial', 'GE': 'Industrial', 'LMT': 'Industrial', 'RTX': 'Industrial',
        // ETFs
        'SPY': 'Index ETF', 'QQQ': 'Index ETF', 'IWM': 'Index ETF', 'DIA': 'Index ETF',
        'VOO': 'Index ETF', 'VTI': 'Index ETF', 'TQQQ': 'Leveraged ETF', 'SQQQ': 'Leveraged ETF',
        'TSLL': 'Leveraged ETF', 'NVDL': 'Leveraged ETF', 'SOXL': 'Leveraged ETF',
        // Crypto
        'MSTR': 'Crypto', 'MARA': 'Crypto', 'RIOT': 'Crypto', 'BITX': 'Crypto',
        // Real Estate
        'O': 'Real Estate', 'AMT': 'Real Estate', 'PLD': 'Real Estate', 'EQIX': 'Real Estate'
    };
    
    // Calculate sector exposure from open positions
    const sectorExposure = {};
    let totalCapitalAtRisk = 0;
    
    openPositions.forEach(pos => {
        const sector = sectorMap[pos.ticker] || 'Other';
        const capitalAtRisk = pos.type?.includes('spread') 
            ? Math.abs((pos.sellStrike || pos.strike) - (pos.buyStrike || 0)) * 100 * (pos.contracts || 1)
            : (pos.strike || 0) * 100 * (pos.contracts || 1);
        
        sectorExposure[sector] = (sectorExposure[sector] || 0) + capitalAtRisk;
        totalCapitalAtRisk += capitalAtRisk;
    });
    
    // Format sector breakdown
    const sectorBreakdown = Object.entries(sectorExposure)
        .sort((a, b) => b[1] - a[1])
        .map(([sector, capital]) => {
            const pct = totalCapitalAtRisk > 0 ? ((capital / totalCapitalAtRisk) * 100).toFixed(1) : 0;
            return `${sector}: $${capital.toLocaleString()} (${pct}%)`;
        })
        .join('\n');
    
    // Format open positions summary
    const openPositionsSummary = openPositions.map(pos => {
        const sector = sectorMap[pos.ticker] || 'Other';
        return `${pos.ticker} ${pos.type} $${pos.strike} (${sector})`;
    }).join(', ') || 'No open positions';
    
    // Format pending candidates
    const candidatesList = pendingTrades.map((p, i) => {
        const sector = sectorMap[p.ticker] || 'Other';
        const capitalNeeded = p.type?.includes('spread')
            ? Math.abs((p.upperStrike || p.strike) - (p.strike || 0)) * 100
            : (p.strike || 0) * 100;
        return `${i + 1}. ${p.ticker} $${p.strike}${p.upperStrike ? '/$' + p.upperStrike : ''} ${p.type || 'short_put'} ${p.expiry || 'N/A'} | Sector: ${sector} | Capital: $${capitalNeeded.toLocaleString()} | Premium: $${((p.premium || 0) * 100).toFixed(0)}`;
    }).join('\n');
    
    // Format historical patterns for each candidate ticker
    const patternSummary = Object.entries(tickerPatterns)
        .map(([ticker, stats]) => {
            return `${ticker}: ${stats.trades} trades, ${stats.winRate}% win rate, ${stats.netPnL >= 0 ? '+' : ''}$${stats.netPnL}`;
        })
        .join('\n') || 'No historical patterns available';
    
    // Account info
    const buyingPower = accountBalances.buyingPower || 0;
    const accountValue = accountBalances.accountValue || 0;
    
    return `You are a senior portfolio manager evaluating which pending trade candidates best fit your current portfolio. Analyze diversification, concentration risk, historical edge, and position sizing.

═══ ACCOUNT STATUS ═══
Account Value: $${accountValue.toLocaleString()}
Buying Power: $${buyingPower.toLocaleString()}
Open Positions: ${openPositions.length}
Capital at Risk: $${totalCapitalAtRisk.toLocaleString()}

═══ CURRENT SECTOR EXPOSURE ═══
${sectorBreakdown || 'No current exposure (portfolio is empty)'}

═══ OPEN POSITIONS ═══
${openPositionsSummary}

═══ PENDING TRADE CANDIDATES ═══
${candidatesList || 'No pending trades to analyze'}

═══ YOUR HISTORICAL PATTERNS ON THESE TICKERS ═══
${patternSummary}

═══ YOUR ANALYSIS ═══

Evaluate each candidate on:
1. **DIVERSIFICATION FIT** - Does it add new sector exposure or increase concentration?
2. **HISTORICAL EDGE** - What's your track record on this ticker/strategy?
3. **CAPITAL EFFICIENCY** - Is buying power being used wisely?
4. **POSITION SIZING** - Kelly criterion suggests max 5% per position

**OUTPUT FORMAT:**

## PORTFOLIO FIT SUMMARY

### ✅ BEST FIT (Execute These)
List candidates that ADD diversification or leverage proven edge. Include:
- Ticker & strike
- Why it fits (sector gap, historical wins, etc.)
- Suggested size (contracts) based on buying power

### ⚠️ CAUTION (Consider Carefully)  
List candidates that increase concentration but may still be worthwhile. Include:
- The concentration concern
- Conditions under which it's still okay

### ❌ SKIP (Pass On These)
List candidates that hurt diversification or have poor historical edge. Include:
- The specific concern
- What would make it better (different strike, wait for other position to close, etc.)

### 📊 RECOMMENDED EXECUTION ORDER
If executing multiple trades, what order optimizes capital usage and leaves buffer?

### 💰 CAPITAL SUMMARY
| Action | Capital Used | Remaining BP |
|--------|--------------|--------------|
| Current | $X | $${buyingPower.toLocaleString()} |
| After Best Fit trades | $X | $X |

**BOTTOM LINE**: One sentence summary of the overall recommendation.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
    // Core prompt builders
    buildDeepDivePrompt,
    buildCheckupPrompt,
    buildTradeParsePrompt,
    buildDiscordTradeAnalysisPrompt,
    buildCritiquePrompt,
    buildTradePrompt,
    buildIdeaPrompt,
    buildStrategyAdvisorPrompt,
    buildExpertModePrompt,
    buildPortfolioFitPrompt,
    
    // Unified context system
    buildPositionFlowContext,
    POSITION_STAGES,
    RECOMMENDATIONS
};
