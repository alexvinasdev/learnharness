import { getScope, grindView, landBatch, setBuried } from "@/src/server";
import type { ExerciseDraft } from "@/src/server";

/** The pool surface: exercises, batches, and every DERIVED stat
 *  (learned/rusty/fail% per exercise, rollups per leaf) — the grind view
 *  reads this. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	// No exercises file yet = an empty pool, not a 404 (fresh scopes grind
	// nothing until W6 generation lands).
	return Response.json(grindView(id) ?? { exercises: [], batches: [], statsById: {}, rollups: {}, attempts: [] });
}

/** Land a generated batch (the exercise job posts here; tests too).
 *  Exercises arrive as drafts — ids and the batch record are minted
 *  server-side, and the batch lands STRAIGHT in the pool (auto-accept:
 *  the review-queue gate was retired). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { topicIds?: unknown; exercises?: unknown } | null;
	if (!Array.isArray(body?.topicIds) || !Array.isArray(body?.exercises)) {
		return Response.json({ error: "topicIds and exercises must be arrays" }, { status: 400 });
	}
	const drafts = (body as { exercises: unknown[] }).exercises.filter(
		(e): e is ExerciseDraft =>
			typeof e === "object" && e !== null && typeof (e as ExerciseDraft).topicId === "string" && typeof (e as ExerciseDraft).type === "string" && "payload" in e,
	);
	try {
		const batchId = landBatch(id, (body as { topicIds: string[] }).topicIds, drafts);
		return Response.json({ batchId });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "invalid batch" }, { status: 400 });
	}
}

/** Pool actions (one route, one action field):
 *  bury/unbury {exerciseId, buried} — exclusion with history intact. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as
		| { action?: unknown; batchId?: unknown; exerciseId?: unknown; buried?: unknown }
		| null;
	const bad = (error: string) => Response.json({ error }, { status: 400 });
	try {
		if (body?.action === "bury" || body?.action === "unbury") {
			if (typeof body.exerciseId !== "string") return bad("exerciseId required");
			if (!setBuried(id, body.exerciseId, body.action === "bury")) return bad("unknown exercise or not pooled");
			return Response.json({ ok: true });
		}
		return bad('action must be "bury" or "unbury"');
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "action failed" }, { status: 400 });
	}
}
