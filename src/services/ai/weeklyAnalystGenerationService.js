import { AI_ANALYST_OUTPUT_SCHEMA, AI_ANALYST_SYSTEM_PROMPT, AI_ANALYST_PROMPT_VERSION } from "./aiPromptV5.js"
import { buildV5EvidencePack } from "./aiPayloadBuilderV5.js"
import { generateStructuredReport, CloudflareProviderError } from "./cloudflareProvider.js"
import { buildInsufficientDataReport, buildStableWeekReport } from "./aiReportValidator.js"
import WeeklyAnalystReport from "../../models/WeeklyAnalystReport.js"

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
                failureReason: { code, message, failedAt: new Date() },
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
                reportVersion: result.reportVersion || "5",
                failureReason: null,
            },
        }
    )
    return await WeeklyAnalystReport.findOne({ businessId, periodKey })
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
            return await markCompleted(businessId, periodKey, {
                generatedReport: buildInsufficientDataReport(),
                modelProvider: "deterministic",
                modelVersion: null,
                promptVersion: AI_ANALYST_PROMPT_VERSION,
                reportVersion: "5"
            })
        }

        if (insights?.noSignificantInsights) {
            return await markCompleted(businessId, periodKey, {
                generatedReport: buildStableWeekReport(),
                modelProvider: "deterministic",
                modelVersion: null,
                promptVersion: AI_ANALYST_PROMPT_VERSION,
                reportVersion: "5"
            })
        }

        const evidencePack = buildV5EvidencePack(snapshot)

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

        const assembledReport = aiResult.content

        return await markCompleted(businessId, periodKey, {
            generatedReport: assembledReport,
            modelProvider: "cloudflare",
            modelVersion: aiResult.model,
            promptVersion: AI_ANALYST_PROMPT_VERSION,
            reportVersion: "5"
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