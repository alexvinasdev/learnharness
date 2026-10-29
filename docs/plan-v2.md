# Build Plan v2 — Scope, cheatsheets, deterministic grind

Execution plan for the fork's new features (design resolved in the grilling session of 2026-01-26; language in `CONTEXT.md`, core decision in `docs/adr/0001-scope-replaces-plan-tree.md`). Follows the convention of `docs/plan.md` (v1): dependency-ordered waves, contracts first, standing gates `npx tsc --noEmit`, `npm test`, `npm run build` after every wave.

Standing rule (AGENTS.md): **when anything is ambiguous, ask — never guess.** Before touching anything under `app/`, read the relevant guide in `node_modules/next/dist/docs/` (this Next.js has breaking changes).

## Summary of what is being built

1. **Scope** — persistent per-domain artifact: topic hierarchy (leaves = cheatsheet-sized), objectives with per-topic importance (Essential/High/Medium/Low/Excluded), topic states (`untested/held/taught/partial`), dependency edges (teacher-discovered). Edited via guided **Scope Sessions** (new chat kind) and manual importance edits in the UI.
2. **Teach/probe integration** — teach sessions attach to a scope; probe measures and writes topic states; teacher walks the scope (current-leaf strip + counters replace the plan panel), updates states, adds dependency edges, links graph propositions to topics.
3. **Plan tree removal** — `plan_init`, plan panel, plan phase, contracts, tests (ADR 0001).
4. **Cheatsheets** — per-leaf schematized theory; AI knowledge + linked graph propositions; regenerated on demand and when a leaf reaches `taught`; markdown files; viewer, no editor.
5. **Exercises + grind** — 6 universal types (flashcard, cloze, ordering, matching (subsumes classification), spot-the-error, numeric); generated in background jobs with review-queue QA; append-only grind log; learned/rusty/%/buried all derived; non-chat grind view with greedy selection, zero LLM in the loop.

## Wave 0 — contracts + pure derivations (everything depends on this)

Files (new): `src/core/contracts/scope.ts`, `src/core/contracts/exercises.ts`; (edit) `src/core/contracts.ts` re-exports, `src/core/contracts/chat.ts` (`ChatKind` += `"scope"`; teach records gain optional `scopeId`), `src/core/contracts/graph.ts` (proposition gains optional `topicIds: string[]`).

- `scope.ts`: `Objective` (id, text, created), `Importance` = `essential|high|medium|low|excluded`, `TopicState` = `untested|held|taught|partial`, `ScopeTopic` (id, title, summary, children, importance per objective, state, dependency edge refs), `Scope` (id, name, objectives[], root topics, updatedAt).
- `exercises.ts`: `ExerciseType` union + payload shapes (flashcard front/back; cloze template + per-blank accepted/distractors; ordering items-in-order; matching pairs (1:1 or N→1 buckets); spot-the-error artifact + expected selections/corrections; numeric prompt + accepted value(s) + tolerance + unit), `Exercise` (stable id, type, payload, topicId, batchId, buried flag), `Batch` (id, topicId(s), status `pending|accepted`), `Attempt` (exerciseId, at, correct), `GrindStats` derived (learned K=3, rusty D=21 days, fail% lifetime + last-10) — constants configurable.
- Pure derivation module `src/core/grind-derive.ts` (learned/rusty/percentages/rollup per leaf) with unit tests `tests/grind-derive.test.ts`.

Gate: typecheck + new tests green. No store, no UI.

## Wave 1 — persistence + server + REST

Files (new): `src/store/scope.ts` (scopes + their exercises/batches/cheatsheet file mgmt), grind log as append-only JSONL; (edit) `src/core/ports.ts`, `src/server/stores.ts`, server routes + `app/api/scopes/**` (list/create/get/patch scope; cheatsheet get/regenerate; exercises list/generate-batch; batch review accept/discard-item; grind POST attempt + GET pool stats). Follow existing store/API patterns (`src/store/chats.ts`, `src/server/chats.ts`, seam test `tests/data-dir-seam.test.ts`).

Data layout: `data/scopes/<id>/scope.json`, `data/scopes/<id>/exercises.json`, `data/scopes/<id>/grind.jsonl`, `data/scopes/<id>/cheatsheets/<topicId>.md`.

Gate: API round-trip tests with store seams (`tests/scope-store.test.ts`, `tests/scope-api.test.ts`).

## Wave 2 — Scope Session (agent + UI entry + scope view)

Files (new): `src/agent/prompts/scoper/*.md` (guided interview: explore goal → propose decomposition → propose importance per objective → user overrides; leaf = one-cheatsheet rule), `src/agent/tools/scope-author.ts` (propose/apply tree edits, set importance, add objective); (edit) `src/agent/teacher-agent.ts` (`AgentKind` += scoper; engine = teacher tier), `src/store/chats.ts` createChat kind, `src/server/chat-handler.ts` scoper branch, `components/new-session.tsx` + sidebar entries, (new UI) `app/scope/page.tsx`, `components/scope/scope-tree.tsx` (tree, states, importance-per-objective, rollups, actions: generate cheatsheet / generate exercises / open grind), `app/grind/page.tsx` shell.

Gate: fake-model agent test (pattern: `tests/practice-agents.test.ts`), UI smoke via build.

## Wave 3 — teach/probe on the scope (before removal)

Files (edit): chat records attach `scopeId` (session start picks scope or free); `src/agent/tools/scope.ts` (new, teacher/prober-facing read/write: list subtree+states, set_topic_state, add_dependency_edge, link_proposition→topicIds); prober writes `held/gap` states; `src/agent/prompts/teacher/10-planning.md` → replaced by scope-walk doctrine (pick leaf by states+dependencies, teach, verify, mark); `src/core/contracts/chat.ts` HANDOFF_TEXT rework; `src/core/phases.ts` plan phase removed from semantics (probe→teach); compact strip UI (`components/scope/scope-strip.tsx`) in place of plan panel; graph extraction carries topic links.

Gate: `tests/phases.test.ts`, `tests/probe-done.test.ts`, `tests/chat-flow.test.ts` reworked and green.

## Wave 4 — plan machinery removal (ADR 0001)

Delete: `src/core/contracts/plan.ts`, `src/core/plan-tree.ts`, `src/core/plan-blocks.ts`, `src/agent/tools/plan.ts`, `src/agent/tools/mermaid-plan.ts`, `components/plan-block.tsx`, `components/plan-window.tsx`; strip plan references from `src/agent/tools.ts`, `src/core/{pending,view,question-core,compaction,native-messages,index}.ts`, `src/server/{compaction,turn-service}.ts`, `components/{chat,md-blocks,phase-divider,session-overlay,artifacts/index}.tsx`, `app/globals.css`, prompts (`teacher/50-demos.md`, `shared/40-formatting.md` plan mentions), `tests/{plan-tree,plan-blocks,plan-window,render-plan-block}.test.*`, plan parts inside golden fixtures (trim/regenerate: `tests/fixtures/golden-data/*`, `tests/fixtures/tool-rendering/*`). Keep the mermaid renderer itself (used by markdown). Docs: archive note on `docs/plan.md`, amend `docs/probe-teach-split.md`.

Gate: full suite + build green; old sessions (with persisted trees) still load clean.

## Wave 5 — cheatsheets

Files: new JobKind `"cheatsheet"` (`src/core/contracts/jobs.ts`, runner tables in `src/agent/subagents/runner.ts`, `src/agent/subagents/cheatsheet-writer.ts`): input = scope+topic (+objective context), source = model knowledge + linked propositions + existing cheatsheet on regen; writes `cheatsheets/<topicId>.md`. Auto-trigger: server hook when topic state → `taught` (Wave 3's set_topic_state). Viewer: markdown modal from scope tree. On-demand: button + API.

Gate: fake-model job test; auto-trigger unit test.

## Wave 6 — exercises + grind

Files: new JobKind `"exercises"` (`src/agent/subagents/exercise-generator.ts`): batch for leaf/subtree, N per call, source = cheatsheet + propositions + objective; output batch `pending`. Review queue UI in scope view (skim, discard item, accept batch). Grind view (`components/grind/*`): pool = accepted non-buried, topic-filtered (scope/subtree/objective incl. Excluded filter), greedy pick (not-learned > rusty > maintenance; tie: fail% desc, never-attempted last in group; failed item re-served later same session), render per type (word-bank/typed modes from same payload), binary outcome → append JSONL, instant derived stats, bury action. Zero LLM at attempt time.

Gate: `tests/exercise-selection.test.ts` (order math), `tests/grind-attempt.test.ts` (log append + derivations), typecheck/test/build.

## Wave 7 — close-out

README feature notes, CONTEXT.md final sync vs implementation, full gates, manual browser pass over: scope session → teach with scope → cheatsheet auto → exercise batch → review → grind → rusty/learned visible.

## Explicitly not in v2

Free production exercises (needs AI grading — non-deterministic; generative practice sessions already cover it), diagram labeling (images), classification as separate type (subsumed by matching), manual cheatsheet editor, calendar scheduling (rejected: rusty is a flag, never a schedule), exercise auto-generation.
