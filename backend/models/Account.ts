import mongoose from "mongoose";
import { createLeadFromAccount } from "../services/salesforceService.js";

const accountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    industry: String,
    website: String,
    phone: String,
    address: String,
    createdAt: { type: Date, default: Date.now },
});

accountSchema.post("save", async function (doc) {
    console.log("Account saved, syncing to Salesforce...");
    await createLeadFromAccount(doc);
});

const Account = mongoose.model("Account", accountSchema);
export default Account;
