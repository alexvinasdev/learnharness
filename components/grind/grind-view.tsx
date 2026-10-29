"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { pickExercise, type Exercise, type ExerciseStats } from "@/src/core";
import { ExerciseCard } from "@/components/grind/exercise-card";

/**
 * The grind loop's client (fork 2026-01-26, plan v2 W6): NON-chat, zero LLM.
 * Pool = accepted, non-buried exercises; greedy pick per turn (not-learned →
 * rusty → maintenance, core/exercise-pick); served-this-session ids exclude
 * until the pool cycles (failed items re-enter first on the reset — fail%
 * rules). Instant binary feedback; every answer POSTs to the grind seam and
 * the returned derived stats update in place.
 */

interface ExercisesView {
	exercises: Exercise[];
	batches: Array<{ id: string; status: "pending" | "accepted" }>;
	statsById: Record<string, ExerciseStats | null>;
	rollups: Record<string, { learned: number; total: number }>;
}

type Phase = { kind: "loading" } | { kind: "done"; reason: string } | { kind: "exercise"; exercise: Exercise };

export function GrindView({ scopeId }: { scopeId: string }) {
	const [view, setView] = useState<ExercisesView | null>(null);
	const [stats, setStats] = useState<Record<string, ExerciseStats | null>>({});
	const [phase, setPhase] = useState<Phase>({ kind: "loading" });
	const [served, setServed] = useState<Set<string>>(new Set());
	const [answer, setAnswer] = useState<null | { ok: boolean }>(null);
	const [note, setNote] = useState<string | null>(null);
	const [rounds, setRounds] = useState(0);

	const pool = useMemo(
		() =>
			view
				? view.exercises.filter((e) => !e.buried && view.batches.find((b) => b.id === e.batchId)?.status === "accepted")
				: [],
		[view],
	);

	const serveNext = useCallback(
		(currentStats: Record<string, ExerciseStats | null>, servedIds: ReadonlySet<string>) => {
			let pick = pickExercise(pool, currentStats, servedIds);
			if (pick === null && servedIds.size > 0) {
				// Pool cycled: failed items re-enter FIRST (their fail% leads the
				// not-learned group) — "re-offered later in the same session".
				const reset = new Set<string>();
				pick = pickExercise(pool, currentStats, reset);
				setServed(reset);
			}
			setAnswer(null);
			if (pick === null) setPhase({ kind: "done", reason: pool.length === 0 ? "No exercises yet — generate a batch from the scope view" : "Everything served — session complete" });
			else {
				setPhase({ kind: "exercise", exercise: pick });
				setServed((prev) => new Set([...prev, pick!.id]));
				setRounds((r) => r + 1);
			}
		},
		[pool],
	);

	useEffect(() => {
		void (async () => {
			const [scopeRes, exRes] = await Promise.all([
				fetch(`/api/scopes/${scopeId}`),
				fetch(`/api/scopes/${scopeId}/exercises`),
			]);
			if (!scopeRes.ok || !exRes.ok) {
				setPhase({ kind: "done", reason: "Scope not found" });
				return;
			}
			const v = (await exRes.json()) as ExercisesView;
			setView(v);
			setStats(v.statsById);
		})();
	}, [scopeId]);

	// Serve the first exercise once the view lands (and after bury/refetch).
	useEffect(() => {
		if (view && phase.kind === "loading") serveNext(stats, served);
	}, [view]); // initial serve only; explicit actions drive the rest

	const submit = async (ok: boolean) => {
		if (phase.kind !== "exercise") return;
		setAnswer({ ok });
		const res = await fetch(`/api/scopes/${scopeId}/grind`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ exerciseId: phase.exercise.id, ok }),
		});
		if (res.ok) {
			const fresh = (await res.json()) as ExerciseStats;
			setStats((prev) => ({ ...prev, [phase.exercise.id]: fresh }));
		} else setNote("The attempt could not be saved — check the server");
	};

	const bury = async (exerciseId: string) => {
		await fetch(`/api/scopes/${scopeId}/exercises`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "bury", exerciseId, buried: true }),
		});
		setServed((prev) => {
			const next = new Set(prev);
			next.delete(exerciseId);
			return next;
		});
		serveNext(stats, new Set([...served].filter((id) => id !== exerciseId)));
	};

	if (phase.kind === "loading") {
		return <p className="p-8 font-ui text-sm text-muted-foreground">loading…</p>;
	}
	if (phase.kind === "done") {
		return (
			<div className="flex h-dvh flex-col items-center justify-center gap-3">
				<p className="font-ui text-sm text-muted-foreground">{phase.reason}</p>
				<Link href={`/scope`} className="rounded-md border border-border px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent">
					Back to the scope
				</Link>
			</div>
		);
	}

	const e = phase.exercise;
	const s = stats[e.id];
	return (
		<div className="flex h-dvh flex-col">
			<header className="flex items-center gap-3 px-4 py-2">
				<Link href="/scope" className="font-ui text-xs text-muted-foreground hover:text-foreground">
					← scope
				</Link>
				<span className="font-ui text-xs text-muted-foreground">
					round {rounds} · pool {pool.length} · {pool.filter((p) => stats[p.id]?.learned).length} learned
				</span>
				{s && (
					<span className="ml-auto font-ui text-[11px] text-muted-foreground">
						{s.attempts} attempts · {s.failPct}% fail{s.rusty ? " · rusty" : ""}
					</span>
				)}
			</header>
			{note && (
				<p className="mx-4 rounded-md border border-border bg-card px-3 py-1.5 font-ui text-xs text-muted-foreground">
					{note}
					<button type="button" className="ml-2 underline" onClick={() => setNote(null)}>
						dismiss
					</button>
				</p>
			)}
			<main className="flex min-h-0 flex-1 items-center justify-center px-4">
				<div className="w-full max-w-2xl">
					<ExerciseCard exercise={e} answer={answer} onResult={(ok) => void submit(ok)} onNext={() => serveNext(stats, served)} />
				</div>
			</main>
			<footer className="flex items-center justify-center gap-3 px-4 pb-4">
				<button
					type="button"
					onClick={() => void bury(e.id)}
					className="rounded-md border border-border px-2.5 py-1.5 font-ui text-xs text-muted-foreground hover:text-foreground"
					title="Exclude from the pool, keep history"
				>
					Bury this exercise
				</button>
			</footer>
		</div>
	);
}

