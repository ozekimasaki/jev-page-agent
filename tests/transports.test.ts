import { describe, expect, it, vi } from 'vitest'

import { cloudflareTransport, typesafeTransport } from '../src/jev/transports.js'
import { JevApiError } from '../src/jev/types.js'

const QUESTIONS = {
	urgent: { type: 'noul', instructions: 'Is it urgent?' },
} as const

function mockFetch(body: unknown, status = 200) {
	return vi.fn(async () =>
		new Response(JSON.stringify(body), {
			status,
			statusText: status === 200 ? 'OK' : 'ERR',
			headers: { 'Content-Type': 'application/json' },
		})
	)
}

describe('typesafeTransport', () => {
	it('POSTs {state, model, questions} to /v1/systemone', async () => {
		const f = mockFetch({
			model: 'jev-1.13.0',
			answers: { urgent: { type: 'noul', noul: 0.9 } },
			usage: { input_tokens: 10, output_tokens: 4 },
		})
		const evaluate = typesafeTransport({ apiKey: 'k', fetch: f })
		const res = await evaluate({ state: 'hi', questions: { ...QUESTIONS } })

		expect(f).toHaveBeenCalledTimes(1)
		const [url, init] = f.mock.calls[0]!
		expect(url).toBe('https://api.typesafe.ai/v1/systemone')
		expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer k')
		const sent = JSON.parse(String(init?.body))
		expect(sent.model).toBe('jev-latest')
		expect(sent.questions.urgent.type).toBe('noul')
		expect(res.answers['urgent']).toEqual({ type: 'noul', noul: 0.9 })
	})

	it('throws JevApiError on HTTP failure', async () => {
		const f = mockFetch({ error: { message: 'bad key' } }, 401)
		const evaluate = typesafeTransport({ apiKey: 'k', fetch: f })
		await expect(evaluate({ state: '', questions: {} })).rejects.toThrow(JevApiError)
	})
})

describe('cloudflareTransport', () => {
	it('POSTs {model, input:{state,questions}} and unwraps result', async () => {
		const f = mockFetch({
			success: true,
			result: { answers: { urgent: { type: 'noul', noul: 1 } } },
		})
		const evaluate = cloudflareTransport({ accountId: 'acc', apiToken: 'tok', fetch: f })
		const res = await evaluate({ state: 'x', questions: { ...QUESTIONS } })

		const [url, init] = f.mock.calls[0]!
		expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run')
		const sent = JSON.parse(String(init?.body))
		expect(sent.model).toBe('typesafe/jev')
		expect(sent.input.state).toBe('x')
		expect(res.answers['urgent']).toEqual({ type: 'noul', noul: 1 })
	})
})
