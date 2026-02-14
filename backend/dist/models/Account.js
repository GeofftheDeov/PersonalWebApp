import mongoose from "mongoose";
import bcrypt from "bcryptjs";
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
    sfID: String,
    sfRecordTypeID: String,
    sfRecordTypeName: String,
    createdAt: { type: Date, default: Date.now },
});
accountSchema.pre("save", async function () {
    if (!this.isModified("password") || !this.password)
        return;
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }
    catch (err) {
        throw err;
    }
});
accountSchema.post("save", async function (doc) {
    console.log("Account saved, syncing to Salesforce...");
    const sfAccountResponse = await createLeadFromAccount(doc);
    doc.sfID = sfAccountResponse?.id;
    //TODO: Add record type ID and name
    // doc.sfRecordTypeID = sfAccountResponse?.recordTypeId;
    // doc.sfRecordTypeName = sfAccountResponse?.recordTypeName;
    doc.save();
});
// Post-save hook to sync to Salesforce
accountSchema.post("save", async function (doc) {
    // Only sync if this is a new Account (no Salesforce ID yet)
    if (!doc.sfID) {
        console.log("New Account saved, syncing to Salesforce...");
        const sfAccountResponse = await createLeadFromAccount(doc);
        if (sfAccountResponse?.id) {
            // Update without triggering another save hook
            const updateData = {
                sfID: sfAccountResponse.id
            };
            // Add optional fields if they exist
            if (sfAccountResponse.recordTypeId) {
                updateData.sfRecordTypeID = sfAccountResponse.recordTypeId;
            }
            if (sfAccountResponse.recordTypeName) {
                updateData.sfRecordTypeName = sfAccountResponse.recordTypeName;
            }
            await Account.updateOne({ _id: doc._id }, { $set: updateData });
            console.log(`Salesforce Account created with ID: ${sfAccountResponse.id}`);
        }
    }
});
// Post-update hook to sync to Salesforce
accountSchema.post("updateOne", async function (doc) {
    // Only sync if this is a new Account (no Salesforce ID yet)
    if (!doc.sfID) {
        console.log("New Account saved, syncing to Salesforce...");
        const sfAccountResponse = await createLeadFromAccount(doc);
        if (sfAccountResponse?.id) {
            // Update without triggering another save hook
            const updateData = {
                sfID: sfAccountResponse.id
            };
            // Add optional fields if they exist
            if (sfAccountResponse.recordTypeId) {
                updateData.sfRecordTypeID = sfAccountResponse.recordTypeId;
            }
            if (sfAccountResponse.recordTypeName) {
                updateData.sfRecordTypeName = sfAccountResponse.recordTypeName;
            }
            await Account.updateOne({ _id: doc._id }, { $set: updateData });
            console.log(`Salesforce Account created with ID: ${sfAccountResponse.id}`);
        }
    }
});
const Account = mongoose.model("Account", accountSchema);
export default Account;
