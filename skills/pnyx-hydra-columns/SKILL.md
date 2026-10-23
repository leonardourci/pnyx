---
name: pnyx-hydra-columns
description: Use when you are Hydra and are about to move or reorder a card, or create, rename, describe, reorder, delete or resize a Hydra column.
---

# Hydra columns

Each column's description says when and why work goes there; the digest prints them, and `pnyx-axi column list --hydra <hydra>` reads them again after a column change.

## Move a card

Pnyx moves a task's card when its lifecycle changes explicitly: a `working` declaration to In progress, an open permission request or question, or a `needs_you` or `blocked` declaration, to Needs you, and a `done` declaration or outcome to Done. Once the ask is answered the card returns to In progress. A finished turn, silence or an exit moves nothing, `paused` leaves the card where it is, and a card in a column without a role (one the owner made) stays put. Each such move appears in the task's history with its reason, so do not repeat it. Move a card yourself only when its own agent does something else that calls for it, using the column descriptions; the owner's manual placement holds until the next lifecycle change. For an agent's question, answer it through the card when you can. On a Firstmate-linked Hydra, Pnyx moves cards between the five default columns (Queued, In progress, Needs you, Parked, Done) from Firstmate's records, so leave those moves to it.

```sh
pnyx-axi move <task> <column> --reason "<why>" --hydra <hydra>
```

Inspect the proposed action, then repeat the command with `--confirm <token>`.

When a worker reports completion, use `task status <task> done` so Pnyx checks that the work landed by its project's rule, then let its lifecycle move the card. Passing local checks alone is not completion; `move <task> done` is placement, not a substitute for those landing checks.

## Change columns

- `column create --title "<name>" --description "<when and why>"`, `column rename <id> --title "<name>"` and `column describe <id> --description "<when and why>"` maintain the columns.
- `column reorder <id> --before <id>` moves a column; `column delete <id> --to <remaining-id>` deletes it and places its cards in the destination. A Firstmate-linked Hydra's default columns cannot be deleted.
- Moves and deletes first return `confirmation: needed` and a token: inspect the action and repeat the exact command with `--confirm <token>`. A changed target needs a new confirmation.
- `column resize <id> --width <pixels>` and `hydra resize --width <pixels>` change widths; `layout show` reports them and their defaults, and `layout reset` restores the default widths.

Pass `--hydra <hydra>` and `--reason "<why>"` on each.
