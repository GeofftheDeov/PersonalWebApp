const http = require('http');

http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const tunnels = JSON.parse(data);
    if (tunnels.tunnels && tunnels.tunnels.length > 0) {
      const tunnel = tunnels.tunnels[0];
      console.log('Ngrok Tunnel Information:');
      console.log('Name:', tunnel.name);
      console.log('Public URL:', tunnel.public_url);
      console.log('Protocol:', tunnel.proto);
      console.log('Local Address:', tunnel.config.addr);
    }
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
