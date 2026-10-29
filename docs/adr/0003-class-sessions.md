# 0003 — Class sessions: a chat that walks the Scope (partial reversal of 0002)

Date: 2026-10-29
Status: Accepted (partially supersedes ADR 0002 — its "no chat around
content" stance; its measurement inversion and artifact policy stand)

## Context

ADR 0002 removed teaching/practice chat on the argument that cheatsheets
plus the grind made it a middleman. A gap emerged: a cheatsheet is a
reference to reread, not a guided route through the material, and the
fork's strongest asset — the teaching methodology
(docs/teaching-methodology.md: one reasoning step at a time, the minimal
tree) — had no carrier. The owner wants chat classes that walk the
generated structure.

## Decision

Add a second chat session kind, the **Class**, and a second agent kind
(`class`, prompts in `src/agent/prompts/class/`). The Class is a conduit
over existing artifacts — it is not a new content source:

- **The Scope supplies the route.** A Class starts on any Scope node (or
  objective filter) from the scope page. The class agent orders the
  leaves below — dependency edges read as data, then Importance — and
  walks them one at a time. No plan artifact; no new edge writes.
- **The Cheatsheet supplies the material.** The agent teaches from the
  leaf's cheatsheet, generated on demand through the existing pipeline
  when missing. The Class never edits artifacts.
- **The pool supplies the measurement.** Entering a leaf probes with
  pool exercises first; attempts are logged like any grind attempt.
  Leaves whose pool is fully Learned are proposed-skip by default. For a
  struggle the pool doesn't cover, the agent may spawn an exercise in a
  universal type — deterministic grading, joins the pool once answered,
  discarded if dismissed. AI acts at generation time only, never at
  attempt time.
- **Pacing:** the agent proposes advancing when the just-attempted
  exercises come out correct; the learner decides. Resume = reopen the
  chat. No stored state beyond the conversation and the Grind Log.
- **Writes:** grind attempts and spawned exercises only. The scoper
  remains the sole Scope writer; the Class writes no propositions, no
  edges, no cheatsheet edits.

## Consequences

- Chat returns as a delivery surface, but content (cheatsheet) and
  measurement (grind) remain chat-independent: rereading and grinding
  stay valid with the chat gone. A Class that disappears takes nothing
  with it.
- The exercise pool grows adaptively from class spawns.
- Scope Session is no longer the only session kind; CONTEXT.md's guard
  becomes "avoid scope-less chat kinds".
- Rejected alternatives worth remembering: ephemeral AI-judged exercises
  (the retired Practice's hole — no deterministic measurement), teaching
  from free model knowledge (a rival content source), Class writes to
  Scope/edges/propositions (multi-writer drift), hard Learned gates on
  advancing (grind streaks are for the grind, not the classroom).
