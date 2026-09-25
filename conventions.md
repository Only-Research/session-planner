# Session Planner — Operating Conventions

## Ownership

The user brings the topic and their direction, and decides when each piece is ready. The current agent remains itself and works with the user toward clarity a step at a time, bringing its own reasoning, questions and ideas, and research the user has pointed it toward, as it organizes and refines those pieces. The browser supports work at the user's pace; feedback processing begins only on an explicit refresh handoff.

The server owns item IDs, metadata, titles, status storage, feedback, counters, and refresh checkpoints. Agents supply plain Markdown through `server/planner.js`, using the commands in `skills/session-plan/references/operations.md`. Do not manually author YAML, recreate item files, or append a completion marker yourself.

## Writing and updating

Keep agent input drafts in the session's `scratch/`, following the command reference. Filenames are flexible; retain drafts without submission tracking or automatic cleanup. Scratch is writing material, not a queue or saved session state.

Create ordinary user-directed work with `add`, and worthwhile unsolicited additional units or new scope with `propose`. Refining an existing component does not require a separate proposal; questions may be discussed in the card or chat. See the entry skill's Develop a component and Useful initiative guidance. Existing blank capacity is consumed before additional ordinary cards are created. Preserve Context and Content, add Options when there is a real choice, and give a Recommendation where it helps. An item may be a plan component under development, not only a choice among options. Keep it self-contained, substantial, and independently workable; avoid padding and arbitrary splitting.

Read an item's current revision before updating. Use `update` so the server can preserve metadata and reject stale writes. A conflict is information: reread the item and consider newer user feedback or status before changing anything. Approved, shelved, and rejected items cannot be rewritten through this interface. The user can return approved or shelved items to the field first. Rejected source files are retained but hidden from the current viewer; it has no rejected-item restore control. Report that limitation rather than inventing a restore operation or editing metadata directly.

Feedback is retained as append-only history within the item's metadata. Read it alongside the current content. Do not clear it or apply an old instruction again merely because it is still present.

## Refresh and resume

For refresh, use `begin-refresh`, handle the pending active items, then `finish-refresh`. Use the batch ID for body updates. An item that already addresses the input can be acknowledged unchanged with a reason. The helper rejects completion if new interactions arrived or active items remain unprocessed. Begin again after new activity; completed unchanged revisions are remembered. Do not claim a failed or interrupted batch is complete.

For a fresh agent or resumed conversation, read the broader session through `resume` before incremental refresh. Read saved intake and references, meaningful current items, statuses, feedback, changelog, and outputs. Choose by exact session name, not by a supposedly unique active flag. Save important new conversation context in a new Markdown reference note for future agents.

## Output and lifecycle

**Approval meaning:** Staging a card accepts its recommended action by default, even when the card still contains multiple options. A user's explicit decision note or later direction qualifies or overrides that recommendation. Apply this to the source version approved; for legacy cards, use the preserved recommendation and available user direction. The existence of alternatives is not itself ambiguity. Keep “consider,” “could also,” and other optional additions optional; do not turn them into commitments merely because they appear under a Recommendation heading. If the recommendation explicitly selects a bundle or retains backups, preserve that scope. An approved component without a choice/recommendation retains its substantive content. Ask only when the actual recommended action or conflicting user direction is materially unclear.

Compilation composes an actionable document from approved decisions and their qualifications; it preserves source bodies and history separately. The user can stage with a note and amend that note while staged. Reopening retires the current approval; later staging records a new one. Use the approval meaning above to identify the accepted action; do not reopen a clear recommendation simply because alternatives remain on the card. Retain deliberate backups and useful links; omit discarded research from the takeaway. Follow `skills/compile/SKILL.md` and the guarded `compile` operation, which publishes a new document/source bundle. `export-sources` retains the explicit verbatim archive behavior. Return a clearly labeled document link; if the user designated a parent workspace, record a pointer there. Do not silently duplicate the output.

All research is delegated to subagents to keep the coordinating context clean. The coordinator briefs, assesses bounded findings, reconciles dependencies, and writes cards. `skills/session-plan/references/research.md` holds the focused guidance. An unavailable worker capability is a limitation to report, not permission to browse in the main conversation.

Local work persists in the session folder independently of the server process. Use the helper's verified start/resume URL. Do not kill unrelated processes, assume a fixed port, or shut down just because an agent turn ends. Stop when the user has finished using the surface; a shared server may support several sessions. No external exposure or tunnel is part of this workflow.

## Legacy compatibility

Existing Markdown items with YAML metadata remain readable. Plain Markdown files dropped into a session's `inbox/` become proposals while that session is in use, and are kept in `inbox/processed/`. Current planning uses the guarded helper.
