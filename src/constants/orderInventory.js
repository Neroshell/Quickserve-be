export const ORDER_INVENTORY_SEMANTICS = Object.freeze({
    LEGACY_MENU_STOCK_V1: "legacy_menu_stock_v1",
    CANONICAL_SIMPLE_BRIDGE_V1: "canonical_simple_bridge_v1",
    MIXED_BRIDGE_V1: "mixed_bridge_v1",
    CANONICAL_RESERVATION_V1: "canonical_reservation_v1",
    MIXED_RESERVATION_V1: "mixed_reservation_v1",
})

export const ORDER_INVENTORY_SEMANTICS_VALUES = Object.freeze(
    Object.values(ORDER_INVENTORY_SEMANTICS),
)

export const ORDER_INVENTORY_AUTHORITIES = Object.freeze({
    LEGACY_MENU_ITEM: "legacy_menu_item",
    CANONICAL_INVENTORY_ITEM: "canonical_inventory_item",
})

export const ORDER_INVENTORY_AUTHORITY_VALUES = Object.freeze(
    Object.values(ORDER_INVENTORY_AUTHORITIES),
)
