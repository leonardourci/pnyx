import { commands } from './cli.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraIds } from './home-migration.ts'
import { loadTitan } from './store.ts'
import { CREATION_PREFIX, summarize, unreadableSummary } from './hydra-summary.ts'
import { homeScoped } from '#store/paths.ts'
import type { TitanState } from './model.ts'
import { readEvents } from './event-log.ts'
import { withAsyncRegistryLock } from '#store/storage.ts'
import { pickName } from '#titan/titan-names.ts'
import { otherTitanNames } from '#titan/taken-names.ts'
import { inListOrder } from './hydra-list-order.ts'

export interface TitanProjectSummary {
  name: string
  path: string
  live: number
  asks: number
}
export interface TitanSummary {
  asks?: number
  polis?: string
  creationAttempt?: string
  identity?: string
  id: string
  name: string
  icon?: string
  // Position in the Titan list: the set position, else creation time in ms.
  order: number
  hydra: string
  // Its agent is running a turn now; absent for a Titan whose agent Othrys does not run.
  working?: boolean
  projects: TitanProjectSummary[]
}

type Cached = {
  log: string
  summary: TitanSummary
}
const summaries = new Map<string, Cached>()

// Unreadable Titans remain reachable so opening one reports the error.
export function listTitans(): TitanSummary[] {
  return inListOrder({
    hydras: hydraIds().map(id => {
      let state: TitanState

      try {
        state = loadTitan({ hydraId: id }).state
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

export async function createTitan({
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

export async function editTitan({
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
    '--titan',
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

export async function nameUnnamedTitans(): Promise<void> {
  await withAsyncRegistryLock({
    fn: async () => {
      for (const id of hydraIds()) {
        const config = readableConfig({ id })

        if (!config || (config.name.trim() && config.name !== id)) {
          continue
        }

        const picked = pickName({ taken: otherTitanNames({ id }) })
        await commands.hydra([
          'set',
          '--titan',
          id,
          '--name',
          picked.name,
          '--icon',
          picked.icon,
          '--actor',
          'othrys',
        ])
      }
    },
  })
}

function readableConfig({ id }: { id: string }) {
  try {
    return hydraConfig({
      state: loadTitan({ hydraId: id }).state,
      id,
    })
  } catch {
    return undefined
  }
}
