// socket/index.js
import cookie from "cookie";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { AvailableChatEvents, ChatEventEnum } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { redisPub, redisSub } from "../utils/redisClient.js";
import { cleanupRedisForChat } from "../utils/redisCleanup.js";

const activeRedisSubscriptions = new Set();

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

const initializeSocketIO = (io, prisma) => {
  globalRedisListener(io);

  io.on("connection", async (socket) => {
    const cookies = cookie.parse(socket.handshake.headers?.cookie || "");
    let token = cookies?.accessToken || socket.handshake.auth?.token;
    if (!token) return socket.disconnect(true);

    try {
      const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decodedToken?.id },
        select: { id: true, name: true, email: true },
      });

      if (!user) throw new ApiError(401, "Invalid user");

      socket.user = user;
      socket.join(user.id.toString());
      socket.emit(ChatEventEnum.CONNECTED_EVENT);
      console.log("User connected:", user.id);

      // Subscribe user Redis channel if not already
      const redisChannel = `user:${user.id}`;
      if (!activeRedisSubscriptions.has(redisChannel)) {
        await redisSub.subscribe(redisChannel);
        activeRedisSubscriptions.add(redisChannel);
      }

      socket.on(ChatEventEnum.JOIN_CHAT_EVENT, (chatId) => socket.join(chatId));
      socket.on(ChatEventEnum.TYPING_EVENT, (chatId) =>
        io.to(chatId).emit(ChatEventEnum.TYPING_EVENT, chatId)
      );
      socket.on(ChatEventEnum.STOP_TYPING_EVENT, (chatId) =>
        io.to(chatId).emit(ChatEventEnum.STOP_TYPING_EVENT, chatId)
      );

      socket.on(
        ChatEventEnum.MESSAGE_RECEIVED_EVENT,
        async ({ chatId, message }) => {
          await redisPub.publish(
            `chat:${chatId}`,
            JSON.stringify({
              event: ChatEventEnum.MESSAGE_RECEIVED_EVENT,
              data: { senderId: user.id, message },
            })
          );
        }
      );

      socket.on(ChatEventEnum.DISCONNECT_EVENT, async () => {
        console.log("User disconnected:", socket.user.id);
        socket.rooms.forEach(async (room) => {
          if (room !== user.id.toString()) await cleanupRedisForChat(room);
        });
        socket.leave(user.id.toString());
      });
    } catch (error) {
      socket.emit(
        ChatEventEnum.SOCKET_ERROR_EVENT,
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
