import { ORCHESTRATE_SKILL, REPORT_PROGRESS_SKILL, CLI_SKILL } from '#setup/skill-names.ts'
import { HYDRA_MEMORY_BUDGET, OWNER_MEMORY_BUDGET } from '#memory/budgets.ts'
import { POOL_IDLE } from '#projects/copies.ts'
import { NOTES_SHOWN, NOTE_CUT, CONTEXT_TASKS } from '#tasks/cli.ts'
import { HISTORY_LIMIT, HISTORY_MAX } from './cli-support.ts'

export const TOP_LEVEL_HELP = `usage: pnyx-axi [command] [args] [flags]
description: Pnyx shows every agent and its work in Hydras
commands:
  pnyx-axi                                   Show the Hydra summary
  hydra create|list|homes|show|set|memory     Configure Hydras and their own notes; owner memory list|set|forget keeps the owner's for every Hydra
  project add|list|set|remove                   Attach, list or detach projects
  column create|rename|describe|rule|resize|delete|reorder|list  Edit columns
  task create|list|show|rename|status|history|permission Tasks and one level of subtasks (--parent <id>)
  task start|continue <task>                  Start a worker or host an ended outside session
  hydra start|send|messages|check            Start the Hydra, queue task context in its chat, read it, or wait for changes
  rule; account list|set|remove              Heads dispatch rules and worker login folders
  task sessions|queue|unqueue|reorder        Sessions and ordered worker queues
  task attach|detach <task> [--session <id>]  Attach an interactive session or detach it
  push --key <key> --file <card.json|->      Create or update the card with this key
  card <id|key> [--full]                     Show one card with its summary, decisions and context
  harvest [--card <id>]                      Collect summaries and decisions sources already recorded
  move <id> <column> [--before <id>]         Put a card in a column, above another card or at its end
  link <id> --url <url> [--state open]       Add, update or --remove a link
  outcome <id> done|failed|cancelled         Record the task outcome (--note, --clear)
  history [--card <id>] [--before <seq>]     Page through past events, newest first
  context [--cwd <folder>]                   Open tasks for the attached project holding a folder (the session-start hook prints it)
  oracle "<words>" | status | rebuild        Full-text search over titles, links, events and transcripts
  undo <event-id>                            Append the reverse of a manual edit, move, link or outcome
  view show|schema|set; layout show|reset      Inspect or save preferences; reset widths
  repair                                     Set aside a torn log tail and rebuild the snapshot
  serve [--port <n>]                         Run the one server of every Hydra until stopped
  stop                                       Stop the running server
  upgrade [--check]                          Pull, install and build the latest main, then restart the server
  setup check|skills|hooks|service          List what setup still needs, or install global skills, reporting hooks or the login service
  setup hydra --home <firstmate home>        Make a Firstmate home Hydra and give it the ${ORCHESTRATE_SKILL} skill
  integrations                               Show which integrations are ready and how to set each up
  reply <id> --text <text> [--home <path>]   Send a reply through the card's Firstmate home or its session's terminal
  agent <id> [<setting> <value>]             List or change a session's model, effort, mode or fast mode from its card
  firstmate sync|watch --home <path>         Fold a Firstmate home's tasks into the Hydra, once or on every change
flags:
  --hydra <name>     Hydra to use (default: default)
  --event-id <id>    On writes: idempotency key; a repeat returns the original receipt
  --if-revision <n>  On writes: expected card revision (0 for a new card)
  --help | --version Show command help or the installed version
`

const COMMAND_HELP: Record<string, string> = {
  hydra: `usage: pnyx-axi hydra create <id> [--name <name>] [--identity <identity>] [--session <session>] [--firstmate <home>]
pnyx-axi hydra create --firstmate <home>
pnyx-axi hydra list
pnyx-axi hydra homes [--base <folder>]
pnyx-axi hydra show|set --hydra <id> [--identity <identity>] [--session <session>] [--firstmate <home>] [--command <shell>] [--command-folder own|copy] [--done-after-hours <hours>] [--review-minutes <n>]
Each Hydra has one orchestrator identity. Changing that identity preserves tasks, history and old messages.
--session self picks the session running in the caller's own Paseo terminal, tmux pane or Herdr pane. No process is launched. A session used as Hydra cannot also be a task worker.
hydra create --firstmate names the Hydra after the home's folder. hydra homes lists the Firstmate homes
in --base (or FIRSTMATE_FACTORY_BASE) and each one's Hydra.
--helper auto uses a lighter model on Hydra’s harness (Sonnet on Claude, gpt-6-luna on Codex). --helper claude|codex --helper-model <id> [--helper-effort <value>] selects its agent; --helper off routes all wakes to main.
--review-minutes sets the timed review cadence (default 30 minutes); 0 turns it off. Reviews wake Hydra only for new actionable flags. Memory lag stays quiet; overdue owner questions get chat reminders without waking Hydra.
--done-after-hours hides cards after continuous time in Done (default 24); 0 keeps them visible. Hidden cards remain in History and Oracle. task unhide brings one back until it leaves Done and returns.
--command sets the shell command task start --via command and hydra start --via command run; an empty value clears it.
--command-folder own says the command makes its own folder, so it runs in the project folder and Pnyx makes no task copy; copy (the default) runs it in the task's copy.
pnyx-axi hydra send --task <id> [--action send|worker] [--text <message>] [--details <text>]
pnyx-axi hydra send --text <message> [--details <text>]
pnyx-axi hydra send --task <id> --kind progress --text <message>
--kind progress is a worker's routine progress: it updates the task's card and joins Hydra's next wake without waking Hydra.
pnyx-axi hydra stop
hydra stop ends the turn Pnyx's hosted Hydra is running; its workers keep going.
pnyx-axi hydra usage
hydra usage prints the hosted Hydra's context window use and session cost when known, and its account's plan windows from quota-axi.
pnyx-axi hydra resize --width <pixels>
pnyx-axi hydra worker-notes set|forget [--text <text>] --reason <why>
Standing worker instructions are included verbatim in every new worker header.
pnyx-axi hydra memory list|set|forget [--key <key>] [--text <text>]
Hydra memory holds only what this Hydra needs (its scope, where it left off, its check cursor), within ${HYDRA_MEMORY_BUDGET} characters. Owner preferences and learnings are Pnyx-wide: see \`pnyx-axi owner --help\`.
pnyx-axi hydra digest
Prints Hydra's live state: columns, open tasks and their workers, what waits on someone, owner memory and Hydra memory.
pnyx-axi hydra messages [--after <seq>] [--limit <n>] [--full]
pnyx-axi hydra check [--after <seq>] [--wait <seconds>]
pnyx-axi hydra start [--via paseo|command] [--rule <name>] [--harness claude|codex] [--prompt <text>] [--folder <path>] [--paseo-url <url>]
pnyx-axi hydra start --via firstmate --home <firstmate home>
hydra start starts Hydra: in Paseo (Claude Code by default) or with the configured command, its
session becomes Hydra (in Paseo on the hydra rule's agent unless --rule names another); a Firstmate home becomes Hydra as \`setup hydra\` makes it. The default
prompt points Hydra at the ${ORCHESTRATE_SKILL} skill.
Messages are durable entries in Hydra’s chat; one without --task is about the Hydra, not a task. No worker is launched or native terminal typed into.
Hydra reads messages and task history through AXI. --after is an event sequence cursor.
check is Hydra's light check: it lists only what Hydra tracks (messages, task creation, briefs, visibility, declarations, open agent questions, attachments, columns, moves, links) after --after (default: now), skipping Hydra's own writes (actor hydra)
except its chat lines, which are listed but never end a wait; with --wait it blocks up to that many seconds until something else appears. It also records native task conversations
and returns a compact conversations digest of owner instructions and agent replies. Read task history --full
for complete messages. Pass the printed through as the next --after; unavailable native sources are reported for retry.
`,
  owner: `usage: pnyx-axi owner memory list|set|forget|confirm|move|save|archive [--project <name|path>] [--key <key>] [--text <text>] [--reason <why>] [--if-revision <n>]
Owner memory is Pnyx-wide: every Hydra's digest prints it. Keep the owner's preferences under the key preferences and general learnings under learnings,
one line per entry, and save each document whole. It holds ${OWNER_MEMORY_BUDGET} characters; a save over budget is refused.
Pass the revision list printed as --if-revision so a save made from an older read is refused instead of replacing another Hydra's save.
New learning lines accept --kind for-now --until task:<hydra>/<task>|<PR URL>|version:<version>|date:YYYY-MM-DD.
A memory save advances unused-save counts; --used "<exact lines, newline-separated>" and --reason record session evidence and refresh those lines.
Confirm and archive take --text "<exact learning line>". List includes recoverable archived lines.
Move one learning atomically into project memory with owner memory move --project <name|path> --text "<exact learning line>".
Every replacement and removal stays in $PNYX_HOME/owner/memory.jsonl (default ~/.pnyx).
`,
  column: `usage: pnyx-axi column list
pnyx-axi column create --title <title> [--id custom:<id>]
pnyx-axi column rename <id> --title <title>
pnyx-axi column describe <id> --description <text>
pnyx-axi column rule <id> --when <fact[,fact]> [--when <fact[,fact]>] --reason <why>
pnyx-axi column rule <id> --clear --reason <why>
pnyx-axi column resize <id> --width <pixels>
pnyx-axi column delete <id> [--to <remaining-column>]
pnyx-axi column reorder <id> [--before <id>]
All columns, including template columns, can be edited. Deletion moves cards to the fallback;
the final column cannot be deleted. Rule edits, reorder and delete first return confirmation: needed and a token;
repeat the same command with --confirm <token>. Browser actions already carry the owner’s intent.
Rules use comma-separated facts as AND, repeated --when as OR, and !fact as NOT.
The first matching column in display order wins; --clear makes a column manual only.
Facts: worker:none|working|checks|blocked|hydra|paused|ended, owner-question, held,
pr:none|draft|open|pending|green|red|merged|closed, kind:build|investigation, done, reminder-due, queued.
Use --if-revision for the Hydra revision (the view revision for resize).
`,
  task: `usage: pnyx-axi task hide-after <task> <hours|default> [--hydra <id>]
pnyx-axi task create --title <title> [--project <name|path>] [--ask <text>] [--message <owner-message-id>] [--goal <text>] [--brief <text>] [--kind build|investigation] [--hold] [--key <key>] [--folder <path>] [--column <id>] [--parent <task>] [--reason <text>] [--details <text>]
--project names a project attached to the Hydra (see project list).
pnyx-axi task depend|undepend <id> --on <prerequisite> [--on <prerequisite> ...]
pnyx-axi task hold <id> --reason <topic>
pnyx-axi task release <id> --from-message <owner-message-id> --reason <why>
Held cards stay in Backlog, marked Talking. Start, build, queue and continue refuse until the owner gives the go.
pnyx-axi task intent <id> --text <owner-words> [--message <owner-message-id>]
pnyx-axi task brief <id> --brief <text> [--reason <text>] [--details <text>]
pnyx-axi task hide|unhide <id> [--reason <text>] [--details <text>]
pnyx-axi task list [--fields <field,...>]
Rows show id, title, project and column; --fields adds any of attention, parent, status, worker, hold, queue.
pnyx-axi task show <id> [--full]
Long fields are cut to 1,000 characters with their total length; --full shows the whole record.
pnyx-axi task rename <id> [--title <title>] [--project <name>]
--project adds a compact project label; an empty value clears it.
pnyx-axi task status <id> working|needs_you|paused|blocked|done [--note <text>] [--until <time> | --hold]
A paused worker's --until (ISO time, "in 2 hours" or "tomorrow 9:00") ends its wait: Hydra is woken once then.
--hold marks a pause the owner or Hydra asked for: it waits for their word and never wakes Hydra on a timer. A pause with neither wakes Hydra after 4 hours.
done is refused while the task's work has not landed by its project's rule (uncommitted files, or a pull request not yet merged),
or, for an investigation, before its report is stored and its decision inventory reviewed. The owner can override build landing by moving the card to Done; report review is always required.
Ready owner-merge questions include the PR title, link, latest worker report or status note, and check counts.
pnyx-axi task report-review <id> --report <report-id> (--none | --call <task>/<ask>...)
Attests that the whole report was reviewed. Each call names an owner question on separate work, linked with task ask --from-report <origin-task>. Completion, hiding and promotion require a current inventory.
pnyx-axi task report <id> [--file <path>]
Stores an investigation's report with the task (every version stays in the log), or prints the latest one.
pnyx-axi task inbox read <task> [--all]
pnyx-axi task source register <task> <source-id> --executable <absolute-path> --argv <json-array> --cwd <absolute-path> [--timeout-ms <n> --max-bytes <n> --expires <ISO-time> --restart never|on-failure --max-runs <n>]
pnyx-axi task source lavish <task> <source-id> --page <path> --executable <absolute-lavish-axi> [--agent-reply-file <path>] [--after <source-id> --sequence <n> --session <session> --generation <n>]
pnyx-axi task source list <task>
pnyx-axi task source read <task> <source-id> [--all]
pnyx-axi task source handled <task> <source-id> <sequence> --session <session> --generation <n>
pnyx-axi task source stop <task> <source-id>
pnyx-axi task inbox enqueue <task> <message-id> --text <text> | --file <path|-> [--source <source>] [--reply <reply-id>]
pnyx-axi task inbox ack <task> <message-id> --session <session> --generation <number> [--outcome incorporated|blocked --note <why>]
pnyx-axi task inbox notify <task> <message-id> --session <session> --generation <number> --attempt <attempt-id> --result delivered|unknown|failed|deferred
Inbox reads return the active session/generation claim and pending instructions in order. Acknowledge the oldest instruction after incorporating it.
A blocked acknowledgement requires --note; it records why incorporation could not proceed. Delivery receipts never mark an instruction handled.
Inbox writes deduplicate message/attempt IDs and reject --event-id and --if-revision.
pnyx-axi task build <id>
Turns an investigation with a stored report into its build; its worker keeps the context and starts a fresh branch. Owner, or Hydra on the owner's word.
pnyx-axi task landing <id> [--landing pr|branch] [--merge owner|hydra] [--clear]
Gives this task alone a landing rule other than its project's, or prints the rule it follows. Owner, or Hydra on the owner's word.
pnyx-axi task merge <id> [--url <pull request>]
Merges the task's linked pull request with a merge commit and records it. Hydra may merge only where the project's rule is --merge hydra,
and never while a check is red or still running.
pnyx-axi task ask <task> --question <text> [--context <text>] [--choice "<label>[: <description>]"]... [--recommend <n>] [--details <text> | --details-file <path>] [--to hydra|owner] [--kind go]
A worker's question goes to Hydra (the default); only Hydra asks the owner, with --to owner. A go question requires a held card and offers Go or Hold; only Go releases it. Other questions accept a typed answer.
pnyx-axi task answer <task> <question> [--choice <n|label>] [--text <answer>] [--from-message <id>] [--reason <text>] [--undelivered]
Sends the answer to the task's worker and resolves the question once it is delivered. Hydra answers questions asked of it, or records an owner answer with --from-message <id>, quoting an owner message newer than the question.
An answer still being sent or of unknown delivery holds the question; after checking that it never arrived, --undelivered answers (or escalates) again.
pnyx-axi task close-question <task> <question> --evidence <link or recorded fact> --reason <why moot>
pnyx-axi task reopen-question <task> <question> --answer <current answer event>
pnyx-axi task escalate <task> <question> [--question <owner-facing text>] [--context <text>] [--undelivered] --reason <text>
Hydra hands a worker's question to the owner under the same id; the worker's wording stays in its history.
pnyx-axi task history <id> [--before <seq>] [--limit <n>] [--full]
pnyx-axi task chat <id> [--session <past-or-current-session>] [--before <cursor>]
pnyx-axi task permission <task> <request> allow|deny [--answer <json>] [--reason <text>]
A question request is allowed with its answers, --answer '{"answers":[{"pick":[1]},{"text":"..."}]}' (one per question, picks
numbered from 1), and a form with --answer '{"values":{"<field>":"<value>"}}'; deny skips it.
pnyx-axi task project <task> --project <name|path>
pnyx-axi task remind <task> <when|clear>
pnyx-axi task reminders
pnyx-axi task continue <task> [--check]
pnyx-axi task start <task> [--via pnyx|paseo] [--rule <name>] [--harness claude|codex] [--model <model>] [--effort <effort>] [--mode <mode>] [--fast on|off] [--prompt <text>] [--folder <path>] [--in-place] [--paseo-url <url>] [--replace-session <session>]
pnyx-axi task start <task> --via firstmate [--prompt <text>]
pnyx-axi task start <task> --via command [--command <project-command-name>] [--prompt <text>] [--harness <name>] [--folder <path>] [--in-place]
pnyx-axi task copy <task> [remove [--safe | --discard]]
Hydra (actor hydra) must pass --reason, one short why, to create, brief, hide, unhide, start and permission, as to move. Pnyx keeps it on the event,
and shows the changes in the task’s Updates and the turn’s fold. --details keeps longer context on the same event.
pnyx-axi task paseo [--paseo-url <url>]
pnyx-axi task queue <task> --behind <task|session>
pnyx-axi task unqueue <task>
pnyx-axi task reorder <task> --behind <task|session>
pnyx-axi task sessions
pnyx-axi task attach <task> --session <session-id|card-id|key|self>
pnyx-axi task detach <task>
Dependencies name tasks in the same Hydra. Each prerequisite must complete its task-kind and landing lifecycle with no owner gate or hold. Reports alone do not complete investigations. Reopening a prerequisite blocks new dispatch; running dependents are reported to Hydra for judgment.
Queueing behind a session appends; behind a queued task inserts immediately after it. Repeating task queue or using task reorder changes that position. Unqueue releases a task for a separate worker. Only unstarted tasks in the same project can queue. The server advances after a merged PR or a declared done task whose commit landed, never an open PR.
Tasks accept one attached session. A second session cannot replace the recipient.
attach moves an interactive session to the task; an occupied destination is rejected.
detach removes the attachment without stopping the session; it stays in task sessions and History.
attach sends a saved task brief as its first task message and reports the delivery result; detach never stops a process. Writes accept --if-revision and --event-id.
task create accepts --project <name|path>; task project assigns an existing task to an attached project.
task remind sets one reminder per task; use a future ISO timestamp with a timezone, "tomorrow 9:00" (laptop time), or "in 2 hours". clear removes it. task reminders lists waiting reminders and their count. The server fires overdue reminders on startup, moves the task to Needs you, and records a line in Hydra’s chat.

task continue adopts an ended outside Claude Code or Codex session; --check only reads its current presence.
It refuses a running or unverified terminal session; the next message resumes the same session in its recorded folder.
task start runs Claude Code (Agent SDK) or Codex (app-server) in the task's folder through the Hydra's
Pnyx server (\`pnyx-axi serve\`), with your own provider settings, skills and hooks, and records its native session, folder
and settings on the task. Replies and setting changes from the Hydra or \`pnyx-axi reply\` and \`pnyx-axi agent\`
go straight to it; after a server restart the next message resumes the same session. A turn that was
running when the server stopped is marked interrupted and waits for a message. Permission prompts and
questions wait on the task for task permission. Codex mode is its approval policy (untrusted, on-request or
never) with its sandbox: never, or bypassPermissions, runs with full access, the others write only in the folder and Pnyx's home. Codex applies picker changes on the next turn and queues messages during a turn.
--via paseo asks the local Paseo daemon (PNYX_PASEO_URL, default ws://127.0.0.1:6767/ws) to start a
Claude Code or Codex agent instead, then attaches it; replies and the conversation go through Paseo,
and the agent stays in Paseo too. task paseo checks the daemon. --folder also records the task's folder.
Repeating the same --event-id never starts a second agent.
--rule chooses the heads dispatch candidate list (default: default); an explicit owner --harness or
--model wins outside that list, checked against its own catalog and login. --prompt sets its opening message, which otherwise names the task and the ${REPORT_PROGRESS_SKILL} skill. Known quota ranks
by spendPriority above unknown quota; a tie, or several candidates with unknown quota, stops the start.
--model, --effort, --mode and --fast on|off replace the chosen candidate's settings from the first turn; the model
must be in the harness's catalog and the task records the override.
--via firstmate puts a worker request in Hydra's chat and sends it to the Hydra's Firstmate home as an inbox note.
--via command --command <name> selects the assigned project’s named command (project list); without --command it runs the configured Hydra command. It runs in the task's folder with PNYX_TASK and the rest of its context in the
environment; the session it starts attaches to the task when its hooks first report.
The default route is firstmate for a Hydra run by a Firstmate home, otherwise pnyx.
A task with an attached project starts in its own copy: a git worktree slot copies/<project>-<n> on branch
pnyx/<hydra>-<task> (or the project's copy command, see project set), taken once and reused by later starts. A start
takes a clean idle slot from the project's pool when there is one, keeping its ignored files such as installed
dependencies, and starts the branch from the fetched origin default branch. A failed refresh stops allocation;
projects without origin use local HEAD. --in-place works in the project folder
itself and is refused while a worker of another Hydra runs there; --folder names the folder outright. Firstmate Hydras
make their own copies.
When the task reaches Done and its agent stops working, Pnyx releases its copy if it has no uncommitted changes and its
commit is on the default branch or its linked pull request merged; the branch stays. Copies from a project's copy
command are only released. Otherwise the task keeps the copy, flagged, and Hydra gets a message.
A released slot goes back to the pool when fewer than ${POOL_IDLE} clean idle slots of the project are already there, or
when an attached worker still runs in it; otherwise it is deleted. A slot a worker runs in is never handed to another task.
Queued handoff prepares the next branch and transfers the folder; manual task attach only moves the session.
task copy shows the copy and that check. task copy remove settles it again; --safe (Hydra) confirms a clean copy whose work
already landed or is empty; --discard removes work that never landed and needs the owner's --confirm <token>, never Hydra's.
`,
  push: `usage: pnyx-axi push --key <key> --file <card.json|-> [--event-id <id>] [--if-revision <n>] [--actor <who>] [--reason <text>]
Creates or updates the card with this key. Repeating the same push, or the same --event-id, appends nothing.
card.json fields (all optional): title, autoTitle {from: session|prompt|agent|folder, text} (used only while no title is set), workspace, tags[], parent (card id or key, null to clear), activity,
  agent {provider, sessionId, agentId, agentType, cwd, transcriptPath}, attention[] {kind, key, blocking, text, questions[] {question, header, options[] {label, description}, multiSelect}, form[] {name, title, type, options[], required}, answered},
  settings {<name>: <value>, or null to remove it} merged into the card's settings, such as model, effort, mode, fast,
  terminal {tty, pid, program, tmux, tmuxPane, paseoTerminal, paseoHome, herdrSession, herdrPane},
  folder (absolute path, null to clear; a hook session started there reports to this card),
  source {adapter, objectId, instanceId, generation, cursor, observedAt}
An observation older than the card's latest one from the same source is ignored.
`,
  card: `usage: pnyx-axi card <id|key> [--full] [--hydra <name>]
Shows the card and its notes in three sections, summary, decisions and context, newest first:
${NOTES_SHOWN} per section with text cut at ${NOTE_CUT} characters, or every note in full with --full.
`,
  context: `usage: pnyx-axi context [--cwd <folder>] [--hydra <name>]
Prints the open tasks (up to ${CONTEXT_TASKS}) of the attached project holding the folder (default: the current one),
with the Hydra and server state. Prints nothing outside every attached project. The session-start hook runs it.
`,
  harvest: `usage: pnyx-axi harvest [--card <id>] [--hydra <name>]
Collects notes that sources already recorded, with no model and nothing asked of agents: Claude Code
compaction summaries, session titles and AskUserQuestion answers, Codex compaction summaries, and each
linked pull request's title and description through gh-axi. Sessions are also harvested whenever a
turn ends; Firstmate decisions, reports and Captain's intent arrive through \`firstmate sync\`.
Sources are only read. Each note is kept once, so running it again appends only what is new.
`,
  move: `usage: pnyx-axi move <id> <column-id> [--before <id>] [--event-id <id>] [--if-revision <n>] [--reason <text>] [--details <text>]
Puts the card in the column just above the --before card, or at the end of the column without it.
First returns confirmation: needed and a token; repeat with --confirm <token> to act.
Pnyx applies column rules on phase changes; a manual move lasts until the next rule result changes.
Hydra uses manual placement for an exceptional correction with a reason. Read rules with \`pnyx-axi column list\`.
Hydra's moves need --reason, kept on the event and shown in the task's Updates. The owner's moves need none.
`,
  link: `usage: pnyx-axi link <id> --url <url> [--kind github_pr|linear|url] [--number <n>] [--title <text>] [--state open|merged|closed] [--remove] [--event-id <id>] [--if-revision <n>]
GitHub pull request URLs get kind and number filled in. A link never moves the card.
`,
  outcome: `usage: pnyx-axi outcome <id> done|failed|cancelled [--note <text>] | --clear [--event-id <id>] [--if-revision <n>]
`,
  history: `usage: pnyx-axi history [--card <id>] [--kind pushed|moved|linked|outcome|replied|noted] [--workspace <name>] [--before <seq>] [--limit <n>] [--full] [--updates]
Newest first, ${HISTORY_LIMIT} per page (max ${HISTORY_MAX}). --updates keeps only the events a task's Updates list shows.
`,
  undo: `usage: pnyx-axi undo <event-id> [--event-id <id>] [--if-revision <n>]
Appends an event that reverses a manual push edit, move, link or outcome. Refused when the card changed since.
Source observations, card creation and merges cannot be undone.
`,
  setup: `usage: pnyx-axi setup check [--hydra <id>]
pnyx-axi setup service [--port <n>] [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup hooks [--harness claude|codex] [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup skills [--remove] [--preview] [--allow-custom-home]
pnyx-axi setup hydra --home <firstmate home> [--hydra <id>]
setup check lists what is still missing (local config, logins, hooks, skills, quota-axi, the login service,
project profiles) and who fixes each; it exits 1 while anything is missing. A Hydra's digest lists the same.
setup hooks, service and skills refuse a non-default PNYX_HOME unless --allow-custom-home is given.
setup service refuses a port reserved by another Pnyx home; choose a different --port.
setup skills links only ${REPORT_PROGRESS_SKILL} and ${CLI_SKILL} from this installation into ~/.claude/skills
(or $CLAUDE_CONFIG_DIR/skills) and ~/.agents/skills. Updates to the installation apply to the links.
Existing files and unrelated links are never replaced. Legacy Pnyx skill links are removed.
--remove takes out this install's global links and legacy Pnyx links.
Adds Pnyx's reporting hook to the user-level Claude Code settings.json or Codex hooks.json, keeping
every other hook. Without --harness it sets up each harness whose config folder exists. Rerunning
changes nothing; --remove takes out only Pnyx's entries. The hooks always exit 0 and print nothing,
except at session start in a folder inside an attached project, where they print that project's open tasks.
Hook events go to the default Hydra, or to PNYX_HOME and PNYX_HYDRA when a session has them.
setup service installs one login service running the server of every Hydra: a launchd job on macOS, a systemd user unit on Linux.
It replaces the older one-per-Hydra services.
setup hydra makes the Firstmate home the Hydra, copies the ${ORCHESTRATE_SKILL} skill into the home's
.agents/skills (kept out of the clone through .git/info/exclude) and leaves Firstmate an inbox note about it.
Firstmate's own files are not changed.
`,
  repair: `usage: pnyx-axi repair [--hydra <name>]
A crash mid-append can leave a torn last line; writes refuse until it is repaired.
Repair copies the torn bytes to a side file and appends a marker so readers skip them; the log is never cut.
`,
  serve: `usage: pnyx-axi serve [--port <n>] [--hydra <name>] [--home <Firstmate path>]...
Serves every Hydra in PNYX_HOME on 127.0.0.1 port 4747 (--port overrides it; 0 picks a random one) until SIGINT, SIGTERM or \`pnyx-axi stop\`.
Each Hydra lives at /hydra/<id>/; / opens the --hydra Hydra. A Hydra that fails to load is skipped and reported, and a Hydra created
while the server runs is served once its folder appears. --hydra names the Hydra whose address is printed (default: default); it and
the default Hydra must load. A Hydra run by a Firstmate home watches that home and replies through it. Each --home is a Firstmate home
for the --hydra Hydra instead: replies to its cards go through it, and its tasks are folded in as \`pnyx-axi firstmate watch\` would.
Hook events arrive on each Hydra's server.sock or through its spool. Browsers get one WebSocket per Hydra at /hydra/<id>/ws:
a snapshot on connect, then events by sequence; ?after=<seq> resumes, a gap gets a fresh snapshot.
The handshake needs ?token=<token>: each Hydra page served here carries it, local programs read $PNYX_HOME/token.
Commands go over the same socket: {"type":"command","id":"<id>","name":"move|link|outcome|undo|rule|account","args":[...]}
gets {"type":"receipt","id":"<id>",...} or {"type":"error","id":"<id>",...}. They always write that socket's Hydra;
--hydra is refused and the actor defaults to web. GET /hydra/<id>/health answers {"hydraId","pid","build"};
GET /health answers {"pid","build","hydras","skipped"}.
`,
  stop: `usage: pnyx-axi stop
Stops the one server of every Hydra. A login service starts it again; \`pnyx-axi setup service --remove\` keeps it stopped.
`,
}

export function commandHelp({ command }: { command: string }): string | undefined {
  if (command === 'layout') {
    return 'usage: pnyx-axi layout show|reset [--hydra <name>] [--if-revision <view revision>]'
  }

  if (command === 'view') {
    return 'usage: pnyx-axi view show|schema|set [--json <patch>] [--if-revision <n>] [--event-id <id>] [--hydra <name>]'
  }

  return COMMAND_HELP[command]
}
