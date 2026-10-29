"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

/**
 * Scope deletion — the destructive confirmation for the sidebar's scope
 * context menu, in the DeleteSessionDialog's shape (z-50 portal, one-esc
 * law, Cancel + destructive red Delete). No modes: the orphan doctrine
 * already decided the cascade question — DELETE /api/scopes/[id] removes
 * the scope's whole directory while its sessions keep the dangling
 * scopeId (CONTEXT.md "Orphan"; chats without a known scope leave the
 * sidebar's groups by design).
 */
export function DeleteScopeDialog({
	scope,
	onClose,
	onDeleted,
}: {
	/** The scope up for deletion; null = closed. */
	scope: { id: string; name: string } | null;
	onClose: () => void;
	/** Success path — the sidebar owns list patching + navigation. */
	onDeleted: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	// Fresh state per scope: closing resets, opening a new scope starts clean.
	useEffect(() => {
		if (!scope) {
			setBusy(false);
			setFailure(null);
		}
	}, [scope]);

	// Esc closes (claimed — the one-esc law, a dialog Esc must not also
	// abort a turn or fold the sidebar).
	useEffect(() => {
		if (!scope) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [scope, onClose]);

	const run = async () => {
		if (!scope || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/scopes/${scope.id}`, { method: "DELETE" });
			if (!res.ok) {
				// 404 = already gone; the network line covers both retry paths.
				setFailure(`Delete failed (${res.status}). Try again.`);
				setBusy(false);
				return;
			}
			onDeleted(scope.id);
		} catch {
			setFailure("Delete failed — network error. Try again.");
			setBusy(false);
		}
	};

	if (!scope) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			{...backdropDismiss}
		>
			<DeleteScopeBody
				scope={scope}
				busy={busy}
				failure={failure}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>,
		document.body,
	);
}

/** The dialog's pure body — exported for SSR pins (the DeleteSessionBody
 *  pattern). The wrapper owns state + effects + portal. */
export function DeleteScopeBody({
	scope,
	busy,
	failure,
	onClose,
	onRun,
}: {
	scope: { id: string; name: string };
	busy: boolean;
	failure: string | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete scope"
			data-testid="delete-scope-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[32rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">Delete scope?</h2>
			{/* The scope name in JetBrains Mono (the session dialog's shape):
			    no code-block chrome — the font already says code. */}
			<div className="mt-1.5">
				<code data-testid="scope-name-code" className="font-mono text-sm text-foreground">
					{scope.name}
				</code>
			</div>
			{/* The orphan doctrine, said out loud: what dies (the tree and its
			    artifacts) and what stays (the sessions, dangling — and hidden
			    from this sidebar's groups, scopeGroups' documented rule). */}
			<p className="mt-3 text-xs text-muted-foreground">
				The topic tree, its exercises, and cheatsheets are removed. Its sessions are
				not deleted — they keep a dangling scope reference and leave the sidebar.
			</p>
			{failure && (
				<div
					role="alert"
					data-testid="delete-scope-failure"
					className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs"
				>
					<span className="text-foreground">{failure}</span>
					<button
						type="button"
						data-testid="delete-scope-retry"
						onClick={onRun}
						disabled={busy}
						className="ml-3 text-xs text-foreground underline-offset-2 hover:underline disabled:opacity-40"
					>
						Try again
					</button>
				</div>
			)}
			{/* The session dialog's exact bottom row: quiet Cancel, destructive
			    red Delete (border + text, fill on hover). */}
			<div className="mt-4 flex justify-end gap-2">
				<button
					type="button"
					data-testid="delete-scope-cancel"
					onClick={onClose}
					disabled={busy}
					className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="delete-scope-confirm"
					onClick={onRun}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					Delete
				</button>
			</div>
		</div>
	);
}
