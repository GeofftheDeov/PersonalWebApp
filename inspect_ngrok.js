const http = require('http');

const getJSON = (path) => {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:4040${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
};

async function main() {
  try {
    const tunnels = await getJSON('/api/tunnels');
    console.log('--- TUNNELS ---');
    tunnels.tunnels.forEach(t => {
      console.log(`Name: ${t.name}`);
      console.log(`Public URL: ${t.public_url}`);
      console.log(`Proto: ${t.proto}`);
      console.log(`Config Address: ${t.config.addr}`);
      console.log(`Bind TLS: ${t.config.bind_tls}`);
      console.log('---');
    });

    const requests = await getJSON('/api/requests');
    console.log('--- RECENT REQUESTS ---');
    requests.requests.slice(0, 3).forEach(r => {
      console.log(`${r.method} ${r.uri} -> ${r.response.status}`);
      if (r.error) console.log(`Error: ${r.error}`);
    });
  } catch (err) {
    console.error('Failed to get ngrok info:', err.message);
  }
}

main();
