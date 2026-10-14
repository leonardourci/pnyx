---
name: pnyx
description: Find or create Pnyx tasks, attach an agent session, report progress, and read task messages through pnyx-axi.
---

# Pnyx

Pnyx cards are tasks. Each task has at most one attached agent session; its conversation follows that session. Run `pnyx-axi` for the live tasks and `pnyx-axi --help` for commands. Interactive Claude Code and Codex sessions create tasks automatically after hooks are installed. Runs without an interactive terminal stay in History. Firstmate imports one task per managed piece of work, and its first worker joins by the recorded worktree. Another session in the same folder gets its own task; folder equality never replaces the attached recipient.

Find your existing task with `pnyx-axi search "<words>"` and inspect `pnyx-axi card <id>`. Reuse a Firstmate task instead of creating a duplicate. To create independent work:

```sh
pnyx-axi task create --key work:example --title "Describe the work" --folder /absolute/work/folder
pnyx-axi task sessions
pnyx-axi attach work:example --session <session-id-or-session-card-key>
```

To start a new agent for a task in Paseo instead, run `pnyx-axi task start <task> --harness claude|codex --prompt "<opening message>" --folder <absolute folder>`; it attaches the agent, and `pnyx-axi task paseo` checks that the Paseo daemon is running. Use the exact identity from `task sessions`. An occupied task rejects another attachment. `pnyx-axi detach <task>` removes the attachment without stopping the agent; attach it elsewhere to continue. Attachment writes accept `--if-revision <revision>` and `--event-id <unique-id>`. A repeated event id returns its original receipt. A rejected revision means reread the task before retrying.

Report progress through `pnyx-axi push --key <task-key> --file <json-file-or->`, using fields such as `activity`, `workspace` and `tags`. Keep the task's key stable and let hooks supply native session, terminal and settings facts. For example, the JSON `{"activity":"Checking the migration"}` changes the status without renaming the task. Add evidence with `pnyx-axi link <task> --url <url>`. Use `pnyx-axi outcome <task> done --note "What finished"` for an explicit completion. A manual move pins placement; it does not answer a source request or complete the work.

Read the owner's messages with `pnyx-axi history --card <task> --kind replied --full`. The queued event contains the literal text; later events describe delivery. Use `--before <seq>` for older pages. Delivery confirms submission, not that an agent handled it. For task notes and source context, use `pnyx-axi card <task> --full`; for the existing conversation, open the task in the board. Respond in the attached agent conversation. `pnyx-axi reply <task> --text <text>` sends a message to that task's agent; it is not a message to the owner. Managed Firstmate replies continue through its configured send route.

`pnyx-axi search "<words>"` includes tasks, background sessions, event history, notes and recorded transcripts. Semantic search uses optional local models; while they download, results use full-text search. Hook events can wait in the spool until the next writer ingests them. No model-generated title, summary or status is needed to maintain the board.
