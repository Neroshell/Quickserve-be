import { BILLING_JOB_NAMES } from "../../queues/index.js";
import {
    processBillingLifecycleAction,
    scanBillingLifecycleCandidates,
} from "../../services/billingLifecycleService.js";
import { recoverOfflineCommissionAccruals, prepareCompletedCommissionBatches } from "../../services/offlineCommissionRecoveryService.js";

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
    if (job.name === BILLING_JOB_NAMES.COMMISSION_RECOVERY_SCAN) return recoverOfflineCommissionAccruals({ now: dependencies.now || new Date() })
    if (job.name === BILLING_JOB_NAMES.COMMISSION_INVOICE_SCAN) return prepareCompletedCommissionBatches({ now: dependencies.now || new Date(), env: dependencies.env || process.env, stripeClient: dependencies.stripeClient })
    return processAction({
        jobName: job.name,
        ...job.data,
        now: dependencies.now || new Date(),
    });
}
