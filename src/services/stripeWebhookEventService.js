import { randomUUID } from "node:crypto";
import StripeWebhookEvent from "../models/StripeWebhookEvent.js";

export const STRIPE_WEBHOOK_CLAIM_LEASE_MS = 5 * 60 * 1000;

export async function claimStripeWebhookEvent({
    eventId,
    eventType,
    now = new Date(),
    claimId = randomUUID(),
    eventModel = StripeWebhookEvent,
} = {}) {
    if (!eventId || !eventType) {
        throw new TypeError("Stripe event ID and type are required");
    }
    const claimExpiresAt = new Date(now.getTime() + STRIPE_WEBHOOK_CLAIM_LEASE_MS);
    let claimed;
    try {
        claimed = await eventModel.findOneAndUpdate(
            {
                eventId,
                $or: [
                    { status: "failed" },
                    {
                        status: "processing",
                        claimExpiresAt: { $lte: now },
                    },
                ],
            },
            {
                $setOnInsert: { eventId },
                $set: {
                    eventType,
                    status: "processing",
                    claimId,
                    claimedAt: now,
                    claimExpiresAt,
                    error: null,
                    processedAt: null,
                },
                $inc: { attemptCount: 1 },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();
    } catch (error) {
        if (error?.code !== 11000) throw error;
    }
    if (claimed?.claimId === claimId) {
        return { claimed: true, claimId, event: claimed };
    }
    const existing = await eventModel.findOne({ eventId }).lean();
    if (["processed", "processed_with_email_error"].includes(existing?.status)) {
        return { claimed: false, reason: "already_processed", event: existing };
    }
    return { claimed: false, reason: "processing", event: existing };
}

export async function completeStripeWebhookEvent({
    eventId,
    claimId,
    status = "processed",
    error = null,
    now = new Date(),
    eventModel = StripeWebhookEvent,
} = {}) {
    if (!["processed", "processed_with_email_error", "failed"].includes(status)) {
        throw new TypeError("Invalid Stripe webhook completion status");
    }
    const result = await eventModel.updateOne(
        { eventId, claimId, status: "processing" },
        {
            $set: {
                status,
                processedAt: status === "failed" ? null : now,
                error: error ? String(error).slice(0, 1000) : null,
                claimId: null,
                claimExpiresAt: null,
            },
        },
    );
    if (result.matchedCount !== 1) {
        throw new Error("Stripe webhook event claim was lost");
    }
    return { completed: status !== "failed", status };
}
