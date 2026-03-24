/**
 * mcp-client.js — Streamable HTTP client for the deployed ABAP MCP Server
 *
 * Sends JSON-RPC 2.0 `tools/call` requests to the MCP endpoint.
 * Authentication: passes the user's XSUAA Bearer token so Principal Propagation
 * (PP) is applied by the MCP server when it calls the on-premise ABAP system.
 */

const MCP_ENDPOINT = process.env.MCP_ENDPOINT ||
    'https://robert-bosch-gmbh-rb-btphub-taf-d-bt222d00-abap-mcp-server.cfapps.eu10-004.hana.ondemand.com/mcp';

let _sessionId = null;   // Reuse a single session across requests (stateful)
let _sessionExpiry = 0;  // Reset session every 50 minutes

/**
 * Call an MCP tool on the remote server.
 *
 * @param {string} toolName   Exact MCP tool name (e.g. 'searchObject', 'lock')
 * @param {object} params     Tool parameters as a plain JS object
 * @param {string} userJwt    The XSUAA JWT of the authenticated user (Bearer token without "Bearer " prefix)
 * @returns {object}          Parsed result object from `content[0].text`
 */
async function callMcpTool(toolName, params, userJwt) {
    if (!userJwt) {
        throw new Error('MCP call requires a user JWT (no token provided)');
    }

    // Reuse session or initialize a fresh one
    const now = Date.now();
    if (!_sessionId || now > _sessionExpiry) {
        _sessionId = await initMcpSession(userJwt);
        _sessionExpiry = now + 50 * 60 * 1000; // 50 minutes
    }

    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
            name: toolName,
            arguments: params
        }
    });

    let response;
    try {
        response = await fetch(MCP_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${userJwt}`,
                'mcp-session-id': _sessionId
            },
            body
        });
    } catch (fetchErr) {
        throw new Error(`MCP network error: ${fetchErr.message}`);
    }

    if (response.status === 401) {
        // Session may have expired — clear it so next call re-initializes
        _sessionId = null;
        throw new Error('MCP authentication error: token rejected');
    }

    if (!response.ok) {
        const errText = await response.text().catch(() => '(no body)');
        throw new Error(`MCP HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    // For SSE streaming, read all lines and find the data line
    const contentType = response.headers.get('content-type') || '';
    let json;
    if (contentType.includes('text/event-stream')) {
        const text = await response.text();
        // Each event is: "data: {...}\n\n". Find the tools/call result.
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const candidate = JSON.parse(line.slice(6));
                    if (candidate.result || candidate.error) {
                        json = candidate;
                        break;
                    }
                } catch (_) { }
            }
        }
        if (!json) throw new Error(`MCP: No result in SSE stream for tool '${toolName}'`);
    } else {
        json = await response.json();
    }

    if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }

    if (!json.result) {
        throw new Error(`MCP: Unexpected response format for tool '${toolName}'`);
    }

    // Result content is: { content: [{ type: 'text', text: '{ ... }' }] }
    const firstContent = json.result?.content?.[0];
    if (!firstContent || firstContent.type !== 'text') {
        throw new Error(`MCP: No text content in result for tool '${toolName}'`);
    }

    try {
        return JSON.parse(firstContent.text);
    } catch (_) {
        // If it's plain text (e.g., source code), return as-is
        return { status: 'success', raw: firstContent.text };
    }
}

/**
 * Send an MCP `initialize` request to start a session and get a session ID.
 * @returns {string} mcp-session-id value
 */
async function initMcpSession(userJwt) {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'cap-mcp-ai', version: '1.0.0' }
        }
    });

    const response = await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${userJwt}`
        },
        body
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '(no body)');
        throw new Error(`MCP init failed: HTTP ${response.status} - ${errText.substring(0, 200)}`);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
        throw new Error('MCP server did not return a session ID during initialize');
    }

    console.log(`[mcp-client] New session: ${sessionId}`);
    return sessionId;
}

module.exports = { callMcpTool };
