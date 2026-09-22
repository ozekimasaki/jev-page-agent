/**
 * JevPageAgent — an in-page GUI agent whose every step is decided by a single
 * TypeSafe Jev (System One) evaluation instead of a generative LLM call.
 *
 * Loop per step:
 *   1. observe  — snapshot the DOM into indexed interactive elements
 *   2. evaluate — one jev call answering: action choice + every param question
 *   3. act      — run the decoded action on the page
 */
import {
	clickElement,
	getElement,
	inputText,
	scrollPage,
	selectOption,
	type ScrollDirection,
} from './actions.js'
import { extractAnswerCandidates, extractTextCandidates } from './candidates.js'
import { snapshotPage, type PageSnapshot } from './dom.js'
import type { FallbackPlanner, FallbackReason } from './fallback.js'
import { cloudflareTransport } from './jev/transports.js'
import type { JevEvaluator } from './jev/types.js'
import { typesafeTransport } from './jev/transports.js'
import {
	buildPlanRequest,
	JevPlanError,
	ParamUnresolvedError,
	synthesizePlan,
	type ActionSpec,
	type HistoryEntry,
	type PlanContext,
	type PlannedAction,
	type PlanRequest,
	type SynthContext,
} from './planner.js'

export interface ActionRunContext {
	agent: JevPageAgent
	snapshot: PageSnapshot
	signal: AbortSignal
}

export interface AgentAction extends ActionSpec {
	run: (params: Record<string, any>, ctx: ActionRunContext) => Promise<string> | string
}

export interface JevPageAgentConfig {
	/** Ready-made evaluator (tests, Vercel AI Gateway, your own transport). Wins over provider config. */
	evaluate?: JevEvaluator

	/** @default 'typesafe' */
	provider?: 'typesafe' | 'cloudflare'
	/** TypeSafe API key, or Cloudflare API token when provider='cloudflare' */
	apiKey?: string
	/** TypeSafe base URL @default 'https://api.typesafe.ai' */
	baseURL?: string
	/** Cloudflare account ID (provider='cloudflare' only) */
	accountId?: string
	/** @default 'jev-latest' (typesafe) / 'typesafe/jev' (cloudflare) */
	model?: string
	fetch?: typeof globalThis.fetch

	/** @default 20 */
	maxSteps?: number
	/** delay between steps in seconds @default 0.3 */
	stepDelay?: number
	/** abort the task after this many consecutive failures @default 3 */
	maxConsecutiveErrors?: number
	/** max elements offered to jev's element question @default 48 */
	maxElementCandidates?: number
	/** max text candidates per text param @default 16 */
	maxTextCandidates?: number

	/** DOM root to control (default: document) */
	root?: ParentNode
	/** querySelectorAll selectors whose elements are excluded */
	blacklist?: string[]
	/** extra querySelectorAll selectors to mark interactive */
	extraSelectors?: string[]

	/** override/add actions; set an entry to `null` to remove a builtin */
	actions?: Record<string, AgentAction | null>

	/** required to enable the `ask_user` action */
	onAskUser?: (question: string, opts: { signal: AbortSignal }) => Promise<string>

	/**
	 * Generative-LLM fallback planner for decisions jev cannot make:
	 * unresolved text params (`__none__`), undecodable plans, and — when
	 * `confidenceThreshold` is set — low-confidence picks. See
	 * `openaiCompatibleFallback` for a ready-made OpenAI-compatible one
	 * (DeepSeek / Qwen / OpenRouter / ...).
	 */
	fallback?: FallbackPlanner
	/**
	 * When `fallback` is configured and this is > 0, a plan whose lowest
	 * answered-question confidence is below it is re-decided by the fallback.
	 * @default 0 (jev confidences are advisory only)
	 */
	confidenceThreshold?: number

	/** log decisions and confidences to console */
	verbose?: boolean
}

export interface StepEvent extends HistoryEntry {
	type: 'step'
	confidences?: Record<string, number>
	usage?: { input_tokens?: number; output_tokens?: number }
}

export interface ErrorEvent {
	type: 'error'
	message: string
	raw?: unknown
}

export interface ObservationEvent {
	type: 'observation'
	content: string
}

export type AgentEvent = StepEvent | ErrorEvent | ObservationEvent

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped'

export interface ExecutionResult {
	success: boolean
	data: string
	history: AgentEvent[]
}

export class JevPageAgent extends EventTarget {
	readonly config: JevPageAgentConfig
	readonly actions: Record<string, AgentAction>
	history: AgentEvent[] = []
	task = ''
	disposed = false

	onAskUser?: JevPageAgentConfig['onAskUser']

	#status: AgentStatus = 'idle'
	#abort = new AbortController()
	#running: Promise<void> = Promise.resolve()
	#evaluate: JevEvaluator
	#fallback?: FallbackPlanner

	constructor(config: JevPageAgentConfig) {
		super()
		this.config = config
		this.onAskUser = config.onAskUser
		this.#evaluate = config.evaluate ?? this.#buildEvaluator()
		this.#fallback = config.fallback

		this.actions = builtinActions()
		for (const [name, action] of Object.entries(config.actions ?? {})) {
			if (action === null) delete this.actions[name]
			else this.actions[name] = action
		}
		if (!this.onAskUser) delete this.actions['ask_user']
	}

	get status(): AgentStatus {
		return this.#status
	}

	#buildEvaluator(): JevEvaluator {
		const c = this.config
		if (c.provider === 'cloudflare' || c.accountId) {
			if (!c.accountId) throw new Error('[jev-page-agent] cloudflare provider requires accountId')
			if (!c.apiKey) throw new Error('[jev-page-agent] cloudflare provider requires apiKey (API token)')
			return cloudflareTransport({
				accountId: c.accountId,
				apiToken: c.apiKey,
				model: c.model,
				fetch: c.fetch,
			})
		}
		if (!c.apiKey && !c.evaluate) {
			throw new Error(
				'[jev-page-agent] missing jev credentials: pass `apiKey` (TypeSafe) or a custom `evaluate` function'
			)
		}
		return typesafeTransport({ apiKey: c.apiKey!, baseURL: c.baseURL, model: c.model, fetch: c.fetch })
	}

	#setStatus(status: AgentStatus): void {
		if (this.#status === status) return
		this.#status = status
		this.dispatchEvent(new Event('statuschange'))
	}

	#emitHistoryChange(): void {
		this.dispatchEvent(new Event('historychange'))
	}

	#emitActivity(detail: unknown): void {
		this.dispatchEvent(new CustomEvent('activity', { detail }))
	}

	/** implement in subclasses / set via config */
	async askUser(question: string, signal: AbortSignal): Promise<string> {
		if (!this.onAskUser) throw new Error('ask_user requires onAskUser callback')
		return this.onAskUser(question, { signal })
	}

	async stop(): Promise<void> {
		if (this.#status !== 'running') return
		this.#abort.abort()
		await this.#running
	}

	async execute(task: string): Promise<ExecutionResult> {
		if (this.disposed) throw new Error('JevPageAgent has been disposed. Create a new instance.')
		if (this.#status === 'running') throw new Error('A task is already running.')
		if (!task) throw new Error('Task is required')

		this.task = task
		this.history = []
		this.#abort = new AbortController()
		const signal = this.#abort.signal
		let resolveRunning!: () => void
		this.#running = new Promise<void>((r) => (resolveRunning = r))

		const maxSteps = this.config.maxSteps ?? 20
		const stepDelay = this.config.stepDelay ?? 0.3
		const maxConsecutiveErrors = this.config.maxConsecutiveErrors ?? 3
		let consecutiveErrors = 0
		let step = 0
		let result: ExecutionResult = { success: false, data: 'not finished', history: this.history }
		let finalStatus: AgentStatus = 'error'

		this.#setStatus('running')
		this.#emitHistoryChange()

		try {
			while (true) {
				signal.throwIfAborted()
				if (step > 0) await waitFor(stepDelay, signal)

				try {
					const snapshot = snapshotPage({
						root: this.config.root,
						blacklist: this.config.blacklist,
						extraSelectors: this.config.extraSelectors,
					})

					const stepHistory: HistoryEntry[] = this.history
						.filter((e): e is StepEvent => e.type === 'step')
						.map((e) => ({ step: e.step, action: e.action, params: e.params, result: e.result, ok: e.ok }))

					const ctx = {
						task,
						step,
						maxSteps,
						snapshot,
						history: stepHistory,
						inputCandidates: extractTextCandidates(task, {
							max: this.config.maxTextCandidates,
						}),
						answerCandidates: extractAnswerCandidates(
							snapshot.pageText,
							stepHistory
								.map((h) => h.result ?? '')
								.filter(Boolean)
								.slice(-4)
						),
						actions: this.actions,
						maxElementCandidates: this.config.maxElementCandidates,
					}

					const request = buildPlanRequest(ctx)
					if (this.config.verbose) {
						console.debug('[jev-page-agent] state', request.state)
						console.debug('[jev-page-agent] questions', Object.keys(request.questions))
					}

					this.#emitActivity({ type: 'thinking' })
					const evaluation = await this.#evaluate(
						{ state: request.state, model: this.config.model, questions: request.questions },
						signal
					)

					let plan: PlannedAction
					try {
						plan = synthesizePlan(request, evaluation.answers, ctx)
					} catch (error) {
						if (error instanceof ParamUnresolvedError) {
							plan =
								(await this.#fallbackPlan('unresolved_param', request, ctx, signal)) ??
								this.#fallbackAskUser(error, ctx)
						} else if (error instanceof JevPlanError) {
							const fallbackPlan = await this.#fallbackPlan('plan_error', request, ctx, signal)
							if (!fallbackPlan) throw error
							plan = fallbackPlan
						} else {
							throw error
						}
					}

					const threshold = this.config.confidenceThreshold ?? 0
					if (this.#fallback && threshold > 0) {
						const lowest = Math.min(...Object.values(plan.confidences))
						if (lowest < threshold) {
							plan =
								(await this.#fallbackPlan('low_confidence', request, ctx, signal)) ?? plan
						}
					}

					if (this.config.verbose) {
						console.debug('[jev-page-agent] plan', plan.name, plan.params, plan.confidences)
					}

					const event: StepEvent = {
						type: 'step',
						step,
						action: plan.name,
						params: plan.params,
						confidences: plan.confidences,
						usage: evaluation.usage,
					}
					this.history.push(event)
					this.#emitHistoryChange()

					if (plan.name === 'done') {
						result = {
							success: Boolean(plan.params['success'] ?? true),
							data: String(plan.params['text'] ?? ''),
							history: this.history,
						}
						finalStatus = 'completed'
						break
					}

					const action = this.actions[plan.name]
					if (!action) throw new JevPlanError(`Action "${plan.name}" has no executor`)

					this.#emitActivity({ type: 'executing', action: plan.name, params: plan.params })
					try {
						const output = await action.run(plan.params, { agent: this, snapshot, signal })
						signal.throwIfAborted()
						event.result = output
						event.ok = true
					} catch (error) {
						if ((error as Error).name === 'AbortError') throw error
						event.result = error instanceof Error ? error.message : String(error)
						event.ok = false
					}
					this.#emitHistoryChange()

					consecutiveErrors = 0
				} catch (error) {
					if ((error as Error)?.name === 'AbortError') throw error
					consecutiveErrors++
					this.history.push({ type: 'error', message: String(error), raw: error })
					this.#emitActivity({ type: 'error', message: String(error) })
					this.#emitHistoryChange()
					if (consecutiveErrors >= maxConsecutiveErrors) {
						const message = `Too many consecutive errors (${consecutiveErrors}): ${String(error)}`
						result = { success: false, data: message, history: this.history }
						finalStatus = 'error'
						break
					}
				}

				step++
				if (step >= maxSteps) {
					const message = `Step count exceeded maximum (${maxSteps})`
					this.history.push({ type: 'error', message })
					this.#emitHistoryChange()
					result = { success: false, data: message, history: this.history }
					finalStatus = 'error'
					break
				}
			}
		} catch (error) {
			const isAbort = (error as Error)?.name === 'AbortError'
			const message = isAbort ? 'Task aborted' : String(error)
			this.history.push({ type: 'error', message, raw: error })
			this.#emitHistoryChange()
			result = { success: false, data: message, history: this.history }
			finalStatus = isAbort ? 'stopped' : 'error'
		} finally {
			this.#abort.abort()
			resolveRunning()
			this.#setStatus(finalStatus)
		}

		return result
	}

	/**
	 * Ask the configured generative fallback for a plan. Returns null when no
	 * fallback is configured or it fails / returns nothing usable — callers
	 * keep their built-in behavior in that case. `computed` params are filled
	 * here because they depend on the live snapshot, not on the model.
	 */
	async #fallbackPlan(
		reason: FallbackReason,
		request: PlanRequest,
		ctx: PlanContext,
		signal: AbortSignal
	): Promise<PlannedAction | null> {
		if (!this.#fallback) return null
		try {
			const plan = await this.#fallback(
				{ task: ctx.task, step: ctx.step, reason, state: request.state, actions: this.actions },
				signal
			)
			if (!plan) return null
			const spec = this.actions[plan.name]
			if (!spec) {
				throw new Error(`fallback chose unknown action "${plan.name}"`)
			}
			const synthCtx: SynthContext = { task: ctx.task, snapshot: ctx.snapshot, params: plan.params }
			for (const [paramName, param] of Object.entries(spec.params ?? {})) {
				if (param.kind === 'computed') plan.params[paramName] = param.compute(synthCtx)
			}
			this.#emitActivity({ type: 'fallback', reason, action: plan.name, params: plan.params })
			return plan
		} catch (error) {
			this.history.push({
				type: 'error',
				message: `fallback planner failed (${reason}): ${String(error)}`,
				raw: error,
			})
			this.#emitHistoryChange()
			return null
		}
	}

	/**
	 * When a required text param resolves to `__none__`, fall back to asking
	 * the user instead of failing the step.
	 */
	#fallbackAskUser(error: ParamUnresolvedError, ctx: { task: string }): PlannedAction {
		const spec = this.actions['ask_user']
		if (!spec || error.actionName === 'ask_user') throw error
		const question =
			`What value should be used for "${error.paramName}" ` +
			`in "${error.actionName}"? (task: "${ctx.task}")`
		return {
			name: 'ask_user',
			params: { question },
			confidences: {},
			rawAnswers: {},
		}
	}

	dispose(): void {
		this.disposed = true
		this.#abort.abort()
		this.dispatchEvent(new Event('dispose'))
	}
}

function waitFor(seconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, seconds * 1000)
		const onAbort = () => {
			clearTimeout(timer)
			reject(new DOMException('Aborted', 'AbortError'))
		}
		if (signal.aborted) return onAbort()
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

export function builtinActions(): Record<string, AgentAction> {
	return {
		done: {
			description: 'Complete the task and report the final answer to the user.',
			params: {
				text: { kind: 'text', pool: 'answer' },
				success: {
					kind: 'boolean',
					instructions: "Has the user's task been fully and successfully completed?",
				},
			},
			run: () => 'Task completed',
		},
		click: {
			description: 'Click an interactive element (link, button, checkbox, tab, ...)',
			params: {
				index: { kind: 'element' },
			},
			run: (params, ctx) => clickElement(getElement(ctx.snapshot, Number(params['index']))),
		},
		input_text: {
			description: 'Type text into a text field, textarea, or editable element',
			params: {
				index: { kind: 'element' },
				text: { kind: 'text', pool: 'input' },
			},
			run: (params, ctx) =>
				inputText(getElement(ctx.snapshot, Number(params['index'])), String(params['text'])),
		},
		select_option: {
			description: 'Choose an option of a <select> dropdown by its visible text',
			params: {
				index: { kind: 'element' },
				text: { kind: 'text', pool: 'input' },
			},
			run: (params, ctx) =>
				selectOption(getElement(ctx.snapshot, Number(params['index'])), String(params['text'])),
		},
		scroll: {
			description: 'Scroll the page to reveal more content',
			params: {
				direction: {
					kind: 'choice',
					options: ['down', 'up', 'left', 'right'],
					instructions: 'Which direction should the page scroll to make progress?',
				},
			},
			run: (params) => scrollPage(params['direction'] as ScrollDirection),
		},
		wait: {
			description: 'Wait for the page or data to load',
			params: {
				seconds: {
					kind: 'number',
					presets: [1, 3, 5, 10],
					instructions: 'How many seconds should the agent wait?',
				},
			},
			run: async (params, ctx) => {
				await waitFor(Number(params['seconds']), ctx.signal)
				return `✅ Waited ${params['seconds']}s`
			},
		},
		ask_user: {
			description: 'Ask the user for clarification or information needed to continue',
			params: {
				question: {
					kind: 'computed',
					compute: (c) => `What should I do to help complete the task: "${c.task}"?`,
				},
			},
			run: async (params, ctx) => {
				const answer = await ctx.agent.askUser(String(params['question']), ctx.signal)
				return `User answered: ${answer}`
			},
		},
	}
}
