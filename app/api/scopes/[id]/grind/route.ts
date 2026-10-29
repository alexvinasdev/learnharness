import { getScope, recordAttempt } from "@/src/server";

/** The grind loop's write seam: one attempt per POST, binary outcome.
 *  Returns the exercise's fresh derived stats — the grind view updates
 *  in place (no refetch of the whole pool per answer). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { exerciseId?: unknown; ok?: unknown } | null;
	if (typeof body?.exerciseId !== "string" || typeof body?.ok !== "boolean") {
		return Response.json({ error: "exerciseId (string) and ok (boolean) are required" }, { status: 400 });
	}
	try {
		return Response.json(recordAttempt(id, body.exerciseId, body.ok));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "attempt failed" }, { status: 400 });
	}
}
