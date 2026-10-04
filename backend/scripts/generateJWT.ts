import dotenv from "dotenv";
import fs from "fs";
import { signJwt } from "../utils/jwt.js";

dotenv.config();

// Signs with the backend's own JWT_SECRET (#95); refuses if it is unset or the
// old insecure default, since a token signed with that is a token anyone can mint.
let token: string;
try {
    token = signJwt(
        {
            service: "salesforce",
            purpose: "account-sync"
        },
        { expiresIn: "365d" } // 1 year expiration
    );
} catch (err: any) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
}

console.log("\n=== JWT Token for Salesforce ===");
console.log(token);
console.log("\nAdd this token to your Salesforce batch class as the JWT_TOKEN constant.");
console.log("================================\n");

// Also write to file
fs.writeFileSync("scripts/jwt_token.txt", token);
console.log("Token also saved to scripts/jwt_token.txt\n");
