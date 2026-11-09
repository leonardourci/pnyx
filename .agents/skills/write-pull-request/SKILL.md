---
name: write-pull-request
description: Write or update a Pnyx pull request description, including Intent, Problem, Fix, Validation and Review. Read before opening a PR or changing its title or body, and after every push to keep the description true to the final diff.
---

# Write a pull request

Use the [PR template](../../../.github/pull_request_template.md) and the checks in [CONTRIBUTING.md](../../../CONTRIBUTING.md#pull-requests-and-checks). Write for a reviewer who has not seen the conversation.

- [ ] **Intent:** follow the template's Intent guidance before describing the problem.
- [ ] **Problem:** explain what is wrong or missing and who it affects. Include discovery context only when it helps explain the failure.
- [ ] **Fix:** describe the resulting behavior and material limits. Cover the whole diff against the PR's base; a stacked PR describes only its own change. Link any agreed design or issue needed to judge it.
- [ ] **Validation:** name the checks actually run and their results. State failures, skipped checks and pending checks honestly. For each new or changed test, record the behavior or past bug it guards and the flip result required by [audit-tests](../audit-tests/SKILL.md). Include before/after media for visible changes; say when there is no visible UI change.
- [ ] **Review:** record findings and fixes, or no findings, from each required checklist in order. Tick only completed, required boxes. The boxes alone do not replace the review results.
- [ ] Remove the template placeholders. Keep all five headings, each with substantive text; hidden comments and examples do not count. `pnpm verify` checks structure, not whether the claims are true.
- [ ] After every push, compare the description with the final diff and current validation. Rewrite stale claims, changed scope and validation gaps. Preserve the hidden verification marker and the review boxes; rerun `pnpm verify` on the pushed head after editing the body.
- [ ] Read the final title, body and changed code comments using [deslop](../deslop/SKILL.md). Use plain English, keep enough context to assess the change and remove session history.

## File structure changes

For a PR that adds, moves, splits, renames or deletes files, put one combined tree in a fenced code block inside **Fix**. Show folders, subfolders and their files together, replacing path lists and separate before/after trees. PRs that only edit existing files do not need a tree.

- [ ] Give each file one line with a short note on what it holds. Siblings that share a note may share a line, joined with ` · `.
- [ ] Mark new files with `+`, moved or renamed files with `⇐` and `(from old/path)` in the note, and removed files with `-`. For splits or merges, show the resulting files and their source in the notes; include the removed source if it no longer exists.
- [ ] Add `~N` for a file's approximate line count after the change when useful. Collapse unchanged files to one line such as `(other files unchanged)`.

Example:

```text
src/
├── app/
│   ├── host.ts ~600                 wiring only after the split
│   ├── +live-sessions.ts            agent processes (from app/host.ts)
│   ├── +server-clients.ts           client connections (from app/server.ts)
│   ├── server.ts ~400               mount, event pump, shutdown
│   ├── -legacy-clients.ts           removed obsolete client handling
│   └── (other files unchanged)
└── hydra/
    ├── +send-cli.ts · +history-cli.ts  send and history commands
    └── operations.ts ⇐              stop, outage, retry (from app/operations.ts)
```
