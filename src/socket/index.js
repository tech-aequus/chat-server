import cookie from "cookie";
import jwt from "jsonwebtoken";
import { Server, Socket } from "socket.io";
import { AvailableChatEvents, ChatEventEnum } from "../constants.js";
import { User } from "../models/auth/user.models.js";
import { ApiError } from "../utils/ApiError.js";
import { redisPub, redisSub } from "../utils/redisClient.js";
import { cleanupRedisForChat } from "../utils/redisCleanup.js";

/**
 * @description This function is responsible to allow user to join the chat represented by chatId (chatId). event happens when user switches between the chats
 * @param {Socket<import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, any>} socket
 */
const mountJoinChatEvent = (socket) => {
  socket.on(ChatEventEnum.JOIN_CHAT_EVENT, (chatId) => {
    console.log(`User joined the chat 🤝. chatId: `, chatId);
    // joining the room with the chatId will allow specific events to be fired where we don't bother about the users like typing events
    // E.g. When user types we don't want to emit that event to specific participant.
    // We want to just emit that to the chat where the typing is happening
    socket.join(chatId);
  });
};

/**
 * @description This function is responsible to emit the typing event to the other participants of the chat
 * @param {Socket<import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, any>} socket
 */
const mountParticipantTypingEvent = (socket) => {
  socket.on(ChatEventEnum.TYPING_EVENT, (chatId) => {
    socket.in(chatId).emit(ChatEventEnum.TYPING_EVENT, chatId);
  });
};

/**
 * @description This function is responsible to emit the stopped typing event to the other participants of the chat
 * @param {Socket<import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, any>} socket
 */
const mountParticipantStoppedTypingEvent = (socket) => {
  socket.on(ChatEventEnum.STOP_TYPING_EVENT, (chatId) => {
    socket.in(chatId).emit(ChatEventEnum.STOP_TYPING_EVENT, chatId);
  });
};

/**
 *
 * @param {Server<import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, import("socket.io/dist/typed-events").DefaultEventsMap, any>} io
 */
const initializeSocketIO = (io) => {
  return io.on("connection", async (socket) => {
    try {
      // parse the cookies from the handshake headers (This is only possible if client has `withCredentials: true`)
      const cookies = cookie.parse(socket.handshake.headers?.cookie || "");

      let token = cookies?.accessToken; // get the accessToken

      if (!token) {
        // If there is no access token in cookies. Check inside the handshake auth
        token = socket.handshake.auth?.token;
      }

      if (!token) {
        // Token is required for the socket to work
        throw new ApiError(401, "Un-authorized handshake. Token is missing");
      }

      const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET); // decode the token

      const user = await prisma.user.findUnique({
        where: { id: decodedToken?.id },
        select: {
          id: true,
          name: true,
          email: true,
        },
      });

      // retrieve the user
      if (!user) {
        throw new ApiError(401, "Un-authorized handshake. Token is invalid");
      }
      socket.user = user; // mount te user object to the socket

      // We are creating a room with user id so that if user is joined but does not have any active chat going on.
      // still we want to emit some socket events to the user.
      // so that the client can catch the event and show the notifications.
      socket.join(user.id.toString());
      socket.emit(ChatEventEnum.CONNECTED_EVENT); // emit the connected event so that client is aware
      console.log("User connected 🗼. userId: ", user.id.toString());

      // Common events that needs to be mounted on the initialization
      mountJoinChatEvent(socket);
      mountParticipantTypingEvent(socket);
      mountParticipantStoppedTypingEvent(socket);

      socket.on(ChatEventEnum.DISCONNECT_EVENT, async () => {
        try {
          console.log("User has disconnected 🚫. userId: " + socket.user?.id);
          console.log(socket.rooms);
          const rooms = Object.keys(socket.rooms);

          for (const room of rooms) {
            if (room !== socket.user?.id.toString()) {
              await cleanupRedisForChat(room);
              console.log(`Cleaned up Redis for chat: ${room}`);
            }
            socket.leave(room);
          }

          if (socket.user?.id) {
            const userRoom = socket.user.id.toString();
            socket.leave(userRoom);
            await redisSub.unsubscribe(`user:${userRoom}`);
            console.log(`Unsubscribed from Redis channel: user:${userRoom}`);
          }

          // Perform any additional cleanup if necessary
          // For example, you might want to update user status in the database

          console.log(
            "Disconnect process completed for user: " + socket.user?.id
          );
        } catch (error) {
          console.error("Error during disconnect process:", error);
        }
      });
      redisSub.subscribe(`user:${socket.user.id}`);

      // Handle incoming messages
      socket.on(ChatEventEnum.MESSAGE_RECEIVED_EVENT, async (data) => {
        const { chatId, message } = data;
        await redisPub.publish(
          `chat:${chatId}`,
          JSON.stringify({
            event: ChatEventEnum.MESSAGE_RECEIVED_EVENT,
            data: { senderId: socket.user.id, message },
          })
        );
      });

      // Handle Redis messages
      redisSub.on("message", (channel, message) => {
        const parsedMessage = JSON.parse(message);
        if (channel.startsWith("chat:")) {
          const chatId = channel.split(":")[1];
          socket.to(chatId).emit(parsedMessage.event, parsedMessage.data);
        } else if (channel === `user:${socket.user.id}`) {
          socket.emit(parsedMessage.event, parsedMessage.data);
        }
      });
    } catch (error) {
      socket.emit(
        ChatEventEnum.SOCKET_ERROR_EVENT,
        error?.message || "Something went wrong while connecting to the socket."
      );
    }
  });
};

/**
 *
 * @param {import("express").Request} req - Request object to access the `io` instance set at the entry point
 * @param {string} roomId - Room where the event should be emitted
 * @param {AvailableChatEvents[0]} event - Event that should be emitted
 * @param {any} payload - Data that should be sent when emitting the event
 * @description Utility function responsible to abstract the logic of socket emission via the io instance
 */
const emitSocketEvent = (req, roomId, event, payload) => {
  req.app.get("io").in(roomId).emit(event, payload);
};

export { initializeSocketIO, emitSocketEvent };
