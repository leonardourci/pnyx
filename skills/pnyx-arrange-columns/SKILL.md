---
name: pnyx-arrange-columns
description: Use when you are Hydra and are about to assign a task to a project, nest or arrange tasks, resize project columns, or inspect legacy lifecycle placement rules.
user-invocable: false
metadata:
  internal: true
---

# Arrange work

The page groups tasks by project. Ideas is first and contains tasks without an attached repository, including tasks with legacy free-text project tags. Labels do not create project columns. A project may group several repositories; each repository retains its own copies, start command, landing rules and memory.

- Read `project list --hydra <hydra>` before choosing a repository. Use `project add <path>` for a repository, or for a folder with repositories directly beneath it. Use `project group <name> <repo-path>...` to group attached repositories.
- Use `task rename <task> --project <repo-path>` to assign a repository. An empty project clears the assignment. A child appears beneath its parent and retains its own repository and worker.
- `task parent <task> <parent|none>` nests or detaches. There is one level; a task with children cannot become a child. Detaching returns it to its project: `none --before <root>` places it before that root, and `none` places it last. Undo restores its parent and position together.
- `task arrange <task> [--before <task>]` sets visual order within a project and parent. State groups stay needs you, running, waiting/queued/paused, then done. `task reorder --behind` still changes a worker queue, not visual order.
- `view set --json '{"workspace":{"projectOrder":["ideas","<project-id>"],"projectWidths":{"<project-id>":560},"foldedProjects":{"<project-id>":true}}}'` saves project layout. Project ids are repository paths or the group's id. Widths have a 280px minimum and no maximum. `collapsed` and `chatCollapsed` fold the Hydra and its chat. Pass `--hydra <hydra>` on every command.

A repository can have only one Hydra. New duplicate attachments are refused. Existing duplicates remain usable and Setup and Settings ask the owner for a keeper. Only the owner runs `project keep <repo-path> --hydra <keeper>`. It moves every task and records each move, or lists all blockers and moves nothing. Never choose the keeper for the owner.

## Lifecycle compatibility

Lifecycle columns remain internal compatibility state. Their rules still drive completion, queues, manual overrides and Firstmate mirrors. They do not create visible project columns. Ordinary activity and worker.log lines update state automatically; do not create or move lifecycle columns to organize the page.

Use the legacy `column list`, `column rule`, `column create|rename|describe|reorder|delete` and `move` commands only for an explicit lifecycle-rule request or a correction. Read their help and inspect the confirmation before repeating with its token. Firstmate still owns its mirrored lifecycle placement. Existing `column resize` and `layout` values remain available for old clients; use `view set` for project widths.

Rely on checked completion and recorded PR merges. A finished turn or passing local checks does not declare completion. Done cards hide after 1 hour by default, subject to the shared setting and task overrides. Parents stay open while any child is unfinished.

Needs you holds open decisions that require the owner, including questions and permission requests. Due reminders, ready results and worker notes without a decision are updates. A custom Needs you rule still requires an owner decision.
