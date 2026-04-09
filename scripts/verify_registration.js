const fetch = require('node-fetch');

async function testRegistration(payload, description) {
    console.log(`Testing: ${description}`);
    try {
        const response = await fetch('http://localhost:5000/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        console.log(`Status: ${response.status}`);
        console.log(`Response: ${JSON.stringify(data, null, 2)}`);
        console.log('---');
    } catch (error) {
        console.error(`Error: ${error.message}`);
    }
}

async function runTests() {
    const base = { firstName: 'Test', lastName: 'User', password: 'password123' };

    await testRegistration({ ...base, email: `test${Date.now()}@example.com` }, 'Valid Email, No Phone');
    await testRegistration({ ...base, phone: '555-0101' }, 'Valid Phone, No Email');
    await testRegistration({ ...base, email: `test${Date.now()+1}@example.com`, phone: '555-0202' }, 'Both Email and Phone');
    await testRegistration({ ...base }, 'Neither Email nor Phone (Should Fail)');
}

runTests();
