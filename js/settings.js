/**
 * settings.js - Frontend settings management
 * 
 * Handles loading, saving, and testing API credentials.
 * All secrets are stored on the server (.env), never in browser localStorage.
 */

// ============================================================================
// LOAD SETTINGS ON PAGE LOAD
// ============================================================================

async function loadSettings() {
    try {
        const response = await fetch('/api/settings');
        const data = await response.json();
        
        if (!data.success) {
            console.log('[SETTINGS] Failed to load:', data.error);
            return;
        }
        
        const settings = data.settings;
        
        // Populate form fields (masked values show as ••••••••)
        if (settings.SCHWAB_APP_KEY) {
            document.getElementById('settingSchwabAppKey').value = settings.SCHWAB_APP_KEY;
            updateStatus('schwabStatus', true, 'Configured');
        }
        if (settings.SCHWAB_APP_SECRET) {
            document.getElementById('settingSchwabAppSecret').value = settings.SCHWAB_APP_SECRET;
        }
        if (settings.SCHWAB_REFRESH_TOKEN) {
            document.getElementById('settingSchwabRefreshToken').value = settings.SCHWAB_REFRESH_TOKEN;
        }
        
        if (settings.OPENAI_API_KEY) {
            document.getElementById('settingOpenAIKey').value = settings.OPENAI_API_KEY;
            updateStatus('openaiStatus', true, 'Configured');
        }
        
        if (settings.GROK_API_KEY) {
            document.getElementById('settingGrokKey').value = settings.GROK_API_KEY;
            updateStatus('grokStatus', true, 'Configured');
            localStorage.setItem('wheelhouse_grok_configured', 'true');
        }
        
        if (settings.TELEGRAM_BOT_TOKEN) {
            document.getElementById('settingTelegramToken').value = settings.TELEGRAM_BOT_TOKEN;
        }
        if (settings.TELEGRAM_CHAT_ID) {
            document.getElementById('settingTelegramChatId').value = settings.TELEGRAM_CHAT_ID;
            if (settings.TELEGRAM_BOT_TOKEN) {
                updateStatus('telegramStatus', true, 'Configured');
            }
        }
        
        console.log('[SETTINGS] Loaded from server');
    } catch (error) {
        console.error('[SETTINGS] Load error:', error);
    }
}

// ============================================================================
// SAVE SETTINGS
// ============================================================================

async function saveAllSettings() {
    const statusEl = document.getElementById('settingsSaveStatus');
    statusEl.textContent = 'Saving...';
    statusEl.style.color = '#888';
    
    // Collect all settings from form
    const settings = {
        SCHWAB_APP_KEY: document.getElementById('settingSchwabAppKey')?.value || '',
        SCHWAB_APP_SECRET: document.getElementById('settingSchwabAppSecret')?.value || '',
        SCHWAB_REFRESH_TOKEN: document.getElementById('settingSchwabRefreshToken')?.value || '',
        OPENAI_API_KEY: document.getElementById('settingOpenAIKey')?.value || '',
        GROK_API_KEY: document.getElementById('settingGrokKey')?.value || '',
        TELEGRAM_BOT_TOKEN: document.getElementById('settingTelegramToken')?.value || '',
        TELEGRAM_CHAT_ID: document.getElementById('settingTelegramChatId')?.value || ''
    };
    
    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusEl.textContent = '✅ ' + data.message;
            statusEl.style.color = '#00ff88';
            
            // Update status badges
            if (settings.SCHWAB_APP_KEY && settings.SCHWAB_APP_KEY !== '••••••••') {
                updateStatus('schwabStatus', true, 'Configured');
            }
            if (settings.OPENAI_API_KEY && settings.OPENAI_API_KEY !== '••••••••') {
                updateStatus('openaiStatus', true, 'Configured');
            }
            if (settings.GROK_API_KEY && settings.GROK_API_KEY !== '••••••••') {
                updateStatus('grokStatus', true, 'Configured');
                localStorage.setItem('wheelhouse_grok_configured', 'true');
            }
            if (settings.TELEGRAM_BOT_TOKEN && settings.TELEGRAM_BOT_TOKEN !== '••••••••') {
                updateStatus('telegramStatus', true, 'Configured');
            }
        } else {
            statusEl.textContent = '❌ ' + data.error;
            statusEl.style.color = '#ff5252';
        }
    } catch (error) {
        statusEl.textContent = '❌ Connection error: ' + error.message;
        statusEl.style.color = '#ff5252';
    }
    
    // Clear status after 5 seconds
    setTimeout(() => {
        statusEl.textContent = '';
    }, 5000);
}

// ============================================================================
// TEST CONNECTIONS
// ============================================================================

async function testSchwabConnection() {
    updateStatus('schwabStatus', null, 'Testing...');
    
    try {
        // First check status
        const statusRes = await fetch('/api/schwab/status');
        const status = await statusRes.json();
        
        if (!status.configured) {
            updateStatus('schwabStatus', false, 'Not configured');
            return;
        }
        
        if (!status.hasRefreshToken) {
            updateStatus('schwabStatus', false, 'Need OAuth');
            return;
        }
        
        // Try to get account info (this will refresh access token if needed)
        const accountRes = await fetch('/api/schwab/accounts/numbers');
        const accounts = await accountRes.json();
        
        if (accounts.error) {
            updateStatus('schwabStatus', false, accounts.error.message || 'Auth failed');
            return;
        }
        
        if (accounts && accounts.length > 0) {
            updateStatus('schwabStatus', true, `Connected (${accounts.length} account${accounts.length > 1 ? 's' : ''})`);
        } else {
            updateStatus('schwabStatus', false, 'No accounts found');
        }
    } catch (error) {
        updateStatus('schwabStatus', false, 'Connection failed');
    }
}

/**
 * Load Schwab accounts into the dropdown
 */
async function loadSchwabAccounts() {
    const select = document.getElementById('schwabAccountSelect');
    if (!select) return;
    
    select.innerHTML = '<option value="">Loading...</option>';
    
    try {
        const accounts = await window.SchwabAPI.getAccountNumbers();
        
        if (!accounts || accounts.length === 0) {
            select.innerHTML = '<option value="">No accounts found</option>';
            return;
        }
        
        // Build options with account numbers and types
        const allAccounts = await window.SchwabAPI.getAccounts('positions');
        
        select.innerHTML = '';
        accounts.forEach((acct, idx) => {
            const option = document.createElement('option');
            option.value = acct.hashValue;
            
            // Try to get account type from full account data
            const fullAcct = allAccounts?.find(a => 
                a.securitiesAccount?.accountNumber === acct.accountNumber
            );
            const acctType = fullAcct?.securitiesAccount?.type || 'Unknown';
            const posCount = fullAcct?.securitiesAccount?.positions?.length || 0;
            
            option.textContent = `${acct.accountNumber} (${acctType}) - ${posCount} positions`;
            
            // Select first by default
            if (idx === 0) option.selected = true;
            
            select.appendChild(option);
        });
        
        // Save selection to localStorage
        select.addEventListener('change', () => {
            localStorage.setItem('schwab_selected_account', select.value);
        });
        
        // Restore previous selection if exists
        const saved = localStorage.getItem('schwab_selected_account');
        if (saved) {
            select.value = saved;
        }
        
    } catch (error) {
        console.error('Failed to load accounts:', error);
        select.innerHTML = '<option value="">Error loading accounts</option>';
    }
}

/**
 * Sync account positions from Schwab
 * Imports option positions and stock holdings into WheelHouse
 */
async function syncAccountFromSchwab() {
    const statusEl = document.getElementById('schwabSyncStatus');
    const syncBtn = document.getElementById('schwabSyncBtn');
    const accountSelect = document.getElementById('schwabAccountSelect');
    
    if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.innerHTML = '<span style="color:#00d9ff;">⏳ Fetching positions from Schwab...</span>';
    }
    if (syncBtn) syncBtn.disabled = true;
    
    try {
        // Check if Schwab is authenticated
        if (!window.SchwabAPI) {
            throw new Error('SchwabAPI not loaded');
        }
        
        const status = await window.SchwabAPI.getStatus();
        if (!status.hasRefreshToken) {
            throw new Error('Not authenticated. Please authenticate with Schwab first.');
        }
        
        // Get selected account hash
        const selectedAccountHash = accountSelect?.value || null;
        if (!selectedAccountHash) {
            throw new Error('Please select an account first. Click "Load Accounts" to populate the list.');
        }
        
        // Fetch positions from selected Schwab account
        const schwabPositions = await window.SchwabAPI.getPositions(selectedAccountHash);
        
        if (!schwabPositions || schwabPositions.length === 0) {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color:#888;">No positions found in Schwab account.</span>';
            }
            return;
        }
        
        // Separate options from stocks
        const optionPositions = schwabPositions.filter(p => p.type !== 'stock');
        const stockPositions = schwabPositions.filter(p => p.type === 'stock');
        
        // Load existing positions
        const existingPositions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
        const existingHoldings = JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
        
        let imported = 0;
        let skipped = 0;
        let holdingsImported = 0;
        
        // Helper: Check if two position types are equivalent
        // (e.g., covered_call should match buy_write since Schwab doesn't distinguish)
        const isEquivalentType = (type1, type2) => {
            if (type1 === type2) return true;
            // Covered calls and buy/writes are the same option position
            const callTypes = ['covered_call', 'buy_write'];
            if (callTypes.includes(type1) && callTypes.includes(type2)) return true;
            return false;
        };
        
        // Import option positions
        for (const schwabPos of optionPositions) {
            // Check for duplicates (same ticker, strike, expiry, equivalent type)
            const isDuplicate = existingPositions.some(p => 
                p.ticker === schwabPos.ticker &&
                p.strike === schwabPos.strike &&
                p.expiry === schwabPos.expiry &&
                isEquivalentType(p.type, schwabPos.type) &&
                p.status !== 'closed'
            );
            
            if (isDuplicate) {
                skipped++;
                continue;
            }
            
            // Convert Schwab position to WheelHouse format
            const newPosition = {
                id: Date.now() + imported,
                chainId: Date.now() + imported,
                ticker: schwabPos.ticker,
                type: schwabPos.type,
                strike: schwabPos.strike,
                contracts: schwabPos.contracts,
                premium: schwabPos.averagePrice,
                expiry: schwabPos.expiry,
                openDate: new Date().toISOString().split('T')[0],
                status: 'open',
                broker: 'Schwab',
                source: 'schwab_sync',
                schwabSymbol: schwabPos.symbol,
                currentSpot: null, // Will be fetched on next refresh
                lastOptionPrice: schwabPos.currentPrice || null,
                markedPrice: schwabPos.currentPrice || null
            };
            
            // Calculate DTE
            const expiryDate = new Date(schwabPos.expiry + 'T16:00:00');
            const now = new Date();
            newPosition.dte = Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)));
            
            existingPositions.push(newPosition);
            imported++;
        }
        
        // Import stock holdings
        for (const schwabStock of stockPositions) {
            // Check for duplicate stock holding
            const existingHolding = existingHoldings.find(h => h.ticker === schwabStock.ticker);
            
            if (existingHolding) {
                // Update existing holding with Schwab data
                existingHolding.shares = schwabStock.shares;
                existingHolding.costBasis = schwabStock.averagePrice;
                existingHolding.totalCost = schwabStock.shares * schwabStock.averagePrice;
                existingHolding.currentPrice = schwabStock.currentPrice;
                existingHolding.marketValue = schwabStock.marketValue;
                holdingsImported++;
            } else {
                // Create new holding
                const newHolding = {
                    id: Date.now() + imported + holdingsImported,
                    ticker: schwabStock.ticker,
                    shares: schwabStock.shares,
                    costBasis: schwabStock.averagePrice,
                    totalCost: schwabStock.shares * schwabStock.averagePrice,
                    currentPrice: schwabStock.currentPrice,
                    marketValue: schwabStock.marketValue,
                    source: 'schwab_sync',
                    assignedDate: new Date().toISOString().split('T')[0],
                    acquiredDate: new Date().toISOString().split('T')[0],
                    premiumCredit: 0
                };
                existingHoldings.push(newHolding);
                holdingsImported++;
            }
        }
        
        // Save to localStorage
        localStorage.setItem('wheelhouse_positions', JSON.stringify(existingPositions));
        localStorage.setItem('wheelhouse_holdings', JSON.stringify(existingHoldings));
        
        // Show results
        const messages = [];
        if (imported > 0) messages.push(`✅ Imported ${imported} option position${imported > 1 ? 's' : ''}`);
        if (holdingsImported > 0) messages.push(`✅ Synced ${holdingsImported} stock holding${holdingsImported > 1 ? 's' : ''}`);
        if (skipped > 0) messages.push(`⏭️ Skipped ${skipped} duplicate${skipped > 1 ? 's' : ''}`);
        
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:#00ff88;">${messages.join(' | ')}</span>`;
        }
        
        // Refresh positions view if available
        if (window.loadPositions) {
            window.loadPositions();
        }
        
        // Show notification
        if (window.showNotification) {
            window.showNotification(
                `Schwab Sync: ${imported} options, ${holdingsImported} stocks imported`, 
                'success'
            );
        }
        
    } catch (error) {
        console.error('Schwab sync error:', error);
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:#ff5252;">❌ ${error.message}</span>`;
        }
    } finally {
        if (syncBtn) syncBtn.disabled = false;
    }
}

async function testOpenAIConnection() {
    const settings = {
        OPENAI_API_KEY: document.getElementById('settingOpenAIKey')?.value || ''
    };
    
    updateStatus('openaiStatus', null, 'Testing...');
    
    try {
        const response = await fetch('/api/settings/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'openai', settings })
        });
        
        const result = await response.json();
        updateStatus('openaiStatus', result.success, result.message);
    } catch (error) {
        updateStatus('openaiStatus', false, 'Connection failed');
    }
}

async function testGrokConnection() {
    const settings = {
        GROK_API_KEY: document.getElementById('settingGrokKey')?.value || ''
    };
    
    updateStatus('grokStatus', null, 'Testing...');
    
    try {
        const response = await fetch('/api/settings/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'grok', settings })
        });
        
        const result = await response.json();
        updateStatus('grokStatus', result.success, result.message);
        
        // Set flag so model dropdowns know Grok is available
        if (result.success) {
            localStorage.setItem('wheelhouse_grok_configured', 'true');
        }
    } catch (error) {
        updateStatus('grokStatus', false, 'Connection failed');
    }
}

async function testTelegramConnection() {
    const settings = {
        TELEGRAM_BOT_TOKEN: document.getElementById('settingTelegramToken')?.value || '',
        TELEGRAM_CHAT_ID: document.getElementById('settingTelegramChatId')?.value || ''
    };
    
    updateStatus('telegramStatus', null, 'Testing...');
    
    try {
        const response = await fetch('/api/settings/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'telegram', settings })
        });
        
        const result = await response.json();
        updateStatus('telegramStatus', result.success, result.message);
    } catch (error) {
        updateStatus('telegramStatus', false, 'Connection failed');
    }
}

// ============================================================================
// SCHWAB OAUTH
// ============================================================================

async function startSchwabOAuth() {
    // First, ensure credentials are saved
    const appKey = document.getElementById('settingSchwabAppKey')?.value || '';
    const appSecret = document.getElementById('settingSchwabAppSecret')?.value || '';
    
    if (!appKey || appKey === '••••••••' || !appSecret || appSecret === '••••••••') {
        alert('Please enter and save your Schwab App Key and App Secret first!');
        return;
    }
    
    // Save credentials before starting OAuth
    await saveAllSettings();
    
    // Get the authorization URL
    try {
        const response = await fetch('/api/schwab/authorize-url');
        const data = await response.json();
        
        if (data.error) {
            alert('Error: ' + data.error);
            return;
        }
        
        // Show instructions modal
        showOAuthModal(data.url, data.instructions);
        
    } catch (error) {
        alert('Error starting OAuth: ' + error.message);
    }
}

function showOAuthModal(authUrl, instructions) {
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'schwabOAuthModal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.9); display: flex; align-items: center;
        justify-content: center; z-index: 100000;
    `;
    
    modal.innerHTML = `
        <div style="background: #1a1a2e; border-radius: 16px; padding: 30px; max-width: 600px; width: 90%; border: 1px solid #333;">
            <h2 style="color: #00ff88; margin-top: 0;">🔐 Schwab OAuth Authentication</h2>
            
            <div style="background: #0d0d1a; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                <h4 style="color: #0df; margin-top: 0;">Instructions:</h4>
                <ol style="color: #ccc; line-height: 1.8; padding-left: 20px;">
                    <li>Click the "Open Schwab Login" button below</li>
                    <li>Log in with your Schwab.com credentials</li>
                    <li>Authorize WheelHouse to access your account</li>
                    <li>You'll be redirected to a page that fails to load - <strong style="color:#ffaa00">that's OK!</strong></li>
                    <li>Copy the <strong>entire URL</strong> from your browser's address bar</li>
                    <li>Paste it in the field below and click "Complete"</li>
                </ol>
            </div>
            
            <div style="text-align: center; margin-bottom: 20px;">
                <a href="${authUrl}" target="_blank" 
                   style="display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #00ff88, #00d9ff); 
                          color: #000; font-weight: bold; border-radius: 8px; text-decoration: none;">
                    🔗 Open Schwab Login
                </a>
            </div>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; color: #888; font-size: 12px; margin-bottom: 4px;">
                    Paste the redirect URL here:
                </label>
                <input type="text" id="schwabRedirectUrl" placeholder="https://127.0.0.1:5556/?code=..." 
                       style="width: 100%; padding: 12px; background: #0d0d1a; border: 1px solid #444; 
                              border-radius: 8px; color: #fff; font-family: monospace; font-size: 12px;">
            </div>
            
            <div id="oauthStatus" style="margin-bottom: 15px; font-size: 12px;"></div>
            
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button onclick="document.getElementById('schwabOAuthModal').remove()" 
                        style="padding: 10px 20px; background: #333; border: none; color: #fff; border-radius: 8px; cursor: pointer;">
                    Cancel
                </button>
                <button onclick="completeSchwabOAuth()" 
                        style="padding: 10px 20px; background: #00ff88; border: none; color: #000; font-weight: bold; 
                               border-radius: 8px; cursor: pointer;">
                    ✅ Complete OAuth
                </button>
            </div>
        </div>
    `;
    
    modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
    };
    
    document.body.appendChild(modal);
}

async function completeSchwabOAuth() {
    const redirectUrl = document.getElementById('schwabRedirectUrl')?.value || '';
    const statusEl = document.getElementById('oauthStatus');
    
    if (!redirectUrl) {
        statusEl.innerHTML = '<span style="color:#ff5252">❌ Please paste the redirect URL</span>';
        return;
    }
    
    if (!redirectUrl.includes('code=')) {
        statusEl.innerHTML = '<span style="color:#ff5252">❌ Invalid URL - must contain "code=" parameter</span>';
        return;
    }
    
    statusEl.innerHTML = '<span style="color:#ffaa00">⏳ Completing OAuth...</span>';
    
    try {
        const response = await fetch('/api/schwab/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ redirectUrl })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusEl.innerHTML = '<span style="color:#00ff88">✅ ' + data.message + '</span>';
            updateStatus('schwabStatus', true, 'Authenticated');
            
            // Reload settings to show the new refresh token
            setTimeout(() => {
                document.getElementById('schwabOAuthModal').remove();
                loadSettings();
            }, 2000);
        } else {
            statusEl.innerHTML = '<span style="color:#ff5252">❌ ' + (data.error || 'OAuth failed') + '</span>';
        }
    } catch (error) {
        statusEl.innerHTML = '<span style="color:#ff5252">❌ Error: ' + error.message + '</span>';
    }
}

// Expose OAuth functions globally
window.completeSchwabOAuth = completeSchwabOAuth;

// ============================================================================
// SCHWAB ORDERS - VIEW PENDING AND RECENT ORDERS
// ============================================================================

/**
 * Toggle visibility of the orders panel
 */
async function viewSchwabOrders() {
    const panel = document.getElementById('schwabOrdersPanel');
    if (!panel) return;
    
    // Toggle visibility
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = 'block';
        await refreshSchwabOrders();
    } else {
        panel.style.display = 'none';
    }
}

/**
 * Fetch and display orders from Schwab
 */
async function refreshSchwabOrders() {
    const listEl = document.getElementById('schwabOrdersList');
    if (!listEl) return;
    
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#888">⏳ Loading orders...</div>';
    
    try {
        // Get selected account hash
        const accountSelect = document.getElementById('schwabAccountSelect');
        if (!accountSelect || !accountSelect.value) {
            listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#ffaa00">⚠️ Please select an account first</div>';
            return;
        }
        
        const accountHash = accountSelect.value;
        
        // Fetch orders from last 7 days - Schwab needs full ISO 8601 format
        const toDate = new Date().toISOString();
        const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        
        const response = await fetch(`/api/schwab/accounts/${accountHash}/orders?fromEnteredTime=${encodeURIComponent(fromDate)}&toEnteredTime=${encodeURIComponent(toDate)}`);
        const data = await response.json();
        
        if (!data.success) {
            listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#ff5252">❌ ${data.error || 'Failed to load orders'}</div>`;
            return;
        }
        
        const orders = data.orders || [];
        
        if (orders.length === 0) {
            listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#888">No orders in the last 7 days</div>';
            return;
        }
        
        // Sort by entered time (newest first)
        orders.sort((a, b) => new Date(b.enteredTime) - new Date(a.enteredTime));
        
        // Build HTML for orders
        let html = '';
        for (const order of orders) {
            html += renderOrderRow(order);
        }
        
        listEl.innerHTML = html;
        
    } catch (error) {
        console.error('[ORDERS] Error:', error);
        listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#ff5252">❌ Error: ${error.message}</div>`;
    }
}

/**
 * Render a single order row
 */
function renderOrderRow(order) {
    const status = order.status || 'UNKNOWN';
    const orderType = order.orderType || '';
    const instruction = order.orderLegCollection?.[0]?.instruction || '';
    const quantity = order.quantity || order.orderLegCollection?.[0]?.quantity || 0;
    const filledQty = order.filledQuantity || 0;
    const price = order.price || order.stopPrice || 0;
    
    // Parse the instrument
    const leg = order.orderLegCollection?.[0] || {};
    const instrument = leg.instrument || {};
    const symbol = instrument.symbol || '';
    const assetType = instrument.assetType || 'EQUITY';
    
    // Parse option symbol if it's an option
    let displaySymbol = symbol;
    let optionDetails = '';
    if (assetType === 'OPTION' && symbol.length > 10) {
        const parsed = parseOptionSymbol(symbol);
        if (parsed) {
            displaySymbol = parsed.ticker;
            optionDetails = `${parsed.expiry} $${parsed.strike} ${parsed.type}`;
        }
    }
    
    // Status colors
    const statusColors = {
        'FILLED': '#00ff88',
        'WORKING': '#00d9ff',
        'PENDING_ACTIVATION': '#ffaa00',
        'QUEUED': '#ffaa00',
        'ACCEPTED': '#00d9ff',
        'CANCELED': '#888',
        'REJECTED': '#ff5252',
        'EXPIRED': '#888'
    };
    const statusColor = statusColors[status] || '#888';
    
    // Instruction colors
    const instructionColors = {
        'SELL_TO_OPEN': '#00ff88',
        'BUY_TO_CLOSE': '#ff5252',
        'BUY_TO_OPEN': '#00d9ff',
        'SELL_TO_CLOSE': '#ffaa00'
    };
    const instrColor = instructionColors[instruction] || '#ccc';
    
    // Format time
    const enteredTime = order.enteredTime ? new Date(order.enteredTime).toLocaleString() : '';
    
    // Can cancel if working/pending
    const canCancel = ['WORKING', 'PENDING_ACTIVATION', 'QUEUED', 'ACCEPTED'].includes(status);
    
    return `
        <div style="display:flex; align-items:center; gap:12px; padding:10px 12px; background:#1a1a2e; border-radius:6px; margin-bottom:8px;">
            <!-- Status Badge -->
            <div style="min-width:80px;">
                <span style="background:${statusColor}22; color:${statusColor}; padding:3px 8px; border-radius:4px; font-size:11px; font-weight:600;">
                    ${status}
                </span>
            </div>
            
            <!-- Symbol & Details -->
            <div style="flex:1;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="color:${instrColor}; font-weight:600;">${instruction.replace(/_/g, ' ')}</span>
                    <span style="color:#fff; font-weight:600;">${displaySymbol}</span>
                    ${optionDetails ? `<span style="color:#888; font-size:12px;">${optionDetails}</span>` : ''}
                </div>
                <div style="color:#666; font-size:11px; margin-top:2px;">${enteredTime}</div>
            </div>
            
            <!-- Quantity -->
            <div style="text-align:center; min-width:60px;">
                <div style="color:#fff; font-weight:600;">${filledQty}/${quantity}</div>
                <div style="color:#666; font-size:10px;">FILLED</div>
            </div>
            
            <!-- Price -->
            <div style="text-align:right; min-width:70px;">
                <div style="color:#00d9ff; font-weight:600;">$${price.toFixed(2)}</div>
                <div style="color:#666; font-size:10px;">${orderType}</div>
            </div>
            
            <!-- Cancel Button -->
            ${canCancel ? `
                <button onclick="cancelSchwabOrder('${order.orderId}')" 
                        style="background:#ff525233; color:#ff5252; border:1px solid #ff5252; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;"
                        title="Cancel Order">
                    ✕ Cancel
                </button>
            ` : '<div style="width:70px;"></div>'}
        </div>
    `;
}

/**
 * Parse Schwab option symbol format
 * Example: "SLV   260123C00085500" → { ticker: "SLV", expiry: "01/23/26", strike: 85.5, type: "Call" }
 */
function parseOptionSymbol(symbol) {
    try {
        // Symbol format: TICKER + YYMMDD + C/P + 8-digit strike
        const match = symbol.match(/^([A-Z]+)\s*(\d{6})([CP])(\d{8})$/);
        if (!match) return null;
        
        const [, ticker, dateStr, cpFlag, strikeStr] = match;
        
        // Parse date YYMMDD
        const yy = dateStr.substring(0, 2);
        const mm = dateStr.substring(2, 4);
        const dd = dateStr.substring(4, 6);
        const expiry = `${mm}/${dd}/${yy}`;
        
        // Parse strike (8 digits, last 3 are decimals)
        const strike = parseInt(strikeStr) / 1000;
        
        const type = cpFlag === 'C' ? 'Call' : 'Put';
        
        return { ticker, expiry, strike, type };
    } catch (e) {
        return null;
    }
}

/**
 * Cancel a pending order
 */
async function cancelSchwabOrder(orderId) {
    if (!confirm('Are you sure you want to cancel this order?')) return;
    
    try {
        const accountSelect = document.getElementById('schwabAccountSelect');
        if (!accountSelect || !accountSelect.value) {
            alert('No account selected');
            return;
        }
        
        const accountHash = accountSelect.value;
        
        const response = await fetch(`/api/schwab/accounts/${accountHash}/orders/${orderId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            if (window.showNotification) window.showNotification('Order canceled successfully', 'success');
            // Refresh the orders list
            await refreshSchwabOrders();
        } else {
            if (window.showNotification) window.showNotification(data.error || 'Failed to cancel order', 'error');
        }
    } catch (error) {
        console.error('[ORDERS] Cancel error:', error);
        if (window.showNotification) window.showNotification('Error canceling order: ' + error.message, 'error');
    }
}

// Expose order functions globally
window.viewSchwabOrders = viewSchwabOrders;
window.refreshSchwabOrders = refreshSchwabOrders;
window.cancelSchwabOrder = cancelSchwabOrder;

// ============================================================================
// HELPERS
// ============================================================================

function updateStatus(elementId, success, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    
    el.textContent = message;
    
    if (success === null) {
        // Testing state
        el.style.background = '#444';
        el.style.color = '#fff';
    } else if (success) {
        el.style.background = 'rgba(0,255,136,0.2)';
        el.style.color = '#00ff88';
    } else {
        el.style.background = 'rgba(255,82,82,0.2)';
        el.style.color = '#ff5252';
    }
}

// ============================================================================
// INITIALIZE
// ============================================================================

// Load settings when page loads
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure DOM is fully ready
    setTimeout(loadSettings, 100);
});

// Expose functions globally for onclick handlers
window.saveAllSettings = saveAllSettings;
window.testSchwabConnection = testSchwabConnection;
window.testOpenAIConnection = testOpenAIConnection;
window.testGrokConnection = testGrokConnection;
window.testTelegramConnection = testTelegramConnection;
window.startSchwabOAuth = startSchwabOAuth;
window.syncAccountFromSchwab = syncAccountFromSchwab;
window.loadSchwabAccounts = loadSchwabAccounts;
