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
import { uploadToS3, deleteFromS3 } from "../utils/s3utils.js";

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

  if (!content && !req.files?.attachments?.length) {
    throw new ApiError(400, "Message content or attachment is required");
  }

  const selectedChat = await Chat.findById(chatId);

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  const messageFiles = [];

  if (req.files && req.files.attachments?.length > 0) {
    // Add better error handling for file uploads
    try {
      const uploadPromises = req.files.attachments.map(async (file) => {
        const key = `chats/${chatId}/messages/${Date.now()}-${file.originalname}`;
        const s3Url = await uploadToS3(file, key);

        return {
          url: s3Url,
          key: key,
          _id: new mongoose.Types.ObjectId(),
        };
      });

      const uploadedFiles = await Promise.all(uploadPromises);
      messageFiles.push(...uploadedFiles);
    } catch (error) {
      console.error("Error uploading files:", error);
      throw new ApiError(500, "Error uploading files to S3");
    }
  }

  // Create message with S3 attachments
  const message = await ChatMessage.create({
    sender: req.user._id,
    content: content || "",
    chat: chatId,
    attachments: messageFiles,
  });
  const messageToStore = {
    _id: message._id,
    sender: message.sender,
    content: message.content,
    attachments: message.attachments,
    chat: message.chat,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };

  await redisClient.lpush(
    `chat:${chatId}:messages`,
    JSON.stringify(messageToStore)
  );

  // Set expiration for Redis message (e.g., 1 hour)
  await redisClient.expire(`chat:${chatId}:messages`, 60);

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
  // structure the message
  const messages = await ChatMessage.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    ...chatMessageCommonAggregation(),
  ]);

  // Store the aggregation result
  const receivedMessage = messages[0];

  if (!receivedMessage) {
    throw new ApiError(500, "Internal server error");
  }

  // logic to emit socket event about the new message created to the other participants
  chat.participants.forEach((participantObjectId) => {
    // here the chat is the raw instance of the chat in which participants is the array of object ids of users
    // avoid emitting event to the user who is sending the message
    if (participantObjectId.toString() === req.user._id.toString()) return;

    // emit the receive message event to the other participants with received message as the payload
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

const deleteMessage = asyncHandler(async (req, res) => {
  const { chatId, messageId } = req.params;

  const chat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
    participants: req.user?._id,
  });

  if (!chat) {
    throw new ApiError(404, "Chat does not exist");
  }

  const message = await ChatMessage.findOne({
    _id: new mongoose.Types.ObjectId(messageId),
  });

  if (!message) {
    throw new ApiError(404, "Message does not exist");
  }

  if (message.sender.toString() !== req.user._id.toString()) {
    throw new ApiError(403, "You are not authorized to delete the message");
  }

  // Delete attachments from S3
  if (message.attachments.length > 0) {
    const deletePromises = message.attachments.map((asset) =>
      deleteFromS3(asset.key)
    );
    await Promise.all(deletePromises);
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

export { getAllMessages, sendMessage, deleteMessage };
