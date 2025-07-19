import { PrismaClient } from "@prisma/client";
import { redisClient } from "./redisClient.js";

const prisma = new PrismaClient();

/**
 * Fetch chat participant IDs from Redis cache.
 * Falls back to DB if cache miss, then updates Redis.
 * @param {string} chatId
 * @returns {Promise<string[]>} participant IDs
 */
export const getChatParticipantIds = async (chatId) => {
  console.log("Fetching participant IDs for chat:", chatId);
  const cacheKey = `chat:${chatId}:participants`;

  let cached = await redisClient.get(cacheKey);

  console.log("Cached participant IDs:", cached);

  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: Fetch from DB
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: {
      participants: {
        select: { id: true },
      },
    },
  });

  if (!chat) throw new Error(`Chat not found for ID ${chatId}`);

  const participantIds = chat.participants.map((user) => user.id);

  // Cache result for next time (fixed syntax)
  await redisClient.set(cacheKey, JSON.stringify(participantIds), "EX", 3600);

  return participantIds;
};

/**
 * Updates Redis cache with participant IDs
 * @param {string} chatId
 * @param {string[]} participantIds
 */
export const updateChatParticipantCache = async (chatId, participantIds) => {
  const cacheKey = `chat:${chatId}:participants`;
  console.log("Updating participant cache for chat:", chatId, participantIds);

  // Fixed syntax
  await redisClient.set(cacheKey, JSON.stringify(participantIds), "EX", 3600);
};
