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

// A wake's turn id names the last change it covers; its turn is recorded as `<id>:hosted`.
export const WAKE_TURN = /^wake:(\d+)(?:\.\d+)?:hosted$/

// The finished record of the turn that read a wake carries this id.
export const WAKE_HANDLED = /^wake:(\d+):handled$/
