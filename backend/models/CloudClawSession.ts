import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ICloudClawSession extends Document {
  userId: mongoose.Types.ObjectId;
  messages: IMessage[];
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>({
  role:    { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },
}, { _id: false });

const CloudClawSessionSchema = new Schema<ICloudClawSession>({
  userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  messages: { type: [MessageSchema], default: [] },
}, { timestamps: true });

export default mongoose.model<ICloudClawSession>('CloudClawSession', CloudClawSessionSchema);
