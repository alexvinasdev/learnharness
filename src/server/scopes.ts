/**
 * Scope services — validation + derived views over the ScopeStore (W1).
 *
 * Routes (app/api/scopes/**) are thin HTTP; this layer is the trust
 * boundary: shape sanity on saveScope (duplicate ids, dangling refs),
 * pool discipline on exercises (pooled vs buried), and the
 * derived grind surfaces (stats per exercise, rollups per leaf —
 * core/grind-derive.ts folds; nothing derived is ever stored).
 */

import { stores } from "./stores.ts";
import { exerciseStats, leafRollup, type ExerciseStats, type LeafRollup } from "../core/grind-derive.ts";
import type { Attempt, Exercise, ExerciseBatch } from "../core/contracts/exercises.ts";
import { walkTopics, type Scope, type ScopeSummary } from "../core/contracts/scope.ts";
import { newBatchId, newObjectiveId } from "../store/scope.ts";

// ─── Scope CRUD (validation at the trust boundary) ───────────────────────────

export function listScopes(): ScopeSummary[] {
	return stores.scopeStore.listScopes();
}

export function getScope(id: string): Scope | null {
	return stores.scopeStore.getScope(id);
}

export function createScope(name: string): Scope {
	return stores.scopeStore.createScope(name);
}

/** Shape sanity on replace-whole saves — the corruption guards, nothing
 *  more: unique objective ids, unique topic ids, `requires` pointing at
 *  existing topics, importance keyed by existing objectives. Throws
 *  Error with a readable message (the route maps it to 400). */
/** The scoper's scope_create (fork 2026-01-26): create the scope AND its
 *  first objective in one persisted step — the interview's opening move. */
export function createScopeWithObjective(name: string, objectiveText: string): Scope {
	const created = createScope(name);
	const next: Scope = {
		...created,
		objectives: [{ id: newObjectiveId(), text: objectiveText.trim(), createdAt: new Date().toISOString() }],
	};
	saveScope(next);
	return next;
}

export function saveScope(scope: Scope): void {
	const objectiveIds = new Set<string>();
	for (const o of scope.objectives) {
		if (objectiveIds.has(o.id)) throw new Error(`duplicate objective id: ${o.id}`);
		objectiveIds.add(o.id);
	}
	const topics = walkTopics(scope.roots);
	const topicIds = new Set<string>();
	for (const t of topics) {
		if (topicIds.has(t.id)) throw new Error(`duplicate topic id: ${t.id}`);
		topicIds.add(t.id);
	}
	for (const t of topics) {
		for (const dep of t.requires ?? []) {
			if (!topicIds.has(dep)) throw new Error(`topic ${t.id} requires unknown topic ${dep}`);
		}
		for (const key of Object.keys(t.importance ?? {})) {
			if (!objectiveIds.has(key)) throw new Error(`topic ${t.id} weighted by unknown objective ${key}`);
		}
	}
	stores.scopeStore.saveScope(scope);
}

export function deleteScope(id: string): boolean {
	return stores.scopeStore.deleteScope(id);
}

// ─── Exercises: batch landing (auto-accept — the review gate is gone) ──────

/** Omit must DISTRIBUTE over the Exercise union — a plain Omit<Exercise,
 *  "id"|"batchId"> collapses the discriminated union into one bag and the
 *  stamped results stop assigning. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ExerciseDraft = DistributiveOmit<Exercise, "id" | "batchId">;

export function landBatch(
	scopeId: string,
	topicIds: string[],
	exercises: ExerciseDraft[],
): string {
	const scope = stores.scopeStore.getScope(scopeId);
	if (!scope) throw new Error("scope not found");
	const known = new Set(walkTopics(scope.roots).map((t) => t.id));
	for (const topicId of topicIds) {
		if (!known.has(topicId)) throw new Error(`unknown topic ${topicId}`);
	}
	for (const e of exercises) {
		if (!known.has(e.topicId)) throw new Error(`exercise for unknown topic ${e.topicId}`);
	}
	const batchId = newBatchId();
	// The spread cannot re-narrow the union through a non-generic map
	// (type/payload correlation is lost in the callback) — one cast at the
	// seam; the topic validation above is the real gate.
	const stamped = exercises.map((e) => ({ ...e, id: `ex_${crypto.randomUUID().slice(0, 12)}`, batchId })) as Exercise[];
	stores.scopeStore.appendBatch(
		scopeId,
		// Auto-accept (owner): the batch lands STRAIGHT in the pool —
		// bury, not a review queue, is the curation.
		{ id: batchId, topicIds, status: "accepted", createdAt: new Date().toISOString() },
		stamped,
	);
	return batchId;
}

export function setBuried(scopeId: string, exerciseId: string, buried: boolean): boolean {
	return stores.scopeStore.setBuried(scopeId, exerciseId, buried);
}

// ─── Grind: the attempt seam + derived views ─────────────────────────────────

export interface GrindView {
	exercises: Exercise[];
	batches: ExerciseBatch[];
	/** Derived stats for POOLED exercises only — nothing else can have
	 *  attempts. */
	statsById: Record<string, ExerciseStats | null>;
	/** Per LEAF rollups of the POOL (non-buried) — the scope panel's
	 *  coverage display. */
	rollups: Record<string, LeafRollup>;
	attempts: Attempt[];
}

/** The whole derived surface (the grind view + scope panel read this). */
export function grindView(scopeId: string): GrindView | null {
	const file = stores.scopeStore.getExercises(scopeId);
	if (!file) return null;
	const attempts = stores.scopeStore.readAttempts(scopeId);
	const pooled = file.batches.map((b) => b.id);
	const isPooled = (e: Exercise) => pooled.includes(e.batchId);
	const byExercise = new Map<string, Attempt[]>();
	for (const a of attempts) {
		const list = byExercise.get(a.exerciseId) ?? [];
		list.push(a);
		byExercise.set(a.exerciseId, list);
	}
	const statsById: Record<string, ExerciseStats | null> = {};
	for (const e of file.exercises.filter(isPooled)) {
		statsById[e.id] = exerciseStats(byExercise.get(e.id) ?? []);
	}
	const rollups: Record<string, LeafRollup> = {};
	const byTopic = new Map<string, Exercise[]>();
	for (const e of file.exercises.filter(isPooled)) {
		const list = byTopic.get(e.topicId) ?? [];
		list.push(e);
		byTopic.set(e.topicId, list);
	}
	for (const [topicId, list] of byTopic) {
		rollups[topicId] = leafRollup(
			list,
			new Map(list.map((e) => [e.id, statsById[e.id] ?? null])),
		);
	}
	return { exercises: file.exercises, batches: file.batches, statsById, rollups, attempts };
}

/** Record one attempt. Pool discipline: the exercise must exist, be in an
 *  ACCEPTED batch, and not be buried (the grind view only serves pool
 *  items — an out-of-band attempt on a buried one is a client bug, refuse
 *  it). Returns the exercise's fresh stats (the view updates in place). */
export function recordAttempt(scopeId: string, exerciseId: string, ok: boolean): ExerciseStats {
	const file = stores.scopeStore.getExercises(scopeId);
	if (!file) throw new Error("scope not found");
	const exercise = file.exercises.find((e) => e.id === exerciseId);
	if (!exercise) throw new Error("exercise not found");
	const batch = file.batches.find((b) => b.id === exercise.batchId);
	if (!batch) throw new Error("exercise not in the pool");
	if (exercise.buried) throw new Error("exercise is buried");
	stores.scopeStore.appendAttempt(scopeId, { exerciseId, at: new Date().toISOString(), ok });
	const view = grindView(scopeId);
	return view?.statsById[exerciseId] ?? { learned: false, rusty: false, attempts: 1, failPct: ok ? 0 : 100, recentFailPct: ok ? 0 : 100, lastAt: new Date().toISOString() };
}

// ─── Cheatsheets (W5 wires generation; the file seam ships now) ──────────────

export function readCheatsheet(scopeId: string, topicId: string): string | null {
	return stores.scopeStore.readCheatsheet(scopeId, topicId);
}

export function writeCheatsheet(scopeId: string, topicId: string, markdown: string): void {
	stores.scopeStore.writeCheatsheet(scopeId, topicId, markdown);
}
