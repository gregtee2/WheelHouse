"""
WheelHouse Streamer Configuration
Reads credentials from parent WheelHouse .env file
"""

import os
import json
from pathlib import Path

# Paths
WHEELHOUSE_ROOT = Path(__file__).parent.parent
ENV_PATH = WHEELHOUSE_ROOT / '.env'
TOKEN_PATH = Path(__file__).parent / 'schwab_token.json'

# WebSocket settings
LOCAL_WS_HOST = 'localhost'
LOCAL_WS_PORT = 8889  # Port to broadcast to Node.js

# Schwab API settings (loaded from .env)
SCHWAB_APP_KEY = ''
SCHWAB_APP_SECRET = ''
SCHWAB_CALLBACK_URL = 'https://127.0.0.1:5556'
SCHWAB_REFRESH_TOKEN = ''

def load_from_env_file():
    """
    Load credentials from WheelHouse's .env file.
    """
    global SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_CALLBACK_URL, SCHWAB_REFRESH_TOKEN
    
    if not ENV_PATH.exists():
        print(f"[CONFIG] .env file not found at {ENV_PATH}")
        return False
    
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip()
                
                if key == 'SCHWAB_APP_KEY':
                    SCHWAB_APP_KEY = value
                elif key == 'SCHWAB_APP_SECRET':
                    SCHWAB_APP_SECRET = value
                elif key == 'SCHWAB_CALLBACK_URL':
                    SCHWAB_CALLBACK_URL = value
                elif key == 'SCHWAB_REFRESH_TOKEN':
                    SCHWAB_REFRESH_TOKEN = value
        
        if SCHWAB_APP_KEY and SCHWAB_APP_SECRET:
            print(f"[CONFIG] Loaded credentials from {ENV_PATH}")
            print(f"[CONFIG] App Key: {SCHWAB_APP_KEY[:8]}...")
            return True
        else:
            print(f"[CONFIG] Missing SCHWAB_APP_KEY or SCHWAB_APP_SECRET in .env")
            return False
            
    except Exception as e:
        print(f"[CONFIG] Error loading .env: {e}")
        return False

def get_credentials():
    """Get Schwab API credentials"""
    load_from_env_file()
    return {
        'app_key': SCHWAB_APP_KEY,
        'app_secret': SCHWAB_APP_SECRET,
        'callback_url': SCHWAB_CALLBACK_URL,
        'refresh_token': SCHWAB_REFRESH_TOKEN,
        'token_path': str(TOKEN_PATH)
    }
