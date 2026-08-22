import mongoose from "mongoose"

export const WEEKLY_SNAPSHOT_VERSION = 1
export const WEEKLY_INSIGHT_ENGINE_VERSION = 1

export const GENERATION_STATUSES = Object.freeze([
    "pending",
    "snapshot_ready",
    "generating",
    "completed",
    "failed",
])

export const EMAIL_STATUSES = Object.freeze([
    "not_sent",
    "sending",
    "sent",
    "failed",
])

const WeeklyAnalystReportSchema = new mongoose.Schema(
    {
        businessId: {
            type: String,
            required: true,
            index: true,
        },
        periodKey: {
            type: String,
            required: true,
        },
        periodStart: {
            type: String,
            required: true,
        },
        periodEnd: {
            type: String,
            required: true,
        },
        previousPeriodStart: {
            type: String,
            default: null,
        },
        previousPeriodEnd: {
            type: String,
            default: null,
        },
        timezone: {
            type: String,
            required: true,
        },

        snapshotVersion: {
            type: Number,
            default: WEEKLY_SNAPSHOT_VERSION,
        },
        analyticsSnapshot: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        insightEngineVersion: {
            type: Number,
            default: null,
        },
        deterministicInsights: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        generationStatus: {
            type: String,
            enum: GENERATION_STATUSES,
            default: "pending",
            index: true,
        },

        modelProvider: {
            type: String,
            default: null,
        },
        modelVersion: {
            type: String,
            default: null,
        },
        promptVersion: {
            type: String,
            default: null,
        },
        reportVersion: {
            type: String,
            default: null,
        },
        generatedReport: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        generatedAt: {
            type: Date,
            default: null,
        },

        failureCode: {
            type: String,
            default: null,
        },
        failureMessage: {
            type: String,
            default: null,
            maxlength: 500,
        },
        failedAt: {
            type: Date,
            default: null,
        },

        emailStatus: {
            type: String,
            enum: EMAIL_STATUSES,
            default: "not_sent",
        },
        emailSentAt: {
            type: Date,
            default: null,
        },
        emailProviderMessageId: {
            type: String,
            default: null,
        },
        emailErrorCode: {
            type: String,
            default: null,
        },
        emailErrorMessage: {
            type: String,
            default: null,
            maxlength: 500,
        },
    },
    { timestamps: true },
)

// One canonical report per business per ISO week.
WeeklyAnalystReportSchema.index(
    { businessId: 1, periodKey: 1 },
    { unique: true },
)

// Supports latest-report lookup and history ordering.
WeeklyAnalystReportSchema.index(
    { businessId: 1, periodStart: -1 },
)

// Supports status queries.
WeeklyAnalystReportSchema.index(
    { businessId: 1, generationStatus: 1 },
)

export default mongoose.models.WeeklyAnalystReport ||
    mongoose.model("WeeklyAnalystReport", WeeklyAnalystReportSchema)