"""
Option Symbol Converter

Converts between WheelHouse position format and OCC option symbols
used by Schwab streaming API.

OCC Format: SYMBOL + YYMMDD + C/P + Strike (8 digits, padded)
Example: AAPL  260221C00200000 = AAPL Feb 21 2026 $200 Call

Note: OCC symbols have the ticker padded to 6 characters with spaces.
"""

from datetime import datetime
import re


def position_to_occ(ticker: str, expiry: str, strike: float, option_type: str) -> str:
    """
    Convert WheelHouse position to OCC option symbol.
    
    Args:
        ticker: Stock symbol (e.g., "AAPL")
        expiry: Expiration date as YYYY-MM-DD (e.g., "2026-02-21")
        strike: Strike price (e.g., 200.00)
        option_type: "put", "call", "short_put", "covered_call", etc.
    
    Returns:
        OCC symbol (e.g., "AAPL  260221P00200000")
    """
    # Pad ticker to 6 characters
    padded_ticker = ticker.upper().ljust(6)
    
    # Parse expiry date
    try:
        exp_date = datetime.strptime(expiry, "%Y-%m-%d")
        date_str = exp_date.strftime("%y%m%d")  # YYMMDD
    except ValueError:
        raise ValueError(f"Invalid expiry format: {expiry}, expected YYYY-MM-DD")
    
    # Determine put/call
    opt_type = option_type.lower()
    if 'put' in opt_type:
        pc = 'P'
    elif 'call' in opt_type:
        pc = 'C'
    else:
        raise ValueError(f"Cannot determine put/call from type: {option_type}")
    
    # Format strike: multiply by 1000, pad to 8 digits
    # $200.00 -> 200000 -> 00200000
    strike_int = int(strike * 1000)
    strike_str = str(strike_int).zfill(8)
    
    return f"{padded_ticker}{date_str}{pc}{strike_str}"


def occ_to_position(occ_symbol: str) -> dict:
    """
    Parse OCC option symbol back to position components.
    
    Args:
        occ_symbol: OCC symbol (e.g., "AAPL  260221P00200000")
    
    Returns:
        dict with ticker, expiry, strike, optionType
    """
    # Remove any extra spaces and ensure uppercase
    occ = occ_symbol.upper().strip()
    
    # OCC format: 6 char ticker + 6 char date + 1 char P/C + 8 char strike
    if len(occ) < 21:
        raise ValueError(f"Invalid OCC symbol length: {occ}")
    
    ticker = occ[:6].strip()
    date_str = occ[6:12]
    pc = occ[12]
    strike_str = occ[13:21]
    
    # Parse date (YYMMDD -> YYYY-MM-DD)
    try:
        exp_date = datetime.strptime(date_str, "%y%m%d")
        expiry = exp_date.strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError(f"Invalid date in OCC symbol: {date_str}")
    
    # Parse strike
    strike = int(strike_str) / 1000.0
    
    # Determine option type
    option_type = 'put' if pc == 'P' else 'call'
    
    return {
        'ticker': ticker,
        'expiry': expiry,
        'strike': strike,
        'optionType': option_type,
        'occSymbol': occ_symbol
    }


def positions_to_occ_symbols(positions: list) -> list:
    """
    Convert a list of WheelHouse positions to OCC symbols.
    
    Args:
        positions: List of position dicts with ticker, expiry, strike, type
    
    Returns:
        List of OCC symbols
    """
    symbols = []
    
    for pos in positions:
        try:
            # Skip non-option positions
            if not pos.get('type') or pos.get('type') in ['stock', 'holding']:
                continue
            
            # Handle spreads (have two strikes)
            if '_spread' in pos.get('type', ''):
                # For spreads, subscribe to both legs
                if pos.get('buyStrike'):
                    symbols.append(position_to_occ(
                        pos['ticker'],
                        pos['expiry'],
                        pos['buyStrike'],
                        pos['type']
                    ))
                if pos.get('sellStrike'):
                    symbols.append(position_to_occ(
                        pos['ticker'],
                        pos['expiry'],
                        pos['sellStrike'],
                        pos['type']
                    ))
            else:
                # Single leg option
                symbols.append(position_to_occ(
                    pos['ticker'],
                    pos['expiry'],
                    pos['strike'],
                    pos['type']
                ))
                
        except (ValueError, KeyError) as e:
            print(f"[OCC] Skipping position {pos.get('ticker', '?')}: {e}")
    
    return symbols


# Test
if __name__ == '__main__':
    # Test conversion
    test_cases = [
        ('AAPL', '2026-02-21', 200.0, 'short_put'),
        ('PLTR', '2026-03-21', 85.0, 'covered_call'),
        ('NVDA', '2026-01-17', 150.5, 'put'),
        ('SPY', '2026-06-19', 600.0, 'call'),
    ]
    
    print("Position -> OCC Symbol:")
    for ticker, expiry, strike, opt_type in test_cases:
        occ = position_to_occ(ticker, expiry, strike, opt_type)
        print(f"  {ticker} {expiry} ${strike} {opt_type} -> {occ}")
    
    print("\nOCC Symbol -> Position:")
    test_occ = "AAPL  260221P00200000"
    parsed = occ_to_position(test_occ)
    print(f"  {test_occ} -> {parsed}")
