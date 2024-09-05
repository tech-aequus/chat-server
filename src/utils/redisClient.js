import Redis from "ioredis";
import logger from "../logger/winston.logger.js";

const redisClient = new Redis(process.env.REDIS_URL);
const redisPub = new Redis(process.env.REDIS_URL);
const redisSub = new Redis(process.env.REDIS_URL);

redisClient.on("error", (err) => logger.error("Redis Client Error", err));
redisPub.on("error", (err) => logger.error("Redis Pub Error", err));
redisSub.on("error", (err) => logger.error("Redis Sub Error", err));

export { redisClient, redisPub, redisSub };
