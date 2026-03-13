const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
    if (process.env.NODE_ENV === 'production') {
        const passport = require('passport');
        const { XssecPassportStrategy, XsuaaService } = require('@sap/xssec');
        const xsenv = require('@sap/xsenv');
        try {
            const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
            passport.use('JWT', new XssecPassportStrategy(new XsuaaService(services.uaa)));
            app.use('/api', passport.initialize());
            app.use('/api', passport.authenticate('JWT', { session: false }));
        } catch (error) {
            console.error('[auth] Error setting up XSUAA JWT Strategy:', error);
        }
    }

    const express = require('express');
    app.use(express.json());

    // ADT base path â€” SAP ICF node for ABAP Development Tools
    // Cloud Connector must expose this path: /sap/bc/adt
    const ADT_BASE = '/sap/bc/adt';

    //   Authorization header = XSUAA JWT forwarded by approuter â†’ use this FIRST for PP
    //   authInfo.getToken() = fallback only
    function getUserJwt(req) {
        const authHeader = req.headers.authorization;
        const jwtFromHeader = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.substring(7)
            : null;
        const jwtFromAuthInfo = req.authInfo && typeof req.authInfo.getToken === 'function'
            ? req.authInfo.getToken()
            : null;
        return jwtFromHeader || jwtFromAuthInfo || null;
    }

    async function callAdt(destinationName, jwt, options, cookies = null, connectionId = null) {
        const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
        try {
            options.headers = options.headers || {};
            if (cookies) {
                options.headers['Cookie'] = cookies;
                // CRITICAL: ABAP requires this header in EVERY request within a stateful session 
                // to keep the session alive and prevent premature unlocking.
                options.headers['X-sap-adt-session-type'] = 'stateful';
            }
            if (connectionId) {
                options.headers['sap-adt-connection-id'] = connectionId;
            }
            return await executeHttpRequest(
                { destinationName, jwt },
                options
            );
        } catch (err) {
            // Enrich error with downstream HTTP status so we can forward it to client
            const downstreamStatus = err.response?.status || err.cause?.response?.status;
            const downstreamBody = err.response?.data || err.cause?.response?.data;
            if (downstreamStatus) {
                err.downstreamStatus = downstreamStatus;
                err.downstreamBody = downstreamBody;
            }
            throw err;
        }
    }

    function handleAdtError(res, err, endpoint) {
        const status = err.downstreamStatus || 500;
        console.error(`[adt/${endpoint}] Error (HTTP ${status}):`, err.message);
        if (err.downstreamBody) {
            console.error(`[adt/${endpoint}] Downstream:`, JSON.stringify(err.downstreamBody).substring(0, 500));
        }
        return res.status(status).json({
            error: err.message,
            downstream: err.downstreamBody,
            endpoint
        });
    }

    /**
     * Helper to enforce that a session is established before allowing ADT operations.
     */
    function requireAdtSession(req, res) {
        const cookies = req.headers['x-adt-session-cookies'];
        if (!cookies || cookies === 'null') {
            res.status(401).json({ error: 'Not connected to SAP system. Please click the "Connect" button first.' });
            return null;
        }
        return cookies;
    }

    // write requests can send the same cookie, letting SAP match the session.
    async function fetchAdtCsrfToken(destinationName, jwt, cookies = null) {
        const resp = await callAdt(destinationName, jwt, {
            method: 'GET',
            url: `${ADT_BASE}/core/discovery`,
            headers: { 'X-CSRF-Token': 'Fetch', 'Accept': 'application/atomsvc+xml, application/xml, */*' }
        }, cookies);
        const token = resp.headers['x-csrf-token'] || resp.headers['X-CSRF-Token'] || '';
        // Extract session cookie(s) â€” strip path/domain/max-age directives, keep name=value pairs
        const setCookieHeader = resp.headers['set-cookie'];
        let cookie = '';
        if (Array.isArray(setCookieHeader)) {
            cookie = setCookieHeader.map(c => c.split(';')[0]).join('; ');
        } else if (setCookieHeader) {
            cookie = setCookieHeader.split(';')[0];
        }
        console.log(`[csrf] token=${token?.substring(0, 10) || '(empty)'}, cookie_length=${cookie?.length || 0}`);
        // Return BOTH the new cookie (if any) and the existing cookies to maintain session
        return { token, cookie: cookie || cookies };
    }

    // Helper: build headers with CSRF token + session cookie
    function csrfHeaders(csrfResult, extra = {}) {
        const h = { 'X-CSRF-Token': csrfResult.token, ...extra };
        if (csrfResult.cookie) h['Cookie'] = csrfResult.cookie;
        return h;
    }

    app.get('/api/me', (req, res) => {
        if (req.authInfo) {
            res.json({
                userId: req.authInfo.getLogonName(),
                email: req.authInfo.getEmail(),
                firstName: req.authInfo.getGivenName(),
                lastName: req.authInfo.getFamilyName()
            });
        } else if (process.env.NODE_ENV !== 'production') {
            res.json({
                userId: 'dev-user',
                email: 'dev@local.host',
                firstName: 'Local',
                lastName: 'Developer'
            });
        } else {
            res.status(401).json({ error: 'Not authenticated' });
        }
    });

    app.post('/api/fetch-bom', async (req, res) => {
        try {
            const destinationName = req.body?.destinationName || 'T4X_011';
            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    data: [
                        { BillOfMaterialItemCategory: 'L', Language: 'EN', BillOfMaterialItemCategoryDesc: 'Stock item (Mock)' },
                        { BillOfMaterialItemCategory: 'N', Language: 'EN', BillOfMaterialItemCategoryDesc: 'Non-stock item (Mock)' },
                        { BillOfMaterialItemCategory: 'T', Language: 'EN', BillOfMaterialItemCategoryDesc: 'Text item (Mock)' }
                    ]
                });
            }
            const jwt = getUserJwt(req);
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV/A_BOMItemCategoryText',
                headers: { Accept: 'application/json' }
            });
            const results = response.data.d?.results || response.data.value || response.data;
            res.json({ success: true, data: results });
        } catch (error) {
            console.error('[bom-fetch] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/adt/login', async (req, res) => {
        try {
            const { destinationName } = req.body;
            if (!destinationName) return res.status(400).json({ error: 'Missing destinationName' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, cookies: 'sap-usercontext=sap-client=001; sap-session-id=MOCK_SESSION', discovery: { systemId: 'MOCK' } });
            }

            const jwt = getUserJwt(req);
            const connectionId = req.headers['x-adt-connection-id'];
            // Request stateful session via compatibility graph
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: `${ADT_BASE}/compatibility/graph`,
                headers: { 
                    'Accept': 'application/xml',
                    'X-sap-adt-session-type': 'stateful'
                }
            }, null, connectionId);

            const setCookieHeader = response.headers['set-cookie'];
            let cookies = '';
            if (Array.isArray(setCookieHeader)) {
                cookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
            } else if (setCookieHeader) {
                cookies = setCookieHeader.split(';')[0];
            }

            res.json({ success: true, cookies, discovery: response.data });
        } catch (error) {
            handleAdtError(res, error, 'login');
        }
    });

    app.post('/api/adt/logout', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName } = req.body;
            if (!destinationName) return res.status(400).json({ error: 'Missing destinationName' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true });
            }

            const jwt = getUserJwt(req);
            const connectionId = req.headers['x-adt-connection-id'];
            // Terminate ADT session. Note: some systems prefer /sessions/ vs /sessions
            try {
                await callAdt(destinationName, jwt, {
                    method: 'DELETE',
                    url: `${ADT_BASE}/sessions`
                }, cookies, connectionId);
            } catch (err) {
                console.warn('[adt/logout] DELETE /sessions failed, trying alternative:', err.message);
            }

            res.json({ success: true, message: 'Logged out from SAP' });
        } catch (error) {
            console.error('[adt/logout] Error:', error.message);
            // Even if server session termination fails, we return success so client clears its state
            res.json({ success: true, warning: 'Client session cleared' });
        }
    });

    app.post('/api/adt/search', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, query, objectType = '', maxResults = 50 } = req.body;
            if (!destinationName || !query) return res.status(400).json({ error: 'Missing destinationName or query' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    data: [
                        { name: `Z_PROG_${query.toUpperCase()}_01`, type: 'PROG', description: 'Mock ABAP Program', packageName: 'ZLOCAL' },
                        { name: `ZCL_${query.toUpperCase()}_HANDLER`, type: 'CLAS', description: 'Mock ABAP Class', packageName: 'ZLOCAL' },
                        { name: `ZFUNC_${query.toUpperCase()}`, type: 'FUNC', description: 'Mock Function Module', packageName: 'ZFUNC_GRP' }
                    ]
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/search] user=${logonName}, dest=${destinationName}, query=${query}, jwt_present=${!!jwt}`);

            let url = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query + '*')}&maxResults=${maxResults}&reposistoryScope=ALL`;
            if (objectType) url += `&objectType=${encodeURIComponent(objectType)}`;

            const connectionId = req.headers['x-adt-connection-id'];
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: {
                    // ADT search result format
                    'Accept': 'application/vnd.sap.adt.repository.informationsystem.search.result.v1+xml, application/xml',
                    'sap-client': process.env.SAP_CLIENT || ''
                }
            }, cookies, connectionId);

            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.log(`[adt/search] response status=${response.status}, body_length=${xml.length}`);

            // Parse ADT XML search results â€” extract object name, type, description, package
            const objects = [];
            // Match <adtcore:objectReference ... /> elements
            const refPattern = /<(?:adtcore:objectReference|atom:entry)[^>]*?>/gm;
            // Broader attribute extraction
            const namePattern = /adtcore:name="([^"]+)"/;
            const typePattern = /adtcore:type="([^"]+)"/;
            const descPattern = /adtcore:description="([^"]*)"/;
            const pkgPattern = /adtcore:packageName="([^"]*)"/;
            const uriPattern = /adtcore:uri="([^"]*)"/;

            let match;
            while ((match = refPattern.exec(xml)) !== null) {
                const tag = match[0];
                const name = (namePattern.exec(tag) || [])[1];
                const type = (typePattern.exec(tag) || [])[1];
                if (name && type) {
                    objects.push({
                        name,
                        type,
                        description: (descPattern.exec(tag) || [])[1] || '',
                        packageName: (pkgPattern.exec(tag) || [])[1] || '',
                        url: (uriPattern.exec(tag) || [])[1] || ''
                    });
                }
            }

            res.json({ success: true, data: objects });
        } catch (error) {
            return handleAdtError(res, error, 'search');
        }
    });

    app.post('/api/adt/search-package', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, query, maxResults = 50 } = req.body;
            if (!destinationName || !query) return res.status(400).json({ error: 'Missing destinationName or query' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    data: [
                        { name: `Z${query.toUpperCase()}`, type: 'DEVC', description: 'Mock Package 1', superPackage: '$TMP' },
                        { name: `Z${query.toUpperCase()}_UTILS`, type: 'DEVC', description: 'Mock Package 2', superPackage: '$TMP' }
                    ]
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/search-package] user=${logonName}, dest=${destinationName}, query=${query}`);

            const isExact = !query.includes('*');
            let objects = [];

            if (!isExact) {
                // Wildcard search: list matching packages
                const url = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=${maxResults}&objectType=DEVC%2FK`;
                const connectionId = req.headers['x-adt-connection-id'];
                const response = await callAdt(destinationName, jwt, {
                    method: 'GET',
                    url,
                    headers: { 'Accept': 'application/xml' }
                }, cookies, connectionId);
                
                const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                const refPattern = /<(?:adtcore:objectReference)[^>]*?>/gm;
                const namePattern = /adtcore:name="([^"]+)"/;
                const descPattern = /adtcore:description="([^"]*)"/;
                let match;
                while ((match = refPattern.exec(xml)) !== null) {
                    const tag = match[0];
                    const name = (namePattern.exec(tag) || [])[1];
                    if (name) objects.push({ name, type: 'DEVC', description: (descPattern.exec(tag) || [])[1] || '' });
                }
            } else {
                // Exact search: get package info AND its objects
                // 1. Get the package itself
                const pkgUrl = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=1&objectType=DEVC%2FK`;
                const connectionId = req.headers['x-adt-connection-id'];
                const pkgResponse = await callAdt(destinationName, jwt, {
                    method: 'GET',
                    url: pkgUrl,
                    headers: { 'Accept': 'application/xml' }
                }, cookies, connectionId);
                
                let pkgXml = typeof pkgResponse.data === 'string' ? pkgResponse.data : JSON.stringify(pkgResponse.data);
                const pkgRefPattern = /<(?:adtcore:objectReference)[^>]*?>/gm;
                const namePattern = /adtcore:name="([^"]+)"/;
                const descPattern = /adtcore:description="([^"]*)"/;
                let match;
                let pkgFound = false;
                while ((match = pkgRefPattern.exec(pkgXml)) !== null) {
                    const tag = match[0];
                    const name = (namePattern.exec(tag) || [])[1];
                    if (name && name.toUpperCase() === query.toUpperCase()) {
                        objects.push({ name, type: 'DEVC', description: (descPattern.exec(tag) || [])[1] || '' });
                        pkgFound = true;
                        break;
                    }
                }

                if (pkgFound) {
                    // 2. Get all objects in package
                    let limit = parseInt(maxResults, 10);
                    if (isNaN(limit) || limit < 1) limit = 50;
                    
                    const contentsUrl = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=*&packageName=${encodeURIComponent(query)}&maxResults=${limit}`;
                    const connectionId = req.headers['x-adt-connection-id'];
                    const contentsResp = await callAdt(destinationName, jwt, {
                        method: 'GET',
                        url: contentsUrl,
                        headers: { 'Accept': 'application/vnd.sap.adt.repository.informationsystem.search.result.v1+xml, application/xml' }
                    }, cookies, connectionId);
                    
                    const xml = typeof contentsResp.data === 'string' ? contentsResp.data : JSON.stringify(contentsResp.data);
                    const refPattern = /<(?:adtcore:objectReference)[^>]*?>/gm;
                    const typePattern = /adtcore:type="([^"]+)"/;
                    const uriPattern = /adtcore:uri="([^"]*)"/;
                    const pkgPattern = /adtcore:packageName="([^"]*)"/;
                    
                    while ((match = refPattern.exec(xml)) !== null) {
                        const tag = match[0];
                        const name = (namePattern.exec(tag) || [])[1];
                        const type = (typePattern.exec(tag) || [])[1];
                        if (name && type) {
                            objects.push({
                                name,
                                type,
                                description: (descPattern.exec(tag) || [])[1] || '',
                                packageName: (pkgPattern.exec(tag) || [])[1] || query,
                                url: (uriPattern.exec(tag) || [])[1] || ''
                            });
                        }
                    }
                }
            }
            res.json({ success: true, data: objects });
        } catch (error) {
            return handleAdtError(res, error, 'search-package');
        }
    });

    app.post('/api/adt/transports', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, packageName } = req.body;
            if (!destinationName || !packageName) return res.status(400).json({ error: 'Missing destinationName or packageName' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    data: [
                        { number: `T4XK903271`, status: 'D', description: 'Mock Transport 1', owner: 'MOCKUSER' }
                    ]
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/transports] user=${logonName}, dest=${destinationName}, package=${packageName}`);

            // The ADT URI for packages is typically /sap/bc/adt/packages/<packageName>
            const packageUri = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
            const url = `${ADT_BASE}/repository/informationsystem/objectproperties/transports?uri=${encodeURIComponent(packageUri)}`;
            
            const connectionId = req.headers['x-adt-connection-id'];
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: { 'Accept': 'application/vnd.sap.adt.repository.trproperties.result.v1+xml' }
            }, cookies, connectionId);

            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const transports = [];
            
            // Example XML element:
            // <tpr:transport number="T4XK903271" description="IYH1HC packages" owner="IYH1HC" status="D" ... />
            const refPattern = /<(?:tpr:transport)[^>]*?>/gm;
            const numPattern = /number="([^"]+)"/;
            const statusPattern = /status="([^"]+)"/;
            const descPattern = /description="([^"]*)"/;
            const ownerPattern = /owner="([^"]*)"/;

            let match;
            while ((match = refPattern.exec(xml)) !== null) {
                const tag = match[0];
                const status = (statusPattern.exec(tag) || [])[1];
                if (status === 'D') {
                    transports.push({
                        number: (numPattern.exec(tag) || [])[1],
                        status,
                        description: (descPattern.exec(tag) || [])[1] || '',
                        owner: (ownerPattern.exec(tag) || [])[1] || ''
                    });
                }
            }
            res.json({ success: true, data: transports });
        } catch (error) {
            return handleAdtError(res, error, 'transports');
        }
    });

    app.post('/api/adt/create-object', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const {
                destinationName, objectType, name, packageName,
                description, responsible,
                parentPath,   // URL of the parent package (e.g. /sap/bc/adt/packages/zpk_iyh1hc)
                transport     // Transport request number (e.g. T4XK903271), auto-created if empty
            } = req.body;
            if (!destinationName || !objectType || !name || !packageName) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, objectType, name, packageName' });
            }

            // Normalize objectType: CLAS/OC -> CLAS, CLAS/OCX -> CLAS, PROG/I -> PROG, etc.
            const baseType = objectType.includes('/') ? objectType.split('/')[0] : objectType;

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    message: `[Mock] Object ${name} of type ${objectType} created in package ${packageName}`,
                    objectUrl: `${ADT_BASE}/oo/classes/${name.toLowerCase()}`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/create-object] user=${logonName}, dest=${destinationName}, type=${objectType}(base=${baseType}), name=${name}, parentPath=${parentPath}, transport=${transport}`);

            // Each object type has its own ADT URI path and XML schema
            const typeConfig = {
                'PROG': {
                    uri: 'programs/programs',
                    contentType: 'application/vnd.sap.adt.programs.programs.v2+xml',
                    typeId: 'PROG/P',
                    xml: (n, pkg, desc, resp, typeId) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<program:abapProgram xmlns:adtcore="http://www.sap.com/adt/core" xmlns:program="http://www.sap.com/adt/programs/programs"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:type="${typeId}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}"\n` +
                        `  program:programType="executableProgram">\n` +
                        `  <adtcore:packageRef adtcore:name="${pkg}"/>\n` +
                        `</program:abapProgram>`
                },
                'CLAS': {
                    uri: 'oo/classes',
                    contentType: 'application/vnd.sap.adt.oo.classes.v4+xml',
                    typeId: 'CLAS/OC',
                    xml: (n, pkg, desc, resp, typeId) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<class:abapClass xmlns:adtcore="http://www.sap.com/adt/core" xmlns:class="http://www.sap.com/adt/oo/classes"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:type="${typeId}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}" class:visibility="public">\n` +
                        `  <adtcore:packageRef adtcore:name="${pkg}"/>\n` +
                        `</class:abapClass>`
                },
                'INTF': {
                    uri: 'oo/interfaces',
                    contentType: 'application/vnd.sap.adt.oo.interface.v2+xml',
                    typeId: 'INTF/OI',
                    xml: (n, pkg, desc, resp, typeId) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<oo:interface xmlns:adtcore="http://www.sap.com/adt/core" xmlns:oo="http://www.sap.com/adt/oo"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:type="${typeId}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}">\n` +
                        `  <adtcore:packageRef adtcore:name="${pkg}"/>\n` +
                        `</oo:interface>`
                },
                'FUGR': {
                    uri: 'functions/groups',
                    contentType: 'application/vnd.sap.adt.functions.groups.v3+xml',
                    typeId: 'FUGR/F',
                    xml: (n, pkg, desc, resp, typeId) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<funcgrp:abapFunctionGroup xmlns:adtcore="http://www.sap.com/adt/core" xmlns:funcgrp="http://www.sap.com/adt/functions/groups"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:type="${typeId}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}">\n` +
                        `  <adtcore:packageRef adtcore:name="${pkg}"/>\n` +
                        `</funcgrp:abapFunctionGroup>`
                },
                'DEVC': {
                    uri: 'packages',
                    contentType: 'application/vnd.sap.adt.packages.v1+xml',
                    typeId: 'DEVC/K',
                    xml: (n, pkg, desc, resp, typeId) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<pak:package xmlns:adtcore="http://www.sap.com/adt/core" xmlns:pak="http://www.sap.com/adt/packages"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:type="${typeId}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}">\n` +
                        `  <adtcore:packageRef adtcore:name="${pkg}"/>\n` +
                        `</pak:package>`
                }
            };

            const cfg = typeConfig[baseType];
            if (!cfg) {
                return res.status(400).json({ error: `Unsupported object type: ${objectType} (base: ${baseType}). Supported: PROG, CLAS, INTF, FUGR, DEVC` });
            }

            const cleanName = name.toUpperCase();
            const cleanPkg = packageName.toUpperCase();
            const cleanDesc = (description || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
            const cleanResp = (responsible || logonName || 'DEVELOPER').toUpperCase();

            const xmlBody = cfg.xml(cleanName, cleanPkg, cleanDesc, cleanResp, cfg.typeId);
            console.log(`[adt/create-object] xmlBody: ${xmlBody}`);

            // Append transport number if provided
            const postUrl = transport
                ? `${ADT_BASE}/${cfg.uri}?corrNr=${encodeURIComponent(transport)}`
                : `${ADT_BASE}/${cfg.uri}`;
            console.log(`[adt/create-object] POST url: ${postUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            const csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: postUrl,
                headers: csrfHeaders(csrf, { 'Content-Type': cfg.contentType, 'Accept': '*/*' }),
                data: xmlBody
            }, cookies, connectionId);

            const objectUrl = response.headers['location'] || `${ADT_BASE}/${cfg.uri}/${cleanName.toLowerCase()}`;
            console.log(`[adt/create-object] created: ${objectUrl}`);
            res.json({ success: true, objectUrl, statusCode: response.status });
        } catch (error) {
            return handleAdtError(res, error, 'create-object');
        }
    });

    app.post('/api/adt/lock', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, objectUrl, accessMode = 'MODIFY' } = req.body;
            if (!destinationName || !objectUrl) return res.status(400).json({ error: 'Missing destinationName or objectUrl' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    lockHandle: `MOCK_LOCK_${Date.now()}`,
                    message: `[Mock] Object locked: ${objectUrl}`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/lock] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            const csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);
            console.log(`[adt/lock] csrf=${csrf.token?.substring(0, 10)}, sending lock to: ${objectUrl}?_action=LOCK&accessMode=${accessMode}`);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${objectUrl}?_action=LOCK&accessMode=${accessMode}`,
                headers: csrfHeaders(csrf, { 
                    'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
                    'X-sap-adt-session-type': 'stateful'
                })
            }, cookies, connectionId);

            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.log(`[adt/lock] response xml (first 300): ${xml.substring(0, 300)}`);

            // Parse lockHandle â€” ADT returns it inside <LOCK_HANDLE> or <adtlock:lockHandle>
            let lockHandle = '';
            const patterns = [
                /<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i,
                /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i,
                /<lockHandle[^>]*>([^<]+)<\/lockHandle>/i,
                /"LOCK_HANDLE":\s*"([^"]+)"/
            ];
            for (const p of patterns) {
                const m = p.exec(xml);
                if (m) { lockHandle = m[1].trim(); break; }
            }

            if (!lockHandle) {
                // If XML is small and has no tags, it might be the raw handle
                if (xml.length < 200 && !xml.includes('<')) {
                    lockHandle = xml.trim();
                } else {
                    console.warn('[adt/lock] Could not parse lockHandle from xml:', xml.substring(0, 200));
                }
            }

            // ── CRITICAL: extract session cookie from LOCK RESPONSE (not CSRF fetch) ──
            // The ADT lock is tied to the ABAP HTTP session that processed the lock request.
            // BTP Cloud Connector may create a new ABAP session when proxying the lock call,
            // so the response Set-Cookie is the actual session holding the lock.
            // If we pass the CSRF-fetch cookie to set-source, ABAP sees a different session
            // and rejects the lock handle with 423 "invalid lock handle".
            const lockRespSetCookie = response.headers['set-cookie'];
            let lockSessionCookie = '';
            if (Array.isArray(lockRespSetCookie)) {
                lockSessionCookie = lockRespSetCookie.map(c => c.split(';')[0]).join('; ');
            } else if (lockRespSetCookie) {
                lockSessionCookie = lockRespSetCookie.split(';')[0];
            }
            const sessionCookie = lockSessionCookie || csrf.cookie;
            console.log(`[adt/lock] lockHandle=${lockHandle}, lock_resp_cookie_len=${lockSessionCookie.length}, using_csrf_cookie=${!lockSessionCookie}`);
            res.json({ success: true, lockHandle, sessionCookie, csrfToken: csrf.token });
        } catch (error) {
            return handleAdtError(res, error, 'lock');
        }
    });

    app.post('/api/adt/set-source', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const {
                destinationName, objectUrl, sourceUrl, lockHandle,
                sessionCookie, lockCsrfToken, source,
                transport  // optional Transport request number
            } = req.body;
            if (!destinationName || !objectUrl || !lockHandle || source === undefined) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, objectUrl, lockHandle, source' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Source saved for ${objectUrl} (${source.length} chars)` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';

            // Use the sourceUrl if provided (from get-source step), otherwise resolve it
            let targetSourceUrl = sourceUrl;
            if (!targetSourceUrl) {
                // Re-fetch object structure to find source link
                try {
                    const structResp = await callAdt(destinationName, jwt, {
                        method: 'GET', url: objectUrl,
                        headers: { 'Accept': 'application/xml, application/*+xml' }
                    }, cookies);
                    const structXml = typeof structResp.data === 'string' ? structResp.data : JSON.stringify(structResp.data);
                    const m = /href="([^"]+)"[^>]*rel="[^"]*\/source[^"]*"/.exec(structXml)
                        || /rel="[^"]*\/source[^"]*"[^>]*href="([^"]+)"/.exec(structXml);
                    if (m) {
                        targetSourceUrl = m[1].startsWith('/') ? m[1] : '/' + m[1];
                    }
                } catch (_) { }
                if (!targetSourceUrl) targetSourceUrl = `${objectUrl}/source/main`;
            }

            console.log(`[adt/set-source] user=${logonName}, dest=${destinationName}, source_url=${targetSourceUrl}`);

            // Use the session cookie and CSRF token provided by the client (from the lock step)
            // This guarantees SAP sees the EXACT SAME session and token for this write operation.
            let csrf = { cookie: sessionCookie, token: lockCsrfToken };
            if (!csrf.token || !csrf.cookie) {
                // Fallback (might fail with 403 or 423 if lock requires same session)
                csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);
                if (sessionCookie) csrf.cookie = sessionCookie;
            }

            // Build PUT URL: lockHandle required, corrNr (transport) optional
            let putUrl = `${targetSourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`;
            if (transport) putUrl += `&corrNr=${encodeURIComponent(transport)}`;
            console.log(`[adt/set-source] PUT url: ${putUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            await callAdt(destinationName, jwt, {
                method: 'PUT',
                url: putUrl,
                headers: csrfHeaders(csrf, { 'Content-Type': 'text/plain; charset=utf-8', 'Accept': 'text/plain, */*' }),
                data: source
            }, cookies, connectionId);
            res.json({ success: true, message: 'Source saved successfully', sourceUrl: targetSourceUrl });
        } catch (error) {
            return handleAdtError(res, error, 'set-source');
        }
    });

    app.post('/api/adt/unlock', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, objectUrl, lockHandle, sessionCookie, lockCsrfToken } = req.body;
            if (!destinationName || !objectUrl || !lockHandle) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Unlocked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/unlock] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);
            console.log(`[adt/unlock] => REQ.BODY: sessionCookie=${!!sessionCookie}, lockCsrfToken=${!!lockCsrfToken}`);

            let csrf = { cookie: sessionCookie, token: lockCsrfToken };
            if (!csrf.token || !csrf.cookie) {
                csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);
                if (sessionCookie) csrf.cookie = sessionCookie;
            }

            const connectionId = req.headers['x-adt-connection-id'];
            await callAdt(destinationName, jwt, {
                method: 'POST', // trace shows POST for UNLOCK
                url: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: csrfHeaders(csrf, { 'X-sap-adt-session-type': 'stateful' })
            }, cookies, connectionId);
            res.json({ success: true, message: 'Object unlocked' });
        } catch (error) {
            return handleAdtError(res, error, 'unlock');
        }
    });

    app.post('/api/adt/activate', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, objects } = req.body;
            // objects: Array of { name, url, type, parentUri }
            // OR MCP_ABAP format: { 'adtcore:uri', 'adtcore:type', 'adtcore:name', 'adtcore:parentUri' }
            if (!destinationName || !objects || !objects.length) {
                return res.status(400).json({ error: 'Missing destinationName or objects array' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    message: `[Mock] Activated ${objects.length} object(s)`,
                    activated: objects.map(o => o.name || o['adtcore:name'])
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';

            // Normalize both input formats:
            //   Simple:   { name, url, type, parentUri }
            //   MCP_ABAP: { 'adtcore:uri', 'adtcore:type', 'adtcore:name', 'adtcore:parentUri' }
            const normalized = objects.map(o => ({
                name: (o.name || o['adtcore:name'] || '').toUpperCase(),
                uri: o.url || o['adtcore:uri'] || '',
                type: o.type || o['adtcore:type'] || '',
                parentUri: o.parentUri || o['adtcore:parentUri'] || ''
            }));

            console.log(`[adt/activate] user=${logonName}, dest=${destinationName}, objects=${normalized.map(o => o.name).join(',')}`);

            const csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);

            // Build objectReferences XML — include type and parentUri if present
            const objRefs = normalized.map(o => {
                let attrs = `adtcore:uri="${o.uri}" adtcore:name="${o.name}"`;
                if (o.type) attrs += ` adtcore:type="${o.type}"`;
                if (o.parentUri) attrs += ` adtcore:parentUri="${o.parentUri}"`;
                return `  <adtcore:objectReference ${attrs}/>`;
            }).join('\n');

            const xmlBody =
                '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n' +
                objRefs + '\n' +
                '</adtcore:objectReferences>';

            console.log(`[adt/activate] xml: ${xmlBody}`);

            const connectionId = req.headers['x-adt-connection-id'];
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${ADT_BASE}/activation/activate?method=activate&preauditRequested=false`,
                headers: csrfHeaders(csrf, {
                    'Content-Type': 'application/xml',
                    'Accept': 'application/xml, */*'
                }),
                data: xmlBody
            }, cookies, connectionId);

            const respXml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.log(`[adt/activate] status=${response.status}, response=${respXml.substring(0, 300)}`);

            const hasError = /<[^>]*type="E"[^>]*>/i.test(respXml) || /<error/i.test(respXml);
            res.json({
                success: !hasError,
                status: response.status,
                message: hasError ? 'Activation completed with errors' : 'Activated successfully',
                details: respXml.length < 2000 ? respXml : undefined
            });
        } catch (error) {
            return handleAdtError(res, error, 'activate');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════════
    // /api/adt/create-test-include — Create test include (CLAS/OCX) for an existing class
    // ADT: PUT /sap/bc/adt/oo/classes/<clas>/includes/testclasses?lockHandle=<h>
    // Must lock the class first → pass lockHandle from lock step
    // ═══════════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/create-test-include', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const {
                destinationName,
                clas,           // class name e.g. ZCL_MY_CLASS
                lockHandle,     // from lock step
                sessionCookie,  // from lock step
                lockCsrfToken,  // from lock step
                transport       // optional TR number
            } = req.body;
            if (!destinationName || !clas || !lockHandle) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, clas, lockHandle' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Test include created for ${clas}` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            const cleanClas = clas.toLowerCase();
            console.log(`[adt/create-test-include] user=${logonName}, dest=${destinationName}, clas=${cleanClas}, transport=${transport}`);

            let csrf = { cookie: sessionCookie, token: lockCsrfToken };
            if (!csrf.token || !csrf.cookie) {
                csrf = await fetchAdtCsrfToken(destinationName, jwt, cookies);
                if (sessionCookie) csrf.cookie = sessionCookie;
            }

            // Build URL: test class include endpoint with lockHandle
            let putUrl = `${ADT_BASE}/oo/classes/${cleanClas}/includes/testclasses?lockHandle=${encodeURIComponent(lockHandle)}`;
            if (transport) putUrl += `&corrNr=${encodeURIComponent(transport)}`;
            console.log(`[adt/create-test-include] PUT url: ${putUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            await callAdt(destinationName, jwt, {
                method: 'PUT',
                url: putUrl,
                headers: csrfHeaders(csrf, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Accept': '*/*'
                }),
                data: ''  // empty body creates the test include
            }, cookies, connectionId);
            res.json({ success: true, message: `Test include created for class ${clas.toUpperCase()}` });
        } catch (error) {
            return handleAdtError(res, error, 'create-test-include');
        }
    });

    app.post('/api/adt/get-source', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        try {
            const { destinationName, objectUrl } = req.body;
            if (!destinationName || !objectUrl) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    source: `*--------------------------------------------------------------*\n* Program: ${objectUrl.split('/').pop()}\n* Generated by MCP ADT Manager\n*--------------------------------------------------------------*\nREPORT z_example.\n\nSTART-OF-SELECTION.\n  WRITE: / 'Hello, World!'.`,
                    sourceUrl: `${objectUrl}/source/main`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';

            // Build the source URL: use /source/main directly
            // This works for all standard ABAP object types (PROG, CLAS, INTF, FUNC)
            // If objectUrl already contains /source/main, don't append again
            const sourceUrl = objectUrl.includes('/source/main')
                ? objectUrl
                : `${objectUrl}/source/main`;

            console.log(`[adt/get-source] user=${logonName}, dest=${destinationName}, url=${sourceUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: sourceUrl,
                headers: { 'Accept': 'text/plain, */*' }
            }, cookies, connectionId);
            res.json({ success: true, source: response.data, sourceUrl });
        } catch (error) {
            return handleAdtError(res, error, 'get-source');
        }
    });

    app.post('/api/adt/save-source', async (req, res) => {
        const cookies = requireAdtSession(req, res);
        if (!cookies) return;

        const { objectUrl, sourceUrl: reqSourceUrl, source, transport, destinationName } = req.body;
        if (!objectUrl) return res.status(400).json({ error: 'Missing objectUrl' });
        if (source === undefined || source === null) return res.status(400).json({ error: 'Missing source' });

        const dest = destinationName || 'T4X_011';
        const srcUrl = reqSourceUrl || `${objectUrl}/source/main`;

        if (process.env.NODE_ENV !== 'production') {
            return res.json({ success: true, message: `[Mock] Source saved for ${objectUrl}`, sourceUrl: srcUrl });
        }

        try {
            const jwt  = getUserJwt(req);
            const user = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/save-source] user=${user}, dest=${dest}, url=${objectUrl}`);

            const connectionId = req.headers['x-adt-connection-id'];
            const { adtSaveSource } = require('./adtSession');
            const result = await adtSaveSource({
                destName:   dest,
                userJwt:    jwt,
                objectUrl,
                sourceUrl:  srcUrl,
                source,
                transport,
                cookies,
                connectionId,
                log: (msg) => console.log(msg)
            });
            res.json({ success: true, message: 'Source saved and unlocked', sourceUrl: result.sourceUrl });
        } catch (error) {
            return handleAdtError(res, error, 'save-source');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════════════
    // AI endpoints — powered by company RAG AI (GPT/Gemini via DIA Brain)
    // Pattern: OAuth2 client_credentials token → DIA_HISTORY → DIA_CHAT_RAG
    // ══════════════════════════════════════════════════════════════════════════════════
    const { agenticChat, createHistory } = require('./ai-service');

    // POST /api/ai/history — Create a new chat history session
    app.post('/api/ai/history', async (req, res) => {
        try {
            const { agenticChat: _, createHistory: ch, getTokenCached } = require('./ai-service');
            const token = await getTokenCached();
            const historyId = await createHistory(token);
            res.json({ success: true, historyId });
        } catch (err) {
            console.error('[ai/history] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/ai/chat — Run agentic AI chat with ADT tool execution
    app.post('/api/ai/chat', async (req, res) => {
        const { message, historyId, destinationName } = req.body;
        if (!message) return res.status(400).json({ error: 'Missing message' });

        const dest = destinationName || 'T4X_011';

        try {
            const jwt = getUserJwt(req);
            const cookies = req.headers['x-adt-session-cookies'];
            const connectionId = req.headers['x-adt-connection-id'];

            /**
             * Tool executor — maps tool_call names to existing ADT endpoints.
             * The AI calls these tools by name; the server executes them
             * using the same helpers (callAdt, csrf, etc.) already in server.js.
             */
            const toolExecutor = async (toolName, params, connectionId = null) => {
                console.log(`[ai/tool] executing tool=${toolName}, connectionId=${connectionId}`);

                if (!cookies || cookies === 'null') {
                    throw new Error('Not connected to SAP system. Please click the "Connect" button in the header before using the AI Assistant.');
                }

                switch (toolName) {

                    case 'search_object': {
                        const response = await callAdt(dest, jwt, {
                            method: 'GET',
                            url: `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(params.query)}${params.objectType ? `&objectType=${params.objectType}` : ''}&maxResults=${params.maxResults || 50}`,
                            headers: { 'Accept': 'application/xml, application/vnd.sap.adt.repository.informationsystem.lists.v1+xml' }
                        }, cookies);
                        const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                        // Parse objects from ADT search XML
                        const items = [];
                        const re = /adtcore:uri="([^"]*)"[^>]*adtcore:type="([^"]*)"[^>]*adtcore:name="([^"]*)"(?:[^>]*adtcore:packageName="([^"]*)")?(?:[^>]*adtcore:description="([^"]*)")?/g;
                        let m;
                        while ((m = re.exec(xml)) !== null) {
                            items.push({ url: m[1], type: m[2], name: m[3], packageName: m[4] || '', description: m[5] || '' });
                        }
                        return { success: true, count: items.length, data: items };
                    }

                    case 'search_package': {
                        const response = await callAdt(dest, jwt, {
                            method: 'GET',
                            url: `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(params.query)}&objectType=DEVC&maxResults=${params.maxResults || 20}`,
                            headers: { 'Accept': 'application/xml, application/vnd.sap.adt.repository.informationsystem.lists.v1+xml' }
                        }, cookies);
                        const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                        const items = [];
                        const re = /adtcore:uri="([^"]*)"[^>]*adtcore:type="([^"]*)"[^>]*adtcore:name="([^"]*)"(?:[^>]*adtcore:description="([^"]*)")?/g;
                        let m;
                        while ((m = re.exec(xml)) !== null) {
                            if (m[2] === 'DEVC/K') {
                                items.push({ url: m[1], name: m[3], description: m[4] || '' });
                            }
                        }
                        return { success: true, count: items.length, data: items };
                    }

                    case 'get_source': {
                        const srcUrl = params.objectUrl.includes('/source/main')
                            ? params.objectUrl
                            : `${params.objectUrl}/source/main`;
                        const response = await callAdt(dest, jwt, {
                            method: 'GET', url: srcUrl,
                            headers: { 'Accept': 'text/plain, */*' }
                        }, cookies, connectionId);
                        return { success: true, source: response.data, sourceUrl: srcUrl };
                    }

                    case 'create_object': {
                        // Normalize type
                        const rawType = params.objectType || 'CLAS/OC';
                        const baseType = rawType.includes('/') ? rawType.split('/')[0] : rawType;
                        const typeMap = {
                            CLAS: { uri: 'oo/classes', ct: 'application/vnd.sap.adt.oo.classes.v4+xml',
                                xml: (n, pkg, d, pkgPath) =>
                                    `<?xml version="1.0" encoding="utf-8"?>\n<class:abapClass xmlns:adtcore="http://www.sap.com/adt/core" xmlns:class="http://www.sap.com/adt/oo/classes"\n  adtcore:description="${d}" adtcore:name="${n}" adtcore:packageName="${pkg}" class:visibility="public">\n${pkgPath ? `  <adtcore:packageRef adtcore:uri="${pkgPath}"/>\n` : ''}</class:abapClass>`
                            },
                            PROG: { uri: 'programs/programs', ct: 'application/vnd.sap.adt.programs.programs.v2+xml',
                                xml: (n, pkg, d, pkgPath) =>
                                    `<?xml version="1.0" encoding="utf-8"?>\n<program:abapProgram xmlns:adtcore="http://www.sap.com/adt/core" xmlns:program="http://www.sap.com/adt/programs/programs"\n  adtcore:description="${d}" adtcore:name="${n}" adtcore:packageName="${pkg}" program:programType="executableProgram">\n${pkgPath ? `  <adtcore:packageRef adtcore:uri="${pkgPath}"/>\n` : ''}</program:abapProgram>`
                            },
                            INTF: { uri: 'oo/interfaces', ct: 'application/vnd.sap.adt.oo.interface.v2+xml',
                                xml: (n, pkg, d, pkgPath) =>
                                    `<?xml version="1.0" encoding="utf-8"?>\n<oo:interface xmlns:adtcore="http://www.sap.com/adt/core" xmlns:oo="http://www.sap.com/adt/oo"\n  adtcore:description="${d}" adtcore:name="${n}" adtcore:packageName="${pkg}">\n${pkgPath ? `  <adtcore:packageRef adtcore:uri="${pkgPath}"/>\n` : ''}</oo:interface>`
                            }
                        };
                        const cfg = typeMap[baseType];
                        if (!cfg) throw new Error(`Unsupported objectType: ${rawType}`);
                        const cleanName = (params.name || '').toUpperCase();
                        const cleanPkg  = (params.packageName || '').toUpperCase();
                        const cleanDesc = (params.description || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
                        const xmlBody = cfg.xml(cleanName, cleanPkg, cleanDesc, params.parentPath || '');
                        const postUrl = params.transport ? `${ADT_BASE}/${cfg.uri}?corrNr=${encodeURIComponent(params.transport)}` : `${ADT_BASE}/${cfg.uri}`;
                        const csrf = await fetchAdtCsrfToken(dest, jwt, cookies);
                        const response = await callAdt(dest, jwt, {
                            method: 'POST', url: postUrl,
                            headers: csrfHeaders(csrf, { 'Content-Type': cfg.ct, 'Accept': '*/*' }),
                            data: xmlBody
                        }, cookies, connectionId);
                        const objectUrl = response.headers['location'] || `${ADT_BASE}/${cfg.uri}/${cleanName.toLowerCase()}`;
                        return { success: true, objectUrl };
                    }

                    case 'lock': {
                        const csrf = await fetchAdtCsrfToken(dest, jwt, cookies);
                        const response = await callAdt(dest, jwt, {
                            method: 'POST',
                            url: `${params.objectUrl}?_action=LOCK&accessMode=MODIFY`,
                            headers: csrfHeaders(csrf, { 
                                'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9',
                                'X-sap-adt-session-type': 'stateful'
                            })
                        }, cookies, connectionId);
                        const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                        let lockHandle = '';
                        for (const p of [/<LOCK_HANDLE[^>]*>([^<]+)<\/LOCK_HANDLE>/i, /<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>/i]) {
                            const m = p.exec(xml);
                            if (m) { lockHandle = m[1].trim(); break; }
                        }
                        // Extract session cookie from lock RESPONSE (not CSRF fetch)
                        const lockRespSetCookie = response.headers['set-cookie'];
                        let lockSessionCookie = '';
                        if (Array.isArray(lockRespSetCookie)) lockSessionCookie = lockRespSetCookie.map(c => c.split(';')[0]).join('; ');
                        else if (lockRespSetCookie) lockSessionCookie = lockRespSetCookie.split(';')[0];
                        const sessionCookie = lockSessionCookie || csrf.cookie;
                        return { success: true, lockHandle, sessionCookie, csrfToken: csrf.token };
                    }

                    case 'set_source': {
                        const srcUrl = params.sourceUrl || `${params.objectUrl}/source/main`;
                        let csrf = { cookie: params.sessionCookie, token: params.lockCsrfToken };
                        if (!csrf.token || !csrf.cookie) csrf = await fetchAdtCsrfToken(dest, jwt, cookies);
                        let putUrl = `${srcUrl}?lockHandle=${encodeURIComponent(params.lockHandle)}`;
                        if (params.transport) putUrl += `&corrNr=${encodeURIComponent(params.transport)}`;
                        await callAdt(dest, jwt, {
                            method: 'PUT', url: putUrl,
                            headers: csrfHeaders(csrf, { 'Content-Type': 'text/plain; charset=utf-8', 'X-sap-adt-session-type': 'stateful' }),
                            data: params.source || ''
                        }, cookies, connectionId);
                        return { success: true, message: 'Source saved', sourceUrl: srcUrl };
                    }

                    case 'unlock': {
                        let csrf = { cookie: params.sessionCookie, token: params.lockCsrfToken };
                        if (!csrf.token || !csrf.cookie) csrf = await fetchAdtCsrfToken(dest, jwt);
                        await callAdt(dest, jwt, {
                            method: 'POST',
                            url: `${params.objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(params.lockHandle)}`,
                            headers: csrfHeaders(csrf, { 'X-sap-adt-session-type': 'stateful' })
                        }, cookies, connectionId);
                        return { success: true, message: 'Object unlocked' };
                    }

                    case 'activate': {
                        const csrf = await fetchAdtCsrfToken(dest, jwt);
                        const normalized = (params.objects || []).map(o => ({
                            uri:       o.url || o['adtcore:uri'] || '',
                            name:      (o.name || o['adtcore:name'] || '').toUpperCase(),
                            type:      o.type || o['adtcore:type'] || '',
                            parentUri: o.parentUri || o['adtcore:parentUri'] || ''
                        }));
                        const objRefs = normalized.map(o => {
                            let attrs = `adtcore:uri="${o.uri}" adtcore:name="${o.name}"`;
                            if (o.type)      attrs += ` adtcore:type="${o.type}"`;
                            if (o.parentUri) attrs += ` adtcore:parentUri="${o.parentUri}"`;
                            return `  <adtcore:objectReference ${attrs}/>`;
                        }).join('\n');
                        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n${objRefs}\n</adtcore:objectReferences>`;
                        const response = await callAdt(dest, jwt, {
                            method: 'POST',
                            url: `${ADT_BASE}/activation/activate?method=activate&preauditRequested=false`,
                            headers: csrfHeaders(csrf, { 'Content-Type': 'application/xml', 'Accept': 'application/xml, */*', 'X-sap-adt-session-type': 'stateful' }),
                            data: xmlBody
                        }, cookies, connectionId);
                        const respXml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                        const hasError = /<[^>]*type="E"[^>]*>/i.test(respXml) || /<error/i.test(respXml);
                        return { success: !hasError, message: hasError ? 'Activation completed with errors' : 'Activated successfully' };
                    }

                    case 'create_test_include': {
                        const cleanClas = (params.clas || '').toLowerCase();
                        let csrf = { cookie: params.sessionCookie, token: params.lockCsrfToken };
                        if (!csrf.token || !csrf.cookie) csrf = await fetchAdtCsrfToken(dest, jwt);
                        let putUrl = `${ADT_BASE}/oo/classes/${cleanClas}/includes/testclasses?lockHandle=${encodeURIComponent(params.lockHandle)}`;
                        if (params.transport) putUrl += `&corrNr=${encodeURIComponent(params.transport)}`;
                        await callAdt(dest, jwt, { 
                            method: 'PUT', url: putUrl, 
                            headers: csrfHeaders(csrf, { 'Content-Type': 'text/plain; charset=utf-8', 'X-sap-adt-session-type': 'stateful' }), 
                            data: '' 
                        }, cookies, connectionId);
                        return { success: true, message: `Test include created for ${(params.clas || '').toUpperCase()}` };
                    }

                    default:
                        throw new Error(`Unknown tool: ${toolName}`);
                }
            };

            const result = await agenticChat(message, historyId || null, dest, (name, params) => toolExecutor(name, params, connectionId));
            res.json({ success: true, ...result });

        } catch (err) {
            console.error('[ai/chat] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

module.exports = cds.server;
