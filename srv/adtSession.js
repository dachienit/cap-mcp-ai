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
  log
}) {
  log = log || console.log;

  // We use the new STANDALONE SICF endpoint which handles Lock->Save->Unlock internally.
  // This avoids all BTP Proxy / Cloud Connector session drop issues.
  const CUSTOM_SICF_PATH = '/mcp/taf/octoagent';

  log(`\n========================================`);
  log(`[adtSaveSource] CALLING STANDALONE SICF API`);
  log(`[adtSaveSource] Path: ${CUSTOM_SICF_PATH}`);
  log(`[adtSaveSource] Object: ${objectUrl}`);
  
  const client = await buildClient(destName, userJwt, log);

  try {
    const csrf = await fetchAdtCsrfToken(destName, userJwt);

    
/*     const response = await client.post(CUSTOM_SICF_PATH, {
      objecturl: objectUrl,
      sourceurl: sourceUrl,
      sourcecode: source
    }); */

    log(`[adtSaveSource] API Status: ${response.status}`);
    log(`[adtSaveSource] API Body: ${JSON.stringify(response.data)}`);

    if (response.status !== 200 || !response.data.success) {
      throw new Error(response.data.message || `API Error HTTP ${response.status}`);
    }

    log(`[adtSaveSource] SUCCESS: ${response.data.message}`);
    log(`========================================\n`);

    return { 
      success: true, 
      message: response.data.message,
      sourceUrl 
    };

  } catch (error) {
    const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
    log(`[adtSaveSource] FAILED: ${errorDetail}`);
    throw new Error(`Failed to save via SICF Handler: ${errorDetail}`);
  }
}

module.exports = {
  adtLockObject,
  adtSaveSource
}