const { createServer } = require('https');
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
    console.log("-> App prepared. Creating HTTP server...");

    const httpsOptions = {
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
    };

    createServer(httpsOptions, async (req, res) => {
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
            console.log(`> Ready on https://${hostname}:${port}`);
            console.log("> If you see this message, the server is DEFINITELY listening (HTTPS).");
        });
}).catch((err) => {
    console.error("-> Failed to prepare app:");
    console.error(err);
});
