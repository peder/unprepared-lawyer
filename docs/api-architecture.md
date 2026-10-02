# Trial API & Game State Machine: design plan (v1)

Author: Claude (architect). Date: 2026-09-30. Status: **proposed**, to be implemented before any new UI work.
Scope: separate the presentation layer from the game/data layer so that the terminal client, the React HUD, and future clients (web, desktop, mobile) all play through **one** authoritative Trial API. Authorization is out of scope for v1 (see §12).

---

## 1. Principles

1. **The server is authoritative.** Clients send *intents* ("I want to ask this question"). The server decides whether that intent is legal right now, runs it, and tells everyone what happened. No client computes rules, counts, timers, or outcomes.
2. **The server tells the client what it may do.** Every state response includes `allowedActions`. The UI renders buttons, inputs, and timers from that list and nothing else. If an action isn't listed, the UI doesn't offer it, and the server rejects it anyway if sent.
3. **Commands in, events out.** Every change is a *command* that produces zero or more *events*. State is the result of applying events in order. Events are the single source of truth for rendering, persistence, replay, and debugging.
4. **Hidden information never leaves the server.** The API exposes only the **PlayerView** projection. The case file, truth, facts, witness profiles, RECORD view, JURY view, and Jev/LLM prompts are internal.
5. **One trial, one writer.** Commands against a trial are processed strictly one at a time. That removes almost every concurrency bug by construction.

---

## 2. Layers

```
client/            React HUD, terminal client (scripts/play.ts) — render PlayerView + allowedActions, send commands
  │  HTTP + SSE (or in-process for terminal/tests)
server/api/        Transport adapters: REST routes, SSE stream, request validation (zod), error mapping
server/app/        TrialService: load trial, serialize commands, run effects (Jev, LLM, timers), persist events, publish
server/core/       PURE domain: state machine, rules, reducers, projections. No I/O, no clock, no network, no randomness sources.
server/ports/      Interfaces the app layer depends on: JevClient, LLMClient, TrialStore, Clock, Rng, EventBus
server/adapters/   Implementations: HttpJevClient, DirectLLMClient, InMemoryTrialStore, FileTrialStore, SystemClock…
```

Rules:
- `core/` imports nothing from `app/`, `api/`, `adapters/`, or Node built-ins. It's testable with plain objects.
- `app/` depends on `core/` and on `ports/` interfaces only.
- `api/` and the terminal client call **only** `TrialService`. `scripts/play.ts` gets rewritten as a thin client over `TrialService` (in-process). That's the proof the separation works.
- `TrialEngine` today mixes rules, I/O, and sampling. It gets split into `core/` (decide/evolve) and `app/` (effects) per §4. Its existing tests become the regression suite for the refactor.

---

## 3. Resources

| Resource | What it is | Exposed as |
|---|---|---|
| **Case** | An authored case file in the library (`cases/*.json`) | `CaseSummary` only: id, title, charge, defendant, difficulty. Never facts/truth/docs. |
| **Trial** | One play-through of a case: phase, counters, transcript, jury meters, judge patience, outcome | `PlayerView` + `allowedActions` + `version` |
| **Event** | An append-only record of something that happened in a trial | Streamed to clients as `PublicEvent` (redacted) |
| *(later)* **Lawyer / Career / Docket** | Persistent player record, double-booked days | Out of scope for v1; the Trial carries an optional `lawyerId` so it can attach later. |

### Endpoints (v1)

```
GET    /v1/cases                              → CaseSummary[]
POST   /v1/trials            { caseId?, seed? } → 201 TrialResponse     (random unseen case if caseId omitted)
GET    /v1/trials/:id                         → TrialResponse          (snapshot)
POST   /v1/trials/:id/commands  Command       → 202 CommandAccepted | 409 | 422 | 423
GET    /v1/trials/:id/events?after=<seq>      → SSE stream of PublicEvent (resumable)
GET    /v1/trials/:id/documents/:docId        → DocumentBody  (only while a READ window for that doc is open)
```

```ts
interface TrialResponse {
  trialId: string;
  version: number;            // increments on every applied event
  lastEventSeq: number;
  view: PlayerView;           // redacted projection (§6)
  allowedActions: AllowedAction[];
  busy: boolean;              // an effect is in flight (Jev/LLM); only 'abort-safe' actions allowed
  serverTime: string;         // for client timer display
}
```

REST for commands plus SSE for events is the simplest thing that works everywhere (browsers, Electron, terminal). WebSocket can replace SSE later without changing the command/event model.

---

## 4. The state machine

### 4.1 Decide / Evolve

The core is two pure functions plus a table:

```ts
// core/trial.ts
decide(state: TrialState, cmd: Command, ctx: { now: number }): Decision
evolve(state: TrialState, event: DomainEvent): TrialState
allowedActions(state: TrialState, now: number): AllowedAction[]
```

`Decision` is one of:
- `{ kind: "reject", code, message }`: illegal right now (wrong phase, no questions left, window closed, busy…).
- `{ kind: "events", events }`: pure outcome, apply immediately (e.g. `WitnessSelected`, `QuestionWaived`).
- `{ kind: "effect", effect, pendingEvent }`: needs outside work (a Jev call, a voice line, a timer). The service marks the trial `busy`, runs the effect, and turns the result into events.

**Randomness and model output never live in `core/`.** The service performs Jev and LLM calls, *samples* with the trial's seeded RNG, and records the **results** (probabilities, sampled choices, generated text, latencies) inside the events. Replaying events therefore reproduces a trial exactly, with no model calls. That gives us free regression tests, bug reproduction from a player's log, and "watch the replay" as a feature.

### 4.2 Transition table (data, not scattered `if`s)

```ts
// core/transitions.ts: the single place that says what is legal when
const TRANSITIONS: Record<Phase, Partial<Record<CommandType, Guard>>> = {
  OPENING:     { SubmitOpening: g.textWithin(CONFIG.MAX_WORDS_OPENING) },
  P_READ:      { ReadDocument: g.readsLeft.and(g.docExists), SkipRead: g.always },
  P_DIRECT:    { Object: g.objectionWindowOpen.and(g.objectionsLeft) /* prosecutor asks; system drives */ },
  P_CROSS:     { AskQuestion: g.questionsLeft.and(g.textWithin(60)), WaiveQuestions: g.questionsLeft },
  D_SELECT:    { SelectWitness: g.defenseWitnessAvailable },
  D_READ:      { ReadDocument: g.readsLeft.and(g.docExists), SkipRead: g.always },
  D_DIRECT:    { AskQuestion: g.questionsLeft.and(g.textWithin(60)), WaiveQuestions: g.questionsLeft },
  D_CROSS:     { Object: g.objectionWindowOpen.and(g.objectionsLeft) },
  FINAL_READ:  { ReadDocument: g.readsLeft.and(g.docExists), SkipRead: g.always },
  CLOSING:     { SubmitClosing: g.textWithin(CONFIG.MAX_WORDS_CLOSING) },
  DELIBERATION:{ /* system-driven only */ },
  DONE:        { /* none */ },
  SETUP:       { /* system-driven only */ },
};
```

`allowedActions()` is computed from this same table, so the list the client sees and the guard the server enforces can never disagree. Add a test that iterates every phase: each action in `allowedActions` passes `decide`, and every command type *not* listed is rejected.

### 4.3 Sub-states inside a phase

Some phases have short-lived inner states. Model them explicitly on `TrialState`, not as hidden promises:

- `pending: null | { kind: "jev" | "voice" | "cross" | "closing" | "deliberation"; startedAt; commandId }`: the trial is `busy`. Only abort-safe actions are allowed (see objection below).
- `window: null | { kind: "objection"; questionSeq; deadline } | { kind: "read"; docId; deadline }`

### 4.4 System-driven transitions and timers

Not everything is a player action. The service issues **system commands** itself:

- `AdvancePhase`: after the last witness question, after deliberation, and so on.
- `ProsecutorAsks`: at the start of each prosecutor question.
- `WindowExpired { windowId }`: fired by a server timer at `deadline`.

Timers are server-owned. The client receives `deadline` (and `serverTime`) and draws a countdown, but its countdown is cosmetic. If a player sends `Object` after the deadline, it's rejected with `WINDOW_CLOSED`, even if their screen still showed 0.3 s. Timers are rescheduled from persisted `deadline`s on server restart.

### 4.5 The objection flow, as the worked example

```
ProsecutorAsks (system)
  → event ProsecutorQuestionPosed { seq, text }
  → effect: Jev Call A + start voice line (speculative, abortable)
  → event ObjectionWindowOpened { questionSeq, deadline = now + 4s }
       allowedActions: [ Object{ grounds } ]            ← player
Object (player, before deadline)
  → effect: Jev Call O
  → event ObjectionRuled { sustained }
       sustained → QuestionStricken; abort voice; no answer
       overruled → use speculative Call A + voice
WindowExpired (system, at deadline) if no Object
  → use speculative Call A + voice → WitnessAnswered
→ JuryUpdated (Call B) → next ProsecutorAsks or AdvancePhase
```

Exactly one of `Object` / `WindowExpired` wins. Because commands for a trial are serialized (§5), whichever arrives first is applied, and the second is rejected as `WINDOW_CLOSED`.

---

## 5. Controlling allowable actions at scale

"Imagine this is a popular app." These are the mechanisms, cheapest first.

1. **Per-trial serialization (actor/mailbox).** Each live trial has one in-memory mailbox. Commands queue and run one at a time, including their effects. Double-clicks, two tabs, retries, and a timer racing the player all become ordered, and the phase check in `decide` is always made against current state.
2. **Optimistic concurrency.** Every command carries `expectedVersion` (the `version` the client last saw). If the trial has moved on, the server returns `409 VERSION_CONFLICT` with the fresh `TrialResponse`, and the client re-renders from it. This catches the "I clicked on a stale screen" case.
3. **Idempotency.** Every command carries a client-generated `commandId` (UUID). The service stores the outcome per `commandId` for the trial's lifetime, so a retried POST returns the original result and doesn't ask the same question twice.
4. **Busy lock.** While `pending` is set, non-abort-safe commands get `423 TRIAL_BUSY` (with the current `allowedActions`). The UI disables inputs while `busy` is true.
5. **Schema validation at the edge.** Every command is validated with zod in `api/` before it reaches the service: types, lengths, word caps, and ids that exist in this trial's PlayerView.
6. **Rate limiting (later, with auth).** Per player and per trial. It's cheap insurance against scripted spam, and matters because every command can cost model calls.

**Scaling out:** trials are independent. Run N stateless API nodes and route all commands for a trial to the node that owns its mailbox (consistent hashing on `trialId`, or a short-lived ownership lease in the store). Any node can serve `GET` snapshots from the store. That's the whole scaling story for v1. No distributed locks per command.

### Command envelope

```ts
interface CommandEnvelope<T extends Command = Command> {
  commandId: string;          // idempotency key (UUID)
  expectedVersion: number;    // optimistic concurrency
  command: T;
}

type Command =
  | { type: "SubmitOpening"; text: string }
  | { type: "ReadDocument"; docId: string }
  | { type: "SkipRead" }
  | { type: "SelectWitness"; witnessId: string }
  | { type: "AskQuestion"; text: string }
  | { type: "WaiveQuestions" }
  | { type: "Object"; grounds: ObjectionGrounds }
  | { type: "SubmitClosing"; text: string };
// System-only (never accepted over HTTP): ProsecutorAsks, WindowExpired, AdvancePhase, RunDeliberation
```

### Allowed actions

```ts
type AllowedAction =
  | { type: "SubmitOpening"; maxWords: number; deadline?: string }
  | { type: "ReadDocument"; docs: { docId: string; bin: string; title: string; alreadyRead: boolean }[]; readsLeft: number }
  | { type: "SkipRead" }
  | { type: "SelectWitness"; witnesses: { witnessId: string; name: string; role: string }[] }
  | { type: "AskQuestion"; questionsLeft: number; maxChars: number }
  | { type: "WaiveQuestions" }
  | { type: "Object"; grounds: ObjectionGrounds[]; objectionsLeft: number; deadline: string }
  | { type: "SubmitClosing"; maxWords: number };
```

Actions carry the data the UI needs to render them (which docs, which witnesses, how many left, the deadline), so the client never has to derive options from state.

### Errors

| HTTP | code | meaning | body includes |
|---|---|---|---|
| 409 | `PHASE_CONFLICT` | command not legal in this phase | fresh `TrialResponse` |
| 409 | `VERSION_CONFLICT` | client state is stale | fresh `TrialResponse` |
| 409 | `WINDOW_CLOSED` | objection/read window already expired | fresh `TrialResponse` |
| 422 | `INVALID_COMMAND` | schema/limits failed (word cap, unknown doc) | zod issues |
| 423 | `TRIAL_BUSY` | an effect is in flight | `allowedActions` |
| 404 | `NOT_FOUND` | unknown trial/case | — |

Every rejection returns enough for the client to re-render correctly without a second request.

---

## 6. PlayerView (the only state a client sees)

```ts
interface PlayerView {
  case: { title: string; defendant: string; charge: string };
  phase: Phase;
  round: 1 | 2 | 3 | 4;
  currentWitness?: { witnessId: string; name: string; role: string; examination: "direct" | "cross"; askedBy: "defense" | "prosecution" };
  counters: { readsLeft: number; questionsLeft?: number; objectionsLeft: number };
  judge: { name: string; patience: number; warnings: number; strictness: number };
  jury: { jurorId: string; label: string; leaning: number; reaction: string }[];
  transcript: PublicTranscriptEntry[];   // hidden entries (prosecution opening) excluded; stricken entries flagged
  window?: { kind: "objection" | "read"; deadline: string; docId?: string };
  outcome?: { verdict: "not_guilty" | "guilty" | "hung_jury" | "mistrial"; votes?: Record<string, "guilty" | "not_guilty"> };
  reveal?: { prosecutionOpening: string; truthSummary: string };   // only when phase === DONE
}
```

- Built by `core/projections/playerView.ts` from `TrialState`. The existing `visibleToPlayer` logic moves here.
- **Tests:** snapshot the PlayerView at every phase of a scripted trial and assert it never contains fact ids, fact statements, truth text, unread document bodies, witness `knows` / `willLieAbout` / `secret`, or juror personas. Extend the existing views test.
- Document bodies are **not** in PlayerView. They're served by `GET /documents/:docId` only while that doc's read window is open, then refused. The 30-second read is enforced by the server, not the UI.
- Juror *personas* stay server-side (they're Jev prompt material). Labels ("Retired sea captain") are public.

### Public events

`PublicEvent` is a redacted mirror of domain events: `TranscriptAppended`, `JuryUpdated`, `PatienceChanged`, `WindowOpened`, `WindowClosed`, `PhaseChanged`, `CountersChanged`, `Busy`/`Idle`, `VerdictReached`. Clients can render from events alone (animations, emoji pops) and use `GET /trials/:id` to resync after a reconnect: `events?after=lastEventSeq`.

Internal-only event fields (Jev probabilities, prompts, model ids, latencies) are stripped by the projection. A debug flag on the server (not the client) can expose them for `PLAY_DEBUG`-style tooling.

---

## 7. Persistence

- **Event log per trial** (append-only) plus the **case id** and **seed** is the durable record. `TrialState` is rebuilt by folding events, and cached in memory while the trial is live.
- `TrialStore` port: `append(trialId, events, expectedVersion)`, `load(trialId)`, `list()`.
  - v1 adapters: `InMemoryTrialStore` (tests), `FileTrialStore` (`data/trials/<id>.jsonl`, fine for local play).
  - Later: SQLite/Postgres with a unique `(trial_id, seq)` constraint, which gives optimistic concurrency for free.
- Existing `play --log` JSONL output becomes the event log. Don't keep two formats.

---

## 8. Effects and latency (carrying over Reviews 05–07)

- Effects run in `app/` behind ports: `JevClient`, `LLMClient`, `Clock`, `Rng`.
- Speculative effects (Call A + voice during the objection window) are started by the service and **cancelled via `AbortController`** when a sustained objection lands.
- Effect results are recorded in events *before* being applied, so a crash mid-trial can resume from the log.
- Budgets (voice 6 s, stub fallback) stay in the LLM adapter. The service only sees "a line came back" (with `source: "model" | "stub"` recorded in the event).
- While `busy`, the client shows the "witness considers the question…" beat. The `Busy`/`Idle` events drive it.

---

## 9. What the clients become

- **Terminal (`scripts/play.ts`):** creates a trial via `TrialService` in-process, loops on `allowedActions`, prints `PublicEvent`s. No rule knowledge left in it. If a rule is needed to write the terminal client, it belongs in `core/`.
- **React HUD (`client/`):** a single `useTrial(trialId)` hook holds `TrialResponse`, subscribes to SSE, and exposes `send(command)`. Components read `view` and `allowedActions`: evidence boxes enabled iff `ReadDocument` is allowed; OBJECT button visible iff `Object` is allowed, with its countdown from `deadline`; question input iff `AskQuestion`; and so on. The mock state in `App.tsx` gets deleted.
- **Tests / sim:** `scripts/sim.ts` drives `TrialService` with `InMemoryTrialStore`, mock Jev, and stub LLM. The same code path as production.

---

## 10. Implementation plan (in order, each step green before the next)

1. **Types & schemas:** `shared/api.ts` with `Command`, `CommandEnvelope`, `AllowedAction`, `PlayerView`, `PublicEvent`, `TrialResponse`, error codes, and zod schemas for every inbound command.
2. **Core extraction:** move phase rules into `core/transitions.ts` and implement `decide` / `evolve` / `allowedActions` / `playerView`. Keep `TrialEngine` as a facade over them temporarily so existing tests keep passing.
3. **TrialService:** mailbox per trial, `expectedVersion`, `commandId` idempotency, busy lock, timers via `Clock`, effects via ports, events persisted via `TrialStore`, published via `EventBus`.
4. **Port terminal client** onto `TrialService`, and delete rule logic from `play.ts`. **Checkpoint:** a full trial plays identically (same seed → same transcript) before and after.
5. **HTTP + SSE adapter** in `server/api/` (plain Node `http` or a small framework, your pick; keep it thin), with error mapping per §5.
6. **React HUD:** `useTrial` hook, render from `view` + `allowedActions`. Evidence reader calls `/documents/:docId`.
7. **Replay:** `scripts/replay.ts <trial.jsonl>` rebuilds a trial from events with zero model calls and prints the transcript.

### Tests that must exist

- Transition table: every phase × every command type → allowed iff listed; `allowedActions ⊆ accepted`.
- Concurrency: two `AskQuestion`s with the same `expectedVersion` → one applied, one `VERSION_CONFLICT`. Same `commandId` twice → same result, one applied.
- Timers: `Object` at `deadline + 1ms` → `WINDOW_CLOSED`. `Object` vs `WindowExpired` race → exactly one wins.
- Busy: commands during `pending` → `TRIAL_BUSY`.
- Redaction: PlayerView and every PublicEvent in a full scripted trial contain none of the hidden fields (§6).
- Replay: fold(events) === live state for a full trial. Replay makes zero Jev/LLM calls.
- Document endpoint: body returned during the read window, refused after.

---

## 11. Non-goals for v1

Multiplayer (human prosecutor), spectators, career/docket/double-booking, persistence beyond local files, horizontal scaling infrastructure. The design leaves room for each: multiplayer = a second actor sending commands to the same mailbox, with `allowedActions` computed per participant. Career = a `Lawyer` resource that trials reference.

## 12. Authorization (later, noted so v1 doesn't paint us into a corner)

- Every command will carry an authenticated `actorId`, and `allowedActions(state, actor)` will be computed **per actor**. Keep `actor` as a parameter in `decide`/`allowedActions` from day one, even if v1 always passes `"defense"`.
- Trial ownership: `trial.participants = [{ actorId, role: "defense" }]`.
- Rate limits and model-cost budgets per actor.
