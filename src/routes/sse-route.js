import express from "express"
import { sseHandler } from "../utils/sseManager.js"

const router = express.Router()

router.get("/events", sseHandler)

export default router
