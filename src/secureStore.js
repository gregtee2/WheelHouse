/**
 * secureStore.js - Secure credential storage
 * 
 * When running in Electron, uses Windows Credential Manager via safeStorage.
 * Falls back to .env file when running as plain Node.js server.
 * 
 * Secrets stored securely:
 * - SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_REFRESH_TOKEN, SCHWAB_ACCESS_TOKEN
 * - OPENAI_API_KEY, GROK_API_KEY
 * - TELEGRAM_BOT_TOKEN
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Path to encrypted store file (when in Electron mode)
const SECURE_STORE_PATH = path.join(__dirname, '../.secure-store');

// Keys that should use secure storage
const SECURE_KEYS = new Set([
    'SCHWAB_APP_KEY',
    'SCHWAB_APP_SECRET',
    'SCHWAB_REFRESH_TOKEN',
    'SCHWAB_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'GROK_API_KEY',
    'POLYGON_API_KEY',
    'TELEGRAM_BOT_TOKEN'
]);

// In-memory cache of decrypted values (for performance)
let secureCache = {};
let isElectronMode = false;
let encryptionKey = null;

/**
 * Initialize secure store
 * Called from main process with the encryption key derived from Windows Credential Manager
 */
function initialize(key) {
    if (key) {
        encryptionKey = key;
        isElectronMode = true;
        loadSecureStore();
        console.log('[SECURE-STORE] Initialized with Electron encryption');
    } else {
        isElectronMode = false;
        console.log('[SECURE-STORE] Running in fallback mode (.env)');
    }
}

/**
 * Load and decrypt the secure store file
 */
function loadSecureStore() {
    try {
        if (!fs.existsSync(SECURE_STORE_PATH)) {
            secureCache = {};
            return;
        }
        
        const encrypted = fs.readFileSync(SECURE_STORE_PATH, 'utf-8');
        const decrypted = decrypt(encrypted);
        secureCache = JSON.parse(decrypted);
    } catch (err) {
        console.error('[SECURE-STORE] Failed to load:', err.message);
        secureCache = {};
    }
}

/**
 * Save the secure store to disk (encrypted)
 */
function saveSecureStore() {
    try {
        const data = JSON.stringify(secureCache, null, 2);
        const encrypted = encrypt(data);
        fs.writeFileSync(SECURE_STORE_PATH, encrypted, 'utf-8');
        return true;
    } catch (err) {
        console.error('[SECURE-STORE] Failed to save:', err.message);
        return false;
    }
}

/**
 * Encrypt data using AES-256-GCM
 */
function encrypt(plaintext) {
    if (!encryptionKey) throw new Error('Encryption key not set');
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    // Format: iv:authTag:ciphertext
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt data using AES-256-GCM
 */
function decrypt(ciphertext) {
    if (!encryptionKey) throw new Error('Encryption key not set');
    
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid ciphertext format');
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

/**
 * Get a secure value
 * @param {string} key - The setting key
 * @returns {string|null} - The value or null if not found
 */
function get(key) {
    if (isElectronMode && SECURE_KEYS.has(key)) {
        return secureCache[key] || null;
    }
    
    // Fallback to process.env (loaded from .env)
    return process.env[key] || null;
}

/**
 * Set a secure value
 * @param {string} key - The setting key
 * @param {string} value - The value to store
 * @returns {boolean} - Success
 */
function set(key, value) {
    if (isElectronMode && SECURE_KEYS.has(key)) {
        secureCache[key] = value;
        
        // Also update process.env for immediate use
        process.env[key] = value;
        
        return saveSecureStore();
    }
    
    // Fallback: update process.env (caller should also update .env)
    process.env[key] = value;
    return true;
}

/**
 * Delete a secure value
 * @param {string} key - The setting key
 * @returns {boolean} - Success
 */
function remove(key) {
    if (isElectronMode && SECURE_KEYS.has(key)) {
        delete secureCache[key];
        delete process.env[key];
        return saveSecureStore();
    }
    
    delete process.env[key];
    return true;
}

/**
 * Get all secure keys that have values
 * @returns {string[]} - Array of keys with values
 */
function getKeys() {
    if (isElectronMode) {
        return Object.keys(secureCache);
    }
    
    return Array.from(SECURE_KEYS).filter(key => process.env[key]);
}

/**
 * Check if running in secure mode
 * @returns {boolean}
 */
function isSecure() {
    return isElectronMode;
}

/**
 * Migrate secrets from .env to secure storage (one-time)
 * @returns {number} - Number of secrets migrated
 */
function migrateFromEnv() {
    if (!isElectronMode) return 0;
    
    let count = 0;
    for (const key of SECURE_KEYS) {
        const value = process.env[key];
        if (value && !secureCache[key]) {
            secureCache[key] = value;
            count++;
            console.log(`[SECURE-STORE] Migrated: ${key}`);
        }
    }
    
    if (count > 0) {
        saveSecureStore();
        console.log(`[SECURE-STORE] Migrated ${count} secrets from .env`);
    }
    
    return count;
}

module.exports = {
    initialize,
    get,
    set,
    remove,
    getKeys,
    isSecure,
    migrateFromEnv,
    SECURE_KEYS
};
