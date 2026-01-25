const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script - Secure bridge between renderer and main process
 * 
 * This exposes a limited API to the renderer (your web app) without
 * giving it full Node.js access. All sensitive operations go through
 * IPC to the main process.
 */

contextBridge.exposeInMainWorld('electronAPI', {
    // ============================================
    // SECURE STORAGE
    // Uses Windows Credential Manager / macOS Keychain
    // ============================================
    
    secureStorage: {
        /**
         * Store a value securely (encrypted at rest)
         * @param {string} key - Storage key
         * @param {string} value - Value to store (will be encrypted)
         * @returns {Promise<boolean>} - Success status
         */
        set: (key, value) => ipcRenderer.invoke('secure-storage:set', key, value),
        
        /**
         * Retrieve a securely stored value
         * @param {string} key - Storage key
         * @returns {Promise<string|null>} - Decrypted value or null
         */
        get: (key) => ipcRenderer.invoke('secure-storage:get', key),
        
        /**
         * Delete a securely stored value
         * @param {string} key - Storage key
         * @returns {Promise<boolean>} - Success status
         */
        delete: (key) => ipcRenderer.invoke('secure-storage:delete', key),
        
        /**
         * Check if encryption is available
         * @returns {Promise<boolean>}
         */
        isAvailable: () => ipcRenderer.invoke('secure-storage:available')
    },
    
    // ============================================
    // APP INFO
    // ============================================
    
    app: {
        /**
         * Get app version from package.json
         * @returns {Promise<string>}
         */
        getVersion: () => ipcRenderer.invoke('app:version'),
        
        /**
         * Get system paths (userData, documents, etc.)
         * @param {string} name - Path name
         * @returns {Promise<string>}
         */
        getPath: (name) => ipcRenderer.invoke('app:path', name)
    },
    
    // ============================================
    // SERVER CONTROL
    // ============================================
    
    server: {
        /**
         * Restart the backend server
         * @returns {Promise<boolean>}
         */
        restart: () => ipcRenderer.invoke('server:restart')
    },
    
    // ============================================
    // PLATFORM INFO
    // ============================================
    
    platform: process.platform,
    isElectron: true
});

// Log that preload ran successfully
console.log('WheelHouse Electron preload initialized');
