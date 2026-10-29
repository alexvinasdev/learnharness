import { chainsForSelection, formatChainLine, walkTopics } from "@/src/core";
import { newGraphContextMessage, type GraphContextPick } from "@/src/core";
import { compactionInFlight, createChat, getScope, isTurnRunning, listChats, readSettingsRecord, stores, titleFromPrompt } from "@/src/server";
import type { ChatListItem } from "@/src/core";

/** The session picker's list: record-derived summaries (phase, pending
 *  question) + live liveness — a running turn marks the session busy
 *  (contracts.ts ChatListItem; the store can't see liveness, the route is
 *  the merge point). Owner, minimal-color round: background jobs NO LONGER
 *  count — the sidebar's Background agents section is their channel now
 *  (a running spinner per row would double-signal them), so busy means
 *  exactly "a teach turn is in flight". */
export async function GET() {
	const chats: ChatListItem[] = listChats().map((c) => ({
		...c,
		busy: isTurnRunning(c.id),
		compacting: compactionInFlight(c.id),
	}));
	return Response.json({ chats });
}

export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { title?: unknown; kind?: unknown; scopeId?: unknown; classRootId?: unknown; graphContext?: unknown };
	const title = typeof body.title === "string" ? body.title : "";
	// Practice sessions (owner, 2026-10-04): kind "practice" marks the
	// record — the practice agent + its tools from turn 1, no extraction.
	// Scope sessions (fork 2026-01-26): kind "scope" + optional scopeId —
	// a session opened against an EXISTING scope (refinement); blank ones
	// create their scope in-turn (the scoper's scope_create). Classes
	// (ADR 0003): kind "class" + REQUIRED scopeId + optional classRootId
	// (the subtree anchor; absent = the whole scope) — validated against
	// the scope here, the only writer-side gate.
	const kind = body.kind === "practice" ? ("practice" as const) : body.kind === "scope" ? ("scope" as const) : body.kind === "class" ? ("class" as const) : undefined;
	const scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : undefined;
	let classRootId: string | undefined;
	if (kind === "class") {
		if (!scopeId) {
			return Response.json({ error: "A Class needs a scopeId — start it from a scope." }, { status: 400 });
		}
		const scope = getScope(scopeId);
		if (!scope) return Response.json({ error: "Unknown scope." }, { status: 404 });
		const rootId = typeof body.classRootId === "string" && body.classRootId ? body.classRootId : undefined;
		if (rootId && !walkTopics(scope.roots).some((t) => t.id === rootId)) {
			return Response.json({ error: "classRootId is not a topic of this scope." }, { status: 400 });
		}
		classRootId = rootId;
	}
	const chat = createChat(titleFromPrompt(title || "Untitled session"), kind, scopeId, classRootId);
	// PER-SESSION MODELS (owner, 2026-09-28): a session owns its model +
	// thinking level from birth — stamped verbatim from the STRONG slot,
	// the new-session default. From here the strong slot never reaches
	// this session again: in-session picks write the session's own record
	// (PUT /api/chats/:id/settings). No strong slot configured (fresh BYOK
	// boot) → no stamp; the turn gate's 503 models_not_configured envelope
	// refuses honestly until the setup flow fills the slot.
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	// The session's map context (owner, 2026-10-04): the picked
	// propositions ride the CREATION — message[0] is a graph-context
	// marker (a separate custom message BEFORE the learner's first user
	// message), carrying the picks plus the reasoning chains among them.
	// The picks carry their own name/statement (what the learner saw at
	// pick time); the chains derive from the CURRENT graph snapshot.
	const rawPicks = (body.graphContext as { propositions?: unknown } | undefined)?.propositions;
	const picks: GraphContextPick[] = Array.isArray(rawPicks)
		? rawPicks
				.filter(
						(p): p is GraphContextPick =>
							typeof p === "object" &&
							p !== null &&
							typeof (p as GraphContextPick).id === "string" &&
							typeof (p as GraphContextPick).name === "string" &&
							typeof (p as GraphContextPick).statement === "string",
					)
					.slice(0, 64)
			: [];
	if (picks.length > 0) {
		const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
		const pickedNodes = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
		const chainLines = chainsForSelection(pickedNodes, stores.graphStore.readChains()).map((c) =>
			formatChainLine(c, Object.fromEntries(byId)),
		);
		stores.chatStore.saveMessages(chat.id, [newGraphContextMessage(picks, chainLines)]);
	}
	return Response.json({ id: chat.id, title: chat.title });
}
