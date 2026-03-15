
'use strict';

/**
 * ADT Save Source — Full stateful flow using @sap-cloud-sdk/http-client
 *
 * Uses executeHttpRequest (same as all other working ADT endpoints in server.js)
 * to avoid BTP Cloud Connector proxy rejection caused by raw axios.
 *
 * Session affinity (required for ABAP lock) is maintained by:
 *   - Extracting Set-Cookie from each response
 *   - Forwarding the session cookie as a Cookie header in subsequent requests
 *
 * Flow: CSRF fetch → LOCK → SET SOURCE → UNLOCK
 */

const ADT_BASE = '/sap/bc/adt';

/**
 * Parse Set-Cookie header(s) into a Cookie request string.
 * Extracts only name=value pairs (strips Path, Domain, Max-Age, etc.)
 */
function parseCookies(setCookieHeader) {
    if (!setCookieHeader) return '';
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return cookies.map(c => c.split(';')[0]).join('; ');
}

/**
 * Merge cookie strings, deduplicating by cookie name (later wins).
 */
function mergeCookies(existing, incoming) {
    if (!incoming) return existing;
    if (!existing) return incoming;

    const map = new Map();
    for (const part of (existing + '; ' + incoming).split('; ')) {
        const [name] = part.split('=');
        if (name && name.trim()) map.set(name.trim(), part.trim());
    }
    return [...map.values()].join('; ');
}

/**
 * Execute an HTTP request via SAP Cloud SDK (BTP Cloud Connector compatible).
 * Wraps executeHttpRequest and extracts useful response info.
 *
 * @param {string} destName
 * @param {string} jwt
 * @param {object} options   - { method, url, headers, data }
 * @returns {Promise<{status, headers, data}>}
 */
async function sdkRequest(destName, jwt, options) {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    // validateStatus: always pass so we can inspect 4xx bodies (don't throw)
    const mergedOptions = {
        ...options,
        validateStatus: () => true
    };
    const resp = await executeHttpRequest(
        { destinationName: destName, jwt },
        mergedOptions
    );
    return {
        status:  resp.status,
        headers: resp.headers || {},
        data:    resp.data
    };
}

/**
 * Full stateful save-source operation:
 *   1. CSRF fetch  (HEAD on objectUrl — lightweight, returns x-csrf-token)
 *   2. Lock        (POST objectUrl?_action=LOCK)
 *   3. Set-source  (PUT sourceUrl?lockHandle=...)
 *   4. Unlock      (POST objectUrl?_action=UNLOCK)
 *
 * Session cookie is forwarded between steps to keep ABAP session alive.
 *
 * @param {object} opts
 * @param {string} opts.destName     - BTP destination name (e.g. T4X_011)
 * @param {string} opts.userJwt      - User Bearer JWT (Principal Propagation)
 * @param {string} opts.objectUrl    - ADT object URI  (e.g. /sap/bc/adt/oo/classes/zcl_xxx)
 * @param {string} opts.sourceUrl    - ADT source URL  (e.g. objectUrl/source/main)
 * @param {string} opts.source       - ABAP source code to save
 * @param {string} [opts.transport]  - Transport request number (optional)
 * @param {Function} opts.log        - Logging function
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
    log = log || console.log;

    const connectionId = require('crypto').randomUUID().replace(/-/g, '');

    log(`\n========= ADT SAVE SOURCE FLOW =========`);
    log(`[ADT] dest=${destName}`);
    log(`[ADT] object=${objectUrl}`);
    log(`[ADT] source=${sourceUrl}`);
    log(`[ADT] connectionId=${connectionId}`);

    let sessionCookie = '';
    let csrfToken     = '';
    let lockHandle    = '';

    // -------------------------------------------------
    // STEP 1 — CSRF fetch
    // HEAD request on the objectUrl: very lightweight (no body).
    // Uses executeHttpRequest so BTP Cloud Connector proxy handles auth correctly.
    // -------------------------------------------------

    log(`\n[STEP1] CSRF fetch (GET /sap/bc/adt/core/discovery)`);

    // Use /sap/bc/adt/core/discovery — same as fetchAdtCsrfToken() in server.js
    // which is proven to work via executeHttpRequest for activate/create-object.
    const csrfResp = await sdkRequest(destName, userJwt, {
        method: 'GET',
        url:    `${ADT_BASE}/core/discovery`,
        headers: {
            'X-CSRF-Token': 'Fetch',
            'Accept':       'application/atomsvc+xml, application/xml, */*'
        }
    });

    csrfToken     = csrfResp.headers['x-csrf-token'] || '';
    sessionCookie = parseCookies(csrfResp.headers['set-cookie']);

    log(`[STEP1] status=${csrfResp.status}`);
    log(`[STEP1] csrfToken=${csrfToken?.substring(0, 12)}`);
    log(`[STEP1] cookie=${sessionCookie}`);

    if (!csrfToken) {
        throw new Error(`CSRF token missing — /sap/bc/adt/core/discovery returned status=${csrfResp.status} without x-csrf-token`);
    }

    // -------------------------------------------------
    // STEP 2 — LOCK
    // -------------------------------------------------

    log(`\n[STEP2] LOCK object`);

    const lockHeaders = {
        'X-CSRF-Token':          csrfToken,
        'Accept':                'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
        'sap-adt-connection-id': connectionId
    };
    if (sessionCookie) lockHeaders['Cookie'] = sessionCookie;

    const lockResp = await sdkRequest(destName, userJwt, {
        method:  'POST',
        url:     `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
        headers: lockHeaders
    });

    log(`[STEP2] status=${lockResp.status}`);

    const lockCookie = parseCookies(lockResp.headers['set-cookie']);
    if (lockCookie) {
        sessionCookie = mergeCookies(sessionCookie, lockCookie);
        log(`[STEP2] cookie updated from lock response`);
    }

    const lockXml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
    log(`[STEP2] lock xml (first 500)=${lockXml.substring(0, 500)}`);

    const m =
        /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i.exec(lockXml) ||
        /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i.exec(lockXml) ||
        /<lockHandle[^>]*>([^<]+)<\/lockHandle>/i.exec(lockXml);

    if (!m) {
        log(`[STEP2] lock xml=${lockXml}`);
        throw new Error('LOCK_HANDLE not found in lock response');
    }

    lockHandle = m[1].trim();
    log(`[STEP2] lockHandle=${lockHandle}`);

    // Extract transport number (CORRNR) from lock response.
    // ADT requires corrNr in the PUT URL for objects in a transport request.
    // If caller didn't provide one, use the one returned by LOCK.
    const corrNrMatch = /<CORRNR[^>]*>([^<]+)<\/CORRNR>/i.exec(lockXml);
    // TODO: remove hardcode after test
    //const resolvedTransport = transport || (corrNrMatch ? corrNrMatch[1].trim() : '') || 'T4XK903271';
    const resolvedTransport = 'T4XK903271';
    log(`[STEP2] corrNr from lock=${corrNrMatch?.[1]?.trim() || '(none)'}, using transport=${resolvedTransport || '(none)'}`);

    // -------------------------------------------------
    // STEP 3 — SET SOURCE
    // -------------------------------------------------

    log(`\n[STEP3] SET SOURCE`);

    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    if (resolvedTransport) {
        putUrl += `&corrNr=${encodeURIComponent(resolvedTransport)}`;
    }
    log(`[STEP3] PUT url=${putUrl}`);

    const putHeaders = {
        'X-CSRF-Token':          csrfToken,
        'Content-Type':          'text/plain; charset=utf-8',
        'Accept':                'text/plain',
        'sap-adt-connection-id': connectionId
    };
    if (sessionCookie) putHeaders['Cookie'] = sessionCookie;

    log(`[STEP3] sending Cookie=${sessionCookie?.substring(0, 60)}...`);
    log(`[STEP3] sending X-CSRF-Token=${csrfToken?.substring(0, 12)}`);

    const putResp = await sdkRequest(destName, userJwt, {
        method:  'PUT',
        url:     putUrl,
        headers: putHeaders,
        data:    source
    });

    log(`[STEP3] status=${putResp.status}`);
    if (putResp.status >= 300) {
        const body = typeof putResp.data === 'string'
            ? putResp.data.substring(0, 800)
            : JSON.stringify(putResp.data).substring(0, 800);
        log(`[STEP3] ERROR body=${body}`);
    }

    const putCookie = parseCookies(putResp.headers['set-cookie']);
    if (putCookie) sessionCookie = mergeCookies(sessionCookie, putCookie);

    if (putResp.status >= 400) {
        const body = typeof putResp.data === 'string' ? putResp.data : JSON.stringify(putResp.data);
        const err  = new Error(`ADT set-source failed: HTTP ${putResp.status}`);
        err.downstreamStatus = putResp.status;
        err.downstreamBody   = body;
        throw err;
    }

    // -------------------------------------------------
    // STEP 4 — UNLOCK
    // -------------------------------------------------

    log(`\n[STEP4] UNLOCK`);

    const unlockHeaders = {
        'X-CSRF-Token':          csrfToken,
        'sap-adt-connection-id': connectionId
    };
    if (sessionCookie) unlockHeaders['Cookie'] = sessionCookie;

    const unlockResp = await sdkRequest(destName, userJwt, {
        method:  'POST',
        url:     `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
        headers: unlockHeaders
    });

    log(`[STEP4] status=${unlockResp.status}`);
    log(`\n========= ADT FLOW DONE =========\n`);

    return { lockHandle, sourceUrl };
}

module.exports = { adtSaveSource };
