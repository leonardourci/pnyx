import { ownerPolis } from '#memory/owner-polis.ts'
import type { TitanEvent, TitanState } from './model.ts'
import type { TitanSummary } from './server-hydras.ts'
import { hydraIdentity } from './server-state.ts'
import { hydraConfig } from '#titan/config.ts'
import { readEvents } from './event-log.ts'
import { homeScoped } from '#store/paths.ts'
import { projectsFor } from '#projects/read.ts'
import { ownerQuestionGroups } from '#tasks/question-groups.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraWorking } from '#titan/chat-queue.ts'

export const CREATION_PREFIX = 'hydra-create:'

// A Titan's first event never changes, so each is read once it exists.
const firstEvents = new Map<string, TitanEvent>()

function firstEvent({ hydraId }: { hydraId: string }): TitanEvent | null {
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

const creationAttempt = ({ event }: { event: TitanEvent | null }) => {
  if (!event?.id.startsWith(CREATION_PREFIX)) {
    return undefined
  }

  return event.id.slice(CREATION_PREFIX.length)
}

// A Titan whose log has no readable first event sorts last.
const createdAt = ({ event }: { event: TitanEvent | null }) => Date.parse(event?.at ?? '')
  || Number.MAX_SAFE_INTEGER

export function summarize({
  id,
  state,
}: {
  id: string
  state: TitanState
}): TitanSummary {
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
      polis: ownerPolis({ state }),
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

// A Titan that cannot be read stays in the list, last, so opening it reports why.
export const unreadableSummary = ({ id }: { id: string }): TitanSummary => ({
  id,
  name: id,
  order: Number.MAX_SAFE_INTEGER,
  hydra: 'could not be loaded',
  projects: [],
})
