/**
 * Update & Server Management Routes
 * Extracted from server.js Phase 6 modularization
 * 
 * Handles:
 * - /api/update/check - Check for updates from GitHub
 * - /api/update/apply - Apply update via git pull
 * - /api/version - Get current version
 * - /api/restart - Restart the server
 */

const express = require('express');
const router = express.Router();
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Dependencies - will be injected
let fetchJson;
let fetchText;
let getLocalVersion;
let compareVersions;
let rootDir;

/**
 * Initialize the router with required dependencies
 * @param {Object} deps - Dependencies object
 * @param {Function} deps.fetchJson - Function to fetch and parse JSON
 * @param {Function} deps.fetchText - Function to fetch text content
 * @param {Function} deps.getLocalVersion - Function to get local package version
 * @param {Function} deps.compareVersions - Function to compare semver versions
 * @param {string} deps.rootDir - Root directory of the project (__dirname from server.js)
 */
function init(deps) {
    fetchJson = deps.fetchJson;
    fetchText = deps.fetchText;
    getLocalVersion = deps.getLocalVersion;
    compareVersions = deps.compareVersions;
    rootDir = deps.rootDir;
}

// =============================================================================
// UPDATE CHECK
// =============================================================================

/**
 * GET /api/update/check
 * Compares local version to GitHub main branch
 * Returns update availability and changelog
 */
router.get('/update/check', async (req, res) => {
    const localVersion = getLocalVersion();
    console.log(`[UPDATE] Checking for updates... (local: v${localVersion})`);
    
    try {
        // Fetch package.json from GitHub main branch
        const remoteUrl = 'https://raw.githubusercontent.com/gregtee2/WheelHouse/main/package.json';
        const remotePkg = await fetchJson(remoteUrl);
        const remoteVersion = remotePkg.version || '0.0.0';
        
        // Fetch changelog from GitHub
        let changelog = '';
        try {
            const changelogUrl = 'https://raw.githubusercontent.com/gregtee2/WheelHouse/main/CHANGELOG.md';
            changelog = await fetchText(changelogUrl);
        } catch (e) {
            changelog = '';
        }
        
        // Compare versions
        const updateAvailable = compareVersions(remoteVersion, localVersion) > 0;
        
        console.log(`[UPDATE] Remote: v${remoteVersion}, Update available: ${updateAvailable}`);
        
        res.json({
            updateAvailable,
            localVersion,
            remoteVersion,
            changelog
        });
    } catch (e) {
        console.log(`[UPDATE] ❌ Check failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// UPDATE APPLY
// =============================================================================

/**
 * POST /api/update/apply
 * Runs git pull to apply update
 * Requires project to be a git repository
 */
router.post('/update/apply', async (req, res) => {
    console.log('[UPDATE] Applying update via git pull...');
    
    try {
        // Check if this is a git repo
        const isGitRepo = fs.existsSync(path.join(rootDir, '.git'));
        if (!isGitRepo) {
            throw new Error('Not a git repository. Please update manually.');
        }
        
        // Run git pull
        const result = execSync('git pull origin main', { 
            cwd: rootDir,
            encoding: 'utf8',
            timeout: 30000
        });
        
        console.log(`[UPDATE] ✅ Git pull result: ${result}`);
        
        res.json({ 
            success: true, 
            message: result,
            newVersion: getLocalVersion()
        });
    } catch (e) {
        console.log(`[UPDATE] ❌ Apply failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// =============================================================================
// VERSION
// =============================================================================

/**
 * GET /api/version
 * Returns current local version
 */
router.get('/version', (req, res) => {
    res.json({ version: getLocalVersion() });
});

// =============================================================================
// RESTART
// =============================================================================

/**
 * POST /api/restart
 * Restarts the server by spawning a restart script
 * On Windows, creates a temp batch file that waits for this process to die
 */
router.post('/restart', (req, res) => {
    console.log('[SERVER] 🔄 Restart requested...');
    res.json({ success: true, message: 'Restarting...' });
    
    // Give time for response to send, then exit (start.bat will handle restart)
    setTimeout(() => {
        console.log('[SERVER] Exiting for restart...');
        // On Windows, spawn a batch file that waits for this process to die, then starts a new one
        const restartScript = `
            @echo off
            timeout /t 2 /nobreak >nul
            for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8888 ^| findstr LISTENING 2^>nul') do (
                taskkill /F /PID %%a >nul 2>&1
            )
            cd /d "${rootDir.replace(/\\/g, '\\\\')}"
            node server.js
        `.trim();
        
        // Write temp batch file
        const tempBat = path.join(rootDir, '.restart.bat');
        fs.writeFileSync(tempBat, restartScript);
        
        // Spawn detached and exit
        spawn('cmd', ['/c', tempBat], {
            cwd: rootDir,
            detached: true,
            stdio: 'ignore',
            shell: true
        }).unref();
        
        process.exit(0);
    }, 300);
});

module.exports = router;
module.exports.init = init;
