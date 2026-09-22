/**
 * TypeSafe "System One" API types (Jev).
 * Jev evaluates a `state` against typed questions and returns structured
 * answers — it never generates free text.
 *
 * @see https://docs.typesafe.ai
 */

export interface NoulQuestion {
	type: 'noul'
	instructions: string
	criteria?: { true: string; false: string }
}

export interface ChoiceQuestion {
	type: 'choice'
	instructions: string
	/** option key -> human-readable description */
	criteria: Record<string, string>
}

export interface ScoreQuestion {
	type: 'score'
	instructions: string
	/** ordered rubric levels, low -> high */
	criteria: string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type JevQuestions = Record<string, JevQuestion>

export interface NoulAnswer {
	type: 'noul'
	noul: number
}

export interface ChoiceAnswer {
	type: 'choice'
	choice: string
	confidence: number
	probabilities: Record<string, number>
}

export interface ScoreAnswer {
	type: 'score'
	score: number
	confidence: number
	legend?: Record<string, string>
	probabilities: Record<string, number>
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
export type JevAnswers = Record<string, JevAnswer>

export interface JevUsage {
	input_tokens?: number
	output_tokens?: number
}

export interface JevEvaluateRequest {
	state: unknown
	model?: string
	questions: JevQuestions
}

export interface JevEvaluateResult {
	model?: string
	answers: JevAnswers
	usage?: JevUsage
}

/**
 * Lowest-level transport: takes a System One request and returns answers.
 * Implementations: typesafeTransport, cloudflareTransport, or bring your own
 * (e.g. Vercel AI Gateway's `experimental_evaluate`).
 */
export type JevEvaluator = (
	request: JevEvaluateRequest,
	signal?: AbortSignal
) => Promise<JevEvaluateResult>

export class JevApiError extends Error {
	readonly status: number | undefined
	readonly body: unknown

	constructor(message: string, status?: number, body?: unknown) {
		super(message)
		this.name = 'JevApiError'
		this.status = status
		this.body = body
	}
}
