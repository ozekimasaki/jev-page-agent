/**
 * HTTP transports for the TypeSafe System One API.
 *
 * - TypeSafe direct:  POST {baseURL}/v1/systemone
 * - Cloudflare REST:  POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run
 *   (the same request shape `env.AI.run('typesafe/jev', input)` accepts,
 *   wrapped in `{ model, input }`, answers under `result`)
 */
import {
	JevApiError,
	type JevEvaluateRequest,
	type JevEvaluateResult,
	type JevEvaluator,
} from './types.js'

export interface TypeSafeTransportConfig {
	apiKey: string
	/** @default 'https://api.typesafe.ai' */
	baseURL?: string
	/** @default 'jev-latest' */
	model?: string
	fetch?: typeof globalThis.fetch
}

export function typesafeTransport(config: TypeSafeTransportConfig): JevEvaluator {
	const baseURL = (config.baseURL ?? 'https://api.typesafe.ai').replace(/\/+$/, '')
	const model = config.model ?? 'jev-latest'
	const doFetch = (config.fetch ?? globalThis.fetch).bind(globalThis)

	return async (request, signal) => {
		const body = {
			state: request.state,
			model: request.model ?? model,
			questions: request.questions,
		}
		const response = await doFetch(`${baseURL}/v1/systemone`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal,
		})
		return handleResponse(response, body)
	}
}

export interface CloudflareTransportConfig {
	/** Cloudflare account ID (32-char hex, found in the dashboard sidebar) */
	accountId: string
	/** Cloudflare API token with Workers AI read access */
	apiToken: string
	/** @default 'typesafe/jev' */
	model?: string
	fetch?: typeof globalThis.fetch
}

export function cloudflareTransport(config: CloudflareTransportConfig): JevEvaluator {
	const model = config.model ?? 'typesafe/jev'
	const doFetch = (config.fetch ?? globalThis.fetch).bind(globalThis)
	const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run`

	return async (request, signal) => {
		const body = {
			model,
			input: {
				state: request.state,
				questions: request.questions,
			},
		}
		const response = await doFetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${config.apiToken}`,
			},
			body: JSON.stringify(body),
			signal,
		})

		const envelope = await readJson(response, body)
		// Cloudflare REST wraps the run result: { result: {...}, success, errors, messages }
		const inner = (envelope as { result?: unknown })?.result ?? envelope
		return inner as JevEvaluateResult
	}
}

async function readJson(response: Response, rawRequest: unknown): Promise<unknown> {
	if (!response.ok) {
		let body: unknown
		try {
			body = await response.json()
		} catch {
			body = undefined
		}
		const message =
			(body as { error?: { message?: string } })?.error?.message ??
			(body as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ??
			response.statusText
		throw new JevApiError(`Jev API error ${response.status}: ${message}`, response.status, {
			request: rawRequest,
			response: body,
		})
	}
	try {
		return await response.json()
	} catch (error) {
		throw new JevApiError('Jev API returned invalid JSON', undefined, {
			request: rawRequest,
			cause: error,
		})
	}
}

async function handleResponse(response: Response, rawRequest: unknown): Promise<JevEvaluateResult> {
	return (await readJson(response, rawRequest)) as JevEvaluateResult
}
