import type { TitanState } from '#app/model.ts'

// Each wake ID starts one turn. Retrying a failed wake adds or increments its attempt suffix.
export const wakeId = ({
  through,
  state,
}: {
  through: number
  state: TitanState
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
