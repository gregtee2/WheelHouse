// WheelHouse - Challenge System
// Track trading challenges with goals, time limits, and linked positions

import { state } from './state.js';

const CHALLENGES_KEY = 'wheelhouse_challenges';

// ============ Theme Colors Helper ============
// Gets CSS variable values for dynamic theming
function getThemeColor(varName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return value || fallback;
}

// Theme color getters
const colors = {
    get cyan() { return getThemeColor('--accent-cyan', '#00d9ff'); },
    get green() { return getThemeColor('--accent-green', '#00ff88'); },
    get red() { return getThemeColor('--accent-red', '#ff5252'); },
    get orange() { return getThemeColor('--accent-orange', '#ffaa00'); },
    get purple() { return getThemeColor('--accent-purple', '#8b5cf6'); },
    get text() { return getThemeColor('--text-primary', '#e8e8e8'); },
    get muted() { return getThemeColor('--text-muted', '#888'); },
    get bgPrimary() { return getThemeColor('--bg-primary', '#1a1a2e'); },
    get bgSecondary() { return getThemeColor('--bg-secondary', '#0a0a15'); }
};

// ============ Challenge Data Model ============
// Challenge: {
//   id: number,
//   name: string,
//   goal: number (target $ amount),
//   goalType: 'net_pnl' | 'premium' | 'trades',
//   startDate: 'YYYY-MM-DD',
//   endDate: 'YYYY-MM-DD',
//   createdAt: ISO string,
//   status: 'active' | 'completed' | 'archived'
// }
//
// Positions get: challengeIds: [1, 2, ...]

// ============ Storage ============

export function loadChallenges() {
    try {
        const saved = localStorage.getItem(CHALLENGES_KEY);
        state.challenges = saved ? JSON.parse(saved) : [];
    } catch (e) {
        console.error('Failed to load challenges:', e);
        state.challenges = [];
    }
    return state.challenges;
}

export function saveChallenges() {
    localStorage.setItem(CHALLENGES_KEY, JSON.stringify(state.challenges || []));
}

// ============ Challenge CRUD ============

export function createChallenge({ name, goal, goalType = 'net_pnl', startDate, endDate }) {
    if (!state.challenges) state.challenges = [];
    
    const challenge = {
        id: Date.now(),
        name,
        goal: parseFloat(goal),
        goalType,
        startDate,
        endDate,
        createdAt: new Date().toISOString(),
        status: 'active'
    };
    
    state.challenges.push(challenge);
    saveChallenges();
    return challenge;
}

export function updateChallenge(id, updates) {
    const challenge = state.challenges?.find(c => c.id === id);
    if (challenge) {
        Object.assign(challenge, updates);
        saveChallenges();
    }
    return challenge;
}

export function deleteChallenge(id) {
    if (!state.challenges) return;
    
    // Remove challenge tags from positions
    state.positions?.forEach(pos => {
        if (pos.challengeIds) {
            pos.challengeIds = pos.challengeIds.filter(cid => cid !== id);
        }
    });
    localStorage.setItem('wheelhouse_positions', JSON.stringify(state.positions));
    
    // Remove from closed positions too
    state.closedPositions?.forEach(pos => {
        if (pos.challengeIds) {
            pos.challengeIds = pos.challengeIds.filter(cid => cid !== id);
        }
    });
    localStorage.setItem('wheelhouse_closed', JSON.stringify(state.closedPositions));
    
    state.challenges = state.challenges.filter(c => c.id !== id);
    saveChallenges();
}

export function archiveChallenge(id) {
    return updateChallenge(id, { status: 'archived' });
}

// ============ Position Linking ============

export function linkPositionToChallenge(positionId, challengeId) {
    // Check open positions
    let pos = state.positions?.find(p => p.id === positionId);
    let storage = 'wheelhouse_positions';
    let list = state.positions;
    
    // Check closed positions if not found
    if (!pos) {
        pos = state.closedPositions?.find(p => p.id === positionId);
        storage = 'wheelhouse_closed';
        list = state.closedPositions;
    }
    
    if (pos) {
        if (!pos.challengeIds) pos.challengeIds = [];
        if (!pos.challengeIds.includes(challengeId)) {
            pos.challengeIds.push(challengeId);
            localStorage.setItem(storage, JSON.stringify(list));
        }
    }
}

export function unlinkPositionFromChallenge(positionId, challengeId) {
    let pos = state.positions?.find(p => p.id === positionId);
    let storage = 'wheelhouse_positions';
    let list = state.positions;
    
    if (!pos) {
        pos = state.closedPositions?.find(p => p.id === positionId);
        storage = 'wheelhouse_closed';
        list = state.closedPositions;
    }
    
    if (pos && pos.challengeIds) {
        pos.challengeIds = pos.challengeIds.filter(cid => cid !== challengeId);
        localStorage.setItem(storage, JSON.stringify(list));
    }
}

// ============ Scoring Calculation ============

export function getChallengePositions(challengeId) {
    const challenge = state.challenges?.find(c => c.id === challengeId);
    if (!challenge) return { open: [], closed: [] };
    
    const start = new Date(challenge.startDate);
    const end = new Date(challenge.endDate);
    end.setHours(23, 59, 59, 999); // Include full end day
    
    // Get positions that are tagged to this challenge OR opened within date range
    // Only positions OPENED during challenge count - keeps challenges honest!
    // (Can't "pre-load" positions before challenge starts)
    const isInDateRange = (pos) => {
        const openDate = pos.openDate ? new Date(pos.openDate) : null;
        
        // Position must be opened during challenge period
        if (openDate && openDate >= start && openDate <= end) return true;
        
        return false;
    };
    
    const isTagged = (pos) => pos.challengeIds?.includes(challengeId);
    
    // Open positions
    const open = (state.positions || []).filter(pos => 
        isTagged(pos) || isInDateRange(pos)
    );
    
    // Closed positions
    const closed = (state.closedPositions || []).filter(pos => 
        isTagged(pos) || isInDateRange(pos)
    );
    
    return { open, closed };
}

export function calculateChallengeProgress(challengeId) {
    const challenge = state.challenges?.find(c => c.id === challengeId);
    if (!challenge) return null;
    
    const { open, closed } = getChallengePositions(challengeId);
    
    // Calculate realized P&L from closed positions
    // Use stored realizedPnL/closePnL if available (more accurate)
    // Otherwise fall back to premium - closePrice calculation
    let realizedPnL = 0;
    closed.forEach(pos => {
        if (pos.realizedPnL !== undefined || pos.closePnL !== undefined) {
            // Use the stored P&L value
            realizedPnL += (pos.realizedPnL ?? pos.closePnL ?? 0);
        } else {
            // Fall back to calculation
            const premium = (pos.premium || 0) * 100 * (pos.contracts || 1);
            const closeCost = (pos.closePrice || 0) * 100 * (pos.contracts || 1);
            realizedPnL += premium - closeCost;
        }
    });
    
    // Calculate unrealized P&L from open positions
    let unrealizedPnL = 0;
    let totalPremium = 0;
    open.forEach(pos => {
        const premium = (pos.premium || 0) * 100 * (pos.contracts || 1);
        totalPremium += premium;
        
        const currentPrice = pos.lastOptionPrice || pos.markedPrice || 0;
        const currentValue = currentPrice * 100 * (pos.contracts || 1);
        unrealizedPnL += premium - currentValue;
    });
    
    // Net P&L based on goal type
    let current = 0;
    switch (challenge.goalType) {
        case 'net_pnl':
            current = realizedPnL + unrealizedPnL;
            break;
        case 'premium':
            current = totalPremium + closed.reduce((sum, p) => sum + (p.premium || 0) * 100 * (p.contracts || 1), 0);
            break;
        case 'trades':
            current = open.length + closed.length;
            break;
        default:
            current = realizedPnL;
    }
    
    const percent = challenge.goal > 0 ? (current / challenge.goal) * 100 : 0;
    const daysLeft = Math.max(0, Math.ceil((new Date(challenge.endDate) - new Date()) / (1000 * 60 * 60 * 24)));
    const isExpired = daysLeft === 0 && new Date() > new Date(challenge.endDate);
    const isCompleted = percent >= 100;
    
    return {
        challenge,
        openPositions: open,
        closedPositions: closed,
        realizedPnL,
        unrealizedPnL,
        totalPremium,
        current,
        percent: Math.min(percent, 100),
        daysLeft,
        isExpired,
        isCompleted
    };
}

// ============ UI Rendering ============

export function renderChallenges() {
    const container = document.getElementById('challenges');
    if (!container) return;
    
    loadChallenges();
    
    const activeChallenges = (state.challenges || []).filter(c => c.status === 'active');
    const archivedChallenges = (state.challenges || []).filter(c => c.status === 'archived');
    
    container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <h2 style="margin:0; color:${colors.cyan};">🏆 Challenges</h2>
            <button onclick="window.showCreateChallengeModal()" 
                    style="background:${colors.purple}; border:none; color:${colors.text}; padding:10px 20px; 
                           border-radius:6px; cursor:pointer; font-size:14px; font-weight:bold;">
                + New Challenge
            </button>
        </div>
        
        ${activeChallenges.length === 0 ? `
            <div style="text-align:center; padding:60px 20px; color:${colors.muted};">
                <div style="font-size:48px; margin-bottom:15px;">🎯</div>
                <div style="font-size:18px; margin-bottom:10px;">No active challenges</div>
                <div style="font-size:14px; color:${colors.muted};">Create a challenge to track your trading goals!</div>
            </div>
        ` : activeChallenges.map(c => renderChallengeCard(c)).join('')}
        
        ${archivedChallenges.length > 0 ? `
            <div style="margin-top:30px;">
                <h3 style="color:${colors.muted}; margin-bottom:15px; cursor:pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                    📁 Archived (${archivedChallenges.length}) ▾
                </h3>
                <div style="display:none;">
                    ${archivedChallenges.map(c => renderChallengeCard(c, true)).join('')}
                </div>
            </div>
        ` : ''}
    `;
}

function renderChallengeCard(challenge, isArchived = false) {
    const progress = calculateChallengeProgress(challenge.id);
    if (!progress) return '';
    
    const { current, percent, daysLeft, isExpired, isCompleted, openPositions, closedPositions, realizedPnL, unrealizedPnL } = progress;
    
    const statusColor = isCompleted ? colors.green : isExpired ? colors.red : colors.cyan;
    const statusText = isCompleted ? '✅ COMPLETED' : isExpired ? '⏰ EXPIRED' : `${daysLeft} days left`;
    const progressColor = isCompleted ? colors.green : percent > 75 ? colors.orange : colors.cyan;
    
    const goalLabel = challenge.goalType === 'trades' ? 'trades' : '';
    const currentDisplay = challenge.goalType === 'trades' ? current : `$${current.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    const goalDisplay = challenge.goalType === 'trades' ? `${challenge.goal} trades` : `$${challenge.goal.toLocaleString()}`;
    
    // Calculate remaining to goal
    const remaining = challenge.goal - current;
    const remainingDisplay = challenge.goalType === 'trades' 
        ? `${Math.abs(remaining)} trades` 
        : `$${Math.abs(remaining).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    const remainingColor = remaining <= 0 ? colors.green : colors.red;
    const remainingLabel = remaining <= 0 ? 'Exceeded!' : 'To Go';
    
    return `
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); 
                    border-radius:12px; padding:20px; margin-bottom:15px; ${isArchived ? 'opacity:0.6;' : ''}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                <div>
                    <div style="font-size:20px; font-weight:bold; color:${colors.text}; margin-bottom:5px;">
                        ${challenge.name}
                    </div>
                    <div style="color:${colors.muted}; font-size:13px;">
                        ${challenge.startDate} → ${challenge.endDate}
                    </div>
                </div>
                <div style="text-align:right;">
                    <div style="color:${statusColor}; font-weight:bold; font-size:14px;">${statusText}</div>
                </div>
            </div>
            
            <!-- Progress Bar -->
            <div style="background:rgba(255,255,255,0.1); border-radius:10px; height:24px; overflow:hidden; margin-bottom:12px;">
                <div style="background:${progressColor}; height:100%; width:${percent}%; 
                            transition:width 0.5s; display:flex; align-items:center; justify-content:center;
                            font-weight:bold; color:#000; font-size:12px; min-width:${percent > 5 ? 'auto' : '0'};">
                    ${percent > 10 ? `${percent.toFixed(0)}%` : ''}
                </div>
            </div>
            
            <!-- Stats Row -->
            <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:12px; margin-bottom:15px;">
                <div style="text-align:center;">
                    <div style="color:${colors.cyan}; font-size:18px; font-weight:bold;">${currentDisplay}</div>
                    <div style="color:${colors.muted}; font-size:11px;">Current</div>
                </div>
                <div style="text-align:center;">
                    <div style="color:${colors.muted}; font-size:18px; font-weight:bold;">${goalDisplay}</div>
                    <div style="color:${colors.muted}; font-size:11px;">Goal</div>
                </div>
                <div style="text-align:center;">
                    <div style="color:${remainingColor}; font-size:18px; font-weight:bold;">${remaining > 0 ? '' : '+'}${remainingDisplay}</div>
                    <div style="color:${colors.muted}; font-size:11px;">${remainingLabel}</div>
                </div>
                <div style="text-align:center;">
                    <div style="color:${colors.green}; font-size:18px; font-weight:bold;">$${realizedPnL.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    <div style="color:${colors.muted}; font-size:11px;">Realized</div>
                </div>
                <div style="text-align:center;">
                    <div style="color:${unrealizedPnL >= 0 ? colors.orange : colors.red}; font-size:18px; font-weight:bold;">
                        ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                    </div>
                    <div style="color:${colors.muted}; font-size:11px;">Unrealized</div>
                </div>
            </div>
            
            <!-- Position Count -->
            <div style="color:${colors.muted}; font-size:13px; margin-bottom:15px;">
                📊 ${openPositions.length} open · ${closedPositions.length} closed positions
            </div>
            
            <!-- Action Buttons -->
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button onclick="window.viewChallengePositions(${challenge.id})" 
                        style="background:${colors.cyan}; border:none; color:#000; padding:8px 16px; 
                               border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">
                    👁 View Positions
                </button>
                <button onclick="window.showLinkPositionsModal(${challenge.id})" 
                        style="background:${colors.purple}; border:none; color:${colors.text}; padding:8px 16px; 
                               border-radius:6px; cursor:pointer; font-size:12px;">
                    🔗 Link Positions
                </button>
                <button onclick="window.editChallenge(${challenge.id})" 
                        style="background:rgba(255,255,255,0.1); border:none; color:${colors.text}; padding:8px 16px; 
                               border-radius:6px; cursor:pointer; font-size:12px;">
                    ✏️ Edit
                </button>
                ${!isArchived ? `
                    <button onclick="window.archiveChallengeUI(${challenge.id})" 
                            style="background:rgba(255,255,255,0.05); border:none; color:${colors.muted}; padding:8px 16px; 
                                   border-radius:6px; cursor:pointer; font-size:12px;">
                        📁 Archive
                    </button>
                ` : `
                    <button onclick="window.unarchiveChallenge(${challenge.id})" 
                            style="background:rgba(255,255,255,0.05); border:none; color:${colors.muted}; padding:8px 16px; 
                                   border-radius:6px; cursor:pointer; font-size:12px;">
                        ↩️ Restore
                    </button>
                `}
                <button onclick="window.deleteChallengeUI(${challenge.id})" 
                        style="background:rgba(255,82,82,0.2); border:none; color:${colors.red}; padding:8px 16px; 
                               border-radius:6px; cursor:pointer; font-size:12px;">
                    🗑 Delete
                </button>
            </div>
        </div>
    `;
}

// ============ Modal Functions ============

window.showCreateChallengeModal = function(editId = null) {
    const challenge = editId ? state.challenges?.find(c => c.id === editId) : null;
    const isEdit = !!challenge;
    
    // Default dates: start = today, end = end of month
    const today = new Date().toISOString().split('T')[0];
    const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0];
    
    const modal = document.createElement('div');
    modal.id = 'challengeModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.8); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    modal.innerHTML = `
        <div style="background:${colors.bgPrimary}; border:1px solid #333; border-radius:12px; 
                    padding:30px; width:90%; max-width:450px;">
            <h2 style="margin:0 0 20px 0; color:${colors.cyan};">${isEdit ? '✏️ Edit' : '🏆 New'} Challenge</h2>
            
            <div style="margin-bottom:15px;">
                <label style="display:block; color:${colors.muted}; margin-bottom:5px; font-size:13px;">Challenge Name</label>
                <input type="text" id="challengeName" value="${challenge?.name || ''}" 
                       placeholder="e.g., $25K February Challenge"
                       style="width:100%; padding:12px; background:${colors.bgSecondary}; border:1px solid #333; 
                              border-radius:6px; color:${colors.text}; font-size:14px; box-sizing:border-box;">
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:15px;">
                <div>
                    <label style="display:block; color:${colors.muted}; margin-bottom:5px; font-size:13px;">Goal Amount ($)</label>
                    <input type="number" id="challengeGoal" value="${challenge?.goal || 10000}" 
                           style="width:100%; padding:12px; background:${colors.bgSecondary}; border:1px solid #333; 
                                  border-radius:6px; color:${colors.text}; font-size:14px; box-sizing:border-box;">
                </div>
                <div>
                    <label style="display:block; color:${colors.muted}; margin-bottom:5px; font-size:13px;">Goal Type</label>
                    <select id="challengeGoalType" 
                            style="width:100%; padding:12px; background:${colors.bgSecondary}; border:1px solid #333; 
                                   border-radius:6px; color:${colors.text}; font-size:14px; box-sizing:border-box;">
                        <option value="net_pnl" ${challenge?.goalType === 'net_pnl' ? 'selected' : ''}>Net P&L</option>
                        <option value="premium" ${challenge?.goalType === 'premium' ? 'selected' : ''}>Premium Collected</option>
                        <option value="trades" ${challenge?.goalType === 'trades' ? 'selected' : ''}>Number of Trades</option>
                    </select>
                </div>
            </div>
            
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:25px;">
                <div>
                    <label style="display:block; color:${colors.muted}; margin-bottom:5px; font-size:13px;">Start Date</label>
                    <input type="date" id="challengeStart" value="${challenge?.startDate || today}" 
                           style="width:100%; padding:12px; background:${colors.bgSecondary}; border:1px solid #333; 
                                  border-radius:6px; color:${colors.text}; font-size:14px; box-sizing:border-box;">
                </div>
                <div>
                    <label style="display:block; color:${colors.muted}; margin-bottom:5px; font-size:13px;">End Date</label>
                    <input type="date" id="challengeEnd" value="${challenge?.endDate || endOfMonth}" 
                           style="width:100%; padding:12px; background:${colors.bgSecondary}; border:1px solid #333; 
                                  border-radius:6px; color:${colors.text}; font-size:14px; box-sizing:border-box;">
                </div>
            </div>
            
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button onclick="document.getElementById('challengeModal').remove()" 
                        style="background:#333; border:none; color:${colors.text}; padding:12px 24px; 
                               border-radius:6px; cursor:pointer;">Cancel</button>
                <button onclick="window.saveChallenge(${editId || 'null'})" 
                        style="background:${colors.purple}; border:none; color:${colors.text}; padding:12px 24px; 
                               border-radius:6px; cursor:pointer; font-weight:bold;">
                    ${isEdit ? 'Save Changes' : 'Create Challenge'}
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('challengeName').focus();
};

window.saveChallenge = function(editId) {
    const name = document.getElementById('challengeName').value.trim();
    const goal = parseFloat(document.getElementById('challengeGoal').value);
    const goalType = document.getElementById('challengeGoalType').value;
    const startDate = document.getElementById('challengeStart').value;
    const endDate = document.getElementById('challengeEnd').value;
    
    if (!name) {
        alert('Please enter a challenge name');
        return;
    }
    if (!goal || goal <= 0) {
        alert('Please enter a valid goal amount');
        return;
    }
    if (!startDate || !endDate) {
        alert('Please select start and end dates');
        return;
    }
    if (new Date(endDate) < new Date(startDate)) {
        alert('End date must be after start date');
        return;
    }
    
    if (editId) {
        updateChallenge(editId, { name, goal, goalType, startDate, endDate });
    } else {
        createChallenge({ name, goal, goalType, startDate, endDate });
    }
    
    document.getElementById('challengeModal').remove();
    renderChallenges();
};

window.editChallenge = function(id) {
    window.showCreateChallengeModal(id);
};

window.archiveChallengeUI = function(id) {
    if (confirm('Archive this challenge? You can restore it later.')) {
        archiveChallenge(id);
        renderChallenges();
    }
};

window.unarchiveChallenge = function(id) {
    updateChallenge(id, { status: 'active' });
    renderChallenges();
};

window.deleteChallengeUI = function(id) {
    if (confirm('Delete this challenge permanently? This cannot be undone.')) {
        deleteChallenge(id);
        renderChallenges();
    }
};

// ============ View Challenge Positions ============

window.viewChallengePositions = function(challengeId) {
    const progress = calculateChallengeProgress(challengeId);
    if (!progress) return;
    
    const { challenge, openPositions, closedPositions } = progress;
    
    const modal = document.createElement('div');
    modal.id = 'challengePositionsModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.8); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    
    const renderPositionRow = (pos, isClosed = false) => {
        const premium = (pos.premium || 0) * 100 * (pos.contracts || 1);
        let pnl = premium;
        if (isClosed) {
            const closeCost = (pos.closePrice || 0) * 100 * (pos.contracts || 1);
            pnl = premium - closeCost;
        } else {
            const currentPrice = pos.lastOptionPrice || pos.markedPrice || 0;
            pnl = premium - (currentPrice * 100 * (pos.contracts || 1));
        }
        const pnlColor = pnl >= 0 ? colors.green : colors.red;
        const isTagged = pos.challengeIds?.includes(challengeId);
        
        return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:8px; color:${colors.cyan};">${pos.ticker}</td>
                <td style="padding:8px;">${pos.type?.replace('_', ' ') || 'PUT'}</td>
                <td style="padding:8px; text-align:right;">$${pos.strike}</td>
                <td style="padding:8px; text-align:right;">$${premium.toFixed(0)}</td>
                <td style="padding:8px; text-align:right; color:${pnlColor};">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}</td>
                <td style="padding:8px; text-align:center;">
                    ${isTagged ? `<span style="color:${colors.purple};">🔗 Tagged</span>` : `<span style="color:${colors.muted};">📅 Date</span>`}
                </td>
            </tr>
        `;
    };
    
    modal.innerHTML = `
        <div style="background:${colors.bgPrimary}; border:1px solid #333; border-radius:12px; 
                    padding:30px; width:90%; max-width:700px; max-height:80vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0; color:${colors.cyan};">📊 ${challenge.name}</h2>
                <button onclick="document.getElementById('challengePositionsModal').remove()" 
                        style="background:none; border:none; color:${colors.muted}; font-size:24px; cursor:pointer;">×</button>
            </div>
            
            ${openPositions.length > 0 ? `
                <h3 style="color:${colors.orange}; margin:20px 0 10px;">📋 Open Positions (${openPositions.length})</h3>
                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead>
                        <tr style="color:${colors.muted}; border-bottom:1px solid #333;">
                            <th style="padding:8px; text-align:left;">Ticker</th>
                            <th style="padding:8px; text-align:left;">Type</th>
                            <th style="padding:8px; text-align:right;">Strike</th>
                            <th style="padding:8px; text-align:right;">Premium</th>
                            <th style="padding:8px; text-align:right;">P&L</th>
                            <th style="padding:8px; text-align:center;">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${openPositions.map(p => renderPositionRow(p, false)).join('')}
                    </tbody>
                </table>
            ` : ''}
            
            ${closedPositions.length > 0 ? `
                <h3 style="color:${colors.green}; margin:20px 0 10px;">✅ Closed Positions (${closedPositions.length})</h3>
                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead>
                        <tr style="color:${colors.muted}; border-bottom:1px solid #333;">
                            <th style="padding:8px; text-align:left;">Ticker</th>
                            <th style="padding:8px; text-align:left;">Type</th>
                            <th style="padding:8px; text-align:right;">Strike</th>
                            <th style="padding:8px; text-align:right;">Premium</th>
                            <th style="padding:8px; text-align:right;">P&L</th>
                            <th style="padding:8px; text-align:center;">Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${closedPositions.map(p => renderPositionRow(p, true)).join('')}
                    </tbody>
                </table>
            ` : ''}
            
            ${openPositions.length === 0 && closedPositions.length === 0 ? `
                <div style="text-align:center; padding:40px; color:${colors.muted};">
                    <div style="font-size:32px; margin-bottom:10px;">📭</div>
                    <div>No positions linked to this challenge yet</div>
                    <div style="font-size:12px; margin-top:5px;">Positions opened or closed during the challenge period will appear automatically</div>
                </div>
            ` : ''}
        </div>
    `;
    document.body.appendChild(modal);
};

// ============ Link Positions Modal ============

window.showLinkPositionsModal = function(challengeId) {
    const challenge = state.challenges?.find(c => c.id === challengeId);
    if (!challenge) return;
    
    const allPositions = [...(state.positions || []), ...(state.closedPositions || [])];
    
    const modal = document.createElement('div');
    modal.id = 'linkPositionsModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.8); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    
    modal.innerHTML = `
        <div style="background:${colors.bgPrimary}; border:1px solid #333; border-radius:12px; 
                    padding:30px; width:90%; max-width:600px; max-height:80vh; overflow-y:auto;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0; color:${colors.cyan};">🔗 Link Positions to ${challenge.name}</h2>
                <button onclick="document.getElementById('linkPositionsModal').remove()" 
                        style="background:none; border:none; color:${colors.muted}; font-size:24px; cursor:pointer;">×</button>
            </div>
            
            <div style="color:${colors.muted}; font-size:13px; margin-bottom:15px;">
                ✓ = Position is linked to this challenge. Click to toggle.
            </div>
            
            <div style="max-height:400px; overflow-y:auto;">
                ${allPositions.map(pos => {
                    const isLinked = pos.challengeIds?.includes(challengeId);
                    const isClosed = state.closedPositions?.some(p => p.id === pos.id);
                    return `
                        <div onclick="window.togglePositionLink(${pos.id}, ${challengeId})" 
                             style="display:flex; justify-content:space-between; align-items:center;
                                    padding:12px; margin-bottom:8px; background:${isLinked ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.03)'};
                                    border:1px solid ${isLinked ? colors.purple : 'rgba(255,255,255,0.1)'};
                                    border-radius:8px; cursor:pointer; transition:all 0.2s;">
                            <div>
                                <span style="color:${colors.cyan}; font-weight:bold;">${pos.ticker}</span>
                                <span style="color:${colors.muted}; margin-left:10px;">${pos.type?.replace('_', ' ') || 'PUT'}</span>
                                <span style="color:${colors.muted}; margin-left:10px;">$${pos.strike}</span>
                                ${isClosed ? `<span style="color:${colors.green}; margin-left:10px; font-size:11px;">CLOSED</span>` : ''}
                            </div>
                            <div style="color:${isLinked ? colors.purple : '#555'}; font-size:20px;">
                                ${isLinked ? '✓' : '○'}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            
            <div style="margin-top:20px; text-align:right;">
                <button onclick="document.getElementById('linkPositionsModal').remove()" 
                        style="background:${colors.purple}; border:none; color:${colors.text}; padding:12px 24px; 
                               border-radius:6px; cursor:pointer; font-weight:bold;">Done</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

window.togglePositionLink = function(positionId, challengeId) {
    let pos = state.positions?.find(p => p.id === positionId);
    if (!pos) pos = state.closedPositions?.find(p => p.id === positionId);
    
    if (pos) {
        if (pos.challengeIds?.includes(challengeId)) {
            unlinkPositionFromChallenge(positionId, challengeId);
        } else {
            linkPositionToChallenge(positionId, challengeId);
        }
        // Re-render the modal
        document.getElementById('linkPositionsModal').remove();
        window.showLinkPositionsModal(challengeId);
    }
};

// ============ Quick Link from Portfolio ============

export function showQuickLinkModal(positionId) {
    if (!state.challenges || state.challenges.length === 0) {
        alert('No challenges created yet. Create a challenge first!');
        return;
    }
    
    const pos = state.positions?.find(p => p.id === positionId) || 
                state.closedPositions?.find(p => p.id === positionId);
    if (!pos) return;
    
    const activeChallenges = state.challenges.filter(c => c.status === 'active');
    
    const modal = document.createElement('div');
    modal.id = 'quickLinkModal';
    modal.style.cssText = `
        position:fixed; top:0; left:0; right:0; bottom:0; 
        background:rgba(0,0,0,0.8); display:flex; align-items:center; 
        justify-content:center; z-index:10000;
    `;
    
    modal.innerHTML = `
        <div style="background:${colors.bgPrimary}; border:1px solid #333; border-radius:12px; 
                    padding:25px; width:90%; max-width:400px;">
            <h3 style="margin:0 0 15px 0; color:${colors.cyan};">
                🔗 Link ${pos.ticker} to Challenge
            </h3>
            
            ${activeChallenges.map(c => {
                const isLinked = pos.challengeIds?.includes(c.id);
                return `
                    <div onclick="window.toggleQuickLink(${positionId}, ${c.id})" 
                         style="display:flex; justify-content:space-between; align-items:center;
                                padding:12px; margin-bottom:8px; 
                                background:${isLinked ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.03)'};
                                border:1px solid ${isLinked ? colors.purple : 'rgba(255,255,255,0.1)'};
                                border-radius:8px; cursor:pointer;">
                        <span style="color:${colors.text};">${c.name}</span>
                        <span style="color:${isLinked ? colors.purple : '#555'}; font-size:18px;">
                            ${isLinked ? '✓' : '○'}
                        </span>
                    </div>
                `;
            }).join('')}
            
            <div style="margin-top:15px; text-align:right;">
                <button onclick="document.getElementById('quickLinkModal').remove()" 
                        style="background:#333; border:none; color:${colors.text}; padding:10px 20px; 
                               border-radius:6px; cursor:pointer;">Done</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

window.toggleQuickLink = function(positionId, challengeId) {
    let pos = state.positions?.find(p => p.id === positionId);
    if (!pos) pos = state.closedPositions?.find(p => p.id === positionId);
    
    if (pos) {
        if (pos.challengeIds?.includes(challengeId)) {
            unlinkPositionFromChallenge(positionId, challengeId);
        } else {
            linkPositionToChallenge(positionId, challengeId);
        }
        // Re-render
        document.getElementById('quickLinkModal').remove();
        showQuickLinkModal(positionId);
    }
};

// Make showQuickLinkModal available globally
window.showQuickLinkModal = showQuickLinkModal;

// Initialize on load
export function initChallenges() {
    loadChallenges();
}
