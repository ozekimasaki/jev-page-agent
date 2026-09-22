import { describe, expect, it } from 'vitest'

import { JevPageAgent } from '../src/agent.js'
import { openaiCompatibleFallback, parseFallbackPlan, FallbackError } from '../src/fallback.js'
import type { JevEvaluateRequest, JevEvaluateResult } from '../src/jev/types.js'
import type { FallbackContext } from '../src/fallback.js'

const FORM_HTML = `
	<label>Name <input id="name" name="name" type="text" /></label>
	<button id="submit">Sign up</button>
`

const CTX: FallbackContext = {
	task: 'do it',
	step: 0,
	reason: 'unresolved_param',
	state: {},
	actions: {
		click: { description: 'Click element', params: { index: { kind: 'element' } } },
		done: {
			description: 'Finish',
			params: {
				text: { kind: 'text', pool: 'answer' },
				success: { kind: 'boolean' },
			},
		},
	},
}

describe('parseFallbackPlan', () => {
	it('parses a valid JSON plan and normalizes params', () => {
		const plan = parseFallbackPlan(
			'{"action": "click", "params": {"index": "3"}}',
			CTX
		)
		expect(plan.name).toBe('click')
		expect(plan.params['index']).toBe(3)
	})

	it('strips markdown fences', () => {
		const plan = parseFallbackPlan('```json\n{"action": "click", "params": {"index": 1}}\n```', CTX)
		expect(plan.name).toBe('click')
		expect(plan.params['index']).toBe(1)
	})

	it('rejects unknown actions and invalid params', () => {
		expect(() => parseFallbackPlan('{"action": "fly", "params": {}}', CTX)).toThrow(FallbackError)
		expect(() => parseFallbackPlan('{"action": "click", "params": {"index": "abc"}}', CTX)).toThrow(
			FallbackError
		)
		expect(() => parseFallbackPlan('not json', CTX)).toThrow(FallbackError)
	})
})

describe('openaiCompatibleFallback', () => {
	it('POSTs an OpenAI-compatible request and parses the reply', async () => {
		let captured: { url?: string; body?: Record<string, unknown> } = {}
		const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
			captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"action": "click", "params": {"index": 2}}' } }],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		}
		const fallback = openaiCompatibleFallback({
			apiKey: 'sk-test',
			baseURL: 'https://api.deepseek.com',
			model: 'deepseek-chat',
			fetch: fakeFetch as typeof globalThis.fetch,
		})
		const plan = await fallback(CTX)
		expect(captured.url).toBe('https://api.deepseek.com/chat/completions')
		expect(captured.body?.['model']).toBe('deepseek-chat')
		expect(plan?.name).toBe('click')
		expect(plan?.params['index']).toBe(2)
	})
})

describe('JevPageAgent fallback integration', () => {
	/** Follows `script`; input_text's text param is answered `__none__` (unresolvable by jev). */
	const noneEvaluator = (script: string[]) => {
		let calls = 0
		return async (req: JevEvaluateRequest): Promise<JevEvaluateResult> => {
			const action = script[Math.min(calls++, script.length - 1)] ?? 'done'
			const answers: JevEvaluateResult['answers'] = {
				action: { type: 'choice', choice: action, confidence: 0.9, probabilities: {} },
			}
			for (const [name, q] of Object.entries(req.questions)) {
				if (name === 'action') continue
				if (q.type === 'noul') answers[name] = { type: 'noul', noul: 1 }
				else if (q.type === 'choice') {
					const pick = name === 'text_input_text_text' ? '__none__' : (Object.keys(q.criteria)[0] ?? 'x')
					answers[name] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: {} }
				}
			}
			return { answers }
		}
	}

	it('uses the fallback when a required text param is __none__', async () => {
		document.body.innerHTML = FORM_HTML
		const agent = new JevPageAgent({
			evaluate: noneEvaluator(['input_text', 'done']),
			stepDelay: 0,
			fallback: async () => ({
				name: 'input_text',
				params: { index: 1, text: 'from-llm' },
				confidences: {},
				rawAnswers: {},
			}),
		})
		const result = await agent.execute('type something into the name field')
		expect(result.success).toBe(true)
		expect((document.getElementById('name') as HTMLInputElement).value).toBe('from-llm')
	})

	it('re-decides low-confidence plans via the fallback', async () => {
		document.body.innerHTML = FORM_HTML
		const lowConfEvaluator = async (req: JevEvaluateRequest): Promise<JevEvaluateResult> => {
			const answers: JevEvaluateResult['answers'] = {
				action: { type: 'choice', choice: 'wait', confidence: 0.1, probabilities: {} },
			}
			for (const [name, q] of Object.entries(req.questions)) {
				if (name === 'action') continue
				if (q.type === 'noul') answers[name] = { type: 'noul', noul: 1 }
				else if (q.type === 'choice') {
					const pick = Object.keys(q.criteria)[0] ?? 'x'
					answers[name] = { type: 'choice', choice: pick, confidence: 0.1, probabilities: {} }
				}
			}
			return { answers }
		}
		const agent = new JevPageAgent({
			evaluate: lowConfEvaluator,
			stepDelay: 0,
			confidenceThreshold: 0.5,
			fallback: async () => ({
				name: 'done',
				params: { text: 'fallback says done', success: true },
				confidences: {},
				rawAnswers: {},
			}),
		})
		const result = await agent.execute('uncertain task')
		expect(result.success).toBe(true)
		expect(result.data).toBe('fallback says done')
	})

	it('keeps ask_user fallback when the LLM fallback is absent', async () => {
		document.body.innerHTML = FORM_HTML
		let asked = ''
		const agent = new JevPageAgent({
			evaluate: noneEvaluator(['input_text', 'done']),
			stepDelay: 0,
			onAskUser: async (q) => {
				asked = q
				return 'user-value'
			},
		})
		const result = await agent.execute('type something into the name field')
		expect(result.success).toBe(true)
		expect(asked).toContain('input_text')
	})
})
