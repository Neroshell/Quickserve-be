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
import barRoute from "./src/routes/bar-route.js"
import adminRoute from "./src/routes/admin-route.js"
import authRoute from "./src/routes/auth-route.js"
import uploadRoute from "./src/routes/upload-route.js"
import { startRealtimeBus } from "./src/utils/realtimeBus.js"
import helmet from "helmet"
import { sessionMiddleware } from "./src/config/session.js"
import { connectSessionRedis } from "./src/config/sessionRedisClient.js"
import rateLimit from "express-rate-limit"

const app = express()
app.set("trust proxy", 1) // required for secure cookies behind proxies like vercel
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
app.use(helmet())
app.use(express.json())

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 200 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(globalLimiter)

// For cors logic update later, ensure credentials:true is present if needed. Default is * which blocks credentials.
// Let's modify cors to explicitly allow credentials for dashboard frontends
const origins = [
  process.env.FRONTEND_BASE_URL || "http://localhost:3000",
  "http://localhost:3001"
];
app.use(cors({ origin: origins, credentials: true }))
app.use(sessionMiddleware)

import menuRoute from "./src/routes/menu-route.js"
import restaurantScopedRoute from "./src/routes/restaurant-scoped-route.js"

// Routes
app.use("/orders", orderRoute)
app.use("/businesses/:businessId/orders", restaurantScopedRoute)
app.use("/payments", paymentRoute)
app.use("/q", qrRoute)
app.use("/kitchen", kitchenRoute)
app.use("/bar", barRoute)
app.use("/waiter", waiterRoute)
app.use("/owner", ownerRoute)
app.use("/menu-items", menuRoute)
app.use("/business", restaurantRoute)
app.use("/table-session", tableSessionRoute)
app.use("/admin", adminRoute)
app.use("/auth", authRoute)
app.use("/upload", uploadRoute)
app.use(sseRoute)

// Global error handler to swallow 500 stack traces and prevent information leakage (CWE-209)
app.use((err, req, res, next) => {
  console.error("[Unhandled Error Captured]", err);
  res.status(500).json({ error: "Internal Server Error" });
});

// Start server (DB first, then Redis bus, then HTTP)
async function start() {
  await connectDB()
  await connectSessionRedis()
  startRealtimeBus()
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
  })
}

start()




