# Project columns: implementation spec

This is the living spec for task task-ecfe3cac-541d-4dd5-a876-5cc8229f2365.
The source is the settled talk task task-d8d6de12-aab7-474e-ad13-2a01b8f01de1,
its feedback rounds 1–9, and its final Lavish page. Later rounds 10–11 put the
Oracle near the top centre and remove the separate Waiting on you button.
Grouping A is settled. Labels do not define columns.

## Settled behavior

- A slim header replaces the sidebar. Hydra chips show waiting counts and navigate
  to each Hydra's own chat and composer. The Oracle finds waiting work across Hydras.
- Hydras sit side by side on a horizontal axis that snaps to each Hydra. Each has
  its own chat, project chips and project columns. Hydras, chats and projects fold.
  A folded Hydra also lists its projects. A control folds all projects together.
- Ideas is the first column and contains tasks without a project. Attaching a
  project moves a task into that project's column. Each project has one Hydra;
  each repository has one project. A project can group several repositories.
- Project columns resize from a minimum of 280px with no maximum. Their grids
  fit as many compact cards per row as their width allows.
- A closed card has two lines: state pill, age, repository tag when needed and
  provider icon (model and existing usage panel on hover); then chevron and title.
  Only parents have chevrons. A parent rolls up state and completed-part count.
- Order is needs you, running, waiting/paused/queued, done. Dragging reorders within
  a state group. Done tasks disappear after 24 hours, honoring task hide overrides.
- Clicking opens a card in place. Clicking its title folds it. The open card has
  all existing details and worker chat side by side, minimum 560×440, no maximum.
  It initially opens at 660px. Switching cards in a column retains column width.
  Window mode is an explicit action and never changes the next click's behavior.
- One level of sub-tasks, compact and indented beneath their parent. Cross-project
  children show their project. Each retains its own worker, PR and lifecycle.
- During dragging, other cards make space immediately. Only dropping on the small
  central sub-task pill nests a card. The rest of a card reorders it. A task with
  children cannot become a child. Dragging out or the hover menu removes a parent;
  a detached task returns to its own project's column.
- One shared hover pill provides actions for open, closed and child cards.
- Project and Hydra order can be changed from their content or navigation chips,
  including folded strips. All reversible edits appear immediately and reconcile
  through the existing pending resource, preserving DOM identity.
- Scroll, resizing and opening feel continuous. Expansion, folding and dragging
  animate without jumps. Reduced motion is respected.
- Restart, dropped and slept connections reconcile without a manual reload.
  Connection transitions, recovery and slow renders have structured bounded logs.

## Layers and current state

The core and UI layers are implemented in the draft PR. The live-app pass covers desktop and phone; the final readiness reviews and full verification are deliberately held.

- [x] Read settled design and record its migration decisions.
- [x] Automatic stopped-client/query recovery and bounded connection logs.
- [x] Project groups, deterministic duplicate refusal and atomic keeper choice.
- [x] One-level parent changes, rollups and parent completion/retention.
- [x] Shared multi-Hydra data/threads, horizontal axis and slim header.
- [x] Project grids, compact cards and inline details with worker chat.
- [x] Persisted folds/sizes, shared hover actions, drag ranking/nesting/detach and motion.
- [x] Global Oracle waiting list/search and cross-Hydra task navigation.
- [x] Run desktop/phone interaction and restart/drop proof. Upload the synthetic media to the PR.
- [x] Commit the implementation in layers. Push and refresh the same draft PR at the checkpoint.
- [ ] Later: deslop dogfood, readiness reviews and full verification, when Hydra lifts the hold.

## Migration inventory

| Existing behavior | Deliberate destination | Implementation |
| --- | --- | --- |
| Lifecycle placement in role columns | Keep role columns as compatibility facts; render by project and factual state | Preserved. No history rewrite |
| Custom status columns and rules | Continue applying their rules internally; no visible status columns | Preserved. The column CLI remains a lifecycle control |
| Done timestamps and hide overrides | Keep existing retention; parents finish only after their children | Implemented. Default remains 24 hours |
| Queued-role column and worker queues | Keep queue placement and handoff guards | Preserved. `task reorder --behind` stays a queue operation |
| Firstmate locked status columns | Keep mirror placement guards; group the view by project | Preserved. Keeper selection lists Firstmate blockers |
| Manual placement overrides | Keep lifecycle override events; project edits choose visible position | Preserved. `task arrange` changes visual rank |
| Column widths/order and CLI | Preserve old values for old clients; workspace view fields own project layout | Implemented through `view set`, not legacy `column resize` |
| Column skills and digest | Describe project arrangement and per-project state counts; explain legacy controls | Updated |
| Parent specified only at creation | `task parent` sets/clears it, rejecting cycles and deeper nesting | Implemented; prior integration cases passed |
| One folder is one project | Repo attaches alone; folder of direct child repos creates a group; `project group` groups attachments | Implemented atomically |
| Repo attached to several Hydras | Keep legacy duplicates flagged; owner chooses keeper; refuse new duplicates | Implemented in Setup, Settings and CLI; prior integration cases passed |
| Per-project copies/start/landing/memory | Keep them on each repository | Preserved |
| Hidden Hydra preferences | Honor old hidden choices as folded strips until the owner explicitly unfolds them; new layout uses folding | Implemented |
| Selected Hydra alone supplies data | All visible scopes share one WebSocket and Zero client; retain each open card's thread | Implemented |
| Query/client failure requires Retry | Automatically rebuild failed reads with backoff and reconcile retained edits/open cards | Implemented; prior stopped-auth browser regression passed |
| Hydra sequence absent from Zero | Replicate it with schema 6 publication upgrade, so confirmations settle | Proved by an app fold, sequence 28→29 and cleared pending state |
| Free-text project labels | Ideas with a plain tag until assignment | Implemented per ask-204158 |

## Legacy project values

Free-text project values with no matching repository go into Ideas. Keep the stored
value and show it as a small plain tag. No temporary columns are created. Assigning
a real repository moves the task into its project's column (Hydra answer ask-204158).

## Ownership decisions

Existing duplicate attachments keep working after upgrade and no task moves automatically. Setup and Settings must name each duplicated repository and its Hydras, asking which Hydra keeps it. Only the owner's explicit pick moves tasks, recording every move. New duplicate attachments are refused deterministically. Cover continued operation of flagged duplicates, refusal of new duplicates, and recorded task moves after the owner's pick. This migration policy was settled by Hydra in answer ask-203840.

Keeper selection is all or nothing. If any task cannot move (including live workers, PRs in flight, parent/dependency links, Firstmate mirrors and active sources), refuse with every blocking task and reason. Move nothing and defer nothing. The owner retries after settling the blockers (Hydra answer ask-203909).

No alternative visual design is open. Any newly discovered product or architecture
choice goes to Hydra before implementing dependent work. Historical events must
remain replayable. Existing behavior continues until its replacement is tested.

## Running-app evidence

The isolated server uses real Postgres, Zero and the app, with fake provider
boundaries and synthetic tasks. Headless Chrome was run under the shared slot.
Desktop captures use 1440×960 and 1920×1080; phone captures use 390×844.

- Inline card settles at 660×520. Explicit window is 980px wide; closing it leaves
  the next card click inline. Parent children and cross-project tags remain visible.
- Physical reordering records `card.moved`; nesting on the pill persists; detaching
  returns the task to Ideas. A 920px project shows three cards per row; Home
  returns its width to the 280px minimum. No maximum is imposed.
- Folded Hydra is 58px wide and lists projects. A project chip unfolds it.
  Wheel scrolling snaps to the next Hydra's leading edge.
- Forced socket drops preserve the open card DOM and reconcile a title edited
  while disconnected. A real stop/start of the isolated server preserves that DOM.
  Logged sequences show stale 49→reconciled 50, then stale 50→reconciled 50 on restart.
- Reload preserves the open card, unsent worker draft and horizontal position.
  The browser paths reported no page errors.
- Lint, CLI/web type checks and the build pass. Full verification remains held.

The behavior pass fixed a missing replicated sequence that left edits pending,
a server-only planner imported by the browser, opening measured before size settled,
horizontal snap coordinates, a resize preview that skipped its save, and scope
isolation for keyboard, theme, drafts and open task streams.

## Validation direction

The owner now wants proof through the running app, using an isolated server and a headless browser at desktop and phone sizes. Add no more automated or integration tests during this build. Keep the existing passing additions. Exercise layout, opening/folding, drag animations, Hydra snapping, immediate edits and recovery after restart and dropped connections; retain screenshots or short recordings in the draft PR. Test additions and the audit follow during the later deslop pass.

## Review hold

Keep this work on a draft PR. Do not run full pnpm verify, request CI approval,
request owner review, or mark ready until Hydra explicitly lifts the hold. The
owner intends a deslop dogfood pass before green. Targeted checks still apply to
each layer. Browser work uses the shared heavy slot and an isolated home.
