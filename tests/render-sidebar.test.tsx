/**
 * Session-row render tests — the picker's status language (owner,
 * minimal-color round): ONE indicator, the braille spinner, present ONLY
 * while a teach turn is in flight; every other state (idle, question
 * pending) renders nothing — phases only advance, so phase-as-signal was
 * decoration, and question-pending is the dominant RESTING state (the
 * meta line's text carries it). Pure function of the list item, so SSR of
 * <SessionRow> pins every visible state. Same tsx classic-JSX shim as
 * render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, ScopeRow, scopeGroups, timeAgo } from "../components/sidebar.tsx";
import type { ChatListItem, ChatKind, ScopeSummary } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		pendingQuestion: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("no phase strips, no phase colors — the retired decoration", () => {
		const html = render(item({}));
		assert.ok(!html.includes("phase-strip"), "strip removed by design (too busy)");
		assert.ok(!html.includes("bg-phase-"), "phase fills are retired app-wide");
		assert.ok(!html.includes("border-phase-"), "phase rings are retired app-wide");
	});

	it("idle session: NO indicator — absence is the state", () => {
		const html = render(item({}));
		assert.ok(!html.includes("session-dot"), "no dots — the status language is spinner-only");
		assert.ok(!html.includes("braille-spinner"), "idle never shows the spinner");
	});

	it("a pending question renders NO indicator — resting state, carried by the meta text", () => {
		const html = render(item({ pendingQuestion: true }));
		assert.ok(!html.includes("session-dot"), "no dots");
		assert.ok(!html.includes("braille-spinner"), "motion is reserved for working");
		assert.ok(html.includes("Waiting for input"), "the meta line's text");
		assert.ok(!html.includes("Waiting for your answer"), "old wording is gone");
	});

	it("a working session (turn in flight) renders the braille spinner — the ONLY indicator", () => {
		const html = render(item({ busy: true }));
		assert.ok(html.includes('data-testid="braille-spinner"'), "the spinner");
		assert.ok(html.includes("braille-frame"), "CSS-animated frames");
		assert.ok((html.match(/class="braille-frame"/g) ?? []).length === 10, "all ten frames");
		assert.ok(html.includes('data-frame="0"'), "frame 0 leads (static fallback)");
		assert.ok(html.includes("Working"), "accessible label");
		assert.ok(!html.includes("bg-attention"), "no colored state fill — monochrome by design");
	});

	it("busy does not double-signal background agents (that is the sidebar section's channel)", () => {
		// The narrowing lives in the API route (busy = isTurnRunning only);
		// the row itself just renders busy faithfully. Pinned here so the
		// contract can't silently re-widen: an extraction-only "working"
		// row would be a double signal.
		const html = render(item({ busy: true, pendingQuestion: false }));
		assert.ok(html.includes("Working"), "the spinner's label names the turn, not agents");
	});

	it("the meta line: state replaces the count when the state is the useful fact", () => {
		const awaiting = render(item({ pendingQuestion: true, updatedAt: "2026-01-02T01:00:00.000Z" }));
		assert.ok(awaiting.includes("Waiting for input · 2026-01-02"), "awaiting meta keeps the existing date");
		assert.ok(!awaiting.includes("messages"), "count yields to the state");
		assert.ok(!awaiting.includes("braille-spinner"), "…and the spinner stays off");

		const working = render(item({ busy: true }));
		assert.ok(working.includes("Working…"), "working meta");

		// Owner, typography round 5: the message count is dropped — it
		// informed no decision. Idle meta is just how long ago.
		const idle = render(item({ title: "Partial derivatives", messageCount: 7 }));
		assert.ok(idle.includes("Partial derivatives"));
		assert.ok(!idle.includes("messages"), "the count is gone (flip-flop: one line in sessionMeta)");
		assert.match(idle, /\d{4}-\d{2}-\d{2}/, "idle shows the ISO date");
	});

	it("pending questions use the same wording for every kind with recent and old dates", () => {
		for (const kind of ["teach", "scope", "class"] as ChatKind[]) {
			for (const updatedAt of [new Date().toISOString(), "2025-06-02T12:00:00.000Z"]) {
				const html = render(item({ kind, pendingQuestion: true, updatedAt }));
				assert.ok(html.includes(`Waiting for input · ${timeAgo(updatedAt)}`));
				assert.ok(!html.includes("Waiting for your answer"));
			}
		}
	});

	it("compacting retains priority over pending input", () => {
		const html = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(html, /Compacting context ·/);
		assert.doesNotMatch(html, /Waiting for input/);
	});

	it("active row is visually marked by the background alone (owner, round 5: no weight change)", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("bg-accent"), "active background");
		assert.ok(!html.includes("font-medium"), "weight is not a second channel doing the same job");
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date (owner, round 5)", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02", "beyond a week: ISO — unambiguous, sortable");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});

describe("SessionRow kind badge", () => {
	it("a class row carries the graduation cap", () => {
		const html = render(item({ kind: "class" }));
		assert.match(html, /aria-label="Class session"/);
	});

	it("a scope-interview row carries no badge", () => {
		const html = render(item({ kind: "scope" }));
		assert.doesNotMatch(html, /aria-label="Class session"/);
	});

	it("the meta override (search results: scope name prefix) replaces the derived meta", () => {
		const html = renderToStaticMarkup(
			<SessionRow chat={item({})} active={false} onOpen={() => {}} meta="German B1 · 2h ago" />,
		);
		assert.ok(html.includes("German B1 · 2h ago"));
		assert.ok(!html.includes("Waiting for input"));
	});
});

describe("scopeGroups (the sidebar's grouping, 2026-02)", () => {
	const scope = (id: string): ScopeSummary => ({
		id,
		name: id,
		updatedAt: "2026-01-01T00:00:00.000Z",
		objectiveCount: 1,
		topicCount: 2,
		leafCount: 2,
	});
	const chat = (id: string, kind: ChatKind, scopeId: string | undefined, updatedAt: string): ChatListItem => ({
		id,
		title: id,
		kind,
		scopeId,
		createdAt: updatedAt,
		updatedAt,
		messageCount: 1,
		pendingQuestion: false,
		busy: false,
		compacting: false,
	});

	it("groups by scope: interviews first, classes below, newest first within kind", () => {
		const groups = scopeGroups(
			[scope("s1")],
			[
				chat("c1", "class", "s1", "2026-01-03T00:00:00.000Z"),
				chat("c2", "scope", "s1", "2026-01-01T00:00:00.000Z"),
				chat("c3", "class", "s1", "2026-01-05T00:00:00.000Z"),
				chat("c4", "scope", "s1", "2026-01-02T00:00:00.000Z"),
			],
		);
		assert.deepEqual(
			groups.map((g) => g.chats.map((c) => c.id)),
			[["c4", "c2", "c3", "c1"]],
		);
	});

	it("chats without a scope or with an unknown scope stay hidden", () => {
		const groups = scopeGroups(
			[scope("s1")],
			[
				chat("orphan", "teach", undefined, "2026-01-01T00:00:00.000Z"),
				chat("ghost", "class", "sX", "2026-01-01T00:00:00.000Z"),
			],
		);
		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0]!.chats, []);
	});

	it("scopes with no chats still get their row (the empty dropdown)", () => {
		const groups = scopeGroups([scope("s1"), scope("s2")], []);
		assert.deepEqual(groups.map((g) => g.scope.id), ["s1", "s2"]);
		assert.ok(groups.every((g) => g.chats.length === 0));
	});
});

describe("ScopeRow", () => {
	const s: ScopeSummary = {
		id: "s1",
		name: "German B1",
		updatedAt: "2026-01-01T00:00:00.000Z",
		objectiveCount: 1,
		topicCount: 3,
		leafCount: 2,
	};
	function renderScope(opts: Partial<Parameters<typeof ScopeRow>[0]> = {}) {
		const props = { scope: s, expanded: false, hasChats: true, busy: false, onToggle: () => {}, onOpenView: () => {}, ...opts };
		return renderToStaticMarkup(<ScopeRow {...props} />);
	}

	it("collapsed carries aria-expanded=false + the leaves meta", () => {
		const html = renderScope({ hasChats: true, expanded: false });
		assert.ok(html.includes('aria-expanded="false"'));
		assert.ok(html.includes("2 leaves"));
	});

	it("expanded carries aria-expanded=true", () => {
		const html = renderScope({ hasChats: true, expanded: true });
		assert.ok(html.includes('aria-expanded="true"'));
	});

	it("a scope with no chats is a leaf row — no aria-expanded, opens the view", () => {
		const html = renderScope({ hasChats: false });
		assert.ok(!html.includes("aria-expanded"));
		assert.ok(html.includes("open German B1 in the Scopes view"));
	});

	it("a busy group shows the spinner on the scope row", () => {
		const html = renderScope({ hasChats: true, busy: true });
		assert.ok(html.includes('data-testid="braille-spinner"'));
	});
});
