import mongoose from "mongoose";
import "dotenv/config";
import Restaurant from "../src/models/Restaurant.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/quickserve";

async function testCreate() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to DB");

        const testData = {
            name: "Test Restaurant LLC",
            displayName: "Test Restaurant",
            slug: "test-restaurant-" + Date.now(),
            contactEmail: "test@example.com",
            phone: "+123456789",
            address: "123 Test St",
            country: "US",
            currency: "USD",
            timezone: "America/New_York",
            ownerName: "Test Owner",
            ownerEmail: "owner@example.com",
            plan: "pro",
            notes: "Test notes"
        };

        const response = await fetch("http://localhost:5000/admin/restaurants", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testData)
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(JSON.stringify(err));
        }

        const data = await response.json();
        console.log("Success! Created restaurant:", data);

        const dbRecord = await Restaurant.findOne({ restaurantId: data.restaurantId });
        if (dbRecord) {
            console.log("Verified in DB:", dbRecord.restaurantId);
            console.log("Default settings initialized:", !!dbRecord.operatingHours);
        } else {
            console.error("Record NOT found in DB!");
        }

    } catch (err) {
        console.error("Test failed:", err);
    } finally {
        await mongoose.disconnect();
    }
}

testCreate();
