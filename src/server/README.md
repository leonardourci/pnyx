# server

The local server started by `pnyx-axi serve` and stopped by `pnyx-axi stop`, SIGINT or SIGTERM. One per board.

- HTTP on 127.0.0.1, on `--port` or a random port. Every request must name the server by an exact `Host`, and a browser `Origin` must match it exactly.
- Writes: `POST /api/commands/<move|link|outcome|undo>` with `{"args": [...]}` and `Authorization: Bearer <token>`. They run the same CLI commands, under the same writer lock, so the board keeps one writer.
- Hook events: one JSON object per line on the board's `server.sock`. Each is put in the spool and drained through the CLI's spool ingestion; when the server is down, hooks spool and the server drains the spool on start.
- Browsers: one WebSocket at `/ws`. A snapshot on connect, then events by sequence. `/ws?after=<seq>` resumes; a cursor the server cannot continue from, or a `{"type":"resync"}` message, gets a fresh snapshot.
- The built web board from `dist/web`.

The server reads the log for appends from any writer, including the CLI, and pushes them.

Files: `server.json` (pid, port, url, socket) and `server.sock` in the board folder while it runs, and the per-install write token at `$PNYX_HOME/token` (mode 0600).
