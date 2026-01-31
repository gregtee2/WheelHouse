"""
WheelHouse Streamer - Schwab Real-Time Data Service

This Python service connects to Schwab's streaming API and broadcasts
real-time option quotes to the WheelHouse Node.js server.

Architecture:
  Schwab WebSocket ──► This Service ──► Local WebSocket ──► Node.js Server ──► Browser

Usage:
  python streamer.py

Requirements:
  - Python 3.10+
  - schwab-py library
  - Valid Schwab API credentials
"""

import asyncio
import json
import signal
import sys
from datetime import datetime
from pathlib import Path

try:
    import websockets
    from websockets.server import serve as ws_serve
except ImportError:
    print("ERROR: websockets not installed. Run: pip install websockets")
    sys.exit(1)

try:
    from schwab.auth import easy_client
    from schwab.streaming import StreamClient
except ImportError:
    print("ERROR: schwab-py not installed. Run: pip install schwab-py")
    sys.exit(1)

from config import get_credentials, LOCAL_WS_HOST, LOCAL_WS_PORT, TOKEN_PATH

# Connected browser clients (via Node.js relay)
connected_clients = set()

# Current subscriptions
subscribed_options = set()
subscribed_equities = set()

# Schwab client references
schwab_client = None
stream_client = None

# ============================================================================
# Local WebSocket Server (broadcasts to Node.js)
# ============================================================================

async def handle_node_connection(websocket):
    """Handle connection from Node.js server"""
    connected_clients.add(websocket)
    client_id = id(websocket)
    print(f"[WS] Node.js connected (id={client_id}, total={len(connected_clients)})")
    
    try:
        async for message in websocket:
            # Handle commands from Node.js
            try:
                data = json.loads(message)
                cmd = data.get('command')
                
                if cmd == 'subscribe_options':
                    symbols = data.get('symbols', [])
                    await subscribe_options(symbols)
                    
                elif cmd == 'subscribe_equities':
                    symbols = data.get('symbols', [])
                    await subscribe_equities(symbols)
                    
                elif cmd == 'unsubscribe_options':
                    symbols = data.get('symbols', [])
                    await unsubscribe_options(symbols)
                    
                elif cmd == 'get_status':
                    await websocket.send(json.dumps({
                        'type': 'status',
                        'connected': stream_client is not None,
                        'subscribed_options': list(subscribed_options),
                        'subscribed_equities': list(subscribed_equities)
                    }))
                    
                elif cmd == 'ping':
                    await websocket.send(json.dumps({'type': 'pong'}))
                    
            except json.JSONDecodeError:
                print(f"[WS] Invalid JSON from Node.js: {message[:100]}")
                
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Node.js disconnected (id={client_id}, remaining={len(connected_clients)})")


async def broadcast_to_node(message_type: str, data: dict):
    """Broadcast a message to all connected Node.js servers"""
    if not connected_clients:
        return
    
    message = json.dumps({
        'type': message_type,
        'timestamp': datetime.now().isoformat(),
        'data': data
    })
    
    # Send to all connected clients
    disconnected = set()
    for client in connected_clients:
        try:
            await client.send(message)
        except websockets.exceptions.ConnectionClosed:
            disconnected.add(client)
    
    # Clean up disconnected
    connected_clients.difference_update(disconnected)


# ============================================================================
# Schwab Streaming Handlers
# ============================================================================

async def handle_option_quote(msg):
    """Handle level 1 option quote from Schwab"""
    try:
        for item in msg.get('content', []):
            quote_data = {
                'symbol': item.get('key', item.get('SYMBOL', '')),
                'bid': item.get('BID_PRICE'),
                'ask': item.get('ASK_PRICE'),
                'last': item.get('LAST_PRICE'),
                'bidSize': item.get('BID_SIZE'),
                'askSize': item.get('ASK_SIZE'),
                'volume': item.get('TOTAL_VOLUME'),
                'openInterest': item.get('OPEN_INTEREST'),
                'delta': item.get('DELTA'),
                'gamma': item.get('GAMMA'),
                'theta': item.get('THETA'),
                'vega': item.get('VEGA'),
                'rho': item.get('RHO'),
                'iv': item.get('VOLATILITY'),
                'underlyingPrice': item.get('UNDERLYING_PRICE'),
                'daysToExpiration': item.get('DAYS_TO_EXPIRATION'),
                'timeValue': item.get('TIME_VALUE'),
                'theoreticalValue': item.get('THEORETICAL_OPTION_VALUE'),
                'mark': item.get('MARK'),
                'quoteTime': item.get('QUOTE_TIME_MILLIS'),
                'tradeTime': item.get('TRADE_TIME_MILLIS'),
            }
            
            # Remove None values
            quote_data = {k: v for k, v in quote_data.items() if v is not None}
            
            await broadcast_to_node('option_quote', quote_data)
            
    except Exception as e:
        print(f"[STREAM] Error handling option quote: {e}")


async def handle_equity_quote(msg):
    """Handle level 1 equity quote from Schwab"""
    try:
        for item in msg.get('content', []):
            quote_data = {
                'symbol': item.get('key', item.get('SYMBOL', '')),
                'bid': item.get('BID_PRICE'),
                'ask': item.get('ASK_PRICE'),
                'last': item.get('LAST_PRICE'),
                'bidSize': item.get('BID_SIZE'),
                'askSize': item.get('ASK_SIZE'),
                'volume': item.get('TOTAL_VOLUME'),
                'high': item.get('HIGH_PRICE'),
                'low': item.get('LOW_PRICE'),
                'open': item.get('OPEN_PRICE'),
                'close': item.get('CLOSE_PRICE'),
                'netChange': item.get('NET_CHANGE'),
                'netChangePercent': item.get('NET_CHANGE_PERCENT'),
                'high52Week': item.get('HIGH_PRICE_52_WEEK'),
                'low52Week': item.get('LOW_PRICE_52_WEEK'),
                'mark': item.get('MARK'),
                'quoteTime': item.get('QUOTE_TIME_MILLIS'),
                'tradeTime': item.get('TRADE_TIME_MILLIS'),
            }
            
            # Remove None values
            quote_data = {k: v for k, v in quote_data.items() if v is not None}
            
            await broadcast_to_node('equity_quote', quote_data)
            
    except Exception as e:
        print(f"[STREAM] Error handling equity quote: {e}")


async def handle_account_activity(msg):
    """Handle account activity (order fills, etc.)"""
    try:
        await broadcast_to_node('account_activity', msg)
    except Exception as e:
        print(f"[STREAM] Error handling account activity: {e}")


# ============================================================================
# Subscription Management
# ============================================================================

async def subscribe_options(symbols: list):
    """Subscribe to option quotes"""
    global subscribed_options
    
    if not stream_client:
        print("[STREAM] Not connected, cannot subscribe")
        return
    
    new_symbols = [s for s in symbols if s not in subscribed_options]
    if not new_symbols:
        return
    
    try:
        if subscribed_options:
            # Add to existing subscription
            await stream_client.level_one_option_add(new_symbols)
        else:
            # First subscription
            await stream_client.level_one_option_subs(new_symbols)
        
        subscribed_options.update(new_symbols)
        print(f"[STREAM] Subscribed to options: {new_symbols}")
        
    except Exception as e:
        print(f"[STREAM] Error subscribing to options: {e}")


async def subscribe_equities(symbols: list):
    """Subscribe to equity quotes"""
    global subscribed_equities
    
    if not stream_client:
        print("[STREAM] Not connected, cannot subscribe")
        return
    
    new_symbols = [s for s in symbols if s not in subscribed_equities]
    if not new_symbols:
        return
    
    try:
        if subscribed_equities:
            await stream_client.level_one_equity_add(new_symbols)
        else:
            await stream_client.level_one_equity_subs(new_symbols)
        
        subscribed_equities.update(new_symbols)
        print(f"[STREAM] Subscribed to equities: {new_symbols}")
        
    except Exception as e:
        print(f"[STREAM] Error subscribing to equities: {e}")


async def unsubscribe_options(symbols: list):
    """Unsubscribe from option quotes"""
    global subscribed_options
    
    if not stream_client:
        return
    
    to_remove = [s for s in symbols if s in subscribed_options]
    if not to_remove:
        return
    
    try:
        await stream_client.level_one_option_unsubs(to_remove)
        subscribed_options.difference_update(to_remove)
        print(f"[STREAM] Unsubscribed from options: {to_remove}")
    except Exception as e:
        print(f"[STREAM] Error unsubscribing: {e}")


# ============================================================================
# Main Streaming Loop
# ============================================================================

async def connect_to_schwab():
    """Connect to Schwab and initialize streaming"""
    global schwab_client, stream_client
    
    creds = get_credentials()
    
    if not creds['app_key'] or not creds['app_secret']:
        print("[AUTH] Missing Schwab credentials!")
        print("[AUTH] Create wheelhouse-streamer/local_config.json with:")
        print('  {"app_key": "YOUR_KEY", "app_secret": "YOUR_SECRET"}')
        return False
    
    try:
        print("[AUTH] Connecting to Schwab...")
        
        # Create HTTP client (handles OAuth)
        schwab_client = easy_client(
            api_key=creds['app_key'],
            app_secret=creds['app_secret'],
            callback_url=creds['callback_url'],
            token_path=creds['token_path']
        )
        
        # Get account numbers for streaming
        accounts_resp = schwab_client.get_account_numbers()
        if accounts_resp.status_code != 200:
            print(f"[AUTH] Failed to get accounts: {accounts_resp.status_code}")
            return False
        
        accounts = accounts_resp.json()
        if not accounts:
            print("[AUTH] No accounts found")
            return False
        
        account_id = accounts[0].get('accountNumber')
        print(f"[AUTH] Using account: ...{str(account_id)[-4:]}")
        
        # Create streaming client
        stream_client = StreamClient(schwab_client, account_id=account_id)
        
        # Login to streaming
        print("[STREAM] Logging in to streaming...")
        await stream_client.login()
        print("[STREAM] ✓ Streaming login successful!")
        
        # Register handlers
        stream_client.add_level_one_option_handler(handle_option_quote)
        stream_client.add_level_one_equity_handler(handle_equity_quote)
        stream_client.add_account_activity_handler(handle_account_activity)
        
        return True
        
    except Exception as e:
        print(f"[AUTH] Connection failed: {e}")
        import traceback
        traceback.print_exc()
        return False


async def stream_message_loop():
    """Process incoming stream messages"""
    global stream_client
    
    if not stream_client:
        return
    
    print("[STREAM] Starting message loop...")
    
    try:
        while True:
            await stream_client.handle_message()
    except Exception as e:
        print(f"[STREAM] Message loop error: {e}")
        import traceback
        traceback.print_exc()


async def reconnect_loop():
    """Attempt to reconnect if disconnected"""
    global stream_client
    
    while True:
        if stream_client is None:
            print("[STREAM] Attempting to connect...")
            if await connect_to_schwab():
                # Start message processing
                asyncio.create_task(stream_message_loop())
        
        await asyncio.sleep(30)  # Check every 30 seconds


# ============================================================================
# Main Entry Point
# ============================================================================

async def main():
    print("=" * 60)
    print("  WheelHouse Streamer - Schwab Real-Time Data Service")
    print("=" * 60)
    print(f"  Local WebSocket: ws://{LOCAL_WS_HOST}:{LOCAL_WS_PORT}")
    print("=" * 60)
    
    # Start local WebSocket server for Node.js connections
    print(f"[WS] Starting local WebSocket server on port {LOCAL_WS_PORT}...")
    
    ws_server = await ws_serve(
        handle_node_connection,
        LOCAL_WS_HOST,
        LOCAL_WS_PORT
    )
    print(f"[WS] ✓ WebSocket server running on ws://{LOCAL_WS_HOST}:{LOCAL_WS_PORT}")
    
    # Connect to Schwab
    if await connect_to_schwab():
        # Start message processing
        asyncio.create_task(stream_message_loop())
    else:
        print("[WARN] Failed to connect to Schwab. Will retry...")
    
    # Start reconnection monitor
    asyncio.create_task(reconnect_loop())
    
    # Broadcast status periodically
    async def status_broadcast():
        while True:
            await asyncio.sleep(60)
            await broadcast_to_node('heartbeat', {
                'subscribed_options': len(subscribed_options),
                'subscribed_equities': len(subscribed_equities),
                'clients': len(connected_clients)
            })
    
    asyncio.create_task(status_broadcast())
    
    print("[READY] Streamer is running. Press Ctrl+C to stop.")
    
    # Keep running
    try:
        await asyncio.Future()  # Run forever
    except asyncio.CancelledError:
        pass
    finally:
        ws_server.close()
        await ws_server.wait_closed()


def signal_handler(sig, frame):
    print("\n[EXIT] Shutting down...")
    sys.exit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGINT, signal_handler)
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[EXIT] Interrupted by user")
