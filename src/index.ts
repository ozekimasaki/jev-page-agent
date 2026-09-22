export { JevPageAgent, builtinActions } from './agent.js'
export type {
	ActionRunContext,
	AgentAction,
	AgentEvent,
	AgentStatus,
	ErrorEvent,
	ExecutionResult,
	JevPageAgentConfig,
	ObservationEvent,
	StepEvent,
} from './agent.js'

export {
	JevPlanError,
	ParamUnresolvedError,
	buildPlanRequest,
	synthesizePlan,
} from './planner.js'
export type {
	ActionSpec,
	HistoryEntry,
	ParamSpec,
	PlanContext,
	PlanRequest,
	PlannedAction,
	SynthContext,
} from './planner.js'

export {
	ActionError,
	clickElement,
	getElement,
	highlight,
	inputText,
	scrollPage,
	selectOption,
} from './actions.js'
export type { ScrollDirection } from './actions.js'

export { snapshotPage } from './dom.js'
export type { IndexedElement, PageSnapshot, SnapshotOptions } from './dom.js'

export { extractAnswerCandidates, extractTextCandidates } from './candidates.js'

export { cloudflareTransport, typesafeTransport } from './jev/transports.js'
export type { CloudflareTransportConfig, TypeSafeTransportConfig } from './jev/transports.js'

export {
	FallbackError,
	openaiCompatibleFallback,
	parseFallbackPlan,
} from './fallback.js'
export type {
	FallbackContext,
	FallbackPlanner,
	FallbackReason,
	OpenAICompatibleFallbackOptions,
} from './fallback.js'

export { JevApiError } from './jev/types.js'
export type {
	ChoiceAnswer,
	ChoiceQuestion,
	JevAnswer,
	JevAnswers,
	JevEvaluateRequest,
	JevEvaluateResult,
	JevEvaluator,
	JevQuestion,
	JevQuestions,
	JevUsage,
	NoulAnswer,
	NoulQuestion,
	ScoreAnswer,
	ScoreQuestion,
} from './jev/types.js'
