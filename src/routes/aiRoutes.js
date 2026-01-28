/**
 * AI Routes - All /api/ai/* endpoints
 * Extracted from server.js Phase 6 modularization
 * 
 * Handles 17 AI endpoints:
 * - /api/ai/critique - Trade critique
 * - /api/ai/strategy-advisor - Strategy recommendations
 * - /api/ai/ideas - Trade idea generation
 * - /api/ai/grok - Generic Grok prompts
 * - /api/ai/x-sentiment - X/Twitter sentiment via Grok
 * - /api/ai/deep-dive - Comprehensive trade analysis
 * - /api/ai/checkup - Position health check
 * - /api/ai/parse-trade - Discord trade parsing (SSE)
 * - /api/ai/analyze - Trade analysis with MoE
 * - /api/ai/portfolio-audit - Portfolio audit
 * - /api/ai/historical-audit - Historical performance audit
 * - /api/ai/status - Ollama status check
 * - /api/ai/restart - Restart Ollama
 * - /api/ai/warmup - Pre-load model (SSE)
 * - /api/ai/parse-image - Vision model image parsing
 * - /api/ai/parse-wisdom-image - Extract trading wisdom from screenshots
 */

const express = require('express');
const router = express.Router();
const http = require('http');

// Dependencies - will be injected
let AIService;           // callAI, callGrok, callMoE
let DataService;         // fetchDeepDiveData, fetchOptionPremium, fetchTickerIVData
let DiscoveryService;    // fetchWheelCandidatePrices
let promptBuilders;      // All prompt builder functions
let MarketDataService;   // Centralized market data
let formatExpiryForCBOE; // Date helper
let detectGPU;           // GPU detection
let fetchJsonHttp;       // HTTP fetch helper
let MODEL_VRAM_REQUIREMENTS; // VRAM requirements map

/**
 * Initialize the router with required dependencies
 */
function init(deps) {
    AIService = deps.AIService;
    DataService = deps.DataService;
    DiscoveryService = deps.DiscoveryService;
    promptBuilders = deps.promptBuilders;
    MarketDataService = deps.MarketDataService;
    formatExpiryForCBOE = deps.formatExpiryForCBOE;
    detectGPU = deps.detectGPU;
    fetchJsonHttp = deps.fetchJsonHttp;
    MODEL_VRAM_REQUIREMENTS = deps.MODEL_VRAM_REQUIREMENTS;
}

// Alias for cleaner code
const callAI = () => AIService.callAI;
const callGrok = () => AIService.callGrok;
const callMoE = () => AIService.callMoE;

// =============================================================================
// TRADE CRITIQUE
// =============================================================================

router.post('/critique', async (req, res) => {
    try {
        const data = req.body;
        const selectedModel = data.model || 'deepseek-r1:32b';
        console.log('[AI] Critiquing trade:', data.ticker, 'with model:', selectedModel);
        
        const prompt = promptBuilders.buildCritiquePrompt(data);
        const response = await AIService.callAI(prompt, selectedModel, 500);
        
        res.json({ 
            success: true, 
            critique: response,
            model: selectedModel
        });
        console.log('[AI] ✅ Critique complete');
    } catch (e) {
        console.log('[AI] ❌ Critique error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// STRATEGY ADVISOR - Analyzes all strategies for a ticker
// =============================================================================

router.post('/strategy-advisor', async (req, res) => {
    try {
        const data = req.body;
        const { ticker, buyingPower, accountValue, kellyBase, riskTolerance, existingPositions, model, expertMode } = data;
        const selectedModel = model || 'qwen2.5:32b';
        
        console.log(`[STRATEGY-ADVISOR] Analyzing ${ticker} with model ${selectedModel}${expertMode ? ' (EXPERT MODE)' : ''}`);
        console.log(`[STRATEGY-ADVISOR] Buying power from request: ${buyingPower} (type: ${typeof buyingPower})`);
        
        // 1. Get stock quote
        const quote = await MarketDataService.getQuote(ticker);
        if (!quote) {
            return res.status(400).json({ error: `Could not fetch price for ${ticker}` });
        }
        
        console.log(`[STRATEGY-ADVISOR] ✅ Quote from ${quote.source}: $${quote.price}`);
        
        // 2. Get options chain
        const chain = await MarketDataService.getOptionsChain(ticker, { strikeCount: 40, range: 'ALL' });
        
        let sampleOptions = [];
        let expirations = [];
        let ivRank = null;
        let dataSource = quote.source;
        
        if (chain) {
            expirations = chain.expirations.slice(0, 6);
            ivRank = chain.ivRank;
            dataSource = chain.source === quote.source ? chain.source : `${quote.source}+${chain.source}`;
            
            // Add option_type to each option
            const callsWithType = (chain.calls || []).map(c => ({ ...c, option_type: 'C' }));
            const putsWithType = (chain.puts || []).map(p => ({ ...p, option_type: 'P' }));
            
            const allOpts = [...callsWithType, ...putsWithType];
            console.log(`[STRATEGY-ADVISOR] Raw options from ${chain.source}: ${allOpts.length} total`);
            
            // Target ~30 DTE for optimal theta decay - FIND the best expiry FIRST
            const today = new Date();
            const targetDTE = 30;
            
            // Find the best expiry (closest to 30 DTE, minimum 21 DTE)
            let bestExpiry = null;
            let bestExpiryDTE = null;
            for (const exp of expirations) {
                const expDate = new Date(exp);
                const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
                if (dte >= 21) {
                    if (!bestExpiry || Math.abs(dte - targetDTE) < Math.abs(bestExpiryDTE - targetDTE)) {
                        bestExpiry = exp;
                        bestExpiryDTE = dte;
                    }
                }
            }
            // Fallback to first expiry with 21+ DTE, or just the furthest available
            if (!bestExpiry) {
                bestExpiry = expirations.find(exp => {
                    const dte = Math.ceil((new Date(exp) - today) / (1000 * 60 * 60 * 24));
                    return dte >= 7;
                }) || expirations[expirations.length - 1];
                bestExpiryDTE = bestExpiry ? Math.ceil((new Date(bestExpiry) - today) / (1000 * 60 * 60 * 24)) : 30;
            }
            
            console.log(`[STRATEGY-ADVISOR] Target expiry: ${bestExpiry} (${bestExpiryDTE} DTE)`);
            
            // CRITICAL: Filter options to ONLY the target expiry - this ensures strikes actually exist!
            const optsAtExpiry = allOpts.filter(o => o.expiration === bestExpiry);
            console.log(`[STRATEGY-ADVISOR] Options at target expiry: ${optsAtExpiry.length}`);
            
            // Log available strike increments at this expiry
            const strikesAtExpiry = [...new Set(optsAtExpiry.map(o => o.strike))].sort((a, b) => a - b);
            const strikeIncrement = strikesAtExpiry.length > 1 ? strikesAtExpiry[1] - strikesAtExpiry[0] : 5;
            console.log(`[STRATEGY-ADVISOR] Strike increment at ${bestExpiry}: $${strikeIncrement} (${strikesAtExpiry.length} unique strikes)`);
            
            // Filter to ±$20 of spot (wider range to ensure we have enough strikes)
            const strikeRange = Math.max(20, strikeIncrement * 6); // At least 6 strikes each side
            const minStrike = quote.price - strikeRange;
            const maxStrike = quote.price + strikeRange;
            
            const inRangeOpts = optsAtExpiry.filter(o => o.strike >= minStrike && o.strike <= maxStrike);
            inRangeOpts.sort((a, b) => a.strike - b.strike);
            
            sampleOptions = inRangeOpts.map(o => ({
                option_type: o.option_type,
                strike: o.strike,
                expiration_date: o.expiration,
                bid: o.bid,
                ask: o.ask,
                delta: o.delta,
                iv: o.iv,
                dte: bestExpiryDTE
            }));
            
            console.log(`[STRATEGY-ADVISOR] ✅ Using ${sampleOptions.length} options for analysis (strikes: $${strikesAtExpiry.filter(s => s >= minStrike && s <= maxStrike).join(', $')})`);
        }
        
        // 3. Build context for AI
        const stockData = {
            price: quote.price,
            change: quote.change,
            changePercent: quote.changePercent,
            high52: quote.high52,
            low52: quote.low52,
            high3mo: quote.high3mo,
            low3mo: quote.low3mo,
            volume: quote.volume,
            rangePosition: quote.rangePosition
        };
        
        const context = {
            ticker,
            spot: quote.price,
            stockData,
            ivRank,
            expirations,
            sampleOptions,
            buyingPower: buyingPower || 25000,
            accountValue: accountValue || null,
            kellyBase: kellyBase || null,
            riskTolerance: riskTolerance || 'moderate',
            existingPositions: existingPositions || [],
            dataSource
        };
        
        // 4. Build AI prompt - Expert Mode or Guided Mode
        let prompt, calculatedValues;
        if (expertMode) {
            console.log(`[STRATEGY-ADVISOR] 🎯 Using EXPERT MODE - AI has full analytical freedom`);
            const result = promptBuilders.buildExpertModePrompt(context);
            prompt = result.prompt;
            calculatedValues = null;  // Expert mode - AI does its own math
        } else {
            const result = promptBuilders.buildStrategyAdvisorPrompt(context);
            prompt = result.prompt;
            calculatedValues = result.calculatedValues;
        }
        
        // 5. Call AI (more tokens for Expert Mode since it writes more)
        console.log(`[STRATEGY-ADVISOR] Calling AI for recommendation...`);
        const maxTokens = expertMode ? 3000 : 2000;
        let aiResponse = await AIService.callAI(prompt, selectedModel, maxTokens);
        
        // 6. Post-process to fix math hallucinations (only for Guided Mode)
        if (!expertMode && calculatedValues) {
            const cv = calculatedValues;
            
            // Per-contract values
            const perContractMaxProfit = Math.round(cv.putSpreadCredit * 100);
            const perContractMaxLoss = Math.round((cv.putSpreadWidth - cv.putSpreadCredit) * 100);
            const perContractBP = Math.round(cv.putSpreadWidth * 100);
        
            // Total values (for N contracts)
            const totalMaxProfit = cv.totalPutMaxProfit;
            const totalMaxLoss = cv.totalPutMaxLoss;
            const totalBP = cv.totalBuyingPower;
        
            // Fix doubled numbers
            aiResponse = aiResponse.replace(/\$?(\d{1,3}),(\d{3}),\2(?!\d)/g, (match, first, second) => {
                return `$${first},${second}`;
            });
        
            // Fix 7-digit P/L numbers in P&L table
            aiResponse = aiResponse.replace(/(\+|-)\s*\$?(\d),(\d{3}),(\d{3})(?!\d)/g, (match, sign) => {
                const correctVal = sign === '+' ? totalMaxProfit : totalMaxLoss;
                return `${sign}$${correctVal.toLocaleString()}`;
            });
        
            // Fix TOTAL Max Profit/Loss (For N Contracts section) - match "Total" prefix
            aiResponse = aiResponse.replace(/Total\s+Max\s*Profit[:\s]*\$?[\d,]+/gi, 
                () => `Total Max Profit: $${totalMaxProfit.toLocaleString()}`);
            aiResponse = aiResponse.replace(/Total\s+Max\s*Loss[:\s]*\$?[\d,]+/gi,
                () => `Total Max Loss: $${totalMaxLoss.toLocaleString()}`);
            aiResponse = aiResponse.replace(/Total\s+Buying\s*Power[:\s]*\$?[\d,]+/gi,
                () => `Total Buying Power: $${totalBP.toLocaleString()}`);
        
            // Fix per-contract values (no "Total" prefix, match "Max Profit:" or "Max Profit :")
            // Only replace if NOT preceded by "Total"
            aiResponse = aiResponse.replace(/(?<!Total\s)Max\s*Profit[:\s]*\$?[\d,]+(?!\s*\|)/gi, 
                () => `Max Profit: $${perContractMaxProfit.toLocaleString()}`);
            aiResponse = aiResponse.replace(/(?<!Total\s)Max\s*Loss[:\s]*\$?[\d,]+(?!\s*\|)/gi,
                () => `Max Loss: $${perContractMaxLoss.toLocaleString()}`);
            aiResponse = aiResponse.replace(/(?<!Total\s)Buying\s*Power[:\s]*\$?[\d,]+(?!\s*\|)/gi,
                () => `Buying Power: $${perContractBP.toLocaleString()}`);
        
            // Fix P&L table rows (Above strike = Max Profit, Below strike = Max Loss)
            aiResponse = aiResponse.replace(/\|\s*Max\s*Profit\s*\|\s*\+?\$?[\d,]+\s*\|/gi,
                () => `| Max Profit | +$${totalMaxProfit.toLocaleString()} |`);
            aiResponse = aiResponse.replace(/\|\s*Max\s*Loss\s*\|\s*-?\$?[\d,]+\s*\|/gi,
                () => `| Max Loss | -$${totalMaxLoss.toLocaleString()} |`);
        
            // Fix $1 hallucinations
            const dollarOneCount = (aiResponse.match(/\$1(?![0-9.])/g) || []).length;
            if (quote.price > 10 && dollarOneCount >= 1) {
                const puts = sampleOptions.filter(o => o.option_type === 'P');
                const atmPut = puts.find(p => parseFloat(p.strike) <= quote.price) || puts[0];
                const sellPutStrike = atmPut ? parseFloat(atmPut.strike).toFixed(0) : Math.floor(quote.price);
                const buyPutStrike = Math.floor(quote.price - 5);
                const premium = atmPut ? ((parseFloat(atmPut.bid) + parseFloat(atmPut.ask)) / 2).toFixed(2) : '2.50';
                const stockPrice = quote.price.toFixed(0);
            
                // Apply $1 fixes
                aiResponse = aiResponse.replace(/\$1\s*\/\s*\$1\s+Put\s+Spread/gi, `$${sellPutStrike}/$${buyPutStrike} Put Spread`);
                aiResponse = aiResponse.replace(/~\$1\/share/gi, `~$${premium}/share`);
                aiResponse = aiResponse.replace(/\$1\s+strike/gi, `$${sellPutStrike} strike`);
                aiResponse = aiResponse.replace(/\$1(?![0-9.,])/g, `$${stockPrice}`);
            }
        }  // End Guided Mode post-processing
        
        // Range position sanity check - warn if AI ignores directional guidance (Guided Mode only)
        let rangeWarning = null;
        if (!expertMode) {
            const rangePos = quote.rangePosition;
            if (rangePos !== undefined && rangePos !== null) {
                // Detect which setup AI recommended
                const recMatch = aiResponse.match(/RECOMMENDED:\s*([A-H])\s*-?\s*([^\n]*)/i);
                const recLetter = recMatch ? recMatch[1].toUpperCase() : null;
            
                const bullishSetups = ['A', 'B', 'F', 'H'];
                const bearishSetups = ['D', 'E'];
                const neutralSetups = ['G'];
            
                if (rangePos < 25 && recLetter) {
                    // Near low - should be bullish
                    if (bearishSetups.includes(recLetter) || neutralSetups.includes(recLetter)) {
                        rangeWarning = `⚠️ RANGE CONFLICT: Stock is at ${rangePos}% of 3-month range (near LOW = oversold), but AI recommended ${recLetter} (${neutralSetups.includes(recLetter) ? 'neutral' : 'bearish'}). Consider bullish strategies (A, B, F, H) for oversold stocks.`;
                        console.log(`[STRATEGY-ADVISOR] ⚠️ Range conflict: ${rangePos}% (oversold) but recommended ${recLetter}`);
                    }
                } else if (rangePos > 75 && recLetter) {
                    // Near high - should be bearish/neutral
                    if (bullishSetups.includes(recLetter)) {
                        rangeWarning = `⚠️ RANGE CONFLICT: Stock is at ${rangePos}% of 3-month range (near HIGH = overbought), but AI recommended ${recLetter} (bullish). Consider bearish or neutral strategies (D, E, G) for extended stocks.`;
                        console.log(`[STRATEGY-ADVISOR] ⚠️ Range conflict: ${rangePos}% (overbought) but recommended ${recLetter}`);
                    }
                }
            }
        }
        
        res.json({
            success: true,
            ticker,
            spot: quote.price,
            stockData,
            ivRank,
            expirations,
            dataSource,
            expertMode: !!expertMode,
            recommendation: aiResponse,
            rangeWarning,
            model: selectedModel
        });
        
        console.log(`[STRATEGY-ADVISOR] ✅ Analysis complete for ${ticker}`);
        
    } catch (e) {
        console.log('[STRATEGY-ADVISOR] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// TRADE IDEAS GENERATOR
// =============================================================================

router.post('/ideas', async (req, res) => {
    try {
        const data = req.body;
        const selectedModel = data.model || 'qwen2.5:14b';
        const xTrendingTickers = data.xTrendingTickers || [];
        console.log('[AI] Generating trade ideas with model:', selectedModel);
        
        // Fetch real prices for wheel candidates
        const buyingPower = data.buyingPower || 25000;
        const excludeTickers = data.excludeTickers || [];
        const realPrices = await DiscoveryService.fetchWheelCandidatePrices(buyingPower, excludeTickers);
        
        // Fetch prices for X trending tickers
        let xTickerPrices = [];
        if (xTrendingTickers.length > 0) {
            const xPricePromises = xTrendingTickers.map(async (ticker) => {
                try {
                    const quoteRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`);
                    if (quoteRes.ok) {
                        const data = await quoteRes.json();
                        const result = data.chart?.result?.[0];
                        if (result?.meta?.regularMarketPrice) {
                            const price = result.meta.regularMarketPrice;
                            const prevClose = result.meta.previousClose || price;
                            const highs = result.indicators?.quote?.[0]?.high || [];
                            const lows = result.indicators?.quote?.[0]?.low || [];
                            const monthHigh = Math.max(...highs.filter(h => h));
                            const monthLow = Math.min(...lows.filter(l => l));
                            const monthChange = prevClose ? ((price - prevClose) / prevClose * 100).toFixed(1) : 0;
                            const rangePosition = monthHigh - monthLow > 0 ? Math.round((price - monthLow) / (monthHigh - monthLow) * 100) : 50;
                            
                            return {
                                ticker,
                                price: price.toFixed(2),
                                monthLow: monthLow?.toFixed(2) || price.toFixed(2),
                                monthHigh: monthHigh?.toFixed(2) || price.toFixed(2),
                                monthChange,
                                rangePosition,
                                sector: '🔥 X Trending'
                            };
                        }
                    }
                } catch (e) {
                    console.log(`[AI] Failed to fetch X ticker ${ticker}:`, e.message);
                }
                return null;
            });
            xTickerPrices = (await Promise.all(xPricePromises)).filter(p => p !== null);
        }
        
        const allCandidates = [...xTickerPrices, ...realPrices];
        
        const prompt = promptBuilders.buildIdeaPrompt(data, allCandidates, xTrendingTickers);
        const response = await AIService.callAI(prompt, selectedModel, 1500);
        
        const discoveredCount = realPrices.filter(p => p.sector === 'Active Today' || p.sector === 'Trending').length;
        
        res.json({ 
            success: true, 
            ideas: response,
            model: selectedModel,
            candidatesChecked: allCandidates.length,
            discoveredCount,
            xTrendingCount: xTickerPrices.length,
            candidates: allCandidates
        });
        console.log(`[AI] ✅ Ideas generated (${allCandidates.length} candidates)`);
    } catch (e) {
        console.log('[AI] ❌ Ideas error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// GENERIC GROK PROMPT
// =============================================================================

router.post('/grok', async (req, res) => {
    try {
        const { prompt, maxTokens } = req.body;
        
        if (!process.env.GROK_API_KEY) {
            return res.status(400).json({ error: 'Grok API key not configured. Add in Settings.' });
        }
        
        console.log('[AI] Grok custom prompt request...');
        const response = await AIService.callGrok(prompt, 'grok-3', maxTokens || 800);
        
        res.json({ 
            success: true, 
            insight: response,
            source: 'grok-3'
        });
        console.log('[AI] ✅ Grok custom prompt complete');
    } catch (e) {
        console.log('[AI] ❌ Grok error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// X/TWITTER SENTIMENT (Grok-only)
// =============================================================================

router.post('/x-sentiment', async (req, res) => {
    try {
        const data = req.body;
        const { buyingPower, holdings } = data;
        
        if (!process.env.GROK_API_KEY) {
            return res.status(400).json({ error: 'X Sentiment requires Grok API. Configure in Settings.' });
        }
        
        console.log('[AI] 🔥 Fetching X/Twitter sentiment via Grok...');
        
        const today = new Date();
        const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        
        let holdingsContext = '';
        if (holdings && holdings.length > 0) {
            const holdingsList = holdings.map(h => `${h.ticker} (${h.shares || h.quantity || 100} shares @ $${h.costBasis || h.avgCost || '?'})`).join(', ');
            holdingsContext = `

**IMPORTANT - CHECK MY HOLDINGS FIRST:**
I currently hold these stocks: ${holdingsList}

BEFORE the main analysis, check if there's ANY news, sentiment, or buzz on X about my holdings. Put this in a section called "⚡ YOUR HOLDINGS ALERT" at the very top. If nothing notable, just say "No significant X chatter about your holdings today."
`;
        }
        
        const prompt = `Today is ${dateStr}. You have real-time access to X (Twitter). I'm a wheel strategy options trader with $${buyingPower || 25000} buying power.
${holdingsContext}
Scan X/Twitter RIGHT NOW and find me:

1. **🔥 TRENDING TICKERS** - What stocks are traders actively discussing today?
2. **📢 EARNINGS PLAYS** - Any upcoming earnings that FinTwit is buzzing about?
3. **⚠️ CAUTION FLAGS** - Stocks where sentiment has turned negative?
4. **💰 PUT SELLING OPPORTUNITIES** - Stocks good for selling puts?
5. **🚀 SECTOR MOMENTUM** - What sectors are traders most bullish/bearish on?

FORMAT each ticker mention like: **TICKER** @ $XX.XX
Be specific about WHAT you're seeing on X. Focus on wheel-friendly stocks ($5-$200 range).`;

        const response = await AIService.callGrok(prompt, 'grok-3', 1500);
        
        res.json({ 
            success: true, 
            sentiment: response,
            source: 'grok-x-realtime',
            timestamp: new Date().toISOString()
        });
        console.log('[AI] ✅ X sentiment retrieved');
    } catch (e) {
        console.log('[AI] ❌ X sentiment error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// DEEP DIVE - Comprehensive single trade analysis
// =============================================================================

router.post('/deep-dive', async (req, res) => {
    try {
        const data = req.body;
        const { ticker, strike, expiry, currentPrice, model, positionType } = data;
        const selectedModel = model || 'deepseek-r1:32b';
        
        // Determine option type
        const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
        const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
        const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
        
        console.log(`[AI] Deep dive on ${ticker} $${strike} ${optionType.toLowerCase()}, expiry ${expiry}`);
        
        // Fetch extended data
        const tickerData = await DataService.fetchDeepDiveData(ticker);
        
        // Fetch actual option premium
        const premium = await DataService.fetchOptionPremium(ticker, parseFloat(strike), expiry, optionType);
        if (premium) {
            tickerData.premium = premium;
            console.log(`[CBOE] Found premium: bid=$${premium.bid} ask=$${premium.ask} IV=${premium.iv}%`);
        }
        
        const prompt = promptBuilders.buildDeepDivePrompt(data, tickerData);
        const response = await AIService.callAI(prompt, selectedModel, 1000);
        
        res.json({ 
            success: true, 
            analysis: response,
            model: selectedModel,
            tickerData,
            premium
        });
        console.log('[AI] ✅ Deep dive complete');
    } catch (e) {
        console.log('[AI] ❌ Deep dive error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// POSITION CHECKUP - Compare opening thesis to current state
// =============================================================================

router.post('/checkup', async (req, res) => {
    try {
        const data = req.body;
        const { ticker, strike, expiry, openingThesis, positionType, model } = data;
        const selectedModel = model || 'qwen2.5:7b';
        
        // Determine option type
        const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
        const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
        const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
        
        console.log(`[AI] Position checkup for ${ticker} $${strike} ${optionType.toLowerCase()}`);
        
        const currentData = await DataService.fetchDeepDiveData(ticker);
        const currentPremium = await DataService.fetchOptionPremium(ticker, parseFloat(strike), formatExpiryForCBOE(expiry), optionType);
        
        const prompt = promptBuilders.buildCheckupPrompt(data, openingThesis, currentData, currentPremium);
        const response = await AIService.callAI(prompt, selectedModel, 800);
        
        res.json({ 
            success: true, 
            checkup: response,
            model: selectedModel,
            currentData,
            currentPremium
        });
        console.log('[AI] ✅ Checkup complete');
    } catch (e) {
        console.log('[AI] ❌ Checkup error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// PARSE TRADE - Discord trade parsing with SSE progress
// =============================================================================

router.post('/parse-trade', async (req, res) => {
    const acceptsSSE = req.headers.accept?.includes('text/event-stream');
    
    const sendProgress = (step, message, data = {}) => {
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify({ type: 'progress', step, message, ...data })}\n\n`);
        }
        console.log(`[AI] Step ${step}: ${message}`);
    };
    
    try {
        const { tradeText, model, closedSummary } = req.body;
        const selectedModel = model || 'qwen2.5:7b';
        
        // For parsing, use a simpler model - R1's "thinking" wastes tokens on simple JSON extraction
        // R1 is great for analysis but overkill for parsing
        const isR1 = selectedModel.includes('r1');
        const parseModel = isR1 ? 'qwen2.5:7b' : selectedModel;
        const analysisModel = selectedModel; // Use selected model for actual analysis
        
        if (acceptsSSE) {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
        }
        
        sendProgress(1, `Loading ${parseModel}...`, { total: 4 });
        
        // Step 1: Parse trade text (use parseModel - simpler model for JSON extraction)
        const parsePrompt = promptBuilders.buildTradeParsePrompt(tradeText);
        sendProgress(1, `Parsing trade callout with ${parseModel}...`);
        let parsedJson = await AIService.callAI(parsePrompt, parseModel, 500);
        
        // Strip <think>...</think> tags from R1 models before parsing
        parsedJson = parsedJson.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        
        let parsed;
        try {
            const jsonMatch = parsedJson.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in parse response');
            }
        } catch (parseErr) {
            console.log('[AI] Parse extraction failed:', parseErr.message);
            console.log('[AI] Raw response was:', parsedJson.substring(0, 500));
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'Could not parse trade format.' })}\n\n`);
                return res.end();
            }
            return res.status(400).json({ error: 'Could not parse trade format.' });
        }
        
        if (!parsed.ticker) {
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'Could not identify ticker symbol' })}\n\n`);
                return res.end();
            }
            return res.status(400).json({ error: 'Could not identify ticker symbol' });
        }
        
        // Fix spread strikes if backwards
        if (parsed.buyStrike && parsed.sellStrike) {
            const buy = parseFloat(parsed.buyStrike);
            const sell = parseFloat(parsed.sellStrike);
            const strategy = parsed.strategy?.toLowerCase() || '';
            
            if (strategy.includes('bull') && strategy.includes('put') && sell < buy) {
                parsed.sellStrike = Math.max(buy, sell);
                parsed.buyStrike = Math.min(buy, sell);
            }
        }
        
        // Step 2: Fetch ticker data
        sendProgress(2, `Fetching market data for ${parsed.ticker}...`);
        const tickerData = await DataService.fetchDeepDiveData(parsed.ticker);
        if (!tickerData || !tickerData.price) {
            if (acceptsSSE) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: `Could not fetch data for ${parsed.ticker}` })}\n\n`);
                return res.end();
            }
            return res.status(400).json({ error: `Could not fetch data for ${parsed.ticker}` });
        }
        
        // Step 3: Fetch option premium AND alternatives chain
        sendProgress(3, `Fetching CBOE options pricing...`);
        let premium = null;
        let alternativeStrikes = [];
        
        const callStrategies = ['long_call', 'covered_call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
        const strategyLower = (parsed.strategy || '').toLowerCase().replace(/\s+/g, '_');
        const optionType = callStrategies.some(s => strategyLower.includes(s)) ? 'CALL' : 'PUT';
        
        if (parsed.strike && parsed.expiry) {
            const strikeNum = parseFloat(String(parsed.strike).replace(/[^0-9.]/g, ''));
            premium = await DataService.fetchOptionPremium(parsed.ticker, strikeNum, formatExpiryForCBOE(parsed.expiry), optionType);
        }
        
        // Fetch options chain to get real alternative strikes
        try {
            const chain = await MarketDataService.getOptionsChain(parsed.ticker, { strikeCount: 30 });
            if (chain) {
                const options = optionType === 'CALL' ? (chain.calls || []) : (chain.puts || []);
                const currentStrike = parseFloat(parsed.strike) || 0;
                const spot = parseFloat(tickerData.price) || 0;
                
                // Parse the original trade's expiry to match
                const originalExpiry = parsed.expiry ? new Date(parsed.expiry) : null;
                const originalExpiryStr = originalExpiry ? originalExpiry.toISOString().split('T')[0] : null;
                
                // Get strikes FURTHER OTM than the original (better cushion)
                // For puts: lower strikes = more OTM = better
                // For calls: higher strikes = more OTM = better
                const betterStrikes = options.filter(opt => {
                    const strike = parseFloat(opt.strike);
                    
                    // Filter by expiry - match same expiry OR close to it (within 7 days)
                    if (originalExpiry && opt.expiration) {
                        const optExpiry = new Date(opt.expiration);
                        const daysDiff = Math.abs((optExpiry - originalExpiry) / (1000*60*60*24));
                        if (daysDiff > 7) return false; // Skip if expiry is too different
                    }
                    
                    if (optionType === 'PUT') {
                        return strike < currentStrike && strike > spot * 0.7; // 30% max OTM
                    } else {
                        return strike > currentStrike && strike < spot * 1.3; // 30% max OTM
                    }
                });
                
                // Deduplicate by strike - keep the one closest to original expiry
                const strikeMap = new Map();
                for (const opt of betterStrikes) {
                    const strike = parseFloat(opt.strike);
                    if (!strikeMap.has(strike)) {
                        strikeMap.set(strike, opt);
                    } else if (originalExpiry) {
                        // If we already have this strike, keep the one with closer expiry
                        const existing = strikeMap.get(strike);
                        const existingDiff = Math.abs(new Date(existing.expiration) - originalExpiry);
                        const newDiff = Math.abs(new Date(opt.expiration) - originalExpiry);
                        if (newDiff < existingDiff) {
                            strikeMap.set(strike, opt);
                        }
                    }
                }
                const uniqueStrikes = Array.from(strikeMap.values());
                
                // Sort by distance from current strike (closer alternatives first)
                uniqueStrikes.sort((a, b) => {
                    const distA = Math.abs(parseFloat(a.strike) - currentStrike);
                    const distB = Math.abs(parseFloat(b.strike) - currentStrike);
                    return distA - distB;
                });
                
                // Take up to 3 alternative strikes with good liquidity
                alternativeStrikes = uniqueStrikes
                    .filter(opt => (opt.bid || 0) > 0.10) // Has some premium
                    .slice(0, 3)
                    .map(opt => {
                        const strike = parseFloat(opt.strike);
                        const cushion = optionType === 'PUT' 
                            ? ((spot - strike) / spot * 100).toFixed(1)
                            : ((strike - spot) / spot * 100).toFixed(1);
                        return {
                            strike,
                            expiry: opt.expiration,
                            bid: opt.bid,
                            ask: opt.ask,
                            mid: ((opt.bid || 0) + (opt.ask || 0)) / 2,
                            cushion: `${cushion}%`,
                            dte: opt.dte || Math.ceil((new Date(opt.expiration) - new Date()) / (1000*60*60*24))
                        };
                    });
                
                console.log(`[AI] Found ${alternativeStrikes.length} alternative strikes for ${parsed.ticker}`);
                if (alternativeStrikes.length > 0) {
                    console.log(`[AI] Alternatives:`, alternativeStrikes.map(a => `$${a.strike} (bid:$${a.bid?.toFixed(2)}, ask:$${a.ask?.toFixed(2)}, ${a.cushion} OTM)`).join(', '));
                }
            }
        } catch (chainErr) {
            console.log(`[AI] Could not fetch options chain for alternatives: ${chainErr.message}`);
        }

        // Step 4: Generate AI analysis (use analysisModel - the user's selected model, including R1)
        sendProgress(4, `Generating AI analysis with ${analysisModel}...`);
        
        // Build pattern context from closed positions
        let patternContext = null;
        if (closedSummary && closedSummary.length > 0) {
            // ... pattern analysis logic (abbreviated for space)
            const ticker = parsed.ticker?.toUpperCase();
            const strategyType = parsed.strategy?.toLowerCase().replace(/\s+/g, '_') || '';
            const sameTickerType = closedSummary.filter(p => 
                p.ticker?.toUpperCase() === ticker && 
                p.type?.toLowerCase().replace(/\s+/g, '_') === strategyType
            );
            
            if (sameTickerType.length >= 2) {
                const totalPnL = sameTickerType.reduce((sum, p) => sum + (p.pnl || 0), 0);
                const winRate = sameTickerType.filter(p => (p.pnl || 0) >= 0).length / sameTickerType.length * 100;
                patternContext = `### ${ticker} ${strategyType} History\n- ${sameTickerType.length} trades, ${winRate.toFixed(0)}% win rate, $${totalPnL.toFixed(0)} total P&L\n`;
            }
        }
        
        const analysisPrompt = promptBuilders.buildDiscordTradeAnalysisPrompt(parsed, tickerData, premium, patternContext, alternativeStrikes);
        // R1 models need more tokens because they use tokens for both thinking AND response
        // Increased in v1.13+ to prevent analysis cutoff - grade + alternatives need ~1500 tokens
        const analysisTokens = analysisModel.includes('r1') ? 4000 : 2000;
        const analysis = await AIService.callAI(analysisPrompt, analysisModel, analysisTokens);
        
        const result = { 
            type: 'complete',
            success: true,
            parsed,
            tickerData,
            premium,
            analysis,
            model: analysisModel
        };
        
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify(result)}\n\n`);
            res.end();
        } else {
            res.json(result);
        }
        console.log('[AI] ✅ Trade callout analyzed');
    } catch (e) {
        console.log('[AI] ❌ Parse trade error:', e.message);
        if (acceptsSSE) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
            res.end();
        } else {
            if (!res.headersSent) res.status(500).json({ error: e.message });
        }
    }
});

// =============================================================================
// TRADE ANALYSIS - Main analysis with MoE support
// =============================================================================

router.post('/analyze', async (req, res) => {
    try {
        const data = req.body;
        const selectedModel = data.model || 'qwen2.5:7b';
        const isGrok = selectedModel.startsWith('grok');
        const useMoE = !isGrok && data.useMoE !== false;
        const skipWisdom = data.skipWisdom === true;
        console.log('[AI] Analyzing position:', data.ticker, 'with model:', selectedModel, skipWisdom ? '(PURE MODE)' : '');
        
        // DEBUG: Log key data being sent to prompt builder
        console.log('[AI] Position data:', {
            ticker: data.ticker,
            positionType: data.positionType,
            strike: data.strike,
            spot: data.spot,
            isITM: data.positionType === 'covered_call' ? data.spot > data.strike : data.spot < data.strike,
            rollOptions: {
                riskReduction: data.rollOptions?.riskReduction?.length || 0,
                creditRolls: data.rollOptions?.creditRolls?.length || 0
            }
        });
        
        const isLargeModel = selectedModel.includes('32b') || selectedModel.includes('70b') || selectedModel.includes('72b') || isGrok;
        const tokenLimit = isLargeModel ? 1800 : 1000;
        
        const prompt = await promptBuilders.buildTradePrompt({ ...data, skipWisdom }, isLargeModel);
        const wisdomUsed = promptBuilders.buildTradePrompt._lastWisdomUsed || [];
        
        let response;
        let took = '';
        let moeDetails = null;
        
        if (isLargeModel && useMoE) {
            const moeResult = await AIService.callMoE(prompt, data);
            response = moeResult.response;
            took = `MoE: ${moeResult.timing.total}ms`;
            moeDetails = { opinions: moeResult.opinions, timing: moeResult.timing };
        } else {
            const start = Date.now();
            response = await AIService.callAI(prompt, selectedModel, tokenLimit);
            took = `${Date.now() - start}ms`;
        }
        
        res.json({ 
            success: true, 
            insight: response,
            model: selectedModel,
            took,
            moe: moeDetails,
            pureMode: skipWisdom,
            wisdomApplied: !skipWisdom && wisdomUsed.length > 0 ? {
                count: wisdomUsed.length,
                entries: wisdomUsed.map(w => ({ category: w.category, wisdom: w.wisdom.substring(0, 100) + '...' }))
            } : null
        });
        console.log('[AI] ✅ Analysis complete');
    } catch (e) {
        console.log('[AI] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// PORTFOLIO AUDIT
// =============================================================================

router.post('/portfolio-audit', async (req, res) => {
    try {
        const data = req.body;
        const selectedModel = data.model || 'qwen2.5:14b';
        console.log('[AI] Portfolio audit with model:', selectedModel);
        
        const positions = data.positions || [];
        const greeks = data.greeks || {};
        const closedStats = data.closedStats || {};
        
        // Build position summary
        const positionSummary = positions.map(p => {
            const riskPct = p.riskPercent || 0;
            const isLong = ['long_call', 'long_put', 'long_call_leaps', 'skip_call'].includes(p.type);
            const isSpread = p.type?.includes('_spread');
            const typeNote = isLong ? '[LONG]' : (isSpread ? '[SPREAD]' : '[SHORT]');
            
            // Build strike display - spreads have two strikes
            let strikeDisplay;
            if (isSpread && p.sellStrike && p.buyStrike) {
                strikeDisplay = `$${p.sellStrike}/$${p.buyStrike} (${p.spreadWidth || Math.abs(p.sellStrike - p.buyStrike)}w)`;
            } else {
                strikeDisplay = `$${p.strike}`;
            }
            
            // Add max profit/loss for spreads
            let spreadInfo = '';
            if (isSpread && p.maxProfit != null) {
                spreadInfo = ` MaxProfit: $${p.maxProfit}, MaxLoss: $${p.maxLoss}`;
            }
            
            return `${p.ticker}: ${p.type} ${strikeDisplay} (${p.dte}d DTE) ${typeNote}${spreadInfo} - ${riskPct.toFixed(0)}% ITM`;
        }).join('\n');
        
        // Concentration analysis
        const tickerCounts = {};
        positions.forEach(p => { tickerCounts[p.ticker] = (tickerCounts[p.ticker] || 0) + 1; });
        const concentrations = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}: ${c}`);
        
        const prompt = `You are a professional options portfolio manager providing a comprehensive audit.

IMPORTANT: This portfolio may contain MULTIPLE STRATEGIES beyond just the wheel. LEAPs, long calls, spreads, and other directional trades are VALID profit-generating strategies. Do NOT penalize positions simply for not fitting the "wheel" pattern. Judge each position on its own merits: risk/reward, position sizing, and strategic intent.

## CURRENT POSITIONS (${positions.length} total)
${positionSummary || 'No open positions'}

## PORTFOLIO GREEKS
- Net Delta: ${greeks.delta?.toFixed(0) || 0}
- Daily Theta: $${greeks.theta?.toFixed(2) || 0}
- Vega: $${greeks.vega?.toFixed(0) || 0}

## CONCENTRATION
${concentrations.join('\n') || 'None'}

## HISTORICAL PERFORMANCE
- Win Rate: ${closedStats.winRate?.toFixed(1) || '?'}%
- Profit Factor: ${closedStats.profitFactor?.toFixed(2) || '?'}

Provide:
## 📊 PORTFOLIO GRADE: [A/B/C/D/F]
Grade based on overall risk management, diversification, and profit potential - not adherence to any single strategy.

Then: 1. 🚨 PROBLEM POSITIONS (actual problems, not just "different strategy"), 2. ⚠️ CONCENTRATION RISKS, 3. 📊 GREEKS ASSESSMENT, 4. 💡 OPTIMIZATION IDEAS, 5. ✅ WHAT'S WORKING`;

        const response = await AIService.callAI(prompt, selectedModel, 1200);
        
        res.json({ success: true, audit: response, model: selectedModel });
        console.log('[AI] ✅ Portfolio audit complete');
    } catch (e) {
        console.log('[AI] ❌ Portfolio audit error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// HISTORICAL AUDIT
// =============================================================================

router.post('/historical-audit', async (req, res) => {
    try {
        const data = req.body;
        console.log('[AI] Historical audit for period:', data.periodLabel);
        
        const prompt = `You are a professional options trading coach analyzing historical trade data.

## PERIOD: ${data.periodLabel}
- Total Trades: ${data.totalTrades}
- Total P&L: $${data.totalPnL?.toFixed(0) || 0}
- Win Rate: ${data.winRate}%

## BY TICKER (Top 10)
${(data.tickerSummary || []).join('\n')}

## BY STRATEGY
${(data.typeSummary || []).join('\n')}

Provide:
## 📊 PERIOD GRADE: [A/B/C/D/F]
Then: 1. 🎯 WHAT WORKED, 2. ⚠️ AREAS FOR IMPROVEMENT, 3. 📈 PATTERN ANALYSIS, 4. 💡 RECOMMENDATIONS, 5. 🏆 KEY LESSONS`;

        const response = await AIService.callAI(prompt, 'qwen2.5:14b', 1200);
        
        res.json({ success: true, analysis: response });
        console.log('[AI] ✅ Historical audit complete');
    } catch (e) {
        console.log('[AI] ❌ Historical audit error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// AI STATUS - Check Ollama availability
// =============================================================================

router.get('/status', async (req, res) => {
    try {
        const gpu = detectGPU();
        const ollamaRes = await fetchJsonHttp('http://localhost:11434/api/tags');
        const models = ollamaRes.models || [];
        const hasQwen = models.some(m => m.name?.includes('qwen'));
        const hasVision = models.some(m => m.name?.includes('minicpm-v') || m.name?.includes('llava'));
        
        let loadedModels = [];
        try {
            const psRes = await fetchJsonHttp('http://localhost:11434/api/ps');
            loadedModels = (psRes.models || []).map(m => ({
                name: m.name,
                sizeVramGB: (m.size_vram / 1024 / 1024 / 1024).toFixed(1)
            }));
        } catch (e) { /* older Ollama versions */ }
        
        const freeGB = parseFloat(gpu.freeGB) || 0;
        const totalGB = parseFloat(gpu.totalGB) || 0;
        const modelsWithCapability = models.map(m => {
            const req = MODEL_VRAM_REQUIREMENTS[m.name] || { minGB: 4, recGB: 8 };
            const canRun = gpu.available && freeGB >= req.minGB;
            return { 
                name: m.name, 
                sizeGB: (m.size / 1024 / 1024 / 1024).toFixed(1),
                canRun,
                warning: !canRun ? `Needs ${req.minGB}GB VRAM (${freeGB}GB free)` : null
            };
        });
        
        res.json({ 
            available: models.length > 0,
            hasQwen,
            hasVision,
            gpu,
            models: modelsWithCapability,
            loaded: loadedModels,
            isWarm: loadedModels.length > 0
        });
    } catch (e) {
        res.json({ available: false, error: 'Ollama not running', gpu: detectGPU() });
    }
});

// =============================================================================
// RESTART OLLAMA
// =============================================================================

router.post('/restart', async (req, res) => {
    console.log('[AI] 🔄 Restarting Ollama...');
    try {
        const { exec } = require('child_process');
        
        await new Promise((resolve) => {
            exec('taskkill /f /im ollama.exe', () => resolve());
        });
        
        await new Promise(r => setTimeout(r, 1000));
        
        await new Promise((resolve, reject) => {
            exec('start /b ollama serve', { shell: true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        
        await new Promise(r => setTimeout(r, 3000));
        
        try {
            const status = await fetchJsonHttp('http://localhost:11434/api/tags');
            console.log('[AI] ✅ Ollama restarted successfully');
            res.json({ success: true, models: status.models?.length || 0 });
        } catch (e) {
            res.status(500).json({ success: false, error: 'Ollama failed to start' });
        }
    } catch (e) {
        console.log('[AI] ❌ Restart error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================================================
// WARMUP - Pre-load model (SSE)
// =============================================================================

router.post('/warmup', async (req, res) => {
    try {
        const selectedModel = req.body?.model || 'qwen2.5:7b';
        console.log(`[AI] 🔥 Warming up model: ${selectedModel}...`);
        
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        
        res.write(`data: ${JSON.stringify({ type: 'progress', message: `Loading ${selectedModel}...`, percent: 10 })}\n\n`);
        
        const startTime = Date.now();
        
        const postData = JSON.stringify({
            model: selectedModel,
            prompt: 'Hi',
            stream: false,
            options: { num_predict: 1 }
        });
        
        const ollamaReq = http.request({
            hostname: 'localhost',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (ollamaRes) => {
            let data = '';
            
            const progressInterval = setInterval(() => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
                const percent = Math.min(90, 10 + parseInt(elapsed) * 5);
                res.write(`data: ${JSON.stringify({ type: 'progress', message: `Loading ${selectedModel}... ${elapsed}s`, percent })}\n\n`);
            }, 1000);
            
            ollamaRes.on('data', chunk => data += chunk);
            ollamaRes.on('end', () => {
                clearInterval(progressInterval);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[AI] ✅ Model ${selectedModel} loaded in ${elapsed}s`);
                
                res.write(`data: ${JSON.stringify({ type: 'complete', success: true, message: `Loaded in ${elapsed}s`, model: selectedModel })}\n\n`);
                res.end();
            });
        });
        
        ollamaReq.on('error', (e) => {
            console.log(`[AI] ❌ Warmup failed: ${e.message}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
            res.end();
        });
        
        ollamaReq.setTimeout(180000, () => {
            ollamaReq.destroy();
            res.write(`data: ${JSON.stringify({ type: 'error', error: 'Timeout - model too large' })}\n\n`);
            res.end();
        });
        
        ollamaReq.write(postData);
        ollamaReq.end();
        
    } catch (e) {
        console.log(`[AI] ❌ Warmup failed: ${e.message}`);
        if (!res.headersSent) {
            res.set({ 'Content-Type': 'text/event-stream' });
        }
        res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
        res.end();
    }
});

// =============================================================================
// PARSE IMAGE - Vision model
// =============================================================================

router.post('/parse-image', async (req, res) => {
    console.log('[AI-VISION] 📷 Image parse request received');
    try {
        const { image, model = 'minicpm-v:latest' } = req.body || {};
        
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }
        
        let base64Data = image;
        if (image.startsWith('data:image')) {
            base64Data = image.split(',')[1];
        }
        
        console.log(`[AI-VISION] Using model: ${model}, image size: ${(base64Data.length / 1024).toFixed(1)}KB`);
        
        const prompt = `You are extracting trade information from a broker confirmation screenshot.
Look at this image and extract:
1. Ticker symbol
2. Action (Sold to Open, etc.)
3. Option type (Put or Call)
4. Strike price
5. Expiration date
6. Premium/price per share
7. Number of contracts
8. Total premium

Format as:
TICKER: [symbol]
ACTION: [action]
TYPE: [put/call]
STRIKE: [strike price]
EXPIRY: [date]
PREMIUM: [per share price]
CONTRACTS: [number]
TOTAL: [total amount]`;

        const postData = JSON.stringify({
            model,
            prompt,
            images: [base64Data],
            stream: false,
            options: { temperature: 0.1 }
        });
        
        const response = await new Promise((resolve, reject) => {
            const ollamaReq = http.request({
                hostname: 'localhost',
                port: 11434,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (ollamaRes) => {
                let data = '';
                ollamaRes.on('data', chunk => data += chunk);
                ollamaRes.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.response || data);
                    } catch { resolve(data); }
                });
            });
            
            ollamaReq.on('error', reject);
            ollamaReq.setTimeout(120000, () => {
                ollamaReq.destroy();
                reject(new Error('Timeout'));
            });
            
            ollamaReq.write(postData);
            ollamaReq.end();
        });
        
        console.log('[AI-VISION] ✅ Image parsed successfully');
        
        const parsed = {};
        response.split('\n').forEach(line => {
            const match = line.match(/^(TICKER|ACTION|TYPE|STRIKE|EXPIRY|PREMIUM|CONTRACTS|TOTAL):\s*(.+)/i);
            if (match) parsed[match[1].toLowerCase()] = match[2].trim();
        });
        
        res.json({ success: true, raw: response, parsed, model });
        
    } catch (e) {
        console.log('[AI-VISION] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// PARSE WISDOM IMAGE - Extract trading advice from screenshots
// =============================================================================

router.post('/parse-wisdom-image', async (req, res) => {
    console.log('[AI-VISION] 📚 Wisdom image parse request received');
    try {
        const { image, model = 'minicpm-v:latest' } = req.body || {};
        
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }
        
        let base64Data = image;
        if (image.startsWith('data:image')) {
            base64Data = image.split(',')[1];
        }
        
        const prompt = `Look at this screenshot and extract ALL trading advice, tips, or wisdom mentioned.
Focus on extracting:
- Any specific rules or guidelines
- Any strategies or recommendations
- Any warnings or things to avoid
- Any tips about rolling, timing, or position sizing

Return ONLY the trading advice/wisdom text that you find.
If you cannot find any trading advice, respond with: NO_TRADING_ADVICE_FOUND`;

        const postData = JSON.stringify({
            model,
            prompt,
            images: [base64Data],
            stream: false,
            options: { temperature: 0.1 }
        });
        
        const response = await new Promise((resolve, reject) => {
            const ollamaReq = http.request({
                hostname: 'localhost',
                port: 11434,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (ollamaRes) => {
                let data = '';
                ollamaRes.on('data', chunk => data += chunk);
                ollamaRes.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.response || data);
                    } catch { resolve(data); }
                });
            });
            
            ollamaReq.on('error', reject);
            ollamaReq.setTimeout(120000, () => {
                ollamaReq.destroy();
                reject(new Error('Timeout'));
            });
            
            ollamaReq.write(postData);
            ollamaReq.end();
        });
        
        if (!response || response.trim().startsWith('{"error"')) {
            return res.status(500).json({ error: 'Vision model error. Try restarting Ollama.' });
        }
        
        console.log('[AI-VISION] ✅ Wisdom image parsed successfully');
        
        if (response.includes('NO_TRADING_ADVICE_FOUND')) {
            return res.json({ success: false, error: 'No trading advice found in image', extractedText: '' });
        }
        
        res.json({ success: true, extractedText: response.trim(), model });
        
    } catch (e) {
        console.log('[AI-VISION] ❌ Wisdom parse error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// SIMPLE PROMPT - Direct AI call with custom prompt (no prompt builder)
// =============================================================================

router.post('/simple', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt' });
        }
        
        const selectedModel = model || 'qwen2.5:14b';
        const isGrok = selectedModel.startsWith('grok');
        const tokenLimit = isGrok ? 500 : 800;
        
        console.log('[AI-SIMPLE] Direct prompt with model:', selectedModel);
        
        let response;
        if (isGrok) {
            response = await AIService.callGrok(prompt, selectedModel, tokenLimit);
        } else {
            response = await AIService.callAI(prompt, selectedModel, tokenLimit);
        }
        
        res.json({ 
            success: true, 
            insight: response,
            model: selectedModel
        });
        console.log('[AI-SIMPLE] ✅ Complete');
    } catch (e) {
        console.log('[AI-SIMPLE] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
