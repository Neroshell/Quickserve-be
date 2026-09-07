import assert from "node:assert/strict"
import test from "node:test"

import WeeklyAnalystReport from "../src/models/WeeklyAnalystReport.js"
import {
    AI_ANALYST_OUTPUT_SCHEMA,
    AI_ANALYST_PROMPT_VERSION,
    AI_ANALYST_REPORT_VERSION,
} from "../src/services/ai/aiPromptV5.js"
import {
    ReportValidationError,
    validateGeneratedReport,
} from "../src/services/ai/aiReportValidator.js"
import {
    GenerationError,
    generateAnalystReportForPeriod,
} from "../src/services/ai/weeklyAnalystGenerationService.js"
import {
    CloudflareProviderError,
    generateStructuredReport,
} from "../src/services/ai/cloudflareProvider.js"

function validReport() {
    return {
        headline: "Guest satisfaction became the most important story this week",
        executiveSummary: "Guest feedback changed materially this week, making customer experience the clearest issue to address. The evidence is based on enough reviews to compare with the previous period, while sales and operational measures remained less significant. You should review the low-rating pattern and check the service moments that can be verified from your operational records. The data shows an association, not a proven cause, so avoid assuming that one team or menu item created the change. Next week, watch average rating and the share of one- and two-star reviews to see whether the decline continues or begins to recover.",
        businessHealth: [{
            area: "Customer feedback",
            status: "Watch",
            explanation: "Guest ratings declined enough to deserve attention.",
        }],
        priorities: [{
            rank: 1,
            title: "Review lower guest ratings",
            finding: "Guest ratings declined compared with last week.",
            evidence: "Average rating fell from 4.2 to 2.8 across 20 reviews.",
            whyItMatters: "Lower satisfaction can weaken repeat visits.",
            possibleExplanations: "The available data does not prove the cause yet.",
            recommendedAction: "Review the service records associated with low-rating days.",
            watchNextWeek: "Average rating and low-rating share.",
        }],
        workingWell: [],
        opportunities: [],
        watchNextWeek: [{
            title: "Guest rating",
            reason: "Another week will show whether the decline continues.",
            metric: "feedback.current.averageRating",
        }],
    }
}

test("authoritative V5.4 schema accepts valid output", () => {
    assert.equal(AI_ANALYST_OUTPUT_SCHEMA.name, "weekly_analyst_report_v5_4")
    assert.equal(validateGeneratedReport(validReport()).headline, validReport().headline)
})

test("runtime validation rejects malformed structures and unsupported values", () => {
    assert.throws(
        () => validateGeneratedReport({}),
        (error) => error instanceof ReportValidationError && error.code === "invalid_v5_report",
    )

    const unsupportedStatus = validReport()
    unsupportedStatus.businessHealth[0].status = "Excellent"
    assert.throws(() => validateGeneratedReport(unsupportedStatus), ReportValidationError)

    const excessivePriorities = validReport()
    excessivePriorities.priorities = Array.from({ length: 5 }, (_, index) => ({
        ...validReport().priorities[0],
        rank: Math.min(index + 1, 4),
    }))
    assert.throws(() => validateGeneratedReport(excessivePriorities), ReportValidationError)

    const extraField = validReport()
    extraField.untrusted = true
    assert.throws(() => validateGeneratedReport(extraField), ReportValidationError)

    const duplicateRanks = validReport()
    duplicateRanks.priorities.push({ ...duplicateRanks.priorities[0] })
    assert.throws(() => validateGeneratedReport(duplicateRanks), ReportValidationError)
})

test("Cloudflare provider rejects malformed JSON before report validation", async () => {
    const originalFetch = global.fetch
    try {
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                result: {
                    choices: [{ message: { content: "{not-json" } }],
                },
            }),
        })
        await assert.rejects(
            () => generateStructuredReport({
                systemPrompt: "test",
                userPayload: {},
                responseSchema: AI_ANALYST_OUTPUT_SCHEMA,
                overrides: { accountId: "test", apiToken: "test" },
            }),
            (error) => error instanceof CloudflareProviderError && error.code === "invalid_json",
        )
    } finally {
        global.fetch = originalFetch
    }
})

function queryResult(value) {
    return {
        sort() { return this },
        lean() { return Promise.resolve(value) },
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) },
    }
}

test("invalid provider output is failed before final persistence", async () => {
    const originalFindOne = WeeklyAnalystReport.findOne
    const originalUpdateOne = WeeklyAnalystReport.updateOne
    const originalFetch = global.fetch
    const updates = []
    const reportDocument = {
        businessId: "biz_runtime",
        periodKey: "2026-W35",
        periodStart: "2026-08-24",
        analyticsSnapshot: {
            schemaVersion: 2,
            period: { start: "2026-08-24", end: "2026-08-30", timezone: "UTC" },
            business: { businessType: "restaurant", currency: "EUR", modules: ["foodService"] },
            sales: { transactionCount: 20, revenueByDay: [] },
        },
        deterministicInsights: {
            insights: [{
                id: "feedback_rating_decline",
                category: "feedback",
                type: "warning",
                priority: "high",
                impact: "high",
                confidence: "high",
                priorityScore: 80,
                evidence: {},
            }],
            dominantSignal: { id: "feedback_rating_decline", category: "feedback" },
            crossDomainSignals: [],
            insufficientData: false,
            noSignificantInsights: false,
        },
    }

    try {
        WeeklyAnalystReport.findOne = (filter) => {
            if (filter.periodKey === "2026-W35") return queryResult(reportDocument)
            return queryResult(null)
        }
        WeeklyAnalystReport.updateOne = async (filter, update) => {
            updates.push({ filter, update })
            return { acknowledged: true }
        }
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                result: {
                    model: "test-model",
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                    choices: [{ message: { content: JSON.stringify({ headline: "Incomplete" }) } }],
                },
            }),
        })

        await assert.rejects(
            () => generateAnalystReportForPeriod({
                businessId: "biz_runtime",
                periodKey: "2026-W35",
                providerOverrides: { accountId: "test", apiToken: "test" },
            }),
            (error) => error instanceof GenerationError && error.code === "invalid_v5_report",
        )

        assert.ok(updates.some(({ update }) => update.$set?.generationStatus === "failed"))
        assert.ok(!updates.some(({ update }) => update.$set?.generationStatus === "completed"))
    } finally {
        WeeklyAnalystReport.findOne = originalFindOne
        WeeklyAnalystReport.updateOne = originalUpdateOne
        global.fetch = originalFetch
    }
})

test("valid provider output persists V5.4 metadata and usage", async () => {
    const originalFindOne = WeeklyAnalystReport.findOne
    const originalUpdateOne = WeeklyAnalystReport.updateOne
    const originalFetch = global.fetch
    const updates = []
    const reportDocument = {
        businessId: "biz_usage",
        periodKey: "2026-W35",
        periodStart: "2026-08-24",
        analyticsSnapshot: {
            schemaVersion: 2,
            period: { start: "2026-08-24", end: "2026-08-30", timezone: "UTC" },
            business: { businessType: "restaurant", currency: "EUR", modules: ["foodService"] },
            sales: { transactionCount: 20, revenueByDay: [] },
            feedback: { current: { reviewCount: 20, averageRating: 2.8 } },
        },
        deterministicInsights: {
            insights: [{
                id: "feedback_rating_decline",
                category: "feedback",
                type: "warning",
                priority: "high",
                impact: "high",
                confidence: "high",
                priorityScore: 80,
                evidence: {},
            }],
            dominantSignal: { id: "feedback_rating_decline", category: "feedback" },
            crossDomainSignals: [],
            insufficientData: false,
            noSignificantInsights: false,
        },
    }

    try {
        WeeklyAnalystReport.findOne = (filter) => {
            if (filter.periodKey === "2026-W35") return queryResult(reportDocument)
            if (filter.generationStatus === "completed") return queryResult(null)
            return queryResult({ generationStatus: "completed" })
        }
        WeeklyAnalystReport.updateOne = async (filter, update) => {
            updates.push({ filter, update })
            return { acknowledged: true }
        }
        global.fetch = async () => ({
            ok: true,
            json: async () => ({
                result: {
                    model: "test-model",
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                    choices: [{ message: { content: JSON.stringify(validReport()) } }],
                },
            }),
        })

        await generateAnalystReportForPeriod({
            businessId: "biz_usage",
            periodKey: "2026-W35",
            providerOverrides: { accountId: "test", apiToken: "test" },
        })

        const completed = updates.find(({ update }) => update.$set?.generationStatus === "completed")
        assert.ok(completed)
        assert.equal(completed.update.$set.promptVersion, AI_ANALYST_PROMPT_VERSION)
        assert.equal(completed.update.$set.reportVersion, AI_ANALYST_REPORT_VERSION)
        assert.deepEqual(completed.update.$set.aiUsage, {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
        })
    } finally {
        WeeklyAnalystReport.findOne = originalFindOne
        WeeklyAnalystReport.updateOne = originalUpdateOne
        global.fetch = originalFetch
    }
})

test("stable deterministic fallback remains provider-free and runtime-valid", async () => {
    const originalFindOne = WeeklyAnalystReport.findOne
    const originalUpdateOne = WeeklyAnalystReport.updateOne
    const originalFetch = global.fetch
    const updates = []
    const reportDocument = {
        businessId: "biz_stable",
        periodKey: "2026-W35",
        periodStart: "2026-08-24",
        analyticsSnapshot: { schemaVersion: 2 },
        deterministicInsights: {
            insights: [],
            dominantSignal: null,
            crossDomainSignals: [],
            insufficientData: false,
            noSignificantInsights: true,
        },
    }

    try {
        WeeklyAnalystReport.findOne = () => queryResult(reportDocument)
        WeeklyAnalystReport.updateOne = async (filter, update) => {
            updates.push({ filter, update })
            return { acknowledged: true }
        }
        global.fetch = async () => {
            throw new Error("Provider must not be called for a stable week")
        }

        await generateAnalystReportForPeriod({
            businessId: "biz_stable",
            periodKey: "2026-W35",
        })

        const completed = updates.find(({ update }) => update.$set?.generationStatus === "completed")
        assert.equal(completed.update.$set.modelProvider, "deterministic")
        assert.equal(completed.update.$set.reportVersion, AI_ANALYST_REPORT_VERSION)
        validateGeneratedReport(completed.update.$set.generatedReport)
    } finally {
        WeeklyAnalystReport.findOne = originalFindOne
        WeeklyAnalystReport.updateOne = originalUpdateOne
        global.fetch = originalFetch
    }
})
