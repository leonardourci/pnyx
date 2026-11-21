# Native file store

The file store is the persistence layer for the storage replacement. It keeps canonical state in memory and appends native facts to one Hydra log and one log per task. The current application still uses its Postgres store and the resumed home socket; connecting this interface and removing Postgres is the next migration step. There is no importer or automatic deletion of an existing home.

## Files and identity

```text
$PNYX_HOME/
└── hydras/<hydra>/
    ├── hydra.log
    ├── snapshot.json
    └── tasks/<task>/
        └── task.log
```

Each line is newline-terminated JSON. Its header is `n`, `at`, `by`, `t`, `id`, followed by the fact's fields. Numbers belong to each file, starting at one. No global event sequence or legacy event envelope is saved. The caller supplies the native ID, including the client or harness input ID for an owner message; the store keeps it unchanged.

The first Hydra fact is `config`; the first task fact is `created`. Task membership comes from the task folders, including when a snapshot lists a task that has since moved or omits a new task. The application creates task UUIDs. The store refuses a second task with the same ID anywhere in its open home.

Only the daemon opens the store for writing or recovery. Workers read files and append to their own `worker.log`; they must not use the daemon's log repair functions. The host owns the single daemon instance. The store does not acquire filesystem or database locks.

Within a process, opening the same canonical home twice refuses with `STORE_OPEN`, including through a symlink alias. `close()` releases that ownership after draining its queue, including when the final snapshot fails. The host must enforce the single daemon process when it connects this store to the application.

## Store interface

`openFileStore` takes a home and two synchronous pure reducers, `reduceHydra` and `reduceTask`. The home's parent must already exist; the store creates and durably publishes the home directory if needed. A reducer receives the scope's previous state, its ID and a numbered native fact. It validates that fact and returns plain JSON state. It performs no I/O, clock reads or random choices.

| Operation | Result |
|---|---|
| `createHydra({hydra, facts})` | Publishes a Hydra folder with its first facts. |
| `createTask({hydra, task, facts})` | Publishes a task folder under an existing Hydra. |
| `changeHydra({hydra, decide})` | Decides and appends Hydra facts in queue order. |
| `changeTask({hydra, task, decide})` | Decides and appends task facts in queue order. |
| `change({decide})` | Reads the durable queue prefix and validates every changed scope before appending a command’s facts. |
| `moveTask({from, to, task, id, at, by})` | Records the move and renames the task folder. |
| `hydras()` | Lists the native Hydras loaded in memory. |
| `read({hydra})` | Returns a copy of its state, task states, worker cursors and scope errors. |
| `locateTask({task})` | Resolves the task's current Hydra and folder. |
| `snapshot()` | Writes atomic snapshots after earlier queued writes finish. |
| `close()` | Stops accepting commands, drains earlier writes and snapshots the state. |

A decision receives its scope's state and a `read({hydra})` function for the staged home. It sees the preceding accepted decisions, including ones waiting in the same disk batch. A refused decision discards its draft without discarding adjacent valid commands.

The application integration must call `snapshot()` every five minutes when state has changed and call `close()` on a clean stop. That host schedule, runtime observation handling, socket transport, worker-file following, copy creation and Oracle indexing are outside this layer.

## Receipts and failures

One ordered queue collects commands for up to five milliseconds. The store appends each touched file once and calls `fdatasync` before resolving any receipt from the batch. A decision that reads another scope first commits pending writes, so a dependent fact cannot survive without the fact it read. A command that changes several scopes reads the durable prefix and validates all its scopes before any of its facts are appended. This starts a new batch when needed. A receipt contains the original native ID, its file's line number and its accepted timestamp.

Repeating an accepted ID with the same contents returns its original receipt with `duplicate: true`. A different timestamp is a retry of the same intent. Changing the contents or author role refuses with `IDEMPOTENCY_CONFLICT`. Accepted IDs follow a task when its folder moves and survive snapshots and restart.

An append or sync failure returns `WRITE_FAILED`, with no success receipt. Some complete lines may already be present. The store reloads and syncs those lines before accepting more commands; retrying their native IDs reconciles the uncertain write without duplicating it. If recovery also fails, further commands return `STORE_UNAVAILABLE` until the home can be reopened.

A failed `change()` may have persisted some scopes before another scope failed. Rerunning `decide` reads the recovered state and can choose different facts. Retry the original scope changes and facts with their native IDs, or independently verify completion in every scope before treating that command as complete.

A move first syncs a `moved` fact in the task log, then renames the folder and syncs both parents. Recovery validates the task's replay before completing an interrupted rename and reconciles directory syncs before recovered receipts can succeed. The directory is authoritative after rename. Retrying an older move returns its original receipt even if a later move changed the holder. General decisions cannot append move facts. Copy paths stored in task facts stay unchanged; the integration places worker copies outside Hydra folders.

## Snapshots and recovery

Snapshots contain state, accepted native IDs and the byte and line position covered in each log. They also keep the Hydra and task folded worker byte cursors. Their checksum covers the cached state and its positions. The store validates that cache before using its offsets for reads or repairs. A malformed, unsupported, unreadable or changed cache falls back to the logs, as does a snapshot path that points to a symlink or another nonregular file. A valid cache replays only each file's tail; a task absent from the cache is read from its first line.

Worker facts carry `off`, the byte immediately after the consumed worker line. A new worker fact advances that cursor strictly; a retry uses the same native ID. The cursor is rebuilt from native facts if the snapshot is absent.

The daemon truncates an unterminated final line or invalid JSON at the end of a log. Corruption before the tail in bytes that replay reads reports the file and byte position as `LOG_CORRUPT`. Bytes covered by a valid snapshot are not reread on open, so corruption in them is not reported then. A permission-denied canonical log reports `LOG_UNREADABLE`. The affected task remains visible with an error and refuses changes; other healthy tasks continue. A corrupt Hydra log refuses changes to that Hydra. Legacy folders without `hydra.log` are left untouched.
