---
name: follow-conventions
description: Coding conventions for Pnyx code that AGENTS.md and ESLint do not already state, such as early-return guards, named constants, plain named steps, HydraError failures, one decision in one place, behavior-preserving refactors and installed-version APIs. Read before writing or reviewing Pnyx code.
---

# Follow conventions

`AGENTS.md` holds the layout, design rules and the one-object-parameter rule, and `pnpm run lint` enforces formatting. This skill adds the rest. Cleaning up code that drifted from these rules is [deslop](../deslop/SKILL.md).

## Control flow

- Put guard clauses first: check invalid cases at the top, `return` or `throw`, and let the main flow read after them without extra indentation.
- In new code, avoid nesting ternaries: a second level of branching reads better as a small named helper.
- Write conditions in their positive form. A `const skip = !known` flag feeding an inverted branch makes the reader flip it twice.
- Delete dead branches: an arm an earlier guard handled, a check on an already narrowed value, a fallback no caller can reach.

## Names and values

- Give a value with meaning (a timeout, a limit, a retry count, a cutoff) a named constant, declared after the imports, and share it between every site that uses it. Structural literals such as a `0` index need no name.
- Name each meaningful intermediate value. Avoid vague names (`tmp`, `data`, `res`, `obj`) and long `&&` or `||` chains inside one condition; name the checks instead. [review-code](../review-code/SKILL.md) lists the shorthand new code never uses, such as conditional spreads and `??=`.
- Pass a function directly when a callback only forwards its argument: `.map(toRow)`, not `.map(card => toRow(card))`.

## Decisions and errors

- Write a rule the code checks in more than one place once, as a named helper every site imports.
- Throw a `HydraError` with its code at the failure site; `guard()` turns it into the CLI's structured error. A `catch` that doesn't recognize an error rethrows it.
- Never drop an error to make code tidy. A deliberate fire-and-forget says in a short comment why losing the failure is safe.

## Changes

- A refactor changes form, never outcomes: every input path keeps its result, guard order, side effects and error. Run `pnpm run lint` after each structural edit.
- Write library and Node calls from the installed version's types, not from memory, and avoid deprecated APIs. Node 22.13 is the floor.
- Comment only for a non-obvious reason or constraint that no name can carry; rename instead of explaining.
- A change to behavior, CLI output or setup updates its docs, CLI help and shipped skills in the same change.
