
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
 * @param {string} [opts.transport]  - Transport request number (optional)
 * @param {Function} opts.log        - Logging function (msg => void)
 */
async function adtSaveSource({
    destName,
    userJwt,
    objectUrl,
    sourceUrl,
    source,
    transport,
    log
}) {

    log = log || console.log

    const { client, destUrl } = await buildAdtAxiosClient(destName, userJwt)

    let sessionCookie = ''
    let csrfToken = ''
    let lockHandle = ''
    let connectionId = require('crypto').randomUUID().replace(/-/g,'')

    log(`\n========= ADT SAVE SOURCE FLOW =========`)
    log(`[ADT] dest=${destUrl}`)
    log(`[ADT] object=${objectUrl}`)
    log(`[ADT] source=${sourceUrl}`)
    log(`[ADT] connectionId=${connectionId}`)

    // -------------------------------------------------
    // STEP 1 — CSRF
    // Use a HEAD request on the objectUrl (lightweight — no body transfer).
    // Avoids hitting the heavy /core/discovery endpoint which can timeout (503)
    // on ABAP systems with many installed packages.
    // -------------------------------------------------

    log(`\n[STEP1] CSRF fetch`)

    const csrfResp = await client.head(objectUrl, {
        headers: {
            'X-CSRF-Token': 'Fetch',
            'sap-adt-connection-id': connectionId,
            'User-Agent': 'Eclipse/4.37.0 ADT/3.52.0'
        }
    })

    csrfToken = csrfResp.headers['x-csrf-token'] || ''

    // NOTE: We do NOT pass cookies manually. The BTP Cloud Connector maintains
    // the HTTP session transparently via the keep-alive TCP connection (shared
    // axios client). Forwarding cookies across proxy hops causes session
    // mismatches that result in "invalid lock handle" (423) errors.
    sessionCookie = parseCookies(csrfResp.headers['set-cookie'])

    log(`[STEP1] status=${csrfResp.status}`)
    log(`[STEP1] csrfToken=${csrfToken?.substring(0,12)}`)
    log(`[STEP1] headers=${JSON.stringify(csrfResp.headers,null,2)}`)

    if (!csrfToken) {
        // Fallback: if HEAD doesn't return a CSRF token, try GET on objectUrl
        log(`[STEP1] HEAD did not return CSRF token, falling back to GET`)
        const csrfFallback = await client.get(objectUrl, {
            headers: {
                'X-CSRF-Token': 'Fetch',
                'Accept': 'application/xml, application/vnd.sap.adt.core.objectstructure+xml',
                'sap-adt-connection-id': connectionId,
                'User-Agent': 'Eclipse/4.37.0 ADT/3.52.0'
            }
        })
        csrfToken = csrfFallback.headers['x-csrf-token'] || ''
        sessionCookie = parseCookies(csrfFallback.headers['set-cookie'])
        log(`[STEP1] fallback status=${csrfFallback.status}, csrfToken=${csrfToken?.substring(0,12)}`)
    }

    if (!csrfToken) {
        throw new Error('CSRF token missing — HEAD and GET on objectUrl both failed to return x-csrf-token')
    }

    // -------------------------------------------------
    // STEP 2 — LOCK
    // -------------------------------------------------

    log(`\n[STEP2] LOCK object`)

    const lockResp = await client.post(
        `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
        null,
        {
            headers: {
                'X-CSRF-Token': csrfToken,
                'Cookie': sessionCookie,
                'Accept':
                    'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
                'sap-adt-connection-id': connectionId
            }
        }
    )

    log(`[STEP2] status=${lockResp.status}`)
    log(`[STEP2] headers=${JSON.stringify(lockResp.headers,null,2)}`)

    const lockXml = lockResp.data

    const m =
        /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i.exec(lockXml) ||
        /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i.exec(lockXml)

    if (!m) {
        log(`[STEP2] lock xml=${lockXml}`)
        throw new Error("LOCK_HANDLE not found")
    }

    lockHandle = m[1]

    log(`[STEP2] lockHandle=${lockHandle}`)

    const lockCookie = parseCookies(lockResp.headers['set-cookie'])

    if (lockCookie) {
        sessionCookie = lockCookie
        log(`[STEP2] cookie replaced with lock cookie`)
    }

    // -------------------------------------------------
    // STEP 3 — SET SOURCE
    // -------------------------------------------------

    log(`\n[STEP3] SET SOURCE`)

    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`

    if (transport) {
        putUrl += `&corrNr=${encodeURIComponent(transport)}`
    }

    log(`[STEP3] PUT url=${putUrl}`)

    const putResp = await client.put(
        putUrl,
        source,
        {
            headers: {
                'X-CSRF-Token': csrfToken,
                'Cookie': sessionCookie,
                'Content-Type': 'text/plain; charset=utf-8',
                'Accept': 'text/plain',
                'sap-adt-connection-id': connectionId
            }
        }
    )

    log(`[STEP3] status=${putResp.status}`)
    log(`[STEP3] headers=${JSON.stringify(putResp.headers,null,2)}`)

    if (putResp.status >= 400) {
        throwAdtError(putResp, 'set-source')
    }

    // -------------------------------------------------
    // STEP 4 — UNLOCK
    // -------------------------------------------------

    log(`\n[STEP4] UNLOCK`)

    const unlockResp = await client.post(
        `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
        null,
        {
            headers: {
                'X-CSRF-Token': csrfToken,
                'Cookie': sessionCookie,
                'sap-adt-connection-id': connectionId
            }
        }
    )

    log(`[STEP4] status=${unlockResp.status}`)
    log(`[STEP4] headers=${JSON.stringify(unlockResp.headers,null,2)}`)

    log(`\n========= ADT FLOW DONE =========\n`)

    return {
        lockHandle,
        sourceUrl
    }
}

module.exports = { adtSaveSource, buildAdtAxiosClient };
