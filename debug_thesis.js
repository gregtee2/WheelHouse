// Debug script for INTC thesis persistence issue
// Run this in browser DevTools console after attaching thesis to INTC

console.log('\n=== THESIS PERSISTENCE DEBUG ===\n');

// 1. Check what's in state.positions
const statePos = window.state?.positions || [];
console.log('state.positions count:', statePos.length);

// 2. Find INTC in state
const intcInState = statePos.find(p => p.ticker === 'INTC');
console.log('INTC in state.positions:', intcInState ? 'FOUND' : 'NOT FOUND');
if (intcInState) {
    console.log('  ID:', intcInState.id);
    console.log('  Has openingThesis:', !!intcInState.openingThesis);
    if (intcInState.openingThesis) {
        console.log('  Thesis preview:', JSON.stringify(intcInState.openingThesis).substring(0, 200));
    }
}

// 3. Check what's in localStorage
const lsPositions = JSON.parse(localStorage.getItem('wheelhouse_positions') || '[]');
console.log('\nlocalStorage positions count:', lsPositions.length);

const intcInLS = lsPositions.find(p => p.ticker === 'INTC');
console.log('INTC in localStorage:', intcInLS ? 'FOUND' : 'NOT FOUND');
if (intcInLS) {
    console.log('  ID:', intcInLS.id);
    console.log('  Has openingThesis:', !!intcInLS.openingThesis);
    if (intcInLS.openingThesis) {
        console.log('  Thesis preview:', JSON.stringify(intcInLS.openingThesis).substring(0, 200));
    }
}

// 4. Compare IDs
if (intcInState && intcInLS) {
    console.log('\nID Match:', intcInState.id === intcInLS.id);
    console.log('Thesis Match:', !!intcInState.openingThesis === !!intcInLS.openingThesis);
}

// 5. Check if savePositionsToStorage is available
console.log('\nwindow.savePositionsToStorage available:', typeof window.savePositionsToStorage === 'function');

// 6. Show all localStorage keys for WheelHouse
console.log('\nLocalStorage keys containing "wheelhouse":');
Object.keys(localStorage).filter(k => k.includes('wheelhouse')).forEach(k => {
    console.log(`  ${k}: ${localStorage.getItem(k).length} chars`);
});

console.log('\n=== END DEBUG ===\n');
