import { cancelItem, cancelQueue, getScope } from "@/src/server";

/**
 * Queue cancel (fork simplification 2026-02): no body (or empty) cancels
 * everything still cancellable; {itemId} cancels that one item (the
 * per-item ✕ — pending dies, running is marked cancelled now; its model
 * call is already spent and may still land the artifact).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => ({}))) as { itemId?: unknown };
	if (typeof body.itemId === "string") {
		const ok = await cancelItem(id, body.itemId);
		return Response.json({ cancelled: ok ? 1 : 0 });
	}
	return Response.json({ cancelled: await cancelQueue(id) });
}
