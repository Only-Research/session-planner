# Session Planner

Session Planner is a local collaborative planning surface for refining many independent pieces without flattening their substance into one draft. The user controls staging, shelving, and rejection. The agent brings its own reasoning, research and ideas, organizes and refines the work, and preserves approved content.

## Orientation

Keep your existing identity; this tool does not ask you to adopt a persona. Read `conventions.md` for storage and ownership rules. To operate a planning session, read `skills/session-plan/SKILL.md` and its command reference. The same core workflow serves any compatible local agent host.

Preparation precedes population: review the existing discussion, mirror what is being carried forward, and ask focused questions about missing context. For a fresh topic, invite a brain dump and develop the framing in conversation. Preserve the relevant intake in the session so another agent can resume.

## Layout

- `runs/`: central session store, one folder per named session.
- `runs/.scratch/`: retained initial intake inputs written before a session exists; create when needed.
- `server/`: local server, guarded operations, and `planner.js` command helper.
- `viewer/`: the user's planning surface, served on loopback.
- `templates/`: the card and changelog templates new sessions are built from.
- `skills/session-plan/`: entry workflow and command reference.
- `skills/populate`, `refresh`, `review`, `compile`: focused operation guidance.

A run contains `session.yaml`, `changelog.md`, `reference/`, `items/`, `inbox/`, `output/`, and `scratch/`. Scratch holds retained agent input drafts; saved cards and outputs remain authoritative. Metadata and checkpoints are maintained mechanically. Agents use supported commands to supply Markdown content, while the server remains the writer of item metadata.

## Selection and operation

Use the exact named session. Several runs may be marked active; that flag is not a unique selector. `resume` provides the saved context, field, feedback, history, and outputs for a fresh orientation. Incremental refresh is for an already-oriented agent and only follows an explicit user handoff.

Use the local helper for create/add/propose/read/update/refresh/compile and server lifecycle. Read approval notes as part of the decision; compose useful outputs with separate preserved sources, following the compile skill. All research goes to subagents, with coordinator synthesis; see the entry skill’s research reference. Never edit YAML or write item files directly. The user's status choices are not agent operations. Use the returned revision to update content; conflicts require rereading and reconciling. Never overwrite a staged item.

One server serves a session store. Use its verified URL rather than assuming a port. Stop when the user finishes using the surface, accounting for other open sessions; preserve data and resume later. Do not install dependencies, publish, or expose the server as a side effect of planning. If the user asks you to install or set up Session Planner, follow `docs/install-with-an-agent.md`.
