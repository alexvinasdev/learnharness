/**
 * SSR pins — delete-scope-dialog: the destructive copy must state BOTH
 * sides of the orphan doctrine (what dies — tree/exercises/cheatsheets;
 * what stays — the sessions, dangling, out of the sidebar).
 * DeleteScopeBody is the pure seam (the DeleteSessionBody pattern); the
 * wrapper owns state + effects + portal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteScopeBody } from "@/components/delete-scope-dialog";

const scope = { id: "scope_1", name: "Graph Theory" };

describe("DeleteScopeBody", () => {
	it("names the scope, the orphan-doctrine consequence, Cancel + Delete", () => {
		const html = renderToStaticMarkup(
			<DeleteScopeBody scope={scope} busy={false} failure={null} onClose={() => {}} onRun={() => {}} />,
		);
		assert.ok(html.includes('data-testid="delete-scope-dialog"'));
		assert.match(html, /Delete scope\?/);
		assert.match(html, /Graph Theory/);
		// the doctrine, said out loud — the sessions survive, dangling
		assert.match(html, /not deleted/);
		assert.match(html, /dangling/);
		assert.match(html, /Cancel/);
		assert.match(html, /Delete/);
	});

	it("the confirm action is the destructive pair, never the cancel", () => {
		const html = renderToStaticMarkup(
			<DeleteScopeBody scope={scope} busy={false} failure={null} onClose={() => {}} onRun={() => {}} />,
		);
		const confirmAt = html.indexOf('data-testid="delete-scope-confirm"');
		const cancelAt = html.indexOf('data-testid="delete-scope-cancel"');
		assert.ok(confirmAt > -1 && cancelAt > -1, "both buttons render");
		assert.ok(html.slice(confirmAt).includes("text-destructive"), "confirm is the red destructive");
		assert.ok(!html.slice(cancelAt, confirmAt).includes("text-destructive"), "cancel stays quiet");
	});

	it("failure renders the retry line; the happy path renders none", () => {
		const failed = renderToStaticMarkup(
			<DeleteScopeBody scope={scope} busy={false} failure="Delete failed (404). Try again." onClose={() => {}} onRun={() => {}} />,
		);
		assert.match(failed, /Try again/);
		const clean = renderToStaticMarkup(
			<DeleteScopeBody scope={scope} busy={false} failure={null} onClose={() => {}} onRun={() => {}} />,
		);
		assert.ok(!clean.includes("delete-scope-failure"), "no failure block without a failure");
	});
});
