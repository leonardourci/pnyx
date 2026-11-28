import type { TitanState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { findCard } from '#tasks/push-rules.ts'
import { decided } from '#app/decision.ts'
import { ownerActor, TITAN_ACTOR } from '#app/actors.ts'
import { TitanError } from '#store/errors.ts'
import { openAsks } from '#tasks/ask-state.ts'
import { completedOutcome, type Outcome } from './model.ts'

// A task's state is Titan's or the owner's call; a worker reports, it never decides.
export function refuseOutcomeFrom({ actor }: { actor: string }): void {
  const decider = actor === TITAN_ACTOR || ownerActor({ actor })

  if (!decider) {
    throw new TitanError({
      message: 'only Titan or the owner sets a task outcome; report it in worker.log instead',
      code: 'FORBIDDEN',
    })
  }
}

// Done or cancelled closes the task's open questions, named in the event.
export function decideOutcome(
  {
    state,
    ref,
    outcome,
    meta,
  }: {
    state: TitanState
    ref: string
    outcome: Outcome | null
    meta: Meta
  },
): Decision {
  refuseOutcomeFrom({ actor: meta.actor })
  const card = findCard({
    state,
    ref,
  })
  const closes = completedOutcome({ outcome })
    ? openAsks({ card }).map(ask => ask.id)
    : []

  return decided({
    state,
    meta,
    event: {
      ...base({
        state,
        meta,
        cardId: card.id,
      }),
      type: 'card.outcome',
      data: {
        before: card.outcome ?? null,
        after: outcome,
        ...(closes.length ? { closes } : {}),
        card: {
          title: card.title,
          workspace: card.workspace,
          tags: card.tags,
          links: card.links,
        },
      },
    },
  })
}
