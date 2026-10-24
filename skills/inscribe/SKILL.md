---
name: inscribe
description: Use when you are Hydra and the owner says /inscribe or asks you to save what you learned, before a context reset or compaction, or when the digest says a memory is nearly full. Routes each fact to owner, project or Hydra memory and curates them; use with a project to save project context.
---

# inscribe

Leave the next session a short, current map instead of a growing journal. Each fact goes in the most specific layer that fits:

- Owner memory, Pnyx-wide and read by every Hydra (24000 characters): the owner's preferences under `preferences` and general learnings about tools, workers and routes under `learnings`.
- Project memory, shared by every Hydra on that project (10000 characters): facts, conventions and owner preferences that hold only for that project.
- Hydra memory, this Hydra only (1500 characters): its scope, where it left off, its check cursor.

Owner and Hydra memory are printed in full when a session opens and after compaction. Later wakes carry only a short memory-changed note. Project memory loads only on demand and for workers assigned to that project, so every line must earn its place.

When invoked with a project (`inscribe <project>`), resolve it with `pnyx-axi project list --hydra <hydra>` and read `pnyx-axi project memory list --project <name|path> --hydra <hydra>`. Route facts, conventions and owner preferences specific to that project into its shared memory. All its documents share a 10000-character budget across Hydras; a nearly-full digest asks you to curate it. General owner preferences and learnings go to owner memory.

- `profile`: build/test/lint commands, PR rules, key skills and when to use them, main conventions. Refresh missing or out-of-date profiles from the default-branch sources listed by Pnyx, reading only changed files. Save with the listed `--sources <fingerprint>` so a source change cannot be acknowledged accidentally.
- `preferences`: the owner's preferences for this project. Keep them until the owner changes them; a profile refresh does not replace them.
- `learnings`: durable discoveries about this project, without task progress or history.

Save each document whole with `pnyx-axi project memory set --project <name|path> --key <profile|preferences|learnings> --text "<document>" --reason "<why>" --hydra <hydra>` (add `--sources <fingerprint>` for a profile). Use `project memory forget` with the project and key to remove a document. Over-budget saves are refused: shorten and retry. Replacements and removals stay in the project's append-only log. Finish with what changed and the project characters used.

Without a project, sweep for every layer: route project facts and project preferences as above, and curate owner and Hydra memory with the steps below.

1. Read the current memory: `pnyx-axi owner memory list` and `pnyx-axi hydra memory list --hydra <hydra>` (each shows the characters used; owner memory also prints its revision).
2. Sweep this session for what exists only in the conversation:
   - Owner preferences: how the owner wants work done, standing decisions, people and tools they named. These hold until the owner changes them.
   - Learnings: facts you had to discover the hard way about tools, workers and routes, which would cost the next session time to rediscover. Each must still be true; check one you doubt before keeping it.
   - Hydra notes: what this Hydra covers and where it left off.
   - Leave out task progress, conversations, PRs and anything a task's history, brief or status already records.
3. Curate each document: merge duplicates, rewrite a changed preference in place, drop learnings that turned out wrong or are no longer needed, move a Hydra entry that holds for every Hydra into owner memory, and keep one plain line per entry, most important first. Pnyx keeps a confirmation date for each learning line; unchanged lines keep their date when the document is saved. Review every line marked stale after 30 days. Confirm a line only with evidence from this session: `owner memory confirm --text "<exact learning line>" --reason "<session evidence>"`, or `project memory confirm --project <project> --text "<exact learning line>" --reason "<session evidence>"`. Remove an unproven or outdated line by saving the remaining document; the old version stays in the log. Preferences do not age.
4. When owner memory is nearly full, move clearly project-specific learnings into that project's memory yourself before shortening or dropping useful facts. Resolve the attached project, read its memory, then run `pnyx-axi owner memory move --project <name|path> --text "<exact learning line>" --reason "<why this belongs to the project>" --if-revision <owner revision> --hydra <hydra>`. The move is one durable step and refuses growth beyond the project budget; curate the project first if necessary. Reload both memories after a move before saving whole documents.

   Owner preferences are the owner's own words. Before moving any preference out of owner memory, ask the owner through a real `pnyx-axi task ask <task> --to owner --question "<preference and proposed project>"` and wait for the answer. Name the preference and destination project; a status update or rhetorical question is not approval. Keep it in owner memory until the owner approves.
5. Save each changed document whole, with a reason:

   ```sh
   pnyx-axi owner memory set --key preferences --text "<document>" --reason "<what changed>" --if-revision <revision>
   pnyx-axi owner memory set --key learnings --text "<document>" --reason "<what changed>" --if-revision <revision>
   pnyx-axi hydra memory set --key scope --text "<text>" --reason "<what changed>" --hydra <hydra>
   ```

   Forget keys that became stale with `owner memory forget --key <key>` or `hydra memory forget --key <key> --hydra <hydra>`, each with `--reason "<why>"`. A save over budget is refused: shorten and save again. Other Hydras share owner memory, so a save refused for its revision means another Hydra saved first: list it again, merge and save.
6. If you are supervising with `hydra check`, save the last `through` you fully handled as `hydra memory set --key check-cursor --text "<through>"`.
7. Finish with one line: what you saved, what you dropped, and the characters now used in each layer. Forgotten and replaced entries stay in their logs.
