/**
 * Creates/reuses the Stripe Billing Meter + metered Price needed for
 * QuickServe plan subscriptions, then stores the price ID on local plans.
 *
 * Run with: node scripts/bootstrap-billing-plans.js
 */
import mongoose from "mongoose";
import Stripe from "stripe";
import dotenv from "dotenv";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import Plan from "../src/models/Plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../.env") });

const METER_EVENT_NAME = "offline_commission_cents";
const PRODUCT_ID = "quickserve_platform_billing";
const PRICE_LOOKUP_KEY = "quickserve_offline_commission_cents_v1";
const BILLING_CURRENCY = "eur";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is required");
}

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function getOrCreateMeter() {
  const activeMeters = await stripe.billing.meters.list({ limit: 100, status: "active" });
  const activeMeter = activeMeters.data.find((meter) => meter.event_name === METER_EVENT_NAME);
  if (activeMeter) return activeMeter;

  const inactiveMeters = await stripe.billing.meters.list({ limit: 100, status: "inactive" });
  const inactiveMeter = inactiveMeters.data.find((meter) => meter.event_name === METER_EVENT_NAME);
  if (inactiveMeter) {
    return stripe.billing.meters.reactivate(inactiveMeter.id);
  }

  return stripe.billing.meters.create({
    display_name: "QuickServe offline commission cents",
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: {
      type: "by_id",
      event_payload_key: "stripe_customer_id",
    },
    value_settings: {
      event_payload_key: "value",
    },
  });
}

async function getOrCreateProduct() {
  try {
    return await stripe.products.retrieve(PRODUCT_ID);
  } catch (err) {
    const code = err?.raw?.code || err?.code;
    if (code !== "resource_missing") throw err;
  }

  return stripe.products.create({
    id: PRODUCT_ID,
    name: "QuickServe Platform Billing",
    type: "service",
    metadata: {
      app: "quickserve",
      purpose: "platform_billing",
    },
  });
}

async function getOrCreateMeteredPrice(productId, meterId) {
  const existingPrices = await stripe.prices.list({
    lookup_keys: [PRICE_LOOKUP_KEY],
    limit: 1,
    active: true,
  });

  if (existingPrices.data.length > 0) {
    return existingPrices.data[0];
  }

  return stripe.prices.create({
    product: productId,
    currency: BILLING_CURRENCY,
    unit_amount: 1,
    billing_scheme: "per_unit",
    lookup_key: PRICE_LOOKUP_KEY,
    nickname: "Offline commission cents",
    recurring: {
      interval: "month",
      usage_type: "metered",
      meter: meterId,
    },
    metadata: {
      app: "quickserve",
      event_name: METER_EVENT_NAME,
    },
  });
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const meter = await getOrCreateMeter();
  const product = await getOrCreateProduct();
  const price = await getOrCreateMeteredPrice(product.id, meter.id);

  const plans = await Plan.find({ slug: { $in: ["basic", "growth", "pro"] } });
  for (const plan of plans) {
    if (!plan.stripeMeteredPriceId) {
      plan.stripeMeteredPriceId = price.id;
    }

    if (plan.stripeBasePriceId === plan.stripeMeteredPriceId) {
      plan.stripeBasePriceId = null;
    }

    await plan.save();
  }

  const updatedPlans = await Plan.find({ slug: { $in: ["basic", "growth", "pro"] } })
    .select("slug stripeBasePriceId stripeMeteredPriceId")
    .lean();

  console.log("Billing plan bootstrap complete.");
  console.log(`Meter: ${meter.id}`);
  console.log(`Metered price: ${price.id}`);
  console.log(JSON.stringify(updatedPlans, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Billing plan bootstrap failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch {
    // Ignore disconnect failures while exiting.
  }
  process.exit(1);
});
