import jsforce from "jsforce";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import fs from "fs";

dotenv.config();

const { SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_TOKEN, SF_CLIENT_ID, SF_PRIVATE_KEY_PATH } = process.env;

// Initialize connection placeholder
let conn = new jsforce.Connection({
    loginUrl: SF_LOGIN_URL || "https://login.salesforce.com"
});

let isLoggedIn = false;

export const loginToSalesforce = async () => {
    if (isLoggedIn) return;

    // 1. Try JWT Auth
    if (SF_CLIENT_ID && SF_USERNAME && SF_PRIVATE_KEY_PATH) {
        try {
            console.log("Attempting Salesforce JWT Auth...");
            const privateKey = fs.readFileSync(SF_PRIVATE_KEY_PATH, "utf8");

            const payload = {
                iss: SF_CLIENT_ID,
                sub: SF_USERNAME,
                aud: SF_LOGIN_URL || "https://login.salesforce.com",
                exp: Math.floor(Date.now() / 1000) + (3 * 60) // 3 minutes exp
            };

            const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });

            const body = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: token
            });

            const response = await fetch(`${SF_LOGIN_URL || "https://login.salesforce.com"}/services/oauth2/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Salesforce Token Request Failed: ${response.status} ${errorText}`);
            }

            const data = await response.json() as { access_token: string, instance_url: string };

            conn = new jsforce.Connection({
                instanceUrl: data.instance_url,
                accessToken: data.access_token
            });

            isLoggedIn = true;
            isLoggedIn = true;
            console.log(`Connected to Salesforce via JWT. Instance: ${conn.instanceUrl}, Version: ${conn.version}`);
            return;
        } catch (err: any) {
            console.log("JWT_ERROR: " + JSON.stringify(err.message || err));
        }
    }

    // 2. Fallback to Password Auth
    if (!SF_USERNAME || !SF_PASSWORD) {
        console.log("SKIP_LOGIN: Credentials missing");
        return;
    }
    try {
        await conn.login(SF_USERNAME, SF_PASSWORD + (SF_TOKEN || ""));
        isLoggedIn = true;
        console.log("CONNECTED_PASSWORD");
    } catch (err: any) {
        console.log("PASSWORD_LOGIN_ERROR: " + JSON.stringify(err.message || err));
    }
};

export const createLeadFromAccount = async (account: any) => {
    await loginToSalesforce();
    if (!isLoggedIn) {
        console.warn("Not logged in to Salesforce. Skipping Lead creation.");
        return;
    }

    try {
        // Map Account fields to Lead fields
        // Note: Lead requires Company and LastName (usually). 
        // We'll use account name for Company and Last Name.
        const ret = await conn.sobject("Lead").create({
            Company: account.name,
            LastName: account.name, // Required field fallback
            Email: account.email || undefined,
            Status: "Open - Not Contacted",
            LeadSource: "Web App"
        });

        if (ret.success) {
            console.log(`Created Lead in Salesforce with ID: ${ret.id}`);
            return ret.id;
        } else {
            console.error(`Failed to create Lead: ${JSON.stringify(ret.errors)}`);
        }
    } catch (err) {
        console.error("Error creating Salesforce Lead:", err);
    }
};
