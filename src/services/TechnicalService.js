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
}

module.exports = TechnicalService;
