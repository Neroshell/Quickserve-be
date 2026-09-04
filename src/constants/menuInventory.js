export const MENU_INVENTORY_MODES = Object.freeze({
    SIMPLE: "simple",
    RECIPE: "recipe",
})

export const MENU_INVENTORY_MODE_VALUES = Object.freeze(
    Object.values(MENU_INVENTORY_MODES),
)

// Retained as a historical Phase 2A contract for compatibility tests and
// callers that need to describe the earlier dark-launch capability set.
export const PHASE_TWO_A_MENU_INVENTORY_MODE_VALUES = Object.freeze([
    MENU_INVENTORY_MODES.SIMPLE,
])

export const MAX_INGREDIENT_RECIPE_COMPONENTS = 100

export const MENU_INVENTORY_MAPPING_STATUSES = Object.freeze({
    ACTIVE: "active",
    DISABLED: "disabled",
    ARCHIVED: "archived",
    ORPHANED: "orphaned",
})

export const MENU_INVENTORY_MAPPING_STATUS_VALUES = Object.freeze(
    Object.values(MENU_INVENTORY_MAPPING_STATUSES),
)

export const MENU_INVENTORY_TRACKING_STATES = Object.freeze({
    UNTRACKED: "untracked",
    LEGACY: "legacy",
    CANONICAL_SIMPLE: "canonical_simple",
    CANONICAL_RECIPE: "canonical_recipe",
})

export const LEGACY_MENU_STOCK_MIGRATION_SOURCE = "legacy_menu_stock"
export const LEGACY_MENU_STOCK_MIGRATION_VERSION = 1

// A Simple Stock menu sale represents one directly tracked count unit. Weight
// and volume belong to the future ingredient-recipe phase, not this cutover.
export const SIMPLE_STOCK_UNIT_VALUES = Object.freeze([
    "piece",
    "bottle",
    "can",
    "pack",
    "portion",
])
