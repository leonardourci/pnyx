import type { AgentSession } from './model.ts'
import { createHash } from 'node:crypto'
import { realpathSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runFile, runProcess } from '#app/run-process.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
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
  const { stdout } = await runFile({
    command: 'git',
    args: [
      '-C',
      cwd,
      ...args,
    ],
    options: {
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  })

  return stdout.trim()
}

export async function checkoutRoot({ cwd }: { cwd: string }): Promise<string | undefined> {
  const result = await runProcess({
    command: 'git',
    args: [
      '-C',
      cwd,
      'rev-parse',
      '--show-toplevel',
    ],
    timeout: GIT_TIMEOUT_MS,
  })

  return result.status === 0 ? realpathSync(result.stdout.trim()) : undefined
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

  if (current.branch === previousBranch && current.head === previousHead) {
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
  const intent = JSON.parse(readFileSync(
    path,
    'utf8',
  )) as HandoffIntent

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
  ].every(key => typeof intent[key as keyof HandoffIntent] === 'string')) {
    throw new Error(`Invalid handoff intent: ${path}`)
  }

  return intent
}

// Runs before any worker resumes, so its checkout agrees with the committed assignment.
export async function recoverHandoffs({ hydraId }: { hydraId: string }): Promise<void> {
  const dir = handoffsDir({ hydraId })
  let files: string[]

  try {
    files = readdirSync(dir).filter(file => file.endsWith('.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }

  for (const file of files) {
    const path = join(
      dir,
      file,
    )
    const intent = readHandoff({ path })
    const event = readHandoffEvent({
      hydraId,
      eventId: intent.eventId,
    })
    const state = loadHydra({ hydraId }).state
    const assigned = state.sessions?.[intent.session]?.taskId
    const committed = event?.type === 'task.session' && event.cardId === intent.target
      && event.data.session === intent.session && event.data.handoff?.folder === intent.cwd

    if (event && !committed) {
      throw new Error(`Handoff event differs from its intent; inspect ${intent.cwd}`)
    }

    const expectedTask = committed ? intent.target : intent.source
    const expectedBranch = committed ? intent.branch : intent.previousBranch

    const copy = state.cards[expectedTask]?.copy
    const copyChanged = copy && (copy.path !== intent.cwd || copy.branch !== expectedBranch)

    if (!state.cards[expectedTask] || assigned !== expectedTask || copyChanged
      || state.sessions?.[intent.session]?.agent.cwd !== intent.cwd) {
      throw new Error(`Handoff assignment changed; inspect ${intent.cwd}`)
    }

    for (const session of otherWorkers({
      hydraId,
      state,
      session: state.sessions![intent.session]!,
    })) {
      if (await checkoutRoot({ cwd: session.agent.cwd! }) === intent.root) {
        throw new Error(`Another worker uses the handoff checkout; inspect ${intent.cwd}`)
      }
    }

    if (committed) {
      const current = await checkoutState({ cwd: intent.cwd })

      const root = await checkoutRoot({ cwd: intent.cwd })

      if (root !== intent.root || current.branch !== intent.branch) {
        throw new Error(`Committed handoff checkout changed; inspect ${intent.cwd}`)
      }
    } else {
      await restoreCheckout(intent)
    }

    clearHandoff({ path })
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
