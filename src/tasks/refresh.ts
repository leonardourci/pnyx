import type { TitanState } from '#app/model.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { assignDefined, sessionAttention } from '#workers/session-attachments.ts'
import { permissionAttention } from '#workers/permission-rules.ts'

export function refreshTasks({
  state,
  ids,
}: {
  state: TitanState
  ids?: (string | null | undefined)[]
}): void {
  const cards = ids
    ? [...new Set(ids)].flatMap(id => (id && state.cards[id] ? [state.cards[id]] : []))
    : Object.values(state.cards)

  for (const card of cards) {
    permissionAttention({ card })
  }

  const hydra = state.cards[TITAN_CARD]
  const ref = state.config?.hydra.session
  const session = ref ? state.sessions?.[ref] : undefined

  if (hydra) {
    if (session && hydra.launch?.via === 'command' && session.launch?.via === 'hooks') {
      session.launch = {
        ...hydra.launch,
        harness: session.agent.provider,
      }
    }

    hydra.sessionIds = session ? [session.id] : []
    assignDefined({
      target: hydra,
      values: {
        agent: session && { ...session.agent },
        terminal: session?.terminal && { ...session.terminal },
        ...(session ? { settings: session.settings && { ...session.settings } } : {}),
        activity: session?.activity,
        sessionActivity: session?.sessionActivity ?? session?.activity,
        workingSince: session?.workingSince,
        turnStartedAt: session?.turnStartedAt,
        turnEndedSeq: session?.turnEndedSeq,
      },
    })
    hydra.attention = session?.agent.host === 'pnyx'
      ? [
        ...hydra.attention.filter(a => !a.key.startsWith('hook:')),
        ...sessionAttention({
          state,
          session,
        }),
      ]
      : session ? sessionAttention({
        state,
        session,
      }) : []
    hydra.hidden = true
  }
}
