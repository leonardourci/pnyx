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

- [x] Read source design, feedback and existing contributor rules.
- [x] Record settled design and migration inventory here.
- [ ] Automatic connection/query recovery with regression evidence.
- [ ] Project and repository grouping, ownership and CLI contracts.
- [ ] One-level parent changes and rollups with CLI and API validation. The parent command and optimistic projection are implemented; rollups and gestures remain.
- [ ] Shared multi-Hydra connection views and slim header.
- [ ] Project grids, compact cards and in-place full detail/chat.
- [ ] Folding, resize persistence, physical drag/reorder/nesting and motion.
- [ ] Targeted checks and synthetic before/after screenshots in both themes.
- [ ] Commit and push layers to a linked draft PR.

## Migration inventory

| Existing behavior | Deliberate destination | Implementation |
| --- | --- | --- |
| Lifecycle moves tasks into role columns | Existing lifecycle facts determine state; project determines position | Pending |
| Custom status columns and placement rules | Retire status grouping deliberately; preserve replay of historical events | Pending |
| Done timestamps set by Done column entry | Timestamp state becoming done; keep hide-after and 24-hour retention | Pending |
| Queue needs a queued-role column | Queue remains functional with a queued state independent of placement | Pending |
| Firstmate role columns and locked defaults | Mirror facts into state without locking project columns | Pending |
| Manual move overrides lifecycle placement | Project change moves a task; rank reorders within state | Pending |
| Column CLI and saved widths/order | Project layout commands and persisted project widths/order/folds | Pending |
| Column skills and Hydra digest | Teach project selection and report per-project state counts | Pending |
| Parent specified only at creation | One task parent command sets or removes it; reject cycles and deeper nesting | Implemented and integration tested |
| One folder is one project | Project groups repositories; repo folder attaches alone; folder of repos attaches as a group | Pending |
| Same project may attach to several Hydras | Refuse a second owner for projects and repositories | Pending |
| Copies, start and landing configured per project | Preserve settings on the repository where the worker runs | Pending |
| Memory keyed by normalized remote | Keep memory per repository | Pending |
| One selected Hydra supplies page data | Retained scopes share one WebSocket and Zero client across visible Hydras | Pending |
| Query/client failure offers manual Retry | Automatically rebuild failed reads with bounded backoff | Implemented; stopped-authentication browser regression passes |

## Open implementation questions

Existing duplicate attachments keep working after upgrade and no task moves automatically. Setup and Settings must name each duplicated repository and its Hydras, asking which Hydra keeps it. Only the owner's explicit pick moves tasks, recording every move. New duplicate attachments are refused deterministically. Cover continued operation of flagged duplicates, refusal of new duplicates, and recorded task moves after the owner's pick. This migration policy was settled by Hydra in answer ask-203840.

No alternative visual design is open. Any newly discovered product or architecture
choice goes to Hydra before implementing dependent work. Historical events must
remain replayable. Existing behavior continues until its replacement is tested.

## Review hold

Keep this work on a draft PR. Do not run full pnpm verify, request CI approval,
request owner review, or mark ready until Hydra explicitly lifts the hold. The
owner intends a deslop dogfood pass before green. Targeted checks still apply to
each layer. Browser work uses the shared heavy slot and an isolated home.
