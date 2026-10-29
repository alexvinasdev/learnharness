/**
 * Grind derivations — pure folds over the append-only attempt log
 *
 * Store events, derive state (owner, 2026-01-26): learned, rusty, fail %,
 * and rollups are NEVER stored — they compute from Attempt[] on every
 * read, so tuning a threshold (contracts/exercises.ts constants) changes
 * results everywhere with zero migration. Same discipline as the graph's
 * derived view.
 */

import { LEARNED_STREAK, RECENT_WINDOW, RUSTY_DAYS, type Attempt, type Exercise } from "./contracts/exercises.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything derivable for one exercise. `null` when never attempted —
 *  callers render "new", not zeros. */
export interface ExerciseStats {
	/** Last LEARNED_STREAK attempts all correct (needs at least that many
	 *  attempts — a new exercise cannot be learned on one lucky hit). */
	learned: boolean;
	/** Learned && last attempt older than RUSTY_DAYS. A flag, never a
	 *  schedule: it boosts selection priority and clears on one correct
	 *  attempt (a failure un-learns — streak reset — which un-rusties too,
	 *  by demotion). */
	rusty: boolean;
	attempts: number;
	/** Lifetime fail % (0–100), rounded — informational, never a gate. */
	failPct: number;
	/** Fail % over the last RECENT_WINDOW attempts (the recent window —
	 *  the past at a glance). Same as failPct with fewer attempts. */
	recentFailPct: number;
	/** ISO of the last attempt — recency for selection ordering. */
	lastAt: string;
}

/** Fold one exercise's attempts into its stats. Pure; `now` injectable for
 *  tests. Attempts are ordered as given — the store returns append order
 *  (oldest first); the fold tolerates any order by sorting on `at`. */
export function exerciseStats(attempts: Attempt[], now: Date = new Date()): ExerciseStats | null {
	if (attempts.length === 0) return null;
	const ordered = [...attempts].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const last = ordered.at(-1);
	if (!last) return null; // unreachable (length checked) — satisfies indexed-access
	const fails = ordered.filter((a) => !a.ok).length;
	const recent = ordered.slice(-RECENT_WINDOW);
	const recentFails = recent.filter((a) => !a.ok).length;
	const streakSlice = ordered.slice(-LEARNED_STREAK);
	const learned =
		ordered.length >= LEARNED_STREAK && streakSlice.every((a) => a.ok);
	const daysSince = (now.getTime() - Date.parse(last.at)) / DAY_MS;
	return {
		learned,
		rusty: learned && daysSince > RUSTY_DAYS,
		attempts: ordered.length,
		failPct: Math.round((100 * fails) / ordered.length),
		recentFailPct: Math.round((100 * recentFails) / recent.length),
		lastAt: last.at,
	};
}

/** A leaf's rollup for the scope panel: of its ACTIVE (non-buried)
 *  exercises, how many are learned. Buried ones leave the denominator —
 *  the user excluded them from the pool, so they stop counting. */
export interface LeafRollup {
	total: number;
	learned: number;
	/** Learned share of total, 0–100 rounded; 0 when total is 0 (renderers
	 *  show "—", a leaf with no exercises is not 0% learned). */
	learnedPct: number;
}

/** Fold a leaf's exercises + their stats into the rollup. Pure; exercises
 *  with null stats count in `total` but never in `learned`. */
export function leafRollup(
	exercises: Exercise[],
	statsById: Map<string, ExerciseStats | null>,
): LeafRollup {
	const active = exercises.filter((e) => !e.buried);
	const learned = active.filter((e) => statsById.get(e.id)?.learned).length;
	return {
		total: active.length,
		learned,
		learnedPct: active.length === 0 ? 0 : Math.round((100 * learned) / active.length),
	};
}
