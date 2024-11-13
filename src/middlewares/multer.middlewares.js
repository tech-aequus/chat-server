import multer from "multer";
import { ApiError } from "../utils/ApiError.js";

const storage = multer.memoryStorage(); // Use memory storage instead of disk storage

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow only images
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new ApiError(400, "Only image files are allowed!"), false);
    }
  },
});
