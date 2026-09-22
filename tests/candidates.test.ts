import { describe, expect, it } from 'vitest'

import { extractAnswerCandidates, extractTextCandidates } from '../src/candidates.js'

describe('extractTextCandidates', () => {
	it('finds quoted strings', () => {
		const c = extractTextCandidates('Type "alice@example.com" into the email field')
		expect(c).toContain('alice@example.com')
	})

	it('finds text after action verbs', () => {
		const c = extractTextCandidates('Search for running shoes and open the first result')
		expect(c).toContain('running shoes')
	})

	it('finds emails, urls and numbers', () => {
		const c = extractTextCandidates('notify bob@corp.io about https://example.com/x within 3 days')
		expect(c).toContain('bob@corp.io')
		expect(c).toContain('https://example.com/x')
		expect(c).toContain('3')
	})

	it('finds Japanese bracketed and suffix-marked text', () => {
		const c = extractTextCandidates('「田中太郎」を入力して')
		expect(c).toContain('田中太郎')
		const c2 = extractTextCandidates('検索欄に 猫の写真 を検索')
		expect(c2.length).toBeGreaterThan(0)
	})

	it('dedupes and caps', () => {
		const c = extractTextCandidates('type "a" then type "a" then "a"', { max: 3 })
		expect(new Set(c).size).toBe(c.length)
		expect(c.length).toBeLessThanOrEqual(3)
	})
})

describe('extractAnswerCandidates', () => {
	it('includes page text lines and a generic fallback', () => {
		const c = extractAnswerCandidates('Hello World\nFooter nav\nx', ['saved ok'])
		expect(c).toContain('Hello World')
		expect(c).toContain('saved ok')
		expect(c).toContain('Task completed')
	})
})
