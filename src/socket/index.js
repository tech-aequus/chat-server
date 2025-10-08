// socket/index.js
import cookie from "cookie";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { AvailableChatEvents, ChatEventEnum } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { redisPub, redisSub } from "../utils/redisClient.js";
import { cleanupRedisForChat } from "../utils/redisCleanup.js";
import { PrismaClient } from "@prisma/client";
import logger from "../logger/winston.logger.js";

const activeRedisSubscriptions = new Set();
const prisma = new PrismaClient();
const globalRedisListener = (io) => {
  redisSub.on("message", (channel, message) => {
    const parsedMessage = JSON.parse(message);
    if (channel.startsWith("chat:")) {
      const chatId = channel.split(":")[1];
      io.to(chatId).emit(parsedMessage.event, parsedMessage.data);
    } else if (channel.startsWith("user:")) {
      const userId = channel.split(":")[1];
      io.to(userId).emit(parsedMessage.event, parsedMessage.data);
    }
  });
};

const initializeSocketIO = (io) => {
  globalRedisListener(io);

  io.on("connection", async (socket) => {
    const cookies = cookie.parse(socket.handshake.headers?.cookie || "");
    let token = cookies?.accessToken || socket.handshake.auth?.token;

    if (!token) {
      logger.error("Socket authentication failed: No token found");
      socket.emit("socketError", "Authentication failed: No token found");
      return socket.disconnect(true);
    }

    try {
      const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

      const user = await prisma.user.findUnique({
        where: { id: decodedToken?.id },
        select: { id: true, name: true, email: true },
      });

      logger.info("User fetched from DB:", user);
      if (!user) {
        logger.error("Socket authentication failed: Invalid user from token");
        socket.emit("socketError", "Authentication failed: Invalid token");
        return socket.disconnect(true);
      }

      logger.info("user here", user);

      socket.user = user;
      socket.join(user.id.toString());

      logger.info(
        `Socket connected - User: ${user.id}, Socket ID: ${socket.id}`
      );

      socket.emit("connected"); // Ensure event matches frontend

      // Redis Subscription Logging
      const redisChannel = `user:${user.id}`;
      if (!activeRedisSubscriptions.has(redisChannel)) {
        await redisSub.subscribe(redisChannel);
        activeRedisSubscriptions.add(redisChannel);
        logger.debug(`Redis subscribed to channel: ${redisChannel}`);
      }

      // Socket Events
      socket.on(ChatEventEnum.JOIN_CHAT_EVENT, (chatId) => {
        logger.debug(`User ${user.id} joined chat ${chatId}`);
        socket.join(chatId);
      });

      socket.on(ChatEventEnum.TYPING_EVENT, (chatId) => {
        logger.debug(`Typing event in chat ${chatId} by user ${user.id}`);
        io.to(chatId).emit(ChatEventEnum.TYPING_EVENT, {
          chatId,
          senderId: user.id,
        });
      });

      socket.on(ChatEventEnum.STOP_TYPING_EVENT, (chatId) => {
        logger.debug(`Stop typing in chat ${chatId} by user ${user.id}`);
        io.to(chatId).emit(ChatEventEnum.STOP_TYPING_EVENT, {
          chatId,
          senderId: user.id,
        });
      });

      socket.on(
        ChatEventEnum.MESSAGE_RECEIVED_EVENT,
        async ({ chatId, message }) => {
          logger.debug(
            `Message received from user ${user.id} for chat ${chatId}`
          );
          await redisPub.publish(
            `chat:${chatId}`,
            JSON.stringify({
              event: ChatEventEnum.MESSAGE_RECEIVED_EVENT,
              data: message,
            })
          );
          logger.debug(`Message published to Redis chat:${chatId}`);
        }
      );

      // Use the built-in 'disconnect' event
      socket.on("disconnect", async (reason) => {
        if (!socket.user) {
          logger.warn(
            `Unauthenticated socket disconnected (reason: ${reason})`
          );
          return;
        }

        const userId = socket.user.id;
        logger.info(`User disconnected: ${userId} (reason: ${reason})`);

        for (const room of socket.rooms) {
          if (room !== userId.toString()) {
            logger.debug(`Cleaning up Redis for chat room: ${room}`);
            await cleanupRedisForChat(room);
          }
        }

        socket.leave(userId.toString());
      });
    } catch (error) {
      logger.error("Socket authentication error:", error?.message || error);
      socket.emit(
        "socketError",
        error?.message || "Socket authentication failed"
      );
      socket.disconnect(true);
    }
  });
};

const emitSocketEvent = (req, roomId, event, payload) => {
  req.app.get("io").to(roomId).emit(event, payload);
};

export { initializeSocketIO, emitSocketEvent };
