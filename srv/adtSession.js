'use strict';

/**
 * ADT Save Source — stateful flow
 *
 * ROOT CAUSE of 423: executeHttpRequest uses PP auth → ABAP creates NEW session
 * per request → lock created in session-A is released when that session ends →
 * PUT arrives in session-B → "not locked (invalid lock handle)".
 *
 * FIX: Step 1 (CSRF) uses SDK (PP) to establish an ABAP session and get the
 * MYSAPSSO2 + SAP_SESSIONID cookies. Steps 2-4 (LOCK, PUT, UNLOCK) use raw axios
 * through the CC proxy with ONLY these SSO cookies for auth (no PP headers).
 * ABAP reuses the existing session from the cookie → lock stays alive → PUT works.
 *
 * Flow:
 *   STEP 1  GET  /sap/bc/adt/core/discovery   → via SDK (PP) → get CSRF + cookies
 *   STEP 2  POST objectUrl?_action=LOCK        → via CC proxy (cookie auth, no PP)
 *   STEP 3  PUT  sourceUrl?lockHandle=...      → via CC proxy (same session)
 *   STEP 4  POST objectUrl?_action=UNLOCK      → via CC proxy (same session)
 */

const ADT_BASE = '/sap/bc/adt';

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function parseCookies(setCookieHeader) {
    if (!setCookieHeader) return '';
    const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return list.map(c => c.split(';')[0]).join('; ');
}

function mergeCookies(existing, incoming) {
    if (!incoming) return existing || '';
    if (!existing) return incoming;
    const map = new Map();
    for (const part of `${existing}; ${incoming}`.split('; ')) {
        const eq = part.indexOf('=');
        const name = eq >= 0 ? part.substring(0, eq).trim() : part.trim();
        if (name) map.set(name, part.trim());
    }
    return [...map.values()].join('; ');
}

/* ─── STEP 1: CSRF via SDK (PP) ───────────────────────────────────────────── */

async function sdkCsrfFetch(destName, jwt, log) {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const resp = await executeHttpRequest(
        { destinationName: destName, jwt },
        {
            method: 'GET',
            url: `${ADT_BASE}/core/discovery`,
            headers: {
                'X-CSRF-Token': 'Fetch',
                'Accept': 'application/atomsvc+xml, application/xml, */*'
            },
            validateStatus: () => true
        }
    );
    const csrfToken = resp.headers['x-csrf-token'] || '';
    const sessionCookie = parseCookies(resp.headers['set-cookie']);
    log(`[STEP1] status=${resp.status}, csrfToken=${csrfToken.substring(0, 12)}`);
    log(`[STEP1] cookie=${sessionCookie.substring(0, 100)}`);
    return { csrfToken, sessionCookie };
}

/* ─── CC proxy config (for raw axios calls WITHOUT PP) ──────────────────── */

async function getCcProxy(destName, jwt, log) {
    const { getDestination } = require('@sap-cloud-sdk/connectivity');
    const dest = await getDestination({ destinationName: destName, jwt });
    const pc = dest.proxyConfiguration || {};
    log(`[CC] baseURL=${dest.url}, proxy=${pc.host}:${pc.port}`);
    return {
        baseURL: dest.url,
        proxyHost: pc.host,
        proxyPort: parseInt(pc.port, 10) || 20003,
        proxyHeaders: pc.headers || {}   // contains Proxy-Authorization (connectivity JWT)
    };
}

/* ─── raw CC call (no PP) ─────────────────────────────────────────────────── */

async function ccCall(cc, { method, path, headers = {}, body }) {
    const axios = require('axios');
    // Merge Proxy-Authorization into request headers (Node.js axios recognises it)
    const reqHeaders = { ...cc.proxyHeaders, ...headers };

    const resp = await axios({
        method,
        url: `${cc.baseURL}${path}`,
        proxy: { host: cc.proxyHost, port: cc.proxyPort },
        headers: reqHeaders,
        data: body !== undefined ? body : undefined,
        validateStatus: () => true,
        maxRedirects: 0
    });
    return { status: resp.status, headers: resp.headers || {}, data: resp.data };
}

/* ─── main export ─────────────────────────────────────────────────────────── */

async function adtSaveSource({ destName, userJwt, objectUrl, sourceUrl, source, transport, log }) {
    log = log || console.log;
    const connectionId = require('crypto').randomUUID().replace(/-/g, '');

    log(`\n========= ADT SAVE SOURCE FLOW =========`);
    log(`[ADT] dest=${destName}`);
    log(`[ADT] object=${objectUrl}`);
    log(`[ADT] source=${sourceUrl}`);
    log(`[ADT] connectionId=${connectionId}`);

    // ── STEP 1: CSRF via SDK (PP) ─────────────────────────────────────────
    log(`\n[STEP1] CSRF fetch (SDK/PP)`);
    const { csrfToken, sessionCookie } = await sdkCsrfFetch(destName, userJwt, log);
    if (!csrfToken) throw new Error(`CSRF token missing from /sap/bc/adt/core/discovery`);

    // ── Get CC proxy config ───────────────────────────────────────────────
    log(`\n[CC] Resolving CC proxy config`);
    const cc = await getCcProxy(destName, userJwt, log);

    const baseHeaders = {
        'Cookie': sessionCookie,
        'X-CSRF-Token': csrfToken,
        'sap-adt-connection-id': connectionId
    };

    // ── STEP 2: LOCK via CC proxy (SSO cookie, no PP) ─────────────────────
    log(`\n[STEP2] LOCK (CC proxy / SSO cookie)`);
    const lockResp = await ccCall(cc, {
        method: 'POST',
        path: `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
        headers: {
            ...baseHeaders,
            'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8'
        }
    });

    log(`[STEP2] status=${lockResp.status}`);
    const lockXml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
    log(`[STEP2] xml=${lockXml.substring(0, 400)}`);

    if (lockResp.status >= 400) {
        const err = new Error(`LOCK failed: HTTP ${lockResp.status}`);
        err.downstreamStatus = lockResp.status;
        err.downstreamBody = lockXml.substring(0, 500);
        throw err;
    }

    // Update cookies from lock response if any
    const lockCookie = parseCookies(lockResp.headers['set-cookie']);
    const cookieAfterLock = lockCookie ? mergeCookies(sessionCookie, lockCookie) : sessionCookie;

    const mHandle =
        /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i.exec(lockXml) ||
        /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i.exec(lockXml) ||
        /<lockHandle[^>]*>([^<]+)<\/lockHandle>/i.exec(lockXml);

    if (!mHandle) throw new Error(`LOCK_HANDLE not found in: ${lockXml.substring(0, 200)}`);
    const lockHandle = mHandle[1].trim();

    const mCorrNr = /<CORRNR[^>]*>([^<]+)<\/CORRNR>/i.exec(lockXml);
    const resolvedTransport = transport || (mCorrNr ? mCorrNr[1].trim() : '');
    log(`[STEP2] lockHandle=${lockHandle}, transport=${resolvedTransport || '(none)'}`);

    // ── STEP 3: PUT source via CC proxy ───────────────────────────────────
    log(`\n[STEP3] SET SOURCE (CC proxy / SSO cookie)`);
    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    if (resolvedTransport) putUrl += `&corrNr=${encodeURIComponent(resolvedTransport)}`;
    log(`[STEP3] PUT ${putUrl}`);

    const putResp = await ccCall(cc, {
        method: 'PUT',
        path: putUrl,
        headers: {
            ...baseHeaders,
            'Cookie': cookieAfterLock,
            'Content-Type': 'text/plain; charset=utf-8',
            'Accept': 'text/plain'
        },
        body: source
    });

    log(`[STEP3] status=${putResp.status}`);
    const putCookie = parseCookies(putResp.headers['set-cookie']);
    const cookieAfterPut = putCookie ? mergeCookies(cookieAfterLock, putCookie) : cookieAfterLock;

    if (putResp.status >= 400) {
        const body = typeof putResp.data === 'string' ? putResp.data : JSON.stringify(putResp.data);
        log(`[STEP3] ERROR body=${body.substring(0, 600)}`);
        const err = new Error(`set-source failed: HTTP ${putResp.status}`);
        err.downstreamStatus = putResp.status;
        err.downstreamBody = body;
        throw err;
    }

    // ── STEP 4: UNLOCK via CC proxy ───────────────────────────────────────
    log(`\n[STEP4] UNLOCK (CC proxy / SSO cookie)`);
    const unlockResp = await ccCall(cc, {
        method: 'POST',
        path: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
        headers: { ...baseHeaders, 'Cookie': cookieAfterPut }
    });

    log(`[STEP4] status=${unlockResp.status}`);
    log(`\n========= ADT FLOW DONE =========\n`);

    return { lockHandle, sourceUrl };
}

module.exports = { adtSaveSource };
