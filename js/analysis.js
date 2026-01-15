// WheelHouse - Analysis Module
// Recommendations, EV calculations, Roll calculator

import { state } from './state.js';
import { getPositionType } from './pricing.js';
import { randomNormal } from './utils.js';

/**
 * Generate AI recommendation based on probabilities
 */
export function generateRecommendation(belowStrikePct, aboveStrikePct, dteValue) {
    const recBox = document.getElementById('recommendation');
    const recTitle = document.getElementById('recTitle');
    const recAction = document.getElementById('recAction');
    const recReason = document.getElementById('recReason');
    const recTip = document.getElementById('recTip');
    
    // Safety check - if elements don't exist, bail out
    if (!recBox || !recTitle || !recAction || !recReason || !recTip) {
        console.warn('Recommendation elements not found in DOM');
        return;
    }
    
    recBox.style.display = 'block';
    
    const posType = getPositionType();
    const isPut = posType.isPut;
    const riskPct = isPut ? belowStrikePct : aboveStrikePct;
    const winPct = isPut ? aboveStrikePct : belowStrikePct;
    
    const safeThreshold = 30;
    const watchThreshold = 40;
    const cautionThreshold = 50;
    const dangerThreshold = 60;
    
    if (riskPct < safeThreshold) {
        recBox.className = 'recommendation-box safe';
        recTitle.textContent = '✅ Low Risk - HOLD';
        recAction.textContent = `✅ HOLD - ${riskPct.toFixed(1)}% assignment risk`;
        if (isPut) {
            recReason.innerHTML = `<b>Why:</b> Only ${riskPct.toFixed(0)}% chance stock closes below $${state.strike.toFixed(2)} in ${dteValue} days. <b>${winPct.toFixed(0)}% chance you keep premium!</b>`;
            recTip.textContent = `💡 Tip: Set an alert at $${(state.strike * 0.95).toFixed(2)}. Let theta work for you.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> Only ${riskPct.toFixed(0)}% chance stock closes above $${state.strike.toFixed(2)}. Shares likely stay yours.`;
            recTip.textContent = `💡 Tip: ${winPct.toFixed(0)}% win probability. Let the position ride.`;
        }
    } else if (riskPct < watchThreshold) {
        recBox.className = 'recommendation-box safe';
        recTitle.textContent = '👀 Moderate Risk - WATCH';
        recAction.textContent = `⚠️ WATCH CLOSELY - ${riskPct.toFixed(1)}% assignment risk`;
        recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% risk. Still ${winPct.toFixed(0)}% win probability, but closer than ideal.`;
        recTip.textContent = `💡 Consider profit-taking at 50-75% max gain.`;
    } else if (riskPct < cautionThreshold) {
        recBox.className = 'recommendation-box caution';
        recTitle.textContent = '⚠️ CAUTION - Consider Rolling';
        recAction.textContent = `🔄 ROLL OR CLOSE - ${riskPct.toFixed(1)}% assignment risk`;
        if (isPut) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance stock closes below strike. Close to 50/50 - not ideal.`;
            recTip.textContent = `💡 Roll to: $${(state.strike * 0.95).toFixed(2)} for ${Math.min(dteValue + 30, 60)} DTE.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance of losing shares.`;
            recTip.textContent = `💡 Roll to: $${(state.strike * 1.05).toFixed(2)} for ${Math.min(dteValue + 30, 60)} DTE.`;
        }
    } else if (riskPct < dangerThreshold) {
        recBox.className = 'recommendation-box danger';
        recTitle.textContent = '🚨 HIGH RISK - ROLL NOW!';
        recAction.textContent = `🔴 ROLL NOW - ${riskPct.toFixed(1)}% assignment risk!`;
        if (isPut) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance stock closes below $${state.strike.toFixed(2)}. More likely to be assigned than not!`;
            recTip.textContent = `💡 Action: Close $${state.strike.toFixed(2)} put TODAY. Sell $${(state.strike * 0.90).toFixed(2)} put for 45 DTE.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance shares get called away.`;
            recTip.textContent = `💡 Action: Close $${state.strike.toFixed(2)} call TODAY or roll much higher.`;
        }
    } else {
        recBox.className = 'recommendation-box danger';
        recTitle.textContent = '🔥 CRITICAL - High Assignment Probability!';
        recAction.textContent = `‼️ DECISION TIME - ${riskPct.toFixed(1)}% assignment risk!`;
        if (isPut) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% probability stock closes below $${state.strike.toFixed(2)}. Assignment is MORE LIKELY than expiring worthless.`;
            recTip.innerHTML = `<b>👉 Two Options:</b><br>1) Accept assignment - own 100 shares at $${state.strike.toFixed(2)}, sell covered calls.<br>2) Close now - take the loss if you don't want the stock.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% probability shares get called away.`;
            recTip.innerHTML = `<b>👉 Two Options:</b><br>1) Let shares get called at $${state.strike.toFixed(2)} - Start new Wheel cycle.<br>2) Roll aggressively to much higher strike.`;
        }
    }
}

/**
 * Calculate expected value and trade metrics
 */
export function calculateExpectedValue() {
    if (!state.optionResults?.finalPrices) return;
    
    const contracts = state.currentPositionContext?.contracts || 1;
    const posType = getPositionType();
    const isPut = posType.isPut;
    
    // Use position premium if analyzing a position, otherwise use calculated price
    let premium;
    if (state.currentPositionContext?.premium) {
        premium = state.currentPositionContext.premium;
    } else {
        const putPriceEl = document.getElementById('putPrice');
        const callPriceEl = document.getElementById('callPrice');
        premium = isPut ? parseFloat(putPriceEl?.textContent?.replace('$','') || '0') :
                         parseFloat(callPriceEl?.textContent?.replace('$','') || '0');
    }
    
    let totalPnL = 0;
    state.optionResults.finalPrices.forEach(price => {
        let pnl;
        if (isPut) {
            pnl = (price >= state.strike) ? premium * 100 : (premium - (state.strike - price)) * 100;
        } else {
            pnl = (price <= state.strike) ? premium * 100 : (premium - (price - state.strike)) * 100;
        }
        totalPnL += pnl * contracts;
    });
    
    const expectedValue = totalPnL / state.optionResults.finalPrices.length;
    
    const expectedValueEl = document.getElementById('expectedValue');
    if (expectedValueEl) {
        expectedValueEl.textContent = `$${expectedValue.toFixed(2)}`;
        expectedValueEl.style.color = expectedValue >= 0 ? '#00ff88' : '#ff5252';
    }
    
    calculateIsItWorthIt(expectedValue, isPut, premium, contracts);
}

/**
 * Calculate "Is It Worth It?" metrics
 */
function calculateIsItWorthIt(expectedValue, isPut, premium, contracts) {
    const worthItBox = document.getElementById('worthItBox');
    if (worthItBox) worthItBox.style.display = 'block';
    
    const winPct = isPut ? 
        (state.optionResults.aboveStrikeCount / state.optionResults.finalPrices.length * 100) :
        (state.optionResults.belowStrikeCount / state.optionResults.finalPrices.length * 100);
    
    const maxProfit = premium * 100 * contracts;
    const capitalRequired = state.strike * 100 * contracts;
    const roc = (maxProfit / capitalRequired) * 100;
    const annualizedRoc = roc * (365 / state.dte);
    
    // Calculate average price if assigned
    let avgPriceIfAssigned = 0;
    let assignedCount = 0;
    
    if (isPut) {
        state.optionResults.finalPrices.forEach(price => {
            if (price < state.strike) {
                avgPriceIfAssigned += price;
                assignedCount++;
            }
        });
    } else {
        state.optionResults.finalPrices.forEach(price => {
            if (price > state.strike) {
                avgPriceIfAssigned += price;
                assignedCount++;
            }
        });
    }
    
    let expectedLossIfAssigned, realisticRiskReward;
    
    if (assignedCount > 0) {
        avgPriceIfAssigned = avgPriceIfAssigned / assignedCount;
        
        if (isPut) {
            expectedLossIfAssigned = ((state.strike - avgPriceIfAssigned) - premium) * 100 * contracts;
        } else {
            expectedLossIfAssigned = ((avgPriceIfAssigned - state.strike) - premium) * 100 * contracts;
        }
        expectedLossIfAssigned = Math.max(0, expectedLossIfAssigned);
        realisticRiskReward = expectedLossIfAssigned > 0 ? 
            (expectedLossIfAssigned / maxProfit).toFixed(1) + ':1' : '0:1';
    } else {
        avgPriceIfAssigned = 0;
        expectedLossIfAssigned = isPut ? (state.strike - premium) * 100 * contracts : Infinity;
        realisticRiskReward = expectedLossIfAssigned === Infinity ? '∞:1' : (expectedLossIfAssigned / maxProfit).toFixed(1) + ':1';
    }
    
    // Required win rate
    let requiredWinRate;
    if (isPut && expectedLossIfAssigned > 0 && expectedLossIfAssigned !== Infinity) {
        requiredWinRate = (expectedLossIfAssigned / (maxProfit + expectedLossIfAssigned)) * 100;
    } else if (isPut) {
        requiredWinRate = ((state.strike - premium) / state.strike * 100);
    } else {
        requiredWinRate = 100;
    }
    
    const yourEdge = winPct - requiredWinRate;
    
    // Kelly Criterion
    const b = expectedLossIfAssigned > 0 ? maxProfit / expectedLossIfAssigned : 0;
    const p = winPct / 100;
    const q = 1 - p;
    let kellyPct = b > 0 ? ((b * p - q) / b) * 100 : 0;
    kellyPct = Math.max(0, Math.min(kellyPct, 100));
    
    // Update display - helper function
    function setEl(id, text, colorFn) {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
            if (colorFn) el.style.color = colorFn();
        }
    }
    
    setEl('rocDisplay', roc.toFixed(2) + '%', () => roc >= 2 ? '#00ff88' : roc >= 1 ? '#00d9ff' : '#ffaa00');
    setEl('annRocDisplay', annualizedRoc.toFixed(0) + '%', () => annualizedRoc >= 30 ? '#00ff88' : annualizedRoc >= 15 ? '#00d9ff' : '#ffaa00');
    
    const rrValue = parseFloat(realisticRiskReward.split(':')[0]);
    setEl('riskRewardRatio', realisticRiskReward, () => 
        rrValue === Infinity ? '#ff5252' : (rrValue < 5 ? '#00ff88' : rrValue < 20 ? '#ffaa00' : '#ff5252'));
    
    setEl('winProbability', winPct.toFixed(1) + '%', () => winPct > 70 ? '#00ff88' : winPct > 50 ? '#ffaa00' : '#ff5252');
    setEl('requiredWinRate', requiredWinRate.toFixed(1) + '%');
    setEl('yourEdge', (yourEdge > 0 ? '+' : '') + yourEdge.toFixed(1) + '%', () => yourEdge > 0 ? '#00ff88' : '#ff5252');
    setEl('kellyPct', kellyPct.toFixed(1) + '%', () => kellyPct > 0 ? '#00ff88' : '#ff5252');
    setEl('avgIfAssigned', assignedCount > 0 ? `$${avgPriceIfAssigned.toFixed(2)}` : 'N/A');
    setEl('expectedLoss', expectedLossIfAssigned > 0 ? `-$${expectedLossIfAssigned.toFixed(0)}` : '$0');
}

/**
 * Calculate roll scenario
 */
export async function calculateRoll() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    
    const putPriceEl = document.getElementById('putPrice');
    const optLowerEl = document.getElementById('optLower');
    const currentPremium = parseFloat(putPriceEl?.textContent?.replace('$','') || '0');
    const currentRisk = parseFloat(optLowerEl?.textContent?.replace('%','') || '0');
    
    // Helper to set element text
    function setEl(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    
    setEl('rollCurrentStrike', currentStrike.toFixed(2));
    setEl('rollCurrentDte', currentDte);
    setEl('rollCurrentRisk', currentRisk.toFixed(1));
    setEl('rollCurrentPremium', currentPremium.toFixed(2));
    
    const newStrikeEl = document.getElementById('rollNewStrike');
    const newDteEl = document.getElementById('rollNewDte');
    const rollCreditEl = document.getElementById('rollCredit');
    
    const newStrike = parseFloat(newStrikeEl?.value || '95');
    const newDte = parseInt(newDteEl?.value || '45');
    const rollCredit = parseFloat(rollCreditEl?.value || '0.50');
    
    // Simulate new position
    let newBelowCount = 0;
    const quickPaths = 1000;
    const T = newDte / 365.25;
    const numSteps = 50;
    const dt = T / numSteps;
    
    for (let i = 0; i < quickPaths; i++) {
        let S = state.spot;
        for (let step = 0; step < numSteps; step++) {
            const dW = randomNormal() * Math.sqrt(dt);
            S *= Math.exp((state.rate - 0.5*state.optVol*state.optVol)*dt + state.optVol*dW);
        }
        if (S < newStrike) newBelowCount++;
    }
    
    const newRisk = (newBelowCount / quickPaths) * 100;
    const totalPremium = currentPremium + rollCredit;
    
    setEl('rollNewStrikeDisp', '$' + newStrike.toFixed(2));
    setEl('rollNewDteDisp', newDte + ' days');
    setEl('rollNewRisk', newRisk.toFixed(1) + '%');
    setEl('rollTotalPremium', '$' + totalPremium.toFixed(2));
    setEl('rollNetCredit', '$' + rollCredit.toFixed(2));
    
    const riskChange = currentRisk - newRisk;
    const timeChange = newDte - currentDte;
    let comparison = '';
    if (riskChange > 0) {
        comparison += `✅ <b>Risk reduced by ${riskChange.toFixed(1)}%</b><br>`;
    } else {
        comparison += `⚠️ Risk increased by ${Math.abs(riskChange).toFixed(1)}%<br>`;
    }
    comparison += `📅 Added ${timeChange} days (${newDte} DTE total)<br>`;
    comparison += `💰 Net credit: $${(rollCredit * 100).toFixed(0)} per contract<br>`;
    comparison += `<br><b>Verdict:</b> ${riskChange > 5 ? '✅ Good roll!' : riskChange > 0 ? '👍 Decent roll' : '⚠️ Not recommended'}`;
    
    const rollCompEl = document.getElementById('rollComparison');
    const rollResultsEl = document.getElementById('rollResults');
    if (rollCompEl) rollCompEl.innerHTML = comparison;
    if (rollResultsEl) rollResultsEl.style.display = 'block';
}
