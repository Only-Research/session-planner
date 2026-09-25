---
name: refresh
description: Process an explicit user handoff of Session Planner feedback while preserving staged work.
---

# Refresh

Read `../session-plan/references/operations.md`. For a fresh agent context, first use `resume` and orient to the whole session.

Read [Work toward clarity together](../session-plan/SKILL.md#work-toward-clarity-together), [Develop a component](../session-plan/SKILL.md#develop-a-component) and [Useful initiative](../session-plan/SKILL.md#useful-initiative). An explicit refresh includes thoughtful refinement and consideration of worthwhile new proposals, not just transcription. Reorientation alone remains distinct from authorization to change the field.

If investigation is needed, read `../session-plan/references/research.md`: all research goes to subagents, and the coordinator evaluates their returns and owns the writes. Research only what the feedback asks, as a short look unless the user has asked for or agreed to a deep dive. Update the cards that need no research first and tell the user; finish the refresh once the researched cards are written.

When the user hands off their board feedback, run `begin-refresh` for the exact session. Read the returned pending active items with their current bodies and feedback histories. Respond thoughtfully: adjust the framing when needed, incorporate direction, and explain reasoned recommendations. Do not merely echo feedback or reapply old instructions.

Use `update` with each item's current revision and the batch ID. If the existing content already addresses the request, use `ack` with a specific reason. A research failure alone is not an unchanged acknowledgment: keep that work pending and report the limitation, or explicitly record the unresolved state in the card without claiming a substantive answer. Leave approved, shelved, and rejected items alone. Use `propose` only for a worthwhile unsolicited new consideration.

Follow the operations reference's proposal/batch reconciliation sequence before `finish-refresh`; do not generate another round of proposals just because reconciliation restarts. If new user interactions arrived, begin again and handle the remaining current work; processed unchanged revisions are remembered. If continuing activity prevents completion, report what remains instead of chasing an endless refresh. Never force completion or append your own completion marker. After successful completion, tell the user what changed, where to review it and any unresolved questions. Say where your thinking actually moved and where you held a position against their feedback, not only which cards you touched. A refresh that transcribed the feedback into the cards and changed nothing else should be reported as exactly that. Distinguish processing saved feedback from reloading a browser; follow the entry skill's handoff guidance.
