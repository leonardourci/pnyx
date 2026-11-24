---
name: othrys-arrange-columns
description: Use when arranging projects and tasks in the Othrys UI.
user-invocable: false
metadata:
  internal: true
---

# Arrange the Titan

Use the UI to attach and arrange projects, nest or order tasks, and resize their columns. Read this Titan's hydra.log and the tasks' task.log files for current placement; the optional snapshot.json is a cached view and may be older than the logs.

Running and idle come from sessions; workers append their status and links to worker.log. Completion follows the task's landing rules. Do not edit the snapshot or canonical logs to change placement.
