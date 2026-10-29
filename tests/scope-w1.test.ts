/**
 * Scope persistence + REST round-trip (W1) — the fork's scope family:
 * scope.json CRUD with lazy version stamps, the exercises pool discipline
 * (batches land POOLED — auto-accept; bury is the only curation), the
 * append-only grind log, and cheatsheet files. Drives the REAL route handlers
 * (framework-free Request/Response) under an isolated LH_DATA_DIR — the
 * seam must be set before the first import that transitively loads
 * config.ts, so every app-module import is dynamic (the house pattern,
 * tests/chat-birth-stamp.test.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scope-w1-"));
process.env.LH_DATA_DIR = TMP_DATA;

const scopesRoute = await import("../app/api/scopes/route.ts");
const scopeRoute = await import("../app/api/scopes/[id]/route.ts");
const exercisesRoute = await import("../app/api/scopes/[id]/exercises/route.ts");
const grindRoute = await import("../app/api/scopes/[id]/grind/route.ts");
const cheatsheetRoute = await import("../app/api/scopes/[id]/cheatsheets/[topicId]/route.ts");
const { saveScope } = await import("../src/server/scopes.ts");
const { scopeStore, newObjectiveId, newTopicId } = await import("../src/store/scope.ts");
import type { Importance, Scope, ScopeTopic } from "../src/core/contracts/scope.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;
const req = (url: string, method: string, body?: unknown) =>
	new Request(url, {
		method,
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

// A scope with one objective and a two-leaf tree, built through the service
// (the same shape the scoper interview will produce).
function builtScope(id: string, name: string): Scope {
	const obj = newObjectiveId();
	const leaf1: ScopeTopic = { id: newTopicId(), title: "Nominativ", children: [], importance: { [obj]: "essential" as Importance } };
	const leaf2: ScopeTopic = { id: newTopicId(), title: "Dativ", children: [], importance: { [obj]: "high" as Importance } };
	return {
		id,
		name,
		objectives: [{ id: obj, text: "Vivir en Suiza", createdAt: new Date().toISOString() }],
		roots: [{ id: newTopicId(), title: "Casos gramaticales", children: [leaf1, leaf2] }],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("scope CRUD round-trip", () => {
	it("creates via POST, lists, fetches, saves, deletes", async () => {
		const created = await json(
			await scopesRoute.POST(req("http://t/api/scopes", "POST", { name: "Alemán" })),
		);
		const id = created.id as string;

		const list = (await json(await scopesRoute.GET())) as unknown as { scopes: unknown[] };
		assert.equal(list.scopes.length, 1);

		const fetched = (await json(await scopeRoute.GET(req(`http://t/api/scopes/${id}`, "GET"), { params: Promise.resolve({ id }) }))) as unknown as Scope;
		assert.equal(fetched.name, "Alemán");
		assert.equal(fetched.objectives.length, 0);

		const saved = builtScope(id, "Alemán");
		const put = await scopeRoute.PUT(req(`http://t/api/scopes/${id}`, "PUT", saved), { params: Promise.resolve({ id }) });
		assert.equal(put.status, 200);
		const after = (await json(await scopeRoute.GET(req(`http://t/api/scopes/${id}`, "GET"), { params: Promise.resolve({ id }) }))) as unknown as Scope;
		assert.equal(after.objectives.length, 1);
		assert.equal(after.version, 1, "writes stamp the lazy version");
		assert.ok(after.updatedAt >= saved.updatedAt, "save bumps updatedAt");

		const del = await scopeRoute.DELETE(req(`http://t/api/scopes/${id}`, "DELETE"), { params: Promise.resolve({ id }) });
		assert.equal(del.status, 200);
		assert.equal(((await json(await scopesRoute.GET())) as unknown as { scopes: unknown[] }).scopes.length, 0);
	});

	it("rejects shape violations with readable 400s (dup ids, dangling refs)", async () => {
		const id = ((await json(await scopesRoute.POST(req("http://t/api/scopes", "POST", { name: "X" })))) as { id: string }).id;
		const base = builtScope(id, "X");
		const put = (scope: Scope) =>
			scopeRoute.PUT(req(`http://t/api/scopes/${id}`, "PUT", scope), { params: Promise.resolve({ id }) });

		const dup = structuredClone(base);
		dup.roots[0]!.children.push({ ...dup.roots[0]!.children[0]! }); // same leaf id twice
		assert.match(String(((await json(await put(dup))).error)), /duplicate topic id/);

		const dangling = structuredClone(base);
		dangling.roots[0]!.children[1]!.requires = ["t_nope"];
		assert.match(String(((await json(await put(dangling))).error)), /unknown topic t_nope/);

		const badKey = structuredClone(base);
		badKey.roots[0]!.children[0]!.importance = { obj_ghost: "high" };
		assert.match(String(((await json(await put(badKey))).error)), /unknown objective obj_ghost/);

		assert.equal((await put(base)).status, 200, "the clean version passes");
	});

	it("refuses a newer-stamped scope honestly (reads as 404)", async () => {		const id = ((await json(await scopesRoute.POST(req("http://t/api/scopes", "POST", { name: "Y" })))) as { id: string }).id;
		const file = path.join(TMP_DATA, "scopes", id, "scope.json");
		const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { version: number };
		fs.writeFileSync(file, JSON.stringify({ ...record, version: 99 }), "utf-8");
		const res = await scopeRoute.GET(req(`http://t/api/scopes/${id}`, "GET"), { params: Promise.resolve({ id }) });
		assert.equal(res.status, 404, "a future schema version reads as absent");
	});

	it("hostile ids never escape the data dir (house law: reads null, writes throw)", () => {
		assert.equal(scopeStore.getScope("scope_..%2Fevil"), null, "the read's try/catch swallows the guard — reads as absent");
		assert.throws(() => scopeStore.writeCheatsheet("scope_ok123", "bad topic!", "x"), /Invalid topic id/);
	});
});

describe("exercises pool discipline + grind round-trip", () => {
	const BASE = "http://t";
	let scopeId = "";
	let topicId = "";

	it("lands a batch STRAIGHT in the pool (auto-accept); grind attempts derive stats", async () => {
		scopeId = ((await json(await scopesRoute.POST(req(`${BASE}/api/scopes`, "POST", { name: "G" })))) as { id: string }).id;
		const scope = builtScope(scopeId, "G");
		saveScope(scope);
		topicId = scope.roots[0]!.children[0]!.id;

		const drafts = [
			{ topicId, type: "flashcard" as const, payload: { front: "der Hund", back: "el perro" } },
			{ topicId, type: "cloze" as const, payload: { template: "Der ___ schläft", blanks: [{ accepted: ["Hund"], distractors: ["Katze"] }] } },
		];
		await exercisesRoute.POST(req(`${BASE}/api/scopes/${scopeId}/exercises`, "POST", { topicIds: [topicId], exercises: drafts }), { params: Promise.resolve({ id: scopeId }) });

		const pool = (await json(
			await exercisesRoute.GET(req(`${BASE}/api/scopes/${scopeId}/exercises`, "GET"), { params: Promise.resolve({ id: scopeId }) }),
		)) as unknown as {
			exercises: Array<{ id: string; batchId: string; buried?: boolean }>;
			batches: Array<{ id: string; status: string }>;
			statsById: Record<string, unknown>;
			rollups: Record<string, { total: number; learned: number }>;
		};
		assert.equal(pool.batches.length, 1);
		assert.equal(pool.batches[0]!.status, "accepted", "no review gate — the batch lands pooled");
		assert.equal(pool.exercises.length, 2);
		assert.ok(pool.exercises.every((e) => e.id.startsWith("ex_")), "ids minted server-side");
		assert.equal(pool.rollups[topicId]?.total ?? 0, 2, "landed items are the pool immediately");

		// Attempts work immediately — three correct → learned.
		const target = pool.exercises[0]!.id;
		for (let i = 0; i < 3; i++) {
			const stats = (await json(
				await grindRoute.POST(req(`${BASE}/api/scopes/${scopeId}/grind`, "POST", { exerciseId: target, ok: true }), { params: Promise.resolve({ id: scopeId }) }),
			)) as unknown as { learned: boolean; attempts: number };
			assert.equal(stats.attempts, i + 1);
			assert.equal(stats.learned, i === 2, "learned exactly on the third correct");
		}

		const after = (await json(
			await exercisesRoute.GET(req(`${BASE}/api/scopes/${scopeId}/exercises`, "GET"), { params: Promise.resolve({ id: scopeId }) }),
		)) as unknown as { rollups: Record<string, { learned: number; total: number }> };
		assert.deepEqual(after.rollups[topicId], { learned: 1, total: 2, learnedPct: 50 } as never);
	});

	it("bury is the only curation — accept/discard are gone (auto-accept doctrine)", async () => {
		// A second batch: also pooled on landing.
		const drafts = [{ topicId, type: "flashcard" as const, payload: { front: "die Katze", back: "la gata" } }];
		await exercisesRoute.POST(req(`${BASE}/api/scopes/${scopeId}/exercises`, "POST", { topicIds: [topicId], exercises: drafts }), { params: Promise.resolve({ id: scopeId }) });
		const pool = (await json(
			await exercisesRoute.GET(req(`${BASE}/api/scopes/${scopeId}/exercises`, "GET"), { params: Promise.resolve({ id: scopeId }) }),
		)) as unknown as { exercises: Array<{ id: string; batchId: string }> };
		const target = pool.exercises[pool.exercises.length - 1]!.id; // the second batch's only item

		// The retired review-queue actions read as bad requests now.
		assert.equal(
			(await exercisesRoute.PATCH(
				req(`${BASE}/api/scopes/${scopeId}/exercises`, "PATCH", { action: "discard", exerciseId: target }),
				{ params: Promise.resolve({ id: scopeId }) },
			)).status,
			400,
			"discard died with the review queue",
		);
		assert.equal(
			(await exercisesRoute.PATCH(
				req(`${BASE}/api/scopes/${scopeId}/exercises`, "PATCH", { action: "accept-batch", batchId: "batch_nope" }),
				{ params: Promise.resolve({ id: scopeId }) },
			)).status,
			400,
			"accept-batch died with the review queue",
		);

		// Bury: excluded from selection AND from the rollup denominator,
		// history intact.
		assert.equal(
			(await exercisesRoute.PATCH(
				req(`${BASE}/api/scopes/${scopeId}/exercises`, "PATCH", { action: "bury", exerciseId: target }),
				{ params: Promise.resolve({ id: scopeId }) },
			)).status,
			200,
		);
		const buriedPool = (await json(
			await exercisesRoute.GET(req(`${BASE}/api/scopes/${scopeId}/exercises`, "GET"), { params: Promise.resolve({ id: scopeId }) }),
		)) as unknown as { rollups: Record<string, { learned: number; total: number }>; exercises: Array<{ id: string; buried?: boolean }> };
		assert.equal(buriedPool.rollups[topicId]!.total, 2, "buried leaves the denominator");
		assert.equal(buriedPool.exercises.find((e) => e.id === target)!.buried, true, "kept, flagged");

		const buriedAttempt = await grindRoute.POST(
			req(`${BASE}/api/scopes/${scopeId}/grind`, "POST", { exerciseId: target, ok: true }),
			{ params: Promise.resolve({ id: scopeId }) },
		);
		assert.equal(buriedAttempt.status, 400, "buried exercises are never served");
	});
});

describe("cheatsheets file seam", () => {
	it("PUT then GET round-trips; unknown topic 404s", async () => {
		const id = ((await json(await scopesRoute.POST(req("http://t/api/scopes", "POST", { name: "C" })))) as { id: string }).id;
		const ctx = { params: Promise.resolve({ id, topicId: "t_abc123" }) };
		assert.equal(
			(await cheatsheetRoute.PUT(req(`http://t/api/scopes/${id}/cheatsheets/t_abc123`, "PUT", { markdown: "# Nominativ\n..." }), ctx)).status,
			200,
		);
		const got = (await json(await cheatsheetRoute.GET(req(`http://t/api/scopes/${id}/cheatsheets/t_abc123`, "GET"), ctx))) as { markdown: string };
		assert.equal(got.markdown, "# Nominativ\n...");
		const missing = await cheatsheetRoute.GET(req(`http://t/api/scopes/${id}/cheatsheets/t_ghost`, "GET"), { params: Promise.resolve({ id, topicId: "t_ghost" }) });
		assert.equal(missing.status, 404);
	});
});
