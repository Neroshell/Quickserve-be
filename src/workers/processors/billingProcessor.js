import { BILLING_JOB_NAMES } from "../../queues/index.js";
import {
    processBillingLifecycleAction,
    scanBillingLifecycleCandidates,
} from "../../services/billingLifecycleService.js";

export async function processBillingJob(job, dependencies = {}) {
    const scan = dependencies.scan || scanBillingLifecycleCandidates;
    const processAction = dependencies.processAction ||
        processBillingLifecycleAction;

    if (job.name === BILLING_JOB_NAMES.LIFECYCLE_SCAN) {
        return scan({
            now: dependencies.now || new Date(),
            enqueueAction: dependencies.enqueueAction,
        });
    }
    return processAction({
        jobName: job.name,
        ...job.data,
        now: dependencies.now || new Date(),
    });
}
