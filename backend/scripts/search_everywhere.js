import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/personal_web_app';

async function searchEverywhere() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const email = 'geoffrey.murray.1995@gmail.com';
        
        const collections = ['leads', 'users', 'accounts', 'contacts'];
        
        console.log(`Searching for email: ${email}`);
        for (const collName of collections) {
            const doc = await db.collection(collName).findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
            if (doc) {
                console.log(`[FOUND] in ${collName}: ID ${doc._id}, STATUS/ROLE ${doc.status || doc.role}`);
            } else {
                console.log(`[NOT FOUND] in ${collName}`);
            }
        }
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

searchEverywhere();
