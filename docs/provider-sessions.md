# Provider sessions

Claude Code and Codex run under `pnyx-axi serve`. Stopping or restarting the server ends their running turns. The provider interface separates execution from readers inside that process.

`Provider.open` returns a `HostedSession`. Its first `run` binds application input and permission handling and starts one native owner. `attach` adds an event reader. Returning from a reader removes that subscription; `close` explicitly shuts down the native session. A slow reader has a bounded queue and receives an error if it falls behind. Attachments receive live events; `snapshot` supplies current work, permissions, value-free answer receipts and the latest complete terminal outcome. This is an in-memory snapshot, without a durable replay or acknowledgement protocol.

Inputs have an application ID, text and an explicit image manifest containing paths, media types and SHA-256 digests. The application selects images from the original message, before adding memory, helper outcomes or other context. Adapters translate only supplied parts and check their bytes before delivery. Missing or changed images fail visibly. Claude uses a native UUID mapped back to the application input ID; Codex associates accepted starts and steering with their turn IDs.

Native permission IDs are separate from the saved Pnyx permission ID. An answer receipt records `received` when application policy returns its decision and `submitted` when the adapter hands it to the SDK callback or Codex pipe. Submission does not prove native application. Receipts contain no answer values. The application owns authorization, persistence, redaction and expiry.

Each `turn-ended` fact carries its completion time, input IDs, status, final text, assembled assistant messages, structured output, usage and any error. The helper parses this complete outcome. Input, permission, answer, terminal, compaction and structured-output events are critical facts; text, tools, thinking, usage, work and foreground activity are view events.

Foreground `finished` does not authorize idle cleanup. Cleanup requires no running turn or tool, unsettled input, pending control, queued native turn or background task. Claude's queue count and background-task replacement sets supply native knowledge; missing queue information keeps the session open. A Codex input refused by steering remains carried until its own turn settles. Codex child agents block cleanup until confirmed shutdown; background commands and unsupported native work also keep their owner open. Explicit close and server shutdown retain their existing authority.

## Usage

Each provider implements `Provider.readUsage` for its own transcript format and emits neutral `HostedUsage` events for live readings. Consumers never interpret vendor fields. `src/workers/usage.ts` combines those readings, recorded task totals and quota plan windows into `AgentUsage`. The server pushes that derived shape over the existing WebSocket; both the composer and task card render `web/src/workers/usage.tsx`.

Current context is the latest request's reading, not the sum of earlier requests. Recorded task tokens retain their worker and attributed Hydra breakdown. Only reported counts are shown. Claude transcripts provide used tokens but no window or session cost; those details can come from live readings. Synthetic assistant records do not change usage, and a transcript compaction boundary clears current context. Transcript fragments and task totals never substitute for current context.

The server owns transcript readings and task totals and passes them to the host for reads and views. `hydra usage` returns that shape once. `hydra usage refresh` refreshes plan windows separately; `--force` bypasses the quota cache.
