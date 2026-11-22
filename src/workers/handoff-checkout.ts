import { HydraError } from '#store/errors.ts'
import type { AgentSession } from './model.ts'
import { createHash } from 'node:crypto'
import { realpathSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { git as projectGit } from '#projects/git.ts'
import { sameProjectPath } from '#projects/identity.ts'
import { hydraDir, hydraIds } from '#app/home-migration.ts'
import { log } from '#app/diagnostics.ts'
import { loadHydra, reloadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { privateDir, replaceFile } from '#store/storage.ts'
import { nativeHome } from '#app/native-home.ts'
import { nativeFact, nativeReferences, reduceNative, type NativeState } from '#app/native-state.ts'
import { taskFiles } from '#store/file-home.ts'
import { readLog } from '#store/log.ts'
import { applySessionMove } from './reduce.ts'

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

export async function matchesCheckout({
  cwd,
  root,
  branch,
  head,
}: {
  cwd: string
  root: string
  branch: string
  head: string
}): Promise<boolean> {
  const current = await checkoutState({ cwd })
  const sameRoot = await checkoutRoot({ cwd }) === root

  return sameRoot && current.branch === branch && current.head === head && !current.dirty
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

  const restored = await matchesCheckout({
    cwd,
    root,
    branch: previousBranch,
    head: previousHead,
  })

  if (!restored) {
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
      help: [`Inspect the copy of ${task} for changed work, then use /restart in Hydra chat to settle the handoff`],
    })
  }
}

async function completeHandoff({
  hydraId,
  intent,
  event,
}: {
  hydraId: string
  intent: HandoffIntent
  event: Extract<HydraEvent, { type: 'task.session' }>
}): Promise<void> {
  const home = nativeHome()
  await home.run({
    fn: async () => {
      const tasks = [
        intent.source,
        intent.target,
      ]
      const missing = tasks.filter(task => !home.files.has({
        hydra: hydraId,
        task,
        id: event.id,
      }))

      if (!missing.length) {
        return
      }

      const before = structuredClone(loadHydra({ hydraId }).state)
      const positions = home.files.positions({ hydra: hydraId })
      const ids = home.references({ hydra: hydraId })

      for (const task of tasks) {
        const position = positions?.tasks.get(task)?.position

        if (!position) {
          throw new Error(`Handoff task log is missing; inspect ${intent.cwd}`)
        }

        let previous: NativeState = {}
        let reached = false
        readLog({
          path: join(
            taskFiles({
              home: home.path,
              hydra: hydraId,
              task,
            }),
            'task.log',
          ),
          through: position,
          readOnly: true,
          accept: ({ entry }) => {
            reached = reached || entry.id === event.id

            if (!reached) {
              previous = reduceNative({
                state: previous,
                entry,
                id: task,
              })
            }
          },
        })
        const restored = nativeReferences({
          value: previous,
          ids,
          restore: true,
        }) as NativeState

        if (!restored.card) {
          throw new Error(`Handoff task history is missing; inspect ${intent.cwd}`)
        }

        before.cards[task] = restored.card
        before.sessions = {
          ...before.sessions,
          ...restored.sessions,
        }
      }

      const after = structuredClone(before)
      applySessionMove({
        state: after,
        event,
      })

      if (after.sessions?.[intent.session]?.taskId !== intent.target) {
        throw new Error(`Handoff decision cannot be recovered; inspect ${intent.cwd}`)
      }

      for (const task of missing) {
        home.position({
          hydra: hydraId,
          scope: task,
          id: event.id,
          seq: event.seq,
        })
        const fact = nativeFact({
          event,
          before,
          after,
          task,
          ids,
          basis: home.files.value({
            hydra: hydraId,
            task,
          })?.state,
        })
        await home.files.changeTask({
          hydra: hydraId,
          task,
          decide: () => [fact],
        })
      }

      reloadHydra({ hydraId })
    },
  })
}

// Runs before any worker resumes, so its checkout agrees with the committed assignment.
export async function recoverHandoffs({ hydraId }: { hydraId: string }): Promise<void> {
  const recover = async ({ path }: { path: string }) => {
    const intent = readHandoff({ path })
    const event = readHandoffEvent({
      hydraId,
      eventId: intent.eventId,
    })
    const committed = event?.type === 'task.session' && event.cardId === intent.target
      && event.data.session === intent.session && event.data.handoff?.folder === intent.cwd
      && event.data.before === intent.source && event.data.after === intent.target

    if (event && !committed) {
      throw new Error(`Handoff event differs from its intent; inspect ${intent.cwd}`)
    }

    if (committed) {
      await completeHandoff({
        hydraId,
        intent,
        event,
      })
    }

    const state = loadHydra({ hydraId }).state
    const assigned = state.sessions?.[intent.session]
    const expectedTask = committed ? intent.target : intent.source
    const copy = state.cards[expectedTask]?.copy
    const copyChanged = copy && (!sameProjectPath({
      left: copy.path,
      right: intent.root,
    })
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
      const kept = await matchesCheckout({
        cwd: intent.cwd,
        root: intent.root,
        branch: intent.branch,
        head: intent.tip,
      })

      if (!kept) {
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
  reloadHydra({ hydraId })

  return readEvents({
    hydraId,
    ids: [eventId],
    limit: 1,
  })[0]
}
