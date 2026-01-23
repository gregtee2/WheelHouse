// WheelHouse - Analysis Module
// Recommendations, EV calculations, Roll calculator

import { state } from './state.js';
import { getPositionType } from './pricing.js';
import { randomNormal, showNotification } from './utils.js';
import { formatPortfolioContextForAI } from './portfolio.js';

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
    const isLong = posType.isLong; // true for long_call, long_put
    
    // For LONG options, the risk/win logic is inverted
    // Long call: risk = below strike (expires worthless), win = above strike
    // Long put: risk = above strike (expires worthless), win = below strike
    // Short put: risk = below strike (assignment), win = above strike
    // Short call/covered call: risk = above strike (assignment), win = below strike
    let riskPct, winPct;
    
    if (isLong) {
        // Long call: risk is expiring worthless (below strike)
        // Long put: risk is expiring worthless (above strike)
        riskPct = isPut ? aboveStrikePct : belowStrikePct;
        winPct = isPut ? belowStrikePct : aboveStrikePct;
    } else {
        // Short put: risk is assignment (below strike)
        // Covered call: risk is assignment (above strike)
        riskPct = isPut ? belowStrikePct : aboveStrikePct;
        winPct = isPut ? aboveStrikePct : belowStrikePct;
    }
    
    const safeThreshold = 30;
    const watchThreshold = 40;
    const cautionThreshold = 50;
    const dangerThreshold = 60;
    
    // For long options, use different language (expiring worthless vs assignment)
    const riskLabel = isLong ? 'expire worthless' : 'assignment';
    const riskAction = isLong ? 'expiring worthless' : 'assignment';
    
    if (riskPct < safeThreshold) {
        recBox.className = 'recommendation-box safe';
        recTitle.textContent = isLong ? '✅ Looking Good - IN PROFIT ZONE' : '✅ Low Risk - HOLD';
        recAction.textContent = isLong 
            ? `✅ ON TRACK - ${winPct.toFixed(1)}% profit probability`
            : `✅ HOLD - ${riskPct.toFixed(1)}% assignment risk`;
        if (isLong) {
            if (isPut) {
                recReason.innerHTML = `<b>Why:</b> ${winPct.toFixed(0)}% chance stock closes below $${state.strike.toFixed(2)}. Your long put is on track!`;
            } else {
                recReason.innerHTML = `<b>Why:</b> ${winPct.toFixed(0)}% chance stock closes above $${state.strike.toFixed(2)}. Your long call is on track!`;
            }
            recTip.textContent = `💡 Consider taking profits or setting a trailing stop.`;
        } else if (isPut) {
            recReason.innerHTML = `<b>Why:</b> Only ${riskPct.toFixed(0)}% chance stock closes below $${state.strike.toFixed(2)} in ${dteValue} days. <b>${winPct.toFixed(0)}% chance you keep premium!</b>`;
            recTip.textContent = `💡 Tip: Set an alert at $${(state.strike * 0.95).toFixed(2)}. Let theta work for you.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> Only ${riskPct.toFixed(0)}% chance stock closes above $${state.strike.toFixed(2)}. Shares likely stay yours.`;
            recTip.textContent = `💡 Tip: ${winPct.toFixed(0)}% win probability. Let the position ride.`;
        }
    } else if (riskPct < watchThreshold) {
        recBox.className = 'recommendation-box safe';
        recTitle.textContent = isLong ? '👀 50/50 Zone - MONITOR' : '👀 Moderate Risk - WATCH';
        recAction.textContent = isLong
            ? `⚠️ CLOSE TO BREAKEVEN - ${winPct.toFixed(1)}% win probability`
            : `⚠️ WATCH CLOSELY - ${riskPct.toFixed(1)}% assignment risk`;
        recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% risk of ${riskAction}. Still ${winPct.toFixed(0)}% win probability, but close.`;
        recTip.textContent = isLong 
            ? `💡 Set a price target. Consider cutting losses early if wrong.`
            : `💡 Consider profit-taking at 50-75% max gain.`;
    } else if (riskPct < cautionThreshold) {
        recBox.className = 'recommendation-box caution';
        recTitle.textContent = isLong ? '⚠️ CAUTION - Losing Odds' : '⚠️ CAUTION - Consider Rolling';
        recAction.textContent = isLong
            ? `🔄 RECONSIDER - ${riskPct.toFixed(1)}% chance of ${riskAction}`
            : `🔄 ROLL OR CLOSE - ${riskPct.toFixed(1)}% assignment risk`;
        if (isLong) {
            recReason.innerHTML = `<b>Why:</b> Only ${winPct.toFixed(0)}% chance of profit. Odds are against you.`;
            recTip.textContent = `💡 Consider: Close to salvage time value, or hold if you have conviction.`;
        } else if (isPut) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance stock closes below strike. Close to 50/50 - not ideal.`;
            recTip.textContent = `💡 Roll to: $${(state.strike * 0.95).toFixed(2)} for ${Math.min(dteValue + 30, 60)} DTE.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance of losing shares.`;
            recTip.textContent = `💡 Roll to: $${(state.strike * 1.05).toFixed(2)} for ${Math.min(dteValue + 30, 60)} DTE.`;
        }
    } else if (riskPct < dangerThreshold) {
        recBox.className = 'recommendation-box danger';
        recTitle.textContent = isLong ? '🚨 HIGH RISK - Likely Loss' : '🚨 HIGH RISK - ROLL NOW!';
        recAction.textContent = isLong
            ? `🔴 ${riskPct.toFixed(1)}% chance of expiring worthless!`
            : `🔴 ROLL NOW - ${riskPct.toFixed(1)}% assignment risk!`;
        if (isLong) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance your option expires worthless. More likely to lose than win.`;
            recTip.textContent = `💡 Action: Close to salvage remaining time value, or accept the likely loss.`;
        } else if (isPut) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance stock closes below $${state.strike.toFixed(2)}. More likely to be assigned than not!`;
            recTip.textContent = `💡 Action: Close $${state.strike.toFixed(2)} put TODAY. Sell $${(state.strike * 0.90).toFixed(2)} put for 45 DTE.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance shares get called away.`;
            recTip.textContent = `💡 Action: Close $${state.strike.toFixed(2)} call TODAY or roll much higher.`;
        }
    } else {
        recBox.className = 'recommendation-box danger';
        recTitle.textContent = isLong ? '🔥 CRITICAL - Likely to Expire Worthless' : '🔥 CRITICAL - High Assignment Probability!';
        recAction.textContent = isLong
            ? `‼️ ${riskPct.toFixed(1)}% chance of total loss!`
            : `‼️ DECISION TIME - ${riskPct.toFixed(1)}% assignment risk!`;
        if (isLong) {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% probability your option expires worthless. The trade has moved against you.`;
            recTip.innerHTML = `<b>👉 Options:</b><br>1) Close NOW to salvage any remaining time value<br>2) Hold if you still expect a reversal (high risk)`;
        } else if (isPut) {
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
    
    // Show cost basis box for covered calls
    const costBasisBox = document.getElementById('costBasisBox');
    const costBasisValue = document.getElementById('costBasisValue');
    const gainIfCalledValue = document.getElementById('gainIfCalledValue');
    
    const costBasis = state.currentPositionContext?.costBasis || state.currentPositionContext?.holdingCostBasis;
    const posType = getPositionType();
    
    // Show for any CALL position (not put) that has a cost basis
    if (costBasisBox && costBasis && !isPut) {
        costBasisBox.style.display = 'block';
        costBasisValue.textContent = '$' + costBasis.toFixed(2);
        
        // Calculate gain if called: (Strike - Cost Basis + Premium) × 100 × contracts
        const gainIfCalled = (state.strike - costBasis + premium) * 100 * contracts;
        const gainPerShare = state.strike - costBasis + premium;
        const gainPct = ((gainPerShare / costBasis) * 100).toFixed(1);
        
        if (gainIfCalled >= 0) {
            gainIfCalledValue.textContent = `+$${gainIfCalled.toFixed(0)} (${gainPct}%)`;
            gainIfCalledValue.style.color = '#00ff88';
        } else {
            gainIfCalledValue.textContent = `-$${Math.abs(gainIfCalled).toFixed(0)} (${gainPct}%)`;
            gainIfCalledValue.style.color = '#ff5252';
        }
    } else if (costBasisBox) {
        costBasisBox.style.display = 'none';
    }
    
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
    
    // Calculate margin impact for short options (puts and naked calls)
    calculateMarginImpact(state.spot, state.strike, premium, contracts, isPut);
}

/**
 * Calculate margin impact for selling a short option (put or call)
 * Uses Schwab's standard margin formula:
 * 
 * SHORT PUT:
 *   Margin = max(20% of stock - OTM amount + premium, 10% of strike + premium)
 * 
 * SHORT CALL (naked):
 *   Margin = max(20% of stock + OTM amount + premium, 10% of stock + premium)
 * 
 * Note: Covered calls don't require margin if you own the shares
 */
async function calculateMarginImpact(spot, strike, premium, contracts, isPut) {
    const marginBox = document.getElementById('marginImpactBox');
    if (!marginBox) return;
    
    let totalMarginRequired;
    let marginType;
    
    if (isPut) {
        // SHORT PUT margin
        const otmAmount = Math.max(0, spot - strike);  // Positive if OTM
        const optionA = (0.20 * spot - otmAmount + premium) * 100;
        const optionB = (0.10 * strike + premium) * 100;
        const marginPerContract = Math.max(optionA, optionB);
        totalMarginRequired = marginPerContract * contracts;
        marginType = 'Short Put';
        
        console.log(`[MARGIN] PUT: Spot=$${spot}, Strike=$${strike}, Premium=$${premium}`);
        console.log(`[MARGIN] OTM=$${otmAmount.toFixed(2)}, OptionA=$${optionA.toFixed(0)}, OptionB=$${optionB.toFixed(0)}`);
    } else {
        // SHORT CALL margin (naked call - assumes no shares owned)
        const otmAmount = Math.max(0, strike - spot);  // Positive if OTM
        const optionA = (0.20 * spot + otmAmount + premium) * 100;
        const optionB = (0.10 * spot + premium) * 100;
        const marginPerContract = Math.max(optionA, optionB);
        totalMarginRequired = marginPerContract * contracts;
        marginType = 'Short Call';
        
        console.log(`[MARGIN] CALL: Spot=$${spot}, Strike=$${strike}, Premium=$${premium}`);
        console.log(`[MARGIN] OTM=$${otmAmount.toFixed(2)}, OptionA=$${optionA.toFixed(0)}, OptionB=$${optionB.toFixed(0)}`);
    }
    
    console.log(`[MARGIN] ${marginType}: $${totalMarginRequired.toFixed(0)} required`);
    
    // Update the option type label
    const typeLabel = document.getElementById('marginOptionType');
    if (typeLabel) typeLabel.textContent = `(${marginType})`;
    
    // Show covered call note for calls
    const coveredNote = document.getElementById('marginCoveredNote');
    if (coveredNote) coveredNote.style.display = isPut ? 'none' : 'block';
    
    // Fetch current buying power from Schwab
    let buyingPower = null;
    try {
        const res = await fetch('/api/schwab/accounts');
        if (res.ok) {
            const accounts = await res.json();
            const marginAccount = accounts.find(a => a.securitiesAccount?.type === 'MARGIN');
            buyingPower = marginAccount?.securitiesAccount?.currentBalances?.buyingPower;
        }
    } catch (e) {
        console.log('[MARGIN] Could not fetch buying power:', e.message);
    }
    
    // Format helper
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    // Update display
    document.getElementById('marginRequired').textContent = fmt(totalMarginRequired);
    
    if (buyingPower !== null) {
        const afterTrade = buyingPower - totalMarginRequired;
        const utilization = (totalMarginRequired / buyingPower) * 100;
        
        document.getElementById('marginBuyingPower').textContent = fmt(buyingPower);
        document.getElementById('marginBuyingPower').style.color = '#00d9ff';
        
        document.getElementById('marginAfterTrade').textContent = fmt(afterTrade);
        document.getElementById('marginAfterTrade').style.color = afterTrade > 0 ? '#00ff88' : '#ff5252';
        
        document.getElementById('marginUtilization').textContent = utilization.toFixed(1) + '%';
        document.getElementById('marginUtilization').style.color = utilization < 25 ? '#00ff88' : utilization < 50 ? '#ffaa00' : '#ff5252';
        
        // Verdict
        const verdictEl = document.getElementById('marginVerdict');
        if (afterTrade < 0) {
            verdictEl.innerHTML = '❌ <strong>INSUFFICIENT MARGIN</strong> - You need $' + fmt(Math.abs(afterTrade)).replace('$','') + ' more buying power';
            verdictEl.style.background = 'rgba(255,82,82,0.2)';
            verdictEl.style.color = '#ff5252';
        } else if (utilization > 50) {
            verdictEl.innerHTML = '⚠️ <strong>HIGH UTILIZATION</strong> - This uses ' + utilization.toFixed(0) + '% of your buying power';
            verdictEl.style.background = 'rgba(255,170,0,0.2)';
            verdictEl.style.color = '#ffaa00';
        } else if (utilization > 25) {
            verdictEl.innerHTML = '✓ <strong>OK</strong> - Uses ' + utilization.toFixed(0) + '% of buying power';
            verdictEl.style.background = 'rgba(0,217,255,0.2)';
            verdictEl.style.color = '#00d9ff';
        } else {
            verdictEl.innerHTML = '✅ <strong>LOW IMPACT</strong> - Only uses ' + utilization.toFixed(0) + '% of buying power';
            verdictEl.style.background = 'rgba(0,255,136,0.2)';
            verdictEl.style.color = '#00ff88';
        }
    } else {
        // No Schwab connection
        document.getElementById('marginBuyingPower').textContent = '—';
        document.getElementById('marginBuyingPower').style.color = '#888';
        document.getElementById('marginAfterTrade').textContent = '—';
        document.getElementById('marginUtilization').textContent = '—';
        
        const verdictEl = document.getElementById('marginVerdict');
        verdictEl.innerHTML = '💡 Connect Schwab to see if you can afford this trade';
        verdictEl.style.background = 'rgba(255,255,255,0.1)';
        verdictEl.style.color = '#888';
    }
    
    // Show the box
    marginBox.style.display = 'block';
}

/**
 * Calculate roll scenario
 */
export async function calculateRoll() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    
    // Determine if this is a call or put position
    const posType = state.currentPositionContext?.type || '';
    const isBuyWrite = posType === 'buy_write';
    const isCoveredCall = posType === 'covered_call' || isBuyWrite;
    const isCall = isCoveredCall || posType.includes('call');
    
    // Get current premium - use call price for calls, put price for puts
    // Or use stored premium from position context
    let currentPremium;
    if (state.currentPositionContext?.premium) {
        currentPremium = state.currentPositionContext.premium;
    } else {
        const priceEl = document.getElementById(isCall ? 'callPrice' : 'putPrice');
        currentPremium = parseFloat(priceEl?.textContent?.replace('$','') || '0');
    }
    
    // For calls, "risk" is probability of assignment (stock > strike)
    // For puts, "risk" is probability of assignment (stock < strike)
    const optLowerEl = document.getElementById('optLower');  // Below strike %
    const optUpperEl = document.getElementById('optUpper');  // Above strike %
    const currentRisk = isCall 
        ? parseFloat(optUpperEl?.textContent?.replace('%','') || '0')
        : parseFloat(optLowerEl?.textContent?.replace('%','') || '0');
    
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
    
    // Simulate new position - count assignment risk
    // For puts: assignment if stock < strike
    // For calls: assignment if stock > strike
    let riskCount = 0;
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
        // For calls (including Buy/Write), risk is stock > strike (called away)
        // For puts, risk is stock < strike (assigned stock)
        if (isCall) {
            if (S > newStrike) riskCount++;
        } else {
            if (S < newStrike) riskCount++;
        }
    }
    
    const newRisk = (riskCount / quickPaths) * 100;
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
 * Helper to render roll option rows
 */
function renderRollOptions(candidates, contracts, isCallPosition, currentAsk) {
    if (candidates.length === 0) return '<div style="color:#888;">No options available</div>';
    
    let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
    
    candidates.forEach((c, i) => {
        const totalRollNet = c.rollNetPerContract * contracts;
        const isDebit = totalRollNet < 0;
        
        let netDisplay;
        if (isDebit) {
            netDisplay = `<span style="color:#ff5252;">$${Math.abs(totalRollNet).toFixed(0)} deb</span>`;
        } else if (totalRollNet > 0) {
            netDisplay = `<span style="color:#00ff88;">$${totalRollNet.toFixed(0)} cr</span>`;
        } else {
            netDisplay = '<span style="color:#888;">$0</span>';
        }
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `
            <div style="padding:8px; background:rgba(0,0,0,0.3); border-radius:4px; cursor:pointer; border:1px solid rgba(255,255,255,0.1);"
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:#00d9ff; font-weight:bold;">$${c.strike}</span>
                    <span style="color:#888; font-size:11px;">${expFormatted} (${c.dte}d)</span>
                    <span style="font-weight:bold;">${netDisplay}</span>
                </div>
                ${c.newBidPerShare > 0 ? `<div style="font-size:10px; color:#666;">Bid: $${c.newBidPerShare.toFixed(2)}</div>` : ''}
            </div>
        `;
    });
    
    html += '</div>';
    return html;
}

/**
 * Suggest optimal roll parameters
 * Fetches REAL strikes from CBOE and calculates TRUE roll cost/credit
 * For PUTS: Roll = (Sell new put at BID) - (Buy to close current put at ASK)
 * For CALLS: Roll = (Sell new call at BID) - (Buy to close current call at ASK)
 */
export async function suggestOptimalRoll() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    const spot = state.spot;
    const vol = state.optVol;
    
    // Get contract count and position type from context
    const contracts = state.currentPositionContext?.contracts || 1;
    const posType = state.currentPositionContext?.type || 'short_put';
    const isBuyWrite = posType === 'buy_write';
    const isCoveredCall = posType === 'short_call' || posType === 'covered_call';
    const isLongCall = posType === 'long_call';
    const isLongPut = posType === 'long_put';
    const isLong = isLongCall || isLongPut;
    const isCallPosition = isBuyWrite || isCoveredCall || isLongCall;
    
    // Get ticker from the input field
    const tickerEl = document.getElementById('tickerInput');
    const ticker = tickerEl?.value?.toUpperCase() || '';
    
    if (!ticker) {
        showNotification('Enter a ticker first', 'warning');
        return;
    }
    
    // For LONG options, rolling is less common - usually you just close or hold
    // But we can still show roll options (roll to higher strike for calls, lower for puts)
    
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
    
    // Use calls for Buy/Write and covered calls, puts for short puts
    const optionChain = isCallPosition ? chain.calls : chain.puts;
    const optionType = isCallPosition ? 'call' : 'put';
    
    if (!optionChain || optionChain.length === 0) {
        listEl.innerHTML = `<div style="color:#ff5252;">❌ No ${optionType} options found for this ticker</div>`;
        return;
    }
    
    listEl.innerHTML = '<div style="color:#888;">🔄 Analyzing real strikes...</div>';
    await new Promise(r => setTimeout(r, 50));
    
    // Find the CURRENT position's option to get its ASK price (cost to close)
    // We need to match the current strike and find the nearest expiration to our current DTE
    const today = new Date();
    const currentExpiryTarget = new Date(today.getTime() + currentDte * 24 * 60 * 60 * 1000);
    
    // Find current option (closest expiration to our current DTE at current strike)
    let currentAsk = 0;
    let currentExpiration = null;
    
    // Find all options at current strike
    const currentStrikeOptions = optionChain.filter(p => Math.abs(p.strike - currentStrike) < 0.01);
    
    if (currentStrikeOptions.length > 0) {
        // Find the one with expiration closest to our current DTE
        currentStrikeOptions.sort((a, b) => {
            const aDiff = Math.abs(new Date(a.expiration) - currentExpiryTarget);
            const bDiff = Math.abs(new Date(b.expiration) - currentExpiryTarget);
            return aDiff - bDiff;
        });
        const currentOption = currentStrikeOptions[0];
        currentAsk = currentOption.ask || currentOption.bid * 1.1 || 0;
        currentExpiration = currentOption.expiration;
        console.log(`Current position: $${currentStrike} ${optionType}, exp ${currentExpiration}, ASK=$${currentAsk.toFixed(2)}`);
    } else {
        // Can't find current option - estimate from displayed price
        const priceEl = document.getElementById(isCallPosition ? 'callPrice' : 'putPrice');
        currentAsk = parseFloat(priceEl?.textContent?.replace('$','') || '0') * 1.05;
        console.log(`Current position: $${currentStrike} ${optionType} not in chain, estimating ASK=$${currentAsk.toFixed(2)}`);
    }
    
    // Get unique strikes and expirations from the chain
    const availableStrikes = [...new Set(optionChain.map(p => p.strike))].sort((a, b) => b - a);
    const availableExpirations = chain.expirations.filter(exp => {
        const expDate = new Date(exp);
        const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        return dte > currentDte; // Only future expirations beyond current
    });
    
    // Filter strikes based on position type:
    // PUTS: Roll DOWN (lower strikes = less risk)
    // CALLS: Roll UP (higher strikes = more upside before assignment)
    // BUT: For covered calls near expiry, rolling OUT at same strike is also valid
    let candidateStrikes;
    if (isCallPosition) {
        // For calls, include same strike (roll out) and higher strikes (roll up)
        // Sort ASCENDING so strikes closest to current come first
        candidateStrikes = availableStrikes
            .filter(s => s >= currentStrike && s <= spot * 1.3)  // Filter first
            .sort((a, b) => a - b);  // Sort ascending (closest to current first)
    } else {
        // For puts, rolling DOWN means lower strikes (less assignment risk)
        // Also include same strike for roll out
        // Sort DESCENDING so strikes closest to current come first
        candidateStrikes = availableStrikes
            .filter(s => s <= currentStrike && s > 0 && s >= spot * 0.7)  // Filter first
            .sort((a, b) => b - a);  // Sort descending (closest to current first)
    }
    
    if (candidateStrikes.length === 0) {
        const direction = isCallPosition ? 'higher' : 'lower';
        listEl.innerHTML = `<div style="color:#ffaa00;">⚠️ No ${direction} strikes available in options chain.</div>`;
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
        
        for (const testStrike of candidateStrikes.slice(0, 10)) { // Limit to 10 strikes (already filtered)
            // Find the actual option in the chain
            const option = optionChain.find(p => 
                p.strike === testStrike && p.expiration === expiration
            );
            
            // Use real bid price (what you receive when selling)
            const newBidPerShare = option?.bid || 0;
            
            // Capture Greeks from CBOE data
            const delta = option?.delta || 0;
            const theta = option?.theta || 0;
            const iv = option?.impliedVolatility || 0;
            
            // Calculate TRUE roll net: New bid - Current ask
            // Negative = DEBIT (you pay), Positive = CREDIT (you receive)
            const rollNetPerShare = newBidPerShare - currentAsk;
            const rollNetPerContract = rollNetPerShare * 100;
            
            // Monte Carlo for risk probability
            // PUTS: Risk = chance stock ends below strike (assignment)
            // CALLS: Risk = chance stock ends above strike (shares called away)
            let riskCount = 0;
            for (let i = 0; i < quickPaths; i++) {
                let S = spot;
                for (let step = 0; step < numSteps; step++) {
                    const dW = randomNormal() * Math.sqrt(dt);
                    S *= Math.exp((state.rate - 0.5*vol*vol)*dt + vol*dW);
                }
                if (isCallPosition) {
                    if (S > testStrike) riskCount++; // Shares will be called
                } else {
                    if (S < testStrike) riskCount++; // Will be assigned
                }
            }
            const newRisk = (riskCount / quickPaths) * 100;
            
            // Calculate score - for calls, "risk" is assignment which is actually the goal!
            // So for calls, higher risk = closer to max profit
            const riskReduction = currentRisk - newRisk;
            const timeAdded = dteVal - currentDte;
            
            // Score: prioritize risk reduction, penalize debits, reward credits
            // For puts: lower risk = better (less chance of assignment)
            // For calls: higher "risk" = good (higher chance of max profit)
            let score;
            if (isCallPosition) {
                // For calls, we want to roll UP for more upside
                // Higher strike + credit is best
                score = (rollNetPerShare * 10) + ((testStrike - currentStrike) * 0.5) + (timeAdded * 0.1);
            } else {
                // For puts, we want to reduce risk
                score = (riskReduction * 3) + (rollNetPerShare * 5) + (timeAdded * 0.1);
            }
            
            candidates.push({
                strike: testStrike,
                dte: dteVal,
                expiration: expiration,
                risk: newRisk,
                riskChange: riskReduction,
                timeAdded: timeAdded,
                newBidPerShare: newBidPerShare,
                currentAskPerShare: currentAsk,
                rollNetPerContract: rollNetPerContract,
                delta: delta,
                theta: theta,
                iv: iv,
                score: score,
                isCall: isCallPosition
            });
        }
    }
    
    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);
    
    // Take top 3 for best score
    const top3 = candidates.slice(0, 3);
    
    // Find credit rolls specifically (positive net)
    const creditRolls = candidates
        .filter(c => c.rollNetPerContract > 0)
        .sort((a, b) => b.rollNetPerContract - a.rollNetPerContract)
        .slice(0, 3);
    
    // If we have candidates but none are "attractive", still show them
    const hasAnyCandidates = candidates.length > 0;
    
    if (top3.length === 0 && creditRolls.length === 0) {
        if (!hasAnyCandidates) {
            // Truly no candidates found
            const direction = isCallPosition ? 'higher' : 'lower';
            const optionLabel = isCallPosition ? 'call' : 'put';
            listEl.innerHTML = `
                <div style="color:#ffaa00; padding:10px; background:rgba(255,170,0,0.1); border-radius:6px;">
                    <div style="font-weight:bold; margin-bottom:8px;">⚠️ No roll options found in chain</div>
                    <div style="font-size:12px; color:#aaa;">
                        <div>• Current: $${currentStrike} ${optionLabel}, ${currentDte}d DTE</div>
                        <div>• Spot: $${spot.toFixed(2)} (${((spot/currentStrike - 1) * 100).toFixed(1)}% vs strike)</div>
                        <div>• Options may not be available at these strikes/expirations</div>
                        <div style="margin-top:8px; color:#888;">Try the Expert System suggestion in the Options tab.</div>
                    </div>
                </div>
            `;
        } else {
            // We have candidates but none scored well - show them anyway
            const allRolls = candidates.slice(0, 5);
            let html = `<div style="font-size:11px; color:#888; margin-bottom:8px;">
                ⚠️ No ideal rolls, but here are available options:
            </div>`;
            html += renderRollOptions(allRolls, contracts, isCallPosition, currentAsk);
            listEl.innerHTML = html;
        }
        return;
    }
    
    // Render suggestions
    let html = '';
    
    // Show cost to close current position
    const totalCostToClose = currentAsk * 100 * contracts;
    const optionLabel = isCallPosition ? 'call' : 'put';
    html += `<div style="font-size:12px; color:#aaa; margin-bottom:10px; padding:8px; background:rgba(255,82,82,0.15); border-radius:4px; border:1px solid rgba(255,82,82,0.3);">
        💰 Close <b>$${currentStrike.toFixed(0)}</b> ${optionLabel}: <span style="color:#ff5252; font-weight:bold;">$${totalCostToClose.toFixed(0)}</span>
        <span style="color:#888; font-size:11px;">(${contracts} × $${(currentAsk * 100).toFixed(0)})</span>
    </div>`;
    
    // Helper to render a candidate row - COMPACT for 2-column grid
    const renderCandidate = (c, i, emoji) => {
        const riskColor = c.riskChange > 0 ? '#00ff88' : '#ff5252';
        const riskIcon = c.riskChange > 0 ? '↓' : '↑';
        
        const totalRollNet = c.rollNetPerContract * contracts;
        const isDebit = totalRollNet < 0;
        
        let netDisplay;
        if (isDebit) {
            netDisplay = `<span style="color:#ff5252; font-weight:bold;">$${Math.abs(totalRollNet).toFixed(0)} deb</span>`;
        } else if (totalRollNet > 0) {
            netDisplay = `<span style="color:#00ff88; font-weight:bold;">$${totalRollNet.toFixed(0)} cr</span>`;
        } else {
            netDisplay = '<span style="color:#888;">—</span>';
        }
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        // Format Greeks - compact
        const deltaDisplay = c.delta ? `Δ${c.delta.toFixed(2)}` : '';
        const ivDisplay = c.iv ? `IV${(c.iv * 100).toFixed(0)}%` : '';
        const greeksLine = [deltaDisplay, ivDisplay].filter(Boolean).join(' ');
        
        return `
            <div style="padding:6px 8px; background:rgba(0,0,0,0.4); border-radius:4px; cursor:pointer; border:1px solid rgba(255,255,255,0.1);" 
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})"
                 onmouseover="this.style.borderColor='rgba(0,217,255,0.5)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'">
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px;">
                    <span>${emoji} <b>$${c.strike.toFixed(0)}</b></span>
                    <span style="color:${riskColor}; font-size:11px;">${riskIcon}${Math.abs(c.riskChange).toFixed(0)}%</span>
                </div>
                <div style="color:#aaa; font-size:11px; margin-top:3px;">
                    ${expFormatted} · ${netDisplay}
                </div>
                ${greeksLine ? `<div style="font-size:10px; color:#8b5cf6; margin-top:2px;">${greeksLine}</div>` : ''}
            </div>
        `;
    };
    
    // Best suggestions section - 2-column grid
    // For puts: "Best Risk Reduction" (lower strikes)
    // For calls: "Best Roll Up" (higher strikes = more upside)
    if (top3.length > 0) {
        const sectionTitle = isCallPosition ? '📈 Best Roll Up' : '📉 Best Risk Reduction';
        html += `<div style="font-size:12px; color:#00d9ff; margin-bottom:6px; font-weight:bold;">${sectionTitle}</div>`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">`;
        top3.forEach((c, i) => {
            const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
            html += renderCandidate(c, i, emoji);
        });
        html += `</div>`;
    }
    
    // Credit Rolls section - 2-column grid
    if (creditRolls.length > 0) {
        html += `<div style="font-size:12px; color:#00ff88; margin:8px 0 6px 0; font-weight:bold;">💵 Credit Rolls</div>`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">`;
        creditRolls.forEach((c, i) => {
            html += renderCandidate(c, i, '💰');
        });
        html += `</div>`;
    } else {
        // No credit rolls found - offer to search further out
        html += `<div style="font-size:11px; color:#aaa; margin-top:8px; padding:8px; background:rgba(255,170,0,0.1); border-radius:4px;">
            ⚠️ No credit rolls nearby.
            <button onclick="window.findCreditRolls()" 
                    style="display:block; margin-top:6px; background:#00ff88; border:none; color:#000; padding:6px 12px; 
                           border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; width:100%;">
                🔍 Search Further Out
            </button>
        </div>`;
    }
    
    html += `<div style="font-size:11px; color:#00d9ff; margin-top:10px;">✓ Real CBOE prices: close @ ASK, open @ BID${contracts > 1 ? ` (${contracts} contracts)` : ''}</div>`;
    listEl.innerHTML = html;
    
    // Render expert analysis with option chain data for IV context
    renderExpertAnalysis('expertAnalysis', chain);
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

/**
 * Find credit rolls by searching further out in time
 * Searches ALL expirations and same/higher strikes to maximize credit potential
 */
window.findCreditRolls = async function() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    const spot = state.spot;
    const vol = state.optVol;
    const contracts = state.currentPositionContext?.contracts || 1;
    
    const tickerEl = document.getElementById('tickerInput');
    const ticker = tickerEl?.value?.toUpperCase() || '';
    
    if (!ticker) {
        showNotification('Enter a ticker first', 'warning');
        return;
    }
    
    const listEl = document.getElementById('rollSuggestionsList');
    if (!listEl) return;
    
    listEl.innerHTML = '<div style="color:#888;">🔄 Searching ALL expirations for credit rolls...</div>';
    await new Promise(r => setTimeout(r, 50));
    
    let chain;
    try {
        chain = await window.fetchOptionsChain(ticker);
    } catch (e) {
        listEl.innerHTML = `<div style="color:#ff5252;">❌ Could not fetch options chain: ${e.message}</div>`;
        return;
    }
    
    if (!chain.puts || chain.puts.length === 0) {
        listEl.innerHTML = '<div style="color:#ff5252;">❌ No put options found</div>';
        return;
    }
    
    // Find current put's ask price
    const today = new Date();
    const currentExpiryTarget = new Date(today.getTime() + currentDte * 24 * 60 * 60 * 1000);
    
    let currentPutAsk = 0;
    const currentStrikePuts = chain.puts.filter(p => Math.abs(p.strike - currentStrike) < 0.01);
    if (currentStrikePuts.length > 0) {
        currentStrikePuts.sort((a, b) => {
            const aDiff = Math.abs(new Date(a.expiration) - currentExpiryTarget);
            const bDiff = Math.abs(new Date(b.expiration) - currentExpiryTarget);
            return aDiff - bDiff;
        });
        currentPutAsk = currentStrikePuts[0].ask || currentStrikePuts[0].bid * 1.1 || 0;
    } else {
        const putPriceEl = document.getElementById('putPrice');
        currentPutAsk = parseFloat(putPriceEl?.textContent?.replace('$','') || '0') * 1.05;
    }
    
    // Search ALL future expirations (not just first 5)
    const allExpirations = chain.expirations.filter(exp => {
        const expDate = new Date(exp);
        const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        return dte > currentDte;
    });
    
    // Include same strike AND higher strikes (not just lower)
    const allStrikes = [...new Set(chain.puts.map(p => p.strike))].sort((a, b) => b - a);
    const candidateStrikes = allStrikes.filter(s => s <= currentStrike * 1.1 && s > 0); // Up to 10% above current
    
    const creditCandidates = [];
    const quickPaths = 300;
    
    for (const expiration of allExpirations) {
        const expDate = new Date(expiration);
        const dteVal = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
        
        const T = dteVal / 365.25;
        const numSteps = 30;
        const dt = T / numSteps;
        
        for (const testStrike of candidateStrikes) {
            if (testStrike >= spot * 1.1) continue; // Skip very high strikes
            
            const option = chain.puts.find(p => 
                p.strike === testStrike && p.expiration === expiration
            );
            
            const newPutBidPerShare = option?.bid || 0;
            const rollNetPerShare = newPutBidPerShare - currentPutAsk;
            
            // Only keep if it's a credit!
            if (rollNetPerShare <= 0) continue;
            
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
            const riskReduction = state.currentPositionContext?.risk || 50 - newRisk;
            
            creditCandidates.push({
                strike: testStrike,
                dte: dteVal,
                expiration: expiration,
                risk: newRisk,
                riskChange: riskReduction,
                timeAdded: dteVal - currentDte,
                rollNetPerContract: rollNetPerShare * 100,
                newPutBidPerShare: newPutBidPerShare
            });
        }
    }
    
    // Sort by credit amount (highest first)
    creditCandidates.sort((a, b) => b.rollNetPerContract - a.rollNetPerContract);
    
    const topCredits = creditCandidates.slice(0, 6); // Show top 6
    
    if (topCredits.length === 0) {
        const posType = state.currentPositionContext?.type || 'short_put';
        const isLong = posType === 'long_call' || posType === 'long_put';
        const optionType = posType.includes('call') ? 'call' : 'put';
        
        listEl.innerHTML = `<div style="color:#ff5252; padding:10px;">
            ❌ No credit rolls available for this position.<br>
            <span style="font-size:11px; color:#888;">${isLong 
                ? 'Long options are typically closed, not rolled. Consider selling to close.'
                : `The current ${optionType} is too deep ITM. You may need to take a debit to roll, or accept assignment.`
            }</span>
        </div>`;
        return;
    }
    
    // Render credit rolls
    const posType2 = state.currentPositionContext?.type || 'short_put';
    const optionLabel2 = posType2.includes('call') ? 'call' : 'put';
    let html = `<div style="font-size:11px; color:#888; margin-bottom:8px; padding:6px; background:rgba(255,82,82,0.1); border-radius:4px;">
        💰 Cost to close $${currentStrike.toFixed(0)} ${optionLabel2}: <span style="color:#ff5252;">$${(currentPutAsk * 100 * contracts).toFixed(0)}</span>
    </div>`;
    
    html += `<div style="font-size:12px; color:#00ff88; margin-bottom:6px; font-weight:bold;">💵 Credit Roll Options (${topCredits.length} found)</div>`;
    
    topCredits.forEach((c, i) => {
        const totalRollNet = c.rollNetPerContract * contracts;
        const riskColor = c.riskChange > 0 ? '#00ff88' : '#ff5252';
        const riskIcon = c.riskChange > 0 ? '↓' : '↑';
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `
            <div style="padding:8px; margin-bottom:6px; background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); border-radius:4px; cursor:pointer;" 
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="white-space:nowrap;">💰 <b>$${c.strike.toFixed(2)}</b> · <b>${expFormatted}</b></span>
                    <span style="color:#00ff88; font-weight:bold;">+$${totalRollNet.toFixed(0)} credit</span>
                </div>
                <div style="font-size:11px; color:#888; margin-top:4px;">
                    ${c.dte}d (+${c.timeAdded}) | <span style="color:${riskColor};">${riskIcon} ${Math.abs(c.riskChange).toFixed(1)}% risk</span> | ITM: ${c.risk.toFixed(1)}%
                </div>
            </div>
        `;
    });
    
    html += `<div style="font-size:10px; color:#888; margin-top:8px;">
        💡 <i>Credit rolls typically require going further out in time. Consider the added time risk.</i>
    </div>`;
    
    html += `<button onclick="window.suggestOptimalRoll()" 
                style="display:block; margin-top:8px; background:rgba(0,217,255,0.2); border:1px solid #00d9ff; color:#00d9ff; 
                       padding:6px 12px; border-radius:4px; cursor:pointer; font-size:11px; width:100%;">
        ← Back to Risk-Based Suggestions
    </button>`;
    
    listEl.innerHTML = html;
};

/**
 * RULE-BASED EXPERT SYSTEM
 * Analyzes the current position and market conditions to provide smart recommendations.
 * Uses decision tree logic based on:
 * - ITM/OTM status (position risk)
 * - DTE (time pressure)
 * - IV level (premium environment)
 * - Available credit/debit rolls
 */
export function analyzePositionExpert(position, spot, optionChainData) {
    const results = {
        situation: '',
        urgency: 'low', // low, medium, high, critical
        recommendation: '',
        actions: [],
        reasoning: ''
    };
    
    const strike = position.strike;
    const dte = position.dte || 0;
    const posType = position.type || 'short_put';
    const isBuyWrite = posType === 'buy_write';
    const isCoveredCall = posType === 'short_call' || posType === 'covered_call';
    const isLongCall = posType === 'long_call';
    const isLongPut = posType === 'long_put';
    const isCallPosition = isBuyWrite || isCoveredCall;
    
    // Get average IV from option chain if available
    let avgIV = 0.3; // Default 30%
    const chainData = isCallPosition ? optionChainData?.calls : optionChainData?.puts;
    if (chainData && chainData.length > 0) {
        const ivs = chainData
            .map(p => p.impliedVolatility)
            .filter(iv => iv && iv > 0);
        if (ivs.length > 0) {
            avgIV = ivs.reduce((a, b) => a + b, 0) / ivs.length;
        }
    }
    const ivRank = avgIV > 0.5 ? 'high' : avgIV > 0.3 ? 'medium' : 'low';
    
    // === BUY/WRITE & COVERED CALL ANALYSIS ===
    if (isCallPosition) {
        const stockPrice = position.stockPrice || spot;
        const premium = position.premium || 0;
        const costBasis = position.costBasis || position.holdingCostBasis || stockPrice;
        const contracts = position.contracts || 1;
        const shares = contracts * 100;
        
        // For calls: ITM = spot > strike (stock above call strike, will be called away)
        const callIsITM = spot > strike;
        const callDepth = callIsITM ? ((spot - strike) / strike * 100) : 0;
        const otmDistance = !callIsITM ? ((strike - spot) / spot * 100) : 0;
        
        // Calculate max profit if called away - use costBasis for true gain
        const gainOnShares = Math.max(0, (strike - costBasis)) * shares;
        const premiumCollected = premium * 100 * contracts;
        const maxProfit = gainOnShares + premiumCollected;
        const maxProfitPct = (maxProfit / (costBasis * shares)) * 100;
        
        // Current unrealized on stock
        const unrealizedStock = (spot - stockPrice) * shares;
        
        if (callIsITM && callDepth > 5 && dte <= 7) {
            results.situation = '📞 ITM CALL - LIKELY ASSIGNMENT';
            results.urgency = 'medium';
            results.recommendation = 'Prepare for shares to be called away at profit';
            const profitBreakdown1 = gainOnShares > 0 
                ? `$${gainOnShares.toFixed(0)} stock + $${premiumCollected.toFixed(0)} prem`
                : `$${premiumCollected.toFixed(0)} premium`;
            results.actions = [
                `Max profit if assigned: $${maxProfit.toFixed(0)} (${maxProfitPct.toFixed(1)}%) = ${profitBreakdown1}`,
                'Let expire ITM for clean assignment, or...',
                'Roll out+up to keep shares & collect more premium'
            ];
            results.reasoning = `Stock is ${callDepth.toFixed(1)}% above strike. Assignment = you sell at $${strike} + keep $${premiumCollected.toFixed(0)} premium. This is the ideal outcome for covered calls.`;
        }
        else if (callIsITM && dte > 7) {
            results.situation = '📈 CALL ITM - SHARES RALLYING';
            results.urgency = 'low';
            results.recommendation = 'On track for max profit - let it ride';
            const profitBreakdown2 = gainOnShares > 0 
                ? `$${gainOnShares.toFixed(0)} stock + $${premiumCollected.toFixed(0)} prem`
                : `$${premiumCollected.toFixed(0)} premium`;
            results.actions = [
                `Max profit at assignment: $${maxProfit.toFixed(0)} (${maxProfitPct.toFixed(1)}%) = ${profitBreakdown2}`,
                'Can roll up+out for more upside (costs debit)',
                'Or let expire for clean assignment'
            ];
            results.reasoning = `Stock above strike is good! You\'ll realize max profit if called away. Plenty of time for stock to stay above strike.`;
        }
        else if (!callIsITM && otmDistance < 5 && dte <= 14) {
            results.situation = '👀 CALL ATM - COULD GO EITHER WAY';
            results.urgency = 'medium';
            results.recommendation = 'Prime theta decay zone - hold';
            results.actions = [
                `Close call at 50-80% profit to free up shares`,
                'Stock near strike = max time decay',
                `Unrealized stock P/L: ${unrealizedStock >= 0 ? '+' : ''}$${unrealizedStock.toFixed(0)}`
            ];
            results.reasoning = `ATM calls decay fastest. You're collecting max theta. If it stays here, call expires worthless and you keep shares + premium.`;
        }
        else if (!callIsITM && otmDistance >= 5) {
            results.situation = '🔄 CALL OTM - PREMIUM DECAYING';
            results.urgency = 'low';
            results.recommendation = dte <= 14 ? 'Close early to roll to new strike' : 'Let theta work';
            results.actions = [
                `Call is ${otmDistance.toFixed(1)}% OTM - likely expires worthless`,
                dte <= 7 ? 'Roll to new strike/expiry for more premium' : 'Hold for more decay',
                `Stock P/L: ${unrealizedStock >= 0 ? '+' : ''}$${unrealizedStock.toFixed(0)} (unrealized)`
            ];
            results.reasoning = `Call is safely OTM. You'll keep shares and premium. Consider rolling to collect more if DTE is low.`;
        }
        else {
            results.situation = isBuyWrite ? '📈 BUY/WRITE ACTIVE' : '📞 COVERED CALL ACTIVE';
            results.urgency = 'low';
            results.recommendation = 'Position running normally';
            results.actions = [
                `Cost basis: $${costBasis.toFixed(2)}/share`,
                `Max profit if called: $${maxProfit.toFixed(0)}`,
                'Monitor for early assignment around ex-div dates'
            ];
            results.reasoning = `Standard covered call management. Time is on your side.`;
        }
        
        // Add IV context for calls
        if (ivRank === 'high') {
            results.ivContext = {
                value: `${(avgIV * 100).toFixed(0)}% IV`,
                advice: 'Elevated IV - good time to sell more calls'
            };
        } else if (ivRank === 'low') {
            results.ivContext = {
                value: `${(avgIV * 100).toFixed(0)}% IV`,
                advice: 'Low IV - consider waiting to roll'
            };
        }
        
        return results;
    }
    
    // === LONG CALL ANALYSIS ===
    if (isLongCall) {
        const premium = position.premium || 0;
        const contracts = position.contracts || 1;
        const maxLoss = premium * 100 * contracts; // Premium paid
        const breakeven = strike + premium;
        
        // For long calls: ITM = spot > strike (profitable if exercised)
        const callIsITM = spot > strike;
        const intrinsicValue = callIsITM ? (spot - strike) * 100 * contracts : 0;
        const unrealizedPL = intrinsicValue - maxLoss;
        const distanceToStrike = ((spot - strike) / spot) * 100;
        const distanceToBreakeven = ((spot - breakeven) / spot) * 100;
        
        if (callIsITM && spot >= breakeven && dte <= 7) {
            results.situation = '💰 PROFITABLE - EXPIRING SOON';
            results.urgency = 'medium';
            results.recommendation = 'Take profits or exercise';
            results.actions = [
                `Current profit: +$${unrealizedPL.toFixed(0)}`,
                'Sell to close and lock in profit',
                'Or exercise to acquire shares at $' + strike.toFixed(2)
            ];
            results.reasoning = `Long call is ${distanceToStrike.toFixed(1)}% ITM with only ${dte} days left. Time decay accelerates - consider closing.`;
        }
        else if (callIsITM && spot >= breakeven) {
            results.situation = '📈 PROFITABLE LONG CALL';
            results.urgency = 'low';
            results.recommendation = 'Consider profit target or trailing stop';
            results.actions = [
                `Unrealized P/L: +$${unrealizedPL.toFixed(0)}`,
                'Set mental trailing stop on premium',
                dte <= 21 ? 'Time decay accelerating - take profits soon' : 'Can hold for more upside'
            ];
            results.reasoning = `Position is profitable. Breakeven is $${breakeven.toFixed(2)}, spot is above. Consider profit targets.`;
        }
        else if (callIsITM && spot < breakeven) {
            results.situation = '⚡ ITM BUT BELOW BREAKEVEN';
            results.urgency = 'medium';
            results.recommendation = 'Has intrinsic value but still losing';
            results.actions = [
                `Intrinsic value: $${intrinsicValue.toFixed(0)} (below cost)`,
                `Need $${breakeven.toFixed(2)} to break even`,
                dte <= 14 ? 'Consider salvage value - close to recover partial loss' : 'Hold for rally'
            ];
            results.reasoning = `Stock is above strike but you paid $${premium.toFixed(2)} premium. Need more upside to profit.`;
        }
        else if (!callIsITM && Math.abs(distanceToStrike) < 5) {
            results.situation = '👀 AT-THE-MONEY';
            results.urgency = 'medium';
            results.recommendation = 'Monitor - could go either way';
            results.actions = [
                `Distance to strike: ${Math.abs(distanceToStrike).toFixed(1)}%`,
                `Breakeven: $${breakeven.toFixed(2)}`,
                dte <= 14 ? 'Time decay hurts - needs quick move' : 'Still time for rally'
            ];
            results.reasoning = `ATM options have highest gamma and theta. Price can swing either direction quickly.`;
        }
        else if (!callIsITM && dte <= 14) {
            results.situation = '⚠️ OTM, EXPIRING SOON';
            results.urgency = 'high';
            results.recommendation = 'Risk of expiring worthless - decide now';
            results.actions = [
                `Need ${Math.abs(distanceToStrike).toFixed(1)}% rally to reach strike`,
                'Sell to salvage remaining time value',
                `Max loss if expires: $${maxLoss.toFixed(0)}`
            ];
            results.reasoning = `Long call is ${Math.abs(distanceToStrike).toFixed(1)}% OTM with ${dte} days left. Time decay accelerates exponentially.`;
        }
        else if (!callIsITM && dte > 14) {
            results.situation = '📊 OTM LONG CALL';
            results.urgency = 'low';
            results.recommendation = 'Still time - monitor for entry rally';
            results.actions = [
                `Distance to strike: ${Math.abs(distanceToStrike).toFixed(1)}%`,
                `Breakeven: $${breakeven.toFixed(2)}`,
                `Max risk: $${maxLoss.toFixed(0)} (premium paid)`
            ];
            results.reasoning = `With ${dte} days remaining, there's time for the stock to rally. But OTM calls lose value daily.`;
        }
        else {
            results.situation = '📞 LONG CALL ACTIVE';
            results.urgency = 'low';
            results.recommendation = 'Monitor for profit opportunities';
            results.actions = [
                `Breakeven: $${breakeven.toFixed(2)}`,
                `Max loss: $${maxLoss.toFixed(0)} (premium paid)`,
                'Time is working against you'
            ];
            results.reasoning = `Long call analysis. Remember: you own the right to buy, no assignment risk. Risk is expiring worthless.`;
        }
        
        // Add IV context for long calls (opposite of short - low IV is good to buy)
        if (ivRank === 'high') {
            results.ivContext = {
                value: `${(avgIV * 100).toFixed(0)}% IV`,
                advice: 'High IV means expensive premiums - consider waiting'
            };
        } else if (ivRank === 'low') {
            results.ivContext = {
                value: `${(avgIV * 100).toFixed(0)}% IV`,
                advice: 'Low IV - options are cheaper to buy'
            };
        }
        
        return results;
    }
    
    // === LONG PUT ANALYSIS ===
    if (isLongPut) {
        const premium = position.premium || 0;
        const contracts = position.contracts || 1;
        const maxLoss = premium * 100 * contracts;
        const breakeven = strike - premium;
        
        // For long puts: ITM = spot < strike (profitable if exercised)
        const putIsITM = spot < strike;
        const intrinsicValue = putIsITM ? (strike - spot) * 100 * contracts : 0;
        const unrealizedPL = intrinsicValue - maxLoss;
        const distanceToStrike = ((strike - spot) / spot) * 100;
        
        if (putIsITM && spot <= breakeven && dte <= 7) {
            results.situation = '💰 PROFITABLE - EXPIRING SOON';
            results.urgency = 'medium';
            results.recommendation = 'Take profits - sell to close';
            results.actions = [
                `Current profit: +$${unrealizedPL.toFixed(0)}`,
                'Sell to close and lock in profit',
                'Exercise only if you want to sell shares at $' + strike.toFixed(2)
            ];
            results.reasoning = `Long put is ${distanceToStrike.toFixed(1)}% ITM with ${dte} days left. Consider closing.`;
        }
        else if (putIsITM) {
            results.situation = '📉 PROFITABLE LONG PUT';
            results.urgency = 'low';
            results.recommendation = 'Position is working - consider profit target';
            results.actions = [
                `Unrealized P/L: ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(0)}`,
                `Breakeven: $${breakeven.toFixed(2)}`,
                'Consider trailing stop on premium value'
            ];
            results.reasoning = `Long put is ITM. Good hedge or directional play working.`;
        }
        else if (!putIsITM && dte <= 14) {
            results.situation = '⚠️ OTM, EXPIRING SOON';
            results.urgency = 'high';
            results.recommendation = 'Risk of expiring worthless';
            results.actions = [
                `Need ${distanceToStrike.toFixed(1)}% drop to reach strike`,
                'Sell to salvage remaining time value',
                `Max loss: $${maxLoss.toFixed(0)}`
            ];
            results.reasoning = `Long put is ${distanceToStrike.toFixed(1)}% OTM with ${dte} days left. Time decay accelerates.`;
        }
        else {
            results.situation = '📊 LONG PUT ACTIVE';
            results.urgency = 'low';
            results.recommendation = 'Monitor for downside move';
            results.actions = [
                `Breakeven: $${breakeven.toFixed(2)}`,
                `Max loss: $${maxLoss.toFixed(0)}`,
                'Time works against you'
            ];
            results.reasoning = `Long put - you profit if stock drops. No assignment risk, just premium at risk.`;
        }
        
        if (ivRank === 'high') {
            results.ivContext = { value: `${(avgIV * 100).toFixed(0)}% IV`, advice: 'High IV = expensive puts' };
        } else if (ivRank === 'low') {
            results.ivContext = { value: `${(avgIV * 100).toFixed(0)}% IV`, advice: 'Low IV = cheaper puts' };
        }
        
        return results;
    }
    
    // === SHORT PUT ANALYSIS (Original Logic) ===
    const moneyness = ((spot - strike) / strike) * 100; // Negative = ITM for puts
    
    // Determine position status
    const isITM = spot < strike; // For short puts
    const itDepth = isITM ? ((strike - spot) / strike * 100) : 0;
    
    // CRITICAL: Deep ITM with low DTE
    if (isITM && itDepth > 10 && dte <= 7) {
        results.situation = '🚨 DEEP ITM, EXPIRING SOON';
        results.urgency = 'critical';
        results.recommendation = 'Roll immediately or prepare for assignment';
        results.actions = [
            'Roll out 30+ days for any available credit',
            'If no credit possible, consider accepting assignment',
            'Calculate break-even with cost basis if assigned'
        ];
        results.reasoning = `Position is ${itDepth.toFixed(1)}% in-the-money with only ${dte} days left. Assignment is highly likely without action.`;
    }
    // HIGH: ITM approaching expiration
    else if (isITM && dte <= 14) {
        results.situation = '⚠️ ITM, TIME PRESSURE';
        results.urgency = 'high';
        results.recommendation = 'Roll this week to avoid gamma risk';
        results.actions = [
            'Look for 45-60 day rolls for best premium',
            'Consider rolling down for credit if IV is high',
            'Set alert for earnings dates before new expiration'
        ];
        results.reasoning = `Short puts accelerate in risk as expiration nears. Rolling now preserves options and may capture credit.`;
    }
    // MEDIUM: ITM but plenty of time
    else if (isITM && dte > 14) {
        results.situation = '📊 ITM, MONITOR CLOSELY';
        results.urgency = 'medium';
        results.recommendation = 'Watch for bounce, no immediate action needed';
        results.actions = [
            'Set price alert at strike price',
            'Prepare roll plan if stock doesn\'t recover',
            ivRank === 'high' ? 'IV is elevated - good for rolling if needed' : 'IV is low - consider waiting for spike'
        ];
        results.reasoning = `With ${dte} days remaining, there's time for price recovery. Monitor but don't panic roll.`;
    }
    // OTM but close to strike
    else if (!isITM && Math.abs(moneyness) < 5) {
        results.situation = '👀 AT-THE-MONEY';
        results.urgency = 'medium';
        results.recommendation = dte <= 7 ? 'Consider early close for profit' : 'Monitor - could go either way';
        results.actions = [
            'Current premium decay is fastest (highest theta)',
            dte <= 14 ? 'Close at 50-70% profit target' : 'Hold for more decay',
            'Have roll plan ready if it goes ITM'
        ];
        results.reasoning = `ATM options have highest gamma and theta. Price can swing either direction quickly.`;
    }
    // OTM with safe cushion
    else if (!isITM && Math.abs(moneyness) >= 5 && dte <= 21) {
        results.situation = '✅ OTM, APPROACHING EXPIRATION';
        results.urgency = 'low';
        results.recommendation = 'Let theta work - on track for max profit';
        results.actions = [
            'Close at 80-90% profit to free capital',
            'Start planning next trade',
            'Consider rolling out for new premium if delta < 0.15'
        ];
        results.reasoning = `Position is safely OTM with limited time value. Time decay is your friend.`;
    }
    // OTM with lots of time
    else if (!isITM && dte > 21) {
        results.situation = '🟢 OTM, EARLY IN TRADE';
        results.urgency = 'low';
        results.recommendation = 'Patience - let the trade develop';
        results.actions = [
            'Monitor at 50% profit for early exit',
            'Check for upcoming earnings/dividends',
            ivRank === 'high' ? 'Consider closing early on IV crush' : 'Normal hold strategy'
        ];
        results.reasoning = `Plenty of time remaining. Theta accelerates closer to expiration.`;
    }
    // Default case
    else {
        results.situation = '📋 STANDARD POSITION';
        results.urgency = 'low';
        results.recommendation = 'No immediate action required';
        results.actions = [
            'Follow standard management rules',
            'Close at profit target (50-75%)',
            'Roll if challenged'
        ];
        results.reasoning = `Position is within normal parameters. Standard wheel management applies.`;
    }
    
    // Add IV context
    results.ivContext = {
        level: ivRank,
        value: (avgIV * 100).toFixed(0) + '%',
        advice: ivRank === 'high' 
            ? '💡 High IV = good for rolling (more premium)' 
            : ivRank === 'low' 
                ? '💡 Low IV = consider waiting for spike before rolling'
                : '💡 Normal IV environment'
    };
    
    return results;
}

/**
 * Render Expert System analysis in Roll Calculator panel
 */
export function renderExpertAnalysis(containerId, optionChainData = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // Get current position context
    const ctx = state.currentPositionContext;
    if (!ctx) {
        container.innerHTML = '<div style="color:#888; font-size:11px;">Load a position to see expert analysis.</div>';
        return;
    }
    
    // Get current spot price - prefer slider value over context
    const spotEl = document.getElementById('rollSpot');
    const spot = spotEl ? parseFloat(spotEl.value) : (state.spot || ctx.spot || 0);
    
    // Use CURRENT state values (from sliders) over original context values
    // This ensures Expert Analysis matches what user sees in charts
    const currentStrike = state.strike || ctx.strike;
    const currentDte = state.dte || ctx.dte;
    
    // Create position object for analysis
    const position = {
        strike: currentStrike,  // Use current slider value!
        dte: currentDte,        // Use current slider value!
        premium: ctx.premium,
        type: ctx.type || 'short_put',
        stockPrice: ctx.stockPrice,
        costBasis: ctx.costBasis,
        contracts: ctx.contracts
    };
    
    // Run expert analysis with option chain data for IV context
    const analysis = analyzePositionExpert(position, spot, optionChainData);
    
    // Render
    const urgencyColors = {
        low: '#00ff88',
        medium: '#ffaa00',
        high: '#ff8800',
        critical: '#ff5252'
    };
    
    // Build earnings/dividend warning if we have calendar data
    let calendarWarning = '';
    if (analysis.calendarWarnings && analysis.calendarWarnings.length > 0) {
        calendarWarning = `
            <div style="background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.5); border-radius:4px; padding:8px; margin-bottom:8px;">
                ${analysis.calendarWarnings.map(w => `<div style="font-size:11px; color:#ffaa00;">⚠️ ${w}</div>`).join('')}
            </div>
        `;
    }
    
    let html = `
        <div style="background:rgba(0,0,0,0.4); border-radius:6px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span style="font-size:13px; font-weight:bold;">${analysis.situation}</span>
                <span style="background:${urgencyColors[analysis.urgency]}; color:#000; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:bold;">
                    ${analysis.urgency.toUpperCase()}
                </span>
            </div>
            ${calendarWarning}
            <div style="font-size:12px; color:#00d9ff; margin-bottom:6px;">
                📌 ${analysis.recommendation}
            </div>
            <div style="font-size:11px; color:#aaa; margin-bottom:8px; line-height:1.3;">
                ${analysis.reasoning}
            </div>
            <div style="border-top:1px solid #444; padding-top:8px;">
                <div style="font-size:11px; color:#ccc; margin-bottom:4px; font-weight:bold;">Actions:</div>
                ${analysis.actions.map(a => `<div style="font-size:11px; color:#eee; padding:2px 0 2px 10px;">• ${a}</div>`).join('')}
            </div>
            ${analysis.ivContext ? `
                <div style="font-size:10px; color:#8b5cf6; margin-top:8px; padding-top:6px; border-top:1px solid #444;">
                    💡 ${analysis.ivContext.advice} (${analysis.ivContext.value})
                </div>
            ` : ''}
        </div>
    `;
    
    container.innerHTML = html;
    
    // Async fetch calendar data and update warnings
    fetchCalendarAndUpdateWarnings(container, ctx, position, spot, analysis, urgencyColors);
}

/**
 * Async function to fetch calendar data and update the expert analysis with warnings
 */
async function fetchCalendarAndUpdateWarnings(container, ctx, position, spot, analysis, urgencyColors) {
    const ticker = ctx.ticker;
    if (!ticker || !window.fetchCalendarData) return;
    
    try {
        const calendarData = await window.fetchCalendarData(ticker);
        
        // Calculate expiration date from position DTE
        const today = new Date();
        const expiryDate = new Date(today.getTime() + (ctx.dte || 0) * 24 * 60 * 60 * 1000);
        
        const warnings = [];
        
        // Check earnings date
        if (calendarData.earningsDate) {
            const earningsDate = new Date(calendarData.earningsDate + 'T00:00:00');
            if (earningsDate <= expiryDate) {
                const daysToEarnings = Math.ceil((earningsDate - today) / (1000 * 60 * 60 * 24));
                const formatted = earningsDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                warnings.push(`📊 EARNINGS ${formatted} (${daysToEarnings}d) - BEFORE your expiration!`);
            }
        }
        
        // Check ex-dividend date
        if (calendarData.exDividendDate) {
            const exDivDate = new Date(calendarData.exDividendDate + 'T00:00:00');
            if (exDivDate <= expiryDate && exDivDate >= today) {
                const daysToExDiv = Math.ceil((exDivDate - today) / (1000 * 60 * 60 * 24));
                const formatted = exDivDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                warnings.push(`💰 EX-DIVIDEND ${formatted} (${daysToExDiv}d) - Early assignment risk for ITM puts!`);
            }
        }
        
        if (warnings.length > 0) {
            analysis.calendarWarnings = warnings;
            
            // Re-render with calendar warnings (use same larger font styles)
            let calendarWarning = `
                <div style="background:rgba(255,170,0,0.2); border:1px solid rgba(255,170,0,0.5); border-radius:6px; padding:10px; margin-bottom:12px;">
                    ${warnings.map(w => `<div style="font-size:13px; color:#ffaa00; margin-bottom:4px;">⚠️ ${w}</div>`).join('')}
                </div>
            `;
            
            let html = `
                <div style="background:rgba(0,0,0,0.4); border-radius:8px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="font-size:15px; font-weight:bold;">${analysis.situation}</span>
                        <span style="background:${urgencyColors[analysis.urgency]}; color:#000; padding:4px 12px; border-radius:12px; font-size:11px; font-weight:bold;">
                            ${analysis.urgency.toUpperCase()}
                        </span>
                    </div>
                    ${calendarWarning}
                    <div style="font-size:14px; color:#00d9ff; margin-bottom:10px;">
                        📌 ${analysis.recommendation}
                    </div>
                    <div style="font-size:13px; color:#aaa; margin-bottom:12px; line-height:1.4;">
                        ${analysis.reasoning}
                    </div>
                    <div style="border-top:1px solid #444; padding-top:12px; margin-top:12px;">
                        <div style="font-size:13px; color:#ccc; margin-bottom:8px; font-weight:bold;">Suggested Actions:</div>
                        ${analysis.actions.map(a => `<div style="font-size:13px; color:#eee; padding:4px 0 4px 16px; line-height:1.4;">• ${a}</div>`).join('')}
                    </div>
                    ${analysis.ivContext ? `
                        <div style="font-size:12px; color:#8b5cf6; margin-top:12px; padding-top:10px; border-top:1px solid #444;">
                            💡 ${analysis.ivContext.advice} <span style="color:#aaa;">(Current: ${analysis.ivContext.value})</span>
                        </div>
                    ` : ''}
                </div>
            `;
            
            container.innerHTML = html;
        }
    } catch (e) {
        console.log('Calendar data fetch failed:', e.message);
        // Non-critical - just don't show warnings
    }
}

// Make it globally accessible
window.renderExpertAnalysis = renderExpertAnalysis;

/**
 * Get AI insight from local Qwen 7B model via Ollama
 */
async function getAIInsight() {
    const contentEl = document.getElementById('aiInsightContent');
    const btnEl = document.getElementById('aiInsightBtn');
    
    if (!contentEl || !btnEl) return;
    
    // Gather current position data FIRST for health check
    const posType = getPositionType();
    const ticker = document.getElementById('tickerInput')?.value?.toUpperCase() || 'UNKNOWN';
    
    // Get displayed probabilities
    const optLowerEl = document.getElementById('optLower');
    const optUpperEl = document.getElementById('optUpper');
    const belowPct = parseFloat(optLowerEl?.textContent?.replace('%', '') || '50');
    const abovePct = parseFloat(optUpperEl?.textContent?.replace('%', '') || '50');
    
    // Determine risk based on position type
    const isPut = posType.isPut;
    const isLong = posType.isLongCall || posType.isLongPut;
    const riskPct = isPut ? belowPct : abovePct;
    const winPct = isPut ? abovePct : belowPct;
    
    // ═══ POSITION HEALTH CHECK ═══
    // Skip AI call for healthy positions - save time and avoid "overthinking"
    const isOTM = isPut ? (state.spot > state.strike) : (state.spot < state.strike);
    const isLowRisk = riskPct < 35;
    const isHighWin = winPct > 60;
    const isShortDTE = state.dte <= 21;
    
    // Position is healthy if: OTM + low risk + high win probability
    const isHealthy = isOTM && isLowRisk && isHighWin && !isLong;
    
    if (isHealthy && isShortDTE) {
        // Don't bother the AI - position is cruising to max profit
        contentEl.innerHTML = `
            <div style="color:#00ff88; font-weight:bold; margin-bottom:8px;">
                ✅ HOLD - Position is healthy
            </div>
            <div style="color:#ddd; line-height:1.6; font-size:11px;">
                1. <b>No action needed</b> - Let theta work for you
                
                2. Position is ${(100 - riskPct).toFixed(0)}% likely to expire worthless (max profit). 
                   With only ${state.dte} DTE, time decay accelerates in your favor.
                
                3. <b>Watch:</b> If ${ticker} drops below $${state.strike?.toFixed(2) || 'strike'}, reassess.
            </div>
            <div style="font-size:9px; color:#555; margin-top:8px; text-align:right;">
                Health check • No AI needed
            </div>
        `;
        btnEl.disabled = false;
        btnEl.textContent = '💡 Get Insight';
        return;
    }
    
    // Disable button and show loading
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Thinking...';
    contentEl.innerHTML = '<div style="color:#888;">🔄 Consulting AI... (may take 5-15 seconds)</div>';
    
    try {
        // Get expert recommendation text if available
        const recActionEl = document.getElementById('recAction');
        const expertRec = recActionEl?.textContent || '';
        
        // Gather ALL roll options from the Roll Suggestions panel
        const rollOptions = gatherRollOptions();
        
        // Get cost to close current position
        const closeInfoEl = document.querySelector('#rollSuggestionsList > div:first-child');
        let costToClose = null;
        if (closeInfoEl) {
            const closeMatch = closeInfoEl.textContent.match(/\$(\d+)/);
            if (closeMatch) costToClose = parseInt(closeMatch[1]);
        }
        
        // Get selected AI model from dropdown
        const modelSelect = document.getElementById('aiModelSelect');
        const selectedModel = modelSelect?.value || 'qwen2.5:7b';
        
        // Get previous analysis for comparison (if any)
        const positionId = state.currentPositionContext?.id;
        const previousAnalysis = positionId ? (window.getLatestAnalysis?.(positionId) || null) : null;
        
        // Build request payload
        const requestData = {
            ticker: ticker,
            positionType: posType.isBuyWrite ? 'buy_write' : 
                          posType.isCoveredCall ? 'covered_call' :
                          posType.isLongCall ? 'long_call' :
                          posType.isLongPut ? 'long_put' :
                          posType.isPut ? 'short_put' : 'unknown',
            strike: state.strike,
            premium: state.currentPositionContext?.premium || 0,
            dte: state.dte,
            contracts: state.currentPositionContext?.contracts || 1,
            spot: state.spot,
            costBasis: state.currentPositionContext?.costBasis || null,
            breakeven: state.currentPositionContext?.breakeven || null,
            maxProfit: state.currentPositionContext?.maxProfit || null,
            maxLoss: state.currentPositionContext?.maxLoss || null,
            iv: state.optVol * 100,  // Convert to percentage
            riskPercent: riskPct,
            winProbability: winPct,
            costToClose: costToClose,
            rollOptions: rollOptions,  // Pass all roll options!
            expertRecommendation: expertRec,
            model: selectedModel,  // Include selected model
            previousAnalysis: previousAnalysis,  // Include previous analysis for comparison
            portfolioContext: formatPortfolioContextForAI()  // Include portfolio context from audit
        };
        
        // Call our server endpoint
        const response = await fetch('/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `Server error: ${response.status}`);
        }
        
        const result = await response.json();
        
        // Extract recommendation (HOLD, ROLL, CLOSE) from AI response
        const extractRecommendation = (text) => {
            const upper = text.toUpperCase();
            if (upper.includes('HOLD') || upper.includes('LET POSITION EXPIRE')) return 'HOLD';
            if (upper.includes('ROLL TO') || upper.includes('ROLL -')) return 'ROLL';
            if (upper.includes('CLOSE') || upper.includes('CUT LOSS') || upper.includes('EXIT')) return 'CLOSE';
            return 'REVIEW';
        };
        
        // Save analysis to position history (if we have a position context)
        // positionId already declared above when getting previousAnalysis
        if (positionId && window.saveAnalysisToPosition) {
            const analysisData = {
                insight: result.insight,
                model: selectedModel,
                recommendation: extractRecommendation(result.insight),
                snapshot: {
                    spot: state.spot,
                    strike: state.strike,
                    dte: state.dte,
                    iv: state.optVol * 100,
                    riskPercent: riskPct,
                    winProbability: winPct,
                    costToClose: costToClose
                }
            };
            window.saveAnalysisToPosition(positionId, analysisData);
            console.log('[AI] Saved analysis to position history');
        }
        
        // Format the AI response with better styling
        let formattedInsight = result.insight
            // Highlight trade execution lines
            .replace(/(BUY TO CLOSE|SELL TO OPEN|Net:)/g, '<span style="color:#00ff88; font-weight:bold;">$1</span>')
            // Highlight key actions
            .replace(/(PICK|BEST OPTION|RECOMMENDED|EXECUTE|ACTION):/gi, '<span style="color:#ffaa00; font-weight:bold;">$1:</span>')
            // Make credits green, debits red
            .replace(/(\$\d+)\s*(credit)/gi, '<span style="color:#00ff88;">$1 $2</span>')
            .replace(/(\$\d+)\s*(debit)/gi, '<span style="color:#ff5252;">$1 $2</span>');
        
        // Check if we have previous analyses
        const analysisHistory = window.getAnalysisHistory?.(positionId) || [];
        const hasHistory = analysisHistory.length > 1; // >1 because we just added one
        
        // Build MoE indicator if used
        const isMoE = result.moe && result.moe.opinions;
        const moeIndicator = isMoE ? 
            `<span style="color:#8b5cf6; margin-right:8px;" title="Mixture of Experts: 7B + 14B opinions synthesized by 32B">🧠 MoE</span>` : '';
        
        // Store MoE opinions for "View Opinions" button
        if (isMoE) {
            window._lastMoeOpinions = result.moe.opinions;
        }
        
        // Store the latest insight for "Save as Thesis"
        window._lastAIInsight = {
            insight: result.insight,
            model: selectedModel,
            spot: state.spot,
            strike: state.strike,
            dte: state.dte,
            iv: state.optVol * 100,
            riskPercent: riskPct,
            winProbability: winPct,
            positionId: positionId
        };
        
        // Check if this position already has a thesis
        const pos = positionId ? state.positions.find(p => p.id === positionId) : null;
        const hasThesis = pos?.openingThesis;
        
        // Display the AI insight with Save button
        contentEl.innerHTML = `
            <div style="color:#ddd; line-height:1.6; white-space:pre-wrap; font-size:11px;">${formattedInsight}</div>
            <div style="font-size:9px; color:#555; margin-top:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                <span>${moeIndicator}${selectedModel} • ${result.took || 'N/A'}</span>
                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    ${positionId ? `
                        <button onclick="window.saveAsThesis()" style="background:rgba(0,255,136,0.2); border:1px solid rgba(0,255,136,0.4); color:#0f8; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:9px;" title="Save this analysis as the opening thesis for ${ticker}">
                            💾 ${hasThesis ? 'Update' : 'Save'} Thesis
                        </button>
                    ` : `<span style="color:#666;" title="Load a position first to save thesis">💾 No position</span>`}
                    ${isMoE ? `<button onclick="window.showMoeOpinions()" style="background:rgba(139,92,246,0.2); border:1px solid rgba(139,92,246,0.4); color:#a78bfa; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:9px;">👁️ View Opinions</button>` : ''}
                    ${hasHistory ? `<button onclick="window.showAnalysisHistory(${positionId})" style="background:none; border:1px solid #555; color:#888; padding:2px 6px; border-radius:3px; cursor:pointer; font-size:9px;">📜 History (${analysisHistory.length})</button>` : ''}
                </div>
            </div>
        `;
        
        // Highlight the matching roll suggestion card
        highlightAIPick(result.insight);
        
    } catch (e) {
        console.error('AI insight error:', e);
        
        let errorMsg = e.message;
        if (errorMsg.includes('Ollama connection failed') || errorMsg.includes('Failed to fetch')) {
            errorMsg = `<b>Ollama not running</b><br><br>
                Start Ollama with: <code style="background:#333; padding:2px 6px; border-radius:3px;">ollama serve</code><br><br>
                Then pull the model: <code style="background:#333; padding:2px 6px; border-radius:3px;">ollama pull qwen2.5:7b</code>`;
        }
        
        contentEl.innerHTML = `<div style="color:#ff5252;">❌ ${errorMsg}</div>`;
    } finally {
        btnEl.disabled = false;
        btnEl.textContent = '💡 Get Insight';
    }
}

/**
 * Gather all roll options from the Roll Suggestions panel
 * Parses the DOM to extract structured roll data
 */
function gatherRollOptions() {
    const options = {
        riskReduction: [],
        creditRolls: []
    };
    
    const listEl = document.getElementById('rollSuggestionsList');
    if (!listEl) return options;
    
    // Find section headers and their options
    let currentSection = null;
    
    listEl.querySelectorAll('div').forEach(el => {
        const text = el.textContent.trim();
        
        // Detect section headers
        if (text.includes('Best Risk Reduction') || text.includes('Best Roll Up')) {
            currentSection = 'riskReduction';
            return;
        }
        if (text.includes('Credit Rolls')) {
            currentSection = 'creditRolls';
            return;
        }
        
        // Parse roll option cards
        // Format: "$17  ↓12%  Feb 20 · $141 cr  Δ-0.50 IV91%"
        const strikeMatch = text.match(/\$(\d+(?:\.\d+)?)/);
        const riskMatch = text.match(/[↓↑](\d+)%/);
        const dateMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/i);
        const creditMatch = text.match(/\$(\d+)\s*(cr|deb)/i);
        const deltaMatch = text.match(/Δ(-?\d+\.?\d*)/);
        const ivMatch = text.match(/IV(\d+)%/);
        
        if (strikeMatch && (creditMatch || riskMatch)) {
            const option = {
                strike: parseFloat(strikeMatch[1]),
                riskChange: riskMatch ? parseInt(riskMatch[1]) : null,
                expiry: dateMatch ? dateMatch[0] : null,
                amount: creditMatch ? parseInt(creditMatch[1]) : null,
                isCredit: creditMatch ? creditMatch[2].toLowerCase() === 'cr' : null,
                delta: deltaMatch ? parseFloat(deltaMatch[1]) : null,
                iv: ivMatch ? parseInt(ivMatch[1]) : null
            };
            
            if (currentSection === 'riskReduction') {
                options.riskReduction.push(option);
            } else if (currentSection === 'creditRolls') {
                options.creditRolls.push(option);
            }
        }
    });
    
    return options;
}

/**
 * Highlight the roll suggestion card that matches the AI's pick
 * Parses the AI response to find strike and expiry, then highlights matching card
 */
function highlightAIPick(aiResponse) {
    if (!aiResponse) return;
    
    // Clear any previous highlights
    document.querySelectorAll('.ai-pick-highlight').forEach(el => {
        el.classList.remove('ai-pick-highlight');
        el.style.border = '';
        el.style.boxShadow = '';
    });
    
    // Parse the first line to find the pick
    // Expected format: "1. Roll to $160 Aug 21 - $1820 credit" or similar
    const lines = aiResponse.split('\n');
    const firstLine = lines[0] || '';
    
    // Extract strike price (e.g., $160, $165, $86)
    const strikeMatch = firstLine.match(/\$(\d+(?:\.\d+)?)/);
    if (!strikeMatch) return;
    
    const pickedStrike = parseFloat(strikeMatch[1]);
    
    // Extract month and day (e.g., "Aug 21", "Feb 6", "Jul 17")
    const dateMatch = firstLine.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})/i);
    const pickedMonth = dateMatch ? dateMatch[1].toLowerCase() : null;
    const pickedDay = dateMatch ? parseInt(dateMatch[2]) : null;
    
    // Find all roll suggestion cards
    const listEl = document.getElementById('rollSuggestionsList');
    if (!listEl) return;
    
    // Look for cards that match the strike and (optionally) month
    const cards = listEl.querySelectorAll('div[onclick*="applyRollSuggestion"]');
    
    cards.forEach(card => {
        const cardText = card.textContent || '';
        
        // Extract strike from card (e.g., "$160" or "$165")
        const cardStrikeMatch = cardText.match(/\$(\d+(?:\.\d+)?)/);
        if (!cardStrikeMatch) return;
        
        const cardStrike = parseFloat(cardStrikeMatch[1]);
        
        // Check if strike matches
        if (Math.abs(cardStrike - pickedStrike) > 0.5) return; // Not a match
        
        // If we have a month, check that too
        if (pickedMonth) {
            const cardDateMatch = cardText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})/i);
            if (!cardDateMatch) return; // No date found in card
            
            const cardMonth = cardDateMatch[1].toLowerCase();
            const cardDay = parseInt(cardDateMatch[2]);
            
            // Month must match
            if (cardMonth !== pickedMonth) return;
            
            // If we have a specific day, it must match too
            if (pickedDay && cardDay !== pickedDay) return;
        }
        
        // This card matches! Highlight it
        card.classList.add('ai-pick-highlight');
        card.style.border = '2px solid #00ff88';
        card.style.boxShadow = '0 0 10px rgba(0, 255, 136, 0.4)';
        
        // Add a small "AI Pick" badge
        if (!card.querySelector('.ai-pick-badge')) {
            const badge = document.createElement('div');
            badge.className = 'ai-pick-badge';
            badge.style.cssText = 'position:absolute; top:-8px; right:-8px; background:#00ff88; color:#000; font-size:9px; font-weight:bold; padding:2px 5px; border-radius:8px; z-index:10;';
            badge.textContent = '🤖 AI Pick';
            card.style.position = 'relative';
            card.appendChild(badge);
        }
    });
}

/**
 * Show analysis history modal for a position
 * @param {number} positionId - The position ID
 */
function showAnalysisHistory(positionId) {
    const history = window.getAnalysisHistory?.(positionId) || [];
    if (history.length === 0) {
        alert('No analysis history for this position');
        return;
    }
    
    // Get position info
    const position = state.positions?.find(p => p.id === positionId);
    const ticker = position?.ticker || 'Unknown';
    
    // Build timeline HTML
    let timelineHtml = history.map((entry, i) => {
        const date = new Date(entry.timestamp);
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        
        // Recommendation color
        const recColor = entry.recommendation === 'HOLD' ? '#00ff88' :
                        entry.recommendation === 'ROLL' ? '#ffaa00' :
                        entry.recommendation === 'CLOSE' ? '#ff5252' : '#888';
        
        // Snapshot diff if not first entry
        let diffHtml = '';
        if (i < history.length - 1) {
            const prev = history[i + 1].snapshot || {};
            const curr = entry.snapshot || {};
            const diffs = [];
            
            if (curr.spot && prev.spot) {
                const spotChange = ((curr.spot - prev.spot) / prev.spot * 100).toFixed(1);
                if (Math.abs(spotChange) > 0.5) {
                    diffs.push(`Spot ${spotChange > 0 ? '↑' : '↓'}${Math.abs(spotChange)}%`);
                }
            }
            if (curr.iv && prev.iv) {
                const ivChange = (curr.iv - prev.iv).toFixed(0);
                if (Math.abs(ivChange) > 2) {
                    diffs.push(`IV ${ivChange > 0 ? '↑' : '↓'}${Math.abs(ivChange)}%`);
                }
            }
            if (curr.dte && prev.dte) {
                const dteChange = prev.dte - curr.dte;
                if (dteChange > 0) {
                    diffs.push(`${dteChange} days passed`);
                }
            }
            
            if (diffs.length > 0) {
                diffHtml = `<div style="font-size:9px; color:#888; margin-top:4px;">Changes: ${diffs.join(' • ')}</div>`;
            }
        }
        
        return `
            <div style="border-left:3px solid ${recColor}; padding:8px 12px; margin-bottom:12px; background:rgba(255,255,255,0.03); border-radius:0 6px 6px 0;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <span style="color:${recColor}; font-weight:bold; font-size:12px;">${entry.recommendation}</span>
                    <span style="color:#666; font-size:10px;">${dateStr} ${timeStr}</span>
                </div>
                <div style="font-size:10px; color:#aaa; margin-bottom:4px;">
                    Spot: $${entry.snapshot?.spot?.toFixed(2) || '?'} • DTE: ${entry.snapshot?.dte || '?'} • IV: ${entry.snapshot?.iv?.toFixed(0) || '?'}% • Risk: ${entry.snapshot?.riskPercent?.toFixed(1) || '?'}%
                </div>
                <div style="font-size:11px; color:#ddd; white-space:pre-wrap; line-height:1.5; max-height:120px; overflow-y:auto;">${entry.insight?.substring(0, 500) || 'No insight saved'}${entry.insight?.length > 500 ? '...' : ''}</div>
                ${diffHtml}
                <div style="font-size:9px; color:#555; margin-top:4px;">${entry.model || 'unknown model'}</div>
            </div>
        `;
    }).join('');
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'analysisHistoryModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:20px; max-width:600px; width:90%; max-height:80vh; overflow-y:auto; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="color:#fff; margin:0;">📜 Analysis History - ${ticker}</h3>
                <button onclick="this.closest('#analysisHistoryModal').remove()" style="background:none; border:none; color:#888; font-size:20px; cursor:pointer;">&times;</button>
            </div>
            <div style="color:#888; font-size:11px; margin-bottom:16px;">
                ${history.length} analysis${history.length > 1 ? 'es' : ''} saved • Newest first
            </div>
            <div id="analysisTimeline">
                ${timelineHtml}
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

/**
 * Show the MoE opinions modal - displays what 7B and 14B said before 32B made the final call
 */
function showMoeOpinions() {
    const opinions = window._lastMoeOpinions;
    if (!opinions) {
        alert('No MoE opinions available');
        return;
    }
    
    const modal = document.createElement('div');
    modal.id = 'moeOpinionsModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:10000;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:20px; max-width:700px; width:90%; max-height:80vh; overflow-y:auto; border:1px solid #333;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="color:#fff; margin:0;">🧠 Mixture of Experts - Analyst Opinions</h3>
                <button onclick="this.closest('#moeOpinionsModal').remove()" style="background:none; border:none; color:#888; font-size:20px; cursor:pointer;">&times;</button>
            </div>
            <div style="color:#888; font-size:11px; margin-bottom:16px;">
                The 7B and 14B models ran in parallel, then 32B synthesized their opinions into the final recommendation.
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <!-- 7B Opinion -->
                <div style="background:rgba(0,217,255,0.1); border:1px solid rgba(0,217,255,0.3); border-radius:8px; padding:12px;">
                    <div style="color:#00d9ff; font-weight:bold; margin-bottom:8px; font-size:12px;">
                        ⚡ Analyst #1 (Qwen 7B)
                    </div>
                    <div style="color:#ccc; font-size:11px; line-height:1.5; white-space:pre-wrap;">
                        ${opinions['7B'] || 'No response'}
                    </div>
                </div>
                
                <!-- 14B Opinion -->
                <div style="background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3); border-radius:8px; padding:12px;">
                    <div style="color:#ffaa00; font-weight:bold; margin-bottom:8px; font-size:12px;">
                        📊 Analyst #2 (Qwen 14B)
                    </div>
                    <div style="color:#ccc; font-size:11px; line-height:1.5; white-space:pre-wrap;">
                        ${opinions['14B'] || 'No response'}
                    </div>
                </div>
            </div>
            
            <div style="margin-top:16px; padding-top:12px; border-top:1px solid #444; text-align:center;">
                <span style="color:#8b5cf6; font-size:11px;">
                    👨‍⚖️ The 32B model reviewed both opinions and made the final call shown above
                </span>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

/**
 * Extract recommendation type from AI text
 */
function extractRecommendationFromText(text) {
    const upper = text.toUpperCase();
    if (upper.includes('HOLD') || upper.includes('LET POSITION EXPIRE')) return 'HOLD';
    if (upper.includes('ROLL TO') || upper.includes('ROLL -')) return 'ROLL';
    if (upper.includes('CLOSE') || upper.includes('CUT LOSS') || upper.includes('EXIT')) return 'CLOSE';
    return 'REVIEW';
}

/**
 * Save the last AI insight as the opening thesis for the current position
 */
function saveAsThesis() {
    const data = window._lastAIInsight;
    if (!data || !data.positionId) {
        showNotification('❌ No position loaded - click 📊 Analyze on a position first', 'error');
        return;
    }
    
    // Find the position
    const pos = state.positions.find(p => p.id === data.positionId);
    if (!pos) {
        showNotification('❌ Position not found', 'error');
        return;
    }
    
    // Extract recommendation from insight
    const recommendation = extractRecommendationFromText(data.insight);
    
    // Map to standard recommendation types
    let standardRec = recommendation;
    const upper = data.insight.toUpperCase();
    if (upper.includes('ROLL TO') || upper.includes('ROLL -') || upper.includes('$') && upper.includes('CREDIT')) {
        standardRec = 'ROLL';
    } else if (upper.includes('LET') && (upper.includes('CALL') || upper.includes('ASSIGN') || upper.includes('EXPIRE'))) {
        standardRec = 'LET CALL';
    } else if (upper.includes('BUY BACK') || upper.includes('CLOSE')) {
        standardRec = 'BUY BACK';
    }
    
    // Create the openingThesis structure
    pos.openingThesis = {
        analyzedAt: new Date().toISOString(),
        priceAtAnalysis: data.spot,
        iv: data.iv,
        modelUsed: data.model,
        recommendation: standardRec,  // Store the standard recommendation
        aiSummary: {
            fullAnalysis: data.insight,
            bottomLine: recommendation || 'See full analysis',
            probability: data.winProbability
        },
        snapshot: {
            spot: data.spot,
            strike: data.strike,
            dte: data.dte,
            iv: data.iv,
            riskPercent: data.riskPercent,
            winProbability: data.winProbability
        }
    };
    
    // ═══ SYNC TO HOLDING (for covered calls) ═══
    // If this is a covered call and we have a linked holding, update its savedStrategy too
    if (pos.type === 'covered_call' || pos.type?.includes('call')) {
        const holding = (state.holdings || []).find(h => h.ticker === pos.ticker);
        if (holding) {
            const oldStrategy = holding.savedStrategy?.recommendation;
            
            // Update the holding's savedStrategy to match
            holding.savedStrategy = {
                recommendation: standardRec,
                fullAnalysis: data.insight,
                savedAt: new Date().toISOString(),
                model: data.model,
                snapshot: {
                    spot: data.spot,
                    strike: data.strike,
                    dte: data.dte,
                    iv: data.iv
                }
            };
            
            // Save holdings
            localStorage.setItem('wheelhouse_holdings', JSON.stringify(state.holdings));
            
            // Notify if strategy changed
            if (oldStrategy && oldStrategy !== standardRec) {
                showNotification(`⚠️ Strategy changed: ${oldStrategy} → ${standardRec}`, 'info');
            }
            
            console.log(`[Thesis] Synced to ${pos.ticker} holding: ${standardRec}`);
        }
    }
    
    // Save to localStorage
    if (window.savePositionsToStorage) {
        window.savePositionsToStorage();
    } else {
        // Fallback: save directly
        localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    }
    
    showNotification(`✅ Thesis saved to ${pos.ticker} $${pos.strike} - 🩺 Checkup now available!`, 'success');
    
    // Update the button to show "Update" instead of "Save"
    const contentEl = document.getElementById('aiInsightContent');
    if (contentEl) {
        const saveBtn = contentEl.querySelector('button[onclick="window.saveAsThesis()"]');
        if (saveBtn) {
            saveBtn.innerHTML = '✅ Saved!';
            saveBtn.style.background = 'rgba(0,255,136,0.4)';
            setTimeout(() => {
                saveBtn.innerHTML = '💾 Update Thesis';
                saveBtn.style.background = 'rgba(0,255,136,0.2)';
            }, 2000);
        }
    }
    
    // Refresh positions table to show the 📋 indicator
    if (window.renderPositions) {
        window.renderPositions();
    }
}

// Make available globally
window.showAnalysisHistory = showAnalysisHistory;
window.showMoeOpinions = showMoeOpinions;
window.saveAsThesis = saveAsThesis;

// Make globally accessible
window.getAIInsight = getAIInsight;
