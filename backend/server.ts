import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import userRoutes from "./routes/userRoutes";
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error(err));
app.listen(5000, () => console.log("Server running on port 5000"));

app.use("/api/users", userRoutes);

