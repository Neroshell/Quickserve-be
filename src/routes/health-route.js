import express from "express";
import mongoose from "mongoose";
import { redisSession } from "../config/sessionRedisClient.js";

const router = express.Router();

export function resolveReadiness({
    mongoReadyState = mongoose.connection.readyState,
    sessionRedisReady = redisSession?.isReady === true,
} = {}) {
    const mongoConnected = mongoReadyState === 1;
    return {
        ready: mongoConnected && sessionRedisReady,
        mongo: mongoConnected ? "connected" : "disconnected",
        sessionRedis: sessionRedisReady ? "connected" : "disconnected",
    };
}

/**
 * Liveness Probe (/healthz)
 * Represents whether the process is alive. If this fails, the orchestrator
 * should restart the process.
 */
router.get("/healthz", (req, res) => {
    res.status(200).json({ status: "alive" });
});

/**
 * Readiness Probe (/ready)
 * Represents whether the process is ready to receive traffic.
 * Checks only mandatory serving dependencies (MongoDB and Session Redis).
 * Other dependencies (like BullMQ, public cache, presence) must remain
 * degradable and do not fail readiness.
 */
router.get("/ready", (req, res) => {
    const readiness = resolveReadiness();

    if (readiness.ready) {
        return res.status(200).json({ status: "ready" });
    }

    return res.status(503).json({
        status: "unready",
        mongo: readiness.mongo,
        sessionRedis: readiness.sessionRedis,
    });
});

export default router;
