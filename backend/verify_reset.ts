
import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5000/api/users';
const TEST_EMAIL = 'test_reset@example.com';
const TEST_PASSWORD = 'password123';
const NEW_PASSWORD = 'newpassword456';

async function runTest() {
    console.log("Starting Verification...");

    // 1. Register a test user (ignoring error if exists)
    try {
        await fetch(`${BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test User', email: TEST_EMAIL, password: TEST_PASSWORD })
        });
        console.log("Registered test user (or already exists).");
    } catch (e) {
        console.log("Registration skipped/failed (likely exists).");
    }

    // 2. Request Forgot Password
    console.log("Requesting password reset...");
    const forgotRes = await fetch(`${BASE_URL}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL })
    });
    
    if (!forgotRes.ok) {
        console.error("Forgot Password failed:", await forgotRes.text());
        return;
    }

    const forgotData = await forgotRes.json();
    console.log("Forgot Password Response:", forgotData);
    
    const token = forgotData.mockToken;
    if (!token) {
        console.error("No mock token received. backend logging might be needed to see it if not mocked in response.");
        return;
    }

    // 3. Reset Password
    console.log(`Resetting password with token: ${token}`);
    const resetRes = await fetch(`${BASE_URL}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: NEW_PASSWORD })
    });

    if (!resetRes.ok) {
        console.error("Reset Password failed:", await resetRes.text());
        return;
    }
    console.log("Reset Password Success:", await resetRes.json());

    // 4. Login with NEW password
    console.log("Attempting login with new password...");
    const loginRes = await fetch(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: NEW_PASSWORD })
    });

    if (loginRes.ok) {
        console.log("Login Successful! Verification Complete.");
    } else {
        console.error("Login Failed:", await loginRes.text());
    }
}

runTest();
