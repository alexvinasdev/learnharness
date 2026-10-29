import { generateExercises, getScope } from "@/src/server";

/** The batch-generation seam (plan v2 W6): one shot — the batch lands
 *  STRAIGHT in the grind pool (auto-accept; bury is the curation). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => ({}))) as { topicIds?: unknown; count?: unknown };
	const topicIds = Array.isArray(body.topicIds) ? body.topicIds.filter((t): t is string => typeof t === "string") : [];
	if (topicIds.length === 0) return Response.json({ error: "topicIds (string[]) required" }, { status: 400 });
	const count = typeof body.count === "number" ? body.count : undefined;
	try {
		const result = await generateExercises(id, { topicIds, ...(count ? { count } : {}) });
		return Response.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "generation failed";
		const status = message.startsWith("Unknown") ? 404 : 503;
		return Response.json({ error: message }, { status });
	}
}
