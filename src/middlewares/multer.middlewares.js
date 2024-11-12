const multer = require("multer");
const multerS3 = require("multer-s3");
const aws = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

// Configure AWS
const s3 = new aws.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Multer S3 configuration
export const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET,
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      const fileExtension = file.originalname.split(".").pop();
      cb(null, `chat-attachments/${uuidv4()}.${fileExtension}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});
export const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Maximum 5 files allowed" });
    }
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File size limit exceeded (5MB)" });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
};
