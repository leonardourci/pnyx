import type { HydraEvent, HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { taskMention } from '#hydra/mentions.ts'
import type { HydraMessage } from '#hydra/model.ts'

export function routineMessages({
  state,
  event,
}: {
  state: HydraState
  event: Extract<HydraEvent, { type: 'hydra.helper-finished' }>
}): HydraMessage[] {
  const normalized = ({ text }: { text: string }) => text.trim().replace(
    /\s+/g,
    ' ',
  )

  return event.data.outcomes.flatMap(outcome => {
    if (outcome.status !== 'handled') {
      return []
    }

    const prior = state.helper?.outcomes.findLast(item => item.task === outcome.task
      && item.status === 'handled')

    if (prior && normalized({ text: prior.summary }) === normalized({ text: outcome.summary })) {
      return []
    }

    const task = state.cards[outcome.task]

    return [
      {
        id: `helper-result:${event.data.batch}:${outcome.task}`,
        at: event.at,
        actor: 'pnyx',
        action: 'send',
        kind: 'routine',
        hydra: hydraConfig({ state }).hydra.id,
        task: outcome.task,
        text: `- ${taskMention({
          id: outcome.task,
          title: task?.title ?? outcome.task,
        })}: ${outcome.summary}`,
      },
    ]
  })
}
