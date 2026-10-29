import { getScope, readCheatsheet, writeCheatsheet } from "@/src/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; topicId: string }> }) {
	const { id, topicId } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const markdown = readCheatsheet(id, topicId);
	if (markdown === null) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ topicId, markdown });
}

/** The write seam for the W5 generation job (and tests) — regenerable
 *  files, replace-whole. No manual editor exists by design (CONTEXT.md). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; topicId: string }> }) {
	const { id, topicId } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { markdown?: unknown } | null;
	if (typeof body?.markdown !== "string" || body.markdown === "") {
		return Response.json({ error: "markdown must be a non-empty string" }, { status: 400 });
	}
	writeCheatsheet(id, topicId, body.markdown);
	return Response.json({ ok: true });
}
