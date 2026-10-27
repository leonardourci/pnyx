---
name: deslop
description: Remove AI-style wording, em dashes and needless complexity from Pnyx text, including code comments, docs, UI copy, PR descriptions and commit messages.
---

# Deslop

Apply this checklist to the changed text, whatever its format. Preserve facts, contracts, necessary caveats and the writer's intended meaning. Leave licenses, attributed quotations and external protocol data intact.

- [ ] Read as someone who did not see the conversation. Lead with the concrete problem, action or result. Remove drafting history, assistant chatter, self-praise and summaries that repeat the preceding paragraph.
- [ ] Replace vague claims and AI filler (“delve”, “leverage”, “seamless”, “robust”, “it is worth noting”, “this PR aims to”) with plain words and specific facts. Do not add claims the evidence does not support.
- [ ] Remove em dashes from authored text. Use a period, comma, colon or parentheses that fits the sentence. Keep punctuation natural rather than mechanically replacing every dash with a hyphen.
- [ ] Cut contrastive slogans, invented labels, unnecessary headings and repeated explanations. Keep lists when they help someone follow steps or compare parallel facts.
- [ ] Keep each prose paragraph on one source line. Use line breaks for lists, code and separate paragraphs.
- [ ] In code comments, retain non-obvious reasons, invariants, compatibility constraints and useful public contracts. Remove narration, step numbers, signature paraphrases, stale claims and comments that repeat test names. Prefer clearer names when they carry the meaning.
- [ ] When code is in scope, remove dead branches, unused scaffolding and one-use wrappers that obscure the operation. Avoid introducing abstractions or dependencies just for cleanup. Keep useful collection methods, concurrent work and declarative rendering.
- [ ] Preserve error visibility, ordering, cancellation, retries, cleanup and permissions. A wording pass must not quietly change behavior or hide a failure.
- [ ] Check Pnyx vocabulary and update stale usage guidance in the root README. Use Hydra, Oracle and inscribe; keep other terms plain.
- [ ] Read the final diff, including the PR description and proposed commit messages. Run `git diff --check`; for executable changes run focused checks and `pnpm verify` as allowed. A prose-only cleanup needs no new behavior tests.

## Code cleanups

A cleanup removes complexity the job didn't ask for without changing what the code does. [follow-conventions](../follow-conventions/SKILL.md) holds the target style.

- [ ] Unpack cryptic shorthand in new and changed code into plain named steps: conditional spreads (`...(x ? { a } : {})`), logical assignment picking a value (`??=`, `||=`, `&&=`), `||` or `??` defaults whose case the names don't make obvious, a bare `void` on a promise, `.then` chains and `for (;;)` or `while (true)` waits. Keep every arm's outcome: a `|| 'none'` that fires on an empty list becomes a named empty-list check. Existing uses elsewhere are not rewritten.
- [ ] Leave declarative shapes alone: `map`, `filter` and `reduce`, `Promise.all` over independent work and conditional JSX are not slop. Don't turn them into loops.
- [ ] Remove indirection; don't add it. No new abstraction, helper layer or dependency to make a pattern look cleaner. A named helper still belongs where it names a distinct read, decision or write, or one decision used in several places. A one-off fallback stays a local `try`/`catch` at that spot.
- [ ] Keep every path's outcome. When a `.catch(() => fallback)` becomes `try`/`catch`, the fallback value and the errors that reach it stay the same. Serialized work stays serialized, independent work stays concurrent, and retries, cleanup in `finally` and the message the user sees stay as they were.
- [ ] Keep the diff small and mechanical, one logical change per commit, so a reviewer can compare old and new arm by arm. Update or delete guidance the cleanup made stale in the same change.
- [ ] Scan what you added for new shorthand: `git diff origin/main -U0 -- '*.ts' '*.tsx' | grep -E '^\+.*(\.then\(|\bvoid [a-zA-Z(]|\?\?=|\|\|=|&&=|\.\.\.\(|for \(;;\)|while \(true\))'`. Name any you keep on purpose in the PR, with its reason.

Record meaningful fixes and any intentional exception. Once complete, tick **Ran `deslop`** in the PR and note what you changed (or say no findings).

For an agent: edit the assigned text yourself, keep the author's meaning, and report any validation gap honestly. This checklist grants no extra authority to commit, publish or send text.
