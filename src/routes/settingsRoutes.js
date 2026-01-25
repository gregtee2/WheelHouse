/**
 * settingsRoutes.js - Settings API endpoints with security
 * 
 * Handles reading/writing .env configuration with:
 * - Allowlist of permitted keys
 * - Secret masking (never expose tokens to frontend)
 * - Localhost-only access for security
 * - Secure storage integration when in Electron mode
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const secureStore = require('../secureStore');

// ============================================================================
// SECURITY CONFIGURATION
// ============================================================================

// Allowlist of settings that can be read/written via API
const ALLOWED_SETTINGS = [
    // Server
    'PORT',
    // Schwab API
    'SCHWAB_APP_KEY',
    'SCHWAB_APP_SECRET', 
    'SCHWAB_REFRESH_TOKEN',
    'SCHWAB_ACCESS_TOKEN',
    // AI
    'OPENAI_API_KEY',
    'GROK_API_KEY',
    // Market Data
    'POLYGON_API_KEY',
    // Notifications
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID'
];

// Settings that should NEVER be returned in plaintext
const SECRET_SETTINGS = new Set([
    'SCHWAB_APP_KEY',
    'SCHWAB_APP_SECRET',
    'SCHWAB_REFRESH_TOKEN',
    'SCHWAB_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'GROK_API_KEY',
    'POLYGON_API_KEY',
    'TELEGRAM_BOT_TOKEN'
]);

// Middleware: Only allow localhost access to settings API
const requireLocalhost = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
    
    if (!isLocal) {
        console.log(`[SECURITY] Blocked non-local settings access from: ${ip}`);
        return res.status(403).json({ 
            success: false, 
            error: 'Settings API is only accessible from localhost' 
        });
    }
    next();
};

// Helper to get .env path (at project root, not src/)
const getEnvPath = () => path.join(__dirname, '../../.env');

// ============================================================================
// GET /api/settings - Read current settings (masked secrets)
// ============================================================================
router.get('/', requireLocalhost, async (req, res) => {
    try {
        const envPath = getEnvPath();
        let envContent = '';
        
        try {
            envContent = await fs.readFile(envPath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                // No .env yet - return empty settings
                console.log('[SETTINGS] No .env file found, returning empty settings');
                return res.json({ success: true, settings: {} });
            }
            throw err;
        }
        
        const settings = {};
        const lines = envContent.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex > 0) {
                    const key = trimmed.substring(0, eqIndex).trim();
                    const value = trimmed.substring(eqIndex + 1).trim();
                    
                    // Only return allowed settings
                    if (ALLOWED_SETTINGS.includes(key)) {
                        // Mask secret values
                        if (SECRET_SETTINGS.has(key)) {
                            settings[key] = value ? '••••••••' : '';
                        } else {
                            settings[key] = value;
                        }
                    }
                }
            }
        }
        
        res.json({ success: true, settings });
        console.log('[SETTINGS] Settings fetched via API');
    } catch (error) {
        console.error('[SETTINGS] Failed to read settings:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// POST /api/settings - Update settings
// ============================================================================
router.post('/', requireLocalhost, express.json(), async (req, res) => {
    try {
        const { settings: newSettings } = req.body;
        
        if (!newSettings || typeof newSettings !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid settings data' });
        }
        
        const envPath = getEnvPath();
        
        // Read existing .env or create new one
        let envContent = '';
        try {
            envContent = await fs.readFile(envPath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.log('[SETTINGS] Creating new .env file');
                envContent = '# WheelHouse Environment Configuration\n# Created automatically via Settings UI\n\n';
            } else {
                throw err;
            }
        }
        
        let updatedCount = 0;
        let secureCount = 0;
        
        // Process each setting update
        for (const [key, value] of Object.entries(newSettings)) {
            // Security: Only allow whitelisted keys
            if (!ALLOWED_SETTINGS.includes(key)) {
                console.log(`[SETTINGS] Blocked non-allowed key: ${key}`);
                continue;
            }
            
            // Skip masked values (no change intended)
            if (SECRET_SETTINGS.has(key)) {
                if (value === '••••••••' || value === '********' || value === '' || value == null) {
                    continue;
                }
            }
            
            // Sanitize value (prevent newline injection)
            const sanitizedValue = String(value).replace(/[\r\n]/g, '');
            
            // Use secure storage for secrets when in Electron mode
            if (secureStore.isSecure() && secureStore.SECURE_KEYS.has(key)) {
                secureStore.set(key, sanitizedValue);
                secureCount++;
                console.log(`[SETTINGS] Stored ${key} in secure storage`);
            } else {
                // Check if key exists in file
                const regex = new RegExp(`^${key}=.*$`, 'm');
                if (regex.test(envContent)) {
                    // Update existing key
                    envContent = envContent.replace(regex, `${key}=${sanitizedValue}`);
                } else {
                    // Append new key
                    envContent = envContent.trimEnd() + `\n${key}=${sanitizedValue}\n`;
                }
            }
            
            // Update process.env for immediate effect
            process.env[key] = sanitizedValue;
            updatedCount++;
        }
        
        // Write back to .env file (even if some went to secure storage)
        await fs.writeFile(envPath, envContent, 'utf-8');
        
        const secureMsg = secureCount > 0 ? ` (${secureCount} secured)` : '';
        res.json({ 
            success: true, 
            message: `Settings saved successfully (${updatedCount} updated${secureMsg})`,
            secureMode: secureStore.isSecure()
        });
        console.log(`[SETTINGS] Updated ${updatedCount} settings via API${secureMsg}`);
    } catch (error) {
        console.error('[SETTINGS] Failed to save settings:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// POST /api/settings/test - Test a service connection
// ============================================================================
router.post('/test', requireLocalhost, express.json(), async (req, res) => {
    const { service, settings } = req.body;
    
    // Helper to get setting value (skip masked values, fall back to process.env)
    const getSetting = (key) => {
        const val = settings?.[key];
        if (val === '••••••••' || val === '********') return process.env[key];
        return val || process.env[key];
    };
    
    try {
        let result = { success: false, message: 'Unknown service' };
        
        switch (service) {
            case 'schwab': {
                const appKey = getSetting('SCHWAB_APP_KEY');
                const refreshToken = getSetting('SCHWAB_REFRESH_TOKEN');
                
                if (!appKey || !refreshToken) {
                    result = { success: false, message: 'Missing Schwab App Key or Refresh Token' };
                    break;
                }
                
                // TODO: Actually test Schwab API connection
                // For now, just verify the values are present
                result = { 
                    success: true, 
                    message: 'Schwab credentials configured (connection test coming soon)' 
                };
                break;
            }
            
            case 'openai': {
                const apiKey = getSetting('OPENAI_API_KEY');
                
                if (!apiKey) {
                    result = { success: false, message: 'Missing OpenAI API Key' };
                    break;
                }
                
                // Test OpenAI API with a simple request
                const https = require('https');
                const testResult = await new Promise((resolve) => {
                    const req = https.request({
                        hostname: 'api.openai.com',
                        path: '/v1/models',
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`
                        }
                    }, (response) => {
                        if (response.statusCode === 200) {
                            resolve({ success: true, message: 'OpenAI API connected successfully' });
                        } else if (response.statusCode === 401) {
                            resolve({ success: false, message: 'Invalid OpenAI API key' });
                        } else {
                            resolve({ success: false, message: `OpenAI API error: ${response.statusCode}` });
                        }
                    });
                    req.on('error', (e) => {
                        resolve({ success: false, message: `Connection error: ${e.message}` });
                    });
                    req.setTimeout(5000, () => {
                        req.destroy();
                        resolve({ success: false, message: 'Connection timeout' });
                    });
                    req.end();
                });
                result = testResult;
                break;
            }
            
            case 'telegram': {
                const token = getSetting('TELEGRAM_BOT_TOKEN');
                const chatId = getSetting('TELEGRAM_CHAT_ID');
                
                if (!token || !chatId) {
                    result = { success: false, message: 'Missing Telegram Bot Token or Chat ID' };
                    break;
                }
                
                // Test by getting bot info
                const https = require('https');
                const testResult = await new Promise((resolve) => {
                    https.get(`https://api.telegram.org/bot${token}/getMe`, (response) => {
                        let data = '';
                        response.on('data', chunk => data += chunk);
                        response.on('end', () => {
                            try {
                                const json = JSON.parse(data);
                                if (json.ok) {
                                    resolve({ success: true, message: `Connected as @${json.result.username}` });
                                } else {
                                    resolve({ success: false, message: json.description || 'Unknown error' });
                                }
                            } catch (e) {
                                resolve({ success: false, message: 'Invalid response' });
                            }
                        });
                    }).on('error', (e) => {
                        resolve({ success: false, message: e.message });
                    });
                });
                result = testResult;
                break;
            }
            
            case 'grok': {
                const apiKey = getSetting('GROK_API_KEY');
                
                if (!apiKey) {
                    result = { success: false, message: 'Missing Grok API Key' };
                    break;
                }
                
                // Test Grok API with a simple models list request
                const https = require('https');
                const testResult = await new Promise((resolve) => {
                    const req = https.request({
                        hostname: 'api.x.ai',
                        path: '/v1/models',
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        }
                    }, (response) => {
                        let data = '';
                        response.on('data', chunk => data += chunk);
                        response.on('end', () => {
                            if (response.statusCode === 200) {
                                try {
                                    const json = JSON.parse(data);
                                    const models = json.data?.map(m => m.id).join(', ') || 'grok-2';
                                    resolve({ success: true, message: `Connected! Available models: ${models}` });
                                } catch (e) {
                                    resolve({ success: true, message: 'Grok API connected successfully' });
                                }
                            } else if (response.statusCode === 401) {
                                resolve({ success: false, message: 'Invalid Grok API key' });
                            } else {
                                resolve({ success: false, message: `Grok API error: ${response.statusCode}` });
                            }
                        });
                    });
                    req.on('error', (e) => {
                        resolve({ success: false, message: `Connection error: ${e.message}` });
                    });
                    req.setTimeout(10000, () => {
                        req.destroy();
                        resolve({ success: false, message: 'Connection timeout' });
                    });
                    req.end();
                });
                result = testResult;
                break;
            }
        }
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================================
// GET /api/settings/schwab/status - Check Schwab authentication status
// ============================================================================
router.get('/schwab/status', requireLocalhost, async (req, res) => {
    const appKey = process.env.SCHWAB_APP_KEY;
    const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;
    const accessToken = process.env.SCHWAB_ACCESS_TOKEN;
    
    res.json({
        configured: !!(appKey && refreshToken),
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        // Don't expose actual values
        appKeySet: !!appKey,
        refreshTokenSet: !!refreshToken
    });
});

// ============================================================================
// GET /api/settings/security - Check security status
// ============================================================================
router.get('/security', requireLocalhost, async (req, res) => {
    res.json({
        secureMode: secureStore.isSecure(),
        electronMode: process.env.WHEELHOUSE_ELECTRON_MODE === 'true',
        securedKeys: secureStore.isSecure() ? secureStore.getKeys() : [],
        message: secureStore.isSecure() 
            ? '🔒 Secrets encrypted with Windows Credential Manager' 
            : '⚠️ Secrets stored in .env file (use Electron app for secure storage)'
    });
});

module.exports = router;
