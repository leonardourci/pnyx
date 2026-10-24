---
name: pnyx-hydra-columns
description: Use when you are Hydra and are about to move or reorder a card, or create, rename, describe, rule, reorder, delete or resize a Hydra column.
---

# Hydra columns

Each column has a rule that code applies without a model. The digest and `pnyx-axi column list --hydra <hydra>` print the rules and descriptions. When the owner asks for a column change, write or update its rule so future events and commands place cards there automatically.

## Move a card

Pnyx computes facts from the recorded worker state, owner questions, discussion hold, pull requests, task kind, completion, reminders and queue. The first column in display order with a matching rule wins. Successful starts and queue handoffs record working; owner questions, permissions, merge and go questions, or due reminders go to Needs you. Worker `needs_you` and `blocked` notes stay In progress for Hydra to resolve. A worker paused for checks stays In progress; an owner pause or an ended worker with unfinished work goes to Parked. Held work stays in Backlog (the Queued role), marked Talking, until a real go question puts it in Needs you. Checked done declarations and all non-abandoned linked pull requests merging place completed work in Done. A finished turn or successful session never declares completion. On Firstmate-linked Hydras, Firstmate's records own placement.

Use `move` for an owner request or an exceptional correction with a reason. A manual placement, including one in a custom column, holds until the next change in the matching rule's destination. Ordinary activity, repeated status notes and edits that match the same destination leave it alone.

```sh
pnyx-axi move <task> <column> --reason "<why>" --hydra <hydra>
```

Inspect the proposed action, then repeat the command with `--confirm <token>`.

Rely on the worker's checked done declaration or Pnyx's merge transition. If completion evidence is missing, ask the worker to record it and declare the result. Do not repeat its status or move the card to Done yourself. Passing local checks alone is not completion.

## Change columns

Use `column rule <id> --when "<fact>[,<fact>]" --reason "<why>"` to replace a column's rule. Commas mean AND; repeat `--when` for OR. Prefix a fact with `!` to negate it. Use `--clear` instead of `--when` for manual placement only. Inspect the confirmation's rules and affected cards before repeating it with its token. New custom columns start manual only; put a custom column before broader matching columns when it should win.

Facts:
- `worker:none`, `worker:working`, `worker:checks`, `worker:blocked`, `worker:hydra`, `worker:paused`, `worker:ended`;
- `owner-question`, `held`, `reminder-due`, `queued` (queued behind a worker), `done`;
- `pr:none`, `pr:draft`, `pr:open`, `pr:pending`, `pr:green`, `pr:red`, `pr:merged`, `pr:closed`;
- `kind:build`, `kind:investigation`.

Pull request facts can coexist, including facts from different linked pull requests. Green and red require recorded checks; an absent summary is neither. Keep Needs you for real owner questions and reminders, and keep held work in Backlog. Exclude those facts when writing a broader custom rule:

```sh
pnyx-axi column rule custom:research --when "kind:investigation,!done,!held,!owner-question,!reminder-due" --reason "Keep investigations together" --hydra <hydra>
```


- `column create --title "<name>" --description "<when and why>"`, `column rename <id> --title "<name>"` and `column describe <id> --description "<when and why>"` maintain the columns.
- `column reorder <id> --before <id>` moves a column; `column delete <id> --to <remaining-id>` deletes it and places its cards in the destination. A Firstmate-linked Hydra's default columns cannot be deleted.
- Card moves, column reorders, rule edits and deletes first return `confirmation: needed` and a token: inspect the action and repeat the exact command with `--confirm <token>`. A changed target needs a new confirmation.
- `column resize <id> --width <pixels>` and `hydra resize --width <pixels>` change widths; `layout show` reports them and their defaults, and `layout reset` restores the default widths.

Pass `--hydra <hydra>` and `--reason "<why>"` on each.
