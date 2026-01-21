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
    const settings = {
        SCHWAB_APP_KEY: document.getElementById('settingSchwabAppKey')?.value || '',
        SCHWAB_REFRESH_TOKEN: document.getElementById('settingSchwabRefreshToken')?.value || ''
    };
    
    updateStatus('schwabStatus', null, 'Testing...');
    
    try {
        const response = await fetch('/api/settings/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: 'schwab', settings })
        });
        
        const result = await response.json();
        updateStatus('schwabStatus', result.success, result.message);
    } catch (error) {
        updateStatus('schwabStatus', false, 'Connection failed');
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
// SCHWAB OAUTH (Future)
// ============================================================================

function startSchwabOAuth() {
    // TODO: Implement Schwab OAuth flow when API key is available
    // This will open a popup window to Schwab's login page
    alert('Schwab OAuth flow coming soon! First, save your App Key and App Secret, then this button will start the authentication process.');
}

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
window.testTelegramConnection = testTelegramConnection;
window.startSchwabOAuth = startSchwabOAuth;
