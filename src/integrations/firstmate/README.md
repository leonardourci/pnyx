# firstmate

Reads configured Firstmate homes and turns their tasks into cards. Read-only: it never writes a home, never patches Firstmate and never looks at its backends (Paseo, Herdr, tmux).

- `status.ts`: parses `state/<task>.status` lines and folds keyed decisions the way Firstmate does (needs-decision and blocked open a key, resolved and captain-held close it, a ship or scout terminal line closes all).
- `home.ts`: reads `state/<task>.meta`, the status log and `data/backlog.md` into one observation per task: backlog title, repo tag, pull request, latest activity and open decisions.
- `sync.ts`: folds a home into the board through the single writer (one card per task, parented to the home's card, decisions as blocking attention), and watches `state/` and `data/` with `fs.watch`, reconciling on start and after a watcher error.
- `reply.ts`: sends a reply or decision answer through the home's own `bin/fm-send.sh <task> [--resolve-key <key>] <text>` with `FM_HOME` set, recording queued, delivered, delivery_unknown or failed receipts.
- `cli.ts`: the `pnyx-axi firstmate sync|watch` and `pnyx-axi reply` commands.
