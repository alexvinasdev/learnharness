/**
 * Scripted integration test — the full teacher loop with zero tokens:
 *
 *   learner opens chat → faux model calls `quiz` → server streams + persists
 *   → client grades and sends the ANSWER EVENT back
 *   → faux model reacts → transcript persisted.
 *
 * Drives handleChatRequest directly (plain Request/Response — no Next server
 * needed) with a scripted pi engine (pi-ai's faux provider, docs/
 * pi-engine-swap.md §7). Wave B: POSTs carry ONE INPUT EVENT (never a client
 * transcript), the record is pi-native agent history (read through the
 * projection where a part shape is pinned), and the answer arrives as the
 * question call's real tool result (fork 1, owner 2026-09-26).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createScoperAgent } from "../src/agent/teacher-agent.ts";
import type { Scope } from "../src/core/contracts/scope.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { effectiveSettings } from "../src/server/stores.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { deliverJobResult, registerLiveAgent, setTurnRunner, steerLiveChat, unregisterLiveAgent } from "../src/server/jobs.ts";
import { SessionModel } from "../components/session-core.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { abortTurn, runningTurn, settledTurnResponse } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, endsInDismissal, needsContinuation, newAnswerResult, newUserMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// Route-level pin (the chat-birth-stamp pattern): the dismiss route's
// handler, driven directly. Env is the runner's (the same the static
// store imports already resolved under).
const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
const steerRoute = await import("../app/api/chats/[id]/steer/route.ts");
const streamRoute = await import("../app/api/chats/[id]/stream/route.ts");
const recordRoute = await import("../app/api/chats/[id]/route.ts");
import { PATHS } from "../config.ts";

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus" },
		{ label: "Mercury" },
		{ label: "Mars" },
	],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

/** Turn 1: a bit of reasoning, then the quiz tool call. Turn 2: plain text.
 *  Each response factory records the prompt it received (the transcript the
 *  model saw) — the old doStream capture, engine-shaped. */
function scriptedTeacher(steps: (calls: string[][]) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: string[][];
} {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

/** The default two-turn lesson: probe quiz, then react to the answer. */
function defaultLesson(calls: string[][]): FauxResponseStep[] {
	return [
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — Mercury it is.")]);
		},
	];
}

/** A minimal scoper ctx for the injected factories (the scoper is the only
 *  agent — 2026-02; the scripted tests never touch its tools). */
function agentFixtureCtx() {
	return {
		chatId: "scratch-flow",
		scopeId: () => null,
		attachScope: () => {},
		readScope: () => null,
		createScope: () => ({ id: "scope_x", name: "x", objectives: [], roots: [], createdAt: "", updatedAt: "" }),
		writeScope: () => {},
		mintTopicId: () => "t_x",
		mintObjectiveId: () => "obj_x",
		now: () => "",
	};
}

/** The handler seam (stateless per turn): each request builds a fresh agent
 *  off the record it is about to run — the factory tests inject. Wave B: the
 *  handler hands the factory the NATIVE build options (the record IS the
 *  agent state — no adapter conversion). */
function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createScoperAgent(agentFixtureCtx(), { engine, messages: opts.messages });
}

/** The graded answer a client sends for a quiz (the shared grading seam). */
function gradedAnswer(input: typeof QUIZ_INPUT, values: string[]) {
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

/** Parse an SSE body into its wire events (verbatim pi AgentEvents +
 *  the app-level error/turn-settled terminals). Structural beats substring:
 *  key order never matters. */
function eventsOf(body: string): Array<Record<string, any>> {
	const out: Array<Record<string, any>> = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		out.push(JSON.parse(line.slice(6)));
	}
	return out;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text(); // consumes the SSE stream to completion (fires onFinish)
}

/** CONNECTION DIET B (owner, 2026-10-10 — parallel-session freeze postmortem):
 *  POST /api/chat no longer streams the turn — it acks and closes, and the
 *  submitter (like every view) attaches via the reattach stream. This
 *  mirrors drain(): assert the 200 ack, then drain the turn's SSE body to
 *  completion through runningTurn + subscribe — the same wire the GET
 *  route serves. Subscribe IMMEDIATELY after the ack: faux turns settle in
 *  microtask rounds, and the handle leaves the registry at settle. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle)
		// A short turn (a quick answer reaction) can settle INSIDE the
		// handler's trailing awaits — the registry is already clear. There is
		// nothing to drain: completion happened. (Body-reading callers get "" —
		// their eventsOf asserts then fail loudly if this ever bites a long
		// turn, which is the honest outcome for a lost wire.)
		return "";
	return new Response(handle.subscribe()).text();
}

/** Drain a RUNNING turn's wire when the POST already happened (the ack
 *  path left nothing to consume — CONNECTION DIET B). Subscribe immediately:
 *  faux turns settle in microtask rounds. */
async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) assert.fail(`no running turn to drain: ${chatId}`);
	return new Response(handle.subscribe()).text();
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

/** A teacher whose step 1 blocks on an external gate — a turn held mid-run
 *  so view-cancel / reattach / abort timing is deterministic. */
function gatedTeacher(gate: Promise<void>): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("Gated reply.")]);
		},
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A teacher that NEVER resolves except on abort (the jobs abortableFactory
 *  pattern): the only way this turn can end is the remote kill. */
function abortableTeacher(): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		((_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const sig = opts?.signal;
				if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			})) as unknown as FauxResponseStep,
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// Wave B: the input-events contract — one explicit event per POST,
		// never a client transcript.
		body: JSON.stringify({ chatId, input }),
	});
}

/** The silent-dismissal route POST (module scope — the parallel-rounds
 *  pins drive it too). */
function dismissPost(chatId: string, toolCallId: string, kind: "quiz" | "ask" | "explain" = "quiz"): Promise<Response> {
	return dismissRoute.POST(
		new Request(`http://test/api/chats/${chatId}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: { type: "dismiss", toolCallId, answer: dismissedAnswer(kind, kind === "ask" ? "Next topic?" : QUIZ_INPUT.question) },
			}),
		}),
		{ params: Promise.resolve({ id: chatId }) },
	);
}


// ── the fork's scope seam (2026-01-26): scripted lessons quiz against a
// scope whose leaves carry the old plan slugs as topic ids — the nodeId
// law validates against the scope tree now (ADR 0001).
const FLOW_SCOPE_ID = "scope_flow";
const flowScope = (): Scope => ({
	id: FLOW_SCOPE_ID,
	name: "Scripted",
	objectives: [{ id: "obj_flow", text: "test", createdAt: "2026-01-26T00:00:00Z" }],
	roots: [{
		id: "t_root", title: "Root", children: [
			{ id: "planet-order", title: "Planet order", children: [] },
			{ id: "genealogy", title: "Genealogy of religion", children: [] },
			{ id: "indexicals", title: "Indexical 'actual'", children: [] },
			{ id: "modal-realism", title: "Modal realism", children: [] },
		],
	}],
	createdAt: "2026-01-26T00:00:00Z",
	updatedAt: "2026-01-26T00:00:00Z",
});

/** BYOK turn gate (owner, 2026-09-22): no factory floor — a chat needs a
 *  conversation model before any turn streams. The scripted tests give
 *  each chat a per-chat pin exactly like the setup flow does in
 *  production (the injected faux engine still runs the loop). */
function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title, "scope");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

// The teacher chat-flow describe (probe/teach seam, scope-walk checks)
// died with teaching sessions (2026-02).

describe("chat store", () => {
	it("round-trips and lists chats", async () => {
		const chat = chatStore.createChat("Store test");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hi", timestamp: 1 } as never]);
		const loaded = chatStore.getChat(chat.id)!;
		assert.equal(loaded.messages.length, 1);
		assert.equal(loaded.title, "Store test");
	});

	it("persist the per-chat model settings (replace-whole, no updatedAt churn)", async () => {
		const chat = chatStore.createChat("Settings test");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.settings, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.equal(saved.updatedAt, before, "a picker write is not conversation activity");
		// replace-whole: a settings-less write clears the override (an empty
		// object persists — every field absent = config defaults)
		chatStore.saveSettings(chat.id, {});
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, {});
	});
});


describe("mid-turn navigation (turn liveness + write-ahead)", () => {
	it("one turn per chat: a concurrent request is 409'd; the next one after finish is accepted", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: turn guard");
		createdChats.push(chat.id);

		const res1 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine)); // acked; the turn runs as a background object (Diet B: no stream to hold)
		assert.equal(isTurnRunning(chat.id), true, "turn registered as in flight");
		const view1 = drainRunning(chat.id); // a live view — the turn would run on with none

		// A stale client (remount racing a live turn) tries to start a second turn.
		const res2 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res2.status, 409, "concurrent turn rejected — last-writer-wins persist would clobber it");

		await view1; // finish → onFinish → endTurn
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");

		const res3 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res3.status, 200, "the next turn is accepted after the previous finished");
		await drainRunning(chat.id);
	});

});

describe("renameChat (the header's click-to-edit title)", () => {
	it("persists the title and does NOT bump updatedAt — sidebar order must not churn", () => {
		const chat = chatStore.createChat("old title");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const renamed = chatStore.renameChat(chat.id, "  new title  ");
		assert.equal(renamed.title, "new title", "trimmed on the way in");
		assert.equal(chatStore.getChat(chat.id)!.title, "new title");
		assert.equal(
			chatStore.getChat(chat.id)!.updatedAt,
			before,
			"a rename is not conversation activity",
		);
		assert.equal(
			chatStore.listChats().find((c) => c.id === chat.id)!.title,
			"new title",
			"the sidebar list view sees it",
		);
	});

	it("falls back to Untitled session on an all-whitespace title (the honest floor)", () => {
		const chat = chatStore.createChat("keep me");
		createdChats.push(chat.id);
		const renamed = chatStore.renameChat(chat.id, "   ");
		assert.equal(renamed.title, "Untitled session");
	});
});

describe("the BYOK turn gate (no factory floor — owner, 2026-09-22)", () => {
	it("a chat with no model refuses the turn with the 503 envelope — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: unconfigured chat", "scope");
		createdChats.push(chat.id);

		// The record's strong slot belongs to settings-store.test.ts (the
		// one-fs-owner policy) — READ the resolved truth, never write it.
		// Refusal holds when the chain is empty; a record-carried strong
		// slot legitimately opens the gate (the chain is honest both ways).
		const expectRefusal = effectiveSettings().models.strong === null;

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));

		if (expectRefusal) {
			assert.equal(res.status, 503, "the universal turn gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; missing: string[] };
			assert.equal(body.code, "models_not_configured");
			assert.deepEqual(body.missing, ["strong"]);
			assert.match(body.error, /No model configured/);
		} else {
			assert.equal(res.status, 200, "the record's strong slot satisfies the conversation chain");
			await drainRunning(chat.id);
		}

		// Either way: no phantom liveness, nothing durable from a refused turn.
		if (expectRefusal) {
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			const saved = chatStore.getChat(chat.id)!;
			assert.equal(saved.messages.length, 0, "no write-ahead persist before the gate");
		}
	});

	it("a per-chat model alone opens the gate (the setup flow's exact write)", async () => {
		const chat = createConfiguredChat("Test: per-chat pin only");
		createdChats.push(chat.id);
		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 200, "chat.settings.model satisfies the chain without any record slot");
		await drainRunning(chat.id);
	});
});

// ─── the key-presence turn gate (provider-key interlude, owner, 2026-09-25) ─

describe("the key-presence turn gate (provider-key interlude, 2026-09-25)", () => {
	// The gate's truth is env-first (keyValue): in tests process.env is the
	// WHOLE truth (the throwaway data dir has no auth.json), so each test
	// pins its provider's env var explicitly and restores it after.
	it("a pinned provider whose key is gone refuses with 503 provider_key_missing — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: keyless provider", "scope");
		createdChats.push(chat.id);
		const saved = process.env.TOGETHER_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		try {
			// The chat's own model override pins the provider — the same
			// chain the strong slot rides. The gate fires BEFORE the engine
			// build, so the fake model id never hits the catalog.
			chatStore.saveSettings(chat.id, { model: { provider: "together", id: "no-such-model" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 503, "the key-presence gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; provider: string; slots: string[] };
			assert.equal(body.code, "provider_key_missing");
			assert.equal(body.provider, "together", "the envelope names whose key is gone");
			assert.deepEqual(body.slots, ["strong"], "the conversation tier is the affected slot");
			assert.equal(body.error, "No Together key is set — add one in Settings → Keys", "the human line names the provider");
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} finally {
			if (saved !== undefined) process.env.TOGETHER_API_KEY = saved;
		}
	});

	it("an env-present key passes the gate (gate by what would run)", async () => {
		const chat = chatStore.createChat("Test: env-keyed provider", "scope");
		createdChats.push(chat.id);
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-presence-gate";
		try {
			// A REAL catalog model: the engine build AFTER the gate must
			// resolve — the injected agent replaces the loop, not the build.
			chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 200, "the env-shadowed key counts as present — the turn runs");
			await drainRunning(chat.id);
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
			else delete process.env.OPENAI_API_KEY;
		}
	});
});


// ─── parallel question calls (the deepseek batch incident, 2026-10-03) ─────



// ─── composer steering (owner arc 2026-10-03): the route + the live rail ────

describe("composer steering: POST /api/chats/[id]/steer", () => {
	const steerPost = (chatId: string, body: unknown): Promise<Response> =>
		steerRoute.POST(
			new Request(`http://test/api/chats/${chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			{ params: Promise.resolve({ id: chatId }) },
		);

	it("honest rejections: 404 unknown chat, 400 bad input, 409 when no turn is live", async () => {
		const chat = createConfiguredChat("Test: steer rejections");
		createdChats.push(chat.id);
		assert.equal((await steerPost("chat_nope", { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 404);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "text", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "  " } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 409);
	});

	it("200 + the live steering queue when a turn runs; the drain lands the card and the model sees it", async () => {
		// A GATED engine (the scriptedTeacher seam): the first factory
		// awaits our release, holding the turn open mid-generation so the
		// steer POST lands while the run is genuinely live.
		const calls: string[][] = [];
		let release!: () => void;
		const gate = new Promise<void>((res) => {
			release = res;
		});
		const faux = createFauxCore({});
		faux.setResponses([
			async (context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				await gate;
				return fauxAssistantMessage([fauxText("Teaching the solar system…")]);
			},
			(context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Steered — covering Venus too.")]);
			},
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const chat = createConfiguredChat("Test: steer live");
		createdChats.push(chat.id);

		// The turn starts and holds at the first model call.
		const turnRes = await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine as never));
		await waitFor(() => calls.length === 1, 8000, "first model call started");

		// The steer lands mid-turn: 200, handed to the live agent.
		const res = await steerPost(chat.id, { input: { type: "steer", id: "steer_live1", text: "also cover Venus" } });
		assert.equal(res.status, 200);
		assert.equal((await res.json() as { ok: boolean }).ok, true);

		// CONNECTION DIET B: the drain rides the reattach wire (the POST
		// acked long ago). Attach BEFORE releasing — a live view.
		const viewText = drainRunning(chat.id);
		release(); // the first response completes → the drain → the second call
		const body = await viewText;
		assert.match(body, /also cover Venus/, "the drained steer rode the live stream verbatim");

		// ONE turn: the second model call's context contains the steer
		// BETWEEN the user message and the continuing assistant text.
		assert.equal(calls.length, 2, "still one run — the steer continued it, not a new turn");
		assert.match(calls[1]!.join("\n"), /also cover Venus/, "the model saw the steer in its context");

		// The record persists the user steer in its true position.
		const saved = chatStore.getChat(chat.id)!;
		const roles = saved.messages.map((m) => (m as { role?: string }).role);
		assert.deepEqual(roles, ["user", "assistant", "user", "assistant"], "text → teaching → STEER → steered reply");
		const steerMsg = saved.messages[2] as { id?: string; content?: unknown };
		assert.equal(steerMsg.id, "steer_live1", "the client-minted id survived to the record");
		assert.equal(steerMsg.content, "also cover Venus");
	});
});

// ─── THE LACAN INCIDENT: per-response tool-call ids (owner fix 2026-10-04) ──
// DeepSeek (via OpenRouter) returns tool-call ids that reset every response —
// `call_0` for every turn's single call. Before the uniquifier, the duplicate
// ids corrupted the fold (the quiz answer overwrote the ask card, the ask
// question vanished), answer routing, and the shuffle seeds. Now the wire
// boundary remints colliding ids ONCE — the client, the record, the pending
// gate, and the next turn's provider context all see unique ids.
