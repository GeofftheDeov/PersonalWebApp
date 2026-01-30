import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();
const jwtSecret = process.env.JWT_SECRET || "your-secret-key-change-this";
// Generate a JWT token that doesn't expire (for Salesforce integration)
const token = jwt.sign({
    service: "salesforce",
    purpose: "account-sync"
}, jwtSecret, { expiresIn: "365d" } // 1 year expiration
);
console.log("\n=== JWT Token for Salesforce ===");
console.log(token);
console.log("\nAdd this token to your Salesforce batch class as the JWT_TOKEN constant.");
console.log("================================\n");
// Also write to file
fs.writeFileSync("scripts/jwt_token.txt", token);
console.log("Token also saved to scripts/jwt_token.txt\n");
