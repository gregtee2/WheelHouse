// WheelHouse - Analysis Module
// Recommendations, EV calculations, Roll calculator

import { state } from './state.js';
import { getPositionType } from './pricing.js';
import { randomNormal, showNotification } from './utils.js';
import { formatPortfolioContextForAI } from './portfolio.js';
import AccountService from './services/AccountService.js';
import { fetchRealIV } from './api.js';

/**
 * Get chain history and calculate total premium for a position
 * @param {number} positionId - ID of the current position
 * @returns {Object} { chainHistory, totalPremiumCollected }
 */
export function getChainData(positionId) {
    if (!positionId) return { chainHistory: [], totalPremiumCollected: 0 };
    
    // Find the current position to get its chainId
    const currentPos = state.positions?.find(p => p.id === positionId);
    if (!currentPos) return { chainHistory: [], totalPremiumCollected: 0 };
    
    const chainId = currentPos.chainId || currentPos.id;
    
    // Find all positions in this chain (open + closed)
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    const chainPositions = allPositions
        .filter(p => (p.chainId || p.id) === chainId)
        .sort((a, b) => new Date(a.openDate || 0) - new Date(b.openDate || 0));
    
    if (chainPositions.length <= 1) {
        // No roll history - just the current position
        return { chainHistory: [], totalPremiumCollected: currentPos.premium * 100 * (currentPos.contracts || 1) };
    }
    
    // Calculate NET total: premium received MINUS cost to close (for rolled positions)
    let totalReceived = 0;
    let totalClosingCosts = 0;
    
    chainPositions.forEach(p => {
        const premiumReceived = (p.premium || 0) * 100 * (p.contracts || 1);
        totalReceived += premiumReceived;
        
        if (p.status === 'closed' && p.closePrice !== undefined && p.closePrice > 0) {
            const closingCost = p.closePrice * 100 * (p.contracts || 1);
            totalClosingCosts += closingCost;
        }
    });
    
    const totalPremiumCollected = totalReceived - totalClosingCosts;
    
    // Return simplified chain history for prompt
    const chainHistory = chainPositions.map(p => ({
        openDate: p.openDate,
        strike: p.strike,
        type: p.type,
        premium: p.premium,
        contracts: p.contracts,
        expiry: p.expiry,
        status: p.status,
        closePrice: p.closePrice,
        closeReason: p.closeReason
    }));
    
    return { chainHistory, totalPremiumCollected };
}

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
    
    // For LONG options, thresholds should be different:
    // - Long options have capped downside (premium) and uncapped upside
    // - 50% ITM probability with good reward:risk is actually reasonable
    // - We should consider reward:risk ratio, not just probability
    const safeThreshold = isLong ? 40 : 30;      // Long: 40% OTM risk is safe, Short: 30%
    const watchThreshold = isLong ? 55 : 40;     // Long: 55%, Short: 40%
    const cautionThreshold = isLong ? 70 : 50;   // Long: 70%, Short: 50%
    const dangerThreshold = isLong ? 80 : 60;    // Long: 80%, Short: 60%
    
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
            recTip.textContent = `💡 Click "Suggest Roll" below for real strikes from CBOE chain.`;
        } else {
            recReason.innerHTML = `<b>Why:</b> ${riskPct.toFixed(0)}% chance of losing shares.`;
            recTip.textContent = `💡 Click "Suggest Roll" below for real strikes from CBOE chain.`;
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
            recTip.textContent = `💡 Action: Close this strike TODAY. Click "Suggest Roll" for real CBOE options.`;
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
    const isLong = posType.isLong;
    
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
        if (isLong) {
            // LONG options - you PAID premium, profit from price movement
            if (isPut) {
                // Long put: profit when price < strike
                const intrinsic = Math.max(0, state.strike - price);
                pnl = (intrinsic - premium) * 100;
            } else {
                // Long call: profit when price > strike
                const intrinsic = Math.max(0, price - state.strike);
                pnl = (intrinsic - premium) * 100;
            }
        } else {
            // SHORT options - you RECEIVED premium, risk from price movement
            if (isPut) {
                // Short put: profit when price >= strike, loss when price < strike
                pnl = (price >= state.strike) ? premium * 100 : (premium - (state.strike - price)) * 100;
            } else {
                // Short call: profit when price <= strike, loss when price > strike
                pnl = (price <= state.strike) ? premium * 100 : (premium - (price - state.strike)) * 100;
            }
        }
        totalPnL += pnl * contracts;
    });
    
    const expectedValue = totalPnL / state.optionResults.finalPrices.length;
    
    const expectedValueEl = document.getElementById('expectedValue');
    if (expectedValueEl) {
        expectedValueEl.textContent = `$${expectedValue.toFixed(2)}`;
        expectedValueEl.style.color = expectedValue >= 0 ? '#6b9b7a' : '#b87a75';
    }
    
    calculateIsItWorthIt(expectedValue, isPut, premium, contracts, isLong);
}

/**
 * Calculate "Is It Worth It?" metrics
 * Now supports both SHORT and LONG options with different calculations
 */
function calculateIsItWorthIt(expectedValue, isPut, premium, contracts, isLong = false) {
    const worthItBox = document.getElementById('worthItBox');
    if (worthItBox) worthItBox.style.display = 'block';
    
    // Show cost basis box for covered calls
    const costBasisBox = document.getElementById('costBasisBox');
    const costBasisValue = document.getElementById('costBasisValue');
    const gainIfCalledValue = document.getElementById('gainIfCalledValue');
    
    const costBasis = state.currentPositionContext?.costBasis || state.currentPositionContext?.holdingCostBasis;
    const posType = getPositionType();
    
    // Show for any CALL position (not put) that has a cost basis (covered calls)
    if (costBasisBox && costBasis && !isPut && !isLong) {
        costBasisBox.style.display = 'block';
        costBasisValue.textContent = '$' + costBasis.toFixed(2);
        
        // Calculate gain if called: (Strike - Cost Basis + Premium) × 100 × contracts
        const gainIfCalled = (state.strike - costBasis + premium) * 100 * contracts;
        const gainPerShare = state.strike - costBasis + premium;
        const gainPct = ((gainPerShare / costBasis) * 100).toFixed(1);
        
        if (gainIfCalled >= 0) {
            gainIfCalledValue.textContent = `+$${gainIfCalled.toFixed(0)} (${gainPct}%)`;
            gainIfCalledValue.style.color = '#6b9b7a';
        } else {
            gainIfCalledValue.textContent = `-$${Math.abs(gainIfCalled).toFixed(0)} (${gainPct}%)`;
            gainIfCalledValue.style.color = '#b87a75';
        }
    } else if (costBasisBox) {
        costBasisBox.style.display = 'none';
    }
    
    // Update display - helper function
    function setEl(id, text, colorFn) {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
            if (colorFn) el.style.color = colorFn();
        }
    }
    
    if (isLong) {
        // ===================== LONG OPTION METRICS =====================
        // For LONG options, you PAY premium upfront
        // Risk = Premium paid (max loss if expires worthless)
        // Reward = Unlimited (call) or Strike - Premium (put)
        
        const maxRisk = premium * 100 * contracts;
        const capitalInvested = maxRisk; // Premium is the capital at risk
        
        // Win = expires in the money with profit
        // For long call: win = price > strike + premium (breakeven)
        // For long put: win = price < strike - premium (breakeven)
        const breakeven = isPut ? state.strike - premium : state.strike + premium;
        
        // Calculate win rate for LONG options (needs to exceed breakeven to profit)
        let winCount = 0;
        let totalProfit = 0;
        let lossCount = 0;
        let totalLoss = 0;
        
        state.optionResults.finalPrices.forEach(price => {
            if (isPut) {
                const intrinsic = Math.max(0, state.strike - price);
                const pnl = intrinsic - premium;
                if (pnl > 0) {
                    winCount++;
                    totalProfit += pnl * 100;
                } else {
                    lossCount++;
                    totalLoss += Math.abs(pnl) * 100;
                }
            } else {
                const intrinsic = Math.max(0, price - state.strike);
                const pnl = intrinsic - premium;
                if (pnl > 0) {
                    winCount++;
                    totalProfit += pnl * 100;
                } else {
                    lossCount++;
                    totalLoss += Math.abs(pnl) * 100;
                }
            }
        });
        
        const totalPaths = state.optionResults.finalPrices.length;
        const winPct = (winCount / totalPaths) * 100;
        const avgWin = winCount > 0 ? (totalProfit / winCount) * contracts : 0;
        const avgLoss = lossCount > 0 ? (totalLoss / lossCount) * contracts : maxRisk;
        
        // Expected profit if winning
        const expectedProfit = avgWin;
        // ROC for long options = Expected Profit / Premium Paid (if you win)
        const rocIfWin = capitalInvested > 0 ? (avgWin / capitalInvested) * 100 : 0;
        // Annualized ROC
        const annualizedRoc = rocIfWin * (365 / state.dte);
        
        // Risk:Reward for LONG options = Max Risk : Expected Profit
        // Displayed as Reward:Risk (how much you can make per $ risked)
        const rewardRiskRatio = avgWin > 0 ? (avgWin / maxRisk).toFixed(1) + ':1' : '0:1';
        
        // For long options, required win rate is based on risk/reward
        // If you risk $100 to make $300 (3:1 reward), you need to win >25% to break even
        const requiredWinRate = avgWin > 0 ? (maxRisk / (avgWin + maxRisk)) * 100 : 50;
        
        const yourEdge = winPct - requiredWinRate;
        
        // Kelly Criterion for long options
        const b = avgWin / maxRisk; // odds ratio
        const p = winPct / 100;
        const q = 1 - p;
        let kellyPct = b > 0 ? ((b * p - q) / b) * 100 : 0;
        kellyPct = Math.max(0, Math.min(kellyPct, 100));
        
        // Update labels for long options context
        setEl('rocDisplay', rocIfWin.toFixed(1) + '%', () => rocIfWin >= 100 ? '#6b9b7a' : rocIfWin >= 50 ? '#7ba3b0' : '#a89060');
        setEl('annRocDisplay', annualizedRoc.toFixed(0) + '%', () => annualizedRoc >= 100 ? '#6b9b7a' : annualizedRoc >= 50 ? '#7ba3b0' : '#a89060');
        
        setEl('riskRewardRatio', rewardRiskRatio, () => {
            const ratio = parseFloat(rewardRiskRatio);
            return ratio >= 2 ? '#6b9b7a' : ratio >= 1 ? '#7ba3b0' : '#a89060';
        });
        
        setEl('winProbability', winPct.toFixed(1) + '%', () => winPct > 50 ? '#6b9b7a' : winPct > 30 ? '#a89060' : '#b87a75');
        setEl('requiredWinRate', requiredWinRate.toFixed(1) + '%');
        setEl('yourEdge', (yourEdge > 0 ? '+' : '') + yourEdge.toFixed(1) + '%', () => yourEdge > 0 ? '#6b9b7a' : '#b87a75');
        setEl('kellyPct', kellyPct.toFixed(1) + '%', () => kellyPct > 0 ? '#6b9b7a' : '#b87a75');
        
        // For long options, show breakeven and max risk instead of assignment metrics
        setEl('avgIfAssigned', `$${breakeven.toFixed(2)}`, () => '#7ba3b0');
        setEl('expectedLoss', `-$${maxRisk.toFixed(0)}`, () => '#b87a75');
        
        // Update labels to be more accurate for long options
        // Labels are <span class="result-label"> before the value spans
        const avgValueEl = document.getElementById('avgIfAssigned');
        const lossValueEl = document.getElementById('expectedLoss');
        if (avgValueEl?.previousElementSibling) avgValueEl.previousElementSibling.textContent = 'Breakeven:';
        if (lossValueEl?.previousElementSibling) lossValueEl.previousElementSibling.textContent = 'Max Risk:';
        
        // Calculate "margin" for long options - just the debit paid
        calculateMarginImpactLong(premium, contracts, isPut);
        
    } else {
        // ===================== SHORT OPTION METRICS =====================
        // Original logic for short puts, covered calls, etc.
        
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
        
        // Restore labels for short options
        const avgValueEl = document.getElementById('avgIfAssigned');
        const lossValueEl = document.getElementById('expectedLoss');
        if (avgValueEl?.previousElementSibling) avgValueEl.previousElementSibling.textContent = 'Avg if Assigned:';
        if (lossValueEl?.previousElementSibling) lossValueEl.previousElementSibling.textContent = 'Expected Loss:';
        
        setEl('rocDisplay', roc.toFixed(2) + '%', () => roc >= 2 ? '#6b9b7a' : roc >= 1 ? '#7ba3b0' : '#a89060');
        setEl('annRocDisplay', annualizedRoc.toFixed(0) + '%', () => annualizedRoc >= 30 ? '#6b9b7a' : annualizedRoc >= 15 ? '#7ba3b0' : '#a89060');
        
        const rrValue = parseFloat(realisticRiskReward.split(':')[0]);
        setEl('riskRewardRatio', realisticRiskReward, () => 
            rrValue === Infinity ? '#b87a75' : (rrValue < 5 ? '#6b9b7a' : rrValue < 20 ? '#a89060' : '#b87a75'));
        
        setEl('winProbability', winPct.toFixed(1) + '%', () => winPct > 70 ? '#6b9b7a' : winPct > 50 ? '#a89060' : '#b87a75');
        setEl('requiredWinRate', requiredWinRate.toFixed(1) + '%');
        setEl('yourEdge', (yourEdge > 0 ? '+' : '') + yourEdge.toFixed(1) + '%', () => yourEdge > 0 ? '#6b9b7a' : '#b87a75');
        setEl('kellyPct', kellyPct.toFixed(1) + '%', () => kellyPct > 0 ? '#6b9b7a' : '#b87a75');
        setEl('avgIfAssigned', assignedCount > 0 ? `$${avgPriceIfAssigned.toFixed(2)}` : 'N/A');
        setEl('expectedLoss', expectedLossIfAssigned > 0 ? `-$${expectedLossIfAssigned.toFixed(0)}` : '$0');
        
        // Calculate margin impact for short options (puts and naked calls)
        calculateMarginImpact(state.spot, state.strike, premium, contracts, isPut);
    }
}

/**
 * Calculate "margin" display for long options (just shows debit cost)
 */
async function calculateMarginImpactLong(premium, contracts, isPut) {
    const marginBox = document.getElementById('marginImpactBox');
    if (!marginBox) return;
    
    const debitPaid = premium * 100 * contracts;
    const marginType = isPut ? 'Long Put' : 'Long Call';
    
    // Update the option type label
    const typeLabel = document.getElementById('marginOptionType');
    if (typeLabel) typeLabel.textContent = `(${marginType})`;
    
    // Hide covered call note for long options
    const coveredNote = document.getElementById('marginCoveredNote');
    if (coveredNote) coveredNote.style.display = 'none';
    
    // Get buying power from AccountService (single source of truth)
    let buyingPower = AccountService.getBuyingPower();
    if (!buyingPower) {
        await AccountService.refresh();
        buyingPower = AccountService.getBuyingPower();
    }
    
    // Format helper
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    // Update display - for long options, show "Cost" instead of "Margin Required"
    document.getElementById('marginRequired').textContent = fmt(debitPaid);
    
    // Update the label to say "Debit Cost" instead of "Margin Required"
    const marginLabel = document.querySelector('label[for="marginRequired"]');
    if (marginLabel) marginLabel.textContent = 'Debit Cost:';
    
    if (buyingPower !== null) {
        const afterTrade = buyingPower - debitPaid;
        const utilization = (debitPaid / buyingPower) * 100;
        
        document.getElementById('marginBuyingPower').textContent = fmt(buyingPower);
        document.getElementById('marginBuyingPower').style.color = '#7ba3b0';
        
        document.getElementById('marginAfterTrade').textContent = fmt(afterTrade);
        document.getElementById('marginAfterTrade').style.color = afterTrade > 0 ? '#6b9b7a' : '#b87a75';
        
        document.getElementById('marginUtilization').textContent = utilization.toFixed(1) + '%';
        document.getElementById('marginUtilization').style.color = utilization < 25 ? '#6b9b7a' : utilization < 50 ? '#a89060' : '#b87a75';
        
        // Verdict for long options
        const verdictEl = document.getElementById('marginVerdict');
        if (afterTrade < 0) {
            verdictEl.innerHTML = `⚠️ <b>INSUFFICIENT FUNDS</b> - Need $${fmt(Math.abs(afterTrade))} more`;
            verdictEl.className = 'margin-verdict high-risk';
        } else if (utilization > 50) {
            verdictEl.innerHTML = `⚠️ <b>HIGH ALLOCATION</b> - This uses ${utilization.toFixed(0)}% of your buying power`;
            verdictEl.className = 'margin-verdict high-risk';
        } else {
            verdictEl.innerHTML = `✅ Affordable - ${utilization.toFixed(0)}% of buying power`;
            verdictEl.className = 'margin-verdict';
            verdictEl.style.display = 'none'; // Hide if no issues
        }
        verdictEl.style.display = afterTrade < 0 || utilization > 50 ? 'block' : 'none';
    } else {
        document.getElementById('marginBuyingPower').textContent = 'N/A';
        document.getElementById('marginAfterTrade').textContent = 'N/A';
        document.getElementById('marginUtilization').textContent = 'N/A';
    }
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
    
    // Get buying power from AccountService (single source of truth)
    let buyingPower = AccountService.getBuyingPower();
    if (!buyingPower) {
        await AccountService.refresh();
        buyingPower = AccountService.getBuyingPower();
    }
    
    // Format helper
    const fmt = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    
    // Update display
    document.getElementById('marginRequired').textContent = fmt(totalMarginRequired);
    
    if (buyingPower !== null) {
        const afterTrade = buyingPower - totalMarginRequired;
        const utilization = (totalMarginRequired / buyingPower) * 100;
        
        document.getElementById('marginBuyingPower').textContent = fmt(buyingPower);
        document.getElementById('marginBuyingPower').style.color = '#7ba3b0';
        
        document.getElementById('marginAfterTrade').textContent = fmt(afterTrade);
        document.getElementById('marginAfterTrade').style.color = afterTrade > 0 ? '#6b9b7a' : '#b87a75';
        
        document.getElementById('marginUtilization').textContent = utilization.toFixed(1) + '%';
        document.getElementById('marginUtilization').style.color = utilization < 25 ? '#6b9b7a' : utilization < 50 ? '#a89060' : '#b87a75';
        
        // Verdict
        const verdictEl = document.getElementById('marginVerdict');
        if (afterTrade < 0) {
            verdictEl.innerHTML = '❌ <strong>INSUFFICIENT MARGIN</strong> - You need $' + fmt(Math.abs(afterTrade)).replace('$','') + ' more buying power';
            verdictEl.style.background = 'rgba(184,122,117,0.2)';
            verdictEl.style.color = '#b87a75';
        } else if (utilization > 50) {
            verdictEl.innerHTML = '⚠️ <strong>HIGH UTILIZATION</strong> - This uses ' + utilization.toFixed(0) + '% of your buying power';
            verdictEl.style.background = 'rgba(168,144,96,0.2)';
            verdictEl.style.color = '#a89060';
        } else if (utilization > 25) {
            verdictEl.innerHTML = '✓ <strong>OK</strong> - Uses ' + utilization.toFixed(0) + '% of buying power';
            verdictEl.style.background = 'rgba(123,163,176,0.2)';
            verdictEl.style.color = '#7ba3b0';
        } else {
            verdictEl.innerHTML = '✅ <strong>LOW IMPACT</strong> - Only uses ' + utilization.toFixed(0) + '% of buying power';
            verdictEl.style.background = 'rgba(107,155,122,0.2)';
            verdictEl.style.color = '#6b9b7a';
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
 * Calculate roll scenario - now uses real IV from CBOE!
 */
export async function calculateRoll() {
    const currentStrike = state.strike;
    const currentDte = state.dte;
    
    // Determine if this is a call or put position
    const posType = state.currentPositionContext?.type || '';
    const isBuyWrite = posType === 'buy_write';
    const isCoveredCall = posType === 'covered_call' || isBuyWrite;
    const isCall = isCoveredCall || posType.includes('call');
    
    // Fetch real IV from CBOE for accurate Monte Carlo simulation
    const ticker = state.currentPositionContext?.ticker;
    let realIV = state.optVol; // Fallback to slider value
    let ivSource = 'slider';
    
    if (ticker) {
        try {
            const ivResult = await fetchRealIV(ticker);
            if (ivResult.iv) {
                realIV = ivResult.iv;
                ivSource = ivResult.source;
                console.log(`[ROLL] Using real IV for ${ticker}: ${(realIV * 100).toFixed(1)}% (${ivSource})`);
            }
        } catch (e) {
            console.warn('[ROLL] Could not fetch real IV, using slider value');
        }
    }
    
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
            // Use realIV instead of state.optVol for accurate simulation!
            S *= Math.exp((state.rate - 0.5*realIV*realIV)*dt + realIV*dW);
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
    
    // Show new risk with IV source in tooltip
    const riskEl = document.getElementById('rollNewRisk');
    if (riskEl) {
        riskEl.textContent = newRisk.toFixed(1) + '%';
        riskEl.title = `Monte Carlo simulation using IV: ${(realIV * 100).toFixed(1)}% (${ivSource})`;
    }
    
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
        comparison += `💸 Net DEBIT: <span style="color:#b87a75;">-$${totalDebitAmount.toFixed(0)}</span> (you pay)<br>`;
    } else {
        comparison += `💰 Net credit: <span style="color:#6b9b7a;">+$${totalRollCredit.toFixed(0)}</span> (you receive)<br>`;
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
            netDisplay = `<span style="color:#b87a75;">$${Math.abs(totalRollNet).toFixed(0)} deb</span>`;
        } else if (totalRollNet > 0) {
            netDisplay = `<span style="color:#6b9b7a;">$${totalRollNet.toFixed(0)} cr</span>`;
        } else {
            netDisplay = '<span style="color:#888;">$0</span>';
        }
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `
            <div style="padding:8px; background:rgba(0,0,0,0.3); border-radius:4px; cursor:pointer; border:1px solid rgba(255,255,255,0.1);"
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="color:#7ba3b0; font-weight:bold;">$${c.strike}</span>
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
 * Populate the Roll Calculator strike dropdown with available strikes from chain
 */
function populateRollStrikeDropdown(optionChain, currentStrike, isCall, spotPrice) {
    const strikeSelect = document.getElementById('rollNewStrike');
    if (!strikeSelect) return;
    
    // Get unique strikes
    const strikes = [...new Set(optionChain.map(o => o.strike))].sort((a, b) => {
        // For calls, sort ascending (roll UP); for puts, sort descending (roll DOWN)
        return isCall ? a - b : b - a;
    });
    
    // Filter to reasonable range around current strike
    const filteredStrikes = strikes.filter(s => {
        if (isCall) {
            // Calls: same or higher, up to 30% above spot
            return s >= currentStrike && s <= spotPrice * 1.3;
        } else {
            // Puts: same or lower, down to 70% of spot
            return s <= currentStrike && s >= spotPrice * 0.7;
        }
    });
    
    // Build options HTML with delta
    const optionsHtml = filteredStrikes.slice(0, 20).map(s => {
        // Find an option at this strike (any expiry) to get delta
        const opt = optionChain.find(o => Math.abs(o.strike - s) < 0.01);
        let info = '';
        if (opt) {
            const bid = opt.bid?.toFixed(2) || '?';
            const delta = opt.delta ? Math.abs(opt.delta).toFixed(2) : null;
            info = delta ? ` ($${bid} | Δ${delta})` : ` ($${bid})`;
        }
        const selected = Math.abs(s - currentStrike) < 0.01 ? 'selected' : '';
        return `<option value="${s}" ${selected}>$${s}${info}</option>`;
    }).join('');
    
    strikeSelect.innerHTML = optionsHtml || '<option>No strikes</option>';
}

/**
 * Show IV summary bar in Roll Calculator
 */
function showRollIvSummary(optionChain, currentStrike) {
    const summaryEl = document.getElementById('rollIvSummary');
    const ivDisplay = document.getElementById('rollIvDisplay');
    const ivContext = document.getElementById('rollIvContext');
    
    if (!summaryEl || !ivDisplay) return;
    
    // Find option at current strike to get IV
    const opt = optionChain.find(o => Math.abs(o.strike - currentStrike) < 0.01);
    const iv = opt?.impliedVolatility || 0;
    
    if (iv > 0) {
        const ivPct = (iv * 100).toFixed(0);
        // Color code: <30% blue (low), 30-50% white (normal), >50% orange (high)
        const ivColor = iv < 0.30 ? '#00d9ff' : iv > 0.50 ? '#ffaa00' : '#fff';
        ivDisplay.style.color = ivColor;
        ivDisplay.textContent = `${ivPct}%`;
        
        // Context text
        if (ivContext) {
            if (iv < 0.25) ivContext.textContent = '(Low - thin premiums)';
            else if (iv < 0.35) ivContext.textContent = '(Normal)';
            else if (iv < 0.50) ivContext.textContent = '(Elevated)';
            else ivContext.textContent = '(High - fat premiums!)';
        }
        
        summaryEl.style.display = 'block';
    } else {
        summaryEl.style.display = 'none';
    }
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
    
    // Get current risk from displayed value or position context
    // The optLower element might show "—" which parses as NaN
    const optLowerEl = document.getElementById('optLower');
    let currentRisk = parseFloat(optLowerEl?.textContent?.replace('%',''));
    if (isNaN(currentRisk)) {
        // Use position context if available, otherwise estimate from delta or default to 50%
        currentRisk = state.currentPositionContext?.risk || 50;
    }
    
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
        listEl.innerHTML = `<div style="color:#b87a75;">❌ Could not fetch options chain: ${e.message}</div>`;
        return;
    }
    
    // Use calls for Buy/Write and covered calls, puts for short puts
    const optionChain = isCallPosition ? chain.calls : chain.puts;
    const optionType = isCallPosition ? 'call' : 'put';
    
    if (!optionChain || optionChain.length === 0) {
        listEl.innerHTML = `<div style="color:#b87a75;">❌ No ${optionType} options found for this ticker</div>`;
        return;
    }
    
    // Populate the strike dropdown with available strikes + delta
    populateRollStrikeDropdown(optionChain, currentStrike, isCallPosition, chain.currentPrice || state.spot);
    
    // Show IV summary bar
    showRollIvSummary(optionChain, currentStrike);
    
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
        listEl.innerHTML = `<div style="color:#a89060;">⚠️ No ${direction} strikes available in options chain.</div>`;
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
                <div style="color:#a89060; padding:10px; background:rgba(168,144,96,0.1); border-radius:6px;">
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
    html += `<div style="font-size:12px; color:#aaa; margin-bottom:10px; padding:8px; background:rgba(184,122,117,0.15); border-radius:4px; border:1px solid rgba(184,122,117,0.3);">
        💰 Close <b>$${currentStrike.toFixed(0)}</b> ${optionLabel}: <span style="color:#b87a75; font-weight:bold;">$${totalCostToClose.toFixed(0)}</span>
        <span style="color:#888; font-size:11px;">(${contracts} × $${(currentAsk * 100).toFixed(0)})</span>
    </div>`;
    
    // Helper to render a candidate row - COMPACT for 2-column grid
    const renderCandidate = (c, i, emoji) => {
        const riskColor = c.riskChange > 0 ? '#6b9b7a' : '#b87a75';
        const riskIcon = c.riskChange > 0 ? '↓' : '↑';
        
        const totalRollNet = c.rollNetPerContract * contracts;
        const isDebit = totalRollNet < 0;
        
        let netDisplay;
        if (isDebit) {
            netDisplay = `<span style="color:#b87a75; font-weight:bold;">$${Math.abs(totalRollNet).toFixed(0)} deb</span>`;
        } else if (totalRollNet > 0) {
            netDisplay = `<span style="color:#6b9b7a; font-weight:bold;">$${totalRollNet.toFixed(0)} cr</span>`;
        } else {
            netDisplay = '<span style="color:#888;">—</span>';
        }
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        // Format Greeks - compact
        const deltaDisplay = c.delta ? `Δ${c.delta.toFixed(2)}` : '';
        const ivDisplay = c.iv ? `IV${(c.iv * 100).toFixed(0)}%` : '';
        const greeksLine = [deltaDisplay, ivDisplay].filter(Boolean).join(' ');
        
        // Prepare stage button data
        const stageData = JSON.stringify({
            ticker,
            strike: c.strike,
            expiry: c.expiration,
            premium: c.newBidPerShare,
            currentPrice: spot,
            delta: c.delta,
            iv: c.iv,
            isCall: c.isCall
        }).replace(/"/g, '&quot;');
        
        return `
            <div style="padding:6px 8px; background:rgba(0,0,0,0.4); border-radius:4px; border:1px solid rgba(255,255,255,0.1);">
                <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; cursor:pointer;"
                     onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})"
                     onmouseover="this.parentElement.style.borderColor='rgba(123,163,176,0.5)'" 
                     onmouseout="this.parentElement.style.borderColor='rgba(255,255,255,0.1)'">
                    <span>${emoji} <b>$${c.strike.toFixed(0)}</b></span>
                    <span style="color:${riskColor}; font-size:11px;">${riskIcon}${Math.abs(c.riskChange).toFixed(0)}% risk</span>
                </div>
                <div style="color:#aaa; font-size:11px; margin-top:3px;">
                    ${expFormatted} · ${netDisplay}
                </div>
                ${greeksLine ? `<div style="font-size:10px; color:#7a8a94; margin-top:2px;">${greeksLine}</div>` : ''}
                <button onclick="event.stopPropagation(); window.stageRollSuggestion(${stageData})" 
                    style="margin-top:5px; width:100%; padding:4px; background:rgba(123,163,176,0.2); border:1px solid rgba(123,163,176,0.4); 
                           color:#7ba3b0; border-radius:3px; cursor:pointer; font-size:10px;"
                    title="Stage this roll to Ideas tab">
                    📥 Stage to Ideas
                </button>
            </div>
        `;
    };
    
    // Best suggestions section - 2-column grid
    // For puts: "Best Risk Reduction" (lower strikes)
    // For calls: "Best Roll Up" (higher strikes = more upside)
    if (top3.length > 0) {
        const sectionTitle = isCallPosition ? '📈 Best Roll Up' : '📉 Best Risk Reduction';
        html += `<div style="font-size:12px; color:#7ba3b0; margin-bottom:6px; font-weight:bold;">${sectionTitle}</div>`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">`;
        top3.forEach((c, i) => {
            const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
            html += renderCandidate(c, i, emoji);
        });
        html += `</div>`;
    }
    
    // Credit Rolls section - 2-column grid
    if (creditRolls.length > 0) {
        html += `<div style="font-size:12px; color:#6b9b7a; margin:8px 0 6px 0; font-weight:bold;">💵 Credit Rolls</div>`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">`;
        creditRolls.forEach((c, i) => {
            html += renderCandidate(c, i, '💰');
        });
        html += `</div>`;
    } else {
        // No credit rolls found - offer to search further out
        html += `<div style="font-size:11px; color:#aaa; margin-top:8px; padding:8px; background:rgba(168,144,96,0.1); border-radius:4px;">
            ⚠️ No credit rolls nearby.
            <button onclick="window.findCreditRolls()" 
                    style="display:block; margin-top:6px; background:#6b9b7a; border:none; color:#000; padding:6px 12px; 
                           border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; width:100%;">
                🔍 Search Further Out
            </button>
        </div>`;
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // ALTERNATIVE STRATEGIES SECTION - Think beyond rolling!
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Only show for covered calls that are ITM (stock above strike)
    if ((isCoveredCall || isBuyWrite) && spot > currentStrike) {
        const costBasis = state.currentPositionContext?.costBasis || state.currentPositionContext?.stockPrice || currentStrike;
        const premium = state.currentPositionContext?.premium || 0;
        const totalPremiumCollected = premium * 100 * contracts;
        const stockGain = (currentStrike - costBasis) * 100 * contracts;
        const assignmentProfit = stockGain + totalPremiumCollected;
        
        // Find REAL options from the chain for alternatives
        const skipCallStrike = Math.ceil(spot / 5) * 5;  // Round up to nearest $5
        const spreadUpperStrike = skipCallStrike + 5;
        const putStrike = Math.floor((spot * 0.9) / 5) * 5;  // 10% below spot, rounded
        
        // Find target expiration 60-90 DTE (good for buying calls - enough time for thesis to play out)
        const today = new Date();
        const targetDte = 75;  // ~2.5 months out - sweet spot for long calls
        const targetExpDate = new Date(today.getTime() + targetDte * 24 * 60 * 60 * 1000);
        
        // Find best matching expiration from chain (60-120 DTE range for long calls)
        let bestExpiry = chain.expirations?.find(exp => {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            return dte >= 60 && dte <= 120;  // 60-120 DTE range for long calls
        }) || chain.expirations?.find(exp => {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            return dte >= 45;  // Fallback: at least 45 DTE
        }) || chain.expirations?.[3];  // Last fallback to 4th expiration
        
        // === SKIP™ STRATEGY OPTIONS ===
        // LEAPS = 12+ months out (365+ DTE)
        // SKIP call = 3-9 months out (90-270 DTE), higher strike
        let leapsExpiry = chain.expirations?.find(exp => {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            return dte >= 365;  // 12+ months
        });
        let skipExpiry = chain.expirations?.find(exp => {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            return dte >= 120 && dte <= 270;  // 3-9 months (skip call has shorter term)
        }) || chain.expirations?.find(exp => {
            const expDate = new Date(exp);
            const dte = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
            return dte >= 90;  // Fallback: at least 90 DTE
        });
        
        // LEAPS strike = ATM or slightly OTM (at the money for maximum delta)
        const leapsStrike = Math.round(spot / 5) * 5;  // Round to nearest $5
        // SKIP call strike = above spot, catching further upside
        const skipStrike = Math.ceil(spot * 1.05 / 5) * 5;  // 5% above spot, rounded to $5
        
        let leapsOption = leapsExpiry ? chain.calls?.find(c => 
            c.strike === leapsStrike && c.expiration === leapsExpiry
        ) || chain.calls?.find(c => 
            Math.abs(c.strike - leapsStrike) <= 2.5 && c.expiration === leapsExpiry
        ) : null;
        
        let skipCallOption = skipExpiry ? chain.calls?.find(c => 
            c.strike === skipStrike && c.expiration === skipExpiry
        ) || chain.calls?.find(c => 
            Math.abs(c.strike - skipStrike) <= 2.5 && c.expiration === skipExpiry
        ) : null;
        
        // Calculate SKIP™ total cost
        const leapsPrice = leapsOption ? (leapsOption.ask || leapsOption.bid * 1.05) : null;
        const skipPrice = skipCallOption ? (skipCallOption.ask || skipCallOption.bid * 1.05) : null;
        const skipTotalCost = (leapsPrice && skipPrice) ? (leapsPrice + skipPrice) * 100 * contracts : null;
        
        // Find long call option in chain (for "Buy Upside Call" strategy)
        let longCallOption = chain.calls?.find(c => 
            c.strike === skipCallStrike && c.expiration === bestExpiry
        ) || chain.calls?.find(c => 
            Math.abs(c.strike - skipCallStrike) <= 2.5 && 
            new Date(c.expiration) > today
        );
        
        // Find spread options
        let spreadBuyOption = chain.calls?.find(c => 
            c.strike === skipCallStrike && c.expiration === bestExpiry
        );
        let spreadSellOption = chain.calls?.find(c => 
            c.strike === spreadUpperStrike && c.expiration === bestExpiry
        );
        
        // Find PUT option for selling
        let sellPutOption = chain.puts?.find(p => 
            p.strike === putStrike && p.expiration === bestExpiry
        ) || chain.puts?.find(p => 
            Math.abs(p.strike - putStrike) <= 2.5 && 
            new Date(p.expiration) > today
        );
        
        // Calculate spread details
        const spreadCost = (spreadBuyOption && spreadSellOption) 
            ? ((spreadBuyOption.ask || spreadBuyOption.bid * 1.05) - (spreadSellOption.bid || spreadSellOption.ask * 0.95))
            : null;
        const spreadMaxProfit = (spreadBuyOption && spreadSellOption)
            ? (spreadUpperStrike - skipCallStrike - spreadCost) * 100 * contracts
            : null;
        
        html += `
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(122,138,148,0.3);">
            <div style="font-size:12px; color:#7a8a94; margin-bottom:8px; font-weight:bold;">
                💡 Alternative Strategies <span style="font-size:10px; color:#888; font-weight:normal;">(Instead of Rolling)</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                
                <!-- LET ASSIGN -->
                <div style="background:rgba(107,155,122,0.15); border:1px solid rgba(107,155,122,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#6b9b7a; font-weight:bold; font-size:12px;">✅ Let Assign</span>
                        <span style="color:#6b9b7a; font-size:11px; font-weight:bold;">+$${assignmentProfit.toFixed(0)}</span>
                    </div>
                    <div style="font-size:10px; color:#ccc; line-height:1.4;">
                        <div>📈 Stock gain: <span style="color:#6b9b7a;">$${stockGain.toFixed(0)}</span> (sell @ $${currentStrike})</div>
                        <div>💵 Premium kept: <span style="color:#6b9b7a;">$${totalPremiumCollected.toFixed(0)}</span></div>
                        <div>🎯 ROI: <span style="color:#6b9b7a;">${((assignmentProfit / (costBasis * 100 * contracts)) * 100).toFixed(1)}%</span> on cost basis</div>
                    </div>
                </div>
                
                <!-- SKIP™ STRATEGY -->
                <div style="background:rgba(168,152,120,0.15); border:1px solid rgba(168,152,120,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#a89878; font-weight:bold; font-size:12px;">⭐ SKIP™</span>
                        <span style="color:#b87a75; font-size:11px; font-weight:bold;">${skipTotalCost ? `-$${skipTotalCost.toFixed(0)}` : 'N/A'}</span>
                    </div>
                    ${(leapsOption && skipCallOption) ? `
                    <div style="font-size:10px; color:#ccc; line-height:1.4;">
                        <div>📋 LEAPS $${leapsOption.strike}c @ <span style="color:#a89878;">$${leapsPrice.toFixed(2)}</span> (${Math.ceil((new Date(leapsExpiry) - today) / (1000*60*60*24))} DTE)</div>
                        <div>📋 SKIP $${skipCallOption.strike}c @ <span style="color:#a89878;">$${skipPrice.toFixed(2)}</span> (${Math.ceil((new Date(skipExpiry) - today) / (1000*60*60*24))} DTE)</div>
                        <div>💡 Exit SKIP at 45-60 DTE, ride LEAPS</div>
                    </div>
                    <button onclick="window.stageSkipStrategy('${ticker}', ${leapsOption.strike}, '${leapsExpiry}', ${leapsPrice.toFixed(2)}, ${skipCallOption.strike}, '${skipExpiry}', ${skipPrice.toFixed(2)}, ${spot})" 
                            style="width:100%; margin-top:6px; background:rgba(168,152,120,0.3); border:1px solid rgba(168,152,120,0.5); color:#a89878; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px; font-weight:bold;">
                        📥 Stage to Ideas
                    </button>
                    ` : leapsOption ? `
                    <div style="font-size:10px; color:#888;">LEAPS available but no SKIP call expiry found</div>
                    ` : `
                    <div style="font-size:10px; color:#888;">No LEAPS (12+ months) available</div>
                    `}
                </div>
                
                <!-- BUY LONG CALL (Upside Participation) -->
                <div style="background:rgba(123,163,176,0.15); border:1px solid rgba(123,163,176,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#7ba3b0; font-weight:bold; font-size:12px;">🚀 Long Call</span>
                        <span style="color:#b87a75; font-size:11px; font-weight:bold;">${longCallOption ? `-$${((longCallOption.ask || longCallOption.bid * 1.05) * 100 * contracts).toFixed(0)}` : 'N/A'}</span>
                    </div>
                    ${longCallOption ? `
                    <div style="font-size:10px; color:#ccc; line-height:1.4;">
                        <div>📋 Buy $${longCallOption.strike} call @ <span style="color:#7ba3b0;">$${(longCallOption.ask || longCallOption.bid * 1.05).toFixed(2)}</span></div>
                        <div>📅 Exp: ${longCallOption.expiration} (${Math.ceil((new Date(longCallOption.expiration) - today) / (1000*60*60*24))} DTE)</div>
                        <div>Δ ${(longCallOption.delta || 0.40).toFixed(2)} | IV ${((longCallOption.iv || 0.65) * 100).toFixed(0)}%</div>
                    </div>
                    <button onclick="window.stageAlternativeStrategy('${ticker}', 'long_call', ${longCallOption.strike}, ${spot}, null, '${longCallOption.expiration}', ${(longCallOption.ask || longCallOption.bid * 1.05).toFixed(2)}, ${longCallOption.delta || 0.40}, ${((longCallOption.iv || 0.65) * 100).toFixed(0)})" 
                            style="width:100%; margin-top:6px; background:rgba(123,163,176,0.3); border:1px solid rgba(123,163,176,0.5); color:#7ba3b0; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px; font-weight:bold;">
                        📥 Stage to Ideas
                    </button>
                    ` : `<div style="font-size:10px; color:#888;">No $${skipCallStrike} calls available</div>`}
                </div>
                
                <!-- CALL SPREAD -->
                <div style="background:rgba(122,138,148,0.15); border:1px solid rgba(122,138,148,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#7a8a94; font-weight:bold; font-size:12px;">📊 Call Spread</span>
                        <span style="color:#b87a75; font-size:11px; font-weight:bold;">${spreadCost ? `-$${(spreadCost * 100 * contracts).toFixed(0)}` : 'N/A'}</span>
                    </div>
                    ${(spreadBuyOption && spreadSellOption) ? `
                    <div style="font-size:10px; color:#ccc; line-height:1.4;">
                        <div>📋 Buy $${skipCallStrike}c / Sell $${spreadUpperStrike}c</div>
                        <div>💰 Max profit: <span style="color:#6b9b7a;">$${spreadMaxProfit.toFixed(0)}</span></div>
                        <div>📅 Exp: ${bestExpiry} | Width: $${spreadUpperStrike - skipCallStrike}</div>
                    </div>
                    <button onclick="window.stageAlternativeStrategy('${ticker}', 'call_spread', ${skipCallStrike}, ${spot}, ${spreadUpperStrike}, '${bestExpiry}', ${spreadCost.toFixed(2)})" 
                            style="width:100%; margin-top:6px; background:rgba(122,138,148,0.3); border:1px solid rgba(122,138,148,0.5); color:#7a8a94; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px; font-weight:bold;">
                        📥 Stage to Ideas
                    </button>
                    ` : `<div style="font-size:10px; color:#888;">Spread not available</div>`}
                </div>
                
                <!-- SELL PUT -->
                <div style="background:rgba(168,144,96,0.15); border:1px solid rgba(168,144,96,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#a89060; font-weight:bold; font-size:12px;">💰 Sell Put</span>
                        <span style="color:#6b9b7a; font-size:11px; font-weight:bold;">${sellPutOption ? `+$${((sellPutOption.bid || sellPutOption.ask * 0.95) * 100 * contracts).toFixed(0)}` : 'N/A'}</span>
                    </div>
                    ${sellPutOption ? `
                    <div style="font-size:10px; color:#ccc; line-height:1.4;">
                        <div>📋 Sell $${sellPutOption.strike} put @ <span style="color:#6b9b7a;">$${(sellPutOption.bid || sellPutOption.ask * 0.95).toFixed(2)}</span></div>
                        <div>📅 Exp: ${sellPutOption.expiration} (${Math.ceil((new Date(sellPutOption.expiration) - today) / (1000*60*60*24))} DTE)</div>
                        <div>Δ ${(sellPutOption.delta || -0.20).toFixed(2)} | BE: $${(sellPutOption.strike - (sellPutOption.bid || sellPutOption.ask * 0.95)).toFixed(2)}</div>
                    </div>
                    <button onclick="window.stageAlternativeStrategy('${ticker}', 'short_put', ${sellPutOption.strike}, ${spot}, null, '${sellPutOption.expiration}', ${(sellPutOption.bid || sellPutOption.ask * 0.95).toFixed(2)}, ${sellPutOption.delta || -0.20}, ${((sellPutOption.iv || 0.65) * 100).toFixed(0)})" 
                            style="width:100%; margin-top:6px; background:rgba(168,144,96,0.3); border:1px solid rgba(168,144,96,0.5); color:#a89060; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px; font-weight:bold;">
                        📥 Stage to Ideas
                    </button>
                    ` : `<div style="font-size:10px; color:#888;">No $${putStrike} puts available</div>`}
                </div>
                
            </div>
        </div>`;
    }
    
    // Similar section for short puts that are ITM (stock below strike)
    if (!isCoveredCall && !isBuyWrite && !isLong && spot < currentStrike) {
        const putStrikeBelow = Math.floor((spot * 0.95) / 5) * 5;  // 5% below spot
        
        html += `
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(122,138,148,0.3);">
            <div style="font-size:12px; color:#7a8a94; margin-bottom:8px; font-weight:bold;">
                💡 Alternative Strategies <span style="font-size:10px; color:#888; font-weight:normal;">(Instead of Rolling)</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
                
                <!-- TAKE ASSIGNMENT -->
                <div style="background:rgba(107,155,122,0.15); border:1px solid rgba(107,155,122,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#6b9b7a; font-weight:bold; font-size:12px;">📦 Take Shares</span>
                        <span style="color:#888; font-size:10px;">@$${currentStrike}</span>
                    </div>
                    <div style="font-size:10px; color:#aaa; margin-bottom:6px;">
                        Buy shares at strike, start selling calls
                    </div>
                    <button onclick="showNotification('Let put assign. Buy ${contracts * 100} shares at $${currentStrike}, then sell covered calls.', 'info')" 
                            style="width:100%; background:rgba(107,155,122,0.2); border:1px solid rgba(107,155,122,0.4); color:#6b9b7a; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px;">
                        📋 Details
                    </button>
                </div>
                
                <!-- PUT SPREAD -->
                <div style="background:rgba(122,138,148,0.15); border:1px solid rgba(122,138,148,0.3); border-radius:6px; padding:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                        <span style="color:#7a8a94; font-weight:bold; font-size:12px;">📊 Put Spread</span>
                        <span style="color:#888; font-size:10px;">Convert</span>
                    </div>
                    <div style="font-size:10px; color:#aaa; margin-bottom:6px;">
                        Buy protective put below to cap downside
                    </div>
                    <button onclick="showNotification('Convert to put spread: Buy $${putStrikeBelow} put to cap losses', 'info')" 
                            style="width:100%; background:rgba(122,138,148,0.2); border:1px solid rgba(122,138,148,0.4); color:#7a8a94; 
                                   padding:5px 8px; border-radius:4px; cursor:pointer; font-size:10px;">
                        📋 Details
                    </button>
                </div>
                
            </div>
        </div>`;
    }
    
    html += `<div style="font-size:11px; color:#7ba3b0; margin-top:10px;">✓ Real CBOE prices: close @ ASK, open @ BID${contracts > 1 ? ` (${contracts} contracts)` : ''}</div>`;
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
 * Stage a roll suggestion to the Ideas tab
 * Called from roll suggestions grid
 */
window.stageRollSuggestion = function(data) {
    const { ticker, strike, expiry, premium, currentPrice, delta, iv, isCall } = data;
    
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.expiry === expiry);
    if (exists) {
        showNotification(`${ticker} $${strike} already staged`, 'info');
        return;
    }
    
    // Create pending trade
    const trade = {
        id: Date.now(),
        ticker,
        strike: parseFloat(strike),
        expiry,
        currentPrice: parseFloat(currentPrice) || 0,
        premium: parseFloat(premium) || 0,
        delta: parseFloat(delta) || null,
        iv: parseFloat(iv) || null,
        type: isCall ? 'short_call' : 'short_put',  // Rolls are typically short options
        isCall: isCall || false,
        isRoll: true,  // Flag that this came from roll suggestions
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    const optionType = isCall ? 'call' : 'put';
    showNotification(`📥 Staged Roll: ${ticker} $${strike} ${optionType}, ${expiry}`, 'success');
    
    // Re-render pending trades
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
};

/**
 * Stage an alternative strategy to the Ideas tab
 * Called from alternative strategies grid (long call, call spread, sell put)
 * Now accepts real chain data: expiry, premium, delta, iv
 */
window.stageAlternativeStrategy = function(ticker, strategyType, strike, currentPrice, upperStrike = null, realExpiry = null, premium = null, delta = null, iv = null) {
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Use real expiry if provided, otherwise calculate ~60 days out
    let expiry = realExpiry;
    if (!expiry) {
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + 60);
        // Adjust to Friday
        const dayOfWeek = expDate.getDay();
        const daysUntilFriday = (5 - dayOfWeek + 7) % 7;
        expDate.setDate(expDate.getDate() + daysUntilFriday);
        expiry = expDate.toISOString().split('T')[0];
    }
    
    // Determine trade details based on strategy type
    let tradeDescription, tradeType, isCall, isDebit;
    
    switch (strategyType) {
        case 'long_call':
            tradeDescription = `Long Call $${strike}`;
            tradeType = 'long_call';
            isCall = true;
            isDebit = true;  // Bought option
            break;
        case 'long_put':
            tradeDescription = `Long Put $${strike}`;
            tradeType = 'long_put';
            isCall = false;
            isDebit = true;  // Bought option
            break;
        case 'call_spread':
            tradeDescription = `Call Spread $${strike}/$${upperStrike}`;
            tradeType = 'call_debit_spread';
            isCall = true;
            isDebit = true;  // Bull call spread is a debit
            break;
        case 'put_spread':
            tradeDescription = `Put Spread $${strike}/$${upperStrike}`;
            tradeType = 'put_debit_spread';
            isCall = false;
            isDebit = true;  // Bear put spread is a debit
            break;
        case 'short_put':
            tradeDescription = `Short Put $${strike}`;
            tradeType = 'short_put';
            isCall = false;
            isDebit = false;  // Sold option = credit
            break;
        case 'short_call':
            tradeDescription = `Short Call $${strike}`;
            tradeType = 'short_call';
            isCall = true;
            isDebit = false;  // Sold option = credit
            break;
        default:
            tradeDescription = `${strategyType} $${strike}`;
            tradeType = strategyType;
            isCall = strategyType.includes('call');
            isDebit = strategyType.includes('long') || strategyType.includes('debit');
    }
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.strike === strike && p.type === tradeType);
    if (exists) {
        showNotification(`${ticker} ${tradeDescription} already staged`, 'info');
        return;
    }
    
    // Create pending trade with real chain data
    const trade = {
        id: Date.now(),
        ticker,
        strike: parseFloat(strike),
        upperStrike: upperStrike ? parseFloat(upperStrike) : null,
        expiry,
        currentPrice: parseFloat(currentPrice) || 0,
        premium: premium ? parseFloat(premium) : null,
        delta: delta ? parseFloat(delta) : null,
        iv: iv ? parseFloat(iv) : null,
        type: tradeType,
        isCall,
        isDebit,  // Whether this is a debit (bought) vs credit (sold) position
        isAlternative: true,  // Flag that this came from alternative strategies
        description: tradeDescription,
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // More detailed notification
    const premiumText = premium ? ` @ $${parseFloat(premium).toFixed(2)}` : '';
    showNotification(`📥 Staged: ${ticker} ${tradeDescription}${premiumText}, exp ${expiry}`, 'success');
    
    // Re-render pending trades
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
};

/**
 * Stage a SKIP™ strategy to the Ideas tab
 * SKIP™ = LEAPS call (12+ months) + SKIP call (3-9 months, higher strike)
 */
window.stageSkipStrategy = function(ticker, leapsStrike, leapsExpiry, leapsPrice, skipStrike, skipExpiry, skipPrice, currentPrice) {
    // Load existing pending trades
    let pending = JSON.parse(localStorage.getItem('wheelhouse_pending') || '[]');
    
    // Calculate DTEs
    const today = new Date();
    const leapsDte = Math.ceil((new Date(leapsExpiry) - today) / (1000 * 60 * 60 * 24));
    const skipDte = Math.ceil((new Date(skipExpiry) - today) / (1000 * 60 * 60 * 24));
    
    // Check for duplicates
    const exists = pending.find(p => p.ticker === ticker && p.type === 'skip_call');
    if (exists) {
        showNotification(`${ticker} SKIP™ strategy already staged`, 'info');
        return;
    }
    
    // Create SKIP™ trade with both legs
    const trade = {
        id: Date.now(),
        ticker,
        type: 'skip_call',
        // LEAPS leg
        leapsStrike: parseFloat(leapsStrike),
        leapsExpiry,
        leapsPremium: parseFloat(leapsPrice),
        leapsDte,
        // SKIP leg
        skipStrike: parseFloat(skipStrike),
        skipExpiry,
        skipPremium: parseFloat(skipPrice),
        skipDte,
        // Combined
        strike: parseFloat(leapsStrike),  // Primary strike for display
        expiry: leapsExpiry,  // Primary expiry (the longer one)
        premium: parseFloat(leapsPrice) + parseFloat(skipPrice),  // Total premium
        currentPrice: parseFloat(currentPrice) || 0,
        totalInvestment: (parseFloat(leapsPrice) + parseFloat(skipPrice)) * 100,
        // Metadata
        isSkip: true,
        isCall: true,  // SKIP strategies use CALLS
        isDebit: true,  // SKIP strategies are bought (debit), not sold (credit)
        isAlternative: true,
        description: `SKIP™ $${leapsStrike}/${skipStrike}`,
        stagedAt: new Date().toISOString()
    };
    
    pending.push(trade);
    localStorage.setItem('wheelhouse_pending', JSON.stringify(pending));
    
    // Detailed notification
    const totalCost = (parseFloat(leapsPrice) + parseFloat(skipPrice)).toFixed(2);
    showNotification(`📥 Staged: ${ticker} SKIP™ - LEAPS $${leapsStrike} (${leapsDte} DTE) + SKIP $${skipStrike} (${skipDte} DTE) = $${totalCost}`, 'success');
    
    // Re-render pending trades
    if (typeof window.renderPendingTrades === 'function') {
        window.renderPendingTrades();
    }
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
        listEl.innerHTML = `<div style="color:#b87a75;">❌ Could not fetch options chain: ${e.message}</div>`;
        return;
    }
    
    if (!chain.puts || chain.puts.length === 0) {
        listEl.innerHTML = '<div style="color:#b87a75;">❌ No put options found</div>';
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
            const riskReduction = (state.currentPositionContext?.risk || 50) - newRisk;
            
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
        
        listEl.innerHTML = `<div style="color:#b87a75; padding:10px;">
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
    let html = `<div style="font-size:11px; color:#888; margin-bottom:8px; padding:6px; background:rgba(184,122,117,0.1); border-radius:4px;">
        💰 Cost to close $${currentStrike.toFixed(0)} ${optionLabel2}: <span style="color:#b87a75;">$${(currentPutAsk * 100 * contracts).toFixed(0)}</span>
    </div>`;
    
    html += `<div style="font-size:12px; color:#6b9b7a; margin-bottom:6px; font-weight:bold;">💵 Credit Roll Options (${topCredits.length} found)</div>`;
    
    topCredits.forEach((c, i) => {
        const totalRollNet = c.rollNetPerContract * contracts;
        const riskColor = c.riskChange > 0 ? '#6b9b7a' : '#b87a75';
        const riskIcon = c.riskChange > 0 ? '↓' : '↑';
        
        const expDate = new Date(c.expiration + 'T00:00:00');
        const expFormatted = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        html += `
            <div style="padding:8px; margin-bottom:6px; background:rgba(107,155,122,0.1); border:1px solid rgba(107,155,122,0.3); border-radius:4px; cursor:pointer;" 
                 onclick="window.applyRollSuggestion(${c.strike}, ${c.dte}, '${c.expiration}', ${totalRollNet})">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="white-space:nowrap;">💰 <b>$${c.strike.toFixed(2)}</b> · <b>${expFormatted}</b></span>
                    <span style="color:#6b9b7a; font-weight:bold;">+$${totalRollNet.toFixed(0)} credit</span>
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
                style="display:block; margin-top:8px; background:rgba(123,163,176,0.2); border:1px solid #7ba3b0; color:#7ba3b0; 
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
        low: '#6b9b7a',
        medium: '#a89060',
        high: '#ff8800',
        critical: '#b87a75'
    };
    
    // Build earnings/dividend warning if we have calendar data
    let calendarWarning = '';
    if (analysis.calendarWarnings && analysis.calendarWarnings.length > 0) {
        calendarWarning = `
            <div style="background:rgba(168,144,96,0.2); border:1px solid rgba(168,144,96,0.5); border-radius:4px; padding:8px; margin-bottom:8px;">
                ${analysis.calendarWarnings.map(w => `<div style="font-size:11px; color:#a89060;">⚠️ ${w}</div>`).join('')}
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
            <div style="font-size:12px; color:#7ba3b0; margin-bottom:6px;">
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
                <div style="font-size:10px; color:#7a8a94; margin-top:8px; padding-top:6px; border-top:1px solid #444;">
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
                <div style="background:rgba(168,144,96,0.2); border:1px solid rgba(168,144,96,0.5); border-radius:6px; padding:10px; margin-bottom:12px;">
                    ${warnings.map(w => `<div style="font-size:13px; color:#a89060; margin-bottom:4px;">⚠️ ${w}</div>`).join('')}
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
                    <div style="font-size:14px; color:#7ba3b0; margin-bottom:10px;">
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
                        <div style="font-size:12px; color:#7a8a94; margin-top:12px; padding-top:10px; border-top:1px solid #444;">
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
            <div style="color:#6b9b7a; font-weight:bold; margin-bottom:8px;">
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
        
        // DEBUG: Log what we gathered
        console.log('[getAIInsight] Roll options gathered:', JSON.stringify(rollOptions, null, 2));
        console.log('[getAIInsight] Risk reduction count:', rollOptions?.riskReduction?.length || 0);
        console.log('[getAIInsight] Credit rolls count:', rollOptions?.creditRolls?.length || 0);
        
        // Get current option price (what it would cost to close)
        // Use stored lastOptionPrice first (from CBOE/Schwab live feed), then markedPrice as fallback
        let costToClose = state.currentPositionContext?.lastOptionPrice 
                       || state.currentPositionContext?.markedPrice 
                       || null;
        
        // If we still don't have it, try scraping from the roll panel (legacy fallback)
        if (!costToClose) {
            const closeInfoEl = document.querySelector('#rollSuggestionsList > div:first-child');
            if (closeInfoEl) {
                const closeMatch = closeInfoEl.textContent.match(/\$(\d+)/);
                if (closeMatch) costToClose = parseInt(closeMatch[1]) / 100 / (state.currentPositionContext?.contracts || 1);  // Convert to per-share
            }
        }
        
        // Get selected AI model (global with local override)
        const selectedModel = window.getSelectedAIModel?.('aiModelSelect') || 'qwen2.5:7b';
        
        // Get previous analysis for comparison (if any)
        const positionId = state.currentPositionContext?.id;
        const previousAnalysis = positionId ? (window.getLatestAnalysis?.(positionId) || null) : null;
        
        // Get chain history and total premium for rolled positions
        const { chainHistory, totalPremiumCollected } = getChainData(positionId);
        
        // Gather closed positions summary for historical pattern matching
        const closedPositions = state.closedPositions || [];
        const closedSummary = closedPositions.length > 0 ? closedPositions.map(p => ({
            ticker: p.ticker,
            type: p.type,
            strike: p.strike,
            pnl: p.realizedPnL ?? p.closePnL ?? 0,
            closeDate: p.closeDate
        })) : null;
        
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
            portfolioContext: formatPortfolioContextForAI(),  // Include portfolio context from audit
            chainHistory: chainHistory.length > 1 ? chainHistory : null,  // Only include if rolled
            totalPremiumCollected: totalPremiumCollected,  // Net premium across all rolls
            skipWisdom: !document.getElementById('aiWisdomToggle')?.checked,  // True = pure mode (no wisdom)
            closedSummary: closedSummary  // Historical trades for pattern matching
        };
        
        // DEBUG: Log what we're sending to AI
        console.log('[getAIInsight] Sending to AI:', {
            ticker: requestData.ticker,
            positionType: requestData.positionType,
            strike: requestData.strike,
            spot: requestData.spot,
            dte: requestData.dte,
            isITM: requestData.positionType === 'covered_call' ? requestData.spot > requestData.strike : requestData.spot < requestData.strike,
            rollOptionsCount: {
                riskReduction: requestData.rollOptions?.riskReduction?.length || 0,
                creditRolls: requestData.rollOptions?.creditRolls?.length || 0
            }
        });
        
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
            .replace(/(BUY TO CLOSE|SELL TO OPEN|Net:)/g, '<span style="color:#6b9b7a; font-weight:bold;">$1</span>')
            // Highlight key actions
            .replace(/(PICK|BEST OPTION|RECOMMENDED|EXECUTE|ACTION):/gi, '<span style="color:#a89060; font-weight:bold;">$1:</span>')
            // Make credits green, debits red
            .replace(/(\$\d+)\s*(credit)/gi, '<span style="color:#6b9b7a;">$1 $2</span>')
            .replace(/(\$\d+)\s*(debit)/gi, '<span style="color:#b87a75;">$1 $2</span>')
            // Color-code ratings: 8-10 green, 5-7 orange, 1-4 red
            .replace(/\|\s*(10|9|8)\/10\s*\|/g, '| <span style="color:#6b9b7a; font-weight:bold; font-size:16px;">$1/10</span> |')
            .replace(/\|\s*(7|6|5)\/10\s*\|/g, '| <span style="color:#a89060; font-weight:bold; font-size:16px;">$1/10</span> |')
            .replace(/\|\s*([1-4])\/10\s*\|/g, '| <span style="color:#b87a75; font-weight:bold; font-size:16px;">$1/10</span> |');
        
        // Check if we have previous analyses
        const analysisHistory = window.getAnalysisHistory?.(positionId) || [];
        const hasHistory = analysisHistory.length > 1; // >1 because we just added one
        
        // Build MoE indicator if used
        const isMoE = result.moe && result.moe.opinions;
        const moeIndicator = isMoE ? 
            `<span style="color:#7a8a94; margin-right:8px;" title="Mixture of Experts: 7B + 14B opinions synthesized by 32B">🧠 MoE</span>` : '';
        
        // Build pure mode indicator
        const pureModeIndicator = result.pureMode ?
            `<span style="color:#fbbf24; margin-right:8px;" title="Analysis without wisdom/rules influence">⚡ Pure</span>` : '';
        
        // Build wisdom indicator
        const wisdomIndicator = !result.pureMode && result.wisdomApplied?.count > 0 ?
            `<span style="color:#4ade80; margin-right:8px;" title="${result.wisdomApplied.count} wisdom entries applied">📚 ${result.wisdomApplied.count}</span>` : '';
        
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
        
        // Show a brief summary in the panel, with button to open full modal
        contentEl.innerHTML = `
            <div style="color:#7ba3b0; font-weight:bold; margin-bottom:6px;">✅ Analysis Complete</div>
            <div style="color:#888; font-size:11px; margin-bottom:8px;">${moeIndicator}${pureModeIndicator}${wisdomIndicator}${selectedModel} • ${result.took || 'N/A'}</div>
            <button onclick="window.showAIInsightModal()" style="background:#7ba3b0; border:none; color:#000; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:bold; width:100%;">
                📊 View Full Analysis
            </button>
        `;
        
        // Store data for the modal
        window._lastAIInsightModal = {
            formattedInsight,
            ticker,
            selectedModel,
            took: result.took,
            isMoE,
            moeIndicator,
            pureModeIndicator,
            wisdomIndicator,
            pureMode: result.pureMode,
            hasThesis,
            positionId,
            hasHistory,
            analysisHistoryLength: analysisHistory.length,
            wisdomApplied: result.wisdomApplied  // Store wisdom entries used
        };
        
        // Auto-open the modal
        window.showAIInsightModal();
        
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
        
        contentEl.innerHTML = `<div style="color:#b87a75;">❌ ${errorMsg}</div>`;
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
    if (!listEl) {
        console.log('[gatherRollOptions] No rollSuggestionsList element found');
        return options;
    }
    
    // Find card containers: we look for the clickable div and get its parent (the card)
    const clickables = listEl.querySelectorAll('div[onclick*="applyRollSuggestion"]');
    console.log(`[gatherRollOptions] Found ${clickables.length} clickable roll suggestion elements`);
    
    // Get unique parent cards (the card container wraps the clickable div)
    const cards = new Set();
    clickables.forEach(el => {
        // The card is the grandparent: card > inner-wrapper > clickable
        // Or the card is just the parent in some formats
        const parent = el.parentElement;
        if (parent && parent !== listEl) {
            cards.add(parent);
        }
    });
    
    console.log(`[gatherRollOptions] Found ${cards.size} unique roll card containers`);
    
    // Also find section headers to know which section we're in
    const allHtml = listEl.innerHTML;
    const riskReductionMatch = allHtml.match(/Best Risk Reduction|Best Roll Up/);
    const creditRollsMatch = allHtml.match(/Credit Rolls/);
    
    // Parse each card
    let cardIndex = 0;
    cards.forEach(card => {
        const fullText = card.textContent.trim();
        console.log(`[gatherRollOptions] Card ${cardIndex}: "${fullText.substring(0, 100)}..."`);
        
        // Determine section based on what headers appear BEFORE this card in the DOM
        // We'll use the order: first cards are risk reduction, later ones are credit rolls
        let section = 'unknown';
        
        // Check for section markers in ancestors or previous siblings
        let el = card;
        while (el && el !== listEl) {
            const prev = el.previousElementSibling;
            if (prev) {
                const prevText = prev.textContent || '';
                if (prevText.includes('Best Risk Reduction') || prevText.includes('Best Roll Up')) {
                    section = 'riskReduction';
                    break;
                }
                if (prevText.includes('Credit Rolls')) {
                    section = 'creditRolls';
                    break;
                }
            }
            el = el.parentElement;
        }
        
        // Fallback: check parent grid's previous sibling
        if (section === 'unknown' && card.parentElement) {
            const gridPrev = card.parentElement.previousElementSibling;
            if (gridPrev) {
                const gridPrevText = gridPrev.textContent || '';
                if (gridPrevText.includes('Best Risk Reduction') || gridPrevText.includes('Best Roll Up')) {
                    section = 'riskReduction';
                } else if (gridPrevText.includes('Credit Rolls')) {
                    section = 'creditRolls';
                }
            }
        }
        
        console.log(`[gatherRollOptions] Detected section: ${section}`);
        
        // Parse the card text
        const strikeMatch = fullText.match(/\$(\d+(?:\.\d+)?)/);
        const riskMatch = fullText.match(/[↓↑](\d+(?:\.\d+)?)%\s*risk/i);
        const dateMatch = fullText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/i);
        const creditMatch = fullText.match(/\$(\d+)\s*(cr|deb)/i);
        const deltaMatch = fullText.match(/Δ(-?\d+\.?\d*)/);
        const ivMatch = fullText.match(/IV(\d+)%/);
        
        if (strikeMatch) {
            const option = {
                strike: parseFloat(strikeMatch[1]),
                riskChange: riskMatch ? parseFloat(riskMatch[1]) : null,
                expiry: dateMatch ? dateMatch[0] : null,
                amount: creditMatch ? parseInt(creditMatch[1]) : null,
                isCredit: creditMatch ? creditMatch[2].toLowerCase() === 'cr' : null,
                delta: deltaMatch ? parseFloat(deltaMatch[1]) : null,
                iv: ivMatch ? parseInt(ivMatch[1]) : null
            };
            
            console.log(`[gatherRollOptions] Parsed:`, option, `→ section: ${section}`);
            
            if (section === 'riskReduction') {
                options.riskReduction.push(option);
            } else if (section === 'creditRolls') {
                options.creditRolls.push(option);
            } else {
                // Fallback heuristic: credit vs debit
                if (option.isCredit === true) {
                    options.creditRolls.push(option);
                } else {
                    options.riskReduction.push(option);
                }
            }
        }
        
        cardIndex++;
    });
    
    console.log(`[gatherRollOptions] Final: ${options.riskReduction.length} risk reduction, ${options.creditRolls.length} credit rolls`);
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
        card.style.border = '2px solid #6b9b7a';
        card.style.boxShadow = '0 0 10px rgba(0, 255, 136, 0.4)';
        
        // Add a small "AI Pick" badge
        if (!card.querySelector('.ai-pick-badge')) {
            const badge = document.createElement('div');
            badge.className = 'ai-pick-badge';
            badge.style.cssText = 'position:absolute; top:-8px; right:-8px; background:#6b9b7a; color:#000; font-size:9px; font-weight:bold; padding:2px 5px; border-radius:8px; z-index:10;';
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
        const recColor = entry.recommendation === 'HOLD' ? '#6b9b7a' :
                        entry.recommendation === 'ROLL' ? '#a89060' :
                        entry.recommendation === 'CLOSE' ? '#b87a75' : '#888';
        
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
                <div style="background:rgba(123,163,176,0.1); border:1px solid rgba(123,163,176,0.3); border-radius:8px; padding:12px;">
                    <div style="color:#7ba3b0; font-weight:bold; margin-bottom:8px; font-size:12px;">
                        ⚡ Analyst #1 (Qwen 7B)
                    </div>
                    <div style="color:#ccc; font-size:11px; line-height:1.5; white-space:pre-wrap;">
                        ${opinions['7B'] || 'No response'}
                    </div>
                </div>
                
                <!-- 14B Opinion -->
                <div style="background:rgba(168,144,96,0.1); border:1px solid rgba(168,144,96,0.3); border-radius:8px; padding:12px;">
                    <div style="color:#a89060; font-weight:bold; margin-bottom:8px; font-size:12px;">
                        📊 Analyst #2 (Qwen 14B)
                    </div>
                    <div style="color:#ccc; font-size:11px; line-height:1.5; white-space:pre-wrap;">
                        ${opinions['14B'] || 'No response'}
                    </div>
                </div>
            </div>
            
            <div style="margin-top:16px; padding-top:12px; border-top:1px solid #444; text-align:center;">
                <span style="color:#7a8a94; font-size:11px;">
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
            saveBtn.style.background = 'rgba(107,155,122,0.4)';
            setTimeout(() => {
                saveBtn.innerHTML = '💾 Update Thesis';
                saveBtn.style.background = 'rgba(107,155,122,0.2)';
            }, 2000);
        }
    }
    
    // Refresh positions table to show the 📋 indicator
    if (window.renderPositions) {
        window.renderPositions();
    }
}

/**
 * Show AI Insight in a full-screen modal
 * Much better than the cramped inline display!
 */
function showAIInsightModal() {
    const data = window._lastAIInsightModal;
    if (!data) {
        showNotification('No analysis available', 'error');
        return;
    }
    
    // Remove existing modal if any
    const existing = document.getElementById('aiInsightModal');
    if (existing) existing.remove();
    
    // Build wisdom section if wisdom was applied
    let wisdomSection = '';
    if (data.wisdomApplied && data.wisdomApplied.count > 0) {
        const posType = data.wisdomApplied.positionType?.replace(/_/g, ' ') || 'position';
        const wisdomEntries = data.wisdomApplied.entries.map(w => 
            `<div style="margin:4px 0; padding:6px 10px; background:rgba(122,138,148,0.1); border-radius:4px; font-size:12px;">
                <span style="color:#a78bfa; font-weight:bold;">[${w.category}]</span> 
                <span style="color:#ccc;">${w.wisdom}</span>
                ${w.relevance ? `<span style="color:#666; font-size:10px; float:right;">relevance: ${w.relevance}</span>` : ''}
            </div>`
        ).join('');
        
        wisdomSection = `
            <div style="background:rgba(122,138,148,0.1); border:1px solid #7a8a94; border-radius:8px; padding:12px; margin-top:16px;">
                <div style="color:#a78bfa; font-weight:bold; margin-bottom:8px; font-size:13px;">
                    📚 WISDOM APPLIED (${data.wisdomApplied.count} entries matched "${posType}")
                </div>
                ${wisdomEntries}
            </div>
        `;
    } else if (data.pureMode) {
        wisdomSection = `
            <div style="background:rgba(251,191,36,0.1); border:1px solid #fbbf24; border-radius:8px; padding:12px; margin-top:16px;">
                <div style="color:#fbbf24; font-weight:bold; font-size:13px;">
                    ⚡ PURE MODE - Analysis without wisdom/rules influence
                </div>
                <div style="color:#888; font-size:11px; margin-top:4px;">
                    Enable "📚 Apply Wisdom" to include your trading rules in the analysis.
                </div>
            </div>
        `;
    }
    
    const modal = document.createElement('div');
    modal.id = 'aiInsightModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.95); display:flex; align-items:center; justify-content:center; z-index:10000; padding:20px;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border:1px solid #7ba3b0; border-radius:12px; padding:24px; max-width:800px; width:95%; max-height:90vh; display:flex; flex-direction:column;">
            <!-- Header -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-shrink:0;">
                <h2 style="margin:0; color:#7ba3b0; font-size:20px;">
                    🧠 AI Strategy Analysis: ${data.ticker}
                </h2>
                <button onclick="document.getElementById('aiInsightModal').remove()" 
                    style="background:none; border:none; color:#888; font-size:28px; cursor:pointer; line-height:1;">&times;</button>
            </div>
            
            <!-- Model info bar -->
            <div style="background:rgba(123,163,176,0.1); padding:10px 14px; border-radius:8px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; flex-shrink:0;">
                <span style="color:#7ba3b0;">${data.moeIndicator || ''}${data.pureModeIndicator || ''}${data.wisdomIndicator || ''}${data.selectedModel}</span>
                <span style="color:#888;">${data.took || ''}</span>
            </div>
            
            <!-- Content - scrollable -->
            <div style="flex:1; overflow-y:auto; color:#e0e0e0; line-height:1.8; font-size:14px; white-space:pre-wrap; padding-right:8px;">
                ${data.formattedInsight}
                ${wisdomSection}
            </div>
            
            <!-- Action buttons - fixed at bottom -->
            <div style="display:flex; gap:10px; margin-top:16px; padding-top:16px; border-top:1px solid #333; flex-shrink:0; flex-wrap:wrap;">
                ${data.positionId ? `
                    <button onclick="window.saveAsThesis(); document.getElementById('aiInsightModal').remove();" 
                        style="background:#6b9b7a; border:none; color:#000; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px;">
                        💾 ${data.hasThesis ? 'Update' : 'Save'} Thesis
                    </button>
                ` : ''}
                ${data.isMoE ? `
                    <button onclick="window.showMoeOpinions()" 
                        style="background:rgba(122,138,148,0.3); border:1px solid #7a8a94; color:#a78bfa; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px;">
                        👁️ View Expert Opinions
                    </button>
                ` : ''}
                ${data.hasHistory ? `
                    <button onclick="window.showAnalysisHistory(${data.positionId})" 
                        style="background:rgba(168,144,96,0.2); border:1px solid #a89060; color:#a89060; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px;">
                        📜 History (${data.analysisHistoryLength})
                    </button>
                ` : ''}
                <button onclick="document.getElementById('aiInsightModal').remove()" 
                    style="background:#333; border:1px solid #555; color:#ccc; padding:10px 20px; border-radius:6px; cursor:pointer; font-size:13px; margin-left:auto;">
                    Close
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

// Make available globally
window.showAnalysisHistory = showAnalysisHistory;
window.showMoeOpinions = showMoeOpinions;
window.saveAsThesis = saveAsThesis;
window.showAIInsightModal = showAIInsightModal;

// Make globally accessible
window.getAIInsight = getAIInsight;
