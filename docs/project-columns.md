# Project columns: implementation spec

This is the living spec for task task-ecfe3cac-541d-4dd5-a876-5cc8229f2365.
The source is the settled talk task task-d8d6de12-aab7-474e-ad13-2a01b8f01de1,
its feedback rounds 1–9, and its final Lavish page. Later rounds remove the
separate Waiting on you button. Owner follow-up r207090 puts the Oracle beside
Settings on the header's right and gives Settings its own page.
Grouping A is settled. Labels do not define columns.

## Settled behavior

- A slim header replaces the sidebar. Hydra chips show waiting counts and navigate
  to each Hydra's own chat and composer. The Oracle finds waiting work across Hydras.
  Settings opens at `/hydra/<id>/settings/` as a full page. Closing it preserves the
  workspace's open cards, unsent drafts and horizontal position; Back and reload work.
- Hydras sit side by side on a horizontal axis that snaps to each Hydra. Each has
  its own chat, project chips and project columns. Hydras, chats and projects fold.
  A folded Hydra also lists its projects. A control folds all projects together.
  Its shared fold icon points inward horizontally toward a vertical divider.
- Ideas is the first column and contains tasks without a project. Attaching a
  project moves a task into that project's column. Each project has one Hydra;
  each repository has one project. A project can group several repositories.
- Project columns resize from a minimum of 280px with no maximum. Their grids
  fit as many compact cards per row as their width allows.
- A closed card has three rows: state pill, age and provider icon (model and
  existing usage panel on hover); chevron and title; repository tag and other labels.
  Root and sub-task cards share this layout. Ideas without labels omit the empty row.
  Only parents have chevrons. A parent rolls up state and completed-part count.
  Compact state and age labels leave room for progress. Full state details
  remain on hover; tags stay inside the card and wrap instead of losing text.
- Order is needs you, running, waiting/paused/queued, done. Dragging reorders within
  a state group. Done tasks disappear after 24 hours, honoring task hide overrides.
- Clicking opens a card in place. Clicking its title folds it. The open card has
  all existing details and worker chat side by side, minimum 560×440, no maximum.
  It initially opens at 660px. Switching cards in a column retains column width.
  Window mode is an explicit action and never changes the next click's behavior.
  Neighboring cards fill available spaces before, beside and below an expanded family. A wider project
  keeps enough room for a closed card beside it; children include their indent in
  the required width. Columns scroll vertically, with no horizontal scrollbar.
- One level of sub-tasks, compact and indented beneath their parent. Cross-project
  children show their project. Each retains its own worker, PR and lifecycle.
- During dragging, the full card or family follows the pointer. A marked landing
  slot moves through the layout as other cards slide aside and fill its origin.
  Position checks use the resting layout so slides do not bounce. A drop settles
  into its slot; pill nesting tucks the lifted card around the pointer. Hover menus
  and text selection stay out of the gesture. Other states stay visibly distinct. Only dropping on the small
  central sub-task pill nests a card. The rest of a card reorders it. A task with
  children cannot become a child. Dragging out or the hover menu removes a parent;
  a detached task returns to its own project's column.
- One shared hover pill provides actions for open, closed and child cards.
- Project and Hydra order can be changed from their content or navigation chips,
  including folded strips. All reversible edits appear immediately and reconcile
  through the existing pending resource, preserving DOM identity.
- Vertical chat gestures stay in their chat; only horizontal gestures move the Hydra axis. Chat retains its own follow/anchor controller.
- Scroll, resizing and opening feel continuous. Expansion, folding and dragging
  animate without jumps. Reduced motion is respected.
- Restart, dropped and slept connections reconcile without a manual reload.
  Connection transitions, recovery and slow renders have structured bounded logs.

## Layers and current state

The core and UI layers are implemented. The live-app pass covers desktop and phone. The previous head passed deslop and required CI; the settled three-row card change is repeating that gate with new browser evidence.

- [x] Read settled design and record its migration decisions.
- [x] Automatic stopped-client/query recovery and bounded connection logs.
- [x] Project groups, deterministic duplicate refusal and atomic keeper choice.
- [x] One-level parent changes, rollups and parent completion/retention.
- [x] Shared multi-Hydra data/threads, horizontal axis and slim header.
- [x] Project grids, compact cards and inline details with worker chat.
- [x] Persisted folds/sizes, shared hover actions, drag ranking/nesting/detach and motion.
- [x] Global Oracle waiting list/search and cross-Hydra task navigation.
- [x] Run desktop/phone interaction and restart/drop proof. Upload the synthetic media to the PR.
- [x] Give Settings its own page, move the Oracle beside it, fill earlier card gaps and match the settled physical drag behavior.
- [x] Commit the implementation in layers. Push and refresh the same draft PR at the checkpoint.
- [ ] Refresh deslop and required CI for the settled three-row closed cards. The five focused regression flips passed on the preceding head.

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

## Closed-card layout

The owner picked three rows in asks 206506 and 206510 (steer r207057). Repository
and other labels sit below the title on every closed card, including sub-tasks.
Repository tags remain visible even in a single-repository project. Legacy free-text
projects keep their plain tag in Ideas. Open cards keep their existing metadata
and editable context. This replaces the two-row comparison; there is no layout switch.

Any other newly discovered product or architecture choice goes to Hydra before
dependent work. Historical events remain replayable.

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
- Lint, CLI/web type checks and the build pass. Full integration and browser suites run in required CI.

The behavior pass fixed a missing replicated sequence that left edits pending,
a server-only planner imported by the browser, opening measured before size settled,
horizontal snap coordinates, a resize preview that skipped its save, and scope
isolation for keyboard, theme, drafts and open task streams.

The owner trial uses its own portless address, data home, made-up repositories
and fake agent providers. Its three Hydras contain 30 tasks, Ideas, grouped
repositories, every requested state, one-level sub-tasks and a Done task older
than 24 hours. Keep that instance running until Hydra says the owner is finished.

The trial exposed crowded metadata, independently sticky project chips and empty
space beside an open card. The toolbar now moves as one unit, chat headers reserve
space for their controls, metadata fits narrow cards and measured placement fills free space before and
beside expanded cards. Position animations keep the reflow continuous.
The browser checks cover both themes at 390, 760, 1440 and 1920px, and project
widths of 280, 740 and 944px. They confirm control separation, readable repository
tags, no horizontal column scroll and cards beside a 660×520 open card. Physical
reorder and nesting still persist. A dropped socket and a restart through portless
retain the open card and reconcile fresh Zero data even when the internal port
changes. The comparison captures show 258px and 360px cards in both themes. The settled three-row layout was then checked on the real trial at card widths 258, 353 and 514px, including indented children down to 232px, in both themes. Repository and label rows stay inside their cards; the existing open-card metadata and context remain available.

The r207090 pass checks Settings at 390, 1440 and 1920px in both themes, including direct reload, Back, the Oracle on Settings and the retained card/draft/offset on close. The opened phone-card example was checked at minimum, typical and wide project widths. Later cards fill its earlier gaps, with no overlaps or horizontal column scroll. Physical drag was checked at the same widths and both themes; neighbors move before release, the landing slot leaves the origin, the order survives reload, pill nesting works and dragging out returns the child to Ideas. A separate headless page exercises the settled Lavish gesture for comparison.

All eight project-view browser cases pass. The existing fold/draft flow now covers the Settings route and reload. Visual arrangement uses a real held-pointer drag and checks live displacement and origin filling before release. One new packing case pins backfilling before an open card. Each changed flow fails under its corresponding mutation in a throwaway copy.

## Validation and readiness

The owner first asked for running-app proof and held new tests. With deslop merged through PR #405, Hydra explicitly requested focused regressions for grouping, visual arrangement, parent retention, folding identity and worker reply recovery. Keep one behavior flow for each, using public commands, saved page facts and rendered behavior; record a failing mutation for each in a throwaway copy. The full suite runs in CI.

Two fresh deslop passes retained eight fixes: stale active-Hydra effects, project and card resize previews retained after saving, stale drag targets, folding that unmounted card state, reused grouping event IDs, unscoped composer focus and an unchecked browser-test callback. Both stopped with the test audit incomplete. The five focused regressions now have passing baselines and failing mutations in a throwaway copy. The affected suites also retain their existing task and Activity coverage; the retired hide-Hydra journey is folded into the current fold/draft flow.

After its quick local commands pass, ask Hydra for CI approval with the waiting run URL and exact SHA. Required checks are `deslop` and `Lint, build and tests`. Confirm the final commit's deslop note and status, report the green head and findings, then mark PR #410 ready. Keep the isolated owner trial running on the latest build with the settled three-row closed cards.

## Focused regression proof

| Behavior | Mutation | Failing observation |
| --- | --- | --- |
| Repository grouping | Reuse the group ID for repeated command event IDs | The third repository task never enters Suite |
| Closed-card labels | Omit the closed-card label row | The grouped repository tag is absent; the passing flow also checks labels through open/close and the legacy Ideas tag |
| Visual arrangement | Omit the live drag preview; earlier proof also ignored arrangement persistence | Neighbors never move while the pointer is held; the earlier mutation loses the saved order |
| Dense packing | Prefer the lowest free space over earlier gaps | The later card no longer fills the earlier space beside the open family |
| Settings page | Remove the server's Settings-route support | Reload returns to the Hydra instead of Settings |
| Parent retention | Suppress all-children completion | The parent's completion timestamp remains absent |
| Folding identity | Unmount folded project content | The original open card is disconnected |
| Worker reply recovery | Omit worker reply sending | The worker never receives the reply after reconnect |

The passing reply flow drops the first command before the server receives it, then checks delivery acknowledgement and exactly one worker delivery after reconnection. Native steering envelopes can contain the same prose; counting every text occurrence is not a delivery assertion.

## CI compatibility pass

The first full CI run exposed old chat journeys that selected conversations globally and a privacy allowlist that omitted the new public sequence. Chat selectors, paging counters, loader checks and touch input now target their own workspace/conversation. The privacy assertion still names every allowed field explicitly, including `seq`.

The scoped journeys also reproduced competing scroll controllers and vertical gestures moving the horizontal Hydra axis. Keep chat's existing follow/anchor controller and give the axis horizontal gestures only. The affected chat and access suites pass all 19 cases after those fixes.
