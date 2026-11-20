# Questions and decisions

Read this when a worker asks something, a decision is unsettled, or the owner answers, defers or holds.

## A worker's question

Read it with `task show <task>` first; an answered or escalated one needs nothing. Answer what the owner's accepted ask, their later answers or the design they approved already settle: `pnyx-axi task answer <task> <id> --choice <n> | --text "<answer>" --reason "<why>" --hydra <hydra>`. Escalate a choice they leave open with `task escalate <task> <id> --question "<decision?>" --context "<...>" --choice "<recommended>" --choice "<alternative>" --recommend 1 --reason "<why>"`.

## What goes to the owner

Escalate a product or architecture choice the ask leaves open, requirements that conflict, and a change that adds a guarantee, subsystem, abstraction, compatibility surface, state machine, monitoring, framework or broader architecture the ask does not need. Escalate repeated fixes circling one design problem, and destructive, irreversible or security-sensitive steps. Labels such as correctness or security are evidence, not authority to widen the ask. "Proceeding with these defaults unless you say otherwise" settles nothing that is still open.

Decide everything else yourself and answer the worker. Announce a consequential decision once, in one line with its reason: `hydra send --task <task> --text "<decision and reason>"`.

Make an owner question readable on its own. Its context gives the owner's requirement, what the proposed expansion adds, the smallest option that fulfills the ask, each choice's cost, and your recommendation. Ask on the task with `task ask <task> --to owner`; a decision with no task uses `hydra ask`. Work that depends on the answer waits; independent work goes on.

## The owner's answer

The owner answers on the card. To record an answer they wrote in chat, run `task answer <task> <id> --from-message <message-id>`, adding `--choice Go|Hold` or `--choice Merge|Hold` for those questions; `reply <task> --question <id> --from-message <message-id> --text "<relay>"` also passes it to the worker. Record only a message that answers that question: a clarification such as "why?" continues the conversation. "Later, until <date>" is `task defer-question <task> <id> --until "<date>" --from-message <message-id>`. Keep one open question per decision, and reuse a pull request's existing merge question.

## Talking it over first

When the owner asks to discuss before work starts, hold the card (`task intake --hold`, or `task hold <task> --reason "<topic>"` on an existing one). Once your playback is complete, ask `task ask <task> --to owner --kind go --question "<go question?>"`; the owner's Go releases the hold, as does `task release <task> --from-message <message-id> --reason "<why>"` for a newer message that gives the go.
