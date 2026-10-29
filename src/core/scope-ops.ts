/**
 * Scope operations (fork 2026-01-26, CONTEXT.md "Scope Session") — the
 * PURE edit algebra the scoper agent's `scope_edit` tool applies. One
 * atomic batch per call: either every op applies or none does (problems
 * out, scope untouched). Ids are minted through the injected `mintId` so
 * this module stays pure (no crypto, no fs, no clock — testable both
 * sides of the wire).
 *
 * The tree is the UNION of what exploration surfaced across objectives;
 * importance lives per-topic-per-objective; `remove_topic` prunes without
 * cascade (attached exercises/cheatsheets orphan — the scope never owns
 * progress data, CONTEXT.md "Orphan").
 */

import type { Importance, Scope, ScopeTopic } from "./contracts/scope.ts";

export type ScopeOp =
	| { op: "add_objective"; text: string }
	| {
			op: "add_topic";
			/** null/absent = a new root (the tree is a forest). */
			parentId: string | null;
			title: string;
			summary?: string;
			/** Pre-filled per-objective tiers (AI proposal — the learner overrides in chat or UI). */
			importance?: Record<string, Importance>;
	  }
	| { op: "rename_topic"; topicId: string; title?: string; summary?: string }
	| { op: "move_topic"; topicId: string; parentId: string | null }
	| { op: "remove_topic"; topicId: string }
	| { op: "set_importance"; topicId: string; objectiveId: string; tier: Importance };

/** Clone the tree (deep) so the caller's input scope never mutates. */
function clone(topics: ScopeTopic[]): ScopeTopic[] {
	return topics.map((t) => ({ ...t, importance: t.importance ? { ...t.importance } : undefined, children: clone(t.children) }));
}

function removeTopic(topics: ScopeTopic[], topicId: string): boolean {
	for (let i = 0; i < topics.length; i++) {
		if (topics[i]!.id === topicId) {
			topics.splice(i, 1);
			return true;
		}
		if (removeTopic(topics[i]!.children, topicId)) return true;
	}
	return false;
}

/** The ids of a topic and every descendant (cycle guard for moves). */
function subtreeIds(topics: ScopeTopic[], topicId: string): Set<string> | null {
	for (const t of topics) {
		if (t.id === topicId) {
			const ids = new Set<string>([t.id]);
			const walk = (n: ScopeTopic) => n.children.forEach((c) => { ids.add(c.id); walk(c); });
			walk(t);
			return ids;
		}
		const nested = subtreeIds(t.children, topicId);
		if (nested) return nested;
	}
	return null;
}

/**
 * Apply one batch. Returns the NEXT scope plus the problems list — an
 * empty list means the batch applied; non-empty means the scope is
 * returned UNCHANGED (all-or-nothing, the atomicity the interview needs:
 * a half-applied proposal is a corrupted tree).
 */
export function applyScopeOps(scope: Scope, ops: ScopeOp[], deps: { mintTopicId: () => string; mintObjectiveId: () => string; now: () => string }): { scope: Scope; problems: string[] } {
	// Two passes: validate references against the EVOLVING tree (an op may
	// add the parent a later op needs), but never commit on failure — so
	// work on a scratch clone and only hand it back when every op passed.
	const problems: string[] = [];
	const next: Scope = {
		...scope,
		objectives: scope.objectives.map((o) => ({ ...o })),
		roots: clone(scope.roots),
	};
	const find = (id: string): ScopeTopic | null => {
		const stack = [...next.roots];
		while (stack.length) {
			const t = stack.pop()!;
			if (t.id === id) return t;
			stack.push(...t.children);
		}
		return null;
	};
	const objectiveIds = () => new Set(next.objectives.map((o) => o.id));

	for (const op of ops) {
		switch (op.op) {
			case "add_objective": {
				if (!op.text.trim()) { problems.push("add_objective: text must not be empty"); break; }
				next.objectives.push({ id: deps.mintObjectiveId(), text: op.text.trim(), createdAt: deps.now() });
				break;
			}
			case "add_topic": {
				if (!op.title.trim()) { problems.push("add_topic: title must not be empty"); break; }
				if (op.parentId !== null && !find(op.parentId)) { problems.push(`add_topic: unknown parentId "${op.parentId}"`); break; }
				const known = objectiveIds();
				for (const key of Object.keys(op.importance ?? {})) {
					if (!known.has(key)) { problems.push(`add_topic: importance key "${key}" matches no objective`); break; }
				}
				if (problems.length) break;
				const topic: ScopeTopic = {
					id: deps.mintTopicId(),
					title: op.title.trim(),
					...(op.summary?.trim() ? { summary: op.summary.trim() } : {}),
					children: [],
					...(op.importance && Object.keys(op.importance).length > 0 ? { importance: { ...op.importance } } : {}),
				};
				if (op.parentId === null) next.roots.push(topic);
				else find(op.parentId)!.children.push(topic);
				break;
			}
			case "rename_topic": {
				const t = find(op.topicId);
				if (!t) { problems.push(`rename_topic: unknown topicId "${op.topicId}"`); break; }
				if (op.title !== undefined) t.title = op.title.trim() || t.title;
				if (op.summary !== undefined) t.summary = op.summary.trim() || undefined;
				break;
			}
			case "move_topic": {
				if (op.parentId === op.topicId) { problems.push("move_topic: a topic cannot be its own parent"); break; }
				if (op.parentId !== null && !find(op.parentId)) { problems.push(`move_topic: unknown parentId "${op.parentId}"`); break; }
				const ids = subtreeIds(next.roots, op.topicId);
				if (!ids) { problems.push(`move_topic: unknown topicId "${op.topicId}"`); break; }
				if (op.parentId !== null && ids.has(op.parentId)) { problems.push("move_topic: cannot move a topic under its own descendant"); break; }
				// Detach (from roots or any parent), then reattach.
				const detached = detach(next.roots, op.topicId);
				if (!detached) { problems.push(`move_topic: unknown topicId "${op.topicId}"`); break; }
				if (op.parentId === null) next.roots.push(detached);
				else find(op.parentId)!.children.push(detached);
				break;
			}
			case "remove_topic": {
				if (!removeTopic(next.roots, op.topicId)) problems.push(`remove_topic: unknown topicId "${op.topicId}"`);
				break;
			}
			case "set_importance": {
				const t = find(op.topicId);
				if (!t) { problems.push(`set_importance: unknown topicId "${op.topicId}"`); break; }
				if (!objectiveIds().has(op.objectiveId)) { problems.push(`set_importance: unknown objective "${op.objectiveId}"`); break; }
				t.importance = { ...t.importance, [op.objectiveId]: op.tier };
				break;
			}
		}
		if (problems.length) break;
	}
	if (problems.length) return { scope, problems };
	next.updatedAt = deps.now();
	return { scope: next, problems: [] };
}

function detach(topics: ScopeTopic[], topicId: string): ScopeTopic | null {
	for (let i = 0; i < topics.length; i++) {
		if (topics[i]!.id === topicId) return topics.splice(i, 1)[0]!;
		const nested = detach(topics[i]!.children, topicId);
		if (nested) return nested;
	}
	return null;
}

/** Count leaves under a topic set (the cheatsheet-sized units). */
export function countLeaves(topics: ScopeTopic[]): number {
	return topics.reduce((n, t) => n + (t.children.length === 0 ? 1 : 0) + countLeaves(t.children), 0);
}
