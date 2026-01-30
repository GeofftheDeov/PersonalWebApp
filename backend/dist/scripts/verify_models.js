import mongoose from "mongoose";
import dotenv from "dotenv";
import Account from "../models/Account.js";
import Contact from "../models/Contact.js";
import Lead from "../models/Lead.js";
import Opportunity from "../models/Opportunity.js";
import Task from "../models/Task.js";
dotenv.config();
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/personal_web_app";
const verifyModels = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB for verification.");
        // Create Account
        const account = new Account({
            name: "Acme Corp",
            industry: "Technology",
            website: "https://acme.com",
            phone: "555-0100",
            address: "123 Tech Lane"
        });
        const savedAccount = await account.save();
        console.log(`Saved Account: ${savedAccount.name}`);
        // Create Contact linked to Account
        const contact = new Contact({
            name: "Alice Smith",
            email: "alice@acme.com",
            phone: "555-0101",
            role: "CTO",
            accountId: savedAccount._id,
            notes: "Key decision maker"
        });
        const savedContact = await contact.save();
        console.log(`Saved Contact: ${savedContact.name}`);
        // Create Lead
        const lead = new Lead({
            firstName: "Bob",
            lastName: "Jones",
            email: "bob@startup.io",
            password: "password123",
            company: "StartupIO",
            status: "New",
            source: "Web"
        });
        const savedLead = await lead.save();
        console.log(`Saved Lead: ${savedLead.firstName} ${savedLead.lastName}`);
        // Create Opportunity linked to Account
        const opportunity = new Opportunity({
            name: "Big Deal 2024",
            amount: 50000,
            stage: "Probe",
            closeDate: new Date("2024-12-31"),
            accountId: savedAccount._id
        });
        const savedOpp = await opportunity.save();
        console.log(`Saved Opportunity: ${savedOpp.name}`);
        // Create Task
        const task = new Task({
            title: "Follow up with Alice",
            description: "Discuss contract terms",
            status: "Not Started",
            dueDate: new Date("2024-01-15")
        });
        const savedTask = await task.save();
        console.log(`Saved Task: ${savedTask.title}`);
        // Cleanup
        await Account.findByIdAndDelete(savedAccount._id);
        await Contact.findByIdAndDelete(savedContact._id);
        await Lead.findByIdAndDelete(savedLead._id);
        await Opportunity.findByIdAndDelete(savedOpp._id);
        await Task.findByIdAndDelete(savedTask._id);
        console.log("Cleanup completed.");
        console.log("All models verified successfully!");
        process.exit(0);
    }
    catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
    }
};
verifyModels();
