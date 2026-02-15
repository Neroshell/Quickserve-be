// sseManager.js
const clients = new Set();

/**
 * Express handler for GET /events
 */
export function sseHandler(req, res) {
    // Required SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.flushHeaders?.();

    const client = { res };
    clients.add(client);

    // Initial heartbeat to open stream
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ok: true, t: Date.now() })}\n\n`);

    // Ping every 25s
    const keepAlive = setInterval(() => {
        try {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
        } catch (err) {
            console.error("[SSE Heartbeat Error] Removing client", err);
            clearInterval(keepAlive);
            clients.delete(client);
        }
    }, 25000);

    req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(client);
    });
}

/**
 * Broadcast event to all connected clients
 */
export function broadcast(eventName, payload) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
        try {
            client.res.write(data);
        } catch (err) {
            // If write fails, the client is likely disconnected but req.on("close") hasn't fired yet
            clients.delete(client);
        }
    }
}
