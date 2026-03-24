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

    const { callMcpTool } = require('./mcp-client');

    // ── Helper: extract user JWT from request ──────────────────────────────────
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

    // ── Helper: handle and format errors from MCP calls ────────────────────────
    function handleMcpError(res, err, endpoint) {
        const msg = err.message || 'Unknown MCP error';
        const status = msg.includes('401') ? 401 : msg.includes('403') ? 403 : 500;
        console.error(`[mcp/${endpoint}] Error (HTTP ${status}):`, msg);
        return res.status(status).json({ error: msg, endpoint });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // /api/me — User info (unchanged, no ADT call)
    // ══════════════════════════════════════════════════════════════════════════
    app.get('/api/me', (req, res) => {
        if (req.authInfo) {
            res.json({
                userId: req.authInfo.getLogonName(),
                email: req.authInfo.getEmail(),
                firstName: req.authInfo.getGivenName(),
                lastName: req.authInfo.getFamilyName()
            });
        } else if (process.env.NODE_ENV !== 'production') {
            res.json({ userId: 'dev-user', email: 'dev@local.host', firstName: 'Local', lastName: 'Developer' });
        } else {
            res.status(401).json({ error: 'Not authenticated' });
        }
    });

    app.get('/api/get-token', (req, res) => {
        const token = getUserJwt(req);
        if (token) {
            res.json({ token: `Bearer ${token}` });
        } else {
            res.status(401).json({ error: 'No JWT found' });
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/fetch-bom — Kept for compatibility (direct OData call, not ADT)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/fetch-bom', async (req, res) => {
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
        try {
            const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
            const destinationName = req.body?.destinationName || 'T4X_011';
            const jwt = getUserJwt(req);
            const response = await executeHttpRequest(
                { destinationName, jwt },
                { method: 'GET', url: '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV/A_BOMItemCategoryText', headers: { Accept: 'application/json' } }
            );
            res.json({ success: true, data: response.data.d?.results || response.data.value || response.data });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/search — Search ABAP repository objects
    // MCP Tool: searchObject(query, objType, max)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/search', async (req, res) => {
        try {
            const { destinationName, query, objectType = '', maxResults = 50 } = req.body;
            if (!destinationName || !query) return res.status(400).json({ error: 'Missing destinationName or query' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, data: [
                    { name: `Z_${query.toUpperCase()}_01`, type: 'PROG', description: 'Mock ABAP Program', packageName: 'ZLOCAL' }
                ]});
            }

            const jwt = getUserJwt(req);
            console.log(`[adt/search] query=${query}, objectType=${objectType}, maxResults=${maxResults}`);

            const result = await callMcpTool('searchObject', {
                query: query + '*',
                objType: objectType || undefined,
                max: maxResults
            }, jwt);

            // result.results is an array of SearchResult objects
            const data = (result.results || []).map(r => ({
                name: r['adtcore:name'] || r.name,
                type: r['adtcore:type'] || r.type,
                description: r['adtcore:description'] || r.description || '',
                packageName: r['adtcore:packageName'] || r.packageName || '',
                url: r['adtcore:uri'] || r.uri || ''
            }));

            res.json({ success: true, data });
        } catch (error) {
            return handleMcpError(res, error, 'search');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/search-package — Search packages and their contents
    // MCP Tool: searchPackage(packageName) for exact, searchObject for wildcard
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/search-package', async (req, res) => {
        try {
            const { destinationName, query, maxResults = 50 } = req.body;
            if (!destinationName || !query) return res.status(400).json({ error: 'Missing destinationName or query' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, data: [
                    { name: `Z${query.toUpperCase()}`, type: 'DEVC', description: 'Mock Package 1', superPackage: '$TMP' }
                ]});
            }

            const jwt = getUserJwt(req);
            const isExact = !query.includes('*');

            let data = [];
            if (isExact) {
                // Exact: get package + all its contents
                const result = await callMcpTool('searchPackage', { packageName: query }, jwt);
                data = result.results || [];
            } else {
                // Wildcard: list matching packages only
                const result = await callMcpTool('searchObject', {
                    query,
                    objType: 'DEVC/K',
                    max: maxResults
                }, jwt);
                data = (result.results || []).map(r => ({
                    name: r['adtcore:name'] || r.name,
                    type: 'DEVC',
                    description: r['adtcore:description'] || r.description || ''
                }));
            }

            res.json({ success: true, data });
        } catch (error) {
            return handleMcpError(res, error, 'search-package');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/transports — Get open transports for a package
    // MCP Tool: transportInfo(objSourceUrl, devClass)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/transports', async (req, res) => {
        try {
            const { destinationName, packageName } = req.body;
            if (!destinationName || !packageName) return res.status(400).json({ error: 'Missing destinationName or packageName' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, data: [
                    { number: 'T4XK903271', status: 'D', description: 'Mock Transport 1', owner: 'MOCKUSER' }
                ]});
            }

            const jwt = getUserJwt(req);
            const packageUri = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
            const result = await callMcpTool('transportInfo', {
                objSourceUrl: packageUri,
                devClass: packageName.toUpperCase()
            }, jwt);

            // transportInfo returns transport request info
            const transports = (result.transports || result.results || [])
                .filter(t => t.status === 'D' || !t.status)
                .map(t => ({
                    number: t.number || t['trkorr'],
                    status: t.status || 'D',
                    description: t.description || t['as4text'] || '',
                    owner: t.owner || t['as4user'] || ''
                }));

            res.json({ success: true, data: transports });
        } catch (error) {
            return handleMcpError(res, error, 'transports');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/create-object — Create a new ABAP object
    // MCP Tool: createObject(objtype, name, parentName, description, parentPath, responsible, transport)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/create-object', async (req, res) => {
        try {
            const {
                destinationName, objectType, name, packageName,
                description, responsible, parentPath, transport
            } = req.body;
            if (!destinationName || !objectType || !name || !packageName) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, objectType, name, packageName' });
            }

            // Normalize type: 'CLAS/OC' → 'CLAS/OC' (MCP createObject uses full type ID)
            const baseType = objectType.includes('/') ? objectType.split('/')[0] : objectType;
            const typeIdMap = {
                'PROG': 'PROG/P', 'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI',
                'FUGR': 'FUGR/F', 'DEVC': 'DEVC/K'
            };
            const objtype = typeIdMap[baseType] || objectType;

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Object ${name} created`, objectUrl: `/sap/bc/adt/oo/classes/${name.toLowerCase()}` });
            }

            const jwt = getUserJwt(req);
            const logonName = req.authInfo?.getLogonName?.() || 'unknown';
            console.log(`[adt/create-object] type=${objtype}, name=${name}, package=${packageName}`);

            const cleanName = name.toUpperCase();
            const cleanPkg = packageName.toUpperCase();
            const pkgPath = parentPath || `/sap/bc/adt/packages/${cleanPkg.toLowerCase()}`;

            const result = await callMcpTool('createObject', {
                objtype,
                name: cleanName,
                parentName: cleanPkg,
                description: description || '',
                parentPath: pkgPath,
                responsible: (responsible || logonName || 'DEVELOPER').toUpperCase(),
                transport: transport || undefined
            }, jwt);

            res.json({ success: true, objectUrl: result.result || result.objectUrl || pkgPath, statusCode: 201 });
        } catch (error) {
            return handleMcpError(res, error, 'create-object');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/lock — Lock an ABAP object for editing
    // MCP Tool: lock(objectUrl, accessMode)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/lock', async (req, res) => {
        try {
            const { destinationName, objectUrl, accessMode = 'MODIFY' } = req.body;
            if (!destinationName || !objectUrl) return res.status(400).json({ error: 'Missing destinationName or objectUrl' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, lockHandle: `MOCK_LOCK_${Date.now()}`, message: `[Mock] Object locked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const result = await callMcpTool('lock', { objectUrl, accessMode }, jwt);

            res.json({ success: true, lockHandle: result.lockHandle, message: result.message });
        } catch (error) {
            return handleMcpError(res, error, 'lock');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/unlock — Unlock an ABAP object
    // MCP Tool: unLock(objectUrl, lockHandle)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/unlock', async (req, res) => {
        try {
            const { destinationName, objectUrl, lockHandle } = req.body;
            if (!destinationName || !objectUrl || !lockHandle) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Unlocked: ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            const result = await callMcpTool('unLock', { objectUrl, lockHandle }, jwt);

            res.json({ success: true, message: result.message });
        } catch (error) {
            return handleMcpError(res, error, 'unlock');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/get-source — Retrieve source code of an ABAP object
    // MCP Tool: getObjectSource(objectSourceUrl)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/get-source', async (req, res) => {
        try {
            const { destinationName, objectUrl } = req.body;
            if (!destinationName || !objectUrl) return res.status(400).json({ error: 'Missing fields' });

            if (process.env.NODE_ENV !== 'production') {
                return res.json({
                    success: true,
                    source: `*------\nREPORT z_example.\nSTART-OF-SELECTION.\n  WRITE: / 'Hello, World!'.`,
                    sourceUrl: `${objectUrl}/source/main`
                });
            }

            const jwt = getUserJwt(req);
            const sourceUrl = objectUrl.includes('/source/main') ? objectUrl : `${objectUrl}/source/main`;
            const result = await callMcpTool('getObjectSource', { objectSourceUrl: sourceUrl }, jwt);

            res.json({ success: true, source: result.source, sourceUrl });
        } catch (error) {
            return handleMcpError(res, error, 'get-source');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/set-source — Lock + Set source + Unlock in one sequence
    // MCP Tools: lock → setObjectSource → unLock
    // The MCP server maintains stateful session, so sequencing works reliably.
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/set-source', async (req, res) => {
        try {
            const { destinationName, objectUrl, sourceUrl, source, transport } = req.body;
            if (!destinationName || !objectUrl || source === undefined) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, objectUrl, source' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Source saved for ${objectUrl}` });
            }

            const jwt = getUserJwt(req);
            console.log(`[adt/set-source] Locking ${objectUrl}...`);

            // Step 1: Lock
            const lockResult = await callMcpTool('lock', { objectUrl, accessMode: 'MODIFY' }, jwt);
            const lockHandle = lockResult.lockHandle;
            if (!lockHandle) throw new Error('Could not obtain lock handle from MCP server');
            console.log(`[adt/set-source] Lock handle: ${lockHandle}`);

            // Step 2: Set source
            const targetSourceUrl = sourceUrl || `${objectUrl}/source/main`;
            let setError = null;
            try {
                await callMcpTool('setObjectSource', {
                    objectSourceUrl: targetSourceUrl,
                    source,
                    lockHandle,
                    transport: transport || undefined
                }, jwt);
            } catch (err) {
                setError = err;
                console.error(`[adt/set-source] Set source failed: ${err.message}`);
            }

            // Step 3: Always unlock
            try {
                await callMcpTool('unLock', { objectUrl, lockHandle }, jwt);
            } catch (unlockErr) {
                console.warn(`[adt/set-source] Unlock warning: ${unlockErr.message}`);
            }

            if (setError) throw setError;
            res.json({ success: true, message: 'Source saved successfully', sourceUrl: targetSourceUrl });

        } catch (error) {
            return handleMcpError(res, error, 'set-source');
        }
    });

    // Keep save-source as alias for set-source
    app.post('/api/adt/save-source', async (req, res) => {
        req.url = '/api/adt/set-source';
        return app._router.handle(req, res, () => {});
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/activate — Activate one or more ABAP objects
    // MCP Tool: activate(objectName, objectUrl)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/activate', async (req, res) => {
        try {
            const { destinationName, objects } = req.body;
            if (!destinationName || !objects || !objects.length) {
                return res.status(400).json({ error: 'Missing destinationName or objects array' });
            }

            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Activated ${objects.length} object(s)`, activated: objects.map(o => o.name || o['adtcore:name']) });
            }

            const jwt = getUserJwt(req);
            const results = [];
            // Activate each object (MCP activate handles one at a time)
            for (const obj of objects) {
                const name = (obj.name || obj['adtcore:name'] || '').toUpperCase();
                const url = obj.url || obj['adtcore:uri'] || '';
                if (!name || !url) continue;
                try {
                    const r = await callMcpTool('activate', { objectName: name, objectUrl: url }, jwt);
                    results.push({ name, success: r.status === 'success' });
                } catch (e) {
                    results.push({ name, success: false, error: e.message });
                }
            }
            const allOk = results.every(r => r.success);
            res.json({ success: allOk, message: allOk ? 'All activated successfully' : 'Some activations failed', results });
        } catch (error) {
            return handleMcpError(res, error, 'activate');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // /api/adt/create-test-include — Create test include for a class
    // MCP Tool: createTestInclude(clas, lockHandle, transport)
    // ══════════════════════════════════════════════════════════════════════════
    app.post('/api/adt/create-test-include', async (req, res) => {
        try {
            const { destinationName, clas, lockHandle, transport } = req.body;
            if (!destinationName || !clas || !lockHandle) {
                return res.status(400).json({ error: 'Missing required fields: destinationName, clas, lockHandle' });
            }
            if (process.env.NODE_ENV !== 'production') {
                return res.json({ success: true, message: `[Mock] Test include created for ${clas}` });
            }
            const jwt = getUserJwt(req);
            const result = await callMcpTool('createTestInclude', { clas, lockHandle, transport: transport || '' }, jwt);
            res.json({ success: true, message: result.message });
        } catch (error) {
            return handleMcpError(res, error, 'create-test-include');
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // AI endpoints — powered by company RAG AI (GPT/Gemini via DIA Brain)
    // toolExecutor now routes all ADT operations through MCP
    // ══════════════════════════════════════════════════════════════════════════
    const { agenticChat, createHistory } = require('./ai-service');

    app.post('/api/ai/history', async (req, res) => {
        try {
            const { getTokenCached } = require('./ai-service');
            const token = await getTokenCached();
            const historyId = await createHistory(token);
            res.json({ success: true, historyId });
        } catch (err) {
            console.error('[ai/history] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/ai/chat', async (req, res) => {
        const { message, historyId, destinationName } = req.body;
        if (!message) return res.status(400).json({ error: 'Missing message' });

        const dest = destinationName || 'T4X_011';

        try {
            const jwt = getUserJwt(req);

            /**
             * Tool executor — maps AI tool calls to MCP tools.
             * Destination name is passed in x-sap-destination-name header via MCP client.
             */
            const toolExecutor = async (toolName, params) => {
                console.log(`[ai/tool] executing tool=${toolName}`);

                switch (toolName) {
                    case 'search_object':
                        return callMcpTool('searchObject', {
                            query: params.query,
                            objType: params.objectType || undefined,
                            max: params.maxResults || 50
                        }, jwt);

                    case 'search_package':
                        return callMcpTool('searchPackage', {
                            packageName: params.query || params.packageName
                        }, jwt);

                    case 'get_source': {
                        const srcUrl = params.objectUrl.includes('/source/main')
                            ? params.objectUrl : `${params.objectUrl}/source/main`;
                        return callMcpTool('getObjectSource', { objectSourceUrl: srcUrl }, jwt);
                    }

                    case 'create_object': {
                        const rawType = params.objectType || 'CLAS/OC';
                        const baseType = rawType.includes('/') ? rawType.split('/')[0] : rawType;
                        const typeIdMap = { 'PROG': 'PROG/P', 'CLAS': 'CLAS/OC', 'INTF': 'INTF/OI' };
                        const objtype = typeIdMap[baseType] || rawType;
                        const cleanName = (params.name || '').toUpperCase();
                        const cleanPkg = (params.packageName || '').toUpperCase();
                        return callMcpTool('createObject', {
                            objtype,
                            name: cleanName,
                            parentName: cleanPkg,
                            description: params.description || '',
                            parentPath: params.parentPath || `/sap/bc/adt/packages/${cleanPkg.toLowerCase()}`,
                            transport: params.transport || undefined
                        }, jwt);
                    }

                    case 'lock':
                        return callMcpTool('lock', {
                            objectUrl: params.objectUrl,
                            accessMode: params.accessMode || 'MODIFY'
                        }, jwt);

                    case 'set_source': {
                        const srcUrl = params.sourceUrl || `${params.objectUrl}/source/main`;
                        return callMcpTool('setObjectSource', {
                            objectSourceUrl: srcUrl,
                            source: params.source || '',
                            lockHandle: params.lockHandle,
                            transport: params.transport || undefined
                        }, jwt);
                    }

                    case 'save_source': {
                        const objectUrl = params.objectUrl;
                        const source = params.source;
                        const sourceUrl = params.sourceUrl || `${objectUrl}/source/main`;

                        // Lock → Set → Unlock atomically
                        const lockRes = await callMcpTool('lock', { objectUrl, accessMode: 'MODIFY' }, jwt);
                        const lockHandle = lockRes.lockHandle;
                        if (!lockHandle) throw new Error('Could not obtain lock handle');

                        let setErr = null;
                        try {
                            await callMcpTool('setObjectSource', {
                                objectSourceUrl: sourceUrl, source, lockHandle,
                                transport: params.transport || undefined
                            }, jwt);
                        } catch (e) { setErr = e; }

                        await callMcpTool('unLock', { objectUrl, lockHandle }, jwt).catch(() => {});
                        if (setErr) throw setErr;
                        return { status: 'success', message: 'Source saved atomically via MCP', sourceUrl };
                    }

                    case 'unlock':
                        return callMcpTool('unLock', {
                            objectUrl: params.objectUrl,
                            lockHandle: params.lockHandle
                        }, jwt);

                    case 'activate':
                        // Activate first object if AI passes an array
                        if (params.objects && params.objects.length) {
                            const obj = params.objects[0];
                            return callMcpTool('activate', {
                                objectName: (obj.name || obj['adtcore:name'] || '').toUpperCase(),
                                objectUrl: obj.url || obj['adtcore:uri'] || ''
                            }, jwt);
                        }
                        return callMcpTool('activate', {
                            objectName: (params.objectName || '').toUpperCase(),
                            objectUrl: params.objectUrl || ''
                        }, jwt);

                    case 'create_test_include':
                        return callMcpTool('createTestInclude', {
                            clas: params.clas || '',
                            lockHandle: params.lockHandle,
                            transport: params.transport || ''
                        }, jwt);

                    default:
                        throw new Error(`Unknown tool: ${toolName}`);
                }
            };

            const result = await agenticChat(message, historyId || null, dest, toolExecutor);
            res.json({ success: true, ...result });

        } catch (err) {
            console.error('[ai/chat] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
});

module.exports = cds.server;
