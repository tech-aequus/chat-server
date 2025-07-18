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
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
// /**
//  * @description Utility function which returns the pipeline stages to structure the chat message schema with common lookups
//  * @returns {mongoose.PipelineStage[]}
//  */
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

  // Check if the chat exists and the user is a participant
  const selectedChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: { id: true },
      },
    },
  });

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  const isParticipant = selectedChat.participants.some(
    (participant) => participant.id === req.user.id
  );

  if (!isParticipant) {
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

  // Fetch older messages from the database
  const oldMessages = await prisma.chatMessage.findMany({
    where: {
      chatId: chatId,
      createdAt: {
        lt: oldestRedisMessageTimestamp,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
  });

  // Combine Redis and DB messages
  const allMessages = [...parsedRecentMessages, ...oldMessages];

  // Sort messages from oldest to newest
  const sortedMessages = allMessages.sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  // Remove duplicate messages based on id
  const uniqueMessages = sortedMessages.filter(
    (message, index, self) =>
      index === self.findIndex((t) => t.id === message.id)
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
  try {
    const { chatId } = req.params;
    const { content } = req.body;

    console.log("Received request:", {
      chatId,
      content,
      files: req.files,
    });

    if (!content && !req.files?.attachments?.length) {
      throw new ApiError(400, "Message content or attachment is required");
    }

    // Check if the chat exists
    const selectedChat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: {
          select: { id: true },
        },
      },
    });

    if (!selectedChat) {
      throw new ApiError(404, "Chat does not exist");
    }

    const messageFiles = [];

    // Process and upload attachments to S3
    if (req.files && req.files.attachments?.length > 0) {
      console.log(`Processing ${req.files.attachments.length} files`);

      for (const file of req.files.attachments) {
        try {
          console.log("Processing file:", {
            filename: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
          });

          const key = `chats/${chatId}/messages/${Date.now()}-${file.originalname}`;
          const s3Url = await uploadToS3(file, key);

          console.log("File uploaded successfully:", {
            key,
            url: s3Url,
          });

          messageFiles.push({
            url: s3Url,
            key: key,
          });
        } catch (error) {
          console.error("Error processing individual file:", {
            filename: file.originalname,
            error: error.message,
          });
          throw error;
        }
      }
    }

    console.log("Creating message with files:", messageFiles);
    const messageData = {
      senderId: req.user.id,
      content: content || "",
      chatId: chatId,
    };

    // Add attachments only if there are files
    if (messageFiles.length > 0) {
      messageData.attachments = {
        create: messageFiles,
      };
    }
    console.log("Message data:", messageData);
    // Create the message in the database
    const message = await prisma.chatMessage.create({
      data: messageData,
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        attachments: messageFiles.length > 0,
      },
    });

    console.log("Message created successfully:", message.id);

    // Store the message in Redis
    const messageToStore = {
      id: message.id,
      sender: message.sender,
      content: message.content,
      attachments: message.attachments,
      chatId: message.chatId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };

    await redisClient.lpush(
      `chat:${chatId}:messages`,
      JSON.stringify(messageToStore)
    );

    // Set expiration for Redis message (e.g., 1 hour)
    await redisClient.expire(`chat:${chatId}:messages`, 3600);

    // Update the chat's last message
    await prisma.chat.update({
      where: { id: chatId },
      data: {
        lastMessageId: message.id,
      },
    });

    // Emit socket event about the new message to other participants
    selectedChat.participants.forEach((participant) => {
      if (participant.id === req.user.id) return;

      emitSocketEvent(
        req,
        participant.id,
        ChatEventEnum.MESSAGE_RECEIVED_EVENT,
        messageToStore
      );
    });

    return res
      .status(201)
      .json(new ApiResponse(201, messageToStore, "Message saved successfully"));
  } catch (error) {
    console.error("Controller error:", {
      message: error.message,
      stack: error.stack,
    });
    throw new ApiError(500, `Error uploading files to S3: ${error.message}`);
  }
});

const deleteMessage = asyncHandler(async (req, res) => {
  const { chatId, messageId } = req.params;

  // Check if the chat exists and the user is a participant
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: { id: true },
      },
      lastMessage: {
        select: { id: true },
      },
    },
  });

  if (!chat) {
    throw new ApiError(404, "Chat does not exist");
  }

  const isParticipant = chat.participants.some(
    (participant) => participant.id === req.user.id
  );

  if (!isParticipant) {
    throw new ApiError(
      403,
      "You are not authorized to delete messages in this chat"
    );
  }

  // Check if the message exists
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    include: {
      attachments: true,
    },
  });

  if (!message) {
    throw new ApiError(404, "Message does not exist");
  }

  // Check if the user is the sender of the message
  if (message.senderId !== req.user.id) {
    throw new ApiError(403, "You are not authorized to delete this message");
  }

  // Delete attachments from S3
  if (message.attachments.length > 0) {
    const deletePromises = message.attachments.map((attachment) =>
      deleteFromS3(attachment.key)
    );
    await Promise.all(deletePromises);
  }

  // Delete the message from the database
  await prisma.chatMessage.delete({
    where: { id: messageId },
  });

  // Update the chat's last message if the deleted message was the last message
  if (chat.lastMessage?.id === messageId) {
    const lastMessage = await prisma.chatMessage.findFirst({
      where: { chatId },
      orderBy: { createdAt: "desc" },
    });

    await prisma.chat.update({
      where: { id: chatId },
      data: {
        lastMessageId: lastMessage ? lastMessage.id : null,
      },
    });
  }

  // Emit socket event about the message deletion to other participants
  chat.participants.forEach((participant) => {
    if (participant.id === req.user.id) return;

    emitSocketEvent(req, participant.id, ChatEventEnum.MESSAGE_DELETE_EVENT, {
      messageId,
    });
  });

  return res
    .status(200)
    .json(new ApiResponse(200, { messageId }, "Message deleted successfully"));
});

export { getAllMessages, sendMessage, deleteMessage };
