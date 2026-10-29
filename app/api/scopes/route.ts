import { createScope, listScopes } from "@/src/server";

/** The scope picker's list: light summaries, most recently updated first. */
export async function GET() {
	return Response.json({ scopes: listScopes() });
}

/** Create an empty scope — objectives and the tree arrive via the scoper
 *  interview (saveScope), never here. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { name?: unknown };
	if (typeof body.name !== "string" || body.name.trim() === "") {
		return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
	}
	const scope = createScope(body.name);
	return Response.json({ id: scope.id, name: scope.name });
}
