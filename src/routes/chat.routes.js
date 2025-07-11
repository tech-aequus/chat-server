import { Router } from "express";
import {
  addNewFactionMemberToGroupChat,
  addNewParticipantInGroupChat,
  createAFactionGroupChat,
  createAGroupChat,
  createOrGetAOneOnOneChat,
  deleteGroupChat,
  deleteOneOnOneChat,
  getAllChats,
  getGroupChatDetails,
  isEmailRegistered,
  leaveGroupChat,
  removeParticipantFromGroupChat,
  renameGroupChat,
  searchAvailableUsers,
} from "../controllers/chat.controllers.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import {
  createAFactionGroupChatValidator,
  createAGroupChatValidator,
  updateGroupChatNameValidator,
} from "../validators/chat.validator.js";
import { mongoIdPathVariableValidator } from "../validators/mongodb.validators.js";
import { validate } from "../validators/validate.js";

const router = Router();

router.use(verifyJWT);

router.route("/").get(getAllChats);

router.route("/users").get(searchAvailableUsers);
router.route("/isEmailRegistered").get(isEmailRegistered);
router
  .route("/c/:receiverId")
  .post(
    mongoIdPathVariableValidator("receiverId"),
    validate,
    createOrGetAOneOnOneChat
  );

router
  .route("/group")
  .post(createAGroupChatValidator(), validate, createAGroupChat);

router
  .route("/faction/createChat")
  .post(createAFactionGroupChatValidator(), validate, createAFactionGroupChat);

router
  .route("/group/:chatId")
  .get(mongoIdPathVariableValidator("chatId"), validate, getGroupChatDetails)
  .patch(
    mongoIdPathVariableValidator("chatId"),
    updateGroupChatNameValidator(),
    validate,
    renameGroupChat
  )
  .delete(mongoIdPathVariableValidator("chatId"), validate, deleteGroupChat);

router
  .route("/group/:chatId/:participantId")
  .post(
    mongoIdPathVariableValidator("chatId"),
    mongoIdPathVariableValidator("participantId"),
    validate,
    addNewParticipantInGroupChat
  )
  .delete(
    mongoIdPathVariableValidator("chatId"),
    mongoIdPathVariableValidator("participantId"),
    validate,
    removeParticipantFromGroupChat
  );

router
  .route("/faction/:chatId/:participantId")
  .post(
    mongoIdPathVariableValidator("chatId"),
    mongoIdPathVariableValidator("participantId"),
    validate,
    addNewFactionMemberToGroupChat
  );


router
  .route("/leave/group/:chatId")
  .delete(mongoIdPathVariableValidator("chatId"), validate, leaveGroupChat);

router
  .route("/remove/:chatId")
  .delete(mongoIdPathVariableValidator("chatId"), validate, deleteOneOnOneChat);

export default router;
