/**
 * callMcpClient.js
 * -----------------
 * MCP Client module for Octo App (cap-mcp-ai).
 * Handles:
 *   - Auto OAuth2 token acquisition via browser redirect (Local dev mode)
 *   - JWT & MCP Session caching (per user, per destination)
 *   - Tool invocation via Streamable HTTP MCP protocol
 */

const http = require('http');
const { exec } = require('child_process');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'https://robert-bosch-gmbh-rb-btphub-taf-d-bt222d00-abap-mcp-server.cfapps.eu10-004.hana.ondemand.com/mcp';
const MCP_OAUTH_BASE = MCP_SERVER_URL.replace('/mcp', ''); // e.g. https://test.cfapps.cf10.hana.ondemand.com
const LOCAL_CALLBACK_PORT = process.env.MCP_CALLBACK_PORT || 3099;

// ─── BAS HELPERS ───────────────────────────────────────────────────────────────

/**
 * Construct the callback URI based on the current environment.
 * If running in SAP BAS, it uses the workspace's public URL for port forwarding.
 */
function getCallbackUri() {
    if (process.env.WS_BASE_URL) {
        // SAP BAS Environment
        // Example: https://workspaces-ws-g41xm.eu10.applicationstudio.cloud.sap/
        // To callback on port 3099, we need: https://port3099-workspaces-ws-g41xm.eu10.applicationstudio.cloud.sap/mcp-callback
        const baseUrl = process.env.WS_BASE_URL.replace('https://', '');
        return `https://port${LOCAL_CALLBACK_PORT}-${baseUrl}mcp-callback`.replace('//', '/');
    }
    // Local Environment
    return `http://localhost:${LOCAL_CALLBACK_PORT}/mcp-callback`;
}

/**
 * Handle browser opening based on environment.
 */
function notifyUserToLogin(authUrl) {
    if (process.env.WS_BASE_URL) {
        // On BAS, we can't open a browser window on the user's host.
        // We print a clear banner so the user can click the link in the terminal.
        console.log("\n" + "=".repeat(80));
        console.log("🔑 MCP AUTHENTICATION REQUIRED");
        console.log("=".repeat(80));
        console.log("You are running in SAP Business Application Studio.");
        console.log("Please click the link below to sign in via Bosch SSO:");
        console.log("\n" + authUrl + "\n");
        console.log("Note: After successful login, this terminal will automatically continue.");
        console.log("=".repeat(80) + "\n");
    } else {
        // Local: Auto-open the OS default browser
        openBrowser(authUrl);
    }
}

// ─── IN-MEMORY SESSION STORE ────────────────────────────────────────────────────
// Structure:
// userCache = {
//   "<userId>": {
//     jwt: "eyJhbG...",
//     jwtExpiresAt: 1700000000000, // ms timestamp
//     mcpSessions: {
//       "<destinationName>": {
//         sessionId: "sess-abc-123",
//         createdAt: 1700000000000
//       }
//     }
//   }
// }
const userCache = new Map();

// ─── SESSION TTL ────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours (BTP MCP auto-clears at 24h)

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function getUserEntry(userId) {
    if (!userCache.has(userId)) {
        userCache.set(userId, { jwt: null, jwtExpiresAt: 0, mcpSessions: {} });
    }
    return userCache.get(userId);
}

function isJwtValid(userEntry) {
    return userEntry.jwt && Date.now() < userEntry.jwtExpiresAt;
}

function isSessionValid(sessionEntry) {
    return sessionEntry && (Date.now() - sessionEntry.createdAt) < SESSION_TTL_MS;
}

function saveJwt(userId, token, expiresInSeconds = 3600) {
    const entry = getUserEntry(userId);
    entry.jwt = token;
    // Keep a 60s buffer before actual expiry to avoid race conditions
    entry.jwtExpiresAt = Date.now() + (expiresInSeconds - 60) * 1000;
    console.log(`[McpClient] JWT saved for user=${userId}, expires in ${expiresInSeconds}s`);
}

function saveSession(userId, destinationName, sessionId) {
    const entry = getUserEntry(userId);
    entry.mcpSessions[destinationName] = { sessionId, createdAt: Date.now() };
    console.log(`[McpClient] Session saved: user=${userId}, dest=${destinationName}, sessionId=${sessionId}`);
}

function clearSession(userId, destinationName) {
    const entry = getUserEntry(userId);
    delete entry.mcpSessions[destinationName];
    console.log(`[McpClient] Session cleared: user=${userId}, dest=${destinationName}`);
}

// ─── STEP 1: OAUTH2 BROWSER FLOW (Local Dev) ────────────────────────────────────

/**
 * Opens a browser to do SSO login and retrieves access_token automatically.
 * Works because xs-security.json allows redirect to http://localhost:*
 */
async function acquireTokenViaBrowser() {
    console.log('[McpClient] No valid JWT found. Starting browser OAuth2 flow...');

    return new Promise((resolve, reject) => {
        let server;

        const app = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${LOCAL_CALLBACK_PORT}`);

            if (url.pathname !== '/mcp-callback') {
                res.writeHead(404);
                res.end();
                return;
            }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<h2>Authentication failed: ${error}</h2>`);
                server.close();
                reject(new Error(`OAuth error: ${error}`));
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<h2>No code received</h2>');
                server.close();
                reject(new Error('No authorization code received'));
                return;
            }

            try {
                // Exchange code for token via MCP Server's OAuth proxy
                const tokenData = await exchangeCodeForToken(code);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html><body style="font-family:sans-serif;text-align:center;padding:2rem;background:#f4f4f5">
                        <h2 style="color:#10b981">✅ Login Successful!</h2>
                        <p>You can close this tab and return to the application.</p>
                        <script>setTimeout(() => window.close(), 2000)</script>
                    </body></html>
                `);
                server.close();
                resolve(tokenData);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`<h2>Token exchange failed: ${err.message}</h2>`);
                server.close();
                reject(err);
            }
        });

        server = app.listen(LOCAL_CALLBACK_PORT, '0.0.0.0', () => {
            const callbackUri = getCallbackUri();
            const authUrl = `${MCP_OAUTH_BASE}/oauth/authorize?redirect_uri=${encodeURIComponent(callbackUri)}`;
            console.log(`[McpClient] Login server listening on port ${LOCAL_CALLBACK_PORT}`);
            notifyUserToLogin(authUrl);
        });

        server.on('error', (err) => {
            reject(new Error(`Failed to start local callback server: ${err.message}`));
        });

        // Timeout after 2 minutes if user doesn't complete login
        setTimeout(() => {
            server.close();
            reject(new Error('OAuth login timed out after 2 minutes'));
        }, 2 * 60 * 1000);
    });
}

function openBrowser(url) {
    const platform = process.platform;
    const cmd = platform === 'win32' ? `start "" "${url}"`
        : platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.error('[McpClient] Failed to open browser:', err.message);
    });
}

async function exchangeCodeForToken(code) {
    const fetch = (await import('node-fetch')).default;
    const callbackUri = getCallbackUri();

    const resp = await fetch(`${MCP_OAUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: callbackUri
        })
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    return resp.json(); // { access_token, expires_in, refresh_token, ... }
}

// ─── STEP 2: MCP INITIALIZE (Get mcp-session-id) ─────────────────────────────────

async function initializeMcpSession(jwt, destinationName) {
    console.log(`[McpClient] Initializing MCP session for dest=${destinationName}...`);
    const fetch = (await import('node-fetch')).default;

    const resp = await fetch(MCP_SERVER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${jwt}`,
            'x-sap-destination-name': destinationName
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'cap-mcp-ai', version: '1.0.0' }
            }
        })
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`MCP initialize failed (${resp.status}): ${text}`);
    }

    const sessionId = resp.headers.get('mcp-session-id');
    if (!sessionId) {
        throw new Error('MCP initialize succeeded but no mcp-session-id returned in headers');
    }

    console.log(`[McpClient] Session initialized: sessionId=${sessionId}`);
    return sessionId;
}

// ─── STEP 3: CALL TOOL ─────────────────────────────────────────────────────────

async function callMcpTool(jwt, sessionId, destinationName, toolName, toolArgs = {}) {
    const fetch = (await import('node-fetch')).default;
    console.log(`[McpClient] Calling tool=${toolName}, dest=${destinationName}, sessionId=${sessionId}`);

    const resp = await fetch(MCP_SERVER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'Authorization': `Bearer ${jwt}`,
            'mcp-session-id': sessionId,
            'x-sap-destination-name': destinationName
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: toolName, arguments: toolArgs }
        })
    });

    if (!resp.ok) {
        const text = await resp.text();
        // 401 means JWT expired, caller should retry after re-auth
        const err = new Error(`MCP tool call failed (${resp.status}): ${text}`);
        err.statusCode = resp.status;
        throw err;
    }

    return resp.json();
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Main entry point. Handles token & session lifecycle automatically.
 * @param {string} userId - Unique identifier for the user (e.g. logon name)
 * @param {string} destinationName - SAP Destination (e.g. 'T4X_011')
 * @param {string} toolName - MCP Tool name (e.g. 'searchObject')
 * @param {object} toolArgs - Tool arguments
 * @returns {object} MCP tool response (parsed JSON)
 */
async function callTool(userId, destinationName, toolName, toolArgs = {}) {
    const entry = getUserEntry(userId);

    // ── ACQUIRE JWT if missing or expired ──────────────────────────────────────
    if (!isJwtValid(entry)) {
        const tokenData = await acquireTokenViaBrowser();
        saveJwt(userId, tokenData.access_token, tokenData.expires_in || 3600);
    }

    const jwt = getUserEntry(userId).jwt;

    // ── ACQUIRE MCP SESSION if missing or expired ──────────────────────────────
    const sessionEntry = entry.mcpSessions[destinationName];
    if (!isSessionValid(sessionEntry)) {
        const sessionId = await initializeMcpSession(jwt, destinationName);
        saveSession(userId, destinationName, sessionId);
    }

    const sessionId = getUserEntry(userId).mcpSessions[destinationName].sessionId;

    // ── CALL TOOL (with one auto-retry on 401) ─────────────────────────────────
    try {
        return await callMcpTool(jwt, sessionId, destinationName, toolName, toolArgs);
    } catch (err) {
        if (err.statusCode === 401) {
            // JWT expired mid-session → clear everything and retry once
            console.warn(`[McpClient] 401 received — clearing session/JWT for user=${userId}, dest=${destinationName} and retrying...`);
            clearSession(userId, destinationName);
            getUserEntry(userId).jwt = null;

            // Re-acquire JWT
            const tokenData = await acquireTokenViaBrowser();
            saveJwt(userId, tokenData.access_token, tokenData.expires_in || 3600);

            const newJwt = getUserEntry(userId).jwt;
            const newSessionId = await initializeMcpSession(newJwt, destinationName);
            saveSession(userId, destinationName, newSessionId);

            return await callMcpTool(newJwt, newSessionId, destinationName, toolName, toolArgs);
        }
        throw err;
    }
}

module.exports = { callTool };
