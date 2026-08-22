import {
    BILLING_JOB_NAMES,
    BILLING_JOB_OPTIONS,
    isBillingSchedulersEnabled,
    isPostPaymentQueueEnabled,
    isReservationSchedulersEnabled,
    QUEUE_NAMES,
    RESERVATION_JOB_NAMES,
    RESERVATION_JOB_OPTIONS,
    POST_PAYMENT_JOB_NAMES,
    POST_PAYMENT_JOB_OPTIONS,
} from "../queues/index.js";
import {
    AI_ANALYST_JOB_OPTIONS,
    isAiAnalystWeeklyEnabled,
} from "../queues/aiAnalystQueue.js";
import { AI_ANALYST_JOB_NAMES } from "../queues/index.js";
import { createQueue } from "../queues/createQueue.js";

export const RESERVATION_REPAIR_SCHEDULER_ID =
    "reservation-expiry-repair-scan-every-5-minutes";
export const BILLING_LIFECYCLE_SCHEDULER_ID =
    "billing-lifecycle-scan-hourly";
export const CRM_ORDER_REPAIR_SCHEDULER_ID =
    "crm-order-repair-scan-every-10-minutes";
export const AI_ANALYST_WEEKLY_SCHEDULER_ID =
    "ai-analyst-weekly-scan-monday-6am-utc";

export async function registerWorkerSchedulers({
    runtime = null,
    env = process.env,
    createQueueFn = createQueue,
} = {}) {
    const result = { reservation: false, billing: false, postPayment: false, aiAnalyst: false };
    if (runtime !== "worker") return result;

    if (isReservationSchedulersEnabled(env)) {
        const reservationQueue = createQueueFn(QUEUE_NAMES.RESERVATIONS, { env });
        await reservationQueue.upsertJobScheduler(
            RESERVATION_REPAIR_SCHEDULER_ID,
            { every: 5 * 60 * 1000 },
            {
                name: RESERVATION_JOB_NAMES.EXPIRY_REPAIR_SCAN,
                data: {},
                opts: RESERVATION_JOB_OPTIONS,
            },
        );
        result.reservation = true;
    }

    if (isBillingSchedulersEnabled(env)) {
        const billingQueue = createQueueFn(QUEUE_NAMES.BILLING, { env });
        await billingQueue.upsertJobScheduler(
            BILLING_LIFECYCLE_SCHEDULER_ID,
            { every: 60 * 60 * 1000 },
            {
                name: BILLING_JOB_NAMES.LIFECYCLE_SCAN,
                data: {},
                opts: BILLING_JOB_OPTIONS,
            },
        );
        result.billing = true;
    }

    if (isPostPaymentQueueEnabled(env)) {
        const postPaymentQueue = createQueueFn(QUEUE_NAMES.POST_PAYMENT, { env });
        await postPaymentQueue.upsertJobScheduler(
            CRM_ORDER_REPAIR_SCHEDULER_ID,
            { every: 10 * 60 * 1000 },
            {
                name: POST_PAYMENT_JOB_NAMES.CRM_ORDER_REPAIR_SCAN,
                data: {},
                opts: POST_PAYMENT_JOB_OPTIONS,
            },
        );
        result.postPayment = true;
    }

    if (isAiAnalystWeeklyEnabled(env)) {
        const aiAnalystQueue = createQueueFn(QUEUE_NAMES.AI_ANALYST, { env });
        await aiAnalystQueue.upsertJobScheduler(
            AI_ANALYST_WEEKLY_SCHEDULER_ID,
            { every: 7 * 24 * 60 * 60 * 1000 }, // weekly
            {
                name: AI_ANALYST_JOB_NAMES.WEEKLY_SCAN,
                data: {},
                opts: AI_ANALYST_JOB_OPTIONS[AI_ANALYST_JOB_NAMES.WEEKLY_SCAN],
            },
        );
        result.aiAnalyst = true;
    }

    return result;
}
