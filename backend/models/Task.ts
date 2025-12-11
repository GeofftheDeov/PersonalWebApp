import mongoose from "mongoose";

const taskSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: String,
    status: {
        type: String,
        enum: ["Not Started", "In Progress", "Completed"],
        default: "Not Started"
    },
    dueDate: Date,
    // Polymorphic reference or just generic related fields? 
    // For simplicity now, let's keep it unlinked or manual until specific requirements allow
    createdAt: { type: Date, default: Date.now },
});

const Task = mongoose.model("Task", taskSchema);
export default Task;
