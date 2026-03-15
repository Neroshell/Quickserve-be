
import mongoose from 'mongoose';
import MenuItem from './src/models/menuItem.js';
import dotenv from 'dotenv';
dotenv.config();

const testValidation = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/quickserve');
        console.log("Connected to DB");

        const longName = "A".repeat(31);
        const longDesc = "B".repeat(71);

        console.log("Testing invalid name (31 chars)...");
        try {
            const item1 = new MenuItem({
                restaurantId: "test",
                name: longName,
                price: 10,
                category: "mains"
            });
            await item1.save();
            console.log("❌ Error: Long name should have failed validation");
        } catch (err) {
            console.log("✅ Success: Long name caught by validation:", err.message);
        }

        console.log("Testing invalid description (71 chars)...");
        try {
            const item2 = new MenuItem({
                restaurantId: "test",
                name: "Valid Name",
                description: longDesc,
                price: 10,
                category: "mains"
            });
            await item2.save();
            console.log("❌ Error: Long description should have failed validation");
        } catch (err) {
            console.log("✅ Success: Long description caught by validation:", err.message);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error("Test failed:", err);
    }
};

testValidation();
