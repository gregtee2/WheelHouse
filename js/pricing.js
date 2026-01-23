// WheelHouse - Options Pricing Module
// Black-Scholes, Monte Carlo pricing, and Greeks

import { state } from './state.js';
import { randomNormal, erf } from './utils.js';
import { drawPayoffChart, drawPriceHist, drawGreeksChart, drawPnLChart, drawProbabilityCone, drawHeatMap } from './charts.js';
import { generateRecommendation, calculateExpectedValue } from './analysis.js';

/**
 * Black-Scholes option price calculation
 */
export function bsPrice(S, K, T, r, sigma, isPut) {
    if (T <= 0.001) {
        return isPut ? Math.max(0, K - S) : Math.max(0, S - K);
    }
    const d1 = (Math.log(S/K) + (r + sigma*sigma/2)*T) / (sigma*Math.sqrt(T));
    const d2 = d1 - sigma*Math.sqrt(T);
    const Nd1 = 0.5 * (1 + erf(d1/Math.sqrt(2)));
    const Nd2 = 0.5 * (1 + erf(d2/Math.sqrt(2)));
    if (isPut) {
        return K * Math.exp(-r*T) * (1-Nd2) - S * (1-Nd1);
    } else {
        return S * Nd1 - K * Math.exp(-r*T) * Nd2;
    }
}

/**
 * Monte Carlo option pricing at given parameters
 */
async function priceAtParams(S0, vol, paths) {
    let callSum = 0, putSum = 0;
    
    const T = state.dte / 365.25;
    const numSteps = 50;
    const dt = T / numSteps;
    
    for (let i = 0; i < paths; i++) {
        let S = S0;
        
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormal() * Math.sqrt(dt);
            S *= Math.exp((state.rate - 0.5*vol*vol)*dt + vol*dW);
        }
        
        const disc = Math.exp(-state.rate * T);
        callSum += Math.max(S - state.strike, 0) * disc;
        putSum += Math.max(state.strike - S, 0) * disc;
    }
    return { call: callSum/paths, put: putSum/paths };
}

/**
 * Main Monte Carlo option pricing
 * If Sync checkbox is enabled, fetches live spot/IV from CBOE first
 */
export async function priceOptions() {
    const optRunning = document.getElementById('optRunning');
    if (optRunning) optRunning.classList.add('active');
    await new Promise(r => setTimeout(r, 10));
    
    // Sync live data if enabled (updates state.spot and state.optVol)
    const syncCheckbox = document.getElementById('syncCheckbox');
    if (syncCheckbox?.checked && window.syncLiveOptionsData) {
        try {
            await window.syncLiveOptionsData();
        } catch (e) {
            console.warn('Live sync failed, using manual values:', e.message);
        }
    }
    
    let callSum = 0, putSum = 0;
    let belowStrikeCount = 0, aboveStrikeCount = 0;
    const finalPrices = [];
    
    const T = state.dte / 365.25;
    const numSteps = 100;
    const dt = T / numSteps;
    
    for (let i = 0; i < state.mcPaths; i++) {
        let S = state.spot;
        
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormal() * Math.sqrt(dt);
            S *= Math.exp((state.rate - 0.5*state.optVol*state.optVol)*dt + state.optVol*dW);
        }
        
        finalPrices.push(S);
        
        if (S < state.strike) {
            belowStrikeCount++;
        } else {
            aboveStrikeCount++;
        }
        
        const discount = Math.exp(-state.rate * T);
        callSum += Math.max(S - state.strike, 0) * discount;
        putSum += Math.max(state.strike - S, 0) * discount;
    }
    
    const callPrice = callSum / state.mcPaths;
    const putPrice = putSum / state.mcPaths;
    
    // Update UI with null checks
    const callPriceEl = document.getElementById('callPrice');
    const putPriceEl = document.getElementById('putPrice');
    const optTauEl = document.getElementById('optTau');
    const optLowerEl = document.getElementById('optLower');
    const optUpperEl = document.getElementById('optUpper');
    const priceSourceEl = document.getElementById('priceSource');
    
    // Only update prices if we didn't already show live prices
    const showedLivePrices = syncCheckbox?.checked && state.liveOptionData?.callOption;
    
    if (!showedLivePrices) {
        if (callPriceEl) {
            callPriceEl.textContent = '$' + callPrice.toFixed(2);
            callPriceEl.title = 'Monte Carlo calculated';
        }
        if (putPriceEl) {
            putPriceEl.textContent = '$' + putPrice.toFixed(2);
            putPriceEl.title = 'Monte Carlo calculated';
        }
        if (priceSourceEl) {
            priceSourceEl.textContent = '🧮 Calculated';
            priceSourceEl.style.color = '#888';
        }
    }
    
    if (optTauEl) optTauEl.textContent = state.dte.toFixed(1) + ' days';
    if (optLowerEl) optLowerEl.textContent = (belowStrikeCount/state.mcPaths*100).toFixed(1) + '%';
    if (optUpperEl) optUpperEl.textContent = (aboveStrikeCount/state.mcPaths*100).toFixed(1) + '%';
    
    state.optionResults = { callPrice, putPrice, avgTau: state.dte, finalPrices, belowStrikeCount, aboveStrikeCount };
    
    drawPayoffChart();
    drawPriceHist(finalPrices);
    generateRecommendation(belowStrikeCount/state.mcPaths*100, aboveStrikeCount/state.mcPaths*100, state.dte);
    calculateExpectedValue();
    drawPnLChart();
    drawProbabilityCone();
    
    const heatMapSpot = document.getElementById('heatMapSpot');
    if (heatMapSpot) heatMapSpot.value = state.spot.toFixed(2);
    drawHeatMap();
    
    if (optRunning) optRunning.classList.remove('active');
}

/**
 * Calculate Greeks using finite differences
 */
export async function calcGreeks() {
    const greekRunning = document.getElementById('greekRunning');
    if (greekRunning) greekRunning.classList.add('active');
    await new Promise(r => setTimeout(r, 10));
    
    const bumpSlider = document.getElementById('bumpSlider');
    const bump = bumpSlider ? parseFloat(bumpSlider.value) : 0.01;
    const paths = Math.min(state.mcPaths, 5000);
    
    const base = await priceAtParams(state.spot, state.optVol, paths);
    const upSpot = await priceAtParams(state.spot * (1 + bump), state.optVol, paths);
    const downSpot = await priceAtParams(state.spot * (1 - bump), state.optVol, paths);
    
    const callDelta = (upSpot.call - downSpot.call) / (2 * state.spot * bump);
    const putDelta = (upSpot.put - downSpot.put) / (2 * state.spot * bump);
    const callGamma = (upSpot.call - 2*base.call + downSpot.call) / Math.pow(state.spot * bump, 2);
    const putGamma = (upSpot.put - 2*base.put + downSpot.put) / Math.pow(state.spot * bump, 2);
    
    const upVol = await priceAtParams(state.spot, state.optVol + bump, paths);
    const downVol = await priceAtParams(state.spot, state.optVol - bump, paths);
    const callVega = (upVol.call - downVol.call) / (2 * bump) / 100;
    const putVega = (upVol.put - downVol.put) / (2 * bump) / 100;
    
    // Update UI with null checks
    const callDeltaEl = document.getElementById('callDelta');
    const callGammaEl = document.getElementById('callGamma');
    const callVegaEl = document.getElementById('callVega');
    const putDeltaEl = document.getElementById('putDelta');
    const putGammaEl = document.getElementById('putGamma');
    const putVegaEl = document.getElementById('putVega');
    
    if (callDeltaEl) callDeltaEl.textContent = callDelta.toFixed(4);
    if (callGammaEl) callGammaEl.textContent = callGamma.toFixed(4);
    if (callVegaEl) callVegaEl.textContent = callVega.toFixed(4);
    if (putDeltaEl) putDeltaEl.textContent = putDelta.toFixed(4);
    if (putGammaEl) putGammaEl.textContent = putGamma.toFixed(4);
    if (putVegaEl) putVegaEl.textContent = putVega.toFixed(4);
    
    drawGreeksChart(callDelta, putDelta);
    if (greekRunning) greekRunning.classList.remove('active');
}

/**
 * Get position type from context or heuristic
 */
export function getPositionType() {
    if (state.currentPositionContext?.type) {
        const type = state.currentPositionContext.type;
        
        // Buy/Write = Long stock + Short call (covered call at entry)
        // Covered Call = Short call against existing shares
        const isBuyWrite = type === 'buy_write';
        const isCoveredCall = type === 'covered_call' || isBuyWrite;
        const isLongCall = type === 'long_call' || type === 'long_call_leaps';
        const isLongPut = type === 'long_put' || type === 'long_put_leaps';
        const isLong = isLongCall || isLongPut;
        
        return {
            isPut: type.includes('put'),
            isShort: type.includes('short') || isCoveredCall, // CC/BW is short the call
            isLong: isLong,
            isLongCall: isLongCall,
            isLongPut: isLongPut,
            isBuyWrite: isBuyWrite,
            isCoveredCall: isCoveredCall,
            source: 'position'
        };
    }
    
    return {
        isPut: state.spot <= state.strike,
        isShort: true,
        isLong: false,
        isLongCall: false,
        isLongPut: false,
        isBuyWrite: false,
        isCoveredCall: false,
        source: 'heuristic'
    };
}

/**
 * What-If Scenario Calculator
 * Projects option value at a target price and date using Black-Scholes
 */
export function calculateWhatIf() {
    const targetPrice = parseFloat(document.getElementById('whatIfPrice')?.value);
    const targetDateStr = document.getElementById('whatIfDate')?.value;
    const targetIV = parseFloat(document.getElementById('whatIfIV')?.value) / 100 || state.optVol / 100;
    
    if (!targetPrice || !targetDateStr) {
        alert('Please enter both target price and target date');
        return;
    }
    
    const targetDate = new Date(targetDateStr);
    const today = new Date();
    const expiryDate = state.currentPositionContext?.expiry ? new Date(state.currentPositionContext.expiry) : null;
    
    if (!expiryDate) {
        // Fall back to DTE-based expiry
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + state.dte);
    }
    
    // Calculate new DTE from target date to expiry
    const actualExpiry = expiryDate || (() => {
        const e = new Date();
        e.setDate(e.getDate() + state.dte);
        return e;
    })();
    
    const newDTE = Math.max(1, Math.ceil((actualExpiry - targetDate) / (1000 * 60 * 60 * 24)));
    const T = newDTE / 365.25;
    
    // Determine if put or call
    const posType = getPositionType();
    const isPut = posType.isPut;
    const isLong = posType.isLong;
    
    // Calculate projected option price using Black-Scholes
    const r = 0.05; // Risk-free rate
    const projectedValue = bsPrice(targetPrice, state.strike, T, r, targetIV, isPut);
    
    // Get current option value
    const currentValueEl = isPut ? document.getElementById('putPrice') : document.getElementById('callPrice');
    const currentValue = parseFloat(currentValueEl?.textContent?.replace('$', '') || '0') || 
                         state.currentPositionContext?.premium || 0;
    
    // Calculate intrinsic and time value
    const intrinsic = isPut ? 
        Math.max(0, state.strike - targetPrice) : 
        Math.max(0, targetPrice - state.strike);
    const timeValue = Math.max(0, projectedValue - intrinsic);
    
    // Calculate gain/loss
    const contracts = state.currentPositionContext?.contracts || 1;
    const costBasis = state.currentPositionContext?.premium || currentValue;
    
    let gainLoss, returnPct;
    if (isLong) {
        // Long option: you paid premium, profit = new value - cost
        gainLoss = (projectedValue - costBasis) * 100 * contracts;
        returnPct = costBasis > 0 ? ((projectedValue - costBasis) / costBasis * 100) : 0;
    } else {
        // Short option: you received premium, profit = premium - close cost
        gainLoss = (costBasis - projectedValue) * 100 * contracts;
        returnPct = costBasis > 0 ? ((costBasis - projectedValue) / costBasis * 100) : 0;
    }
    
    // Update UI
    const resultsDiv = document.getElementById('whatIfResults');
    if (resultsDiv) resultsDiv.style.display = 'block';
    
    const setEl = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    
    setEl('whatIfValue', `$${projectedValue.toFixed(2)}`);
    setEl('whatIfCurrent', `$${currentValue.toFixed(2)}`);
    
    const gainEl = document.getElementById('whatIfGain');
    if (gainEl) {
        gainEl.textContent = `${gainLoss >= 0 ? '+' : ''}$${gainLoss.toFixed(0)}`;
        gainEl.style.color = gainLoss >= 0 ? '#00ff88' : '#ff5252';
    }
    
    const returnEl = document.getElementById('whatIfReturn');
    if (returnEl) {
        returnEl.textContent = `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`;
        returnEl.style.color = returnPct >= 0 ? '#00ff88' : '#ff5252';
    }
    
    setEl('whatIfIntrinsic', `$${intrinsic.toFixed(2)}`);
    setEl('whatIfTimeValue', `$${timeValue.toFixed(2)}`);
    setEl('whatIfDTE', `${newDTE} days`);
    
    console.log(`[WHAT-IF] Target: $${targetPrice} by ${targetDateStr}, IV: ${(targetIV*100).toFixed(1)}%`);
    console.log(`[WHAT-IF] Projected: $${projectedValue.toFixed(2)}, Current: $${currentValue.toFixed(2)}, Gain: $${gainLoss.toFixed(0)}`);
}

// Expose to window for HTML onclick
window.calculateWhatIf = calculateWhatIf;
