import mongoose from "mongoose";
import dotenv from "dotenv";
import Account from "../models/Account.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app";

async function inspect() {
    try {
        await mongoose.connect(MONGO_URI);
        const syncedAccounts = await Account.find({ sfID: { $exists: true } }).limit(20);
        
        console.log(`Found ${syncedAccounts.length} synced accounts.`);
        
        syncedAccounts.forEach(acc => {
            console.log(`ID: ${acc._id} | Name: ${acc.name} | Email: "${acc.email}" | sfID: ${acc.sfID}`);
        });

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

inspect();
