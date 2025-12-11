const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

console.log(`Attempting to bind to ${hostname}:${port}...`);

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Port binding test successful\n');
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

server.on('error', (e) => {
    console.error('Server error:', e);
});
