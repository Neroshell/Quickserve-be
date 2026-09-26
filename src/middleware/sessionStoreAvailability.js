const SESSION_STORE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "NR_CLOSED",
  "SOCKET_CLOSED",
])

export function isSessionStoreUnavailableError(error) {
  if (!error) return false
  if (SESSION_STORE_ERROR_CODES.has(error.code)) return true

  const name = String(error.name || "").toLowerCase()
  const message = String(error.message || "").toLowerCase()
  return (
    name.includes("redis") ||
    name.includes("socketclosed") ||
    message.includes("redis") ||
    message.includes("offline") ||
    message.includes("closed") ||
    message.includes("connect")
  )
}

export function handleSessionStoreUnavailable(error, req, res, next) {
  if (!isSessionStoreUnavailableError(error)) return next(error)

  console.error("[Session] Infrastructure unavailable:", error.message)
  return res.status(503).json({
    message: "Service temporarily unavailable. Please try again later.",
    code: "SESSION_STORE_UNAVAILABLE",
  })
}
