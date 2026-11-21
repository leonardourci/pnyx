import type { HydraState } from '#app/model.ts'

// A wake offered again after its turn failed gets a fresh id, as each id starts one turn: wake:<through>.<try>.
export const wakeId = ({
  through,
  state,
}: {
  through: number
  state: HydraState
}) => {
  let attempt = 1

  for (const session of Object.values(state.sessions ?? {})) {
    const started = WAKE_TURN.exec(session.wakeStarted ?? '')

    if (started && Number(started[1]) === through) {
      attempt = Math.max(
        attempt,
        Number(started[2] ?? 1) + 1,
      )
    }
  }

  let id = attempt === 1 ? `wake:${through}` : `wake:${through}.${attempt}`

  while (Object.hasOwn(
    state.eventIds,
    `${id}:hosted`,
  )) {
    attempt += 1
    id = `wake:${through}.${attempt}`
  }

  return id
}

export const WAKE_ID = /^wake:(\d+)(?:\.\d+)?$/

export const WAKE_TURN = /^wake:(\d+)(?:\.(\d+))?:hosted$/

export const WAKE_HANDLED = /^wake:(\d+):handled$/
