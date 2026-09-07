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

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateNode(value, schema, path, errors) {
    if (!schema || errors.length >= 20) return

    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${path} must be one of: ${schema.enum.join(", ")}`)
        return
    }

    if (schema.type === "object") {
        if (!isPlainObject(value)) {
            errors.push(`${path} must be an object`)
            return
        }
        const properties = schema.properties || {}
        for (const requiredKey of schema.required || []) {
            if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
                errors.push(`${path}.${requiredKey} is required`)
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                    errors.push(`${path}.${key} is not supported`)
                }
            }
        }
        for (const [key, childSchema] of Object.entries(properties)) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                validateNode(value[key], childSchema, `${path}.${key}`, errors)
            }
        }
        return
    }

    if (schema.type === "array") {
        if (!Array.isArray(value)) {
            errors.push(`${path} must be an array`)
            return
        }
        if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
            errors.push(`${path} must contain at least ${schema.minItems} items`)
        }
        if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
            errors.push(`${path} must contain at most ${schema.maxItems} items`)
        }
        value.forEach((entry, index) => {
            validateNode(entry, schema.items, `${path}[${index}]`, errors)
        })
        return
    }

    if (schema.type === "string") {
        if (typeof value !== "string") {
            errors.push(`${path} must be a string`)
            return
        }
        if (Number.isInteger(schema.minLength) && value.trim().length < schema.minLength) {
            errors.push(`${path} is required`)
        }
        if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
            errors.push(`${path} exceeds ${schema.maxLength} characters`)
        }
        return
    }

    if (schema.type === "integer") {
        if (!Number.isInteger(value)) {
            errors.push(`${path} must be an integer`)
            return
        }
        if (Number.isFinite(schema.minimum) && value < schema.minimum) {
            errors.push(`${path} must be at least ${schema.minimum}`)
        }
        if (Number.isFinite(schema.maximum) && value > schema.maximum) {
            errors.push(`${path} must be at most ${schema.maximum}`)
        }
    }
}

/**
 * Validate parsed provider output against the same authoritative JSON Schema
 * sent to Cloudflare. Invalid output is rejected; it is never truncated or
 * persisted as a completed report.
 */
export function validateGeneratedReport(
    report,
    responseSchema = AI_ANALYST_OUTPUT_SCHEMA,
) {
    const errors = []
    validateNode(report, responseSchema?.schema, "$", errors)

    if (Array.isArray(report?.priorities)) {
        const ranks = report.priorities.map((priority) => priority?.rank)
        if (new Set(ranks).size !== ranks.length) {
            errors.push("$.priorities ranks must be unique")
        }
    }

    if (errors.length > 0) {
        throw new ReportValidationError("Generated report failed V5 runtime validation", {
            code: "invalid_v5_report",
            details: errors,
        })
    }
    return report
}

/**
 * Fallback report when the business has insufficient data.
 */
export function buildInsufficientDataReport() {
    return {
        headline: "Insufficient Data for Analysis",
        executiveSummary: "QuickServe does not yet have enough weekly activity to produce a reliable business briefing. As order, visit, feedback, and operational inventory activity grows, Mayor will unlock deeper whole-business analysis.",
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
        executiveSummary: "This was a steady week with no material changes across the business domains that had enough evidence to assess. Sales, customers, service, feedback, and inventory signals stayed within the configured thresholds, so there is no single issue that requires immediate action.",
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
    validateGeneratedReport,
    buildInsufficientDataReport,
    buildStableWeekReport,
    ReportValidationError,
}
