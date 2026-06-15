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
    createdAt: { type: Date, default: Date.now },
    // Salesforce sync fields
    sfID: String,
    sfRecordTypeID: String,
    sfRecordTypeName: String,
    sfLastSynced: Date,
    // Notion sync fields
    notionPageId: String,
    notionLastSynced: Date,
    ownerId: String,
    ownerName: String,
});

const Task = mongoose.model("Task", taskSchema);
export default Task;
