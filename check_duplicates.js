import mongoose from "mongoose";
import "dotenv/config";

const RestaurantSchema = new mongoose.Schema({
    ownerEmail: String
});

const Restaurant = mongoose.model("Restaurant", RestaurantSchema);

async function checkDuplicates() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB");

        const duplicates = await Restaurant.aggregate([
            {
                $group: {
                    _id: { $toLower: { $trim: { input: "$ownerEmail" } } },
                    count: { $sum: 1 },
                    docs: { $push: "$_id" }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            }
        ]);

        if (duplicates.length > 0) {
            console.log("Found duplicate owner emails:");
            duplicates.forEach(d => {
                console.log(`Email: ${d._id}, Count: ${d.count}`);
            });
        } else {
            console.log("No duplicate owner emails found.");
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error("Error checking duplicates:", err);
    }
}

checkDuplicates();
