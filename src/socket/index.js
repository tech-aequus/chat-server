// socket/index.js
import cookie from "cookie";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { AvailableChatEvents, ChatEventEnum } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { redisPub, redisSub } from "../utils/redisClient.js";
import { cleanupRedisForChat } from "../utils/redisCleanup.js";
import { PrismaClient } from "@prisma/client";

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

    console.log("🔑 [SOCKET] Token received:", token);

    if (!token) {
      console.error("❌ [SOCKET] No token found. Disconnecting socket.");
      socket.emit("socketError", "Authentication failed: No token found");
      return socket.disconnect(true);
    }

    try {
      const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

      console.log("✅ [SOCKET] Token decoded:", decodedToken);

      const user = await prisma.user.findUnique({
        where: { id: decodedToken?.id },
        select: { id: true, name: true, email: true },
      });

      console.log("User fetched from DB:", user);
      if (!user) {
        console.error("❌ [SOCKET] Invalid user from token. Disconnecting.");
        socket.emit("socketError", "Authentication failed: Invalid user");
        return socket.disconnect(true);
      }
      console.log("user here", user);

      socket.user = user;
      socket.join(user.id.toString());

      console.log(
        `🎉 [SOCKET] User connected: ${user.id} (Socket ID: ${socket.id})`
      );

      socket.emit("connected"); // Ensure event matches frontend

      // Redis Subscription Logging
      const redisChannel = `user:${user.id}`;
      if (!activeRedisSubscriptions.has(redisChannel)) {
        await redisSub.subscribe(redisChannel);
        activeRedisSubscriptions.add(redisChannel);
        console.log(`📡 [REDIS] Subscribed to channel: ${redisChannel}`);
      }

      // Socket Events
      socket.on(ChatEventEnum.JOIN_CHAT_EVENT, (chatId) => {
        console.log(`📥 [SOCKET] User ${user.id} joined chat ${chatId}`);
        socket.join(chatId);
      });

      socket.on(ChatEventEnum.TYPING_EVENT, (chatId) => {
        console.log(
          `💬 [SOCKET] Typing event in chat ${chatId} by user ${user.id}`
        );
        io.to(chatId).emit(ChatEventEnum.TYPING_EVENT, chatId);
      });

      socket.on(ChatEventEnum.STOP_TYPING_EVENT, (chatId) => {
        console.log(
          `✋ [SOCKET] Stop typing in chat ${chatId} by user ${user.id}`
        );
        io.to(chatId).emit(ChatEventEnum.STOP_TYPING_EVENT, chatId);
      });

      socket.on(
        ChatEventEnum.MESSAGE_RECEIVED_EVENT,
        async ({ chatId, message }) => {
          console.log(
            `📨 [SOCKET] Message received from user ${user.id} for chat ${chatId}`
          );
          await redisPub.publish(
            `chat:${chatId}`,
            JSON.stringify({
              event: ChatEventEnum.MESSAGE_RECEIVED_EVENT,
              data: { senderId: user.id, message },
            })
          );
          console.log(`📡 [REDIS] Message published to chat:${chatId}`);
        }
      );

      // Use the built-in 'disconnect' event
      socket.on("disconnect", async (reason) => {
        console.log(socket);
        if (!socket.user) {
          console.warn(
            `⚠️ [SOCKET] Unauthenticated socket disconnected (reason: ${reason})`
          );
          return;
        }

        const userId = socket.user.id;
        console.log(
          `⚡ [SOCKET] User disconnected: ${userId} (reason: ${reason})`
        );

        for (const room of socket.rooms) {
          if (room !== userId.toString()) {
            console.log(`🧹 Cleaning up Redis for chat room: ${room}`);
            await cleanupRedisForChat(room);
          }
        }

        socket.leave(userId.toString());
      });
    } catch (error) {
      console.error("❌ [SOCKET ERROR]", error?.message || error);
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
