/**
 * Planner: turns the current page + task into one Jev evaluation
 * (speculative fan-out — every parameter question is asked up front in a
 * single request) and decodes the answers back into a concrete action.
 *
 * Jev cannot generate text, so every parameter is answered as a typed
 * `choice`/`noul` question over candidates the code prepares.
 */
import type { IndexedElement, PageSnapshot } from './dom.js'
import type { ChoiceQuestion, JevAnswers, JevQuestion, JevQuestions } from './jev/types.js'

/** Sentinel option meaning "none of the offered text candidates fits". */
export const NONE_OPTION = '__none__'

// ---------- action specs ----------

export interface SynthContext {
	task: string
	snapshot: PageSnapshot
	params: Record<string, unknown>
}

export type ParamSpec =
	| { kind: 'element' }
	| { kind: 'text'; pool: 'input' | 'answer'; optional?: boolean }
	| { kind: 'choice'; options: string[]; instructions?: string }
	| { kind: 'boolean'; instructions?: string }
	| { kind: 'number'; presets: number[]; instructions?: string }
	| { kind: 'computed'; compute: (ctx: SynthContext) => unknown }

export interface ActionSpec {
	description: string
	params?: Record<string, ParamSpec>
}

export interface HistoryEntry {
	step: number
	action: string
	params?: unknown
	result?: string
	ok?: boolean
}

export interface PlanContext {
	task: string
	/** 0-based step index */
	step: number
	maxSteps: number
	snapshot: PageSnapshot
	history: HistoryEntry[]
	inputCandidates: string[]
	answerCandidates: string[]
	actions: Record<string, ActionSpec>
	/** cap on how many elements are offered to the `element` question (default 48) */
	maxElementCandidates?: number
}

export interface PlanRequest {
	state: unknown
	questions: JevQuestions
	/** data needed to decode jev's answers back into params */
	decode: {
		/** elements actually offered (truncated at maxElementCandidates) */
		elements: IndexedElement[]
		/** question name -> candidate strings (index in array = `c{index}` key) */
		textOptions: Record<string, string[]>
	}
}

export interface PlannedAction {
	name: string
	params: Record<string, unknown>
	/** jev confidence per answered question (for observability) */
	confidences: Record<string, number>
	/** the raw jev answers */
	rawAnswers: JevAnswers
}

export class JevPlanError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'JevPlanError'
	}
}

export class ParamUnresolvedError extends Error {
	readonly actionName: string
	readonly paramName: string

	constructor(actionName: string, paramName: string, message?: string) {
		super(message ?? `Could not resolve parameter "${paramName}" for action "${actionName}"`)
		this.name = 'ParamUnresolvedError'
		this.actionName = actionName
		this.paramName = paramName
	}
}

// ---------- request building ----------

const ELEMENT_QUESTION = 'element'
const ACTION_QUESTION = 'action'

export function textQuestionName(action: string, param: string): string {
	return `text_${action}_${param}`
}
export function optQuestionName(action: string, param: string): string {
	return `opt_${action}_${param}`
}
export function boolQuestionName(action: string, param: string): string {
	return `bool_${action}_${param}`
}
export function numQuestionName(action: string, param: string): string {
	return `num_${action}_${param}`
}

export function buildPlanRequest(ctx: PlanContext): PlanRequest {
	const { snapshot, actions } = ctx
	const maxElements = ctx.maxElementCandidates ?? 48

	const elements = snapshot.elements.slice(0, maxElements)
	const truncated = snapshot.elements.length > elements.length

	const elementCriteria: Record<string, string> = {}
	for (const el of elements) elementCriteria[String(el.index)] = el.line

	// Every action must be expressible with jev answers; "computed" params are
	// filled in code so they are always expressible.
	const actionCriteria: Record<string, string> = {}
	for (const [name, spec] of Object.entries(actions)) {
		actionCriteria[name] = spec.description
	}

	const questions: JevQuestions = {}
	const textOptions: Record<string, string[]> = {}

	questions[ACTION_QUESTION] = {
		type: 'choice',
		instructions:
			'What is the single best next action to progress toward completing the task? ' +
			'Pick "done" only when the task is fully satisfied.',
		criteria: actionCriteria,
	} satisfies ChoiceQuestion

	if (elements.length > 0) {
		questions[ELEMENT_QUESTION] = {
			type: 'choice',
			instructions:
				'Which interactive element is the most relevant target for the next action ' +
				'toward the task? Pick the single best match.',
			criteria: elementCriteria,
		} satisfies ChoiceQuestion
	}

	for (const [actionName, spec] of Object.entries(actions)) {
		for (const [paramName, param] of Object.entries(spec.params ?? {})) {
			switch (param.kind) {
				case 'text': {
					const pool = param.pool === 'answer' ? ctx.answerCandidates : ctx.inputCandidates
					const questionName = textQuestionName(actionName, paramName)
					const criteria: Record<string, string> = {}
					pool.forEach((candidate, i) => {
						criteria[`c${i}`] = candidate
					})
					criteria[NONE_OPTION] = 'none of these — the needed value is not listed'
					textOptions[questionName] = pool
					questions[questionName] = {
						type: 'choice',
						instructions:
							`If the agent performs "${actionName}", which text value should be used ` +
							`for "${paramName}"? Pick the most likely candidate from the task, or "${NONE_OPTION}".`,
						criteria,
					} satisfies ChoiceQuestion
					break
				}
				case 'choice': {
					const criteria: Record<string, string> = {}
					for (const opt of param.options) criteria[opt] = opt
					questions[optQuestionName(actionName, paramName)] = {
						type: 'choice',
						instructions:
							param.instructions ??
							`If the agent performs "${actionName}", which value should "${paramName}" take?`,
						criteria,
					} satisfies ChoiceQuestion
					break
				}
				case 'boolean': {
					questions[boolQuestionName(actionName, paramName)] = {
						type: 'noul',
						instructions:
							param.instructions ??
							`If the agent performs "${actionName}", should "${paramName}" be true?`,
					}
					break
				}
				case 'number': {
					const criteria: Record<string, string> = {}
					for (const preset of param.presets) criteria[String(preset)] = String(preset)
					questions[numQuestionName(actionName, paramName)] = {
						type: 'choice',
						instructions:
							param.instructions ??
							`If the agent performs "${actionName}", which value should "${paramName}" take?`,
						criteria,
					} satisfies ChoiceQuestion
					break
				}
				case 'element':
				case 'computed':
					// covered by the shared element question / resolved in code
					break
			}
		}
	}

	const state = {
		task: ctx.task,
		step: ctx.step + 1,
		max_steps: ctx.maxSteps,
		page: { url: snapshot.url, title: snapshot.title },
		scroll_position: `${snapshot.pixelsAbove}px above / ${snapshot.pixelsBelow}px below`,
		page_text: snapshot.pageText,
		interactive_elements: elementCriteria,
		interactive_elements_truncated: truncated || undefined,
		history: ctx.history.slice(-10).map((h) => ({
			step: h.step,
			action: h.action,
			params: h.params,
			result: h.result,
			ok: h.ok,
		})),
		text_candidates: ctx.inputCandidates,
		answer_candidates: ctx.answerCandidates,
	}

	return { state, questions, decode: { elements, textOptions } }
}

// ---------- answer decoding ----------

function getChoice(answers: JevAnswers, name: string): { value: string; confidence: number } {
	const answer = answers[name]
	if (!answer || answer.type !== 'choice') {
		throw new JevPlanError(`Missing or invalid choice answer "${name}"`)
	}
	return { value: answer.choice, confidence: answer.confidence }
}

function getNoul(answers: JevAnswers, name: string): number {
	const answer = answers[name]
	if (!answer || answer.type !== 'noul') {
		throw new JevPlanError(`Missing or invalid noul answer "${name}"`)
	}
	return answer.noul
}

export function synthesizePlan(request: PlanRequest, answers: JevAnswers, ctx: PlanContext): PlannedAction {
	const confidences: Record<string, number> = {}

	const actionPick = getChoice(answers, ACTION_QUESTION)
	confidences[ACTION_QUESTION] = actionPick.confidence
	const actionName = actionPick.value
	const spec = ctx.actions[actionName]
	if (!spec) {
		throw new JevPlanError(`Jev chose unknown action "${actionName}"`)
	}

	const params: Record<string, unknown> = {}
	const synthCtx: SynthContext = { task: ctx.task, snapshot: ctx.snapshot, params }

	for (const [paramName, param] of Object.entries(spec.params ?? {})) {
		switch (param.kind) {
			case 'element': {
				const pick = getChoice(answers, ELEMENT_QUESTION)
				confidences[ELEMENT_QUESTION] = pick.confidence
				const index = Number.parseInt(pick.value, 10)
				if (!Number.isInteger(index) || index < 0 || index >= request.decode.elements.length) {
					throw new JevPlanError(
						`Jev picked element "${pick.value}" but only ${request.decode.elements.length} candidates were offered`
					)
				}
				params[paramName] = request.decode.elements[index]!.index
				break
			}
			case 'text': {
				const qname = textQuestionName(actionName, paramName)
				const pick = getChoice(answers, qname)
				confidences[qname] = pick.confidence
				if (pick.value === NONE_OPTION) {
					if (param.optional) break
					throw new ParamUnresolvedError(actionName, paramName)
				}
				const candidates = request.decode.textOptions[qname] ?? []
				const match = /^c(\d+)$/.exec(pick.value)
				const text = match ? candidates[Number(match[1])] : undefined
				if (text === undefined) {
					throw new JevPlanError(`Jev picked unknown text option "${pick.value}" for "${paramName}"`)
				}
				params[paramName] = text
				break
			}
			case 'choice': {
				const qname = optQuestionName(actionName, paramName)
				const pick = getChoice(answers, qname)
				confidences[qname] = pick.confidence
				if (!param.options.includes(pick.value)) {
					throw new JevPlanError(`Jev picked invalid option "${pick.value}" for "${paramName}"`)
				}
				params[paramName] = pick.value
				break
			}
			case 'boolean': {
				const qname = boolQuestionName(actionName, paramName)
				params[paramName] = getNoul(answers, qname) >= 0.5
				break
			}
			case 'number': {
				const qname = numQuestionName(actionName, paramName)
				const pick = getChoice(answers, qname)
				confidences[qname] = pick.confidence
				const num = Number(pick.value)
				if (!Number.isFinite(num) || !param.presets.includes(num)) {
					throw new JevPlanError(`Jev picked invalid number "${pick.value}" for "${paramName}"`)
				}
				params[paramName] = num
				break
			}
			case 'computed': {
				params[paramName] = param.compute(synthCtx)
				break
			}
		}
	}

	return { name: actionName, params, confidences, rawAnswers: answers }
}
