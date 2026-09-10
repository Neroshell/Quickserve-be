import { NOTIFICATION_JOB_NAMES } from "../../queues/index.js"
import {
    processNotificationIntent,
    scanNotificationIntentRepairs,
} from "../../services/notificationService.js"

export async function processNotificationJob(job, dependencies = {}) {
    const processIntent = dependencies.processIntent || processNotificationIntent
    const repairScan = dependencies.repairScan || scanNotificationIntentRepairs
    if (job.name === NOTIFICATION_JOB_NAMES.PROCESS_INTENT) {
        return processIntent({
            ...job.data,
            now: dependencies.now || new Date(),
        })
    }
    if (job.name === NOTIFICATION_JOB_NAMES.REPAIR_SCAN) {
        return repairScan({
            now: dependencies.now || new Date(),
            env: dependencies.env || process.env,
        })
    }
    throw new TypeError(`Unsupported notification job: ${job.name}`)
}

