import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { createLeadInSalesforce } from "../services/salesforceService.js";
const leadSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: true },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    isVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    company: { type: String, required: false },
    phone: String,
    status: {
        type: String,
        enum: ["New", "Contacted", "Qualified", "Lost", "Converted"],
        default: "New"
    },
    source: { type: String, default: "Web App" },
    sfLeadId: String,
    sfRecordTypeId: String,
    sfRecordTypeName: String,
    createdAt: { type: Date, default: Date.now },
});
leadSchema.pre("save", async function () {
    if (!this.isModified("password"))
        return;
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }
    catch (err) {
        throw err;
    }
});
// Post-save hook to sync to Salesforce
leadSchema.post("save", async function (doc) {
    // Only sync if this is a new lead (no Salesforce ID yet)
    if (!doc.sfLeadId) {
        setImmediate(async () => {
            try {
                console.log("[SALESFORCE] New Lead saved, starting background sync...");
                const sfLeadResponse = await createLeadInSalesforce(doc);
                if (sfLeadResponse?.id) {
                    const updateData = { sfLeadId: sfLeadResponse.id };
                    if (sfLeadResponse.recordTypeId)
                        updateData.sfRecordTypeId = sfLeadResponse.recordTypeId;
                    if (sfLeadResponse.recordTypeName)
                        updateData.sfRecordTypeName = sfLeadResponse.recordTypeName;
                    // Use model directly from this context
                    await doc.constructor.updateOne({ _id: doc._id }, { $set: updateData });
                    console.log(`[SALESFORCE] Result: Success (ID: ${sfLeadResponse.id})`);
                }
            }
            catch (err) {
                console.error("[SALESFORCE] Background Sync Error:", err);
            }
        });
    }
});
const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
