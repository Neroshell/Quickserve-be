import { redisSession } from "../config/sessionRedisClient.js";
import { publishEvent } from "../utils/sseManager.js";

const PRESENCE_TTL = 90; // 3 minutes
const LAST_SEEN_TTL = 90 * 24 * 60 * 60; // 90 days

export function getPresenceKey(businessId, staffId) {
    return `quickserve:v1:presence:${businessId}:${staffId}`;
}

export function getLastSeenKey(businessId, staffId) {
    return `quickserve:v1:lastSeen:${businessId}:${staffId}`;
}

export async function markStaffActive(businessId, staffId) {
    if (!businessId || !staffId) return;
    
    try {
        const now = Date.now();
        if (redisSession && redisSession.isOpen) {
            const multi = redisSession.multi();
            multi.set(getPresenceKey(businessId, staffId), "1", { EX: PRESENCE_TTL });
            multi.set(getLastSeenKey(businessId, staffId), now.toString(), { EX: LAST_SEEN_TTL });
            await multi.exec();
        }
        
        await publishEvent("staff_presence_changed", businessId, ["owner"], {
            staffId,
            presenceStatus: "active",
            lastSeenAt: new Date(now).toISOString(),
            expiresAt: now + (PRESENCE_TTL * 1000)
        });
    } catch (err) {
        console.error(`[Presence] Error marking staff active (businessId: ${businessId}, staffId: ${staffId}):`, err.message);
    }
}

export async function markStaffOffline(businessId, staffId) {
    if (!businessId || !staffId) return;
    
    try {
        const now = Date.now();
        if (redisSession && redisSession.isOpen) {
            const multi = redisSession.multi();
            multi.del(getPresenceKey(businessId, staffId));
            multi.set(getLastSeenKey(businessId, staffId), now.toString(), { EX: LAST_SEEN_TTL });
            await multi.exec();
        }
        
        await publishEvent("staff_presence_changed", businessId, ["owner"], {
            staffId,
            presenceStatus: "offline",
            lastSeenAt: new Date(now).toISOString(),
            expiresAt: null
        });
    } catch (err) {
        console.error(`[Presence] Error marking staff offline (businessId: ${businessId}, staffId: ${staffId}):`, err.message);
    }
}

export async function getStaffPresence(businessId, staffIds) {
    const presenceMap = {};
    if (!businessId || !staffIds || staffIds.length === 0) return presenceMap;
    
    try {
        if (redisSession && redisSession.isOpen) {
            const keys = [];
            staffIds.forEach(id => {
                keys.push(getPresenceKey(businessId, id));
                keys.push(getLastSeenKey(businessId, id));
            });
            
            const results = await redisSession.mGet(keys);
            
            staffIds.forEach((id, index) => {
                const presenceVal = results[index * 2];
                const lastSeenVal = results[index * 2 + 1];
                
                presenceMap[id] = {
                    status: presenceVal === "1" ? "active" : "offline",
                    lastSeenAt: lastSeenVal ? new Date(parseInt(lastSeenVal)).toISOString() : null
                };
            });
        } else {
            // Fallback if redis is unavailable
            staffIds.forEach(id => {
                presenceMap[id] = { status: "offline", lastSeenAt: null };
            });
        }
    } catch (err) {
        console.error(`[Presence] Error getting staff presence (businessId: ${businessId}):`, err.message);
        staffIds.forEach(id => {
            presenceMap[id] = { status: "offline", lastSeenAt: null };
        });
    }
    
    return presenceMap;
}
