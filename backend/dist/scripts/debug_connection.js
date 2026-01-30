import { loginToSalesforce } from "../services/salesforceService.js";
import dotenv from "dotenv";
dotenv.config();
const testLogin = async () => {
    console.log("Starting isolated login test...");
    await loginToSalesforce();
    console.log("Login test complete.");
};
testLogin();
