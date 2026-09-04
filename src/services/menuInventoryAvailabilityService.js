import {
    MENU_INVENTORY_MAPPING_STATUSES,
    MENU_INVENTORY_MODES,
    MENU_INVENTORY_TRACKING_STATES,
} from "../constants/menuInventory.js"

function plain(value) {
    if (!value) return value
    return typeof value.toObject === "function"
        ? value.toObject({ depopulate: true })
        : value
}

function inventoryItemById(inventoryItems, inventoryItemId) {
    if (inventoryItems instanceof Map) return inventoryItems.get(inventoryItemId) || null
    if (Array.isArray(inventoryItems)) {
        return inventoryItems.find((item) => item?.inventoryItemId === inventoryItemId) || null
    }
    return inventoryItems?.[inventoryItemId] || null
}

export function resolveManualMenuAvailability(menuItemValue) {
    const menuItem = plain(menuItemValue) || {}
    return typeof menuItem.manualIsAvailable === "boolean"
        ? menuItem.manualIsAvailable
        : menuItem.isAvailable !== false
}

export function resolveMenuInventoryTrackingState({ menuItem: menuItemValue, mapping: mappingValue }) {
    const menuItem = plain(menuItemValue) || {}
    const mapping = plain(mappingValue)
    if (mapping?.status === MENU_INVENTORY_MAPPING_STATUSES.ACTIVE) {
        return mapping.mode === MENU_INVENTORY_MODES.RECIPE
            ? MENU_INVENTORY_TRACKING_STATES.CANONICAL_RECIPE
            : MENU_INVENTORY_TRACKING_STATES.CANONICAL_SIMPLE
    }
    return menuItem.trackStock === true
        ? MENU_INVENTORY_TRACKING_STATES.LEGACY
        : MENU_INVENTORY_TRACKING_STATES.UNTRACKED
}

export function resolveEffectiveMenuAvailability({
    menuItem: menuItemValue,
    mapping: mappingValue = null,
    inventoryItems = [],
}) {
    const menuItem = plain(menuItemValue) || {}
    const mapping = plain(mappingValue)
    const manualIsAvailable = resolveManualMenuAvailability(menuItem)
    const trackingState = resolveMenuInventoryTrackingState({ menuItem, mapping })
    let inventoryAvailable = null
    let availableMenuQuantity = null
    let inventoryAvailabilityState = "not_tracked"

    if (trackingState === MENU_INVENTORY_TRACKING_STATES.LEGACY) {
        if (typeof menuItem.stockQuantity === "number" && Number.isFinite(menuItem.stockQuantity)) {
            availableMenuQuantity = menuItem.stockQuantity
            inventoryAvailable = menuItem.stockQuantity > 0
            inventoryAvailabilityState = inventoryAvailable ? "available" : "unavailable"
        } else {
            inventoryAvailabilityState = "unknown"
        }
    } else if (trackingState === MENU_INVENTORY_TRACKING_STATES.CANONICAL_SIMPLE) {
        const component = mapping?.components?.[0]
        const inventoryItem = plain(inventoryItemById(
            inventoryItems,
            component?.inventoryItemId,
        ))
        if (!component || !inventoryItem || inventoryItem.isActive === false) {
            inventoryAvailable = false
            availableMenuQuantity = 0
            inventoryAvailabilityState = "unavailable"
        } else if (
            !Number.isSafeInteger(component.canonicalQuantity) ||
            component.canonicalQuantity <= 0 ||
            !Number.isSafeInteger(inventoryItem.onHandQuantity) ||
            !Number.isSafeInteger(inventoryItem.reservedQuantity) ||
            inventoryItem.onHandQuantity < 0 ||
            inventoryItem.reservedQuantity < 0 ||
            inventoryItem.reservedQuantity > inventoryItem.onHandQuantity
        ) {
            inventoryAvailable = false
            availableMenuQuantity = 0
            inventoryAvailabilityState = "invalid"
        } else {
            const availableQuantity = inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
            availableMenuQuantity = Math.max(
                0,
                Math.floor(availableQuantity / component.canonicalQuantity),
            )
            inventoryAvailable = availableMenuQuantity > 0
            inventoryAvailabilityState = inventoryAvailable ? "available" : "unavailable"
        }
    } else if (trackingState === MENU_INVENTORY_TRACKING_STATES.CANONICAL_RECIPE) {
        const components = Array.isArray(mapping?.components) ? mapping.components : []
        if (components.length === 0) {
            inventoryAvailable = false
            availableMenuQuantity = 0
            inventoryAvailabilityState = "invalid"
        } else {
            let limitingQuantity = Number.POSITIVE_INFINITY
            let broken = false
            for (const component of components) {
                const inventoryItem = plain(inventoryItemById(
                    inventoryItems,
                    component?.inventoryItemId,
                ))
                if (!inventoryItem || inventoryItem.isActive === false) {
                    broken = true
                    inventoryAvailabilityState = "unavailable"
                    break
                }
                if (
                    !Number.isSafeInteger(component.canonicalQuantity) ||
                    component.canonicalQuantity <= 0 ||
                    !Number.isSafeInteger(inventoryItem.onHandQuantity) ||
                    !Number.isSafeInteger(inventoryItem.reservedQuantity) ||
                    inventoryItem.onHandQuantity < 0 ||
                    inventoryItem.reservedQuantity < 0 ||
                    inventoryItem.reservedQuantity > inventoryItem.onHandQuantity
                ) {
                    broken = true
                    inventoryAvailabilityState = "invalid"
                    break
                }
                const componentAvailable = inventoryItem.onHandQuantity -
                    inventoryItem.reservedQuantity
                limitingQuantity = Math.min(
                    limitingQuantity,
                    Math.floor(componentAvailable / component.canonicalQuantity),
                )
            }
            availableMenuQuantity = broken ? 0 : Math.max(0, limitingQuantity)
            inventoryAvailable = !broken && availableMenuQuantity > 0
            if (!broken) {
                inventoryAvailabilityState = inventoryAvailable ? "available" : "unavailable"
            }
        }
    }

    const effectiveIsAvailable = manualIsAvailable && inventoryAvailable !== false
    return Object.freeze({
        trackingState,
        manualIsAvailable,
        inventoryAvailable,
        inventoryAvailabilityState,
        effectiveIsAvailable,
        availableMenuQuantity,
    })
}

export function toMenuInventoryAvailabilityDTO(input) {
    const resolved = resolveEffectiveMenuAvailability(input)
    return {
        manualIsAvailable: resolved.manualIsAvailable,
        inventoryAvailability: {
            trackingState: resolved.trackingState,
            state: resolved.inventoryAvailabilityState,
            availableMenuQuantity: resolved.availableMenuQuantity,
        },
        effectiveIsAvailable: resolved.effectiveIsAvailable,
    }
}

export function applyCanonicalSimpleStockProjection({ menuItem, inventoryItem }) {
    if (!menuItem || !inventoryItem) {
        throw new TypeError("menuItem and inventoryItem are required")
    }
    const availableQuantity = inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
    const manualIsAvailable = resolveManualMenuAvailability(menuItem)
    menuItem.manualIsAvailable = manualIsAvailable
    menuItem.trackStock = true
    menuItem.stockQuantity = availableQuantity
    menuItem.lowStockThreshold = inventoryItem.lowStockThreshold
    menuItem.isAvailable = manualIsAvailable && inventoryItem.isActive !== false && availableQuantity > 0
    return menuItem
}

export function toMenuItemWithInventoryDTO({
    menuItem: menuItemValue,
    mapping: mappingValue = null,
    inventoryItem: inventoryItemValue = null,
    inventoryItems: inventoryItemValues = [],
}) {
    const menuItem = plain(menuItemValue) || {}
    const mapping = plain(mappingValue)
    const suppliedInventoryItems = Array.isArray(inventoryItemValues) && inventoryItemValues.length > 0
        ? inventoryItemValues.map(plain)
        : inventoryItemValue
            ? [plain(inventoryItemValue)]
            : []
    const inventoryItem = mapping?.mode === MENU_INVENTORY_MODES.SIMPLE
        ? plain(inventoryItemValue) || suppliedInventoryItems[0] || null
        : null
    const availability = resolveEffectiveMenuAvailability({
        menuItem,
        mapping,
        inventoryItems: suppliedInventoryItems,
    })
    const canonicalSimpleActive = availability.trackingState ===
        MENU_INVENTORY_TRACKING_STATES.CANONICAL_SIMPLE
    const canonicalRecipeActive = availability.trackingState ===
        MENU_INVENTORY_TRACKING_STATES.CANONICAL_RECIPE
    const availableQuantity = canonicalSimpleActive && inventoryItem
        ? inventoryItem.onHandQuantity - inventoryItem.reservedQuantity
        : canonicalRecipeActive
            ? null
            : menuItem.stockQuantity ?? null
    const threshold = canonicalSimpleActive && inventoryItem
        ? inventoryItem.lowStockThreshold
        : canonicalRecipeActive
            ? null
            : menuItem.lowStockThreshold ?? 5

    return {
        ...menuItem,
        manualIsAvailable: availability.manualIsAvailable,
        isAvailable: availability.effectiveIsAvailable,
        stockQuantity: availableQuantity,
        lowStockThreshold: threshold,
        inventory: {
            trackingState: availability.trackingState,
            mode: mapping?.mode ?? null,
            mappingStatus: mapping?.status ?? null,
            inventoryItemId: mapping?.mode === MENU_INVENTORY_MODES.SIMPLE
                ? mapping?.components?.[0]?.inventoryItemId ?? null
                : null,
            unit: mapping?.mode === MENU_INVENTORY_MODES.SIMPLE
                ? inventoryItem?.trackingUnit ?? mapping?.components?.[0]?.unit ?? null
                : null,
            onHandQuantity: inventoryItem?.onHandQuantity ?? null,
            reservedQuantity: inventoryItem?.reservedQuantity ?? null,
            availableQuantity: canonicalSimpleActive ? availableQuantity : null,
            lowStockThreshold: canonicalSimpleActive ? threshold : null,
            isLowStock: canonicalSimpleActive ? availableQuantity <= threshold : null,
            recipeComponentCount: mapping?.mode === MENU_INVENTORY_MODES.RECIPE
                ? mapping.components?.length ?? 0
                : null,
            ingredientAvailabilityEnforced: canonicalRecipeActive,
            effectiveIsAvailable: availability.effectiveIsAvailable,
            disabledReason: mapping?.disabledReason ?? null,
        },
    }
}
