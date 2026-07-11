import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import Plan from "../src/models/Plan.js";

async function seedPlans() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const defaultPlans = [
      { name: "Basic", slug: "basic", commissionPercentage: 2.5, offlineCommissionRate: 2.5, monthlyPrice: 0, level: 1 },
      { name: "Growth", slug: "growth", commissionPercentage: 3.0, offlineCommissionRate: 3.0, monthlyPrice: 0, level: 2 },
      { name: "Pro", slug: "pro", commissionPercentage: 4.0, offlineCommissionRate: 4.0, monthlyPrice: 0, level: 3 },
    ];

    for (const plan of defaultPlans) {
      await Plan.findOneAndUpdate(
        { slug: plan.slug },
        { $set: plan },
        { upsert: true, new: true }
      );
    }

    const growthPlan = await Plan.findOne({ slug: "growth" });
    console.log("Growth plan:", growthPlan);

    console.log("Plans seeded successfully!");
  } catch (err) {
    console.error("Failed to seed plans:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seedPlans();
