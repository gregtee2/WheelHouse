/**
 * Streaming Routes - WebSocket client to Python streamer
 * 
 * This module connects to the Python streaming service and broadcasts
 * real-time option quotes to browser clients via Socket.IO.
 */

const WebSocket = require('ws');

// Configuration
const STREAMER_HOST = process.env.STREAMER_HOST || 'localhost';
const STREAMER_PORT = process.env.STREAMER_PORT || 8889;
const RECONNECT_INTERVAL = 5000; // 5 seconds
const HEALTH_CHECK_INTERVAL = 15000; // 15 seconds - check connection health
const MAX_SILENCE_BEFORE_RECONNECT = 60000; // 60 seconds - force reconnect if no messages

// State
let streamerSocket = null;
let isConnecting = false;
let reconnectTimer = null;
let healthCheckTimer = null;
let io = null; // Socket.IO server reference

// Stats
const stats = {
    connected: false,
    lastMessage: null,
    messagesReceived: 0,
    quotesReceived: 0,
    subscribedSymbols: [],
    reconnectAttempts: 0,
    lastDisconnectReason: null,
    totalDisconnects: 0
};

/**
 * Connect to Python streamer WebSocket
 */
function connectToStreamer() {
    if (isConnecting || (streamerSocket && streamerSocket.readyState === WebSocket.OPEN)) {
        return;
    }
    
    isConnecting = true;
    const url = `ws://${STREAMER_HOST}:${STREAMER_PORT}`;
    
    console.log(`[STREAMER] Connecting to ${url}...`);
    
    try {
        streamerSocket = new WebSocket(url);
        
        streamerSocket.on('open', () => {
            isConnecting = false;
            stats.connected = true;
            stats.reconnectAttempts = 0;
            console.log(`[STREAMER] ✓ Connected to Python streamer`);
            
            // Request current status
            sendToStreamer({ command: 'get_status' });
            
            // Broadcast to browsers that streaming is available
            if (io) {
                io.emit('streamer-status', { connected: true });
            }
        });
        
        streamerSocket.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                stats.messagesReceived++;
                stats.lastMessage = new Date().toISOString();
                
                handleStreamerMessage(message);
            } catch (e) {
                console.error('[STREAMER] Error parsing message:', e.message);
            }
        });
        
        streamerSocket.on('close', (code, reason) => {
            isConnecting = false;
            stats.connected = false;
            stats.lastDisconnectReason = `close_code_${code}`;
            const reasonStr = reason ? reason.toString() : 'unknown';
            console.log(`[STREAMER] Disconnected from Python streamer (code: ${code}, reason: ${reasonStr})`);
            
            if (io) {
                io.emit('streamer-status', { connected: false, disconnectReason: stats.lastDisconnectReason });
            }
            
            // Schedule reconnect
            scheduleReconnect();
        });
        
        streamerSocket.on('error', (error) => {
            isConnecting = false;
            stats.connected = false;
            // Don't log ECONNREFUSED spam - streamer may not be running
            if (error.code !== 'ECONNREFUSED') {
                console.error('[STREAMER] WebSocket error:', error.message);
            }
        });
        
    } catch (e) {
        isConnecting = false;
        console.error('[STREAMER] Connection error:', e.message);
        scheduleReconnect();
    }
}

/**
 * Schedule reconnection attempt
 */
function scheduleReconnect() {
    if (reconnectTimer) return;
    
    stats.reconnectAttempts++;
    stats.totalDisconnects++;
    const delay = Math.min(RECONNECT_INTERVAL * stats.reconnectAttempts, 60000);
    
    console.log(`[STREAMER] Scheduling reconnect in ${delay/1000}s (attempt ${stats.reconnectAttempts}, total disconnects: ${stats.totalDisconnects})`);
    
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToStreamer();
    }, delay);
}

/**
 * Check connection health - force reconnect if silent too long
 */
function checkConnectionHealth() {
    if (!stats.connected) return;
    
    const now = Date.now();
    const lastMsg = stats.lastMessage ? new Date(stats.lastMessage).getTime() : 0;
    const silenceMs = now - lastMsg;
    
    if (silenceMs > MAX_SILENCE_BEFORE_RECONNECT) {
        console.log(`[STREAMER] ⚠️ No messages for ${Math.round(silenceMs/1000)}s - forcing reconnect`);
        stats.lastDisconnectReason = 'silence_timeout';
        
        // Force close and reconnect
        if (streamerSocket) {
            try {
                streamerSocket.close();
            } catch (e) {}
        }
        stats.connected = false;
        scheduleReconnect();
    }
}

/**
 * Send command to Python streamer
 */
function sendToStreamer(message) {
    if (streamerSocket && streamerSocket.readyState === WebSocket.OPEN) {
        const msgStr = JSON.stringify(message);
        console.log(`[STREAMER] → Python: ${message.command || message.type}`);
        streamerSocket.send(msgStr);
        return true;
    }
    console.log(`[STREAMER] Cannot send to Python (not connected): ${message.command || message.type}`);
    return false;
}

/**
 * Handle message from Python streamer
 */
function handleStreamerMessage(message) {
    const { type, data, timestamp } = message;
    
    // Skip if no type
    if (!type) {
        console.log('[STREAMER] Ignoring message without type');
        return;
    }
    
    switch (type) {
        case 'option_quote':
            stats.quotesReceived++;
            // Broadcast to all connected browsers
            if (io) {
                io.emit('option-quote', {
                    ...data,
                    serverTimestamp: timestamp
                });
            }
            break;
            
        case 'equity_quote':
            if (io) {
                io.emit('equity-quote', {
                    ...data,
                    serverTimestamp: timestamp
                });
            }
            break;
            
        case 'futures_quote':
            if (io) {
                io.emit('futures-quote', {
                    ...data,
                    serverTimestamp: timestamp
                });
            }
            break;
            
        case 'account_activity':
            if (io) {
                io.emit('account-activity', data);
            }
            break;
            
        case 'status':
            stats.subscribedSymbols = data?.subscribed_options || [];
            if (io) {
                io.emit('streamer-status', {
                    connected: true,
                    subscribedOptions: data?.subscribed_options || [],
                    subscribedEquities: data?.subscribed_equities || [],
                    subscribedFutures: data?.subscribed_futures || []
                });
            }
            break;
            
        case 'heartbeat':
            // Just update stats, no broadcast needed
            break;
            
        case 'pong':
            // Response to ping
            break;
            
        default:
            console.log(`[STREAMER] Unknown message type: ${type}`);
    }
}

/**
 * Subscribe to option symbols
 * @param {string[]} symbols - OCC format option symbols
 */
function subscribeOptions(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return false;
    return sendToStreamer({ command: 'subscribe_options', symbols });
}

/**
 * Subscribe to equity symbols
 * @param {string[]} symbols - Stock tickers
 */
function subscribeEquities(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return false;
    return sendToStreamer({ command: 'subscribe_equities', symbols });
}

/**
 * Unsubscribe from option symbols
 */
function unsubscribeOptions(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return false;
    return sendToStreamer({ command: 'unsubscribe_options', symbols });
}

/**
 * Subscribe to futures symbols
 * @param {string[]} symbols - Futures symbols (e.g., /ES, /NQ, /YM, /RTY)
 */
function subscribeFutures(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return false;
    return sendToStreamer({ command: 'subscribe_futures', symbols });
}

/**
 * Unsubscribe from futures symbols
 */
function unsubscribeFutures(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return false;
    return sendToStreamer({ command: 'unsubscribe_futures', symbols });
}

/**
 * Get current stats
 */
function getStats() {
    return { ...stats };
}

/**
 * Convert position to OCC symbol (mirrors Python occ_converter.py)
 */
function positionToOCC(ticker, expiry, strike, optionType) {
    // Pad ticker to 6 characters
    const paddedTicker = ticker.toUpperCase().padEnd(6, ' ');
    
    // Parse expiry (YYYY-MM-DD)
    const expDate = new Date(expiry + 'T00:00:00');
    const yy = String(expDate.getFullYear()).slice(-2);
    const mm = String(expDate.getMonth() + 1).padStart(2, '0');
    const dd = String(expDate.getDate()).padStart(2, '0');
    const dateStr = `${yy}${mm}${dd}`;
    
    // Put or Call
    const pc = optionType.toLowerCase().includes('put') ? 'P' : 'C';
    
    // Strike: multiply by 1000, pad to 8 digits
    const strikeInt = Math.round(strike * 1000);
    const strikeStr = String(strikeInt).padStart(8, '0');
    
    return `${paddedTicker}${dateStr}${pc}${strikeStr}`;
}

/**
 * Convert positions array to OCC symbols
 */
function positionsToOCCSymbols(positions) {
    const symbols = [];
    
    for (const pos of positions) {
        try {
            // Skip non-options
            if (!pos.type || pos.type === 'stock' || pos.type === 'holding') continue;
            
            // Handle spreads
            if (pos.type.includes('_spread')) {
                if (pos.buyStrike) {
                    symbols.push(positionToOCC(pos.ticker, pos.expiry, pos.buyStrike, pos.type));
                }
                if (pos.sellStrike) {
                    symbols.push(positionToOCC(pos.ticker, pos.expiry, pos.sellStrike, pos.type));
                }
            } else {
                symbols.push(positionToOCC(pos.ticker, pos.expiry, pos.strike, pos.type));
            }
        } catch (e) {
            console.error(`[STREAMER] Error converting position ${pos.ticker}:`, e.message);
        }
    }
    
    return symbols;
}

/**
 * Initialize streaming routes
 */
function init(deps) {
    const { app, socketIO } = deps;
    io = socketIO;
    
    // API Routes
    app.get('/api/streaming/status', (req, res) => {
        res.json({
            connected: stats.connected,
            messagesReceived: stats.messagesReceived,
            quotesReceived: stats.quotesReceived,
            subscribedSymbols: stats.subscribedSymbols.length,
            lastMessage: stats.lastMessage,
            reconnectAttempts: stats.reconnectAttempts
        });
    });
    
    app.post('/api/streaming/subscribe', (req, res) => {
        const { positions } = req.body;
        
        if (!positions || !Array.isArray(positions)) {
            return res.status(400).json({ error: 'positions array required' });
        }
        
        // Convert positions to OCC symbols
        const occSymbols = positionsToOCCSymbols(positions);
        
        // Also get unique tickers for equity quotes
        const tickers = [...new Set(positions.map(p => p.ticker))];
        
        // Subscribe
        const optionsOk = subscribeOptions(occSymbols);
        const equitiesOk = subscribeEquities(tickers);
        
        res.json({
            success: optionsOk || equitiesOk,
            subscribedOptions: occSymbols.length,
            subscribedEquities: tickers.length,
            streamerConnected: stats.connected
        });
    });
    
    app.post('/api/streaming/unsubscribe', (req, res) => {
        const { symbols } = req.body;
        const ok = unsubscribeOptions(symbols);
        res.json({ success: ok });
    });
    
    app.post('/api/streaming/futures', (req, res) => {
        const { symbols } = req.body;
        
        if (!symbols || !Array.isArray(symbols)) {
            return res.status(400).json({ error: 'symbols array required (e.g., ["/ES", "/NQ"])' });
        }
        
        const ok = subscribeFutures(symbols);
        res.json({
            success: ok,
            subscribedFutures: symbols,
            streamerConnected: stats.connected
        });
    });
    
    // Handle Socket.IO connections for streaming
    if (io) {
        io.on('connection', (socket) => {
            // Send current status to new client
            socket.emit('streamer-status', {
                connected: stats.connected,
                subscribedSymbols: stats.subscribedSymbols
            });
            
            // Handle explicit status request
            socket.on('get-streamer-status', () => {
                socket.emit('streamer-status', {
                    connected: stats.connected,
                    subscribedSymbols: stats.subscribedSymbols
                });
            });
            
            // Handle subscription requests from browser
            socket.on('subscribe-positions', (positions) => {
                console.log(`[STREAMER] Browser requested subscription for ${positions?.length || 0} positions`);
                
                const occSymbols = positionsToOCCSymbols(positions);
                const tickers = [...new Set(positions.map(p => p.ticker))];
                
                console.log(`[STREAMER] OCC symbols: ${occSymbols.slice(0, 3).join(', ')}${occSymbols.length > 3 ? '...' : ''}`);
                console.log(`[STREAMER] Tickers: ${tickers.join(', ')}`);
                
                subscribeOptions(occSymbols);
                subscribeEquities(tickers);
            });
        });
    }
    
    // Start connection to Python streamer
    connectToStreamer();
    
    // Periodic ping to keep connection alive (every 30s)
    setInterval(() => {
        if (stats.connected) {
            sendToStreamer({ command: 'ping' });
        }
    }, 30000);
    
    // Health check - force reconnect if no messages for too long (every 15s)
    setInterval(() => {
        checkConnectionHealth();
    }, HEALTH_CHECK_INTERVAL);
    
    console.log('[STREAMER] Streaming routes initialized');
}

module.exports = {
    init,
    connectToStreamer,
    subscribeOptions,
    subscribeEquities,
    subscribeFutures,
    unsubscribeOptions,
    unsubscribeFutures,
    positionToOCC,
    positionsToOCCSymbols,
    getStats
};
