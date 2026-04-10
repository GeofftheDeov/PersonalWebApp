import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const contactSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: false },
    password: { type: String, required: false },
    isVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    phone: String,
    handle: String,
    role: String,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
    userNumber: String,
    userDigit: String,
    notes: String,
    sfID: String,
    createdAt: { type: Date, default: Date.now },
});

contactSchema.pre("save", async function() {
    // Generate IDs if missing
    if (!this.userNumber) {
        this.userNumber = Math.floor(1000 + Math.random() * 9000).toString();
    }
    if (!this.userDigit) {
        this.userDigit = "CON-" + Date.now();
    }

    if (!this.isModified("password") || !this.password) return;
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    } catch (err: any) {
        throw err;
    }
});

const Contact = mongoose.model("Contact", contactSchema);
export default Contact;
