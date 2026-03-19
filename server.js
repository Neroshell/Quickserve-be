import "dotenv/config"
import express from "express"
import cors from "cors"
import orderRoute from "./src/routes/order-route.js"
import { connectDB } from "./src/config/db.js"
import qrRoute from "./src/routes/qr-route.js"
import kitchenRoute from "./src/routes/kitchen-route.js"
import waiterRoute from "./src/routes/waiter-route.js"
import sseRoute from "./src/routes/sse-route.js"
import paymentRoute from "./src/routes/payment-route.js"
import webhookRoute from "./src/routes/webhook-route.js"
import ownerRoute from "./src/routes/owner-route.js"
import restaurantRoute from "./src/routes/restaurant-route.js"
import tableSessionRoute from "./src/routes/table-session-route.js"
import { startRealtimeBus } from "./src/utils/realtimeBus.js"

const app = express()
const PORT = process.env.PORT || 5000

// ⚠️ IMPORTANT: Webhook route must be registered BEFORE express.json()
// because Stripe signature verification requires the raw body buffer.
// The express.raw() middleware is applied inside webhook-route.js for this specific path only.

// DEBUG: log ANY request hitting /webhook/*
app.use("/webhook", (req, res, next) => {
  console.log(`[server.js] 🔔 /webhook${req.url} — method=${req.method}`)
  next()
})

// Quick test endpoint so you can verify reachability with a browser
app.get("/webhook/test", (req, res) => res.send("webhook endpoint reachable"))

app.use("/webhook", webhookRoute)

// Global middleware
app.use(express.json())
app.use(cors())

import menuRoute from "./src/routes/menu-route.js"
import restaurantScopedRoute from "./src/routes/restaurant-scoped-route.js"

// Routes
app.use("/orders", orderRoute)
app.use("/restaurants/:restaurantId/orders", restaurantScopedRoute)
app.use("/payments", paymentRoute)
app.use("/q", qrRoute)
app.use("/kitchen", kitchenRoute)
app.use("/waiter", waiterRoute)
app.use("/owner", ownerRoute)
app.use("/menu-items", menuRoute)
app.use("/restaurant", restaurantRoute)
app.use("/table-session", tableSessionRoute)
app.use(sseRoute)

// Start server (DB first, then Redis bus, then HTTP)
async function start() {
  await connectDB()
  startRealtimeBus()
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
  })
}

start()

