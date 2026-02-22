import "dotenv/config"
import express from "express"
import cors from "cors"
import orderRoute from "./src/routes/order-route.js"
import { connectDB } from "./src/config/db.js"
import qrRoute from "./src/routes/qr-route.js"
import kitchenRoute from "./src/routes/kitchen-route.js"
import waiterRoute from "./src/routes/waiter-route.js"
import sseRoute from "./src/routes/sse-route.js"




const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(express.json())
// app.use(cors())

app.use(cors({
  origin: process.env.FRONTEND_BASE_URL || "http://localhost:3000",
  credentials: true,
}));

// Routes
app.use("/orders", orderRoute)
app.use("/q", qrRoute)
app.use("/kitchen", kitchenRoute)
app.use("/waiter", waiterRoute)
app.use(sseRoute)



// Start server (DB first)
async function start() {
  await connectDB()
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
  })
}

start()
