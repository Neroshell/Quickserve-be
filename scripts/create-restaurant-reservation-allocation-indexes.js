import "dotenv/config";
import mongoose from "mongoose";

import Reservation from "../src/models/Reservation.js";

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI is required");
}

try {
  await mongoose.connect(uri, { autoIndex: false });
  await Reservation.collection.createIndex(
    { businessId: 1, restaurantCreationIdempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: {
        restaurantCreationIdempotencyKey: { $type: "string" },
      },
      name: "uniq_restaurant_reservation_creation_request",
    },
  );
  console.log("Restaurant reservation allocation indexes are ready");
} finally {
  await mongoose.disconnect();
}
