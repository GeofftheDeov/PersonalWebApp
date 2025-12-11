const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '127.0.0.1';
const port = 3000;

console.log("-> Initializing Next.js app object...");
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

console.log("-> Preparing Next.js app (compilation)...");
app.prepare().then(() => {
    console.log("-> App prepared. Creating HTTP server...");

    createServer(async (req, res) => {
        try {
            const parsedUrl = parse(req.url, true);
            await handle(req, res, parsedUrl);
        } catch (err) {
            console.error('Error occurred handling', req.url, err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    })
        .once('error', (err) => {
            console.error("-> Server binding error:");
            console.error(err);
            process.exit(1);
        })
        .listen(port, hostname, () => {
            console.log(`> Ready on http://${hostname}:${port}`);
            console.log("> If you see this message, the server is DEFINITELY listening.");
        });
}).catch((err) => {
    console.error("-> Failed to prepare app:");
    console.error(err);
});
