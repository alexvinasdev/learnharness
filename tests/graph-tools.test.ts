// THE PROBER'S GRAPH TOOLS (wave 7; understanding levels removed
// 2026-09-27) — pinned behaviors:
// 1. REGISTRATION: the factory registers list_sessions/list_propositions
//    on the prober ONLY when the composition root passes a graphStore
//    (the graphToolsEnabled gate lives server-side; absent store = closed
//    gate — the factory must not reach for settings itself).
// 2. OUTPUT: names only — the owner ruling bars statement text and session
//    contents from the prober's view of the map.
// 3. HONESTY: empty graph, unknown session id — the tools answer in
//    their own voice, never throw, never guess.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditorGraphTools } from "../src/agent/tools/graph.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });
const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }>,
): GraphNode => ({
	id,
	name,
	statement: `statement of ${name}`, // must NEVER leak into tool output
	aliases: [],
	createdAt: "2026-09-23T00:00:00.000Z",
	provenance,
});

function fakeStores(
	nodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const chains: GraphChain[] = [];
	const graphStore: GraphStore = {
		readNodes: () => nodes,
		readChains: () => chains,
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
		readClusterLabels: () => [],
		appendClusterLabel: () => {},
		appendNamingRun: () => {},
	} as unknown as GraphStore;
	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatSummary) ?? undefined,
	} as unknown as ChatStore;
	return { chatStore, graphStore };
}



// ─── registration (the factory gate) ────────────────────────────────────────

// The prober graph-tool describes died with the prober (2026-02);
// the auditor set below survives (jobs/subagent wiring).

describe("auditor graph tools", () => {
	const nodes = [
		{ ...node("n1", "Will to power", [pt("c1")]), statement: "The will to power is Nietzsche's central drive.", aliases: ["power drive"] },
		{ ...node("n2", "Eternal recurrence", [pt("c1")]), statement: "Eternal recurrence is the thought experiment of living again.", aliases: [] },
	];
	const { chatStore, graphStore } = fakeStores(nodes);

	it("find: glob over names + statements + aliases, returning id + name + statement + BIRTH SESSION (owner, 2026-09-29)", async () => {
		const tools = auditorGraphTools({ chatStore, graphStore });
		const out = (await tools.find!.execute!("tc", { query: "*will to power*" })).details as string;
		assert.match(out, /1 match\(es\):/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		// The born-in pointer: hits compose with list_propositions.
		assert.match(out, /born in: c1/);
		// Statements and aliases hit too — and a bare term gets implicit stars.
		const byStatement = (await tools.find!.execute!("tc", { query: "living again" })).details as string;
		assert.match(byStatement, /n2 :: Eternal recurrence/);
		const byAlias = (await tools.find!.execute!("tc", { query: "power drive" })).details as string;
		assert.match(byAlias, /n1/);
		const miss = (await tools.find!.execute!("tc", { query: "*nothing matches this*" })).details as string;
		assert.equal(miss, 'No existing proposition matches "*nothing matches this*".');
	});

	it("list_sessions: names, kinds, counts, ids — NO timestamps (identity work needs content, not chronology)", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes, {
			chats: [{ id: "c1", title: "Nietzsche seminar", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-21T10:00:00.000Z" }],
		});
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_sessions!.execute!("tc", {})).details as string;
		assert.match(out, /1 session\(s\):/);
		assert.match(out, /Nietzsche seminar \(chat, 2 propositions\) — id: c1/);
		assert.ok(!out.includes("2026-09-20"), "no dates in the auditor's view");
	});

	it("list_propositions: FULL statement text (identity work), no dates", async () => {
		const { chatStore: cs, graphStore: gs } = fakeStores(nodes);
		const tools = auditorGraphTools({ chatStore: cs, graphStore: gs });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) born in this session:/);
		assert.match(out, /- n1 :: Will to power/);
		assert.match(out, /statement: The will to power is Nietzsche's central drive\./);
		assert.ok(!out.includes("2026-09"), "no dates in the auditor's view");
		const miss = (await tools.list_propositions!.execute!("tc", { session: "no-such" })).details as string;
		assert.equal(miss, 'No propositions born in session "no-such". Call list_sessions for the current ids.');
	});
});
