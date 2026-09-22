import { describe, expect, it } from 'vitest'

import {
	NONE_OPTION,
	ParamUnresolvedError,
	JevPlanError,
	buildPlanRequest,
	synthesizePlan,
	type PlanContext,
} from '../src/planner.js'
import type { PageSnapshot } from '../src/dom.js'

const snapshot: PageSnapshot = {
	url: 'https://example.com/form',
	title: 'Form',
	elementsText: '[0]<input name=email />\n[1]<button>Submit</button>',
	elements: [
		{
			index: 0,
			element: null as unknown as HTMLElement,
			line: '[0]<input type=email name=email placeholder="Email" />',
			tagName: 'input',
			editable: true,
			disabled: false,
			scrollable: false,
		},
		{
			index: 1,
			element: null as unknown as HTMLElement,
			line: '[1]<button>Submit</button>',
			tagName: 'button',
			editable: false,
			disabled: false,
			scrollable: false,
		},
	],
	pageText: 'Sign up\nEmail\nPassword',
	viewportWidth: 800,
	viewportHeight: 600,
	pixelsAbove: 0,
	pixelsBelow: 900,
	totalPages: 2,
	currentPagePosition: 0,
}

const actions = {
	done: {
		description: 'Complete the task',
		params: {
			text: { kind: 'text', pool: 'answer' } as const,
			success: { kind: 'boolean' } as const,
		},
	},
	click: {
		description: 'Click an element',
		params: { index: { kind: 'element' } as const },
	},
	input_text: {
		description: 'Type text',
		params: {
			index: { kind: 'element' } as const,
			text: { kind: 'text', pool: 'input' } as const,
		},
	},
	scroll: {
		description: 'Scroll',
		params: {
			direction: {
				kind: 'choice',
				options: ['down', 'up', 'left', 'right'],
			} as const,
		},
	},
}

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
	return {
		task: 'type "alice@example.com" into the email field',
		step: 0,
		maxSteps: 20,
		snapshot,
		history: [],
		inputCandidates: ['alice@example.com'],
		answerCandidates: ['Sign up', 'Task completed'],
		actions,
		...overrides,
	}
}

function choice(value: string, confidence = 0.9) {
	return { type: 'choice' as const, choice: value, confidence, probabilities: { [value]: 0.9 } }
}

describe('buildPlanRequest', () => {
	it('asks one speculative question set per step', () => {
		const req = buildPlanRequest(ctx())
		expect(Object.keys(req.questions)).toEqual(
			expect.arrayContaining([
				'action',
				'element',
				'opt_scroll_direction',
				'bool_done_success',
				'text_done_text',
				'text_input_text_text',
			])
		)
		const elementQ = req.questions['element']
		expect(elementQ?.type).toBe('choice')
		expect((elementQ as any).criteria['0']).toContain('input')
		expect((elementQ as any).criteria['1']).toContain('Submit')
	})

	it('state carries the page, history and candidates', () => {
		const req = buildPlanRequest(ctx())
		const state = req.state as any
		expect(state.task).toContain('alice@example.com')
		expect(state.interactive_elements['0']).toContain('input')
		expect(state.text_candidates).toContain('alice@example.com')
	})
})

describe('synthesizePlan', () => {
	it('decodes a click plan', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		const plan = synthesizePlan(
			req,
			{ action: choice('click'), element: choice('1') },
			c
		)
		expect(plan.name).toBe('click')
		expect(plan.params).toEqual({ index: 1 })
		expect(plan.confidences.action).toBe(0.9)
	})

	it('decodes input_text with a candidate', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		const plan = synthesizePlan(
			req,
			{
				action: choice('input_text'),
				element: choice('0'),
				text_input_text_text: choice('c0'),
			},
			c
		)
		expect(plan.params).toEqual({ index: 0, text: 'alice@example.com' })
	})

	it('decodes done with success + answer text', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		const plan = synthesizePlan(
			req,
			{
				action: choice('done'),
				bool_done_success: { type: 'noul', noul: 0.97 },
				text_done_text: choice('c1'),
			},
			c
		)
		expect(plan.params).toEqual({ text: 'Task completed', success: true })
	})

	it('rejects an unknown action', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		expect(() =>
			synthesizePlan(req, { action: choice('teleport') }, c)
		).toThrow(JevPlanError)
	})

	it('rejects an out-of-range element', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		expect(() =>
			synthesizePlan(req, { action: choice('click'), element: choice('9') }, c)
		).toThrow(JevPlanError)
	})

	it('maps __none__ on a required text param to ParamUnresolvedError', () => {
		const c = ctx()
		const req = buildPlanRequest(c)
		expect(() =>
			synthesizePlan(
				req,
				{
					action: choice('input_text'),
					element: choice('0'),
					text_input_text_text: choice(NONE_OPTION),
				},
				c
			)
		).toThrow(ParamUnresolvedError)
	})
})
