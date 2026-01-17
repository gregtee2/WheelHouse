// WheelHouse - Analysis Module
// Recommendations, EV calculations, Roll calculator

import { state } from './state.js';
import { getPositionType } from './pricing.js';
import { randomNormal, showNotification } from './utils.js';

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
    
    // Get contract count from position context
    const contracts = state.currentPositionContext?.contracts || 1;
    
    // Input is now TOTAL credit/debit for all contracts
    const totalRollCredit = parseFloat(rollCreditEl?.value || '50');
    const rollCreditPerContract = totalRollCredit / contracts;
    const rollCredit = rollCreditPerContract / 100; // Convert to per-share for calculations
    
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
    const totalPremiumPerShare = currentPremium + rollCredit;
    const totalPremiumAllContracts = totalPremiumPerShare * 100 * contracts;
    
    setEl('rollNewStrikeDisp', '$' + newStrike.toFixed(2));
    setEl('rollNewDteDisp', newDte + ' days');
    setEl('rollNewRisk', newRisk.toFixed(1) + '%');
    setEl('rollTotalPremium', '$' + totalPremiumAllContracts.toFixed(0) + (contracts > 1 ? ` (${contracts} contracts)` : ''));
    setEl('rollNetCredit', '$' + totalRollCredit.toFixed(0));
    
    const riskChange = currentRisk - newRisk;
    const timeChange = newDte - currentDte;
    const isCredit = totalRollCredit >= 0;
    const isDebit = totalRollCredit < 0;
    const totalDebitAmount = Math.abs(totalRollCredit);
    
    let comparison = '';
    if (riskChange > 0) {
        comparison += `✅ <b>Risk reduced by ${riskChange.toFixed(1)}%</b><br>`;
    } else {
        comparison += `⚠️ Risk increased by ${Math.abs(riskChange).toFixed(1)}%<br>`;
    }
    comparison += `📅 Added ${timeChange} days (${newDte} DTE total)<br>`;
    
    // Show credit or debit with appropriate styling (total amounts like Schwab)
    if (isDebit) {
        comparison += `💸 Net DEBIT: <span style="color:#ff5252;">-$${totalDebitAmount.toFixed(0)}</span> (you pay)<br>`;
    } else {
        comparison += `💰 Net credit: <span style="color:#00ff88;">+$${totalRollCredit.toFixed(0)}</span> (you receive)<br>`;
    }
    
    // Smarter verdict that considers both risk AND money (using totals)
    let verdict = '';
    // Scale thresholds by contract count for fair comparison
    const significantDebit = 100 * contracts;  // $100 per contract is significant
    const smallDebit = 50 * contracts;         // $50 per contract is small
    
    if (isDebit) {
        // Paying money to roll - need significant risk reduction to justify
        const costPerPercentReduction = totalDebitAmount / Math.max(riskChange, 0.1);
        if (riskChange <= 0) {
            verdict = '❌ Bad roll - paying money AND increasing risk!';
        } else if (riskChange > 20 && totalDebitAmount < smallDebit) {
            verdict = '✅ Worth it - major risk reduction for small cost';
        } else if (riskChange > 30) {
            verdict = '👍 Acceptable - big risk reduction, but you\'re paying';
        } else if (costPerPercentReduction > (20 * contracts)) {
            verdict = `⚠️ Expensive - paying $${(costPerPercentReduction/contracts).toFixed(0)}/contract per 1% reduction`;
        } else {
            verdict = '🤔 Consider it - paying to reduce risk';
        }
    } else {
        // Receiving credit - much better!
        const goodCredit = 50 * contracts;  // $50+ per contract is good
        if (riskChange > 5) {
            verdict = '✅ Great roll! Risk down + you get paid';
        } else if (riskChange > 0) {
            verdict = '👍 Good roll - credit received';
        } else if (totalRollCredit > goodCredit) {
            verdict = '🤔 Risky but profitable - nice credit, more risk';
        } else {
            verdict = '⚠️ Not ideal - more risk for small credit';
        }
    }
    comparison += `<br><b>Verdict:</b> ${verdict}`;
    
    const rollCompEl = document.getElementById('rollComparison');
    if (rollCompEl) rollCompEl.innerHTML = comparison;
    // Results panel is always visible now, no need to toggle display
}

/**
 * Suggest optimal roll parameters
 * Fetches REAL strikes from CBOE and uses actual bid prices
 */
export async function suggestOptimalRoll() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    const spot = state.spot;
    const vol = state.optVol;
    
    // Get contract count from position context
    const contracts = state.currentPositionContext?.contracts || 1;
    
    // Get ticker from the input field
    const tickerEl = document.getElementById('tickerInput');
    const ticker = tickerEl?.value?.toUpperCase() || '';
    
    if (!ticker) {
        showNotification('Enter a ticker first', 'warning');
        return;
    }
    
    // Get current risk from displayed value
    const optLowerEl = document.getElementById('optLower');
    const currentRisk = parseFloat(optLowerEl?.textContent?.replace('%','') || '50');
    
    const suggestionsEl = document.getElementById('rollSuggestions');
    const listEl = document.getElementById('rollSuggestionsList');
    if (!suggestionsEl || !listEl) return;
    
    listEl.innerHTML = '<div style="color:#888;">🔄 Fetching options chain from CBOE...</div>';
    suggestionsEl.style.display = 'block';
    
    await new Promise(r => setTimeout(r, 50)); // Let UI update
    
    // Fetch real options chain from CBOE
    let chain;
    try {
        chain = await window.fetchOptionsChain(ticker);
    } catch (e) {
        listEl.innerHTML = `<div style="color:#ff5252;">❌ Could not fetch options chain: ${e.message}</div>`;
        return;
    }
    
    if (!chain.puts || chain.puts.length === 0) {
        listEl.innerHTML = '<div style="color:#ff5252;">❌ No put options found for this ticker</div>';
        return;
    }
    
    listEl.innerHTML = '<div style="color:#888;">🔄 Analyzing real strikes...</div>';
    await new Promise(r => setTimeout(r, 50));
    
    // Get unique strikes and expirations from the chain
    const today = new Date();
    const availableStrikes = [...new Set(chain.puts.map(p => p.strike))].sort((a, b) => b - a);
    const availableExpirations = chain.expirations.filter(exp => {
        const expDate = new Date(exp);
        const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        return dte > currentDte; // Only future expirations beyond current
    });
    
    // Filter strikes: below current strike (rolling down)
    const candidateStrikes = availableStrikes.filter(s => s < currentStrike && s > 0);
    
    if (candidateStrikes.length === 0) {
        listEl.innerHTML = '<div style="color:#ffaa00;">⚠️ No lower strikes available. Already at lowest?</div>';
        return;
    }
    
    const candidates = [];
    const quickPaths = 500;
    
    // Test each real strike/expiration combination
    for (const expiration of availableExpirations.slice(0, 5)) { // Limit to 5 expirations
        const expDate = new Date(expiration);
        const dteVal = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        
        const T = dteVal / 365.25;
        const numSteps = 30;
        const dt = T / numSteps;
        
        for (const testStrike of candidateStrikes.slice(0, 8)) { // Limit to 8 strikes
            // Skip if strike is above spot (too aggressive for puts)
            if (testStrike >= spot) continue;
            
            // Find the actual option in the chain
            const option = chain.puts.find(p => 
                p.strike === testStrike && p.expiration === expiration
            );
            
            // Use real bid price if available (per share), convert to per contract
            const realBidPerShare = option?.bid || 0;
            const realBidPerContract = realBidPerShare * 100;
            
            // Monte Carlo for ITM probability
            let belowCount = 0;
            for (let i = 0; i < quickPaths; i++) {
                let S = spot;
                for (let step = 0; step < numSteps; step++) {
                    const dW = randomNormal() * Math.sqrt(dt);
                    S *= Math.exp((state.rate - 0.5*vol*vol)*dt + vol*dW);
                }
                if (S < testStrike) belowCount++;
            }
            const newRisk = (belowCount / quickPaths) * 100;
            
            // Calculate score
            const riskReduction = currentRisk - newRisk;
            const timeAdded = dteVal - currentDte;
            
            // Score: prioritize risk reduction, then premium, then time
            // Use real bid (per share) for premium component
            const score = (riskReduction * 3) + (realBidPerShare * 2) + (timeAdded * 0.1);
            
            candidates.push({
                strike: testStrike,
                dte: dteVal,
                expiration: expiration,
                risk: newRisk,
                riskChange: riskReduction,
                timeAdded: timeAdded,
                realBidPerContract: realBidPerContract,
                score: score
            });
        }
    }
    
    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);
    
    // Take top 3
    const top3 = candidates.slice(0, 3);
    
    if (top3.length === 0) {
        listEl.innerHTML = '<div style="color:#ffaa00;">⚠️ No better rolls found. Consider closing position.</div>';
        return;
    }
    
    // Render suggestions
    let html = '';
    top3.forEach((c, i) => {
        const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        const riskColor = c.riskChange > 0 ? '#00ff88' : '#ff5252';
        const riskIcon = c.riskChange > 0 ? '↓' : '↑';
        // Show TOTAL credit for all contracts (like Schwab shows)
        const totalCredit = c.realBidPerContract * contracts;
        const bidDisplay = totalCredit > 0 ? `$${totalCredit.toFixed(0)} credit` : 'no bid';
        
        // Format expiration date nicely (e.g., "Feb 21")
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `
            <div style="padding:8px; margin-bottom:6px; background:rgba(0,0,0,0.3); border-radius:4px; cursor:pointer;" 
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalCredit})">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="white-space:nowrap;">${emoji} <b>$${c.strike.toFixed(2)}</b> · <b>${expFormatted}</b></span>
                    <span style="color:${riskColor}; font-size:12px;">${riskIcon} ${Math.abs(c.riskChange).toFixed(1)}% risk</span>
                </div>
                <div style="font-size:11px; color:#888; margin-top:4px;">
                    ${c.dte}d (+${c.timeAdded}) | ${bidDisplay} | ITM: ${c.risk.toFixed(1)}%
                </div>
            </div>
        `;
    });
    
    html += `<div style="font-size:10px; color:#00d9ff; margin-top:6px;">✓ Using real CBOE strikes & bids${contracts > 1 ? ` (${contracts} contracts)` : ''}</div>`;
    listEl.innerHTML = html;
}

// Global function to apply suggestion to inputs
window.applyRollSuggestion = function(strike, dte, expiration, totalCredit) {
    const strikeEl = document.getElementById('rollNewStrike');
    const dteEl = document.getElementById('rollNewDte');
    const expiryEl = document.getElementById('rollNewExpiry');
    const creditEl = document.getElementById('rollCredit');
    
    if (strikeEl) strikeEl.value = strike;
    if (dteEl) dteEl.value = dte;
    if (creditEl && totalCredit !== undefined) creditEl.value = Math.round(totalCredit);
    
    // Use actual expiration date if provided
    if (expiryEl && expiration) {
        expiryEl.value = expiration;
    } else if (expiryEl) {
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + dte);
        expiryEl.value = expDate.toISOString().split('T')[0];
    }
    
    // Trigger calculation
    const rollBtn = document.getElementById('rollBtn');
    if (rollBtn) rollBtn.click();
};

