import Business from "../../models/Business.js"
import { resolveBusinessCapabilities } from "../businessCapabilityService.js"
import {
    resolveAnalyticsDomainRanges,
    toAnalyticsDomainRangeContract,
} from "./analyticsRangeService.js"
import { getFoodServiceAnalytics } from "./foodServiceAnalyticsService.js"
import { getLodgingAnalytics } from "./lodgingAnalyticsService.js"
import { getSharedAnalytics } from "./sharedAnalyticsService.js"

const ANALYTICS_MODULE_IDS = new Set([
    "foodService",
    "lodging",
])

export class OwnerAnalyticsServiceError extends Error {
    constructor(message, statusCode = 500) {
        super(message)
        this.name = "OwnerAnalyticsServiceError"
        this.statusCode = statusCode
    }
}

function getBusinessCurrency(business) {
    const currency =
        typeof business?.currency === "string"
            ? business.currency.trim().toUpperCase()
            : ""
    if (!currency) {
        throw new OwnerAnalyticsServiceError(
            "Business currency is not configured"
        )
    }
    return currency
}

async function loadBusiness(businessModel, businessId) {
    const query = businessModel.findOne(
        { businessId },
        "businessId businessType modules timezone currency hotelSettings"
    )
    return typeof query?.lean === "function"
        ? query.lean()
        : query
}

export function createOwnerAnalyticsService({
    businessModel = Business,
    capabilityResolver = resolveBusinessCapabilities,
    rangeResolver = resolveAnalyticsDomainRanges,
    rangeContractSerializer = toAnalyticsDomainRangeContract,
    sharedAnalytics = getSharedAnalytics,
    foodServiceAnalytics = getFoodServiceAnalytics,
    lodgingAnalytics = getLodgingAnalytics,
    clock = () => new Date(),
} = {}) {
    return async function ownerAnalyticsService({
        businessId,
        range = "today",
        from,
        to,
    }) {
        const business = await loadBusiness(
            businessModel,
            businessId
        )
        if (!business) {
            throw new OwnerAnalyticsServiceError(
                "Business not found",
                404
            )
        }

        const capabilities = capabilityResolver(business)
        const enabledAnalyticsModules =
            capabilities.analytics.sections.filter((moduleId) =>
                ANALYTICS_MODULE_IDS.has(moduleId)
            )
        const generatedAt = clock()
        const domainRanges = rangeResolver({
            preset: range,
            from,
            to,
            timezone: business.timezone,
            now: generatedAt,
            business,
        })
        const response = {
            contractVersion: 2,
            range: rangeContractSerializer(domainRanges),
            currency: getBusinessCurrency(business),
            generatedAt: generatedAt.toISOString(),
            enabledAnalyticsModules,
            modules: {},
        }

        if (enabledAnalyticsModules.length === 0) {
            return response
        }

        const {
            shared,
            foodServiceFinancials,
            lodgingFinancials,
        } =
            await sharedAnalytics({
                businessId,
                enabledAnalyticsModules,
                foodOperationalRange:
                    domainRanges.foodOperationalRange,
                lodgingCalendarRange:
                    domainRanges.lodgingCalendarRange,
            })
        const moduleEntries = await Promise.all(
            enabledAnalyticsModules.map(async (moduleId) => {
                if (moduleId === "foodService") {
                    return [
                        moduleId,
                        await foodServiceAnalytics({
                            businessId,
                            analyticsRange:
                                domainRanges.foodOperationalRange,
                            financials:
                                foodServiceFinancials,
                        }),
                    ]
                }

                return [
                    moduleId,
                    await lodgingAnalytics({
                        businessId,
                        analyticsRange:
                            domainRanges.lodgingCalendarRange,
                        financials: lodgingFinancials,
                        generatedAt,
                        hotelSettings:
                            business.hotelSettings || {},
                    }),
                ]
            })
        )

        return {
            ...response,
            shared,
            modules: Object.fromEntries(moduleEntries),
        }
    }
}

export const ownerAnalyticsService = createOwnerAnalyticsService()
