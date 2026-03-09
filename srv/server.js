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

    // ADT base path — SAP ICF node for ABAP Development Tools
    // Cloud Connector must expose this path: /sap/bc/adt
    const ADT_BASE = '/sap/bc/adt';

    // ─── Helper: get user JWT for Principal Propagation ─────────────────────────
    // SAME pattern as /api/fetch-bom which works correctly on BTP:
    //   Authorization header = XSUAA JWT forwarded by approuter → use this FIRST for PP
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

    // ─── Helper: call on-prem via SAP Cloud SDK (same as fetch-bom) ──────────────
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

    // ─── Helper: standardized error response with downstream status ───────────────
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

    // ─── Helper: fetch ADT CSRF token from on-prem ───────────────────────────────
    async function fetchAdtCsrfToken(destinationName, jwt) {
        const resp = await callAdt(destinationName, jwt, {
            method: 'GET',
            url: `${ADT_BASE}/core/discovery`,
            headers: { 'X-CSRF-Token': 'Fetch', 'Accept': 'application/xml' }
        });
        return resp.headers['x-csrf-token'] || resp.headers['X-CSRF-Token'] || '';
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/me
    // ═══════════════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/fetch-bom  (legacy)
    // ═══════════════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/search  — Search ABAP repository objects
    // ADT API: GET /sap/adt/repository/informationsystem/search
    //   ?operation=quickSearch&query=<term>&maxResults=50&objectType=<type>
    // ═══════════════════════════════════════════════════════════════════════════════
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

            // Parse ADT XML search results — extract object name, type, description, package
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/search-package  — Search ABAP packages (DEVC)
    // ═══════════════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/create-object  — Create a new ABAP object
    // ═══════════════════════════════════════════════════════════════════════════════
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
                    objectUrl: `/sap/adt/programs/programs/${name}`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/create-object] user=${logonName}, dest=${destinationName}, type=${objectType}, name=${name}`);

            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);

            const typeUriMap = {
                'PROG': 'programs/programs',
                'FUGR': 'functions/groups',
                'CLAS': 'oo/classes',
                'INTF': 'oo/interfaces',
                'DEVC': 'packages'
            };
            const typeUri = typeUriMap[objectType] || `repository/objects/${objectType}`;

            const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<${objectType === 'CLAS' ? 'oo:class' : 'program:abapProgram'} xmlns:adtcore="http://www.sap.com/adt/core"
  xmlns:program="http://www.sap.com/adt/programs/programs"
  adtcore:description="${description || ''}"
  adtcore:name="${name.toUpperCase()}"
  adtcore:packageName="${packageName.toUpperCase()}"
  adtcore:responsible="${(responsible || logonName || 'DEVELOPER').toUpperCase()}"/>`;

            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${ADT_BASE}/${typeUri}`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Content-Type': 'application/vnd.sap.adt.programs.programs.v2+xml'
                },
                data: xmlBody
            });

            const objectUrl = response.headers['location'] || `${ADT_BASE}/${typeUri}/${name}`;
            res.json({ success: true, objectUrl, statusCode: response.status });
        } catch (error) {
            return handleAdtError(res, error, 'create-object');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/lock  — Lock an ABAP object for editing
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/lock', async (req, res) => {
        try {
            const { destinationName, objectUrl } = req.body;
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

            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result'
                }
            });

            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const match = xml.match(/<adtlock:lockHandle[^>]*>([^<]+)<\/adtlock:lockHandle>|<lockHandle[^>]*>([^<]+)<\/lockHandle>/);
            const lockHandle = match ? (match[1] || match[2] || '').trim() : xml.trim();
            res.json({ success: true, lockHandle });
        } catch (error) {
            return handleAdtError(res, error, 'lock');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/set-source  — Upload source code to a locked object
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/set-source', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle, source } = req.body;
            if (!destinationName || !objectUrl || !lockHandle || source === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Source saved for ${objectUrl} (${source.length} chars)` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/set-source] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);

            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);
            await callAdt(destinationName, jwt, {
                method: 'PUT',
                url: `${objectUrl}/source/main?lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Accept': 'text/plain'
                },
                data: source
            });
            res.json({ success: true, message: 'Source saved successfully' });
        } catch (error) {
            return handleAdtError(res, error, 'set-source');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/unlock  — Unlock an ABAP object after editing
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/unlock', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle } = req.body;
            if (!destinationName || !objectUrl || !lockHandle) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Unlocked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/unlock] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);

            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);
            await callAdt(destinationName, jwt, {
                method: 'DELETE',
                url: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: { 'X-CSRF-Token': csrfToken }
            });
            res.json({ success: true, message: 'Object unlocked' });
        } catch (error) {
            return handleAdtError(res, error, 'unlock');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/activate  — Activate ABAP objects
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/activate', async (req, res) => {
        try {
            const { destinationName, objects } = req.body;
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

            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);

            const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${objects.map(o => `  <adtcore:objectReference adtcore:uri="${o.url}" adtcore:name="${o.name}" adtcore:type="${o.type}"/>`).join('\n')}
</adtcore:objectReferences>`;

            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${ADT_BASE}/activation/activate_multiple`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Content-Type': 'application/xml',
                    'Accept': 'application/xml'
                },
                data: xmlBody
            });

            res.json({ success: true, status: response.status });
        } catch (error) {
            return handleAdtError(res, error, 'activate');
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/get-source  — Get source code of an existing object
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/get-source', async (req, res) => {
        try {
            const { destinationName, objectUrl } = req.body;
            if (!destinationName || !objectUrl) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    source: `*--------------------------------------------------------------*\n* Program: ${objectUrl.split('/').pop()}\n* Generated by MCP ADT Manager\n*--------------------------------------------------------------*\nREPORT z_example.\n\nSTART-OF-SELECTION.\n  WRITE: / 'Hello, World!'.`
                });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/get-source] user=${logonName}, dest=${destinationName}, url=${objectUrl}`);

            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: `${objectUrl}/source/main`,
                headers: { 'Accept': 'text/plain; charset=utf-8' }
            });
            res.json({ success: true, source: response.data });
        } catch (error) {
            return handleAdtError(res, error, 'get-source');
        }
    });
});

module.exports = cds.server;
