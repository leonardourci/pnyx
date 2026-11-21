import { commands } from './cli.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraIds } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { CREATION_PREFIX, summarize, unreadableSummary } from './hydra-summary.ts'
import { homeScoped } from '#store/postgres.ts'
import type { HydraState } from './model.ts'
import { readEvents } from './event-log.ts'
import { withAsyncRegistryLock } from '#store/storage.ts'
import { pickName } from '#hydra/hydra-names.ts'
import { otherHydraNames } from '#hydra/taken-names.ts'
import { inListOrder } from './hydra-list-order.ts'

export interface HydraProjectSummary {
  name: string
  path: string
  live: number
  asks: number
}
export interface HydraSummary {
  asks?: number
  polis?: string
  creationAttempt?: string
  identity?: string
  id: string
  name: string
  icon?: string
  // Position in the Hydra list: the set position, else creation time in ms.
  order: number
  hydra: string
  // Its agent is running a turn now; absent for a Hydra whose agent Pnyx does not run.
  working?: boolean
  projects: HydraProjectSummary[]
}

type Cached = {
  log: string
  summary: HydraSummary
}
const summaries = new Map<string, Cached>()

// Unreadable Hydras remain reachable so opening one reports the error.
export function listHydras(): HydraSummary[] {
  return inListOrder({
    hydras: hydraIds().map(id => {
      let state: HydraState

      try {
        state = loadHydra({ hydraId: id }).state
      } catch {
        return unreadableSummary({ id })
      }

      const key = homeScoped({ hydraId: id })
      const seq = String(state.seq)
      const known = summaries.get(key)

      if (known?.log === seq) {
        return known.summary
      }

      const summary = summarize({
        id,
        state,
      })
      summaries.set(
        key,
        {
          log: seq,
          summary,
        },
      )

      return summary
    }),
  })
}

const creationEventId = ({ attempt }: { attempt: string }) => `${CREATION_PREFIX}${attempt}`

export async function createHydra({
  name,
  icon,
  attempt,
}: {
  name: string
  icon?: string
  attempt?: string
}): Promise<string> {
  return withAsyncRegistryLock({
    fn: async () => {
      const ids = hydraIds({ includeRemoved: true })
      const eventId = attempt ? creationEventId({ attempt }) : undefined

      if (eventId) {
        for (const id of ids) {
          const event = readEvents({
            hydraId: id,
            limit: 1,
          })[0]

          if (event?.type === 'board.configured' && event.id === eventId) {
            return id
          }
        }
      }

      const taken = new Set(ids)
      let n = taken.size + 1

      while (taken.has(`hydra-${n}`)) {
        n++
      }

      const id = `hydra-${n}`
      const args = [
        'create',
        id,
        '--actor',
        'web',
        ...(eventId ? [
          '--event-id',
          eventId,
        ] : []),
      ]

      // Without a name the CLI picks an unused Greek one.
      if (name) {
        args.push(
          '--name',
          name,
        )
      }

      if (icon) {
        args.push(
          '--icon',
          icon,
        )
      }

      await commands.hydra(args)

      return id
    },
  })
}

export async function editHydra({
  id,
  name,
  icon,
  position,
}: {
  id: string
  name?: string
  icon?: string
  position?: number
}): Promise<void> {
  const args = [
    'set',
    '--hydra',
    id,
    '--actor',
    'web',
  ]

  if (name) {
    args.push(
      '--name',
      name,
    )
  }

  if (icon) {
    args.push(
      '--icon',
      icon,
    )
  }

  if (position !== undefined) {
    args.push(
      '--position',
      String(position),
    )
  }

  await commands.hydra(args)
}

export async function nameUnnamedHydras(): Promise<void> {
  await withAsyncRegistryLock({
    fn: async () => {
      for (const id of hydraIds()) {
        const config = readableConfig({ id })

        if (!config || (config.name.trim() && config.name !== id)) {
          continue
        }

        const picked = pickName({ taken: otherHydraNames({ id }) })
        await commands.hydra([
          'set',
          '--hydra',
          id,
          '--name',
          picked.name,
          '--icon',
          picked.icon,
          '--actor',
          'pnyx',
        ])
      }
    },
  })
}

function readableConfig({ id }: { id: string }) {
  try {
    return hydraConfig({
      state: loadHydra({ hydraId: id }).state,
      id,
    })
  } catch {
    return undefined
  }
}
