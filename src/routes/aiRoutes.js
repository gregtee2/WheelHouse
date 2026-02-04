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
let TechnicalService;    // Trendlines, Fibonacci analysis
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
    TechnicalService = deps.TechnicalService;
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
        const { ticker, buyingPower, accountValue, kellyBase, riskTolerance, existingPositions, model, expertMode, sharesOwned, costBasis } = data;
        const selectedModel = model || 'qwen2.5:32b';
        
        console.log(`[STRATEGY-ADVISOR] Analyzing ${ticker} with model ${selectedModel}${expertMode ? ' (EXPERT MODE)' : ''}`);
        console.log(`[STRATEGY-ADVISOR] Buying power from request: ${buyingPower} (type: ${typeof buyingPower})`);
        
        // Log share holdings if present (enables covered call recommendations)
        if (sharesOwned > 0) {
            console.log(`[STRATEGY-ADVISOR] 📦 User owns ${sharesOwned} shares @ $${costBasis?.toFixed(2) || '?'} cost basis`);
        }        
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
            sharesOwned: sharesOwned || 0,       // NEW: Enables covered call recommendations
            costBasis: costBasis || 0,           // NEW: For breakeven calculations
            dataSource,
            model: selectedModel  // For Expert Mode to decide lite vs full prompt
        };
        
        // 4. Build AI prompt - Expert Mode or Guided Mode
        let prompt, calculatedValues;
        if (expertMode) {
            const result = promptBuilders.buildExpertModePrompt(context);
            prompt = result.prompt;
            calculatedValues = null;  // Expert mode - AI does its own math
            
            // Log mode selection
            if (result.liteMode) {
                console.log(`[STRATEGY-ADVISOR] 🎯 EXPERT MODE (LITE) - No options chain sent, faster response`);
            } else {
                console.log(`[STRATEGY-ADVISOR] 🎯 EXPERT MODE (FULL) - AI has complete options chain`);
            }
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
// X/TWITTER SENTIMENT (Grok-only with LIVE X SEARCH)
// =============================================================================

router.post('/x-sentiment', async (req, res) => {
    try {
        const data = req.body;
        const { buyingPower, holdings, optionsPositions, allTickers, sectorKeywords, previousRuns } = data;
        
        if (!process.env.GROK_API_KEY) {
            return res.status(400).json({ error: 'X Sentiment requires Grok API. Configure in Settings.' });
        }
        
        console.log(`[AI] 🔥 Fetching LIVE X/Twitter sentiment via Grok Search...`);
        console.log(`[AI]    Holdings: ${holdings?.length || 0}, Options: ${optionsPositions?.length || 0}, Tickers: ${allTickers?.length || 0}, Sector Keywords: ${sectorKeywords?.length || 0}`);
        
        const today = new Date();
        const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        
        // Build holdings context (stock holdings)
        let holdingsContext = '';
        if (holdings && holdings.length > 0) {
            const holdingsList = holdings.map(h => `${h.ticker} (${h.shares || h.quantity || 100} shares @ $${h.costBasis || h.avgCost || '?'})`).join(', ');
            holdingsContext = `
**MY STOCK HOLDINGS:**
${holdingsList}
`;
        }
        
        // Build options context with EXPLICIT ticker list
        let optionsContext = '';
        let optionsTickers = [];
        if (optionsPositions && optionsPositions.length > 0) {
            optionsTickers = [...new Set(optionsPositions.map(p => p.ticker))];
            const optionsList = optionsPositions.map(p => {
                const type = p.type?.includes('call') ? 'CALL' : 'PUT';
                return `- ${p.ticker} $${p.strike} ${type} exp ${p.expiry}`;
            }).join('\n');
            optionsContext = `
**MY OPTIONS POSITIONS (I NEED X SENTIMENT ON EACH TICKER):**
${optionsList}

⚠️ CRITICAL: You MUST search X for EACH of these tickers: ${optionsTickers.join(', ')}
Report what you find for EACH ONE - do NOT skip any just because they're smaller stocks.
`;
        }
        
        // Infer sector keywords from known tickers (fallback if positions don't have tags)
        const inferredSectors = [];
        const sectorMap = {
            'IREN': ['Bitcoin mining', 'crypto mining', 'BTC miners'],
            'CIFR': ['Bitcoin mining', 'crypto mining', 'Cipher Mining'],
            'MARA': ['Bitcoin mining', 'Marathon Digital'],
            'RIOT': ['Bitcoin mining', 'Riot Platforms'],
            'TSLL': ['Tesla', 'TSLA', 'EV', 'leveraged ETF'],
            'NVDA': ['AI chips', 'GPU', 'artificial intelligence'],
            'INTC': ['semiconductors', 'Intel', 'chip stocks', 'foundry'],
            'AMD': ['semiconductors', 'AI chips', 'data center'],
            'NBIS': ['Nebius', 'AI infrastructure', 'cloud computing'],
            'SLV': ['silver', 'precious metals', 'commodities'],
            'BABA': ['China tech', 'Alibaba', 'Chinese stocks'],
            'DJT': ['Trump Media', 'Truth Social', 'MAGA stocks']
        };
        
        // Collect sector keywords from positions AND infer from tickers
        const allSectorKeywords = [...(sectorKeywords || [])];
        (allTickers || []).forEach(ticker => {
            if (sectorMap[ticker]) {
                allSectorKeywords.push(...sectorMap[ticker]);
            }
        });
        const uniqueSectorKeywords = [...new Set(allSectorKeywords)];
        
        // Build sector keywords context
        let sectorContext = '';
        if (uniqueSectorKeywords.length > 0) {
            sectorContext = `
**SECTOR KEYWORDS TO SEARCH (if ticker-specific news is sparse):**
${uniqueSectorKeywords.join(', ')}

Use these as fallback searches - e.g., if no posts about "IREN", search "Bitcoin mining" or "crypto miners".
`;
        }
        
        // Combine all tickers for explicit search
        const tickersToSearch = allTickers && allTickers.length > 0 
            ? allTickers.join(', ')
            : (holdings || []).map(h => h.ticker).join(', ') || 'none';
        
        // Build the complete positions context - MORE FORCEFUL
        let positionsContext = '';
        if (holdingsContext || optionsContext) {
            positionsContext = `
**🚨 PRIORITY #1 - MY POSITIONS (SEARCH X FOR EACH ONE):**
${holdingsContext}${optionsContext}${sectorContext}
⚡ Put findings in "⚡ YOUR HOLDINGS ALERT" section at the VERY TOP.
For EACH ticker above, report:
- What X/Twitter is saying (bullish/bearish/quiet)
- Any news, rumors, or notable posts
- If truly nothing, say "No X buzz on [TICKER]"

DO NOT skip my options tickers just because they're smaller - I need intel on IREN, CIFR, TSLL, etc.!
`;
        }
        
        // Build trend comparison context from previous runs
        let trendContext = '';
        if (previousRuns && previousRuns.length > 0) {
            const prevTickers = previousRuns[0]?.tickers || [];
            const prevTime = previousRuns[0]?.timeString || 'earlier';
            
            // Calculate ticker frequency across all previous runs
            const tickerFreq = {};
            previousRuns.forEach(run => {
                (run.tickers || []).forEach(t => {
                    tickerFreq[t] = (tickerFreq[t] || 0) + 1;
                });
            });
            
            // Find persistent tickers (appeared 2+ times)
            const persistent = Object.entries(tickerFreq)
                .filter(([_, count]) => count >= 2)
                .map(([ticker]) => ticker);
            
            trendContext = `

**🔄 TREND COMPARISON (Compare to my previous scans):**
- My LAST scan (${prevTime}) found these tickers trending: ${prevTickers.join(', ') || 'none recorded'}
${persistent.length > 0 ? `- PERSISTENT buzz (appeared ${previousRuns.length > 2 ? 'in 2+ of my last ' + previousRuns.length + ' scans' : 'multiple times'}): ${persistent.join(', ')}` : ''}

When you find trending tickers, please note:
- 🔥🔥 **STILL HOT** if it was in my previous scan AND still trending now
- 🆕 **NEWLY TRENDING** if it wasn't in my previous scan but is hot now
- 📉 **FADING** if it was hot before but you don't see much buzz now
This helps me spot sustained momentum vs flash-in-the-pan hype.
`;
        }
        
        const prompt = `Today is ${dateStr}. You have access to real-time X/Twitter data. I'm a wheel strategy options trader with $${buyingPower || 25000} buying power.
${positionsContext}${trendContext}
**MY TICKERS TO WATCH:** ${tickersToSearch}

Please check X/Twitter for the following and report what's ACTUALLY being discussed TODAY:

**📊 MARKET PULSE** (Put this FIRST - keep it brief, 3-4 lines max)
- Overall trader mood today: Bullish / Bearish / Mixed / Cautious? One sentence on the vibe.
- Fear & Greed sentiment: What's the general risk appetite? (Greedy/Neutral/Fearful)
- Any major world events or macro news driving markets today? (Fed, geopolitics, economic data, etc.)
- Futures/pre-market direction if relevant.

Then continue with:

1. **🔥 TRENDING TICKERS** - What stocks are traders on X actively discussing right now? Look for $NVDA, $TSLA, $AMD, $PLTR, $AAPL, $MSFT and others with heavy volume of posts.
   ${previousRuns?.length > 0 ? '- Mark each as 🔥🔥 STILL HOT, 🆕 NEWLY TRENDING, or leave unmarked if new to you' : ''}

2. **📢 EARNINGS** - What earnings are traders discussing? 
   CRITICAL: Check if the earnings ALREADY HAPPENED (people discussing results) vs UPCOMING (people anticipating).
   - If people are talking about results/beats/misses → say "ALREADY REPORTED"
   - If people are anticipating → say "UPCOMING"
   Be accurate - today is ${dateStr}.

3. **⚠️ CAUTION FLAGS** - Any stocks where X sentiment has turned negative? Bearish takes, warnings, etc.

4. **💰 PUT SELLING OPPORTUNITIES** - Bullish stocks in the $5-$200 range good for wheel strategy.

5. **🚀 SECTOR MOMENTUM** - What sectors are traders most bullish/bearish on today?

REMEMBER: 
- ⚡ YOUR HOLDINGS ALERT section MUST come FIRST and cover EVERY ticker I listed (TSLL, IREN, CIFR, NBIS, etc.)
- If no direct ticker buzz, check sector keywords (e.g., "Bitcoin mining" for IREN/CIFR)
- Even "no significant chatter" is useful - tell me that explicitly
FORMAT each ticker mention like: **TICKER** @ $XX.XX
Focus on wheel-friendly stocks ($5-$200 range).`;

        // Check if client wants SSE streaming
        const acceptsSSE = req.headers.accept?.includes('text/event-stream');
        
        if (acceptsSSE) {
            // SSE streaming mode with progress updates
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
            res.flushHeaders();
            
            const sendProgress = (step, message, extra = {}) => {
                res.write(`data: ${JSON.stringify({ type: 'progress', step, message, totalSteps: 4, ...extra })}\n\n`);
            };
            
            try {
                // Step 1: Analyzing positions
                sendProgress(1, `Analyzing ${allTickers?.length || 0} positions...`);
                await new Promise(r => setTimeout(r, 300)); // Small delay for UX
                
                // Step 2: Searching X
                sendProgress(2, `Searching X for ${optionsTickers.length} option tickers...`);
                await new Promise(r => setTimeout(r, 300));
                
                // Step 3: Sector trends
                sendProgress(3, uniqueSectorKeywords.length > 0 
                    ? `Checking ${uniqueSectorKeywords.length} sector keywords...` 
                    : 'Checking general market sentiment...');
                
                // Step 4: Generate the actual report (this is the slow part)
                sendProgress(4, 'Generating comprehensive report...');
                
                const result = await AIService.callGrokWithSearch(prompt, {
                    xSearch: true,
                    webSearch: true,
                    maxTokens: 2000,
                    model: 'grok-4'
                });
                
                // Send complete result
                res.write(`data: ${JSON.stringify({ 
                    type: 'complete', 
                    success: true, 
                    sentiment: result.content,
                    citations: result.citations || [],
                    source: 'grok-4-realtime',
                    timestamp: new Date().toISOString()
                })}\n\n`);
                res.end();
                
                console.log(`[AI] ✅ X sentiment retrieved (SSE)`);
            } catch (e) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
                res.end();
                console.log('[AI] ❌ X sentiment SSE error:', e.message);
            }
        } else {
            // Non-SSE mode (legacy/fallback)
            const result = await AIService.callGrokWithSearch(prompt, {
                xSearch: true,
                webSearch: true,
                maxTokens: 2000,
                model: 'grok-4'
            });
            
            res.json({ 
                success: true, 
                sentiment: result.content,
                citations: result.citations || [],
                source: 'grok-4-realtime',
                timestamp: new Date().toISOString()
            });
            console.log(`[AI] ✅ X sentiment retrieved`);
        }
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
        let { ticker, strike, expiry, currentPrice, model, positionType, targetDelta } = data;
        const selectedModel = model || 'qwen2.5:32b';
        
        // Validate expiry format - if malformed, set to null to trigger chain lookup
        const isValidExpiry = expiry && (
            /^\d{4}-\d{2}-\d{2}$/.test(expiry) ||  // ISO: 2026-02-28
            /^[A-Z][a-z]{2}\s+\d{1,2}/.test(expiry)  // Short: Feb 28
        );
        if (expiry && !isValidExpiry) {
            console.log(`[DEEP-DIVE] Invalid expiry "${expiry}", will fetch from chain`);
            expiry = null;
        }
        
        // Determine option type
        const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
        const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
        const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
        
        // If no strike or no valid expiry, fetch real options chain
        let selectedOption = null;
        const needsChainLookup = !strike || !expiry;
        
        if (needsChainLookup) {
            console.log(`[DEEP-DIVE] Fetching real options chain for ${ticker}... (strike=${strike}, expiry=${expiry})`);
            const chain = await MarketDataService.getOptionsChain(ticker, { strikeCount: 40, range: 'ALL' });
            
            console.log(`[DEEP-DIVE] Chain result: ${chain ? `${chain.puts?.length || 0} puts, ${chain.expirations?.length || 0} expirations, source=${chain.source}` : 'null'}`);
            
            if (chain && chain.puts && chain.puts.length > 0) {
                const today = new Date();
                const targetDTE = 30;
                const desiredDelta = targetDelta || 0.20;  // Default to 0.20 delta (conservative)
                
                // Find best expiry (closest to 30 DTE, minimum 21 DTE)
                let bestExpiry = null;
                let bestExpiryDTE = null;
                for (const exp of (chain.expirations || [])) {
                    const expDate = new Date(exp);
                    const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
                    if (dte >= 21) {
                        if (!bestExpiry || Math.abs(dte - targetDTE) < Math.abs(bestExpiryDTE - targetDTE)) {
                            bestExpiry = exp;
                            bestExpiryDTE = dte;
                        }
                    }
                }
                if (!bestExpiry && chain.expirations?.length > 0) {
                    bestExpiry = chain.expirations[0];
                    bestExpiryDTE = Math.ceil((new Date(bestExpiry) - today) / (1000 * 60 * 60 * 24));
                }
                
                console.log(`[DEEP-DIVE] Selected expiry: ${bestExpiry} (${bestExpiryDTE} DTE)`);
                
                // If strike was provided, find that specific option
                // Otherwise, find the option closest to target delta
                if (strike && bestExpiry) {
                    // We have a strike, just need the expiry and premium data
                    const optAtStrike = chain.puts.find(p => 
                        p.expiration === bestExpiry && 
                        p.strike === parseFloat(strike)
                    );
                    if (optAtStrike) {
                        selectedOption = optAtStrike;
                        expiry = bestExpiry;
                        currentPrice = chain.spotPrice || currentPrice;
                        console.log(`[DEEP-DIVE] ✅ Found ${ticker} $${strike}P @ ${expiry} (bid=$${optAtStrike.bid}, ask=$${optAtStrike.ask})`);
                    } else {
                        // Couldn't find exact strike, use the best expiry anyway
                        expiry = bestExpiry;
                        console.log(`[DEEP-DIVE] ⚠️ No exact match for $${strike} at ${bestExpiry}, will try CBOE`);
                    }
                } else {
                    // Filter puts at target expiry with valid delta
                    const putsAtExpiry = chain.puts.filter(p => 
                        p.expiration === bestExpiry && 
                        p.delta !== undefined && 
                        p.delta !== null &&
                        Math.abs(p.delta) > 0.05 && Math.abs(p.delta) < 0.50
                    );
                    
                    // Find closest to target delta (puts have negative delta, so compare absolute)
                    if (putsAtExpiry.length > 0) {
                        putsAtExpiry.sort((a, b) => 
                            Math.abs(Math.abs(a.delta) - desiredDelta) - Math.abs(Math.abs(b.delta) - desiredDelta)
                        );
                        selectedOption = putsAtExpiry[0];
                        strike = selectedOption.strike;
                        expiry = bestExpiry;
                        currentPrice = chain.spotPrice || (await MarketDataService.getQuote(ticker))?.price;
                        
                        console.log(`[DEEP-DIVE] ✅ Found ${ticker} $${strike}P @ ${expiry} (${bestExpiryDTE} DTE, delta=${selectedOption.delta}, bid=$${selectedOption.bid}, ask=$${selectedOption.ask})`);
                    } else {
                        console.log(`[DEEP-DIVE] ⚠️ No puts with valid delta found at ${bestExpiry}`);
                    }
                }
            }
            
            if (!strike) {
                return res.status(400).json({ error: `Could not find suitable options for ${ticker}` });
            }
        }
        
        console.log(`[AI] Deep dive on ${ticker} $${strike} ${optionType.toLowerCase()}, expiry ${expiry}`);
        
        // Fetch extended data + technical analysis (parallel)
        const [tickerData, technicalAnalysis] = await Promise.all([
            DataService.fetchDeepDiveData(ticker),
            TechnicalService ? TechnicalService.analyzeAll(ticker).catch(e => {
                console.log(`[DEEP-DIVE] ⚠️ Technical analysis failed: ${e.message}`);
                return null;
            }) : Promise.resolve(null)
        ]);
        
        // Attach technical data to tickerData for prompt builder
        if (technicalAnalysis) {
            tickerData.technicalAnalysis = technicalAnalysis;
            console.log(`[DEEP-DIVE] 📊 Technical: ${technicalAnalysis.summary}`);
        }
        
        // Use already-fetched option data if we have it, otherwise fetch premium
        let premium = null;
        if (selectedOption) {
            premium = {
                bid: selectedOption.bid,
                ask: selectedOption.ask,
                mid: ((selectedOption.bid || 0) + (selectedOption.ask || 0)) / 2,
                iv: selectedOption.iv,
                delta: selectedOption.delta,
                theta: selectedOption.theta,
                source: 'chain'
            };
            tickerData.premium = premium;
            console.log(`[DEEP-DIVE] Using chain data: bid=$${premium.bid} ask=$${premium.ask} delta=${premium.delta} IV=${premium.iv}%`);
        } else {
            premium = await DataService.fetchOptionPremium(ticker, parseFloat(strike), expiry, optionType);
            if (premium) {
                tickerData.premium = premium;
                console.log(`[CBOE] Found premium: bid=$${premium.bid} ask=$${premium.ask} IV=${premium.iv}%`);
            }
        }
        
        // Update data object with resolved values for prompt builder
        data.strike = strike;
        data.expiry = expiry;
        data.currentPrice = currentPrice;
        
        const prompt = promptBuilders.buildDeepDivePrompt(data, tickerData);
        const response = await AIService.callAI(prompt, selectedModel, 1000);
        
        res.json({ 
            success: true, 
            analysis: response,
            model: selectedModel,
            tickerData,
            premium,
            // Return the actual strike/expiry used (important when auto-selected)
            strike: parseFloat(strike),
            expiry,
            currentPrice
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
        const { ticker, strike, expiry, openingThesis, analysisHistory, userNotes, positionType, monteCarlo, model } = data;
        const selectedModel = model || 'qwen2.5:7b';
        
        // Log prior checkup count for debugging
        if (analysisHistory?.length > 0) {
            console.log(`[AI] Position has ${analysisHistory.length} prior checkup(s)`);
        }
        if (userNotes) {
            console.log(`[AI] User strategy note: "${userNotes.substring(0, 50)}..."`);
        }
        if (monteCarlo) {
            console.log(`[AI] Monte Carlo: ${monteCarlo.probabilities?.profitable} profit probability, ${monteCarlo.probabilities?.maxProfit} max profit`);
        }
        
        // Determine option type
        const callTypes = ['long_call', 'long_call_leaps', 'covered_call', 'leap', 'leaps', 'call', 'call_debit_spread', 'call_credit_spread', 'skip_call'];
        const typeLower = (positionType || '').toLowerCase().replace(/\s+/g, '_');
        const optionType = callTypes.some(s => typeLower.includes(s)) ? 'CALL' : 'PUT';
        
        console.log(`[AI] Position checkup for ${ticker} $${strike} ${optionType.toLowerCase()}`);
        
        // Fetch current market data including real IV
        const [currentData, currentPremium, ivData] = await Promise.all([
            DataService.fetchDeepDiveData(ticker),
            DataService.fetchOptionPremium(ticker, parseFloat(strike), formatExpiryForCBOE(expiry), optionType),
            DataService.fetchTickerIVData(ticker)
        ]);
        
        // Add current IV to market data for prompt
        if (ivData?.atmIV) {
            currentData.currentIV = ivData.atmIV;
            currentData.ivSource = ivData.source;
            console.log(`[AI] Current IV for ${ticker}: ${ivData.atmIV}% (${ivData.source})`);
        }
        
        const prompt = promptBuilders.buildCheckupPrompt(data, openingThesis, currentData, currentPremium, analysisHistory, userNotes, monteCarlo);
        const response = await AIService.callAI(prompt, selectedModel, 2500);  // Increased to 2500 - need room for full analysis + suggested trade block
        
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
// HOLDING CHECKUP - Compare saved strategy to current conditions (unified context)
// This replaces the inline prompt in portfolio.js holdingCheckup()
// =============================================================================

router.post('/holding-checkup', async (req, res) => {
    try {
        const { 
            ticker, 
            strike, 
            expiry, 
            costBasis, 
            shares,
            premium,
            savedStrategy,      // { recommendation, savedAt, fullAnalysis, snapshot }
            chainHistory,       // Array of previous positions in this wheel chain
            model 
        } = req.body;
        
        const selectedModel = model || 'qwen2.5:7b';
        console.log(`[AI] Holding checkup for ${ticker} - comparing to saved ${savedStrategy?.recommendation || 'N/A'} recommendation`);
        
        // Fetch current market data
        let currentPrice = 0;
        try {
            const quote = await MarketDataService.getQuote(ticker);
            currentPrice = quote?.price || 0;
        } catch (e) {
            console.log(`[AI] Quote fetch failed for ${ticker}:`, e.message);
        }
        
        if (!currentPrice) {
            return res.status(400).json({ error: `Could not fetch current price for ${ticker}` });
        }
        
        // Calculate key metrics
        const strikeNum = parseFloat(strike) || 0;
        const costBasisNum = parseFloat(costBasis) || 0;
        const sharesNum = parseInt(shares) || 100;
        const premiumTotal = parseFloat(premium) || 0;
        const dte = expiry ? Math.ceil((new Date(expiry) - new Date()) / (1000 * 60 * 60 * 24)) : 0;
        const isITM = currentPrice > strikeNum;
        const stockGainLoss = (currentPrice - costBasisNum) * sharesNum;
        const ifCalled = ((strikeNum - costBasisNum) * sharesNum) + premiumTotal;
        
        // Extract saved strategy values
        const snapshot = savedStrategy?.snapshot || {};
        const savedStockPrice = snapshot.stockPrice || snapshot.spot || costBasisNum || 0;
        const savedDte = snapshot.dte ?? 'N/A';
        const savedIsITM = snapshot.isITM ?? false;
        const savedRec = savedStrategy?.recommendation || 'HOLD';
        const savedAt = savedStrategy?.savedAt ? new Date(savedStrategy.savedAt).toLocaleDateString() : 'Unknown';
        const priceChange = savedStockPrice > 0 ? ((currentPrice - savedStockPrice) / savedStockPrice * 100).toFixed(1) : 'N/A';
        
        // Build position flow context
        const flowContext = promptBuilders.buildPositionFlowContext({
            stage: promptBuilders.POSITION_STAGES.ACTIVE,
            ticker,
            chainHistory: chainHistory || [],
            aiHistory: savedStrategy ? [{ 
                timestamp: savedStrategy.savedAt, 
                recommendation: savedStrategy.recommendation,
                model: savedStrategy.model 
            }] : [],
            openingThesis: savedStrategy?.snapshot ? {
                analyzedAt: savedStrategy.savedAt,
                priceAtAnalysis: savedStockPrice,
                aiSummary: { bottomLine: savedStrategy.recommendation }
            } : null
        });
        
        // Build the prompt
        const prompt = `${flowContext}You previously analyzed this covered call position. Compare current conditions to your original recommendation.

ORIGINAL ANALYSIS (from ${savedAt}):
- Stock was: $${savedStockPrice.toFixed(2)}
- Recommendation: ${savedRec}
- DTE was: ${savedDte} days
- Was ITM: ${savedIsITM ? 'Yes' : 'No'}

CURRENT CONDITIONS:
- Ticker: ${ticker}
- Stock NOW: $${currentPrice.toFixed(2)} (was $${savedStockPrice.toFixed(2)}, change: ${priceChange}%)
- Strike: $${strikeNum.toFixed(2)}
- Cost Basis: $${costBasisNum.toFixed(2)}
- DTE NOW: ${dte} days (was ${savedDte})
- Currently ITM: ${isITM ? 'Yes' : 'No'}
- Stock P&L: $${stockGainLoss.toFixed(0)}
- Premium Collected: $${premiumTotal.toFixed(0)}
- If Called Profit: $${ifCalled.toFixed(0)}

ORIGINAL FULL ANALYSIS:
${(savedStrategy?.fullAnalysis || savedStrategy?.recommendation || 'No detailed analysis saved').substring(0, 1500)}

Based on how conditions have changed, what should the trader do NOW?

IMPORTANT: Evaluate objectively. If the position is now ITM with high assignment probability, "LET ASSIGN" may be better than rolling again. Consider:
- Is assignment now the most profitable outcome?
- Has the situation changed enough to warrant a different strategy?
- Don't stick with the old plan just because it was the old plan.

End your response with one of these exact phrases:
- "VERDICT: STICK WITH ${savedRec}" (only if old plan is still best)
- "VERDICT: CHANGE TO ROLL" (roll to new strike/expiry)
- "VERDICT: CHANGE TO HOLD" (do nothing, wait)
- "VERDICT: CHANGE TO LET ASSIGN" (let shares get called away)
- "VERDICT: CHANGE TO BUY BACK" (close the call position)`;

        const response = await AIService.callAI(prompt, selectedModel, 1500);
        
        // Parse verdict
        let newRecommendation = savedRec;
        let recommendationChanged = false;
        const verdictMatch = response.match(/VERDICT:\s*(STICK WITH|CHANGE TO)\s*(\w+(?:\s+\w+)?)/i);
        if (verdictMatch) {
            if (verdictMatch[1].toUpperCase() === 'STICK WITH') {
                newRecommendation = savedRec;
            } else {
                const newRec = verdictMatch[2].toUpperCase().trim();
                if (newRec.includes('ROLL')) newRecommendation = 'ROLL';
                else if (newRec.includes('HOLD')) newRecommendation = 'HOLD';
                else if (newRec.includes('ASSIGN')) newRecommendation = 'LET ASSIGN';
                else if (newRec.includes('LET') || newRec.includes('CALL')) newRecommendation = 'LET ASSIGN';
                else if (newRec.includes('BUY')) newRecommendation = 'BUY BACK';
                else newRecommendation = newRec;
                
                recommendationChanged = newRecommendation !== savedRec;
            }
        }
        
        res.json({
            success: true,
            checkup: response,
            model: selectedModel,
            currentPrice,
            savedStockPrice,
            priceChange,
            dte,
            isITM,
            stockGainLoss,
            ifCalled,
            newRecommendation,
            recommendationChanged,
            savedRecommendation: savedRec
        });
        console.log(`[AI] ✅ Holding checkup complete: ${savedRec} → ${newRecommendation}`);
    } catch (e) {
        console.log('[AI] ❌ Holding checkup error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// HOLDING SUGGESTION - AI suggestion for covered call holdings (ACTIVE stage)
// =============================================================================

router.post('/holding-suggestion', async (req, res) => {
    try {
        const { 
            ticker, shares, costBasis, strike, expiry, premium, 
            model, chainHistory, analysisHistory, openingThesis, portfolioContext
        } = req.body;
        
        if (!ticker || !strike) {
            return res.status(400).json({ error: 'Missing required fields: ticker, strike' });
        }
        
        // Ensure model is a string
        const selectedModel = (typeof model === 'string' && model) ? model : 'qwen2.5:32b';
        console.log(`[AI] 📊 Holding suggestion for ${ticker} $${strike} via ${selectedModel}`);
        
        // Fetch current price via MarketDataService
        let currentPrice = 0;
        try {
            const quote = await MarketDataService.getQuote(ticker);
            currentPrice = quote?.price || 0;
            console.log(`[AI] Price for ${ticker}: $${currentPrice} via ${quote?.source || 'unknown'}`);
        } catch (e) {
            console.log('[AI] Price fetch error:', e.message);
        }
        
        if (!currentPrice) {
            return res.status(400).json({ error: `Could not fetch price for ${ticker}` });
        }
        
        // Calculate key metrics
        const dte = expiry ? Math.max(0, Math.round((new Date(expiry) - new Date()) / 86400000)) : 0;
        const shareCount = shares || 100;
        const stockValue = currentPrice * shareCount;
        const stockGainLoss = costBasis > 0 ? (currentPrice - costBasis) * shareCount : 0;
        const isITM = currentPrice > strike;
        const onTable = isITM ? (currentPrice - strike) * shareCount : 0;
        const cushion = !isITM ? (strike - currentPrice) * shareCount : 0;
        const ifCalled = (strike - costBasis) * shareCount + (premium || 0);
        const breakeven = costBasis - ((premium || 0) / shareCount);
        
        // Calculate wheel continuation put strikes
        const wheelPutStrike = Math.floor((strike * 0.95) / 5) * 5;
        const wheelPutStrikeAlt = Math.floor((strike * 0.90) / 5) * 5;
        
        // Build unified context
        const positionFlowContext = promptBuilders.buildPositionFlowContext({
            stage: 'ACTIVE',
            positionType: 'covered_call',
            ticker,
            strike,
            expiry,
            dte,
            currentSpot: currentPrice,
            costBasis,
            premium: premium || 0,
            chainHistory: chainHistory || [],
            analysisHistory: analysisHistory || [],
            openingThesis: openingThesis || null,
            portfolioContext: portfolioContext || null,
            isITM
        });
        
        // Build prompt
        const prompt = `You are a wheel strategy options expert analyzing a COVERED CALL position. This is an ACTIVE position needing actionable advice.

${positionFlowContext}

=== POSITION DETAILS ===
Ticker: ${ticker}
Shares: ${shareCount} @ $${costBasis?.toFixed(2) || 'unknown'} cost basis
Current stock price: $${currentPrice.toFixed(2)}
Covered call: $${strike.toFixed(2)} strike, expires ${expiry} (${dte} DTE)
Premium collected: $${(premium || 0).toFixed(0)} total
Breakeven: $${breakeven.toFixed(2)}

=== CURRENT STATUS ===
Stock P&L: ${stockGainLoss >= 0 ? '+' : ''}$${stockGainLoss.toFixed(0)} (${costBasis > 0 ? ((stockGainLoss / (costBasis * shareCount)) * 100).toFixed(1) : '0'}%)
Option status: ${isITM ? 'IN THE MONEY (ITM)' : 'OUT OF THE MONEY (OTM)'}
${isITM ? `Money on table (above strike): $${onTable.toFixed(0)}` : `Cushion to strike: $${cushion.toFixed(0)} (${((strike - currentPrice) / currentPrice * 100).toFixed(1)}%)`}
If called at expiry: +$${ifCalled.toFixed(0)} total profit

=== YOUR TASK ===
Provide a COMPLETE analysis with these sections:

**SITUATION SUMMARY**
Explain what's happening with this position in 2-3 sentences.

**RECOMMENDATION** 
Choose ONE: HOLD / ROLL UP / ROLL OUT / ROLL UP & OUT / LET IT GET CALLED / WHEEL CONTINUATION / BUY BACK THE CALL
- WHEEL CONTINUATION means: LET IT GET CALLED + immediately SELL A PUT at $${wheelPutStrike} or $${wheelPutStrikeAlt}
Explain WHY your choice is the best action right now.

**SPECIFIC ACTION**
If rolling: Suggest specific new strike and timeframe.
If WHEEL CONTINUATION: Specify the put strike, expiry, and expected premium.

**KEY RISK**
One important risk or thing to watch.

**SUGGESTED TRADE (REQUIRED if recommending ROLL, WHEEL CONTINUATION, or BUY BACK)**
If recommending an action other than HOLD, provide specific trade details:

===SUGGESTED_TRADE===
ACTION: ROLL|WHEEL_CONTINUATION|CLOSE|HOLD
CLOSE_STRIKE: ${strike.toFixed(0)}
CLOSE_EXPIRY: ${expiry}
CLOSE_TYPE: CALL
NEW_STRIKE: [new strike price - for WHEEL_CONTINUATION this is the PUT strike]
NEW_EXPIRY: [new expiry YYYY-MM-DD]
NEW_TYPE: [CALL for rolls, PUT for WHEEL_CONTINUATION]
ESTIMATED_DEBIT: [cost to buy back current call, or N/A for LET ASSIGN]
ESTIMATED_CREDIT: [credit from selling new option]
NET_COST: [net result, e.g. "-$10.00 debit" or "+$2.00 credit"]
RATIONALE: [One sentence explaining why]
===END_TRADE===

Be specific with dollar amounts. Reference any previous AI recommendations if they exist.`;

        // Call AI
        let response;
        const isGrok = selectedModel.toLowerCase().includes('grok');
        
        if (isGrok) {
            response = await AIService.callGrok(prompt, 'grok-4-1-fast', 1200);
        } else {
            response = await AIService.callAI(prompt, selectedModel, 1200);
        }
        
        // Parse suggested trade
        let suggestedTrade = null;
        const tradeMatch = response.match(/===SUGGESTED_TRADE===([\s\S]*?)===END_TRADE===/);
        if (tradeMatch) {
            const tradeBlock = tradeMatch[1];
            suggestedTrade = {
                action: tradeBlock.match(/ACTION:\s*(\S+)/)?.[1] || 'HOLD',
                closeStrike: parseFloat(tradeBlock.match(/CLOSE_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                closeExpiry: tradeBlock.match(/CLOSE_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                closeType: tradeBlock.match(/CLOSE_TYPE:\s*(\S+)/)?.[1] || null,
                newStrike: parseFloat(tradeBlock.match(/NEW_STRIKE:\s*(\d+(?:\.\d+)?)/)?.[1]) || null,
                newExpiry: tradeBlock.match(/NEW_EXPIRY:\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null,
                newType: tradeBlock.match(/NEW_TYPE:\s*(\S+)/)?.[1] || null,
                estimatedDebit: tradeBlock.match(/ESTIMATED_DEBIT:\s*(.+)/)?.[1]?.trim() || null,
                estimatedCredit: tradeBlock.match(/ESTIMATED_CREDIT:\s*(.+)/)?.[1]?.trim() || null,
                netCost: tradeBlock.match(/NET_COST:\s*(.+)/)?.[1]?.trim() || null,
                rationale: tradeBlock.match(/RATIONALE:\s*(.+)/)?.[1]?.trim() || null
            };
            console.log('[AI] Parsed suggested trade:', suggestedTrade.action);
        }
        
        // Parse recommendation from response
        let newRecommendation = 'HOLD';
        const responseUpper = response.toUpperCase();
        if (responseUpper.includes('WHEEL CONTINUATION')) {
            newRecommendation = 'WHEEL_CONTINUATION';
        } else if (responseUpper.includes('ROLL UP & OUT') || responseUpper.includes('ROLL UP AND OUT')) {
            newRecommendation = 'ROLL_UP_OUT';
        } else if (responseUpper.includes('ROLL UP')) {
            newRecommendation = 'ROLL_UP';
        } else if (responseUpper.includes('ROLL OUT')) {
            newRecommendation = 'ROLL_OUT';
        } else if (responseUpper.includes('LET IT GET CALLED') || responseUpper.includes('LET ASSIGN')) {
            newRecommendation = 'LET_ASSIGN';
        } else if (responseUpper.includes('BUY BACK')) {
            newRecommendation = 'BUY_BACK';
        }
        
        res.json({
            success: true,
            analysis: response,
            model: selectedModel,
            currentPrice,
            costBasis,
            strike,
            dte,
            isITM,
            stockGainLoss,
            onTable,
            cushion,
            ifCalled,
            breakeven,
            wheelPutStrike,
            wheelPutStrikeAlt,
            suggestedTrade,
            newRecommendation
        });
        console.log(`[AI] ✅ Holding suggestion complete: ${newRecommendation}`);
    } catch (e) {
        console.log('[AI] ❌ Holding suggestion error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// SPREAD ADVISOR - AI advice for spread positions (ACTIVE stage)
// =============================================================================

router.post('/spread-advisor', async (req, res) => {
    try {
        const { 
            ticker, positionType, sellStrike, buyStrike, contracts, entryPremium,
            expiry, model, chainHistory, analysisHistory, openingThesis, portfolioContext
        } = req.body;
        
        if (!ticker || !sellStrike || !buyStrike) {
            return res.status(400).json({ error: 'Missing required fields: ticker, sellStrike, buyStrike' });
        }
        
        // Ensure model is a string
        const selectedModel = (typeof model === 'string' && model) ? model : 'qwen2.5:14b';
        console.log(`[AI] 📊 Spread advisor for ${ticker} $${sellStrike}/$${buyStrike} via ${selectedModel}`);
        
        // Fetch current price via MarketDataService
        let spotPrice = 0;
        try {
            const quote = await MarketDataService.getQuote(ticker);
            spotPrice = quote?.price || 0;
            console.log(`[AI] Price for ${ticker}: $${spotPrice} via ${quote?.source || 'unknown'}`);
        } catch (e) {
            console.log('[AI] Price fetch error:', e.message);
        }
        
        // Parse position type
        const isPut = positionType?.includes('put');
        const isCredit = positionType?.includes('credit');
        
        // Calculate metrics
        const dte = expiry ? Math.max(0, Math.round((new Date(expiry) - new Date()) / 86400000)) : 0;
        const spreadWidth = Math.abs(sellStrike - buyStrike);
        const entry = entryPremium || 0;
        const maxProfit = isCredit ? entry * 100 * (contracts || 1) : (spreadWidth - entry) * 100 * (contracts || 1);
        const maxLoss = isCredit ? (spreadWidth - entry) * 100 * (contracts || 1) : entry * 100 * (contracts || 1);
        
        // Determine ITM status
        let isITM = false;
        if (spotPrice > 0) {
            if (isPut && isCredit) {
                isITM = spotPrice < sellStrike;
            } else if (!isPut && isCredit) {
                isITM = spotPrice > sellStrike;
            } else if (isPut && !isCredit) {
                isITM = spotPrice < buyStrike;
            } else {
                isITM = spotPrice > buyStrike;
            }
        }
        const itmStatus = spotPrice > 0 ? (isITM ? 'ITM (in trouble)' : 'OTM (safe zone)') : 'unknown';
        
        // Build unified context (simpler for spreads)
        const positionFlowContext = promptBuilders.buildPositionFlowContext({
            stage: 'ACTIVE',
            positionType: positionType || 'spread',
            ticker,
            strike: sellStrike,
            expiry,
            dte,
            currentSpot: spotPrice,
            chainHistory: chainHistory || [],
            analysisHistory: analysisHistory || [],
            openingThesis: openingThesis || null,
            portfolioContext: portfolioContext || null,
            isITM
        });
        
        // Build concise prompt
        const prompt = `You are a concise options trading advisor. Analyze this spread position and give a SHORT recommendation (3-4 sentences MAX).

${positionFlowContext}

POSITION:
- ${ticker} ${isPut ? 'PUT' : 'CALL'} ${isCredit ? 'CREDIT' : 'DEBIT'} SPREAD
- Short strike: $${sellStrike}, Long strike: $${buyStrike}
- Contracts: ${contracts || 1}
- Entry premium: $${entry.toFixed(2)} ${isCredit ? 'credit received' : 'debit paid'}
- Stock price: ${spotPrice > 0 ? '$' + spotPrice.toFixed(2) : 'not available'}
- Status: ${itmStatus}
- DTE: ${dte} days
- Max Profit potential: $${maxProfit.toFixed(0)}
- Max Loss risk: $${maxLoss.toFixed(0)}

RULES TO FOLLOW:
- If >50% of max profit realized: Consider CLOSE to lock in gains
- If DTE < 7 and profitable: CLOSE to avoid gamma risk
- If ITM and losing: Consider CLOSE to limit loss
- Credit spreads profit when stock stays ${isPut ? 'ABOVE' : 'BELOW'} short strike ($${sellStrike})

Give ONE clear verdict: HOLD, CLOSE, or CLOSE EARLY. Explain in 2-3 sentences why.`;

        // Call AI
        const response = await AIService.callAI(prompt, selectedModel, 300);
        
        // Parse recommendation
        let recommendation = 'HOLD';
        const responseUpper = response.toUpperCase();
        if (responseUpper.includes('CLOSE EARLY') || responseUpper.includes('CLOSE NOW')) {
            recommendation = 'CLOSE_EARLY';
        } else if (responseUpper.includes('CLOSE')) {
            recommendation = 'CLOSE';
        }
        
        res.json({
            success: true,
            insight: response,
            model: selectedModel,
            spotPrice,
            dte,
            isITM,
            maxProfit,
            maxLoss,
            recommendation
        });
        console.log(`[AI] ✅ Spread advisor complete: ${recommendation}`);
    } catch (e) {
        console.log('[AI] ❌ Spread advisor error:', e.message);
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
        
        // Fix expiry if it's in the past (AI might have parsed wrong year)
        if (parsed.expiry) {
            const parsedExpiry = new Date(parsed.expiry);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (parsedExpiry < today) {
                // Expiry is in the past - this is likely a parsing error
                // Try to fix by using current or next year
                const originalYear = parsedExpiry.getFullYear();
                const currentYear = today.getFullYear();
                
                // Try current year first
                let fixedExpiry = new Date(parsedExpiry);
                fixedExpiry.setFullYear(currentYear);
                
                // If still in the past, try next year
                if (fixedExpiry < today) {
                    fixedExpiry.setFullYear(currentYear + 1);
                }
                
                const fixedDateStr = fixedExpiry.toISOString().split('T')[0];
                console.log(`[AI] ⚠️ Fixed expired date: ${parsed.expiry} → ${fixedDateStr}`);
                parsed.expiry = fixedDateStr;
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
// PORTFOLIO AUDIT (with Diversification Recommendations)
// =============================================================================

router.post('/portfolio-audit', async (req, res) => {
    try {
        const data = req.body;
        const selectedModel = data.model || 'qwen2.5:14b';
        const buyingPower = data.buyingPower || 25000; // Default if not provided
        const includeDiversification = data.includeDiversification !== false; // Default true
        
        console.log('[AI] Portfolio audit with model:', selectedModel, '| Diversification:', includeDiversification);
        
        const positions = data.positions || [];
        const greeks = data.greeks || {};
        const closedStats = data.closedStats || {};
        
        // =====================================================================
        // FETCH LIVE SPOT PRICES for all unique tickers
        // This is CRITICAL for accurate risk assessment!
        // =====================================================================
        const uniqueTickers = [...new Set(positions.map(p => p.ticker))];
        const spotPrices = {};
        
        console.log('[AI] Fetching spot prices for:', uniqueTickers.join(', '));
        
        for (const ticker of uniqueTickers) {
            try {
                const quote = await MarketDataService.getQuote(ticker);
                if (quote && quote.price) {
                    spotPrices[ticker] = quote.price;
                    console.log(`[AI] ${ticker}: $${quote.price.toFixed(2)}`);
                }
            } catch (e) {
                console.log(`[AI] Failed to get spot for ${ticker}:`, e.message);
            }
        }
        
        // Build position summary WITH live spot prices
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
            
            // ========================================================
            // CRITICAL: Add spot price and distance from strike!
            // Without this, AI can't assess actual risk level.
            // Use fetched spotPrices (live) or fall back to p.currentSpot
            // ========================================================
            let spotInfo = '';
            const spot = spotPrices[p.ticker] || p.currentSpot;
            const strike = isSpread ? p.sellStrike : p.strike;  // Use sell strike for spreads
            
            if (spot && strike) {
                const isPut = p.type?.includes('put');
                const isCall = p.type?.includes('call');
                
                // Calculate distance from strike
                const distance = Math.abs(spot - strike);
                const distancePct = ((distance / strike) * 100).toFixed(1);
                
                // Determine if OTM or ITM
                let moneyness;
                if (isPut) {
                    // Put is OTM when spot > strike, ITM when spot < strike
                    moneyness = spot > strike ? 'OTM' : (spot < strike ? 'ITM' : 'ATM');
                } else if (isCall) {
                    // Call is OTM when spot < strike, ITM when spot > strike
                    moneyness = spot < strike ? 'OTM' : (spot > strike ? 'ITM' : 'ATM');
                } else {
                    moneyness = '';
                }
                
                spotInfo = ` | Spot: $${spot.toFixed(2)} ($${distance.toFixed(2)} ${moneyness}, ${distancePct}% buffer)`;
            }
            
            // Add P/L info if available
            let pnlInfo = '';
            if (p.unrealizedPnL !== null && p.unrealizedPnL !== undefined) {
                const pnlSign = p.unrealizedPnL >= 0 ? '+' : '';
                const pnlPctSign = p.unrealizedPnLPct >= 0 ? '+' : '';
                const status = p.unrealizedPnLPct >= 50 ? '✓WINNING' : 
                               p.unrealizedPnLPct >= 0 ? 'profitable' : 
                               p.unrealizedPnLPct >= -25 ? 'underwater' : '⚠LOSING';
                pnlInfo = ` | P/L: ${pnlSign}$${p.unrealizedPnL.toFixed(0)} (${pnlPctSign}${p.unrealizedPnLPct.toFixed(0)}%) ${status}`;
            }
            
            // Add current option price if available
            let optPriceInfo = '';
            if (p.lastOptionPrice !== null && p.lastOptionPrice !== undefined) {
                optPriceInfo = ` | OptPrice: $${p.lastOptionPrice.toFixed(2)}`;
            }
            
            return `${p.ticker}: ${p.type} ${strikeDisplay} (${p.dte}d DTE) ${typeNote}${spreadInfo}${spotInfo}${pnlInfo}${optPriceInfo} - ${riskPct.toFixed(0)}% ITM`;
        }).join('\n');
        
        // Concentration analysis - by ticker
        const tickerCounts = {};
        positions.forEach(p => { tickerCounts[p.ticker] = (tickerCounts[p.ticker] || 0) + 1; });
        const concentrations = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}: ${c}`);
        
        // =====================================================================
        // SECTOR ANALYSIS - Map current holdings to sectors
        // =====================================================================
        const SECTOR_MAP = {
            // Tech
            AAPL: 'Tech', MSFT: 'Tech', GOOGL: 'Tech', GOOG: 'Tech', META: 'Tech', NVDA: 'Tech',
            AMD: 'Tech', INTC: 'Tech', PLTR: 'Tech', CRWD: 'Tech', SNOW: 'Tech', NET: 'Tech',
            DDOG: 'Tech', MU: 'Tech', UBER: 'Tech', SHOP: 'Tech', AVGO: 'Tech', TSM: 'Tech',
            ORCL: 'Tech', CRM: 'Tech', NOW: 'Tech', ADBE: 'Tech', CSCO: 'Tech', AMAT: 'Tech',
            QCOM: 'Tech', TXN: 'Tech', LRCX: 'Tech', KLAC: 'Tech', SMCI: 'Tech', DELL: 'Tech',
            // Finance
            BAC: 'Finance', C: 'Finance', JPM: 'Finance', GS: 'Finance', SOFI: 'Finance',
            COIN: 'Finance', SCHW: 'Finance', V: 'Finance', MA: 'Finance', AXP: 'Finance',
            WFC: 'Finance', MS: 'Finance', BLK: 'Finance', COF: 'Finance',
            // Energy
            XOM: 'Energy', OXY: 'Energy', CVX: 'Energy', DVN: 'Energy', HAL: 'Energy',
            SLB: 'Energy', COP: 'Energy', EOG: 'Energy', MPC: 'Energy', VLO: 'Energy',
            // Consumer
            KO: 'Consumer', F: 'Consumer', GM: 'Consumer', NKE: 'Consumer', SBUX: 'Consumer',
            DIS: 'Consumer', TGT: 'Consumer', WMT: 'Consumer', COST: 'Consumer', HD: 'Consumer',
            LOW: 'Consumer', MCD: 'Consumer', AMZN: 'Consumer', ABNB: 'Consumer',
            // Healthcare
            PFE: 'Healthcare', ABBV: 'Healthcare', JNJ: 'Healthcare', MRK: 'Healthcare',
            MRNA: 'Healthcare', UNH: 'Healthcare', LLY: 'Healthcare', BMY: 'Healthcare',
            GILD: 'Healthcare', AMGN: 'Healthcare', CVS: 'Healthcare',
            // ETFs
            SPY: 'ETF', QQQ: 'ETF', IWM: 'ETF', SLV: 'ETF', GLD: 'ETF', XLF: 'ETF',
            DIA: 'ETF', XLE: 'ETF', XLK: 'ETF', XLV: 'ETF', ARKK: 'ETF',
            // High IV / Speculative
            MSTR: 'High IV', HOOD: 'High IV', RIVN: 'High IV', LCID: 'High IV',
            NIO: 'High IV', TSLA: 'High IV', GME: 'High IV', AMC: 'High IV',
            MARA: 'High IV', RIOT: 'High IV', RBLX: 'High IV', SNAP: 'High IV'
        };
        
        // Calculate current sector exposure
        const sectorCounts = {};
        positions.forEach(p => {
            const sector = SECTOR_MAP[p.ticker] || 'Other';
            sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
        });
        
        const currentSectors = Object.keys(sectorCounts);
        const sectorExposure = Object.entries(sectorCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([s, c]) => `${s}: ${c} positions (${(c / positions.length * 100).toFixed(0)}%)`)
            .join('\n');
        
        // Build the main audit prompt - LEAN VERSION: Trust the AI to think
        const prompt = `Analyze this options portfolio. I run a wheel strategy (selling puts, covered calls).

HOW I WIN: For short puts/calls, I just need the stock to be $0.01 past the strike at expiry. That's it.
- Short put at $82 strike, stock at $89 = I'm WINNING (stock is above strike)
- Short call at $50 strike, stock at $45 = I'm WINNING (stock is below strike)
- Mark-to-market P/L can be negative due to IV changes, but if I'm OTM with buffer, I'm on track to win.

## MY POSITIONS (${positions.length} total)
${positionSummary || 'No open positions'}

## GREEKS
Net Delta: ${greeks.delta?.toFixed(0) || 0} | Daily Theta: $${greeks.theta?.toFixed(2) || 0} | Vega: $${greeks.vega?.toFixed(0) || 0}

## SECTOR EXPOSURE
${sectorExposure || 'None'}

## CONCENTRATION
${concentrations.join('\n') || 'None'}

## HISTORICAL
Win Rate: ${closedStats.winRate?.toFixed(1) || '?'}% | Profit Factor: ${closedStats.profitFactor?.toFixed(2) || '?'}

---

For any position you think might be problematic, run a quick Monte Carlo in your head:
- Given current spot, strike, DTE, and typical volatility for this stock
- What's the probability it expires OTM (I win) vs ITM (I lose)?
- If >65% chance of winning, it's probably fine to hold.

Provide:
## 📊 PORTFOLIO GRADE: [A/B/C/D/F]
Why?

## 🚨 PROBLEM POSITIONS
Any positions actually in trouble? For each, estimate win probability and explain your concern.

## ⚠️ RISKS
Concentration, Greeks, or structural issues?

## 💡 RECOMMENDATIONS  
What would YOU do? Be specific.

## ✅ WHAT'S WORKING
What's positioned well?

Be direct. I want your honest analysis.`;

        const auditResponse = await AIService.callAI(prompt, selectedModel, 1200);
        
        // =====================================================================
        // PHASE 2: DIVERSIFICATION RECOMMENDATIONS
        // =====================================================================
        let diversificationSection = '';
        let diversificationCandidates = [];
        
        if (includeDiversification && positions.length > 0) {
            console.log('[AI] Fetching diversification candidates...');
            
            // Get curated candidates from DiscoveryService
            const { CURATED_CANDIDATES } = DiscoveryService;
            
            // Find sectors we DON'T have exposure to
            const allSectors = [...new Set(CURATED_CANDIDATES.map(c => c.sector))];
            const missingSectors = allSectors.filter(s => !currentSectors.includes(s) && s !== 'High IV');
            
            // Also find underweight sectors (only 1 position)
            const underweightSectors = Object.entries(sectorCounts)
                .filter(([s, c]) => c === 1 && s !== 'High IV' && s !== 'Other')
                .map(([s]) => s);
            
            console.log('[AI] Missing sectors:', missingSectors.join(', ') || 'None');
            console.log('[AI] Underweight sectors:', underweightSectors.join(', ') || 'None');
            
            // Get candidates from missing/underweight sectors
            const existingTickers = new Set(positions.map(p => p.ticker));
            const candidatesForDiversification = CURATED_CANDIDATES
                .filter(c => !existingTickers.has(c.ticker)) // Not already owned
                .filter(c => missingSectors.includes(c.sector) || underweightSectors.includes(c.sector));
            
            // Take up to 6 candidates across different sectors
            const selectedCandidates = [];
            const usedSectors = new Set();
            for (const c of candidatesForDiversification) {
                if (!usedSectors.has(c.sector) && selectedCandidates.length < 6) {
                    selectedCandidates.push(c);
                    usedSectors.add(c.sector);
                }
            }
            
            console.log('[AI] Selected', selectedCandidates.length, 'diversification candidates');
            
            // Fetch live pricing for candidates
            if (selectedCandidates.length > 0) {
                const maxStrike = buyingPower / 100;
                const candidateData = [];
                
                for (const candidate of selectedCandidates) {
                    try {
                        // Fetch stock price and option chain via MarketDataService
                        const quote = await MarketDataService.getQuote(candidate.ticker);
                        if (!quote || quote.price > maxStrike) continue;
                        
                        // Get options chain with more strikes
                        const chain = await MarketDataService.getOptionsChain(candidate.ticker, { strikeCount: 20 });
                        
                        console.log(`[AI] ${candidate.ticker}: quote source=${quote.source}, chain source=${chain?.source || 'none'}, puts=${chain?.puts?.length || 0}`);
                        
                        // Find ~30-45 DTE expiration
                        const targetDte = 35;
                        let bestExpiry = null;
                        let bestDteDiff = Infinity;
                        let actualDte = targetDte;
                        
                        if (chain?.expirations) {
                            for (const exp of chain.expirations) {
                                const expDate = new Date(exp);
                                const dte = Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24));
                                if (dte >= 25 && dte <= 50 && Math.abs(dte - targetDte) < bestDteDiff) {
                                    bestDteDiff = Math.abs(dte - targetDte);
                                    bestExpiry = exp;
                                    actualDte = dte;
                                }
                            }
                        }
                        
                        // =====================================================
                        // FIND A PUT WITH MEANINGFUL PREMIUM (~25-35 delta)
                        // Target: 3-7% OTM with premium that gives 15%+ annualized
                        // =====================================================
                        let suggestedStrike = null;
                        let putPremium = null;
                        let putDelta = null;
                        
                        if (chain?.puts && chain.puts.length > 0) {
                            // Sort puts by strike descending (highest first = closest to ATM)
                            const sortedPuts = [...chain.puts]
                                .filter(p => p.strike < quote.price) // Only OTM puts
                                .sort((a, b) => b.strike - a.strike);
                            
                            // Strategy: Find best put by these criteria:
                            // 1. Has delta between 0.20-0.40 (if delta available)
                            // 2. Has premium >= $0.50 (minimum to be worth trading)
                            // 3. Gives annualized yield >= 12%
                            
                            const minPremium = 0.50;
                            const minAnnualizedYield = 0.12; // 12%
                            
                            let bestPut = null;
                            let bestScore = -1;
                            
                            for (const put of sortedPuts) {
                                const premium = put.mid || ((put.bid || 0) + (put.ask || 0)) / 2;
                                if (premium < minPremium) continue;
                                
                                const annYield = (premium / put.strike) * (365 / actualDte);
                                if (annYield < minAnnualizedYield) continue;
                                
                                // Calculate cushion (how far OTM)
                                const cushion = ((quote.price - put.strike) / quote.price) * 100;
                                if (cushion < 2 || cushion > 15) continue; // 2-15% OTM
                                
                                // Score: prefer higher yield but with reasonable cushion
                                // Delta ~0.25-0.30 is ideal, cushion 4-8% is sweet spot
                                const deltaScore = put.delta ? (1 - Math.abs(Math.abs(put.delta) - 0.28) * 3) : 0.5;
                                const cushionScore = 1 - Math.abs(cushion - 6) / 10;
                                const yieldScore = Math.min(annYield / 0.30, 1); // Cap at 30% yield
                                
                                const score = (deltaScore * 0.3) + (cushionScore * 0.3) + (yieldScore * 0.4);
                                
                                if (score > bestScore) {
                                    bestScore = score;
                                    bestPut = put;
                                }
                            }
                            
                            // Fallback: if no put meets criteria, find the one with highest premium that's OTM
                            if (!bestPut && sortedPuts.length > 0) {
                                bestPut = sortedPuts.find(p => {
                                    const prem = p.mid || ((p.bid || 0) + (p.ask || 0)) / 2;
                                    return prem >= 0.30; // Lower threshold for fallback
                                });
                            }
                            
                            if (bestPut) {
                                suggestedStrike = bestPut.strike;
                                putPremium = bestPut.mid || ((bestPut.bid || 0) + (bestPut.ask || 0)) / 2;
                                putDelta = bestPut.delta ? Math.abs(bestPut.delta) : null;
                                console.log(`[AI] ${candidate.ticker} best put: $${suggestedStrike} bid=$${bestPut.bid?.toFixed(2)} ask=$${bestPut.ask?.toFixed(2)} mid=$${putPremium?.toFixed(2)} delta=${putDelta?.toFixed(2)}`);
                            }
                        }
                        
                        // Skip if we couldn't find a decent put
                        if (!suggestedStrike || !putPremium || putPremium < 0.30) {
                            console.log(`[AI] Skipping ${candidate.ticker} - no put with meaningful premium`);
                            continue;
                        }
                        
                        const cushionPct = ((quote.price - suggestedStrike) / quote.price * 100).toFixed(1);
                        const annualizedYield = ((putPremium / suggestedStrike) * (365 / actualDte) * 100).toFixed(1);
                        
                        candidateData.push({
                            ticker: candidate.ticker,
                            sector: candidate.sector,
                            price: quote.price,
                            rangePosition: quote.rangePosition || 50,
                            suggestedStrike,
                            expiry: bestExpiry,
                            dte: actualDte,
                            putPremium,
                            putDelta,
                            cushionPct,
                            annualizedYield,
                            collateral: suggestedStrike * 100,
                            reason: missingSectors.includes(candidate.sector) ? 'New sector' : 'Add to sector'
                        });
                    } catch (e) {
                        console.log(`[AI] Failed to fetch data for ${candidate.ticker}:`, e.message);
                    }
                }
                
                // Filter to only include trades with 12%+ annualized yield
                diversificationCandidates = candidateData.filter(c => parseFloat(c.annualizedYield) >= 12);
                
                // Build diversification text section
                if (diversificationCandidates.length > 0) {
                    diversificationSection = `\n\n## 🎯 DIVERSIFICATION OPPORTUNITIES\n\nBased on your current sector exposure, here are wheel-worthy candidates from sectors you're missing or underweight:\n\n`;
                    
                    for (const c of diversificationCandidates) {
                        const rangeNote = c.rangePosition < 30 ? '🟢 Near lows' : 
                                         c.rangePosition > 70 ? '🔴 Near highs' : '🟡 Mid-range';
                        
                        diversificationSection += `### ${c.ticker} (${c.sector}) - ${c.reason}\n`;
                        diversificationSection += `- **Current Price**: $${c.price.toFixed(2)} (${rangeNote})\n`;
                        
                        if (c.putPremium && c.expiry) {
                            const deltaStr = c.putDelta ? ` | Δ ${(c.putDelta * 100).toFixed(0)}` : '';
                            diversificationSection += `- **Suggested Trade**: Sell **$${c.suggestedStrike} PUT** exp ${c.expiry} (${c.dte}d)\n`;
                            diversificationSection += `- **Premium**: ~$${c.putPremium.toFixed(2)} | **${c.annualizedYield}% ann. yield** | ${c.cushionPct}% cushion${deltaStr}\n`;
                            diversificationSection += `- **Collateral**: $${c.collateral.toLocaleString()}\n`;
                        } else {
                            diversificationSection += `- Check option chain for current premiums\n`;
                        }
                        diversificationSection += `\n`;
                    }
                    
                    diversificationSection += `\n*Criteria: 12%+ annualized yield, 2-15% cushion, $0.50+ premium. Verify earnings before trading.*`;
                }
            }
        }
        
        // Combine audit + diversification
        const fullResponse = auditResponse + diversificationSection;
        
        res.json({ 
            success: true, 
            audit: fullResponse, 
            model: selectedModel,
            diversificationCandidates,  // Structured data for frontend
            sectorExposure: sectorCounts
        });
        console.log('[AI] ✅ Portfolio audit complete (with', diversificationCandidates.length, 'diversification ideas)');
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

// ═══════════════════════════════════════════════════════════════════════════
// PORTFOLIO FIT ANALYZER
// ═══════════════════════════════════════════════════════════════════════════
router.post('/portfolio-fit', async (req, res) => {
    try {
        const { 
            openPositions = [], 
            closedPositions = [],
            pendingTrades = [], 
            accountBalances = {},
            model 
        } = req.body;
        
        console.log('[PORTFOLIO-FIT] Analyzing', pendingTrades.length, 'candidates against', openPositions.length, 'open positions');
        
        if (pendingTrades.length === 0) {
            return res.status(400).json({ error: 'No pending trades to analyze' });
        }
        
        // Build historical patterns for each candidate ticker
        const tickerPatterns = {};
        const candidateTickers = [...new Set(pendingTrades.map(p => p.ticker))];
        
        candidateTickers.forEach(ticker => {
            const tickerTrades = closedPositions.filter(p => p.ticker === ticker);
            if (tickerTrades.length > 0) {
                const wins = tickerTrades.filter(p => (p.realizedPnL || p.closePnL || 0) > 0).length;
                const netPnL = tickerTrades.reduce((sum, p) => sum + (p.realizedPnL || p.closePnL || 0), 0);
                tickerPatterns[ticker] = {
                    trades: tickerTrades.length,
                    winRate: Math.round((wins / tickerTrades.length) * 100),
                    netPnL: Math.round(netPnL)
                };
            }
        });
        
        // Build the prompt
        const prompt = promptBuilders.buildPortfolioFitPrompt({
            openPositions,
            closedPositions,
            pendingTrades,
            accountBalances,
            tickerPatterns
        });
        
        // Determine model
        const selectedModel = model || 'qwen2.5:32b';
        const isGrok = selectedModel.startsWith('grok');
        const tokenLimit = isGrok ? 1500 : 2000;
        
        console.log('[PORTFOLIO-FIT] Using model:', selectedModel);
        
        let analysis;
        if (isGrok) {
            analysis = await AIService.callGrok(prompt, selectedModel, tokenLimit);
        } else {
            analysis = await AIService.callAI(prompt, selectedModel, tokenLimit);
        }
        
        res.json({
            success: true,
            analysis,
            model: selectedModel,
            candidateCount: pendingTrades.length,
            openPositionCount: openPositions.length
        });
        
        console.log('[PORTFOLIO-FIT] ✅ Analysis complete');
        
    } catch (e) {
        console.error('[PORTFOLIO-FIT] ❌ Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
module.exports.init = init;
