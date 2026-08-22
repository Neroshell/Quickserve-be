import { AI_ANALYST_JOB_NAMES } from "../../queues/index.js"
import Business from "../../models/Business.js"
import { resolveSubscriptionEntitlements } from "../../services/subscriptionEntitlementService.js"
import { generateWeeklySnapshot } from "../../services/analytics/weeklyAnalystSnapshotService.js"
import { generateWeeklyInsights } from "../../services/analytics/weeklyInsightService.js"
import { upsertSnapshotAndInsights, findReport } from "../../services/weeklyAnalystReportService.js"
import { generateAnalystReportForPeriod, GenerationError } from "../../services/ai/weeklyAnalystGenerationService.js"
import { CloudflareProviderError } from "../../services/ai/cloudflareProvider.js"
import { enqueueAiAnalystGenerate, buildAiAnalystJobId } from "../../queues/aiAnalystQueue.js"

const SCAN_BATCH_SIZE = 200

/**
 * Weekly scan processor.
 *
 * Finds all Growth businesses entitled to aiBusinessAnalyst, determines
 * the most recently completed week for each, and enqueues one generation
 * job per business/week.
 */
export async function processAiAnalystWeeklyScan(job) {
    const startTime = Date.now()
    let cursor = null
    let totalEligible = 0
    let enqueued = 0
    let skipped = 0

    console.log("[ai-analyst-scan] Starting weekly scan")

    while (true) {
        const filter = {}
        if (cursor) {
            filter._id = { $gt: cursor }
        }

        const businesses = await Business.find(
            filter,
            "businessId currentPlan businessType modules timezone",
        )
            .sort({ _id: 1 })
            .limit(SCAN_BATCH_SIZE)
            .lean()

        if (businesses.length === 0) break

        for (const biz of businesses) {
            const entitlements = resolveSubscriptionEntitlements(biz)
            if (!entitlements.aiBusinessAnalyst) continue

            totalEligible++

            // Determine the canonical completed week
            let snapshot
            try {
                snapshot = await generateWeeklySnapshot({
                    businessId: biz.businessId,
                })
            } catch (err) {
                console.warn(
                    `[ai-analyst-scan] Snapshot failed for ${biz.businessId}: ${err.message}`,
                )
                continue
            }

            const periodKey = snapshot.period.key
            const jobId = buildAiAnalystJobId(biz.businessId, periodKey)

            // Check if already exists
            const existing = await findReport(biz.businessId, periodKey)
            if (existing?.generationStatus === "completed") {
                skipped++
                continue
            }

            // Enqueue generation job
            try {
                await enqueueAiAnalystGenerate({
                    businessId: biz.businessId,
                    periodKey,
                })
                enqueued++
            } catch (err) {
                if (err.message?.includes?.("jobId") && err.message?.includes?.("exist")) {
                    skipped++
                } else {
                    console.warn(
                        `[ai-analyst-scan] Enqueue failed for ${biz.businessId}/${periodKey}: ${err.message}`,
                    )
                }
            }
        }

        cursor = businesses[businesses.length - 1]._id
    }

    const duration = Date.now() - startTime
    console.log(
        `[ai-analyst-scan] Complete: ${totalEligible} eligible, ${enqueued} enqueued, ${skipped} skipped, ${duration}ms`,
    )

    return { totalEligible, enqueued, skipped, duration }
}

/**
 * Generation job processor.
 *
 * Runs the full Phase 1→2→3→4 pipeline for one business/week.
 * Idempotent via deterministic job ID and generation state guards.
 */
export async function processAiAnalystGenerate(job) {
    const { businessId, periodKey } = job.data
    const startTime = Date.now()

    console.log(`[ai-analyst-generate] Starting ${businessId}/${periodKey}`)

    try {
        // 1. Load business + validate eligibility
        const biz = await Business.findOne({ businessId }).lean()
        if (!biz) {
            throw new GenerationError("Business not found", {
                code: "business_not_found",
                retryable: false,
            })
        }

        const entitlements = resolveSubscriptionEntitlements(biz)
        if (!entitlements.aiBusinessAnalyst) {
            throw new GenerationError("Business not entitled to AI Analyst", {
                code: "not_entitled",
                retryable: false,
            })
        }

        // 2. Check if already completed
        const existing = await findReport(businessId, periodKey)
        if (existing?.generationStatus === "completed") {
            console.log(
                `[ai-analyst-generate] ${businessId}/${periodKey} already completed — skipping`,
            )
            return { status: "already_completed" }
        }

        // 3. Generate snapshot
        const snapshot = await generateWeeklySnapshot({
            businessId,
            periodStart: existing?.periodStart,
            periodEnd: existing?.periodEnd,
        })

        // 4. Generate insights
        const insightResult = generateWeeklyInsights(snapshot)

        // 5. Upsert snapshot + insights
        await upsertSnapshotAndInsights({
            businessId,
            period: snapshot.period,
            snapshot,
            insights: insightResult,
        })

        // 6. Generate AI report (handles insufficient-data/stable-week shortcuts internally)
        const result = await generateAnalystReportForPeriod({
            businessId,
            periodKey: snapshot.period.key,
        })

        const duration = Date.now() - startTime
        console.log(
            `[ai-analyst-generate] ${businessId}/${periodKey} completed: status=${result.generationStatus}, model=${result.modelProvider}, ${duration}ms`,
        )

        return {
            status: result.generationStatus,
            modelProvider: result.modelProvider,
            duration,
        }
    } catch (err) {
        const duration = Date.now() - startTime

        if (err instanceof GenerationError) {
            console.error(
                `[ai-analyst-generate] ${businessId}/${periodKey} failed: code=${err.code}, retryable=${err.retryable}, ${duration}ms`,
            )
            if (err.retryable) {
                throw err // BullMQ will retry
            }
            // Non-retryable — discard
            return {
                status: "failed",
                code: err.code,
                retryable: false,
                duration,
            }
        }

        if (err instanceof CloudflareProviderError) {
            console.error(
                `[ai-analyst-generate] ${businessId}/${periodKey} provider error: code=${err.code}, retryable=${err.retryable}, ${duration}ms`,
            )
            if (err.retryable) {
                throw err
            }
            return {
                status: "failed",
                code: err.code,
                retryable: false,
                duration,
            }
        }

        console.error(
            `[ai-analyst-generate] ${businessId}/${periodKey} unexpected error: ${err.message}`,
        )
        throw err // Retry unknown errors
    }
}

/**
 * Job router — dispatches to the correct processor based on job name.
 * This is the function registered as the BullMQ worker processor.
 */
export async function processAiAnalystJob(job) {
    switch (job.name) {
        case AI_ANALYST_JOB_NAMES.WEEKLY_SCAN:
            return processAiAnalystWeeklyScan(job)
        case AI_ANALYST_JOB_NAMES.GENERATE_REPORT:
            return processAiAnalystGenerate(job)
        default:
            throw new Error(`Unknown AI analyst job: ${job.name}`)
    }
}