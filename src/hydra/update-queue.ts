import type { AgentConfig } from '#workers/model.ts'

// id names the Hydra message or wake an item carries, so a turn knows what it answered.
export function inbox() {
  const items: {
    text: string
    id?: string
    steeringIds?: string[]
    agent?: AgentConfig
  }[] = []
  let wake: (() => void) | undefined, done = false

  return {
    push({
      text,
      id,
      steeringIds,
      agent,
    }: {
      text: string
      id?: string
      steeringIds?: string[]
      agent?: AgentConfig
    }) {
      items.push({
        text,
        ...(id ? { id } : {}),
        steeringIds,
        agent,
      })
      wake?.()
    },
    pending({ includes }: {
      includes?({ steeringIds }: { steeringIds?: string[] }): boolean
    } = {}) {
      return includes ? items.filter(includes).length : items.length
    },
    end() {
      done = true
      wake?.()
    },
    async* [Symbol.asyncIterator](): AsyncGenerator<{
      text: string
      id?: string
      steeringIds?: string[]
      agent?: AgentConfig
    }> {
      for (;;) {
        if (items.length) {
          yield items.shift()!
        } else if (done) {
          return
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = undefined
        }
      }
    },
  }
}
