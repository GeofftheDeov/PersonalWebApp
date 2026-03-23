const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/personal_web_app';

async function recreateUser() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const users = db.collection('users');
        const email = 'geoffrey.murray.1995@gmail.com';
        
        // 1. Delete
        const delResult = await users.deleteMany({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
        console.log('Deleted copies:', delResult.deletedCount);
        
        // 2. Hash password
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash('Password123!', salt);
        
        // 3. Insert fresh
        const userData = {
            name: "Geoffrey Murray",
            email: email,
            password: hashed,
            role: "admin",
            isVerified: true,
            userNumber: "ADM-" + Date.now(),
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        const insResult = await users.insertOne(userData);
        console.log('Inserted fresh user:', insResult.insertedId);
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

recreateUser();
