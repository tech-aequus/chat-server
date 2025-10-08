import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import logger from "../logger/winston.logger.js";

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const uploadToS3 = async (file, key) => {
  try {
    logger.debug("Starting S3 upload with:", {
      bucket: process.env.AWS_BUCKET_NAME,
      key,
      fileSize: file.buffer.length,
      contentType: file.mimetype,
    });

    const command = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: "public-read",
    });

    const result = await s3Client.send(command);
    logger.debug("S3 upload result:", result);

    // Construct the URL
    const s3Url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    logger.debug("Generated S3 URL:", s3Url);

    return s3Url;
  } catch (error) {
    logger.error("Detailed S3 upload error:", {
      errorMessage: error.message,
      errorCode: error.code,
      errorStack: error.stack,
      errorDetails: error,
    });
    throw new Error(`S3 upload failed: ${error.message}`);
  }
};

export const deleteFromS3 = async (key) => {
  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(deleteCommand);
  } catch (error) {
    logger.error("Error deleting from S3:", error);
    throw error;
  }
};
