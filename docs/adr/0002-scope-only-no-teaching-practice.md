# 0002 — Teaching and practice sessions removed; the scoper interview is the only chat kind

Date: 2026-02-14 (fork simplification wave W8)
Status: Accepted (chat-kind removal partially superseded by ADR 0003 —
Class sessions)

## Context

This fork rebuilt the app around the Scope (ADR 0001 removed the plan tree
in favor of a persistent, objective-weighted topic tree). After the scope,
cheatsheets, and the deterministic grind landed, the remaining session
kinds were re-examined:

- **Teaching sessions** (probe → teacher walking the scope, free sessions)
  existed to *deliver* lessons conversationally.
- **Practice sessions** (generative problems, R0–R5 hint ladders, verdicts)
  existed to *exercise* knowledge adaptively.

The owner's product goal (stable since the first interview rounds) is
deterministic, pre-generated exercises with mastery tracking — no
chat-accretion around learning content. With cheatsheets as the content
artifact and the grind as the practice loop, both chat kinds became
middlemen.

## Decision

Remove both. The product becomes:

**Scope interview (the only session kind) → cheatsheets (the content) →
exercise batches (reviewed, then pooled) → grind (the practice).**

- The **scoper** is the only agent; teaching/practice/prober agents,
  prompts, and tool factories are deleted.
- Old teach/practice chats stay readable as history; a NEW turn on them
  refuses with a 400 ("session kind retired").
- **Topic State** (held/taught/partial) dies as a stored, agent-written
  concept: leaf coverage is DERIVED from the grind rollups (% of pooled
  exercises Learned). Nothing else writes states.
- The cheatsheet auto-trigger ("on taught") dies with states; cheatsheets
  and exercises generate on demand — per leaf, or in bulk through the
  generation queue (sequential worker, skip-existing, importance order).
- Dependency edges have no writer left; existing edges remain as data.
- The knowledge graph keeps its import path and renders history, but no
  agent writes propositions anymore.

## Consequences

- Learning content is a rereadable artifact (the cheatsheet) rather than a
  conversation. What the chat era produced — free production practice,
  adaptive hint ladders, reasoning-chain teaching — is gone for new work
  and lives on only in retired transcripts.
- Measurement inverts: instead of probing before teaching, the grind
  discovers what you hold (fail → study the cheatsheet → retry). Every
  exercise attempt is logged; coverage is derivable, never stored.
- The chat surface shrinks to one agent and one interview flow; the scope
  tree page becomes the app's working surface (generate, review, grind).
- Dangling-but-dormant: the jobs infra (research/demo/visual/pdf) remains
  wired to routes but no agent can spawn jobs; graph render/import remain
  for history and imports. Removal is possible later if they stay unused.
