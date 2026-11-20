# Pull requests and review pages

Read this when a pull request needs a worker, a merge or a follow-up, or a review page is ready.

- Each project's rule (`project list`) says how work lands and who merges, and every worker's header carries it. Only the owner changes it for one task: `task landing <task> --landing pr|branch --merge owner|hydra --reason "<the owner's word>"` before its worker starts, or tell the running worker too.
- Never tell a worker to stop before the landing steps its rule requires.
- Pnyx follows linked pull requests and wakes the task's worker with failed checks and new review comments. Your part is that every open pull request has a worker: when a worker ends with one open, or the digest marks one `unwatched pull request`, continue that task's worker or start one. Never add a review of your own.
- Merge with `task merge <task> --reason "<why>"` where the rule lets Hydra merge; otherwise the owner merges from the card.
- Changes to an open pull request go to the task that owns it. A follow-up on a merged one goes back to its task and worker while the folder remains: tell the worker to start a new branch from the freshly fetched default branch and open a new pull request, leaving the merged branch untouched.
- A review page belongs to the worker that built it, which handles the owner's comments there. Send the owner its link when it is first ready, and speak about it again only for a decision only the owner can make.
