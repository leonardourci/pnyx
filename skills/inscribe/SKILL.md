---
name: inscribe
description: Use when you are Hydra and the owner says /inscribe or asks you to save what you learned, before a context reset or compaction, or when the digest says a memory is nearly full. Routes each fact to owner, project or Hydra memory and curates them; use with a project to save project context.
user-invocable: true
metadata:
  internal: true
---

# inscribe

Owner-memory writes use this Hydra's home polis. To read a polis, this Hydra must include it in its read list and appear on the polis's reader list or be covered by `*`. The home polis must also be readable for writes. By default, the home and read list both use `shared`. Use `owner memory move --key <key> --to <polis> --hydra <hydra>` to move a whole document or `project move <project> --polis <polis> --hydra <hydra>` to reassign project memory. If a move adds readers, repeat the command with `--propose` and wait for the owner's Confirm, even in bypass modes.

Keep saved context brief and up to date, and edit or remove entries when things change. Save each fact at the narrowest level that fits:

- Owner memory in named poleis (24000 characters per polis) holds the owner's `preferences`, general `learnings` about tools and workers, and standing instructions under `workers`. Each polis can hold 1500 characters of worker notes. New workers receive notes from the poleis their Hydra may read. Change the write polis's notes with `pnyx-axi owner worker-notes set --text "<whole document>" --reason "<why>"`.
- Project memory in one assigned polis, shared by attached Hydras that may read that polis (10000 characters): facts, conventions and owner preferences that hold only for that project.
- Hydra memory, this Hydra only (1500 characters): its scope, where it left off, its check cursor. Successful inscribe milestones track what has been read.

A fresh session and a session after compaction receive owner memory within a 3000 estimated-token budget and Hydra memory in full. Read `pnyx-axi owner memory list` when a decision needs omitted owner memory. A resumed session receives only changed digest sections, and later wakes carry a short memory-changed note. Project memory loads only on demand and for workers assigned to that project, so every line must earn its place.

When invoked with a project (`/inscribe <project>`), resolve it with `pnyx-axi project list --hydra <hydra>` and read `pnyx-axi project memory list --project <name|path> --hydra <hydra>`. Route facts, conventions and owner preferences specific to that project into its shared memory. All its documents share a 10000-character budget across Hydras; a nearly-full digest asks you to curate it. General owner preferences and learnings go to owner memory.

- `profile`: build/test/lint commands, PR rules, key skills and when to use them, main conventions. Refresh missing or out-of-date profiles from the default-branch sources listed by Pnyx, reading only changed files. Save with the listed `--sources <fingerprint>` so a source change cannot be acknowledged accidentally.
- `preferences`: the owner's preferences for this project. Keep them until the owner changes them; a profile refresh does not replace them.
- `learnings`: durable discoveries about this project, without task progress or history.

Save each document whole with `pnyx-axi project memory set --project <name|path> --key <profile|preferences|learnings> --text "<document>" --reason "<why>" --hydra <hydra>` (add `--sources <fingerprint>` for a profile). Use `project memory forget` with the project and key to remove a document. Over-budget saves are refused: shorten and retry. Replacements and removals stay in the project's append-only log. Finish the project pass with `project memory save` as described below, then report what changed and the project characters used.

Without a project, sweep for every layer: route project facts and project preferences as above, and curate owner and Hydra memory with the steps below.

1. Read the current memory with `pnyx-axi owner memory list` and `pnyx-axi hydra memory list --hydra <hydra>`. For owner-memory edits, use the documents under `writable` and the revision printed alongside them. The combined `memory` output is for reference. Pass the printed revision unchanged; it also guards against a home-polis change.
2. Start or resume the pass with `pnyx-axi hydra inscribe start --hydra <hydra>`. Keep its `milestone` ID and `through`, and run the history command it returns. It reads since the last successful inscribe, including the owner's messages, your replies read from your native transcripts, task briefs, intents and helper results. Helper results are historical context with their task and outcome status; unchanged waits and duplicate automated chat copies are omitted. Follow every `--after <cursor>` until `more` is false; each page ends at a whole message. When more follows, carry forward the facts from this page for your next update before finishing the pass. Keep the owner's messages and the briefs' standing rules:
   - Owner preferences: how the owner wants work done, standing decisions, people and tools they named. These hold until the owner changes them.
   - Learnings: facts you had to discover the hard way about tools, workers and routes, which would cost the next session time to rediscover. Each must still be true; check one you doubt before keeping it.
   - Hydra notes: what this Hydra covers and where it left off.
   - Leave out task progress, conversations, PRs and anything a task's history, brief or status already records. The exception is a standing rule the owner states with "always", "every" or "never": save it as a preference even when a brief also holds it, because the brief ends with its task.
3. Curate each document: merge duplicates, rewrite a changed preference in place, drop learnings that turned out wrong or are no longer needed, move a Hydra entry that belongs in its write polis into owner memory, and keep one plain line per entry, most important first. Normal learnings become stale after 30 days without confirmation or 10 memory saves without use, whichever comes first. Short-lived **for now** learnings become stale after 7 days or 3 unused saves. New lines default to normal. For new short-lived lines, save the whole learnings document with `--kind for-now --until <condition>`. Supply a task reference (`task:<hydra>/<task-key-or-id>`), a full PR URL, `version:<version>`, or `date:YYYY-MM-DD` (expires at midnight UTC). Pnyx checks task completion and followed PR merges against its saved state, and dates against the review time. Bring your own evidence for version conditions and for task or PR state Pnyx cannot verify.

   Review every stale or expired line in the writable documents. Confirm only with evidence from this session using `owner memory confirm --text "<exact learning line>" --reason "<session evidence>" --if-revision <revision>` or `project memory confirm --project <project> --text "<exact learning line>" --reason "<session evidence>"`. Confirmation refreshes the date and clears the unused-save count. Archive an unproven, outdated or expired line with `owner memory archive --text "<exact learning line>" --reason "<why>" --if-revision <revision>` or the project equivalent. `memory list` shows removed lines with the date and reason for recovery through a new set. Preferences stay undated and never decay.
4. When owner memory is nearly full, move clearly project-specific learnings into that project's memory before shortening or dropping useful facts. Resolve the attached project, read its memory, then run `pnyx-axi owner memory move --project <name|path> --text "<exact learning line>" --reason "<why this belongs to the project>" --if-revision <owner revision> --hydra <hydra>`. If the move widens access, repeat it with `--propose` and wait for the owner's Confirm. If the move exceeds the project budget, curate the project first. Reload both memories after a move before saving whole documents.

   Owner preferences are the owner's own words. Before moving any preference out of owner memory, ask the owner through a real `pnyx-axi task ask <task> --to owner --question "<preference and proposed project>"` and wait for the answer. Name the preference and destination project; a status update or rhetorical question is not approval. Keep it in owner memory until the owner approves.
5. Save each changed document whole, with a reason:

   ```sh
   pnyx-axi owner memory set --key preferences --text "<document>" --reason "<what changed>" --if-revision <revision>
   pnyx-axi owner memory set --key learnings --text "<document>" --reason "<what changed>" --if-revision <revision>
   pnyx-axi hydra memory set --key scope --text "<text>" --reason "<what changed>" --hydra <hydra>
   ```

   Pass the latest revision with each owner-memory write. Use the revision returned by the write, or list writable memory again if the command returns no revision.

   Before writing `left-off`, put each wait or next step on its own task: `task depend <task> --on <prerequisite>` for another task, `task ask <task> --to owner` for the owner, `task brief` for a next step, `task create` for untracked work. `left-off` then links those tasks as `[@Title](pnyx-task:<id>)` references and says what comes next; the timed review flags it once they are all done, or after 7 days.

   Forget keys that became stale with `owner memory forget --key <key> --if-revision <revision>` or `hydra memory forget --key <key> --hydra <hydra>`, each with `--reason "<why>"`. If a save exceeds the budget, shorten the document and retry. If the home polis revision changed, list its writable documents again and merge your edits before saving.
6. Save each memory layer you curated, even if its documents stayed the same. Use `pnyx-axi owner memory save --reason "<what you checked>" --if-revision <revision>` for the home polis and `pnyx-axi project memory save --project <project> --reason "<what you checked>" --hydra <hydra>` for the project. Pass `--used` once with the exact text of the learnings you used or confirmed in that layer during the session, one line per learning. Name the session evidence in the reason. The save refreshes those dates, clears their counts, and adds one unused save to every other learning in the layer. A set, read, wake or timed review never advances this count. Review any lines that reach their limit on this save and confirm or archive them before finishing.
7. Only after every history page is read and the saves above succeed, finish the milestone with `pnyx-axi hydra inscribe finish --key <id> --through <through> --hydra <hydra>`, using the pass snapshot returned in step 2. On failure, record `hydra inscribe fail --key <id> --error "<why>" --hydra <hydra>`; it leaves the previous boundary in place. If you are supervising with `hydra check`, save the last `through` you fully handled as `hydra memory set --key check-cursor --text "<through>"`.
8. During an agent switch, return silently. Otherwise finish with one line: what you saved, what you dropped, and the characters now used in each layer. Forgotten and replaced entries stay in their logs.
