---
name: inscribe
description: Use when you are Hydra and the owner says /inscribe or asks you to save what you learned, before a context reset or compaction, or when the digest says Hydra memory is nearly full. Curates and saves the Hydra's owner preferences and learnings.
---

# inscribe

Leave the next session a short, current map instead of a growing journal. Memory is printed into every digest and all of it shares one budget (6000 characters), so every line must earn its place.

1. Read the current memory: `pnyx-axi hydra memory list --hydra <hydra>` (it shows the characters used).
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
