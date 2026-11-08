# Provider sessions

Claude Code and Codex run under `pnyx-axi serve`. Stopping or restarting the server ends their running turns. The provider interface separates execution from readers inside that process.

`Provider.open` returns a `HostedSession`. Its first `run` binds application input and permission handling and starts one native owner. `attach` adds an event reader. Returning from a reader removes that subscription; `close` explicitly shuts down the native session. A slow reader has a bounded queue and receives an error if it falls behind. Attachments receive live events; `snapshot` supplies current work, permissions, value-free answer receipts and the latest complete terminal outcome. This is an in-memory snapshot, without a durable replay or acknowledgement protocol.

Inputs have an application ID, text and an explicit image manifest containing paths, media types and SHA-256 digests. The application selects images from the original message, before adding memory, helper outcomes or other context. Adapters translate only supplied parts and check their bytes before delivery. Missing or changed images fail visibly. Claude uses a native UUID mapped back to the application input ID; Codex associates accepted starts and steering with their turn IDs.

Native permission IDs are separate from the saved Pnyx permission ID. An answer receipt records `received` when application policy returns its decision and `submitted` when the adapter hands it to the SDK callback or Codex pipe. Submission does not prove native application. Receipts contain no answer values. The application owns authorization, persistence, redaction and expiry.

Each `turn-ended` fact carries its completion time, input IDs, status, final text, assembled assistant messages, structured output, usage and any error. The helper parses this complete outcome. Input, permission, answer, terminal, compaction and structured-output events are critical facts; text, tools, thinking, usage, work and foreground activity are view events.

A worker card stays working while its session has native background work or one of its own hook-reported child agents is working, even after its foreground turn finishes. Hook-reported children are matched by provider and parent session ID; ordinary subtasks and other sessions do not contribute. Ended workers remain stopped, and a child that has finished or ended no longer contributes activity. Foreground `finished` does not authorize idle cleanup. Cleanup requires no running turn or tool, unsettled input, pending control, queued native turn or background task. Claude's queue count and background-task replacement sets supply native knowledge; missing queue information keeps the session open. A Codex input refused by steering remains carried until its own turn settles. Codex child agents block cleanup until confirmed shutdown; background commands and unsupported native work also keep their owner open. Explicit close and server shutdown retain their existing authority.

The Claude SDK warning about a shadowed permission callback is logged at most once per server process. The callback stays installed so permission-mode changes keep their existing behavior; other SDK warnings remain visible.

## Transcript records

`src/workers/claude.ts` and `src/workers/codex.ts` decode their own transcript formats into `TranscriptRecord`, defined in `src/workers/provider.ts`. `src/workers/transcripts.ts` selects the reader and exposes typed text through `transcriptMessages`. Records carry the message role and time, visible text, hidden wake boundaries, tool and thinking traces, calls and results, harvested notes and observed settings. Calls carry normalized command, file, query, URL, skill and description fields. Trace positions retain their original block indexes so thread entry IDs and pagination stay stable.

The Oracle, thread reader, latest-message feed, reply confirmation and hook harvesting consume that neutral shape. Redaction and display limits stay in their consumers. The browser imports the shared text and call presentation helpers; its bundle does not load the provider adapters.

## Usage

Each provider's adapter reads usage from its own transcript format and emits neutral `HostedUsage` events for live readings; `src/workers/usage.ts` picks the transcript reader by harness. Consumers never interpret vendor fields. `src/workers/usage.ts` combines those readings, recorded task totals and quota plan windows into `AgentUsage`. The server pushes that derived shape over the existing WebSocket; both the composer and task card render `web/src/workers/usage.tsx`. The browser keeps spend and usage in a separate live map and merges them into the displayed cards; its saved Hydra state contains only confirmed event state.

Current context is the latest request's reading, not the sum of earlier requests. Recorded task tokens retain their worker and attributed Hydra breakdown. Only reported counts are shown. Claude transcripts provide used tokens but no window or session cost; those details can come from live readings. Synthetic assistant records do not change usage, and a transcript compaction boundary clears current context. Transcript fragments and task totals never substitute for current context.

The server owns transcript readings and task totals and passes them to the host for reads and views. `hydra usage` returns that shape once. `hydra usage refresh` refreshes plan windows separately; `--force` bypasses the quota cache.
