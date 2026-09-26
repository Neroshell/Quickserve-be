/**
 * Starts HTTP after Mongo is ready without making listener availability depend
 * on the session Redis connection promise. Redis keeps reconnecting in the
 * background and readiness stays false until the client reports isReady.
 */
export async function startApiRuntime({
  connectDatabase,
  listen,
  connectSessionStore,
  startRealtime,
  logger = console,
}) {
  await connectDatabase()
  const server = listen()

  try {
    const connection = connectSessionStore()
    Promise.resolve(connection).catch((error) => {
      logger.error("[Redis:session] Background connection failed:", error.message)
    })
  } catch (error) {
    logger.error("[Redis:session] Background connection failed:", error.message)
  }

  startRealtime()
  return server
}
