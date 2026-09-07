import {
    AI_ANALYST_OUTPUT_SCHEMA,
    AI_ANALYST_SYSTEM_PROMPT,
    AI_ANALYST_PROMPT_VERSION,
    AI_ANALYST_REPORT_VERSION,
} from "./aiPromptV5.js"
import { buildV5EvidencePack } from "./aiPayloadBuilderV5.js"
import { generateStructuredReport, CloudflareProviderError } from "./cloudflareProvider.js"
import {
    buildInsufficientDataReport,
    buildStableWeekReport,
    ReportValidationError,
    validateGeneratedReport,
} from "./aiReportValidator.js"
import WeeklyAnalystReport from "../../models/WeeklyAnalystReport.js"
import { normalizeBusinessHealth } from "./businessHealthNormalizer.js"

export class GenerationError extends Error {
    constructor(message, { code = "generation_failed", retryable = false } = {}) {
        super(message)
        this.name = "GenerationError"
        this.code = code
        this.retryable = retryable
    }
}

async function markFailed(businessId, periodKey, { code, message }) {
    console.error(`V5 GENERATION FAILED for ${businessId} ${periodKey}: ${message}`)
    
    try {
        const lastValid = await WeeklyAnalystReport.findOne({ 
            businessId, 
            periodKey: { $ne: periodKey }, 
            generationStatus: "completed" 
        }).sort({ createdAt: -1 })
        
        console.error(`LAST VALID REPORT VERSION: ${lastValid?.reportVersion || 'None'}`)
    } catch (e) {
        console.error("Could not fetch last valid report for logging", e)
    }

    await WeeklyAnalystReport.updateOne(
        { businessId, periodKey },
        {
            $set: {
                generationStatus: "failed",
                failureCode: String(code || "generation_failed").slice(0, 100),
                failureMessage: String(message || "").slice(0, 500),
                failedAt: new Date(),
            },
        }
    )
}

async function markCompleted(businessId, periodKey, result) {
    await WeeklyAnalystReport.updateOne(
        { businessId, periodKey },
        {
            $set: {
                generationStatus: "completed",
                generatedReport: result.generatedReport,
                generatedAt: new Date(),
                modelProvider: result.modelProvider,
                modelVersion: result.modelVersion,
                promptVersion: result.promptVersion,
                reportVersion: result.reportVersion || AI_ANALYST_REPORT_VERSION,
                aiUsage: result.aiUsage || null,
                failureCode: null,
                failureMessage: null,
                failedAt: null,
            },
        }
    )
    return await WeeklyAnalystReport.findOne({ businessId, periodKey })
}

export function buildRecentThemeSummary(previousReport, currentInsights) {
    if (!previousReport) return null
    const previousDominant =
        previousReport.deterministicInsights?.dominantSignal ||
        previousReport.deterministicInsights?.insights?.[0] ||
        null
    const currentDominant =
        currentInsights?.dominantSignal || currentInsights?.insights?.[0] || null

    return {
        previousHeadline: previousReport.generatedReport?.headline || null,
        previousTopPriorityDomain: previousDominant?.category || null,
        previousDominantIssueKey: previousDominant?.id || null,
        sameDominantIssue: Boolean(
            previousDominant?.id &&
            currentDominant?.id &&
            previousDominant.id === currentDominant.id,
        ),
    }
}

async function loadRecentTheme(doc, insights) {
    const query = WeeklyAnalystReport.findOne(
        {
            businessId: doc.businessId,
            generationStatus: "completed",
            periodStart: { $lt: doc.periodStart },
        },
        "generatedReport.headline deterministicInsights periodStart",
    ).sort({ periodStart: -1 })
    const previous = typeof query?.lean === "function" ? await query.lean() : await query
    return buildRecentThemeSummary(previous, insights)
}

function normalizedUsage(usage) {
    if (!usage) return null
    const token = (value) => Number.isInteger(value) && value >= 0 ? value : null
    return {
        inputTokens: token(usage.inputTokens),
        outputTokens: token(usage.outputTokens),
        totalTokens: token(usage.totalTokens),
    }
}

export async function generateAnalystReportForPeriod({
    businessId,
    periodKey,
    providerOverrides = {},
}) {
    const doc = await WeeklyAnalystReport.findOne({ businessId, periodKey })
    
    if (!doc) {
        throw new GenerationError("Report document not found", { code: "not_found" })
    }
    
    const { analyticsSnapshot: snapshot, deterministicInsights: insights } = doc

    if (!snapshot || !insights) {
        throw new GenerationError("Missing prerequisites for generation", { code: "missing_prerequisites" })
    }

    try {
        await WeeklyAnalystReport.updateOne({ businessId, periodKey }, { $set: { generationStatus: "generating" } })

        if (insights?.insufficientData) {
            const fallback = validateGeneratedReport(buildInsufficientDataReport())
            return await markCompleted(businessId, periodKey, {
                generatedReport: fallback,
                modelProvider: "deterministic",
                modelVersion: null,
                promptVersion: AI_ANALYST_PROMPT_VERSION,
                reportVersion: AI_ANALYST_REPORT_VERSION,
            })
        }

        if (insights?.noSignificantInsights) {
            const fallback = validateGeneratedReport(buildStableWeekReport())
            return await markCompleted(businessId, periodKey, {
                generatedReport: fallback,
                modelProvider: "deterministic",
                modelVersion: null,
                promptVersion: AI_ANALYST_PROMPT_VERSION,
                reportVersion: AI_ANALYST_REPORT_VERSION,
            })
        }

        const recentTheme = await loadRecentTheme(doc, insights)
        const evidencePack = buildV5EvidencePack(snapshot, {
            deterministicInsights: insights,
            recentTheme,
        })

        let aiResult
        try {
            aiResult = await generateStructuredReport({
                systemPrompt: AI_ANALYST_SYSTEM_PROMPT,
                userPayload: evidencePack,
                responseSchema: AI_ANALYST_OUTPUT_SCHEMA,
                overrides: {
                    ...providerOverrides,
                    timeoutMs: 120_000,
                    maxTokens: 4096,
                },
            })
        } catch (err) {
            if (err instanceof CloudflareProviderError) {
                await markFailed(businessId, periodKey, { code: err.code, message: err.message })
                throw new GenerationError(err.message, { code: err.code, retryable: err.retryable })
            }
            throw err
        }

        let assembledReport
        try {
            const validatedProviderReport = validateGeneratedReport(aiResult.content)
            assembledReport = normalizeBusinessHealth(
                validatedProviderReport,
                insights,
                snapshot,
            )
            validateGeneratedReport(assembledReport)
        } catch (error) {
            if (!(error instanceof ReportValidationError)) throw error
            await markFailed(businessId, periodKey, {
                code: error.code,
                message: `${error.message}: ${(error.details || []).join("; ")}`,
            })
            throw new GenerationError(error.message, {
                code: error.code,
                retryable: true,
            })
        }

        return await markCompleted(businessId, periodKey, {
            generatedReport: assembledReport,
            modelProvider: "cloudflare",
            modelVersion: aiResult.model,
            promptVersion: AI_ANALYST_PROMPT_VERSION,
            reportVersion: AI_ANALYST_REPORT_VERSION,
            aiUsage: normalizedUsage(aiResult.usage),
        })
    } catch (err) {
        if (err instanceof GenerationError && !err.retryable) {
            // Already handled
        } else if (!(err instanceof GenerationError)) {
            await markFailed(businessId, periodKey, {
                code: "generation_error",
                message: String(err.message).slice(0, 500),
            }).catch(() => { })
        }
        throw err
    }
}

export default { generateAnalystReportForPeriod, GenerationError }
