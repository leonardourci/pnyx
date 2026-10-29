import { statSync } from 'node:fs'
import { join } from 'node:path'
import { commands } from './cli.ts'
import { hydraIdentity } from './server-state.ts'
import { hydraConfig } from '#hydra/config.ts'
import { hydraDir, hydraIds } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { readInitialEvent } from './event-log.ts'
import { withRegistryLock } from '#store/storage.ts'
import { projectsFor } from '#projects/read.ts'
import { firstmateProjects } from '#integrations/firstmate/projects.ts'
import { liveTask } from '#tasks/select.ts'
import { pickName } from '#hydra/hydra-names.ts'
import { otherHydraNames } from '#hydra/cli.ts'

export interface HydraProjectSummary {
  name: string
  path: string
  references: string[]
  live: number
  asks: number
}
export interface HydraSummary {
  creationAttempt?: string
  identity?: string
  id: string
  name: string
  icon?: string
  hydra: string
  projects: HydraProjectSummary[]
}

// A summary is reused until the Hydra's log, or the projects of its Firstmate home, change.
type Cached = {
  log: string
  home?: string
  projects: string
  summary: HydraSummary
}
const summaries = new Map<string, Cached>()

function projectStamp({ home }: { home?: string }): string {
  try {
    return home ? JSON.stringify(firstmateProjects({
      home,
      aliases: true,
    })) : ''
  } catch (error) {
    return String(error)
  }
}

function logStamp({ id }: { id: string }): string {
  try {
    const {
      ino,
      size,
      mtimeMs,
    } = statSync(join(
      hydraDir({ hydraId: id }),
      'events.jsonl',
    ))

    return `${ino}:${size}:${mtimeMs}`
  } catch {
    return ''
  }
}

// Unreadable Hydras remain reachable so opening one reports the error.
export function listHydras(): HydraSummary[] {
  return hydraIds().map(id => {
    const log = logStamp({ id }), known = summaries.get(id)

    if (log && known?.log === log && known.projects === projectStamp({ home: known.home })) {
      return known.summary
    }

    const {
      summary,
      home,
    } = summarize({ id })
    summaries.set(
      id,
      {
        log,
        home,
        projects: projectStamp({ home }),
        summary,
      },
    )

    return summary
  })
}

function summarize({ id }: { id: string }): {
  summary: HydraSummary
  home?: string
} {
  try {
    const state = loadHydra({ hydraId: id }).state
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

    return {
      home,
      summary: {
        id,
        identity: hydraIdentity({ hydraId: id }),
        creationAttempt: Object.entries(state.eventIds).find(([
          event,
          seq,
        ]) => seq === 1 && event.startsWith('hydra-create:'))?.[0].slice('hydra-create:'.length),
        name: config.name,
        icon: config.icon,
        hydra: home ? `Firstmate ${home}` : config.hydra.name,
        projects,
      },
    }
  } catch {
    return {
      summary: {
        id,
        name: id,
        hydra: 'could not be loaded',
        projects: [],
      },
    }
  }
}

export function createHydra({
  name,
  icon,
  attempt,
}: {
  name: string
  icon?: string
  attempt?: string
}): string {
  return withRegistryLock({
    fn: () => {
      const ids = hydraIds()
      const eventId = attempt ? `hydra-create:${attempt}` : undefined

      if (eventId) {
        for (const id of ids) {
          const event = readInitialEvent({ hydraId: id })

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

      commands.hydra(args)

      return id
    },
  })
}

export function editHydra({
  id,
  name,
  icon,
}: {
  id: string
  name?: string
  icon?: string
}): void {
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

  commands.hydra(args)
}

// A Firstmate Hydra keeps its home's name; an unreadable Hydra is left for opening to report.
export function nameUnnamedHydras(): void {
  withRegistryLock({
    fn: () => {
      for (const id of hydraIds()) {
        const config = readableConfig({ id })

        if (!config || config.hydra.kind === 'firstmate' || (config.name.trim() && config.name !== id)) {
          continue
        }

        const picked = pickName({ taken: otherHydraNames({ id }) })
        commands.hydra([
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
