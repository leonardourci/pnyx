---
name: othrys-report-progress
description: Report progress on an assigned Othrys task through its worker.log file.
user-invocable: false
metadata:
  internal: true
---

Append one line to the worker log named in your current task header (`$OTHRYS_TASK_DIR/worker.log` at launch). Use `needs-you: <question>`, `blocked: <why>`, `done: <summary>`, `link: <url> <label>`, or `note: <progress>`. Only the worker appends this file. Othrys observes running and idle automatically. A `note` changes only the card's latest line. Follow the task header for scope, questions, inbox messages and landing.
