import express from "express"
import { sseHandler } from "../utils/sseBus.js"

const router = express.Router()

router.get("/events", sseHandler)

export default router
