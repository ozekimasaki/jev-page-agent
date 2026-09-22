import { beforeEach, describe, expect, it } from 'vitest'

import { JevPageAgent } from '../src/agent.js'
import type { JevEvaluateRequest, JevEvaluateResult } from '../src/jev/types.js'

const FORM_HTML = `
	<label>Name <input id="name" name="name" type="text" /></label>
	<label>Country
		<select id="country">
			<option>Japan</option>
			<option>USA</option>
		</select>
	</label>
	<button id="submit">Sign up</button>
`

function pickElement(req: JevEvaluateRequest, match: RegExp): string {
	const q = req.questions['element']
	if (!q || q.type !== 'choice') return '0'
	for (const [key, text] of Object.entries(q.criteria)) {
		if (match.test(text)) return key
	}
	return '0'
}

/** A deterministic evaluator that follows a script of action names. */
function scriptedEvaluator(script: string[], elementMatch: RegExp = /input|select|button/i) {
	let calls = 0
	return async (req: JevEvaluateRequest): Promise<JevEvaluateResult> => {
		const action = script[Math.min(calls++, script.length - 1)] ?? 'done'
		const answers: JevEvaluateResult['answers'] = {
			action: { type: 'choice', choice: action, confidence: 0.99, probabilities: {} },
		}
		for (const [name, q] of Object.entries(req.questions)) {
			if (name === 'action') continue
			if (q.type === 'noul') answers[name] = { type: 'noul', noul: 1 }
			else if (q.type === 'choice') {
				const keys = Object.keys(q.criteria)
				let pick = keys[0] ?? 'x'
				if (name === 'element') pick = pickElement(req, elementMatch)
				if (name.startsWith('text_')) pick = 'c0'
				answers[name] = {
					type: 'choice',
					choice: pick,
					confidence: 0.9,
					probabilities: { [pick]: 0.9 },
				}
			}
		}
		return { answers, usage: { input_tokens: 100, output_tokens: 20 } }
	}
}

describe('JevPageAgent', () => {
	beforeEach(() => {
		document.body.innerHTML = FORM_HTML
	})

	it('types text into an input and finishes', async () => {
		const agent = new JevPageAgent({
			evaluate: scriptedEvaluator(['input_text', 'done']),
			stepDelay: 0,
		})
		const result = await agent.execute('type "alice@example.com" into the name field')
		expect(result.success).toBe(true)
		expect((document.getElementById('name') as HTMLInputElement).value).toBe('alice@example.com')
		const steps = result.history.filter((e) => e.type === 'step')
		expect(steps.length).toBe(2)
		expect(steps[0]!.type === 'step' && steps[0]!.action).toBe('input_text')
	})

	it('clicks a button', async () => {
		let clicked = false
		document.getElementById('submit')!.addEventListener('click', () => (clicked = true))
		const agent = new JevPageAgent({
			evaluate: scriptedEvaluator(['click', 'done'], /sign up|button/i),
			stepDelay: 0,
		})
		const result = await agent.execute('click the submit button')
		expect(result.success).toBe(true)
		expect(clicked).toBe(true)
	})

	it('reports failure when the action fails', async () => {
		document.body.innerHTML = '<p>nothing interactive</p>'
		const agent = new JevPageAgent({
			evaluate: scriptedEvaluator(['input_text']),
			stepDelay: 0,
			maxSteps: 2,
		})
		// element question absent (no elements) -> synthesizePlan throws JevPlanError
		const result = await agent.execute('type hello')
		expect(result.success).toBe(false)
		expect(result.history.some((e) => e.type === 'error')).toBe(true)
	})

	it('stop() aborts a running task', async () => {
		const agent = new JevPageAgent({
			evaluate: scriptedEvaluator(['wait']),
			stepDelay: 0,
		})
		const pending = agent.execute('wait for it')
		await agent.stop()
		const result = await pending
		expect(result.success).toBe(false)
	})
})
