# Native agent host transport

`src/agent-host/` runs Claude Code and Codex sessions in a separate process. `pnyx-axi serve` still runs its agents in process. Hydra, worker and routine helper sessions require application integration before they can survive server restarts.

The host listens on one authenticated Unix socket in a canonical private runtime directory. A durable installation ID, private token and live process claim prevent competing owners. Clients negotiate protocol and capabilities; a different application build does not replace a healthy host. Socket paths that exceed the platform limit fail explicitly. An unrelated file, live socket or unverifiable owner claim is preserved.

## Ownership and requests

Each session has a native incarnation (`id` and `epoch`). A serialized attach barrier grants one connection an opaque controller generation. The host scope controls session opens; a session scope controls inputs, answers, settings, context, interrupts, close and critical acknowledgements. An observer can watch or read results, but cannot mutate or compact output. A takeover invalidates earlier controller generations. An unsettled native action blocks later mutations even when its caller has timed out.

Stateful calls have stable request IDs. Repeating an admitted ID returns its result when the operation identity matches; conflicting reuse fails. The comparison excludes controller tokens and answer decision contents, except for allow/deny behavior. Named input IDs also include the explicit image manifest in their identity. Images are selected by the application and checked by the provider adapter. Disconnecting a client removes its readers and leaves the native owner running. Explicit close is separate; idle close checks queued input and the provider's conservative native-work inventory.

This foundation limits a host lifetime to 64 session descriptors and 10,000 named requests, including completed requests and closed sessions. Reaching a limit explicitly refuses new admissions. Reclamation and retirement must be implemented before application routing; restarting is not a safe way to recover capacity while native ownership is unresolved.

Permission decisions stay in the live continuation. The ledger retains only answer identity and receipt phase, never values or hashes of values. A client that lost an answer reply can look up the request without resending its secret. `submitted` means handed to the SDK callback or native pipe, not proof of native application. A missing request in an intact live ledger is `NOT_RECEIVED`; after host loss it is `UNKNOWN`.

## Output and recovery

Replaceable text and activity have bounded retention. Every snapshot separately includes all unacknowledged critical facts with their original epoch, sequence and time. Terminal results, structured output, compaction, input outcomes and permission receipts remain available after text expiry. A snapshot's view watermark never acknowledges those facts. Only the current controller can acknowledge a delivered prefix after the application has durably applied it.

Critical facts are appended durably. Retention or disk pressure stops new admissions and uses an emergency in-memory reserve; exhausting that reserve explicitly fails the native owner and requires reconciliation. Facts retained only in memory cannot survive a host crash. Slow socket readers are disconnected without stopping the provider. Oversized snapshots fail explicitly and leave the facts for reconciliation.

A restarted host exposes retained facts under their old incarnation without reopening the provider. It refuses new native admissions until ownership is reconciled. This transport does not implement cold recovery, task retries, helper policy, authorization grants or maintenance drain. Host termination still ends its live continuations; only client loss is survivable at this stage.

## Runtime bundles

`stageBundle` copies a prepared production payload, dereferences dependencies and hashes its files into a versioned bundle. Payload preparation must include the entry, its package imports and all provider dependencies. Validation rejects changed bytes, missing entries and symlinks. The native entry verifies that it is running from the supplied bundle. Rebuilding the source payload leaves the copied runtime available. Production service installation, bundle selection and safe replacement are separate integration steps.

The host imports provider adapters and storage primitives, with no application reducer, task, Hydra or helper policy. See [Provider sessions](provider-sessions.md) for the shared native types and [Testing](testing.md) for the subprocess tests.
