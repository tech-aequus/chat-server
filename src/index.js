import dotenv from "dotenv";
import { httpServer } from "./app.js";
import connectDB from "./db/index.js";
import logger from "./logger/winston.logger.js";

dotenv.config({
  path: "./.env",
});

const majorNodeVersion = +process.env.NODE_VERSION?.split(".")[0] || 0;

const startServer = () => {
  httpServer.listen(process.env.PORT || 8080, () => {
    logger.info(
      `📑 Visit the documentation at: http://localhost:${
        process.env.PORT || 8080
      }`
    );
    logger.info("⚙️  Server is running on port: " + process.env.PORT);
  });
};

if (majorNodeVersion >= 14) {
  try {
    await connectDB();
    startServer();
  } catch (err) {
    logger.error("Mongo db connect error: ", err);
  }
} else {
  connectDB()
    .then(() => {
      startServer();
    })
    .catch((err) => {
      logger.error("Mongo db connect error: ", err);
    });
}
