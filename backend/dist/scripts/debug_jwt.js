import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
console.log("Checking JWT Config...");
console.log("SF_CLIENT_ID:", process.env.SF_CLIENT_ID ? "PRESENT" : "MISSING");
console.log("SF_USERNAME:", process.env.SF_USERNAME ? "PRESENT" : "MISSING");
console.log("SF_PRIVATE_KEY_PATH:", process.env.SF_PRIVATE_KEY_PATH ? "PRESENT" : "MISSING");
if (process.env.SF_PRIVATE_KEY_PATH) {
    try {
        const keyStats = fs.statSync(process.env.SF_PRIVATE_KEY_PATH);
        console.log(`Private Key File: FOUND (${keyStats.size} bytes)`);
    }
    catch (e) {
        console.log(`Private Key File: NOT FOUND at ${process.env.SF_PRIVATE_KEY_PATH}`);
    }
}
else {
    console.log("Private Key File: Path not set");
}
