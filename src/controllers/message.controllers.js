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
import { getChatParticipantIds } from "../utils/chatParticpantIds.js";
import crypto from "crypto";

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

  console.log("Fetching messages for chat:", chatId);

  // ✅ Fetch participants via Redis or DB
  const participants = await getChatParticipantIds(chatId);
  console.log("Participants fetched:", participants);
  if (!participants || participants.length === 0) {
    throw new ApiError(404, "Chat does not exist");
  }

  // ✅ Authorization check using cached participants
  if (!participants.includes(req.user.id)) {
    throw new ApiError(400, "User is not a part of this chat");
  }

  // ✅ Fetch recent messages from Redis
  const recentMessages = await redisClient.lrange(
    `chat:${chatId}:messages`,
    0,
    -1
  );
  const parsedRecentMessages = recentMessages.map((msg) => JSON.parse(msg));

  const oldestRedisMessageTimestamp =
    parsedRecentMessages.length > 0
      ? new Date(
          parsedRecentMessages[parsedRecentMessages.length - 1].createdAt
        )
      : new Date();

  // ✅ Fetch older messages from database
  const oldMessages = await prisma.chatMessage.findMany({
    where: {
      chatId,
      createdAt: { lt: oldestRedisMessageTimestamp },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // ✅ Combine and sort messages
  const allMessages = [...parsedRecentMessages, ...oldMessages];
  const sortedMessages = allMessages.sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

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
  const { chatId } = req.params;
  const { content, id, clientMessageId } = req.body;

  if (!content && !req.files?.attachments?.length) {
    throw new ApiError(400, "Message content or attachment is required");
  }

  const participantIds = await getChatParticipantIds(chatId);

  if (!participantIds.includes(req.user.id)) {
    throw new ApiError(403, "You are not part of this chat");
  }

  const messageToStore = {
    id: id ?? crypto.randomUUID(),
    sender: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      image: req.user.image,
    },
    content: content || "",
    attachments: [],
    chatId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // ✅ Immediately emit message to all participants in chat room
  emitSocketEvent(req, chatId, ChatEventEnum.MESSAGE_RECEIVED_EVENT, {
    ...messageToStore,
    clientMessageId,
  });

  // ✅ Immediately respond to sender
  res.status(201).json(new ApiResponse(201, messageToStore, "Message sent"));

  // ⚙️ Background processing (non-blocking)
  (async () => {
    try {
      // Cache message in Redis (latest 50)
      await Promise.allSettled([
        redisClient.lpush(
          `chat:${chatId}:messages`,
          JSON.stringify(messageToStore)
        ),
        redisClient.ltrim(`chat:${chatId}:messages`, 0, 49),
      ]);

      // Handle attachments (upload to S3)
      if (req.files?.attachments?.length > 0) {
        const attachmentUploads = req.files.attachments.map(async (file) => {
          const key = `chats/${chatId}/messages/${Date.now()}-${file.originalname}`;
          const s3Url = await uploadToS3(file, key);
          return { url: s3Url, key };
        });

        const uploadedAttachments = await Promise.all(attachmentUploads);
        messageToStore.attachments = uploadedAttachments;

        // Optional: Emit update once attachments are uploaded
        emitSocketEvent(
          req,
          chatId,
          ChatEventEnum.MESSAGE_ATTACHMENT_UPDATE_EVENT,
          {
            messageId: messageToStore.id,
            attachments: uploadedAttachments,
          }
        );
      }

      // Save message in DB
      await prisma.chatMessage.create({
        data: {
          id: messageToStore.id,
          senderId: req.user.id,
          content: messageToStore.content,
          chatId,
          createdAt: messageToStore.createdAt,
          updatedAt: messageToStore.updatedAt,
          attachments: {
            create: messageToStore.attachments || [],
          },
        },
      });

      // Update chat's last message
      await prisma.chat.update({
        where: { id: chatId },
        data: { lastMessageId: messageToStore.id },
      });
    } catch (error) {
      console.error("Background error (sendMessage):", error);
    }
  })();
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
