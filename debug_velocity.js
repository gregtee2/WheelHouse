const fs = require('fs');

// Read from example backup if available
const files = fs.readdirSync('examples').filter(f => f.includes('wheelhouse'));
if (files.length === 0) {
    console.log('No backup files found');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync('examples/' + files[0], 'utf8'));
const closed = data.closedPositions || [];

// Filter credit trades
const creditTrades = closed.filter(p => {
    const type = p.type || '';
    return type === 'short_put' || type === 'covered_call' || type === 'buy_write';
});

console.log('Total closed:', closed.length);
console.log('Credit trades:', creditTrades.length);

// Sample first 10
console.log('\nSample trades (first 10):');
creditTrades.slice(0, 10).forEach(p => {
    const pnl = p.realizedPnL ?? p.closePnL ?? 0;
    const capital = (p.strike || 0) * 100 * (p.contracts || 1);
    const days = p.daysHeld || 30;
    console.log(`  ${p.ticker} ${p.type} $${p.strike}: PnL=$${pnl}, Capital=$${capital}, Days=${days}`);
});

// Calculate total
let totalPnL = 0, totalCapitalDays = 0, totalDays = 0;
let winCount = 0, lossCount = 0, totalWins = 0, totalLosses = 0;

creditTrades.forEach(p => {
    const pnl = p.realizedPnL ?? p.closePnL ?? 0;
    const capital = p.type === 'buy_write' ? (p.stockPrice || p.strike || 0) * 100 * (p.contracts || 1) 
                                           : (p.strike || 0) * 100 * (p.contracts || 1);
    const days = p.daysHeld || 30;
    
    totalPnL += pnl;
    totalCapitalDays += capital * days;
    totalDays += days;
    
    if (pnl >= 0) {
        winCount++;
        totalWins += pnl;
    } else {
        lossCount++;
        totalLosses += Math.abs(pnl);
    }
});

console.log('\n--- TOTALS ---');
console.log('Total PnL:', totalPnL.toFixed(2));
console.log('Total Capital-Days:', totalCapitalDays.toFixed(0));
console.log('Avg Days:', (totalDays / creditTrades.length).toFixed(1));
console.log('Daily yield:', (totalPnL / totalCapitalDays * 100).toFixed(4) + '%');
console.log('Monthly yield:', (totalPnL / totalCapitalDays * 30 * 100).toFixed(2) + '%');

console.log('\n--- WIN/LOSS ---');
console.log('Wins:', winCount, 'Total:', totalWins.toFixed(2));
console.log('Losses:', lossCount, 'Total:', totalLosses.toFixed(2));
console.log('Win Rate:', ((winCount / creditTrades.length) * 100).toFixed(1) + '%');

// Find the biggest losers
console.log('\n--- BIGGEST LOSERS (dragging down yield) ---');
const sorted = [...creditTrades].sort((a, b) => (a.realizedPnL ?? a.closePnL ?? 0) - (b.realizedPnL ?? b.closePnL ?? 0));
sorted.slice(0, 5).forEach(p => {
    const pnl = p.realizedPnL ?? p.closePnL ?? 0;
    const capital = (p.strike || 0) * 100 * (p.contracts || 1);
    console.log(`  ${p.ticker} ${p.type} $${p.strike}: PnL=$${pnl}, Capital=$${capital}`);
});

// Check if maybe we should use premium-based yield instead
console.log('\n--- PREMIUM-BASED YIELD (alternative calc) ---');
let totalPremium = 0;
let totalCapital = 0;
creditTrades.forEach(p => {
    const premium = (p.premium || 0) * 100 * (p.contracts || 1);
    const capital = p.type === 'buy_write' ? (p.stockPrice || p.strike || 0) * 100 * (p.contracts || 1) 
                                           : (p.strike || 0) * 100 * (p.contracts || 1);
    totalPremium += premium;
    totalCapital += capital;
});
const avgCapital = totalCapital / creditTrades.length;
const avgDays = totalDays / creditTrades.length;
const tradesPerMonth = 30 / avgDays;
const monthlyPremium = (totalPremium / creditTrades.length) * tradesPerMonth;
const premiumYield = (monthlyPremium / avgCapital) * 100;
console.log('Avg Premium/trade:', (totalPremium / creditTrades.length).toFixed(2));
console.log('Avg Capital/trade:', avgCapital.toFixed(0));
console.log('Trades per month:', tradesPerMonth.toFixed(1));
console.log('Premium-based monthly yield:', premiumYield.toFixed(2) + '%');
