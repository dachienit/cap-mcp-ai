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

module.exports = {
  adtLockObject
}