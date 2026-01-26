/**
 * Date Helpers - Date parsing and formatting utilities for options trading
 * Extracted from server.js for modularity
 */

/**
 * Convert any expiry format to "Mon DD" or "Mon DD, YYYY" format for CBOE lookup
 * For LEAPS (1+ year out), we preserve the year so CBOE can find the correct chain
 * @param {string} expiry - Date in various formats
 * @returns {string|null} Formatted date for CBOE API
 */
function formatExpiryForCBOE(expiry) {
    if (!expiry) return null;
    
    const currentYear = new Date().getFullYear();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // ISO format: 2026-02-20 or 2028-01-21
    const isoMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = months[parseInt(isoMatch[2]) - 1];
        const day = parseInt(isoMatch[3]);
        // If it's a LEAPS (more than 1 year out), include the year
        if (year > currentYear) {
            return `${month} ${day}, ${year}`;
        }
        return `${month} ${day}`;
    }
    
    // US format: 1/21/28 or 1/21/2028
    const usMatch = expiry.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (usMatch) {
        const month = months[parseInt(usMatch[1]) - 1];
        const day = parseInt(usMatch[2]);
        let year = parseInt(usMatch[3]);
        if (year < 100) year += 2000; // 28 -> 2028
        if (year > currentYear) {
            return `${month} ${day}, ${year}`;
        }
        return `${month} ${day}`;
    }
    
    // Already in "Mon DD" format? Check if there's a year
    const shortMatch = expiry.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)$/i);
    if (shortMatch) return expiry;
    
    // "Mon DD, YYYY" format - preserve year if future
    const longMatch = expiry.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+),?\s*(\d{4})?/i);
    if (longMatch) {
        const year = longMatch[3] ? parseInt(longMatch[3]) : currentYear;
        if (year > currentYear) {
            return `${longMatch[1]} ${parseInt(longMatch[2])}, ${year}`;
        }
        return `${longMatch[1]} ${parseInt(longMatch[2])}`;
    }
    
    // Full month name: "February 20, 2028" or "February 20"
    const fullMonthMatch = expiry.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d+),?\s*(\d{4})?/i);
    if (fullMonthMatch) {
        const shortMonths = { January: 'Jan', February: 'Feb', March: 'Mar', April: 'Apr', May: 'May', June: 'Jun',
                             July: 'Jul', August: 'Aug', September: 'Sep', October: 'Oct', November: 'Nov', December: 'Dec' };
        const year = fullMonthMatch[3] ? parseInt(fullMonthMatch[3]) : currentYear;
        if (year > currentYear) {
            return `${shortMonths[fullMonthMatch[1]]} ${parseInt(fullMonthMatch[2])}, ${year}`;
        }
        return `${shortMonths[fullMonthMatch[1]]} ${parseInt(fullMonthMatch[2])}`;
    }
    
    console.log(`[CBOE] Could not parse expiry format: ${expiry}`);
    return expiry; // Return as-is, let the caller handle it
}

/**
 * Parse expiry string to Date object for DTE calculation
 * Handles various formats: "Jan 23", "2026-02-20", "Feb 20, 2026", "2/27/26"
 * @param {string} expiry - Date in various formats
 * @returns {Date|null} Parsed Date object
 */
function parseExpiryDate(expiry) {
    if (!expiry) return null;
    
    const currentYear = new Date().getFullYear();
    const monthMap = { 
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
        january: 0, february: 1, march: 2, april: 3, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    
    // ISO format: 2026-02-20
    const isoMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
    }
    
    // US format: 2/27/26 or 2/27/2026
    const usMatch = expiry.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (usMatch) {
        let year = parseInt(usMatch[3]);
        if (year < 100) year += 2000; // 26 -> 2026
        return new Date(year, parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
    }
    
    // "Mon DD" or "Mon DD, YYYY" format
    const monthDayMatch = expiry.match(/^([A-Za-z]+)\s+(\d+),?\s*(\d{4})?/);
    if (monthDayMatch) {
        const month = monthMap[monthDayMatch[1].toLowerCase()];
        if (month !== undefined) {
            const day = parseInt(monthDayMatch[2]);
            const year = monthDayMatch[3] ? parseInt(monthDayMatch[3]) : currentYear;
            const date = new Date(year, month, day);
            // If date is in the past and no year specified, assume next year
            if (!monthDayMatch[3] && date < new Date()) {
                date.setFullYear(date.getFullYear() + 1);
            }
            return date;
        }
    }
    
    console.log(`[DTE] Could not parse expiry for DTE: ${expiry}`);
    return null;
}

/**
 * Calculate Days To Expiration from an expiry string
 * @param {string} expiry - Date in various formats
 * @returns {number|null} Days until expiration
 */
function calculateDTE(expiry) {
    const expiryDate = parseExpiryDate(expiry);
    if (!expiryDate) return null;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expiryDate.setHours(0, 0, 0, 0);
    
    const diffMs = expiryDate - today;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

module.exports = {
    formatExpiryForCBOE,
    parseExpiryDate,
    calculateDTE
};
