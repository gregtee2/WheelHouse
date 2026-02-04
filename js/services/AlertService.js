/**
 * AlertService.js - Price Alert Management
 * 
 * Manages price alerts with proximity zones for Fibonacci/support levels.
 * Alerts trigger when price enters the zone (not just exact match).
 */

const STORAGE_KEY = 'wheelhouse_price_alerts';
const DEFAULT_PROXIMITY_PERCENT = 3;  // Alert when within 3% of target

class AlertService {
    constructor() {
        this.alerts = [];
        this.triggeredAlerts = new Set();  // Track which alerts fired this session
        this.load();
    }

    /**
     * Load alerts from localStorage
     */
    load() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            this.alerts = saved ? JSON.parse(saved) : [];
            console.log(`[AlertService] Loaded ${this.alerts.length} price alerts`);
        } catch (e) {
            console.error('[AlertService] Load error:', e);
            this.alerts = [];
        }
    }

    /**
     * Save alerts to localStorage
     */
    save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.alerts));
        } catch (e) {
            console.error('[AlertService] Save error:', e);
        }
    }

    /**
     * Add a new price alert
     * @param {Object} alertData - Alert configuration
     * @returns {Object} The created alert
     */
    add(alertData) {
        const alert = {
            id: Date.now(),
            ticker: alertData.ticker.toUpperCase(),
            targetPrice: parseFloat(alertData.targetPrice),
            proximityPercent: alertData.proximityPercent || DEFAULT_PROXIMITY_PERCENT,
            direction: alertData.direction || 'below',  // 'below' for support, 'above' for resistance
            levelName: alertData.levelName || '',       // e.g., "61.8% Fib"
            suggestedStrike: alertData.suggestedStrike || null,
            note: alertData.note || '',
            createdAt: new Date().toISOString(),
            triggered: false,
            triggeredAt: null,
            triggeredPrice: null,
            enabled: true
        };

        this.alerts.push(alert);
        this.save();
        
        console.log(`[AlertService] Added alert: ${alert.ticker} @ $${alert.targetPrice} (±${alert.proximityPercent}%)`);
        return alert;
    }

    /**
     * Remove an alert by ID
     */
    remove(id) {
        const idx = this.alerts.findIndex(a => a.id === id);
        if (idx !== -1) {
            const removed = this.alerts.splice(idx, 1)[0];
            this.save();
            console.log(`[AlertService] Removed alert: ${removed.ticker} @ $${removed.targetPrice}`);
            return true;
        }
        return false;
    }

    /**
     * Get all active (non-triggered) alerts
     */
    getActive() {
        return this.alerts.filter(a => a.enabled && !a.triggered);
    }

    /**
     * Get all alerts (including triggered)
     */
    getAll() {
        return [...this.alerts];
    }

    /**
     * Get alerts for a specific ticker
     */
    getByTicker(ticker) {
        return this.alerts.filter(a => a.ticker === ticker.toUpperCase());
    }

    /**
     * Check if price is within proximity zone of target
     * @returns {Object|null} Alert info if triggered, null otherwise
     */
    checkPrice(ticker, currentPrice) {
        const tickerUpper = ticker.toUpperCase();
        const activeAlerts = this.alerts.filter(a => 
            a.ticker === tickerUpper && 
            a.enabled && 
            !a.triggered &&
            !this.triggeredAlerts.has(a.id)  // Don't re-trigger in same session
        );

        for (const alert of activeAlerts) {
            const proximityAmount = alert.targetPrice * (alert.proximityPercent / 100);
            const lowerBound = alert.targetPrice - proximityAmount;
            const upperBound = alert.targetPrice + proximityAmount;

            let triggered = false;

            if (alert.direction === 'below') {
                // For support levels: alert when price drops INTO the zone
                // (price is at or below upper bound of zone)
                triggered = currentPrice <= upperBound;
            } else {
                // For resistance levels: alert when price rises INTO the zone
                triggered = currentPrice >= lowerBound;
            }

            if (triggered) {
                // Mark as triggered
                alert.triggered = true;
                alert.triggeredAt = new Date().toISOString();
                alert.triggeredPrice = currentPrice;
                this.triggeredAlerts.add(alert.id);
                this.save();

                const distancePercent = ((currentPrice - alert.targetPrice) / alert.targetPrice * 100).toFixed(1);
                console.log(`[AlertService] 🔔 TRIGGERED: ${ticker} @ $${currentPrice} (target: $${alert.targetPrice}, ${distancePercent}% away)`);

                return {
                    alert,
                    currentPrice,
                    distancePercent: Math.abs(parseFloat(distancePercent)),
                    isAboveTarget: currentPrice > alert.targetPrice
                };
            }
        }

        return null;
    }

    /**
     * Reset a triggered alert (re-enable it)
     */
    reset(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.triggered = false;
            alert.triggeredAt = null;
            alert.triggeredPrice = null;
            this.triggeredAlerts.delete(id);
            this.save();
            return true;
        }
        return false;
    }

    /**
     * Toggle alert enabled/disabled
     */
    toggle(id) {
        const alert = this.alerts.find(a => a.id === id);
        if (alert) {
            alert.enabled = !alert.enabled;
            this.save();
            return alert.enabled;
        }
        return null;
    }

    /**
     * Clear all triggered alerts
     */
    clearTriggered() {
        this.alerts = this.alerts.filter(a => !a.triggered);
        this.save();
    }

    /**
     * Calculate the alert zone for display
     */
    static getZone(targetPrice, proximityPercent) {
        const amount = targetPrice * (proximityPercent / 100);
        return {
            lower: (targetPrice - amount).toFixed(2),
            upper: (targetPrice + amount).toFixed(2),
            target: targetPrice.toFixed(2)
        };
    }
}

// Export singleton instance
const alertService = new AlertService();
export default alertService;

// Also attach to window for global access
if (typeof window !== 'undefined') {
    window.AlertService = alertService;
}
