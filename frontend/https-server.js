const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT, 10) || 3000;
const secondaryPort = parseInt(process.env.SECONDARY_PORT, 10) || 3001;

// Log but do NOT exit: a single failed render inside Next.js (which surfaces
// as an unhandled rejection) was killing the whole server, failing ALB health
// checks and taking the site down with a 502.
process.on('uncaughtException', (err) => {
    console.error('ERROR: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('ERROR: Unhandled Rejection, reason:', reason);
});

console.log(`-> Starting server in ${dev ? 'development' : 'production'} mode...`);
console.log(`-> Target: http://${hostname}:${port}`);

console.log("-> Initializing Next.js app object...");
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
// WebSocket upgrades (the live channel at /api/live, #98) go through the same
// /api rewrite as everything else; we attach Next's upgrade handler to both
// listeners ourselves, below. Left alone, Next attaches it lazily to whichever
// server served the first page request, and only to that one.
app.didWebSocketSetup = true;

const requestHandler = async (req, res) => {
    // Immediate health check response (even if Next.js isn't ready)
    if (req.url === '/health' || req.url === '/ping') {
        res.statusCode = 200;
        res.end('ok');
        return;
    }

    try {
        const parsedUrl = parse(req.url, true);
        // /admin and /db pages carry the JWT as ?token= — same leak the backend
        // logger had (#39): keep it out of CloudWatch.
        console.log(`[FRONTEND] ${req.method} ${req.url.replace(/([?&]token=)[^&]+/, "$1***")}`);
        await handle(req, res, parsedUrl);
    } catch (err) {
        console.error('Error occurred handling', req.url.replace(/([?&]token=)[^&]+/, "$1***"), err);
        res.statusCode = 500;
        res.end('Internal Server Error');
    }
};

console.log("-> Creating HTTP servers...");
const httpServer = createHttpServer(requestHandler);
const secondaryServer = createHttpServer(requestHandler);

// The ALB keeps idle connections to this server open for its idle timeout
// (120 s on dev and prod, raised for the live channel's WebSockets, #106).
// Node's default 5 s keep-alive would close them first, and a request the ALB
// sends down a connection just as Node closes it comes back as a 502. So keep
// idle connections longer than the ALB does: raise these with its timeout.
for (const server of [httpServer, secondaryServer]) {
    server.keepAliveTimeout = 125_000;
    server.headersTimeout = 126_000;
}

httpServer.listen(port, hostname, () => {
    console.log(`> Server Ready on http://${hostname}:${port}`);
});

secondaryServer.listen(secondaryPort, hostname, () => {
    console.log(`> Appending Listener on http://${hostname}:${secondaryPort}`);
});

console.log("-> Preparing Next.js app (compilation)...");
app.prepare().then(() => {
    console.log("-> App prepared successfully.");
    if (typeof app.upgradeHandler === 'function') {
        for (const server of [httpServer, secondaryServer]) {
            server.on('upgrade', (req, socket, head) => app.upgradeHandler(req, socket, head));
        }
        console.log("-> WebSocket upgrades proxied through the rewrites.");
    } else {
        // A Next upgrade moved the internals: fall back to Next's own lazy setup.
        app.didWebSocketSetup = false;
        console.warn("-> WARNING: next has no upgradeHandler; WebSocket upgrades rely on its lazy setup.");
    }
}).catch((err) => {
    console.error("-> Failed to prepare app:");
    console.error(err);
});
