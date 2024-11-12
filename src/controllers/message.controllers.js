import mongoose from "mongoose";
import { ChatEventEnum } from "../constants.js";
import { Chat } from "../models/chat-app/chat.models.js";
import { ChatMessage } from "../models/chat-app/message.models.js";
import { emitSocketEvent } from "../socket/index.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  getLocalPath,
  getStaticFilePath,
  removeLocalFile,
} from "../utils/helpers.js";
import { redisClient } from "../utils/redisClient.js";

/**
 * @description Utility function which returns the pipeline stages to structure the chat message schema with common lookups
 * @returns {mongoose.PipelineStage[]}
 */
const chatMessageCommonAggregation = () => {
  return [
    {
      $lookup: {
        from: "users",
        foreignField: "_id",
        localField: "sender",
        as: "sender",
        pipeline: [
          {
            $project: {
              username: 1,
              avatar: 1,
              email: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        sender: { $first: "$sender" },
      },
    },
  ];
};

const getAllMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const selectedChat = await Chat.findById(chatId);

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  if (!selectedChat.participants?.includes(req.user?._id)) {
    throw new ApiError(400, "User is not a part of this chat");
  }

  // Fetch recent messages from Redis
  const recentMessages = await redisClient.lrange(
    `chat:${chatId}:messages`,
    0,
    -1
  );
  const parsedRecentMessages = recentMessages.map((msg) => JSON.parse(msg));

  // Get the timestamp of the oldest message in Redis
  const oldestRedisMessageTimestamp =
    parsedRecentMessages.length > 0
      ? new Date(
          parsedRecentMessages[parsedRecentMessages.length - 1].createdAt
        )
      : new Date();

  // Fetch older messages from MongoDB
  const oldMessages = await ChatMessage.find({
    chat: chatId,
    createdAt: { $lt: oldestRedisMessageTimestamp },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  // Combine and sort messages
  const allMessages = [...parsedRecentMessages, ...oldMessages].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  // Remove duplicate messages based on _id
  const uniqueMessages = allMessages.filter(
    (message, index, self) =>
      index ===
      self.findIndex((t) => t._id.toString() === message._id.toString())
  );

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        uniqueMessages || [],
        "Messages fetched successfully"
      )
    );
});

const sendMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content } = req.body;

  // Check if there's either content or files
  if (!content && !req.files?.length) {
    throw new ApiError(400, "Message content or attachment is required");
  }

  const selectedChat = await Chat.findById(chatId);

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  // Process S3 uploaded files
  const attachments = [];
  if (req.files && req.files.length > 0) {
    attachments.push(
      ...req.files.map((file) => ({
        url: file.location, // S3 URL from multer-s3
        key: file.key, // S3 object key
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        bucketName: process.env.AWS_BUCKET_NAME,
      }))
    );
  }

  // Create a new message with attachments
  const message = await ChatMessage.create({
    sender: req.user._id,
    content: content || "",
    chat: chatId,
    attachments,
  });

  // Prepare message for Redis storage
  const messageToStore = {
    _id: message._id,
    sender: message.sender,
    content: message.content,
    attachments: message.attachments,
    chat: message.chat,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };

  // Store in Redis with error handling
  try {
    await redisClient.lpush(
      `chat:${chatId}:messages`,
      JSON.stringify(messageToStore)
    );
    // Set expiration for Redis message (1 hour)
    await redisClient.expire(`chat:${chatId}:messages`, 3600); // 60 minutes * 60 seconds
  } catch (error) {
    console.error("Redis storage error:", error);
    // Continue execution even if Redis fails
  }

  // Update the chat's last message
  const chat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $set: {
        lastMessage: message._id,
      },
    },
    { new: true }
  );

  // Aggregate message with common pipeline
  const messages = await ChatMessage.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    ...chatMessageCommonAggregation(),
  ]);

  const receivedMessage = messages[0];

  if (!receivedMessage) {
    throw new ApiError(500, "Internal server error");
  }

  // Emit socket events to other participants
  chat.participants.forEach((participantObjectId) => {
    if (participantObjectId.toString() === req.user._id.toString()) return;

    emitSocketEvent(
      req,
      participantObjectId.toString(),
      ChatEventEnum.MESSAGE_RECEIVED_EVENT,
      receivedMessage
    );
  });

  return res
    .status(201)
    .json(new ApiResponse(201, receivedMessage, "Message saved successfully"));
});

// Helper function to clean up S3 files in case of error
const cleanupS3Uploads = async (files) => {
  try {
    if (!files || !files.length) return;

    const deletePromises = files.map((file) => {
      return s3
        .deleteObject({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: file.key,
        })
        .promise();
    });

    await Promise.all(deletePromises);
  } catch (error) {
    console.error("S3 cleanup error:", error);
  }
};

// Error handling middleware for the route
const handleMessageError = asyncHandler(async (err, req, res, next) => {
  // Clean up any uploaded files if there's an error
  if (req.files) {
    await cleanupS3Uploads(req.files);
  }
  next(err);
});
const deleteMessage = asyncHandler(async (req, res) => {
  //controller to delete chat messages and attachments

  const { chatId, messageId } = req.params;

  //Find the chat based on chatId and checking if user is a participant of the chat
  const chat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    participants: req.user?._id,
  });

  if (!chat) {
    throw new ApiError(404, "Chat does not exist");
  }

  //Find the message based on message id
  const message = await ChatMessage.findOne({
    _id: new mongoose.Types.ObjectId(messageId),
  });

  if (!message) {
    throw new ApiError(404, "Message does not exist");
  }

  // Check if user is the sender of the message
  if (message.sender.toString() !== req.user._id.toString()) {
    throw new ApiError(
      403,
      "You are not the authorised to delete the message, you are not the sender"
    );
  }
  if (message.attachments.length > 0) {
    //If the message is attachment  remove the attachments from the server
    message.attachments.map((asset) => {
      removeLocalFile(asset.localPath);
    });
  }
  //deleting the message from DB
  await ChatMessage.deleteOne({
    _id: new mongoose.Types.ObjectId(messageId),
  });

  //Updating the last message of the chat to the previous message after deletion if the message deleted was last message
  if (chat.lastMessage.toString() === message._id.toString()) {
    const lastMessage = await ChatMessage.findOne(
      { chat: chatId },
      {},
      { sort: { createdAt: -1 } }
    );

    await Chat.findByIdAndUpdate(chatId, {
      lastMessage: lastMessage ? lastMessage?._id : null,
    });
  }
  // logic to emit socket event about the message deleted  to the other participants
  chat.participants.forEach((participantObjectId) => {
    // here the chat is the raw instance of the chat in which participants is the array of object ids of users
    // avoid emitting event to the user who is deleting the message
    if (participantObjectId.toString() === req.user._id.toString()) return;
    // emit the delete message event to the other participants frontend with delete messageId as the payload
    emitSocketEvent(
      req,
      participantObjectId.toString(),
      ChatEventEnum.MESSAGE_DELETE_EVENT,
      message
    );
  });

  return res
    .status(200)
    .json(new ApiResponse(200, message, "Message deleted successfully"));
});

export { getAllMessages, sendMessage, deleteMessage, handleMessageError };
