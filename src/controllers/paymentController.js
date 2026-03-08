import Stripe from "stripe";
import TableSession from "../models/TableSession.js";
import PendingCheckout from "../models/PendingCheckout.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

/**
 * POST /payments/checkout
 *
 * Validates the request, stores cart data in PendingCheckout (temporary),
 * creates a Stripe Checkout Session, and returns the Stripe-hosted URL.
 *
 * NO Order is created here. The Order is only created by the webhook
 * after Stripe confirms the payment is successful.
 */
export async function createCheckoutSession(req, res) {
    try {
        const {
            tableNumber,
            items,
            sessionId,
            tableSessionToken,
            orderType,
            currency,
        } = req.body;

        // --- Validation ---
        if (!sessionId)
            return res.status(400).json({ message: "sessionId is required" });
        if (!tableSessionToken)
            return res.status(400).json({ message: "tableSessionToken is required" });
        if (!tableNumber || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ message: "tableNumber and items are required" });

        const allowedTypes = ["dine-in", "takeout"];
        const finalOrderType = orderType || "dine-in";
        if (!allowedTypes.includes(finalOrderType))
            return res.status(400).json({ message: `Invalid orderType. Use: ${allowedTypes.join(", ")}` });

        // --- Validate table session token ---
        const ts = await TableSession.findOne({ token: tableSessionToken });
        if (!ts)
            return res.status(403).json({ message: "Invalid or expired table session." });
        if (ts.expiresAt.getTime() < Date.now())
            return res.status(403).json({ message: "Session expired." });
        if (ts.tableId !== tableNumber)
            return res.status(403).json({ message: "Table session mismatch." });

        // Bind session to first device
        if (!ts.boundSessionId) {
            ts.boundSessionId = sessionId;
            await ts.save();
        } else if (ts.boundSessionId !== sessionId) {
            return res.status(403).json({ message: "Table session active on another device." });
        }

        // --- Build Stripe line items and enrich cart items ---
        const lineItems = [];
        const enrichedItems = [];
        let serverTotal = 0;
        const finalCurrency = (currency || "eur").toLowerCase();

        for (const item of items) {
            const price = Number(item.price) || 0;
            const qty = Number(item.quantity) || 1;
            const priceInCents = Math.round(price * 100);

            serverTotal += price * qty;

            lineItems.push({
                price_data: {
                    currency: finalCurrency,
                    product_data: { name: item.itemName },
                    unit_amount: priceInCents,
                },
                quantity: qty,
            });

            enrichedItems.push({
                itemName: item.itemName,
                quantity: qty,
                lineTotal: Number((price * qty).toFixed(2)),
                category: item.orderCategory || "food",
                notes: item.notes || "",
                allergies: item.allergies || [],
            });
        }

        // --- Save cart data temporarily (not an Order yet) ---
        const pending = await PendingCheckout.create({
            tableNumber,
            orderType: finalOrderType,
            sessionId,
            items: enrichedItems,
            total: Number(serverTotal.toFixed(2)),
            currency: finalCurrency.toUpperCase(),
        });

        console.log(`[createCheckoutSession] ✅ PendingCheckout created — _id=${pending._id}, table=${tableNumber}, items=${enrichedItems.length}`);

        // --- Create Stripe Checkout Session ---
        const stripeSession = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            line_items: lineItems,
            metadata: {
                pendingCheckoutId: pending._id.toString(),
                tableNumber,
            },
            success_url: `${FRONTEND_BASE_URL}/table/${tableNumber}/confirmation?payment=success`,
            cancel_url: `${FRONTEND_BASE_URL}/table/${tableNumber}/order?payment=cancelled`,
        });

        console.log(`[createCheckoutSession] ✅ Stripe session created — id=${stripeSession.id}, metadata=${JSON.stringify(stripeSession.metadata)}`);

        // Save Stripe session ID on the pending record for reference
        pending.stripeSessionId = stripeSession.id;
        await pending.save();

        return res.status(201).json({
            sessionUrl: stripeSession.url,
        });
    } catch (err) {
        console.error("[createCheckoutSession] Error:", err);
        return res.status(500).json({ message: "Server error creating checkout session" });
    }
}
