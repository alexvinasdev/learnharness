import { NewSession } from "@/components/new-session";
import { readSettingsRecord } from "@/src/server";
import { slotsConfigured } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * The draft view behind "+ New session" (owner, 2026-09-13): NO session is
 * created until the first message is sent — the view is a sessionless empty
 * chat; on send it creates the chat (title = that message) and redirects to
 * the real page, whose initialPrompt path delivers the message as turn 1.
 * Static segment beats the dynamic [id] route — "new" is never a chat id.
 *
 * The draft's model control binds the STRONG SLOT (the new-session
 * default); the session the first send creates is stamped from it
 * server-side (per-session models, owner 2026-09-28).
 *
 * The scope-or-class law (2026-02 + ADR 0003): a plain draft is a Scope
 * Session — the scoper agent interviews the learner into a persistent
 * Scope. ?scope=<id> opens the draft against an EXISTING scope
 * (refinement interviews). ?mode=class&scope=<id>[&topic=<id>] makes the
 * draft a CLASS — the agent that walks the scope (or the subtree
 * anchored by topic) teaching from cheatsheets and exercising from the
 * pool.
 */
export default async function NewSessionPage({
	searchParams,
}: {
	searchParams: Promise<{ scope?: string; topic?: string; mode?: string }>;
}) {
	const { scope, topic, mode } = await searchParams;
	const classTarget = mode === "class" && scope ? { scopeId: scope, topicId: topic } : undefined;
	return (
		<NewSession
			initialConfigured={slotsConfigured(readSettingsRecord()?.models)}
			{...(scope && !classTarget ? { scopeId: scope } : {})}
			{...(classTarget ? { classTarget } : {})}
		/>
	);
}
