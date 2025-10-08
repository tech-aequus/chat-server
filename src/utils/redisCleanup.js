import { redisClient } from "./redisClient.js";
import logger from "../logger/winston.logger.js";

const cleanupRedisForChat = async (chatId) => {
  try {
    // Get all message keys for this chat
    const messageKeys = await redisClient.keys(`chat:${chatId}:messages*`);
    logger.debug(`Redis cleanup for chat: ${chatId}:messages*`);
    if (messageKeys.length > 0) {
      // Delete all message keys for this chat
      await redisClient.del(messageKeys);
      logger.info(
        `Deleted ${messageKeys.length} message keys for chat: ${chatId}`
      );
    } else {
      logger.info(`No message keys found for chat: ${chatId}`);
    }

    // Remove any other chat-related keys (if any)
    const otherChatKeys = await redisClient.keys(`chat:${chatId}:*`);
    if (otherChatKeys.length > 0) {
      await redisClient.del(otherChatKeys);
      logger.info(
        `Deleted ${otherChatKeys.length} other chat-related keys for chat: ${chatId}`
      );
    }

    logger.info(`Redis cleanup completed for chat: ${chatId}`);
  } catch (error) {
    logger.error(`Error cleaning up Redis for chat ${chatId}:`, error);
  }
};

export { cleanupRedisForChat };
