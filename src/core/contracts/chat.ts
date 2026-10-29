/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../native-messages.ts";
import type { EmissionStats } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. Wave B (owner-approved
 * 2026-09-26): the stored messages are pi-NATIVE history (LhMessage — the
 * agent loop's own shapes, provider/model/usage/thinkingSignature stamped
 * by pi) — the canonical session record IS the agent state; replay is
 * `state.messages = record.messages` + continue(). The client-shaped view
 * is the client's own grouping fold (core/view.ts, Wave D) — a pending quiz
 * is an unanswered question tool call, which is exactly what makes
 * resume-mid-question free. */
/** The session's kind (practice sessions, owner 2026-10-04): "teach" is
 *  the default and ABSENT on pre-practice records (no migration — absence
 *  reads as teach); "practice" marks an adaptive-practice session — the
 *  practice agent, its two tools, no extraction, no graph writes;
 *  "scope" marks a Scope Session (fork 2026-01-26) — the guided interview
 *  that builds/edits the Scope artifact with the scoper agent. Teach
 *  sessions with an attached Scope (scopeId) walk it directly — there is
 *  no plan phase in this fork (ADR 0001). "class" marks a Class (ADR
 *  0003): the class agent walks the scope's leaves teaching from each
 *  Cheatsheet and posing pool/spawned exercises; its writes are limited
 *  to grind attempts and spawned exercises — never the scope, never the
 *  graph. Classes are persistent and resumable (the conversation is the
 *  pointer). */
export type ChatKind = "teach" | "practice" | "scope" | "class";

export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** The session's kind — absent = teach (pre-practice records). */
	kind?: ChatKind;
	/** The Scope this session works on (fork 2026-01-26): for kind "scope",
	 *  the artifact being interviewed into; for kind "teach", the scope the
	 *  session walks (no scopeId = a Free Session — chat without a map,
	 *  ADR 0001). Practice sessions never carry one. Classes always
	 *  carry one — without a scope there is nothing to walk. */
	scopeId?: string;
	/** The topic node this Class walks (ADR 0003; kind "class" only).
	 *  Absent = the whole scope (all roots). Validated at creation: the
	 *  topic must exist in the session's scope. Classes are read-only on
	 *  the scope — this anchor never changes after creation. */
	classRootId?: string;
	/** Append-only usage log (observability, 2026-09): one entry per model
	 * turn. DELIBERATELY a parallel log, not per-message metadata — the client
	 * re-POSTs its message list every turn and its copies never carry
	 * server-stamped fields, so anything inside message objects gets clobbered
	 * by the next persist. Keyed by messageId so the transcript view can fold
	 * each entry onto its message; aggregates are folds over this log
	 * (core/prices.ts). */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage log (2026-09 observability):
	 *  one entry per finished pipeline run on THIS chat — extraction is real
	 *  spend too. Same parallel-log discipline as `turns` (nothing rides
	 *  inside messages). Keyed by startedAt; idempotent appends. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP (schema-versioning wave, owner 2026-10-10): LAZY v1 —
	 *  existing records stay unstamped (absence reads as v1); every write
	 *  stamps the current version. A record stamped NEWER than this build
	 *  (the downgrade scenario) is REFUSED on read: a read-modify-write
	 *  store must never rewrite what it doesn't understand. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;

/** The conversation agents' runtime model choice (model-control wave,
 *  2026-09-12): a per-chat override of config.ts's pinned prober/teacher
 *  spec. Absent fields fall back to config; written by the model picker
 *  (PUT /api/chats/[id]/settings) and read at turn composition — the
 *  agents are stateless per turn, so a change takes effect on the next
 *  turn by construction. Background sub-agents are NEVER overridden
 *  (config-pinned: they're infrastructure, not conversation). */
export interface ChatSettings {
	/** pi-ai catalog coordinates: the provider that owns the model. Only
	 *  "openrouter" is configured today; the field exists so a second
	 *  provider needs no schema change. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
}


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (core/prices.ts). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — the SDK's LanguageModelUsage
 * flattened to the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Pi-normalized fresh input tokens; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes
	 * for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens written with one-hour retention. Missing
	 * on older logs; new native captures explicitly record zero if absent. */
	cacheWrite1hTokens?: number;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One billing turn: one full invocation of the teacher (a client turn or a
 * wake turn — same handler, same log). A turn with tool calls spans several
 * agent steps, and each step bills separately. Capture lands at the persist
 * seam (server); cost is INFERRED at read time from core/prices.ts. */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the
	 *  idempotency key for the append-only log. Continuation turns share a
	 *  response message id (the SDK coalesces them); keying on messageId
	 *  would swallow their usage. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  Fork 2026-01-26 (ADR 0001): the plan tree is gone — the seam survives
 *  only on SCOPED sessions, and the wake now walks the scope. First the
 *  probe's findings land as topic states (set_topic_state), then the
 *  teaching begins at the first leaf worth teaching. FREE sessions never
 *  fire this wake (no probe — the teacher opens from turn 1). */
export const HANDOFF_TEXT =
	"Next: write what the probe found onto the scope (set_topic_state — held for what I solidly hold, partial for " +
	"the shaky strands), then begin teaching. Read the scope (scope_read), pick the first leaf worth teaching by states " +
	"and dependencies — nothing I already hold is re-taught — and teach it: the motivated path, the checks, one topic at " +
	"a time. Mark each leaf (held/taught/partial) as you finish it.";

// ─── Practice sessions (owner, 2026-10-04) — marker + ack texts ──────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in core/contracts, never in the flattening seam.

/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). Hints and commits ride
 *  one channel — the label is the ONLY difference the model sees. */
/** The single submission label (owner round, 2026-10-05): one send
 *  lane — whether a submission claims an answer is read from the text,
 *  not declared by a button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. Owner round 16:
 *  the turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal (owner round 16, 2026-10-06):
 *  the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

// ─── Class sessions (ADR 0003) — the result marker ────────────────────────────
// Single-sourced here per the marker law (same as NEXT_PROBLEM_TEXT): the
// model-facing text the class seam appends as a user-side message. No
// opener marker exists — the class agent's doctrine orders the opening
// (read the route, probe first); the learner's first message is the
// natural wake.
/** The model-facing register of an answered in-class exercise: the
 *  client appends this as the next user input AFTER the deterministic
 *  grader ruled. The attempt itself is ALREADY recorded in the grind
 *  log (the client POSTs the same seam the grind view uses) — this
 *  marker is the conversation channel, never the measurement channel. */
export function exerciseResultText(exerciseId: string, ok: boolean): string {
	return (
		`[EXERCISE RESULT] ${exerciseId} — ${ok ? "correct" : "wrong"} (already logged in the grind log). ` +
		"Continue the Class per doctrine: on a miss, find what it reveals and teach exactly that; on success, keep going or propose advancing."
	);
}

/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `pendingQuestion` derives from
 *  the stored record (messages); the store computes it in listChats.
 *  Liveness (`busy`) is NOT record-derived — the API route merges it in
 *  (see ChatListItem). */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	/** The scope this session belongs to (scope-grouped sidebar, 2026-02):
	 *  interviews (kind "scope") and Classes carry one; the sidebar groups
	 *  chats by it. Rides the record spread — absent on scopeless history. */
	scopeId?: string;
	messageCount: number;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry ONLY — a running
 *  teach turn (owner, minimal-color round: background jobs no longer
 *  count; the sidebar's Background agents section is their channel, and
 *  the row spinner means exactly "a turn is in flight"). The store itself
 *  can't see liveness (import law: store never imports server), hence the
 *  split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** Live compaction liveness (turn-liveness's twin): true while a
	 *  background context compaction holds the chat's model gate. The
	 *  route attaches it from the compaction registry — never
	 *  record-derived (the marker persists, the RUN is ephemeral). */
	compacting: boolean;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold (owner round 17): the whole problem-call
		 * arguments joined onto the conclude part by projectView — the
		 * observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards (owner round, 2026-10-05):
		 *  the modelSolution committed at POSE time, folded onto the part by
		 *  projectView — the reveal is never re-authored. */
		reveal?: unknown;
	};
}
