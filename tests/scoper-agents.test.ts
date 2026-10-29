/**
 * THE SCOPER AGENT (Scope Sessions, fork 2026-01-26): the registry shape
 * (scope / scope_create / scope_edit ONLY — no question, plan, or job
 * tools), the create-once discipline, the atomic batch semantics of
 * scope_edit (all apply or none), and the prompt composition (own
 * directory + the curated shared appendix — the practice law, no teaching
 * base, no question-tool mechanics).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { applyScopeOps, type ScopeOp } from "../src/core/scope-ops.ts";
import type { Scope } from "../src/core/contracts/scope.ts";
import { scoperTools, renderScope, type ScoperToolContext } from "../src/agent/tools/scoper.ts";
import { composeInstructions, createScoperAgent } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths } from "../src/agent/prompt-segments.ts";

// ── an in-memory context: closures over a single scope + attach state ───────

function fakeCtx() {
	let scope: Scope | null = null;
	let attached: string | null = null;
	let n = 0;
	const now = () => "2026-01-26T00:00:00Z"; // fixed — ids get their own counter
	const ctx: ScoperToolContext & { get: () => Scope | null; attachedId: () => string | null } = {
		chatId: "c1",
		scopeId: () => attached,
		attachScope: (id) => {
			attached = id;
		},
		readScope: (id) => (scope && scope.id === id ? scope : null),
		createScope: (name, objectiveText) => {
			scope = {
				id: "scope_new1",
				name,
				objectives: [{ id: "obj_1", text: objectiveText, createdAt: now() }],
				roots: [],
				createdAt: now(),
				updatedAt: now(),
			};
			return scope;
		},
		writeScope: (s) => {
			scope = s;
		},
		mintTopicId: () => `t_${n++}`,
		mintObjectiveId: () => `obj_x${n++}`,
		now,
		get: () => scope,
		attachedId: () => attached,
	};
	return ctx;
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
	res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("the scoper registry", () => {
	it("is exactly the three scope tools — no question, plan, or job tools", () => {
		const tools = scoperTools(fakeCtx());
		assert.deepEqual(Object.keys(tools).sort(), ["scope", "scope_create", "scope_edit"]);
	});

	it("scope_create creates + attaches once; a second create is refused", async () => {
		const ctx = fakeCtx();
		const tools = scoperTools(ctx) as Record<string, { execute: (id: string, input: unknown) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> }>;
		const res = await tools.scope_create!.execute("c1", { name: "German", objective: "live in Switzerland" });
		assert.equal(res.isError, undefined, "first create succeeds");
		assert.match(textOf(res), /scope "German"/);
		assert.equal(ctx.attachedId(), "scope_new1");
		assert.equal(ctx.get()!.objectives[0]!.text, "live in Switzerland");

		const second = await tools.scope_create!.execute("c2", { name: "Again", objective: "x" });
		assert.equal(second.isError, true, "one scope per session");
		assert.match(textOf(second), /already has a scope/);
	});

	it("scope reads: no scope yet / the rendered tree", async () => {
		const ctx = fakeCtx();
		const tools = scoperTools(ctx) as Record<string, { execute: (id: string, input: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }>;
		const none = await tools.scope!.execute("c1", {});
		assert.match(textOf(none), /No scope yet/);

		await tools.scope_create!.execute("c1", { name: "German", objective: "live in Switzerland" });
		const ops: ScopeOp[] = [
			{ op: "add_topic", parentId: null, title: "Grammar", importance: { obj_1: "essential" } },
			{ op: "add_topic", parentId: "t_0", title: "Nominativ", importance: { obj_1: "high" } },
		];
		await tools.scope_edit!.execute("c1", { ops });
		const tree = await tools.scope!.execute("c1", {});
		const rendered = textOf(tree);
		assert.match(rendered, /Grammar/);
		assert.match(rendered, /Nominativ \[t_\d+\] \(leaf\)/);
		assert.match(rendered, /objective obj_1: live in Switzerland/);
	});
});

describe("scope_edit — atomic batches", () => {
	it("applies a level proposal and returns the after-tree", async () => {
		const ctx = fakeCtx();
		const tools = scoperTools(ctx) as Record<string, { execute: (id: string, input: unknown) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> }>;
		await tools.scope_create!.execute("c1", { name: "German", objective: "live in Switzerland" });
		const res = await tools.scope_edit!.execute("c1", {
			ops: [
				{ op: "add_topic", parentId: null, title: "Casos", importance: { obj_1: "essential" } },
				{ op: "add_topic", parentId: "t_0", title: "Nominativ" },
				{ op: "add_objective", text: "read Kant" },
			],
		});
		assert.equal(res.isError, undefined);
		const scope = ctx.get()!;
		assert.equal(scope.roots[0]!.title, "Casos");
		assert.equal(scope.roots[0]!.children[0]!.title, "Nominativ");
		assert.equal(scope.objectives.length, 2);
		assert.match(textOf(res), /read Kant/);
	});

	it("rejects a dangling parentId and applies NOTHING (all-or-nothing)", async () => {
		const ctx = fakeCtx();
		const tools = scoperTools(ctx) as Record<string, { execute: (id: string, input: unknown) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> }>;
		await tools.scope_create!.execute("c1", { name: "X", objective: "y" });
		const before = ctx.get()!;
		const res = await tools.scope_edit!.execute("c1", {
			ops: [
				{ op: "add_topic", parentId: "t_ghost", title: "Broken" },
				{ op: "add_objective", text: "should not land" },
			],
		});
		assert.equal(res.isError, true);
		assert.match(textOf(res), /unknown parentId "t_ghost"/);
		assert.deepEqual(ctx.get(), before, "the failed batch left the scope untouched");
	});

	it("guards the move cycle and unknown importance refs", () => {
		const base: Scope = {
			id: "scope_x",
			name: "X",
			objectives: [{ id: "obj_1", text: "o", createdAt: "2026-01-26T00:00:00Z" }],
			roots: [
				{ id: "t_a", title: "A", children: [{ id: "t_b", title: "B", children: [] }] },
			],
			createdAt: "2026-01-26T00:00:00Z",
			updatedAt: "2026-01-26T00:00:00Z",
		};
		const deps = { mintTopicId: () => "t_new", mintObjectiveId: () => "obj_new", now: () => "2026-01-26T00:00:09Z" };
		const cycle = applyScopeOps(base, [{ op: "move_topic", topicId: "t_a", parentId: "t_b" }], deps);
		assert.match(cycle.problems.join(" "), /own descendant/);

		const badObjective = applyScopeOps(base, [{ op: "set_importance", topicId: "t_a", objectiveId: "obj_ghost", tier: "high" }], deps);
		assert.match(badObjective.problems.join(" "), /unknown objective/);

		const ok = applyScopeOps(base, [{ op: "remove_topic", topicId: "t_b" }], deps);
		assert.deepEqual(ok.problems, []);
		assert.equal(ok.scope.roots[0]!.children.length, 0, "remove prunes without cascade");
	});
});

describe("the scoper prompt composition", () => {
	it("composes own directory + the curated shared appendix — no teaching base, no question mechanics", () => {
		const prompt = composeInstructions("scoper");
		const doctrine = readFileSync("src/agent/prompts/scoper/10-doctrine.md", "utf-8");
		assert.ok(prompt.includes("one cheatsheet"), "the leaf rule composes");
		assert.ok(prompt.includes("Importance is your proposal"), "the doctrine composes");
		assert.ok(!doctrine.includes("ask_user_question"), "the doctrine itself never references question tools");
		assert.ok(!prompt.includes("system-prompt.md's teaching base"), "sanity");
		// The teaching base's marker phrase (from src/agent/system-prompt.md) must be absent.
		const base = readFileSync("src/agent/system-prompt.md", "utf-8");
		const marker = base.split("\n").find((l) => l.trim().length > 20);
		if (marker) assert.ok(!prompt.includes(marker!.trim()), "the teaching base does not compose for the scoper");
		// The question-tools mechanics fragment (shared/20-question-tools.md)
		// stays out: a distinctive phrase from that file must not compose.
		const questionFragment = readFileSync("src/agent/prompts/shared/20-question-tools.md", "utf-8");
		const questionMarker = questionFragment.split("\n").find((l) => l.trim().length > 30)!.trim();
		assert.ok(!prompt.includes(questionMarker), `question mechanics leak: "${questionMarker.slice(0, 40)}…"`);
	});

	it("registers in the segment universe (settings/override surfaces)", () => {
		const paths = allSegmentPaths();
		assert.ok(paths.some((p) => p.startsWith("scoper/")), "scoper fragments are addressable for overrides");
	});

	it("builds an agent off a bare options object (the stateless-per-turn seam)", () => {
		const agent = createScoperAgent(fakeCtx(), {
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
