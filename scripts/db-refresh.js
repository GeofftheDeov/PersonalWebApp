const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const PROD_URI = process.env.PROD_MONGO_URI;
const DEV_URI = process.env.DEV_MONGO_URI;
const DEFAULT_PASSWORD = process.env.DEFAULT_DEV_PASSWORD || 'DevPassword123!';

async function anonymize() {
    if (!PROD_URI || !DEV_URI) {
        console.error("Missing PROD_MONGO_URI or DEV_MONGO_URI");
        process.exit(1);
    }

    const prodClient = new MongoClient(PROD_URI);
    const devClient = new MongoClient(DEV_URI);

    try {
        await prodClient.connect();
        await devClient.connect();

        const prodDb = prodClient.db();
        const devDb = devClient.db();

        const collections = ['users', 'accounts', 'contacts', 'leads'];
        const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

        for (const colName of collections) {
            console.log(`Processing collection: ${colName}`);
            const data = await prodDb.collection(colName).find({}).toArray();

            const cleanData = data.map(doc => {
                const scrubbed = { ...doc };

                // Generic scrubbing
                if (scrubbed.name) scrubbed.name = `Dev User ${scrubbed._id.toString().slice(-4)}`;
                if (scrubbed.firstName) scrubbed.firstName = "Dev";
                if (scrubbed.lastName) scrubbed.lastName = `User-${scrubbed._id.toString().slice(-4)}`;
                if (scrubbed.email) scrubbed.email = `dev-${scrubbed._id}@example.com`;
                if (scrubbed.phone) scrubbed.phone = "555-000-0000";
                if (scrubbed.address) scrubbed.address = "123 Dev Lane, Cloud City, CC";
                
                // Security scrubbing
                if (scrubbed.password) scrubbed.password = passwordHash;
                delete scrubbed.resetPasswordToken;
                delete scrubbed.emailVerificationToken;
                
                // Integration scrubbing (prevent accidental prod sync)
                delete scrubbed.sfID;
                delete scrubbed.sfLeadId;
                delete scrubbed.sfRecordTypeID;
                delete scrubbed.discordId;
                delete scrubbed.discordHandle;

                return scrubbed;
            });

            if (cleanData.length > 0) {
                await devDb.collection(colName).deleteMany({});
                await devDb.collection(colName).insertMany(cleanData);
                console.log(`Successfully refreshed ${cleanData.length} records in ${colName}`);
            } else {
                console.log(`No data found in ${colName}`);
            }
        }

        // Handle other collections by just copying if they don't have PII
        const otherCollections = ['campaigns', 'sessions', 'characters', 'events', 'dungeons', 'encounters', 'playersessions'];
        for (const colName of otherCollections) {
             const prodCol = prodDb.collection(colName);
             const count = await prodCol.countDocuments();
             if (count > 0) {
                 const data = await prodCol.find({}).toArray();
                 await devDb.collection(colName).deleteMany({});
                 await devDb.collection(colName).insertMany(data);
                 console.log(`Copied ${count} records for ${colName}`);
             }
        }

        console.log("Data refresh complete!");
    } catch (err) {
        console.error("Refresh failed:", err);
        process.exit(1);
    } finally {
        await prodClient.close();
        await devClient.close();
    }
}

anonymize();
