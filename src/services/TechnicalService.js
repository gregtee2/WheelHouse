/**
 * TechnicalService - Algorithmic technical analysis
 * Swing low detection, trendline calculation, support projection
 */

class TechnicalService {
    
    /**
     * Fetch historical OHLC data from Yahoo Finance
     * @param {string} ticker 
     * @param {number} years - How many years of data to fetch
     * @returns {Array<{date, open, high, low, close}>}
     */
    static async fetchOHLC(ticker, years = 2) {
        try {
            const endDate = Math.floor(Date.now() / 1000);
            const startDate = endDate - (years * 365 * 24 * 60 * 60);
            
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${startDate}&period2=${endDate}&interval=1d`;
            const response = await fetch(url);
            
            if (!response.ok) {
                console.log(`[TECHNICAL] Failed to fetch OHLC for ${ticker}`);
                return null;
            }
            
            const data = await response.json();
            const result = data.chart?.result?.[0];
            
            if (!result || !result.timestamp) {
                return null;
            }
            
            const timestamps = result.timestamp;
            const quotes = result.indicators?.quote?.[0];
            
            if (!quotes) return null;
            
            const ohlc = [];
            for (let i = 0; i < timestamps.length; i++) {
                if (quotes.low[i] && quotes.high[i] && quotes.close[i]) {
                    ohlc.push({
                        date: new Date(timestamps[i] * 1000),
                        open: quotes.open[i],
                        high: quotes.high[i],
                        low: quotes.low[i],
                        close: quotes.close[i]
                    });
                }
            }
            
            console.log(`[TECHNICAL] Fetched ${ohlc.length} days of OHLC for ${ticker}`);
            return ohlc;
            
        } catch (e) {
            console.log(`[TECHNICAL] Error fetching OHLC: ${e.message}`);
            return null;
        }
    }
    
    /**
     * Find swing lows in price data
     * A swing low is a low that is lower than N bars on each side
     * @param {Array} ohlc - OHLC data
     * @param {number} lookback - Bars to look on each side (default 10 = ~2 weeks)
     * @returns {Array<{index, date, price}>}
     */
    static findSwingLows(ohlc, lookback = 10) {
        const swingLows = [];
        
        for (let i = lookback; i < ohlc.length - lookback; i++) {
            const currentLow = ohlc[i].low;
            let isSwingLow = true;
            
            // Check if this low is lower than all bars on each side
            for (let j = 1; j <= lookback; j++) {
                if (ohlc[i - j].low < currentLow || ohlc[i + j].low < currentLow) {
                    isSwingLow = false;
                    break;
                }
            }
            
            if (isSwingLow) {
                swingLows.push({
                    index: i,
                    date: ohlc[i].date,
                    price: currentLow
                });
            }
        }
        
        // Filter out swing lows that are too close together (keep lower one)
        const filtered = [];
        for (let i = 0; i < swingLows.length; i++) {
            const current = swingLows[i];
            const next = swingLows[i + 1];
            
            // If next swing low is within 20 bars, keep the lower one
            if (next && (next.index - current.index) < 20) {
                if (current.price <= next.price) {
                    filtered.push(current);
                }
                // Skip next in loop
                i++;
            } else {
                filtered.push(current);
            }
        }
        
        return filtered;
    }
    
    /**
     * Linear regression on swing lows to calculate trendline
     * @param {Array<{index, price}>} swingLows
     * @returns {{slope, intercept, r2}} - Trendline equation y = slope*x + intercept
     */
    static calculateTrendline(swingLows) {
        if (swingLows.length < 2) {
            return null;
        }
        
        const n = swingLows.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
        
        for (const point of swingLows) {
            sumX += point.index;
            sumY += point.price;
            sumXY += point.index * point.price;
            sumX2 += point.index * point.index;
            sumY2 += point.price * point.price;
        }
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        
        // Calculate R² (how well the line fits)
        const yMean = sumY / n;
        let ssTot = 0, ssRes = 0;
        for (const point of swingLows) {
            const predicted = slope * point.index + intercept;
            ssTot += (point.price - yMean) ** 2;
            ssRes += (point.price - predicted) ** 2;
        }
        const r2 = 1 - (ssRes / ssTot);
        
        return { slope, intercept, r2 };
    }
    
    /**
     * Analyze support trendlines at multiple timeframes
     * @param {string} ticker
     * @returns {Object} - Trendline analysis with projected support
     */
    static async analyzeTrendlines(ticker) {
        console.log(`[TECHNICAL] Analyzing trendlines for ${ticker}...`);
        
        // Fetch 2 years of data
        const ohlc = await this.fetchOHLC(ticker, 2);
        if (!ohlc || ohlc.length < 60) {
            return { error: 'Insufficient price data' };
        }
        
        const currentPrice = ohlc[ohlc.length - 1].close;
        const currentIndex = ohlc.length - 1;
        
        // Analyze multiple timeframes
        const timeframes = [
            { name: '3 months', days: 63 },
            { name: '6 months', days: 126 },
            { name: '1 year', days: 252 },
            { name: '2 years', days: 504 }
        ];
        
        const results = [];
        
        for (const tf of timeframes) {
            // Get subset of data for this timeframe
            const startIdx = Math.max(0, ohlc.length - tf.days);
            const subset = ohlc.slice(startIdx);
            
            if (subset.length < 30) continue;
            
            // Find swing lows in this timeframe
            const swingLows = this.findSwingLows(subset, 10);
            
            if (swingLows.length < 2) {
                results.push({
                    timeframe: tf.name,
                    status: 'insufficient_data',
                    swingLowCount: swingLows.length
                });
                continue;
            }
            
            // Adjust indices to global (full dataset) indices
            const adjustedSwingLows = swingLows.map(sl => ({
                ...sl,
                index: sl.index + startIdx
            }));
            
            // Calculate trendline
            const trendline = this.calculateTrendline(adjustedSwingLows);
            
            if (!trendline) {
                results.push({
                    timeframe: tf.name,
                    status: 'calculation_error'
                });
                continue;
            }
            
            // Current trendline value (where support "should be" today)
            const currentTrendlineValue = trendline.slope * currentIndex + trendline.intercept;
            
            // Is current price above or below trendline?
            const breached = currentPrice < currentTrendlineValue;
            const percentFromTrendline = ((currentPrice - currentTrendlineValue) / currentTrendlineValue * 100);
            
            // Project forward: where will trendline be in 30/45/60 days?
            const projections = {};
            for (const daysOut of [30, 45, 60]) {
                const futureIndex = currentIndex + daysOut;
                const futureValue = trendline.slope * futureIndex + trendline.intercept;
                projections[`${daysOut}d`] = Math.round(futureValue * 100) / 100;
            }
            
            results.push({
                timeframe: tf.name,
                status: breached ? 'breached' : 'valid',
                swingLowCount: swingLows.length,
                currentTrendlineValue: Math.round(currentTrendlineValue * 100) / 100,
                currentPrice: Math.round(currentPrice * 100) / 100,
                percentFromTrendline: Math.round(percentFromTrendline * 10) / 10,
                slope: Math.round(trendline.slope * 1000) / 1000,  // Daily slope
                r2: Math.round(trendline.r2 * 100) / 100,  // Fit quality
                projections,
                swingLows: adjustedSwingLows.slice(-5).map(sl => ({
                    date: sl.date.toISOString().split('T')[0],
                    price: Math.round(sl.price * 100) / 100
                }))
            });
        }
        
        // Find the longest valid (unbreached) trendline
        const validTrendlines = results.filter(r => r.status === 'valid');
        const longestValid = validTrendlines.length > 0 
            ? validTrendlines[validTrendlines.length - 1]  // Last = longest timeframe
            : null;
        
        // Suggested strike: below the projected support at 30-45 DTE
        let suggestedStrike = null;
        if (longestValid) {
            const support45d = longestValid.projections['45d'];
            // Round down to nearest $5 for strikes > $50, $2.50 for < $50
            if (support45d >= 50) {
                suggestedStrike = Math.floor(support45d / 5) * 5;
            } else {
                suggestedStrike = Math.floor(support45d / 2.5) * 2.5;
            }
        }
        
        return {
            ticker,
            currentPrice,
            analysisDate: new Date().toISOString().split('T')[0],
            timeframes: results,
            longestValidTrendline: longestValid,
            suggestedStrike,
            summary: longestValid 
                ? `${longestValid.timeframe} uptrend valid. Support at ~$${longestValid.projections['45d']} in 45 days. Suggested strike: $${suggestedStrike}`
                : 'No valid support trendlines found - all timeframes breached'
        };
    }
    
    /**
     * Find significant swing high/low for Fibonacci calculation
     * Looks for the major move that defines current price action
     * @param {Array} ohlc - OHLC data
     * @returns {{swingLow, swingHigh, lowDate, highDate}}
     */
    static findMajorSwing(ohlc) {
        if (!ohlc || ohlc.length < 60) return null;
        
        // Find the absolute low and high in the dataset
        let lowestIdx = 0, highestIdx = 0;
        let lowestPrice = Infinity, highestPrice = 0;
        
        for (let i = 0; i < ohlc.length; i++) {
            if (ohlc[i].low < lowestPrice) {
                lowestPrice = ohlc[i].low;
                lowestIdx = i;
            }
            if (ohlc[i].high > highestPrice) {
                highestPrice = ohlc[i].high;
                highestIdx = i;
            }
        }
        
        // Determine if this is an uptrend (low before high) or downtrend (high before low)
        const isUptrend = lowestIdx < highestIdx;
        
        return {
            swingLow: lowestPrice,
            swingHigh: highestPrice,
            lowDate: ohlc[lowestIdx].date,
            highDate: ohlc[highestIdx].date,
            isUptrend,
            lowIdx: lowestIdx,
            highIdx: highestIdx
        };
    }
    
    /**
     * Calculate Fibonacci retracement levels
     * @param {number} low - Swing low price
     * @param {number} high - Swing high price
     * @returns {Array<{level, ratio, price}>}
     */
    static calculateFibLevels(low, high) {
        const range = high - low;
        
        // Standard Fib ratios (for retracement from high back toward low)
        const ratios = [
            { level: '0%', ratio: 0, desc: 'High (Peak)' },
            { level: '23.6%', ratio: 0.236, desc: 'Shallow pullback' },
            { level: '38.2%', ratio: 0.382, desc: 'Moderate pullback' },
            { level: '50%', ratio: 0.5, desc: 'Half retracement' },
            { level: '61.8%', ratio: 0.618, desc: 'Golden ratio (key support)' },
            { level: '78.6%', ratio: 0.786, desc: 'Deep retracement' },
            { level: '100%', ratio: 1.0, desc: 'Low (Origin)' }
        ];
        
        return ratios.map(r => ({
            level: r.level,
            ratio: r.ratio,
            price: Math.round((high - range * r.ratio) * 100) / 100,
            desc: r.desc
        }));
    }
    
    /**
     * Find which Fib level current price is near
     * @param {number} currentPrice 
     * @param {Array} fibLevels 
     * @returns {{nearestLevel, distancePercent, nextSupport, nextResistance}}
     */
    static findNearestFibLevel(currentPrice, fibLevels) {
        let nearest = null;
        let minDistance = Infinity;
        let nextSupport = null;
        let nextResistance = null;
        
        for (let i = 0; i < fibLevels.length; i++) {
            const fib = fibLevels[i];
            const distance = Math.abs(currentPrice - fib.price);
            const distancePercent = Math.abs((currentPrice - fib.price) / fib.price * 100);
            
            if (distance < minDistance) {
                minDistance = distance;
                nearest = { ...fib, distancePercent: Math.round(distancePercent * 10) / 10 };
            }
            
            // Find next support (Fib level below current price)
            if (fib.price < currentPrice && (!nextSupport || fib.price > nextSupport.price)) {
                nextSupport = fib;
            }
            
            // Find next resistance (Fib level above current price)
            if (fib.price > currentPrice && (!nextResistance || fib.price < nextResistance.price)) {
                nextResistance = fib;
            }
        }
        
        return { nearest, nextSupport, nextResistance };
    }
    
    /**
     * Full Fibonacci analysis for a ticker
     * @param {string} ticker 
     * @returns {Object} Fib analysis with levels and current position
     */
    static async analyzeFibonacci(ticker) {
        console.log(`[TECHNICAL] Calculating Fibonacci levels for ${ticker}...`);
        
        // Fetch 2 years of data to find major swing
        const ohlc = await this.fetchOHLC(ticker, 2);
        if (!ohlc || ohlc.length < 60) {
            return { error: 'Insufficient price data' };
        }
        
        const currentPrice = ohlc[ohlc.length - 1].close;
        
        // Find the major swing high/low
        const swing = this.findMajorSwing(ohlc);
        if (!swing) {
            return { error: 'Could not identify major swing' };
        }
        
        // Calculate Fib levels
        const fibLevels = this.calculateFibLevels(swing.swingLow, swing.swingHigh);
        
        // Find where current price sits
        const position = this.findNearestFibLevel(currentPrice, fibLevels);
        
        // Suggest strike at or below next support level
        let suggestedStrike = null;
        if (position.nextSupport) {
            const supportPrice = position.nextSupport.price;
            if (supportPrice >= 50) {
                suggestedStrike = Math.floor(supportPrice / 5) * 5;
            } else {
                suggestedStrike = Math.floor(supportPrice / 2.5) * 2.5;
            }
        }
        
        return {
            ticker,
            currentPrice: Math.round(currentPrice * 100) / 100,
            analysisDate: new Date().toISOString().split('T')[0],
            swing: {
                low: Math.round(swing.swingLow * 100) / 100,
                high: Math.round(swing.swingHigh * 100) / 100,
                lowDate: swing.lowDate.toISOString().split('T')[0],
                highDate: swing.highDate.toISOString().split('T')[0],
                isUptrend: swing.isUptrend,
                movePercent: Math.round((swing.swingHigh - swing.swingLow) / swing.swingLow * 100)
            },
            fibLevels,
            position: {
                nearest: position.nearest,
                nextSupport: position.nextSupport,
                nextResistance: position.nextResistance
            },
            suggestedStrike,
            summary: position.nextSupport 
                ? `Currently near ${position.nearest?.level} ($${position.nearest?.price}). Next Fib support: ${position.nextSupport.level} at $${position.nextSupport.price}. Suggested strike: $${suggestedStrike}`
                : `At or below all Fib levels - no clear support`
        };
    }
    
    /**
     * Combined technical analysis - trendlines + Fibonacci
     * @param {string} ticker 
     * @returns {Object} Full technical analysis
     */
    static async analyzeAll(ticker) {
        console.log(`[TECHNICAL] Running full analysis for ${ticker}...`);
        
        const [trendlines, fibonacci] = await Promise.all([
            this.analyzeTrendlines(ticker),
            this.analyzeFibonacci(ticker)
        ]);
        
        // Combine suggestions - prefer confluence (where trendline and Fib agree)
        let confluenceSupport = null;
        if (trendlines.longestValidTrendline && fibonacci.position?.nextSupport) {
            const trendSupport = trendlines.longestValidTrendline.projections['45d'];
            const fibSupport = fibonacci.position.nextSupport.price;
            
            // If they're within 10% of each other, we have confluence
            const diff = Math.abs(trendSupport - fibSupport) / fibSupport * 100;
            if (diff < 10) {
                confluenceSupport = {
                    price: Math.round((trendSupport + fibSupport) / 2 * 100) / 100,
                    trendlineSupport: trendSupport,
                    fibSupport: fibSupport,
                    confidence: 'HIGH - Trendline and Fib align'
                };
            }
        }
        
        // Best suggested strike
        let bestStrike = null;
        if (confluenceSupport) {
            // Use confluence point
            const support = confluenceSupport.price;
            bestStrike = support >= 50 ? Math.floor(support / 5) * 5 : Math.floor(support / 2.5) * 2.5;
        } else if (trendlines.suggestedStrike) {
            bestStrike = trendlines.suggestedStrike;
        } else if (fibonacci.suggestedStrike) {
            bestStrike = fibonacci.suggestedStrike;
        }
        
        return {
            ticker,
            currentPrice: fibonacci.currentPrice || trendlines.currentPrice,
            analysisDate: new Date().toISOString().split('T')[0],
            trendlines,
            fibonacci,
            confluence: confluenceSupport,
            suggestedStrike: bestStrike,
            summary: confluenceSupport 
                ? `🎯 CONFLUENCE: Trendline ($${confluenceSupport.trendlineSupport}) and Fib ${fibonacci.position?.nextSupport?.level} ($${confluenceSupport.fibSupport}) align near $${confluenceSupport.price}. Strong support zone. Strike: $${bestStrike}`
                : `Trendline: ${trendlines.summary}. Fib: ${fibonacci.summary}`
        };
    }
}

module.exports = TechnicalService;
