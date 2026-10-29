/**
 * phases — the event-driven phase chain (docs/probe-teach-split.md §4).
 *
 * probe ends at the first CONCLUDED probe_done (output-available); teaching
 * begins at the FIRST nodeId-tagged quiz CALL (the inferred seam, owner
 * ruling 2026-09-26 — the verdict death: presenting the plan ends the
 * teacher's turn, the learner's reply is natural text, and nothing flips
 * the phase until a question ABOUT a plan node is actually posed). No
 * stored-tree seam: the phase is a pure fold over the transcript, so it can
 * never stick (the old currentNodeId-based phaseOfTree read a field nothing
 * ever set).
 */
import assert from "node:assert";
import test from "node:test";
import type { LhViewMessage } from "../src/core/view.ts";
import { phaseAt3, phaseTimeline, type Phase3 } from "../src/core/phases.ts";

/** Text-only user message. */
function user(text: string): LhViewMessage {
	return { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant message carrying a tool part in the given state. */
function assistantTool(
	name: string,
	state: "input-available" | "output-available" | "output-error",
	output?: unknown,
): LhViewMessage {
	return {
		id: `a_${name}_${state}_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: `tool-${name}`, state, ...(output !== undefined ? { output } : {}) } as never],
	};
}

/** A quiz call with its parsed input — `nodeId` present iff tagged. */
function assistantQuiz(input: Record<string, unknown> | undefined): LhViewMessage {
	return {
		id: `a_quiz_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		parts: [{ type: "tool-quiz", ...(input !== undefined ? { input } : {}) } as never],
	};
}

const DONE_ASSESSMENT = { assessment: { strands: [{ strand: "s", assessment: "a" }] } };

test("phaseAt3: probe until a concluded probe_done or the first TEACH-quiz call; teach after (fork 2026-01-26)", () => {
	const probeQuiz = phaseAt3([user("teach me calculus"), assistantTool("probe", "output-available")]);
	assert.equal(probeQuiz, "probe", "a PROBE quiz (tool-probe) never ends the probe");

	const concluded = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
	]);
	assert.equal(concluded, "teach", "a concluded probe_done ends the probe (teaching begins)");

	const teaching = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		assistantQuiz({ question: "q", correctAnswer: "a" }),
	]);
	assert.equal(teaching, "teach", "any teach-quiz CALL (tagged or not) is teaching");

	const quizAlone = phaseAt3([
		user("teach me"),
		assistantQuiz({ question: "q", correctAnswer: "a" }),
	]);
	assert.equal(quizAlone, "teach", "a teach-quiz call alone begins teaching (free sessions never probe)");
});

test("phaseAt3: the tag is the seam — natural text and untagged questions never start teaching", () => {
	const plainText = phaseAt3([
		user("teach me"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		user("Begin teaching, please."), // words alone
	]);
	assert.equal(plainText, "teach", "the probe_done seam fired — words change nothing either way");

	const wordsAlone = phaseAt3([user("teach me"), user("begin!")]);
	assert.equal(wordsAlone, "probe", "no seam event, no advance — words never flip a phase");

	const probeOnly = phaseAt3([
		user("teach me"),
		assistantTool("probe", "output-available"),
		assistantTool("recall", "output-available"),
	]);
	assert.equal(probeOnly, "probe", "the prober's own tools never start teaching");
});

test("phaseAt3: a mere probe_done CALL (input-available, not yet concluded) keeps the probe open", () => {
	const still = phaseAt3([user("teach me"), assistantTool("probe_done", "input-available")]);
	assert.equal(still, "probe");
});

test("phaseAt3: legacy transcripts without probe_done read as probe (no backwards compat — data wiped)", () => {
	const legacy = phaseAt3([user("teach me lacan"), assistantTool("plan_init", "output-available", { ok: true })]);
	assert.equal(legacy, "probe", "a plan_init call (legacy transcripts) flips nothing — the plan is gone");
});

test("phaseTimeline: folds messages into phase spans for the dividers", () => {
	const timeline = phaseTimeline([
		user("teach me"),
		assistantTool("probe", "output-available"),
		assistantTool("probe_done", "output-available", DONE_ASSESSMENT),
		user("what does this mean?"), // side question — teaching has begun
		user("go on"),
		assistantQuiz({ question: "q", correctAnswer: "a" }),
		assistantQuiz({ question: "q2", correctAnswer: "a" }),
	]);
	assert.deepEqual(timeline satisfies Phase3[], ["probe", "probe", "teach", "teach", "teach", "teach", "teach"]);
	assert.equal(timeline.length, 7);
});

test("phaseAt3: empty transcript is probe", () => {
	assert.equal(phaseAt3([]), "probe");
});

// ─── the native fold (phaseAt3Lh over LhMessage[]) ──────────────────────────

import type { LhMessage } from "../src/core/native-messages.ts";
import { phaseAt3Lh } from "../src/core/phases.ts";

/** A native toolResult (the probe_done conclusion). */
function toolResult(toolName: string, isError = false): LhMessage {
	return {
		id: `tr_${toolName}_${Math.random().toString(36).slice(2, 6)}`,
		role: "toolResult",
		toolCallId: `call_${toolName}`,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: Date.now(),
	} as LhMessage;
}

/** A native assistant message carrying a quiz toolCall — arguments carry
 *  `nodeId` iff tagged (exactly what the wire would persist). */
function assistantQuizCall(arguments_: Record<string, unknown>): LhMessage {
	return {
		id: `a_${Math.random().toString(36).slice(2, 6)}`,
		role: "assistant",
		content: [{ type: "toolCall", id: "call_quiz", name: "quiz", arguments: arguments_ }],
		stopReason: "toolUse",
		usage: undefined,
		timestamp: Date.now(),
	} as unknown as LhMessage;
}

test("phaseAt3Lh (native fold): probe→teach at the clean probe_done result OR the first quiz CALL", () => {
	const done = toolResult("probe_done");
	const quiz = assistantQuizCall({ question: "q", correctAnswer: "a" });

	assert.equal(phaseAt3Lh([done, quiz]), "teach", "the quiz CALL follows the seam");
	assert.equal(phaseAt3Lh([quiz]), "teach", "a quiz CALL alone begins teaching (free sessions)");
	assert.equal(
		phaseAt3Lh([toolResult("probe_done", true), quiz]),
		"teach",
		"an ERRORED probe_done concludes nothing — but the quiz still teaches",
	);
	// The two folds agree on the same settled transcript (the view projection
	// of the call carries its arguments as the part input).
	assert.equal(
		phaseAt3Lh([done, quiz]),
		phaseAt3([
			{ parts: [{ type: "tool-probe_done", state: "output-available" } as never] },
			{ parts: [{ type: "tool-quiz", input: { question: "q" } } as never] },
		]),
	);
});

// ─── the explain mechanic at the seam (owner 2026-09-27) ───────────────────
// Both quizzing tools (quiz OR explain, whichever the settings armed) open
// teaching — the seam is structural, not name-bound to the MC tool.

test("phaseAt3 + phaseAt3Lh: an explain CALL opens teaching too (tagged or not)", () => {
	const done = toolResult("probe_done");
	const explainCall = (args: Record<string, unknown>): LhMessage =>
		({
			id: "a_explain",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_explain", name: "explain", arguments: args }],
			timestamp: Date.now(),
		}) as unknown as LhMessage;

	const untagged = explainCall({ question: "q", correctAnswer: "a", explanation: "e" });

	assert.equal(phaseAt3Lh([done, untagged]), "teach", "any explain CALL is the seam (free sessions explain untagged)");
	assert.equal(
		phaseAt3Lh([done, untagged]),
		phaseAt3([
			{ parts: [{ type: "tool-probe_done", state: "output-available" } as never] },
			{ parts: [{ type: "tool-explain", input: { question: "q" } } as never] },
		]),
		"the two folds agree on the explain mechanic",
	);
});
