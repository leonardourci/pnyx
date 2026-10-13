# Pnyx design

Pnyx is a deterministic board of every agent and its work, with an AXI CLI named `pnyx-axi`. It is a view and a reply queue over existing tools. It does not orchestrate, dispatch or supervise agents.

## Sources

Two integrations ship in v1.

1. **Harness hooks are the universal source of cards.** A one-time `pnyx-axi setup hooks` installs owned user-level command hooks for Claude Code and Codex (more harnesses later), keeping existing entries. New and resumed sessions in any folder become cards through lifecycle events. SubagentStart/SubagentStop give children their own IDs and parent references; a logical child can share its parent's terminal.
2. **Firstmate records cover managed work.** Pnyx reads only configured Firstmate homes: status logs, metadata, backlog and decision records. Titles come from the backlog. It follows Firstmate's file schemas and keyed-resolution semantics, never inspects backend endpoints and never patches Firstmate. Replies and decision answers go through Firstmate's own send command, with an explicit `FM_HOME`, task ID and resolve key for an answered decision.

Firstmate can launch some workers with hooks disabled, so hooks alone cannot cover them; the Firstmate source supplies their task facts without changing the launch policy. Firstmate's durable inbox delivery, handled receipts and native invocations stay separate facts.

Paseo, Herdr and tmux are optional later enrichments for location, native thread access or typing. A plain terminal inventory does not create cards. Hooks cover local sessions where user hooks are enabled; they cannot discover a session that was already running until it sends a supported event, and they cannot override disabled hooks. Missing coverage is shown explicitly. Firstmate's initial file snapshot imports its existing tasks.

## Silent reporting and push delivery

Reporting hooks print nothing to stdout or stderr, always exit 0, and enqueue one small event through a local socket without waiting for a browser, model or network call. When the service is down they spool locally and ingestion later deduplicates by event ID. The hook path has a millisecond latency target, to be measured, not a promise. A small bounded helper runs instead of a full CLI start on every hook. Failure diagnostics are local and bounded; if storage also fails, Pnyx records a coverage gap when it can rather than claiming lossless delivery or blocking the agent.

A session-start board summary is opt-in and off by default. Claude Code adds SessionStart and UserPromptSubmit stdout to the model's context, so the ordinary reporter must never print. Only the separately enabled context hook emits that payload. Codex payloads need their own version-tested adapter.

| Source | Update route |
|---|---|
| Harness hooks | Local socket, fallback spool; session, turn, permission, child and tool events |
| Firstmate files | FSEvents on configured records; parse changed files and fold facts |
| Optional Paseo / Herdr | Source push stream, capability-checked |
| Optional tmux | Native hooks for terminal changes; harness hooks supply agent state |
| Local service to browser | One WebSocket per tab for updates, commands and receipts |
| Linked open pull requests | The only recurring external poll: `gh-axi`, about once a minute |

Startup, reconnect and detected watcher gaps trigger focused reconciliation, not periodic inventory scans. Watch directories so atomic file replacement is seen. Keep watcher cursors and rescan the configured scope when a dropped or coalesced event requires it. A surface without push support reports itself unavailable rather than silently adding polling.

A post-tool hook that sees a recognized `gh pr create`/`merge`, its `gh-axi` equivalent, or a deploy command queues an immediate update. Parse structured invocation and result data; never execute captured command text. A command sighting is a refresh hint, not proof of a merge or deployment: verify the result or refresh the linked record through `gh-axi`. New links get one initial read; the timer refresh covers only confirmed open linked pull requests, stops at closure and resumes on evidence of reopening. There is no hidden poll of closed records and no broad GitHub discovery. Cache duplicate links, bound concurrency and back off on rate limits.

## Data model and identity join

```text
Board {id, name, schemaVersion, ruleVersion, sources, workspaceMappings,
       manualMovePolicy, viewPreferences, sessionStartSummary:false}
Card {id, key, title, workspace, tags[], parentId?, sourceRefs[], agentRef?,
      terminalRef?, links[], taskOutcome, activity, attention[], freshness,
      manualColumn?, revision}
SourceRef {adapter, instanceId, objectId, generation, cursor?, observedAt}
AgentRef {hostId, provider, sessionId, childAgentId?, parentEvidence?, cwd}
TerminalRef {machineId, backend, endpointId, processGeneration}
Link {kind:github_pr|linear|url, url, label, number?, observedState?, checkedAt?}
```

Observations of the same agent join by **same session ID or same working folder**, applied across all sources rather than as rules per adapter pair. IDs are namespaced by host and provider, and folder paths are canonicalized on the same host. Both observations and their provenance are kept: Firstmate supplies backlog titles and task decisions, hooks add native session identity. Event IDs and source generations handle replay and process reuse.

Folder equality is a fallback match, not proof that every process in a repository is one agent. Distinct known session or child IDs stay distinct, and several folder-only candidates stay ambiguous until identity resolves them. Joins are recorded as reversible aliases so a wrong join can be corrected without deleting source history. Two agents and nested children sharing one folder must be tested before shipping.

Each card has exactly one coarse workspace, free tags, an optional parent ID, and explicit workspace mappings with `unassigned` for gaps. Parents may cross workspaces; filters do not expose an excluded parent's details. Parent cycles are rejected. Titles are literal source or backlog titles, or ID fallbacks, never model-generated. Hooks never infer task completion from idle, turn end or terminal exit.

The board has four columns: Needs you, Workers on it, Review, Done. An open linked change moves a card to Review; a confirmed merge moves it to Done. Precedence: sticky manual pin, blocking source request, linked-change facts, other explicit attention or completion, then ongoing work. With several tracked links, any open one means Review, and all must be confirmed merged for automatic Done. Closed-unmerged needs attention; a stale refresh keeps the last known facts. Moving or merging a card does not resolve a source decision. Manual placement is sticky by default, with an alternate policy that expires it on the next distinct accepted observation and a per-card return-to-auto command.

## Events, snapshot, replay and undo

Each board's **`events.jsonl` is the canonical history**. **`snapshot.json` is only a rebuildable cache** holding current cards, pins, preferences, queues, cursors and the sequence it was built through. This mirrors Firstmate's split between append-only status records and computed state.

| Pattern | Pnyx counterpart |
|---|---|
| Append-only status lines | Accepted board events with actor, time, reason and payload |
| Keyed decision fold | Pure reducer; an exactly matching resolution closes a request |
| Inbox and handled receipts | Queued, delivered and handled are separate events |
| Wake sequence and lock | Single writer and a monotonic board sequence |
| Atomic publication | Atomic snapshot replacement after a durable append |
| Single backlog writer | Only the `pnyx-axi` command layer writes board state |

```json
{"v":1,"seq":184,"id":"evt_184","at":"2026-10-13T14:00:00Z","actor":"agent:abc","type":"card.moved","cardId":"c12","reason":"Keep in review","data":{"before":null,"after":"review"}}
```

A write validates the expected revision and idempotency key, appends and flushes, reduces, atomically replaces the cache, then notifies clients. Hook spools are ingress buffers, not alternate writers of `events.jsonl`. Stale source generations and duplicate event IDs are rejected. A partial tail left by a crash is kept for explicit repair; corruption inside the log is rejected.

Replay by sequence (or by the sequence at an ingest timestamp) restores any **recorded** board state. Events carry schema and rule versions and every input fact the reducer needs; external observations are recorded rather than refetched during replay. Native transcripts stay owned by their source, so replay cannot recover source content that was never kept. Undo appends a reversing event that references the original edit, checks intervening revisions and keeps history. It can reverse pins, settings or metadata edits. It cannot unsend a reply, change a provider permission, undo a merge or roll back a deployment.

Activity is a recent view; History queries the same log for past work, decisions and evidence. Outcome events keep their event-time title, workspace, tags, source-owned completion notes, links and evidence references even after archival or card edits. Agents use filters, stable IDs, through-sequence and bounded cursor pages. Corrections append superseding events. A planned history search index (`src/search/`), derived from the log and rebuildable like the snapshot, narrows scans of old segments; no generated summaries or database are needed to start.

Size estimate: 100 cards × 50 changed facts a day × 800 bytes is about **4 MB a day, 120 MB a month**. A 1,000-card snapshot at 3 KB a card is about **3 MB**, plus queues and indexes. Segment history around 64 MB and page old segments without discarding them. Bound the thread cache to 10 MB, pages to 100 messages and pending browser output to 1 MB; coalesce display bursts. Targets, not measurements: service RSS under 150 MB at 1,000 cards, idle under 1% of one core, ordinary local updates under one second. SQLite waits for a measured need.

## Threads, replies and liveness

Claude Code hooks expose transcript paths: read completed JSONL records and follow file changes. Codex session files need a version-tested reader, with "unavailable" shown for missing or unsupported paths. An optional Paseo adapter can use its paginated timeline. Readers handle partial lines, replacement, rotation and compaction and never write to native transcripts. Only recorded thinking that the provider exposes is shown. Logical children without an input endpoint point to their owner.

The composer queues literal text for a verified existing route. Firstmate-owned work always replies through Firstmate's send command; other input routes are optional source capabilities. Native skills and commands stay interpreted by the harness. A missing, busy, changed or unverified route keeps the reply queued. An ambiguous send result becomes `delivery_unknown` instead of triggering a blind duplicate. A successful submit is not proof the agent handled or answered the message.

Listener presence, source freshness and working/idle are distinct facts. Socket connection and close, plus consumer leases, drive the "Not watching" banner; lease timers measure presence, not source polling. Ping is a deduplicated queued nudge where a wake route exists. Re-attach opens the known native session. There is no automatic restart and no repeated ping loop. Firstmate's inbox policy stays authoritative for Firstmate work.

## CLI

```text
pnyx-axi
pnyx-axi board open <board>
pnyx-axi push --key <key> --file card.json
pnyx-axi card <id> [--thread|--history]
pnyx-axi move <id> review | --auto
pnyx-axi link <id> --kind github_pr --url <url>
pnyx-axi reply <id> --file reply.txt --idempotency-key <key>
pnyx-axi watch --after <seq>
pnyx-axi poll --consumer <id> --after <seq>
pnyx-axi ack <action> --state applied --receipt <ref>
pnyx-axi history --workspace <workspace> --kind outcome --before <seq> --limit 50
pnyx-axi replay --at <seq>
pnyx-axi undo <event-id> --if-revision <revision>
pnyx-axi view set --font-size 16 --panel right
pnyx-axi view set --column-width needs=320 --card-height 250
pnyx-axi view show | schema
pnyx-axi setup hooks [--preview]
pnyx-axi settings set sessionStartSummary true
pnyx-axi refresh <id> --links
pnyx-axi ping <id> | attach <id>
```

The CLI follows [AXI](https://axi.md/): a no-argument scoped summary, compact TOON output, optional JSON, minimal default fields, bounded pages, explicit empty, stale and error states, examples and executable next steps, and no prompts. `poll` is a consumer queue read and long-poll contract, not a source inventory timer. The no-argument summary never silently starts infrastructure.

Pnyx ships an installable setup and usage skill, optional AGENTS.md/CLAUDE.md snippets, adapter examples, schema fixtures, and scripts for hook setup, normalization, socket and spool ingestion and source-specific validation. No project instruction file is edited by default, and there is no helper-agent spawning skill. The Firstmate integration needs no Firstmate changes. All UI preferences live in the versioned CLI schema; the local service owns the single writer, validation and revision checks. The service binds loopback, checks Origin and Host, authenticates writes, renders text safely and validates links and paths. Captured tool text is data, never shell input.

## Web board

Workspace filters, colored tags, an orchestrator with its children, four columns, links shown as icon plus number or title, the full thread with tool and thinking markers, a composer, a liveness banner and manual placement. A fixed frame holds independently scrolling columns and threads; the composer stays visible with the conversation in a right panel. Settings cover right or inline conversation, font size, per-column width, default and per-card height and card accent colors; column, panel and composer sizes can be dragged or changed with the keyboard. Tool and thinking details are switches with board defaults and per-card overrides. History supports search, workspace and type filters, source evidence and export. Dragging cards between columns is deferred and will use the same move commands, with keyboard alternatives. Every preference is written through the same validated, event-backed writer.

## Delivery phases

1. **Smallest useful v1:** event writer, reducer and cache; the AXI CLI; local socket and spool; silent user hooks for tested Claude Code and Codex versions; the Firstmate file reader, FSEvents watcher and send route; the generic identity join; the four-column WebSocket board; native thread reads; history; shared preferences; linked open pull request state through `gh-axi`. No Firstmate patches.
2. **Prove the boundaries:** fixture replay and undo, sibling agents in one folder, hook-disabled Firstmate workers, silent and fast hook failure with spool recovery, watcher gap recovery, source permission state, idempotent queues and reply receipts. Benchmarks establish the latency and memory targets before they are claimed.
3. **Optional integrations:** Paseo, Herdr and tmux location and input, and more harness hooks. Add capabilities one at a time; never substitute periodic polling for a missing push contract.

Deliberately absent: model classification or board-maintenance agents, dispatch or supervision by Pnyx, permission bypass, GitHub work management, cloud hosting, terminal emulation, universal transcript scraping, inferred completion, automatic restarts and a database.
