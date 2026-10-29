/**
 * Exercise generation (fork 2026-01-26, plan v2 W6 — CONTEXT.md
 * "Exercise"): one-shot model call per batch (the cheatsheet precedent —
 * file/scope-attached artifacts never ride the chat JobKind machinery).
 * The model emits JSON drafts; NOTHING lands without shape validation
 * (validateDraft — the trust boundary), then landBatch stamps ids and
 * lands the batch STRAIGHT in the pool (auto-accept). Deterministic payload
 * by construction: accepted answers + distractor banks live IN the data,
 * so the grind never needs a model at attempt time.
 */

import { runSubagent } from "../agent/subagents/pi-run.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import type { ExerciseType } from "../core/contracts/exercises.ts";
import type { Scope, ScopeTopic } from "../core/contracts/scope.ts";
import { getScope, landBatch, readCheatsheet, type ExerciseDraft } from "./scopes.ts";
import { stores } from "./stores.ts";

const GENERATOR_SYSTEM_PROMPT = `You generate practice exercises as JSON. The output is parsed by a program: return ONE JSON array and NOTHING else — no prose, no markdown fence, no trailing commentary.
Each element is one exercise: {"type": ..., "topicId": "<exact id copied from the topic header>", "payload": {...}}. The six types and their payload shapes:
- flashcard: {"front": string, "back": string} — one atomic fact, front prompts the recall, back is the answer.
- cloze: {"template": string with "___" per blank, "blanks": [{"accepted": [string, ...], "distractors": [string, ...]}]} — accepted answers are exact-after-trim, case-sensitive; distractors populate the word bank.
- ordering: {"items": [string, ...]} — the items IN THE CORRECT ORDER; the UI shuffles.
- matching: {"pairs": [{"left": string, "right": string}, ...]} — 1:1 matching.
- spot_error: {"artifact": string, "errors": [{"span": string (the WRONG text verbatim as it appears), "acceptedFixes": [string, ...]}]} — artifact contains the planted errors.
- numeric: {"prompt": string, "answers": [{"value": number, "tolerance": number, "unit": string}]} — tolerance default 0, unit optional.
Rules: every exercise answerable WITHOUT ambiguity; distractors believable, never joke options; mix types; the language of the topic material; difficulty aimed at retention, not trickery. Every element MUST carry its topicId verbatim from the topic header above.`;

export interface GenerateExercisesInput {
	/** The leaf/subtree topics the batch serves. */
	topicIds: string[];
	/** How many exercises to draft (default 8). */
	count?: number;
}

export interface CheatsheetDeps2 {
	/** Tests inject a scripted engine; production resolves the researcher
	 *  tier (the one-shot precedent). */
	engine?: PiEngine;
}

/** Build the one-shot prompt for a batch: topic + its cheatsheet (the
 *  primary source when present) + linked-proposition weave. */
export function generationPrompt(scope: Scope, topics: ScopeTopic[], count: number, cheatsheets: Record<string, string | null>): string {
	const parts: string[] = [];
	if (scope.objectives.length > 0) {
		parts.push(`The learner's objectives: ${scope.objectives.map((o) => o.text).join("; ")}.`);
	}
	for (const t of topics) {
		parts.push(`## Topic: ${t.title}${t.summary ? ` — ${t.summary}` : ""} (id: ${t.id})`);
		const sheet = cheatsheets[t.id];
		if (sheet) parts.push(`Source material (the topic's cheatsheet — derive the exercises from it):\n${sheet.slice(0, 6000)}`);
	}
	parts.push(`Generate exactly ${count} exercises across these topics (spread sensibly; one exercise per element).`);
	return parts.join("\n\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
function strArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

/** The trust boundary: validate ONE model-emitted draft or reject it with
 *  a reason. Per-type shape checks; no partial landings. */
export function validateDraft(raw: unknown, knownTopics: ReadonlySet<string>): { draft: ExerciseDraft } | { problem: string } {
	if (!isRecord(raw)) return { problem: "not an object" };
	const { type, payload, topicId } = raw as { type?: unknown; payload?: unknown; topicId?: unknown };
	if (typeof topicId !== "string" || !knownTopics.has(topicId)) return { problem: `unknown topicId ${String(topicId)}` };
	if (!isRecord(payload)) return { problem: "payload not an object" };
	const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
	switch (type) {
		case "flashcard":
			if (!nonEmpty(payload.front) || !nonEmpty(payload.back)) return { problem: "flashcard needs front/back" };
			break;
		case "cloze": {
			if (typeof payload.template !== "string" || !Array.isArray(payload.blanks) || payload.blanks.length === 0) {
				return { problem: "cloze needs template + blanks" };
			}
			if ((payload.template.match(/___/g) ?? []).length !== payload.blanks.length) {
				return { problem: "cloze blank count ≠ ___ tokens" };
			}
			for (const b of payload.blanks) {
				if (!isRecord(b) || !strArray(b.accepted) || !strArray(b.distractors)) return { problem: "cloze blank needs accepted[] + distractors[]" };
			}
			break;
		}
		case "ordering":
			if (!strArray(payload.items) || payload.items.length < 3) return { problem: "ordering needs ≥3 items" };
			break;
		case "matching": {
			if (!Array.isArray(payload.pairs) || payload.pairs.length < 3) return { problem: "matching needs ≥3 pairs" };
			for (const p of payload.pairs) {
				if (!isRecord(p) || !nonEmpty(p.left) || !nonEmpty(p.right)) return { problem: "matching pair needs left/right" };
			}
			break;
		}
		case "spot_error": {
			if (!nonEmpty(payload.artifact) || !Array.isArray(payload.errors) || payload.errors.length === 0) {
				return { problem: "spot_error needs artifact + errors" };
			}
			for (const e of payload.errors) {
				if (!isRecord(e) || !nonEmpty(e.span) || !strArray(e.acceptedFixes)) return { problem: "spot_error error needs span + acceptedFixes" };
				if (!String(payload.artifact).includes(String(e.span))) return { problem: "spot_error span not found in artifact" };
			}
			break;
		}
		case "numeric": {
			if (!nonEmpty(payload.prompt) || !Array.isArray(payload.answers) || payload.answers.length === 0) {
				return { problem: "numeric needs prompt + answers" };
			}
			for (const a of payload.answers) {
				if (!isRecord(a) || typeof a.value !== "number" || !Number.isFinite(a.value)) return { problem: "numeric answer needs a finite value" };
				if (a.tolerance !== undefined && (typeof a.tolerance !== "number" || a.tolerance < 0)) return { problem: "tolerance must be ≥ 0" };
			}
			break;
		}
		default:
			return { problem: `unknown type ${String(type)}` };
	}
	// SAFETY: the switch above validated THIS type's payload field-by-field;
	// the double-cast only reconciles the Record<string, unknown> shape with
	// the discriminated union the checks proved.
	return { draft: { type: type as ExerciseType, topicId, payload } as unknown as ExerciseDraft };
}

/** Parse the model's raw text into validated drafts: an array literal is
 *  extracted (the model sometimes wraps in a fence despite the contract),
 *  every element validated, invalid elements REJECTED individually — the
 *  batch lands with whatever survived, and the return reports the drop. */
export function parseDrafts(text: string, knownTopics: ReadonlySet<string>, defaultTopicId?: string): { drafts: ExerciseDraft[]; rejected: string[] } {
	const source = text.trim();
	const start = source.indexOf("[");
	const end = source.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) return { drafts: [], rejected: ["no JSON array found"] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(source.slice(start, end + 1));
	} catch {
		return { drafts: [], rejected: ["JSON parse failed"] };
	}
	if (!Array.isArray(parsed)) return { drafts: [], rejected: ["top level not an array"] };
	const drafts: ExerciseDraft[] = [];
	const rejected: string[] = [];
	parsed.forEach((el, i) => {
		// Single-topic batches (the per-leaf button's dominant case): a
		// model that omits topicId is unambiguous — fill it rather than
		// reject; multi-topic batches stay strict.
		const candidate =
			defaultTopicId !== undefined && isRecord(el) && el.topicId === undefined
			? { ...el, topicId: defaultTopicId }
			: el;
		const res = validateDraft(candidate, knownTopics);
		if ("draft" in res) drafts.push(res.draft);
		else rejected.push(`#${i}: ${res.problem}`);
	});
	return { drafts, rejected };
}

/** Generate one batch (pooled — auto-accept) for the topics. Returns the batchId. */
export async function generateExercises(scopeId: string, input: GenerateExercisesInput, deps: CheatsheetDeps2 = {}): Promise<{ batchId: string; rejected: string[] }> {
	const scope = getScope(scopeId);
	if (!scope) throw new Error(`Unknown scope: ${scopeId}`);
	const known = new Set<string>();
	const topics: ScopeTopic[] = [];
	const walk = (list: ScopeTopic[]) => {
		for (const t of list) {
			known.add(t.id);
			if (input.topicIds.includes(t.id)) topics.push(t);
			walk(t.children);
		}
	};
	walk(scope.roots);
	for (const id of input.topicIds) {
		if (!known.has(id)) throw new Error(`Unknown topic: ${id}`);
	}
	const count = Math.min(Math.max(input.count ?? 8, 1), 20);
	const cheatsheets: Record<string, string | null> = {};
	for (const t of topics) cheatsheets[t.id] = readCheatsheet(scopeId, t.id);
	const engine =
		deps.engine ??
		(() => {
			const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
			if (!spec) throw new Error("No model configured for the researcher slot — set your model slots (settings → models)");
			return piEngineForSpec(spec);
		})();
	const { text } = await runSubagent([], {
		role: "researcher",
		prompt: generationPrompt(scope, topics, count, cheatsheets),
		engine,
		systemPrompt: GENERATOR_SYSTEM_PROMPT,
		maxTurns: 1,
	});
	const { drafts, rejected } = parseDrafts(text, known, input.topicIds.length === 1 ? input.topicIds[0] : undefined);
	if (drafts.length === 0) throw new Error(`No valid exercises in the model output (${rejected.join("; ")})`);
	const batchId = landBatch(scopeId, input.topicIds, drafts);
	return { batchId, rejected };
}
