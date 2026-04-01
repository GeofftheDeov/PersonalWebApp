const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const uri = process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app";

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const database = client.db('personal_web_app');
        const leads = database.collection('leads');
        
        const results = await leads.find({}).toArray();
        
        console.log(`Found ${results.length} leads in MongoDB.`);
        results.forEach(lead => {
            console.log(`ID: ${lead._id} | Name: ${lead.firstName} ${lead.lastName} | Email: "${lead.email}" | sfID: ${lead.sfLeadId}`);
        });
    } finally {
        await client.close();
    }
}
run();
