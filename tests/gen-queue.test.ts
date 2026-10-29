/**
 * The bulk generation queue (fork simplification 2026-02): eligibility
 * (skip-existing, importance order, excluded-everywhere leaf dropped),
 * enqueue dedup, cancel-clears-pending, and the worker's honest error
 * path (no model configured → every item lands `error` with the reason,
 * the queue itself never wedges).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import (house pattern) ───────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gen-queue-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createScope, getScope, readCheatsheet, writeCheatsheet, landBatch } = await import("../src/server/scopes.ts");
const { stores } = await import("../src/server/stores.ts");
const { eligibleLeaves, enqueueGeneration, queueStatus, cancelQueue, cancelItem, stampItem } = await import("../src/server/gen-queue.ts");

const NOW = "2026-02-01T00:00:00Z";

/** A scope with three leaves: essential sheetless, low sheetless, and an
 *  everywhere-excluded leaf — plus one already covered by a batch. */
function seedScope(): string {
	const scope = createScope("Queue German");
	const s = getScope(scope.id)!;
	s.objectives = [{ id: "obj_q", text: "test", createdAt: NOW }];
	s.roots = [
		{
			id: "t_root",
			title: "root",
			children: [
				{ id: "t_low", title: "Low leaf", importance: { obj_q: "low" }, children: [] },
				{ id: "t_ess", title: "Essential leaf", importance: { obj_q: "essential" }, children: [] },
				{ id: "t_exc", title: "Excluded leaf", importance: { obj_q: "excluded" }, children: [] },
				{ id: "t_bat", title: "Batched leaf", importance: { obj_q: "high" }, children: [] },
			],
		},
	];
	stores.scopeStore.saveScope(s);
	// the batched leaf already has a (pending) batch → not eligible for exercises
	landBatch(scope.id, ["t_bat"], []);
	return scope.id;
}

describe("eligibleLeaves — skip-existing, order, exclusion", () => {
	it("cheatsheets: sheeted leaves skipped, essential first, excluded dropped", async () => {
		const sid = seedScope();
		await writeCheatsheet(sid, "t_low", "# existing"); // low already has a sheet
		const leaves = await eligibleLeaves(sid, "cheatsheet");
		assert.deepEqual(leaves.map((l) => l.topicId), ["t_ess", "t_bat"], "essential before high; sheeted low skipped; excluded dropped");
	});

	it("…including every sheetless leaf ordered essential→high→low", async () => {
		const sid = seedScope();
		const leaves = await eligibleLeaves(sid, "cheatsheet");
		assert.deepEqual(leaves.map((l) => l.topicId), ["t_ess", "t_bat", "t_low"]);
	});

	it("exercises: only leaves without any batch", async () => {
		const sid = seedScope();
		const leaves = await eligibleLeaves(sid, "exercises");
		assert.deepEqual(leaves.map((l) => l.topicId), ["t_ess", "t_low"], "t_bat has a batch; t_exc excluded");
	});
});

describe("enqueue / status / cancel", () => {
	it("enqueue lands the eligible set exactly once (settle-tolerant: no model → items end done/error)", async () => {
		const sid = seedScope();
		const added = await enqueueGeneration(sid, "exercises");
		assert.equal(added, 2);
		// settle: the worker drains (error without a model) — but never wedges
		let st = await queueStatus(sid);
		for (let i = 0; i < 40 && st.pending + st.running > 0; i++) {
			await new Promise((r) => setTimeout(r, 100));
			st = await queueStatus(sid);
		}
		assert.equal(st.pending + st.running, 0, "worker drained");
		const keys = st.items.map((i) => `${i.kind}:${i.topicId}`);
		assert.equal(keys.length, 2, "exactly the eligible set — no duplicates");
		assert.deepEqual(new Set(keys), new Set(["exercises:t_ess", "exercises:t_low"]));
		assert.ok(st.items.every((i) => i.status === "done" || i.status === "error"));
	});

	it("cancel clears pending; worker items settle to error without a model (honest path)", async () => {
		const sid = seedScope();
		await enqueueGeneration(sid, "exercises");
		// let the worker attempt (no model configured in the tmp data dir)
		for (let i = 0; i < 40; i++) {
			const st = await queueStatus(sid);
			if (st.pending === 0) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const st = await queueStatus(sid);
		assert.equal(st.pending, 0, "worker drained the queue");
		assert.ok(st.error >= 1, `items failed honestly (${st.error} errors) — no model in tmp dir`);
		assert.ok(st.items.every((i) => i.status !== "running"), "nothing wedged");

		// cancel path on a fresh scope: enqueue then cancel everything pending
		const sid2 = seedScope();
		await enqueueGeneration(sid2, "cheatsheet");
		const removed = await cancelQueue(sid2);
		assert.ok(removed >= 1, "pending items removed");
		const st2 = await queueStatus(sid2);
		assert.equal(st2.pending, 0);
	});

	it("unknown scope rejects", async () => {
		await assert.rejects(() => eligibleLeaves("scope_ghost", "cheatsheet"), /Unknown scope/);
	});

	it("readCheatsheet sanity for the sheeted case", async () => {
		const sid = seedScope();
		await writeCheatsheet(sid, "t_ess", "# Dativ");
		assert.ok((await readCheatsheet(sid, "t_ess"))!.includes("Dativ"));
	});
});

describe("per-item cancel and the never-resurrect guard", () => {
	const queueFile = (sid: string) => path.join(TMP_DATA, "scopes", sid, "queue.json");

	/** Craft the queue file directly (the file IS the persistence contract). */
	function seedQueue(sid: string, items: Array<Record<string, unknown>>): void {
		fs.mkdirSync(path.dirname(queueFile(sid)), { recursive: true });
		fs.writeFileSync(queueFile(sid), JSON.stringify({ items }, null, "\t"));
	}

	it("cancelItem kills a pending item; finished items refuse", async () => {
		const sid = seedScope();
		seedQueue(sid, [
			{ id: "gen_a", kind: "cheatsheet", topicId: "t_ess", topicTitle: "Essential leaf", status: "pending", enqueuedAt: NOW },
			{ id: "gen_b", kind: "cheatsheet", topicId: "t_low", topicTitle: "Low leaf", status: "done", enqueuedAt: NOW, startedAt: NOW, endedAt: NOW },
		]);
		assert.equal(await cancelItem(sid, "gen_a"), true, "pending is cancellable");
		assert.equal(await cancelItem(sid, "gen_a"), false, "already cancelled refuses");
		assert.equal(await cancelItem(sid, "gen_b"), false, "done refuses");
		assert.equal(await cancelItem(sid, "gen_ghost"), false, "unknown id refuses");
		const st = await queueStatus(sid);
		assert.equal(st.items.find((i) => i.id === "gen_a")?.status, "cancelled");
		assert.equal(st.cancelled, 1);
	});

	it("stampItem never resurrects a cancelled item (the late-stamp guard)", async () => {
		const sid = seedScope();
		seedQueue(sid, [
			{ id: "gen_r", kind: "cheatsheet", topicId: "t_ess", topicTitle: "Essential leaf", status: "running", enqueuedAt: NOW, startedAt: NOW },
			{ id: "gen_c", kind: "cheatsheet", topicId: "t_low", topicTitle: "Low leaf", status: "cancelled", enqueuedAt: NOW },
		]);
		// the worker's late completion for an externally cancelled item
		await stampItem(sid, "gen_c", { status: "done", endedAt: NOW });
		assert.equal((await queueStatus(sid)).items.find((i) => i.id === "gen_c")?.status, "cancelled", "cancel wins over the late stamp");
		// a genuinely running item still stamps
		await stampItem(sid, "gen_r", { status: "done", endedAt: NOW });
		assert.equal((await queueStatus(sid)).items.find((i) => i.id === "gen_r")?.status, "done");
	});

	it("enqueue prunes finished business — the watched list is THIS run's", async () => {
		const sid = seedScope();
		seedQueue(sid, [
			{ id: "gen_old1", kind: "cheatsheet", topicId: "t_ess", topicTitle: "Essential leaf", status: "done", enqueuedAt: NOW },
			{ id: "gen_old2", kind: "cheatsheet", topicId: "t_low", topicTitle: "Low leaf", status: "error", error: "no model", enqueuedAt: NOW },
			{ id: "gen_old3", kind: "cheatsheet", topicId: "t_exc", topicTitle: "Excluded leaf", status: "cancelled", enqueuedAt: NOW },
		]);
		const added = await enqueueGeneration(sid, "exercises");
		assert.equal(added, 2);
		const st = await queueStatus(sid);
		assert.ok(st.items.every((i) => i.status === "pending" || i.status === "running"), "old done/error/cancelled pruned");
		assert.ok(!st.items.some((i) => i.id.startsWith("gen_old")), "none of the old items survive");
	});
});

describe("timing — averages and ETAs derived from done items", () => {
	const queueFile = (sid: string) => path.join(TMP_DATA, "scopes", sid, "queue.json");

	it("avgMs per kind; pending items get the kind average; running gets average minus elapsed", async () => {
		const sid = seedScope();
		const t0 = "2026-02-01T00:00:00Z";
		fs.mkdirSync(path.dirname(queueFile(sid)), { recursive: true });
		fs.writeFileSync(queueFile(sid), JSON.stringify({
			items: [
				// one done per kind: 30s cheatsheet, 60s exercises
				{ id: "g1", kind: "cheatsheet", topicId: "t_ess", topicTitle: "A", status: "done", enqueuedAt: t0, startedAt: t0, endedAt: "2026-02-01T00:00:30Z" },
				{ id: "g2", kind: "exercises", topicId: "t_low", topicTitle: "B", status: "done", enqueuedAt: t0, startedAt: t0, endedAt: "2026-02-01T00:01:00Z" },
				// remaining work: one pending of each kind + one just-started exercises
				{ id: "g3", kind: "cheatsheet", topicId: "t_bat", topicTitle: "C", status: "pending", enqueuedAt: t0 },
				{ id: "g4", kind: "exercises", topicId: "t_exc", topicTitle: "D", status: "pending", enqueuedAt: t0 },
				{ id: "g5", kind: "exercises", topicId: "t_ess", topicTitle: "E", status: "running", enqueuedAt: t0, startedAt: new Date().toISOString() },
			],
		}, null, "\t"));
		const st = await queueStatus(sid);
		assert.equal(st.avgMs.cheatsheet, 30000);
		assert.equal(st.avgMs.exercises, 60000);
		// 30s (pending cheatsheet) + 60s (pending exercises) + ~60s (running, just started)
		assert.ok(st.totalEtaMs > 138000 && st.totalEtaMs <= 150000, `totalEtaMs ${st.totalEtaMs}`);
	});

	it("no done history → estimates stay honest-null, total 0", async () => {
		const sid = seedScope();
		fs.mkdirSync(path.dirname(queueFile(sid)), { recursive: true });
		fs.writeFileSync(queueFile(sid), JSON.stringify({
			items: [{ id: "g1", kind: "cheatsheet", topicId: "t_ess", topicTitle: "A", status: "pending", enqueuedAt: NOW }],
		}, null, "\t"));
		const st = await queueStatus(sid);
		assert.equal(st.avgMs.cheatsheet, undefined);
		assert.equal(st.totalEtaMs, 0);
	});
});
