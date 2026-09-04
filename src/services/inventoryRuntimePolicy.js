export const SIMPLE_STOCK_KILL_SWITCH_ENV = "SIMPLE_STOCK_KILL_SWITCH"

export function isSimpleStockKillSwitchActive(env = process.env) {
    const value = String(env?.[SIMPLE_STOCK_KILL_SWITCH_ENV] ?? "")
        .trim()
        .toLowerCase()
    return ["1", "true", "yes", "on"].includes(value)
}

export function assertSimpleStockRuntimeEnabled({ env = process.env } = {}) {
    if (!isSimpleStockKillSwitchActive(env)) return
    const error = new Error(
        "Canonical Simple Stock is temporarily disabled by the operational kill switch",
    )
    error.name = "SimpleStockKillSwitchError"
    error.code = "SIMPLE_STOCK_KILL_SWITCH_ACTIVE"
    error.statusCode = 503
    throw error
}
