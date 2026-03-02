const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
    if (process.env.NODE_ENV === 'production') {
        const passport = require('passport');
        const { JWTStrategy } = require('@sap/xssec');
        const xsenv = require('@sap/xsenv');
        try {
            const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
            passport.use(new JWTStrategy(services.uaa));
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

    app.post('/api/action', (req, res) => {
        res.json({ message: "Action successful, POST request allowed. CSRF token was valid!" });
    });
});

module.exports = cds.server;
