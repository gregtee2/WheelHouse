/**
 * SparkChartService - Tiny inline bar charts for market internals & futures
 * 
 * Collects values over time at configurable intervals and renders
 * mini SVG bar charts next to each indicator tile.
 * 
 * Usage:
 *   SparkChartService.push('$TICK', 345);      // record a value
 *   SparkChartService.render('$TICK', element); // draw bars into element
 */

const MAX_BARS = 20;          // Number of bars to display (last N intervals)
const BUCKET_MS = 2 * 60 * 1000; // 2-minute buckets (~40 min of visible history)
const CHART_W = 72;           // SVG width  (px)
const CHART_H = 22;           // SVG height (px)
const BAR_GAP = 1;            // Gap between bars (px)

// History: symbol → [ { t: timestamp, v: value }, … ]
const history = new Map();

// Per-symbol config for bar coloring
const colorConfigs = {
    // Internals – zero-centred (green > 0, red < 0)
    '$TICK':  { mode: 'zero', accent: '#00c8ff' },
    '$ADD':   { mode: 'zero', accent: '#00ff88' },
    '$VOLD':  { mode: 'zero', accent: '#8b5cf6' },
    // TRIN – centered at 1.0 (deviation: <1 bullish green UP, >1 bearish red DOWN)
    '$TRIN':  { mode: 'trin', accent: '#ffaa00' },
    // VIX – show changes (green = VIX dropping/calmer, red = VIX rising/fear)
    '$VIX':   { mode: 'vix_change', accent: '#ff5252' },
    // Futures – based on net change direction
    '/ES':    { mode: 'change', accent: '#00d9ff' },
    '/NQ':    { mode: 'change', accent: '#8b5cf6' },
    '/YM':    { mode: 'change', accent: '#00ff88' },
    '/RTY':   { mode: 'change', accent: '#ffaa00' },
};

/**
 * Push a new raw sample.  We bucket by BUCKET_MS so that rapid
 * 30-second refreshes are averaged into 15-minute bars.
 */
function push(symbol, value) {
    if (value === null || value === undefined || isNaN(value)) return;

    const now = Date.now();
    const bucketKey = Math.floor(now / BUCKET_MS);

    if (!history.has(symbol)) history.set(symbol, []);
    const arr = history.get(symbol);

    // If latest entry is same bucket → average in
    const last = arr[arr.length - 1];
    if (last && last.bucket === bucketKey) {
        last.count++;
        last.v = last.v + (value - last.v) / last.count; // running mean
    } else {
        arr.push({ bucket: bucketKey, t: now, v: value, count: 1 });
    }

    // Keep only recent buckets
    while (arr.length > MAX_BARS + 2) arr.shift();
}

/**
 * Get the last N completed + current bucket values for a symbol.
 */
function getBars(symbol) {
    const arr = history.get(symbol);
    if (!arr || arr.length === 0) return [];
    return arr.slice(-MAX_BARS).map(b => b.v);
}

/**
 * Choose bar fill based on value and symbol mode.
 */
function barColor(symbol, value) {
    const cfg = colorConfigs[symbol] || { mode: 'zero', accent: '#00d9ff' };

    switch (cfg.mode) {
        case 'zero':
            return value >= 0 ? '#00ff88' : '#ff5252';
        case 'trin':
            // Centered at 1.0: below 1 = bullish (green), above 1 = bearish (red)
            return value <= 0 ? '#00ff88' : '#ff5252';
        case 'vix_change':
            // Change-based: negative change = VIX dropping (green/calm)
            return value <= 0 ? '#00ff88' : '#ff5252';
        case 'change':
            return value >= 0 ? '#00ff88' : '#ff5252';
        default:
            return cfg.accent;
    }
}

/**
 * Render an inline SVG bar chart into a container element.
 * For 'change' mode (futures), bars represent price changes between buckets.
 */
function render(symbol, container) {
    if (!container) return;

    let values = getBars(symbol);
    const cfg = colorConfigs[symbol] || { mode: 'zero' };

    // Change/delta modes need at least 2 values (to compute deltas);
    // other modes can render with just 1
    const minRequired = (cfg.mode === 'change' || cfg.mode === 'vix_change') ? 2 : 1;
    if (values.length < minRequired) {
        // Not enough data yet – show placeholder
        container.innerHTML = `<svg width="${CHART_W}" height="${CHART_H}" style="opacity:0.3">
            <rect x="0" y="${CHART_H - 3}" width="${CHART_W}" height="1" fill="#555" rx="0.5"/>
        </svg>`;
        return;
    }

    // For futures ('change' mode), convert absolute prices to deltas
    // For VIX ('vix_change'), also use deltas (green = dropping, red = rising)
    // For TRIN, center at 1.0 (subtract 1.0 so deviation shows as pos/neg)
    let barValues;
    if (cfg.mode === 'change' || cfg.mode === 'vix_change') {
        barValues = [];
        for (let i = 1; i < values.length; i++) {
            barValues.push(values[i] - values[i - 1]);
        }
    } else if (cfg.mode === 'trin') {
        // Center at 1.0: values > 1.0 become positive (bearish), < 1.0 become negative (bullish)
        barValues = values.map(v => v - 1.0);
    } else {
        barValues = values;
    }

    if (barValues.length === 0) return;

    const n = barValues.length;
    const barW = Math.max(2, (CHART_W - (n - 1) * BAR_GAP) / n);
    const maxAbs = Math.max(...barValues.map(v => Math.abs(v)), 0.0001);

    // Build SVG bars
    const midY = CHART_H / 2;
    const halfH = midY - 1; // leave 1px margin

    let bars = '';
    for (let i = 0; i < n; i++) {
        const v = barValues[i];
        const fill = barColor(symbol, v);

        // For zero-centred modes, bars go up (positive) or down (negative) from midY
        // For TRIN/VIX, still use midY but threshold determines color
        const normH = Math.max(1, (Math.abs(v) / maxAbs) * halfH);
        const x = i * (barW + BAR_GAP);

        let y;
        if (v >= 0) {
            y = midY - normH;
        } else {
            y = midY;
        }
        bars += `<rect x="${x}" y="${y}" width="${barW}" height="${normH}" fill="${fill}" rx="0.5" opacity="0.85"/>`;
    }

    // Centre line for all zero-centred modes
    let centerLine = '';
    if (cfg.mode === 'zero' || cfg.mode === 'change' || cfg.mode === 'trin' || cfg.mode === 'vix_change') {
        centerLine = `<line x1="0" y1="${midY}" x2="${CHART_W}" y2="${midY}" stroke="#555" stroke-width="0.5"/>`;
    }

    container.innerHTML = `<svg width="${CHART_W}" height="${CHART_H}" style="vertical-align:middle">${centerLine}${bars}</svg>`;
}

/**
 * Convenience: push + render for an internal tile
 */
function update(symbol, value) {
    push(symbol, value);
    const container = document.querySelector(`[data-spark="${symbol}"]`);
    render(symbol, container);
}

/**
 * Clear history for a symbol (or all)
 */
function clear(symbol) {
    if (symbol) {
        history.delete(symbol);
    } else {
        history.clear();
    }
}

/**
 * Seed initial data from Schwab candles (optional enhancement).
 * For now we just collect data from the live refresh cycle.
 */
function seed(symbol, dataPoints) {
    if (!dataPoints || dataPoints.length === 0) return;
    if (!history.has(symbol)) history.set(symbol, []);
    const arr = history.get(symbol);
    for (const { t, v } of dataPoints) {
        const bucketKey = Math.floor(t / BUCKET_MS);
        arr.push({ bucket: bucketKey, t, v, count: 1 });
    }
    while (arr.length > MAX_BARS + 2) arr.shift();
}

const SparkChartService = { push, render, update, clear, seed, getBars, history };

export default SparkChartService;
