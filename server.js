import "dotenv/config"
import express from "express"
import cors from "cors"
import orderRoute from "./src/routes/order-route.js"
import { connectDB } from "./src/config/db.js"
import qrRoute from "./src/routes/qr-route.js"

// ...



const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(express.json())
app.use(cors())

// Routes
app.use("/orders", orderRoute)
app.use("/q", qrRoute)


// Start server (DB first)
async function start() {
  await connectDB()
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
  })
}

start()
