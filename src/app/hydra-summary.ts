import { hydraPolisConfig } from '#memory/polis-policy.ts'
import type { HydraEvent, HydraState } from './model.ts'
import type { HydraSummary } from './server-hydras.ts'
import { hydraIdentity } from './server-state.ts'
import { hydraConfig } from '#hydra/config.ts'
import { readEvents } from './event-log.ts'
import { homeScoped } from '#store/postgres.ts'
import { projectsFor } from '#projects/read.ts'
import { ownerQuestionGroups } from '#tasks/question-groups.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraWorking } from '#hydra/chat-queue.ts'

export const CREATION_PREFIX = 'hydra-create:'

// A Hydra's first event never changes, so each is read once it exists.
const firstEvents = new Map<string, HydraEvent>()

// A Hydra's first write names its first event before it commits, so its summary row has it from the start.
export function rememberFirstEvent({
  hydraId,
  event,
}: {
  hydraId: string
  event: HydraEvent
}): void {
  firstEvents.set(
    homeScoped({ hydraId }),
    event,
  )
}

function firstEvent({ hydraId }: { hydraId: string }): HydraEvent | null {
  const key = homeScoped({ hydraId })
  const known = firstEvents.get(key)

  if (known) {
    return known
  }

  const event = readEvents({
    hydraId,
    limit: 1,
  })[0] ?? null

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
}): HydraSummary {
  try {
    const config = hydraConfig({
      state,
      id,
    })
    const cards = Object.values(state.cards).filter(c => liveTask({ card: c }))
    const groups = ownerQuestionGroups({ state })
    const projects = projectsFor({ state }).filter(p => !p.detached)
      .map(p => {
        const tasks = cards.filter(c => c.project === p.path)

        const live = tasks.filter(c => c.agent && (c.sessionActivity ?? c.activity) === 'working')
        const taskIds = new Set(tasks.map(task => task.id))
        const asks = groups.filter(group =>
          group.decisions.some(decision => taskIds.has(decision.card.id)))

        return {
          name: p.name,
          path: p.path,
          live: live.length,
          asks: asks.length,
        }
      })

    const initial = firstEvent({ hydraId: id })

    return {
      asks: groups.length,
      id,
      polis: hydraPolisConfig({ state }).polis,
      identity: hydraIdentity({ hydraId: id }),
      creationAttempt: creationAttempt({ event: initial }),
      name: config.name,
      icon: config.icon,
      order: config.position ?? createdAt({ event: initial }),
      hydra: config.hydra.name,
      working: hydraWorking({ state }),
      projects,
    }
  } catch {
    return unreadableSummary({ id })
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
