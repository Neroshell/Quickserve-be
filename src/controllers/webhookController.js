import Stripe from "stripe";
import PendingCheckout from "../models/PendingCheckout.js";
import Order from "../models/order.js";
import { generateOrderId } from "../utils/orderId.js";
import { toOrderDTO } from "../utils/orderDTO.js";
import { broadcast, broadcastToRole } from "../utils/sseManager.js";
import { sendReceiptEmail } from "../utils/emailService.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * POST /webhook/stripe
 */
export async function handleStripeWebhook(req, res) {
    // ========== DEBUG: entry-point log ==========
    // console.log("[stripeWebhook] ✅ Handler HIT");
    // console.log("[stripeWebhook] Content-Type:", req.headers["content-type"]);
    // console.log("[stripeWebhook] Body type:", typeof req.body, "| isBuffer:", Buffer.isBuffer(req.body));
    // console.log("[stripeWebhook] Body length:", req.body?.length || 0);
    // console.log("[stripeWebhook] Has stripe-signature:", !!req.headers["stripe-signature"]);
    // ============================================

    const sig = req.headers["stripe-signature"];
    let event;

    // 1. Verify webhook signature
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        console.log("[stripeWebhook] ✅ Signature verified — event.type:", event.type);
    } catch (err) {
        console.error("[stripeWebhook] ❌ Signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 2. Handle checkout.session.completed
    try {
        if (event.type === "checkout.session.completed") {
            const session = event.data.object;

            // ========== DEBUG: dump metadata ==========
            console.log("[stripeWebhook] Session ID:", session.id);
            console.log("[stripeWebhook] Full metadata:", JSON.stringify(session.metadata));
            // ==========================================

            const { pendingCheckoutId } = session.metadata || {};

            if (!pendingCheckoutId) {
                console.error("[stripeWebhook] ❌ No pendingCheckoutId in metadata — this is likely a test trigger, not a real checkout");
                return res.status(200).send();
            }

            console.log(`[stripeWebhook] ✅ Payment confirmed — pendingCheckoutId=${pendingCheckoutId}`);

            // 3. Look up the saved cart data
            const pending = await PendingCheckout.findById(pendingCheckoutId);
            if (!pending) {
                console.error(`[stripeWebhook] ❌ PendingCheckout not found: ${pendingCheckoutId}`);
                return res.status(200).send();
            }

            console.log(`[stripeWebhook] ✅ PendingCheckout found — table=${pending.tableNumber}, items=${pending.items.length}`);

            // 4. Create the real Order as PAID
            const now = new Date();
            const hasFood = pending.items.some((i) => i.category === "food");
            const initialStatus = hasFood ? "placed" : "ready";
            const orderId = generateOrderId(pending.tableNumber, now);

            const customerEmail = session.customer_details?.email || null;

            const order = await Order.create({
                orderId,
                tableNumber: pending.tableNumber,
                orderType: pending.orderType,
                sessionId: pending.sessionId,
                items: pending.items,
                status: initialStatus,
                total: pending.total,
                currency: pending.currency,
                paymentChannel: "online",
                paymentStatus: "paid",
                paidVia: "online_card",
                stripeSessionId: pending.stripeSessionId,
                receiptEmail: customerEmail,
                receiptSent: false
            });

            console.log(`[stripeWebhook] ✅ Order created: ${orderId} (status=${initialStatus}, paid=online_card)`);

            // Send receipt automatically if email is available
            if (customerEmail) {
                const emailSent = await sendReceiptEmail(order, customerEmail);
                if (emailSent) {
                    await Order.findOneAndUpdate({ orderId }, { receiptSent: true });
                    console.log(`[stripeWebhook] ✅ Receipt sent to ${customerEmail}`);
                }
            }

            // 5. Broadcast order_created to dashboards
            const orderDTO = toOrderDTO(order);

            const foodItems = order.items.filter((i) => i.category === "food");
            if (foodItems.length > 0) {
                const kitchenDTO = { ...orderDTO, items: foodItems };
                broadcastToRole("kitchen", "order_created", { order: kitchenDTO });
                console.log("[stripeWebhook] ✅ Broadcast to kitchen");
            }

            broadcast("order_created", { order: orderDTO }, (client) => client.role !== "kitchen");
            console.log("[stripeWebhook] ✅ Broadcast to waiter/other clients");

            // 6. Clean up
            await PendingCheckout.findByIdAndDelete(pendingCheckoutId);
            console.log(`[stripeWebhook] ✅ Cleaned up PendingCheckout`);
        } else {
            console.log(`[stripeWebhook] Ignoring event type: ${event.type}`);
        }

        return res.status(200).send();
    } catch (error) {
        console.error("[stripeWebhook] ❌ Error processing webhook:", error);
        return res.status(500).send("Internal Server Error");
    }
}
