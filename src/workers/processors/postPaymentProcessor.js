import { POST_PAYMENT_JOB_NAMES } from "../../queues/queueNames.js";
import { validateCrmOrderPayload } from "../../queues/postPaymentQueue.js";
import {
    processCrmOrder,
    scanCrmOrderRepairs,
} from "../../services/guestProfileService.js";

export async function processPostPaymentJob(
    job,
    { processOrder = processCrmOrder, repairScan = scanCrmOrderRepairs } = {},
) {
    if (job.name === POST_PAYMENT_JOB_NAMES.CRM_ORDER) {
        return processOrder(validateCrmOrderPayload(job.data));
    }
    if (job.name === POST_PAYMENT_JOB_NAMES.CRM_ORDER_REPAIR_SCAN) {
        return repairScan({ now: new Date() });
    }
    throw new Error(`Unsupported post-payment job: ${job.name}`);
}
