# Pnyx

A deterministic board of every agent and its work, with an [AXI](https://axi.md/) CLI named `pnyx-axi`.

Pnyx shows your coding agents as cards on one board (Needs you, Workers on it, Review, Done) and queues your replies to them. It is a view over the tools you already use, not an orchestrator: Claude Code and Codex hooks report sessions, a Firstmate integration reads Firstmate's own records, and linked pull requests come from GitHub. Every change is an event in an append-only log, so the board can be replayed and audited.

## Status

Pre-v1. `pnyx-axi` keeps each board as an append-only event log with a rebuildable snapshot; cards come from `pnyx-axi push`, from Claude Code and Codex hooks (`pnyx-axi setup hooks`) and from `pnyx-axi firstmate sync|watch`, are edited with `move`, `link`, `outcome` and `undo`, and Firstmate tasks take replies with `reply`, `search` finds past work across titles, links, events, notes and transcripts, and `harvest` collects the summaries, decisions and context that transcripts, Firstmate records and linked pull requests already hold onto each card (run `pnyx-axi --help`). `pnyx-axi serve` runs the local server that takes hook events and pushes board changes to browsers over a WebSocket. The web board provides filters, conversations, reply receipts, inline custom columns, resizable panes, event-backed settings and full-text history. The GitHub source remains pending. See [docs/design.md](docs/design.md).

## Try it

```sh
pnpm install
pnpm run build
node dist/cli/pnyx-axi.js
node dist/cli/pnyx-axi.js serve
```

Open the local URL printed by `serve`. To enable replies, explicitly configure each
Firstmate home with `serve --home <path>`; browser commands cannot add homes.
Sessions without a configured input route remain readable and retain draft replies.
Harness command catalogs and listener-presence signals are not exposed by the current
adapters, so the board reports them unavailable instead of inventing them.

Run `pnpm run lint` and `pnpm test` for deterministic verification. `pnpm test:web`
uses `chrome-devtools-axi` for a real browser smoke test with a temporary `PNYX_HOME`,
a random port, synthetic transcripts and a fake Firstmate send script. Set
`PNYX_EVIDENCE_DIR` to an outside-repository directory to keep its screenshots.
