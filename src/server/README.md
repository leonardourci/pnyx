# server

The local server started by `pnyx-axi serve` and stopped by `pnyx-axi stop`, SIGINT or SIGTERM. One per board.

- HTTP on 127.0.0.1, on `--port` or a random port, for the built web board from `dist/web` and `GET /health` (`{"board","pid"}`). Every request must name the server by an exact `Host`, and a browser `Origin` must match it exactly. The served `index.html` carries the per-install token in `<meta name="pnyx-token">`.
- Browsers: one WebSocket at `/ws?token=<token>`, for updates, commands and receipts. A snapshot on connect, then events by sequence. `&after=<seq>` resumes; a cursor the server cannot continue from, or a `{"type":"resync"}` message, gets a fresh snapshot.
- Writes: `{"type":"command","id":"<id>","name":"<move|link|outcome|undo>","args":[...]}` on the socket, answered by `{"type":"receipt","id":"<id>",...}` or `{"type":"error","id":"<id>","error","code","help"}`. They run the same CLI commands, under the same writer lock, always on the server's board (`--board` is refused), with actor `web` unless `--actor` is given.
- Hook events: one JSON object per line on the board's `server.sock`. Each is put in the spool and drained through the CLI's spool ingestion; when the server is down, hooks spool and the server drains the spool on start.

The server reads the log for appends from any writer, including the CLI, and pushes them.

Files: `server.json` (pid, port, url, socket) and `server.sock` in the board folder while it runs, and the per-install token at `$PNYX_HOME/token` (mode 0600), which local programs read for the handshake. `server.json` counts only while its port answers `/health` with the same board and pid.
