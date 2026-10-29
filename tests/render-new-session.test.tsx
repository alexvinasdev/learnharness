import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";

/**
 * The sessionless draft view (/chat/new, owner 2026-09-13): "+ New session"
 * opens the draft — NOTHING is created until the first message is sent, and
 * that message becomes the session's title. These pins hold the two seams:
 * startDraftSession (the create-on-send contract) and DraftShell (the
 * visible surface: composer blob + stats bar + the fresh-chat empty state).
 */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startDraftSession — the create-on-send contract", () => {
	it("creates the session titled with the first message, returns the prompt redirect", async () => {
		const { f, calls } = fakeFetch("c_new");
		const target = await startDraftSession("teach me orbital mechanics", f);
		assert.equal(target, "/chat/c_new?prompt=teach%20me%20orbital%20mechanics");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.equal(calls[0]!.method, "POST");
		assert.deepEqual(calls[0]!.body, { title: "teach me orbital mechanics", kind: "scope" });
	});

	it("no settings PUT on create — the server stamps the newborn (per-session models, owner 2026-09-28)", async () => {
		const { f, calls } = fakeFetch("c_3");
		await startDraftSession("hello", f);
		assert.equal(calls.length, 1, "a single create call — the birth stamp is server-side");
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", f), null);
		assert.equal(await startDraftSession("   ", f), null);
		assert.equal(calls.length, 0);
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("renders the composer blob, the stats bar, and the fresh-chat empty state", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		// The chat composer, ready for the first message.
		assert.ok(html.includes('data-testid="composer"'));
		// The draft's model control binds the strong slot — the
		// new-session default (per-session models, owner 2026-09-28).
		assert.ok(html.includes('data-testid="stats-model"'));
		// No CTA by default: a configured surface stays quiet.
		assert.ok(!html.includes('data-testid="setup-cta"'));
		// The same empty state a fresh scope session shows.
		assert.ok(html.includes("Say what the domain is for — the interviewer helps you map what to learn into a topic tree."));
		// The pointer-events pattern (953b22b): the wrapper stays inert…
		assert.ok(html.includes("pointer-events-none"));
		// …and the blob re-enables it.
		assert.ok(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/.test(html));
	});

	it("renders the setup CTA above the composer blob when passed (fix wave chunk B: /chat/new mirrors home)", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				setupCta={
					<button type="button" data-testid="setup-cta">
						Set up your models
					</button>
				}
			/>,
		);
		// The same affordance home carries, above the draft shell's blob.
		assert.ok(html.includes('data-testid="setup-cta"'));
		assert.match(html, />Set up your models<\/button>/);
		assert.doesNotMatch(html, /chats start after/);
		// Above the composer: the CTA's markup precedes the blob's.
		const cta = html.indexOf('data-testid="setup-cta"');
		const blob = html.search(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/);
		assert.ok(cta !== -1 && blob !== -1 && cta < blob, "CTA above the blob");
	});

	it("no chat id anywhere — nothing in the markup references a session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(html));
	});
});
describe("the scope draft (scope-only law, 2026-02)", () => {
	it("the shell carries the interview copy: title, empty state, placeholder", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		assert.match(html, /New scope session/);
		assert.ok(html.includes("Say what the domain is for — the interviewer helps you map what to learn into a topic tree."));
		assert.match(html, /What domain, and what for\?/);
	});

	it("a refinement draft (scopeIdPresent) swaps the copy to the continue-on-the-scope variant", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				scopeIdPresent
			/>,
		);
		assert.ok(html.includes("The interview continues on the existing scope"));
		assert.match(html, /What should change in the scope\?/);
	});

	it("startDraftSession carries kind:\"scope\" and the scopeId (the refinement contract)", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c9" }), { status: 201 });
		}) as unknown as typeof fetch;
		const target = await startDraftSession("the parity chain", f, "scope_1");
		assert.equal(target, "/chat/c9?prompt=the%20parity%20chain");
		assert.deepEqual(body, { title: "the parity chain", kind: "scope", scopeId: "scope_1" });
	});

	it("a fresh draft sends no scopeId key at all", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c10" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("drill me", f);
		assert.deepEqual(body, { title: "drill me", kind: "scope" });
	});
});