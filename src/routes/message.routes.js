import { Router } from "express";
import {
  deleteMessage,
  getAllMessages,
  sendMessage,
  markMessagesAsRead,
  getUnreadCount,
} from "../controllers/message.controllers.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { upload } from "../middlewares/multer.middlewares.js";
import { sendMessageValidator } from "../validators/message.validator.js";
import { mongoIdPathVariableValidator } from "../validators/mongodb.validators.js";
import { validate } from "../validators/validate.js";

const router = Router();

router.use(verifyJWT);

router
  .route("/:chatId")
  .get(mongoIdPathVariableValidator("chatId"), validate, getAllMessages)
  .post(
    upload.fields([{ name: "attachments", maxCount: 5 }]),
    mongoIdPathVariableValidator("chatId"),
    sendMessageValidator(),
    validate,
    sendMessage
  );

// New routes for read status
router
  .route("/:chatId/read")
  .post(mongoIdPathVariableValidator("chatId"), validate, markMessagesAsRead);

router
  .route("/:chatId/unread-count")
  .get(mongoIdPathVariableValidator("chatId"), validate, getUnreadCount);

router
  .route("/:chatId/:messageId")
  .delete(
    mongoIdPathVariableValidator("chatId"),
    mongoIdPathVariableValidator("messageId"),
    validate,
    deleteMessage
  );

export default router;
