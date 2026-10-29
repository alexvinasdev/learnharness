import { GrindView } from "@/components/grind/grind-view";

export const dynamic = "force-dynamic";

/**
 * The grind view (fork 2026-01-26, plan v2 W6): the NON-chat exercise loop —
 * zero LLM in it, one exercise at a time, instant binary feedback, until the
 * learner stops. Reached from the scope view's "Open grind".
 */
export default async function GrindPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <GrindView scopeId={id} />;
}
