/**
 * api.js — Centralized API client for MCP ADT Manager
 * All calls go through /api/adt/* backed by SAP Cloud SDK + BTP Destination
 */

let csrfToken = null;

export function setCsrfToken(token) {
    csrfToken = token;
}

async function post(endpoint, body) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken || ''
        },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

/**
 * Fetch user info and CSRF token
 */
export async function fetchUserInfo() {
    const res = await fetch('/api/me', {
        headers: { 'X-CSRF-Token': 'Fetch' }
    });
    const token = res.headers.get('X-CSRF-Token');
    if (token) setCsrfToken(token);
    if (!res.ok) throw new Error('Not authenticated');
    return await res.json();
}

/**
 * Search ABAP repository objects
 * @param {string} destinationName BTP Destination name
 * @param {string} query Search term
 * @param {string} objectType Optional: PROG, CLAS, FUNC, INTF, etc.
 * @param {number} maxResults
 */
export async function searchObject(destinationName, query, objectType = '', maxResults = 50) {
    return post('/api/adt/search', { destinationName, query, objectType, maxResults });
}

/**
 * Search ABAP packages (DEVC)
 */
export async function searchPackage(destinationName, query, maxResults = 50) {
    return post('/api/adt/search-package', { destinationName, query, maxResults });
}

/**
 * Get active transports for a package
 */
export async function getTransports(destinationName, packageName) {
    return post('/api/adt/transports', { destinationName, packageName });
}

/**
 * Get source code of an existing object
 */
export async function getObjectSource(destinationName, objectUrl) {
    return post('/api/adt/get-source', { destinationName, objectUrl });
}

/**
 * Create a new ABAP object
 * @param {object} params { destinationName, objectType, name, packageName, description, responsible }
 */
export async function createObject(params) {
    return post('/api/adt/create-object', params);
}

/**
 * Lock an ABAP object for editing
 * Returns { lockHandle }
 */
export async function lockObject(destinationName, objectUrl) {
    return post('/api/adt/lock', { destinationName, objectUrl });
}

/**
 * Upload source code to a locked object
 * @param {string} sourceUrl - Actual source URL from get-source response (may differ from objectUrl/source/main for classes)
 */
export async function setObjectSource(destinationName, objectUrl, lockHandle, source, sourceUrl = null, sessionCookie = null, lockCsrfToken = null) {
    return post('/api/adt/set-source', { destinationName, objectUrl, lockHandle, source, sourceUrl, sessionCookie, lockCsrfToken });
}

/**
 * Combined lock + set-source + unlock in ONE backend request.
 * Fixes the 423 "invalid lock handle" error on BTP caused by Cloud Connector
 * using different TCP connections (and different ABAP sessions) for separate requests.
 * @param {string} destinationName
 * @param {string} objectUrl  - ADT object URI (e.g. /sap/bc/adt/oo/classes/zcl_my_class)
 * @param {string} source     - ABAP source code to save
 * @param {string} sourceUrl  - Specific source URL (optional, defaults to objectUrl/source/main)
 * @param {string} transport  - Transport request number (optional)
 */
export async function saveObjectSource(destinationName, objectUrl, source, sourceUrl = null, transport = null) {
    return post('/api/adt/set-source', { destinationName, objectUrl, source, sourceUrl, transport });
    //return post('/api/adt/save-source', { destinationName, objectUrl, source, sourceUrl, transport });
}

/**
 * Unlock an ABAP object
 */
export async function unlock(destinationName, objectUrl, lockHandle, sessionCookie = null, lockCsrfToken = null) {
    return post('/api/adt/unlock', { destinationName, objectUrl, lockHandle, sessionCookie, lockCsrfToken });
}

/**
 * Activate one or more ABAP objects
 * @param {string} destinationName
 * @param {Array<{name, type, url}>} objects
 */
export async function activateObjects(destinationName, objects) {
    return post('/api/adt/activate', { destinationName, objects });
}
