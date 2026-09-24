# Local operations

This skill ships inside the application at `skills/session-plan/`. Resolve the skill's real filesystem location (including symlinks); the app root is two directories above it. The helper is `<app-root>/server/planner.js`. Use its absolute path from other projects. Read `<app-root>/templates/item-template.md` for the card's section headings if needed — its metadata header is the server's, never part of what you write; never manually duplicate a run or author its metadata.

Requires an already installed Node.js 20+ and the app's existing server dependencies. `node <helper> --help` lists commands. Nothing auto-installs. Commands emit JSON or an actionable error, and run through a localhost server that owns metadata. Use properly quoted command arguments; use text files for multiline content.

## Session selection and lifecycle

```text
node <helper> list
node <helper> create <name> --intake <absolute-markdown-path> [--parent <absolute-workspace-path>]
node <helper> resume <name>
node <helper> status
node <helper> start
node <helper> stop
```

Names use lowercase letters, numbers, and hyphens. `create` refuses a conflicting existing name; an exact retry of the original creation reuses the completed session, as detailed under Content operations. It saves intake to `reference/intake.md` and prepares the normal 15 blanks. `--parent` records a user-designated parent workspace without writing to it. `resume` returns the full saved session and the exact browser URL. List/resume/start reuse a verified running instance or start one. A fresh start reuses the store's previous loopback port when it is still free, so a browser tab left open on the planner keeps its unsaved drafts and can reconnect by reopening the link in that same tab; otherwise, and on first use, the OS assigns a free port. `start --port 0` always takes a fresh OS-assigned port. `start --port NUMBER` requests one explicitly and fails if occupied, leaving the existing service alone. Never kill an unrelated service to make room.

All commands accept `--runs <absolute-store-path>`; otherwise they use the installed app's `runs/` directory. This option points to the **parent of session folders**, not an individual session folder. Preserve the chosen store throughout the session. One server serves the store. `status` reports sessions touched by that running server, not a live inventory of open browser tabs. The agent cannot detect every browser-only draft or unfinished save. Before shutdown, have the user save unfinished input and confirm other surfaces are finished when relevant. `stop --all` stops the shared server when several sessions have been opened; use it only with direction covering all those surfaces. A refusal from `stop` is not permission to retry with `--all`. Already explicit applicable shutdown direction does not require another confirmation.

If the host terminates background processes when the conversation exits, later resume can start a new process. Files remain. Do not promise that the page remains available when its computer or server stops. Runtime files are local credentials and process records; do not quote their token or include them in exports.

An interrupted startup can leave `<store>/.startup-lock`. The helper briefly waits for a verified healthy server, then reports the retained lock; it does not automatically reclaim it. Stop other launch attempts before inspecting the lock and runtime. Establish that the recorded owner has exited, preserve the abandoned lock under a separate name, then restart. Do not blindly remove a lock or kill a process based only on its PID. If ownership cannot be established, report the blockage and leave it intact. This is deliberate recovery, not a routine startup step.

## Content operations

Every Markdown file you write for the planner — intake, card bodies, reference notes, drafts and the plan — has no frontmatter or other metadata header. That is this app's format, and it settles the question whatever document conventions apply elsewhere in your workspace.

Keep input files in `<session-path>/scratch/`, using the session path returned by `create` or `resume`. New sessions include this folder; create it when first needed in an older session. Use it for card bodies, proposals, refresh drafts, and compilation inputs (Markdown and coverage JSON). Filenames are flexible: no naming pattern, numbering, or registry is required. Preserve an existing draft by choosing another filename for a new version.

The agent writes the input file and passes its absolute path to the helper. The helper reads the file and sends only its text to the server; it does not move or delete the input. Leave drafts in scratch after submission, including failed or uncertain attempts. Nothing scans or automatically submits this folder, and its contents are excluded from normal resume and compilation sources. Saved cards and outputs remain authoritative. A retained draft does not indicate whether submission succeeded; inspect saved state after an uncertain result. `add` and `propose` calculate a stable creation operation ID from the command, session, absolute input path, title, and exact text. Repeating the same command with the same input returns the existing card, including its current status; it does not restore old content. Keep the input unchanged for that retry. For an intentional second card from identical input, pass a fresh `--operation <unique-id>` (8–80 letters, digits, or hyphens). An explicit operation ID also lets a retry retain its identity if the draft file is moved. Do not reuse it for different text. Direct API callers must supply `operationId` for safe creation retries; omitted IDs cannot deduplicate separate requests.

Initial intake precedes the session: write it in `<session-store>/.scratch/` (by default `<app-root>/runs/.scratch/`), creating that folder if needed. Choose any available filename and retain the input there; no other workspace or naming pattern is required. Pass its absolute path to `create`, which saves its text as `reference/intake.md`. This shared scratch folder is excluded from the session list. Do not precreate the session directory to hold intake, because only the server publishes a complete session directory. An exact repeat of the original create request reuses the completed session; different intake or a legacy session without a creation receipt conflicts. Keep subsequent drafts in the session's own scratch folder rather than a system temporary directory. Keep scratch separate from `inbox/` (processed proposals), `reference/` (orientation context), and `output/` (saved results).

```text
node <helper> add <name> --title "Title" --body <markdown-file>
node <helper> propose <name> --title "Title" --body <markdown-file>
node <helper> read <name> <item-id>
node <helper> update <name> <item-id> --revision <revision> --body <markdown-file>
```

Use the returned `revision` from the current read. The update endpoint rejects a stale revision or an item that has become approved, shelved, or rejected. Reread and consider the new feedback instead of retrying the same stale content. A blank-item update additionally needs `--title`; `add` normally handles blank reuse for you.

The body file is plain Markdown: Context, Content, optional Options, and Recommendation where useful. It must not contain item metadata. The helper does not grant permission to move statuses. Direct editing of item files, YAML, counters, or changelog boundaries bypasses the guarded protocol and is not the supported workflow. If a command reports that a card file can't be read, tell the user which file; it was probably edited outside the planner, and they can fix it or restore it from a backup. Don't repair its metadata yourself. Files dropped into `inbox/` become proposals automatically; use `propose` yourself and never write files there.

## Explicit refresh

```text
node <helper> begin-refresh <name>
node <helper> update <name> <item-id> --revision <revision> --body <markdown-file> --batch <batch-id>
node <helper> ack <name> <item-id> --revision <revision> --batch <batch-id> --reason "Why no change is needed"
node <helper> finish-refresh <name> --batch <batch-id>
```

Begin returns pending active items and separately identifies respected statuses. Full feedback history is included. Each item carries durable processing evidence so processed feedback survives an interrupted or later batch; the server distinguishes a body update from unchanged acknowledgment. Approvals include the user’s exact note and recoverable source, with prior approvals retained after amendment or reopening. Read it against current content; avoid applying old feedback twice. Each pending active item must be updated or explicitly acknowledged unchanged. Initial creation may appear in the first batch: if already populated and no further input exists, acknowledge that fact rather than gratuitously rewriting it.

Before taking a snapshot or completing a refresh, the server repairs missing derived bookkeeping from saved card receipts. A repair that reveals activity after a batch began makes that batch conflict; begin again. Completion checks the recorded interactions have not changed and every pending active item was handled. New user activity can make completion fail. Begin again; unchanged completed item revisions are remembered, while items with new feedback return as pending. Interrupted work does not acquire a false completion marker.

Develop worthwhile proposals while processing the feedback, then submit them together. Their new events invalidate the current batch: after submitting the group, begin again, reconcile any newly pending active work, and finish. Do not regenerate proposals merely because reconciliation restarted, or restart after each individual proposal. Continue respecting actual new user activity; if it keeps preventing completion, report the unfinished work rather than looping indefinitely.

## Approval evidence and compilation

Browser approval and feedback writes require the displayed item revision and a retry operation ID. Approval with a note is one saved decision, and staged notes can be amended or explicitly removed without rewriting the body. Browser drafts and uncertain request receipts are scoped to this session store and browser tab. Unfinished new-item forms also survive Back/Forward navigation and same-tab reload; Cancel discards the form, and successful creation/replay clears only submitted text, preserving later edits. Editing a restored card draft or retrying its initial load never substitutes for explicit Review latest. A shelved card may return to the field with its draft intact and must be reviewed before that draft is saved. Drafts survive same-tab reload on the same origin, but closing the tab, changing ports, clearing browser storage, or changing device can lose unsent work. The browser offers Retry saved action after an uncertain response; it replays the original submission and preserves subsequent typing. After a server restart, reopen the helper’s link to obtain the new token before retrying. These receipts are retained through authentication failures. These are user interface operations, not agent status controls. Agents use the returned evidence; they do not manufacture approvals.

`read` and `resume` return `approvalBasis` for each staged item. A recorded approval has a durable ID and exact note/source in `data.approval`; prior records live in `data.approvalHistory`. A `legacy-…` basis means a historically staged item without a decision record. Staging accepts the approved source’s recommended action by default; a missing note does not make that clear choice unresolved. Optional additions remain optional, explicit bundles/backups retain their scope, and a user qualification overrides the default. This also applies to a legacy staged card with a preserved clear recommendation. Clarify meaningful conflicts or an unclear recommendation, not merely the presence of other options.

```text
node <helper> resume <name>
node <helper> compile <name> --revision <session-revision> --document <markdown-file> --coverage <json-file>
```

Write the composed plan as ordinary Markdown. The small coverage file maps each approved item exactly once to one or more existing headings, using the `approvalBasis` from the same snapshot:

```json
[
  {"id": 1, "approvalId": "the-returned-approvalBasis", "sections": ["Saturday"]},
  {"id": 4, "approvalId": "another-returned-approvalBasis", "sections": ["Saturday", "Before you go"]}
]
```

Heading text must match the document exactly, without the Markdown `#` prefix. Several items may map to the same section, and the plan's structure should follow the reader, not the cards: map each card to wherever its actionable detail lives, not only to the executive summary. Include every approved component, but do not copy every research option. Source IDs and the coverage file are bookkeeping; they need not appear in the reader-facing prose. The helper rejects stale session/approval evidence, absent coverage, and unknown sections. These checks do not prove the document is faithful; have it checked against the decisions as the compile guide describes before compiling.

A complete output is a new folder in `output/` named `<session>-session-plan-<date>-<time>` in local time, with a `-2`, `-3` suffix if that minute is taken. It holds the plan under the same name plus `.md`, and its `sources.json`. Older bundles may use another plan name, such as `plan.md`; `resume` lists each plan by its actual name. Outputs are listed by name, not by time; each bundle's `sources.json` records when it was created. The server records the supporting approved bodies, feedback, notes, and source identities. It publishes the bundle only after both files exist. Interrupted hidden pending bundles are retained but not presented as completed outputs. Previous plain Markdown outputs and new bundles are discoverable through `resume`.

The returned `path` is the user-facing document; `sources` is its supporting record. Return a clickable document link. `parentWorkspace`, when present, identifies the designated parent work: record a durable pointer there according to its conventions rather than silently duplicating the output. If a pointer cannot be written, report the saved plan and the incomplete handoff explicitly.

For an explicit verbatim archive request:

```text
node <helper> export-sources <name> --revision <session-revision> --framing <markdown-file>
```

This preserves approved bodies unchanged in a separately named source export. It is not the default takeaway. Existing outputs and original cards remain unchanged for either operation.

Relevant source: `server/planner.js` (commands), `server/server.js` (storage/runtime), `server/interaction-api.js` (user decisions), `server/item-state.js` (processing evidence), and `server/agent-api.js` (orientation, refresh, output).
