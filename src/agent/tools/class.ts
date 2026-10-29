/**
 * The CLASS agent's tool registry (ADR 0003 — Classes): the session kind
 * that walks the Scope's leaves, teaching from each Cheatsheet and
 * exercising from the pool. Four tools, all server-side:
 *
 * - `scope`          — read the (sub)tree this Class walks: ids,
 *                      per-objective importance, states, requires-edges —
 *                      the route.
 * - `cheatsheet`     — read a leaf's cheatsheet (generate on demand when
 *                      missing — one model call, seconds). The teaching
 *                      material; never editable through this agent.
 * - `exercises`      — the leaf's pool + derived stats (learned / rusty /
 *                      fail %) — where to begin, what's done.
 * - `pose_exercise`  — pose ONE exercise interactively: a pool item by id,
 *                      or a validated spawn for a struggle the pool
 *                      misses (it lands in the pool). terminate ends the
 *                      turn; the graded outcome arrives as the
 *                      [EXERCISE RESULT] message (already grind-logged).
 *
 * The architecture law: no store imports — closures the composition root
 * (chat-handler) wires over the real seams, same seam as the scoper. The
 * class agent's ONLY write is spawnExercise (validateDraft → landBatch,
 * straight into the pool): never the scope, never a cheatsheet, never the
 * graph (ADR 0003).
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, poseExerciseResult } from "../tool-execute.ts";
import { healToolRecord } from "./heal.ts";
import { renderScope } from "./scoper.ts";
import { walkTopics } from "../../core/contracts/scope.ts";
import type { Scope } from "../../core/contracts/scope.ts";
import type { Exercise, ExerciseType } from "../../core/contracts/exercises.ts";
import type { ExerciseStats, LeafRollup } from "../../core/grind-derive.ts";

/** The exercises tool's payload: one leaf's pool (non-buried) with each
 *  exercise's derived stats, plus the leaf's rollup. */
export interface ClassLeafPool {
	exercises: Array<{ exercise: Exercise; stats: ExerciseStats | null }>;
	rollup: LeafRollup | null;
}

export interface ClassToolContext {
	chatId: string;
	/** Fresh per call — the session record's scopeId (always set for a Class). */
	scopeId: () => string | null;
	/** Fresh per call — the record's classRootId (null = whole scope). */
	classRootId: () => string | null;
	/** Scope read seam (null = unknown id). */
	readScope: (scopeId: string) => Scope | null;
	/** Cheatsheet read seam (null = none yet). */
	readCheatsheet: (scopeId: string, topicId: string) => string | null;
	/** Cheatsheet generation seam — one-shot model call, seconds. */
	generateCheatsheet: (scopeId: string, topicId: string) => Promise<string>;
	/** The leaf's pool + derived stats (null = no exercises file yet). */
	readLeafPool: (scopeId: string, topicId: string) => ClassLeafPool | null;
	/** One pooled exercise by id (null = unknown). */
	readExercise: (scopeId: string, exerciseId: string) => Exercise | null;
	/** The spawn seam: validate ONE draft, land it in the pool. Returns
	 *  the stamped exercise or the rejection problem — the trust boundary
	 *  (validateDraft) lives server-side, never in the model's hands. */
	spawnExercise: (scopeId: string, draft: unknown) => { exercise: Exercise } | { problem: string };
}

/** The subtree this Class walks: the whole tree, or roots=[classRoot]. */
function routeView(scope: Scope, rootId: string | null): Scope | { gone: string } {
	if (!rootId) return scope;
	const sub = walkTopics(scope.roots).find((t) => t.id === rootId);
	return sub ? { ...scope, roots: [sub] } : { gone: rootId };
}

/** One-line model-facing preview per exercise type — enough for the agent
 *  to pick meaningful probes without dumping payloads. */
function preview(e: Exercise): string {
	const cut = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
	switch (e.type) {
		case "flashcard":
			return `${e.payload.front} → ${e.payload.back}`;
		case "cloze":
			return cut(e.payload.template);
		case "ordering":
			return cut(e.payload.items.join(" | "));
		case "matching":
			return cut(e.payload.pairs.map((p) => `${p.left}=${p.right}`).join(" "));
		case "spot_error":
			return cut(e.payload.artifact);
		case "numeric":
			return cut(e.payload.prompt);
	}
}

const EXERCISE_TYPES: ExerciseType[] = ["flashcard", "cloze", "ordering", "matching", "spot_error", "numeric"];

const emptySchema = Type.Object({});
const cheatSchema = Type.Object({
	topicId: Type.String({ description: "The LEAF to read (verbatim id from the tree)" }),
	generate: Type.Optional(Type.Boolean({ description: "Generate the cheatsheet first when missing (one model call, seconds) — default false" })),
});
const poolSchema = Type.Object({
	topicId: Type.String({ description: "The LEAF whose pool to read (verbatim id from the tree)" }),
});
const draftSchema = Type.Object({
	type: Type.Union(EXERCISE_TYPES.map((t) => Type.Literal(t))),
	topicId: Type.String({ description: "The LEAF this exercise belongs to (verbatim id from the tree)" }),
	payload: Type.Unknown({ description: "The type's payload — one atomic exercise, answerable without ambiguity; validated before landing" }),
});
const poseSchema = Type.Object({
	exerciseId: Type.Optional(Type.String({ description: "A pooled exercise id (from the exercises tool) — pose it" })),
	draft: Type.Optional(draftSchema),
});

const classScopeTool = (ctx: ClassToolContext): AgentTool<typeof emptySchema> => ({
	name: "scope",
	label: "scope",
	description:
		"Read the route: the subtree this Class walks (objectives, ids, per-objective importance, states, requires-edges, leaves marked). " +
		"Call at session start and whenever unsure where the walk stands. Ordering guidance: requires-edges first, then importance; excluded topics are skipped.",
	parameters: emptySchema,
	execute: async () => {
		const sid = ctx.scopeId();
		if (!sid) return { content: [{ type: "text", text: "No scope attached to this Class." }], details: null };
		const scope = ctx.readScope(sid);
		if (!scope) return { content: [{ type: "text", text: `Scope ${sid} no longer exists.` }], details: null };
		const view = routeView(scope, ctx.classRootId());
		if ("gone" in view) {
			return { content: [{ type: "text", text: `This Class's root topic ${view.gone} is no longer in the scope (pruned in a scope session?). The Class cannot walk it — suggest the learner start a Class on a live topic.` }], details: null };
		}
		return { content: [{ type: "text", text: renderScope(view) }], details: null };
	},
});

const cheatsheetTool = (ctx: ClassToolContext): AgentTool<typeof cheatSchema> => ({
	name: "cheatsheet",
	label: "cheatsheet",
	description:
		"Read a leaf's cheatsheet — the committed material this Class teaches from. If missing, pass generate:true to create it first " +
		"(one model call, takes seconds; returns the fresh sheet). Read-only otherwise: gaps are named in chat, never edited here.",
	parameters: cheatSchema,
	execute: async (_id, input) => {
		const sid = ctx.scopeId();
		if (!sid) return invalidInputResult("cheatsheet", ["no scope attached to this Class"]);
		const scope = ctx.readScope(sid);
		if (!scope) return invalidInputResult("cheatsheet", [`scope ${sid} no longer exists`]);
		const topic = walkTopics(scope.roots).find((t) => t.id === input.topicId);
		if (!topic) return invalidInputResult("cheatsheet", [`unknown topic ${input.topicId} — read the tree with scope`]);
		const existing = ctx.readCheatsheet(sid, input.topicId);
		if (existing) return { content: [{ type: "text", text: `# ${topic.title}\n\n${existing}` }], details: null };
		if (!input.generate) {
			return { content: [{ type: "text", text: `No cheatsheet for "${topic.title}" yet. Call again with generate:true to create it (one model call, seconds) — then teach from it.` }], details: null };
		}
		const sheet = await ctx.generateCheatsheet(sid, input.topicId);
		return { content: [{ type: "text", text: `# ${topic.title} (freshly generated)\n\n${sheet}` }], details: null };
	},
});

const exercisesTool = (ctx: ClassToolContext): AgentTool<typeof poolSchema> => ({
	name: "exercises",
	label: "exercises",
	description:
		"Read a leaf's exercise pool with derived stats (attempts, learned, rusty, recent fail %) — the probe-and-skip data: " +
		"where explanation should begin, and whether the leaf is already done. Pose items with pose_exercise by id.",
	parameters: poolSchema,
	execute: async (_id, input) => {
		const sid = ctx.scopeId();
		if (!sid) return invalidInputResult("exercises", ["no scope attached to this Class"]);
		const pool = ctx.readLeafPool(sid, input.topicId);
		if (!pool) return invalidInputResult("exercises", [`unknown topic ${input.topicId} — read the tree with scope`]);
		const r = pool.rollup;
		const lines = [
			`pool: ${pool.exercises.length} exercises` + (r ? `, ${r.learned} learned (${r.learnedPct}%)` : ""),
		];
		for (const { exercise: e, stats } of pool.exercises) {
			const s = stats
				? `attempts=${stats.attempts}${stats.learned ? " learned" : ""}${stats.rusty ? " rusty" : ""} recentFailPct=${stats.recentFailPct}`
				: "untried";
			lines.push(`- ${e.id} [${e.type}] ${s} :: ${preview(e)}`);
		}
		if (pool.exercises.length === 0) {
			lines.push("Empty pool — spawn targeted exercises with pose_exercise (draft), or suggest generating a batch from the scope page.");
		}
		return { content: [{ type: "text", text: lines.join("\n") }], details: null };
	},
});

const poseTool = (ctx: ClassToolContext): AgentTool<typeof poseSchema> => ({
	name: "pose_exercise",
	label: "pose_exercise",
	description:
		"Pose ONE exercise as an interactive card — the turn ends here and the graded outcome arrives as the next message. " +
		"Pass exerciseId (a pooled item from exercises) to serve the pool, or draft (one atomic exercise targeting the struggle at hand) " +
		"to spawn it — it is validated and lands in the pool. Never both.",
	parameters: poseSchema,
	execute: async (_id, input) => {
		const sid = ctx.scopeId();
		if (!sid) return invalidInputResult("pose_exercise", ["no scope attached to this Class"]);
		if ((!input.exerciseId) === (!input.draft)) {
			return invalidInputResult("pose_exercise", ["pass exactly one of exerciseId (a pool item) or draft (a new exercise)"]);
		}
		let exercise: Exercise;
		if (input.exerciseId) {
			const found = ctx.readExercise(sid, input.exerciseId);
			if (!found) return invalidInputResult("pose_exercise", [`unknown exercise ${input.exerciseId} — read the leaf's pool with exercises`]);
			if (found.buried) return invalidInputResult("pose_exercise", [`exercise ${found.id} is buried — out of the pool; pick another`]);
			exercise = found;
		} else {
			const spawned = ctx.spawnExercise(sid, input.draft);
			if ("problem" in spawned) return invalidInputResult("pose_exercise", [spawned.problem]);
			exercise = spawned.exercise;
		}
		return { ...poseExerciseResult(exercise.id), details: { scopeId: sid, exercise } };
	},
});

/** The class agent's whole registry: the four class tools (closures over
 *  the per-request context), healed. */
export function classTools(ctx: ClassToolContext): Record<string, AgentTool<any>> {
	return healToolRecord({
		scope: classScopeTool(ctx),
		cheatsheet: cheatsheetTool(ctx),
		exercises: exercisesTool(ctx),
		pose_exercise: poseTool(ctx),
	});
}
