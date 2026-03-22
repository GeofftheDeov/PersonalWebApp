const { createServer: createHttpsServer } = require('https');
const { createServer: createHttpServer } = require('http');
const fs = require('fs');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = 3000;

console.log("-> Initializing Next.js app object...");
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

console.log("-> Preparing Next.js app (compilation)...");
app.prepare().then(() => {
    console.log("-> App prepared. Creating servers...");

    const requestHandler = async (req, res) => {
        // Simple health check logging
        if (req.url === '/health' || req.url === '/ping') {
            console.log(`[HEALTHCHECK] ${req.method} ${req.url} - 200 OK`);
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

    // HTTP Server (behind AWS ALB)
    createHttpServer(requestHandler)
        .once('error', (err) => {
            console.error("-> HTTP server binding error:");
            console.error(err);
            process.exit(1);
        })
        .listen(port, hostname, () => {
            console.log(`> Server Ready on http://${hostname}:${port}`);
        });

}).catch((err) => {
    console.error("-> Failed to prepare app:");
    console.error(err);
});
