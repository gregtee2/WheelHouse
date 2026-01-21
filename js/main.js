// WheelHouse - Main Entry Point
// Initialization and tab management

import { state, resetSimulation } from './state.js';
import { draw, drawPayoffChart, drawHistogram, drawPnLChart, drawProbabilityCone, drawHeatMap, drawGreeksChart } from './charts.js';
import { runSingle, runBatch, resetAll } from './simulation.js';
import { priceOptions, calcGreeks } from './pricing.js';
import { calculateRoll, generateRecommendation, suggestOptimalRoll } from './analysis.js';
import { fetchTickerPrice, fetchHeatMapPrice, fetchPositionTickerPrice } from './api.js';
import { loadPositions, addPosition, editPosition, cancelEdit, renderPositions, updatePortfolioSummary } from './positions.js';
import { loadClosedPositions, renderPortfolio, renderHoldings } from './portfolio.js';
import { initChallenges, renderChallenges } from './challenges.js';
import { setupSliders, setupDatePicker, setupPositionDatePicker, setupRollDatePicker, updateDteDisplay, updateResults, updateDataTab, syncToSimulator } from './ui.js';
import { showNotification } from './utils.js';

/**
 * Main initialization
 */
export function init() {
    console.log('🏠 WheelHouse - Wheel Strategy Options Analyzer');
    
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
    initChallenges();
    
    // Check for updates (after a short delay to not block init)
    setTimeout(checkForUpdates, 2000);
    
    // Check AI availability (show/hide AI panel)
    setTimeout(checkAIAvailability, 1000);
    
    console.log('✅ Initialization complete');
}

/**
 * Check if AI Trade Advisor (Ollama) is available
 */
async function checkAIAvailability() {
    const aiPanel = document.getElementById('aiInsightsPanel');
    const aiBtn = document.getElementById('aiInsightBtn');
    const aiContent = document.getElementById('aiInsightContent');
    const modelSelect = document.getElementById('aiModelSelect');
    const modelStatus = document.getElementById('aiModelStatus');
    
    if (!aiPanel) return;
    
    // Restore saved model preference
    const savedModel = localStorage.getItem('wheelhouse_ai_model') || 'qwen2.5:7b';
    if (modelSelect) {
        modelSelect.value = savedModel;
    }
    
    try {
        const res = await fetch('/api/ai/status');
        if (!res.ok) throw new Error('API error');
        
        const data = await res.json();
        
        if (data.available) {
            // AI is ready - show which models are available
            const models = data.models || [];
            const modelNames = models.map(m => m.name);
            console.log('🧠 AI Trade Advisor: Ready. Available models:', modelNames.join(', '));
            
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '1';
            
            // Update model dropdown to show installed status
            if (modelSelect) {
                Array.from(modelSelect.options).forEach(opt => {
                    const isInstalled = modelNames.some(m => m.startsWith(opt.value.split(':')[0]));
                    opt.textContent = opt.textContent.replace(' ✓', '').replace(' (not installed)', '');
                    if (isInstalled) {
                        opt.textContent += ' ✓';
                        opt.disabled = false;
                    } else {
                        opt.textContent += ' (not installed)';
                        opt.disabled = true;
                    }
                });
            }
            
            if (aiContent) {
                aiContent.innerHTML = `Click <b>Get Insight</b> after loading a position for AI-powered analysis.`;
            }
        } else {
            // Ollama not running
            console.log('🧠 AI Trade Advisor: Ollama not running (AI features disabled)');
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '0.5';
            if (aiContent) {
                aiContent.innerHTML = `<span style="color:#888;">AI not available.</span><br>
                    <span style="font-size:10px;">Install Ollama from <a href="https://ollama.com" target="_blank" style="color:#00d9ff;">ollama.com</a> for AI insights.</span>`;
            }
            if (aiBtn) {
                aiBtn.disabled = true;
                aiBtn.title = 'Ollama not running';
            }
            if (modelSelect) modelSelect.disabled = true;
        }
    } catch (e) {
        // Server doesn't support AI endpoint - hide panel entirely
        console.log('🧠 AI Trade Advisor: Not available');
        if (aiPanel) aiPanel.style.display = 'none';
    }
}

/**
 * Save AI model preference to localStorage
 */
window.saveAIModelPreference = function() {
    const modelSelect = document.getElementById('aiModelSelect');
    if (modelSelect) {
        localStorage.setItem('wheelhouse_ai_model', modelSelect.value);
        console.log('AI model preference saved:', modelSelect.value);
    }
};

/**
 * Check for updates from GitHub
 */
async function checkForUpdates() {
    try {
        const res = await fetch('/api/update/check');
        if (!res.ok) return;
        
        const data = await res.json();
        if (data.updateAvailable) {
            console.log(`🆕 Update available: v${data.localVersion} → v${data.remoteVersion}`);
            showUpdateToast(data);
        } else {
            console.log(`✅ WheelHouse v${data.localVersion} is up to date`);
        }
    } catch (e) {
        console.log('Could not check for updates:', e.message);
    }
}

/**
 * Show update notification toast
 */
function showUpdateToast(data) {
    // Remove existing toast if any
    const existing = document.getElementById('update-toast');
    if (existing) existing.remove();
    
    // Parse changelog to get the latest version's changes
    const changelogSummary = parseChangelog(data.changelog, data.remoteVersion);
    
    const toast = document.createElement('div');
    toast.id = 'update-toast';
    toast.innerHTML = `
        <div class="update-toast-header">
            <span class="update-toast-icon">🆕</span>
            <span class="update-toast-title">Update Available!</span>
            <button class="update-toast-close" onclick="this.closest('#update-toast').remove()">✕</button>
        </div>
        <div class="update-toast-version">
            v${data.localVersion} → <span style="color: #00ff88;">v${data.remoteVersion}</span>
        </div>
        <div class="update-toast-changelog">
            ${changelogSummary}
        </div>
        <div class="update-toast-actions">
            <button class="update-toast-btn update-btn-primary" onclick="applyUpdate()">
                ⬇️ Update Now
            </button>
            <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse/releases', '_blank')">
                📋 View on GitHub
            </button>
            <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                Later
            </button>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => toast.classList.add('show'));
}

/**
 * Parse changelog to extract latest version's changes
 */
function parseChangelog(changelog, version) {
    if (!changelog) return '<em>No changelog available</em>';
    
    // Find the section for this version
    const versionPattern = new RegExp(`## \\[${version.replace(/\./g, '\\.')}\\][^#]*`, 's');
    const match = changelog.match(versionPattern);
    
    if (match) {
        let section = match[0];
        // Convert markdown to simple HTML
        section = section
            .replace(/^## \[.*?\].*$/m, '') // Remove version header
            .replace(/### (.*)/g, '<strong>$1</strong>') // Convert ### headers
            .replace(/- \*\*(.*?)\*\*/g, '• <strong>$1</strong>') // Bold items
            .replace(/- (.*)/g, '• $1') // Convert list items
            .replace(/\n\n+/g, '<br>') // Convert double newlines
            .replace(/\n/g, ' ') // Remove single newlines
            .trim();
        
        // Limit length
        if (section.length > 400) {
            section = section.substring(0, 400) + '...';
        }
        return section || '<em>See GitHub for details</em>';
    }
    
    return '<em>See GitHub for full changelog</em>';
}

/**
 * Apply update via git pull
 */
window.applyUpdate = async function() {
    const toast = document.getElementById('update-toast');
    const actionsDiv = toast?.querySelector('.update-toast-actions');
    
    if (actionsDiv) {
        actionsDiv.innerHTML = `
            <div style="color: #00d9ff; display: flex; align-items: center; gap: 8px;">
                <div class="update-spinner"></div>
                Updating...
            </div>
        `;
    }
    
    try {
        const res = await fetch('/api/update/apply', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
            if (actionsDiv) {
                actionsDiv.innerHTML = `
                    <div style="color: #00ff88;">
                        ✅ Updated to v${data.newVersion}!
                    </div>
                    <button class="update-toast-btn update-btn-primary" onclick="location.reload()">
                        🔄 Reload Page
                    </button>
                `;
            }
            showNotification(`Updated to v${data.newVersion}! Reload to apply.`, 'success');
        } else {
            throw new Error(data.error || 'Update failed');
        }
    } catch (e) {
        if (actionsDiv) {
            actionsDiv.innerHTML = `
                <div style="color: #ff5252; margin-bottom: 8px;">
                    ❌ ${e.message}
                </div>
                <button class="update-toast-btn update-btn-secondary" onclick="window.open('https://github.com/gregtee2/WheelHouse', '_blank')">
                    📥 Manual Download
                </button>
                <button class="update-toast-btn update-btn-dismiss" onclick="this.closest('#update-toast').remove()">
                    Close
                </button>
            `;
        }
        showNotification('Update failed: ' + e.message, 'error');
    }
};

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
                // Auto-run pricing if not already done
                if (!state.optionResults?.finalPrices) {
                    priceOptions().then(() => {
                        drawPnLChart();
                        drawProbabilityCone();
                        drawHeatMap();
                    });
                } else {
                    drawPnLChart();
                    drawProbabilityCone();
                    drawHeatMap();
                }
            } else if (targetId === 'greeks') {
                // Greeks will be drawn when pricing is run
            } else if (targetId === 'data') {
                updateDataTab();
            } else if (targetId === 'positions') {
                renderPositions();
                updatePortfolioSummary();
            } else if (targetId === 'challenges') {
                renderChallenges();
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
    
    // Suggest optimal roll button
    const suggestRollBtn = document.getElementById('suggestRollBtn');
    if (suggestRollBtn) {
        suggestRollBtn.addEventListener('click', suggestOptimalRoll);
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
