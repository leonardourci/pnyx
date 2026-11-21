import type { HydraState } from '#app/model.ts'

// A wake offered again after its turn failed gets a fresh id, as each id starts one turn: wake:<through>.<try>.
export const wakeId = ({
  through,
  state,
}: {
  through: number
  state: HydraState
}) => {
  let id = `wake:${through}`

  for (let attempt = 2; `${id}:hosted` in state.eventIds; attempt += 1) {
    id = `wake:${through}.${attempt}`
  }

  return id
}

export const WAKE_ID = /^wake:(\d+)(?:\.\d+)?$/

export const WAKE_TURN = /^wake:(\d+)(?:\.\d+)?:hosted$/

export const WAKE_HANDLED = /^wake:(\d+):handled$/
