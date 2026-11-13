import type { HydraEvent, HydraState } from './model.ts'
import type { HydraSummary } from './server-hydras.ts'
import { hydraIdentity } from './server-state.ts'
import { hostedHydra, hydraConfig } from '#hydra/config.ts'
import { readInitialEvent } from './event-log.ts'
import { homeScoped } from '#store/postgres.ts'
import { projectsFor } from '#projects/read.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraWorking } from '#hydra/chat-queue.ts'

export const CREATION_PREFIX = 'hydra-create:'

// A Hydra's first event never changes, so each is read once it exists.
const firstEvents = new Map<string, HydraEvent>()

function firstEvent({ hydraId }: { hydraId: string }): HydraEvent | null {
  const key = homeScoped({ hydraId })
  const known = firstEvents.get(key)

  if (known) {
    return known
  }

  const event = readInitialEvent({ hydraId })

  if (event) {
    firstEvents.set(
      key,
      event,
    )
  }

  return event
}

const creationAttempt = ({ event }: { event: HydraEvent | null }) => {
  if (!event?.id.startsWith(CREATION_PREFIX)) {
    return undefined
  }

  return event.id.slice(CREATION_PREFIX.length)
}

// A Hydra whose log has no readable first event sorts last.
const createdAt = ({ event }: { event: HydraEvent | null }) => Date.parse(event?.at ?? '')
  || Number.MAX_SAFE_INTEGER

export function summarize({
  id,
  state,
}: {
  id: string
  state: HydraState
}): {
  summary: HydraSummary
  home?: string
} {
  try {
    const config = hydraConfig({
      state,
      id,
    })
    const cards = Object.values(state.cards).filter(c => liveTask({ card: c }))
    const projects = projectsFor({
      state,
      aliases: true,
    }).filter(p => !p.detached)
      .map(p => {
        const references = [
          p.path,
          ...(config.hydra.kind === 'firstmate' ? [
            p.name,
            ...p.aliases ?? [],
          ] : []),
        ]
        const tasks = cards.filter(c => c.project && references.includes(c.project))

        const live = tasks.filter(c => c.agent && (c.sessionActivity ?? c.activity) === 'working')
        const asks = tasks.flatMap(c => c.attention).filter(a => !a.answered)

        return {
          name: p.name,
          path: p.path,
          references,
          live: live.length,
          asks: asks.length,
        }
      })

    const home = config.hydra.kind === 'firstmate' ? config.hydra.home : undefined
    const initial = firstEvent({ hydraId: id })

    return {
      home,
      summary: {
        id,
        identity: hydraIdentity({ hydraId: id }),
        creationAttempt: creationAttempt({ event: initial }),
        name: config.name,
        icon: config.icon,
        order: config.position ?? createdAt({ event: initial }),
        hydra: home ? `Firstmate ${home}` : config.hydra.name,
        working: hostedHydra({ state }) ? hydraWorking({ state }) : undefined,
        projects,
      },
    }
  } catch {
    return { summary: unreadableSummary({ id }) }
  }
}

// A Hydra that cannot be read stays in the list, last, so opening it reports why.
export const unreadableSummary = ({ id }: { id: string }): HydraSummary => ({
  id,
  name: id,
  order: Number.MAX_SAFE_INTEGER,
  hydra: 'could not be loaded',
  projects: [],
})
