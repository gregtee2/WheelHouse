// WheelHouse - UI Module
// Event handlers, sliders, date pickers, display updates

import { state } from './state.js';
import { download, formatCurrency, showNotification } from './utils.js';
import { draw, drawPayoffChart, drawPriceHist, drawGreeksChart, drawPnLChart, drawProbabilityCone, drawHeatMap } from './charts.js';
import { priceOptions, calcGreeks } from './pricing.js';
import { calculateExpectedValue, calculateRoll, generateRecommendation } from './analysis.js';
import { runSingle, runBatch } from './simulation.js';

/**
 * Setup all slider bindings
 */
export function setupSliders() {
    // Simulator sliders
    bindSlider('pSlider', 'pInput', (v) => { state.p = parseFloat(v); draw(); });
    bindSlider('qSlider', 'qInput', (v) => { state.q = parseFloat(v); draw(); });
    bindSlider('sigmaSlider', 'sigmaInput', (v) => { state.sigma = parseFloat(v); draw(); });
    
    // Options sliders
    bindInputSlider('spotSlider', 'spotInput', (v) => { state.spot = parseFloat(v); });
    bindInputSlider('strikeSlider', 'strikeInput', (v) => { state.strike = parseFloat(v); });
    bindInputSlider('lowerSlider', 'lowerInput', (v) => { state.lower = parseFloat(v); drawPayoffChart(); });
    bindInputSlider('upperSlider', 'upperInput', (v) => { state.upper = parseFloat(v); drawPayoffChart(); });
    bindInputSlider('dteSlider', 'dteInput', (v) => { 
        state.dte = parseInt(v); 
        updateDatePickerFromDte();
        updateDteDisplay();
    });
    
    // Volatility slider (special handling for percentage display)
    const optVolSlider = document.getElementById('optVolSlider');
    const optVolInput = document.getElementById('optVolInput');
    if (optVolSlider && optVolInput) {
        optVolSlider.addEventListener('input', (e) => {
            state.optVol = parseFloat(e.target.value);
            optVolInput.value = Math.round(state.optVol * 100);
        });
        optVolInput.addEventListener('change', (e) => {
            state.optVol = parseFloat(e.target.value) / 100;
            optVolSlider.value = state.optVol;
        });
    }
    
    // Paths slider
    const pathsSlider = document.getElementById('pathsSlider');
    const pathsInput = document.getElementById('pathsInput');
    if (pathsSlider && pathsInput) {
        pathsSlider.addEventListener('input', (e) => {
            state.numPaths = parseInt(e.target.value);
            pathsInput.value = state.numPaths.toLocaleString();
        });
    }
}

function bindSlider(sliderId, inputId, callback) {
    const slider = document.getElementById(sliderId);
    const input = document.getElementById(inputId);
    if (!slider || !input) return;
    
    slider.addEventListener('input', (e) => {
        input.value = e.target.value;
        callback(e.target.value);
    });
    input.addEventListener('change', (e) => {
        slider.value = e.target.value;
        callback(e.target.value);
    });
}

function bindInputSlider(sliderId, inputId, callback) {
    const slider = document.getElementById(sliderId);
    const input = document.getElementById(inputId);
    if (!slider || !input) return;
    
    slider.addEventListener('input', (e) => {
        input.value = e.target.value;
        callback(e.target.value);
    });
    input.addEventListener('change', (e) => {
        slider.value = e.target.value;
        callback(e.target.value);
    });
}

/**
 * Setup date picker for expiry
 */
export function setupDatePicker() {
    const picker = document.getElementById('expiryDatePicker');
    if (!picker) return;
    
    // Set default to current DTE
    const today = new Date();
    const expiry = new Date(today);
    expiry.setDate(today.getDate() + state.dte);
    picker.value = expiry.toISOString().split('T')[0];
    
    picker.addEventListener('change', (e) => {
        const selectedDate = new Date(e.target.value);
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        
        const diffTime = selectedDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays > 0) {
            state.dte = diffDays;
            document.getElementById('dteSlider').value = Math.min(diffDays, 365);
            document.getElementById('dteInput').value = diffDays;
            updateDteDisplay();
        }
    });
}

/**
 * Update date picker from DTE value
 */
function updateDatePickerFromDte() {
    const picker = document.getElementById('expiryDatePicker');
    if (!picker) return;
    
    const today = new Date();
    const expiry = new Date(today);
    expiry.setDate(today.getDate() + state.dte);
    picker.value = expiry.toISOString().split('T')[0];
}

/**
 * Update DTE display with days and weeks
 */
export function updateDteDisplay() {
    const weeks = Math.floor(state.dte / 7);
    const days = state.dte % 7;
    const dteDisplay = document.getElementById('dteDisplay');
    if (dteDisplay) {
        dteDisplay.textContent = weeks > 0 ? 
            `${state.dte} days (${weeks}w ${days}d)` : 
            `${state.dte} days`;
    }
}

/**
 * Setup position date picker
 */
export function setupPositionDatePicker() {
    const picker = document.getElementById('posExpiry');
    if (!picker) return;
    
    // Default to 30 days out
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    picker.value = expiry.toISOString().split('T')[0];
}

/**
 * Setup roll date picker
 */
export function setupRollDatePicker() {
    const picker = document.getElementById('rollNewExpiry');
    if (!picker) return;
    
    picker.addEventListener('change', (e) => {
        const selectedDate = new Date(e.target.value);
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        
        const diffTime = selectedDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays > 0) {
            document.getElementById('rollNewDte').value = diffDays;
        }
    });
}

/**
 * Update results display
 */
export function updateResults() {
    // Simulator results
    const batchStats = document.getElementById('batchStats');
    if (batchStats && state.exitTimes.length > 0) {
        const mean = state.exitTimes.reduce((a, b) => a + b, 0) / state.exitTimes.length;
        const sorted = [...state.exitTimes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const min = Math.min(...state.exitTimes);
        const max = Math.max(...state.exitTimes);
        
        batchStats.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px;">
                <div>
                    <div style="color: #888; font-size: 11px;">MEAN</div>
                    <div style="color: #00d9ff; font-size: 18px; font-weight: bold;">${mean.toFixed(2)}</div>
                </div>
                <div>
                    <div style="color: #888; font-size: 11px;">MEDIAN</div>
                    <div style="color: #00d9ff; font-size: 18px; font-weight: bold;">${median.toFixed(2)}</div>
                </div>
                <div>
                    <div style="color: #888; font-size: 11px;">MIN</div>
                    <div style="color: #00ff88; font-size: 18px; font-weight: bold;">${min.toFixed(2)}</div>
                </div>
                <div>
                    <div style="color: #888; font-size: 11px;">MAX</div>
                    <div style="color: #ff5252; font-size: 18px; font-weight: bold;">${max.toFixed(2)}</div>
                </div>
            </div>
            <div style="margin-top: 10px; color: #888; font-size: 12px;">
                Total simulations: ${state.exitTimes.length.toLocaleString()}
            </div>
        `;
    }
}

/**
 * Update data tab with current values
 */
export function updateDataTab() {
    const container = document.getElementById('dataContent');
    if (!container) return;
    
    const data = {
        simulator: {
            p: state.p,
            q: state.q,
            sigma: state.sigma,
            exitTimes: state.exitTimes,
            hitZeroPct: state.hitZeroCount / Math.max(1, state.exitTimes.length) * 100,
            hitOnePct: state.hitOneCount / Math.max(1, state.exitTimes.length) * 100
        },
        options: {
            spot: state.spot,
            strike: state.strike,
            dte: state.dte,
            volatility: state.optVol,
            rate: state.rate,
            lower: state.lower,
            upper: state.upper
        },
        results: state.optionResults
    };
    
    container.innerHTML = `
        <div style="margin-bottom: 20px;">
            <h3 style="color: #00d9ff; margin-bottom: 10px;">Current Parameters</h3>
            <pre style="background: #1a1a2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px;">
${JSON.stringify(data, null, 2)}
            </pre>
        </div>
        <div style="display: flex; gap: 10px;">
            <button onclick="window.exportJSON()" class="btn-primary">📥 Export JSON</button>
            <button onclick="window.exportCSV()" class="btn-primary">📥 Export CSV</button>
            <button onclick="window.copyData()" class="btn-primary">📋 Copy to Clipboard</button>
        </div>
    `;
}

/**
 * Export functions
 */
export function exportJSON() {
    const data = {
        timestamp: new Date().toISOString(),
        parameters: {
            spot: state.spot,
            strike: state.strike,
            dte: state.dte,
            volatility: state.optVol
        },
        results: state.optionResults,
        simulatorResults: {
            exitTimes: state.exitTimes,
            hitZeroCount: state.hitZeroCount,
            hitOneCount: state.hitOneCount
        }
    };
    
    download('wheelhouse_data.json', JSON.stringify(data, null, 2));
    showNotification('Exported JSON file', 'success');
}

export function exportCSV() {
    if (!state.optionResults?.finalPrices) {
        showNotification('No simulation data to export', 'error');
        return;
    }
    
    let csv = 'simulation_id,final_price,pnl\n';
    state.optionResults.finalPrices.forEach((price, i) => {
        const pnl = price >= state.strike ? 
            state.optionResults.putPrice * 100 : 
            (state.optionResults.putPrice - (state.strike - price)) * 100;
        csv += `${i + 1},${price.toFixed(2)},${pnl.toFixed(2)}\n`;
    });
    
    download('wheelhouse_simulations.csv', csv);
    showNotification('Exported CSV file', 'success');
}

export function copyData() {
    const data = {
        spot: state.spot,
        strike: state.strike,
        dte: state.dte,
        volatility: state.optVol,
        callPrice: state.optionResults?.callPrice,
        putPrice: state.optionResults?.putPrice
    };
    
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
        .then(() => showNotification('Copied to clipboard', 'success'))
        .catch(() => showNotification('Failed to copy', 'error'));
}

/**
 * Sync current form values to simulator
 */
export function syncToSimulator() {
    // Calculate p (probability starting point)
    const moneyness = state.spot / state.strike;
    state.p = Math.min(0.95, Math.max(0.05, moneyness - 0.5));
    
    // Calculate volatility-based sigma
    state.sigma = state.optVol / Math.sqrt(252); // Daily sigma from annual vol
    
    // Update sliders
    document.getElementById('pSlider').value = state.p;
    document.getElementById('pInput').value = state.p.toFixed(2);
    document.getElementById('sigmaSlider').value = state.sigma;
    document.getElementById('sigmaInput').value = state.sigma.toFixed(3);
    
    draw();
    showNotification('Synced to simulator', 'info');
}

// Export to window for HTML onclick handlers
window.exportJSON = exportJSON;
window.exportCSV = exportCSV;
window.copyData = copyData;
window.syncToSimulator = syncToSimulator;
