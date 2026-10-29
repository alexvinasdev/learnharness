/**
 * Scope contracts — the persistent learning-domain map
 *
 * The fork's scope system (grilling 2026-01-26; docs/adr/0001-scope-replaces-
 * plan-tree.md): a first-class artifact SEPARATE from the knowledge graph
 * (which holds only true propositions — intentions never enter it) and from
 * the REMOVED session plan tree. The Scope is exhaustive coverage: a topic
 * hierarchy whose leaves are cheatsheet-sized, weighted per attached
 * Objective, carrying learning states and teacher-discovered dependency
 * edges. Teaching sessions walk it directly; probes and teachers write
 * states. Terminology in CONTEXT.md.
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream. Pure types + protocol docs — operations
 * live in the store (src/store/scope.ts), derivations in core.
 */

// ─── The scope artifact (data/scopes/<id>/scope.json) ────────────────────────

/** Why the domain is being learned — free text, ALL SIMULTANEOUS (owner,
 *  2026-01-26): never a single combined goal. Objectives both WEIGHT the
 *  tree (importance per objective) and SHAPE it (exploration surfaces
 *  topics a generic decomposition would miss — Swiss German needs). */
export interface Objective {
	/** "obj_" + nanoid-like (store-assigned). */
	id: string;
	text: string;
	createdAt: string;
}

/** Per-objective topic weight (owner, 2026-01-26): four named tiers plus
 *  Excluded. Excluded topics STAY in the tree (exhaustiveness) but are
 *  filtered out of teaching, probing, exercise generation, and grind by
 *  default — exclusion is a filter, never a deletion. */
export type Importance = "essential" | "high" | "medium" | "low" | "excluded";

/** A topic's learning evidence (owner, 2026-01-26) — written by probes and
 *  teachers, NEVER by grind (grind tracks exercises, not topics). `held`
 *  and `taught` both count as covered; they differ only in evidence
 *  origin. Finer percentages belong to exercise stats, not here. */
export type TopicState = "untested" | "held" | "taught" | "partial";

/** One node of the topic hierarchy. The tree is THEMATIC — grouping and
 *  weighting only; learning ORDER lives in `requires` edges, which are
 *  teacher-discovered during teaching (never authored in the scope
 *  interview: at definition time the learner cannot validate
 *  prerequisites). */
export interface ScopeTopic {
	/** "t_" + nanoid-like (store-assigned, stable for the artifact's life —
	 *  exercises, cheatsheets, graph links, and grind history anchor to it;
	 *  pruning a topic orphans them, never deletes them). */
	id: string;
	title: string;
	/** One or two sentences — what this topic covers. Optional. */
	summary?: string;
	children: ScopeTopic[];
	/** LEAF RULE (owner, 2026-01-26): a topic with no children must be
	 *  small enough that its material fits ONE cheatsheet — the stopping
	 *  criterion of decomposition. Cheatsheets and exercises attach to
	 *  leaves; interior topics group and carry importance. Not enforced by
	 *  the store (the scoper agent holds it); recorded here so every
	 *  consumer shares one rule. */
	/** Importance per objective id — PARTIAL on purpose: an objective that
	 *  never weighed this topic reads as absent (UI renders a default of
	 *  "medium"); a topic may be essential for one objective and excluded
	 *  for another. */
	importance?: Record<string, Importance>;
	/** Written by probes/teachers; absence reads as untested. */
	state?: TopicState;
	/** Dependency edges: node ids of topics whose holding PRECEDES this
	 *  one. Additive — the teacher appends as discovered while teaching;
	 *  never authored in the scope interview (ADR 0001). */
	requires?: string[];
}

export interface Scope {
	/** "scope_" + nanoid-like (store-assigned). */
	id: string;
	name: string;
	/** ALL simultaneous objectives (never combined — importance is stored,
	 *  viewed, and filtered per objective). */
	objectives: Objective[];
	/** A forest: domains may decompose into several independent root
	 *  topics (the union of what exploration surfaced across objectives). */
	roots: ScopeTopic[];
	createdAt: string;
	updatedAt: string;
	/** SCHEMA STAMP (fork 2026-01-26, lazy v1 — the chats' discipline):
	 *  absent on pre-stamp records; every write stamps the current version;
	 *  a record stamped NEWER than this build reads as absent (honest
	 *  refusal — never rewrite what you don't understand). */
	version?: number;
}

/** The scope-family format version this build writes and understands. */
export const CURRENT_SCOPE_VERSION = 1;

/** A scope's list entry (the picker's payload — light, no tree). */
export interface ScopeSummary {
	id: string;
	name: string;
	updatedAt: string;
	objectiveCount: number;
	topicCount: number;
	leafCount: number;
}

// ─── Pure helpers (tiny, like titleFromPrompt) ───────────────────────────────

/** Depth-first topic iteration (parents before children). Pure. */
export function walkTopics(roots: ScopeTopic[]): ScopeTopic[] {
	const out: ScopeTopic[] = [];
	const visit = (t: ScopeTopic) => {
		out.push(t);
		t.children.forEach(visit);
	};
	roots.forEach(visit);
	return out;
}

/** A topic is a LEAF iff it has no children (the leaf rule above attaches
 *  cheatsheets and exercises to exactly these). Pure. */
export function isLeaf(t: ScopeTopic): boolean {
	return t.children.length === 0;
}

/** Resolve an importance reading: explicit entry, else "medium" (the
 *  documented default for an unweighed topic). Pure. */
export function importanceOf(t: ScopeTopic, objectiveId: string): Importance {
	return t.importance?.[objectiveId] ?? "medium";
}

/** Topics EXCLUDED for a given objective are filtered from teaching,
 *  probing, generation, and grind pools by default. Pure. */
export function isExcluded(t: ScopeTopic, objectiveId: string): boolean {
	return importanceOf(t, objectiveId) === "excluded";
}

/** Resolve a topic's state; absence reads as untested. Pure. */
export function stateOf(t: ScopeTopic): TopicState {
	return t.state ?? "untested";
}
