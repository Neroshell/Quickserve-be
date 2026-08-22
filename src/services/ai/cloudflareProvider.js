/**
 * Cloudflare AI provider — thin HTTP client over Cloudflare Workers AI.
 *
 * Uses the Workers AI REST API (OpenAI-compatible chat completions).
 * All configuration comes from environment variables.
 * No business logic. No prompt construction. No validation.
 */

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4"
const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_TEMPERATURE = 0.3

export class CloudflareProviderError extends Error {
    constructor(message, { code = "cloudflare_error", retryable = false, statusCode = null } = {}) {
        super(message)
        this.name = "CloudflareProviderError"
        this.code = code
        this.retryable = retryable
        this.statusCode = statusCode
    }
}

function safeError(error) {
    if (error instanceof CloudflareProviderError) return error
    const message = String(error?.message || "Unknown Cloudflare error").slice(0, 500)
    const statusCode = Number(error?.status ?? error?.statusCode) || null

    if (statusCode === 429) {
        return new CloudflareProviderError("Cloudflare rate limit exceeded", {
            code: "rate_limited",
            retryable: true,
            statusCode: 429,
        })
    }
    if (statusCode && statusCode >= 500) {
        return new CloudflareProviderError(`Cloudflare server error (${statusCode})`, {
            code: "provider_5xx",
            retryable: true,
            statusCode,
        })
    }
    if (statusCode === 400) {
        return new CloudflareProviderError(`Cloudflare request rejected (${statusCode})`, {
            code: "provider_400",
            retryable: false,
            statusCode,
        })
    }
    if (statusCode === 401 || statusCode === 403) {
        return new CloudflareProviderError(`Cloudflare auth error (${statusCode})`, {
            code: "provider_auth",
            retryable: false,
            statusCode,
        })
    }
    if (error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT" || error?.cause?.code === "ETIMEDOUT") {
        return new CloudflareProviderError("Cloudflare request timed out", {
            code: "timeout",
            retryable: true,
        })
    }
    return new CloudflareProviderError(message, { code: "unknown", retryable: true })
}

/**
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {Object} opts.userPayload  — the compact AI payload
 * @param {Object} [opts.responseSchema] — JSON Schema for structured output
 * @param {Object} [opts.overrides]
 * @returns {Promise<{ content: Object, usage: Object|null, model: string }>}
 */
export async function generateStructuredReport({
    systemPrompt,
    userPayload,
    responseSchema = null,
    overrides = {},
}) {
    const accountId = overrides.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
    const apiToken = overrides.apiToken ?? process.env.CLOUDFLARE_AI_TOKEN

    if (!accountId) {
        throw new CloudflareProviderError("CLOUDFLARE_ACCOUNT_ID is not configured", {
            code: "missing_account_id",
            retryable: false,
        })
    }
    if (!apiToken) {
        throw new CloudflareProviderError("CLOUDFLARE_AI_TOKEN is not configured", {
            code: "missing_api_token",
            retryable: false,
        })
    }

    const baseUrl = overrides.baseUrl ?? process.env.CLOUDFLARE_AI_BASE_URL ?? DEFAULT_BASE_URL
    const model = overrides.model ?? process.env.CLOUDFLARE_AI_MODEL ?? DEFAULT_MODEL
    const timeoutMs = overrides.timeoutMs ?? (Number(process.env.CLOUDFLARE_AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
    const maxTokens = overrides.maxTokens ?? (Number(process.env.CLOUDFLARE_AI_MAX_TOKENS) || DEFAULT_MAX_TOKENS)
    const temperature = overrides.temperature ?? (Number(process.env.CLOUDFLARE_AI_TEMPERATURE) || DEFAULT_TEMPERATURE)

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
    ]

    const body = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        response_format: responseSchema
            ? { type: "json_schema", json_schema: responseSchema }
            : { type: "json_object" },
    }

    const endpoint = `${baseUrl}/accounts/${accountId}/ai/v1/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiToken}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        })
    } catch (err) {
        clearTimeout(timer)
        throw safeError(err)
    } finally {
        clearTimeout(timer)
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "")
        throw safeError({
            message: `Cloudflare HTTP ${response.status}: ${errorText.slice(0, 200)}`,
            status: response.status,
        })
    }

    let data
    try {
        data = await response.json()
    } catch {
        throw new CloudflareProviderError("Cloudflare returned unparseable response", {
            code: "malformed_response",
            retryable: true,
        })
    }

    // Cloudflare Workers AI wraps the OpenAI response in { result: { ... } }
    const inner = data?.result ?? data
    const choice = inner?.choices?.[0]
    if (!choice?.message?.content) {
        throw new CloudflareProviderError("Cloudflare response missing content", {
            code: "empty_response",
            retryable: true,
        })
    }

    let parsed
    try {
        parsed = JSON.parse(choice.message.content)
    } catch {
        throw new CloudflareProviderError("Cloudflare returned invalid JSON", {
            code: "invalid_json",
            retryable: true,
        })
    }

    return {
        content: parsed,
        usage: inner.usage
            ? {
                inputTokens: inner.usage.prompt_tokens ?? null,
                outputTokens: inner.usage.completion_tokens ?? null,
                totalTokens: inner.usage.total_tokens ?? null,
            }
            : null,
        model: inner.model || model,
    }
}

export default { generateStructuredReport, CloudflareProviderError }