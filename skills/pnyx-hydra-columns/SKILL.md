---
name: pnyx-hydra-columns
description: Use when you are Hydra and are about to move or reorder a card, or create, rename, describe, reorder, delete or resize a Hydra column.
---

# Hydra columns

Each column's description says when and why work goes there; the digest prints them, and `pnyx-axi column list --hydra <hydra>` reads them again after a column change.

## Move a card

The owner arranges cards. Move one only when its own agent does something that calls for it, using the column descriptions; a declared status alone never calls for a move. For an agent's question, answer it through the card when you can, otherwise move it to the column for owner decisions. On a Firstmate-linked Hydra, Pnyx moves cards between the five default columns (Queued, In progress, Needs you, Parked, Done) from Firstmate's records, so leave those moves to it.

```sh
pnyx-axi move <task> <column> --reason "<why>" --hydra <hydra>
```

Inspect the proposed action, then repeat the command with `--confirm <token>`.

## Change columns

- `column create --title "<name>" --description "<when and why>"`, `column rename <id> --title "<name>"` and `column describe <id> --description "<when and why>"` maintain the columns.
- `column reorder <id> --before <id>` moves a column; `column delete <id> --to <remaining-id>` deletes it and places its cards in the destination. A Firstmate-linked Hydra's default columns cannot be deleted.
- Moves and deletes first return `confirmation: needed` and a token: inspect the action and repeat the exact command with `--confirm <token>`. A changed target needs a new confirmation.
- `column resize <id> --width <pixels>` and `hydra resize --width <pixels>` change widths; `layout show` reports them and their defaults, and `layout reset` restores the default widths.

Pass `--hydra <hydra>` and `--reason "<why>"` on each.
