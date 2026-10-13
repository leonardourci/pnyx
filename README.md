# Pnyx

A deterministic board of every agent and its work, with an [AXI](https://axi.md/) CLI named `pnyx-axi`.

Pnyx shows your coding agents as cards on one board (Needs you, Workers on it, Review, Done) and queues your replies to them. It is a view over the tools you already use, not an orchestrator: Claude Code and Codex hooks report sessions, a Firstmate integration reads Firstmate's own records, and linked pull requests come from GitHub. Every change is an event in an append-only log, so the board can be replayed and audited.

## Status

Pre-v1. This repository holds the project template and a first CLI slice: `pnyx-axi` prints an empty board and `pnyx-axi --help` prints help. The event log, sources and web board land next. See [docs/design.md](docs/design.md).

## Try it

```sh
pnpm install
pnpm run build
node dist/cli/pnyx-axi.js
```
