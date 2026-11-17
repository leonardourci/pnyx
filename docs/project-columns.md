# Project columns: implementation spec

This is the living spec for task `task-ecfe3cac-541d-4dd5-a876-5cc8229f2365`. Its source is talk task `task-d8d6de12-aab7-474e-ad13-2a01b8f01de1`, rounds 1–9 and the settled Lavish page. Later owner decisions put Settings on its own page, choose three-row closed cards, make open cards full-width and require Shift for nesting. Grouping A is settled: project columns, with Ideas first. Labels never define columns.

## Settled behavior

- A slim header replaces the sidebar. Hydra chips show waiting counts and navigate to each Hydra's own chat and composer. The Oracle finds waiting work across Hydras. Settings opens at `/hydra/<id>/settings/` as a full page. Closing it preserves the workspace's open cards, unsent drafts and horizontal position; Back and reload work.
- Hydras sit side by side on a horizontal axis that snaps to each Hydra. Each has its own chat, project chips and project columns. Hydras, chats and projects fold. A folded Hydra also lists its projects. A control folds all projects together. Its shared fold icon points inward horizontally toward a vertical divider.
- Ideas is the first column and contains tasks without a project. Attaching a project moves a task into that project's column. Each project has one Hydra; each repository has one project. A project can group several repositories.
- Project columns resize from a minimum of 280px with no maximum. Their grids fit as many compact cards per row as their width allows.
- A closed card has three rows: state pill, age and provider icon (model and existing usage panel on hover); chevron and title; repository tag and other labels. Root and sub-task cards share this layout. Ideas without labels omit the empty row. Only parents have chevrons. A parent rolls up state and completed-part count. Compact state and age labels leave room for progress. Full state details remain on hover; tags stay inside the card and wrap instead of losing text.
- Order is needs you, running, waiting/paused/queued, done. Dragging reorders within a state group. Done tasks disappear after 24 hours, honoring task hide overrides.
- Clicking opens a card in place. Clicking its title folds it. The open card has all existing details and worker chat side by side, minimum 560×440, no maximum. It fills its project column in its own row at its place in task order. Window mode is an explicit action and never changes the next click's behavior. Its width follows the same project width, with no separate width control. Cards before and after it fill complete rows, including partial rows that stretch to the available width. Children include their indent in the required width. The project handle is the only width control; cards keep their height handle. Columns scroll vertically, with no horizontal scrollbar.
- One level of sub-tasks, compact and indented beneath their parent. Every write path, including hooks and untracked pushes, rejects deeper nesting. Existing deeper descendants display as sub-tasks of their top-level ancestor without changing stored parentage. Cross-project children show their project. Each retains its own worker, PR and lifecycle.
- During dragging, the full card or family follows the pointer. A marked landing slot moves only when the card crosses into the next position. Small movements leave the order alone. Neighbors slide aside and fill its origin.
- Plain dragging only reorders siblings within their state group. Holding Shift over a root card nests the task beneath it; releasing Shift returns to reorder. Escape cancels without closing an open card. A task with children cannot nest. Only during the gesture, the lifted card shows one “⇧ Sub-task” keycap, lit while Shift is held. The target has an inset drop outline. During an eligible task drag, its source project header shows “Hold Shift and drop on a task to make it a sub-task” without moving the grid. A nesting drop shrinks the lifted card into its parent, then reveals the child; reorder drops retain their landing motion. There is no nesting pill. “Move out of its parent” in the shared hover menu detaches a child and returns it to its own project. Plain drag never changes parentage.
- Keyboard task movement is vertical and sibling-only through `task arrange`. Left/right on a project heading saves project-column order; it never changes a task’s project or lifecycle. Shortcuts and focus stay inside their owning Hydra.
- One shared hover pill provides actions for open, closed and child cards.
- Project and Hydra order can be changed from their content or navigation chips, including folded strips. All reversible edits appear immediately and reconcile through the existing pending resource, preserving DOM identity. A refused creation draft is restored only in its own repository or project group.
- Vertical chat gestures stay in their chat; only horizontal gestures move the Hydra axis. Chat retains its own follow/anchor controller.
- Scroll, resizing and opening feel continuous. Expansion, folding and dragging animate without jumps. Reduced motion is respected.
- Restart, dropped and slept connections reconcile without a manual reload. Connection transitions, recovery and slow renders have structured bounded logs.

## Implementation and remaining work

The project, task, recovery and UI layers are implemented. dnd-kit owns sorting, sensors and the drag overlay; Motion owns card and column layout animation. The handwritten drag, animation and packing engines are deleted. Collision selection follows pointer/modifier changes, so animation cannot shuffle cards under a stationary pointer. Reordering commits the displayed slot rather than recalculating against moving cards at release. Edge scrolling starts near the viewport edge.

Rewritten workspace pieces use Tailwind utilities on theme tokens: header, Hydra strip, project grids, cards, open-card layout, composer placement, Settings shell and drag layer. Button, Label and HoverActions convert once for every caller. Their old rules are removed. CardShell and its content, heading, panel and section components share card variants. StatePill, Label, Chip, SortableChip, ProjectColumnHeader, IconButton, SortablePanel, WaitingCount and SettingsFrame own the repeated styles. Chat, Oracle and existing Settings section layouts retain their styling. Only the visible hover menu follows its card through Motion’s frame callback. Its shared geometry stays clamped inside the viewport, including during layout motion.

Instructions always show in full. Worker chat uses the same Composer as Hydra chat, including task/file mentions, skills, commands, images and file attachments, without model controls. Pending replies retain one event ID through uncertain delivery and reconnect. A resize starts only on its visible captured grip; a release or a gesture begun elsewhere cannot resize a project.

The owner mentioned another screen that should open as a modal; Hydra is confirming which one. Its behavior stays unchanged until that clarification.

Remaining: finish the current-head deslop proof and required CI, then report the green head and mark PR #410 ready. Per owner direction, deslop runs at readiness, never after intermediate commits. CodeRabbit remains the owner-requested challenger.

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
| Saved per-card widths | Schema 7 removes them from view rows; replay and undo normalize old events without rewriting history | Implemented; project widths and card heights stay |
| Free-text project labels | Ideas with a plain tag until assignment | Implemented per ask-204158 |

## Ownership and legacy values

Existing duplicate repository attachments keep working after upgrade and no task moves automatically. Setup and Settings name each duplicated repository and its Hydras. An explicit keeper choice moves all affected tasks and records each move. New duplicate attachments are refused deterministically (ask-203840).

Keeper selection is all or nothing. If any task cannot move, refuse with every blocking task and reason. Blockers include live workers, PRs in flight, parent/dependency links, Firstmate mirrors and active sources. Move nothing and defer nothing; the owner retries after clearing the blockers (ask-203909).

A free-text project with no attached repository stays stored, appears as a plain tag and places its task in Ideas. There are no temporary columns. Assigning a real repository moves the task into its project column (ask-204158).

## Running-app evidence

The isolated owner trial uses real Postgres, Zero and the built app with fake provider boundaries, three synthetic Hydras and 30 made-up tasks. It contains grouped repositories, Ideas, all requested lifecycle states, sub-tasks, provider icons and an expired Done card. Keep it running at the stable portless URL until Hydra says the owner is finished.

Headless Chrome checks cover 390, 1440 and 1920px viewports in both themes. Closed project widths are 280, 944 and 1440px; open cards are checked at their minimum and wider sizes. Checks cover full-width rows, surrounding partial rows, repository/label containment, header/chip controls, small drag movements, pointer following, live displacement, plain reorder, Shift nesting, modifier release, Escape cancellation and parent removal. The shared controls have before/after Chat and Oracle screenshots in both themes.

A real wheel gesture snaps to the next Hydra after layout settles. Forced socket drops reconcile a title edited while disconnected. A real portless stop/start changes the instance PID and port, then reconnects without reload, retains the selected card DOM and receives a fresh Zero update. The latest running-app proof reports no page errors. Settings navigation, Back/reload and retained cards/drafts are also covered by the browser journey.

Connection transitions and stale/reconciled sequences use structured logs. Slow render commits over 32ms aggregate count and worst duration at most once every five seconds. Logs retain identifiers and timing, not prompts or credentials.

## Performance and size

The comparison uses separate isolated instances of the native-animation revision and the completed library build: Chrome 157, 1440×960, 24 cards, a 944px project, three held drags and three open/close cycles. Intervals come from requestAnimationFrame marks in the Chrome trace; they are not presented-frame FPS. Both runs include idle samples on the same shared machine.

| Interval, median / P95 ms | Native | Current dnd-kit / Motion |
| --- | --- | --- |
| Idle | 51.2 / 70.1 | 55.6 / 76.0 |
| Drag | 50.7 / 79.4 | 45.5 / 75.8 |
| Open | 46.7 / 76.6 | 52.6 / 75.5 |
| Close | 56.7 / 78.2 | 33.3 / 79.2 |

The libraries add about 62.5 KB gzip JS. There is no measured speed change within this noise. The gains are keyboard dragging with the same legal destinations as pointer sorting, continuous reflow and deleting the handwritten engines. Hydra confirmed retaining the libraries with that cost (ask-207933). Earlier faster samples are not a performance claim. The measured component/nesting build, before readiness fixes, totals 509,968 gzip JS bytes versus 440,022 before the libraries: 69,946 bytes overall. Current build totals and hashes are recorded in the PR measurement artifact. The initial Tailwind baseline CSS was 150,454 bytes raw / 28,379 gzip; the completed UI is 149,788 / 28,123. Authored qualified rules fell from 1,463 to 1,108, removing 355 rules; this counts nested media/supports rules and excludes keyframe steps and theme declarations. Exact build provenance, matching clips and sanitized traces are linked from PR #410.

## Behavioral validation

The nine original project-view browser journeys and the additional refused-draft journey pass. The two affected browser files also passed all 20 original journeys in the failed CI order after test-context cleanup and visible-target corrections. All ten worker-scope checks pass. The focused saved-width migration also passes. Full integration and browser suites run in required CI on the final head. All local code checks run again through deslop.

| Behavior | Failing mutation / observed refusal |
| --- | --- |
| Repository grouping | Reusing group identity as command event identity leaves the third repository outside Suite |
| Closed labels | Removing the closed label row loses the grouped repository tag |
| Live and saved arrangement | Omitting the preview stops displacement; losing persistence restores the old order after reload |
| Plain drag never nests | Treating ordinary drops as parent changes makes the parent assertion fail |
| Shift-drop nests | Ignoring the nesting drop leaves the task without its selected parent |
| Drag instruction | Omitting the source-column instruction leaves its visible count at zero |
| Nest animation | Restoring the ordinary drop animation never shrinks the overlay into its parent |
| Keyboard arrangement | Disabling keyboard coordinates prevents the rendered order from changing; the passing flow checks both directions after reload |
| Complete legacy tags | Disabling wrapping clips the long legacy tag at the column minimum |
| Small movements stay put | Selecting a neighbor while the pointer remains in the source changes the initial order |
| Full-width open rows | Removing the full-row basis leaves the open row or its surrounding partial rows too narrow |
| Resize arming | Restoring the full-height hit area makes a blank-edge gesture change width while held |
| Saved-width cleanup | Suppressing migration cleanup leaves the retired card-width map in the stored view |
| Shared worker attachments | Restoring the plain worker form removes the file-attachment control |
| Reply recovery | Suppressing delivery leaves the reply undelivered after reconnect; the passing flow asserts one delivery with file name and body |
| Refused creation recovery | Omitting destination matching restores a repository draft when opening Ideas |
| Settings route | Removing server route support loses Settings on reload |
| Folding identity | Unmounting folded content disconnects the original selected card |
| Parent retention | Suppressing all-children completion leaves the parent's completion timestamp absent |

Mutations run in throwaway copies against public commands, rendered behavior and delivered replies. They never touch real homes, providers or external tools. Earlier CI compatibility fixes scope chat journeys to their workspace/conversation and retain the privacy allowlist, including public `seq`. The affected chat/access suites passed all 19 cases before the current UI refinement; the final CI run refreshes that coverage.
