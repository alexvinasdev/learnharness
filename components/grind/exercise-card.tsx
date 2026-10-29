"use client";

import { useMemo, useState } from "react";
import type { Exercise } from "@/src/core";

/**
 * The six deterministic exercise renderers (zero LLM, exact checks) —
 * shared surface between the grind view (its own pick loop) and the
 * Class chat card (ADR 0003, posed by pose_exercise). Extracted verbatim
 * from grind-view.tsx; grading stays client-deterministic in both homes.
 * `onNext` is optional: the grind view cycles its pool, the Class card
 * passes none (the agent's next turn IS the next step).
 */

export function ExerciseCard({
	exercise,
	answer,
	onResult,
	onNext,
}: {
	exercise: Exercise;
	answer: { ok: boolean } | null;
	onResult: (ok: boolean) => void;
	onNext?: () => void;
}) {
	switch (exercise.type) {
		case "flashcard":
			return <Flashcard ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
		case "cloze":
			return <Cloze ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
		case "ordering":
			return <Ordering ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
		case "matching":
			return <Matching ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
		case "spot_error":
			return <SpotError ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
		case "numeric":
			return <Numeric ex={exercise} answer={answer} onResult={onResult} onNext={onNext} />;
	}
}

function ResultBand({ answer, onNext }: { answer: { ok: boolean } | null; onNext?: () => void }) {
	if (!answer) return null;
	return (
		<div className="mt-4 flex items-center gap-3">
			<span className={`font-ui text-sm font-medium ${answer.ok ? "text-emerald-300" : "text-amber-300"}`}>
				{answer.ok ? "Correct" : "Not quite — one correct clears it"}
			</span>
			{onNext && (
				<button
					type="button"
					onClick={onNext}
					className="ml-auto rounded-md border border-border bg-card px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent"
				>
					Next
				</button>
			)}
		</div>
	);
}

function Flashcard({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "flashcard" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">flashcard</p>
			<p className="mt-2 font-sans3 text-xl text-foreground">{ex.payload.front}</p>
			{revealed ? (
				<p className="mt-3 rounded-lg border border-border/60 bg-background/50 p-3 font-sans3 text-lg text-foreground">{ex.payload.back}</p>
			) : (
				<button
					type="button"
					onClick={() => setRevealed(true)}
					className="mt-4 rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent"
				>
					Show answer
				</button>
			)}
			{revealed && !answer && (
				<div className="mt-4 flex gap-2">
					<button type="button" onClick={() => onResult(true)} className="rounded-md border border-border px-3 py-1.5 font-ui text-sm text-emerald-300 hover:bg-accent">
						I knew it
					</button>
					<button type="button" onClick={() => onResult(false)} className="rounded-md border border-border px-3 py-1.5 font-ui text-sm text-amber-300 hover:bg-accent">
						I didn&apos;t
					</button>
				</div>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}

function Cloze({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "cloze" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const tokens = useMemo(() => {
		const bank: string[] = [];
		for (const b of ex.payload.blanks) bank.push(b.accepted[0]!, ...b.distractors.slice(0, 3));
		return bank.sort(() => Math.random() - 0.5);
	}, [ex]);
	const [fills, setFills] = useState<(string | null)[]>(() => ex.payload.blanks.map(() => null));
	const done = fills.every((f) => f !== null);
	const check = () => {
		const ok = ex.payload.blanks.every((b, i) => b.accepted.includes(fills[i]!.trim()));
		onResult(ok);
	};
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">cloze</p>
			<p className="mt-2 font-sans3 text-lg text-foreground">
				{ex.payload.template.split("___").map((seg, i) => (
					<span key={i}>
						{seg}
						{i < ex.payload.blanks.length && (
							<button
								type="button"
								onClick={() => setFills((prev) => prev.map((f, j) => (j === i ? null : f)))}
								className={`mx-1 inline-block min-w-16 rounded border px-1.5 py-0.5 font-mono text-sm ${fills[i] ? (answer ? (ex.payload.blanks[i]!.accepted.includes(fills[i]!) ? "border-emerald-500/60 text-emerald-300" : "border-amber-500/60 text-amber-300") : "border-border text-foreground") : "border-dashed border-border/70 text-muted-foreground"}`}
							>
								{fills[i] ?? "?"}
							</button>
						)}
					</span>
				))}
			</p>
			<div className="mt-4 flex flex-wrap gap-2">
				{tokens.map((t, i) => (
					<button
						key={`${t}-${i}`}
						type="button"
						disabled={fills.includes(t) || !!answer}
						onClick={() => {
							const at = fills.findIndex((f) => f === null);
							if (at !== -1) setFills((prev) => prev.map((f, j) => (j === at ? t : f)));
						}}
						className="rounded-md border border-border px-2.5 py-1 font-mono text-sm text-foreground hover:bg-accent disabled:opacity-40"
					>
						{t}
					</button>
				))}
			</div>
			{done && !answer && (
				<button type="button" onClick={check} className="mt-4 rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent">
					Check
				</button>
			)}
			{answer && !answer.ok && (
				<p className="mt-3 font-ui text-xs text-muted-foreground">
					Answers: {ex.payload.blanks.map((b) => b.accepted[0]).join(" · ")}
				</p>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}

function Ordering({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "ordering" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const shuffled = useMemo(() => [...ex.payload.items].sort(() => Math.random() - 0.5), [ex]);
	const [placed, setPlaced] = useState<string[]>([]);
	const remaining = shuffled.filter((t) => !placed.includes(t));
	const check = () => onResult(placed.join("\u0000") === ex.payload.items.join("\u0000"));
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">ordering</p>
			<ol className="mt-3 flex flex-col gap-1">
				{placed.map((t, i) => (
					<li key={t} className={`rounded-md border px-3 py-1.5 font-sans3 text-sm ${answer ? (ex.payload.items[i] === t ? "border-emerald-500/60 text-emerald-300" : "border-amber-500/60 text-amber-300") : "border-border text-foreground"}`}>
						{i + 1}. {t}
					</li>
				))}
			</ol>
			<div className="mt-3 flex flex-wrap gap-2">
				{remaining.map((t) => (
					<button
						key={t}
						type="button"
						disabled={!!answer}
						onClick={() => setPlaced((prev) => [...prev, t])}
						className="rounded-md border border-border px-2.5 py-1 font-sans3 text-sm text-foreground hover:bg-accent disabled:opacity-40"
					>
						{t}
					</button>
				))}
			</div>
			{placed.length > 0 && !answer && (
				<div className="mt-4 flex gap-2">
					<button type="button" onClick={check} className="rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent">
						Check
					</button>
					<button type="button" onClick={() => setPlaced([])} className="rounded-md border border-border px-3 py-1.5 font-ui text-xs text-muted-foreground hover:text-foreground">
						Reset
					</button>
				</div>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}

function Matching({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "matching" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const rights = useMemo(() => ex.payload.pairs.map((p) => p.right).sort(() => Math.random() - 0.5), [ex]);
	const [picks, setPicks] = useState<Record<string, string>>({});
	const allPicked = ex.payload.pairs.every((p) => picks[p.left]);
	const check = () => onResult(ex.payload.pairs.every((p) => picks[p.left] === p.right));
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">matching</p>
			<div className="mt-3 flex flex-col gap-2">
				{ex.payload.pairs.map((p) => (
					<div key={p.left} className="flex items-center gap-3">
						<span className="min-w-0 flex-1 truncate font-sans3 text-sm text-foreground">{p.left}</span>
						<select
							aria-label={`match for ${p.left}`}
							disabled={!!answer}
							value={picks[p.left] ?? ""}
							onChange={(ev) => setPicks((prev) => ({ ...prev, [p.left]: ev.target.value }))}
							className={`rounded-md border bg-card px-2 py-1 font-ui text-sm ${answer ? (picks[p.left] === p.right ? "border-emerald-500/60 text-emerald-300" : "border-amber-500/60 text-amber-300") : "border-border text-foreground"}`}
						>
							<option value="" disabled>
								— pick —
							</option>
							{rights.map((r) => (
								<option key={r} value={r}>
									{r}
								</option>
							))}
						</select>
					</div>
				))}
			</div>
			{allPicked && !answer && (
				<button type="button" onClick={check} className="mt-4 rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent">
					Check
				</button>
			)}
			{answer && !answer.ok && (
				<p className="mt-3 font-ui text-xs text-muted-foreground">
					{ex.payload.pairs.map((p) => `${p.left} → ${p.right}`).join(" · ")}
				</p>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}

function SpotError({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "spot_error" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const sentences = useMemo(
		() => ex.payload.artifact.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0),
		[ex],
	);
	const wrongIdx = useMemo(
		() => new Set(sentences.map((s, i) => (ex.payload.errors.some((e) => s.includes(e.span)) ? i : -1)).filter((i) => i >= 0)),
		[ex, sentences],
	);
	const [picked, setPicked] = useState<Set<number>>(new Set());
	const check = () => {
		const ok = sentences.every((_, i) => picked.has(i) === wrongIdx.has(i));
		onResult(ok);
	};
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">spot the error — click the wrong sentences</p>
			<div className="mt-3 flex flex-col gap-1">
				{sentences.map((s, i) => (
					<button
						key={i}
						type="button"
						disabled={!!answer}
						onClick={() => setPicked((prev) => new Set(prev.has(i) ? [...prev].filter((x) => x !== i) : [...prev, i]))}
						className={`rounded-md px-2 py-1 text-left font-sans3 text-sm ${picked.has(i) ? (answer ? (wrongIdx.has(i) ? "text-emerald-300" : "text-amber-300") : "bg-accent text-foreground") : answer && wrongIdx.has(i) ? "text-amber-300" : "text-foreground"} hover:bg-accent/60`}
					>
						{s}
					</button>
				))}
			</div>
			{picked.size > 0 && !answer && (
				<button type="button" onClick={check} className="mt-4 rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent">
					Check
				</button>
			)}
			{answer && !answer.ok && (
				<p className="mt-3 font-ui text-xs text-muted-foreground">
					Wrong parts: {ex.payload.errors.map((e) => `${e.span} → ${e.acceptedFixes[0]}`).join(" · ")}
				</p>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}

function Numeric({ ex, answer, onResult, onNext }: { ex: Extract<Exercise, { type: "numeric" }>; answer: { ok: boolean } | null; onResult: (ok: boolean) => void; onNext?: () => void }) {
	const [value, setValue] = useState("");
	const check = () => {
		const v = Number(value.replace(",", "."));
		const a = ex.payload.answers[0]!;
		onResult(Number.isFinite(v) && Math.abs(v - a.value) <= (a.tolerance ?? 0));
	};
	return (
		<div className="rounded-xl border border-border bg-card p-6">
			<p className="font-ui text-xs uppercase tracking-wide text-muted-foreground">numeric</p>
			<p className="mt-2 font-sans3 text-lg text-foreground">{ex.payload.prompt}</p>
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				disabled={!!answer}
				placeholder={`value${ex.payload.answers[0]!.unit ? ` (${ex.payload.answers[0]!.unit})` : ""}`}
				className="mt-3 w-48 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-sm text-foreground"
				onKeyDown={(e) => {
					if (e.key === "Enter" && value && !answer) check();
				}}
			/>
			{value && !answer && (
				<button type="button" onClick={check} className="ml-3 rounded-md border border-border px-3 py-1.5 font-ui text-sm text-foreground hover:bg-accent">
					Check
				</button>
			)}
			{answer && !answer.ok && (
				<p className="mt-3 font-mono text-xs text-muted-foreground">
					{ex.payload.answers.map((a) => `${a.value}${a.tolerance ? ` ± ${a.tolerance}` : ""}${a.unit ? ` ${a.unit}` : ""}`).join(" · ")}
				</p>
			)}
			<ResultBand answer={answer} onNext={onNext} />
		</div>
	);
}
