const axios = require('axios')
const https = require('https')
const http = require('http')

const { wrapper } = require('axios-cookiejar-support')
const { CookieJar } = require('tough-cookie')

const { getDestination } = require('@sap-cloud-sdk/connectivity')

const ADT_BASE = '/sap/bc/adt'

const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 1
})
const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 1
})

async function buildClient(destName, jwt, log) {

  const dest = await getDestination({
    destinationName: destName,
    jwt
  })

  if (!dest) throw new Error(`Destination ${destName} not found`)

  log(`[ADT] destination URL=${dest.url}`)

  const jar = new CookieJar()

const client = wrapper(axios.create({
  baseURL: dest.url,
  jar,
  withCredentials: true,
  //httpAgent: HTTP_AGENT,
  //httpsAgent: HTTPS_AGENT,
  headers: {
    Authorization: `Bearer ${jwt}`,
    'User-Agent': 'Eclipse/4.37.0 ADT/3.52.0',
    'Connection': 'keep-alive'
  },
  validateStatus: s => s < 500
}))
  
/*     if (dest.proxyConfiguration) {

  const proxy = dest.proxyConfiguration

  client.defaults.proxy = {
    protocol: proxy.protocol,
    host: proxy.host,
    port: Number(proxy.port)
  }

  if (proxy.headers && proxy.headers['Proxy-Authorization']) {
    client.defaults.headers['Proxy-Authorization'] =
      proxy.headers['Proxy-Authorization']
  }

}
log(`[ADT] proxy host=${dest.proxyConfiguration?.host}`)
log(`[ADT] proxy port=${dest.proxyConfiguration?.port}`) */

  return { client, jar }
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

  log = log || console.log

  const { client, jar } = await buildClient(destName, userJwt, log)

  let csrfToken = ''
  let connectionId = ''

  // STEP 1 - CSRF
  log('[STEP1] Fetch CSRF')

  const csrfResp = await client.get(`${ADT_BASE}/core/discovery`, {
    headers: {
      'X-CSRF-Token': 'Fetch',
      'X-sap-adt-session-type': 'stateful'
    }
  })

  csrfToken = csrfResp.headers['x-csrf-token']
  const { randomUUID } = require('crypto')
  connectionId = csrfResp.headers['sap-adt-connection-id'] || randomUUID()
  //onnectionId = csrfResp.headers['sap-adt-connection-id'] || ''

  log(`[STEP1] status=${csrfResp.status}`)
  log(`[STEP1] csrf=${csrfToken?.substring(0,10)}`)
  log(`[STEP1] connectionId=${connectionId}`)
  log(`[STEP1] set-cookie=${csrfResp.headers['set-cookie']}`)

  //const cookies = await jar.getCookies(destName)
  const cookies = await jar.getCookies(client.defaults.baseURL)
  log(`[STEP1] cookies=${cookies.map(c => c.key).join(',')}`)

  if (!csrfToken) throw new Error('CSRF token missing')

  // STEP 2 - LOCK
  log('[STEP2] LOCK object')

  const lockResp = await client.post(
    `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
    null,
    {
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId
      }
    }
  )

  log(`[STEP2] status=${lockResp.status}`)

  const xml = typeof lockResp.data === 'string'
    ? lockResp.data
    : JSON.stringify(lockResp.data)

  const lockHandle = extractLockHandle(xml)

  log(`[STEP2] lockHandle=${lockHandle}`)

  const cookies2 = await jar.getCookies(destName)
  log(`[STEP2] cookies=${cookies2.map(c => c.key).join(',')}`)

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
  const { client, jar } = await buildClient(destName, userJwt, log);

  let lockHandle = '';
  let connectionId = '';
  let csrfToken = '';

  try {
    // ── Step 1: CSRF fetch
    log(`\n========================================`);
    log(`[adtSaveSource] STEP 1: Fetching CSRF...`);
    log(`[adtSaveSource] URL: GET ${ADT_BASE}/core/discovery`);
    
    const csrfResp = await client.get(`${ADT_BASE}/core/discovery`, {
      headers: {
        'X-CSRF-Token': 'Fetch',
        'X-sap-adt-session-type': 'stateful'
      }
    });
    
    csrfToken = csrfResp.headers['x-csrf-token'];
    const { randomUUID } = require('crypto');
    connectionId = csrfResp.headers['sap-adt-connection-id'] || randomUUID();
    
    log(`[adtSaveSource] STEP 1 RESULT: HTTP ${csrfResp.status}`);
    log(`[adtSaveSource] CSRF Token: ${csrfToken ? csrfToken.substring(0, 5) + '...' : 'MISSING'}`);
    log(`[adtSaveSource] Connection ID: ${connectionId}`);
    
    const cookies1 = await jar.getCookies(client.defaults.baseURL);
    log(`[adtSaveSource] Session Cookies: ${cookies1.map(c => c.key).join(', ') || 'NONE'}`);

    if (!csrfToken) throw new Error('CSRF fetch failed to return a token');

    // ── Step 2: Lock
    const lockUrl = `${objectUrl}?_action=LOCK&accessMode=MODIFY`;
    log(`\n----------------------------------------`);
    log(`[adtSaveSource] STEP 2: Locking object...`);
    log(`[adtSaveSource] URL: POST ${lockUrl}`);
    log(`[adtSaveSource] Req Headers: X-CSRF-Token, X-sap-adt-session-type=stateful, sap-adt-connection-id`);
    
    const lockResp = await client.post(
      lockUrl,
      null,
      {
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId,
          'Accept': '*/*'
        }
      }
    );
    
    log(`[adtSaveSource] STEP 2 RESULT: HTTP ${lockResp.status}`);
    const cookies2 = await jar.getCookies(client.defaults.baseURL);
    log(`[adtSaveSource] Session Cookies after Lock: ${cookies2.map(c => c.key).join(', ')}`);

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

    const putResp = await client.put(putUrl, source, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-sap-adt-session-type': 'stateful',
        'sap-adt-connection-id': connectionId,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });

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
    
    const unlockResp = await client.delete(
      unlockUrl,
      {
        headers: {
          'X-CSRF-Token': csrfToken,
          'X-sap-adt-session-type': 'stateful',
          'sap-adt-connection-id': connectionId
        }
      }
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
        const cleanUpResp = await client.delete(
          `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
          {
            headers: {
              'X-CSRF-Token': csrfToken,
              'X-sap-adt-session-type': 'stateful',
              'sap-adt-connection-id': connectionId
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