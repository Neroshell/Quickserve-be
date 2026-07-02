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
import feedbackRoute from "./src/routes/feedback-route.js"
import publicRoute from "./src/routes/public-route.js"
import internalRoute from "./src/routes/internal-route.js"
import guestProfileRoute from "./src/routes/guestProfileRoutes.js"
import { startRealtimeBus } from "./src/utils/realtimeBus.js"
import helmet from "helmet"
import { sessionMiddleware } from "./src/config/session.js"
import { connectSessionRedis } from "./src/config/sessionRedisClient.js"
import rateLimit from "express-rate-limit"
import { setupSwagger } from "./src/config/swagger.js"
import { validateOrigin } from "./src/middleware/originValidation.js"
import { requireAuth, requireRole } from "./src/middleware/authMiddleware.js"

const app = express()
app.set("trust proxy", 1) // required for secure cookies behind proxies like vercel
const PORT = process.env.PORT || 5000



// ⚠️ IMPORTANT: Webhook route must be registered BEFORE express.json()
// because Stripe signature verification requires the raw body buffer.
// The express.raw() middleware is applied inside webhook-route.js for this specific path only.

app.use("/webhook", webhookRoute)

// Global middleware with scoped Helmet CSP exceptions for Swagger UI
app.use((req, res, next) => {
  if (req.path.startsWith("/api-docs")) {
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "https://validator.swagger.io"],
        },
      },
    })(req, res, next)
  } else {
    helmet()(req, res, next)
  }
})
app.use(express.json())

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // Limit each IP to 50 requests per minute
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
// Platform admin backoffice (separate app/origin). Uses Authorization Bearer, not cookies.
if (process.env.BACKOFFICE_BASE_URL) origins.push(process.env.BACKOFFICE_BASE_URL)
app.use(cors({ origin: origins, credentials: true }))
app.use(sessionMiddleware)

// CSRF defense-in-depth: reject state-changing requests whose browser Origin/Referer
// isn't in our allowlist. Runs after the Stripe webhook (registered above), which is
// exempt. (CSRF tokens will be layered on top of this later.)
app.use(validateOrigin(origins))

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
app.use("/owner/guests", requireAuth, requireRole("owner", "co_owner", "manager"), guestProfileRoute)
app.use("/owner", ownerRoute)
app.use("/menu-items", menuRoute)
app.use("/business", restaurantRoute)
app.use("/table-session", tableSessionRoute)
app.use("/admin", adminRoute)
app.use("/auth", authRoute)
app.use("/upload", uploadRoute)
app.use("/feedback", feedbackRoute)
app.use("/public", publicRoute)
app.use("/internal", internalRoute)
app.use(sseRoute)

// Setup Swagger UI and Spec endpoints
setupSwagger(app)

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




