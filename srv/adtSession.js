const axios = require('axios');
const { buildHttpRequest } = require('@sap-cloud-sdk/http-client');

const ADT_BASE = '/sap/bc/adt';

async function buildClient(destName, userJwt, log) {
  const destParams = { destinationName: destName, jwt: userJwt };
  
  // 1. Ask SAP Cloud SDK to build the full HTTP request config.
  // This automatically fetches the BTP Connectivity Proxy credentials,
  // proxy host, and creates the appropriate Http(s)ProxyAgent.
  const reqConfig = await buildHttpRequest(
    destParams, 
    { method: 'GET', url: ADT_BASE },
    { fetchCsrfToken: false }
  );

  // 2. We MUST enforce keep-alive so the TCP socket is not closed between
  // the Lock and Save steps. Cloud Connector strictly ties the ABAP session to the TCP connection.
  if (reqConfig.httpsAgent) {
    reqConfig.httpsAgent.keepAlive = true;
    reqConfig.httpsAgent.maxSockets = 1;
  }
  if (reqConfig.httpAgent) {
    reqConfig.httpAgent.keepAlive = true;
    reqConfig.httpAgent.maxSockets = 1;
  }

  // 3. Ensure the HTTP Connection header asks the proxy to stay open
  if (!reqConfig.headers) reqConfig.headers = {};
  reqConfig.headers['Connection'] = 'keep-alive';
  reqConfig.withCredentials = true;
  reqConfig.validateStatus = s => s < 500;

  log(`[buildClient] baseURL: ${reqConfig.baseURL}`);
  log(`[buildClient] has httpsAgent: ${!!reqConfig.httpsAgent}`);

  // 4. Create a single monolithic Axios instance
  return axios.create(reqConfig);
}

// Utility to properly parse and merge Set-Cookie arrays into a single Cookie string
function updateCookies(existingCookieStr, newSetCookieArr) {
  if (!newSetCookieArr) return existingCookieStr;
  
  const cookieMap = new Map();
  
  // Parse existing
  if (existingCookieStr) {
    existingCookieStr.split(';').forEach(c => {
      const parts = c.trim().split('=');
      if (parts.length >= 2) cookieMap.set(parts[0], parts.slice(1).join('='));
    });
  }
  
  // Parse new
  const cookiesArr = Array.isArray(newSetCookieArr) ? newSetCookieArr : [newSetCookieArr];
  cookiesArr.forEach(c => {
    const pair = c.split(';')[0].trim();
    const parts = pair.split('=');
    if (parts.length >= 2) cookieMap.set(parts[0], parts.slice(1).join('='));
  });
  
  const res = [];
  for (const [k, v] of cookieMap.entries()) {
    res.push(`${k}=${v}`);
  }
  return res.join('; ');
}

function extractLockHandle(xml) {

  const patterns = [
    /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i,
    /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i,
    /<lockHandle[^>]*>([^<]+)<\/lockHandle>/i
  ]

  for (const p of patterns) {
    const m = p.exec(xml)
    if (m) return m[1].trim()
  }

  return null
}

async function adtLockObject({
  destName,
  userJwt,
  objectUrl,
  log
}) {

  log = log || console.log;

  const client = await buildClient(destName, userJwt, log);

  let csrfToken = '';
  const { randomUUID } = require('crypto');
  let connectionId = randomUUID().replace(/-/g, '').toUpperCase();
  let sessionCookieStr = '';
  
  // STEP 1 - CSRF
  log('[STEP1] Fetch CSRF');

  const csrfResp = await client.get(`${ADT_BASE}/core/discovery`, {
    headers: {
      'X-CSRF-Token': 'Fetch',
      'X-sap-adt-session-type': 'stateful',
      'sap-adt-connection-id': connectionId
    }
  });

  csrfToken = csrfResp.headers['x-csrf-token'];
  connectionId = csrfResp.headers['sap-adt-connection-id'];
  if (!connectionId) {
    const { randomUUID } = require('crypto');
    connectionId = randomUUID().replace(/-/g, '').toUpperCase();
  }
  
  sessionCookieStr = updateCookies(sessionCookieStr, csrfResp.headers['set-cookie']);

  log(`[STEP1] status=${csrfResp.status}`);
  log(`[STEP1] csrf=${csrfToken?.substring(0,10)}`);
  log(`[STEP1] connectionId=${connectionId}`);
  log(`[STEP1] sessionCookieStr length=${sessionCookieStr.length}`);

  if (!csrfToken) throw new Error('CSRF token missing');

  // STEP 2 - LOCK
  log('[STEP2] LOCK object');

  const lockResp = await client.post(
    `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
    null,
    {
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId,
        'Cookie': sessionCookieStr,
        'Accept': '*/*'
      }
    }
  );log(`[STEP2] status=${lockResp.status}`)

  let lockHandle = lockResp.headers['x-sap-adt-lock-handle'] || lockResp.headers['x-sap-adt-lockhandle'];
  if (!lockHandle) {
    const xml = typeof lockResp.data === 'string'
      ? lockResp.data
      : JSON.stringify(lockResp.data)

    lockHandle = extractLockHandle(xml)
    if (!lockHandle && xml.length < 200 && !xml.includes('<')) lockHandle = xml.trim();
  }

  log(`[STEP2] lockHandle=${lockHandle}`)

  sessionCookieStr = updateCookies(sessionCookieStr, lockResp.headers['set-cookie']);
  log(`[STEP2] combined cookies length=${sessionCookieStr.length}`)

  if (!lockHandle) throw new Error('Cannot parse lockHandle')

  log('[ADT] LOCK completed')

  return {
    lockHandle
  }
}

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

  const client = await buildClient(destName, userJwt, log);

  let lockHandle = '';
  const { randomUUID } = require('crypto');
  let connectionId = randomUUID().replace(/-/g, '').toUpperCase();
  let csrfToken = '';
  let sessionCookieStr = '';

  try {
    // ── Step 1: CSRF fetch
    log(`\n========================================`);
    log(`[adtSaveSource] STEP 1: Fetching CSRF...`);
    log(`[adtSaveSource] URL: GET ${ADT_BASE}/core/discovery`);
    
    const csrfResp = await client.get(`${ADT_BASE}/core/discovery`, {
      headers: {
        'X-CSRF-Token': 'Fetch',
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId
      }
    });
    
    csrfToken = csrfResp.headers['x-csrf-token'];
    connectionId = csrfResp.headers['sap-adt-connection-id'];
    if (!connectionId) {
      const { randomUUID } = require('crypto');
      connectionId = randomUUID().replace(/-/g, '').toUpperCase();
    }
    sessionCookieStr = updateCookies(sessionCookieStr, csrfResp.headers['set-cookie']);
    
    log(`[adtSaveSource] STEP 1 RESULT: HTTP ${csrfResp.status}`);
    log(`[adtSaveSource] CSRF Token: ${csrfToken ? csrfToken.substring(0, 5) + '...' : 'MISSING'}`);
    log(`[adtSaveSource] Connection ID: ${connectionId}`);
    log(`[adtSaveSource] Session Cookies: ${sessionCookieStr || 'NONE'}`);

    if (!csrfToken) throw new Error('CSRF fetch failed to return a token');

    // ── Step 2: Lock
    const lockUrl = `${objectUrl}?_action=LOCK&accessMode=MODIFY`;
    log(`\n----------------------------------------`);
    log(`[adtSaveSource] STEP 2: Locking object...`);
    log(`[adtSaveSource] URL: POST ${lockUrl}`);
    log(`[adtSaveSource] Req Headers: X-CSRF-Token, X-sap-adt-session-type=stateful, sap-adt-connection-id, Cookie`);
    
    const lockResp = await client.post(
      lockUrl,
      null,
      {
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId,
          'Cookie': sessionCookieStr,
          'Accept': '*/*'
        }
      }
    );
    
    log(`[adtSaveSource] STEP 2 RESULT: HTTP ${lockResp.status}`);
    
    sessionCookieStr = updateCookies(sessionCookieStr, lockResp.headers['set-cookie']);
    log(`[adtSaveSource] Combined Cookies after Lock length: ${sessionCookieStr.length}`);

    if (lockResp.status >= 400) {
      const lockXml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
      throw new Error(`Lock failed with HTTP ${lockResp.status}: ${lockXml}`);
    }

    let extractedLockHandle = lockResp.headers['x-sap-adt-lock-handle'] || lockResp.headers['x-sap-adt-lockhandle'];
    
    if (!extractedLockHandle) {
      const xml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
      extractedLockHandle = extractLockHandle(xml);
      if (!extractedLockHandle && xml.length < 200 && !xml.includes('<')) extractedLockHandle = xml.trim();
    }
    
    lockHandle = extractedLockHandle;
    if (!lockHandle) throw new Error('Could not parse lockHandle from ADT response');
    log(`[adtSaveSource] Lock Handle extracted: ${lockHandle}`);

    log(`\n========================================`);
    log(`[adtSaveSource] 🛑 STOPPING HERE FOR SM12 TEST.`);
    log(`[adtSaveSource] Object should be locked now. Check SM12.`);
    log(`[adtSaveSource] If it's not locked, Cloud Connector has already dropped the session.`);
    log(`========================================\n`);
    
    // RETURN EARLY FOR TESTING!
    return { success: true, lockHandle, message: "Locked up to SM12 check point" };

    // ── Step 3: Set source
    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    if (transport) putUrl += `&corrNr=${encodeURIComponent(transport)}`;
    
    log(`\n----------------------------------------`);
    log(`[adtSaveSource] STEP 3: Saving source code...`);
    log(`[adtSaveSource] URL: PUT ${putUrl}`);
    log(`[adtSaveSource] Payload Size: ${source?.length || 0} chars`);

    const putResp = await client.put(putUrl, source, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId,
        'Cookie': sessionCookieStr,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });

    log(`[adtSaveSource] STEP 3 RESULT: HTTP ${putResp.status}`);
    sessionCookieStr = updateCookies(sessionCookieStr, putResp.headers['set-cookie']);
    if (putResp.status >= 400) {
      const putXml = typeof putResp.data === 'string' ? putResp.data : JSON.stringify(putResp.data);
      throw new Error(`Save source failed with HTTP ${putResp.status}: ${putXml}`);
    }
    log(`[adtSaveSource] Source saved successfully!`);

    // ── Step 4: Unlock
    const unlockUrl = `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`;
    log(`\n----------------------------------------`);
    log(`[adtSaveSource] STEP 4: Unlocking object...`);
    log(`[adtSaveSource] URL: DELETE ${unlockUrl}`);
    
    const unlockResp = await client.delete(unlockUrl, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId,
        'Cookie': sessionCookieStr
      }
    });
    sessionCookieStr = updateCookies(sessionCookieStr, unlockResp.headers['set-cookie']);
    log(`[adtSaveSource] STEP 4 RESULT: HTTP ${unlockResp.status}`);
    log(`========================================\n`);

    return { success: true, lockHandle, sourceUrl };

  } catch (error) {
    log(`\n[adtSaveSource] ERROR OCCURRED: ${error.message}`);
    // Attempt cleanup unlock if we have a handle
    if (lockHandle && csrfToken) {
      log(`[adtSaveSource] Attempting Emergency Cleanup Unlock...`);
      try {
        const cleanUpResp = await client.delete(
          `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
          {
            headers: {
              'X-CSRF-Token': csrfToken,
              'X-sap-adt-session-type': 'stateful',
              'sap-adt-connection-id': connectionId,
              'Cookie': sessionCookieStr
            }
          }
        );
        log(`[adtSaveSource] Cleanup unlock HTTP ${cleanUpResp.status}`);
      } catch (ue) {
        log(`[adtSaveSource] Cleanup unlock failed too: ${ue.message}`);
      }
    }
    throw error;
  }
}

module.exports = {
  adtLockObject,
  adtSaveSource
}