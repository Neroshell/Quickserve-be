import { createInventoryCompatibilityAdapter } from "./inventoryCompatibilityAdapter.js";
import {
    deductSimpleStockOrder,
    restoreSimpleStockOrder,
    validateSimpleStockOrder,
} from "./simpleStockOrderService.js";

// Phase 2B deliberately routes all order stock work through one mapping-aware,
// transactional strategy. Unmapped items retain MenuItem stock authority while
// active Simple Stock mappings use InventoryItem as their sole authority.
const unifiedSimpleStockStrategy = {
    validateTrackedStock: validateSimpleStockOrder,
    deductTrackedStock: deductSimpleStockOrder,
    restoreTrackedStock: restoreSimpleStockOrder,
};

const productionInventoryCompatibilityAdapter = createInventoryCompatibilityAdapter({
    legacyStrategy: unifiedSimpleStockStrategy,
    canonicalStrategy: unifiedSimpleStockStrategy,
    mixedStrategy: unifiedSimpleStockStrategy,
    isCanonicalSimpleStockEnabled: () => true,
});

export function validateTrackedStock(items, businessId, context = {}) {
    return productionInventoryCompatibilityAdapter.validateTrackedStock(items, businessId, context);
}

export function deductTrackedStock(order, context = {}) {
    return productionInventoryCompatibilityAdapter.deductTrackedStock(order, context);
}

export function restoreTrackedStock(order, context = {}) {
    return productionInventoryCompatibilityAdapter.restoreTrackedStock(order, context);
}
