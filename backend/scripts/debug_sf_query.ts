import { loginToSalesforce } from "../services/salesforceService.js";
import jsforce from "jsforce";

// We need to access the 'conn' object from the service, but it's not exported directly.
// Ideally, the service should export the connection or a query method.
// For this debug script, I'll essentially replicate the login logic quickly or modify the service.
// Actually, let's just modify the service to export 'conn' for debugging, OR add a query method.

// Simpler: Just make salesforceService export 'conn'
// But for now, let's just use the existing service and add a 'query' function to it temporarily?
// No, let's copy-paste the login logic here for a standalone test that is 100% reliable diff.

import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import fs from "fs";

dotenv.config();

const { SF_LOGIN_URL, SF_USERNAME, SF_CLIENT_ID, SF_PRIVATE_KEY_PATH } = process.env;

const debugQuery = async () => {
    try {
        console.log("Reading private key...");
        const privateKey = fs.readFileSync(SF_PRIVATE_KEY_PATH!, "utf8");

        const payload = {
            iss: SF_CLIENT_ID,
            sub: SF_USERNAME,
            aud: SF_LOGIN_URL || "https://login.salesforce.com",
            exp: Math.floor(Date.now() / 1000) + (3 * 60)
        };

        const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });

        console.log("Requesting OAuth Token...");
        const response = await fetch(`${SF_LOGIN_URL || "https://login.salesforce.com"}/services/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: token
            })
        });

        if (!response.ok) {
            console.error("Token Request Failed:", await response.text());
            return;
        }

        const data = await response.json() as { access_token: string, instance_url: string };
        console.log(`Got Token! Instance: ${data.instance_url}`);

        const conn = new jsforce.Connection({
            instanceUrl: data.instance_url,
            accessToken: data.access_token
        });

        console.log("Attempting to query User object...");
        const users = await conn.query("SELECT Id, Username FROM User LIMIT 1");
        console.log("User query result:", users);

        console.log("Attempting to query Lead object...");
        const leads = await conn.query("SELECT Id, Name FROM Lead LIMIT 1");
        console.log("Lead query result:", leads);

    } catch (error) {
        console.error("Debug Query Failed:", error);
    }
};

debugQuery();
