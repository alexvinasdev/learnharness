/**
 * The scope's bulk generation queue (fork simplification 2026-02, owner
 * ruling): one global button enqueues cheatsheets/exercises for every
 * eligible leaf — sequential worker, persisted queue.json (survives
 * reloads). NOT the chat JobKind machinery (that is chat-attached); this
 * is scope-attached and deliberately dumber: a list on disk and one
 * promise chain.
 *
 * Cancellation law (owner 2026-11): every item is individually
 * cancellable. Pending items die before starting; a running item is
 * marked cancelled immediately (its model call is already spent — the
 * artifact may still land, paid for) and the worker NEVER resurrects a
 * cancelled item: after each await it re-reads the file fresh and merges
 * by id, so cancels issued mid-flight stick.
 *
 * Timing law: done items carry startedAt/endedAt; queueStatus derives
 * per-kind averages and per-item ETAs from them (pending items get the
 * kind average; a running item gets average minus elapsed). Estimates
 * start honest-null until the first same-kind item finishes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { getScope, readCheatsheet } from "./scopes.ts";
import { stores } from "./stores.ts";
import {
	walkTopics,
	isLeaf,
	importanceOf,
	type ScopeTopic,
	type Importance,
} from "../core/contracts/scope.ts";
import type { ExerciseBatch } from "../core/contracts/exercises.ts";
import { generateCheatsheet } from "./cheatsheets.ts";
import { generateExercises } from "./exercise-gen.ts";
import { emit } from "../core/events.ts";

export type GenKind = "cheatsheet" | "exercises";
export type GenStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface GenQueueItem {
	id: string;
	kind: GenKind;
	topicId: string;
	topicTitle: string;
	status: GenStatus;
	error?: string;
	enqueuedAt: string;
	startedAt?: string;
	endedAt?: string;
}

/** The queue view: items plus derived timing (per-kind averages from
 *  done items; ETA per remaining item; total = sum of remaining). */
export interface QueueStatus {
	items: GenQueueItem[];
	pending: number;
	running: number;
	done: number;
	error: number;
	cancelled: number;
	avgMs: Partial<Record<GenKind, number>>;
	totalEtaMs: number;
}

interface QueueFile {
	items: GenQueueItem[];
}

const queuePath = (scopeId: string) => path.join(PATHS.scopes, scopeId, "queue.json");

async function readQueue(scopeId: string): Promise<QueueFile> {
	try {
		const raw = await fs.readFile(queuePath(scopeId), "utf8");
		const parsed = JSON.parse(raw) as QueueFile;
		return Array.isArray(parsed.items) ? parsed : { items: [] };
	} catch {
		return { items: [] };
	}
}

async function writeQueue(scopeId: string, file: QueueFile): Promise<void> {
	await fs.mkdir(path.dirname(queuePath(scopeId)), { recursive: true });
	await fs.writeFile(queuePath(scopeId), JSON.stringify(file, null, "\t"), "utf8");
}

/** Max importance across objectives (an objective-independent topic is
 *  never excluded); rank orders the queue essential-first. */
function maxImportance(t: ScopeTopic, objectiveIds: string[]): Importance {
	const tiers: Importance[] = ["essential", "high", "medium", "low"];
	let best: Importance = "low";
	for (const oid of objectiveIds) {
		const v = importanceOf(t, oid);
		if (tiers.indexOf(v) < tiers.indexOf(best)) best = v;
	}
	return best;
}

/** The enqueue target list: non-excluded leaves missing their artifact,
 *  highest importance first (tree order breaks ties). */
export async function eligibleLeaves(
	scopeId: string,
	kind: GenKind,
): Promise<Array<{ topicId: string; topicTitle: string }>> {
	const scope = getScope(scopeId);
	if (!scope) throw new Error(`Unknown scope: ${scopeId}`);
	const objectiveIds = scope.objectives.map((o) => o.id);
	const leaves = walkTopics(scope.roots).filter((t) => isLeaf(t) && maxImportance(t, objectiveIds) !== "excluded");
	const missing: Array<{ topicId: string; topicTitle: string }> = [];
	for (const leaf of leaves) {
		if (kind === "cheatsheet") {
			const sheet = await readCheatsheet(scopeId, leaf.id);
			if (sheet === null) missing.push({ topicId: leaf.id, topicTitle: leaf.title });
		} else {
			const data = stores.scopeStore.getExercises(scopeId);
			const covered = (data?.batches ?? ([] as ExerciseBatch[])).some((b) => b.topicIds.includes(leaf.id));
			if (!covered) missing.push({ topicId: leaf.id, topicTitle: leaf.title });
		}
	}
	const rank: Record<Importance, number> = { essential: 0, high: 1, medium: 2, low: 3, excluded: 4 };
	const byId = new Map(walkTopics(scope.roots).map((t) => [t.id, t]));
	missing.sort((a, b) => {
		const ra = rank[maxImportance(byId.get(a.topicId)!, objectiveIds)];
		const rb = rank[maxImportance(byId.get(b.topicId)!, objectiveIds)];
		return ra - rb;
	});
	return missing;
}

// One worker chain per scope; module-level (single-process local app).
const workers = new Map<string, Promise<void>>();
let seq = 0;
const nowIso = () => new Date().toISOString();

/** Stamp an item's outcome by id on a FRESH read (never a stale copy —
 *  the resurrect bug: the pump holds no queue state across an await).
 *  Outcome stamps only apply while the item is still `running` — an
 *  external cancel (the per-item ✕) always wins over the worker's
 *  late completion stamp. */
export async function stampItem(scopeId: string, itemId: string, fields: Partial<GenQueueItem>): Promise<void> {
	const q = await readQueue(scopeId);
	const item = q.items.find((i) => i.id === itemId);
	if (!item || item.status !== "running") return;
	Object.assign(item, fields);
	await writeQueue(scopeId, q);
}

async function pump(scopeId: string): Promise<void> {
	for (;;) {
		const q = await readQueue(scopeId);
		const next = q.items.find((i) => i.status === "pending");
		if (!next) return;
		next.status = "running";
		next.startedAt = nowIso();
		await writeQueue(scopeId, q);
		emit("scopes-changed", {});
		try {
			if (next.kind === "cheatsheet") await generateCheatsheet(scopeId, next.topicId);
			else await generateExercises(scopeId, { topicIds: [next.topicId], count: 6 });
			await stampItem(scopeId, next.id, { status: "done", endedAt: nowIso() });
		} catch (err) {
			await stampItem(scopeId, next.id, {
				status: "error",
				endedAt: nowIso(),
				error: err instanceof Error ? err.message : "generation failed",
			});
		}
		emit("scopes-changed", {});
	}
}

function ensureWorker(scopeId: string): void {
	if (workers.has(scopeId)) return;
	const chain = pump(scopeId).finally(() => {
		workers.delete(scopeId);
		// a raced enqueue after the last item: restart the chain.
		void readQueue(scopeId).then((q) => {
			if (q.items.some((i) => i.status === "pending")) ensureWorker(scopeId);
		});
	});
	workers.set(scopeId, chain);
}

/** Enqueue every eligible leaf for the kind (skip-existing by default —
 *  bulk is for filling gaps, never silent regeneration). Finished
 *  business (done/error/cancelled from earlier runs) is pruned so the
 *  list the user watches is THIS run's. Returns how many items were
 *  newly queued. */
export async function enqueueGeneration(scopeId: string, kind: GenKind): Promise<number> {
	const targets = await eligibleLeaves(scopeId, kind);
	const q = await readQueue(scopeId);
	const live = q.items.filter((i) => i.status === "pending" || i.status === "running");
	q.items = live;
	if (targets.length === 0) {
		if (q.items.length !== live.length) await writeQueue(scopeId, q);
		return 0;
	}
	const already = new Set(live.map((i) => `${i.kind}:${i.topicId}`));
	let added = 0;
	for (const t of targets) {
		if (already.has(`${kind}:${t.topicId}`)) continue;
		q.items.push({ id: `gen_${Date.now().toString(36)}_${seq++}`, kind, topicId: t.topicId, topicTitle: t.topicTitle, status: "pending", enqueuedAt: nowIso() });
		added++;
	}
	if (added > 0) {
		await writeQueue(scopeId, q);
		ensureWorker(scopeId);
	}
	return added;
}

/** The live view with derived timing. */
export async function queueStatus(scopeId: string): Promise<QueueStatus> {
	const q = await readQueue(scopeId);
	const count = (s: GenStatus) => q.items.filter((i) => i.status === s).length;
	const avgMs: Partial<Record<GenKind, number>> = {};
	for (const kind of ["cheatsheet", "exercises"] as GenKind[]) {
		const durations = q.items
			.filter((i) => i.status === "done" && i.kind === kind && i.startedAt && i.endedAt)
			.map((i) => Date.parse(i.endedAt!) - Date.parse(i.startedAt!))
			.filter((d) => d >= 0);
		if (durations.length > 0) avgMs[kind] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
	}
	const now = Date.now();
	let totalEtaMs = 0;
	for (const i of q.items) {
		const avg = avgMs[i.kind];
		if (i.status === "pending" && avg !== undefined) totalEtaMs += avg;
		if (i.status === "running" && avg !== undefined && i.startedAt) {
			totalEtaMs += Math.max(0, avg - (now - Date.parse(i.startedAt)));
		}
	}
	return {
		items: q.items,
		pending: count("pending"),
		running: count("running"),
		done: count("done"),
		error: count("error"),
		cancelled: count("cancelled"),
		avgMs,
		totalEtaMs,
	};
}

/** Cancel one item (the per-item ✕). Pending dies before starting; a
 *  running item is marked cancelled NOW (the in-flight call may still
 *  land its artifact — it is paid for); the worker's stamp never
 *  overwrites a cancelled item back to done. Returns false when the
 *  item was already finished. */
export async function cancelItem(scopeId: string, itemId: string): Promise<boolean> {
	const q = await readQueue(scopeId);
	const item = q.items.find((i) => i.id === itemId);
	if (!item || item.status === "done" || item.status === "error" || item.status === "cancelled") return false;
	item.status = "cancelled";
	item.endedAt = nowIso();
	await writeQueue(scopeId, q);
	emit("scopes-changed", {});
	return true;
}

/** Cancel everything still cancellable (the global button): every
 *  pending item dies and the running one is marked cancelled. Returns
 *  how many items were cancelled. */
export async function cancelQueue(scopeId: string): Promise<number> {
	const q = await readQueue(scopeId);
	let removed = 0;
	for (const item of q.items) {
		if (item.status === "pending" || item.status === "running") {
			item.status = "cancelled";
			item.endedAt = nowIso();
			removed++;
		}
	}
	if (removed > 0) {
		await writeQueue(scopeId, q);
		emit("scopes-changed", {});
	}
	return removed;
}
