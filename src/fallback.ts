/**
 * Generative-LLM fallback for the decisions jev structurally cannot make:
 * values absent from every candidate pool (`__none__`), plans whose jev
 * confidence is below the configured threshold, and plans that fail to
 * decode.
 *
 * The fallback is a caller-supplied planner: it receives the same state
 * document jev saw plus the available action specs, and returns a
 * `PlannedAction` (or `null` to keep the built-in behavior). Anything that
 * speaks chat completions works — `openaiCompatibleFallback` below covers
 * Qwen (DashScope compatible mode / OpenRouter / Together), DeepSeek,
 * OpenAI, and friends.
 */
import type { ActionSpec, PlannedAction } from './planner.js'

export type FallbackReason = 'unresolved_param' | 'low_confidence' | 'plan_error'

export interface FallbackContext {
	task: string
	/** 0-based step index */
	step: number
	reason: FallbackReason
	/** the same state document offered to jev (task, page, elements, candidates, history) */
	state: unknown
	/** registered actions: name -> spec (description + ParamSpec map) */
	actions: Record<string, ActionSpec>
}

export type FallbackPlanner = (
	ctx: FallbackContext,
	signal?: AbortSignal
) => Promise<PlannedAction | null>

export interface OpenAICompatibleFallbackOptions {
	apiKey: string
	/** e.g. 'https://dashscope.aliyuncs.com/compatible-mode/v1' or 'https://openrouter.ai/api/v1' @default 'https://api.openai.com/v1' */
	baseURL?: string
	/** e.g. 'qwen-plus', 'qwen/qwen3-32b', 'deepseek-chat', 'gpt-4o-mini' */
	model: string
	fetch?: typeof globalThis.fetch
	/** @default 1024 */
	maxTokens?: number
	/** system prompt override */
	systemPrompt?: string
}

export class FallbackError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: unknown
	) {
		super(message)
		this.name = 'FallbackError'
	}
}

const DEFAULT_SYSTEM_PROMPT = [
	'You are the fallback planner of a browser automation agent.',
	'Decide the single best next action for the agent to perform.',
	'Respond with STRICT JSON only, no prose, no markdown fences:',
	'{"action": "<action name>", "params": {<param>: <value>, ...}}',
	'- "action" must be one of the listed action names.',
	'- For parameters that target a page element, return the element index (integer key of interactive_elements).',
	'- For text parameters, return the literal string value.',
	'- If no action makes progress, respond {"action": "done", "params": {"text": "<answer>", "success": false}}.',
].join('\n')

/**
 * Build a FallbackPlanner on top of any OpenAI-compatible chat-completions
 * endpoint (Qwen/DashScope, OpenRouter, Together, DeepSeek, OpenAI, ...).
 */
export function openaiCompatibleFallback(opts: OpenAICompatibleFallbackOptions): FallbackPlanner {
	const baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
	const fetchImpl = opts.fetch ?? globalThis.fetch

	return async (ctx, signal) => {
		const actionsDoc = Object.fromEntries(
			Object.entries(ctx.actions).map(([name, spec]) => [
				name,
				{ description: spec.description, params: spec.params ?? {} },
			])
		)

		const body = {
			model: opts.model,
			messages: [
				{ role: 'system', content: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
				{
					role: 'user',
					content: JSON.stringify({
						state: ctx.state,
						available_actions: actionsDoc,
						fallback_reason: ctx.reason,
					}),
				},
			],
			temperature: 0,
			max_tokens: opts.maxTokens ?? 1024,
			response_format: { type: 'json_object' },
		}

		const res = await fetchImpl(`${baseURL}/chat/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: signal ?? null,
		})
		if (!res.ok) {
			const text = await res.text().catch(() => '')
			throw new FallbackError(`fallback LLM request failed (${res.status})`, res.status, text)
		}
		const payload = (await res.json()) as {
			choices?: { message?: { content?: string } }[]
		}
		const content = payload.choices?.[0]?.message?.content ?? ''
		return parseFallbackPlan(content, ctx)
	}
}

/** Parse the LLM's JSON plan and validate it against the registered actions. */
export function parseFallbackPlan(content: string, ctx: FallbackContext): PlannedAction {
	const cleaned = content
		.replace(/^\s*```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim()

	let raw: unknown
	try {
		raw = JSON.parse(cleaned)
	} catch {
		throw new FallbackError(`fallback LLM returned non-JSON content: ${content.slice(0, 200)}`)
	}
	if (typeof raw !== 'object' || raw === null) {
		throw new FallbackError('fallback LLM plan is not a JSON object')
	}
	const obj = raw as Record<string, unknown>
	const name = typeof obj['action'] === 'string' ? obj['action'] : undefined
	if (!name || !ctx.actions[name]) {
		throw new FallbackError(`fallback LLM chose unknown action "${String(name)}"`)
	}
	const spec = ctx.actions[name]!
	const params = (
		typeof obj['params'] === 'object' && obj['params'] !== null ? obj['params'] : {}
	) as Record<string, unknown>

	const normalized: Record<string, unknown> = {}
	for (const [paramName, specEntry] of Object.entries(spec.params ?? {})) {
		const value = params[paramName]
		switch (specEntry.kind) {
			case 'element': {
				const index = Number(value)
				if (!Number.isInteger(index) || index < 0) {
					throw new FallbackError(
						`fallback param "${paramName}" is not a valid element index (${String(value)})`
					)
				}
				normalized[paramName] = index
				break
			}
			case 'text': {
				if (value === undefined || value === null || value === '') {
					if (specEntry.optional) break
					throw new FallbackError(`fallback param "${paramName}" is required`)
				}
				normalized[paramName] = String(value)
				break
			}
			case 'choice': {
				const s = String(value)
				if (!specEntry.options.includes(s)) {
					throw new FallbackError(`fallback param "${paramName}" not in options (${s})`)
				}
				normalized[paramName] = s
				break
			}
			case 'boolean': {
				normalized[paramName] = value === true || value === 'true' || value === 1
				break
			}
			case 'number': {
				const num = Number(value)
				if (!Number.isFinite(num)) {
					throw new FallbackError(`fallback param "${paramName}" is not a number (${String(value)})`)
				}
				normalized[paramName] = num
				break
			}
			case 'computed':
				// filled by the agent from SynthContext after the plan is accepted
				break
		}
	}

	return {
		name,
		params: normalized,
		confidences: { fallback: 1 },
		rawAnswers: {},
	}
}
