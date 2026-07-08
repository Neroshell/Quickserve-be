/**
 * fix-pro-plan.js
 *
 * Inspects all plans in MongoDB and fixes the Pro plan's Stripe price configuration.
 *
 * THE PROBLEM:
 *   The Pro plan has stripeBasePriceId === stripeMeteredPriceId (same price ID).
 *   Stripe does not allow two subscription items with the same price ID.
 *
 * THE FIX:
 *   If stripeBasePriceId === stripeMeteredPriceId, set stripeBasePriceId = null.
 *   This means Pro becomes a metered-only plan (no flat monthly fee), which is
 *   the correct configuration if only one Stripe price was created for Pro.
 *
 * Run with: node scripts/fix-pro-plan.js
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '../.env') })
import Plan from '../src/models/Plan.js'

await mongoose.connect(process.env.MONGODB_URI)
console.log('✅ Connected to MongoDB\n')

const plans = await Plan.find({}).lean()

console.log('=== Current Plan Configuration ===')
for (const p of plans) {
    console.log(`\n[${p.slug.toUpperCase()}]`)
    console.log(`  stripeBasePriceId:    ${p.stripeBasePriceId || '(null)'}`)
    console.log(`  stripeMeteredPriceId: ${p.stripeMeteredPriceId || '(null)'}`)
    if (p.stripeBasePriceId && p.stripeBasePriceId === p.stripeMeteredPriceId) {
        console.log(`  ⚠️  PROBLEM: stripeBasePriceId === stripeMeteredPriceId — will cause Stripe duplicate item error!`)
    }
}

console.log('\n=== Applying Fix ===')

const problemPlans = plans.filter(p =>
    p.stripeBasePriceId &&
    p.stripeBasePriceId === p.stripeMeteredPriceId
)

if (problemPlans.length === 0) {
    console.log('✅ No plans have duplicate price IDs. No fix needed.')
} else {
    for (const p of problemPlans) {
        console.log(`\nFixing [${p.slug}]: setting stripeBasePriceId = null`)
        console.log(`  (keeping stripeMeteredPriceId = ${p.stripeMeteredPriceId})`)
        await Plan.updateOne(
            { slug: p.slug },
            { $set: { stripeBasePriceId: null } }
        )
        console.log(`  ✅ Fixed`)
    }
}

console.log('\n=== Plan Configuration After Fix ===')
const updated = await Plan.find({}).lean()
for (const p of updated) {
    console.log(`\n[${p.slug.toUpperCase()}]`)
    console.log(`  stripeBasePriceId:    ${p.stripeBasePriceId || '(null)'}`)
    console.log(`  stripeMeteredPriceId: ${p.stripeMeteredPriceId || '(null)'}`)
}

await mongoose.disconnect()
console.log('\n✅ Done. Restart your backend server.')
