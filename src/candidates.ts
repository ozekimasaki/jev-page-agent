/**
 * Text-candidate extraction.
 *
 * Jev cannot generate text, so free-text action parameters (e.g. the string to
 * type into an input, or the final answer) are resolved as a `choice` question
 * over candidate strings found in the task, page text, or action history.
 */

const QUOTED = /["'“”‘’「」『』]([^"'“”‘’「」『』\n]{1,120})["'“”‘’「」『』]/g

const AFTER_VERB = new RegExp(
	[
		'(?:search(?:\\s+for)?|type|input|enter|fill(?:\\s+in)?|write|select|choose|pick|name(?:d)?|call(?:ed)?)',
		'\\s*[:：]?\\s*',
		'["\'“‘「『]?',
		'([^\\n"\',.，、。:：;"“”‘’「」『』]{1,80}?)',
		'["\'”’」』]?',
		'(?=\\s*[,.，、。;:：]|\\s+(?:in|into|on|to|and|then|を|と|で|に|する|して|ください)|$)',
	].join(''),
	'gi'
)

// Japanese: 「Xを入力」「Xと入力」「Xを検索」「Xで検索」「Xにする」「Xにして」
const JA_SUFFIX = /([^\s，、。！？「」『』\n]{1,40}?)\s*(?:を入力|と入力|に入力|を検索|で検索|と検索|にする|にして|と答えて)/g

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g
const URL = /https?:\/\/[^\s"'<>]+/g
const NUMBER = /(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g

export interface CandidateOptions {
	max?: number
}

function dedupe(items: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const item of items) {
		const trimmed = item.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		out.push(trimmed)
	}
	return out
}

/**
 * Strings the user likely wants typed/selected, mined from the task text.
 */
export function extractTextCandidates(task: string, opts: CandidateOptions = {}): string[] {
	const max = opts.max ?? 16
	const found: string[] = []

	for (const m of task.matchAll(QUOTED)) if (m[1]) found.push(m[1])
	for (const m of task.matchAll(AFTER_VERB)) if (m[1]) found.push(m[1])
	for (const m of task.matchAll(JA_SUFFIX)) if (m[1]) found.push(m[1])
	for (const m of task.matchAll(EMAIL)) found.push(m[0])
	for (const m of task.matchAll(URL)) found.push(m[0])
	for (const m of task.matchAll(NUMBER)) found.push(m[0])

	return dedupe(found).slice(0, max)
}

/**
 * Candidate final answers for `done.text`: recent tool outputs plus
 * sentence-ish fragments from the visible page text.
 */
export function extractAnswerCandidates(
	pageText: string,
	recentOutputs: string[],
	opts: CandidateOptions = {}
): string[] {
	const max = opts.max ?? 12
	const found: string[] = []

	for (const output of recentOutputs) {
		if (output && output.length <= 160) found.push(output)
	}
	for (const line of pageText.split(/\n+/)) {
		const trimmed = line.trim()
		if (trimmed.length >= 2 && trimmed.length <= 120) found.push(trimmed)
	}
	found.push('Task completed')

	return dedupe(found).slice(0, max)
}
