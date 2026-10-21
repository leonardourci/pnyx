---
name: inscribe
description: Use when you are Hydra and the owner says /inscribe or asks you to save what you learned, before a context reset or compaction, or when the digest says Hydra memory is nearly full. Curates Hydra memory and shared project profiles, project preferences and learnings; use with a project to save project context.
---

# inscribe

Leave the next session a short, current map instead of a growing journal. Hydra memory is printed into full session digests and shares one budget (6000 characters), so every line must earn its place.

When invoked with a project (`inscribe <project>`), resolve it with `pnyx-axi project list --hydra <hydra>` and read `pnyx-axi project memory list --project <name|path> --hydra <hydra>`. Route facts, conventions and owner preferences specific to that project into its shared memory. All its documents share a 3000-character budget across Hydras; a nearly-full digest asks you to curate it. General owner preferences keep their current home; this does not move them.

- `profile`: build/test/lint commands, PR rules, key skills and when to use them, main conventions. Refresh missing or out-of-date profiles from the default-branch sources listed by Pnyx, reading only changed files. Save with the listed `--sources <fingerprint>` so a source change cannot be acknowledged accidentally.
- `preferences`: the owner's preferences for this project. Keep them until the owner changes them; a profile refresh does not replace them.
- `learnings`: durable discoveries about this project, without task progress or history.

Save each document whole with `pnyx-axi project memory set --project <name|path> --key <profile|preferences|learnings> --text "<document>" --reason "<why>" --hydra <hydra>` (add `--sources <fingerprint>` for a profile). Use `project memory forget` with the project and key to remove a document. Over-budget saves are refused: shorten and retry. Replacements and removals stay in the project's append-only log. Finish with what changed and the project characters used.

Without a project, sweep for both kinds of memory: route project facts and project preferences as above, and curate Hydra-specific knowledge with the steps below.

1. Read the current Hydra memory: `pnyx-axi hydra memory list --hydra <hydra>` (it shows the characters used).
2. Sweep this session for what exists only in the conversation:
   - Owner preferences: how the owner wants work done, standing decisions, people and tools they named. These hold until the owner changes them.
   - Learnings: facts you had to discover the hard way about projects, tools, workers and routes, which would cost the next session time to rediscover. Each must still be true; check one you doubt before keeping it.
   - Leave out task progress, conversations, PRs and anything a task's history, brief or status already records.
3. Curate each document: merge duplicates, rewrite a changed preference in place, drop learnings that turned out wrong or are no longer needed, and keep one plain line per entry, most important first. Add a date in parentheses to a learning that may expire.
4. Save each changed document whole, with a reason:

   ```sh
   pnyx-axi hydra memory set --key preferences --text "<document>" --reason "<what changed>" --hydra <hydra>
   pnyx-axi hydra memory set --key learnings --text "<document>" --reason "<what changed>" --hydra <hydra>
   ```

   Forget other keys that became stale with `pnyx-axi hydra memory forget --key <key> --reason "<why>" --hydra <hydra>`. A save over budget is refused: shorten and save again.
5. If you are supervising with `hydra check`, save the last `through` you fully handled as `hydra memory set --key check-cursor --text "<through>"`.
6. Finish with one line: what you saved, what you dropped, and the characters now used. Forgotten and replaced entries stay in the event log.
