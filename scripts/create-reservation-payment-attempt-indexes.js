import "dotenv/config"
import mongoose from "mongoose"

import PendingCheckout from "../src/models/PendingCheckout.js"

const uri = process.env.MONGODB_URI
if (!uri) {
    throw new Error("MONGODB_URI is required")
}

try {
    await mongoose.connect(uri, { autoIndex: false })
    await PendingCheckout.collection.createIndex(
        { businessId: 1, reservationId: 1, createdAt: -1 },
        { name: "reservation_attempt_history" },
    )
    await PendingCheckout.collection.createIndex(
        { reservationId: 1, activeReservationAttempt: 1 },
        {
            unique: true,
            partialFilterExpression: {
                checkoutType: "reservation",
                activeReservationAttempt: true,
            },
            name: "uniq_active_reservation_payment_attempt",
        },
    )
    console.log("Reservation payment-attempt indexes are ready")
} finally {
    await mongoose.disconnect()
}
