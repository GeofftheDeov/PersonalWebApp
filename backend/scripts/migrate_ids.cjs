const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/personal_web_app';

async function migrate() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const config = [
            { name: 'users', prefix: 'ADM-' },
            { name: 'leads', prefix: 'LD-' },
            { name: 'accounts', prefix: 'ACC-' },
            { name: 'contacts', prefix: 'CON-' }
        ];

        for (const colDef of config) {
            const collection = db.collection(colDef.name);
            const records = await collection.find({}).toArray();
            console.log(`Checking ${records.length} records in ${colDef.name}...`);

            for (const record of records) {
                let needsUpdate = false;
                const updateData = {};

                // Logic: 
                // 1. userNumber should be 4-digits
                // 2. userDigit should be timestamp with prefix

                let currentNum = record.userNumber;
                let currentDigit = record.userDigit;

                // Case A: userNumber currently holds the timestamp
                if (currentNum && currentNum.includes('-')) {
                    updateData.userDigit = currentNum;
                    updateData.userNumber = Math.floor(1000 + Math.random() * 9000).toString();
                    needsUpdate = true;
                } 
                // Case B: userNumber is missing but we have a handle
                else if (!currentNum) {
                    updateData.userNumber = Math.floor(1000 + Math.random() * 9000).toString();
                    needsUpdate = true;
                }

                // Case C: userDigit is missing
                if (!currentDigit && !updateData.userDigit) {
                    updateData.userDigit = colDef.prefix + (record.createdAt ? new Date(record.createdAt).getTime() : Date.now());
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    await collection.updateOne({ _id: record._id }, { $set: updateData });
                    console.log(`Updated ${colDef.name} record: ${record.email || record.name || record._id}`);
                }
            }
        }

        console.log('Migration complete!');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
