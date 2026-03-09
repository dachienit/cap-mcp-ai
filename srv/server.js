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

    // ─── Helper: get user JWT from request ───────────────────────────────────────
    function getUserJwt(req) {
        const authHeader = req.headers.authorization;
        return authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.substring(7)
            : (req.authInfo && req.authInfo.getToken ? req.authInfo.getToken() : null);
    }

    // ─── Helper: call ADT API via SAP Cloud SDK (production) ─────────────────────
    async function callAdt(destinationName, jwt, options) {
        const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
        return executeHttpRequest(
            { destinationName, jwt },
            options
        );
    }

    // ─── Helper: fetch ADT CSRF token from on-prem ───────────────────────────────
    async function fetchAdtCsrfToken(destinationName, jwt) {
        const resp = await callAdt(destinationName, jwt, {
            method: 'GET',
            url: '/sap/adt/core/discovery',
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
            let url = `/sap/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}*&maxResults=${maxResults}`;
            if (objectType) url += `&objectType=${encodeURIComponent(objectType)}`;

            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: { Accept: 'application/xml' }
            });

            // ADT returns XML — parse relevant fields
            const xml = response.data;
            // Simple regex extraction for demo; production should use xml2js
            const objects = [];
            const matches = xml.matchAll(/<adtcore:object[^>]+name="([^"]+)"[^>]+type="([^"]+)"[^>]*>([\s\S]*?)<\/adtcore:object>/gm);
            for (const m of matches) {
                objects.push({ name: m[1], type: m[2], raw: m[0] });
            }
            res.json({ success: true, data: objects, raw: xml });
        } catch (error) {
            console.error('[adt/search] Error:', error.message);
            res.status(500).json({ error: error.message });
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
            const url = `/sap/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}*&maxResults=${maxResults}&objectType=DEVC%2FK`;
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url,
                headers: { Accept: 'application/xml' }
            });
            res.json({ success: true, raw: response.data });
        } catch (error) {
            console.error('[adt/search-package] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/create-object  — Create a new ABAP object
    // ADT API: PUT /sap/adt/<objectTypeUri>/<objectName>
    //   Body: XML descriptor
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
            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);

            // Build object URI path based on type
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
  adtcore:responsible="${(responsible || 'DEVELOPER').toUpperCase()}"/>`;

            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `/sap/adt/${typeUri}`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Content-Type': 'application/vnd.sap.adt.programs.programs.v2+xml'
                },
                data: xmlBody
            });

            const objectUrl = response.headers['location'] || `/sap/adt/${typeUri}/${name}`;
            res.json({ success: true, objectUrl, statusCode: response.status });
        } catch (error) {
            console.error('[adt/create-object] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/lock  — Lock an ABAP object for editing
    // ADT API: POST /sap/adt/<objectUrl>?_action=LOCK&accessMode=MODIFY
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
            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);
            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: `${objectUrl}?_action=LOCK&accessMode=MODIFY`,
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Accept': 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result'
                }
            });

            // Lock handle is in the response XML
            const xml = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const match = xml.match(/lockHandle[^>]*>([^<]+)<\/lockHandle>|"lockHandle"\s*:\s*"([^"]+)"/);
            const lockHandle = match ? (match[1] || match[2]) : 'UNKNOWN';
            res.json({ success: true, lockHandle });
        } catch (error) {
            console.error('[adt/lock] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/set-source  — Upload source code to a locked object
    // ADT API: PUT /sap/adt/<objectUrl>/source/main?lockHandle=<handle>
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/set-source', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle, source } = req.body;
            if (!destinationName || !objectUrl || !lockHandle || source === undefined) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    message: `[Mock] Source saved for ${objectUrl} (${source.length} chars)`
                });
            }

            const jwt = getUserJwt(req);
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
            console.error('[adt/set-source] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/unlock  — Unlock an ABAP object after editing
    // ADT API: DELETE /sap/adt/<objectUrl>?_action=UNLOCK&lockHandle=<handle>
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/unlock', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle } = req.body;
            if (!destinationName || !objectUrl || !lockHandle) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Unlocked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);
            await callAdt(destinationName, jwt, {
                method: 'DELETE',
                url: `${objectUrl}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
                headers: { 'X-CSRF-Token': csrfToken }
            });
            res.json({ success: true, message: 'Object unlocked' });
        } catch (error) {
            console.error('[adt/unlock] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/activate  — Activate ABAP objects
    // ADT API: POST /sap/adt/activation/activate_multiple
    //   Body: XML list of objects to activate
    // ═══════════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/activate', async (req, res) => {
        try {
            const { destinationName, objects } = req.body;
            // objects: [{ name, type, url }]
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
            const csrfToken = await fetchAdtCsrfToken(destinationName, jwt);

            const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${objects.map(o => `  <adtcore:objectReference adtcore:uri="${o.url}" adtcore:name="${o.name}" adtcore:type="${o.type}"/>`).join('\n')}
</adtcore:objectReferences>`;

            const response = await callAdt(destinationName, jwt, {
                method: 'POST',
                url: '/sap/adt/activation/activate_multiple',
                headers: {
                    'X-CSRF-Token': csrfToken,
                    'Content-Type': 'application/xml',
                    'Accept': 'application/xml'
                },
                data: xmlBody
            });

            res.json({ success: true, status: response.status, data: response.data });
        } catch (error) {
            console.error('[adt/activate] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════
    // /api/adt/get-source  — Get source code of an existing object
    // ADT API: GET /sap/adt/<objectUrl>/source/main
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
            const response = await callAdt(destinationName, jwt, {
                method: 'GET',
                url: `${objectUrl}/source/main`,
                headers: { Accept: 'text/plain' }
            });
            res.json({ success: true, source: response.data });
        } catch (error) {
            console.error('[adt/get-source] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });
});

module.exports = cds.server;
