import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const contactSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String, required: false },
    isVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    phone: String,
    role: String,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
    notes: String,
    createdAt: { type: Date, default: Date.now },
});

contactSchema.pre("save", async function() {
    const self = this as any;
    if (!self.isModified("password") || !self.password) return;
    try {
        const salt = await bcrypt.genSalt(10);
        self.password = await bcrypt.hash(self.password, salt);
    } catch (err: any) {
        throw err;
    }
});

const Contact = mongoose.model("Contact", contactSchema);
export default Contact;
