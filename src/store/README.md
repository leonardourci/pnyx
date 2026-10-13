# store

Per-board files under `~/.pnyx/boards/<board>/` (or `$PNYX_HOME/boards/<board>/`):

- `events.jsonl`: the canonical history. Append-only and never rewritten.
- `snapshot.json`: a cache rebuilt from the log, replaced atomically.
- the writer lock that keeps `pnyx-axi` the only writer.
- the hook spool: an ingress buffer for events sent while the service is down. It is not a second writer of `events.jsonl`.
