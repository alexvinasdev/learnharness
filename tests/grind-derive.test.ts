/**
 * Grind-derivation tests (W0) — the pure folds behind learned/rusty/%.
 *
 * Covers: the streak gate (K=3), lifetime vs recent fail %, rusty as a
 * flag (never a schedule), unsorted-tolerance, the null-when-new contract,
 * and the leaf rollup's bury semantics.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	exerciseStats,
	leafRollup,
	type ExerciseStats,
} from "../src/core/grind-derive.ts";
import type { Attempt, Exercise } from "../src/core/contracts/exercises.ts";

const NOW = new Date("2026-01-26T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
const A = (ok: boolean, daysAgo: number): Attempt => ({ exerciseId: "ex_1", at: at(daysAgo), ok });

describe("exerciseStats — null and basics", () => {
	it("never-attempted is null (renderers show new, not zeros)", () => {
		assert.equal(exerciseStats([], NOW), null);
	});

	it("one correct attempt is not learned (streak needs 3)", () => {
		const s = exerciseStats([A(true, 1)], NOW);
		assert.ok(s);
		assert.equal(s.learned, false);
		assert.equal(s.attempts, 1);
		assert.equal(s.failPct, 0);
		assert.equal(s.lastAt, at(1));
	});

	it("failPct is lifetime, rounded, over all attempts", () => {
		const s = exerciseStats([A(false, 9), A(true, 8), A(false, 7), A(true, 6)], NOW);
		assert.ok(s);
		assert.equal(s.attempts, 4);
		assert.equal(s.failPct, 50);
	});
});

describe("exerciseStats — the streak gate", () => {
	it("three consecutive correct = learned", () => {
		const s = exerciseStats([A(false, 5), A(true, 3), A(true, 2), A(true, 1)], NOW);
		assert.ok(s);
		assert.equal(s.learned, true);
	});

	it("an old failure does not block learned (the gate is the streak, not the lifetime)", () => {
		// 10 fails while learning it, then 3 straight correct.
		const attempts: Attempt[] = [];
		for (let i = 0; i < 10; i++) attempts.push(A(false, 30 - i));
		attempts.push(A(true, 3), A(true, 2), A(true, 1));
		const s = exerciseStats(attempts, NOW);
		assert.ok(s);
		assert.equal(s.learned, true);
		assert.equal(s.failPct, 77); // 10/13 rounded
		assert.equal(s.recentFailPct, 70); // last 10 attempts still hold 7 of the early fails
	});

	it("a recent failure breaks the streak", () => {
		const s = exerciseStats([A(true, 4), A(true, 3), A(true, 2), A(false, 1)], NOW);
		assert.ok(s);
		assert.equal(s.learned, false);
	});

	it("exactly K correct attempts is learned — no more are required", () => {
		const s = exerciseStats([A(true, 3), A(true, 2), A(true, 1)], NOW);
		assert.ok(s);
		assert.equal(s.learned, true);
	});
});

describe("exerciseStats — rusty is a flag, never a schedule", () => {
	it("learned and untouched beyond RUSTY_DAYS = rusty", () => {
		const s = exerciseStats([A(true, 25), A(true, 24), A(true, 23)], NOW);
		assert.ok(s);
		assert.equal(s.learned, true);
		assert.equal(s.rusty, true);
	});

	it("recent practice keeps it fresh", () => {
		const s = exerciseStats([A(true, 25), A(true, 24), A(true, 5)], NOW);
		assert.ok(s);
		assert.equal(s.rusty, false);
	});

	it("not-learned is never rusty", () => {
		const s = exerciseStats([A(false, 40), A(false, 39), A(false, 38)], NOW);
		assert.ok(s);
		assert.equal(s.learned, false);
		assert.equal(s.rusty, false);
	});
});

describe("exerciseStats — order tolerance", () => {
	it("fold sorts attempts by timestamp (the store appends, but never assume)", () => {
		const shuffled = [A(true, 1), A(true, 3), A(true, 2)];
		const s = exerciseStats(shuffled, NOW);
		assert.ok(s);
		assert.equal(s.learned, true);
		assert.equal(s.lastAt, at(1));
	});
});

describe("leafRollup — bury leaves the denominator", () => {
	const ex = (id: string, buried = false): Exercise =>
		({ id, topicId: "t_1", batchId: "batch_1", type: "flashcard", payload: { front: "a", back: "b" }, ...(buried ? { buried: true } : {}) }) as Exercise;

	const stats = (learnedIds: string[]): Map<string, ExerciseStats | null> => {
		const m = new Map<string, ExerciseStats | null>();
		for (const id of learnedIds) {
			m.set(id, {
				learned: true, rusty: false, attempts: 3, failPct: 0, recentFailPct: 0, lastAt: at(1),
			});
		}
		return m;
	};

	it("counts active exercises only — buried ones neither total nor learned", () => {
		const exercises = [ex("ex_1"), ex("ex_2"), ex("ex_3", true)];
		const r = leafRollup(exercises, stats(["ex_1"]));
		assert.deepEqual(r, { total: 2, learned: 1, learnedPct: 50 });
	});

	it("never-attempted count in total, not in learned", () => {
		const exercises = [ex("ex_1"), ex("ex_2")];
		const r = leafRollup(exercises, stats(["ex_1"]));
		assert.deepEqual(r, { total: 2, learned: 1, learnedPct: 50 });
	});

	it("empty leaf is 0/0 with pct 0 (renderer shows —, not 0%)", () => {
		const r = leafRollup([], new Map());
		assert.deepEqual(r, { total: 0, learned: 0, learnedPct: 0 });
	});
});
