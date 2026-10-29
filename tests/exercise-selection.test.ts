/**
 * Grind selection + exercise generation (fork 2026-01-26, plan v2 W6):
 * the greedy per-pick order (not-learned with fail% desc and never-attempted
 * last → rusty → learned maintenance by recency; exclusions cycle) and the
 * generator's trust boundary (parseDrafts: per-type shape validation, fence
 * tolerance, individual rejection).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickExercise } from "../src/core/exercise-pick.ts";
import type { ExerciseStats } from "../src/core/grind-derive.ts";
import { parseDrafts, validateDraft, generationPrompt } from "../src/server/exercise-gen.ts";
import type { Scope, ScopeTopic } from "../src/core/contracts/scope.ts";

const NOW = "2026-01-26T12:00:00Z";
const stats = (over: Partial<ExerciseStats>): ExerciseStats => ({
	learned: false,
	rusty: false,
	attempts: 1,
	failPct: 0,
	recentFailPct: 0,
	lastAt: "2026-01-01T00:00:00Z",
	...over,
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ex_${i}` }));

describe("pickExercise — the greedy order (Q15)", () => {
	it("not-learned first: highest fail% leads; never-attempted is LAST in the group", () => {
		const pool = ids(4);
		const statsById: Record<string, ExerciseStats | null> = {
			ex_0: stats({ attempts: 10, failPct: 80 }),
			ex_1: stats({ attempts: 5, failPct: 20 }),
			ex_2: null, // never attempted
			ex_3: stats({ learned: true, attempts: 6, failPct: 0 }),
		};
		const order: string[] = [];
		const excluded = new Set<string>();
		for (;;) {
			const pick = pickExercise(pool, statsById, excluded);
			if (!pick) break;
			order.push(pick.id);
			excluded.add(pick.id);
		}
		assert.deepEqual(order, ["ex_0", "ex_1", "ex_2", "ex_3"], "fail% desc → … → never-attempted → learned");
	});

	it("rusty outranks learned maintenance; maintenance goes least-recent first", () => {
		const pool = ids(3);
		const statsById: Record<string, ExerciseStats | null> = {
			ex_0: stats({ learned: true, attempts: 9, lastAt: "2026-01-20T00:00:00Z" }), // fresh learned
			ex_1: stats({ learned: true, rusty: true, attempts: 9, lastAt: "2025-11-01T00:00:00Z" }), // rusty
			ex_2: stats({ learned: true, attempts: 9, lastAt: "2026-01-10T00:00:00Z" }), // older than ex_0
		};
		assert.equal(pickExercise(pool, statsById, new Set())!.id, "ex_1", "rusty leads");
		assert.equal(pickExercise(pool, statsById, new Set(["ex_1"]))!.id, "ex_2", "least recent maintenance next");
		assert.equal(pickExercise(pool, statsById, new Set(["ex_1", "ex_2"]))!.id, "ex_0");
	});

	it("exclusions shrink the pool; everything excluded → null (the caller cycles)", () => {
		const pool = ids(2);
		const statsById: Record<string, ExerciseStats | null> = { ex_0: null, ex_1: null };
		assert.equal(pickExercise(pool, statsById, new Set(["ex_0"]))!.id, "ex_1");
		assert.equal(pickExercise(pool, statsById, new Set(["ex_0", "ex_1"])), null);
	});
});

describe("parseDrafts — the generator's trust boundary", () => {
	const topics = new Set(["t_ok"]);
	const flash = (over: Record<string, unknown> = {}) => ({ type: "flashcard", topicId: "t_ok", payload: { front: "Hund", back: "perro", ...over } });

	it("accepts well-formed drafts (fence-wrapped array tolerated)", () => {
		const text = "```json\n[" + JSON.stringify(flash()) + ", " + JSON.stringify(flash({ front: "Katze", back: "gato" })) + "]\n```";
		const { drafts, rejected } = parseDrafts(text, topics);
		assert.equal(drafts.length, 2);
		assert.deepEqual(rejected, []);
		assert.equal(drafts[0]!.type, "flashcard");
		assert.equal(drafts[0]!.type === "flashcard" ? drafts[0]!.payload.back : "", "perro");
	});

	it("rejects malformed drafts individually — the valid ones still land", () => {
		const bad = [
			{ type: "flashcard", topicId: "t_ghost", payload: { front: "x", back: "y" } }, // unknown topic
			{ type: "flashcard", topicId: "t_ok", payload: { front: "", back: "y" } }, // empty front
			{ type: "cloze", topicId: "t_ok", payload: { template: "one ___ two ___", blanks: [{ accepted: ["a"], distractors: ["b"] }] } }, // blank count ≠ tokens
			{ type: "numeric", topicId: "t_ok", payload: { prompt: "p", answers: [{ value: "nan" }] } }, // non-number
		];
		const { drafts, rejected } = parseDrafts(JSON.stringify([...bad, flash()]), topics);
		assert.equal(drafts.length, 1, "only the valid one lands");
		assert.equal(rejected.length, 4);
	});

	it("spot_error spans must exist in the artifact", () => {
		const res = validateDraft(
			{ type: "spot_error", topicId: "t_ok", payload: { artifact: "Der Hund schläft.", errors: [{ span: "Katze", acceptedFixes: ["Hund"] }] } },
			topics,
		);
		assert.ok("problem" in res && /not found in artifact/.test(res.problem));
	});

	it("no array in the output → nothing lands, honest reason", () => {
		const { drafts, rejected } = parseDrafts("sorry, I cannot", topics);
		assert.equal(drafts.length, 0);
		assert.match(rejected[0]!, /no JSON array/);
	});

	it("single-topic recovery: omitted topicId fills the batch's only topic; strict parse stays strict (regression: glm dropped the field)", () => {
		const bare = { type: "flashcard", payload: { front: "Hund", back: "perro" } };
		const strict = parseDrafts(JSON.stringify([bare]), topics);
		assert.equal(strict.drafts.length, 0, "without the default the omission is rejected");
		const filled = parseDrafts(JSON.stringify([bare]), topics, "t_ok");
		assert.equal(filled.drafts.length, 1);
		assert.equal(filled.drafts[0]!.topicId, "t_ok");
	});

	it("the prompt weaves objectives and cheatsheet source", () => {
		const topic: ScopeTopic = { id: "t_ok", title: "Dativ", children: [] };
		const scope: Scope = {
			id: "scope_g",
			name: "German",
			objectives: [{ id: "obj_1", text: "live in Switzerland", createdAt: NOW }],
			roots: [{ id: "t_root", title: "Casos", children: [topic] }],
			createdAt: NOW,
			updatedAt: NOW,
		};
		const prompt = generationPrompt(scope, [topic], 8, { t_ok: "# Dativ\n| case | role |\n| --- | --- |" });
		assert.match(prompt, /live in Switzerland/);
		assert.match(prompt, /## Topic: Dativ/);
		assert.match(prompt, /# Dativ/);
		assert.match(prompt, /exactly 8 exercises/);
	});
});
