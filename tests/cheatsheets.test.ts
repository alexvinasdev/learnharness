/**
 * Cheatsheet generation (fork 2026-01-26, plan v2 W5): the one-shot
 * writer (hybrid source — model knowledge + linked propositions), the
 * prompt's context weave (lineage, objectives), and the auto-trigger
 * (only leaves NEWLY `taught` and sheetless fire; existing pages and
 * re-saves never re-generate).
 *
 * Drives the REAL service under an isolated LH_DATA_DIR with a scripted
 * engine (the compaction-summarizer test seam — no provider, no agent
 * loop beyond maxTurns 1).
 */

import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cheatsheets-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { generateCheatsheet, cheatsheetPrompt } = await import("../src/server/cheatsheets.ts");
const { saveScope, getScope, readCheatsheet, writeCheatsheet } = await import("../src/server/scopes.ts");
const { newObjectiveId, newTopicId } = await import("../src/store/scope.ts");
import type { Scope, ScopeTopic } from "../src/core/contracts/scope.ts";
import type { PiEngine } from "../src/agent/models.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

/** A scripted one-shot engine: records the prompt, returns fixed text.
 *  (createFauxCore — the pi-ai faux provider, the chat-flow seam.) */
function fauxEngine(markdown: string): PiEngine & { prompts: string[] } {
	const prompts: string[] = [];
	const faux = createFauxCore({});
	const step: FauxResponseStep = (context) => {
		prompts.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)).join("\n"));
		return fauxAssistantMessage([fauxText(markdown)], { stopReason: "stop" });
	};
	faux.setResponses([step]);
	return {
		model: faux.getModel(),
		streamFn: faux.streamSimple,
		prompts,
	};
}

const NOW = "2026-01-26T00:00:00Z";

function scopeFixture(): Scope {
	const obj = newObjectiveId();
	const root: ScopeTopic = { id: newTopicId(), title: "Casos", children: [] };
	const nom: ScopeTopic = { id: newTopicId(), title: "Nominativ", children: [], importance: { [obj]: "essential" }, state: "held" };
	const dat: ScopeTopic = { id: newTopicId(), title: "Dativ", children: [], importance: { [obj]: "high" } };
	root.children.push(nom, dat);
	return {
		id: "scope_cs1",
		name: "German",
		objectives: [{ id: obj, text: "live in Switzerland", createdAt: NOW }],
		roots: [root],
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe("cheatsheet generation", () => {
	it("writes the leaf's page from a one-shot call; the prompt weaves lineage and objectives", async () => {
		const scope = scopeFixture();
		saveScope(scope);
		const engine = fauxEngine("# Nominativ\n\n| case | asks |\n| --- | --- |\n| Wer? | subject |\n");
		const markdown = await generateCheatsheet(scope.id, scope.roots[0]!.children[0]!.id, { engine });
		assert.match(markdown, /^# Nominativ/);
		assert.equal(readCheatsheet(scope.id, scope.roots[0]!.children[0]!.id), markdown, "the file lands");
		assert.match(engine.prompts[0]!, /Inside: Casos/, "lineage weaves in");
		assert.match(engine.prompts[0]!, /live in Switzerland/, "objective weighting weaves in");
	});

	it("regeneration sees the previous page; unknown topic throws honestly", async () => {
		const scope = getScope(scopeFixture().id) ?? scopeFixture();
		saveScope(scope);
		const nom = scope.roots[0]!.children[0]!;
		writeCheatsheet(scope.id, nom.id, "# OLD PAGE");
		const engine = fauxEngine("# NEW PAGE");
		await generateCheatsheet(scope.id, nom.id, { engine });
		assert.match(engine.prompts[0]!, /# OLD PAGE/, "the regen prompt carries the previous version");
		assert.equal(readCheatsheet(scope.id, nom.id), "# NEW PAGE", "the file replaces");

		await assert.rejects(generateCheatsheet(scope.id, "t_ghost", { engine: fauxEngine("x") }), /Unknown topic/);
	});

	it("the prompt builder: linked propositions weave in when present", () => {
		const scope = scopeFixture();
		const prompt = cheatsheetPrompt(scope, scope.roots[0]!.children[1]!, ["- Dativ marks the indirect object."], null);
		assert.match(prompt, /Dativ marks the indirect object/);
		assert.match(prompt, /Topic: Dativ/);
		assert.ok(!prompt.includes("previous version"), "no existing page → no regen block");
	});
});

