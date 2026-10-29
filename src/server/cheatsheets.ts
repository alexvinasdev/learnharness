/**
 * Cheatsheet generation (fork 2026-01-26, plan v2 W5 — CONTEXT.md
 * "Cheatsheet"): one leaf = one schematized theory page, regenerated on
 * demand and auto-fired when a leaf reaches `taught`. NOT a chat job —
 * the artifact is a scope-attached FILE, so this is a one-shot model
 * call (the compaction summarizer's pattern: runSubagent, maxTurns 1),
 * never a JobKind with a steer delivery.
 *
 * Source material is hybrid by design (owner ruling Q10): the model's
 * domain knowledge as the base, plus the knowledge-graph propositions
 * linked to the topic (GraphNode.topicIds — the teacher's
 * link_proposition writes) woven in where they exist. Stateless and
 * regenerable: the file is a cache, never an edited artifact.
 */

import { runSubagent } from "../agent/subagents/pi-run.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { getGraph } from "../core/graph.ts";
import { emit } from "../core/events.ts";
import type { Scope, ScopeTopic } from "../core/contracts/scope.ts";
import { getScope, readCheatsheet, writeCheatsheet } from "./scopes.ts";
import { stores } from "./stores.ts";

/** The writer's contract: one page, schematized, self-contained. */
const CHEATSHEET_SYSTEM_PROMPT = `You write cheatsheets: one-page schematized theory references a learner reviews at a glance.
The law: SCHEMA over prose. Tables for contrasts, numbered steps for procedures, tight bullet lists for enumerations,
short worked examples in fenced blocks, formulas in LaTeX ($...$ inline, $$...$$ display). Every section earns its line —
no filler, no motivation, no teaching arc. This is the page someone reads two weeks after the lesson to re-derive what
they knew. Start with a single # heading naming the topic. End with a "## Common traps" section when the topic has them.
Output ONLY the markdown page — no preamble, no closing remarks.`;

/** The topic's ancestors, root-first ("Casos > Nominativ") — context for
 *  scope-aware wording without bloating the page. */
export function topicLineage(scope: Scope, topicId: string): string[] {
	const lineage: string[] = [];
	const walk = (topics: ScopeTopic[], trail: string[]): boolean => {
		for (const t of topics) {
			const next = [...trail, t.title];
			if (t.id === topicId) {
				lineage.push(...next);
				return true;
			}
			if (walk(t.children, next)) return true;
		}
		return false;
	};
	walk(scope.roots, []);
	return lineage;
}

/** Build the one-shot prompt: topic + lineage + objectives + linked
 *  propositions + the existing page (regen sees what it replaces). */
export function cheatsheetPrompt(scope: Scope, topic: ScopeTopic, linked: string[], existing: string | null): string {
	const parts: string[] = [];
	parts.push(`Write the cheatsheet for this topic:\n- Topic: ${topic.title}${topic.summary ? ` — ${topic.summary}` : ""}`);
	const lineage = topicLineage(scope, topic.id);
	if (lineage.length > 1) parts.push(`- Inside: ${lineage.slice(0, -1).join(" > ")}`);
	const relevant = scope.objectives.filter((o) => topic.importance?.[o.id] === "essential" || topic.importance?.[o.id] === "high");
	if (relevant.length > 0) parts.push(`- The learner's goal weighting: ${relevant.map((o) => o.text).join("; ")}`);
	if (linked.length > 0) {
		parts.push(`- Propositions the learner's lessons linked to this topic (weave the ones that belong in; keep their wording where it is already precise):\n${linked.map((p) => `  - ${p}`).join("\n")}`);
	}
	if (existing) parts.push(`- The previous version of this page (replace it; keep what earned its line):\n\n---\n${existing}\n---`);
	return parts.join("\n\n");
}

/** Propositions linked to the topic, as statement lines (the graph is
 *  process-global — no per-scope partition). */
function linkedPropositions(topicId: string): string[] {
	const graph = getGraph(stores.graphStore);
	return graph.nodes
		.filter((n) => n.topicIds?.includes(topicId))
		.map((n) => `- ${n.statement}`.replace("- - ", "- "))
}

export interface CheatsheetDeps {
	/** Tests inject a scripted engine; production resolves the researcher
	 *  tier (the one-shot text precedent — the compaction summarizer's
	 *  role label). */
	engine?: PiEngine;
}

/** Generate (or regenerate) one leaf's cheatsheet and persist it.
 *  Returns the markdown written. Throws honestly on a missing scope or
 *  topic (the route maps to 404), and on model absence (503 upstream). */
export async function generateCheatsheet(scopeId: string, topicId: string, deps: CheatsheetDeps = {}): Promise<string> {
	const scope = getScope(scopeId);
	if (!scope) throw new Error(`Unknown scope: ${scopeId}`);
	const topic = walkFind(scope, topicId);
	if (!topic) throw new Error(`Unknown topic: ${topicId}`);
	const engine =
		deps.engine ??
		(() => {
			const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
			if (!spec) throw new Error("No model configured for the researcher slot — set your model slots (settings → models)");
			return piEngineForSpec(spec);
		})();
	const prompt = cheatsheetPrompt(scope, topic, linkedPropositions(topicId), readCheatsheet(scopeId, topicId));
	const { text } = await runSubagent([], {
		role: "researcher",
		prompt,
		engine,
		systemPrompt: CHEATSHEET_SYSTEM_PROMPT,
		maxTurns: 1,
	});
	const markdown = text.trim();
	if (!markdown) throw new Error("The model returned an empty cheatsheet — nothing written");
	writeCheatsheet(scopeId, topicId, markdown);
	emit("scopes-changed", {});
	return markdown;
}

function walkFind(scope: Scope, topicId: string): ScopeTopic | null {
	const stack = [...scope.roots];
	while (stack.length) {
		const t = stack.pop()!;
		if (t.id === topicId) return t;
		stack.push(...t.children);
	}
	return null;
}

