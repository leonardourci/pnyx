import type { AgentConfig } from '#workers/model.ts'

// id names the Hydra message or wake an item carries, so a turn knows what it answered.
export function inbox() {
  const items: {
    original?: string
    text: string
    id?: string
    steeringIds?: string[]
    // A steering item that carries its messages' words, not only their IDs.
    inline?: boolean
    agent?: AgentConfig
    // The owner's messages a Hydra input lists, which Hydra takes with it.
    carried?: string[]
  }[] = []
  let wake: (() => void) | undefined, done = false

  return {
    push({
      text,
      original,
      id,
      steeringIds,
      inline,
      agent,
      carried,
    }: {
      original?: string
      text: string
      id?: string
      steeringIds?: string[]
      inline?: boolean
      agent?: AgentConfig
      carried?: string[]
    }) {
      items.push({
        text,
        original,
        ...(id ? { id } : {}),
        steeringIds,
        ...(inline ? { inline } : {}),
        agent,
        carried,
      })
      wake?.()
    },
    pending({ includes }: {
      includes?({ steeringIds }: { steeringIds?: string[] }): boolean
    } = {}) {
      return includes ? items.filter(includes).length : items.length
    },
    clear() {
      return items.splice(0)
    },
    end() {
      done = true
      wake?.()
    },
    async* [Symbol.asyncIterator](): AsyncGenerator<{
      original?: string
      text: string
      id?: string
      steeringIds?: string[]
      inline?: boolean
      agent?: AgentConfig
      carried?: string[]
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
