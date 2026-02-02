// WheelHouse - Chart Drawing Module
// All canvas rendering functions

import { state } from './state.js';
import { erf } from './utils.js';
import { getPositionType, bsPrice } from './pricing.js';

// Payoff chart zoom/pan state
let payoffChartState = {
    zoom: 1.0,        // 1.0 = auto-fit, >1 = zoomed in, <1 = zoomed out
    panX: 0,          // Pan offset in price units
    isDragging: false,
    dragStartX: 0,
    dragStartPanX: 0,
    initialized: false
};

// Reset payoff chart zoom/pan (called when loading new position)
export function resetPayoffChartZoom() {
    payoffChartState.zoom = 1.0;
    payoffChartState.panX = 0;
}

// Initialize payoff chart mouse handlers (call once)
function initPayoffChartInteraction(canvas) {
    if (payoffChartState.initialized) return;
    payoffChartState.initialized = true;
    
    // Mouse wheel zoom
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1; // Zoom out/in
        payoffChartState.zoom = Math.max(0.3, Math.min(5, payoffChartState.zoom * zoomFactor));
        drawPayoffChart();
    }, { passive: false });
    
    // Mouse drag pan
    canvas.addEventListener('mousedown', (e) => {
        payoffChartState.isDragging = true;
        payoffChartState.dragStartX = e.clientX;
        payoffChartState.dragStartPanX = payoffChartState.panX;
        canvas.style.cursor = 'grabbing';
    });
    
    canvas.addEventListener('mousemove', (e) => {
        if (!payoffChartState.isDragging) return;
        const dx = e.clientX - payoffChartState.dragStartX;
        // Convert pixel movement to price units (rough estimate)
        const pricePerPixel = (state.strike * 0.5) / canvas.getBoundingClientRect().width;
        payoffChartState.panX = payoffChartState.dragStartPanX - dx * pricePerPixel / payoffChartState.zoom;
        drawPayoffChart();
    });
    
    canvas.addEventListener('mouseup', () => {
        payoffChartState.isDragging = false;
        canvas.style.cursor = 'grab';
    });
    
    canvas.addEventListener('mouseleave', () => {
        payoffChartState.isDragging = false;
        canvas.style.cursor = 'grab';
    });
    
    // Double-click to reset zoom
    canvas.addEventListener('dblclick', () => {
        payoffChartState.zoom = 1.0;
        payoffChartState.panX = 0;
        drawPayoffChart();
    });
    
    canvas.style.cursor = 'grab';
}

/**
 * Main simulator canvas drawing
 */
export function draw(currentPath = null) {
    const canvas = document.getElementById('mainCanvas');
    if (!canvas) return;  // Canvas may not exist if simulator tab is removed
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, M = 40;
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
        const y = M + (i/10) * (H - 2*M);
        ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W-M, y); ctx.stroke();
    }
    
    // Walls
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, M); ctx.lineTo(W-M, M); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(M, H-M); ctx.lineTo(W-M, H-M); ctx.stroke();
    
    // Start position
    const startY = M + (1-state.p) * (H - 2*M);
    ctx.strokeStyle = '#ffaa00';
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(M, startY); ctx.lineTo(W-M, startY); ctx.stroke();
    ctx.setLineDash([]);
    
    // Labels
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('1', M-5, M+4);
    ctx.fillText('0', M-5, H-M+4);
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('p=' + state.p.toFixed(2), M-5, startY+4);
    
    // Previous paths
    state.previousPaths.forEach((path, i) => {
        drawPath(ctx, path, `rgba(0,217,255,${0.1 + 0.2*i/state.previousPaths.length})`, 1, W, H, M);
    });
    
    // Current path
    if (currentPath) {
        drawPath(ctx, currentPath, '#00ff88', 2, W, H, M);
        const last = currentPath[currentPath.length - 1];
        const maxT = Math.max(...currentPath.map(p => p.x), 1);
        const dx = M + (last.x/maxT) * (W - 2*M);
        const dy = M + (1 - Math.max(0, Math.min(1, last.y))) * (H - 2*M);
        ctx.beginPath();
        ctx.arc(dx, dy, 5, 0, Math.PI*2);
        ctx.fillStyle = '#00ff88';
        ctx.fill();
    }
    
    drawHistogram();
}

function drawPath(ctx, path, color, width, W, H, M) {
    if (path.length < 2) return;
    const maxT = Math.max(...path.map(p => p.x), 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    path.forEach((pt, i) => {
        const x = M + (pt.x/maxT) * (W - 2*M);
        const y = M + (1 - Math.max(0, Math.min(1, pt.y))) * (H - 2*M);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
}

/**
 * Histogram drawing
 */
export function drawHistogram() {
    const canvas = document.getElementById('histogramCanvas');
    if (!canvas) return;  // Canvas may not exist if simulator tab is removed
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, W, H);
    
    if (state.exitTimes.length === 0) {
        ctx.fillStyle = '#666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Run simulations to see distribution', W/2, H/2);
        return;
    }
    
    const bins = 25, maxT = Math.max(...state.exitTimes, 0.1);
    const binWidth = maxT / bins;
    const counts = new Array(bins).fill(0);
    state.exitTimes.forEach(t => { const b = Math.min(Math.floor(t/binWidth), bins-1); counts[b]++; });
    const maxC = Math.max(...counts);
    const barW = (W - 40) / bins;
    
    const grad = ctx.createLinearGradient(0, H-10, 0, 10);
    grad.addColorStop(0, '#00d9ff');
    grad.addColorStop(1, '#00ff88');
    
    counts.forEach((c, i) => {
        const h = (c/maxC) * (H - 35);
        ctx.fillStyle = grad;
        ctx.fillRect(20 + i*barW, H - 25 - h, barW - 1, h);
    });
    
    ctx.fillStyle = '#888';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('0', 20, H-3);
    ctx.fillText(maxT.toFixed(1), W-20, H-3);
}

/**
 * Payoff chart drawing - Enhanced with P&L, breakeven, annotations
 * Supports mouse zoom (scroll) and pan (drag)
 */
export function drawPayoffChart() {
    const canvas = document.getElementById('payoffCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Initialize mouse interaction handlers (once)
    initPayoffChartInteraction(canvas);
    
    // High-DPI scaling
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 400;
    const cssH = rect.height || 300;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
    
    const W = cssW, H = cssH;
    // Increased margins to prevent label clipping
    const M = { top: 45, right: 100, bottom: 55, left: 65 };
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    // Get position info
    const posType = getPositionType();
    const isPut = posType.isPut;
    const isShort = posType.isShort;
    const isBuyWrite = posType.isBuyWrite || posType.isCoveredCall;
    const contracts = state.currentPositionContext?.contracts || 1;
    const premium = state.currentPositionContext?.premium || 
                   (isPut ? state.optionResults?.putPrice : state.optionResults?.callPrice) || 1;
    
    // Check if this is a spread position
    const positionType = state.currentPositionContext?.type || '';
    const isSpread = positionType.includes('_spread');
    const isCredit = positionType.includes('credit');
    const isDebit = positionType.includes('debit');
    const isPutSpread = positionType.includes('put');
    const isCallSpread = positionType.includes('call');
    
    // Get spread strikes
    const buyStrike = state.currentPositionContext?.buyStrike || null;
    const sellStrike = state.currentPositionContext?.sellStrike || null;
    const spreadWidth = state.currentPositionContext?.spreadWidth || 
                        (buyStrike && sellStrike ? Math.abs(sellStrike - buyStrike) : 0);
    
    // For Buy/Write, we need the stock purchase price
    const stockPrice = state.currentPositionContext?.stockPrice || state.spot;
    
    const strike = state.strike;
    const spot = state.spot;
    
    // Calculate P&L at key points
    const multiplier = contracts * 100;
    
    // For Buy/Write: Max profit = (Strike - Stock Price + Premium) × 100
    // For Short Put: Max profit = Premium × 100
    // For Spreads: Calculate based on spread type
    let maxProfit, maxLoss, breakeven;
    
    if (isSpread && buyStrike && sellStrike) {
        // SPREAD CALCULATIONS
        if (isCredit) {
            // Credit spreads: receive premium upfront
            maxProfit = premium * multiplier;  // Keep the net credit
            maxLoss = (spreadWidth - premium) * multiplier;  // Spread width minus premium
            
            if (isPutSpread) {
                // Put Credit Spread (Bull Put): Sell high put, buy low put
                // Max profit when stock > sellStrike
                // Max loss when stock < buyStrike
                breakeven = sellStrike - premium;
            } else {
                // Call Credit Spread (Bear Call): Sell low call, buy high call
                // Max profit when stock < sellStrike
                // Max loss when stock > buyStrike
                breakeven = sellStrike + premium;
            }
        } else {
            // Debit spreads: pay premium upfront
            maxProfit = (spreadWidth - premium) * multiplier;  // Spread width minus cost
            maxLoss = premium * multiplier;  // Lose the debit paid
            
            if (isPutSpread) {
                // Put Debit Spread (Bear Put): Buy high put, sell low put
                // Max profit when stock < sellStrike
                // Max loss when stock > buyStrike
                breakeven = buyStrike - premium;
            } else {
                // Call Debit Spread (Bull Call): Buy low call, sell high call
                // Max profit when stock > sellStrike
                // Max loss when stock < buyStrike
                breakeven = buyStrike + premium;
            }
        }
    } else if (isBuyWrite) {
        maxProfit = (strike - stockPrice + premium) * multiplier;
        maxLoss = (stockPrice - premium) * multiplier;  // If stock goes to 0
        breakeven = stockPrice - premium; // Net cost basis
    } else {
        maxProfit = premium * multiplier;  // Short option max profit
        breakeven = isPut ? strike - premium : strike + premium;
        maxLoss = isShort ? (isPut ? (strike - premium) * multiplier : 9999 * multiplier) : premium * multiplier;
    }
    
    // Calculate price range DYNAMICALLY to include all key points:
    // - Strike(s), Spot, Breakeven, plus 15% padding on each side
    let keyPrices;
    if (isSpread && buyStrike && sellStrike) {
        keyPrices = [buyStrike, sellStrike, spot, breakeven].filter(p => p > 0);
    } else {
        keyPrices = [strike, spot, breakeven].filter(p => p > 0);
    }
    const minKey = Math.min(...keyPrices);
    const maxKey = Math.max(...keyPrices);
    const priceSpan = maxKey - minKey;
    const padding = Math.max(priceSpan * 0.20, (strike || sellStrike) * 0.15); // At least 15% of strike as padding
    
    // Apply zoom and pan from mouse interaction
    const baseMin = Math.max(0, minKey - padding);
    const baseMax = maxKey + padding;
    const baseRange = baseMax - baseMin;
    const zoomedRange = baseRange / payoffChartState.zoom;
    const center = (baseMin + baseMax) / 2 + payoffChartState.panX;
    const minS = Math.max(0, center - zoomedRange / 2);
    const maxS = center + zoomedRange / 2;
    
    // Calculate max loss for display (at edge of chart)
    let maxLossAtEdge;
    if (isSpread) {
        // Spreads have defined max loss
        maxLossAtEdge = maxLoss;
    } else if (isBuyWrite) {
        // Buy/Write max loss: Stock goes to zero, you lose (stockPrice - premium) × shares
        maxLossAtEdge = (stockPrice - premium) * multiplier;
    } else if (isShort && isPut) {
        maxLossAtEdge = (strike - premium - minS) * multiplier;  // Loss if stock goes to minS
    } else if (isShort && !isPut) {
        maxLossAtEdge = (maxS - strike - premium) * multiplier;  // Loss if stock goes to maxS
    } else {
        maxLossAtEdge = premium * multiplier;  // Long option max loss is premium
    }
    
    // P&L range for Y axis
    const pnlMax = maxProfit * 1.3;
    const pnlMin = -Math.max(maxLossAtEdge, maxProfit) * 1.3;
    const pnlRange = pnlMax - pnlMin;
    
    // Helper: price to X
    const priceToX = (price) => M.left + (price - minS) / (maxS - minS) * (W - M.left - M.right);
    // Helper: P&L to Y
    const pnlToY = (pnl) => M.top + (pnlMax - pnl) / pnlRange * (H - M.top - M.bottom);
    
    // Draw grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
        const y = M.top + (i/6) * (H - M.top - M.bottom);
        ctx.beginPath(); ctx.moveTo(M.left, y); ctx.lineTo(W - M.right, y); ctx.stroke();
    }
    
    // Draw zero line (breakeven P&L)
    const zeroY = pnlToY(0);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.left, zeroY); ctx.lineTo(W - M.right, zeroY); ctx.stroke();
    
    // Calculate P&L for a given stock price at expiration
    // stockPriceAtExp = price at expiration
    const calcPnL = (stockPriceAtExp) => {
        // SPREAD P&L CALCULATION
        if (isSpread && buyStrike && sellStrike) {
            if (isPutSpread) {
                // Put spreads
                const longPutValue = Math.max(buyStrike - stockPriceAtExp, 0);  // Long put intrinsic
                const shortPutValue = Math.max(sellStrike - stockPriceAtExp, 0); // Short put intrinsic
                
                if (isCredit) {
                    // Put Credit Spread: Short the higher strike, long the lower strike
                    // P&L = Premium received - (short put intrinsic - long put intrinsic)
                    const netIntrinsic = shortPutValue - longPutValue;
                    return (premium - netIntrinsic) * multiplier;
                } else {
                    // Put Debit Spread: Long the higher strike, short the lower strike
                    // P&L = (long put intrinsic - short put intrinsic) - Premium paid
                    const netIntrinsic = longPutValue - shortPutValue;
                    return (netIntrinsic - premium) * multiplier;
                }
            } else {
                // Call spreads
                const longCallValue = Math.max(stockPriceAtExp - buyStrike, 0);  // Long call intrinsic
                const shortCallValue = Math.max(stockPriceAtExp - sellStrike, 0); // Short call intrinsic
                
                if (isCredit) {
                    // Call Credit Spread: Short the lower strike, long the higher strike
                    // P&L = Premium received - (short call intrinsic - long call intrinsic)
                    const netIntrinsic = shortCallValue - longCallValue;
                    return (premium - netIntrinsic) * multiplier;
                } else {
                    // Call Debit Spread: Long the lower strike, short the higher strike
                    // P&L = (long call intrinsic - short call intrinsic) - Premium paid
                    const netIntrinsic = longCallValue - shortCallValue;
                    return (netIntrinsic - premium) * multiplier;
                }
            }
        }
        
        // Buy/Write (Covered Call): Long stock + Short call
        // P&L = (Stock P&L) + (Call premium) - (Call intrinsic if exercised)
        if (isBuyWrite) {
            const stockPnL = stockPriceAtExp - stockPrice; // Stock gain/loss per share
            const callIntrinsic = Math.max(stockPriceAtExp - strike, 0); // Call ITM value
            // Short call: keep premium, but pay intrinsic if ITM
            const callPnL = premium - callIntrinsic;
            return (stockPnL + callPnL) * multiplier;
        }
        
        // Regular option P&L
        let intrinsicValue;
        if (isPut) {
            intrinsicValue = Math.max(strike - stockPriceAtExp, 0);
        } else {
            intrinsicValue = Math.max(stockPriceAtExp - strike, 0);
        }
        
        if (isShort) {
            return (premium - intrinsicValue) * multiplier;
        } else {
            return (intrinsicValue - premium) * multiplier;
        }
    };
    
    // Draw P&L curve
    ctx.lineWidth = 3;
    ctx.beginPath();
    let firstPoint = true;
    for (let x = M.left; x <= W - M.right; x += 2) {
        const price = minS + (x - M.left) / (W - M.left - M.right) * (maxS - minS);
        const pnl = calcPnL(price);
        const y = pnlToY(pnl);
        
        // Color based on profit/loss
        if (firstPoint) {
            ctx.moveTo(x, y);
            firstPoint = false;
        } else {
            ctx.lineTo(x, y);
        }
    }
    // Draw with gradient or split colors
    ctx.strokeStyle = '#888';
    ctx.stroke();
    
    // Re-draw with proper colors (profit green, loss red)
    for (let x = M.left; x <= W - M.right - 2; x += 2) {
        const price = minS + (x - M.left) / (W - M.left - M.right) * (maxS - minS);
        const pnl = calcPnL(price);
        const nextPrice = minS + (x + 2 - M.left) / (W - M.left - M.right) * (maxS - minS);
        const nextPnl = calcPnL(nextPrice);
        
        ctx.strokeStyle = pnl >= 0 ? '#00ff88' : '#ff5252';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, pnlToY(pnl));
        ctx.lineTo(x + 2, pnlToY(nextPnl));
        ctx.stroke();
    }
    
    // Strike line(s)
    if (isSpread && buyStrike && sellStrike) {
        // Draw both strike lines for spreads
        const buyX = priceToX(buyStrike);
        const sellX = priceToX(sellStrike);
        
        // Buy strike (long leg) - purple
        ctx.strokeStyle = '#b9f';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(buyX, M.top); ctx.lineTo(buyX, H - M.bottom); ctx.stroke();
        
        // Sell strike (short leg) - cyan
        ctx.strokeStyle = '#00d9ff';
        ctx.beginPath(); ctx.moveTo(sellX, M.top); ctx.lineTo(sellX, H - M.bottom); ctx.stroke();
        ctx.setLineDash([]);
    } else {
        const strikeX = priceToX(strike);
        ctx.strokeStyle = '#00d9ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(strikeX, M.top); ctx.lineTo(strikeX, H - M.bottom); ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Spot price line
    const spotX = priceToX(spot);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(spotX, M.top); ctx.lineTo(spotX, H - M.bottom); ctx.stroke();
    
    // Breakeven line
    if (breakeven > minS && breakeven < maxS) {
        const beX = priceToX(breakeven);
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(beX, M.top); ctx.lineTo(beX, H - M.bottom); ctx.stroke();
        ctx.setLineDash([]);
        
        // BE label
        ctx.fillStyle = '#ff9800';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('BE: $' + breakeven.toFixed(2), beX, H - M.bottom + 25);
    }
    
    // X-axis labels
    ctx.fillStyle = '#888';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    
    // Strike label(s)
    if (isSpread && buyStrike && sellStrike) {
        const buyX = priceToX(buyStrike);
        const sellX = priceToX(sellStrike);
        
        // Buy strike label (long leg)
        ctx.fillStyle = '#b9f';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.fillText('Buy $' + buyStrike, buyX, M.top - 8);
        
        // Sell strike label (short leg)
        ctx.fillStyle = '#00d9ff';
        ctx.fillText('Sell $' + sellStrike, sellX, M.top - 8);
    } else {
        const strikeX = priceToX(strike);
        ctx.fillStyle = '#00d9ff';
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.fillText('K=$' + strike, strikeX, M.top - 8);
    }
    
    // Spot label
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText('$' + spot.toFixed(0), spotX, H - M.bottom + 12);
    ctx.fillText('SPOT', spotX, H - M.bottom + 24);
    
    // Y-axis labels (P&L values)
    ctx.fillStyle = '#888';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
        const pnl = pnlMax - (i / yTicks) * pnlRange;
        const y = M.top + (i / yTicks) * (H - M.top - M.bottom);
        
        if (Math.abs(pnl) < 10) continue; // Skip near-zero
        
        ctx.fillStyle = pnl >= 0 ? '#00ff88' : '#ff5252';
        const label = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0);
        ctx.fillText(label, M.left - 5, y + 4);
    }
    
    // Zero line label
    ctx.fillStyle = '#aaa';
    ctx.fillText('$0', M.left - 5, zeroY + 4);
    
    // Max Profit annotation
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    const maxProfitY = pnlToY(maxProfit);
    ctx.fillText('Max Profit: +$' + maxProfit.toFixed(0), W - M.right + 5, maxProfitY + 4);
    
    // For LONG options (not short), calculate actual unrealized P&L using current option price
    // This matters for options with lots of time value (like LEAPS)
    // Try multiple sources for current option price:
    // 1. Position's lastOptionPrice (from streaming/sync)
    // 2. Position's markedPrice (manually set)
    // 3. state.liveOptionData from CBOE fetch (if user clicked "Price Options")
    let currentOptionPrice = state.currentPositionContext?.lastOptionPrice || 
                             state.currentPositionContext?.markedPrice || null;
    
    // Fallback: Check state.liveOptionData (populated when user fetches CBOE prices)
    if (!currentOptionPrice && state.liveOptionData) {
        const optionData = isPut ? state.liveOptionData.putOption : state.liveOptionData.callOption;
        if (optionData && optionData.bid !== undefined && optionData.ask !== undefined) {
            currentOptionPrice = (optionData.bid + optionData.ask) / 2;
        }
    }
    
    const isLong = !isShort && !isBuyWrite;
    const hasLivePricing = currentOptionPrice !== null && currentOptionPrice > 0;
    
    // Calculate expiration P&L (what the option would be worth if it expired now at current spot)
    const expirationPnL = calcPnL(spot);
    const expirationY = pnlToY(expirationPnL);
    
    // Determine which P&L to display and where to position the marker
    let displayPnL, displayY;
    
    if (hasLivePricing) {
        if (isSpread) {
            // For SPREADS: Use isCredit to determine direction
            // Credit spread: You received premium, pay currentPrice to close
            // Debit spread: You paid premium, receive currentPrice to close
            if (isCredit) {
                displayPnL = (premium - currentOptionPrice) * multiplier;
            } else {
                displayPnL = (currentOptionPrice - premium) * multiplier;
            }
        } else if (isLong) {
            // For LONG options: P&L = (currentPrice - entryPremium) × 100 × contracts
            displayPnL = (currentOptionPrice - premium) * multiplier;
        } else {
            // For SHORT options: P&L = (entryPremium - currentPrice) × 100 × contracts
            // You sold for premium, now it costs currentPrice to buy back
            displayPnL = (premium - currentOptionPrice) * multiplier;
        }
        displayY = pnlToY(displayPnL);  // Position at ACTUAL P&L level
    } else {
        // No live pricing available - show expiration P&L
        displayPnL = expirationPnL;
        displayY = expirationY;
    }
    
    // Draw dot at the appropriate P&L position
    ctx.beginPath();
    ctx.arc(spotX, displayY, 6, 0, Math.PI * 2);
    ctx.fillStyle = displayPnL >= 0 ? '#00ff88' : '#ff5252';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Current P&L label - position based on whether it's profit or loss
    ctx.fillStyle = displayPnL >= 0 ? '#00ff88' : '#ff5252';
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    const displayLabel = 'NOW: ' + (displayPnL >= 0 ? '+' : '') + '$' + displayPnL.toFixed(0);
    // Place label above/below the dot based on P&L sign
    const labelY = displayPnL >= 0 ? displayY - 15 : displayY + 20;
    ctx.fillText(displayLabel, spotX + 12, labelY);
    
    // Position type label (top left)
    ctx.fillStyle = '#aaa';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    let posLabel;
    if (isSpread) {
        const spreadType = positionType.replace(/_/g, ' ').toUpperCase();
        posLabel = spreadType + ' × ' + contracts;
    } else if (isBuyWrite) {
        posLabel = 'COVERED CALL × ' + contracts;
    } else {
        posLabel = (isShort ? 'SHORT ' : 'LONG ') + (isPut ? 'PUT' : 'CALL') + ' × ' + contracts;
    }
    ctx.fillText(posLabel, M.left + 5, M.top - 8);
    
    // Legend
    ctx.font = '10px -apple-system, sans-serif';
    if (isSpread) {
        ctx.fillStyle = '#00d9ff';
        ctx.fillText('Sell', M.left + 5, M.top + 15);
        ctx.fillStyle = '#b9f';
        ctx.fillText('Buy', M.left + 35, M.top + 15);
        ctx.fillStyle = '#ffaa00';
        ctx.fillText('Spot', M.left + 65, M.top + 15);
        ctx.fillStyle = '#ff9800';
        ctx.fillText('BE', M.left + 100, M.top + 15);
    } else {
        ctx.fillStyle = '#00d9ff';
        ctx.fillText('Strike', M.left + 5, M.top + 15);
        ctx.fillStyle = '#ffaa00';
        ctx.fillText('Spot', M.left + 50, M.top + 15);
        ctx.fillStyle = '#ff9800';
        ctx.fillText('Breakeven', M.left + 85, M.top + 15);
    }
    
    // Max Loss annotation for spreads
    if (isSpread && maxLoss > 0) {
        ctx.fillStyle = '#ff5252';
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        const maxLossY = pnlToY(-maxLoss);
        ctx.fillText('Max Loss: -$' + maxLoss.toFixed(0), W - M.right + 5, maxLossY + 4);
    }
    
    // Zoom/pan indicator (only show if not at default)
    if (payoffChartState.zoom !== 1 || payoffChartState.panX !== 0) {
        ctx.fillStyle = 'rgba(0,217,255,0.7)';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText(`Zoom: ${payoffChartState.zoom.toFixed(1)}x  |  Double-click to reset`, W - M.right - 130, H - 8);
    } else {
        ctx.fillStyle = 'rgba(136,136,136,0.5)';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText('Scroll to zoom • Drag to pan', W - M.right - 100, H - 8);
    }
}

/**
 * Price histogram drawing - with high-DPI support
 */
export function drawPriceHist(prices) {
    const canvas = document.getElementById('priceHistCanvas');
    const ctx = canvas.getContext('2d');
    
    // High-DPI scaling for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 200;
    const cssH = rect.height || 80;
    
    // Set canvas internal resolution to match display pixels
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.scale(dpr, dpr);
    
    const W = cssW, H = cssH;
    
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, W, H);
    
    const lowerCount = prices.filter(p => p < state.strike).length;
    const upperCount = prices.filter(p => p >= state.strike).length;
    const total = prices.length;
    const maxC = Math.max(lowerCount, upperCount);
    
    // Draw bars with more width for visibility
    const barWidth = 50;
    const lh = (lowerCount/maxC) * (H - 30);
    ctx.fillStyle = '#ff5252';
    ctx.fillRect(W*0.25 - barWidth/2, H - 16 - lh, barWidth, lh);
    
    const uh = (upperCount/maxC) * (H - 30);
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(W*0.75 - barWidth/2, H - 16 - uh, barWidth, uh);
    
    // Larger, crisper fonts
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${(lowerCount/total*100).toFixed(1)}%`, W*0.25, 16);
    ctx.fillText(`${(upperCount/total*100).toFixed(1)}%`, W*0.75, 16);
    
    ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(`< $${state.strike}`, W*0.25, H - 3);
    ctx.fillText(`≥ $${state.strike}`, W*0.75, H - 3);
}

/**
 * Greeks chart drawing
 */
export function drawGreeksChart(callD, putD) {
    const canvas = document.getElementById('greeksCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    ctx.fillStyle = '#00d9ff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Delta Comparison', W/2, 25);
    
    const midY = H/2;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath(); ctx.moveTo(50, midY); ctx.lineTo(W-50, midY); ctx.stroke();
    
    const callH = Math.abs(callD) * (H/2 - 30);
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(W*0.35 - 40, midY - (callD > 0 ? callH : 0), 80, callH);
    ctx.fillStyle = '#fff';
    ctx.fillText('Call Δ=' + callD.toFixed(3), W*0.35, callD > 0 ? midY - callH - 10 : midY + callH + 20);
    
    const putH = Math.abs(putD) * (H/2 - 30);
    ctx.fillStyle = '#ff5252';
    ctx.fillRect(W*0.65 - 40, midY - (putD > 0 ? putH : 0), 80, putH);
    ctx.fillStyle = '#fff';
    ctx.fillText('Put Δ=' + putD.toFixed(3), W*0.65, putD > 0 ? midY - putH - 10 : midY + putH + 20);
}

/**
 * P&L chart at expiration
 */
export function drawPnLChart() {
    const canvas = document.getElementById('pnlCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, M = 35;
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    // Check if we have valid pricing data
    if (!state.optionResults?.finalPrices) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Run Option Pricing first', W/2, H/2);
        return;
    }
    
    const minPrice = state.spot * 0.7;
    const maxPrice = state.spot * 1.3;
    const priceRange = maxPrice - minPrice;
    
    const posType = getPositionType();
    const isPut = posType.isPut;
    const isBuyWrite = posType.isBuyWrite || posType.isCoveredCall;
    
    const contracts = state.currentPositionContext?.contracts || 1;
    const multiplier = contracts * 100;
    
    // Get premium from position context or option results
    const premium = state.currentPositionContext?.premium || 
                   (isPut ? (state.optionResults.putPrice || 0) : (state.optionResults.callPrice || 0));
    
    // For Buy/Write, get stock purchase price
    const stockPrice = state.currentPositionContext?.stockPrice || state.spot;
    
    const pnlData = [];
    let maxPnL = 0, minPnL = 0;
    
    // Calculate P&L data points
    for (let price = minPrice; price <= maxPrice; price += priceRange / 100) {
        let pnl;
        
        if (isBuyWrite) {
            // Covered Call P&L: Stock gain + premium - call intrinsic if exercised
            const stockGain = price - stockPrice;
            const callIntrinsic = Math.max(price - state.strike, 0);
            pnl = (stockGain + premium - callIntrinsic) * multiplier;
        } else if (isPut) {
            // Short put P&L
            pnl = (price >= state.strike) ? premium * multiplier : (premium - (state.strike - price)) * multiplier;
        } else {
            // Short call P&L
            pnl = (price <= state.strike) ? premium * multiplier : (premium - (price - state.strike)) * multiplier;
        }
        
        pnlData.push({price, pnl});
        maxPnL = Math.max(maxPnL, pnl);
        minPnL = Math.min(minPnL, pnl);
    }
    
    // Calculate break-even and max profit/loss
    let calculatedBreakEven, maxProfit, maxLoss;
    
    if (isBuyWrite) {
        calculatedBreakEven = stockPrice - premium;  // Net cost basis
        maxProfit = (state.strike - stockPrice + premium) * multiplier;
        maxLoss = (stockPrice - premium) * multiplier;  // If stock goes to zero
    } else if (isPut) {
        calculatedBreakEven = state.strike - premium;
        maxProfit = premium * multiplier;
        maxLoss = (state.strike - premium) * multiplier;
    } else {
        calculatedBreakEven = state.strike + premium;
        maxProfit = premium * multiplier;
        maxLoss = 'Unlimited';
    }
    
    // Update UI with null checks
    const breakEvenEl = document.getElementById('breakEvenPrice');
    const maxProfitEl = document.getElementById('maxProfit');
    const maxLossEl = document.getElementById('maxLoss');
    
    if (breakEvenEl) breakEvenEl.textContent = '$' + calculatedBreakEven.toFixed(2);
    if (maxProfitEl) maxProfitEl.textContent = '$' + maxProfit.toFixed(0);
    if (maxLossEl) maxLossEl.textContent = typeof maxLoss === 'number' ? '$' + maxLoss.toFixed(0) : maxLoss;
    
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
        const y = M + (i/5) * (H - 2*M);
        ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W-M, y); ctx.stroke();
    }
    
    const pnlRange = maxPnL - minPnL;
    const zeroY = H - M - ((0 - minPnL) / pnlRange) * (H - 2*M);
    ctx.strokeStyle = '#ffaa00';
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(M, zeroY); ctx.lineTo(W-M, zeroY); ctx.stroke();
    ctx.setLineDash([]);
    
    // Strike line
    const strikeX = M + ((state.strike - minPrice) / priceRange) * (W - 2*M);
    ctx.strokeStyle = '#00d9ff';
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(strikeX, M); ctx.lineTo(strikeX, H-M); ctx.stroke();
    ctx.setLineDash([]);
    
    // Spot line
    const spotX = M + ((state.spot - minPrice) / priceRange) * (W - 2*M);
    ctx.strokeStyle = '#ff00ff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(spotX, M); ctx.lineTo(spotX, H-M); ctx.stroke();
    
    // P&L curve
    ctx.lineWidth = 3;
    ctx.beginPath();
    pnlData.forEach((point, i) => {
        const x = M + ((point.price - minPrice) / priceRange) * (W - 2*M);
        const y = H - M - ((point.pnl - minPnL) / pnlRange) * (H - 2*M);
        ctx.strokeStyle = point.pnl >= 0 ? '#00ff88' : '#ff5252';
        if (i === 0) ctx.moveTo(x, y);
        else {
            ctx.lineTo(x, y);
            if (i % 5 === 0) { ctx.stroke(); ctx.beginPath(); ctx.moveTo(x, y); }
        }
    });
    ctx.stroke();
    
    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Strike $' + state.strike.toFixed(0), strikeX, M - 5);
    ctx.fillText('Spot $' + state.spot.toFixed(0), spotX, H - 5);
}

/**
 * Probability cone chart
 */
export function drawProbabilityCone() {
    const canvas = document.getElementById('probConeCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const ML = 30;  // Left margin
    const MR = 80;  // Right margin (extra space for labels)
    const MT = 30, MB = 30;  // Top/bottom margins
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    if (!state.optionResults?.finalPrices) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Run Option Pricing first', W/2, H/2);
        return;
    }
    
    const T = state.dte / 365.25;
    const numTimeSteps = 20;
    
    const bands = [];
    for (let t = 0; t <= numTimeSteps; t++) {
        const timeRatio = t / numTimeSteps;
        const currentTime = T * timeRatio;
        const drift = (state.rate - 0.5 * state.optVol * state.optVol) * currentTime;
        const volatility = state.optVol * Math.sqrt(currentTime);
        
        const mean = state.spot * Math.exp(drift);
        const sigma1 = mean * Math.exp(volatility) - mean;
        const sigma2 = mean * Math.exp(2 * volatility) - mean;
        
        bands.push({
            time: timeRatio,
            mean,
            sigma1Lower: mean - sigma1,
            sigma1Upper: mean + sigma1,
            sigma2Lower: mean - sigma2,
            sigma2Upper: mean + sigma2,
            sigma3Lower: Math.max(0, mean - sigma2 * 1.5),
            sigma3Upper: mean + sigma2 * 1.5
        });
    }
    
    const allPrices = bands.flatMap(b => [b.sigma3Lower, b.sigma3Upper]);
    const minPrice = Math.min(...allPrices) * 0.95;
    const maxPrice = Math.max(...allPrices) * 1.05;
    const priceRange = maxPrice - minPrice;
    
    const chartWidth = W - ML - MR;
    const chartHeight = H - MT - MB;
    
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    for (let i = 0; i <= 5; i++) {
        const y = MT + (i/5) * chartHeight;
        ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + chartWidth, y); ctx.stroke();
    }
    
    // Strike line
    const strikeY = H - MB - ((state.strike - minPrice) / priceRange) * chartHeight;
    ctx.strokeStyle = '#00d9ff';
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(ML, strikeY); ctx.lineTo(ML + chartWidth, strikeY); ctx.stroke();
    ctx.setLineDash([]);
    
    // 3σ band
    ctx.fillStyle = 'rgba(136,0,255,0.1)';
    ctx.beginPath();
    bands.forEach((b, i) => {
        const x = ML + b.time * chartWidth;
        const yUpper = H - MB - ((b.sigma3Upper - minPrice) / priceRange) * chartHeight;
        i === 0 ? ctx.moveTo(x, yUpper) : ctx.lineTo(x, yUpper);
    });
    for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i];
        const x = ML + b.time * chartWidth;
        const yLower = H - MB - ((b.sigma3Lower - minPrice) / priceRange) * chartHeight;
        ctx.lineTo(x, yLower);
    }
    ctx.closePath();
    ctx.fill();
    
    // 2σ band
    ctx.fillStyle = 'rgba(0,217,255,0.15)';
    ctx.beginPath();
    bands.forEach((b, i) => {
        const x = ML + b.time * chartWidth;
        const yUpper = H - MB - ((b.sigma2Upper - minPrice) / priceRange) * chartHeight;
        i === 0 ? ctx.moveTo(x, yUpper) : ctx.lineTo(x, yUpper);
    });
    for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i];
        const x = ML + b.time * chartWidth;
        const yLower = H - MB - ((b.sigma2Lower - minPrice) / priceRange) * chartHeight;
        ctx.lineTo(x, yLower);
    }
    ctx.closePath();
    ctx.fill();
    
    // 1σ band
    ctx.fillStyle = 'rgba(0,255,136,0.2)';
    ctx.beginPath();
    bands.forEach((b, i) => {
        const x = ML + b.time * chartWidth;
        const yUpper = H - MB - ((b.sigma1Upper - minPrice) / priceRange) * chartHeight;
        i === 0 ? ctx.moveTo(x, yUpper) : ctx.lineTo(x, yUpper);
    });
    for (let i = bands.length - 1; i >= 0; i--) {
        const b = bands[i];
        const x = ML + b.time * chartWidth;
        const yLower = H - MB - ((b.sigma1Lower - minPrice) / priceRange) * chartHeight;
        ctx.lineTo(x, yLower);
    }
    ctx.closePath();
    ctx.fill();
    
    // Mean line
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    bands.forEach((b, i) => {
        const x = ML + b.time * chartWidth;
        const y = H - MB - ((b.mean - minPrice) / priceRange) * chartHeight;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    
    // Labels on right side - positioned at the band levels at end of chart
    const lastBand = bands[bands.length - 1];
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    
    // Position labels at actual band positions
    const y3Upper = H - MB - ((lastBand.sigma3Upper - minPrice) / priceRange) * chartHeight;
    const y2Upper = H - MB - ((lastBand.sigma2Upper - minPrice) / priceRange) * chartHeight;
    const y1Upper = H - MB - ((lastBand.sigma1Upper - minPrice) / priceRange) * chartHeight;
    
    ctx.fillStyle = 'rgba(136,0,255,0.8)';
    ctx.fillText('3σ (99.7%)', ML + chartWidth + 5, y3Upper + 4);
    ctx.fillStyle = 'rgba(0,217,255,0.9)';
    ctx.fillText('2σ (95%)', ML + chartWidth + 5, y2Upper + 4);
    ctx.fillStyle = 'rgba(0,255,136,0.9)';
    ctx.fillText('1σ (68%)', ML + chartWidth + 5, y1Upper + 4);
}

/**
 * Heat map drawing with theta decay
 */
export function drawHeatMap() {
    const canvas = document.getElementById('heatMapCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, M = 45;
    
    ctx.fillStyle = '#0a0a15';
    ctx.fillRect(0, 0, W, H);
    
    if (!state.optionResults) {
        ctx.fillStyle = '#888';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Run Option Pricing first', W/2, H/2);
        return;
    }
    
    const posType = getPositionType();
    const isPut = posType.isPut;
    const isShort = posType.isShort;
    
    // Calculate the initial premium at current spot and full DTE
    // This represents what you received when opening the position
    const initialT = state.dte / 365.25;
    const initialPremium = bsPrice(state.spot, state.strike, initialT, state.rate, state.optVol, isPut);
    
    const numPriceSteps = 50;  // More resolution for smoother stair-step
    const numTimeSteps = 30;   // More time steps for clearer decay pattern
    const minPrice = state.spot * 0.7;
    const maxPrice = state.spot * 1.3;
    const priceStep = (maxPrice - minPrice) / numPriceSteps;
    
    const cellW = (W - 2*M) / numPriceSteps;
    const cellH = (H - 2*M) / numTimeSteps;
    
    // Calculate P&L grid
    const pnlGrid = [];
    let maxAbsPnL = 0;
    
    for (let t = 0; t <= numTimeSteps; t++) {
        pnlGrid[t] = [];
        const daysRemaining = state.dte * (1 - t / numTimeSteps);
        const T = daysRemaining / 365.25;
        
        for (let p = 0; p <= numPriceSteps; p++) {
            const price = minPrice + p * priceStep;
            const optionValue = bsPrice(price, state.strike, T, state.rate, state.optVol, isPut);
            let pnl = isShort ? (initialPremium - optionValue) * 100 : (optionValue - initialPremium) * 100;
            pnlGrid[t][p] = pnl;
            maxAbsPnL = Math.max(maxAbsPnL, Math.abs(pnl));
        }
    }
    
    // Draw cells
    for (let t = 0; t <= numTimeSteps; t++) {
        for (let p = 0; p <= numPriceSteps; p++) {
            const pnl = pnlGrid[t][p];
            const intensity = Math.min(1, Math.abs(pnl) / maxAbsPnL);
            if (pnl >= 0) {
                const g = Math.floor(100 + 155 * intensity);
                ctx.fillStyle = `rgb(0,${g},${Math.floor(g * 0.5)})`;
            } else {
                const r = Math.floor(100 + 155 * intensity);
                ctx.fillStyle = `rgb(${r},${Math.floor(40 * (1-intensity))},${Math.floor(40 * (1-intensity))})`;
            }
            
            const x = M + p * cellW;
            const y = M + t * cellH;
            ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        }
    }
    
    // Strike line
    const strikeX = M + ((state.strike - minPrice) / (maxPrice - minPrice)) * (W - 2*M);
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    ctx.moveTo(strikeX, M);
    ctx.lineTo(strikeX, H - M);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Current spot line
    const spotX = M + ((state.spot - minPrice) / (maxPrice - minPrice)) * (W - 2*M);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(spotX, M);
    ctx.lineTo(spotX, H - M);
    ctx.stroke();
    
    // Spot marker
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath();
    ctx.arc(spotX, M, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('▼', spotX, M + 12);
    
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('$' + state.spot.toFixed(2), spotX, H - M + 28);
    
    // Labels
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Stock Price →', W/2, H - 5);
    ctx.save();
    ctx.translate(12, H/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText('Days to Expiry →', 0, 0);
    ctx.restore();
    
    // Axis labels
    ctx.font = '10px sans-serif';
    ctx.fillText('$' + minPrice.toFixed(0), M, H - M + 15);
    ctx.fillStyle = '#00d9ff';
    ctx.fillText('$' + state.strike.toFixed(0), strikeX, H - M + 15);
    ctx.fillStyle = '#fff';
    ctx.fillText('$' + maxPrice.toFixed(0), W - M, H - M + 15);
    
    ctx.textAlign = 'right';
    ctx.fillText(state.dte + 'd', M - 5, M + 5);
    ctx.fillText('0d', M - 5, H - M);
    
    // Legend
    const legendX = W - 90, legendY = M + 5;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(legendX - 5, legendY - 3, 85, 55);
    
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#00ff88';
    ctx.fillText('■ Profit', legendX, legendY + 10);
    ctx.fillStyle = '#ff5252';
    ctx.fillText('■ Loss', legendX, legendY + 22);
    ctx.fillStyle = '#00d9ff';
    ctx.fillText('— Strike $' + state.strike.toFixed(0), legendX, legendY + 34);
    ctx.fillStyle = '#ffaa00';
    ctx.fillText('— Spot $' + state.spot.toFixed(0), legendX, legendY + 46);
}

/**
 * Update heat map with new spot price
 */
export function updateHeatMapSpot() {
    const input = document.getElementById('heatMapSpot');
    if (!input) return;
    
    const newSpot = parseFloat(input.value);
    if (isNaN(newSpot) || newSpot <= 0) {
        input.style.borderColor = '#ff5252';
        setTimeout(() => input.style.borderColor = '', 500);
        return;
    }
    
    state.spot = newSpot;
    
    const clampedSpot = Math.max(20, Math.min(500, Math.round(state.spot)));
    const spotSlider = document.getElementById('spotSlider');
    const spotInput = document.getElementById('spotInput');
    
    if (spotSlider) spotSlider.value = clampedSpot;
    if (spotInput) spotInput.value = Math.round(state.spot);
    
    input.style.borderColor = '#00ff88';
    setTimeout(() => input.style.borderColor = '', 300);
    
    drawPnLChart();
    drawProbabilityCone();
    drawHeatMap();
}

// Make available globally for API module
window.updateHeatMapSpot = updateHeatMapSpot;
