import mongoose, { Schema } from "mongoose";
const attachmentSchema = new Schema({
  url: {
    type: String,
    required: true,
  },
  key: {
    type: String,
    required: true, // S3 object key
  },
  filename: {
    type: String,
    required: true, // Original filename
  },
  mimeType: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    required: true, // File size in bytes
  },
  bucketName: {
    type: String,
    required: true, // S3 bucket name
  },
});
const chatMessageSchema = new Schema(
  {
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    content: {
      type: String,
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    chat: {
      type: Schema.Types.ObjectId,
      ref: "Chat",
    },
  },
  { timestamps: true }
);

export const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema);
