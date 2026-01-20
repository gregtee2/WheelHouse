// WheelHouse Simple Server with CBOE Proxy
// Serves static files AND proxies CBOE requests to avoid CORS

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 8888;

// Get current version from package.json
function getLocalVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
}

// Get changelog content
function getChangelog() {
    try {
        return fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    } catch (e) {
        return '';
    }
}

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    // CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // Proxy endpoint for CBOE options
    if (url.pathname.startsWith('/api/cboe/')) {
        const ticker = url.pathname.replace('/api/cboe/', '').replace('.json', '').toUpperCase();
        // Add cache-buster to defeat CDN/browser caching
        const cacheBuster = Date.now();
        const cboeUrl = `https://cdn.cboe.com/api/global/delayed_quotes/options/${ticker}.json?_=${cacheBuster}`;
        
        console.log(`[PROXY] Fetching CBOE options for ${ticker}...`);
        
        try {
            const data = await fetchJson(cboeUrl);
            // Send no-cache headers
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(JSON.stringify(data));
            console.log(`[PROXY] ✅ Returned ${data.data?.options?.length || 0} options for ${ticker}`);
        } catch (e) {
            console.log(`[PROXY] ❌ Failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Proxy endpoint for Yahoo Finance stock prices
    if (url.pathname.startsWith('/api/yahoo/')) {
        const ticker = url.pathname.replace('/api/yahoo/', '').replace('.json', '').toUpperCase();
        const yahooUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
        
        console.log(`[PROXY] Fetching Yahoo price for ${ticker}...`);
        
        try {
            const data = await fetchJson(yahooUrl);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
            console.log(`[PROXY] ✅ ${ticker} = $${price?.toFixed(2) || 'N/A'}`);
        } catch (e) {
            console.log(`[PROXY] ❌ Yahoo failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Update check endpoint - compares local version to GitHub
    if (url.pathname === '/api/update/check') {
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
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                updateAvailable,
                localVersion,
                remoteVersion,
                changelog
            }));
        } catch (e) {
            console.log(`[UPDATE] ❌ Check failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Update apply endpoint - runs git pull
    if (url.pathname === '/api/update/apply' && req.method === 'POST') {
        console.log('[UPDATE] Applying update via git pull...');
        
        try {
            // Check if this is a git repo
            const isGitRepo = fs.existsSync(path.join(__dirname, '.git'));
            if (!isGitRepo) {
                throw new Error('Not a git repository. Please update manually.');
            }
            
            // Run git pull
            const result = execSync('git pull origin main', { 
                cwd: __dirname,
                encoding: 'utf8',
                timeout: 30000
            });
            
            console.log(`[UPDATE] ✅ Git pull result: ${result}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true, 
                message: result,
                newVersion: getLocalVersion()
            }));
        } catch (e) {
            console.log(`[UPDATE] ❌ Apply failed: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    
    // Get current version
    if (url.pathname === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: getLocalVersion() }));
        return;
    }
    
    // Static file serving
    let filePath = url.pathname;
    if (filePath === '/') filePath = '/index.html';
    
    const fullPath = path.join(__dirname, filePath);
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    try {
        const content = fs.readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (e) {
        if (e.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
        } else {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Server error');
        }
    }
});

// Helper to fetch JSON over HTTPS
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', reject);
    });
}

// Helper to fetch plain text over HTTPS
function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// Compare semantic versions (returns 1 if a > b, -1 if a < b, 0 if equal)
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    
    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

server.listen(PORT, () => {
    const version = getLocalVersion();
    console.log(`
╔════════════════════════════════════════════════════╗
║           🏠 WheelHouse Server v${version.padEnd(6)}            ║
╠════════════════════════════════════════════════════╣
║  URL: http://localhost:${PORT}                       ║
║                                                    ║
║  Features:                                         ║
║  • Static file serving                             ║
║  • CBOE options proxy at /api/cboe/{TICKER}.json   ║
║  • Update check at /api/update/check               ║
╚════════════════════════════════════════════════════╝
`);
});
