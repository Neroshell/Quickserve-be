import express from "express"
import { barOrders } from "../controllers/barController.js"

const router = express.Router()

router.get("/orders", barOrders)

export default router
