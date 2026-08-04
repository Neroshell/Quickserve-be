import { RESERVATION_JOB_NAMES } from "../../queues/index.js";
import {
    expireReservationPaymentWindow,
    runReservationExpiryRepairScan,
} from "../../services/reservationExpiryService.js";

export async function processReservationJob(job, dependencies = {}) {
    const expireOne = dependencies.expireOne || expireReservationPaymentWindow;
    const repairScan = dependencies.repairScan || runReservationExpiryRepairScan;

    if (job.name === RESERVATION_JOB_NAMES.EXPIRY_REPAIR_SCAN) {
        return repairScan({ now: dependencies.now || new Date() });
    }
    if (job.name === RESERVATION_JOB_NAMES.EXPIRE_PAYMENT_WINDOW) {
        return expireOne({
            ...job.data,
            now: dependencies.now || new Date(),
        });
    }
    throw new TypeError(`Unsupported reservation job: ${job.name}`);
}
