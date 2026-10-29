/**
 * ScopeStore — the fs adapter (one directory per scope in data/scopes/).
 *
 * Implements core/ports.ts ScopeStore; shapes live in
 * core/contracts/{scope,exercises}.ts. Idioms follow src/store/chats.ts:
 * sync fs, id-guarded filenames, tab-indented JSON, lazy version stamps
 * with honest refusal on newer. The grind log is APPEND-ONLY JSONL (store
 * events, derive state). Wired in the composition root (src/server/stores.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ScopeStore } from "../core/ports.ts";
import type { Attempt, Exercise, ExerciseBatch } from "../core/contracts.ts";
import {
	CURRENT_SCOPE_VERSION,
	isLeaf,
	walkTopics,
	type Scope,
	type ScopeSummary,
} from "../core/contracts/scope.ts";

// ─── Id minting (the store is the id authority, like createChat) ─────────────

const suffix = () => `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
export const newScopeId = () => `scope_${suffix()}`;
export const newObjectiveId = () => `obj_${suffix()}`;
export const newTopicId = () => `t_${suffix()}`;
export const newBatchId = () => `batch_${suffix()}`;
export const newExerciseId = () => `ex_${suffix()}`;

// ─── Paths (id-guarded — a hostile id must never escape the directory) ──────

function scopeDir(id: string): string {
	if (!/^scope_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid scope id: ${id}`);
	return path.join(PATHS.scopes, id);
}
function scopeFile(id: string): string {
	return path.join(scopeDir(id), "scope.json");
}
function exercisesFile(id: string): string {
	return path.join(scopeDir(id), "exercises.json");
}
function grindFile(id: string): string {
	return path.join(scopeDir(id), "grind.jsonl");
}
function cheatsheetFile(scopeId: string, topicId: string): string {
	if (!/^t_[A-Za-z0-9_-]+$/.test(topicId)) throw new Error(`Invalid topic id: ${topicId}`);
	return path.join(scopeDir(scopeId), "cheatsheets", `${topicId}.md`);
}

// ─── Scope.json (read-modify-write like a chat record) ───────────────────────

function writeScope(scope: Scope): void {
	fs.mkdirSync(scopeDir(scope.id), { recursive: true });
	fs.writeFileSync(
		scopeFile(scope.id),
		JSON.stringify({ ...scope, version: CURRENT_SCOPE_VERSION }, null, "\t"),
		"utf-8",
	);
}

function createScope(name: string): Scope {
	const now = new Date().toISOString();
	const scope: Scope = {
		id: newScopeId(),
		name: name.trim() || "Untitled scope",
		objectives: [],
		roots: [],
		createdAt: now,
		updatedAt: now,
	};
	writeScope(scope);
	emit("scopes-changed", {});
	return { ...scope, version: CURRENT_SCOPE_VERSION };
}

function getScope(id: string): Scope | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(scopeFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (the chats' downgrade law): a newer-stamped scope reads
	// as absent — the next read-modify-write must not rewrite it.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_SCOPE_VERSION) {
		console.error(`[scope ${id}] schema version ${v} > ${CURRENT_SCOPE_VERSION} — this build is older; refusing to read`);
		return null;
	}
	return parsed as Scope;
}

function listScopes(): ScopeSummary[] {
	try {
		fs.mkdirSync(PATHS.scopes, { recursive: true });
		return fs
			.readdirSync(PATHS.scopes)
			.filter((f) => f.startsWith("scope_"))
			.map((f) => getScope(f))
			.filter((s): s is Scope => s !== null)
			.map((s) => {
				const topics = walkTopics(s.roots);
				return {
					id: s.id,
					name: s.name,
					updatedAt: s.updatedAt,
					objectiveCount: s.objectives.length,
					topicCount: topics.length,
					leafCount: topics.filter(isLeaf).length,
				};
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

function saveScope(scope: Scope): void {
	// The write choke point's law: save always stamps + bumps. updatedAt
	// moves on every save — scope edits ARE the artifact's activity (unlike
	// a chat rename, there is no transcript of its own to order by).
	writeScope({ ...scope, updatedAt: new Date().toISOString() });
	emit("scopes-changed", {});
}

function deleteScope(id: string): boolean {
	try {
		fs.rmSync(scopeDir(id), { recursive: true, force: true });
		emit("scopes-changed", {});
		return true;
	} catch {
		return false;
	}
}

// ─── exercises.json ({version, exercises, batches}, read-modify-write) ───────

interface ExercisesFile {
	version: number;
	exercises: Exercise[];
	batches: ExerciseBatch[];
}

function readExercisesFile(scopeId: string): ExercisesFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(exercisesFile(scopeId), "utf-8"));
	} catch {
		return null;
	}
	const f = parsed as Partial<ExercisesFile>;
	if (!Array.isArray(f.exercises) || !Array.isArray(f.batches)) return null;
	// The review gate is gone (owner, auto-accept): a legacy "pending"
	// batch on disk reads as accepted — the pool it was always meant for.
	const batches = f.batches.map((b) => (b.status === "pending" ? { ...b, status: "accepted" as const } : b));
	return { version: f.version ?? 1, exercises: f.exercises, batches };
}

function writeExercisesFile(scopeId: string, file: ExercisesFile): void {
	fs.mkdirSync(scopeDir(scopeId), { recursive: true });
	fs.writeFileSync(exercisesFile(scopeId), JSON.stringify({ ...file, version: 1 }, null, "\t"), "utf-8");
}

function mutateExercises(scopeId: string, fn: (file: ExercisesFile) => boolean): boolean {
	const file = readExercisesFile(scopeId) ?? { version: 1, exercises: [], batches: [] };
	if (!fn(file)) return false;
	writeExercisesFile(scopeId, file);
	return true;
}

function appendBatch(scopeId: string, batch: ExerciseBatch, exercises: Exercise[]): void {
	mutateExercises(scopeId, (file) => {
		file.batches = [...file.batches, batch];
		file.exercises = [...file.exercises, ...exercises];
		return true;
	});
}

function getExercises(scopeId: string): { exercises: Exercise[]; batches: ExerciseBatch[] } | null {
	const file = readExercisesFile(scopeId);
	if (!file) return null;
	return { exercises: file.exercises, batches: file.batches };
}

function setBuried(scopeId: string, exerciseId: string, buried: boolean): boolean {
	return mutateExercises(scopeId, (file) => {
		const exercise = file.exercises.find((e) => e.id === exerciseId);
		if (!exercise) return false;
		if (buried) exercise.buried = true;
		else delete exercise.buried;
		return true;
	});
}

// ─── grind.jsonl (append-only — one Attempt per line, never rewritten) ──────

function appendAttempt(scopeId: string, attempt: Attempt): void {
	fs.mkdirSync(scopeDir(scopeId), { recursive: true });
	fs.appendFileSync(grindFile(scopeId), JSON.stringify(attempt) + "\n", "utf-8");
}

function readAttempts(scopeId: string): Attempt[] {
	try {
		return fs
			.readFileSync(grindFile(scopeId), "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Attempt);
	} catch {
		return [];
	}
}

// ─── cheatsheets/<topicId>.md (regenerable files, one per leaf) ─────────────

function readCheatsheet(scopeId: string, topicId: string): string | null {
	try {
		return fs.readFileSync(cheatsheetFile(scopeId, topicId), "utf-8");
	} catch {
		return null;
	}
}

function writeCheatsheet(scopeId: string, topicId: string, markdown: string): void {
	fs.mkdirSync(path.dirname(cheatsheetFile(scopeId, topicId)), { recursive: true });
	fs.writeFileSync(cheatsheetFile(scopeId, topicId), markdown, "utf-8");
}

export const scopeStore: ScopeStore = {
	createScope,
	getScope,
	listScopes,
	saveScope,
	deleteScope,
	appendBatch,
	getExercises,
	setBuried,
	appendAttempt,
	readAttempts,
	readCheatsheet,
	writeCheatsheet,
};
