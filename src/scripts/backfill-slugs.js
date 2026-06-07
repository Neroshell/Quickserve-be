import mongoose from "mongoose";
import "dotenv/config";
import Business from "../models/Business.js";
import { generateSlugFromName } from "../utils/slugify.js";

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB for slug backfill");

    const businesses = await Business.find({
      $or: [
        { slug: { $exists: false } }, 
        { slug: null }, 
        { slug: "" },
        { slug: /^rest_/ }
      ]
    });

    console.log(`Found ${businesses.length} businesses missing slugs.`);

    for (const b of businesses) {
      const baseSlug = generateSlugFromName(b.displayName || b.name || "business");
      let newSlug = baseSlug;
      let counter = 1;

      // Ensure uniqueness
      while (await Business.exists({ slug: newSlug })) {
        newSlug = `${baseSlug}-${counter}`;
        counter++;
      }

      b.slug = newSlug;
      await b.save();
      console.log(`Updated business ${b.businessId} with slug: ${newSlug}`);
    }

    console.log("Backfill complete.");
  } catch (error) {
    console.error("Migration error:", error);
  } finally {
    mongoose.disconnect();
  }
}

run();
