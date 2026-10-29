/**
 * Grind selection (fork 2026-01-26, plan v2 W6 — CONTEXT.md "Grind"): the
 * GREEDY per-pick rule, pure. Zero LLM at attempt time — this function and
 * the derived stats are the whole brain.
 *
 * Priority groups (Q15, owner-confirmed):
 *   1. not-learned first — within: highest lifetime fail% first,
 *      never-attempted LAST
 *   2. rusty (learned && >21d unattempted) — a priority flag, never a
 *      schedule
 *   3. learned maintenance — least recently practiced first
 *
 * The caller excludes already-served-this-session ids (failed items
 * re-enter after the pool cycles — "re-offered later in the same session").
 * Excluded-buried and pending-batch items never enter the pool at all.
 */

import type { ExerciseStats } from "./grind-derive.ts";

export interface PickableExercise {
	id: string;
}

/** The greedy pick from `pool` minus `exclude`; null when everything is
 *  excluded (the caller cycles the exclusions). Pure + deterministic. */
export function pickExercise<T extends PickableExercise>(
	pool: readonly T[],
	statsById: Readonly<Record<string, ExerciseStats | null>>,
	exclude: ReadonlySet<string>,
): T | null {
	let best: T | null = null;
	let bestKey: Array<number | string> | null = null;
	for (const e of pool) {
		if (exclude.has(e.id)) continue;
		const s = statsById[e.id] ?? null;
		const key = rankKey(s);
		if (bestKey === null || compareKeys(key, bestKey) < 0) {
			best = e;
			bestKey = key;
		}
	}
	return best;
}

/** [group, groupOrder, tiebreak, …] — smaller lexicographically wins;
 *  the tiebreak carries lastAt (ISO — lexicographic order = chronological). */
function rankKey(s: ExerciseStats | null): Array<number | string> {
	if (s === null) {
		// Never attempted, not learned: the last of the not-learned group.
		return [0, 1, 0];
	}
	if (!s.learned) {
		// Not-learned: highest fail% first. Fail% in [0,100]; negate for
		// ascending-compare = descending priority. Tie: least recently
		// attempted first.
		return [0, 0, -s.failPct, s.lastAt];
	}
	if (s.rusty) return [1, 0, s.lastAt];
	// Learned maintenance: least recently practiced first.
	return [2, 0, s.lastAt];
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	return 0;
}
