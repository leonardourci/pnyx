---
name: pnyx-hydra-columns
description: Use when you are Hydra and are about to move or reorder a card, or create, rename, describe, reorder, delete or resize a Hydra column.
---

# Hydra columns

Each column's description says when and why work goes there; the digest prints them, and `pnyx-axi column list --hydra <hydra>` reads them again after a column change.

## Move a card

Pnyx places cards through the operation that owns the phase change: successful start and queue handoff record working at once; continue and delivered replies resume eligible work; paused and detach park unfinished work. Owner questions, permission requests, blocked declarations and confirmed ready pull requests under owner-merge rules go to Needs you. Answering the matching gate restores the previous phase unless another owner gate remains. Checked done declarations and merges place completed work in Done. Silence, idle turns and exits never declare completion. Manual placement holds until the next lifecycle phase change, and custom columns without a role stay put. On Firstmate-linked Hydras, Firstmate's records own placement. Use `move` only for an owner request or an exceptional correction with a reason.

```sh
pnyx-axi move <task> <column> --reason "<why>" --hydra <hydra>
```

Inspect the proposed action, then repeat the command with `--confirm <token>`.

Rely on the worker's checked done declaration or Pnyx's merge transition. If completion evidence is missing, ask the worker to record it and declare the result. Do not repeat its status or move the card to Done yourself. Passing local checks alone is not completion.

## Change columns

- `column create --title "<name>" --description "<when and why>"`, `column rename <id> --title "<name>"` and `column describe <id> --description "<when and why>"` maintain the columns.
- `column reorder <id> --before <id>` moves a column; `column delete <id> --to <remaining-id>` deletes it and places its cards in the destination. A Firstmate-linked Hydra's default columns cannot be deleted.
- Moves and deletes first return `confirmation: needed` and a token: inspect the action and repeat the exact command with `--confirm <token>`. A changed target needs a new confirmation.
- `column resize <id> --width <pixels>` and `hydra resize --width <pixels>` change widths; `layout show` reports them and their defaults, and `layout reset` restores the default widths.

Pass `--hydra <hydra>` and `--reason "<why>"` on each.
