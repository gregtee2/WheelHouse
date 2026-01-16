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
    challenges: []
};

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
