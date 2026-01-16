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
        return {
            isPut: type.includes('put'),
            isShort: type.includes('short'),
            source: 'position'
        };
    }
    
    return {
        isPut: state.spot <= state.strike,
        isShort: true,
        source: 'heuristic'
    };
}
