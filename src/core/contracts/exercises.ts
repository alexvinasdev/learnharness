/**
 * Exercise contracts — deterministic pre-generated practice + the grind log
 *
 * The fork's grind system (grilling 2026-01-26): exercises are generated in
 * batches by background jobs, reviewed by the user, then served by a
 * NON-chat grind view with ZERO AI in the loop — grading is data-only at
 * attempt time. Universality rule: types assume NO domain (not even
 * languages). Six types, deliberately: flashcard, cloze, ordering, matching
 * (subsumes classification — 1:1 pairs and N→1 buckets are the same data),
 * spot-the-error, numeric. Free production is EXCLUDED (needs AI grading —
 * non-deterministic; generative practice sessions already cover it).
 *
 * Grind doctrine (owner, 2026-01-26): attempts are an APPEND-ONLY log; every
 * derived notion (learned, rusty, fail %, rollups) computes from it and is
 * never stored — same discipline as the graph's "store events, derive
 * state". Nothing is ever auto-deleted: excluding an exercise (bury) keeps
 * it and its history (the orphan doctrine, CONTEXT.md).
 *
 * Store format (src/store/scope.ts): data/scopes/<scopeId>/exercises.json
 * (exercises + batches, read-modify-write) and grind.jsonl (one Attempt per
 * line, append-only — the log never rewrites history).
 */

// ─── Types and payloads ──────────────────────────────────────────────────────

export type ExerciseType = "flashcard" | "cloze" | "ordering" | "matching" | "spot_error" | "numeric";

/** Recall one direction only (owner, 2026-01-26): "perro → dog" and
 *  "dog → perro" are TWO exercises — failing to recognize must not
 *  contaminate what you can produce. The generator emits both directions
 *  when both matter. */
export interface FlashcardPayload {
	front: string;
	back: string;
}

/** One blank of a cloze: accepted answers (variants — casing matters,
 *  German nouns are capitalised; matched exactly after trimming) plus a
 *  distractor bank for word-bank rendering. Distractors live IN the data —
 *  the UI never invents options at runtime. */
export interface ClozeBlank {
	accepted: string[];
	distractors: string[];
}

/** Fill blanks in context. The template carries N blanks as literal
 *  "___" tokens; blanks[i] belongs to the (i+1)-th token. Grading is
 *  binary over the whole exercise: every blank correct or it failed
 *  (grind standard — you know it or you don't). */
export interface ClozePayload {
	template: string;
	blanks: ClozeBlank[];
}

/** Reorder shuffled items into the correct order. Universal: word order
 *  (languages), process steps, timelines, proof stages. `items` IS the
 *  correct order; the UI shuffles for presentation. */
export interface OrderingPayload {
	items: string[];
}

/** Match or classify. Pairs are (left → right); 1:1 matching has unique
 *  rights, N→1 classification (buckets) repeats the right side. Same
 *  data, different renderer — one type by design. */
export interface MatchingPair {
	left: string;
	right: string;
}
export interface MatchingPayload {
	pairs: MatchingPair[];
}

/** Find (and fix) the error in a flawed artifact — a wrong sentence, a
 *  wrong line of code, a wrong formula. The error is located by its exact
 *  `span` (substring of `artifact`; UI makes spans clickable); fixing is
 *  validated against `acceptedFixes` (typed, exact after trim). Grading:
 *  all errors located = correct; a fix attempt is part of the same binary
 *  outcome. */
export interface SpotErrorPayload {
	artifact: string;
	errors: Array<{ span: string; acceptedFixes: string[] }>;
}

/** Numeric answer with tolerance and optional unit — physics, economics,
 *  quantities. Accepted values are alternatives (any one passes). */
export interface NumericPayload {
	prompt: string;
	answers: Array<{ value: number; tolerance?: number; unit?: string }>;
}

/** One exercise — a discriminated union on `type`. Stable ids: grind
 *  history anchors to them forever (replacing a batch mints NEW ids; the
 *  old exercises and their logs are kept). */
export type Exercise = {
	/** "ex_" + nanoid-like (store-assigned). */
	id: string;
	/** The scope LEAF this exercise belongs to (importance filters and
	 *  rollups resolve through it). Pruning the topic orphans the exercise
	 *  — flagged, never deleted. */
	topicId: string;
	/** The generating batch (review provenance). */
	batchId: string;
} & (
	| { type: "flashcard"; payload: FlashcardPayload }
	| { type: "cloze"; payload: ClozePayload }
	| { type: "ordering"; payload: OrderingPayload }
	| { type: "matching"; payload: MatchingPayload }
	| { type: "spot_error"; payload: SpotErrorPayload }
	| { type: "numeric"; payload: NumericPayload }
) & {
	/** Set by the user only: excluded from selection and rollups, kept
	 *  with full history (the bury doctrine). Absent = active. */
	buried?: boolean;
};

// ─── Batches and the grind log ───────────────────────────────────────────────

/** One generation batch: exercises land STRAIGHT in the pool (owner,
 *  auto-accept — the pending/review-queue gate was retired). `pending`
 *  survives only in pre-retirement files; the store normalizes it to
 *  `accepted` on read. Bury is the only per-exercise curation. */
export interface ExerciseBatch {
	/** "batch_" + nanoid-like (store-assigned). */
	id: string;
	/** The leaves this batch was generated for. */
	topicIds: string[];
	status: "pending" | "accepted";
	createdAt: string;
}

/** One attempt — one line of grind.jsonl. Binary by design: an exercise
 *  with parts (cloze blanks, matching pairs) is correct only when fully
 *  correct. */
export interface Attempt {
	/** The exercised id ("ex_…"). */
	exerciseId: string;
	/** ISO timestamp. */
	at: string;
	ok: boolean;
}

// ─── Derivation constants (tunable, one place each) ─────────────────────────

/** Learned = last LEARNED_STREAK attempts all correct (the streak gate —
 *  lifetime fail % never blocks it). */
export const LEARNED_STREAK = 3;

/** Rusty = learned and unattempted for more than RUSTY_DAYS days — a
 *  priority flag, NEVER a schedule (no calendars anywhere in the fork). */
export const RUSTY_DAYS = 21;

/** The recent window for the displayed fail % (alongside the lifetime one). */
export const RECENT_WINDOW = 10;
