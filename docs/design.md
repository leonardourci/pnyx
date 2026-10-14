# Pnyx design

Pnyx is a deterministic board of every agent and its work, with an AXI CLI named `pnyx-axi`. It is a view and a reply queue over existing tools. It does not orchestrate, dispatch or supervise agents.

## Sources

Two integrations ship in v1.

1. **Harness hooks are the universal source of cards.** A one-time `pnyx-axi setup hooks` installs owned user-level command hooks for Claude Code and Codex (more harnesses later), keeping existing entries. New and resumed sessions in any folder become cards through lifecycle events. SubagentStart/SubagentStop give children their own IDs and parent references; a logical child can share its parent's terminal. The hooks subscribe to every event the agent's own interface reacts to, for every tool, and the card shows them the way that interface would: a permission prompt, a question, a plan to approve or an MCP input request is a blocking request with its reason, the agent's own idle notification and a turn that failed on an API error are non-blocking ones, and running tools, background tasks, subagents and compaction are activity. Each is a fixed rule on payload fields; nothing is classified by a model.
2. **Firstmate records cover managed work.** Pnyx reads only configured Firstmate homes: status logs, metadata, backlog, decision records and task briefs. Titles come from the backlog. It follows Firstmate's file schemas and keyed-resolution semantics, never inspects backend endpoints and never patches Firstmate. Replies and decision answers go through Firstmate's own send command, with an explicit `FM_HOME`, task ID and resolve key for an answered decision.

Firstmate can launch some workers with hooks disabled, so hooks alone cannot cover them; the Firstmate source supplies their task facts without changing the launch policy. Firstmate's durable inbox delivery, handled receipts and native invocations stay separate facts.

**Notes are harvested, never written for Pnyx.** Each card keeps a Summary, Decisions and Context section built only from what sources already recorded, at no model cost and with nothing new asked of agents: Claude Code's compaction summaries, session titles and AskUserQuestion questions with the user's answers; Codex's readable compaction summaries and thread names; Firstmate's needs-decision, resolved and done lines with their text and the brief's Captain's intent; and a linked pull request's title and description through `gh-axi`. Transcripts are harvested when a session ends a turn and on `pnyx-axi harvest`, Firstmate records on every sync, pull requests on `pnyx-axi harvest`. Every source is only read.

Typing into a session needs no extra source: the hooks record, when a session starts or takes a prompt, the harness process, its TTY and the host around it (tmux, Herdr, Paseo, iTerm2 or Terminal) from the environment. Paseo, Herdr and tmux remain optional later enrichments for location and native thread access. A plain terminal inventory does not create cards. Hooks cover local sessions where user hooks are enabled; they cannot discover a session that was already running until it sends a supported event, and they cannot override disabled hooks. Missing coverage is shown explicitly. Firstmate's initial file snapshot imports its existing tasks.

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
Task/Card {id, key, title, workspace, tags[], parentId?, sourceRefs[], sessionIds[], agentRef?,
      settings?, terminalRef?, folder?, links[], taskOutcome, activity, attention[], notes[], freshness,
      manualColumn?, revision}
Session {id, agent, originCardId, taskId?, terminal?, settings?, activity?, attention[], outcome?, sourceRefs[]}
Note {kind:summary|decision|context, source, text, at?}
SourceRef {adapter, instanceId, objectId, generation, cursor?, observedAt}
AgentRef {hostId, provider, sessionId, childAgentId?, parentEvidence?, cwd}
TerminalRef {tty, pid, program, tmux, tmuxPane, paseoTerminal, paseoHome, herdrSession, herdrPane}
Link {kind:github_pr|linear|url, url, label, number?, observedState?, checkedAt?}
Settings {model?, effort?, mode?, fast?, <harness-specific>?}
```

A card's settings are what its harness already reports, never asked for: hook payloads carry the permission mode, effort and (Codex on every hook, Claude Code at session start) the model; the transcript read after each turn adds each turn's model, effort and speed, Claude Code's 1M context and Codex's approval policy, sandbox, collaboration mode and reasoning summary. A push merges settings by name, so a mid-session change shows up on the next hook or turn. Only known values are shown; Pnyx never changes them.

A card is a task, with at most one attached session today. Session identity is separate from task membership: a session keeps its provider/session id (and child id), native transcript, terminal and source facts, while the task keeps its title, links, workspace, pins and source-owned decisions. `sessionIds` is a list so a later version can add several recipients with an explicit ownership protocol; this version rejects an occupied attachment instead of replacing it.

An interactive session automatically creates its task with the same title rules as before. A session without a recorded interactive TTY is a background run: it remains in the session registry, History and search but its automatic card is hidden from the live board, counts and live search results. A later interactive resume can make it visible, and a headless resume clears an earlier terminal. The terminal collector stops at the harness process; it cannot borrow a TTY from an unrelated ancestor. No command-name or validation-tool exceptions classify background work. A Firstmate task remains one task, even while no worker is attached.

Membership pins the reply recipient by session identity. The first interactive session in exactly one source-assigned working folder can join that task. Once occupied, another session in that folder creates its own task. Known session identity and explicit attachment take precedence over folder matching. `pnyx-axi attach <task> --session <session>` moves a session, and `detach <task>` removes its membership without stopping or typing into it. Future hooks follow the attachment. Detaching stays explicit until another attach; it cannot silently join by folder again. Explicit tasks remain when their session moves away, and automatic session cards fold out of view while their session belongs elsewhere.

The migration is the pure replay of existing version-1 events into task and session records; existing ids and event bytes remain unchanged. An older snapshot is invalidated by the reducer rule version and rebuilt. If a legacy card contains observations from several sessions, the first recorded session stays attached and the others remain individually addressable in the registry. `task.session` events record the old and new task ids. Attachments support revisions, idempotency and conflict-checked undo.

Each card has exactly one coarse workspace, free tags, an optional parent ID, and explicit workspace mappings with `unassigned` for gaps. Parents may cross workspaces; filters do not expose an excluded parent's details. Parent cycles are rejected. Titles are literal source or backlog titles, never model-generated. A card that only hooks report takes the first available of the harness's own session title (Claude Code's custom or AI title from the transcript, Codex's thread name from its `session_index.jsonl`), the session's first prompt cut to one line, or the working folder's name, and its key when none is known. A subagent's card takes its agent type and the last 4 characters of its agent id (`Explore 3f2a`, `Subagent` when the type is missing), so sibling subagents stay apart; the hook payload carries no task description. That title is re-derived as a better source appears (a later session title replaces an earlier one; the first prompt stays) and never replaces a title a person or agent set through the CLI or UI; undoing that set title returns the card to its derived one.

A session that ends (SessionEnd, or SubagentStop for a subagent) records a hooks-owned outcome `ended`, which places the card in Done. A pending question or permission still shows Needs you, and new work in the same session (a resume, a prompt or a tool call) clears the outcome and returns it to Workers on it. Hooks never infer completion from idle or a finished turn, and never change an outcome another source or a person recorded; a person may record their own outcome over `ended`. Firstmate tasks, including a session joined to one by its folder, are Done when Firstmate closes them in its backlog.

The board has four automatic columns: Needs you, Workers on it, Waiting, Done. Waiting retains the version-1 `review` id for replay and CLI compatibility; `move waiting` is an alias. An idle session or a task without an attached agent waits there. An open linked change moves a task to Waiting; a confirmed merge moves it to Done. Precedence: sticky manual pin, blocking source request, linked-change facts, other explicit attention (excluding an idle notification) or completion (including an ended session), then ongoing work. With several tracked links, any open one means Waiting, and all must be confirmed merged for automatic Done. Closed-unmerged needs attention; a stale refresh keeps the last known facts. Moving or merging a card does not resolve a source decision. Users may create named custom columns inline; these accept manual placement only. Manual placement is sticky by default, with an alternate policy that expires it on the next distinct accepted observation and a per-card return-to-auto command.

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

Replay by sequence (or by the sequence at an ingest timestamp) restores any **recorded** board state. Events carry schema and rule versions and every input fact the reducer needs; external observations are recorded rather than refetched during replay. Native transcripts stay owned by their source, so replay cannot recover source content that was never kept. Undo appends a reversing event that references the original edit, checks intervening revisions and keeps history. It can reverse pins, settings or metadata edits. A direct CLI or UI write is a manual edit whether a person or an agent made it, so it stays undoable; anything carrying a source (adapters, hooks, the spool, a harvested note) is an observation and is not. A harvested note is a `card.noted` event whose id derives from its card and source record, so harvesting the same record again appends nothing; the card keeps a reference and the text stays in the log. A note is not card activity: it bumps the card's revision but never its updated time or its place in a column. The actor field is attribution only. It cannot unsend a reply, change a provider permission, undo a merge or roll back a deployment.

Activity is a recent view; History queries the same log for past work, decisions and evidence. Outcome events keep their event-time title, workspace, tags, source-owned completion notes, links and evidence references even after archival or card edits. Agents use filters, stable IDs, through-sequence and bounded cursor pages. Corrections append superseding events.

`pnyx-axi search` runs full-text search across everything on a card: titles, links (pull request numbers and titles), event text, harvested notes and the Claude Code and Codex session transcripts the hooks recorded. Its index, `search.db` in the board's folder, is SQLite FTS5 through Node's built-in `node:sqlite`. It is a derived index, not a store: deletable like `snapshot.json`, rebuilt from the log and the transcripts, never read as board state, and written only by the indexer in `src/search/`, which each search runs first to fold in what the log and transcripts gained. Transcripts are indexed by message, long messages split into chunks; tool calls and output, thinking and injected text stay out, and secret-shaped strings are redacted. Every word must match somewhere on one card: each card also has one index row holding its title, link titles and all its indexed text, kept current as chunks land, and BM25 ranks cards on it, the title and link titles weighing half and harvested notes double. Each hit shows the card's best-matching chunks as snippets. With `--card` or `--kind`, every word must match in one chunk of that card or kind. Words match by Porter stem with case and accents folded, so "deploying" finds "deploy" and "migracao" finds "migração", and each word also matches its group in a small, versioned synonym map of our own vocabulary (`src/search/synonyms.ts`: PR / pull request, deploy / release / ship, rollback / revert, issue / ticket). When that finds nothing, a trigram index of every indexed word supplies the words nearest each query word, so typos and partial words still match ("chekout" finds checkout); those results are marked `fuzzy`. Results come with snippets and no generated summaries.

Semantic search is on by default, for every search surface: the board's Find a card box, History, the Cmd+K palette (which lists matching cards after the actions) and `pnyx-axi search`, including `--card` and `--kind transcript`. It runs on node-llama-cpp and sqlite-vec, which are optional dependencies: a normal install has them, and an install without optional dependencies falls back to the full-text search above, silently. `pnyx-axi settings set search.semantic off`, the web board's settings or `PNYX_SEMANTIC=off` turn it off, and search is then exactly the full-text search above. With a GPU backend of node-llama-cpp (Metal, CUDA or Vulkan) it uses granite-embedding-311m-multilingual-r2 (768 dimensions) and the Qwen3-Reranker-0.6B reranker; on a CPU-only machine granite-embedding-97m-multilingual-r2 alone (`search.model` and `search.rerank` default to `auto`). The models are pinned, Apache-2.0 GGUF files, fetched into `~/.pnyx/models/` the first time a search needs them and checked by SHA-256 and then by golden vectors; until they are ready, searches return full-text results with a line showing the download progress, and `search status` shows it too. `pnyx-axi search setup --semantic` fetches the ones the settings need in the foreground instead. A failed download or check is recorded (the reranker's apart, so searches keep the embedder meanwhile), so searches stay full-text and say why for a while instead of retrying on every search. The models run in one worker process per Pnyx home (`search setup` also loads them once, in its own process, for the golden check), spawned on demand at low priority (utility QoS on macOS), never in the server or a hook; it downloads what it needs, embeds the chunks each board's index gains, one at a time and newest first, into `search.db` keyed by content hash (so repeated text is embedded once), answers query embeddings and reranking over a local socket in a temp folder only this user can use, and exits after a minute idle. Vectors carry the model, file and backend that made them plus probe vectors; on any change they are dropped and remade in the background. A search fuses the full-text query (every word must match) and an exact cosine scan with sqlite-vec by reciprocal rank fusion (k = 60) at card level (with `--card`, at entry level), so a card is found by words, by meaning in any language, or both. With the reranker on, its score re-orders the top 20, marks weak results and says when nothing matches strongly. A card found by meaning alone is also weak outside the reranked top 20, or, without the reranker, when its nearest chunk is under the embedder's cosine similarity floor (0.85 for the 311m, 0.82 for the 97m, calibrated on the research evaluation set). The search boxes leave weak results out. The Find a card box keeps its own filter (substrings of title, key, tags and links, every match, in board order) and adds the strong meaning-only cards after them, so with semantic search off it is exactly that filter. Until the vectors catch up, or when the worker cannot answer, a search says so and returns full-text results.

Size estimate: 100 cards × 50 changed facts a day × 800 bytes is about **4 MB a day, 120 MB a month**. A 1,000-card snapshot at 3 KB a card is about **3 MB**, plus queues and indexes. Segment history around 64 MB and page old segments without discarding them. Bound the thread cache to 10 MB, pages to 100 messages and pending browser output to 1 MB; coalesce display bursts. Targets, not measurements: service RSS under 150 MB at 1,000 cards (the semantic search worker is a separate process holding about 1–2.6 GB while it runs), idle under 1% of one core, ordinary local updates under one second. Board state needs no database; the only SQLite file is the derived search index.

## Threads, replies and liveness

Claude Code hooks expose transcript paths: read completed JSONL records and follow file changes. Codex session files need a version-tested reader, with "unavailable" shown for missing or unsupported paths. An optional Paseo adapter can use its paginated timeline. Readers handle partial lines, replacement, rotation and compaction and never write to native transcripts. Only recorded thinking that the provider exposes is shown. Logical children without an input endpoint point to their owner.

The composer queues literal text for a verified existing route, chosen deterministically from recorded facts. Firstmate-owned work always replies through Firstmate's send command. Any other session is typed into the terminal its hooks recorded, through the innermost host: tmux send-keys (a paste buffer), Herdr's or Paseo's CLI, or AppleScript for iTerm2 and Terminal, which find the session by TTY and need the user's one-time macOS automation permission. Before typing, the harness process must still own its recorded TTY, so text never lands in a shell left behind. The text is typed once, then submitted with Enter after a settle that is longer for a leading / or $. Terminal is the exception: its `do script` types the text and Return together, with no settle. A card without a route says why in the composer. Native skills and commands stay interpreted by the harness. A missing, changed or unverified route types nothing and records the reply failed with the reason. An ambiguous send result becomes `delivery_unknown` instead of triggering a blind duplicate. A successful submit is not proof the agent handled or answered the message.

Listener presence, source freshness and working/idle are distinct facts. Socket connection and close, plus consumer leases, drive the "Not watching" banner; lease timers measure presence, not source polling. Ping is a deduplicated queued nudge where a wake route exists. Re-attach opens the known native session. There is no automatic restart and no repeated ping loop. Firstmate's inbox policy stays authoritative for Firstmate work.

## CLI

```text
pnyx-axi
pnyx-axi board open <board>
pnyx-axi push --key <key> --file card.json
pnyx-axi card <id> [--full]
pnyx-axi task create --title <title> [--key <key>] [--folder <path>]
pnyx-axi task sessions
pnyx-axi attach <task> --session <session-id|card-id|key>
pnyx-axi detach <task>
pnyx-axi harvest [--card <id>]
pnyx-axi move <id> review | --auto
pnyx-axi link <id> --kind github_pr --url <url>
pnyx-axi reply <id> --file reply.txt --idempotency-key <key>
pnyx-axi watch --after <seq>
pnyx-axi poll --consumer <id> --after <seq>
pnyx-axi ack <action> --state applied --receipt <ref>
pnyx-axi history --workspace <workspace> --kind outcome --before <seq> --limit 50 [--full]
pnyx-axi search "<words>" [--workspace <w>] [--kind event|note|transcript] [--card <id>] [--limit 20]
pnyx-axi search status | rebuild
pnyx-axi search setup --semantic
pnyx-axi settings set search.semantic on|off | search.rerank auto|on|off | search.model auto|<model>
pnyx-axi replay --at <seq>
pnyx-axi undo <event-id> --if-revision <revision>
pnyx-axi view set --json '{"fontSize":16,"panelPlacement":"right"}'
pnyx-axi view set --json '{"columnWidths":{"needs_you":320},"cardHeight":250}'
pnyx-axi view show | schema
pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview]
pnyx-axi settings set sessionStartSummary true
pnyx-axi refresh <id> --links
pnyx-axi ping <id> | attach <id>
```

The CLI follows [AXI](https://axi.md/): a no-argument scoped summary, compact TOON output, optional JSON, minimal default fields, bounded pages, explicit empty, stale and error states, examples and executable next steps, and no prompts. `history --full` includes the recorded event data, including literal queued owner messages. `poll` is a consumer queue read and long-poll contract, not a source inventory timer. The no-argument summary never silently starts infrastructure.

Pnyx ships an installable setup and usage skill, optional AGENTS.md/CLAUDE.md snippets, adapter examples, schema fixtures, and scripts for hook setup, normalization, socket and spool ingestion and source-specific validation. No project instruction file is edited by default, and there is no helper-agent spawning skill. The Firstmate integration needs no Firstmate changes. All UI preferences live in the versioned CLI schema; the local service owns the single writer, validation and revision checks. The service binds loopback, checks Origin and Host, authenticates writes, renders text safely and validates links and paths. Captured tool text is data, never shell input.

## Web board

Workspace filters, colored tags, an orchestrator with its children, four columns, links shown as icon plus number or title, the full thread with tool and thinking markers, a Notes tab with the card's harvested summary, decisions and context, a composer, a liveness banner and manual placement. A fixed frame holds independently scrolling columns and threads; the composer stays visible with the conversation in a right panel. Settings cover right or inline conversation, font size, per-column width, default and per-card height and card accent colors; column, panel and composer sizes can be dragged or changed with the keyboard. Tool and thinking details are switches with board defaults and per-card overrides. History supports search, workspace and type filters, source evidence and export. Dragging cards between columns is deferred and will use the same move commands, with keyboard alternatives. Every preference is written through the same validated, event-backed writer.

## Delivery phases

1. **Smallest useful v1:** event writer, reducer and cache; the AXI CLI; local socket and spool; silent user hooks for tested Claude Code and Codex versions; the Firstmate file reader, FSEvents watcher and send route; the generic identity join; the four-column WebSocket board; native thread reads; history; shared preferences; linked open pull request state through `gh-axi`. No Firstmate patches.
2. **Prove the boundaries:** fixture replay and undo, sibling agents in one folder, hook-disabled Firstmate workers, silent and fast hook failure with spool recovery, watcher gap recovery, source permission state, idempotent queues and reply receipts. Benchmarks establish the latency and memory targets before they are claimed.
3. **Optional integrations:** Paseo, Herdr and tmux location and native threads, and more harness hooks. Add capabilities one at a time; never substitute periodic polling for a missing push contract.

Deliberately absent: model classification or board-maintenance agents, dispatch or supervision by Pnyx, permission bypass, GitHub work management, cloud hosting, terminal emulation, universal transcript scraping, inferred completion, automatic restarts and a database for board state (`search.db` is a derived, deletable index).
