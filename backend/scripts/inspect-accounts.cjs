const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const uri = process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app";

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const database = client.db('personal_web_app');
        const accounts = database.collection('accounts');
        
        const cursor = accounts.find({ sfID: { $exists: true } }).limit(20);
        const results = await cursor.toArray();
        
        console.log(`Found ${results.length} synced accounts.`);
        results.forEach(acc => {
            console.log(`ID: ${acc._id} | Name: ${acc.name} | Email: "${acc.email}" | sfID: ${acc.sfID}`);
        });
    } finally {
        await client.close();
    }
}
run();
