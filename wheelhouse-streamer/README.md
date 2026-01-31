# WheelHouse Streamer

Real-time Schwab streaming data service for WheelHouse.

## Architecture

```
┌─────────────────┐     WebSocket     ┌─────────────────┐     Socket.IO    ┌─────────────────┐
│  Schwab         │◄─────────────────►│  Python         │◄────────────────►│  Node.js        │
│  Streaming API  │  (schwab-py)      │  Streamer       │  (port 8889)     │  Server         │
│                 │                   │  (this service) │                  │  (port 8888)    │
└─────────────────┘                   └─────────────────┘                  └─────────────────┘
                                                                                    │
                                                                                    │ Socket.IO
                                                                                    ▼
                                                                           ┌─────────────────┐
                                                                           │  Browser        │
                                                                           │  (positions.js) │
                                                                           │  Surgical DOM   │
                                                                           │  updates        │
                                                                           └─────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
# Windows
install.bat

# Or manually
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure Credentials

Create `local_config.json`:

```json
{
  "app_key": "YOUR_SCHWAB_APP_KEY",
  "app_secret": "YOUR_SCHWAB_APP_SECRET"
}
```

You can find these in your Schwab Developer Portal app settings.

### 3. Run

```bash
# Windows
start.bat

# Or manually
python streamer.py
```

## How It Works

1. **Python connects to Schwab** using schwab-py library
2. **Node.js connects to Python** via local WebSocket (port 8889)
3. **Node.js sends position list** to Python
4. **Python subscribes to option quotes** for those positions
5. **Schwab pushes real-time updates** to Python
6. **Python broadcasts to Node.js** which broadcasts to browsers
7. **Browser updates DOM surgically** - no full page refresh!

## Messages

### From Node.js to Streamer

```json
{"command": "subscribe_options", "symbols": ["AAPL  260221P00200000"]}
{"command": "subscribe_equities", "symbols": ["AAPL", "PLTR"]}
{"command": "unsubscribe_options", "symbols": ["..."]}
{"command": "get_status"}
{"command": "ping"}
```

### From Streamer to Node.js

```json
{
  "type": "option_quote",
  "timestamp": "2026-01-30T10:30:00.000Z",
  "data": {
    "symbol": "AAPL  260221P00200000",
    "bid": 3.50,
    "ask": 3.55,
    "last": 3.52,
    "delta": -0.25,
    "theta": -0.03,
    "iv": 0.32,
    "underlyingPrice": 198.50
  }
}
```

```json
{
  "type": "equity_quote",
  "timestamp": "2026-01-30T10:30:00.000Z",
  "data": {
    "symbol": "AAPL",
    "bid": 198.45,
    "ask": 198.50,
    "last": 198.48,
    "volume": 12345678
  }
}
```

## OCC Symbol Format

Options use OCC standard symbols:

```
AAPL  260221P00200000
│     │     │└── Strike × 1000, padded to 8 digits ($200.00 = 00200000)
│     │     └── P=Put, C=Call
│     └── YYMMDD (Feb 21, 2026)
└── Ticker padded to 6 chars

Examples:
  PLTR  260321C00085000 = PLTR Mar 21 2026 $85 Call
  NVDA  260117P00150500 = NVDA Jan 17 2026 $150.50 Put
```

## Troubleshooting

### "Missing Schwab credentials"
- Create `local_config.json` with your app_key and app_secret

### "Failed to get accounts"
- Your Schwab token may have expired
- Delete `schwab_token.json` and re-authenticate

### "WebSocket connection refused"
- Make sure port 8889 is available
- Check firewall settings

### "No data received"
- Markets may be closed
- Check Schwab streaming API status
