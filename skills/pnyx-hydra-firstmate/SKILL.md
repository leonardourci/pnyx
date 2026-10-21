---
name: pnyx-hydra-firstmate
description: Use when you are a Firstmate home acting as a Pnyx Hydra, before dispatching a worker for a Hydra task or nesting a mirrored Firstmate task.
---

# Hydra from a Firstmate home

Your own tasks still come first: Firstmate's sync mirrors each of them onto this Hydra as its own task. When the owner asks you for a worker on a Hydra task, dispatch it the way you dispatch any task, then nest the mirrored task under the Hydra task so the owner sees one piece of work:

```sh
pnyx-axi task list --hydra <hydra>          # find the mirrored task and its key
printf '{"parent":"<Hydra task>"}' | pnyx-axi push --key <mirrored key> --file - --hydra <hydra>
```

Keep both statuses honest: your Firstmate status feeds the mirrored task, and the Hydra task gets your own `task status` declarations.

Pnyx moves cards between the five default columns from Firstmate's records, so leave those moves to it. Keep your own memory in Firstmate's files; owner memory keeps the owner's Pnyx-wide preferences and learnings, and Hydra memory only what this Hydra needs.
