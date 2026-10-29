import { deleteScope, getScope, saveScope } from "@/src/server";
import type { Scope } from "@/src/core";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const scope = getScope(id);
	if (!scope) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(scope);
}

/** Replace-whole save (the scoper interview's apply and the UI's manual
 *  importance edits both land here). Validation — duplicate ids, dangling
 *  requires/importance refs — is the service layer's; a violation is a
 *  client bug, surfaced as 400 with the readable message. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as Scope | null;
	if (!body || typeof body !== "object" || body.id !== id) {
		return Response.json({ error: "body must be the scope record (id matching the route)" }, { status: 400 });
	}
	try {
		saveScope(body);
		return Response.json({ ok: true, scope: getScope(id) });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "invalid scope" }, { status: 400 });
	}
}

/** Delete the scope's whole directory. Sessions keep their dangling
 *  scopeId — the orphan doctrine, flagged never cascaded. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!deleteScope(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ ok: true });
}
