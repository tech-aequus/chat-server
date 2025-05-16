import { body } from "express-validator";

const createAGroupChatValidator = () => {
  return [
    body("name").trim().notEmpty().withMessage("Group name is required"),
    body("participants")
      .isArray({
        min: 2,
        max: 100,
      })
      .withMessage(
        "Participants must be an array with more than 2 members and less than 100 members"
      ),
  ];
};

const createAFactionGroupChatValidator = () => {
  return [
    body("name").trim().notEmpty().withMessage("Group name is required"),
    body("factionId")
    .isUUID()
    .withMessage("FactionId must be a valid UUID"),
  ];
};

const updateGroupChatNameValidator = () => {
  return [body("name").trim().notEmpty().withMessage("Group name is required")];
};

export { createAGroupChatValidator, createAFactionGroupChatValidator, updateGroupChatNameValidator };
