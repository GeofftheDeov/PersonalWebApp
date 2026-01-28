import mongoose from "mongoose";
import { createLeadFromAccount } from "../services/salesforceService.js";

const accountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: false },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    industry: String,
    website: String,
    phone: String,
    address: String,
    createdAt: { type: Date, default: Date.now },
    sfID: String,
    sfRecordTypeID: String,
    sfRecordTypeName: String,
});

accountSchema.post("save", async function (doc) {
    console.log("Account saved, syncing to Salesforce...");
    const sfLeadResponse = await createLeadFromAccount(doc);
    doc.sfID = sfLeadResponse?.id;
    doc.sfRecordTypeID = sfLeadResponse?.recordTypeId;
    doc.sfRecordTypeName = sfLeadResponse?.recordTypeName;
    doc.save();
});

const Account = mongoose.model("Account", accountSchema);
export default Account;
