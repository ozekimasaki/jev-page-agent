# jev-page-agent

An in-page GUI agent whose every decision is made by **[jev](https://docs.typesafe.ai/introduction/coding-agents)** — TypeSafe AI's System One evaluation model — instead of a generative/chat LLM. Inspired by [alibaba/page-agent](https://github.com/alibaba/page-agent), rebuilt around jev's structured evaluation API for fast, typed, per-step decisions.

Zero runtime dependencies. TypeScript, runs in any modern browser page.

## Why jev

jev is an *evaluation* model, not a chat model: it takes a `state` document plus typed `questions` and returns structured `answers` — never free text. That maps naturally onto the observe→decide→act loop of a page agent:

| jev question type | Agent use |
|---|---|
| `choice` (pick an option, returns probabilities + confidence) | Which action to run, which DOM element to target, which candidate text to type |
| `noul` (probability of yes, 0–1) | Boolean parameters (e.g. `done.success`) |
| `score` (rubric score) | Available for custom `ParamSpec`s |

One HTTP call per step asks **every** question speculatively — action selection *and* all parameter questions for every registered action — so a step costs a single evaluation request ("speculative fan-out"). Unused answers are simply ignored.

Because jev cannot *generate* text, free-text parameters (the string to type, the final answer) are resolved as `choice` questions over candidates mined from the task and the page — see `src/candidates.ts`.

## Loop

```
snapshot DOM (indexed interactive elements)
        │
        ▼
buildPlanRequest: state + one typed question set
        │
        ▼
evaluate(state, questions)  ──►  jev  (ONE call per step)
        │
        ▼
synthesizePlan: decode answers → { action, params, confidence }
        │
        ▼
run action (click / input / select / scroll / done / ask_user …)
        │
        ▼
repeat until done | stop() | maxSteps | error budget exhausted
```

## Install & build

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (jsdom)
npm run typecheck
npm run demo       # serves demo/ at http://localhost:8080
```

## Usage

```ts
import { JevPageAgent, typesafeTransport } from 'jev-page-agent'

const agent = new JevPageAgent({
  provider: 'typesafe',
  apiKey: 'ts-…',
  // provider: 'cloudflare', accountId: '…', apiKey: '<cf api token>',
  // evaluate: myJevEvaluator,           // or bring your own evaluator
})

const result = await agent.execute(
  'type "alice@example.com" into the email field, select USA as the country, then click Sign up',
)
// result: { success, history, data }
```

`JevPageAgent` is an `EventTarget`:

```ts
agent.addEventListener('step',   (e) => console.log(e.detail))
agent.addEventListener('error',  (e) => console.warn(e.detail))
agent.addEventListener('statuschange', () => console.log(agent.status)) // idle|running|completed|failed|stopped
agent.addEventListener('historychange', () => render(agent.history))
await agent.stop()             // aborts the running task
```

### Providers

| `provider` | Endpoint | Config |
|---|---|---|
| `'typesafe'` (default) | `POST {baseURL}/v1/systemone` (default `https://api.typesafe.ai`) | `apiKey`, optional `baseURL`, `model` (`'jev-latest'`) |
| `'cloudflare'` | `POST …/accounts/{accountId}/ai/run` with `model: 'typesafe/jev'` | `accountId`, `apiKey` (Workers AI token) |
| custom | your function | `evaluate: (req, signal) => Promise<result>` — useful for Vercel AI Gateway (`typesafe-ai/jev` via `experimental_evaluate`) or tests |

## Built-in actions

`done{text,success}` · `click{index}` · `input_text{index,text}` · `select_option{index,text}` · `scroll{direction}` · `wait{seconds}` · `ask_user{question}`

Each parameter is a typed `ParamSpec` (`element` / `text` / `choice` / `boolean` / `number` / `computed`), so every value jev picks comes from a candidate set the code prepared — never hallucinated. If a required text candidate can't be resolved (`__none__`), the agent falls back to `ask_user` (wire `onAskUser`) rather than guessing.

### Custom actions

```ts
const agent = new JevPageAgent({
  actions: [{
    name: 'open_tab',
    description: 'Open the tab whose visible label is chosen',
    params: { label: { kind: 'choice', options: ['Details', 'History'] } },
    run: async (params) => { document.querySelector(`[data-tab="${params.label}"]`)?.click() },
  }],
})
```

The planner automatically adds `opt_open_tab_label` as a `choice` question in the next evaluation.

## Config reference

| Option | Default | Purpose |
|---|---|---|
| `maxSteps` | 20 | hard cap on loop iterations |
| `stepDelay` | 0.3s | pause between steps |
| `maxConsecutiveErrors` | 3 | abort after N consecutive step failures |
| `maxElementCandidates` | 48 | DOM elements offered to the `element` question |
| `root` | `document.body` | subtree to observe |
| `blacklist` / `extraSelectors` | — | element filtering |
| `onAskUser` | — | `async (question) => string` |
| `verbose` | false | extra event detail |

## Demo

`npm run demo` then open `http://localhost:8080`. Pick a provider (a deterministic `mock` evaluator runs fully offline), enter a task, and watch each step's chosen action + confidence.

## Layout

```
src/
  jev/types.ts        jev question/answer contracts, JevEvaluator signature
  jev/transports.ts   typesafe + cloudflare HTTP transports
  candidates.ts       task/page text-candidate mining (jev can't generate text)
  dom.ts              visible-DOM snapshot → indexed element lines
  planner.ts          one-call question building + answer decoding (speculative fan-out)
  actions.ts          DOM interactions (click, input, select, scroll, highlight)
  agent.ts            JevPageAgent — observe→evaluate→act loop, events, stop()
demo/index.html       runnable demo with a scripted offline evaluator
tests/                vitest suite (jsdom)
```

## Caveats

- jev context is ~32k tokens; the planner caps element/text candidates (`maxElementCandidates`, `maxTextCandidates`) accordingly.
- jev scores/picks; it does not produce narrative memory. The `state` document carries the task, compact history, and current page — design `ParamSpec`s so every required value is a candidate, not something jev must invent.
- Live calls need a TypeSafe API key or a Cloudflare account/token; the mock provider and the test suite run fully offline.
