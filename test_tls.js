const https = require('https');

// Try with different TLS versions
const testWithTLS = (url, tlsVersion) => {
  console.log(`\nTesting ${url} with ${tlsVersion}...`);
  
  const options = new URL(url);
  options.rejectUnauthorized = false;
  
  if (tlsVersion) {
    options.secureProtocol = tlsVersion;
  }
  
  https.get(url, options, (res) => {
    console.log(`✓ Success with ${tlsVersion || 'default'} - Status: ${res.statusCode}`);
    res.on('data', () => {});
  }).on('error', (err) => {
    console.error(`✗ Failed with ${tlsVersion || 'default'}: ${err.message}`);
  });
};

const url = 'https://supermarginally-unquivered-ashli.ngrok-free.dev';

// Test with different TLS versions
testWithTLS(url, null); // default
testWithTLS(url, 'TLSv1_2_method');
testWithTLS(url, 'TLSv1_3_method');
