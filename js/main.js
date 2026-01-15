// WheelHouse - Main Entry Point
// Initialization and tab management

import { state, resetSimulation } from './state.js';
import { draw, drawPayoffChart, drawHistogram, drawPnLChart, drawProbabilityCone, drawHeatMap, drawGreeksChart } from './charts.js';
import { runSingle, runBatch, resetAll } from './simulation.js';
import { priceOptions, calcGreeks } from './pricing.js';
import { calculateRoll, generateRecommendation } from './analysis.js';
import { fetchTickerPrice, fetchHeatMapPrice, fetchPositionTickerPrice } from './api.js';
import { loadPositions, addPosition, editPosition, cancelEdit, renderPositions, updatePortfolioSummary } from './positions.js';
import { loadClosedPositions, renderPortfolio, renderHoldings } from './portfolio.js';
import { setupSliders, setupDatePicker, setupPositionDatePicker, setupRollDatePicker, updateDteDisplay, updateResults, updateDataTab, syncToSimulator } from './ui.js';
import { showNotification } from './utils.js';

/**
 * Main initialization
 */
export function init() {
    console.log('🏠 WheelHouse v1.0.0 - Wheel Strategy Options Analyzer');
    
    // Setup tabs
    setupTabs();
    
    // Setup sliders and controls
    setupSliders();
    setupDatePicker();
    setupPositionDatePicker();
    setupRollDatePicker();
    
    // Setup buttons
    setupButtons();
    
    // Initial draws
    draw();
    drawPayoffChart();
    updateDteDisplay();
    
    // Load saved positions
    loadPositions();
    loadClosedPositions();
    
    console.log('✅ Initialization complete');
}

/**
 * Setup tab switching
 */
function setupTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.tab;
            
            // Update active states
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(targetId)?.classList.add('active');
            
            // Tab-specific initialization
            if (targetId === 'portfolio') {
                renderPortfolio(true); // Fetch fresh prices
            } else if (targetId === 'pnl') {
                drawPnLChart();
                drawProbabilityCone();
                drawHeatMap();
            } else if (targetId === 'greeks') {
                // Greeks will be drawn when pricing is run
            } else if (targetId === 'data') {
                updateDataTab();
            } else if (targetId === 'positions') {
                renderPositions();
                updatePortfolioSummary();
            }
        });
    });
}

/**
 * Setup button event listeners
 */
function setupButtons() {
    // Simulator buttons
    const runSingleBtn = document.getElementById('runSingleBtn');
    const runBatchBtn = document.getElementById('runBatchBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    if (runSingleBtn) {
        runSingleBtn.addEventListener('click', () => {
            runSingle();
            updateResults();
        });
    }
    
    if (runBatchBtn) {
        runBatchBtn.addEventListener('click', () => {
            runBatch();
            updateResults();
        });
    }
    
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetAll();
            updateResults();
        });
    }
    
    // Options pricing button
    const priceBtn = document.getElementById('priceBtn');
    if (priceBtn) {
        priceBtn.addEventListener('click', () => {
            priceOptions();
            drawPayoffChart();
        });
    }
    
    // Greeks button
    const greeksBtn = document.getElementById('greeksBtn');
    if (greeksBtn) {
        greeksBtn.addEventListener('click', calcGreeks);
    }
    
    // Ticker fetch button
    const fetchBtn = document.getElementById('fetchTickerBtn');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', () => {
            const ticker = document.getElementById('tickerInput')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol', 'warning');
            }
        });
    }
    
    // Heat map update button
    const updateHeatMapBtn = document.getElementById('heatMapUpdateBtn');
    if (updateHeatMapBtn) {
        updateHeatMapBtn.addEventListener('click', () => {
            const input = document.getElementById('heatMapSpot');
            const newSpot = parseFloat(input?.value);
            if (!isNaN(newSpot) && newSpot > 0) {
                state.spot = newSpot;
                
                // Update sliders
                const clampedSpot = Math.max(20, Math.min(500, Math.round(state.spot)));
                document.getElementById('spotSlider').value = clampedSpot;
                document.getElementById('spotInput').value = Math.round(state.spot);
                
                // Visual feedback
                input.style.borderColor = '#00ff88';
                setTimeout(() => input.style.borderColor = '', 300);
                
                // Redraw charts
                drawPnLChart();
                drawProbabilityCone();
                drawHeatMap();
            } else {
                input.style.borderColor = '#ff5252';
                setTimeout(() => input.style.borderColor = '', 500);
            }
        });
    }
    
    // Heat map fetch button
    const heatMapFetchBtn = document.getElementById('heatMapFetchBtn');
    if (heatMapFetchBtn) {
        heatMapFetchBtn.addEventListener('click', fetchHeatMapPrice);
    }
    
    // Position ticker fetch button
    const posFetchPriceBtn = document.getElementById('posFetchPriceBtn');
    if (posFetchPriceBtn) {
        posFetchPriceBtn.addEventListener('click', () => {
            const ticker = document.getElementById('posTicker')?.value?.trim()?.toUpperCase();
            if (ticker) {
                fetchPositionTickerPrice(ticker);
            } else {
                showNotification('Enter a ticker symbol first', 'warning');
            }
        });
    }
    
    // Roll calculator button
    const rollBtn = document.getElementById('rollBtn');
    if (rollBtn) {
        rollBtn.addEventListener('click', calculateRoll);
    }
    
    // Add position button
    const addPosBtn = document.getElementById('addPositionBtn');
    if (addPosBtn) {
        addPosBtn.addEventListener('click', addPosition);
    }
    
    // Cancel edit button
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', cancelEdit);
    }
    
    // Roll position buttons
    const executeRollBtn = document.getElementById('executeRollBtn');
    if (executeRollBtn) {
        executeRollBtn.addEventListener('click', () => {
            if (window.executeRoll) window.executeRoll();
        });
    }
    
    const cancelRollBtn = document.getElementById('cancelRollBtn');
    if (cancelRollBtn) {
        cancelRollBtn.addEventListener('click', () => {
            if (window.cancelRoll) window.cancelRoll();
        });
    }
    
    // Close position buttons
    const executeCloseBtn = document.getElementById('executeCloseBtn');
    if (executeCloseBtn) {
        executeCloseBtn.addEventListener('click', () => {
            if (window.executeClose) window.executeClose();
        });
    }
    
    const cancelCloseBtn = document.getElementById('cancelCloseBtn');
    if (cancelCloseBtn) {
        cancelCloseBtn.addEventListener('click', () => {
            if (window.cancelClose) window.cancelClose();
        });
    }
    
    // Expose editPosition to window for inline onclick handlers
    window.editPosition = editPosition;
    
    // Portfolio refresh button
    const refreshPortfolioBtn = document.getElementById('refreshPortfolioBtn');
    if (refreshPortfolioBtn) {
        refreshPortfolioBtn.addEventListener('click', () => renderPortfolio(true));
    }
    
    // Add historical closed position button
    const addClosedBtn = document.getElementById('addClosedPositionBtn');
    if (addClosedBtn) {
        addClosedBtn.addEventListener('click', () => {
            if (window.addHistoricalClosedPosition) {
                window.addHistoricalClosedPosition();
            }
        });
    }
    
    // Sync to simulator button
    const syncBtn = document.getElementById('syncToSimBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', syncToSimulator);
    }
    
    // Clear position context button
    const clearContextBtn = document.getElementById('clearContextBtn');
    if (clearContextBtn) {
        clearContextBtn.addEventListener('click', () => {
            state.currentPositionContext = null;
            const contextEl = document.getElementById('positionContext');
            if (contextEl) contextEl.style.display = 'none';
            showNotification('Cleared position context', 'info');
        });
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for potential external use
export { setupTabs, setupButtons };
