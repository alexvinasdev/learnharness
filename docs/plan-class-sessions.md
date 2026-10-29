# Plan — Class sessions (ADR 0003)

Chat classes that walk the Scope: teach from the Cheatsheet, exercise from
the pool, attempts in the Grind Log. All decisions in
docs/adr/0003-class-sessions.md and CONTEXT.md; this is the mechanical
breakdown. Every wave touches the callers its change breaks.

## Existing seams being reused (no new machinery)

- Agent-per-kind: `AgentKind` + `baseAgentOptions` (teacher-agent.ts) composes
  `prompts/<kind>/`; add `"class"`, mirror `createScoperAgent`.
- Generation on demand: `generateCheatsheet(scopeId, topicId)` and
  `generateExercises(scopeId, {topicIds, count})` — one-shot model calls with
  `validateDraft` as trust boundary; batches land straight in the pool
  (auto-accept; the review queue is already retired).
- Attempt seam: `POST /api/scopes/[id]/grind` → `recordAttempt` → fresh
  derived stats. The chat client uses the SAME route as the grind view.
- Derived pool stats: `recordAttempt`'s return + grind derivations give the
  agent learned/rusty per leaf (skip-Learned, propose-advance).
- Session seeding: `/chat/new?mode=scope&scope=<id>` precedent in
  app/scope/page.tsx; class rides the same pattern with a topic anchor.

## W1 — Contracts (src/core/contracts/chat.ts)

- `ChatKind` += `"class"`.
- `ChatRecord.classRootId?: string` — the topic the Class walks (absent =
  whole scope). Validates against the scope on creation.
- Marker constants (marker law: model-facing text lives in contracts):
  `CLASS_OPEN_TEXT` (wake: scope id + root topic id + read-the-scope order)
  and `EXERCISE_RESULT(id, ok)` — the user-side marker the client appends
  after answering, so the agent sees the outcome without polling.

## W2 — The class agent (src/agent/teacher-agent.ts, prompts/class/)

- `AgentKind = "scoper" | "class"`; `createClassAgent(ctx, opts)` via
  `baseAgentOptions("class", …)`.
- `prompts/class/00-base.md` — identity: conductor of a Class; the Scope is
  the route, the Cheatsheet the material; never invents content beyond
  presentation.
- `prompts/class/10-doctrine.md` — the method, compressed from
  docs/teaching-methodology.md: one reasoning step at a time from what the
  learner holds; probe-first (exercises before explanation); skip fully
  Learned leaves (propose, learner decides); ordering = requires-edges as
  data, then Importance, excluded filtered; propose advancing when the leaf's
  just-attempted exercises are correct; the learner's word is final.

## W3 — Class tools (src/agent/tools/class.ts)

Closure context like ScoperToolContext; NO store imports:

- `scope` — read the (sub)tree; reuse `renderScope` (exported from
  tools/scoper.ts), subtree-scoped by classRootId.
- `cheatsheet` — read the leaf's sheet; `generate: true` calls
  `generateCheatsheet` when missing; returns the text to teach from.
- `exercises` — the leaf's pool + derived stats (learned/rusty/fail%) so the
  agent can probe and skip without guessing.
- `pose_exercise` — by `exerciseId` (serve a pool item) or by inline `draft`
  (spawn for a struggle the pool misses: `validateDraft` → `landBatch` →
  pool, then pose). The tool CALL is what the UI renders interactively.

No scope writes, no graph writes, no edge writes (Q8/Q9/Q11).

## W4 — Handler wiring (src/server/chat-handler.ts)

- Kind gate (l. 193): allow `"class"` alongside `"scope"`; old teach/practice
  refusal message unchanged for those.
- Agent construction (l. 413): select by record kind — scope → scoper
  context; class → class context (scopeId read-only seams; writeScope
  absent by construction).
- Extraction trigger (l. 515): exclude `"class"` (no graph writes — Q9).
- Compaction (l. 263/571): class rides the existing "teach" compaction seam
  (long sessions need it).

## W5 — Session creation (app/api/chats/route.ts, app/chat/new, app/scope)

- `POST /api/chats` accepts `kind: "class"` + `scopeId` + `classRootId`;
  validates scope exists and topic belongs to it.
- `app/chat/new/page.tsx`: `mode=class&scope=<id>&topic=<id>` → create with
  opener (`CLASS_OPEN_TEXT`) as the first turn.
- Scope page: "Tomar una Class aquí" per topic row + "Class" alongside
  "Open grind" on the scope header (whole scope); objective-filter variant
  passes the filter in the opener text (the agent filters importance).

## W6 — Chat UI (app/chat/[id]/page.tsx, components/grind)

- Extract the exercise renderer from `components/grind/grind-view.tsx` into
  a shared interactive card; render `pose_exercise` tool calls with it
  (grading stays client-deterministic, same as grind).
- On answer: POST the attempt to `/api/scopes/<scopeId>/grind`, then append
  `EXERCISE_RESULT` as the next user input — measurement and conversation
  stay two seams, one truth.
- Sidebar/chat list: label class sessions ("Class · scope name"); ensure
  Phase3 derivation no-ops for class (no plan tree reads default — verify).

## W7 — Tests + docs

- tests/class-agent.test.ts mirroring scoper-agents.test.ts: scripted
  engine — orders leaves (edges→importance), probe-first, skips learned,
  spawn path validates drafts (reject malformed), no scope-write tools.
- Chat-handler test: kind gate admits class, extraction excluded.
- README "How it works": insert the Class step between cheatsheets and
  grind. CONTEXT.md/ADR already written.

## Order

W1 → W2 → W3 are the vertical slice (a class session runs headless);
W4-5 make it reachable; W6 makes it usable; W7 locks it.
