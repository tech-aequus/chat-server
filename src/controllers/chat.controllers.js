import { ChatEventEnum } from "../constants.js";
import { emitSocketEvent } from "../socket/index.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { updateChatParticipantCache } from "../utils/chatParticpantIds.js";
import { removeLocalFile } from "../utils/helpers.js";
import { PrismaClient } from "@prisma/client";
import { redisClient } from "../utils/redisClient.js";

const prisma = new PrismaClient();

//working fine
const isEmailRegistered = async (email) => {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    return !!user; // Return true if user exists, false otherwise
  } catch (error) {
    logger.error("Error checking email registration:", error);
    return false;
  }
};

//working fine
const deleteCascadeChatMessages = async (chatId) => {
  // Fetch the messages associated with the chat
  const messages = await prisma.chatMessage.findMany({
    where: { chatId },
    select: {
      id: true,
      attachments: true, // Select only the attachments field
    },
  });

  let attachments = [];

  // Get the attachments present in the messages
  attachments = attachments.concat(
    ...messages.map((message) => message.attachments)
  );

  // Remove attachment files from the local storage
  attachments.forEach((attachment) => {
    if (attachment.localPath) {
      removeLocalFile(attachment.localPath);
    } else {
      logger.warn("Attachment missing localPath:", attachment);
    }
  });

  const messageIds = messages.map((message) => message.id).filter(Boolean); // Filter out undefined values
  await prisma.messageAttachment.deleteMany({
    where: {
      id: {
        in: messageIds,
      },
    },
  });

  await prisma.messageAttachment.deleteMany({
    where: {
      messageId: { in: messageIds },
    },
  });

  // Delete all the messages
  await prisma.chatMessage.deleteMany({
    where: { chatId },
  });
};

//working fine
const searchAvailableUsers = asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    where: {
      id: {
        not: req.user.id, // Exclude the logged-in user
      },
    },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, users, "Users fetched successfully"));
});

//working fine
const createOrGetAOneOnOneChat = asyncHandler(async (req, res) => {
  const { receiverId } = req.params;

  // Check if it's a valid receiver
  const receiver = await prisma.user.findUnique({
    where: { id: receiverId },
  });

  if (!receiver) {
    throw new ApiError(404, "Receiver does not exist");
  }

  // Check if receiver is not the user who is requesting a chat
  if (receiver.id === req.user.id) {
    throw new ApiError(400, "You cannot chat with yourself");
  }

  // Check if a one-on-one chat already exists
  const existingChat = await prisma.chat.findFirst({
    where: {
      isGroupChat: false,
      participants: {
        every: {
          id: {
            in: [req.user.id, receiverId],
          },
        },
      },
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          image: true,
          email: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              image: true,
              email: true,
            },
          },
        },
      },
    },
  });

  if (existingChat) {
    // If the chat exists, return it
    return res
      .status(200)
      .json(new ApiResponse(200, existingChat, "Chat retrieved successfully"));
  }

  // If no chat exists, create a new one
  const newChat = await prisma.chat.create({
    data: {
      name: "One on one chat",
      isGroupChat: false,
      participants: {
        connect: [{ id: req.user.id }, { id: receiverId }],
      },
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          image: true,
          email: true,
        },
      },
    },
  });

  // Emit socket event about the new chat added to the participants
  newChat.participants.forEach((participant) => {
    if (participant.id === req.user.id) return; // Skip the creator
    emitSocketEvent(req, participant.id, ChatEventEnum.NEW_CHAT_EVENT, newChat);
  });

  return res
    .status(201)
    .json(new ApiResponse(201, newChat, "Chat created successfully"));
});

//working fine

const createAGroupChat = asyncHandler(async (req, res) => {
  const { name, participants } = req.body;

  if (participants.includes(req.user.id)) {
    throw new ApiError(
      400,
      "Participants array should not contain the group creator"
    );
  }

  const members = [...new Set([...participants, req.user.id])];

  if (members.length < 3) {
    throw new ApiError(
      400,
      "A group chat must have at least 3 unique participants, including the creator."
    );
  }

  try {
    const groupChat = await prisma.chat.create({
      data: {
        name,
        isGroupChat: true,
        participants: {
          connect: members.map((id) => ({ id })),
        },
        adminId: req.user.id,
      },
      include: {
        participants: {
          select: {
            id: true,
            name: true,
            image: true,
            email: true,
          },
        },
      },
    });

    // Cache participant IDs
    const participantIds = groupChat.participants.map((p) => p.id);
    await updateChatParticipantCache(groupChat.id, participantIds);

    // Emit socket events using cached IDs
    participantIds.forEach((participantId) => {
      if (participantId === req.user.id) return;
      emitSocketEvent(
        req,
        participantId,
        ChatEventEnum.NEW_CHAT_EVENT,
        groupChat
      );
    });

    return res
      .status(201)
      .json(new ApiResponse(201, groupChat, "Group chat created successfully"));
  } catch (error) {
    logger.error("Error creating group chat:", error);
    throw new ApiError(500, "Failed to create group chat");
  }
});

const createAFactionGroupChat = asyncHandler(async (req, res) => {
  const { name, factionId } = req.body;

  const members = [req.user.id]; // Assuming only the creator is added for now

  try {
    // Create a faction group chat
    const groupChat = await prisma.chat.create({
      data: {
        name,
        isGroupChat: true,
        participants: {
          connect: members.map((id) => ({ id })), // Connect participants
        },
        admin: {
          connect: { id: req.user.id },
        },
        faction: {
          connect: { id: factionId },
        },
        factionId: factionId,
      },
      include: {
        participants: {
          select: {
            id: true,
            name: true,
            image: true,
            email: true,
          },
        },
      },
    });

    // ⚡️ Update Redis participant cache
    const participantIds = groupChat.participants.map((p) => p.id);
    await updateChatParticipantCache(groupChat.id, participantIds);

    // Emit socket events to participants (optional here)
    groupChat.participants.forEach((participant) => {
      if (participant.id === req.user.id) return;
      emitSocketEvent(
        req,
        participant.id,
        ChatEventEnum.NEW_CHAT_EVENT,
        groupChat
      );
    });

    return res
      .status(201)
      .json(new ApiResponse(201, groupChat, "Group chat created successfully"));
  } catch (error) {
    logger.error("Error creating faction group chat:", error);
    throw new ApiError(500, "Failed to create faction group chat");
  }
});

//working fine
const getGroupChatDetails = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  // Fetch the group chat details
  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
      admin: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, groupChat, "Group chat fetched successfully"));
});

//working fine
const renameGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { name } = req.body;

  // Check for chat existence
  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      admin: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  // Only admin can change the name
  if (groupChat.admin.id !== req.user.id) {
    throw new ApiError(403, "You are not an admin");
  }

  // Update the group chat name
  const updatedGroupChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      name,
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
  });

  if (!updatedGroupChat) {
    throw new ApiError(500, "Failed to update the group chat name");
  }

  // Emit socket event about the updated chat name to the participants
  updatedGroupChat.participants.forEach((participant) => {
    emitSocketEvent(
      req,
      participant.id,
      ChatEventEnum.UPDATE_GROUP_NAME_EVENT,
      updatedGroupChat
    );
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        updatedGroupChat,
        "Group chat name updated successfully"
      )
    );
});

//working fine
const deleteGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: { id: true },
      },
      admin: {
        select: { id: true },
      },
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  if (groupChat.admin.id !== req.user.id) {
    throw new ApiError(403, "Only admin can delete the group");
  }

  await prisma.chat.delete({ where: { id: chatId } });
  await deleteCascadeChatMessages(chatId);
  await prisma.message.deleteMany({ where: { chatId } });

  // ⚡ Clear Redis Cache
  await redisClient.del(`chat:${chatId}:participants`);

  // Notify participants (except the admin)
  groupChat.participants.forEach((participant) => {
    if (participant.id === req.user.id) return;
    emitSocketEvent(
      req,
      participant.id,
      ChatEventEnum.LEAVE_CHAT_EVENT,
      groupChat
    );
  });

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Group chat deleted successfully"));
});
//working fine
const deleteOneOnOneChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: {
        select: { id: true },
      },
    },
  });

  if (!chat || chat.isGroupChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  await deleteCascadeChatMessages(chatId);

  await prisma.chat.delete({ where: { id: chatId } });
  await prisma.message.deleteMany({ where: { chatId } });

  // ⚡ Clear Redis Cache
  await redisClient.del(`chat:${chatId}:participants`);

  const otherParticipant = chat.participants.find(
    (participant) => participant.id !== req.user.id
  );

  if (otherParticipant) {
    emitSocketEvent(
      req,
      otherParticipant.id,
      ChatEventEnum.LEAVE_CHAT_EVENT,
      chat
    );
  }

  return res
    .status(200)
    .json(new ApiResponse(200, {}, "Chat deleted successfully"));
});

//
const leaveGroupChat = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  // Check if the chat is a group chat
  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: true,
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  // Check if the user is part of the group
  const isParticipant = groupChat.participants.some(
    (participant) => participant.id === req.user.id
  );

  if (!isParticipant) {
    throw new ApiError(400, "You are not a part of this group chat");
  }

  // Remove the user from the group chat
  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      participants: {
        disconnect: { id: req.user.id },
      },
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
    },
  });

  if (!updatedChat) {
    throw new ApiError(500, "Failed to leave the group chat");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, updatedChat, "Left the group successfully"));
});

//working fine
const addNewParticipantInGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: true,
      admin: true,
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  if (groupChat.adminId !== req.user.id) {
    throw new ApiError(403, "You are not an admin");
  }

  const isParticipant = groupChat.participants.some(
    (participant) => participant.id === participantId
  );

  if (isParticipant) {
    throw new ApiError(409, "Participant already in the group chat");
  }

  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      participants: {
        connect: { id: participantId },
      },
    },
    include: {
      participants: {
        select: {
          id: true,
        },
      },
    },
  });

  // ⚡ Update Redis Cache
  const participantIds = updatedChat.participants.map((p) => p.id);
  await updateChatParticipantCache(chatId, participantIds);

  emitSocketEvent(
    req,
    participantId,
    ChatEventEnum.NEW_CHAT_EVENT,
    updatedChat
  );

  return res
    .status(200)
    .json(new ApiResponse(200, updatedChat, "Participant added successfully"));
});

//working fine
const removeParticipantFromGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: true,
      admin: true,
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  if (groupChat.adminId !== req.user.id) {
    throw new ApiError(403, "You are not an admin");
  }

  const isParticipant = groupChat.participants.some(
    (participant) => participant.id === participantId
  );

  if (!isParticipant) {
    throw new ApiError(400, "Participant does not exist in the group chat");
  }

  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      participants: {
        disconnect: { id: participantId },
      },
    },
    include: {
      participants: {
        select: {
          id: true,
        },
      },
    },
  });

  // ⚡ Update Redis Cache
  const participantIds = updatedChat.participants.map((p) => p.id);
  await updateChatParticipantCache(chatId, participantIds);

  emitSocketEvent(
    req,
    participantId,
    ChatEventEnum.LEAVE_CHAT_EVENT,
    updatedChat
  );

  return res
    .status(200)
    .json(
      new ApiResponse(200, updatedChat, "Participant removed successfully")
    );
});

//working fine
const getAllChats = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const chats = await prisma.chat.findMany({
    where: {
      participants: {
        some: {
          id: userId,
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
          attachments: true,
        },
      },
      admin: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return res
    .status(200)
    .json(
      new ApiResponse(200, chats || [], "User chats fetched successfully!")
    );
});
const getChat = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const chatId = req.params.chatId;

  const chat = await prisma.chat.findUnique({
    where: {
      id: chatId,
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
      admin: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  // If chat doesn't exist
  if (!chat) {
    return res.status(404).json(new ApiResponse(404, null, "Chat not found"));
  }

  // Check if user is a participant
  const isParticipant = chat.participants.some(
    (participant) => participant.id === userId
  );

  if (!isParticipant) {
    return res
      .status(403)
      .json(
        new ApiResponse(
          403,
          null,
          "Access denied: You are not a participant in this chat"
        )
      );
  }

  // Optionally remove participant IDs before returning the chat
  return res
    .status(200)
    .json(new ApiResponse(200, chat, "User chat fetched successfully!"));
});

const addNewFactionMemberToGroupChat = asyncHandler(async (req, res) => {
  const { chatId, participantId } = req.params;

  // Check if the chat is a group chat
  const groupChat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      participants: true,
      admin: true,
    },
  });

  if (!groupChat || !groupChat.isGroupChat) {
    throw new ApiError(404, "Group chat does not exist");
  }

  // Check if the participant is already in the group
  const isParticipant = groupChat.participants.some(
    (participant) => participant.id === participantId
  );

  if (isParticipant) {
    throw new ApiError(409, "Participant already in the group chat");
  }

  // Add the participant to the group chat
  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: {
      participants: {
        connect: { id: participantId },
      },
    },
    include: {
      participants: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
      lastMessage: {
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
    },
  });

  if (!updatedChat) {
    throw new ApiError(500, "Failed to update the group chat");
  }

  // Emit new chat event to the added participant
  emitSocketEvent(
    req,
    participantId,
    ChatEventEnum.NEW_CHAT_EVENT,
    updatedChat
  );

  return res
    .status(200)
    .json(new ApiResponse(200, updatedChat, "Participant added successfully"));
});

export {
  addNewParticipantInGroupChat,
  addNewFactionMemberToGroupChat,
  createAGroupChat,
  createAFactionGroupChat,
  createOrGetAOneOnOneChat,
  deleteGroupChat,
  deleteOneOnOneChat,
  getAllChats,
  getChat,
  getGroupChatDetails,
  leaveGroupChat,
  removeParticipantFromGroupChat,
  renameGroupChat,
  searchAvailableUsers,
  isEmailRegistered,
};
