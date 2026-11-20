# Project columns: implementation spec

This is the living spec for task `task-ecfe3cac-541d-4dd5-a876-5cc8229f2365`. Its source is talk task `task-d8d6de12-aab7-474e-ad13-2a01b8f01de1`, rounds 1–9 and the settled Lavish page. Later owner decisions put Settings on its own page, choose three-row closed cards, make open cards full-width and require Shift for nesting. Grouping A is settled: project columns, with Ideas first. Labels never define columns.

## Settled behavior

- A slim header replaces the sidebar. Hydra chips show waiting counts and navigate to each Hydra's own chat and composer. The Oracle finds waiting work across Hydras. Settings opens at `/hydra/<id>/settings/` as a full page. Closing it preserves the workspace's open cards, unsent drafts and horizontal position; Back and reload work.
- Hydras sit side by side on a horizontal axis that snaps to each Hydra. Each has its own chat, project chips and project columns. Hydras, chats and projects fold. A folded Hydra also lists its projects. A control folds all projects together. Every toggle shows the action it will perform: fold-all points inward toward a vertical divider until every project is folded, then points outward to unfold. A partial fold folds the remaining projects. Individual horizontal and vertical chevrons point toward their next action.
- Ideas is the first column and contains tasks without a project. Attaching a project moves a task into that project's column. Each project has one Hydra; each repository has one project. A project can group several repositories.
- Project columns resize from a minimum of 280px with no maximum. Their grids fit as many compact cards per row as their width allows.
- A closed card has three rows: state pill, age and provider icon (model and existing usage panel on hover); chevron and title; repository tag and other labels. Root and sub-task cards share this layout. Ideas without labels omit the empty row. Only parents have chevrons. A parent rolls up state and completed-part count. Compact state and age labels leave room for progress. Full state details remain on hover; tags stay inside the card and wrap instead of losing text.
- Order is needs you, running, waiting/paused/queued, done. Dragging reorders within a state group. Done tasks disappear after 1 hour by default, honoring task hide overrides.
- Clicking opens a card in place. Clicking its title folds it. The open card has all existing details and worker chat side by side, at least 560px wide. It fills the height available inside its project column and follows viewport resizing, in its own row at its place in task order. The explicit Open as a modal action uses the shared dialog with a dimmed backdrop, trapped focus, Escape/outside dismissal and focus return to the inline card. Its task URL survives reload and Back/Forward. Card clicks keep inline opening. Its width follows the same project width, with no separate width control. Cards before and after it fill complete rows, including partial rows that stretch to the available width. Children include their indent in the required width. The project handle controls width; inline card height follows the column. Columns scroll vertically, with no horizontal scrollbar.
- One level of sub-tasks, compact and indented beneath their parent. Every write path, including hooks and untracked pushes, rejects deeper nesting. Existing deeper descendants display as sub-tasks of their top-level ancestor without changing stored parentage. Cross-project children show their project. Each retains its own worker, PR and lifecycle.
- During dragging, the full card or family follows the pointer. A marked landing slot moves only when the card crosses into the next position. Small movements leave the order alone. Neighbors fill its origin in normal document flow.
- Plain dragging only reorders siblings within their state group. Holding Shift over a root card nests the task beneath it; releasing Shift returns to reorder. Escape cancels without closing an open card. A task with children cannot nest. Only during the gesture, the lifted card shows one “⇧ Sub-task” keycap, lit while Shift is held. The target has an inset drop outline. During an eligible task drag, its source project header shows “Hold Shift and drop on a task to make it a sub-task” without moving the grid, centered with a “⇧ shift” keycap. While Shift is held over a valid parent, the lifted card shrinks and its keycap stays readable; leaving the parent or releasing Shift restores its size. A nesting drop shrinks the lifted card into its parent, then reveals the child; reorder drops retain their landing motion. There is no nesting pill. “Move out of its parent” in the shared hover menu detaches a child and returns it to its own project. Plain drag never changes parentage.
- Keyboard task movement is vertical and sibling-only through `task arrange`. Left/right on a project heading saves project-column order; it never changes a task’s project or lifecycle. Shortcuts and focus stay inside their owning Hydra.
- One shared hover pill provides actions for open, closed and child cards.
- Project headings and navigation chips reorder projects, including folded strips. Hydra controls and chips reorder Hydras. All reversible edits appear immediately and reconcile through the existing pending resource, preserving DOM identity. A refused creation draft is restored only in its own repository or project group.
- Vertical chat gestures stay in their chat; only horizontal gestures move the Hydra axis. Chat retains its own follow/anchor controller.
- Every task stays mounted in normal document flow while its column scrolls. Card positions do not animate when layout changes or is measured. Folding and the lifted drag preview respect reduced motion.
- Restart, dropped and slept connections reconcile without a manual reload. Connection transitions, recovery and slow renders have structured bounded logs.

## Implementation and remaining work

The project, task, recovery and UI layers are implemented. dnd-kit owns sorting, sensors and the drag overlay; Motion owns card and column layout animation. The handwritten drag, animation and packing engines are deleted. Collision selection follows pointer/modifier changes, so animation cannot shuffle cards under a stationary pointer. Reordering commits the displayed slot rather than recalculating against moving cards at release. Edge scrolling starts near the viewport edge.

The workspace pieces and shared composer use Tailwind utilities on theme tokens: header, Hydra strip, project grids, cards, open-card layout, composer placement, Settings shell and drag layer. Button, Label and HoverActions convert once for every caller. Their old rules are removed. CardShell and its content, heading, panel and section components share card variants. StatePill, Label, Chip, SortableChip, ProjectColumnHeader, IconButton, SortablePanel, WaitingCount and SettingsFrame own the repeated styles. The parallel Tailwind task converts Chat, Oracle, Settings sections and the remaining shared controls on this branch. It leaves the composer and workspace pieces here. Only the visible hover menu follows its card through Motion’s frame callback. Its shared geometry stays clamped inside the viewport, including during layout motion.

Instructions always show in full. Worker chat uses the same Composer as Hydra chat, including task/file mentions, skills, commands, images and file attachments. Pending replies retain one event ID through uncertain delivery and reconnect. Hydra sends use the connection’s existing saved-command outbox, so delivery resumes after reload while the owning Hydra is off-screen. A visible composer joins that request; a definite refusal is stored and shown when its chat mounts. A resize starts only on its visible captured grip; a release or a gesture begun elsewhere cannot resize a project.

Direct worker starts and switches (task `task-9115947a`, included here by owner direction):

- Sending from a task without a worker starts it directly in its normal repository copy; a new task can be created and started from the same composer. Hydra learns through its normal since-last-turn notes, without a coordination turn.
- The shared composer has harness, model and effort controls. Same-harness changes retain the session. A different harness starts a fresh session carrying a command to read the recorded prior conversation. Card chat retains earlier assistant replies; explicitly selecting a session reads that session alone.
- A send during a live turn that changes the agent queues the message and target harness/model/effort until that turn ends. It never cuts off work silently; Stop then Send is the immediate path (ask-209958). A queued change survives restart; Stop cancels it.
- An outside terminal session keeps its existing reply route. Harness/model controls stay disabled, without hint text, until Continue in Pnyx succeeds (ask-210044).
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
| Done timestamps and hide overrides | Keep existing retention; parents finish only after their children | Implemented. Default is 1 hour |
| Queued-role column and worker queues | Keep queue placement and handoff guards | Preserved. `task reorder --behind` stays a queue operation |
| Manual placement overrides | Keep lifecycle override events; project edits choose visible position | Preserved. `task arrange` changes visual rank |
| Column widths/order and CLI | Preserve old values for old clients; workspace view fields own project layout | Implemented through `view set`, not legacy `column resize` |
| Column skills and digest | Describe project arrangement and per-project state counts; explain legacy controls | Updated |
| Parent specified only at creation | `task parent` sets/clears it, rejecting cycles and deeper nesting | Implemented; prior integration cases passed |
| One folder is one project | Repo attaches alone; folder of direct child repos creates a group; `project group` groups attachments | Implemented atomically |
| Repo attached to several Hydras | Keep legacy duplicates flagged; owner chooses keeper; refuse new duplicates | Implemented in Setup, Settings and CLI; prior integration cases passed |
| Per-project copies/start/landing/memory | Keep them on each repository | Preserved |
| Hidden Hydra preferences | Honor old hidden choices as folded strips until the owner explicitly unfolds them; new layout uses folding | Implemented |
| Selected Hydra alone supplies data | All visible scopes share one WebSocket and Zero client; retain each open card's thread | Implemented |
| Query/client failure requires Retry | Automatically rebuild failed reads with backoff and reconcile retained edits/open cards | Implemented |
| Hydra sequence absent from Zero | Replicate it with schema 6 publication upgrade, so confirmations settle | Proved by an app fold, sequence 28→29 and cleared pending state |
| Saved per-card widths | Schema 7 removes them from view rows; replay and undo normalize old events without rewriting history | Implemented; project widths and card heights stay |
| Free-text project labels | Ideas with a plain tag until assignment | Implemented per ask-204158 |

## Ownership and legacy values

Existing duplicate repository attachments keep working after upgrade and no task moves automatically. Setup and Settings name each duplicated repository and its Hydras. An explicit keeper choice moves all affected tasks and records each move. New duplicate attachments are refused deterministically (ask-203840).

Keeper selection is all or nothing. If any task cannot move, refuse with every blocking task and reason. Blockers include live workers, PRs in flight, parent/dependency links and active sources. Move nothing and defer nothing; the owner retries after clearing the blockers (ask-203909).

A free-text project with no attached repository stays stored, appears as a plain tag and places its task in Ideas. There are no temporary columns. Assigning a real repository moves the task into its project column (ask-204158).

## Running-app evidence

The isolated owner trial uses real Postgres, Zero and the built app with fake provider boundaries, three synthetic Hydras and 30 made-up tasks. It contains grouped repositories, Ideas, all requested lifecycle states, sub-tasks, provider icons and an expired Done card. Keep it running at the stable portless URL until Hydra says the owner is finished.

A real wheel gesture snaps to the next Hydra after layout settles. Forced socket drops reconcile a title edited while disconnected. A real portless stop/start changes the instance PID and port, then reconnects without reload, retains the selected card DOM and receives a fresh Zero update. The latest running-app proof reports no page errors.

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

## Integration validation

| Behavior | Failing mutation / observed refusal |
| --- | --- |
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

The seven `tests/card-input.test.ts` flows are kept: direct start and receipt retry, cross-harness handoff and visible history, turn-boundary settings with session retention, a new repository copy, Stop cancelling a queued change, same-message retry after a refused start, and queued-switch restart recovery. Each covers a separate worker boundary through the real CLI/server; the provider is the only fake.

A provisional-thread guard mutation survived because the shared command dependency queue already waits for task creation. The redundant query guards and their duplicate assertions were removed; the existing mechanism handles that boundary.

The remaining composer styles now use DraftChip and ChipIcon for inline references, the existing SuggestionPicker on FloatingPanel for mention/slash menus, and UsageRow, UsageStack, UsageText and UsageSection for the ring’s shared detail view. Attachment cards, image/viewer surfaces and queued-comments placement use the same utility/theme approach. AgentPickers, account/model menus, compaction/agent-change controls and shared comment surfaces stay with the Tailwind worker (ask-212055, ask-212241).

The isolated composer comparison uses the real app at pinned baseline `933d1c1a` and the converted build, in both themes, for Hydra/card chips and mention menus plus the usage tooltip. Visual comparison preserved the menu’s gold border explicitly when FloatingPanel’s default border won. This is a style refactor; no new regression tests are added, and the temporary capture fixture stays outside the PR. Captures remain local for the final media batch.

For this composer slice, compiled CSS changes from 169,699 to 173,816 raw bytes, and from 31,130 to 31,715 gzip bytes (+585 gzip). It removes 84 legacy selector blocks, counting each existing one-line qualified block once. This is a slice comparison against the shared-primitives checkpoint, not the final whole-branch Tailwind total. Final combined numbers follow the remaining Tailwind work.

### Trial feedback, November 17

Settled: the child hover action is **Remove from parent**, with an outdent icon. Hover controls use the shared outline icon set and size. Open-card summary and family controls sit at the right of the Context / Activity row. Only the active tab has an underline; the row has no border. Resize grips share one style: muted at rest, gold while hovered or dragged.

Shift nesting keeps reparenting: a child can move directly under another root. A drop on its current parent does nothing. Only a target that is itself a child, or a source that has children, is refused. During Shift hover the lifted card replaces its keycap with the short reason; an ordinary drag shows neither refusal nor nesting outline. Refused drops preserve both families (ask-213016).

The task modal defaults to 70% of the viewport width and 80% of its height, with a small margin and the existing minimum/viewport limits. Resizing remembers its dimensions for the user, and smaller viewports clamp them. Chat-only is also a user preference across tabs and reloads. Shared Motion layout connects the inline card and the modal, with the same off switch and reduced-motion preference. The modal shows its title once in its header and uses only its own resize handles. Separate inline and modal anchors keep the hover bar on the card after closing.

Card sizing lives beside the shared motion module. A closed card that fits one normal grid cell keeps its own size while lifted; the cell is derived from the project width, minimum card width and gap. An open card stays full size over its own slot, and compacts only after entering another slot, column or valid nest target. It grows back on returning or dropping. Real width and height animate without stretching the text; the relative grab point stays under the pointer through resizing and uniform Shift shrink. Open cards keep their drag handle and title drag while their conversation remains usable.

Project columns, fold-all, sub-task groups, Hydra workspaces and chat animate their size and fade. Closed content unmounts after its transition; task-keyed state restores it on return. Motion and dnd-kit consume the shared CSS timing tokens; the runtime off switch and OS reduced-motion preference also disable their JavaScript animations. Oracle previews use the same three-line heading as cards, so the age appears once.

The composer comparison pins `fc73e170` and measures the real app at 1440px and 390px in both themes. The baseline is 106px for the Hydra composer, 48px for its text field and 48px for the question note. Before correction, the converted version measured 86.39px, 34.39px and 36px. Removing the composer's competing minimum retains the shared Textarea's 48px minimum; the composer bar stops overriding the account picker's native 36px height with 30px. Attachment and Send buttons retain their baseline 30px height. The composer also owns its Chromium scrollbar override through the shared `composer-text` recipe used by the field and draft mirror; the stale feature selector is removed.

The owner trial was refreshed at `67f4d8b7`, after rebasing on the Tailwind and icon-sweep checkpoints. Its page and Zero endpoint both return HTTP 200. The owner reviews this UI before final deslop, CI and CodeRabbit (r214731, ask-214814). Final before/after media remains for the final combined head. A duplicate composer minimum was removed after its mutation survived: the shared Textarea already owns that value. Open: incorporate further owner feedback, then run the single final gate. Intermediate pushes do not run deslop or request CI approval.

### Header dragging and dense trial

Opened cards lift from the title and blank space in the Context / Activity row, using the same drag sensor as closed cards. Buttons, tabs, fields, resize handles and tooltip panels keep their own behavior.

The isolated trial has 86 additional made-up tasks across three Hydras, project and Ideas columns, one-level families, questions, completed and parked work, plus chat history. Synthetic providers supply three ongoing worker conversations; no real worker harness is launched. This fixture stays in the private trial home.

Open: profile the dense view before and after the performance changes, using Chrome traces and the polish worker's opt-in Profiler metrics. The first marked drag trace contains a 129ms main-thread task and hover contains a 53ms task. Hidden-tooltip dismissal and repeated style reads are being addressed; no speed improvement is claimed until the comparison passes. The owner's trial review still precedes the single final deslop and CI gate.

### Large-workspace stress findings

The 628-task, six-Hydra stress run blocks the merge. Every Hydra, project column, card and loaded task update stays mounted while scrolling. Project columns and cards render normally without paint skipping. Update rows use `content-visibility: auto` with intrinsic sizes so the browser can skip their off-screen rendering. Activity reads all update pages when opened. Selecting a project unfolds its column immediately before scrolling it into view. Drafts, selection, family folds and scroll offsets remain in their existing stores.

Scrolling uses one shared Lenis frame loop. A task's modal action selects it without waiting for inline-card scrolling. The addressed Hydra stays anchored as other Hydra widths load. Open: validate and fix the stress findings, then await Hydra's stress-complete signal before the single final deslop and CI approval.

The title-only Save task path omits an empty ask; it saves an Idea without a repository or worker.

Expanded sub-task families take their own full-width row, like an open task; neighboring families keep their visual order, with no masonry (ask-217174). Fold changes use an id-to-boolean patch through `view set` and the same optimistic reducer, merged against current state; stored folds remain an array. No caller on main used this new setting, so the replacement-array input is removed and the CLI example and shipped arrangement skill use the patch (ask-217052). New-task form identity, fields and agent selection survive reload.

The stress worker retracted the idle Lenis CPU allegation after a matched idle measurement. The shared scroll loop removes duplicate schedulers, but no 8% idle improvement is claimed. Still open from the ranked list: streaming DOM/heap growth attribution, repeated discovery commands, final visual checks of chip/badge containment, and the complete stress rerun. Final deslop, CI and media remain held until Hydra declares the stress findings complete.

Initial discovery is bounded to two model requests, one project-list request, one catalog request and two rule requests. A wider run exposed a 64ms production drag task. Drag subscriptions now sit in the shell and grip, and duplicate focus/press/drag protection shares one viewport update. The fresh stress rerun remains open.

Streaming DOM growth is attributed to reused provider message ids retaining the same live render-key alias on several completed replies. TanStack requested seven rows, but duplicate React keys left old rows attached. The shared alias mapping now releases the previous owner before transferring a live key. In the 40-turn diagnostic, turns 8–40 keep seven mounted messages and 483–484 elements; before the fix, mounted messages rose from 46 to 266 and elements from 2,597 to 14,305. Forced-GC JavaScript heap after the fix grows from 12.2 to 13.9 MB as conversation data grows; no flat-heap claim is made. Every Hydra body remains mounted across viewport boundaries.

Open: the fresh stress rerun, final trace comparison and final visible media. Hydra's stress-complete signal still gates the single deslop and CI approval.

Whole-Hydra layout animation runs for explicit folding and Hydra dragging. Background width changes keep the viewport anchor without a second translation. Keyboard and reference navigation scroll the mounted card after layout settles, then focus its panel when requested. A modal card has no sortable registration while its inline card returns, preserving the reverse animation and focus.

The independent anchoring investigation separated two failures. Scroll compensation runs before Motion measures the horizontal axis; the axis uses viewport coordinates, so widening an earlier Hydra does not animate the selected Hydra’s cards. The chat surface paints above sliding project columns.

A fresh Zero read can replace row objects while their decoded card values stay equal. The row cache also retains equal cards from the preceding snapshot, so one changed card does not redraw every visible card. Final combined proof and the stress rerun remain open.

### Stress rerun refinements

The first critical stress findings passed the 8534ed11 rerun. Folding from far-right projects now clamps the selected Hydra’s offset to its shrinking range, so the view returns to its own workspace instead of stopping across the next Hydra. The correction also cancels the previous smooth-scroll target through the existing Lenis controller. Streamed and settled replies use the same Prose component.

The reported 1,367ms drag frame was the gesture’s duration: the raw `worstFrameMs` was 66.8ms, matching the independent 67ms sampler. Gesture duration is now named `durationMs`, with `worstFrameMs` reserved for the longest sampled frame interval. The existing metric test separates a 1,300ms gesture from a 48ms frame and rejects a late callback after release. The sampler’s lifecycle stays unchanged.

The normal-renderer open-card trace reproduced an 80.8ms cold task and a 46.9ms warm task. CPU samples attribute much of the cold task to synchronous React mount/commit, with TanStack scroll-limit reads and Motion/layout measurements. The largest individual app paths were small portions of that task; no safe isolated rewrite was identified. These diagnostic traces include profiler overhead and do not establish an interaction-speed improvement.

Drag pickup captures the visible card position and its grab point together, so a card lifted during a layout animation stays under the pointer.

Folding also keeps the selected Hydra anchored while wheel packets continue arriving. The axis ignores the tail of that gesture until the width and wheel input settle, using the same idle boundary as snapping. A fresh gesture can then scroll normally.

The owner accepted the remaining open-card latency as a follow-up after merge.

Pointer title activation uses the same opening route as the card surface; keyboard and reference navigation align the mounted card after layout settles. Opening an already-visible card retains its scroll position, scrolling only enough to reveal a clipped edge after layout settles. The card shell clips its contents during shared layout, so new details cannot paint outside the expanding surface. Modal pointer resizing changes real dimensions without shared-layout scaling, and its header actions stay top-aligned when the title wraps. Frame captures cover short/long titles, parents/leaves, inline/modal, narrow/wide projects and both themes.

## Current owner round

Settled and built: opening the modal never changes the board behind it. A closed card stays closed in its slot, so its column neither widens nor reflows, and closing folds the modal back into that closed card. A card that was already open inline returns open. Before this, the modal action also opened the card inline, so a card low in a scrolled column moved to a new row, often below the screen, and the modal folded toward it. Implemented and checked: pointer opening retains the visible scroll anchor and clips expanding contents. The modal defaults to 70% × 80%, keeps saved dimensions and fixes action anchoring during real resizing.

The independent drag render-fan-out patch is committed separately. The investigator measured a median peak of 60ms at 3× CPU slowdown, down from 153ms; this does not establish 50ms compliance.

Sources with children show no nesting hint until Shift is actually held over a refused target. Projects lift from their heading, with keyboard sorting retained; body text, including a modal's portal content, cannot start a project drag. Native dialog behavior keeps the background inert. Written message selections are clipped to their blocks, including whole-line boundaries, and partial task/link text remains selectable. Transcript drags are cancelled while composer token handling stays with the composer.

Settled and built: Shift-dragging a child onto empty space in its own project (gaps between cards, padding, the space below the last card) lifts it into root order where it lands, with the same project and state-group rules as root dragging. Shift over a root card still nests it there, and space inside its own family does nothing. The project outlines while armed; another project's space refuses with “Can't move to another project”, since root cards never change project by dragging. The landing slot is the first card of its state group after the pointer in reading order, or the end of that group. Cards are not pushed aside during this gesture; the lifted card lands into its new slot after the drop. Keyboard movement does not outdent. The shared `task parent <id> none [--before <root>]` command places it before that root or at the end by default. One parent event carries both parent/rank changes and their previous values, so retry and Undo preserve the complete placement. Older parent events keep their existing replay behavior, and raw push input cannot set rank. The existing Remove from parent action keeps its repository-preserving route.
