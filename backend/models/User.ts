import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  handle: String,
  password: {
    type: String,
    required: true
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  isVerified: { type: Boolean, default: false },
  emailVerificationToken: String,
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user"
  },
  userNumber: String,
  userDigit: String,
  sfID: String,
  discordId: String,
  discordHandle: String,
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
});

userSchema.pre("save", async function() {
  // Generate IDs if missing
  if (!this.userNumber) {
    this.userNumber = Math.floor(1000 + Math.random() * 9000).toString();
  }
  if (!this.userDigit) {
    this.userDigit = "ADM-" + Date.now();
  }

  if (!this.isModified("password")) return;
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password as string, salt);
  } catch (err: any) {
    throw err;
  }
});

const User = mongoose.model("User", userSchema);
export default User;