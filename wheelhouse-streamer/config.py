"""
WheelHouse Streamer Configuration
Reads credentials from parent WheelHouse secure store or environment
"""

import os
import json
from pathlib import Path

# Paths
WHEELHOUSE_ROOT = Path(__file__).parent.parent
SECURE_STORE_PATH = WHEELHOUSE_ROOT / '.secure-store'
TOKEN_PATH = Path(__file__).parent / 'schwab_token.json'

# WebSocket settings
LOCAL_WS_HOST = 'localhost'
LOCAL_WS_PORT = 8889  # Port to broadcast to Node.js

# Schwab API settings (loaded from secure store or env)
SCHWAB_APP_KEY = os.getenv('SCHWAB_APP_KEY', '')
SCHWAB_APP_SECRET = os.getenv('SCHWAB_APP_SECRET', '')
SCHWAB_CALLBACK_URL = os.getenv('SCHWAB_CALLBACK_URL', 'https://127.0.0.1:8182')

def load_from_secure_store():
    """
    Attempt to load credentials from WheelHouse's secure store.
    Falls back to environment variables if not available.
    """
    global SCHWAB_APP_KEY, SCHWAB_APP_SECRET
    
    # The secure store is encrypted, so we'll need the Node.js server
    # to provide credentials via the API instead
    # For now, use environment variables or a local config file
    
    local_config = Path(__file__).parent / 'local_config.json'
    if local_config.exists():
        try:
            with open(local_config) as f:
                config = json.load(f)
                SCHWAB_APP_KEY = config.get('app_key', SCHWAB_APP_KEY)
                SCHWAB_APP_SECRET = config.get('app_secret', SCHWAB_APP_SECRET)
                print(f"[CONFIG] Loaded credentials from local_config.json")
                return True
        except Exception as e:
            print(f"[CONFIG] Error loading local_config.json: {e}")
    
    # Check environment
    if SCHWAB_APP_KEY and SCHWAB_APP_SECRET:
        print(f"[CONFIG] Using credentials from environment variables")
        return True
    
    print(f"[CONFIG] No credentials found. Create local_config.json or set env vars.")
    return False

def get_credentials():
    """Get Schwab API credentials"""
    load_from_secure_store()
    return {
        'app_key': SCHWAB_APP_KEY,
        'app_secret': SCHWAB_APP_SECRET,
        'callback_url': SCHWAB_CALLBACK_URL,
        'token_path': str(TOKEN_PATH)
    }
