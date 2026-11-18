import { HydraError } from '#store/errors.ts'
import type { AgentSession } from './model.ts'
import { createHash } from 'node:crypto'
import { realpathSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { git as projectGit } from '#projects/git.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { log } from '#app/diagnostics.ts'
import { loadHydra, reloadHydra } from '#app/store.ts'
import { query } from '#store/postgres.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { privateDir, replaceFile } from '#store/storage.ts'

const GIT_TIMEOUT_MS = 30_000

export async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): Promise<string> {
  const result = await projectGit({
    cwd,
    args,
    timeout: GIT_TIMEOUT_MS,
  })

  if (!result.ok) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${result.err}`)
  }

  return result.out
}

export async function checkoutRoot({ cwd }: { cwd: string }): Promise<string | undefined> {
  const result = await projectGit({
    cwd,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
    timeout: GIT_TIMEOUT_MS,
  })

  return result.ok ? realpathSync(result.out) : undefined
}

export async function checkoutState({ cwd }: { cwd: string }) {
  const currentBranch = await git({
    cwd,
    args: [
      'branch',
      '--show-current',
    ],
  })
  const currentHead = await git({
    cwd,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })

  const status = await git({
    cwd,
    args: [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ],
  })

  return {
    branch: currentBranch,
    head: currentHead,
    dirty: Boolean(status),
  }
}

export async function restoreCheckout({
  cwd,
  root,
  branch,
  tip,
  previousBranch,
  previousHead,
}: {
  cwd: string
  root: string
  branch: string
  tip: string
  previousBranch: string
  previousHead: string
}): Promise<void> {
  if (await checkoutRoot({ cwd }) !== root) {
    throw new Error('Handoff was not recorded and the checkout moved; inspect the worker folder before continuing')
  }

  const current = await checkoutState({ cwd })

  if (!current.dirty && current.branch === previousBranch && current.head === previousHead) {
    return
  }

  if (current.branch !== branch || current.head !== tip || current.dirty) {
    throw new Error('Handoff was not recorded and the checkout changed; inspect the worker folder before continuing')
  }

  if (previousBranch && await git({
    cwd,
    args: [
      'rev-parse',
      `refs/heads/${previousBranch}`,
    ],
  }) !== previousHead) {
    throw new Error('Handoff was not recorded and the previous branch moved; inspect the worker folder before continuing')
  }

  const args = previousBranch ? [
    'switch',
    '--no-guess',
    previousBranch,
  ] : [
    'switch',
    '--detach',
    previousHead,
  ]
  await git({
    cwd,
    args,
  })
  const restored = await checkoutState({ cwd })

  if (await checkoutRoot({ cwd }) !== root || restored.branch !== previousBranch
    || restored.head !== previousHead || restored.dirty) {
    throw new Error('Handoff was not recorded and the previous checkout could not be restored; inspect the worker folder before continuing')
  }
}

export const otherWorkers = ({
  hydraId,
  state,
  session,
}: {
  hydraId: string
  state: HydraState
  session: AgentSession
}) => hydraIds().flatMap(id => {
  const current = id === hydraId ? state : loadHydra({ hydraId: id }).state

  return Object.values(current.sessions ?? {})
    .filter(s => (id !== hydraId || s.id !== session.id) && s.taskId && s.agent.cwd && s.activity !== 'ended')
})

interface HandoffIntent {
  eventId: string
  session: string
  source: string
  target: string
  cwd: string
  root: string
  branch: string
  tip: string
  previousBranch: string
  previousHead: string
}

const handoffsDir = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'handoffs',
)

export function saveHandoff({
  hydraId,
  intent,
}: {
  hydraId: string
  intent: HandoffIntent
}): string {
  const dir = handoffsDir({ hydraId })
  privateDir({ dir })
  const key = createHash('sha256').update(intent.session)
    .digest('hex')
  const path = join(
    dir,
    `${key}.json`,
  )

  if (existsSync(path)) {
    throw new Error('A previous handoff still needs startup recovery before this worker can advance')
  }

  replaceFile({
    path,
    text: JSON.stringify(intent),
  })

  return path
}

export function clearHandoff({ path }: { path: string }): void {
  rmSync(path)
}

function readHandoff({ path }: { path: string }): HandoffIntent {
  const intent: unknown = JSON.parse(readFileSync(
    path,
    'utf8',
  ))

  if (!intent || typeof intent !== 'object' || ![
    'eventId',
    'session',
    'source',
    'target',
    'cwd',
    'root',
    'branch',
    'tip',
    'previousBranch',
    'previousHead',
  ].every(key => typeof Object.getOwnPropertyDescriptor(
    intent,
    key,
  )?.value === 'string')) {
    throw new Error(`Invalid handoff intent: ${path}`)
  }

  return intent as HandoffIntent
}

function handoffFiles({ hydraId }: { hydraId: string }): string[] {
  const dir = handoffsDir({ hydraId })
  let files: string[]

  try {
    files = readdirSync(dir).filter(file => file.endsWith('.json'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }

  return files.map(file => join(
    dir,
    file,
  ))
}

export function handoffPending({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): boolean {
  return handoffFiles({ hydraId }).some(path => {
    const intent = readHandoff({ path })

    return intent.source === task || intent.target === task
  })
}

export function requireHandoffAvailable({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}): void {
  if (handoffPending({
    hydraId,
    task,
  })) {
    throw new HydraError({
      code: 'CONFLICT',
      message: `Task ${task} has an unresolved handoff; inspect its checkout and restart Pnyx before delivering more work`,
    })
  }
}

// Runs before any worker resumes, so its checkout agrees with the committed assignment.
export async function recoverHandoffs({ hydraId }: { hydraId: string }): Promise<void> {
  const recover = async ({ path }: { path: string }) => {
    const intent = readHandoff({ path })
    const event = readHandoffEvent({
      hydraId,
      eventId: intent.eventId,
    })
    const state = loadHydra({ hydraId }).state
    const assigned = state.sessions?.[intent.session]
    const committed = event?.type === 'task.session' && event.cardId === intent.target
      && event.data.session === intent.session && event.data.handoff?.folder === intent.cwd

    if (event && !committed) {
      throw new Error(`Handoff event differs from its intent; inspect ${intent.cwd}`)
    }

    const expectedTask = committed ? intent.target : intent.source
    const copy = state.cards[expectedTask]?.copy
    const copyChanged = copy && (copy.path !== intent.cwd
      || (committed && copy.branch !== intent.branch))

    if (!state.cards[expectedTask] || assigned?.taskId !== expectedTask || copyChanged
      || assigned.agent.cwd !== intent.cwd) {
      throw new Error(`Handoff assignment changed; inspect ${intent.cwd}`)
    }

    for (const session of otherWorkers({
      hydraId,
      state,
      session: assigned,
    })) {
      const cwd = session.agent.cwd

      if (cwd && (cwd === intent.cwd || await checkoutRoot({ cwd }) === intent.root)) {
        throw new Error(`Another worker uses the handoff checkout; inspect ${intent.cwd}`)
      }
    }

    if (committed) {
      const current = await checkoutState({ cwd: intent.cwd })

      const root = await checkoutRoot({ cwd: intent.cwd })

      if (root !== intent.root || current.branch !== intent.branch
        || current.head !== intent.tip || current.dirty) {
        throw new Error(`Committed handoff checkout changed; inspect ${intent.cwd}`)
      }
    } else {
      await restoreCheckout(intent)
    }

    clearHandoff({ path })
  }

  for (const path of handoffFiles({ hydraId })) {
    try {
      await recover({ path })
    } catch (error) {
      log({
        level: 'error',
        operation: 'recover handoff',
        hydraId,
        error,
      })
    }
  }
}

export function readHandoffEvent({
  hydraId,
  eventId,
}: {
  hydraId: string
  eventId: string
}): HydraEvent | undefined {
  // The old process's transaction can finish after it exits; wait on its row lock before reading.
  const [
    , events,
  ] = query({
    transaction: true,
    statements: [
      {
        text: 'select id from hydras where id = $1 for update',
        values: [hydraId],
        expectRows: 1,
      },
      {
        text: 'select data from events where hydra_id = $1 and id = $2',
        values: [
          hydraId,
          eventId,
        ],
      },
    ],
  })
  reloadHydra({ hydraId })

  return events?.[0]?.data as HydraEvent | undefined
}
