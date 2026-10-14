# store

Per-board files under `~/.pnyx/boards/<board>/` (or `$PNYX_HOME/boards/<board>/`):

- `events.jsonl`: the canonical history. Append-only and never rewritten.
- `events.jsonl.torn-<offset>`: a torn tail copied aside by `pnyx-axi repair`, which then closes the line with an appended `log.repaired` marker instead of truncating the log.
- `snapshot.json`: a cache rebuilt from the log, replaced atomically.
- the writer lock that keeps `pnyx-axi` the only writer.
- the hook spool (`spool/`): an ingress buffer for events sent while the service is down, one JSON file each, either a raw hook payload or a push with an explicit key. It is not a second writer of `events.jsonl`; a file that cannot be ingested is renamed `*.rejected`.
- `search.db`: the derived full-text search index; see [../search/README.md](../search/README.md).
- `server.json` and `server.sock` while a board server runs; see [../server/README.md](../server/README.md).
