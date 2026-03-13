
'use strict';

const axios  = require('axios');
const https  = require('https');
const http   = require('http');

// Shared keep-alive agents — encourage TCP connection reuse across calls
const HTTP_AGENT  = new http.Agent({ keepAlive: true, maxSockets: 4 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: false });

const ADT_BASE = '/sap/bc/adt';

/**
 * Build an axios client that routes via Cloud Connector proxy.
 *
 * @param {string} destName      - BTP destination name (e.g. T4X_011)
 * @param {string} userJwt       - User's Bearer JWT (for Principal Propagation)
 * @returns {Promise<{client: AxiosInstance, destUrl: string}>}
 */
async function buildAdtAxiosClient(destName, userJwt) {
    const { getDestination } = require('@sap-cloud-sdk/connectivity');

    const dest = await getDestination({ destinationName: destName, jwt: userJwt });
    if (!dest) throw new Error(`Destination '${destName}' not found`);

    const proxyConf = dest.proxyConfiguration;
    const destUrl   = dest.url || '';

    // Build axios base config
    const clientConfig = {
        baseURL:    destUrl,
        httpAgent:  HTTP_AGENT,
        httpsAgent: HTTPS_AGENT,
        // Disable axios follow-redirects (we handle manually if needed)
        maxRedirects: 0,
        validateStatus: (s) => s < 500,  // handle 4xx ourselves
        headers: {
            // Principal Propagation: CC exchanges this JWT for a PP certificate
            'Authorization': `Bearer ${userJwt}`,
        }
    };

    // Set CC proxy if available
    if (proxyConf) {
        clientConfig.proxy = {
            host:     proxyConf.host,
            port:     parseInt(proxyConf.port, 10),
            protocol: proxyConf.protocol || 'http'
        };
        // Proxy-Authorization authenticates our BTP app to the CC proxy
        if (proxyConf.headers?.['Proxy-Authorization']) {
            clientConfig.headers['Proxy-Authorization'] = proxyConf.headers['Proxy-Authorization'];
        }
    }

    const client = axios.create(clientConfig);
    return { client, destUrl };
}

/**
 * Parse Set-Cookie response header into a Cookie request string.
 * Extracts only name=value pairs (strips Path, Domain, Max-Age, etc.)
 */
function parseCookies(setCookieHeader) {
    if (!setCookieHeader) return '';
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return cookies.map(c => c.split(';')[0]).join('; ');
}

/**
 * Throw an error with ABAP downstream info for proper error handling.
 */
function throwAdtError(axiosResponse, step) {
    const body = typeof axiosResponse.data === 'string'
        ? axiosResponse.data
        : JSON.stringify(axiosResponse.data);

    const err = new Error(`ADT ${step} failed: HTTP ${axiosResponse.status}`);
    err.downstreamStatus = axiosResponse.status;
    err.downstreamBody   = body;
    throw err;
}

/**
 * Full stateful save-source operation in a single axios session:
 *   1. CSRF fetch  → establishes ABAP session (cookie)
 *   2. Lock        → same session → lock tied to session
 *   3. Set-source  → same session → lockHandle valid
 *   4. Unlock      → same session → release lock
 *
 * @param {object} opts
 * @param {string} opts.destName     - BTP destination name
 * @param {string} opts.userJwt      - User Bearer JWT
 * @param {string} opts.objectUrl    - ADT object URI
 * @param {string} opts.sourceUrl    - ADT source URL (or objectUrl/source/main)
 * @param {string} opts.source       - ABAP source code to save
 * @param {string} [opts.cookies]    - Existing session cookies to reuse
 * @param {string} [opts.connectionId] - Persistent ADT connection ID
 * @param {Function} opts.log        - Logging function (msg => void)
 */
async function adtSaveSource({ destName, userJwt, objectUrl, sourceUrl, source, transport, cookies, connectionId, log }) {
    log = log || console.log;

    const { client } = await buildAdtAxiosClient(destName, userJwt);

    let sessionCookie = '';
    let lockHandle    = '';

    // ── Step 1: CSRF fetch (establishes ABAP session, returns cookie + csrf token)
    const csrfResp = await client.get(`${ADT_BASE}/core/discovery`, {
        headers: {
            'X-CSRF-Token': 'Fetch',
            'Accept':       'application/atomsvc+xml, application/xml, */*',
            'Cookie':       cookies || '',
            'X-sap-adt-session-type': 'stateful',
            'sap-adt-connection-id': connectionId || ''
        }
    });
    const csrfToken = csrfResp.headers['x-csrf-token'] || '';
    const newCookies = parseCookies(csrfResp.headers['set-cookie']);
    sessionCookie   = newCookies || cookies || '';
    log(`[adtSession] step1/csrf token=${csrfToken?.substring(0, 10)}, cookie_len=${sessionCookie.length}`);

    if (!csrfToken) throw Object.assign(
        new Error('CSRF fetch did not return a token'),
        { downstreamStatus: 500 }
    );

    // ── Step 2: Lock (send session cookie → ABAP uses same session → lock in that session)
    const lockResp = await client.post(
        `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
        null,
        { 
            headers: { 
                'X-CSRF-Token': csrfToken, 
                'Cookie': sessionCookie, 
                'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
                'X-sap-adt-session-type': 'stateful',
                'sap-adt-connection-id': connectionId || ''
            } 
        }
    );
    if (lockResp.status >= 400) throwAdtError(lockResp, 'lock');

    const lockXml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
    log(`[adtSession] step2/lock xml: ${lockXml.substring(0, 200)}`);

    for (const p of [
        /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i,
        /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i,
        /<lockHandle[^>]*>([^<]+)<\/lockHandle>/i
    ]) {
        const m = p.exec(lockXml);
        if (m) { lockHandle = m[1].trim(); break; }
    }
    if (!lockHandle && lockXml.length < 200 && !lockXml.includes('<')) lockHandle = lockXml.trim();
    if (!lockHandle) throw Object.assign(new Error('Could not parse lockHandle from ABAP response'), { downstreamStatus: 500 });

    // Prefer any new cookie from lock response (if ABAP issued one)
    const lockCookie = parseCookies(lockResp.headers['set-cookie']);
    if (lockCookie) sessionCookie = lockCookie;
    log(`[adtSession] step2/locked handle=${lockHandle}, cookie_len=${sessionCookie.length}`);

    // ── Step 3: Set source (same session cookie → ABAP finds lock in same session)
    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    if (transport) putUrl += `&corrNr=${encodeURIComponent(transport)}`;

    const putResp = await client.put(putUrl, source, {
        headers: {
            'X-CSRF-Token': csrfToken,
            'Cookie':       sessionCookie,
            'Content-Type': 'text/plain; charset=utf-8',
            'X-sap-adt-session-type': 'stateful',
            'sap-adt-connection-id': connectionId || ''
        }
    });
    if (putResp.status >= 400) {
        // Try to cleanup before throwing
        await client.post(
            `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
            null,
            { headers: { 
                'X-CSRF-Token': csrfToken, 
                'Cookie': sessionCookie,
                'X-sap-adt-session-type': 'stateful',
                'sap-adt-connection-id': connectionId || ''
            } }
        ).catch(e => log(`[adtSession] cleanup unlock failed: ${e.message}`));
        throwAdtError(putResp, 'set-source');
    }
    log(`[adtSession] step3/source saved to ${sourceUrl}`);

    // ── Step 4: Unlock (Trace shows POST /sap/bc/adt/.../_action=UNLOCK)
    const unlockResp = await client.post(
        `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
        null,
        { 
            headers: { 
                'X-CSRF-Token': csrfToken, 
                'Cookie': sessionCookie,
                'X-sap-adt-session-type': 'stateful',
                'sap-adt-connection-id': connectionId || ''
            } 
        }
    );
    if (unlockResp.status >= 400) {
        log(`[adtSession] unlock returned HTTP ${unlockResp.status} (non-fatal)`);
    }
    log(`[adtSession] step4/unlocked`);

    return { lockHandle, sourceUrl };
}

module.exports = { adtSaveSource, buildAdtAxiosClient };
