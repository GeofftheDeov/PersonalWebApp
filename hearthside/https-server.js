// Hearthside's server: its own copy of the portfolio's custom server
// (frontend/https-server.js), for the same two reasons. Stock `next start`
// would bring both problems back:
//   - the live channel's WebSocket (/api/live) is proxied through the /api
//     rewrite, and Next only attaches its upgrade handler lazily, to whichever
//     server served the first page; this attaches it up front;
//   - idle keep-alive connections stay open longer than the ALB's 120 s idle
//     timeout, so the ALB never reuses a connection Node just closed (a 502).
//
//   npm run dev                      development (next dev, on this server)
//   npm start  (or NODE_ENV=production node https-server.js)   after `npm run build`
//
// PORT (default 3002) is the one listener. The portfolio's container uses 3000
// and 3001 in the same ECS task, so Hearthside keeps clear of both.
// SECONDARY_PORT adds a second listener, as the portfolio has, if a target
// group ever needs one.
const dev = process.env.NODE_ENV !== 'production' && !process.argv.includes('--production');
// Before Next loads: it reads NODE_ENV as it starts.
if (!dev) process.env.NODE_ENV = 'production';

const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');

const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT, 10) || 3002;
const secondaryPort = parseInt(process.env.SECONDARY_PORT, 10) || null;

// Log but do NOT exit: a single failed render inside Next.js (which surfaces
// as an unhandled rejection) would otherwise kill the whole server, failing
// ALB health checks and taking the site down with a 502.
process.on('uncaughtException', (err) => {
    console.error('ERROR: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('ERROR: Unhandled Rejection, reason:', reason);
});

console.log(`-> Hearthside: starting in ${dev ? 'development' : 'production'} mode on http://${hostname}:${port}`);

const app = next({ dev, hostname, port, dir: __dirname });
const handle = app.getRequestHandler();
// WebSocket upgrades (the live channel at /api/live) go through the same /api
// rewrite as everything else; we attach Next's upgrade handler to every
// listener ourselves, below. Left alone, Next attaches it lazily to whichever
// server served the first page request, and only to that one.
app.didWebSocketSetup = true;
// Pages wait for this: until Next is prepared its handler isn't there, and a
// request that came in early would fail with a 500. (/health doesn't wait.)
const prepared = app.prepare();

// The JWT can ride in a ?token= query (the backend's own pages); keep it out of the logs.
const redact = (url) => url.replace(/([?&]token=)[^&]+/, '$1***');

const requestHandler = async (req, res) => {
    // Immediate health check response (even if Next.js isn't ready)
    if (req.url === '/health' || req.url === '/ping') {
        res.statusCode = 200;
        res.end('ok');
        return;
    }

    try {
        const parsedUrl = parse(req.url, true);
        console.log(`[HEARTHSIDE] ${req.method} ${redact(req.url)}`);
        await prepared;
        await handle(req, res, parsedUrl);
    } catch (err) {
        console.error('Error occurred handling', redact(req.url), err);
        res.statusCode = 500;
        res.end('Internal Server Error');
    }
};

const servers = [createHttpServer(requestHandler)];
if (secondaryPort) servers.push(createHttpServer(requestHandler));

// The ALB keeps idle connections to this server open for its idle timeout
// (120 s on dev and prod, raised for the live channel's WebSockets, #106).
// Node's default 5 s keep-alive would close them first, and a request the ALB
// sends down a connection just as Node closes it comes back as a 502. So keep
// idle connections longer than the ALB does: raise these with its timeout.
for (const server of servers) {
    server.keepAliveTimeout = 125_000;
    server.headersTimeout = 126_000;
}

servers[0].listen(port, hostname, () => {
    console.log(`> Hearthside ready on http://${hostname}:${port}`);
});
if (secondaryPort) {
    servers[1].listen(secondaryPort, hostname, () => {
        console.log(`> Hearthside also listening on http://${hostname}:${secondaryPort}`);
    });
}

prepared.then(() => {
    console.log('-> Hearthside: app prepared.');
    if (typeof app.upgradeHandler === 'function') {
        for (const server of servers) {
            server.on('upgrade', (req, socket, head) => app.upgradeHandler(req, socket, head));
        }
        console.log('-> WebSocket upgrades proxied through the rewrites.');
    } else {
        // A Next upgrade moved the internals: fall back to Next's own lazy setup.
        app.didWebSocketSetup = false;
        console.warn('-> WARNING: next has no upgradeHandler; WebSocket upgrades rely on its lazy setup.');
    }
}).catch((err) => {
    console.error('-> Failed to prepare app:');
    console.error(err);
});
