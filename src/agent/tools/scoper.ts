/**
 * The SCOPER's tool registry (Scope Sessions, fork 2026-01-26 —
 * CONTEXT.md): the interviewer agent that explores what the learner wants
 * to learn and materializes it into a persistent Scope. Three tools, all
 * server-side:
 *
 * - `scope`        — read the current scope as a compact tree (the
 *                    interviewer's eyes; also the after-state every edit
 *                    returns, so the model always sees what it wrought).
 * - `scope_create` — create the scope + its first objective, once, and
 *                    attach it to this session (record.scopeId).
 * - `scope_edit`   — one ATOMIC batch of tree operations (add/rename/
 *                    move/remove topics, set importance, add objective).
 *
 * The architecture law: no store imports here — the context is closures
 * the composition root (chat-handler) wires over the real stores, same
 * seam as the practice tools. The edit algebra itself is pure
 * (core/scope-ops.ts); this module owns the schema and the model-facing
 * rendering.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";
import { healToolRecord } from "./heal.ts";
import { applyScopeOps, countLeaves, type ScopeOp } from "../../core/scope-ops.ts";
import type { Importance, Scope, ScopeTopic } from "../../core/contracts/scope.ts";

export interface ScoperToolContext {
	chatId: string;
	/** Fresh per call — reads the session record's scopeId (null = no scope yet). */
	scopeId: () => string | null;
	/** Attach a freshly created scope to this session (record.scopeId). */
	attachScope: (scopeId: string) => void;
	/** Scope read seam (null = unknown id). */
	readScope: (scopeId: string) => Scope | null;
	/** Create scope + first objective, persisted; returns the saved record. */
	createScope: (name: string, objectiveText: string) => Scope;
	/** The VALIDATED writer (server/scopes.ts saveScope — throws on shape
	 * violations; the turn's tool result surfaces the message). */
	writeScope: (scope: Scope) => void;
	/** Ids + time for the pure op algebra. */
	mintTopicId: () => string;
	mintObjectiveId: () => string;
	now: () => string;
}

/** Compact tree rendering — the single model-facing view of the scope.
 *  One line per topic: indent, title, id, per-objective importance,
 *  state; leaves marked. Objectives head the block. */
export function renderScope(scope: Scope): string {
	const lines: string[] = [];
	lines.push(`scope "${scope.name}" (${scope.id}) — ${countLeaves(scope.roots)} leaves`);
	for (const o of scope.objectives) {
		lines.push(`objective ${o.id}: ${o.text}`);
	}
	const importanceOf = (t: ScopeTopic): string => {
		if (!t.importance || Object.keys(t.importance).length === 0) return "";
		const parts = Object.entries(t.importance).map(([obj, tier]) => {
			const label = scope.objectives.find((o) => o.id === obj)?.text.slice(0, 24) ?? obj;
			return `${label}: ${tier}`;
		});
		return `  [${parts.join(", ")}]`;
	};
	const walk = (topics: ScopeTopic[], depth: number) => {
		for (const t of topics) {
			const leaf = t.children.length === 0 ? " (leaf)" : "";
			const state = t.state && t.state !== "untested" ? ` {${t.state}}` : "";
			const req = t.requires?.length ? ` requires:${t.requires.join(",")}` : "";
			lines.push(`${"  ".repeat(depth + 1)}- ${t.title} [${t.id}]${leaf}${state}${req}${importanceOf(t)}`);
			walk(t.children, depth + 1);
		}
	};
	walk(scope.roots, 0);
	return lines.join("\n");
}

const IMPORTANCE_VALUES = ["essential", "high", "medium", "low", "excluded"] as const;

const importanceRecord = Type.Optional(
	Type.Record(Type.String(), Type.Union(IMPORTANCE_VALUES.map((v) => Type.Literal(v)))),
);

/** The op union as one schema — `op` discriminates. */
const scopeOpSchema = Type.Union([
	Type.Object({
		op: Type.Literal("add_objective"),
		text: Type.String({ description: "The objective in the learner's words, e.g. 'live in Switzerland'" }),
	}),
	Type.Object({
		op: Type.Literal("add_topic"),
		parentId: Type.Union([Type.String(), Type.Null()], { description: "Parent topic id; null = a new root" }),
		title: Type.String(),
		summary: Type.Optional(Type.String({ description: "One line: what this topic covers" })),
		importance: importanceRecord,
	}),
	Type.Object({
		op: Type.Literal("rename_topic"),
		topicId: Type.String(),
		title: Type.Optional(Type.String()),
		summary: Type.Optional(Type.String()),
	}),
	Type.Object({
		op: Type.Literal("move_topic"),
		topicId: Type.String(),
		parentId: Type.Union([Type.String(), Type.Null()]),
	}),
	Type.Object({
		op: Type.Literal("remove_topic"),
		topicId: Type.String(),
	}),
	Type.Object({
		op: Type.Literal("set_importance"),
		topicId: Type.String(),
		objectiveId: Type.String(),
		tier: Type.Union(IMPORTANCE_VALUES.map((v) => Type.Literal(v))),
	}),
]);

const scopeTool = (ctx: ScoperToolContext): AgentTool<typeof emptySchema> => ({
	name: "scope",
	label: "scope",
	description:
		"Read the current scope: objectives and the full topic tree with ids, per-objective importance, and states. " +
		"Call this at session start (or when unsure of the current shape) before proposing edits.",
	parameters: Type.Object({}),
	execute: async () => {
		const sid = ctx.scopeId();
		if (!sid) return { content: [{ type: "text", text: "No scope yet — this session has not created one. Call scope_create first." }], details: null };
		const scope = ctx.readScope(sid);
		if (!scope) return { content: [{ type: "text", text: `Scope ${sid} no longer exists (deleted outside this session).` }], details: null };
		return { content: [{ type: "text", text: renderScope(scope) }], details: null };
	},
});

const emptySchema = Type.Object({});

const createSchema = Type.Object({
	name: Type.String({ description: "Short domain name, e.g. 'German' or 'Linear algebra'" }),
	objective: Type.String({ description: "The learner's goal in their own words — becomes the first Objective" }),
});

const scopeCreateTool = (ctx: ScoperToolContext): AgentTool<typeof createSchema> => ({
	name: "scope_create",
	label: "scope_create",
	description:
		"Create this session's scope (name + first objective) and attach it to the session. ONCE per session — " +
		"a session edits the scope it created (or was opened against); call `scope` to read it after.",
	parameters: createSchema,
	execute: async (_id, input) => {
		if (ctx.scopeId()) {
			return invalidInputResult("scope_create", ["this session already has a scope — edit it with scope_edit"]);
		}
		if (!input.name.trim() || !input.objective.trim()) {
			return invalidInputResult("scope_create", ["name and objective must be non-empty"]);
		}
		const scope = ctx.createScope(input.name, input.objective);
		ctx.attachScope(scope.id);
		return { content: [{ type: "text", text: `Created and attached:\n${renderScope(scope)}` }], details: null };
	},
});

const editSchema = Type.Object({
	ops: Type.Array(scopeOpSchema, { minItems: 1, maxItems: 40, description: "Atomic batch — all apply or none does" }),
});

const scopeEditTool = (ctx: ScoperToolContext): AgentTool<typeof editSchema> => ({
	name: "scope_edit",
	label: "scope_edit",
	description:
		"Apply one ATOMIC batch of scope edits (all apply, or none): add_objective, add_topic, rename_topic, " +
		"move_topic, remove_topic, set_importance. Propose one interview step per call — e.g. the next tree level " +
		"as a batch of add_topic ops with pre-filled importance. Returns the tree after the batch.",
	parameters: editSchema,
	execute: async (_id, input) => {
		const sid = ctx.scopeId();
		if (!sid) return invalidInputResult("scope_edit", ["no scope yet — call scope_create first"]);
		const scope = ctx.readScope(sid);
		if (!scope) return invalidInputResult("scope_edit", [`scope ${sid} no longer exists`]);
		const { scope: next, problems } = applyScopeOps(
			scope,
			input.ops as ScopeOp[],
			{ mintTopicId: ctx.mintTopicId, mintObjectiveId: ctx.mintObjectiveId, now: ctx.now },
		);
		if (problems.length > 0) return invalidInputResult("scope_edit", problems);
		ctx.writeScope(next);
		return { content: [{ type: "text", text: renderScope(next) }], details: null };
	},
});

/** The scoper's whole registry: the three scope tools (closures over the
 *  per-request context — the teachQuizToolFor seam), healed. */
export function scoperTools(ctx: ScoperToolContext): Record<string, AgentTool<any>> {
	return healToolRecord({
		scope: scopeTool(ctx),
		scope_create: scopeCreateTool(ctx),
		scope_edit: scopeEditTool(ctx),
	});
}

export type { Importance };
