// sseBus.js
const clients = new Set()

export function sseHandler(req, res) {
    // Required SSE headers
    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    // If behind nginx/proxy (optional but helpful)
    res.setHeader("X-Accel-Buffering", "no")

    // CORS if FE is on different origin (optional)
    // res.setHeader("Access-Control-Allow-Origin", "*")

    res.flushHeaders?.()

    const client = { res }
    clients.add(client)

    // initial ping so browser "opens" stream immediately
    res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`)

    // Keepalive ping every 25s (prevents idle disconnects)
    const keepAlive = setInterval(() => {
        res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`)
    }, 25000)

    req.on("close", () => {
        clearInterval(keepAlive)
        clients.delete(client)
    })
}

export function broadcast(eventName, payload) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const c of clients) {
        try {
            c.res.write(data)
        } catch (_) { }
    }
}
