import { ORDER_INVENTORY_SEMANTICS } from "../constants/orderInventory.js"
import { resolveOrderRestorationAuthority } from "./orderInventorySemanticsService.js"

export class InventoryCompatibilityError extends Error {
    constructor(message, code = "INVENTORY_COMPATIBILITY_ERROR") {
        super(message)
        this.name = "InventoryCompatibilityError"
        this.code = code
        this.statusCode = 500
    }
}

function requiredStrategyFunction(strategy, name) {
    const fn = strategy?.[name]
    if (typeof fn !== "function") {
        throw new InventoryCompatibilityError(
            `Inventory compatibility strategy is missing ${name}`,
            "INVENTORY_COMPATIBILITY_STRATEGY_MISSING",
        )
    }
    return fn
}

/**
 * Phase 2A installs this boundary in dark mode. Production validation and
 * deduction stay on the supplied legacy strategy until Phase 2B provides a
 * canonical mapping-aware strategy and deliberately enables cutover.
 *
 * Restoration is different: once an Order records canonical/mixed semantics,
 * its immutable linkage decides the restoring system even if new cutovers are
 * disabled. Mixed restoration has its own strategy because it must dispatch
 * each recorded line to its original authority. Current mapping state is never
 * consulted for this decision.
 */
export function createInventoryCompatibilityAdapter({
    legacyStrategy,
    canonicalStrategy = null,
    mixedStrategy = null,
    isCanonicalSimpleStockEnabled = () => false,
}) {
    const legacyValidate = requiredStrategyFunction(legacyStrategy, "validateTrackedStock")
    const legacyDeduct = requiredStrategyFunction(legacyStrategy, "deductTrackedStock")
    const legacyRestore = requiredStrategyFunction(legacyStrategy, "restoreTrackedStock")

    return Object.freeze({
        async validateTrackedStock(items, businessId, context = {}) {
            if (!isCanonicalSimpleStockEnabled(context)) {
                return legacyValidate(items, businessId, context)
            }
            const canonicalValidate = requiredStrategyFunction(
                canonicalStrategy,
                "validateTrackedStock",
            )
            return canonicalValidate(items, businessId, context)
        },

        async deductTrackedStock(order, context = {}) {
            if (!isCanonicalSimpleStockEnabled(context)) {
                return legacyDeduct(order, context)
            }
            const canonicalDeduct = requiredStrategyFunction(
                canonicalStrategy,
                "deductTrackedStock",
            )
            return canonicalDeduct(order, context)
        },

        async restoreTrackedStock(order, context = {}) {
            const semantics = resolveOrderRestorationAuthority(order)
            if (semantics.version === ORDER_INVENTORY_SEMANTICS.LEGACY_MENU_STOCK_V1) {
                return legacyRestore(order, { ...context, semantics })
            }
            if (semantics.version === ORDER_INVENTORY_SEMANTICS.MIXED_BRIDGE_V1) {
                const mixedRestore = requiredStrategyFunction(
                    mixedStrategy,
                    "restoreTrackedStock",
                )
                return mixedRestore(order, { ...context, semantics })
            }
            const canonicalRestore = requiredStrategyFunction(
                canonicalStrategy,
                "restoreTrackedStock",
            )
            return canonicalRestore(order, { ...context, semantics })
        },
    })
}
