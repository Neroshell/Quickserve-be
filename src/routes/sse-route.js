import express from "express"
import { sseHandler } from "../utils/sseManager.js"

const router = express.Router()

/**
 * @openapi
 * /events:
 *   get:
 *     summary: Establish a Server-Sent Events (SSE) channel for real-time updates
 *     tags:
 *       - Events
 *     responses:
 *       200:
 *         description: SSE connection established
 *         headers:
 *           Content-Type:
 *             schema:
 *               type: string
 *               example: text/event-stream
 */
router.get("/events", sseHandler)

export default router
