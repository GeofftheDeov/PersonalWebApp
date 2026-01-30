import mongoose from "mongoose";
const contactSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: String,
    phone: String,
    role: String,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
    notes: String,
    createdAt: { type: Date, default: Date.now },
});
const Contact = mongoose.model("Contact", contactSchema);
export default Contact;
