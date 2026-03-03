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

    // Return user info and handle CSRF token fetch from approuter
    app.get('/api/me', (req, res) => {
        // req.user is populated by basic authentication for local dev
        // req.authInfo is populated by xssec for production Approuter
        const user = req.user || req.authInfo;

        if (user) {
            // Local dev (mock strategy) uses a different object structure than XSUAA's authInfo
            const logonName = user.id || (user.getLogonName && user.getLogonName()) || 'mock-user';
            const email = (user.getEmail && user.getEmail()) || 'mock@example.com';
            const firstName = (user.getGivenName && user.getGivenName()) || 'Mock';
            const lastName = (user.getFamilyName && user.getFamilyName()) || 'User';

            res.json({
                userId: logonName,
                email: email,
                firstName: firstName,
                lastName: lastName
            });
        } else if (process.env.NODE_ENV !== 'production') {
            // Local dev fallback when accessed directly without cds mock auth wrapper
            res.json({
                userId: 'dev-user',
                email: 'dev@local.host',
                firstName: 'Local',
                lastName: 'Developer'
            });
        } else {
            console.warn("No user context found in request.");
            res.status(401).json({ error: "Not authenticated" });
        }
    });

    app.post('/api/fetch-bom', async (req, res) => {
        try {
            const destinationName = req.body.destinationName || 'T4X_011';
            if (!destinationName) {
                return res.status(400).json({ error: "Missing destinationName" });
            }

            // === LOCAL DEVELOPMENT MOCK ===
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[local-mock] Pretending to fetch OData from Destination: ${destinationName}`);
                return res.json({
                    success: true,
                    data: [
                        { BillOfMaterialItemCategory: "L", Language: "EN", BillOfMaterialItemCategoryDesc: "Stock item (Mock)" },
                        { BillOfMaterialItemCategory: "N", Language: "EN", BillOfMaterialItemCategoryDesc: "Non-stock item (Mock)" },
                        { BillOfMaterialItemCategory: "T", Language: "EN", BillOfMaterialItemCategoryDesc: "Text item (Mock)" }
                    ]
                });
            }

            // === PRODUCTION (SAP BTP) EXECUTION ===
            const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

            // Extract the user's JWT token for Principal Propagation
            // This token was set by Passport XSUAA middleware earlier
            const authHeader = req.headers.authorization;
            const userJwt = authHeader && authHeader.startsWith('Bearer ')
                ? authHeader.substring(7)
                : (req.authInfo && req.authInfo.getToken ? req.authInfo.getToken() : null);

            console.log(`[bom-fetch] Calling Destination: ${destinationName}, JWT present: ${!!userJwt}`);

            // Use SAP Cloud SDK to call the On-Premise OData service
            // The SDK automatically: resolves BTP Destination, opens Cloud Connector proxy, forwards JWT
            const response = await executeHttpRequest(
                {
                    destinationName: destinationName,
                    jwt: userJwt
                },
                {
                    method: 'GET',
                    url: '/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV/A_BOMItemCategoryText',
                    headers: { 'Accept': 'application/json' }
                }
            );

            // OData v2 wraps results in d.results
            const results = response.data.d?.results || response.data.value || response.data;
            res.json({ success: true, data: results });
        } catch (error) {
            console.error('[bom-fetch] Error calling OData On-Premise:', error.message);
            const details = error.cause?.message || error.response?.data || error.stack;
            console.error('[bom-fetch] Details:', details);
            res.status(500).json({ error: error.message, details: details });
        }
    });
});

module.exports = cds.server;
