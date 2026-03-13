'use strict';

const path = require('path');
const fs   = require('fs').promises;

// ─── Token Cache ──────────────────────────────────────────────────────────────
let _tokenCache = { accessToken: null, expiresAt: 0 };

async function getOAuth2Token() {
    const params = new URLSearchParams();
    params.append('client_id',     process.env.AI_CLIENT_ID     || '');
    params.append('client_secret', process.env.AI_CLIENT_SECRET || '');
    params.append('scope',         process.env.AI_SCOPE         || '');
    params.append('grant_type',    process.env.AI_GRANT_TYPE    || 'client_credentials');

    const response = await fetch(process.env.AI_URL_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) {
        throw new Error(`OAuth2 token error: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.access_token) throw new Error('No access_token in OAuth2 response');

    return { accessToken: data.access_token, expiresIn: data.expires_in || 3600 };
}

async function getTokenCached() {
    const now = Date.now();
    if (_tokenCache.accessToken && now < _tokenCache.expiresAt - 60_000) {
        return _tokenCache.accessToken;
    }
    const token = await getOAuth2Token();
    _tokenCache = { accessToken: token.accessToken, expiresAt: now + token.expiresIn * 1000 };
    return _tokenCache.accessToken;
}

// ─── History ──────────────────────────────────────────────────────────────────
async function createHistory(token) {
    const brainId = process.env.AI_BRAIN_ID || '';
    const url = `${process.env.AI_DIA_HISTORY}/${brainId}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error(`createHistory error: HTTP ${response.status}`);
    }

    const historyId = await response.text();
    if (!historyId) throw new Error('Empty historyId from DIA_HISTORY');
    return historyId.trim();
}

// ─── Core LLM Call ───────────────────────────────────────────────────────────
async function callLLM(systemMessage, userMessage, token, historyId) {
    const brainId = process.env.AI_BRAIN_ID || '';

    const body = {
        prompt:                userMessage,
        //customMessageBehaviour: systemMessage,
        knowledgeBaseId:       brainId,
        chatHistoryId:         historyId,
        useGptKnowledge:       true
    };

    const response = await fetch(process.env.AI_DIA_CHAT_RAG, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM API error ${response.status}: ${errText}`);
    }

    const chat = await response.json();
    if (!chat.result) throw new Error('LLM response missing result field');

    return chat.result;
}

// ─── System Prompt Loader ─────────────────────────────────────────────────────
async function loadSystemPrompt(destinationName) {
/*     // Pattern from OctoAgent ask.js lines 175-179:
    // Read markdown file → replace ${variables} → pass as customMessageBehaviour
    const filePath = path.join(__dirname, '..', 'docs', 'system_prompt.md');

    let systemMessage = await fs.readFile(filePath, 'utf8');
    systemMessage = systemMessage.replace(/\$\{destinationName\}/g, destinationName || 'T4X_011');

    return systemMessage; */
    const systemMessage = "";
    return systemMessage;
}

// ─── Tool Call Parser ─────────────────────────────────────────────────────────
/**
 * Parse AI response for tool_call JSON blocks.
 * AI signals a tool call by embedding:
 *   ```json
 *   {"tool_call": "search_object", "params": {...}}
 *   ```
 * Returns null if no tool call found.
 */
function parseToolCall(aiResponse) {
    // Match ```json ... ``` or bare JSON with tool_call key
    const patterns = [
        /```json\s*(\{[\s\S]*?"tool_call"[\s\S]*?\})\s*```/,
        /```\s*(\{[\s\S]*?"tool_call"[\s\S]*?\})\s*```/,
        /(\{[\s\S]*?"tool_call"[\s\S]*?\})/
    ];

    for (const pattern of patterns) {
        const match = pattern.exec(aiResponse);
        if (match) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (parsed.tool_call && parsed.params !== undefined) return parsed;
            } catch (_) { /* not valid JSON, keep searching */ }
        }
    }
    return null;
}

/**
 * Strip the tool_call JSON block from the AI response text.
 * Returns the surrounding human-readable text only.
 */
function stripToolCall(aiResponse) {
    return aiResponse
        .replace(/```json\s*\{[\s\S]*?"tool_call"[\s\S]*?\}\s*```/g, '')
        .replace(/```\s*\{[\s\S]*?"tool_call"[\s\S]*?\}\s*```/g, '')
        .trim();
}

// ─── Agentic Chat Loop ────────────────────────────────────────────────────────
const MAX_TURNS = 10;

/**
 * Main function: runs the agentic chat loop.
 *
 * @param {string}   userMessage     - User's natural language request
 * @param {string}   historyId       - Chat history ID (null = create new)
 * @param {string}   destinationName - BTP Destination name (e.g. T4X_011)
 * @param {Function} toolExecutor    - async (toolName, params) => result string
 * @returns {{ response: string, historyId: string, toolCalls: Array }}
 */
async function agenticChat(userMessage, historyId, destinationName, toolExecutor) {
    const token = await getTokenCached();

    // Create new history session if not provided
    if (!historyId) {
        historyId = await createHistory(token);
    }

    const systemMessage = await loadSystemPrompt(destinationName);
    const toolCalls = [];

    let currentUserMessage = userMessage;
    let finalResponse = '';

    for (let turn = 0; turn < MAX_TURNS; turn++) {
        console.log(`[ai/chat] turn=${turn}, sending to LLM...`);

        const aiResponse = await callLLM(systemMessage, currentUserMessage, token, historyId);
        console.log(`[ai/chat] turn=${turn}, response_length=${aiResponse.length}`);

        const toolCall = parseToolCall(aiResponse);

        if (!toolCall) {
            // No tool call — AI returned final answer
            finalResponse = aiResponse;
            break;
        }

        // Execute the requested tool
        const textBeforeCall = stripToolCall(aiResponse);
        console.log(`[ai/chat] turn=${turn}, tool=${toolCall.tool_call}, params=${JSON.stringify(toolCall.params)}`);

        let toolResult;
        let toolStatus = 'success';

        try {
            toolResult = await toolExecutor(toolCall.tool_call, toolCall.params);
        } catch (err) {
            toolResult = `Error: ${err.message}`;
            toolStatus = 'error';
        }

        toolCalls.push({
            turn,
            tool: toolCall.tool_call,
            params: toolCall.params,
            status: toolStatus,
            result: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            textBefore: textBeforeCall
        });

        // Feed tool result back to AI for next turn
        currentUserMessage =
            `Tool "${toolCall.tool_call}" result:\n` +
            `\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\`\n` +
            `Please continue based on this result.`;
    }

    if (!finalResponse) {
        finalResponse = 'Maximum tool call turns reached. Please refine your request.';
    }

    return { response: finalResponse, historyId, toolCalls };
}

module.exports = { agenticChat, createHistory, getTokenCached };
