const { app, BrowserWindow, ipcMain, safeStorage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

// Keep a global reference of the window object
let mainWindow = null;
let serverProcess = null;

// Paths for secure storage
const userDataPath = app.getPath('userData');
const secureStorePath = path.join(userDataPath, 'secure-store.enc');

// ============================================
// SECURE STORAGE (Windows Credential Manager)
// ============================================

function saveSecureData(key, value) {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            console.warn('Encryption not available, falling back to plain storage');
            return false;
        }
        
        // Load existing data
        let store = {};
        if (fs.existsSync(secureStorePath)) {
            const encrypted = fs.readFileSync(secureStorePath);
            const decrypted = safeStorage.decryptString(encrypted);
            store = JSON.parse(decrypted);
        }
        
        // Update and save
        store[key] = value;
        const encrypted = safeStorage.encryptString(JSON.stringify(store));
        fs.writeFileSync(secureStorePath, encrypted);
        return true;
    } catch (err) {
        console.error('Failed to save secure data:', err);
        return false;
    }
}

function getSecureData(key) {
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            return null;
        }
        
        if (!fs.existsSync(secureStorePath)) {
            return null;
        }
        
        const encrypted = fs.readFileSync(secureStorePath);
        const decrypted = safeStorage.decryptString(encrypted);
        const store = JSON.parse(decrypted);
        return store[key] || null;
    } catch (err) {
        console.error('Failed to get secure data:', err);
        return null;
    }
}

function deleteSecureData(key) {
    try {
        if (!fs.existsSync(secureStorePath)) {
            return true;
        }
        
        const encrypted = fs.readFileSync(secureStorePath);
        const decrypted = safeStorage.decryptString(encrypted);
        const store = JSON.parse(decrypted);
        delete store[key];
        
        const newEncrypted = safeStorage.encryptString(JSON.stringify(store));
        fs.writeFileSync(secureStorePath, newEncrypted);
        return true;
    } catch (err) {
        console.error('Failed to delete secure data:', err);
        return false;
    }
}

// ============================================
// SERVER MANAGEMENT
// ============================================

function getOrCreateEncryptionKey() {
    // Try to get existing key from secure storage
    let key = getSecureData('encryption-master-key');
    
    if (!key) {
        // Generate new 256-bit key
        const crypto = require('crypto');
        key = crypto.randomBytes(32).toString('hex');
        saveSecureData('encryption-master-key', key);
        console.log('[Security] Generated new encryption master key');
    }
    
    return key;
}

function startServer() {
    const { spawn } = require('child_process');
    const serverPath = path.join(__dirname, '..', 'server.js');
    
    // Get encryption key for secure storage
    const encryptionKey = getOrCreateEncryptionKey();
    
    // Pass encryption key to server via environment
    const env = {
        ...process.env,
        WHEELHOUSE_ENCRYPTION_KEY: encryptionKey,
        WHEELHOUSE_ELECTRON_MODE: 'true'
    };
    
    serverProcess = spawn('node', [serverPath], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env
    });
    
    serverProcess.stdout.on('data', (data) => {
        console.log(`[Server] ${data.toString().trim()}`);
    });
    
    serverProcess.stderr.on('data', (data) => {
        console.error(`[Server Error] ${data.toString().trim()}`);
    });
    
    serverProcess.on('close', (code) => {
        console.log(`[Server] Process exited with code ${code}`);
        serverProcess = null;
    });
    
    return new Promise((resolve) => {
        // Give server time to start
        setTimeout(resolve, 1500);
    });
}

function stopServer() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

// ============================================
// WINDOW MANAGEMENT
// ============================================

async function createWindow() {
    // Start the backend server
    await startServer();
    
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1200,
        minHeight: 800,
        icon: path.join(__dirname, 'icon.png'),
        backgroundColor: '#0d0d1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    
    // Load login page first (from file://)
    const loginPath = path.join(__dirname, '..', 'login.html');
    mainWindow.loadFile(loginPath);
    
    // Listen for navigation to app - means login succeeded
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.includes('localhost:8888')) {
            // Login successful, allow navigation to app
            console.log('[Login] PIN verified, loading app');
        }
    });
    
    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
    
    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    
    // Dark title bar on Windows
    if (process.platform === 'win32') {
        nativeTheme.themeSource = 'dark';
    }
}

// ============================================
// IPC HANDLERS (Renderer ↔ Main Process)
// ============================================

// Secure storage handlers
ipcMain.handle('secure-storage:set', async (event, key, value) => {
    return saveSecureData(key, value);
});

ipcMain.handle('secure-storage:get', async (event, key) => {
    return getSecureData(key);
});

ipcMain.handle('secure-storage:delete', async (event, key) => {
    return deleteSecureData(key);
});

ipcMain.handle('secure-storage:available', async () => {
    return safeStorage.isEncryptionAvailable();
});

// App info
ipcMain.handle('app:version', async () => {
    return app.getVersion();
});

ipcMain.handle('app:path', async (event, name) => {
    return app.getPath(name);
});

// Server control
ipcMain.handle('server:restart', async () => {
    stopServer();
    await startServer();
    return true;
});

// ============================================
// APP LIFECYCLE
// ============================================

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    stopServer();
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}
