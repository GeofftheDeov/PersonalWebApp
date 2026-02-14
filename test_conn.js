const http = require('http');
const https = require('https');

// Disable SSL verification for testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = (url) => {
  console.log(`\nTesting ${url}...`);
  const client = url.startsWith('https') ? https : http;
  
  const options = url.startsWith('https') ? {
    rejectUnauthorized: false
  } : {};
  
  client.get(url, options, (res) => {
    console.log(`✓ ${url} - Status: ${res.statusCode}`);
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log(`  Response length: ${data.length} bytes`);
      if (data.length < 200) {
        console.log(`  Response: ${data}`);
      }
    });
  }).on('error', (err) => {
    console.error(`✗ ${url} - Error: ${err.message}`);
  });
};

test('http://localhost:5000');
test('https://supermarginally-unquivered-ashli.ngrok-free.dev');
