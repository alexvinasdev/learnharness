import { enqueueGeneration, getScope, queueStatus, type GenKind } from "@/src/server";

/**
 * The bulk-generation queue's wire (fork simplification 2026-02):
 * POST {kind: "cheatsheet"|"exercises"} enqueues every eligible leaf
 * (skip-existing, importance order); GET is the live progress; the
 * sibling /cancel route clears pending. One route per verb, no action
 * field — the queue is small enough to stay honest.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(await queueStatus(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => ({}))) as { kind?: unknown };
	if (body.kind !== "cheatsheet" && body.kind !== "exercises") {
		return Response.json({ error: 'kind must be "cheatsheet" or "exercises"' }, { status: 400 });
	}
	try {
		const added = await enqueueGeneration(id, body.kind as GenKind);
		return Response.json({ added, status: await queueStatus(id) });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "enqueue failed" }, { status: 500 });
	}
}
