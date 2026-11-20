---
name: pnyx-report-progress
description: Report progress on an assigned Pnyx task through its worker.log file.
user-invocable: false
metadata:
  internal: true
---

Append one line to the worker log named in your current task header (`$PNYX_TASK_DIR/worker.log` at launch). Use `needs-you: <question>`, `blocked: <why>`, `done: <summary>`, `link: <url> <label>`, or `note: <progress>`. Only the worker appends this file. Pnyx observes running and idle automatically. A `note` changes only the card's latest line. Follow the task header for scope, questions, inbox messages and landing.
