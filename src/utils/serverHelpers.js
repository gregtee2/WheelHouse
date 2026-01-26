/**
 * Server Helpers - Utility functions for server operations
 * Extracted from server.js for modularity
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Root directory (project root, not src/)
const ROOT_DIR = path.join(__dirname, '..', '..');

/**
 * Get current version from package.json
 * @returns {string} Version string (e.g., "1.15.0")
 */
function getLocalVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
}

/**
 * Get changelog content
 * @returns {string} Contents of CHANGELOG.md
 */
function getChangelog() {
    try {
        return fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
    } catch (e) {
        return '';
    }
}

/**
 * GPU Detection - Query nvidia-smi for VRAM info
 * @returns {Object} GPU information including VRAM
 */
function detectGPU() {
    try {
        // Query nvidia-smi for GPU name and memory
        const output = execSync('nvidia-smi --query-gpu=name,memory.total,memory.free,memory.used --format=csv,noheader,nounits', {
            encoding: 'utf8',
            timeout: 5000
        }).trim();
        
        // Parse output: "NVIDIA GeForce RTX 4090, 24564, 20000, 4564"
        const lines = output.split('\n');
        const gpus = lines.map(line => {
            const parts = line.split(',').map(s => s.trim());
            return {
                name: parts[0],
                totalMB: parseInt(parts[1]) || 0,
                freeMB: parseInt(parts[2]) || 0,
                usedMB: parseInt(parts[3]) || 0,
                totalGB: ((parseInt(parts[1]) || 0) / 1024).toFixed(1),
                freeGB: ((parseInt(parts[2]) || 0) / 1024).toFixed(1),
                usedGB: ((parseInt(parts[3]) || 0) / 1024).toFixed(1)
            };
        });
        
        // Return primary GPU (first one)
        return {
            available: true,
            ...gpus[0],
            allGPUs: gpus
        };
    } catch (e) {
        // No nvidia-smi = no NVIDIA GPU or not installed
        return {
            available: false,
            name: 'No GPU detected',
            totalMB: 0,
            freeMB: 0,
            usedMB: 0,
            totalGB: '0',
            freeGB: '0',
            usedGB: '0',
            error: e.message
        };
    }
}

/**
 * Model VRAM requirements (approximate, for loading)
 */
const MODEL_VRAM_REQUIREMENTS = {
    'qwen2.5:7b': { minGB: 5, recGB: 8, description: '7B parameters - Fast, good quality' },
    'qwen2.5:14b': { minGB: 10, recGB: 14, description: '14B parameters - Balanced' },
    'deepseek-r1:32b': { minGB: 20, recGB: 24, description: '32B parameters - Best for quant/math reasoning' },
    'minicpm-v:latest': { minGB: 6, recGB: 8, description: 'Vision model - Image analysis' },
    'llava:7b': { minGB: 5, recGB: 8, description: 'Vision model - Image analysis' },
    'llava:13b': { minGB: 10, recGB: 14, description: 'Vision model - Better image analysis' }
};

/**
 * MIME types for static files
 */
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

/**
 * Compare semantic versions
 * @param {string} a - Version string (e.g., "1.2.3")
 * @param {string} b - Version string (e.g., "1.2.4")
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    const partsA = (a || '0.0.0').split('.').map(Number);
    const partsB = (b || '0.0.0').split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

module.exports = {
    getLocalVersion,
    getChangelog,
    detectGPU,
    MODEL_VRAM_REQUIREMENTS,
    MIME_TYPES,
    compareVersions,
    ROOT_DIR
};
