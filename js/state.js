// WheelHouse - Global State Management
// All shared state variables live here

export const state = {
    // Simulator parameters
    p: 0.5,
    q: 0.5,
    sigma: 0.1,
    batchSize: 100,
    
    // Simulation results
    exitTimes: [],
    simData: [],
    leftHits: 0,
    rightHits: 0,
    belowStrikeCount: 0,
    aboveStrikeCount: 0,
    previousPaths: [],
    isRunning: false,
    
    // DTE limit - default to true since options always have expiration
    useDteLimit: true,
    dteTimeLimit: 30,
    
    // Options parameters
    spot: 100,
    strike: 100,
    lower: 80,
    upper: 120,
    rate: 0.05,
    optVol: 0.2,
    mcPaths: 10000,
    dte: 30,
    currentTicker: null,  // Currently loaded ticker for Monte Carlo
    
    // Results
    optionResults: null,
    hitZeroCount: 0,
    hitOneCount: 0,
    
    // Position tracking
    positions: [],
    closedPositions: [],
    holdings: [],  // Share holdings from assignments
    currentPositionContext: null,
    editingPositionId: null,
    rollingPositionId: null,
    closingPositionId: null,
    closedYearFilter: null,
    assigningPositionId: null,
    
    // Undo system - stores last destructive action
    lastAction: null,  // { type, data, timestamp }
    
    // Challenges
    challenges: [],
    
    // Account Mode: 'real' or 'paper'
    accountMode: localStorage.getItem('wheelhouse_account_mode') || 'real',
    
    // Paper account settings
    paperAccountBalance: parseFloat(localStorage.getItem('wheelhouse_paper_balance')) || 50000,
    paperAccountStartingBalance: parseFloat(localStorage.getItem('wheelhouse_paper_starting_balance')) || 50000
};

// Storage key helpers - returns appropriate key based on account mode
export function getStorageKey(baseKey) {
    if (state.accountMode === 'paper') {
        return `wheelhouse_paper_${baseKey}`;
    }
    return `wheelhouse_${baseKey}`;
}

// Convenience getters for common keys
export function getPositionsKey() { return getStorageKey('positions'); }
export function getClosedKey() { return getStorageKey('closed_positions'); }
export function getHoldingsKey() { return getStorageKey('holdings'); }
export function getChallengesKey() { return getStorageKey('challenges'); }

// Account mode switcher
export function setAccountMode(mode) {
    if (mode !== 'real' && mode !== 'paper') return;
    state.accountMode = mode;
    localStorage.setItem('wheelhouse_account_mode', mode);
    
    // Update paper mode indicator
    updatePaperModeIndicator();
}

// Paper account balance management
export function setPaperAccountBalance(amount) {
    state.paperAccountBalance = amount;
    state.paperAccountStartingBalance = amount;
    localStorage.setItem('wheelhouse_paper_balance', amount.toString());
    localStorage.setItem('wheelhouse_paper_starting_balance', amount.toString());
}

export function getPaperAccountBalance() {
    return state.paperAccountBalance;
}

export function updatePaperModeIndicator() {
    const indicator = document.getElementById('paperModeIndicator');
    const accountSelect = document.getElementById('accountModeSelect');
    
    if (state.accountMode === 'paper') {
        // Show paper mode banner
        if (!indicator) {
            const banner = document.createElement('div');
            banner.id = 'paperModeIndicator';
            banner.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                background: linear-gradient(90deg, #8b5cf6 0%, #6d28d9 50%, #8b5cf6 100%);
                color: white;
                text-align: center;
                padding: 6px;
                font-weight: bold;
                font-size: 13px;
                z-index: 10000;
                box-shadow: 0 2px 10px rgba(139,92,246,0.5);
            `;
            banner.innerHTML = '📝 PAPER TRADING MODE - This is simulated money, not real trades';
            document.body.prepend(banner);
            document.body.style.paddingTop = '36px';
        }
        if (accountSelect) accountSelect.style.borderColor = '#8b5cf6';
    } else {
        // Remove paper mode banner
        if (indicator) {
            indicator.remove();
            document.body.style.paddingTop = '0';
        }
        if (accountSelect) accountSelect.style.borderColor = '#333';
    }
}

// Make state accessible globally for legacy compatibility
window.state = state;

// Getter/setter helpers for common operations
export function resetSimulation() {
    state.exitTimes = [];
    state.simData = [];
    state.leftHits = 0;
    state.rightHits = 0;
    state.belowStrikeCount = 0;
    state.aboveStrikeCount = 0;
    state.previousPaths = [];
}

export function setPositionContext(context) {
    state.currentPositionContext = context;
    window.currentPositionContext = context; // Legacy support
}

export function clearPositionContext() {
    state.currentPositionContext = null;
    window.currentPositionContext = null;
}
