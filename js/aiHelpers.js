/**
 * AI Helpers - Shared utility functions for AI-related modules
 * 
 * Extracted from main.js to be shared across:
 * - strategyAdvisor.js
 * - positionCheckup.js
 * - aiFunctions.js
 * - main.js (remaining AI code)
 */

/**
 * Extract thesis summary from AI analysis text
 * Parses verdict spectrum (Aggressive/Moderate/Conservative) and legacy formats
 */
function extractThesisSummary(analysis) {
    if (!analysis) return null;
    
    // Extract verdict spectrum sections
    const aggressiveMatch = analysis.match(/(?:GREEN|AGGRESSIVE)[^:]*:([^🟡🔴]*)/is);
    const moderateMatch = analysis.match(/(?:YELLOW|MODERATE)[^:]*:([^🔴]*)/is);
    const conservativeMatch = analysis.match(/(?:RED|CONSERVATIVE)[^:]*:([^B]*)/is);
    const bottomLineMatch = analysis.match(/BOTTOM LINE:([^\n]+)/i);
    
    // Legacy verdict format fallback
    const legacyVerdictMatch = analysis.match(/(✅ FOLLOW|⚠️ PASS|❌ AVOID)[^\n]*/);
    
    // Extract probability if mentioned
    const probabilityMatch = analysis.match(/(\d+)%\s*(?:probability|chance|max profit)/i);
    
    return {
        // New spectrum format
        aggressive: aggressiveMatch ? aggressiveMatch[1].trim().substring(0, 300) : null,
        moderate: moderateMatch ? moderateMatch[1].trim().substring(0, 300) : null,
        conservative: conservativeMatch ? conservativeMatch[1].trim().substring(0, 300) : null,
        bottomLine: bottomLineMatch ? bottomLineMatch[1].trim() : null,
        probability: probabilityMatch ? parseInt(probabilityMatch[1]) : null,
        
        // Legacy format
        verdict: legacyVerdictMatch ? legacyVerdictMatch[0] : null,
        
        // Full analysis for later review
        fullAnalysis: analysis
    };
}

/**
 * Extract a section from Wall Street Mode analysis by header name
 * Looks for patterns like "MARKET ANALYSIS\n..." or "THE RISKS\n..."
 */
function extractSection(text, sectionName) {
    if (!text || !sectionName) return null;
    
    // Create pattern to match section header and capture content until next section or end
    // Sections typically end with a blank line + next header in ALL CAPS
    const pattern = new RegExp(
        sectionName + '[\\s\\n]+([\\s\\S]*?)(?=\\n(?:THE TRADE|MARKET ANALYSIS|WHY THIS STRATEGY|THE RISKS|THE NUMBERS|STRATEGIES I CONSIDERED|TRADE MANAGEMENT|$))',
        'i'
    );
    
    const match = text.match(pattern);
    if (match && match[1]) {
        // Clean up the extracted section
        return match[1].trim().substring(0, 1000);  // Limit to 1000 chars per section
    }
    return null;
}

/**
 * Format AI response text to styled HTML
 * Converts markdown-like syntax to rich HTML with colors and styling
 */
function formatAIResponse(text) {
    if (!text) return '';
    
    let html = text;
    
    // First, escape any existing HTML to prevent XSS
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    
    // IMPORTANT: Use function replacements to prevent $94 being interpreted as capture group 94
    // When replacement string contains $N, JavaScript interprets it as backreference!
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: INLINE TEXT STYLING (must happen BEFORE structural HTML is added)
    // This prevents the percentage/dollar regex from matching values inside CSS
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Style dollar amounts - green for positive context
    html = html.replace(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/g, (match, p1) =>
        `<span style="color:#00ff88; font-weight:bold;">$${p1}</span>`);
    
    // Style percentages (but NOT inside style="" attributes - those come later)
    html = html.replace(/(\d+(?:\.\d+)?%)/g, (match, p1) =>
        `<span style="color:#00d9ff; font-weight:bold;">${p1}</span>`);
    
    // Style specific keywords/values
    html = html.replace(/Max Profit:/g, '<span style="color:#22c55e; font-weight:bold;">Max Profit:</span>');
    html = html.replace(/Max Loss:/g, '<span style="color:#ff5252; font-weight:bold;">Max Loss:</span>');
    html = html.replace(/Breakeven:/g, '<span style="color:#ffaa00; font-weight:bold;">Breakeven:</span>');
    html = html.replace(/Win Probability:/g, '<span style="color:#00d9ff; font-weight:bold;">Win Probability:</span>');
    html = html.replace(/Risk\/Reward Ratio:/g, '<span style="color:#a78bfa; font-weight:bold;">Risk/Reward Ratio:</span>');
    html = html.replace(/Buying Power Used:/g, '<span style="color:#8b5cf6; font-weight:bold;">Buying Power Used:</span>');
    html = html.replace(/Delta Exposure:/g, '<span style="color:#00d9ff; font-weight:bold;">Delta Exposure:</span>');
    html = html.replace(/Action:/g, '<span style="color:#22c55e; font-weight:bold;">Action:</span>');
    html = html.replace(/Expiration:/g, '<span style="color:#ffaa00; font-weight:bold;">Expiration:</span>');
    html = html.replace(/Credit\/Debit:/g, '<span style="color:#00d9ff; font-weight:bold;">Credit/Debit:</span>');
    html = html.replace(/Contracts:/g, '<span style="color:#a78bfa; font-weight:bold;">Contracts:</span>');
    
    // Convert bold **text** - make it stand out
    html = html.replace(/\*\*([^*]+)\*\*/g, (match, p1) =>
        `<strong style="color:#fff; background:rgba(255,255,255,0.1); padding:1px 4px; border-radius:3px;">${p1}</strong>`);
    
    // Convert emoji colors
    html = html.replace(/✅/g, '<span style="color:#00ff88;">✅</span>');
    html = html.replace(/❌/g, '<span style="color:#ff5252;">❌</span>');
    html = html.replace(/🟢/g, '<span style="color:#00ff88;">🟢</span>');
    html = html.replace(/🟡/g, '<span style="color:#ffaa00;">🟡</span>');
    html = html.replace(/🔴/g, '<span style="color:#ff5252;">🔴</span>');
    html = html.replace(/📈/g, '<span style="color:#00ff88;">📈</span>');
    html = html.replace(/📉/g, '<span style="color:#ff5252;">📉</span>');
    html = html.replace(/💡/g, '<span style="color:#ffaa00;">💡</span>');
    html = html.replace(/📚/g, '<span style="color:#a78bfa;">📚</span>');
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: STRUCTURAL HTML (headers, bullets, etc with CSS gradients)
    // Done AFTER inline styling so percentages like "0%" in CSS won't get styled
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert ## headers (main sections) - with colored background
    html = html.replace(/^## 🏆 (.*?)$/gm, (match, p1) =>
        `<div style="background:linear-gradient(135deg, rgba(34,197,94,0.2) 0%, rgba(34,197,94,0.1) 100%); border:1px solid rgba(34,197,94,0.4); border-radius:8px; padding:12px 16px; margin:20px 0 15px 0;"><span style="font-size:18px; font-weight:bold; color:#22c55e;">🏆 ${p1}</span></div>`);
    
    html = html.replace(/^## (.*?)$/gm, (match, p1) =>
        `<div style="background:rgba(147,51,234,0.15); border-left:4px solid #9333ea; padding:10px 15px; margin:20px 0 12px 0; font-size:16px; font-weight:bold; color:#a78bfa;">${p1}</div>`);
    
    // Convert ### headers (subsections) - cyan accent
    html = html.replace(/^### (.*?)$/gm, (match, p1) =>
        `<div style="color:#00d9ff; font-weight:bold; font-size:14px; margin:18px 0 8px 0; padding-bottom:5px; border-bottom:1px solid rgba(0,217,255,0.3);">${p1}</div>`);
    
    // Convert bullet points with • or -
    html = html.replace(/^• (.*?)$/gm, (match, p1) =>
        `<div style="margin:6px 0 6px 20px; padding-left:12px; border-left:2px solid #444;">${p1}</div>`);
    html = html.replace(/^- (.*?)$/gm, (match, p1) =>
        `<div style="margin:6px 0 6px 20px; padding-left:12px; border-left:2px solid #444;">${p1}</div>`);
    
    // Convert numbered lists (1. 2. 3. etc)
    html = html.replace(/^(\d+)\. (.*?)$/gm, (match, p1, p2) =>
        `<div style="margin:8px 0 8px 20px; display:flex; gap:8px;"><span style="color:#8b5cf6; font-weight:bold; min-width:20px;">${p1}.</span><span style="flex:1;">${p2}</span></div>`);
    
    // Convert warning lines (⚠️)
    html = html.replace(/(⚠️[^<\n]*)/g, (match, p1) =>
        `<div style="background:rgba(255,170,0,0.1); border-left:3px solid #ffaa00; padding:8px 12px; margin:6px 0; color:#ffcc00;">${p1}</div>`);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2.5: MARKDOWN TABLES → HTML TABLES
    // Matches pipe-delimited tables and converts to styled HTML
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert markdown tables to HTML
    // Regex: Match lines starting and ending with |, capture everything between
    const tableRegex = /(\|[^\n]+\|\n\|[-:\|\s]+\|\n(?:\|[^\n]+\|\n?)+)/g;
    html = html.replace(tableRegex, (tableBlock) => {
        const rows = tableBlock.trim().split('\n').filter(r => r.trim());
        if (rows.length < 2) return tableBlock;
        
        let tableHtml = '<table style="width:100%; border-collapse:collapse; margin:12px 0; font-size:12px;">';
        
        rows.forEach((row, idx) => {
            // Skip separator row (contains only |, -, :, and spaces)
            if (/^\|[\s\-:\|]+\|$/.test(row)) return;
            
            const cells = row.split('|').filter(c => c.trim() !== '');
            const isHeader = idx === 0;
            const tag = isHeader ? 'th' : 'td';
            const bgColor = isHeader ? 'rgba(147,51,234,0.2)' : (idx % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.2)');
            const fontWeight = isHeader ? 'bold' : 'normal';
            const borderColor = isHeader ? '#9333ea' : '#333';
            
            tableHtml += `<tr style="background:${bgColor};">`;
            cells.forEach(cell => {
                tableHtml += `<${tag} style="padding:8px 12px; border:1px solid ${borderColor}; color:${isHeader ? '#a78bfa' : '#ddd'}; font-weight:${fontWeight}; text-align:left;">${cell.trim()}</${tag}>`;
            });
            tableHtml += '</tr>';
        });
        
        tableHtml += '</table>';
        return tableHtml;
    });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: LINE BREAKS AND FINAL WRAPPING
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Convert line breaks to proper spacing (but not inside already-styled divs)
    // Double line breaks = paragraph break
    html = html.replace(/\n\n/g, '</p><p style="margin:12px 0;">');
    // Single line breaks that aren't already handled
    html = html.replace(/\n/g, '<br>');
    
    // Wrap in container
    html = '<div style="line-height:1.6;">' + html + '</div>';
    
    return html;
}

// Make available globally for onclick handlers and other modules
window.formatAIResponse = formatAIResponse;
window.extractThesisSummary = extractThesisSummary;
window.extractSection = extractSection;

// ES module exports
export { formatAIResponse, extractThesisSummary, extractSection };
