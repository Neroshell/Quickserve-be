import { createClient } from "redis";

export const redisSession = createClient({
  url: process.env.REDIS_URL,
});

redisSession.on("error", (err) => {
  console.error("[Redis:session] ❌ Error:", err.message);
});

export async function connectSessionRedis() {
  if (!redisSession.isOpen) {
    try {
      await redisSession.connect();
      console.log("[Redis:session] ✅ Connected");
    } catch (err) {
      console.error("[Redis:session] ❌ Connection failed:", err.message);
    }
  }
}
