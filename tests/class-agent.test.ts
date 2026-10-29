/**
 * THE CLASS AGENT (ADR 0003): the registry shape (scope / cheatsheet /
 * exercises / pose_exercise ONLY — no scope-write, no question/plan/job
 * tools), the subtree-scoped route view, the pose contract (terminate +
 * the {scopeId, exercise} details payload the chat card renders), and
 * the prompt composition (own directory + the curated shared appendix).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Scope, ScopeTopic, Importance } from "../src/core/contracts/scope.ts";
import type { Exercise } from "../src/core/contracts/exercises.ts";
import type { ClassLeafPool, ClassToolContext } from "../src/agent/tools/class.ts";
import { classTools } from "../src/agent/tools/class.ts";
import { composeInstructions, createClassAgent } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";

// ── an in-memory context: closures over one scope, one pool, one sheet ──────

const NOW = "2026-10-29T00:00:00Z";

const leaf = (id: string, title: string, importance: Record<string, Importance> = {}): ScopeTopic => ({
	id,
	title,
	children: [],
	requires: [],
	importance,
	state: "untested",
});

const scope: Scope = {
	id: "scope_1",
	name: "German",
	objectives: [{ id: "obj_1", text: "live in Switzerland", createdAt: NOW }],
	roots: [
		{
			id: "t_root",
			title: "Casos",
			children: [leaf("t_nom", "Nominativ", { obj_1: "high" }), leaf("t_akk", "Akkusativ", { obj_1: "essential" })],
		},
		leaf("t_other", "Vocab"),
	],
	createdAt: NOW,
	updatedAt: NOW,
};

const flashcard: Exercise = {
	id: "ex_1",
	batchId: "batch_1",
	topicId: "t_nom",
	type: "flashcard",
	payload: { front: "der Mann", back: "el hombre" },
};
const buriedCard: Exercise = { ...flashcard, id: "ex_2", buried: true };

let spawned: Exercise | null = null;

function fakeCtx(overrides: Partial<ClassToolContext> = {}): ClassToolContext {
	return {
		chatId: "c1",
		scopeId: () => "scope_1",
		classRootId: () => "t_root",
		readScope: (id) => (id === scope.id ? scope : null),
		readCheatsheet: (_sid, topicId) => (topicId === "t_nom" ? "# Nominativ\nsubject case" : null),
		generateCheatsheet: async (_sid, topicId) => `# ${topicId} (generated)`,
		readLeafPool: (_sid, topicId): ClassLeafPool | null =>
			topicId === "t_nom"
				? {
						exercises: [
							{ exercise: flashcard, stats: { learned: false, rusty: false, attempts: 2, failPct: 50, recentFailPct: 50, lastAt: NOW } },
						],
						rollup: { total: 1, learned: 0, learnedPct: 0 },
					}
				: { exercises: [], rollup: { total: 0, learned: 0, learnedPct: 0 } },
		readExercise: (_sid, id) => [flashcard, buriedCard].find((e) => e.id === id) ?? null,
		spawnExercise: (_sid, raw) => {
			const draft = raw as { type?: string; topicId?: string; payload?: { front?: string; back?: string } };
			if (draft.type !== "flashcard" || !draft.payload?.front || !draft.payload?.back || draft.topicId !== "t_nom") {
				return { problem: "not a valid flashcard draft for a known leaf" };
			}
			spawned = { id: "ex_new", batchId: "batch_new", topicId: draft.topicId, type: "flashcard", payload: { front: draft.payload.front, back: draft.payload.back } };
			return { exercise: spawned };
		},
		...overrides,
	};
}

type Exec = { execute: (id: string, input: unknown) => Promise<{ isError?: boolean; terminate?: boolean; details?: unknown; content: Array<{ type: string; text?: string }> }> };
const registry = (ctx: ClassToolContext) => classTools(ctx) as unknown as Record<string, Exec>;
const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
	res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("the class registry", () => {
	it("is exactly the four class tools — no scope-write, no question, plan, or job tools", () => {
		assert.deepEqual(Object.keys(classTools(fakeCtx())).sort(), ["cheatsheet", "exercises", "pose_exercise", "scope"]);
	});

	it("scope renders the CLASS ROOT SUBTREE only (the route, not the whole map)", async () => {
		const res = await registry(fakeCtx()).scope!.execute("c1", {});
		const text = textOf(res);
		assert.match(text, /Nominativ/);
		assert.doesNotMatch(text, /Vocab/, "outside the class root, never shown");
	});

	it("scope says the route is gone when the root was pruned", async () => {
		const ctx = fakeCtx({ classRootId: () => "t_pruned" });
		const res = await registry(ctx).scope!.execute("c1", {});
		assert.match(textOf(res), /no longer in the scope/);
	});

	it("cheatsheet reads the sheet; missing without generate hints; generate creates", async () => {
		const tools = registry(fakeCtx());
		const sheet = await tools.cheatsheet!.execute("c1", { topicId: "t_nom" });
		assert.match(textOf(sheet), /subject case/);
		const missing = await tools.cheatsheet!.execute("c1", { topicId: "t_akk" });
		assert.match(textOf(missing), /generate:true/);
		const fresh = await tools.cheatsheet!.execute("c1", { topicId: "t_akk", generate: true });
		assert.match(textOf(fresh), /generated/);
	});

	it("exercises lists the pool with stats + rollup; empty pools say so", async () => {
		const tools = registry(fakeCtx());
		const pool = await tools.exercises!.execute("c1", { topicId: "t_nom" });
		const text = textOf(pool);
		assert.match(text, /pool: 1 exercises/);
		assert.match(text, /ex_1 \[flashcard\] attempts=2/);
		assert.match(text, /der Mann → el hombre/);
		const empty = await tools.exercises!.execute("c1", { topicId: "t_akk" });
		assert.match(textOf(empty), /Empty pool/);
	});
});

describe("pose_exercise — the pose contract", () => {
	it("serves a pool item by id: terminate + the {scopeId, exercise} details payload", async () => {
		const res = await registry(fakeCtx()).pose_exercise!.execute("c1", { exerciseId: "ex_1" });
		assert.equal(res.isError, undefined);
		assert.equal(res.terminate, true, "a pose ends the turn — the outcome arrives as a message");
		assert.deepEqual(res.details, { scopeId: "scope_1", exercise: flashcard });
	});

	it("refuses buried exercises and unknown ids", async () => {
		const tools = registry(fakeCtx());
		const buried = await tools.pose_exercise!.execute("c1", { exerciseId: "ex_2" });
		assert.equal(buried.isError, true);
		assert.match(textOf(buried), /buried/);
		const ghost = await tools.pose_exercise!.execute("c1", { exerciseId: "ex_ghost" });
		assert.equal(ghost.isError, true);
	});

	it("spawns a validated draft — it lands in the pool and poses the stamped exercise", async () => {
		spawned = null;
		const res = await registry(fakeCtx()).pose_exercise!.execute("c1", {
			draft: { type: "flashcard", topicId: "t_nom", payload: { front: "die Frau", back: "la mujer" } },
		});
		assert.equal(res.isError, undefined);
		assert.equal(res.terminate, true);
		assert.ok(spawned, "the spawn seam ran");
		assert.equal((res.details as { exercise: Exercise }).exercise.id, "ex_new");
	});

	it("a rejected draft surfaces the trust boundary's problem", async () => {
		spawned = null;
		const res = await registry(fakeCtx()).pose_exercise!.execute("c1", {
			draft: { type: "flashcard", topicId: "t_ghost", payload: { front: "x", back: "y" } },
		});
		assert.equal(res.isError, true);
		assert.match(textOf(res), /not a valid flashcard draft/);
	});

	it("demands exactly one of exerciseId / draft", async () => {
		const tools = registry(fakeCtx());
		const neither = await tools.pose_exercise!.execute("c1", {});
		assert.equal(neither.isError, true);
		assert.match(textOf(neither), /exactly one/);
		const both = await tools.pose_exercise!.execute("c1", { exerciseId: "ex_1", draft: { type: "flashcard", topicId: "t_nom", payload: { front: "a", back: "b" } } });
		assert.equal(both.isError, true);
	});
});

describe("the class prompt composition", () => {
	it("composes own directory + the curated shared appendix — no teaching base, no question mechanics", () => {
		const prompt = composeInstructions("class");
		assert.ok(prompt.includes("Probe first"), "the class doctrine composes");
		assert.ok(prompt.includes("pose_exercise"), "the tool map composes");
		// The teaching base must not compose (standalone law, like the scoper).
		const base = readFileSync("src/agent/system-prompt.md", "utf-8");
		const marker = base.split("\n").find((l) => l.trim().length > 20);
		if (marker) assert.ok(!prompt.includes(marker!.trim()), "the teaching base does not compose for the class agent");
		// The question-tools mechanics fragment stays out.
		const questionFragment = readFileSync("src/agent/prompts/shared/20-question-tools.md", "utf-8");
		const questionMarker = questionFragment.split("\n").find((l) => l.trim().length > 30)!.trim();
		assert.ok(!prompt.includes(questionMarker), "question mechanics leak");
	});

	it("registers in the segment universe (settings/override surfaces)", () => {
		const paths = allSegmentPaths();
		assert.ok(paths.some((p) => p.startsWith("class/")), "class fragments are addressable for overrides");
	});

	it("builds an agent off a bare options object (the stateless-per-turn seam)", () => {
		const agent = createClassAgent(fakeCtx(), {
			engine: {
				model: { id: "test-model", provider: "test", apis: {} } as never,
				streamFn: (async () => {
					throw new Error("not streamed in this test");
				}) as never,
			},
		});
		assert.ok(agent, "the agent constructs without touching the store layer");
	});
});
