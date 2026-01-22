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
 * Get the next 3rd Friday of the month (standard options expiry)
 * @param {number} monthsAhead - 0 = this month, 1 = next month, etc.
 * @returns {Date} The 3rd Friday date
 */
function getThirdFriday(monthsAhead = 1) {
    const today = new Date();
    let targetMonth = today.getMonth() + monthsAhead;
    let targetYear = today.getFullYear() + Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
    
    // Find 3rd Friday: first day of month, find first Friday, add 14 days
    const firstDay = new Date(targetYear, targetMonth, 1);
    const dayOfWeek = firstDay.getDay();
    const firstFriday = dayOfWeek <= 5 ? (5 - dayOfWeek + 1) : (12 - dayOfWeek + 1);
    const thirdFriday = new Date(targetYear, targetMonth, firstFriday + 14);
    
    // If this month's 3rd Friday already passed, go to next month
    if (thirdFriday <= today && monthsAhead === 0) {
        return getThirdFriday(1);
    }
    
    return thirdFriday;
}

/**
 * Format a date as "Mon DD" (e.g., "Feb 20")
 * @param {Date} date
 * @returns {string}
 */
function formatExpiryShort(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Snap any date string to the nearest valid Friday expiry
 * Options expire on Fridays, never weekends
 * @param {string} dateStr - e.g., "Feb 21" or "Mar 20"
 * @returns {string} Corrected date string, e.g., "Feb 20"
 */
function snapToFriday(dateStr) {
    if (!dateStr) return formatExpiryShort(getThirdFriday(1));
    
    // Parse the date string
    const months = { 'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5, 
                     'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11 };
    const match = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d+)/i);
    if (!match) return dateStr;
    
    const month = months[match[1].toLowerCase()];
    const day = parseInt(match[2]);
    const year = new Date().getFullYear() + (month < new Date().getMonth() ? 1 : 0);
    
    const date = new Date(year, month, day);
    const dayOfWeek = date.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
    
    if (dayOfWeek === 5) {
        return dateStr; // Already Friday
    } else if (dayOfWeek === 6) {
        // Saturday -> go back to Friday
        date.setDate(date.getDate() - 1);
    } else if (dayOfWeek === 0) {
        // Sunday -> go back to Friday
        date.setDate(date.getDate() - 2);
    } else {
        // Weekday -> find nearest Friday (usually go forward)
        const daysToFriday = (5 - dayOfWeek + 7) % 7;
        if (daysToFriday <= 3) {
            date.setDate(date.getDate() + daysToFriday);
        } else {
            date.setDate(date.getDate() - (7 - daysToFriday));
        }
    }
    
    return formatExpiryShort(date);
}

// Expose for use in other places
window.snapToFriday = snapToFriday;
window.getThirdFriday = getThirdFriday;
window.formatExpiryShort = formatExpiryShort;

/**
 * Main initialization
 */
export function init() {
    console.log('🏠 WheelHouse - Wheel Strategy Options Analyzer');
    
    // Setup tabs
    setupTabs();
    
    // Migrate old tab content into new Analyze sub-tabs
    migrateTabContent();
    
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
    
    // Restore collapsed section states
    setTimeout(() => window.restoreCollapsedStates?.(), 100);
    
    // Expose loadPositions to window for staged trade confirmation
    window.loadPositions = loadPositions;
    
    // Render pending trades if any
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
    
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
    const gpuStatusEl = document.getElementById('gpuStatus');
    
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
        
        // Store for other functions to use
        window.aiStatus = data;
        
        // Display GPU info
        if (data.gpu) {
            const gpu = data.gpu;
            console.log(`🎮 GPU: ${gpu.name} (${gpu.totalGB}GB total, ${gpu.freeGB}GB free)`);
            
            // Update GPU status display if element exists
            if (gpuStatusEl) {
                if (gpu.available) {
                    gpuStatusEl.innerHTML = `🎮 <b>${gpu.name}</b> | ${gpu.freeGB}GB free / ${gpu.totalGB}GB`;
                    gpuStatusEl.style.color = '#00ff88';
                } else {
                    gpuStatusEl.innerHTML = `⚠️ No GPU detected - AI will run on CPU (slow)`;
                    gpuStatusEl.style.color = '#ffaa00';
                }
            }
        }
        
        if (data.available) {
            // AI is ready - show which models are available
            const models = data.models || [];
            const modelNames = models.map(m => m.name);
            console.log('🧠 AI Trade Advisor: Ready. Available models:', modelNames.join(', '));
            
            // Log model capabilities
            models.forEach(m => {
                const status = m.canRun ? (m.recommended ? '✅' : '⚠️') : '❌';
                console.log(`   ${status} ${m.name}: ${m.sizeGB}GB (needs ${m.requirements?.minGB || '?'}GB)`);
            });
            
            aiPanel.style.display = 'block';
            aiPanel.style.opacity = '1';
            
            // Update model dropdown to show installed + capability status
            if (modelSelect) {
                // Check if Grok API is configured (check localStorage for saved key)
                const grokConfigured = localStorage.getItem('wheelhouse_grok_configured') === 'true';
                
                Array.from(modelSelect.options).forEach(opt => {
                    // Handle Grok models separately (cloud-based)
                    if (opt.value.startsWith('grok')) {
                        opt.textContent = opt.textContent.replace(/\s*[✓⚠❌].*/g, '').replace(/\s*\(not installed\)/g, '').trim();
                        if (grokConfigured) {
                            opt.textContent += ' ✓';
                            opt.disabled = false;
                            opt.style.color = '#ff6b35'; // Grok orange
                        } else {
                            opt.textContent += ' (configure in Settings)';
                            opt.disabled = true;
                            opt.style.color = '#888';
                        }
                        return;
                    }
                    
                    const modelInfo = models.find(m => m.name === opt.value || m.name.startsWith(opt.value.split(':')[0]));
                    opt.textContent = opt.textContent.replace(/\s*[✓⚠❌].*/g, '').trim();
                    
                    if (modelInfo) {
                        if (!modelInfo.canRun) {
                            opt.textContent += ` ❌ (need ${modelInfo.requirements?.minGB}GB)`;
                            opt.disabled = true;
                            opt.style.color = '#888';
                        } else if (!modelInfo.recommended) {
                            opt.textContent += ' ⚠️ (tight fit)';
                            opt.disabled = false;
                            opt.style.color = '#ffaa00';
                        } else {
                            opt.textContent += ' ✓';
                            opt.disabled = false;
                            opt.style.color = '#00ff88';
                        }
                    } else {
                        opt.textContent += ' (not installed)';
                        opt.disabled = true;
                        opt.style.color = '#888';
                    }
                });
                
                // If saved model can't run, select first available
                const currentOpt = modelSelect.querySelector(`option[value="${savedModel}"]`);
                if (currentOpt?.disabled) {
                    const firstEnabled = Array.from(modelSelect.options).find(o => !o.disabled);
                    if (firstEnabled) {
                        modelSelect.value = firstEnabled.value;
                        localStorage.setItem('wheelhouse_ai_model', firstEnabled.value);
                        showNotification(`Switched to ${firstEnabled.value} (${savedModel} needs more VRAM)`, 'info');
                    }
                }
            }
            
            if (aiContent) {
                aiContent.innerHTML = `Click <b>Get Insight</b> after loading a position for AI-powered analysis.`;
            }
            
            // Check for vision model availability
            if (data.hasVision) {
                console.log('👁️ Vision model available for image parsing');
                window.hasVisionModel = true;
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

// ==========================================
// IMAGE PARSING FUNCTIONS (Broker Screenshots)
// ==========================================

/**
 * Handle image drag & drop
 */
window.handleImageDrop = function(event) {
    event.preventDefault();
    const dropZone = document.getElementById('imageDropZone');
    dropZone.style.borderColor = 'rgba(0,217,255,0.3)';
    dropZone.style.background = 'rgba(0,217,255,0.05)';
    
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        displayImagePreview(file);
    } else {
        showNotification('Please drop an image file', 'error');
    }
};

/**
 * Handle image upload from file input
 */
window.handleImageUpload = function(event) {
    const file = event.target.files[0];
    if (file && file.type.startsWith('image/')) {
        displayImagePreview(file);
    }
};

/**
 * Display image preview
 */
function displayImagePreview(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const preview = document.getElementById('imagePreview');
        const img = document.getElementById('previewImg');
        img.src = e.target.result;
        preview.style.display = 'block';
        // Store base64 for later parsing
        window.pendingImageData = e.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * Handle paste from clipboard (Ctrl+V)
 */
document.addEventListener('paste', async function(event) {
    // Only handle if we're on the Ideas tab
    const ideasTab = document.getElementById('ideas');
    if (!ideasTab || ideasTab.style.display === 'none') return;
    
    const items = event.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) {
                displayImagePreview(file);
                showNotification('Image pasted! Click "Extract Trade Details" to analyze', 'info');
            }
            break;
        }
    }
});

/**
 * Parse the uploaded image using vision model
 */
window.parseUploadedImage = async function(event) {
    if (event) event.stopPropagation();
    
    if (!window.pendingImageData) {
        showNotification('No image to parse', 'error');
        return;
    }
    
    // Check if vision model is available
    if (!window.hasVisionModel) {
        showNotification('Vision model not installed. Run: ollama pull minicpm-v', 'error');
        return;
    }
    
    const resultDiv = document.getElementById('imageParseResult');
    const contentDiv = document.getElementById('imageParseContent');
    
    resultDiv.style.display = 'block';
    contentDiv.innerHTML = '<span style="color:#ffaa00;">⏳ Analyzing image with AI vision...</span>';
    
    try {
        const response = await fetch('/api/ai/parse-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                image: window.pendingImageData,
                model: 'minicpm-v:latest'
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            contentDiv.innerHTML = `<span style="color:#ff5252;">❌ ${data.error}</span>`;
            return;
        }
        
        // Format the parsed result
        const parsed = data.parsed || {};
        let html = '<div style="display:grid; grid-template-columns:auto 1fr; gap:6px 12px;">';
        
        const fields = [
            ['TICKER', parsed.ticker],
            ['ACTION', parsed.action],
            ['TYPE', parsed.type],
            ['STRIKE', parsed.strike],
            ['EXPIRY', parsed.expiry],
            ['PREMIUM', parsed.premium],
            ['CONTRACTS', parsed.contracts],
            ['TOTAL', parsed.total]
        ];
        
        for (const [label, value] of fields) {
            if (value && value.toLowerCase() !== 'unclear') {
                html += `<span style="color:#888;">${label}:</span><span style="color:#00ff88;">${value}</span>`;
            } else {
                html += `<span style="color:#888;">${label}:</span><span style="color:#666;">—</span>`;
            }
        }
        html += '</div>';
        
        // Store for use in analyzer
        window.extractedTradeData = parsed;
        
        contentDiv.innerHTML = html;
        showNotification('Trade details extracted!', 'success');
        
    } catch (e) {
        contentDiv.innerHTML = `<span style="color:#ff5252;">❌ Error: ${e.message}</span>`;
    }
};

/**
 * Use extracted trade data in the analyzer
 */
window.useExtractedTrade = function() {
    const data = window.extractedTradeData;
    if (!data) {
        showNotification('No extracted data available', 'error');
        return;
    }
    
    // Build a trade string from parsed data
    let tradeStr = '';
    if (data.ticker) tradeStr += data.ticker + ' ';
    if (data.strike) tradeStr += '$' + data.strike;
    if (data.type) tradeStr += data.type.toUpperCase().charAt(0) + ' ';
    if (data.expiry) tradeStr += data.expiry + ' ';
    if (data.premium) tradeStr += 'for $' + data.premium;
    
    // Put it in the paste input
    const input = document.getElementById('pasteTradeInput2');
    if (input) {
        input.value = tradeStr.trim() || `${data.ticker || ''} ${data.strike || ''} ${data.type || ''} ${data.expiry || ''}`.trim();
        input.focus();
        showNotification('Trade sent to analyzer. Click "Analyze Trade" to continue.', 'info');
    }
    
    // Hide the image result
    document.getElementById('imageParseResult').style.display = 'none';
};

/**
 * Save AI model preference to localStorage
 */
window.saveAIModelPreference = function() {
    const modelSelect = document.getElementById('aiModelSelect');
    if (modelSelect) {
        localStorage.setItem('wheelhouse_ai_model', modelSelect.value);
        console.log('AI model preference saved:', modelSelect.value);
        // Check if this model is loaded
        checkAIStatus();
    }
};

/**
 * Check AI/Ollama status and show what's loaded
 */
window.checkAIStatus = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    if (!statusEl) return;
    
    try {
        const response = await fetch('/api/ai/status');
        const status = await response.json();
        
        if (!status.available) {
            statusEl.textContent = '❌ Ollama not running';
            statusEl.style.color = '#ff5252';
            return;
        }
        
        const selectedModel = document.getElementById('aiModelSelect')?.value || 'qwen2.5:7b';
        const isLoaded = status.loaded?.some(m => m.name === selectedModel);
        
        if (isLoaded) {
            const loaded = status.loaded.find(m => m.name === selectedModel);
            statusEl.textContent = `✅ Loaded (${loaded.sizeVramGB}GB VRAM)`;
            statusEl.style.color = '#00ff88';
            if (warmupBtn) {
                warmupBtn.style.background = '#1a3a1a';
                warmupBtn.style.color = '#00ff88';
                warmupBtn.textContent = '✓ Ready';
            }
        } else if (status.loaded?.length > 0) {
            const other = status.loaded[0];
            statusEl.textContent = `⚠️ ${other.name} loaded, not ${selectedModel.split(':')[1]}`;
            statusEl.style.color = '#ffaa00';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#ffaa00';
                warmupBtn.textContent = '🔥 Load';
            }
        } else {
            statusEl.textContent = '💤 Cold (click Warmup)';
            statusEl.style.color = '#888';
            if (warmupBtn) {
                warmupBtn.style.background = '#333';
                warmupBtn.style.color = '#888';
                warmupBtn.textContent = '🔥 Warmup';
            }
        }
    } catch (e) {
        statusEl.textContent = '❌ Error';
        statusEl.style.color = '#ff5252';
    }
};

/**
 * Warmup (pre-load) the selected AI model into GPU memory
 */
window.warmupAIModel = async function() {
    const statusEl = document.getElementById('aiModelStatus');
    const warmupBtn = document.getElementById('aiWarmupBtn');
    const selectedModel = document.getElementById('aiModelSelect')?.value || 'qwen2.5:7b';
    
    if (warmupBtn) {
        warmupBtn.disabled = true;
        warmupBtn.innerHTML = '⏳ 0s';
        warmupBtn.style.color = '#b9f';
        warmupBtn.style.minWidth = '60px';
    }
    if (statusEl) {
        statusEl.textContent = `Loading ${selectedModel}...`;
        statusEl.style.color = '#b9f';
    }
    
    const startTime = Date.now();
    
    try {
        const response = await fetch('/api/ai/warmup', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ model: selectedModel })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        if (warmupBtn) warmupBtn.innerHTML = `⏳ ${elapsed}s`;
                        if (statusEl) statusEl.textContent = data.message;
                    } else if (data.type === 'complete') {
                        if (statusEl) {
                            statusEl.textContent = `✅ ${data.message}`;
                            statusEl.style.color = '#00ff88';
                        }
                        if (warmupBtn) {
                            warmupBtn.innerHTML = '✓ Ready';
                            warmupBtn.style.background = '#1a3a1a';
                            warmupBtn.style.color = '#00ff88';
                        }
                        showNotification(`🧠 ${selectedModel} loaded and ready!`, 'success');
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = `❌ ${e.message}`;
            statusEl.style.color = '#ff5252';
        }
        if (warmupBtn) {
            warmupBtn.innerHTML = '🔥 Retry';
            warmupBtn.style.color = '#ff5252';
        }
        showNotification(`Failed to load model: ${e.message}`, 'error');
    } finally {
        if (warmupBtn) warmupBtn.disabled = false;
    }
};

// Check AI status on page load and periodically
setTimeout(checkAIStatus, 2000);
setInterval(checkAIStatus, 30000); // Refresh every 30 seconds

/**
 * Show/hide X Sentiment button based on model selection
 */
function updateXSentimentButton() {
    // Handle both Ideas panels (Ideas tab and Positions tab)
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    const xBtn1 = document.getElementById('xSentimentBtn');
    const xBtn2 = document.getElementById('xSentimentBtn2');
    
    if (modelSelect1 && xBtn1) {
        const isGrok = modelSelect1.value?.startsWith('grok');
        xBtn1.style.display = isGrok ? 'block' : 'none';
    }
    if (modelSelect2 && xBtn2) {
        const isGrok = modelSelect2.value?.startsWith('grok');
        xBtn2.style.display = isGrok ? 'block' : 'none';
    }
}

// Listen for model changes - run immediately since DOM is likely ready
(function setupXSentimentToggle() {
    const modelSelect1 = document.getElementById('ideaModelSelect');
    const modelSelect2 = document.getElementById('ideaModelSelect2');
    
    if (modelSelect1 || modelSelect2) {
        if (modelSelect1) modelSelect1.addEventListener('change', updateXSentimentButton);
        if (modelSelect2) modelSelect2.addEventListener('change', updateXSentimentButton);
        updateXSentimentButton(); // Check immediately
    } else {
        // DOM not ready, wait a bit
        setTimeout(setupXSentimentToggle, 500);
    }
})();

/**
 * Get X/Twitter sentiment via Grok (Grok-only feature)
 */
window.getXSentiment = async function() {
    // Try both panels - Ideas tab uses "Large" suffix, Positions tab doesn't
    const ideaBtn = document.getElementById('xSentimentBtn2') || document.getElementById('xSentimentBtn');
    const ideaResults = document.getElementById('ideaResultsLarge') || document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContentLarge') || document.getElementById('ideaContent');
    
    if (!ideaResults || !ideaContent) {
        console.error('Could not find result containers');
        return;
    }
    
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 
                        parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    
    // Show loading
    if (ideaBtn) {
        ideaBtn.disabled = true;
        ideaBtn.textContent = '⏳ Scanning X...';
    }
    ideaResults.style.display = 'block';
    ideaContent.innerHTML = '<span style="color:#1da1f2;">🔄 Grok is scanning X/Twitter for trader sentiment... (5-10 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/x-sentiment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buyingPower })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Format the response with nice styling
        let formatted = result.sentiment
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#1da1f2;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(🔥|📢|⚠️|💰|🚀)/g, '<span style="font-size:14px;">$1</span>');
        
        // Add header
        const header = `<div style="color:#1da1f2; font-weight:bold; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #333;">
            🔥 Live from X/Twitter <span style="color:#666; font-size:10px;">(${new Date().toLocaleTimeString()})</span>
        </div>`;
        
        ideaContent.innerHTML = header + formatted;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Trending on X (Grok)';
            ideaBtn.disabled = false;
        }
        
    } catch (e) {
        console.error('X Sentiment error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">X Sentiment requires Grok API. Make sure it's configured in Settings.</span>`;
        if (ideaBtn) {
            ideaBtn.textContent = '🔥 Retry';
            ideaBtn.disabled = false;
        }
    }
};

/**
 * Get AI-powered trade ideas
 */
window.getTradeIdeas = async function() {
    const ideaBtn = document.getElementById('ideaBtn');
    const ideaResults = document.getElementById('ideaResults');
    const ideaContent = document.getElementById('ideaContent');
    
    if (!ideaBtn || !ideaResults || !ideaContent) return;
    
    // Get inputs
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'qwen2.5:32b';
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaBtn.textContent = '⏳ Generating...';
    ideaResults.style.display = 'block';
    ideaContent.innerHTML = '<span style="color:#888;">🔄 AI is researching trade ideas... (15-30 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Store candidates for deep dive
        window._lastTradeIdeas = result.candidates || [];
        
        // Debug: log raw response to see exact format
        console.log('Raw AI response:', result.ideas.substring(0, 500));
        
        // Add Deep Dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                console.log('Deep Dive match:', match, 'Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#8b5cf6; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
            });
        
        // Now apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/<span class="dd-ticker" data-ticker="([^"]+)">([^<]+)<\/span>/g, '<span style="color:#00ff88; font-weight:bold;">$2</span>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>');
        
        ideaContent.innerHTML = formatted;
        ideaBtn.textContent = '💡 Generate Ideas';
        ideaBtn.disabled = false;
        
    } catch (e) {
        console.error('Trade ideas error:', e);
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${e.message}</span>
<br><br>
<span style="color:#888;">Make sure Ollama is running with the selected model installed.</span>`;
        ideaBtn.textContent = '💡 Retry';
        ideaBtn.disabled = false;
    }
};

/**
 * Deep Dive - comprehensive analysis of a single trade
 */
window.deepDive = async function(ticker) {
    // Find the candidate data
    const candidates = window._lastTradeIdeas || [];
    const candidate = candidates.find(c => c.ticker === ticker);
    
    if (!candidate) {
        showNotification(`No data found for ${ticker}`, 'error');
        return;
    }
    
    // Parse the current ideas to find the proposed strike/expiry
    const ideaContent = document.getElementById('ideaContent');
    const ideaText = ideaContent?.textContent || '';
    
    // Try to extract strike and expiry from the idea text
    const strikeMatch = ideaText.match(new RegExp(`${ticker}[^]*?Sell\\s*\\$?(\\d+)\\s*put`, 'i'));
    const expiryMatch = ideaText.match(new RegExp(`${ticker}[^]*?put,?\\s*([A-Z][a-z]+\\s+\\d+)`, 'i'));
    
    const strike = strikeMatch ? strikeMatch[1] : Math.floor(parseFloat(candidate.price) * 0.9);
    // Snap expiry to valid Friday (options never expire on weekends)
    const rawExpiry = expiryMatch ? expiryMatch[1] : null;
    const expiry = snapToFriday(rawExpiry);
    
    const selectedModel = document.getElementById('ideaModelSelect')?.value || 'qwen2.5:32b';
    
    // Show modal with loading state
    const modal = document.createElement('div');
    modal.id = 'deepDiveModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:24px; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid #333; padding-bottom:12px;">
                <h2 style="margin:0; color:#8b5cf6;">🔍 Deep Dive: ${ticker}</h2>
                <button onclick="this.closest('#deepDiveModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div style="color:#888; margin-bottom:16px;">
                Analyzing: Sell $${strike} put, ${expiry} | Current: $${candidate.price}
            </div>
            <div id="deepDiveContent" style="color:#ddd; font-size:13px; line-height:1.7;">
                <div style="text-align:center; padding:40px; color:#888;">
                    ⏳ Running comprehensive analysis... (30-60 seconds)
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    try {
        const response = await fetch('/api/ai/deep-dive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker,
                strike,
                expiry,
                currentPrice: candidate.price,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Format the analysis
        let formatted = result.analysis
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(\$[\d,]+\.?\d*)/g, '<span style="color:#ffaa00;">$1</span>')
            .replace(/(✅ ENTER TRADE)/g, '<span style="color:#00ff88; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(⚠️ WAIT)/g, '<span style="color:#ffaa00; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(❌ AVOID)/g, '<span style="color:#ff5252; font-weight:bold; font-size:16px;">$1</span>')
            .replace(/(Strong Buy|Buy|Neutral|Avoid)/g, (match) => {
                const colors = { 'Strong Buy': '#00ff88', 'Buy': '#00d9ff', 'Neutral': '#ffaa00', 'Avoid': '#ff5252' };
                return `<span style="color:${colors[match] || '#fff'}; font-weight:bold;">${match}</span>`;
            })
            .replace(/(Bull case|Base case|Bear case|Disaster case)/gi, '<span style="color:#8b5cf6; font-weight:bold;">$1</span>')
            .replace(/\n/g, '<br>');
        
        // Add premium info if available
        let premiumHtml = '';
        if (result.premium) {
            const p = result.premium;
            const source = p.source === 'schwab' ? '🔴 Schwab (real-time)' : '🔵 CBOE (15-min delay)';
            
            // Note if strike was adjusted
            const actualStrike = p.actualStrike || parseFloat(strike);
            const strikeAdjusted = p.actualStrike && Math.abs(p.actualStrike - parseFloat(strike)) > 0.01;
            const strikeNote = strikeAdjusted 
                ? `<div style="color:#ffaa00; grid-column: span 3; font-size:11px;">⚠️ Using actual strike $${p.actualStrike} (requested $${strike})</div>` 
                : '';
            
            // Calculate annualized ROC using actual strike
            const expiryMatch = expiry.match(/(\w+)\s+(\d+)/);
            let dte = 30, annualizedRoc = 0;
            if (expiryMatch) {
                const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
                const expMonth = monthMap[expiryMatch[1]];
                const expDay = parseInt(expiryMatch[2]);
                const expYear = expMonth < new Date().getMonth() ? new Date().getFullYear() + 1 : new Date().getFullYear();
                const expDate = new Date(expYear, expMonth, expDay);
                dte = Math.max(1, Math.ceil((expDate - new Date()) / (1000 * 60 * 60 * 24)));
            }
            const roc = (p.mid / actualStrike) * 100;
            annualizedRoc = (roc * (365 / dte)).toFixed(1);
            
            // Probability of profit from delta
            let probProfit = '';
            if (p.delta) {
                const pop = ((1 - Math.abs(p.delta)) * 100).toFixed(0);
                probProfit = `<div style="color:#00ff88;">Win Prob: ~${pop}%</div>`;
            }
            
            premiumHtml = `
                <div style="background:#1e3a5f; border:1px solid #00d9ff; border-radius:8px; padding:12px; margin-bottom:16px;">
                    <div style="color:#00d9ff; font-weight:bold; margin-bottom:8px;">💰 ${source}</div>
                    ${strikeNote}
                    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; font-size:12px;">
                        <div>Bid: <span style="color:#00ff88;">$${p.bid.toFixed(2)}</span></div>
                        <div>Ask: <span style="color:#ffaa00;">$${p.ask.toFixed(2)}</span></div>
                        <div>Mid: <span style="color:#fff;">$${p.mid.toFixed(2)}</span></div>
                        <div>Volume: ${p.volume}</div>
                        <div>OI: ${p.openInterest}</div>
                        ${p.iv ? `<div>IV: ${p.iv}%</div>` : ''}
                        ${probProfit}
                        ${p.delta ? `<div>Delta: ${p.delta.toFixed(2)}</div>` : ''}
                        ${p.theta ? `<div>Theta: ${p.theta.toFixed(3)}</div>` : ''}
                    </div>
                    <div style="margin-top:10px; padding-top:8px; border-top:1px solid #335577; display:grid; grid-template-columns:repeat(2, 1fr); gap:8px; font-size:12px;">
                        <div>Premium: <span style="color:#00ff88;">$${(p.mid * 100).toFixed(0)}</span>/contract</div>
                        <div>ROC: <span style="color:#00ff88;">${roc.toFixed(2)}%</span> (${annualizedRoc}% ann.)</div>
                        <div>DTE: ${dte} days</div>
                        <div>Cost Basis: <span style="color:#ffaa00;">$${(actualStrike - p.mid).toFixed(2)}</span>/sh</div>
                    </div>
                </div>`;
        }
        
        // Store thesis data for staging
        const price = parseFloat(candidate.price);
        const rangeHigh = result.tickerData?.threeMonthHigh;
        const rangeLow = result.tickerData?.threeMonthLow;
        const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
            Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
        
        window._currentThesis = {
            ticker,
            strike: parseFloat(strike),
            expiry,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: price,
            premium: result.premium || null,
            tickerData: result.tickerData || {},
            aiAnalysis: result.analysis,
            // Extract key thesis points
            support: result.tickerData?.recentSupport || [],
            sma20: result.tickerData?.sma20,
            sma50: result.tickerData?.sma50,
            earnings: result.tickerData?.earnings,
            rangeHigh,
            rangeLow,
            rangePosition  // 0% = at low, 100% = at high
        };
        
        // Add Stage Trade button
        const stageButtonHtml = `
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageTradeWithThesis()" 
                        style="background:#8b5cf6; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#deepDiveModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>`;
        
        document.getElementById('deepDiveContent').innerHTML = premiumHtml + formatted + stageButtonHtml;
        
    } catch (e) {
        document.getElementById('deepDiveContent').innerHTML = `
            <div style="color:#ff5252; text-align:center; padding:20px;">
                ❌ ${e.message}
            </div>
        `;
    }
};

/**
 * Analyze a Discord trade callout
 * Parses the trade text, fetches data, and runs AI analysis
 */
window.analyzeDiscordTrade = async function() {
    const textarea = document.getElementById('pasteTradeInput');
    const tradeText = textarea?.value?.trim();
    
    if (!tradeText) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }
    
    // Get selected model from Discord-specific dropdown (falls back to main AI dropdown)
    const discordModelSelect = document.getElementById('discordModelSelect');
    const mainModelSelect = document.getElementById('aiModelSelect');
    const model = discordModelSelect?.value || mainModelSelect?.value || 'qwen2.5:32b';
    
    // Create modal with loading state
    const modal = document.createElement('div');
    modal.id = 'discordTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Progress steps for display
    const stepLabels = [
        'Extract trade details',
        'Fetch market data', 
        'Get CBOE pricing',
        'AI analysis'
    ];
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; max-width:800px; width:100%; max-height:90vh; overflow-y:auto; padding:25px; border:1px solid rgba(139,92,246,0.5);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h2 style="margin:0; color:#b9f;">📋 Discord Trade Analysis</h2>
                <button onclick="this.closest('#discordTradeModal').remove()" style="background:none; border:none; color:#888; font-size:24px; cursor:pointer;">✕</button>
            </div>
            <div id="discordTradeContent" style="color:#ccc;">
                <div style="text-align:center; padding:40px;">
                    <div class="spinner" style="width:50px; height:50px; border:3px solid #333; border-top:3px solid #b9f; border-radius:50%; animation:spin 1s linear infinite; margin:0 auto 20px;"></div>
                    <p id="discordProgressText" style="font-size:16px; color:#b9f;">Initializing...</p>
                    <div id="discordProgressSteps" style="margin-top:20px; text-align:left; display:inline-block;">
                        ${stepLabels.map((label, i) => `
                            <div id="discordStep${i+1}" style="padding:6px 0; color:#666;">
                                <span style="display:inline-block; width:24px; text-align:center;">○</span> ${label}
                            </div>
                        `).join('')}
                    </div>
                    <p id="discordElapsed" style="font-size:12px; color:#555; margin-top:15px;">Elapsed: 0s</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Start elapsed timer
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const elapsedEl = document.getElementById('discordElapsed');
        if (elapsedEl) {
            elapsedEl.textContent = `Elapsed: ${elapsed}s`;
            if (elapsed > 30) {
                elapsedEl.style.color = '#ffaa00';
                elapsedEl.textContent += ' (larger models take longer to load)';
            }
        }
    }, 1000);
    
    // Helper to update step UI
    const updateStep = (stepNum, status, message) => {
        const stepEl = document.getElementById(`discordStep${stepNum}`);
        const progressText = document.getElementById('discordProgressText');
        if (stepEl) {
            const icon = status === 'done' ? '✓' : status === 'active' ? '●' : '○';
            const color = status === 'done' ? '#00ff88' : status === 'active' ? '#b9f' : '#666';
            stepEl.style.color = color;
            stepEl.querySelector('span').textContent = icon;
        }
        if (progressText && message) {
            progressText.textContent = message;
        }
    };
    
    try {
        // Use SSE for real-time progress
        const response = await fetch('/api/ai/parse-trade', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            },
            body: JSON.stringify({ tradeText, model })
        });
        
        // Handle SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // Keep incomplete chunk
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'progress') {
                        // Mark previous steps as done
                        for (let i = 1; i < data.step; i++) {
                            updateStep(i, 'done');
                        }
                        // Mark current step as active
                        updateStep(data.step, 'active', data.message);
                    } else if (data.type === 'complete') {
                        // All steps done
                        for (let i = 1; i <= 4; i++) updateStep(i, 'done');
                        result = data;
                    } else if (data.type === 'error') {
                        throw new Error(data.error);
                    }
                }
            }
        }
        
        clearInterval(timerInterval);
        
        if (!result || result.error) {
            throw new Error(result?.error || 'No response received');
        }
        
        const { parsed, tickerData, premium, analysis } = result;
        
        // Format the analysis
        const formatted = analysis
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#b9f;">$1</strong>')
            .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
            .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
            .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
            .replace(/\n/g, '<br>');
        
        // Build strike display
        const isSpread = parsed.buyStrike || parsed.sellStrike;
        const strikeDisplay = isSpread 
            ? `Buy $${parsed.buyStrike} / Sell $${parsed.sellStrike}`
            : `$${parsed.strike}`;
        
        // Validate callout premium: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumForStorage = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50 
            ? parseFloat(parsed.premium) 
            : null;
        
        // Get the model used for this analysis
        const discordModelSelect = document.getElementById('discordModelSelect');
        const modelUsed = discordModelSelect?.value || 'qwen2.5:32b';
        
        // Store parsed data for staging
        window._currentParsedTrade = {
            ticker: parsed.ticker,
            strike: parsed.strike || parsed.sellStrike,
            buyStrike: parsed.buyStrike,
            sellStrike: parsed.sellStrike,
            expiry: parsed.expiry,
            strategy: parsed.strategy,
            isSpread,
            analyzedAt: new Date().toISOString(),
            priceAtAnalysis: parseFloat(tickerData.price),
            premium: premium || { mid: calloutPremiumForStorage || 0 },
            calloutPremium: calloutPremiumForStorage,  // Store separately for clarity
            iv: premium?.iv || null,  // Store IV at time of analysis
            modelUsed,  // Store which AI model was used
            tickerData,
            aiAnalysis: analysis,
            support: tickerData.recentSupport || [],
            sma20: tickerData.sma20,
            sma50: tickerData.sma50,
            earnings: tickerData.earnings,
            rangeHigh: tickerData.threeMonthHigh,
            rangeLow: tickerData.threeMonthLow
        };
        
        // Premium section - logic differs for selling vs buying
        // Validate: stock prices >$50, option premiums typically $0.50-$15
        const calloutPremiumValid = parsed.premium && parsed.premium > 0.01 && parsed.premium < 50;
        const effectivePremium = calloutPremiumValid ? parseFloat(parsed.premium) : (premium?.mid || 0);
        
        const isSelling = parsed.strategy?.includes('short') || parsed.strategy?.includes('credit') || 
                          parsed.strategy?.includes('cash') || parsed.strategy?.includes('covered');
        let premiumHtml = '';
        if (premium) {
            let entryQuality = '';
            if (calloutPremiumValid && premium.mid) {
                if (isSelling) {
                    // Selling: want to get MORE than mid
                    entryQuality = parsed.premium >= premium.mid 
                        ? '✅ got ≥ mid' 
                        : `⚠️ got ${Math.round((1 - parsed.premium/premium.mid) * 100)}% less than mid`;
                } else {
                    // Buying: want to pay LESS than mid  
                    entryQuality = parsed.premium <= premium.mid 
                        ? '✅ paid ≤ mid' 
                        : `⚠️ paid ${Math.round((parsed.premium/premium.mid - 1) * 100)}% more than mid`;
                }
            }
            const discrepancy = calloutPremiumValid && Math.abs(premium.mid - parsed.premium) > 0.5;
            premiumHtml = `
                <div style="background:rgba(139,92,246,0.1); padding:12px; border-radius:8px; margin-bottom:15px; border:1px solid rgba(139,92,246,0.3);">
                    <div style="font-weight:bold; color:#b9f; margin-bottom:6px;">💰 Live CBOE Pricing</div>
                    <div style="font-size:13px;">
                        Bid: $${premium.bid?.toFixed(2)} | Ask: $${premium.ask?.toFixed(2)} | Mid: $${premium.mid?.toFixed(2)}
                        ${premium.iv ? ` | IV: ${premium.iv}%` : ''}
                        ${calloutPremiumValid ? `<br>Callout Entry: $${parsed.premium} ${entryQuality}` : '<br>Callout Entry: Not specified - using live mid'}
                        ${discrepancy ? '<br><span style="color:#ff5252;">⚠️ Large discrepancy - callout may be stale!</span>' : ''}
                    </div>
                </div>`;
        }
        
        // Show results
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#0d0d1a; padding:15px; border-radius:8px; margin-bottom:15px;">
                <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:15px; text-align:center;">
                    <div>
                        <div style="font-size:12px; color:#888;">Ticker</div>
                        <div style="font-size:20px; font-weight:bold; color:#00d9ff;">${parsed.ticker}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strategy</div>
                        <div style="font-size:14px; font-weight:bold; color:#b9f;">${parsed.strategy?.replace(/_/g, ' ') || 'Unknown'}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Strike</div>
                        <div style="font-size:16px; font-weight:bold;">${strikeDisplay}</div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:#888;">Expiry</div>
                        <div style="font-size:16px; font-weight:bold;">${parsed.expiry}</div>
                    </div>
                </div>
                <div style="margin-top:10px; text-align:center; font-size:13px;">
                    Current Price: <strong style="color:#00d9ff;">$${parseFloat(tickerData.price).toFixed(2)}</strong>
                </div>
            </div>
            ${premiumHtml}
            <div style="background:#0d0d1a; padding:20px; border-radius:8px;">
                <h4 style="margin:0 0 15px; color:#b9f;">AI Analysis</h4>
                <div style="white-space:pre-wrap; line-height:1.6; font-size:14px;">${formatted}</div>
            </div>
            <div style="margin-top:20px; padding-top:16px; border-top:1px solid #333; display:flex; gap:12px; justify-content:center;">
                <button onclick="window.stageDiscordTrade()" 
                        style="background:#8b5cf6; color:#fff; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px; font-weight:bold;">
                    📥 Stage This Trade
                </button>
                <button onclick="this.closest('#discordTradeModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:12px 24px; border-radius:8px; cursor:pointer; font-size:14px;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        clearInterval(timerInterval);
        document.getElementById('discordTradeContent').innerHTML = `
            <div style="background:#3a1a1a; padding:20px; border-radius:8px; border:1px solid #ff5252;">
                <h4 style="color:#ff5252; margin:0 0 10px;">❌ Analysis Failed</h4>
                <p style="color:#ccc; margin:0;">${err.message}</p>
                <p style="color:#888; font-size:12px; margin-top:10px;">Try a clearer format like:<br>
                Ticker: XYZ<br>Strategy: Short Put<br>Strike: $100<br>Expiry: Feb 21<br>Entry: $2.50</p>
            </div>
        `;
    }
};

/**
 * Stage a trade from Discord callout analysis
 */
window.stageDiscordTrade = function() {
    const trade = window._currentParsedTrade;
    if (!trade) {
        showNotification('No trade data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === trade.ticker && p.strike === trade.strike && p.expiry === trade.expiry);
    if (exists) {
        showNotification(`${trade.ticker} $${trade.strike} already staged`, 'info');
        return;
    }
    
    // Calculate range position
    const price = trade.priceAtAnalysis;
    const rangeHigh = parseFloat(trade.rangeHigh) || 0;
    const rangeLow = parseFloat(trade.rangeLow) || 0;
    const rangePosition = (rangeHigh && rangeLow && rangeHigh !== rangeLow) ?
        Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null;
    
    // Determine position type
    let posType = 'short_put'; // default
    if (trade.strategy) {
        const strat = trade.strategy.toLowerCase();
        if (strat.includes('bull_put') || strat.includes('put_credit')) posType = 'put_credit_spread';
        else if (strat.includes('bear_call') || strat.includes('call_credit')) posType = 'call_credit_spread';
        else if (strat.includes('call_debit') || strat.includes('bull_call')) posType = 'call_debit_spread';
        else if (strat.includes('put_debit') || strat.includes('bear_put')) posType = 'put_debit_spread';
        else if (strat.includes('short_call') || strat.includes('covered')) posType = 'short_call';
        else if (strat.includes('short_put') || strat.includes('cash')) posType = 'short_put';
    }
    
    // Create pending trade with thesis
    const pendingTrade = {
        id: Date.now(),
        ticker: trade.ticker,
        type: posType,
        strike: trade.strike,
        buyStrike: trade.buyStrike,
        sellStrike: trade.sellStrike,
        expiry: trade.expiry,
        currentPrice: trade.priceAtAnalysis,
        premium: trade.premium?.mid || 0,
        stagedAt: new Date().toISOString(),
        source: 'discord', // Mark as Discord import
        // THESIS DATA
        openingThesis: {
            analyzedAt: trade.analyzedAt,
            priceAtAnalysis: trade.priceAtAnalysis,
            support: trade.support,
            sma20: trade.sma20,
            sma50: trade.sma50,
            earnings: trade.earnings,
            rangeHigh: trade.rangeHigh,
            rangeLow: trade.rangeLow,
            rangePosition,
            premium: trade.premium,
            iv: trade.iv,  // IV at time of analysis
            modelUsed: trade.modelUsed,  // AI model used
            aiSummary: extractThesisSummary(trade.aiAnalysis)
        }
    };
    
    pending.push(pendingTrade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged from Discord: ${trade.ticker} ${posType.replace(/_/g, ' ')}`, 'success');
    
    // Close modal and clear
    document.getElementById('discordTradeModal')?.remove();
    window._currentParsedTrade = null;
    
    // Clear textarea
    const textarea = document.getElementById('pasteTradeInput');
    if (textarea) textarea.value = '';
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Stage a trade with thesis from Deep Dive
 */
window.stageTradeWithThesis = function() {
    const thesis = window._currentThesis;
    if (!thesis) {
        showNotification('No thesis data available', 'error');
        return;
    }
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === thesis.ticker && p.strike === thesis.strike && p.expiry === thesis.expiry);
    if (exists) {
        showNotification(`${thesis.ticker} $${thesis.strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade with full thesis
    const trade = {
        id: Date.now(),
        ticker: thesis.ticker,
        strike: thesis.strike,
        expiry: thesis.expiry,
        currentPrice: thesis.priceAtAnalysis,
        premium: thesis.premium?.mid || 0,
        stagedAt: new Date().toISOString(),
        // THESIS DATA - for checkup later
        openingThesis: {
            analyzedAt: thesis.analyzedAt,
            priceAtAnalysis: thesis.priceAtAnalysis,
            support: thesis.support,
            sma20: thesis.sma20,
            sma50: thesis.sma50,
            earnings: thesis.earnings,
            rangeHigh: thesis.rangeHigh,
            rangeLow: thesis.rangeLow,
            rangePosition: thesis.rangePosition,  // 0% = at 3mo low, 100% = at 3mo high
            premium: thesis.premium,
            aiSummary: extractThesisSummary(thesis.aiAnalysis)
        }
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${thesis.ticker} $${thesis.strike} put, ${thesis.expiry} (with thesis)`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Clear current thesis
    window._currentThesis = null;
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Extract key points from AI analysis for storage
 */
function extractThesisSummary(analysis) {
    if (!analysis) return null;
    
    // Extract verdict spectrum sections
    const aggressiveMatch = analysis.match(/(?:GREEN|AGGRESSIVE)[^:]*:([^🟡🔴]*)/is);
    const moderateMatch = analysis.match(/(?:YELLOW|MODERATE)[^:]*:([^🔴]*)/is);
    const conservativeMatch = analysis.match(/(?:RED|CONSERVATIVE)[^:]*:([^B]*)/is);
    const bottomLineMatch = analysis.match(/BOTTOM LINE:([^\n]+)/i);
    
    // Legacy verdict format fallback
    const legacyVerdictMatch = analysis.match(/(✅ FOLLOW|⚠️ PASS|❌ AVOID)[^\n]*/);
    
    // Extract probability if mentioned
    const probabilityMatch = analysis.match(/(\d+)%\s*(?:probability|chance|max profit)/i);
    
    return {
        // New spectrum format
        aggressive: aggressiveMatch ? aggressiveMatch[1].trim().substring(0, 300) : null,
        moderate: moderateMatch ? moderateMatch[1].trim().substring(0, 300) : null,
        conservative: conservativeMatch ? conservativeMatch[1].trim().substring(0, 300) : null,
        bottomLine: bottomLineMatch ? bottomLineMatch[1].trim() : null,
        probability: probabilityMatch ? parseInt(probabilityMatch[1]) : null,
        
        // Legacy format
        verdict: legacyVerdictMatch ? legacyVerdictMatch[0] : null,
        
        // Full analysis for later review
        fullAnalysis: analysis
    };
}

/**
 * Legacy stage function (without thesis)
 */
window.stageTrade = function(ticker, strike, expiry, currentPrice, premium) {
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} put already staged`, 'info');
        return;
    }
    
    // Create pending trade
    const trade = {
        id: Date.now(),
        ticker,
        strike: parseFloat(strike),
        expiry,
        currentPrice: parseFloat(currentPrice),
        premium: parseFloat(premium) || 0,
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    showNotification(`📥 Staged: ${ticker} $${strike} put, ${expiry}`, 'success');
    
    // Close the deep dive modal
    document.getElementById('deepDiveModal')?.remove();
    
    // Render pending trades
    renderPendingTrades();
};

/**
 * Render pending trades section
 */
window.renderPendingTrades = function() {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    let container = document.getElementById('pendingTradesSection');
    
    // Create container if it doesn't exist
    if (!container) {
        const positionsTab = document.getElementById('positions');
        if (!positionsTab) return;
        
        container = document.createElement('div');
        container.id = 'pendingTradesSection';
        positionsTab.insertBefore(container, positionsTab.firstChild);
    }
    
    if (pending.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    // Calculate DTE and annualized return for each pending trade
    const today = new Date();
    const pendingWithCalcs = pending.map(p => {
        // Parse expiry to calculate DTE
        const expiryDate = parseExpiryToDate(p.expiry);
        const expDate = expiryDate ? new Date(expiryDate) : null;
        const dte = expDate ? Math.ceil((expDate - today) / (1000 * 60 * 60 * 24)) : null;
        
        // Calculate credit (premium × 100)
        const credit = p.premium ? (p.premium * 100) : null;
        
        // Calculate annualized return: (premium / strike) × (365 / DTE) × 100
        const annReturn = (p.premium && p.strike && dte > 0) 
            ? ((p.premium / p.strike) * (365 / dte) * 100).toFixed(1)
            : null;
        
        return { ...p, dte, credit, annReturn };
    });
    
    container.innerHTML = `
        <div style="background:linear-gradient(135deg, #1a1a2e 0%, #2d1f3d 100%); border:1px solid #8b5cf6; border-radius:8px; padding:16px; margin-bottom:20px;">
            <h3 style="color:#8b5cf6; margin:0 0 12px 0; font-size:14px;">📋 Pending Trades (${pending.length})</h3>
            <div style="font-size:11px; color:#888; margin-bottom:12px;">
                Staged from AI analysis - confirm when you execute with your broker
            </div>
            <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <thead>
                    <tr style="color:#888; text-align:left;">
                        <th style="padding:6px;">Ticker</th>
                        <th style="padding:6px;">Strike</th>
                        <th style="padding:6px;">Expiry</th>
                        <th style="padding:6px;">DTE</th>
                        <th style="padding:6px;">Credit</th>
                        <th style="padding:6px;">Ann%</th>
                        <th style="padding:6px;">Staged</th>
                        <th style="padding:6px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${pendingWithCalcs.map(p => `
                        <tr style="border-top:1px solid #333;">
                            <td style="padding:8px; color:#00ff88; font-weight:bold;">${p.ticker}</td>
                            <td style="padding:8px; color:#ffaa00;">$${p.strike}</td>
                            <td style="padding:8px;">${p.expiry}</td>
                            <td style="padding:8px; color:#888;">${p.dte ?? '-'}</td>
                            <td style="padding:8px; color:#00d9ff;">${p.credit ? '$' + p.credit.toFixed(0) : '-'}</td>
                            <td style="padding:8px; color:${p.annReturn && parseFloat(p.annReturn) >= 25 ? '#00ff88' : '#ffaa00'};">${p.annReturn ? p.annReturn + '%' : '-'}</td>
                            <td style="padding:8px; color:#888;">${new Date(p.stagedAt).toLocaleDateString()}</td>
                            <td style="padding:8px;">
                                <button onclick="window.showTickerChart('${p.ticker}')" 
                                        title="View 3-month chart with Bollinger Bands"
                                        style="background:#00d9ff; color:#000; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;">
                                    📊
                                </button>
                                <button onclick="window.confirmStagedTrade(${p.id})" 
                                        style="background:#00ff88; color:#000; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; margin-right:4px;">
                                    ✓ Confirm
                                </button>
                                <button onclick="window.removeStagedTrade(${p.id})" 
                                        style="background:#ff5252; color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px;">
                                    ✕
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
};

/**
 * Show TradingView chart with Bollinger Bands for a ticker
 */
window.showTickerChart = function(ticker) {
    // Remove any existing chart modal
    document.getElementById('chartModal')?.remove();
    
    const modal = document.createElement('div');
    modal.id = 'chartModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.95); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // Generate unique container ID
    const containerId = 'tradingview_' + Date.now();
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:90%; max-width:1000px; padding:24px; border:1px solid #00d9ff; max-height:90vh; overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h2 style="color:#00d9ff; margin:0;">📊 ${ticker} - 3 Month Chart with Bollinger Bands</h2>
                <button onclick="document.getElementById('chartModal').remove()" 
                        style="background:#333; color:#888; border:none; padding:8px 16px; border-radius:8px; cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="${containerId}" style="height:500px; width:100%;"></div>
            <div style="margin-top:12px; font-size:11px; color:#888;">
                💡 <b>Bollinger Bands:</b> Price near lower band = potentially oversold (good for selling puts). 
                Price near upper band = potentially overbought (caution).
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Load TradingView widget script and create chart
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = function() {
        new TradingView.widget({
            "width": "100%",
            "height": 500,
            "symbol": ticker,
            "interval": "D",
            "timezone": "America/New_York",
            "theme": "dark",
            "style": "1",
            "locale": "en",
            "toolbar_bg": "#1a1a2e",
            "enable_publishing": false,
            "hide_side_toolbar": false,
            "allow_symbol_change": true,
            "range": "3M",
            "studies": ["BB@tv-basicstudies"],
            "container_id": containerId
        });
    };
    document.head.appendChild(script);
};

/**
 * Confirm a staged trade - moves to real positions
 */
window.confirmStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Show modal to enter actual trade details
    const modal = document.createElement('div');
    modal.id = 'confirmTradeModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; width:400px; padding:24px; border:1px solid #00ff88;">
            <h2 style="color:#00ff88; margin:0 0 16px 0;">✅ Confirm Trade Executed</h2>
            <p style="color:#888; margin-bottom:16px; font-size:13px;">
                Enter the actual details from your broker:
            </p>
            <div style="display:grid; gap:12px;">
                <div>
                    <label style="color:#888; font-size:12px;">Ticker</label>
                    <input id="confirmTicker" type="text" value="${trade.ticker}" readonly
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Strike Price</label>
                    <input id="confirmStrike" type="number" value="${trade.strike}" step="0.5"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Premium Received (per share)</label>
                    <input id="confirmPremium" type="number" value="${trade.premium?.toFixed(2) || ''}" step="0.01" placeholder="e.g., 1.50"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Contracts</label>
                    <input id="confirmContracts" type="number" value="1" min="1"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="color:#888; font-size:12px;">Expiry Date</label>
                    <input id="confirmExpiry" type="date" value="${parseExpiryToDate(trade.expiry)}"
                           style="width:100%; padding:8px; background:#0d0d1a; border:1px solid #333; color:#fff; border-radius:4px;">
                </div>
            </div>
            <div style="display:flex; gap:12px; margin-top:20px;">
                <button onclick="window.finalizeConfirmedTrade(${id})" 
                        style="flex:1; background:#00ff88; color:#000; border:none; padding:12px; border-radius:8px; cursor:pointer; font-weight:bold;">
                    Add to Positions
                </button>
                <button onclick="this.closest('#confirmTradeModal').remove()" 
                        style="flex:1; background:#333; color:#888; border:none; padding:12px; border-radius:8px; cursor:pointer;">
                    Cancel
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

/**
 * Parse "Feb 20" or "Mar 21" to YYYY-MM-DD
 */
function parseExpiryToDate(expiry) {
    const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                      Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    const match = expiry.match(/(\w+)\s+(\d+)/);
    if (!match) return '';
    const month = monthMap[match[1]] || '01';
    const day = match[2].padStart(2, '0');
    return `2026-${month}-${day}`;
}

/**
 * Finalize the confirmed trade - add to positions
 */
window.finalizeConfirmedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const trade = pending.find(p => p.id === id);
    
    if (!trade) return;
    
    // Get values from modal
    const ticker = document.getElementById('confirmTicker').value;
    const strike = parseFloat(document.getElementById('confirmStrike').value);
    const premium = parseFloat(document.getElementById('confirmPremium').value) || 0;
    const contracts = parseInt(document.getElementById('confirmContracts').value) || 1;
    const expiry = document.getElementById('confirmExpiry').value;
    
    // Create position object with thesis if available
    const position = {
        id: Date.now(),
        chainId: Date.now(),
        ticker,
        type: 'short_put',
        strike,
        premium,
        contracts,
        expiry,
        openDate: new Date().toISOString().split('T')[0],
        status: 'open',
        broker: 'Manual',
        // Include thesis if it was staged with one
        openingThesis: trade.openingThesis || null
    };
    
    // Add to positions
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    positions.push(position);
    localStorage.setItem('wheelhouse_positions', JSON.stringify(positions));
    
    // Remove from pending
    const updatedPending = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updatedPending));
    
    // Close modal
    document.getElementById('confirmTradeModal')?.remove();
    
    // Refresh displays
    renderPendingTrades();
    
    // Reload positions from localStorage to show the new one
    if (window.loadPositions) {
        window.loadPositions();
    }
    
    showNotification(`✅ Added ${ticker} $${strike} put to positions!`, 'success');
};

/**
 * Remove a staged trade
 */
window.removeStagedTrade = function(id) {
    const pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    const updated = pending.filter(p => p.id !== id);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(updated));
    renderPendingTrades();
    showNotification('Staged trade removed', 'info');
};

/**
 * Run a checkup on a position - compares opening thesis to current market conditions
 */
window.runPositionCheckup = async function(positionId) {
    // Find the position
    const positions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
    const pos = positions.find(p => p.id === positionId);
    
    if (!pos) {
        showNotification('Position not found', 'error');
        return;
    }
    
    if (!pos.openingThesis) {
        showNotification('No thesis data for this position', 'error');
        return;
    }
    
    // Get selected model
    const modelSelect = document.getElementById('ollamaModel');
    const model = modelSelect?.value || 'qwen2.5:7b';
    
    // Create loading modal
    const modal = document.createElement('div');
    modal.id = 'checkupModal';
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);
        display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e;border-radius:12px;max-width:800px;width:100%;max-height:90vh;
            overflow-y:auto;padding:25px;border:1px solid #333;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <h2 style="margin:0;color:#00d9ff;">🩺 Position Checkup: ${pos.ticker}</h2>
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:8px 15px;border-radius:6px;cursor:pointer;">
                    ✕ Close
                </button>
            </div>
            <div id="checkupContent" style="color:#ccc;">
                <div style="text-align:center;padding:40px;">
                    <div class="spinner" style="width:50px;height:50px;border:3px solid #333;
                        border-top:3px solid #00d9ff;border-radius:50%;animation:spin 1s linear infinite;
                        margin:0 auto 20px;"></div>
                    <p>Running position checkup with ${model}...</p>
                    <p style="font-size:12px;color:#666;">Comparing opening thesis to current market conditions</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    // Add spinner animation if not already present
    if (!document.getElementById('spinnerStyle')) {
        const style = document.createElement('style');
        style.id = 'spinnerStyle';
        style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }
    
    try {
        // Call checkup API
        const response = await fetch('/api/ai/checkup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ticker: pos.ticker,
                strike: pos.strike,
                expiry: pos.expiry,
                openingThesis: pos.openingThesis,
                model
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        // Calculate DTE
        const dte = Math.ceil((new Date(pos.expiry) - new Date()) / (1000 * 60 * 60 * 24));
        
        // Display result
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:15px;text-align:center;">
                    <div>
                        <div style="font-size:12px;color:#888;">Position</div>
                        <div style="font-size:18px;font-weight:bold;color:#00d9ff;">
                            ${pos.ticker} $${pos.strike}P
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Days to Expiry</div>
                        <div style="font-size:18px;font-weight:bold;color:${dte < 7 ? '#ff5252' : dte < 21 ? '#ffaa00' : '#00ff88'};">
                            ${dte} days
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Entry Price</div>
                        <div style="font-size:18px;font-weight:bold;">
                            $${parseFloat(pos.openingThesis.priceAtAnalysis)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px;color:#888;">Current Price</div>
                        <div style="font-size:18px;font-weight:bold;color:${parseFloat(data.currentData?.price) > parseFloat(pos.openingThesis.priceAtAnalysis) ? '#00ff88' : '#ff5252'};">
                            $${parseFloat(data.currentData?.price)?.toFixed(2) || 'N/A'}
                        </div>
                    </div>
                </div>
            </div>
            
            <div style="background:#0d0d1a;padding:15px;border-radius:8px;margin-bottom:15px;">
                <h4 style="margin:0 0 10px;color:#888;font-size:12px;text-transform:uppercase;">
                    Original Entry Thesis (${new Date(pos.openingThesis.analyzedAt).toLocaleDateString()})
                    ${pos.openingThesis.modelUsed ? `<span style="color:#666;margin-left:10px;">${pos.openingThesis.modelUsed}</span>` : ''}
                </h4>
                ${pos.openingThesis.aiSummary?.bottomLine ? `
                    <div style="color:#ffaa00;font-weight:bold;margin-bottom:8px;">
                        📊 ${pos.openingThesis.aiSummary.bottomLine}
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.probability ? `
                    <div style="color:#00d9ff;font-size:13px;margin-bottom:8px;">
                        🎯 ${pos.openingThesis.aiSummary.probability}% probability of max profit
                    </div>
                ` : ''}
                <div style="display:grid;gap:8px;font-size:12px;">
                    ${pos.openingThesis.aiSummary?.aggressive ? `
                        <div style="background:rgba(0,255,136,0.1);padding:8px;border-radius:4px;border-left:3px solid #00ff88;">
                            <span style="color:#00ff88;font-weight:bold;">🟢 AGGRESSIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.aggressive.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                    ${pos.openingThesis.aiSummary?.conservative ? `
                        <div style="background:rgba(255,82,82,0.1);padding:8px;border-radius:4px;border-left:3px solid #ff5252;">
                            <span style="color:#ff5252;font-weight:bold;">🔴 CONSERVATIVE:</span>
                            <span style="color:#aaa;">${pos.openingThesis.aiSummary.conservative.substring(0, 150)}...</span>
                        </div>
                    ` : ''}
                </div>
                ${pos.openingThesis.iv ? `
                    <div style="margin-top:8px;font-size:11px;color:#666;">
                        IV at entry: ${pos.openingThesis.iv}% | Range: ${pos.openingThesis.rangePosition}% | 
                        Price: $${pos.openingThesis.priceAtAnalysis}
                    </div>
                ` : ''}
                ${pos.openingThesis.aiSummary?.fullAnalysis ? `
                    <div style="margin-top:12px;">
                        <button onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none'; this.textContent = el.style.display === 'none' ? '📄 View Full Entry Analysis' : '📄 Hide Full Analysis';"
                            style="background:#1a1a2e;border:1px solid #333;color:#00d9ff;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px;">
                            📄 View Full Entry Analysis
                        </button>
                        <div style="display:none;margin-top:10px;background:#1a1a2e;padding:12px;border-radius:6px;border:1px solid #333;max-height:300px;overflow-y:auto;">
                            <div style="white-space:pre-wrap;line-height:1.5;font-size:12px;color:#ccc;">
${pos.openingThesis.aiSummary.fullAnalysis}
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
            
            <div style="background:#0d0d1a;padding:20px;border-radius:8px;">
                <h4 style="margin:0 0 15px;color:#00d9ff;">AI Checkup Analysis</h4>
                <div style="white-space:pre-wrap;line-height:1.6;font-size:14px;">
                    ${formatAIResponse(data.checkup)}
                </div>
            </div>
            
            <div style="margin-top:15px;display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="this.closest('#checkupModal').remove()" 
                    style="background:#333;border:none;color:#fff;padding:10px 20px;border-radius:6px;cursor:pointer;">
                    Close
                </button>
            </div>
        `;
        
    } catch (err) {
        document.getElementById('checkupContent').innerHTML = `
            <div style="background:#3a1a1a;padding:20px;border-radius:8px;border:1px solid #ff5252;">
                <h4 style="color:#ff5252;margin:0 0 10px;">❌ Checkup Failed</h4>
                <p style="color:#ccc;margin:0;">${err.message}</p>
            </div>
        `;
    }
};

/**
 * Format AI response with proper styling
 */
function formatAIResponse(text) {
    if (!text) return '';
    return text
        .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
        .replace(/✅/g, '<span style="color:#00ff88;">✅</span>')
        .replace(/⚠️/g, '<span style="color:#ffaa00;">⚠️</span>')
        .replace(/❌/g, '<span style="color:#ff5252;">❌</span>')
        .replace(/🟢/g, '<span style="color:#00ff88;">🟢</span>')
        .replace(/🟡/g, '<span style="color:#ffaa00;">🟡</span>')
        .replace(/🔴/g, '<span style="color:#ff5252;">🔴</span>')
        .replace(/📈/g, '<span style="color:#00ff88;">📈</span>')
        .replace(/📉/g, '<span style="color:#ff5252;">📉</span>');
}

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
 * Restart the server (called from UI button)
 */
window.restartServer = async function() {
    const btn = document.getElementById('restartBtn');
    if (btn) {
        btn.style.opacity = '0.3';
        btn.disabled = true;
        btn.innerHTML = '⏳';
    }
    
    try {
        showNotification('Restarting server...', 'info');
        const res = await fetch('/api/restart', { method: 'POST' });
        
        if (res.ok) {
            // Server is restarting - wait a moment then reload
            showNotification('Server restarting, reloading page...', 'success');
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            throw new Error('Restart failed');
        }
    } catch (e) {
        showNotification('Restart failed: ' + e.message, 'error');
        if (btn) {
            btn.style.opacity = '0.6';
            btn.disabled = false;
            btn.innerHTML = '🔄';
        }
    }
};

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
 * Migrate content from old tabs (Options, Simulator, Greeks) into Analyze sub-tabs
 * This runs once on init to avoid duplicating HTML
 */
function migrateTabContent() {
    console.log('🔄 Starting tab content migration...');
    
    // Move Options tab content → analyze-pricing sub-tab
    const optionsContent = document.getElementById('options');
    const pricingSubTab = document.getElementById('analyze-pricing');
    console.log('  Options tab:', optionsContent ? `found (${optionsContent.childNodes.length} children)` : 'NOT FOUND');
    console.log('  Pricing sub-tab:', pricingSubTab ? `found (${pricingSubTab.childNodes.length} children)` : 'NOT FOUND');
    
    if (optionsContent && pricingSubTab) {
        // Check if already has content (skip if migrated)
        const hasTextContent = pricingSubTab.textContent.trim().length > 50;
        if (!hasTextContent) {
            while (optionsContent.firstChild) {
                pricingSubTab.appendChild(optionsContent.firstChild);
            }
            optionsContent.style.display = 'none';
            console.log('✅ Migrated Options → Analyze/Pricing');
        } else {
            console.log('⏭️ Pricing sub-tab already has content, skipping migration');
        }
    }
    
    // Monte Carlo sub-tab has built-in content directly in HTML
    // No migration needed - just log for debugging
    console.log('✅ Monte Carlo tab has built-in risk analysis UI');
    
    // Move Greeks tab content → analyze-greeks sub-tab
    const greeksContent = document.getElementById('greeks');
    const greeksSubTab = document.getElementById('analyze-greeks');
    console.log('  Greeks tab:', greeksContent ? `found (${greeksContent.childNodes.length} children)` : 'NOT FOUND');
    console.log('  Greeks sub-tab:', greeksSubTab ? `found (${greeksSubTab.childNodes.length} children)` : 'NOT FOUND');
    
    if (greeksContent && greeksSubTab) {
        const hasTextContent = greeksSubTab.textContent.trim().length > 50;
        if (!hasTextContent) {
            while (greeksContent.firstChild) {
                greeksSubTab.appendChild(greeksContent.firstChild);
            }
            greeksContent.style.display = 'none';
            console.log('✅ Migrated Greeks → Analyze/Greeks');
        } else {
            console.log('⏭️ Greeks sub-tab already has content, skipping migration');
        }
    }
    
    // Remove old tab buttons from the header
    const oldTabIds = ['options', 'simulator', 'greeks', 'data'];
    oldTabIds.forEach(tabId => {
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (btn) btn.style.display = 'none';
        // Also hide the tab content
        const content = document.getElementById(tabId);
        if (content && !['options', 'simulator', 'greeks'].includes(tabId)) {
            // Don't hide options/simulator/greeks - they're migrated
            content.style.display = 'none';
        }
    });
    
    console.log('🔄 Tab content migration complete');
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
            } else if (targetId === 'analyze') {
                // Initialize first sub-tab if needed
                const activeSubTab = document.querySelector('#analyze .sub-tab-content.active');
                if (!activeSubTab) {
                    switchSubTab('analyze', 'analyze-pricing');
                }
            } else if (targetId === 'ideas') {
                // Ideas tab - check AI status and restore saved ideas
                checkAIStatus?.();
                // Try to restore previously saved ideas if no new ones shown
                const ideaContent = document.getElementById('ideaContentLarge');
                if (ideaContent && !ideaContent.innerHTML.includes('Entry:')) {
                    window.restoreSavedIdeas?.();
                }
            }
        });
    });
}

/**
 * Switch sub-tabs within a parent tab (e.g., Analyze)
 * @param {string} parentId - Parent tab container ID
 * @param {string} subTabId - Sub-tab content ID to activate
 */
function switchSubTab(parentId, subTabId) {
    const parent = document.getElementById(parentId);
    if (!parent) return;
    
    // Update button states
    parent.querySelectorAll('.sub-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.subtab === subTabId);
    });
    
    // Update content visibility
    parent.querySelectorAll('.sub-tab-content').forEach(content => {
        content.classList.toggle('active', content.id === subTabId);
    });
    
    // Sub-tab specific initialization
    if (subTabId === 'analyze-greeks') {
        drawGreeksPlots?.();
    } else if (subTabId === 'analyze-simulator') {
        // Initialize Monte Carlo tab with current position data
        window.initMonteCarloTab?.();
    }
}

// Make switchSubTab globally accessible for onclick handlers
window.switchSubTab = switchSubTab;

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

/**
 * Ideas Tab: Discord Trade Analyzer (uses Ideas tab element IDs)
 * Wrapper that calls the main analyzeDiscordTrade but swaps element sources
 */
window.analyzeDiscordTrade2 = async function() {
    // Temporarily swap IDs so the main function works
    const textarea = document.getElementById('pasteTradeInput2');
    const modelSelect = document.getElementById('discordModelSelect2');
    
    if (!textarea || !textarea.value.trim()) {
        showNotification('Paste a trade callout first', 'error');
        return;
    }
    
    // Temporarily set the main elements to our values (for modal display)
    const mainTextarea = document.getElementById('pasteTradeInput');
    if (mainTextarea) mainTextarea.value = textarea.value;
    
    const mainModel = document.getElementById('discordModelSelect');
    if (mainModel) mainModel.value = modelSelect?.value || 'qwen2.5:32b';
    
    // Call the main function
    window.analyzeDiscordTrade();
};

/**
 * Restore previously saved trade ideas from localStorage
 */
window.restoreSavedIdeas = function() {
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaResults || !ideaContent) return false;
    
    try {
        const saved = localStorage.getItem('wheelhouse_trade_ideas');
        if (!saved) return false;
        
        const data = JSON.parse(saved);
        if (!data.ideas) return false;
        
        // Check if less than 24 hours old
        const age = Date.now() - (data.timestamp || 0);
        if (age > 24 * 60 * 60 * 1000) {
            localStorage.removeItem('wheelhouse_trade_ideas');
            return false;
        }
        
        // Restore the data
        window._lastTradeIdeas = data.candidates || [];
        window._lastSuggestedTickers = extractSuggestedTickers(data.ideas);
        
        // Debug: log raw ideas to see format
        console.log('[Ideas] Raw saved ideas (first 300 chars):', data.ideas.substring(0, 300));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = data.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                console.log('[Ideas] Deep Dive match:', match, '→ Ticker:', ticker);
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#8b5cf6; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show candidate pool
        const allCandidates = data.candidates || [];
        const discoveredNote = data.discoveredCount > 0 
            ? '(including <span style="color:#ffaa00;">' + data.discoveredCount + ' market movers</span>)'
            : '';
        
        let poolHtml = '<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">';
        poolHtml += '<div style="color:#888; margin-bottom:8px;">';
        poolHtml += '📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ' + (data.candidatesChecked || 0) + ' stocks scanned ';
        poolHtml += discoveredNote;
        poolHtml += ' <span style="margin-left:10px; color:#666;">Saved ' + Math.round(age / 60000) + ' min ago</span>';
        poolHtml += '</div>';
        poolHtml += '<div style="display:flex; flex-wrap:wrap; gap:4px;">';
        allCandidates.forEach(t => {
            const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
            const bg = isDiscovered ? '#4a3500' : '#333';
            const border = isDiscovered ? '1px solid #ffaa00' : 'none';
            poolHtml += '<span style="background:' + bg + '; border:' + border + '; padding:2px 6px; border-radius:3px; color:#ccc;">' + t.ticker + '</span>';
        });
        poolHtml += '</div></div>';
        
        // Add buttons
        formatted += poolHtml;
        formatted += `<div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeas2()" style="padding:8px 16px; background:#8b5cf6; border:none; border-radius:5px; color:#fff; cursor:pointer; font-size:13px;">
                    🔄 Generate Fresh Ideas
                </button>
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; margin-left:10px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;">
                    🔀 Show Different Stocks
                </button>
            </div>`;
        
        ideaResults.style.display = 'block';
        ideaContent.innerHTML = formatted;
        console.log('[Ideas] Restored saved ideas from', Math.round(age / 60000), 'minutes ago');
        return true;
        
    } catch (e) {
        console.error('[Ideas] Failed to restore saved ideas:', e);
        return false;
    }
};

// Helper for template literal in restoreSavedIdeas
function extractSuggestedTickers(text) {
    const matches = text.match(/^\d+\.\s*([A-Z]{1,5})\s*@/gm) || [];
    return matches.map(m => m.match(/([A-Z]{1,5})/)?.[1]).filter(Boolean);
}

/**
 * Ideas Tab: AI Trade Ideas Generator (uses Ideas tab element IDs)
 */
window.getTradeIdeas2 = async function() {
    const ideaBtn = document.getElementById('ideaBtn2');
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaBtn || !ideaResults || !ideaContent) {
        console.error('Ideas tab elements not found');
        return;
    }
    
    // Get inputs from Ideas tab
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC2')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid2')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect2')?.value || 'qwen2.5:32b';
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaBtn.textContent = '⏳ Generating...';
    ideaResults.style.display = 'block';
    ideaContent.innerHTML = '<span style="color:#888;">🔄 AI is researching trade ideas... (15-30 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Store candidates for deep dive and "Show Different" feature
        window._lastTradeIdeas = result.candidates || [];
        window._lastSuggestedTickers = extractSuggestedTickers(result.ideas);
        
        // Save to localStorage for persistence across tab switches
        localStorage.setItem('wheelhouse_trade_ideas', JSON.stringify({
            ideas: result.ideas,
            candidates: result.candidates,
            candidatesChecked: result.candidatesChecked,
            discoveredCount: result.discoveredCount,
            timestamp: Date.now()
        }));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#8b5cf6; border:none; border-radius:3px; color:#fff; cursor:pointer;" title="Comprehensive scenario analysis">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show what stocks were in the candidate pool
        const allCandidates = result.candidates || [];
        const discoveredTickers = allCandidates.filter(c => c.sector === 'Active Today' || c.sector === 'Trending');
        const curatedTickers = allCandidates.filter(c => c.sector !== 'Active Today' && c.sector !== 'Trending');
        
        const poolNote = `<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">
            <div style="color:#888; margin-bottom:8px;">
                📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ${result.candidatesChecked || 0} stocks scanned
                ${result.discoveredCount > 0 ? `(including <span style="color:#ffaa00;">${result.discoveredCount} market movers</span>)` : ''}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${allCandidates.map(t => {
                    const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
                    const bg = isDiscovered ? '#4a3500' : '#333';
                    const border = isDiscovered ? '1px solid #ffaa00' : 'none';
                    return `<span style="background:${bg}; border:${border}; padding:2px 6px; border-radius:3px; color:#ccc;">${t.ticker}</span>`;
                }).join('')}
            </div>
        </div>`;
        
        // Add "Show Different Stocks" button at the end
        formatted += `
            ${poolNote}
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;" title="Get fresh suggestions from different stocks">
                    🔄 Show Different Stocks
                </button>
                <span style="margin-left:10px; color:#666; font-size:11px;">${result.candidatesChecked || 0} stocks scanned</span>
            </div>`;
        
        ideaContent.innerHTML = formatted;
        
    } catch (error) {
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${error.message}</span>`;
    } finally {
        ideaBtn.disabled = false;
        ideaBtn.textContent = '💡 Generate Trade Ideas';
    }
};

/**
 * "Show Different Stocks" - Re-run ideas excluding previously suggested tickers
 */
window.getTradeIdeasDifferent = async function() {
    const ideaBtn = document.getElementById('ideaBtn2');
    const ideaResults = document.getElementById('ideaResultsLarge');
    const ideaContent = document.getElementById('ideaContentLarge');
    
    if (!ideaBtn || !ideaResults || !ideaContent) return;
    
    // Get previously suggested tickers to exclude
    const excludeTickers = window._lastSuggestedTickers || [];
    console.log('[Ideas] Excluding previous picks:', excludeTickers);
    
    // Get inputs from Ideas tab
    const buyingPower = parseFloat(document.getElementById('ideaBuyingPower2')?.value) || 25000;
    const targetROC = parseFloat(document.getElementById('ideaTargetROC2')?.value) || 25;
    const sectorsToAvoid = document.getElementById('ideaSectorsAvoid2')?.value || '';
    const selectedModel = document.getElementById('ideaModelSelect2')?.value || 'qwen2.5:32b';
    
    // Gather current positions for context
    const currentPositions = (window.state?.positions || []).map(p => ({
        ticker: p.ticker,
        type: p.type,
        strike: p.strike,
        sector: p.sector || 'Unknown'
    }));
    
    // Show loading
    ideaBtn.disabled = true;
    ideaContent.innerHTML = '<span style="color:#888;">� Scanning fresh stocks from curated + active + trending... (20-40 seconds)</span>';
    
    try {
        const response = await fetch('/api/ai/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                buyingPower,
                targetAnnualROC: targetROC,
                sectorsToAvoid,
                currentPositions,
                model: selectedModel,
                excludeTickers  // Pass exclusion list
            })
        });
        
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'API error');
        }
        
        const result = await response.json();
        
        // Accumulate excluded tickers for next "Show Different"
        const newTickers = extractSuggestedTickers(result.ideas);
        window._lastSuggestedTickers = [...new Set([...excludeTickers, ...newTickers])];
        window._lastTradeIdeas = result.candidates || [];
        
        // Save to localStorage for persistence
        localStorage.setItem('wheelhouse_trade_ideas', JSON.stringify({
            ideas: result.ideas,
            candidates: result.candidates,
            candidatesChecked: result.candidatesChecked,
            discoveredCount: result.discoveredCount,
            timestamp: Date.now()
        }));
        
        // Format with deep dive buttons - match "1. TICKER" or "1. **TICKER" format
        let formatted = result.ideas.replace(/^(\d+)\.\s*\*{0,2}([A-Z]{1,5})\s*@\s*\$[\d.]+/gm, 
            (match, num, ticker) => {
                return `${match} <button onclick="window.deepDive('${ticker}')" style="font-size:10px; padding:2px 6px; margin-left:8px; background:#8b5cf6; border:none; border-radius:3px; color:#fff; cursor:pointer;">🔍 Deep Dive</button>`;
            });
        
        // Apply styling
        formatted = formatted
            .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#00d9ff;">$1</strong>')
            .replace(/(Entry:|Why:|Risk:|Capital:)/gi, '<span style="color:#888;">$1</span>')
            .replace(/✅|📊|💡|🎯|⚠️/g, match => `<span style="font-size:1.1em;">${match}</span>`);
        
        // Show what stocks were in the candidate pool
        const allCandidates = result.candidates || [];
        const poolNote = `<div style="margin-top:15px; padding:12px; background:#1a1a2e; border-radius:5px; font-size:11px;">
            <div style="color:#888; margin-bottom:8px;">
                📊 <strong style="color:#00d9ff;">Candidate Pool:</strong> ${result.candidatesChecked || 0} stocks scanned
                ${result.discoveredCount > 0 ? `(including <span style="color:#ffaa00;">${result.discoveredCount} market movers</span>)` : ''}
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${allCandidates.map(t => {
                    const isDiscovered = t.sector === 'Active Today' || t.sector === 'Trending';
                    const bg = isDiscovered ? '#4a3500' : '#333';
                    const border = isDiscovered ? '1px solid #ffaa00' : 'none';
                    return `<span style="background:${bg}; border:${border}; padding:2px 6px; border-radius:3px; color:#ccc;">${t.ticker}</span>`;
                }).join('')}
            </div>
        </div>`;
        
        // Add "Show Different" button + "Reset" option
        formatted += `
            ${poolNote}
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #333; text-align:center;">
                <button onclick="window.getTradeIdeasDifferent()" style="padding:8px 16px; background:#444; border:none; border-radius:5px; color:#00d9ff; cursor:pointer; font-size:13px;">
                    🔄 Show More Different Stocks
                </button>
                <button onclick="window._lastSuggestedTickers=[]; window.getTradeIdeas2();" style="padding:8px 16px; margin-left:10px; background:#333; border:none; border-radius:5px; color:#888; cursor:pointer; font-size:13px;" title="Reset exclusions and start fresh">
                    ↩️ Reset
                </button>
                <span style="margin-left:10px; color:#666; font-size:11px;">${window._lastSuggestedTickers.length} excluded • ${result.candidatesChecked || 0} scanned</span>
            </div>`;
        
        ideaContent.innerHTML = formatted;
        
    } catch (error) {
        ideaContent.innerHTML = `<span style="color:#ff5252;">❌ ${error.message}</span>`;
    } finally {
        ideaBtn.disabled = false;
        ideaBtn.textContent = '💡 Generate Trade Ideas';
    }
};

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
    ctx.fillStyle = '#8b5cf6';
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

/**
 * Toggle collapsible sections in Portfolio tab
 * Saves state to localStorage for persistence
 */
window.toggleSection = function(sectionId) {
    const header = document.getElementById(sectionId + 'Header');
    const content = document.getElementById(sectionId + 'Content');
    
    if (!header || !content) return;
    
    const isCollapsed = header.classList.toggle('collapsed');
    content.classList.toggle('collapsed', isCollapsed);
    
    // Save state to localStorage
    const collapsedSections = JSON.parse(localStorage.getItem('wheelhouse_collapsed_sections') || '{}');
    collapsedSections[sectionId] = isCollapsed;
    localStorage.setItem('wheelhouse_collapsed_sections', JSON.stringify(collapsedSections));
};

/**
 * Toggle ticker group in closed positions
 */
window.toggleTickerGroup = function(ticker) {
    const header = document.querySelector(`.ticker-group-header[data-ticker="${ticker}"]`);
    const trades = document.querySelector(`.ticker-group-trades[data-ticker="${ticker}"]`);
    
    if (!header || !trades) return;
    
    header.classList.toggle('collapsed');
    trades.classList.toggle('collapsed');
    
    // Save state
    const collapsedTickers = JSON.parse(localStorage.getItem('wheelhouse_collapsed_tickers') || '{}');
    collapsedTickers[ticker] = header.classList.contains('collapsed');
    localStorage.setItem('wheelhouse_collapsed_tickers', JSON.stringify(collapsedTickers));
};

/**
 * Restore collapsed section states on page load
 */
window.restoreCollapsedStates = function() {
    const collapsedSections = JSON.parse(localStorage.getItem('wheelhouse_collapsed_sections') || '{}');
    
    Object.entries(collapsedSections).forEach(([sectionId, isCollapsed]) => {
        if (isCollapsed) {
            const header = document.getElementById(sectionId + 'Header');
            const content = document.getElementById(sectionId + 'Content');
            if (header && content) {
                header.classList.add('collapsed');
                content.classList.add('collapsed');
            }
        }
    });
};

// Export for potential external use
export { setupTabs, setupButtons };
