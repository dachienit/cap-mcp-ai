const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const ADT_BASE = '/sap/bc/adt';

// Utility to parse array of Set-Cookie strings into a single Cookie string
function extractCookies(setCookieHeader) {
  if (!setCookieHeader) return '';
  const cookiesArr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return cookiesArr.map(c => c.split(';')[0]).join('; ');
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

  let csrfToken = '';
  let connectionId = '';
  let sessionCookieStr = '';
  
  const destParams = { destinationName: destName, jwt: userJwt };
  const sdkOptions = { fetchCsrfToken: false };

  // STEP 1 - CSRF
  log('[STEP1] Fetch CSRF');

  const csrfResp = await executeHttpRequest(
    destParams,
    {
      method: 'GET',
      url: `${ADT_BASE}/core/discovery`,
      headers: {
        'X-CSRF-Token': 'Fetch',
        'X-sap-adt-session-type': 'stateful'
      }
    },
    sdkOptions
  );

  csrfToken = csrfResp.headers['x-csrf-token'];
  const { randomUUID } = require('crypto');
  connectionId = csrfResp.headers['sap-adt-connection-id'] || randomUUID();
  
  sessionCookieStr = extractCookies(csrfResp.headers['set-cookie']);

  log(`[STEP1] status=${csrfResp.status}`);
  log(`[STEP1] csrf=${csrfToken?.substring(0,10)}`);
  log(`[STEP1] connectionId=${connectionId}`);
  log(`[STEP1] sessionCookieStr length=${sessionCookieStr.length}`);

  if (!csrfToken) throw new Error('CSRF token missing');

  // STEP 2 - LOCK
  log('[STEP2] LOCK object');

  const lockResp = await executeHttpRequest(
    destParams,
    {
      method: 'POST',
      url: `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId,
        'Cookie': sessionCookieStr,
        'Accept': '*/*'
      }
    },
    sdkOptions
  );log(`[STEP2] status=${lockResp.status}`)

  const xml = typeof lockResp.data === 'string'
    ? lockResp.data
    : JSON.stringify(lockResp.data)

  const lockHandle = extractLockHandle(xml)

  log(`[STEP2] lockHandle=${lockHandle}`)

  const lockCookies = extractCookies(lockResp.headers['set-cookie'])
  if (lockCookies) {
    sessionCookieStr = sessionCookieStr ? `${sessionCookieStr}; ${lockCookies}` : lockCookies;
  }
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

  let lockHandle = '';
  let connectionId = '';
  let csrfToken = '';
  let sessionCookieStr = '';

  const destParams = { destinationName: destName, jwt: userJwt };
  const sdkOptions = { fetchCsrfToken: false };

  try {
    // ── Step 1: CSRF fetch
    log(`\n========================================`);
    log(`[adtSaveSource] STEP 1: Fetching CSRF...`);
    log(`[adtSaveSource] URL: GET ${ADT_BASE}/core/discovery`);
    
    const csrfResp = await executeHttpRequest(
      destParams,
      {
        method: 'GET',
        url: `${ADT_BASE}/core/discovery`,
        headers: {
          'X-CSRF-Token': 'Fetch',
          'X-sap-adt-session-type': 'stateful'
        }
      },
      sdkOptions
    );
    
    csrfToken = csrfResp.headers['x-csrf-token'];
    const { randomUUID } = require('crypto');
    connectionId = csrfResp.headers['sap-adt-connection-id'] || randomUUID();
    sessionCookieStr = extractCookies(csrfResp.headers['set-cookie']);
    
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
    
    const lockResp = await executeHttpRequest(
      destParams,
      {
        method: 'POST',
        url: lockUrl,
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId,
          'Cookie': sessionCookieStr,
          'Accept': '*/*'
        }
      },
      sdkOptions
    );
    
    log(`[adtSaveSource] STEP 2 RESULT: HTTP ${lockResp.status}`);
    
    const lockCookies = extractCookies(lockResp.headers['set-cookie']);
    if (lockCookies) {
      sessionCookieStr = sessionCookieStr ? `${sessionCookieStr}; ${lockCookies}` : lockCookies;
    }
    log(`[adtSaveSource] Combined Cookies after Lock length: ${sessionCookieStr.length}`);

    if (lockResp.status >= 400) {
      const lockXml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
      throw new Error(`Lock failed with HTTP ${lockResp.status}: ${lockXml}`);
    }

    const xml = typeof lockResp.data === 'string' ? lockResp.data : JSON.stringify(lockResp.data);
    lockHandle = extractLockHandle(xml);
    if (!lockHandle && xml.length < 200 && !xml.includes('<')) lockHandle = xml.trim();
    if (!lockHandle) throw new Error('Could not parse lockHandle from ADT response');
    log(`[adtSaveSource] Lock Handle extracted: ${lockHandle}`);

    // ── Step 3: Set source
    let putUrl = `${sourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
    if (transport) putUrl += `&corrNr=${encodeURIComponent(transport)}`;
    
    log(`\n----------------------------------------`);
    log(`[adtSaveSource] STEP 3: Saving source code...`);
    log(`[adtSaveSource] URL: PUT ${putUrl}`);
    log(`[adtSaveSource] Payload Size: ${source?.length || 0} chars`);

    const putResp = await executeHttpRequest(
      destParams,
      {
        method: 'PUT',
        url: putUrl,
        data: source,
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId,
          'Cookie': sessionCookieStr,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      },
      sdkOptions
    );

    log(`[adtSaveSource] STEP 3 RESULT: HTTP ${putResp.status}`);
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
    
    const unlockResp = await executeHttpRequest(
      destParams,
      {
        method: 'DELETE',
        url: unlockUrl,
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId,
          'Cookie': sessionCookieStr
        }
      },
      sdkOptions
    );
    log(`[adtSaveSource] STEP 4 RESULT: HTTP ${unlockResp.status}`);
    log(`========================================\n`);

    return { success: true, lockHandle, sourceUrl };

  } catch (error) {
    log(`\n[adtSaveSource] ERROR OCCURRED: ${error.message}`);
    // Attempt cleanup unlock if we have a handle
    if (lockHandle && csrfToken) {
      log(`[adtSaveSource] Attempting Emergency Cleanup Unlock...`);
      try {
        const cleanUpResp = await executeHttpRequest(
          destParams,
          {
            method: 'DELETE',
            url: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
            headers: {
              'X-CSRF-Token': csrfToken,
              'X-sap-adt-session-type': 'stateful',
              'sap-adt-connection-id': connectionId,
              'Cookie': sessionCookieStr
            }
          },
          sdkOptions
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