"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileTextIcon, GraduationCapIcon, SparklesIcon } from "lucide-react";
import { SidebarToggle } from "@/components/sidebar";
import { MessageResponse } from "@/components/ai-elements/message";
import { TopicNode, type LeafRollups } from "@/components/scope/scope-tree";
import type { Importance, Scope, ScopeSummary } from "@/src/core";

/**
 * The Scopes view (fork 2026-01-26, plan v2 W2): one page per app — scope
 * switcher, the tree (states + importance + rollups), manual importance
 * edits (replace-whole PUT), the cheatsheet viewer, and the doors out
 * (scope session draft, grind). Single-user local app: no routing
 * gymnastics, a select suffices.
 */

interface ExercisesView {
	rollups: LeafRollups;
}

/** Queue times for humans: <1s, 28s, 4m 12s, 1h 03m. */
function fmtMs(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 1) return "<1s";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** ?scope= preselects (the sidebar's scope rows link here); without it
 *  the first summary loads as before. Suspense: useSearchParams in a
 *  prerenderable client page needs a boundary (Next docs). */
export default function ScopePage() {
	return (
		<Suspense fallback={null}>
			<ScopePageWithParam />
		</Suspense>
	);
}

function ScopePageWithParam() {
	const router = useRouter();
	const wantedScope = useSearchParams().get("scope");
	useEffect(() => {
		if (wantedScope) setSelectedId(wantedScope);
	}, [wantedScope]);
	const [summaries, setSummaries] = useState<ScopeSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [scope, setScope] = useState<Scope | null>(null);
	const [view, setView] = useState<ExercisesView | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [sheet, setSheet] = useState<{ topicId: string; markdown: string | null; loading: boolean } | null>(null);
	const [queue, setQueue] = useState<{
		items: Array<{ id: string; kind: string; topicTitle: string; status: string; error?: string; startedAt?: string; endedAt?: string }>;
		pending: number; running: number; done: number; error: number; cancelled: number;
		avgMs: Record<string, number | undefined>; totalEtaMs: number;
	} | null>(null);

	const loadSummaries = useCallback(async () => {
		const res = await fetch("/api/scopes");
		const { scopes } = (await res.json()) as { scopes: ScopeSummary[] };
		setSummaries(scopes);
		setSelectedId((cur) => cur ?? scopes[0]?.id ?? null);
	}, []);

	const loadScope = useCallback(async (id: string) => {
		const [scopeRes, viewRes] = await Promise.all([
			fetch(`/api/scopes/${id}`),
			fetch(`/api/scopes/${id}/exercises`),
		]);
		setScope(scopeRes.ok ? ((await scopeRes.json()) as Scope) : null);
		setView(viewRes.ok ? ((await viewRes.json()) as ExercisesView) : null);
	}, []);

	useEffect(() => {
		void loadSummaries();
	}, [loadSummaries]);

	useEffect(() => {
		if (selectedId) void loadScope(selectedId);
		else { setScope(null); setView(null); }
	}, [selectedId, loadScope]);

	const loadQueue = useCallback(async (id: string) => {
		const res = await fetch(`/api/scopes/${id}/queue`);
		setQueue(res.ok ? await res.json() : null);
	}, []);

	useEffect(() => {
		if (selectedId) void loadQueue(selectedId);
	}, [selectedId, loadQueue]);

	// While the worker runs: poll progress + refresh the artifacts landing.
	useEffect(() => {
		if (!selectedId || !queue || queue.pending + queue.running === 0) return;
		const t = setInterval(() => {
			void loadQueue(selectedId);
			void loadScope(selectedId);
		}, 3000);
		return () => clearInterval(t);
	}, [selectedId, queue, loadQueue, loadScope]);

	const enqueue = async (kind: "cheatsheet" | "exercises") => {
		if (!selectedId) return;
		const res = await fetch(`/api/scopes/${selectedId}/queue`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind }),
		});
		const out = (await res.json()) as { added?: number; error?: string };
		setNote(out.error ?? (out.added === 0 ? `Nothing to queue — every leaf already has its ${kind === "cheatsheet" ? "cheatsheet" : "exercise batch"}` : `Queued ${out.added} ${kind === "cheatsheet" ? "cheatsheets" : "exercise batches"}`));
		await loadQueue(selectedId);
	};

	const cancelQueueRun = async () => {
		if (!selectedId) return;
		await fetch(`/api/scopes/${selectedId}/queue/cancel`, { method: "POST" });
		await loadQueue(selectedId);
	};

	const cancelOne = async (itemId: string) => {
		if (!selectedId) return;
		await fetch(`/api/scopes/${selectedId}/queue/cancel`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ itemId }),
		});
		await loadQueue(selectedId);
	};

	const putScope = async (next: Scope) => {
		setScope(next); // optimistic
		const res = await fetch(`/api/scopes/${next.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!res.ok) {
			setNote("Save failed — refetching");
			await loadScope(next.id);
		}
	};

	const onImportance = (topicId: string, objectiveId: string, tier: Importance) => {
		if (!scope) return;
		const walk = (topics: Scope["roots"]): Scope["roots"] =>
			topics.map((t) =>
				t.id === topicId
					? { ...t, importance: { ...t.importance, [objectiveId]: tier } }
					: { ...t, children: walk(t.children) },
			);
		void putScope({ ...scope, roots: walk(scope.roots), updatedAt: new Date().toISOString() });
	};

	const openCheatsheet = async (topicId: string) => {
		setSheet({ topicId, markdown: null, loading: true });
		const res = await fetch(`/api/scopes/${selectedId}/cheatsheets/${topicId}`);
		setSheet({
			topicId,
			markdown: res.ok ? ((await res.json()) as { markdown: string }).markdown : null,
			loading: false,
		});
	};

	const generateCheatsheet = async (topicId: string) => {
		if (!selectedId) return;
		setSheet({ topicId, markdown: null, loading: true });
		const res = await fetch(`/api/scopes/${selectedId}/cheatsheets/${topicId}/generate`, { method: "POST" });
		setSheet({ topicId, markdown: null, loading: !res.ok ? false : true });
		if (res.ok) {
			// The job runs in the background; poll the file until it lands (lean v1).
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				const check = await fetch(`/api/scopes/${selectedId}/cheatsheets/${topicId}`);
				if (check.ok) {
					setSheet({ topicId, markdown: ((await check.json()) as { markdown: string }).markdown, loading: false });
					return;
				}
			}
		}
		setSheet({ topicId, markdown: null, loading: false });
		setNote("Cheatsheet generation did not finish — try again");
	};

	const generateExercises = async (topicId: string) => {
		if (!selectedId) return;
		const res = await fetch(`/api/scopes/${selectedId}/exercises/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ topicIds: [topicId] }),
		});
		setNote(res.ok ? "Generating exercises — the batch lands straight in the grind pool" : "Exercise generation failed (no model configured?)");
	};

	return (
		<div className="flex h-dvh">
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center gap-2 px-3 py-2">
					<SidebarToggle />
					<h1 className="font-serif text-lg text-foreground">Scopes</h1>
					{summaries.length > 0 && (
						<select
							aria-label="scope"
							value={selectedId ?? ""}
							onChange={(e) => setSelectedId(e.target.value)}
							className="ml-2 rounded-md border border-border bg-card px-2 py-1 font-ui text-sm text-foreground"
						>
							{summaries.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name} ({s.leafCount} leaves)
								</option>
							))}
						</select>
					)}
					<div className="ml-auto flex items-center gap-2">
						{scope && (
							<>
								<button
									type="button"
									onClick={() => router.push(`/chat/new?mode=scope&scope=${scope.id}`)}
										className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
									>
										Edit with AI
									</button>
								<button
									type="button"
									onClick={() => void enqueue("cheatsheet")}
										className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
										title="Queue a cheatsheet for every sheetless leaf (importance order)"
									>
										Generate cheatsheets
									</button>
								<button
									type="button"
									onClick={() => void enqueue("exercises")}
										className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
										title="Queue an exercise batch for every batchless leaf (importance order)"
									>
										Generate exercises
									</button>
								<button
									type="button"
										onClick={() => router.push(`/grind/${scope.id}`)}
											className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
										>
											Open grind
										</button>
										<button
											type="button"
											onClick={() => router.push(`/chat/new?mode=class&scope=${scope.id}`)}
												className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
												title="A Class walks this scope leaf by leaf — cheatsheet material, pool exercises (ADR 0003)"
											>
												Take a Class
											</button>
							</>
						)}
					</div>
				</header>

				{queue && queue.items.length > 0 && (
					<div className="mx-4 mb-1 rounded-md border border-border bg-card font-ui text-xs">
						<div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-muted-foreground">
							<span className="font-medium text-foreground">Generation queue</span>
							<span>
								{queue.running > 0 ? "⚡ generating" : queue.pending > 0 ? "waiting" : "settled"}
								{" · "}{queue.done}/{queue.items.length} done
								{queue.totalEtaMs > 0 && ` · ~${fmtMs(queue.totalEtaMs)} left`}
							</span>
							{(queue.pending > 0 || queue.running > 0) && (
								<button type="button" className="ml-auto underline hover:text-foreground" onClick={() => void cancelQueueRun()}>
									Cancel all ({queue.pending + queue.running})
								</button>
							)}
						</div>
						<ul className="max-h-56 overflow-y-auto px-3 py-1.5">
							{queue.items.map((i) => {
								const avg = queue.avgMs[i.kind];
								const elapsed = i.startedAt ? Date.now() - Date.parse(i.startedAt) : 0;
								const duration = i.startedAt && i.endedAt ? Date.parse(i.endedAt) - Date.parse(i.startedAt) : 0;
								return (
									<li key={i.id} className="flex items-center gap-2 py-0.5 text-muted-foreground">
										<span aria-hidden>{i.kind === "cheatsheet" ? "📄" : "🏋"}</span>
										<span className="truncate text-foreground" title={i.topicTitle}>{i.topicTitle}</span>
										<span className="ml-auto shrink-0">
											{i.status === "pending" && (avg !== undefined ? `waiting · ~${fmtMs(avg)}` : "waiting")}
											{i.status === "running" && `${fmtMs(elapsed)} in flight${avg !== undefined ? ` · ~${fmtMs(Math.max(0, avg - elapsed))} left` : ""}`}
											{i.status === "done" && (duration > 0 ? <span className="text-emerald-400/90">done in {fmtMs(duration)}</span> : "done")}
											{i.status === "error" && <span className="text-amber-400/90">✖ {i.error ?? "failed"}</span>}
											{i.status === "cancelled" && "cancelled"}
										</span>
										{(i.status === "pending" || i.status === "running") && (
											<button
												type="button"
												aria-label={`cancel ${i.topicTitle}`}
												title="Cancel this item"
												className="shrink-0 rounded px-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
												onClick={() => void cancelOne(i.id)}
											>
												✕
											</button>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				)}

				{note && (
					<div className="mx-4 mb-1 rounded-md border border-border bg-card px-3 py-1.5 font-ui text-xs text-muted-foreground">
						{note}
						<button type="button" className="ml-2 underline" onClick={() => setNote(null)}>
							dismiss
						</button>
					</div>
				)}

				{!scope ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-4">
						<p className="max-w-md text-center font-ui text-sm text-muted-foreground">
							{summaries.length === 0
								? "No scopes yet. A scope is the weighted topic tree for one domain — built in a guided interview."
								: "Select a scope."}
						</p>
						<button
							type="button"
							onClick={() => router.push("/chat/new?mode=scope")}
							className="rounded-md border border-border bg-card px-2.5 py-1.5 font-ui text-xs text-foreground hover:bg-accent"
						>
							New scope session — interview one into being with the scoper agent →
						</button>
					</div>
				) : (
					<div className="flex min-h-0 flex-1">
						<main className="min-w-0 flex-1 overflow-y-auto px-4 pb-8">
							<div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
								{scope.objectives.map((o) => (
									<span key={o.id} className="font-ui text-xs text-muted-foreground">
										objective: <span className="text-foreground">{o.text}</span>
									</span>
								))}
							</div>
							{scope.roots.map((t) => (
								<TopicNode
									key={t.id}
									topic={t}
									depth={0}
									scope={scope}
											rollups={view?.rollups ?? {}}
											onImportance={onImportance}
											nodeActions={(node) => (
												<button
													type="button"
														aria-label={`take a class on ${node.title}`}
														onClick={() => router.push(`/chat/new?mode=class&scope=${scope.id}&topic=${node.id}`)}
														className="rounded-sm border border-border p-1 text-muted-foreground hover:text-foreground"
														title="Take a Class on this subtree"
													>
														<GraduationCapIcon className="size-3" />
													</button>
											)}
											leafActions={(leaf) => (
										<span className="flex items-center gap-1">
											<button
												type="button"
												aria-label={`cheatsheet for ${leaf.title}`}
												onClick={() => void openCheatsheet(leaf.id)}
												className="rounded-sm border border-border p-1 text-muted-foreground hover:text-foreground"
												title="View / generate cheatsheet"
											>
												<FileTextIcon className="size-3" />
											</button>
											<button
												type="button"
												aria-label={`generate exercises for ${leaf.title}`}
												onClick={() => void generateExercises(leaf.id)}
												className="rounded-sm border border-border p-1 text-muted-foreground hover:text-foreground"
												title="Generate exercise batch"
											>
												<SparklesIcon className="size-3" />
											</button>
										</span>
									)}
								/>
							))}

						</main>

						{sheet && (
							<aside className="w-[36rem] shrink-0 overflow-y-auto border-l border-border bg-card/50 px-4 py-3">
								<div className="mb-2 flex items-center gap-2">
									<span className="font-serif text-sm text-foreground">Cheatsheet</span>
									<button
										type="button"
										onClick={() => setSheet(null)}
										className="ml-auto rounded-sm px-2 py-0.5 font-ui text-xs text-muted-foreground hover:text-foreground"
									>
										close
									</button>
								</div>
								{sheet.loading ? (
									<p className="font-ui text-xs text-muted-foreground">loading…</p>
								) : sheet.markdown === null ? (
									<div className="flex flex-col gap-2">
										<p className="font-ui text-xs text-muted-foreground">
											None yet for this leaf. Cheatsheets also generate automatically when a leaf is taught.
										</p>
										<button
											type="button"
											onClick={() => void generateCheatsheet(sheet.topicId)}
											className="w-fit rounded-md border border-border px-2 py-1 font-ui text-xs text-foreground hover:bg-accent"
										>
											Generate now
										</button>
									</div>
								) : (
									<div className="max-w-none font-sans3 text-sm text-foreground">
										<MessageResponse>{sheet.markdown}</MessageResponse>
									</div>
								)}
							</aside>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
