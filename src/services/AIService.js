/**
 * AIService.js - Centralized AI model calling service
 * 
 * Handles calls to:
 * - Ollama (local LLMs: qwen2.5:7b, qwen2.5:14b, deepseek-r1:32b)
 * - Grok (xAI cloud: grok-4, grok-3, grok-3-mini)
 * - MoE (Mixture of Experts: 7B+14B→32B ensemble)
 * 
 * Created: January 2026 (server.js modularization Phase 2)
 */

const http = require('http');
const https = require('https');

// Model name aliases for convenience
const MODEL_MAP = {
    '7b': 'qwen2.5:7b',
    '14b': 'qwen2.5:14b', 
    '32b': 'deepseek-r1:32b',
    'deepseek': 'deepseek-r1:32b',
    'deepseek-r1': 'deepseek-r1:32b',
    'deepseek-r1:32b': 'deepseek-r1:32b',
    'qwen2.5:7b': 'qwen2.5:7b',
    'qwen2.5:14b': 'qwen2.5:14b',
    'llama3.1:8b': 'llama3.1:8b',
    'mistral:7b': 'mistral:7b'
};

/**
 * Universal AI call - routes to Ollama or Grok based on model name
 * @param {string} prompt - The prompt to send
 * @param {string} model - Model name (e.g., 'qwen2.5:7b', 'grok-3')
 * @param {number} maxTokens - Maximum tokens to generate
 * @returns {Promise<string>} - Model response
 */
async function callAI(prompt, model = 'qwen2.5:7b', maxTokens = 400) {
    // Check if this is a Grok model
    if (model.startsWith('grok')) {
        return callGrok(prompt, model, maxTokens);
    }
    // Otherwise use Ollama
    return callOllama(prompt, model, maxTokens);
}

/**
 * Call Grok API (xAI)
 * Model names: grok-4, grok-3, grok-3-mini, grok-2
 * @param {string} prompt - The prompt to send
 * @param {string} model - Grok model name
 * @param {number} maxTokens - Maximum tokens to generate
 * @returns {Promise<string>} - Model response
 */
async function callGrok(prompt, model = 'grok-3', maxTokens = 400) {
    const apiKey = process.env.GROK_API_KEY;
    
    if (!apiKey) {
        throw new Error('Grok API key not configured. Add GROK_API_KEY to Settings.');
    }
    
    // Model-specific timeouts
    // grok-4: Most capable but slowest (can take 3-5 min for complex prompts)
    // grok-4-1-fast: Speed-optimized, nearly as good (recommended default)
    // grok-3: Good balance
    let timeoutMs = 90000;  // Default: 90s
    if (model === 'grok-4') {
        timeoutMs = 300000;  // 5 min for deep thinking
    } else if (model.includes('grok-4')) {
        timeoutMs = 180000;  // 3 min for grok-4 variants
    }
    const timeoutSec = timeoutMs / 1000;
    
    console.log(`[AI] Using Grok model: ${model}, maxTokens: ${maxTokens}, timeout: ${timeoutSec}s`);
    
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[AI] ⚠️ Grok request timed out after ${timeoutSec}s`);
        controller.abort();
    }, timeoutMs);
    
    try {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                max_tokens: maxTokens,
                temperature: 0.7
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errText = await response.text();
            console.log(`[AI] Grok API error: ${response.status} - ${errText}`);
            
            // Parse error for helpful message
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error?.message) {
                    throw new Error(`Grok: ${errJson.error.message}`);
                }
            } catch (parseErr) {
                // Not JSON, use raw text
            }
            
            throw new Error(`Grok API error: ${response.status} - ${errText.substring(0, 200)}`);
        }
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Grok';
        
        // Log token usage for cost tracking
        const usage = data.usage;
        if (usage) {
            console.log(`[AI] Grok tokens: ${usage.prompt_tokens} in → ${usage.completion_tokens} out = ${usage.total_tokens} total`);
        }
        console.log(`[AI] ✅ Grok response length: ${content.length} chars`);
        return content;
        
    } catch (e) {
        clearTimeout(timeoutId);
        
        if (e.name === 'AbortError') {
            throw new Error(`Grok request timed out after ${timeoutSec} seconds. Try grok-4-1-fast for faster responses.`);
        }
        
        console.log(`[AI] ❌ Grok call failed: ${e.message}`);
        throw e;
    }
}

/**
 * Call Grok API with LIVE X (Twitter) and Web Search capability
 * Uses xAI's server-side tools for real-time data access
 * 
 * NOTE: The tools API requires specific formatting. If you get 422 errors,
 * it may be due to incorrect tool format. We fall back to grok-4 with
 * enhanced prompting which has some built-in real-time awareness.
 * 
 * @param {string} prompt - The prompt to send
 * @param {object} options - Search options
 * @param {boolean} options.xSearch - Enable X/Twitter search (default: true)
 * @param {boolean} options.webSearch - Enable web search (default: false)
 * @param {number} options.maxTokens - Maximum tokens (default: 1500)
 * @param {string} options.model - Model to use (default: grok-4)
 * @returns {Promise<{content: string, citations: array}>} - Response with citations
 */
async function callGrokWithSearch(prompt, options = {}) {
    const apiKey = process.env.GROK_API_KEY;
    
    if (!apiKey) {
        throw new Error('Grok API key not configured. Add GROK_API_KEY to Settings.');
    }
    
    const {
        xSearch = true,
        webSearch = false,
        maxTokens = 2000,
        model = 'grok-4'  // grok-4 has built-in real-time X awareness
    } = options;
    
    const timeoutMs = 300000;  // 5 min timeout for grok-4 (can be slow but thorough)
    const timeoutSec = timeoutMs / 1000;
    
    console.log(`[AI] 🔍 Grok Search: model=${model}, xSearch=${xSearch}, webSearch=${webSearch}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[AI] ⚠️ Grok search timed out after ${timeoutSec}s`);
        controller.abort();
    }, timeoutMs);
    
    try {
        const requestBody = {
            model: model,
            messages: [
                { role: 'user', content: prompt }
            ],
            max_tokens: maxTokens,
            temperature: 0.7
        };
        
        // Note: Server-side tools require xai-sdk or specific API format
        // For now, rely on grok-4's built-in real-time awareness
        // The prompt should emphasize checking live X data
        
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errText = await response.text();
            console.log(`[AI] Grok Search API error: ${response.status} - ${errText}`);
            
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error?.message) {
                    throw new Error(`Grok Search: ${errJson.error.message}`);
                }
            } catch (parseErr) {
                // Not JSON
            }
            
            throw new Error(`Grok Search API error: ${response.status}`);
        }
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Grok';
        const citations = data.citations || [];
        
        // Log usage
        const usage = data.usage;
        if (usage) {
            console.log(`[AI] Grok Search tokens: ${usage.prompt_tokens} in → ${usage.completion_tokens} out`);
        }
        
        // Log tool calls if any
        const toolCalls = data.choices?.[0]?.message?.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
            console.log(`[AI] 🔧 Grok made ${toolCalls.length} tool calls during search`);
        }
        
        console.log(`[AI] ✅ Grok Search response: ${content.length} chars, ${citations.length} citations`);
        
        return { content, citations };
        
    } catch (e) {
        clearTimeout(timeoutId);
        
        if (e.name === 'AbortError') {
            throw new Error(`Grok Search timed out after ${timeoutSec} seconds`);
        }
        
        console.log(`[AI] ❌ Grok Search failed: ${e.message}`);
        throw e;
    }
}

/**
 * Call Ollama API (local LLMs)
 * @param {string} prompt - The prompt to send
 * @param {string} model - Model name (supports aliases like '7b', '32b')
 * @param {number} maxTokens - Maximum tokens to generate
 * @returns {Promise<string>} - Model response
 */
function callOllama(prompt, model = 'qwen2.5:7b', maxTokens = 400) {
    const resolvedModel = MODEL_MAP[model] || model;
    console.log(`[AI] Using model: ${resolvedModel}, maxTokens: ${maxTokens}`);
    
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: resolvedModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.7,
                num_predict: maxTokens
            }
        });
        
        const options = {
            hostname: 'localhost',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    console.log(`[AI] Ollama response keys:`, Object.keys(json));
                    
                    // DeepSeek-R1 special handling
                    const isDeepSeekR1 = model.includes('deepseek-r1');
                    let answer = '';
                    
                    if (isDeepSeekR1) {
                        answer = extractDeepSeekAnswer(json, model);
                    } else {
                        // Non-DeepSeek model: use response field
                        answer = json.response || '';
                    }
                    
                    // Fallback: if answer is still empty, try thinking
                    if (!answer && json.thinking) {
                        console.log(`[AI] Fallback: using thinking field (${json.thinking.length} chars)`);
                        answer = json.thinking;
                    }
                    
                    if (!answer) {
                        console.log(`[AI] ⚠️ Empty response. Full JSON:`, JSON.stringify(json).slice(0, 500));
                    }
                    resolve(answer || 'No response from model');
                } catch (e) {
                    console.log(`[AI] ❌ Parse error. Raw data:`, data.slice(0, 500));
                    reject(new Error('Invalid response from Ollama'));
                }
            });
        });
        
        req.on('error', (e) => {
            reject(new Error(`Ollama connection failed: ${e.message}. Is Ollama running?`));
        });
        
        // DeepSeek-R1 is a reasoning model that takes much longer - give it 3 minutes
        const timeoutMs = resolvedModel.includes('deepseek') ? 180000 : 60000;
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`Ollama request timed out (${timeoutMs/1000}s)`));
        });
        
        req.write(postData);
        req.end();
    });
}

/**
 * Extract the best answer from DeepSeek-R1 response
 * DeepSeek-R1 puts chain-of-thought in "thinking" and final answer in "response"
 * But sometimes "response" is incomplete or the better answer is in "thinking"
 * @param {object} json - Ollama response JSON
 * @param {string} model - Model name for logging
 * @returns {string} - Extracted answer
 */
function extractDeepSeekAnswer(json, model) {
    console.log(`[AI] DeepSeek-R1 detected`);
    console.log(`[AI]   thinking: ${json.thinking?.length || 0} chars`);
    console.log(`[AI]   response: ${json.response?.length || 0} chars`);
    
    let answer = '';
    
    // First, try to find formatted answer in thinking
    const thinkingAnswer = extractFormattedAnswer(json.thinking);
    if (thinkingAnswer) {
        answer = thinkingAnswer;
        console.log(`[AI] ✅ Found formatted answer in thinking (${answer.length} chars)`);
        return answer;
    }
    
    // If not found in thinking, try response
    const responseAnswer = extractFormattedAnswer(json.response);
    if (responseAnswer) {
        answer = responseAnswer;
        console.log(`[AI] ✅ Found formatted answer in response (${answer.length} chars)`);
        return answer;
    }
    
    // If still no formatted answer, check if response is NOT chain-of-thought
    if (json.response && !looksLikeChainOfThought(json.response)) {
        answer = json.response;
        console.log(`[AI] Using response (not chain-of-thought) (${answer.length} chars)`);
        return answer;
    }
    
    // Last resort: if thinking has formatted sections but no clear header, try to extract
    if (json.thinking) {
        // Look for any markdown headers that might indicate structure
        const headerMatch = json.thinking.match(/^(#+\s+.+)$/m);
        if (headerMatch) {
            const headerIdx = json.thinking.indexOf(headerMatch[0]);
            answer = json.thinking.slice(headerIdx);
            console.log(`[AI] ⚠️ Extracted from first markdown header (${answer.length} chars)`);
        } else {
            answer = json.thinking;
            console.log(`[AI] ⚠️ Using full thinking (no structure found) (${answer.length} chars)`);
        }
    }
    
    return answer;
}

/**
 * Helper to detect chain-of-thought rambling vs actual formatted answer
 * @param {string} text - Text to check
 * @returns {boolean} - True if text looks like chain-of-thought reasoning
 */
function looksLikeChainOfThought(text) {
    if (!text) return false;
    const cotIndicators = [
        'let me think',
        'I need to',
        'I should',
        'let me go through',
        'considering all this',
        "I'm trying to",
        'wait, maybe',
        'hmm,',
        'okay, so',
        'let me check',
        "I'm not sure",
        'actually,'
    ];
    const lowerText = text.slice(0, 500).toLowerCase();
    return cotIndicators.some(indicator => lowerText.includes(indicator));
}

/**
 * Helper to find formatted answer in text
 * @param {string} text - Text to search
 * @returns {string|null} - Extracted formatted answer or null
 */
function extractFormattedAnswer(text) {
    if (!text) return null;
    
    // Look for our expected format markers
    const markers = [
        '## 🏆 RECOMMENDED',
        '### THE TRADE',
        '🏆 RECOMMENDED:',
        '**RECOMMENDED:**'
    ];
    
    for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx !== -1) {
            return text.slice(idx);
        }
    }
    return null;
}

/**
 * Mixture of Experts (MoE) approach
 * 1. Run 7B and 14B in parallel with the same prompt
 * 2. Pass both opinions to 32B for final nuanced decision
 * 
 * @param {string} basePrompt - The full prompt to analyze
 * @param {object} data - Additional data (for roll options etc.)
 * @returns {Promise<{response: string, opinions: object, timing: object}>}
 */
async function callMoE(basePrompt, data = {}) {
    const startTime = Date.now();
    console.log('[AI] 🧠 Starting MoE analysis (7B + 14B → 32B)...');
    
    // Build a shorter prompt for the smaller models (they just need to give a quick opinion)
    const quickPrompt = `${basePrompt}

IMPORTANT: Be concise. Give your recommendation in 2-3 sentences. Format:
VERDICT: [HOLD/ROLL/CLOSE]
REASON: [Brief explanation]
${data.rollOptions?.creditRolls?.length > 0 || data.rollOptions?.riskReduction?.length > 0 ? 'PICK: [If rolling, which option and why]' : ''}`;

    // Run 7B and 14B in parallel
    console.log('[AI] ⚡ Running 7B and 14B in parallel...');
    const [opinion7B, opinion14B] = await Promise.all([
        callOllama(quickPrompt, 'qwen2.5:7b', 200).catch(e => `Error: ${e.message}`),
        callOllama(quickPrompt, 'qwen2.5:14b', 200).catch(e => `Error: ${e.message}`)
    ]);
    
    const parallelTime = Date.now() - startTime;
    console.log(`[AI] ✓ Parallel phase done in ${parallelTime}ms`);
    console.log('[AI] 7B opinion:', opinion7B.substring(0, 100) + '...');
    console.log('[AI] 14B opinion:', opinion14B.substring(0, 100) + '...');
    
    // Now build the judge prompt for 32B - include full scorecard instructions
    const judgePrompt = `You are a senior options trading advisor reviewing assessments from two junior analysts.

${basePrompt}

═══ ANALYST OPINIONS (for context) ═══

**Analyst #1 (7B Quick):**
${opinion7B}

**Analyst #2 (14B Standard):**
${opinion14B}

═══ YOUR TASK AS SENIOR ADVISOR ═══
You have the full position data and strategy scorecard format above. Now:

1. Consider both analysts' quick takes
2. Complete the FULL STRATEGY SCORECARD rating each strategy 1-10
3. Determine the WINNER based on your expert judgment
4. If analysts disagreed, explain which reasoning you found more compelling

Proceed with the scorecard analysis now.`;

    // Call 32B as the judge - needs more tokens for full scorecard
    console.log('[AI] 👨‍⚖️ Running 32B as judge...');
    const finalResponse = await callOllama(judgePrompt, 'deepseek-r1:32b', 1800);
    
    const totalTime = Date.now() - startTime;
    console.log(`[AI] ✅ MoE complete in ${totalTime}ms (parallel: ${parallelTime}ms, judge: ${totalTime - parallelTime}ms)`);
    
    return {
        response: finalResponse,
        opinions: { '7B': opinion7B, '14B': opinion14B },
        timing: { total: totalTime, parallel: parallelTime, judge: totalTime - parallelTime }
    };
}

/**
 * Resolve model alias to full model name
 * @param {string} model - Model name or alias
 * @returns {string} - Full model name
 */
function resolveModelName(model) {
    return MODEL_MAP[model] || model;
}

module.exports = {
    callAI,
    callGrok,
    callGrokWithSearch,
    callOllama,
    callMoE,
    resolveModelName,
    MODEL_MAP
};
