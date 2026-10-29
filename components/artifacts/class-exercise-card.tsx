"use client";

import { useContext, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { ExerciseCard } from "@/components/grind/exercise-card";
import { exerciseResultText, type ArtifactPartProps, type Exercise } from "@/src/core";

/**
 * The Class's posed-exercise card (ADR 0003): renders pose_exercise's
 * details payload (the stamped exercise) with the SAME deterministic
 * renderers the grind view uses. Grading is client-deterministic, never
 * AI; the outcome takes TWO seams — the attempt POSTs to the grind seam
 * (the same route the grind view uses, so the Grind Log is one truth),
 * then the [EXERCISE RESULT] marker message rides ChatActionsContext
 * into the conversation (the agent's pacing input). A page reload shows
 * the exercise unanswered — answering again is a real grind attempt
 * (append-only log), and the marker carries the latest outcome.
 */
export function ClassExerciseCard({ part }: ArtifactPartProps) {
	const actions = useContext(ChatActionsContext);
	const [answer, setAnswer] = useState<{ ok: boolean } | null>(null);
	const sentRef = useRef(false);
	if (part.state !== "output-available") return null;
	const out = part.output as { scopeId?: unknown; exercise?: unknown } | null | undefined;
	if (
		typeof out !== "object" ||
		out === null ||
		typeof out.scopeId !== "string" ||
		typeof (out.exercise as { type?: unknown } | null | undefined)?.type !== "string"
	) {
		return null;
	}
	const { scopeId, exercise } = out as { scopeId: string; exercise: Exercise };

	const onResult = (ok: boolean) => {
		setAnswer({ ok });
		// Measurement seam: one attempt into the grind log.
		void fetch(`/api/scopes/${scopeId}/grind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ exerciseId: exercise.id, ok }),
		});
		// Conversation seam: the marker the agent reads (single flight —
		// the renderers fire onResult once, the ref is the belt).
		if (!sentRef.current && actions) {
			sentRef.current = true;
			actions.sendText(exerciseResultText(exercise.id, ok));
		}
	};

	return (
		<div className="my-3">
			<ExerciseCard exercise={exercise} answer={answer} onResult={onResult} />
		</div>
	);
}
