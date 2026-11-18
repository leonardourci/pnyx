# Project columns: implementation spec

This is the living spec for task `task-ecfe3cac-541d-4dd5-a876-5cc8229f2365`. Its source is talk task `task-d8d6de12-aab7-474e-ad13-2a01b8f01de1`, rounds 1–9 and the settled Lavish page. Later owner decisions put Settings on its own page, choose three-row closed cards, make open cards full-width and require Shift for nesting. Grouping A is settled: project columns, with Ideas first. Labels never define columns.

## Settled behavior

- A slim header replaces the sidebar. Hydra chips show waiting counts and navigate to each Hydra's own chat and composer. The Oracle finds waiting work across Hydras. Settings opens at `/hydra/<id>/settings/` as a full page. Closing it preserves the workspace's open cards, unsent drafts and horizontal position; Back and reload work.
- Hydras sit side by side on a horizontal axis that snaps to each Hydra. Each has its own chat, project chips and project columns. Hydras, chats and projects fold. A folded Hydra also lists its projects. A control folds all projects together. Every toggle shows the action it will perform: fold-all points inward toward a vertical divider until every project is folded, then points outward to unfold. A partial fold folds the remaining projects. Individual horizontal and vertical chevrons point toward their next action.
- Ideas is the first column and contains tasks without a project. Attaching a project moves a task into that project's column. Each project has one Hydra; each repository has one project. A project can group several repositories.
- Project columns resize from a minimum of 280px with no maximum. Their grids fit as many compact cards per row as their width allows.
- A closed card has three rows: state pill, age and provider icon (model and existing usage panel on hover); chevron and title; repository tag and other labels. Root and sub-task cards share this layout. Ideas without labels omit the empty row. Only parents have chevrons. A parent rolls up state and completed-part count. Compact state and age labels leave room for progress. Full state details remain on hover; tags stay inside the card and wrap instead of losing text.
- Order is needs you, running, waiting/paused/queued, done. Dragging reorders within a state group. Done tasks disappear after 24 hours, honoring task hide overrides.
- Clicking opens a card in place. Clicking its title folds it. The open card has all existing details and worker chat side by side, minimum 560×440, no maximum. It fills its project column in its own row at its place in task order. The explicit Open as a modal action uses the shared dialog with a dimmed backdrop, trapped focus, Escape/outside dismissal and focus return to the inline card. Its task URL survives reload and Back/Forward. Card clicks keep inline opening. Its width follows the same project width, with no separate width control. Cards before and after it fill complete rows, including partial rows that stretch to the available width. Children include their indent in the required width. The project handle is the only width control; cards keep their height handle. Columns scroll vertically, with no horizontal scrollbar.
- One level of sub-tasks, compact and indented beneath their parent. Every write path, including hooks and untracked pushes, rejects deeper nesting. Existing deeper descendants display as sub-tasks of their top-level ancestor without changing stored parentage. Cross-project children show their project. Each retains its own worker, PR and lifecycle.
- During dragging, the full card or family follows the pointer. A marked landing slot moves only when the card crosses into the next position. Small movements leave the order alone. Neighbors slide aside and fill its origin.
- Plain dragging only reorders siblings within their state group. Holding Shift over a root card nests the task beneath it; releasing Shift returns to reorder. Escape cancels without closing an open card. A task with children cannot nest. Only during the gesture, the lifted card shows one “⇧ Sub-task” keycap, lit while Shift is held. The target has an inset drop outline. During an eligible task drag, its source project header shows “Hold Shift and drop on a task to make it a sub-task” without moving the grid, centered with a “⇧ shift” keycap. While Shift is held over a valid parent, the lifted card shrinks and its keycap stays readable; leaving the parent or releasing Shift restores its size. A nesting drop shrinks the lifted card into its parent, then reveals the child; reorder drops retain their landing motion. There is no nesting pill. “Move out of its parent” in the shared hover menu detaches a child and returns it to its own project. Plain drag never changes parentage.
- Keyboard task movement is vertical and sibling-only through `task arrange`. Left/right on a project heading saves project-column order; it never changes a task’s project or lifecycle. Shortcuts and focus stay inside their owning Hydra.
- One shared hover pill provides actions for open, closed and child cards.
- Project headings and navigation chips reorder projects, including folded strips. Hydra controls and chips reorder Hydras. All reversible edits appear immediately and reconcile through the existing pending resource, preserving DOM identity. A refused creation draft is restored only in its own repository or project group.
- Vertical chat gestures stay in their chat; only horizontal gestures move the Hydra axis. Chat retains its own follow/anchor controller.
- Scroll, resizing and opening feel continuous. Expansion, folding and dragging animate without jumps. Reduced motion is respected.
- Restart, dropped and slept connections reconcile without a manual reload. Connection transitions, recovery and slow renders have structured bounded logs.

## Implementation and remaining work

The project, task, recovery and UI layers are implemented. dnd-kit owns sorting, sensors and the drag overlay; Motion owns card and column layout animation. The handwritten drag, animation and packing engines are deleted. Collision selection follows pointer/modifier changes, so animation cannot shuffle cards under a stationary pointer. Reordering commits the displayed slot rather than recalculating against moving cards at release. Edge scrolling starts near the viewport edge.

The workspace pieces and shared composer use Tailwind utilities on theme tokens: header, Hydra strip, project grids, cards, open-card layout, composer placement, Settings shell and drag layer. Button, Label and HoverActions convert once for every caller. Their old rules are removed. CardShell and its content, heading, panel and section components share card variants. StatePill, Label, Chip, SortableChip, ProjectColumnHeader, IconButton, SortablePanel, WaitingCount and SettingsFrame own the repeated styles. The parallel Tailwind task converts Chat, Oracle, Settings sections and the remaining shared controls on this branch. It leaves the composer and workspace pieces here. Only the visible hover menu follows its card through Motion’s frame callback. Its shared geometry stays clamped inside the viewport, including during layout motion.

Instructions always show in full. Worker chat uses the same Composer as Hydra chat, including task/file mentions, skills, commands, images and file attachments. Pending replies retain one event ID through uncertain delivery and reconnect. Hydra sends use the connection’s existing saved-command outbox, so delivery resumes after reload while the owning Hydra is off-screen. A visible composer joins that request; a definite refusal is stored and shown when its chat mounts. A resize starts only on its visible captured grip; a release or a gesture begun elsewhere cannot resize a project.

Direct worker starts and switches (task `task-9115947a`, included here by owner direction):

- Sending from a task without a worker starts it directly in its normal repository copy; a new task can be created and started from the same composer. Hydra learns through its normal since-last-turn notes, without a coordination turn.
- The shared composer has harness, model and effort controls. Same-harness changes retain the session. A different harness starts a fresh session carrying a command to read the recorded prior conversation. Card chat retains earlier assistant replies; explicitly selecting a session reads that session alone.
- A send during a live turn that changes the agent queues the message and target harness/model/effort until that turn ends. It never cuts off work silently; Stop then Send is the immediate path (ask-209958). A queued change survives restart; Stop cancels it.
- An outside terminal, Firstmate or Paseo session keeps its existing reply route. Harness/model controls stay disabled, without hint text, until Continue in Pnyx succeeds (ask-210044).
- The shared Repository picker preselects project-column repositories and offers every attached repository in Ideas or an unassigned card. Picking assigns an existing card. Send stays disabled until assignment is confirmed when starting a worker. Save task works without a repository (ask-210177).
- A legacy card with a worker and no repository keeps sending into its existing folder. It offers the same picker; assignment affects later starts and never moves its running worker (ask-210263).
- A provisional task stays in its chosen project and retains its selected DOM node through confirmation. Its composer waits for creation confirmation before starting work; conversation reads use the existing command dependency queue. An unsent draft survives moving its card to a project, including when browser storage is full.

The modal choice is settled: the former Open as a window card action becomes a real modal. Modal and inline cards share a Focus on chat toggle that hides the summary and gives the conversation full width. Its directional icon brings the summary back; the choice persists per user in browser storage and applies to other cards. The narrow modal stacks summary and chat when both are visible. No separate composer or dialog is introduced.

Before merging, the owner will request a final broad Tailwind review in addition to CodeRabbit.

Remaining: integrate the parallel Tailwind commits, then run one deslop pass and required CI on the final head. After green, refresh the trial and capture the complete light/dark media on that head before reporting readiness. Per owner direction, deslop runs at readiness, never after intermediate commits. CodeRabbit remains the owner-requested challenger.

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
| Direct card start | Omitting delivery for cards without agents leaves the worker absent |
| Turn-boundary settings | Applying changes mid-turn changes the fake provider’s model before the held turn finishes |
| Same-harness retention | Starting a fresh session for model changes prevents the original session receiving its next turn |
| Normal task copy | Starting in place makes the worker folder equal the repository |
| Cross-harness context | Omitting the handoff reference loses the previous conversation command |
| Stop cancels queued changes | Leaving queued switches intact keeps the stopped message queued |
| Pending switch recovery | Treating an input not yet handed to a session as uncertain strands it after restart |
| Refused-start retry | Reusing the original queue event prevents the same message starting after its account is configured |
| Prior assistant replies | Removing prior task sessions loses the earlier assistant reply after a harness switch; an explicit session remains isolated |
| Task-key conversation lookup | Selecting the subscription map by the alias returns an error instead of the task’s thread receipt |
| Unsent draft through assignment | Removing the live draft identity loses the typed message during the project remount when browser draft storage is full |
| Optimistic project placement | Omitting the create command’s project puts the held new card in Ideas instead of its selected repository |
| Repository picker focus | Restoring ordinary card-click handling closes the card when its Repository option is picked, so Send never becomes available |
| Outside-session controls | Removing the lock enables model controls before Continue in Pnyx |
| Fold action | Keeping the inward icon after every project folds fails the outward-action assertion |
| Shift-hover and landing | Removing hover scale prevents shrink; removing drop animation loses intermediate positions on the way to the final card |
| Refused creation recovery | Omitting destination matching restores a repository draft when opening Ideas |
| Settings route | Removing server route support loses Settings on reload |
| Folding identity | Unmounting folded content disconnects the original selected card |
| Parent retention | Suppressing all-children completion leaves the parent's completion timestamp absent |

Mutations run in throwaway copies against public commands, rendered behavior and delivered replies. They never touch real homes, providers or external tools. Earlier CI compatibility fixes scope chat journeys to their workspace/conversation and retain the privacy allowlist, including public `seq`. The affected chat/access suites passed all 19 cases before the current UI refinement; the final CI run refreshes that coverage.


The seven `tests/card-input.test.ts` flows are kept: direct start and receipt retry, cross-harness handoff and visible history, turn-boundary settings with session retention, a new repository copy, Stop cancelling a queued change, same-message retry after a refused start, and queued-switch restart recovery. Each covers a separate worker boundary through the real CLI/server; the provider is the only fake.

The three `tests/e2e/card-input.test.ts` journeys are kept for page behavior: Ideas and unassigned-card starts with repository selection, held creation, DOM retention and unsaved draft retention; outside-session controls before and after Continue; task modal open/close, focus trapping/return, fresh task addresses, Back/Forward, reload, draft retention and the persistent chat-only choice. Grouping, folding, drag/nest and legacy reply recovery assertions stay in the existing workspace journeys rather than adding parallel tests. The affected worker/history/paging run passes 28/28, and the six affected browser journeys pass. Full required CI and final deslop remain pending on the combined branch; previous green evidence belongs to `5fddda1a`.

A provisional-thread guard mutation survived because the shared command dependency queue already waits for task creation. The redundant query guards and their duplicate assertions were removed; the existing mechanism handles that boundary.

The modal journey fails before the shared Dialog Tab boundary fix (focus reaches the page body), and before the idle-resize Escape fix (the modal remains open). Throwaway mutations also fail when task URLs stop opening fresh pages, focus return is removed, summary hiding is disabled, or the preference is kept only in memory instead of durable browser storage. Media for these views remains pending until the combined head is green.


The remaining composer styles now use DraftChip and ChipIcon for inline references, the existing SuggestionPicker on FloatingPanel for mention/slash menus, and UsageRow, UsageStack, UsageText and UsageSection for the ring’s shared detail view. Attachment cards, image/viewer surfaces and queued-comments placement use the same utility/theme approach. AgentPickers, account/model menus, compaction/agent-change controls and shared comment surfaces stay with the Tailwind worker (ask-212055, ask-212241).

The isolated composer comparison uses the real app at pinned baseline `933d1c1a` and the converted build, in both themes, for Hydra/card chips and mention menus plus the usage tooltip. Visual comparison preserved the menu’s gold border explicitly when FloatingPanel’s default border won. The five affected creation, outside-session, modal, grouping and reply-recovery journeys pass. This is a style refactor; no new regression tests are added, and the temporary capture fixture stays outside the PR. Captures remain local for the final media batch.

For this composer slice, compiled CSS changes from 169,699 to 173,816 raw bytes, and from 31,130 to 31,715 gzip bytes (+585 gzip). It removes 84 legacy selector blocks, counting each existing one-line qualified block once. This is a slice comparison against the shared-primitives checkpoint, not the final whole-branch Tailwind total. Final combined numbers follow the remaining Tailwind work.

### Trial feedback, November 17

Settled: the child hover action is **Remove from parent**, with an outdent icon. Hover controls use the shared outline icon set and size. Open-card summary and family controls sit at the right of the Context / Activity row. Only the active tab has an underline; the row has no border. Resize grips share one style: muted at rest, gold while hovered or dragged.

Shift nesting keeps reparenting: a child can move directly under another root. A drop on its current parent does nothing. Only a target that is itself a child, or a source that has children, is refused. During Shift hover the lifted card replaces its keycap with the short reason; an ordinary drag shows neither refusal nor nesting outline. Refused drops preserve both families (ask-213016).

The task modal defaults to 70% of the viewport width and 80% of its height, with a small margin and the existing minimum/viewport limits. Resizing remembers its dimensions for the user, and smaller viewports clamp them. Chat-only is also a user preference across tabs and reloads. Shared Motion layout connects the inline card and the modal, with the same off switch and reduced-motion preference. The modal shows its title once in its header and uses only its own resize handles. Separate inline and modal anchors keep the hover bar on the card after closing.

Card sizing lives beside the shared motion module. A closed card that fits one normal grid cell keeps its own size while lifted; the cell is derived from the project width, minimum card width and gap. An open card stays full size over its own slot, and compacts only after entering another slot, column or valid nest target. It grows back on returning or dropping. Real width and height animate without stretching the text; the relative grab point stays under the pointer through resizing and uniform Shift shrink. Open cards keep their drag handle and title drag while their conversation remains usable.

Project columns, fold-all, sub-task groups, Hydra workspaces and chat animate their size and fade. Closed content unmounts after its transition; task-keyed state restores it on return. Motion and dnd-kit consume the shared CSS timing tokens; the runtime off switch and OS reduced-motion preference also disable their JavaScript animations. Oracle previews use the same three-line heading as cards, so the age appears once.

The composer comparison pins `fc73e170` and measures the real app at 1440px and 390px in both themes. The baseline is 106px for the Hydra composer, 48px for its text field and 48px for the question note. Before correction, the converted version measured 86.39px, 34.39px and 36px. Removing the composer's competing minimum retains the shared Textarea's 48px minimum; the composer bar stops overriding the account picker's native 36px height with 30px. Attachment and Send buttons retain their baseline 30px height. The composer also owns its Chromium scrollbar override through the shared `composer-text` recipe used by the field and draft mirror; the stale feature selector is removed.

The affected journeys pass on the checkpoint: modal behavior, parent removal, depth refusals and reparenting, pointer anchoring, closed/open drag sizing, undistorted landing, all folds, Oracle headings, and field measurements at both widths/themes. Motion twice stopped before Chrome opened because scratch zero-cache readiness never reached HTTP 200. Four later cold starts pass unchanged with retained logs, no Zero exits or restart, and clean private-process teardown. The exact cause of the two earlier startup failures remains unconfirmed because those runs did not retain their logs. CI already preserves the scratch homes and Postgres logs on failure.

The owner trial was refreshed at `67f4d8b7`, after rebasing on the Tailwind and icon-sweep checkpoints. Its page and Zero endpoint both return HTTP 200. The owner reviews this UI before final deslop, CI and CodeRabbit (r214731, ask-214814). Final before/after media remains for the final combined head. Thirteen targeted mutations fail at the promised behavior: parent removal, both depth refusals, reparenting, grab anchoring, conditional sizing, open-card drag, fold transitions, modal default and saved size, composer height, Oracle age and undistorted growth. The final drag control passes; replacing real width animation with ScaleX changes title width by about 253px and fails the 1px tolerance. The drag fixture resolves the live target after layout settles instead of reusing its earlier coordinates. A duplicate composer minimum was removed after its mutation survived: the shared Textarea already owns that value. Open: incorporate further owner feedback, then run the single final gate. Intermediate pushes do not run deslop or request CI approval.


### Header dragging and dense trial

Opened cards lift from the title and blank space in the Context / Activity row, using the same drag sensor as closed cards. Buttons, tabs, fields, resize handles and tooltip panels keep their own behavior. The journey checks title and options-row pickup, persisted sibling order, and the retained conversation draft; presses in a tab or tooltip never start a drag. Its negative runs fail without the header listener and the popover exclusion. The four affected journeys pass, including the modal and the desktop/phone field-height checks.

The isolated trial has 86 additional made-up tasks across three Hydras, project and Ideas columns, one-level families, questions, completed and parked work, plus chat history. Synthetic providers supply three ongoing worker conversations; no real worker harness is launched. This fixture stays in the private trial home.

Open: profile the dense view before and after the performance changes, using Chrome traces and the polish worker's opt-in Profiler metrics. The first marked drag trace contains a 129ms main-thread task and hover contains a 53ms task. Final budget checks require no task above 50ms during drag/scroll and bounded rendering when one task changes. Hidden-tooltip dismissal and repeated style reads are being addressed; no speed improvement is claimed until the comparison passes. The owner's trial review still precedes the single final deslop and CI gate.


### Large-workspace stress findings

The 628-task, six-Hydra stress run blocks the merge. Required: cards and project columns use TanStack Virtual windows, and off-screen Hydra bodies unmount. Width placeholders keep the horizontal layout steady. Drafts, selection, family folds and scroll offsets live outside those DOM nodes and return when a view remounts. The retention test checks restored state, not a permanently mounted node. Focused fields, composition, an active drag and the modal remain mounted until the owner finishes that interaction (ask-216413).

Scrolling uses one shared Lenis frame loop. A task's modal action selects it without waiting for inline-card scrolling. The addressed Hydra stays anchored as other Hydra widths load. The virtual windows and the 628-task/six-Hydra CI fixture pass the local browser checks. The fixture bounds mounted cards, columns and DOM nodes, preserves a late Hydra address while earlier widths change, and exercises keyboard pickup, streaming, task-render isolation and drag/scroll budgets. Open: validate and fix the stress findings, then await Hydra's stress-complete signal before the single final deslop and CI approval.

The title-only Save task path omits an empty ask; it saves an Idea without a repository or worker. The existing start-from-card journey now begins with that empty-ask case and still holds creation confirmation to prove the optimistic card is retained.

Expanded sub-task families take their own full-width row, like an open task; neighboring families keep their visual order, with no masonry (ask-217174). Fold changes use an id-to-boolean patch through `view set` and the same optimistic reducer, merged against current state; stored folds remain an array. No caller on main used this new setting, so the replacement-array input is removed and the CLI example and shipped arrangement skill use the patch (ask-217052). New-task form identity, fields and agent selection survive reload as well as virtualization.


Windowing proof so far: the recovery, calm reorder/Shift-nest, full-width row and simultaneous two-tab fold journeys pass. The phone journey passes in both themes, including a single horizontal wheel snap. The six-Hydra/628-task profiling journey passes its mounting limits (24 visible cards, no cards in the other Hydras), late-address retention and at-most-four task commits for an isolated rename. It passed the complete drag/scroll budget once; repeat runs still exceed the 50ms drag budget, so this checkpoint is not a performance sign-off. A retained Chrome trace attributes the costly sections to React/Motion commits and layout measurement; further reduction and the fresh stress rerun remain open. Synthetic keyboard checks wait for the lifted card's first paint before the next key, because dnd-kit installs its keyboard listener in a deferred task.

The stress worker retracted the idle Lenis CPU allegation after a matched idle measurement. The shared scroll loop removes duplicate schedulers, but no 8% idle improvement is claimed. Still open from the ranked list: streaming DOM/heap growth attribution, repeated discovery commands, final visual checks of chip/badge containment, and the complete stress rerun. The title-only creation, modal action, chat-only tabs, retained new-task draft and concurrent folds have targeted regression coverage. Final deslop, CI and media remain held until Hydra declares the stress findings complete.

The large-board journey runs twice (r217782): the normal renderer enforces the unchanged 50ms drag/scroll budget, while the profiling renderer enforces redraw counts and mounting bounds. This separates React timing overhead from production latency; no retries hide a miss.

After deferring hidden navigation and composer discovery, and observing project intents without reading their lists, the six-Hydra journey passes in both builds: normal drag/scroll stay within 50ms, and profiling commits and DOM stay within their bounds. Initial discovery is bounded to two model requests, one project-list request, one catalog request and two rule requests. The browser waits for fonts before measuring motion. A wider run exposed a 64ms production drag task. Drag subscriptions now sit in the shell and grip, and duplicate focus/press/drag protection shares one viewport update. The normal stationary-pointer and 628-task journeys meet the unchanged 50ms gate. The fresh stress rerun remains open.


Streaming DOM growth is attributed to reused provider message ids retaining the same live render-key alias on several completed replies. TanStack requested seven rows, but duplicate React keys left old rows attached. The shared alias mapping now releases the previous owner before transferring a live key. A real streamed-turn journey checks unique message ids, a bounded history window, and the same reply element through confirmation. In the 40-turn diagnostic, turns 8–40 keep seven mounted messages and 483–484 elements; before the fix, mounted messages rose from 46 to 266 and elements from 2,597 to 14,305. Forced-GC JavaScript heap after the fix grows from 12.2 to 13.9 MB as conversation data grows; no flat-heap claim is made. Workspace visibility also excludes zero-area intersections, so a Hydra touching the viewport edge does not mount its body.


Failure flips now prove that the journeys reject mounting off-screen Hydra bodies, mounting every task row or project column, packing an expanded family beside a short neighbor, replacing another tab's folds, restoring six initial project-list reads, and reusing a live reply key on several completed messages. The family fixture retains a multi-card width so its assertion cannot pass just because the column becomes narrow.

| Stress finding | Current result |
| --- | --- |
| 1, 3: mounted work and drag cost | Card/column windows and visible Hydra bodies; normal 50ms drag/scroll budget and profiling redraw/DOM bounds pass locally |
| 2: streaming redraw and sync | Local streamed-turn and windowing checks pass; complete stress load/recovery rerun remains open |
| 4, 9: creation and drafts | Title-only save omits empty ask; new-task title and agent choice survive reload |
| 5, 6: Hydra address and phone layout | Late-Hydra anchoring and 390px project snaps pass |
| 7: simultaneous folds | Id-to-boolean patches preserve both tabs' folds |
| 8, 14: modal and chat-only | Closed hover opens the modal; chat-only omits empty Context/Activity tabs |
| 10: growing DOM | Reused live keys fixed; repeated-stream DOM stays bounded in the diagnostic and journey |
| 11, 13: chip and folded counts | Non-shrinking chips/counts keep badges contained; final media remains held |
| 12: nesting gap | Expanded family takes a full-width row; its failure flip catches the gap |
| 15: repeated discovery | Hidden navigation/catalogs do not mount/read; pending project observers issue no list read. Initial command budgets pass |

Open: the fresh stress rerun, final trace comparison and final visible media. Hydra's stress-complete signal still gates the single deslop and CI approval.


On-screen windows reconcile cached scroll margins in the same observer pass. Whole-Hydra layout animation runs for explicit folding and Hydra dragging; background width changes keep the viewport anchor without a second translation. Opening a card focuses its panel before scrolling, so its row stays protected. A modal card has no sortable registration while its inline card returns, preserving the reverse animation and focus.


The independent anchoring investigation separated two failures. Scroll compensation runs before Motion measures the horizontal axis; the axis uses viewport coordinates, so widening an earlier Hydra does not animate the selected Hydra’s cards. A per-frame regression checks that the visible card stays fixed throughout that change. The chat surface paints above sliding project columns, and an unfold-frame hit test catches a click that would otherwise reach Fold Ideas. The folding journey keeps its existing horizontal position instead of letting Playwright’s retry scrolling move the Hydra.

A fresh Zero read can replace row objects while their decoded card values stay equal. The row cache also retains equal cards from the preceding snapshot, so one changed card does not redraw every visible card. Its regression reads through separate real Zero clients, keeps an unchanged card, and publishes the renamed card. The original profiling bound remains four task commits; the production drag/scroll limit remains 50ms. Final combined proof and the stress rerun remain open.


### Stress rerun refinements

The first critical stress findings passed the 8534ed11 rerun. Folding from far-right projects now clamps the selected Hydra’s offset to its shrinking range, so the view returns to its own workspace instead of stopping across the next Hydra. The correction also cancels the previous smooth-scroll target through the existing Lenis controller. A real horizontal-wheel and fold-button regression covers this. Streamed and settled replies use the same Prose component; the reply-size regression compares both paths against an older reply.

The reported 1,367ms drag frame was the gesture’s duration: the raw `worstFrameMs` was 66.8ms, matching the independent 67ms sampler. Gesture duration is now named `durationMs`, with `worstFrameMs` reserved for the longest sampled frame interval. The existing metric test separates a 1,300ms gesture from a 48ms frame and rejects a late callback after release. The sampler’s lifecycle stays unchanged.

The normal-renderer open-card trace reproduced an 80.8ms cold task and a 46.9ms warm task. CPU samples attribute much of the cold task to synchronous React mount/commit, with TanStack scroll-limit reads and Motion/layout measurements. The largest individual app paths were small portions of that task; no safe isolated rewrite was identified. These diagnostic traces include profiler overhead and do not establish an interaction-speed improvement. The strict production drag/scroll budget remains 50ms. The final combined proof and focused stress recheck are still required before deslop and CI.

Drag pickup captures the visible card position and its grab point together, so a card lifted during a layout animation stays under the pointer. The existing wide-card journey starts from a translated card and checks its anchoring through compacting and Shift-hover.

Folding also keeps the selected Hydra anchored while wheel packets continue arriving. The axis ignores the tail of that gesture until the width and wheel input settle, using the same idle boundary as snapping. A fresh gesture can then scroll normally. The regression interleaves twelve wheel packets with Fold all, checks the anchor beyond the delayed snap and sends a new gesture.

The owner accepted the remaining open-card latency as a follow-up after merge. The interleaved-fold recheck still gates deslop and CI.

Pointer title activation uses the same opening route as the card surface; only keyboard and reference navigation align a virtual row to its start. Opening an already-visible card retains its scroll position, scrolling only enough to reveal a clipped edge after layout settles. The card shell clips its contents during shared layout, so new details cannot paint outside the expanding surface. Modal pointer resizing changes real dimensions without shared-layout scaling, and its header actions stay top-aligned when the title wraps. Frame captures cover short/long titles, parents/leaves, inline/modal, narrow/wide projects and both themes.

## Current owner round

Implemented and checked: pointer opening retains the visible scroll anchor and clips expanding contents. The modal defaults to 70% × 80%, keeps saved dimensions and fixes action anchoring during real resizing. Shared entry/exit animation, focus, URLs and the motion off switch remain covered.

The independent drag render-fan-out patch is committed separately. Lint/build and three focused reorder, wide-card grab/landing and keyboard journeys pass. The investigator measured a median peak of 60ms at 3× CPU slowdown, down from 153ms; this does not establish 50ms compliance.

Sources with children show no nesting hint until Shift is actually held over a refused target. Projects lift from their heading, with keyboard sorting retained; body text, including a modal's portal content, cannot start a project drag. Native dialog behavior keeps the background inert. Written message selections are clipped to their blocks, including whole-line boundaries, and partial task/link text remains selectable. Transcript drags are cancelled while composer token handling stays with the composer. The seven affected pointer/selection journeys and four shared-control journeys pass. Old-renderer controls fail for hint eligibility, column-body activation, modal background activation and all three transcript regressions.

Only the production drag/Escape latency and stationary-pointer drag responsiveness assertions are report-only. They print the measured long tasks and unchanged 50ms threshold. Follow-up `task-c266753d` restores them as blocking; ordinary wheel-scroll, render/DOM and functional gates remain blocking.

Settled, still to implement: Shift-dragging a child outside its family lifts it into root order where it lands, with the same project and state-group rules as root dragging. The shared `task parent <id> none [--before <root>]` command places it before that root or at the end by default. One parent event carries both parent/rank changes and their previous values, so retry and Undo preserve the complete placement. Older parent events keep their existing replay behavior, and raw push input cannot set rank. The existing Remove from parent action keeps its repository-preserving route.

Open: finish Shift-outdent and its CLI/retry/Undo checks, merge main after #413 lands, run the complete affected proof, then run the single final Claude deslop pass and request exact-head CI through Hydra. Trial and final media refresh remain pending for this round.
