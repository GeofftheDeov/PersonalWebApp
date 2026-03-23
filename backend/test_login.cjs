const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/personal_web_app';

async function testLogin() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const users = db.collection('users');
        
        const email = 'geoffrey.murray.1995@gmail.com';
        const passwordInput = 'Password123!';
        
        console.log('Testing login for:', email);
        
        // 1. Find User
        const user = await users.findOne({ email });
        if (!user) {
            console.log('FAIL: User not found in DB');
            
            // Check insensitive
            const insensitiveUser = await users.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
            if (insensitiveUser) {
                console.log('HINT: Found case-insensitive match:', insensitiveUser.email);
            }
            process.exit(1);
        }
        
        console.log('SUCCESS: User found. ID:', user._id);
        console.log('Stored Password Hash:', user.password);
        
        // 2. Compare Password
        console.log('Comparing with input:', passwordInput);
        const isMatch = await bcrypt.compare(passwordInput, user.password);
        
        if (isMatch) {
            console.log('SUCCESS: Password matches!');
        } else {
            console.log('FAIL: Password mismatch!');
        }
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testLogin();
