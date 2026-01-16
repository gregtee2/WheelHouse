// WheelHouse - Brownian Motion Simulation Module

import { state, resetSimulation } from './state.js';
import { randomNormal } from './utils.js';
import { draw, drawHistogram } from './charts.js';
import { updateResults, updateDataTab } from './ui.js';

/**
 * Simulate a single Brownian motion path
 */
export function simulatePath(animate = false) {
    return new Promise(resolve => {
        let pos = state.p, time = 0;
        // Use larger dt for faster simulation (fewer iterations)
        // For 30 DTE: 30/0.1 = 300 steps (reasonable), vs 30/0.01 = 3000 steps (slow)
        const dt = animate ? 0.5 : 0.1;
        const path = [{x: 0, y: pos}];
        
        // Use DTE as max time (in days), default to dte from options tab
        const maxTime = state.useDteLimit ? state.dteTimeLimit : state.dte;
        
        const step = () => {
            // Barrier knock-out when DTE mode is OFF
            if (!state.useDteLimit && (pos <= 0 || pos >= 1)) {
                const wall = pos <= 0 ? 'left' : 'right';
                state.previousPaths.push([...path]);
                if (state.previousPaths.length > 15) state.previousPaths.shift();
                resolve({time, wall, path, finalPos: pos, reachedExpiry: false});
                return;
            }
            
            // Check if reached expiration
            if (time >= maxTime) {
                state.previousPaths.push([...path]);
                if (state.previousPaths.length > 15) state.previousPaths.shift();
                
                let settlement;
                if (pos < state.q) settlement = 'below_strike';
                else if (pos > state.q) settlement = 'above_strike';
                else settlement = 'at_strike';
                
                resolve({time, wall: settlement, path, finalPos: pos, reachedExpiry: true});
                return;
            }
            
            pos += state.sigma * randomNormal() * Math.sqrt(dt);
            time += dt;
            path.push({x: time, y: pos});
            
            if (animate) {
                draw(path);
                // Faster animation - 16ms = ~60fps
                requestAnimationFrame(step);
            } else {
                step();
            }
        };
        step();
    });
}

/**
 * Record simulation result
 */
function recordResult(result) {
    state.exitTimes.push(result.time);
    
    if (state.useDteLimit && result.reachedExpiry) {
        if (result.wall === 'below_strike') state.belowStrikeCount++;
        else if (result.wall === 'above_strike') state.aboveStrikeCount++;
    } else if (!state.useDteLimit) {
        if (result.wall === 'left') state.leftHits++;
        else if (result.wall === 'right') state.rightHits++;
    }
    
    state.simData.push({
        p: state.p, 
        q: state.q, 
        sigma: state.sigma, 
        tau: result.time, 
        wall: result.wall, 
        finalPos: result.finalPos, 
        reachedExpiry: result.reachedExpiry, 
        u: Math.sqrt(state.q * state.q + result.time)
    });
    
    updateResults();
    updateDataTab();
}

/**
 * Run a single animated simulation
 */
export async function runSingle() {
    if (state.isRunning) return;
    state.isRunning = true;
    const runningIndicator = document.getElementById('runningIndicator');
    if (runningIndicator) runningIndicator.classList.add('active');
    
    const result = await simulatePath(true);
    recordResult(result);
    
    state.isRunning = false;
    if (runningIndicator) runningIndicator.classList.remove('active');
}

/**
 * Run a batch of simulations
 */
export async function runBatch() {
    if (state.isRunning) return;
    state.isRunning = true;
    const runningIndicator = document.getElementById('runningIndicator');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    
    if (runningIndicator) runningIndicator.classList.add('active');
    if (progressBar) progressBar.style.display = 'block';
    
    for (let i = 0; i < state.batchSize; i++) {
        const result = await simulatePath(false);
        recordResult(result);
        if (i % Math.ceil(state.batchSize/20) === 0) {
            if (progressFill) progressFill.style.width = (i/state.batchSize*100) + '%';
            await new Promise(r => setTimeout(r, 0));
        }
    }
    
    if (progressFill) progressFill.style.width = '100%';
    draw();
    setTimeout(() => {
        if (progressBar) progressBar.style.display = 'none';
        if (progressFill) progressFill.style.width = '0';
    }, 300);
    
    state.isRunning = false;
    if (runningIndicator) runningIndicator.classList.remove('active');
}

/**
 * Reset all simulation data
 */
export function resetAll() {
    resetSimulation();
    updateResults();
    updateDataTab();
    draw();
}
