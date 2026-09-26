import { createClient } from "redis";
import { assertTestNetworkTargetAllowed } from "../utils/testExternalProviderGuard.js";

export const SESSION_REDIS_CONNECT_TIMEOUT_MS = 5000;
export const SESSION_REDIS_RECONNECT_MAX_DELAY_MS = 5000;

if (process.env.REDIS_URL) {
  assertTestNetworkTargetAllowed("Redis session store", process.env.REDIS_URL);
}

export function getSessionRedisReconnectDelay(retries) {
  return Math.min(
    100 * (2 ** Math.min(retries, 6)),
    SESSION_REDIS_RECONNECT_MAX_DELAY_MS,
  );
}

export const redisSession = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: {
    connectTimeout: SESSION_REDIS_CONNECT_TIMEOUT_MS,
    reconnectStrategy: getSessionRedisReconnectDelay,
  },
});

redisSession.on("error", (error) => {
  console.error("[Redis:session] Error:", error.message);
});

export async function connectSessionRedis() {
  if (redisSession.isReady) return true;
  if (redisSession.isOpen) return false;

  try {
    await redisSession.connect();
    console.log("[Redis:session] Connected");
    return true;
  } catch (error) {
    console.error("[Redis:session] Connection failed:", error.message);
    return false;
  }
}
