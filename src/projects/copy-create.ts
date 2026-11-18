import { mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { matchesProject } from './identity.ts'
import { COPY_TIMEOUT_MS, branchExists, branchStart, clearDefaultUpstreams, commonDir, git, gitProject, createTaskBranch } from './git.ts'
import { checkCopy } from './copy-check.ts'
import { checkout, copiesDir, freshSlot, liveCopy, recordedBranches, reusable, slots, take, unclaim } from './copy-pool.ts'
import type { HydraProject, TaskCopy } from './model.ts'
import { projectsFor } from './read.ts'
import { runProcess } from '#app/run-process.ts'
import type { HydraState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { pnyxHome } from '#store/storage.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { isFolder } from '#workers/folders.ts'

function taskProject({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): HydraProject | undefined {
  return projectsFor({ state }).find(p => !p.detached && matchesProject({
    project: p,
    ref: card.project,
  }))
}

// ponytail: an attached session stands for a live worker; a presence check could replace it.
function refuseShared({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}): void {
  const working = ({ card }: { card: Card }) => liveTask({ card }) && card.sessionIds?.length
    && !card.doneAt && (card.folder === path || card.agent?.cwd === path)
  const busy = hydraIds().filter(id => id !== hydraId
    && Object.values(loadHydra({ hydraId: id }).state.cards).some(card => working({ card })))

  if (busy.length) {
    throw new HydraError({
      message: `a worker of Hydra ${busy.join(', ')} already runs in ${path}`,
      code: 'CONFLICT',
      help: ['Start without --in-place so the worker gets its own copy'],
    })
  }
}

async function releasedCopyLanded({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}): Promise<boolean> {
  const state = loadHydra({ hydraId }).state
  const branch = (await git({
    cwd: path,
    args: [
      'branch',
      '--show-current',
    ],
  })).out
  const previous = Object.values(state.cards).find(card => card.copy?.path === path
    && card.copy.state === 'removed' && card.copy.branch === branch)

  if (!previous?.copy) {
    return false
  }

  const check = await checkCopy({
    card: previous,
    copy: previous.copy,
  })

  if (!('reason' in check)) {
    return true
  }

  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = writer.state.cards[previous.id]

      if (current?.copy?.path !== path || current.copy.state !== 'removed') {
        return
      }

      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          cardId: current.id,
          meta: {
            actor: 'pnyx',
            at: new Date().toISOString(),
          },
          change: {
            type: 'task.copy',
            data: {
              before: current.copy,
              after: {
                ...current.copy,
                state: 'flagged',
                reason: check.reason,
              },
            },
          },
        }),
      })
    },
  })

  return false
}

// The slot it returns stays claimed until the caller records it.
async function worktreeCopy({
  hydraId,
  card,
  project,
}: {
  hydraId: string
  card: Card
  project: HydraProject
}): Promise<TaskCopy> {
  await gitProject({ project })
  mkdirSync(
    copiesDir({ hydraId }),
    { recursive: true },
  )
  const {
    base,
    start,
  } = await branchStart({ project })
  const state = loadHydra({ hydraId }).state
  const branches = recordedBranches({
    hydraId,
    state,
    project: project.path,
  })
  const existingCopy = liveCopy({ card })
  const previous = existingCopy?.via === 'worktree' ? existingCopy : undefined
  const branch = previous?.branch ?? await createTaskBranch({
    cwd: project.path,
    hydraName: state.config?.name || hydraId,
    task: card.id,
    title: card.title,
    reserved: branches,
    start,
  })

  if (!branch) {
    throw new HydraError({
      code: 'COPY_FAILED',
      message: 'task branch allocation was cancelled',
    })
  }

  await clearDefaultUpstreams({
    cwd: project.path,
    branches,
  })
  const pooled = slots({
    hydraId,
    project,
  })
  const common = await commonDir({ cwd: project.path })

  const pruned = await git({
    cwd: project.path,
    args: [
      'worktree',
      'prune',
      '--expire=now',
    ],
  })

  if (!pruned.ok) {
    throw new HydraError({
      message: `could not prune missing worktrees: ${pruned.err}`,
      code: 'COPY_FAILED',
    })
  }

  const exists = await branchExists({
    cwd: project.path,
    branch,
  })
  const copyBase = previous ? previous.base : base

  const made = ({ path }: { path: string }): TaskCopy => {
    const copy: TaskCopy = {
      path,
      project: project.path,
      via: 'worktree',
      branch,
      state: 'active',
    }

    if (copyBase) {
      copy.base = copyBase
    }

    return copy
  }

  // Ignored files such as installed dependencies stay with the slot; the clean check leaves nothing else to reset.
  for (const path of pooled) {
    if (!take({
      hydraId,
      card,
      path,
    })) {
      continue
    }

    let allocated = false

    try {
      if (!await releasedCopyLanded({
        hydraId,
        path,
      }) || !await reusable({
        path,
        common,
      })) {
        continue
      }

      const checkedOut = await checkout({
        cwd: path,
        branch,
        start,
        exists,
      })

      if (!checkedOut.ok) {
        throw new HydraError({
          code: 'COPY_FAILED',
          message: `git could not switch the task's copy: ${checkedOut.err}`,
        })
      }

      allocated = true

      return made({ path })
    } finally {
      if (!allocated) {
        unclaim({ path })
      }
    }
  }

  const path = freshSlot({
    hydraId,
    project,
  })
  const checkoutArgs = exists ? [
    path,
    branch,
  ] : [
    '--no-track',
    '-b',
    branch,
    path,
    start,
  ]
  let allocated = false

  try {
    const added = await git({
      cwd: project.path,
      args: [
        'worktree',
        'add',
        ...checkoutArgs,
      ],
    })

    if (!added.ok) {
      throw new HydraError({
        message: `git could not make the task's copy: ${added.err}`,
        code: 'COPY_FAILED',
        help: ['Fix the project folder, or start with --in-place'],
      })
    }

    const copy = made({ path: realpathSync(path) })
    allocated = true

    return copy
  } finally {
    if (!allocated) {
      unclaim({ path })
    }
  }
}

async function commandCopy({
  hydraId,
  card,
  project,
  command,
}: {
  hydraId: string
  card: Card
  project: HydraProject
  command: string
}): Promise<TaskCopy> {
  const run = await runProcess({
    command: '/bin/sh',
    args: [
      '-c',
      command,
    ],
    cwd: project.path,
    timeout: COPY_TIMEOUT_MS,
    env: {
      ...process.env,
      PNYX_HOME: pnyxHome(),
      PNYX_HYDRA: hydraId,
      PNYX_TASK: card.id,
      PNYX_TASK_TITLE: card.title,
      PNYX_PROJECT: project.path,
    },
  })
  const printed = run.stdout.trim().split('\n')
    .at(-1)
    ?.trim() ?? ''

  const usable = isAbsolute(printed) && isFolder({ path: printed })
    && realpathSync(printed) !== project.path

  if (run.status !== 0 || !usable) {
    throw new HydraError({
      message: run.status !== 0 ? `the copy command of ${project.name} failed: ${run.stderr.trim().slice(-500)}` : `the copy command of ${project.name} must print the new folder's absolute path last, other than the project folder`,
      code: 'COPY_FAILED',
      help: ['Fix it with `pnyx-axi project set <name> --copy <shell command>`, or start with --in-place'],
    })
  }

  return {
    path: realpathSync(printed),
    project: project.path,
    via: 'command',
    state: 'active',
  }
}

// A project task works in its own copy unless the start says otherwise; Firstmate Hydras make their own.
export async function taskFolder({
  hydraId,
  task,
  folder,
  inPlace,
  ownFolder,
  meta,
}: {
  hydraId: string
  task: string
  folder?: string
  inPlace?: boolean
  ownFolder?: boolean
  meta: Meta
}): Promise<string | undefined> {
  const state = loadHydra({ hydraId }).state

  if (state.config?.hydra.kind === 'firstmate') {
    return folder
  }

  const card = findCard({
    state,
    ref: task,
  })
  const project = taskProject({
    state,
    card,
  })
  const given = canonical({ path: folder })

  if (given && inPlace) {
    throw new HydraError({
      message: 'use either --folder or --in-place',
      code: 'VALIDATION_ERROR',
    })
  }

  if (given) {
    if (projectsFor({ state }).some(p => !p.detached && matchesProject({
      project: p,
      ref: given,
    }))) {
      refuseShared({
        hydraId,
        path: given,
      })
    }

    return given
  }

  if (!project) {
    if (inPlace) {
      throw new HydraError({
        message: '--in-place needs a task with an attached project',
        code: 'VALIDATION_ERROR',
        help: [`Run \`pnyx-axi task project ${card.id} --project <name> --hydra ${hydraId}\``],
      })
    }

    return folder
  }

  // A busy task is the route's own refusal; it gets no copy first.
  if (card.sessionIds?.length) {
    return folder
  }

  if (inPlace || ownFolder) {
    if (inPlace) {
      refuseShared({
        hydraId,
        path: project.path,
      })
    }

    return project.path
  }

  const live = liveCopy({ card })

  if (live && live.project !== project.path) {
    throw new HydraError({
      message: `task ${card.id} still has a copy of ${live.project} at ${live.path}`,
      code: 'CONFLICT',
      help: [`Settle it first with \`pnyx-axi task copy ${card.id} remove --hydra ${hydraId}\``],
    })
  }

  const current = live && isFolder({ path: live.path }) ? live : undefined
  const ready = current
    ?? (project.copy ? await commandCopy({
      hydraId,
      card,
      project,
      command: project.copy,
    }) : undefined)
  const copy = ready ?? await worktreeCopy({
    hydraId,
    card,
    project,
  })

  try {
    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const now = findCard({
          state: writer.state,
          ref: card.id,
        })
        // Another start may have won while this copy was prepared: it leaves its session and copy as they are.
        const startedMeanwhile = Boolean(now.sessionIds?.length)
        const copiedMeanwhile = now.copy?.state === 'active' && now.copy.path !== card.copy?.path
          && now.copy.path !== copy.path

        if (startedMeanwhile || copiedMeanwhile) {
          throw new HydraError({
            message: `task ${card.id} was started meanwhile; its session keeps ${now.copy?.path ?? now.folder ?? 'its folder'}`,
            code: 'SESSION_CONFLICT',
          })
        }

        const id = meta.id && !(`${meta.id}:copy` in writer.state.eventIds) ? `${meta.id}:copy` : undefined
        const recorded = {
          ...meta,
          id,
          ifRevision: undefined,
        }

        const previousCopy = now.copy
        const sameCopy = previousCopy?.path === copy.path && previousCopy.project === copy.project
          && previousCopy.via === copy.via && previousCopy.branch === copy.branch
          && previousCopy.base === copy.base

        if (!sameCopy || previousCopy?.state !== 'active') {
          const change = {
            type: 'task.copy' as const,
            data: {
              before: now.copy ?? null,
              after: copy,
            },
          }
          applyDecision({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: recorded,
              cardId: now.id,
              change,
            }),
          })
        }

        pushFolder({
          writer,
          card: now,
          folder: copy.path,
          meta: {
            ...recorded,
            id: id && `${id}:folder`,
          },
        })

        return copy.path
      },
    })
  } finally {
    if (!ready) {
      unclaim({ path: copy.path })
    }
  }
}

export function pushFolder({
  writer,
  card,
  folder,
  meta,
}: {
  writer: Writer
  card: Card
  folder: string | null
  meta: Meta
}): void {
  if ((card.folder ?? null) !== folder) {
    applyDecision({
      writer,
      decision: decidePush({
        state: writer.state,
        key: card.key,
        input: { folder },
        meta,
      }),
    })
  }
}
