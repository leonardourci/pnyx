---
name: review-code
description: Review a Pnyx diff or branch for correctness, repository conventions, failure handling and behavioral coverage before a PR.
---

# Review code

Use this checklist yourself or ask another reviewer to inspect the diff. Read first, record findings, then fix them. A review does not authorize commits, pushes or merges.

- [ ] Establish the scope: read the intended behavior, `AGENTS.md`, and the diff against the PR's target branch, including uncommitted changes. For `web/`, also read `.agents/skills/write-front-end/SKILL.md`.
- [ ] Trace each changed path from input to observable result, including empty input, invalid input, failures, cancellation and recovery. Check permissions at the write boundary and preserve useful error feedback.
- [ ] Check Pnyx's boundaries: only `pnyx-axi` writes Hydra state; the event log stays append-only; the reducer stays pure and deterministic; snapshots and Oracle indexes stay derived. Hooks stay silent, fast and exit 0. Integrations use their own supported read and reply interfaces.
- [ ] Keep one owner for each fact and one place for each shared decision. Remove dead code and unreachable fallbacks. Avoid speculative abstractions, dependencies and duplicated state. Keep feature code in its feature folder.
- [ ] Check types and function contracts. Functions take one destructured object parameter, except no-argument functions and external API contracts. TypeScript stays erasable. Casts and non-null assertions must not conceal an unchecked value.
- [ ] Check timers, watchers, locks and subprocesses for cleanup on failure and shutdown. Preserve ordering, retry limits and session ownership across asynchronous work.
- [ ] For UI changes, check loading, empty and error states, keyboard access and the existing UI primitives. Use Hydra, Oracle and inscribe consistently.
- [ ] Match changed behavior to tests using `audit-tests`. Read the assertions; a test name alone proves nothing. Check docs and CLI hints describe the resulting behavior.
- [ ] Review comments and prose using `deslop`. Keep comments that explain a constraint or non-obvious reason; remove narration and stale claims.
- [ ] Run `pnpm verify` for the branch's checks. Respect any explicit test hold and report skipped checks as pending. Fix reported lint issues, review automatic edits, commit and push through the approved workflow, then rerun on the clean PR head.

Record each finding with severity, file and line, the failing behavior or violated rule, and a suggested fix. Bugs and explicit rule violations must be resolved; explain any declined recommendation. Record checks run and remaining gaps. Once complete, tick **Ran `review-code`** in the PR and describe what you fixed (or say no findings).

For an agent: perform the checklist yourself when assigned the review; do not merely tell the developer to do it. Report findings before editing when asked only to inspect.
