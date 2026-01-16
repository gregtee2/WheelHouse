/**
 * Broker Import Utility
 * Converts broker transaction exports to WheelHouse format
 * 
 * Currently supports: Schwab
 */

// Local notification helper (fallback if global not available)
function brokerNotify(message, type = 'info') {
    if (window.showNotification) {
        window.brokerNotify(message, type);
    } else {
        // Simple fallback
        const color = type === 'error' ? '#ff5252' : type === 'success' ? '#00ff88' : '#00d9ff';
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
            background: #1a1a2e; color: ${color}; border: 1px solid ${color};
            border-radius: 8px; z-index: 10001; font-size: 14px;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}

/**
 * Parse Schwab symbol format: "HIMS 01/23/2026 31.50 P"
 * Returns: { ticker, expiry, strike, optionType }
 */
function parseSchwabSymbol(symbol) {
    // Format: "TICKER MM/DD/YYYY STRIKE P/C"
    const match = symbol.match(/^(\w+)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d.]+)\s+(P|C)$/);
    if (!match) return null;
    
    const [, ticker, dateStr, strikeStr, optionType] = match;
    
    // Convert MM/DD/YYYY to YYYY-MM-DD
    const [month, day, year] = dateStr.split('/');
    const expiry = `${year}-${month}-${day}`;
    
    return {
        ticker,
        expiry,
        strike: parseFloat(strikeStr),
        optionType: optionType === 'P' ? 'put' : 'call'
    };
}

/**
 * Parse Schwab date format: "01/15/2026" to "2026-01-15"
 */
function parseSchwabDate(dateStr) {
    const [month, day, year] = dateStr.split('/');
    return `${year}-${month}-${day}`;
}

/**
 * Parse Schwab price: "$1.24" to 1.24
 */
function parseSchwabPrice(priceStr) {
    if (!priceStr) return 0;
    return parseFloat(priceStr.replace(/[$,]/g, '')) || 0;
}

/**
 * Parse Schwab amount: "$370.01" or "-$208.98" to number
 */
function parseSchwabAmount(amountStr) {
    if (!amountStr) return 0;
    const negative = amountStr.includes('-');
    const value = parseFloat(amountStr.replace(/[-$,]/g, '')) || 0;
    return negative ? -value : value;
}

/**
 * Convert Schwab transactions to WheelHouse format
 * @param {Object} schwabData - Raw Schwab JSON export
 * @returns {Object} WheelHouse import format
 */
function convertSchwabToWheelHouse(schwabData) {
    const transactions = schwabData.BrokerageTransactions || [];
    
    // Filter to only option transactions (Sell to Open, Buy to Close, etc.)
    const optionActions = ['Sell to Open', 'Buy to Open', 'Buy to Close', 'Sell to Close', 'Assigned', 'Expired'];
    const optionTxns = transactions.filter(t => optionActions.includes(t.Action));
    
    // Group by symbol to match opens with closes
    const bySymbol = {};
    
    optionTxns.forEach(txn => {
        const symbolInfo = parseSchwabSymbol(txn.Symbol);
        if (!symbolInfo) return;
        
        const key = txn.Symbol; // Use full symbol as key
        if (!bySymbol[key]) {
            bySymbol[key] = { opens: [], closes: [] };
        }
        
        const parsed = {
            date: parseSchwabDate(txn.Date),
            action: txn.Action,
            quantity: parseInt(txn.Quantity),
            price: parseSchwabPrice(txn.Price),
            amount: parseSchwabAmount(txn.Amount),
            fees: parseSchwabPrice(txn.Fees),
            ...symbolInfo
        };
        
        if (txn.Action === 'Sell to Open' || txn.Action === 'Buy to Open') {
            bySymbol[key].opens.push(parsed);
        } else {
            bySymbol[key].closes.push(parsed);
        }
    });
    
    // Build positions
    const openPositions = [];
    const closedPositions = [];
    let idCounter = Date.now();
    
    Object.entries(bySymbol).forEach(([symbol, { opens, closes }]) => {
        // Sort by date
        opens.sort((a, b) => a.date.localeCompare(b.date));
        closes.sort((a, b) => a.date.localeCompare(b.date));
        
        // Match opens with closes (FIFO)
        let openIdx = 0;
        let closeIdx = 0;
        let remainingOpenQty = opens[0]?.quantity || 0;
        
        while (openIdx < opens.length) {
            const open = opens[openIdx];
            
            if (closeIdx < closes.length) {
                const close = closes[closeIdx];
                
                // Determine position type
                const isShort = open.action === 'Sell to Open';
                const type = isShort 
                    ? (open.optionType === 'put' ? 'short_put' : 'short_call')
                    : (open.optionType === 'put' ? 'long_put' : 'long_call');
                
                // Calculate P&L for short positions: (open premium - close price) * 100 * contracts
                // For short: positive if close < open (kept premium)
                const contracts = Math.min(remainingOpenQty, close.quantity);
                const pnl = isShort 
                    ? (open.price - close.price) * 100 * contracts
                    : (close.price - open.price) * 100 * contracts;
                
                closedPositions.push({
                    id: idCounter++,
                    ticker: open.ticker,
                    type,
                    strike: open.strike,
                    premium: open.price,
                    contracts,
                    expiry: open.expiry,
                    openDate: open.date,
                    closeDate: close.date,
                    closePrice: close.price,
                    closePnL: Math.round(pnl),
                    closeReason: close.action,
                    broker: 'Schwab',
                    status: 'closed'
                });
                
                remainingOpenQty -= contracts;
                if (remainingOpenQty <= 0) {
                    openIdx++;
                    remainingOpenQty = opens[openIdx]?.quantity || 0;
                }
                closeIdx++;
            } else {
                // No matching close - position is still open
                const isShort = open.action === 'Sell to Open';
                const type = isShort 
                    ? (open.optionType === 'put' ? 'short_put' : 'short_call')
                    : (open.optionType === 'put' ? 'long_put' : 'long_call');
                
                openPositions.push({
                    id: idCounter++,
                    ticker: open.ticker,
                    type,
                    strike: open.strike,
                    premium: open.price,
                    contracts: remainingOpenQty,
                    expiry: open.expiry,
                    openDate: open.date,
                    broker: 'Schwab',
                    status: 'open'
                });
                
                openIdx++;
                remainingOpenQty = opens[openIdx]?.quantity || 0;
            }
        }
    });
    
    // Sort by date
    openPositions.sort((a, b) => b.openDate.localeCompare(a.openDate));
    closedPositions.sort((a, b) => b.closeDate.localeCompare(a.closeDate));
    
    return {
        version: 1,
        exportDate: new Date().toISOString(),
        source: 'Schwab Import',
        positions: openPositions,
        holdings: [],
        closedPositions
    };
}

/**
 * Show broker import modal
 */
function showBrokerImportModal() {
    // Remove existing modal if any
    const existing = document.getElementById('brokerImportModal');
    if (existing) existing.remove();
    
    const modal = document.createElement('div');
    modal.id = 'brokerImportModal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.8); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
    `;
    
    modal.innerHTML = `
        <div style="background:#1a1a2e; border-radius:12px; padding:24px; width:600px; max-width:90vw; max-height:80vh; overflow:auto;">
            <h2 style="margin:0 0 16px; color:#00d9ff;">📥 Import from Broker</h2>
            
            <div style="margin-bottom:16px;">
                <label style="color:#888; display:block; margin-bottom:8px;">Select Broker:</label>
                <select id="brokerSelect" style="width:100%; padding:8px; font-size:14px; background:#0d0d1a; color:#fff; border:1px solid #333; border-radius:6px;">
                    <option value="schwab">Charles Schwab</option>
                    <option value="tda" disabled>TD Ameritrade (coming soon)</option>
                    <option value="fidelity" disabled>Fidelity (coming soon)</option>
                    <option value="etrade" disabled>E*TRADE (coming soon)</option>
                </select>
            </div>
            
            <div style="margin-bottom:16px;">
                <label style="color:#888; display:block; margin-bottom:8px;">Paste JSON or select file:</label>
                <textarea id="brokerJsonInput" placeholder="Paste your broker's JSON export here..." 
                    style="width:100%; height:150px; padding:8px; font-family:monospace; font-size:12px; 
                           background:#0d0d1a; color:#fff; border:1px solid #333; border-radius:6px; resize:vertical;"></textarea>
            </div>
            
            <div style="margin-bottom:16px;">
                <input type="file" id="brokerFileInput" accept=".json" style="display:none;">
                <button onclick="document.getElementById('brokerFileInput').click()" 
                    style="padding:8px 16px; background:#333; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                    📁 Choose File
                </button>
                <span id="brokerFileName" style="color:#888; margin-left:10px;"></span>
            </div>
            
            <div id="brokerPreview" style="display:none; margin-bottom:16px; padding:12px; background:#0d0d1a; border-radius:6px;">
                <h4 style="margin:0 0 8px; color:#00ff88;">Preview:</h4>
                <div id="brokerPreviewContent" style="color:#ccc; font-size:13px;"></div>
            </div>
            
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button onclick="document.getElementById('brokerImportModal').remove()" 
                    style="padding:10px 20px; background:#333; color:#fff; border:none; border-radius:6px; cursor:pointer;">
                    Cancel
                </button>
                <button id="brokerParseBtn" onclick="parseBrokerData()" 
                    style="padding:10px 20px; background:#00d9ff; color:#000; border:none; border-radius:6px; cursor:pointer; font-weight:bold;">
                    Parse Data
                </button>
                <button id="brokerImportBtn" onclick="importParsedBrokerData()" disabled
                    style="padding:10px 20px; background:#00ff88; color:#000; border:none; border-radius:6px; cursor:pointer; font-weight:bold; opacity:0.5;">
                    Import
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // File input handler
    document.getElementById('brokerFileInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            document.getElementById('brokerFileName').textContent = file.name;
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('brokerJsonInput').value = ev.target.result;
            };
            reader.readAsText(file);
        }
    });
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

// Store parsed data for import
let parsedBrokerData = null;

/**
 * Parse the broker data and show preview
 */
function parseBrokerData() {
    const jsonText = document.getElementById('brokerJsonInput').value.trim();
    const broker = document.getElementById('brokerSelect').value;
    
    if (!jsonText) {
        brokerNotify('Please paste or select a file first', 'error');
        return;
    }
    
    try {
        const rawData = JSON.parse(jsonText);
        
        // Convert based on broker
        if (broker === 'schwab') {
            parsedBrokerData = convertSchwabToWheelHouse(rawData);
        } else {
            brokerNotify('Broker not yet supported', 'error');
            return;
        }
        
        // Show preview
        const previewDiv = document.getElementById('brokerPreview');
        const contentDiv = document.getElementById('brokerPreviewContent');
        
        const openCount = parsedBrokerData.positions.length;
        const closedCount = parsedBrokerData.closedPositions.length;
        const totalPnL = parsedBrokerData.closedPositions.reduce((sum, p) => sum + (p.closePnL || 0), 0);
        
        contentDiv.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div>
                    <div style="color:#00ff88; font-size:16px; font-weight:bold;">${openCount}</div>
                    <div style="color:#888; font-size:11px;">Open Positions</div>
                </div>
                <div>
                    <div style="color:#00d9ff; font-size:16px; font-weight:bold;">${closedCount}</div>
                    <div style="color:#888; font-size:11px;">Closed Positions</div>
                </div>
            </div>
            <div style="margin-top:10px; padding-top:10px; border-top:1px solid #333;">
                <span style="color:#888;">Total Realized P&L:</span>
                <span style="color:${totalPnL >= 0 ? '#00ff88' : '#ff5252'}; font-weight:bold; margin-left:10px;">
                    ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)}
                </span>
            </div>
            ${openCount > 0 ? `
                <div style="margin-top:10px; font-size:11px; color:#888;">
                    <strong>Open:</strong> ${parsedBrokerData.positions.map(p => p.ticker).join(', ')}
                </div>
            ` : ''}
        `;
        
        previewDiv.style.display = 'block';
        
        // Enable import button
        const importBtn = document.getElementById('brokerImportBtn');
        importBtn.disabled = false;
        importBtn.style.opacity = '1';
        
        brokerNotify(`Parsed ${openCount + closedCount} positions`, 'success');
        
    } catch (err) {
        console.error('Parse error:', err);
        brokerNotify('Failed to parse JSON: ' + err.message, 'error');
    }
}

/**
 * Import the parsed broker data
 */
function importParsedBrokerData() {
    if (!parsedBrokerData) {
        brokerNotify('No parsed data to import', 'error');
        return;
    }
    
    // Use the existing import function
    if (window.importAllData) {
        // Create a fake file-like blob for the import function
        const jsonStr = JSON.stringify(parsedBrokerData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const file = new File([blob], 'broker-import.json', { type: 'application/json' });
        
        // Trigger import via file input
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        
        // Read and import directly
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importData = JSON.parse(e.target.result);
                
                // Merge with existing data
                const existingPositions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
                const existingClosed = JSON.parse(localStorage.getItem('wheelhouse_closed_positions') || '[]');
                const existingHoldings = JSON.parse(localStorage.getItem('wheelhouse_holdings') || '[]');
                
                // Add new positions (avoid duplicates by checking ticker+openDate+strike)
                const newPositions = importData.positions.filter(p => 
                    !existingPositions.some(ep => 
                        ep.ticker === p.ticker && ep.openDate === p.openDate && ep.strike === p.strike
                    )
                );
                
                const newClosed = importData.closedPositions.filter(p => 
                    !existingClosed.some(ec => 
                        ec.ticker === p.ticker && ec.openDate === p.openDate && ec.closeDate === p.closeDate && ec.strike === p.strike
                    )
                );
                
                // Save merged data
                const mergedPositions = [...existingPositions, ...newPositions];
                const mergedClosed = [...existingClosed, ...newClosed];
                
                localStorage.setItem('wheelhouse_positions', JSON.stringify(mergedPositions));
                localStorage.setItem('wheelhouse_closed_positions', JSON.stringify(mergedClosed));
                
                // Update state
                if (window.state) {
                    window.state.positions = mergedPositions;
                    window.state.closedPositions = mergedClosed;
                }
                
                // Refresh UI
                if (window.updatePositionsPanel) window.updatePositionsPanel();
                if (window.updatePortfolioDisplay) window.updatePortfolioDisplay();
                
                // Trigger auto-save
                if (window.triggerAutoSave) window.triggerAutoSave();
                
                brokerNotify(`Imported ${newPositions.length} open + ${newClosed.length} closed positions`, 'success');
                
                // Close modal
                document.getElementById('brokerImportModal')?.remove();
                parsedBrokerData = null;
                
            } catch (err) {
                console.error('Import error:', err);
                brokerNotify('Import failed: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }
}

// Export functions to window
window.showBrokerImportModal = showBrokerImportModal;
window.parseBrokerData = parseBrokerData;
window.importParsedBrokerData = importParsedBrokerData;
window.convertSchwabToWheelHouse = convertSchwabToWheelHouse;

console.log('✅ Broker import utility loaded');
