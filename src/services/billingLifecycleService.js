import crypto from "crypto";
import Business from "../models/Business.js";
import {
    BILLING_JOB_NAMES,
    EMAIL_JOB_NAMES,
    enqueueBillingJob,
} from "../queues/index.js";
import { invalidatePublicBusinessConfig } from "./cacheInvalidationService.js";
import { dispatchBillingNotification } from "./email/emailDispatchService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 15 * 60 * 1000;
const SCAN_BATCH_SIZE = 100;

export const BILLING_ACTIONS = Object.freeze({
    [BILLING_JOB_NAMES.UPCOMING_INVOICE]: Object.freeze({
        claimField: "upcomingInvoice",
        stage: "upcoming_invoice",
    }),
    [BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3]: Object.freeze({
        claimField: "overdueWarningDay3",
        stage: "overdue_warning_day_3",
    }),
    [BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5]: Object.freeze({
        claimField: "overdueWarningDay5",
        stage: "overdue_warning_day_5",
    }),
    [BILLING_JOB_NAMES.RESTRICT_SERVICE]: Object.freeze({
        claimField: "restrictService",
        stage: "restrict_service",
    }),
    [BILLING_JOB_NAMES.RESTORE_SERVICE]: Object.freeze({
        claimField: "restoreService",
        stage: "restore_service",
    }),
});

const BILLING_EMAIL_JOB_BY_ACTION = Object.freeze({
    [BILLING_JOB_NAMES.UPCOMING_INVOICE]: EMAIL_JOB_NAMES.BILLING_UPCOMING_INVOICE,
    [BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3]: EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_3,
    [BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5]: EMAIL_JOB_NAMES.BILLING_OVERDUE_DAY_5,
    [BILLING_JOB_NAMES.RESTRICT_SERVICE]: EMAIL_JOB_NAMES.BILLING_OFFLINE_RESTRICTED,
    [BILLING_JOB_NAMES.RESTORE_SERVICE]: EMAIL_JOB_NAMES.BILLING_SERVICE_RESTORED,
});

function toUtcDateString(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function startOfUtcDay(value) {
    const date = new Date(value);
    date.setUTCHours(0, 0, 0, 0);
    return date;
}

function getStoredInvoiceVersion(business) {
    if (business.nextInvoiceDate) {
        return {
            date: new Date(business.nextInvoiceDate),
            sourceField: "nextInvoiceDate",
            sourceValue: business.nextInvoiceDate,
        };
    }
    if (business.nextBillingDate) {
        return {
            date: new Date(business.nextBillingDate),
            sourceField: "nextBillingDate",
            sourceValue: business.nextBillingDate,
        };
    }
    if (business.currentPeriodEnd) {
        const periodEnd = new Date(business.currentPeriodEnd);
        return {
            date: new Date(periodEnd.getTime() + 1),
            sourceField: "currentPeriodEnd",
            sourceValue: business.currentPeriodEnd,
        };
    }
    return null;
}

export function getBillingActionPeriodKey(jobName, business) {
    if (jobName === BILLING_JOB_NAMES.UPCOMING_INVOICE) {
        const invoice = getStoredInvoiceVersion(business);
        const dateString = invoice && toUtcDateString(invoice.date);
        return dateString ? `invoice-${dateString}` : null;
    }
    if (
        jobName === BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3 ||
        jobName === BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5 ||
        jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE
    ) {
        const failedAt = business.billingFailedAt &&
            new Date(business.billingFailedAt);
        return failedAt && !Number.isNaN(failedAt.getTime())
            ? `failure-${failedAt.toISOString()}`
            : null;
    }
    if (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE) {
        const restrictedAt = business.offlineServiceRestrictedAt &&
            new Date(business.offlineServiceRestrictedAt);
        return restrictedAt && !Number.isNaN(restrictedAt.getTime())
            ? `restriction-${restrictedAt.toISOString()}`
            : `restriction-legacy-${business.businessId}`;
    }
    throw new TypeError("Unsupported billing lifecycle action");
}

function daysOverdue(business, now) {
    if (!business.billingFailedAt) return -1;
    return Math.floor(
        (now.getTime() - new Date(business.billingFailedAt).getTime()) / DAY_MS,
    );
}

export function isBillingActionDue(jobName, business, now = new Date()) {
    if (!business || !business.businessId) return false;
    if (["archived", "suspended"].includes(business.status)) return false;
    if (!business.stripeSubscriptionId) return false;

    if (jobName === BILLING_JOB_NAMES.UPCOMING_INVOICE) {
        const invoice = getStoredInvoiceVersion(business);
        if (business.billingStatus !== "active" || !invoice) return false;
        const tomorrow = new Date(startOfUtcDay(now).getTime() + DAY_MS);
        return toUtcDateString(invoice.date) === toUtcDateString(tomorrow);
    }
    if (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE) {
        return business.billingStatus === "active" &&
            business.offlineServiceRestricted === true;
    }
    if (business.billingStatus !== "past_due" || !business.billingFailedAt) {
        return false;
    }
    const overdue = daysOverdue(business, now);
    if (jobName === BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3) {
        return overdue >= 3 && overdue < 5;
    }
    if (jobName === BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5) {
        return overdue >= 5 && overdue < 7;
    }
    return jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE && overdue >= 7;
}

function actionVersionFilter(jobName, business) {
    if (jobName === BILLING_JOB_NAMES.UPCOMING_INVOICE) {
        const invoice = getStoredInvoiceVersion(business);
        return {
            billingStatus: "active",
            [invoice.sourceField]: invoice.sourceValue,
        };
    }
    if (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE) {
        return {
            billingStatus: "active",
            offlineServiceRestricted: true,
            offlineServiceRestrictedAt:
                business.offlineServiceRestrictedAt ?? null,
        };
    }
    return {
        billingStatus: "past_due",
        billingFailedAt: business.billingFailedAt,
    };
}

async function resolveQuery(query) {
    return typeof query?.lean === "function" ? query.lean() : query;
}

export async function claimBillingLifecycleAction({
    jobName,
    business,
    periodKey,
    now = new Date(),
    businessModel = Business,
    claimId = crypto.randomUUID(),
} = {}) {
    const action = BILLING_ACTIONS[jobName];
    if (!action) throw new TypeError("Unsupported billing lifecycle action");
    if (!business || !isBillingActionDue(jobName, business, now)) return null;
    if (getBillingActionPeriodKey(jobName, business) !== periodKey) return null;

    const path = `billingLifecycleClaims.${action.claimField}`;
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    return resolveQuery(businessModel.findOneAndUpdate(
        {
            businessId: business.businessId,
            stripeSubscriptionId: { $nin: [null, ""] },
            status: { $nin: ["archived", "suspended"] },
            ...actionVersionFilter(jobName, business),
            $or: [
                { [`${path}.periodKey`]: { $ne: periodKey } },
                {
                    [`${path}.periodKey`]: periodKey,
                    [`${path}.status`]: "failed",
                },
                {
                    [`${path}.periodKey`]: periodKey,
                    [`${path}.status`]: "claimed",
                    [`${path}.claimedAt`]: { $lte: staleBefore },
                },
            ],
        },
        {
            $set: {
                [`${path}.periodKey`]: periodKey,
                [`${path}.claimId`]: claimId,
                [`${path}.status`]: "claimed",
                [`${path}.claimedAt`]: now,
                [`${path}.completedAt`]: null,
                [`${path}.failedAt`]: null,
                [`${path}.lastError`]: null,
                [`${path}.providerMessageId`]: null,
            },
        },
        { new: true, runValidators: true },
    ));
}

function claimIdentity(jobName, businessId, periodKey, claimId) {
    const action = BILLING_ACTIONS[jobName];
    const path = `billingLifecycleClaims.${action.claimField}`;
    return {
        filter: {
            businessId,
            [`${path}.periodKey`]: periodKey,
            [`${path}.claimId`]: claimId,
            [`${path}.status`]: "claimed",
        },
        path,
    };
}

async function markClaimFailed({
    jobName,
    businessId,
    periodKey,
    claimId,
    error,
    now,
    businessModel,
}) {
    const { filter, path } = claimIdentity(
        jobName,
        businessId,
        periodKey,
        claimId,
    );
    await businessModel.updateOne(filter, {
        $set: {
            [`${path}.status`]: "failed",
            [`${path}.failedAt`]: now,
            [`${path}.lastError`]: String(
                error?.code || error?.message || "billing_action_failed",
            ).slice(0, 500),
        },
    });
}

async function markClaimCompleted({
    jobName,
    businessId,
    periodKey,
    claimId,
    now,
    providerMessageId,
    extraFields = {},
    businessModel,
}) {
    const { filter, path } = claimIdentity(
        jobName,
        businessId,
        periodKey,
        claimId,
    );
    const result = await businessModel.updateOne(filter, {
        $set: {
            [`${path}.status`]: "completed",
            [`${path}.completedAt`]: now,
            [`${path}.failedAt`]: null,
            [`${path}.lastError`]: null,
            [`${path}.providerMessageId`]: providerMessageId || null,
            ...extraFields,
        },
    });
    if (result?.matchedCount === 0) {
        const error = new Error("Billing action claim was lost before completion");
        error.code = "BILLING_CLAIM_LOST";
        throw error;
    }
}

async function reclaimTransitionedBillingAction({
    jobName,
    businessId,
    periodKey,
    claimId,
    now,
    businessModel,
}) {
    const action = BILLING_ACTIONS[jobName];
    const path = `billingLifecycleClaims.${action.claimField}`;
    const transitionedState = jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE
        ? { billingStatus: "past_due", offlineServiceRestricted: true }
        : { billingStatus: "active", offlineServiceRestricted: false };
    return resolveQuery(businessModel.findOneAndUpdate(
        {
            businessId,
            ...transitionedState,
            [`${path}.periodKey`]: periodKey,
            [`${path}.status`]: "failed",
        },
        {
            $set: {
                [`${path}.claimId`]: claimId,
                [`${path}.status`]: "claimed",
                [`${path}.claimedAt`]: now,
                [`${path}.failedAt`]: null,
                [`${path}.lastError`]: null,
            },
        },
        { new: true, runValidators: true },
    ));
}

function getRecipient(business) {
    return business.ownerEmail || business.contactEmail || null;
}

async function applyStateTransition({
    jobName,
    business,
    periodKey,
    claimId,
    now,
    businessModel,
}) {
    const { path } = claimIdentity(
        jobName,
        business.businessId,
        periodKey,
        claimId,
    );
    if (jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE) {
        if (business.offlineServiceRestricted) return business;
        return resolveQuery(businessModel.findOneAndUpdate(
            {
                businessId: business.businessId,
                billingStatus: "past_due",
                billingFailedAt: business.billingFailedAt,
                offlineServiceRestricted: { $ne: true },
                [`${path}.periodKey`]: periodKey,
                [`${path}.claimId`]: claimId,
                [`${path}.status`]: "claimed",
            },
            {
                $set: {
                    offlineServiceRestricted: true,
                    offlineServiceRestrictedAt: now,
                },
            },
            { new: true, runValidators: true },
        ));
    }
    if (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE) {
        if (!business.offlineServiceRestricted) return business;
        return resolveQuery(businessModel.findOneAndUpdate(
            {
                businessId: business.businessId,
                billingStatus: "active",
                offlineServiceRestricted: true,
                offlineServiceRestrictedAt:
                    business.offlineServiceRestrictedAt ?? null,
                [`${path}.periodKey`]: periodKey,
                [`${path}.claimId`]: claimId,
                [`${path}.status`]: "claimed",
            },
            {
                $set: {
                    offlineServiceRestricted: false,
                    offlineServiceRestrictedAt: null,
                    offlineRestrictionEmailSentAt: null,
                    overdueReminderSentAt: null,
                    finalWarningSentAt: null,
                    billingFailedAt: null,
                    billingRestoredAt: now,
                },
            },
            { new: true, runValidators: true },
        ));
    }
    return business;
}

export async function processBillingLifecycleAction({
    jobName,
    businessId,
    periodKey,
    now = new Date(),
    businessModel = Business,
    sendNotification = dispatchBillingNotification,
    claimId = crypto.randomUUID(),
} = {}) {
    if (!BILLING_ACTIONS[jobName]) {
        throw new TypeError("Unsupported billing lifecycle action");
    }
    const business = await resolveQuery(businessModel.findOne({ businessId }));
    if (!business) return { skipped: true, reason: "business_not_found" };

    const existingClaim = business.billingLifecycleClaims?.[
        BILLING_ACTIONS[jobName].claimField
    ];
    const alreadyTransitioned =
        existingClaim?.periodKey === periodKey &&
        existingClaim?.status === "failed" &&
        ((jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE &&
            business.offlineServiceRestricted === true) ||
        (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE &&
            business.billingStatus === "active" &&
            business.offlineServiceRestricted === false));

    if (!alreadyTransitioned && !isBillingActionDue(jobName, business, now)) {
        return { skipped: true, reason: "action_not_due" };
    }
    if (
        !alreadyTransitioned &&
        getBillingActionPeriodKey(jobName, business) !== periodKey
    ) {
        return { skipped: true, reason: "period_changed" };
    }

    const claimed = alreadyTransitioned
        ? await reclaimTransitionedBillingAction({
            jobName,
            businessId,
            periodKey,
            claimId,
            now,
            businessModel,
        })
        : await claimBillingLifecycleAction({
            jobName,
            business,
            periodKey,
            now,
            businessModel,
            claimId,
        });
    if (!claimed) {
        const latest = await resolveQuery(businessModel.findOne({ businessId }));
        const latestClaim = latest?.billingLifecycleClaims?.[
            BILLING_ACTIONS[jobName].claimField
        ];
        if (
            latestClaim?.periodKey === periodKey &&
            latestClaim?.status === "claimed"
        ) {
            const error = new Error("Billing action has an in-progress claim");
            error.code = "BILLING_CLAIM_IN_PROGRESS";
            throw error;
        }
        return { skipped: true, reason: "already_completed" };
    }

    try {
        const publicConfigChanged =
            (jobName === BILLING_JOB_NAMES.RESTRICT_SERVICE &&
                claimed.offlineServiceRestricted !== true) ||
            (jobName === BILLING_JOB_NAMES.RESTORE_SERVICE &&
                claimed.offlineServiceRestricted === true);
        const transitioned = await applyStateTransition({
            jobName,
            business: claimed,
            periodKey,
            claimId,
            now,
            businessModel,
        });
        if (!transitioned) {
            await markClaimCompleted({
                jobName,
                businessId,
                periodKey,
                claimId,
                now,
                extraFields: {},
                businessModel,
            });
            return { skipped: true, reason: "state_changed" };
        }

        if (publicConfigChanged) {
            await invalidatePublicBusinessConfig(businessId);
        }

        const recipient = getRecipient(transitioned);
        let notificationResult = { queued: false, reason: "recipient_missing" };
        if (recipient) {
            try {
                notificationResult = await sendNotification({
                    jobName: BILLING_EMAIL_JOB_BY_ACTION[jobName],
                    businessId,
                    entityId: periodKey,
                    deliveryVersion: "1",
                    recipient,
                    metadata: {
                        periodKey,
                        invoiceDate: jobName === BILLING_JOB_NAMES.UPCOMING_INVOICE
                            ? getStoredInvoiceVersion(transitioned)?.date
                            : null,
                    },
                });
            } catch (error) {
                // Financial state and the lifecycle claim are authoritative and
                // must remain independent from queue/provider availability.
                console.error("[BillingLifecycle] Billing email dispatch failed", {
                    businessId,
                    jobName,
                    periodKey,
                    reason: error?.code || error?.name || "billing_email_dispatch_failed",
                });
                notificationResult = { queued: false, success: false, reason: "dispatch_failed" };
            }
        }

        await markClaimCompleted({
            jobName,
            businessId,
            periodKey,
            claimId,
            now,
            providerMessageId: null,
            extraFields: {},
            businessModel,
        });
        return {
            success: true,
            skipped: false,
            businessId,
            stage: BILLING_ACTIONS[jobName].stage,
            notified: Boolean(recipient),
            notification: notificationResult,
        };
    } catch (error) {
        await markClaimFailed({
            jobName,
            businessId,
            periodKey,
            claimId,
            error,
            now,
            businessModel,
        }).catch(() => {});
        throw error;
    }
}

export function getBillingCandidateDefinitions(now = new Date()) {
    const today = startOfUtcDay(now);
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const dayAfterTomorrow = new Date(tomorrow.getTime() + DAY_MS);
    const base = {
        stripeSubscriptionId: { $nin: [null, ""] },
        status: { $nin: ["archived", "suspended"] },
    };
    return [
        {
            jobName: BILLING_JOB_NAMES.UPCOMING_INVOICE,
            filter: {
                ...base,
                billingStatus: "active",
                $or: [
                    { nextInvoiceDate: { $gte: tomorrow, $lt: dayAfterTomorrow } },
                    { nextBillingDate: { $gte: tomorrow, $lt: dayAfterTomorrow } },
                    { currentPeriodEnd: { $gte: today, $lt: tomorrow } },
                ],
            },
        },
        {
            jobName: BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_3,
            filter: {
                ...base,
                billingStatus: "past_due",
                billingFailedAt: {
                    $lte: new Date(now.getTime() - 3 * DAY_MS),
                    $gt: new Date(now.getTime() - 5 * DAY_MS),
                },
            },
        },
        {
            jobName: BILLING_JOB_NAMES.OVERDUE_WARNING_DAY_5,
            filter: {
                ...base,
                billingStatus: "past_due",
                billingFailedAt: {
                    $lte: new Date(now.getTime() - 5 * DAY_MS),
                    $gt: new Date(now.getTime() - 7 * DAY_MS),
                },
            },
        },
        {
            jobName: BILLING_JOB_NAMES.RESTRICT_SERVICE,
            filter: {
                ...base,
                billingStatus: "past_due",
                billingFailedAt: { $lte: new Date(now.getTime() - 7 * DAY_MS) },
                offlineServiceRestricted: { $ne: true },
            },
        },
        {
            jobName: BILLING_JOB_NAMES.RESTORE_SERVICE,
            filter: {
                ...base,
                billingStatus: "active",
                offlineServiceRestricted: true,
            },
        },
    ];
}

async function* mongooseCandidates(businessModel, filter, batchSize) {
    const query = businessModel.find(filter).select([
        "businessId",
        "billingStatus",
        "billingFailedAt",
        "nextInvoiceDate",
        "nextBillingDate",
        "currentPeriodEnd",
        "offlineServiceRestricted",
        "offlineServiceRestrictedAt",
        "stripeSubscriptionId",
        "status",
    ]).lean();
    const cursor = query.cursor({ batchSize });
    for await (const business of cursor) yield business;
}

export async function scanBillingLifecycleCandidates({
    now = new Date(),
    businessModel = Business,
    batchSize = SCAN_BATCH_SIZE,
    candidateSource,
    handleCandidate,
    enqueueAction = enqueueBillingJob,
} = {}) {
    const summary = { candidates: 0, queued: 0, completed: 0, failed: 0 };
    const results = [];
    for (const definition of getBillingCandidateDefinitions(now)) {
        const candidates = candidateSource
            ? candidateSource(definition)
            : mongooseCandidates(businessModel, definition.filter, batchSize);
        for await (const business of candidates) {
            const periodKey = getBillingActionPeriodKey(
                definition.jobName,
                business,
            );
            if (!periodKey || !isBillingActionDue(definition.jobName, business, now)) {
                continue;
            }
            summary.candidates += 1;
            try {
                if (handleCandidate) {
                    await handleCandidate({
                        jobName: definition.jobName,
                        businessId: business.businessId,
                        periodKey,
                        now,
                    });
                    summary.completed += 1;
                } else {
                    const queued = await enqueueAction(
                        definition.jobName,
                        { businessId: business.businessId, periodKey },
                    );
                    if (queued?.queued !== false) summary.queued += 1;
                }
                results.push({
                    businessId: business.businessId,
                    jobName: definition.jobName,
                    status: handleCandidate ? "completed" : "queued",
                });
            } catch (error) {
                summary.failed += 1;
                results.push({
                    businessId: business.businessId,
                    jobName: definition.jobName,
                    status: "failed",
                    reason: error?.code || error?.name || "billing_action_failed",
                });
            }
        }
    }
    return { summary, results };
}

export function runBillingLifecycleRecovery(options = {}) {
    const processAction = options.processAction || processBillingLifecycleAction;
    return scanBillingLifecycleCandidates({
        ...options,
        handleCandidate: (action) => processAction({
            ...action,
            businessModel: options.businessModel || Business,
            sendNotification: options.sendNotification || dispatchBillingNotification,
        }),
    });
}
