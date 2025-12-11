import mongoose from "mongoose";
import dotenv from "dotenv";
import Account from "../models/Account.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app";

const testSync = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB for sync test.");

        // Create Account to trigger sync
        const account = new Account({
            name: "Sync Test Corp",
            industry: "Testing",
            website: "https://synctest.com",
            phone: "555-9999",
            address: " Cloud City"
        });

        console.log("Saving Account - this should trigger Salesforce sync...");
        const savedAccount = await account.save();
        console.log(`Saved Account locally: ${savedAccount.name}`);

        // Wait a moment for any async logs from the service
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Cleanup
        await Account.findByIdAndDelete(savedAccount._id);
        console.log("Cleanup completed.");

        process.exit(0);
    } catch (error) {
        console.error("Test failed:", error);
        process.exit(1);
    }
};

testSync();
