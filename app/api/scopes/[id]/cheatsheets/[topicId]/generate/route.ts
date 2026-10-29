import { generateCheatsheet, getScope } from "@/src/server";

/** The on-demand seam (plan v2 W5): generate/regenerate one leaf's page.
 *  The auto-trigger (taught) and this button share generateCheatsheet —
 *  stateless, regenerable, never edited by hand. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; topicId: string }> }) {
	const { id, topicId } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	try {
		const markdown = await generateCheatsheet(id, topicId);
		return Response.json({ topicId, markdown });
	} catch (err) {
		const message = err instanceof Error ? err.message : "generation failed";
		// Unknown topic vs no-model: 404 vs 503 — honest codes for the UI's note.
		const status = message.includes("Unknown topic") ? 404 : 503;
		return Response.json({ error: message }, { status });
	}
}
