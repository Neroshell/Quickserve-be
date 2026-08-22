/**
 * AI report validator & fallback report builders.
 *
 * Provides default report structures for data-sufficiency edge cases
 * (e.g. insufficient data, stable week with no insights).
 */

import { AI_ANALYST_OUTPUT_SCHEMA } from "./aiPromptV5.js"

export class ReportValidationError extends Error {
    constructor(message, { code = "validation_failed", details = null } = {}) {
        super(message)
        this.name = "ReportValidationError"
        this.code = code
        this.details = details
    }
}

/**
 * Fallback report when the business has insufficient data.
 */
export function buildInsufficientDataReport() {
    return {
        headline: "Insufficient Data for Analysis",
        executiveSummary: "QuickServe does not yet have enough weekly activity to produce a reliable business briefing. As order, visit, and operational volume grows, Mayor will unlock deeper whole-business analysis.",
        businessHealth: [
            {
                area: "Data Volume",
                status: "Insufficient data",
                explanation: "Additional orders and customer visits are required to establish an analytical baseline."
            }
        ],
        priorities: [],
        workingWell: [],
        opportunities: [],
        watchNextWeek: [
            {
                title: "Transaction Volume",
                reason: "Monitor weekly order count to establish analytical baseline",
                metric: "sales.transactionCount"
            }
        ]
    }
}

/**
 * Fallback report when the week is steady with no significant anomalies.
 */
export function buildStableWeekReport() {
    return {
        headline: "Consistent and Stable Weekly Performance",
        executiveSummary: "This was a steady week with no material operational spikes or deteriorations across sales, operations, or service. Business performance remained consistent week-over-week.",
        businessHealth: [
            {
                area: "Overall Performance",
                status: "Stable",
                explanation: "Key metrics across sales, operations, and service are consistent week-over-week."
            }
        ],
        priorities: [],
        workingWell: [
            {
                title: "Operational Consistency",
                explanation: "Core metrics remained stable without operational degradation."
            }
        ],
        opportunities: [],
        watchNextWeek: []
    }
}

export default {
    buildInsufficientDataReport,
    buildStableWeekReport,
    ReportValidationError,
}