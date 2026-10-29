"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { Importance, Scope, ScopeTopic } from "@/src/core";

/**
 * The scope tree (fork 2026-01-26, plan v2 W2): states, per-objective
 * importance (manual edit — CONTEXT.md "Scope is freely editable"), leaf
 * rollups, and the leaf actions. Pure presentation except the importance
 * select, whose change climbs to the page's single write seam (PUT the
 * whole scope — replace-whole, the API's law).
 */

const TIER_ORDER: Importance[] = ["essential", "high", "medium", "low", "excluded"];

/** Interior aggregation (fork simplification 2026-02): an interior topic's
 *  coverage is the SUM of its descendant leaves' rollups — the derived
 *  Topic State (states are dead; the grind is the only evidence). */
function subtreeRollup(topic: ScopeTopic, rollups: LeafRollups): { learned: number; total: number } | null {
	let learned = 0, total = 0, seen = false;
	const stack = [topic];
	while (stack.length) {
		const t = stack.pop()!;
		stack.push(...t.children);
		if (t.children.length === 0) {
			const r = rollups[t.id];
			if (r) { learned += r.learned; total += r.total; seen = true; }
		}
	}
	return seen ? { learned, total } : null;
}

export interface LeafRollups {
	/** leaf topicId → { learned, total } of the POOL (accepted, non-buried). */
	[topicId: string]: { learned: number; total: number };
}

function ImportanceSelect({
	topic,
	current,
	onChange,
}: {
	topic: ScopeTopic;
	current: Importance;
	onChange: (tier: Importance) => void;
}) {
	return (
		<select
			aria-label={`importance for ${topic.title}`}
			value={current}
			onChange={(e) => onChange(e.target.value as Importance)}
			className="rounded-sm border border-border bg-card px-1 py-0.5 font-ui text-[11px] text-foreground"
		>
			{TIER_ORDER.map((t) => (
				<option key={t} value={t}>
					{t}
				</option>
			))}
		</select>
	);
}

export function TopicNode({
	topic,
	depth,
	scope,
	rollups,
	onImportance,
	leafActions,
	nodeActions,
}: {
	topic: ScopeTopic;
	depth: number;
	scope: Scope;
	rollups: LeafRollups;
	onImportance: (topicId: string, objectiveId: string, tier: Importance) => void;
	leafActions?: (topic: ScopeTopic) => React.ReactNode;
	/** Rendered on EVERY node (interior + leaf) — the Class anchor seam
	 *  (ADR 0003: a subtree chosen at start can be any node). */
	nodeActions?: (topic: ScopeTopic) => React.ReactNode;
}) {
	const [open, setOpen] = useState(depth < 1);
	const isLeaf = topic.children.length === 0;
	const rollup = isLeaf ? rollups[topic.id] : subtreeRollup(topic, rollups);
	const excluded = scope.objectives.length > 0 &&
		scope.objectives.every((o) => topic.importance?.[o.id] === "excluded");
	return (
		<div className={depth === 0 ? "mb-1" : undefined}>
			<div className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/40 ${excluded ? "opacity-50" : ""}`}>
				{isLeaf ? (
					<span className="w-4 shrink-0" aria-hidden="true" />
				) : (
					<button
						type="button"
						aria-label={open ? `collapse ${topic.title}` : `expand ${topic.title}`}
						onClick={() => setOpen(!open)}
						className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
					>
						{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
					</button>
				)}
				<span className="min-w-0 truncate font-ui text-sm text-foreground" title={topic.summary ?? topic.title}>
					{topic.title}
				</span>
				{rollup && (
					<span className={`font-ui text-[11px] ${rollup.total > 0 && rollup.learned === rollup.total ? "text-emerald-400/90" : "text-muted-foreground"}`}>
						{rollup.learned}/{rollup.total} learned
					</span>
				)}
				<span className="ml-auto flex items-center gap-1">
					{scope.objectives.map((o) => {
						const current = topic.importance?.[o.id] ?? "medium";
							return (
								<span key={o.id} className="hidden group-hover:inline-flex sm:inline-flex" title={`for: ${o.text}`}>
								<ImportanceSelect
									topic={topic}
									current={current}
									onChange={(tier) => onImportance(topic.id, o.id, tier)}
								/>
								</span>
							);
					})}
					{nodeActions?.(topic)}
					{isLeaf && leafActions?.(topic)}
				</span>
			</div>
			{!isLeaf && open && (
				<div className="ml-4 border-l border-border/60 pl-1">
					{topic.children.map((c) => (
						<TopicNode
							key={c.id}
							topic={c}
							depth={depth + 1}
							scope={scope}
							rollups={rollups}
							onImportance={onImportance}
							nodeActions={nodeActions}
							leafActions={leafActions}
						/>
					))}
				</div>
			)}
		</div>
	);
}
