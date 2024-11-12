import { Router } from "express";
import {
  deleteMessage,
  getAllMessages,
  handleMessageError,
  sendMessage,
} from "../controllers/message.controllers.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";

import { sendMessageValidator } from "../validators/message.validator.js";
import { mongoIdPathVariableValidator } from "../validators/mongodb.validators.js";
import { validate } from "../validators/validate.js";
import {
  handleMulterError,
  upload,
} from "../middlewares/multer.middlewares.js";

const router = Router();

router.use(verifyJWT);

router
  .route("/:chatId")
  .get(mongoIdPathVariableValidator("chatId"), validate, getAllMessages)
  .post(
    upload.array("attachments", 5),
    handleMulterError,
    handleMessageError,
    mongoIdPathVariableValidator("chatId"),
    sendMessageValidator(),
    validate,
    sendMessage
  );
//Delete message route based on Message id

router
  .route("/:chatId/:messageId")
  .delete(
    mongoIdPathVariableValidator("chatId"),
    mongoIdPathVariableValidator("messageId"),
    validate,
    deleteMessage
  );

export default router;
