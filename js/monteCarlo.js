/**
 * Monte Carlo Risk Analysis Module
 * GBM simulation for option positions - probability distributions,
 * price cones, and risk scenarios
 * 
 * Extracted from main.js
 */

import { state } from 'state';

/**
 * Monte Carlo Risk Analysis - Uses loaded position data to run real GBM simulation
 * Shows probability distributions, price cones, and risk scenarios
 */
window.runMonteCarloRisk = function() {
    const numPaths = parseInt(document.getElementById('mcPathCount')?.value) || 10000;
    
    // Get position parameters from state (set by Pricing tab or loadPositionToAnalyze)
    const spot = state.spot || 100;
    const strike = state.strike || 95;
    const dte = state.dte || 30;
    const iv = state.optVol || 0.3;
    const rate = state.rate || 0.045;
    
    // Check if we have a valid position loaded
    if (!state.spot || state.spot <= 0) {
        showNotification('No position loaded - go to Pricing tab first', 'error');
        return;
    }
    
    // Show running indicator
    const runBtn = document.getElementById('runMcBtn');
    const runningEl = document.getElementById('mcRunning');
    if (runBtn) runBtn.disabled = true;
    if (runningEl) {
        runningEl.textContent = `Simulating ${numPaths.toLocaleString()} paths...`;
        runningEl.style.display = 'block';
    }
    
    // Run simulation async (use setTimeout to allow UI update)
    setTimeout(() => {
        const results = runGBMSimulation(spot, strike, dte, iv, rate, numPaths);
        displayMonteCarloResults(results, spot, strike, dte, iv);
        
        if (runBtn) runBtn.disabled = false;
        if (runningEl) runningEl.style.display = 'none';
    }, 50);
};

/**
 * Run Geometric Brownian Motion simulation
 */
function runGBMSimulation(spot, strike, dte, vol, rate, numPaths) {
    const T = dte / 365;
    const dt = 1 / 365;  // Daily steps
    const steps = Math.ceil(dte);
    
    const finalPrices = [];
    const paths = [];  // Store subset for visualization
    const pathsToStore = Math.min(100, numPaths);  // Only store 100 paths for drawing
    
    // Run simulations
    for (let i = 0; i < numPaths; i++) {
        let S = spot;
        const path = [S];
        
        for (let t = 0; t < steps; t++) {
            // Standard GBM: dS = μSdt + σSdW
            const dW = Math.sqrt(dt) * gaussianRandom();
            S *= Math.exp((rate - 0.5 * vol * vol) * dt + vol * dW);
            
            if (i < pathsToStore) path.push(S);
        }
        
        finalPrices.push(S);
        if (i < pathsToStore) paths.push(path);
    }
    
    // Calculate statistics
    finalPrices.sort((a, b) => a - b);
    
    const belowStrike = finalPrices.filter(p => p < strike).length;
    const otmPercent = ((numPaths - belowStrike) / numPaths * 100).toFixed(1);
    const itmPercent = (belowStrike / numPaths * 100).toFixed(1);
    
    const median = finalPrices[Math.floor(numPaths / 2)];
    const mean = finalPrices.reduce((a, b) => a + b, 0) / numPaths;
    
    // Calculate percentiles
    const percentile = (arr, p) => arr[Math.floor(arr.length * p / 100)];
    const percentiles = {
        p5: percentile(finalPrices, 5),
        p10: percentile(finalPrices, 10),
        p25: percentile(finalPrices, 25),
        p50: percentile(finalPrices, 50),
        p75: percentile(finalPrices, 75),
        p90: percentile(finalPrices, 90),
        p95: percentile(finalPrices, 95)
    };
    
    // Expected move (1 std dev)
    const stdDev = Math.sqrt(finalPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / numPaths);
    const expectedMove = spot * vol * Math.sqrt(T);
    
    return {
        finalPrices,
        paths,
        otmPercent: parseFloat(otmPercent),
        itmPercent: parseFloat(itmPercent),
        median,
        mean,
        stdDev,
        expectedMove,
        percentiles,
        numPaths,
        spot,
        strike,
        dte
    };
}

/**
 * Standard normal random using Box-Muller
 */
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Display Monte Carlo results in the UI
 */
function displayMonteCarloResults(results, spot, strike, dte, iv) {
    // Show all hidden elements
    document.getElementById('mcTitle').style.display = 'block';
    document.getElementById('mcConeTitle').style.display = 'block';
    document.getElementById('mcDistributionCanvas').style.display = 'block';
    document.getElementById('mcConeCanvas').style.display = 'block';
    document.getElementById('mcStatsGrid').style.display = 'grid';
    document.getElementById('mcPercentiles').style.display = 'block';
    
    // Update stats
    document.getElementById('mcOtmPct').textContent = results.otmPercent.toFixed(1) + '%';
    document.getElementById('mcItmPct').textContent = results.itmPercent.toFixed(1) + '%';
    document.getElementById('mcMedianPrice').textContent = '$' + results.median.toFixed(2);
    document.getElementById('mcExpectedMove').textContent = '±$' + results.expectedMove.toFixed(2);
    
    // Update percentiles
    document.getElementById('mcP5').textContent = '$' + results.percentiles.p5.toFixed(2);
    document.getElementById('mcP10').textContent = '$' + results.percentiles.p10.toFixed(2);
    document.getElementById('mcP25').textContent = '$' + results.percentiles.p25.toFixed(2);
    document.getElementById('mcP50').textContent = '$' + results.percentiles.p50.toFixed(2);
    document.getElementById('mcP75').textContent = '$' + results.percentiles.p75.toFixed(2);
    document.getElementById('mcP90').textContent = '$' + results.percentiles.p90.toFixed(2);
    document.getElementById('mcP95').textContent = '$' + results.percentiles.p95.toFixed(2);
    
    // Color percentiles based on strike
    ['mcP5', 'mcP10', 'mcP25', 'mcP50', 'mcP75', 'mcP90', 'mcP95'].forEach(id => {
        const el = document.getElementById(id);
        const val = parseFloat(el.textContent.replace('$', ''));
        if (val < strike) {
            el.style.color = '#ff5252';  // ITM = red
        } else {
            el.style.color = '#00ff88';  // OTM = green
        }
    });
    
    // Draw distribution histogram
    drawDistributionHistogram(results, strike);
    
    // Draw probability cone
    drawProbabilityConeChart(results, spot, strike);
    
    // Update risk scenarios
    updateRiskScenarios(results, spot, strike);
    
    // Update profit analysis
    updateProfitAnalysis(results, spot, strike, dte);
}

/**
 * Draw price distribution histogram
 */
function drawDistributionHistogram(results, strike) {
    const canvas = document.getElementById('mcDistributionCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, W, H);
    
    // Create bins
    const prices = results.finalPrices;
    const minPrice = Math.min(...prices) * 0.95;
    const maxPrice = Math.max(...prices) * 1.05;
    const numBins = 50;
    const binWidth = (maxPrice - minPrice) / numBins;
    
    const bins = new Array(numBins).fill(0);
    prices.forEach(p => {
        const binIdx = Math.min(numBins - 1, Math.floor((p - minPrice) / binWidth));
        bins[binIdx]++;
    });
    
    const maxCount = Math.max(...bins);
    const barWidth = (W - 60) / numBins;
    
    // Draw bars
    bins.forEach((count, i) => {
        const x = 40 + i * barWidth;
        const barHeight = (count / maxCount) * (H - 40);
        const priceAtBin = minPrice + (i + 0.5) * binWidth;
        
        // Color based on strike
        if (priceAtBin < strike) {
            ctx.fillStyle = 'rgba(255,82,82,0.6)';  // ITM = red
        } else {
            ctx.fillStyle = 'rgba(0,255,136,0.6)';  // OTM = green
        }
        
        ctx.fillRect(x, H - 20 - barHeight, barWidth - 1, barHeight);
    });
    
    // Draw strike line
    const strikeX = 40 + ((strike - minPrice) / (maxPrice - minPrice)) * (W - 60);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(strikeX, 10);
    ctx.lineTo(strikeX, H - 20);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Label strike
    ctx.fillStyle = '#ffaa00';
    ctx.font = '11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Strike $' + strike.toFixed(0), strikeX, H - 5);
    
    // Axis labels
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('$' + minPrice.toFixed(0), 40, H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('$' + maxPrice.toFixed(0), W - 20, H - 5);
    
    // Median line
    const medianX = 40 + ((results.median - minPrice) / (maxPrice - minPrice)) * (W - 60);
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(medianX, 10);
    ctx.lineTo(medianX, H - 20);
    ctx.stroke();
    ctx.setLineDash([]);
}

/**
 * Draw probability cone showing percentile bands over time
 */
function drawProbabilityConeChart(results, spot, strike) {
    const canvas = document.getElementById('mcConeCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const padding = { left: 50, right: 20, top: 20, bottom: 25 };
    
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, 0, W, H);
    
    const paths = results.paths;
    if (paths.length === 0) return;
    
    const steps = paths[0].length;
    const chartW = W - padding.left - padding.right;
    const chartH = H - padding.top - padding.bottom;
    
    // Calculate percentile bands at each time step
    const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    
    for (let t = 0; t < steps; t++) {
        const pricesAtT = paths.map(p => p[t]).sort((a, b) => a - b);
        const n = pricesAtT.length;
        bands.p5.push(pricesAtT[Math.floor(n * 0.05)]);
        bands.p25.push(pricesAtT[Math.floor(n * 0.25)]);
        bands.p50.push(pricesAtT[Math.floor(n * 0.50)]);
        bands.p75.push(pricesAtT[Math.floor(n * 0.75)]);
        bands.p95.push(pricesAtT[Math.floor(n * 0.95)]);
    }
    
    // Find price range
    const allPrices = [...bands.p5, ...bands.p95];
    const minP = Math.min(...allPrices) * 0.95;
    const maxP = Math.max(...allPrices) * 1.05;
    
    const toX = (t) => padding.left + (t / (steps - 1)) * chartW;
    const toY = (p) => padding.top + (1 - (p - minP) / (maxP - minP)) * chartH;
    
    // Draw 5-95 band (light fill)
    ctx.fillStyle = 'rgba(139,92,246,0.15)';
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p5[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p5[t]));
    for (let t = steps - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(bands.p95[t]));
    ctx.closePath();
    ctx.fill();
    
    // Draw 25-75 band (darker fill)
    ctx.fillStyle = 'rgba(139,92,246,0.3)';
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p25[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p25[t]));
    for (let t = steps - 1; t >= 0; t--) ctx.lineTo(toX(t), toY(bands.p75[t]));
    ctx.closePath();
    ctx.fill();
    
    // Draw median line
    ctx.strokeStyle = '#00d9ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(bands.p50[0]));
    for (let t = 1; t < steps; t++) ctx.lineTo(toX(t), toY(bands.p50[t]));
    ctx.stroke();
    
    // Draw strike line
    if (strike >= minP && strike <= maxP) {
        ctx.strokeStyle = '#ffaa00';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(padding.left, toY(strike));
        ctx.lineTo(W - padding.right, toY(strike));
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Label
        ctx.fillStyle = '#ffaa00';
        ctx.font = '10px Arial';
        ctx.textAlign = 'right';
        ctx.fillText('Strike $' + strike.toFixed(0), W - padding.right, toY(strike) - 3);
    }
    
    // Draw current spot line
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, toY(spot));
    ctx.lineTo(padding.left + 20, toY(spot));
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Axes
    ctx.fillStyle = '#888';
    ctx.font = '10px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('$' + maxP.toFixed(0), 5, padding.top + 10);
    ctx.fillText('$' + minP.toFixed(0), 5, H - padding.bottom);
    
    ctx.textAlign = 'center';
    ctx.fillText('Today', padding.left, H - 5);
    ctx.fillText('Expiry', W - padding.right, H - 5);
    
    // Legend
    ctx.fillStyle = '#7a8a94';
    ctx.fillText('50% of outcomes in dark band, 90% in light band', W / 2, 12);
}

/**
 * Update risk scenarios panel
 */
function updateRiskScenarios(results, spot, strike) {
    const el = document.getElementById('mcRiskScenarios');
    if (!el) return;
    
    const { percentiles, itmPercent } = results;
    
    // Worst case (5th percentile)
    const worstDrop = ((spot - percentiles.p5) / spot * 100).toFixed(1);
    const worstLoss = Math.max(0, (strike - percentiles.p5) * 100).toFixed(0);
    
    // 10th percentile drop
    const drop10 = ((spot - percentiles.p10) / spot * 100).toFixed(1);
    
    el.innerHTML = `
        <div style="margin-bottom:6px;">
            <span style="color:#ff5252;">🔻 5% worst case:</span> Stock at $${percentiles.p5.toFixed(2)} (−${worstDrop}%)
            ${percentiles.p5 < strike ? `<br>&nbsp;&nbsp;&nbsp;→ Assignment loss: ~$${worstLoss}/contract` : ''}
        </div>
        <div style="margin-bottom:6px;">
            <span style="color:#ffaa00;">⚠️ 10% bad case:</span> Stock at $${percentiles.p10.toFixed(2)} (−${drop10}%)
        </div>
        <div>
            <span style="color:#888;">📊 ITM probability:</span> ${itmPercent.toFixed(1)}% chance of assignment
        </div>
    `;
}

/**
 * Update profit analysis panel
 */
function updateProfitAnalysis(results, spot, strike, dte) {
    const el = document.getElementById('mcProfitAnalysis');
    if (!el) return;
    
    const { otmPercent, percentiles, median } = results;
    
    // Expected outcome
    const medianReturn = ((median - spot) / spot * 100).toFixed(1);
    const gainScenario = ((percentiles.p75 - spot) / spot * 100).toFixed(1);
    
    el.innerHTML = `
        <div style="margin-bottom:6px;">
            <span style="color:#00ff88;">✅ OTM probability:</span> ${otmPercent.toFixed(1)}% chance to keep full premium
        </div>
        <div style="margin-bottom:6px;">
            <span style="color:#00d9ff;">📊 Median outcome:</span> Stock at $${median.toFixed(2)} (${medianReturn >= 0 ? '+' : ''}${medianReturn}%)
        </div>
        <div>
            <span style="color:#00ff88;">🎯 75% best case:</span> Stock at $${percentiles.p75.toFixed(2)} or higher
        </div>
    `;
}

/**
 * Initialize Monte Carlo tab when activated
 */
window.initMonteCarloTab = function() {
    // Update UI with current state values
    const mcBanner = document.getElementById('mcPositionBanner');
    const mcNoPos = document.getElementById('mcNoPosition');
    const mcParams = document.getElementById('mcParamsBox');
    
    if (!state.spot || state.spot <= 0) {
        // No position loaded
        if (mcBanner) mcBanner.style.display = 'none';
        if (mcNoPos) mcNoPos.style.display = 'block';
        if (mcParams) mcParams.style.display = 'none';
        return;
    }
    
    // Position is loaded - show it
    if (mcBanner) mcBanner.style.display = 'block';
    if (mcNoPos) mcNoPos.style.display = 'none';
    if (mcParams) mcParams.style.display = 'block';
    
    // Update ticker info
    const ticker = state.currentTicker || 'Unknown';
    document.getElementById('mcPositionTicker').textContent = ticker;
    document.getElementById('mcPositionDetails').textContent = 
        `$${state.strike?.toFixed(2) || '—'} put, ${state.dte || '—'} DTE`;
    
    // Update params
    document.getElementById('mcSpot').textContent = '$' + (state.spot?.toFixed(2) || '—');
    document.getElementById('mcStrike').textContent = '$' + (state.strike?.toFixed(2) || '—');
    document.getElementById('mcIV').textContent = ((state.optVol || 0) * 100).toFixed(0) + '%';
    document.getElementById('mcDTE').textContent = (state.dte || '—') + ' days';
};

// ES module exports
export const runMonteCarloRisk = window.runMonteCarloRisk;
export const initMonteCarloTab = window.initMonteCarloTab;
