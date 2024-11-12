import AWS from "aws-sdk";
import { ApiError } from "./ApiError.js";

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const s3 = new AWS.S3();
const BUCKET_NAME = process.env.AWS_S3_BUCKET;

export const uploadFileToS3 = async (file, folder = "attachments") => {
  try {
    const key = `${folder}/${Date.now()}-${file.originalname}`;

    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: "public-read",
    };

    const uploadResult = await s3.upload(params).promise();

    return {
      url: uploadResult.Location,
      key: uploadResult.Key,
    };
  } catch (error) {
    throw new ApiError(500, "Error uploading file to S3: " + error.message);
  }
};

export const deleteFileFromS3 = async (key) => {
  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    await s3.deleteObject(params).promise();
  } catch (error) {
    throw new ApiError(500, "Error deleting file from S3: " + error.message);
  }
};
