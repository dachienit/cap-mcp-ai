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

    // â”€â”€â”€ Helper: get user JWT for Principal Propagation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // SAME pattern as /api/fetch-bom which works correctly on BTP:
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

    // â”€â”€â”€ Helper: call on-prem via SAP Cloud SDK (same as fetch-bom) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function callAdt(destinationName, jwt, options) {
        const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
        try {
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

    // â”€â”€â”€ Helper: standardized error response with downstream status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€â”€ Helper: fetch ADT CSRF token from on-prem â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // SAP validates CSRF token against the HTTP session (cookie).
    // We must return both the token AND the session cookie so subsequent
    // write requests can send the same cookie, letting SAP match the session.
    async function fetchAdtCsrfToken(destinationName, jwt) {
        const resp = await callAdt(destinationName, jwt, {
            method: 'GET',
            url: `${ADT_BASE}/core/discovery`,
            headers: { 'X-CSRF-Token': 'Fetch', 'Accept': 'application/atomsvc+xml, application/xml, */*' }
        });
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
        return { token, cookie };
    }

    // Helper: build headers with CSRF token + session cookie
    function csrfHeaders(csrfResult, extra = {}) {
        const h = { 'X-CSRF-Token': csrfResult.token, ...extra };
        if (csrfResult.cookie) h['Cookie'] = csrfResult.cookie;
        return h;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/me
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/fetch-bom  (legacy)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/search  â€” Search ABAP repository objects
    // ADT API: GET /sap/adt/repository/informationsystem/search
    //   ?operation=quickSearch&query=<term>&maxResults=50&objectType=<type>
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/search', async (req, res) => {
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

            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: {
                    // ADT search result format
                    'Accept': 'application/vnd.sap.adt.repository.informationsystem.search.result.v1+xml, application/xml',
                    'sap-client': process.env.SAP_CLIENT || ''
                }
            });

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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/search-package  â€” Search ABAP packages (DEVC)
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/search-package', async (req, res) => {
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

            const url = `${ADT_BASE}/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query + '*')}&maxResults=${maxResults}&objectType=DEVC%2FK`;
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: { 'Accept': 'application/xml' }
            });

            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const objects = [];
            const refPattern = /<(?:adtcore:objectReference)[^>]*?>/gm;
            const namePattern = /adtcore:name="([^"]+)"/;
            const descPattern = /adtcore:description="([^"]*)"/;
            let match;
            while ((match = refPattern.exec(xml)) !== null) {
                const tag = match[0];
                const name = (namePattern.exec(tag) || [])[1];
                if (name) objects.push({ name, type: 'DEVC', description: (descPattern.exec(tag) || [])[1] || '' });
            }
            res.json({ success: true, data: objects });
        } catch (error) {
            return handleAdtError(res, error, 'search-package');
        }
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/create-object  â€” Create a new ABAP object
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/create-object', async (req, res) => {
        try {
            const { destinationName, objectType, name, packageName, description, responsible } = req.body;
            if (!destinationName || !objectType || !name || !packageName) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, objectType, name, packageName' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    message: `[Mock] Object ${name} of type ${objectType} created in package ${packageName}`,
                    objectUrl: `${ADT_BASE}/programs/programs/${name.toLowerCase()}`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/create-object] user=${logonName}, dest=${destinationName}, type=${objectType}, name=${name}`);


            // Each object type has its own ADT URI path and XML schema
            const typeConfig = {
                'PROG': {
                    uri: 'programs/programs',
                    contentType: 'application/vnd.sap.adt.programs.programs.v2+xml',
                    xml: (n, pkg, desc, resp) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<program:abapProgram xmlns:adtcore="http://www.sap.com/adt/core" xmlns:program="http://www.sap.com/adt/programs/programs"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}"\n` +
                        `  program:programType="executableProgram"/>`
                },
                'CLAS': {
                    uri: 'oo/classes',
                    contentType: 'application/vnd.sap.adt.oo.classes.v4+xml',
                    xml: (n, pkg, desc, resp) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<class:abapClass xmlns:adtcore="http://www.sap.com/adt/core" xmlns:class="http://www.sap.com/adt/oo/classes"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}" />`
                },
                'INTF': {
                    uri: 'oo/interfaces',
                    contentType: 'application/vnd.sap.adt.oo.interface.v2+xml',
                    xml: (n, pkg, desc, resp) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<oo:interface xmlns:adtcore="http://www.sap.com/adt/core" xmlns:oo="http://www.sap.com/adt/oo"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}"/>`
                },
                'FUGR': {
                    uri: 'functions/groups',
                    contentType: 'application/vnd.sap.adt.functions.groups.v3+xml',
                    xml: (n, pkg, desc, resp) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<funcgrp:abapFunctionGroup xmlns:adtcore="http://www.sap.com/adt/core" xmlns:funcgrp="http://www.sap.com/adt/functions/groups"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}"/>`
                },
                'DEVC': {
                    uri: 'packages',
                    contentType: 'application/vnd.sap.adt.packages.v1+xml',
                    xml: (n, pkg, desc, resp) =>
                        `<?xml version="1.0" encoding="utf-8"?>\n` +
                        `<pak:package xmlns:adtcore="http://www.sap.com/adt/core" xmlns:pak="http://www.sap.com/adt/packages"\n` +
                        `  adtcore:description="${desc}" adtcore:name="${n}" adtcore:packageName="${pkg}" adtcore:responsible="${resp}"/>`
                }
            };

            const cfg = typeConfig[objectType];
            if (!cfg) {
                return res.status(400).json({ error: `Unsupported object type: ${objectType}. Supported: PROG, CLAS, INTF, FUGR, DEVC` });
            }

            const cleanName = name.toUpperCase();
            const cleanPkg = packageName.toUpperCase();
            const cleanDesc = (description || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
            const cleanResp = (responsible || logonName || 'DEVELOPER').toUpperCase();

            const xmlBody = cfg.xml(cleanName, cleanPkg, cleanDesc, cleanResp);
            console.log(`[adt/create-object] xmlBody: ${xmlBody}`);
            console.log(`[adt/create-object] contentType: ${cfg.contentType}, url: ${ADT_BASE}/${cfg.uri}`);

            const csrf = await fetchAdtCsrfToken(destinationName, jwt);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${ADT_BASE}/${cfg.uri}`,
                headers: csrfHeaders(csrf, { 'Content-Type': cfg.contentType, 'Accept': '*/*' }),
                data: xmlBody
            });

            const objectUrl = response.headers['location'] || `${ADT_BASE}/${cfg.uri}/${cleanName.toLowerCase()}`;
            console.log(`[adt/create-object] created: ${objectUrl}`);
            res.json({ success: true, objectUrl, statusCode: response.status });
        } catch (error) {
            return handleAdtError(res, error, 'create-object');
        }
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/lock  â€” Lock an ABAP object for editing
    // ADT: POST objectUrl?_action=LOCK&accessMode=MODIFY
    // Returns: XML with LOCK_HANDLE
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/lock', async (req, res) => {
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

            const csrf = await fetchAdtCsrfToken(destinationName, jwt);
            console.log(`[adt/lock] csrf=${csrf.token?.substring(0, 10)}, sending lock to: ${objectUrl}?_action=LOCK&accessMode=${accessMode}`);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${objectUrl}?_action=LOCK&accessMode=${accessMode}`,
                headers: csrfHeaders(csrf, { 'Accept': '*/*' })
            });

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
            res.json({ success: true, lockHandle, sessionCookie: csrf.cookie, csrfToken: csrf.token });
        } catch (error) {
            return handleAdtError(res, error, 'lock');
        }
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/set-source  â€” Upload source code to a locked object
    // ADT: PUT sourceUrl?lockHandle=<handle>
    // NOTE: sourceUrl must be the actual source URL (from get-source response),
    //       not just objectUrl/source/main â€” classes have different include URLs
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/set-source', async (req, res) => {
        try {
            const { destinationName, objectUrl, sourceUrl, lockHandle, sessionCookie, lockCsrfToken, source } = req.body;
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
                    });
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
                csrf = await fetchAdtCsrfToken(destinationName, jwt);
                if (sessionCookie) csrf.cookie = sessionCookie;
            }

            await callAdt(destinationName, jwt, {
                method: 'PUT',
                url: `${targetSourceUrl}?lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: csrfHeaders(csrf, { 'Content-Type': 'text/plain; charset=utf-8', 'Accept': 'text/plain, */*' }),
                data: source
            });
            res.json({ success: true, message: 'Source saved successfully', sourceUrl: targetSourceUrl });
        } catch (error) {
            return handleAdtError(res, error, 'set-source');
        }
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/unlock  â€” Unlock an ABAP object after editing
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/unlock', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle, sessionCookie, lockCsrfToken } = req.body;
            if (!destinationName || !objectUrl || !lockHandle) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Unlocked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/unlock] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);

            let csrf = { cookie: sessionCookie, token: lockCsrfToken };
            if (!csrf.token || !csrf.cookie) {
                csrf = await fetchAdtCsrfToken(destinationName, jwt);
                if (sessionCookie) csrf.cookie = sessionCookie;
            }

            await callAdt(destinationName, jwt, {
                method: 'DELETE',
                url: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: csrfHeaders(csrf)
            });
            res.json({ success: true, message: 'Object unlocked' });
        } catch (error) {
            return handleAdtError(res, error, 'unlock');
        }
    });

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/activate  â€” Activate ABAP objects
    // ADT: POST /sap/bc/adt/activation/activate_multiple  (multiple objects)
    //      POST /sap/bc/adt/activation/activate?method=activate&preauditRequested=false
    //           with XML body containing object references
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/activate', async (req, res) => {
        try {
            const { destinationName, objects } = req.body;
            // objects: Array of { name, url, type }
            if (!destinationName || !objects || !objects.length) {
                return res.status(400).json({ error: 'Missing destinationName or objects array' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    message: `[Mock] Activated ${objects.length} object(s)`,
                    activated: objects.map(o => o.name)
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/activate] user=${logonName}, dest=${destinationName}, objects=${objects.map(o => o.name).join(',')}`);

            const csrf = await fetchAdtCsrfToken(destinationName, jwt);

            // Build objectReferences XML
            const objRefs = objects.map(o =>
                `  <adtcore:objectReference adtcore:uri="${o.url}" adtcore:name="${o.name.toUpperCase()}"${o.type ? ` adtcore:type="${o.type}"` : ''}/>`
            ).join('\n');

            const xmlBody =
                '<?xml version="1.0" encoding="utf-8"?>\n' +
                '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n' +
                objRefs + '\n' +
                '</adtcore:objectReferences>';

            console.log(`[adt/activate] xml: ${xmlBody}`);

            // Use activate endpoint (works for single and multiple)
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${ADT_BASE}/activation/activate?method=activate&preauditRequested=false`,
                headers: csrfHeaders(csrf, {
                    'Content-Type': 'application/xml',
                    'Accept': 'application/xml, */*'
                }),
                data: xmlBody
            });

            const respXml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.log(`[adt/activate] status=${response.status}, response=${respXml.substring(0, 300)}`);

            // Check for activation errors in response (ADT may return 200 with error messages)
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

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // /api/adt/get-source  â€” Get source code of an existing object
    // ADT: GET objectUrl/source/main  (text/plain ABAP source)
    // NOTE: The objectStructure approach (finding source link from XML) was removed
    //       because it was picking up wrong links (textelements) for ABAP classes.
    //       Direct /source/main works for: PROG, CLAS main, INTF, FUNC
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    app.post('/api/adt/get-source', async (req, res) => {
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

            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: sourceUrl,
                headers: { 'Accept': 'text/plain, */*' }
            });
            res.json({ success: true, source: response.data, sourceUrl });
        } catch (error) {
            return handleAdtError(res, error, 'get-source');
        }
    });
});

module.exports = cds.server;
