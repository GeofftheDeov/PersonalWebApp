import mongoose from "mongoose";
const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    phone: String,
    password: String,
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    role: {
        type: String,
        enum: ["user", "admin"],
        default: "user"
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
});
const User = mongoose.model("User", userSchema);
export default User;
