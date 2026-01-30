import mongoose from "mongoose";
import { createLeadInSalesforce } from "../services/salesforceService.js";

const leadSchema = new mongoose.Schema({
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: true },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
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

// Post-save hook to sync to Salesforce
leadSchema.post("save", async function (doc) {
    // Only sync if this is a new lead (no Salesforce ID yet)
    if (!doc.sfLeadId) {
        console.log("New Lead saved, syncing to Salesforce...");
        const sfLeadResponse = await createLeadInSalesforce(doc);
        if (sfLeadResponse?.id) {
            // Update without triggering another save hook
            const updateData: any = {
                sfLeadId: sfLeadResponse.id
            };
            
            // Add optional fields if they exist
            if ((sfLeadResponse as any).recordTypeId) {
                updateData.sfRecordTypeId = (sfLeadResponse as any).recordTypeId;
            }
            if ((sfLeadResponse as any).recordTypeName) {
                updateData.sfRecordTypeName = (sfLeadResponse as any).recordTypeName;
            }
            
            await Lead.updateOne(
                { _id: doc._id },
                { $set: updateData }
            );
            console.log(`Salesforce Lead created with ID: ${sfLeadResponse.id}`);
        }
    }
});

// Post-update hook to sync to Salesforce
leadSchema.post("updateOne", async function (doc) {
    // Only sync if this is a new lead (no Salesforce ID yet)
    if (!doc.sfLeadId) {
        console.log("New Lead saved, syncing to Salesforce...");
        const sfLeadResponse = await createLeadInSalesforce(doc);
        if (sfLeadResponse?.id) {
            // Update without triggering another save hook
            const updateData: any = {
                sfLeadId: sfLeadResponse.id
            };
            
            // Add optional fields if they exist
            if ((sfLeadResponse as any).recordTypeId) {
                updateData.sfRecordTypeId = (sfLeadResponse as any).recordTypeId;
            }
            if ((sfLeadResponse as any).recordTypeName) {
                updateData.sfRecordTypeName = (sfLeadResponse as any).recordTypeName;
            }
            
            await Lead.updateOne(
                { _id: doc._id },
                { $set: updateData }
            );
            console.log(`Salesforce Lead created with ID: ${sfLeadResponse.id}`);
        }
    }
});



const Lead = mongoose.model("Lead", leadSchema);
export default Lead;
