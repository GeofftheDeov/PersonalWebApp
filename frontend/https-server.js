const { createServer: createHttpServer } = require('http');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT, 10) || 3000;

process.on('uncaughtException', (err) => {
    console.error('FATAL: Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('FATAL: Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

console.log(`-> Starting server in ${dev ? 'development' : 'production'} mode...`);
console.log(`-> Target: http://${hostname}:${port}`);

console.log("-> Initializing Next.js app object...");
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const requestHandler = async (req, res) => {
    // Immediate health check response (even if Next.js isn't ready)
    if (req.url === '/health' || req.url === '/ping') {
        res.statusCode = 200;
        res.end('ok');
        return;
    }

    try {
        const parsedUrl = parse(req.url, true);
        console.log(`[FRONTEND] ${req.method} ${req.url}`);
        await handle(req, res, parsedUrl);
    } catch (err) {
        console.error('Error occurred handling', req.url, err);
        res.statusCode = 500;
        res.end('Internal Server Error');
    }
};

console.log("-> Creating HTTP servers...");
const httpServer = createHttpServer(requestHandler);
const secondaryServer = createHttpServer(requestHandler);

httpServer.listen(port, hostname, () => {
    console.log(`> Server Ready on http://${hostname}:${port}`);
});

secondaryServer.listen(3001, hostname, () => {
    console.log(`> Appending Listener on http://${hostname}:3001`);
});

console.log("-> Preparing Next.js app (compilation)...");
app.prepare().then(() => {
    console.log("-> App prepared successfully.");
}).catch((err) => {
    console.error("-> Failed to prepare app:");
    console.error(err);
});
