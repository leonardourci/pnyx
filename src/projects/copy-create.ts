import { inform } from '#app/command-notices.ts'
import { protectedCopiesFolder } from './remove-pool.ts'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { matchesProject, sameProjectPath } from './identity.ts'
import { COPY_TIMEOUT_MS, branchExists, branchStart, clearDefaultUpstreams, commonDir, git, gitProject, createTaskBranch } from './git.ts'
import { checkCopy } from './copy-check.ts'
import { branchTitanName, checkout, copiesDir, freshSlot, liveCopy, recordedBranches, releasedCopyOwner, requireUnlinkedCopyFolder, reusable, slots, take, unclaim } from './copy-pool.ts'
import type { TitanProject, TaskCopy } from './model.ts'
import { projectsFor } from './read.ts'
import { runProcess } from '#app/run-process.ts'
import type { TitanState } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { decidePush } from '#tasks/push.ts'
import { findCard } from '#tasks/push-rules.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { hydraEvent } from '#titan/titan.ts'
import { hydraConfig } from '#titan/config.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import { canonical } from '#store/paths.ts'
import { othrysHome } from '#store/storage.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { isFolder } from '#workers/folders.ts'

function taskProject({
  state,
  card,
}: {
  state: TitanState
  card: Card
}): TitanProject | undefined {
  return projectsFor({ state }).find(p => !p.detached && matchesProject({
    project: p,
    ref: card.project,
  }))
}

async function verifyCopyBranch({
  path,
  branch,
}: {
  path: string
  branch: string
}): Promise<void> {
  const head = await git({
    cwd: path,
    args: [
      'symbolic-ref',
      '--quiet',
      'HEAD',
    ],
  })

  if (!head.ok || head.out !== `refs/heads/${branch}`) {
    throw new TitanError({
      code: 'COPY_FAILED',
      message: `the task copy did not stay on branch ${branch}`,
    })
  }
}

// ponytail: an attached session stands for a live worker; a presence check could replace it.
function noteShared({
  titanId,
  path,
}: {
  titanId: string
  path: string
}): void {
  const working = ({ card }: { card: Card }) => liveTask({ card }) && card.sessionIds?.length
    && !card.doneAt && (card.folder === path || card.agent?.cwd === path)
  const busy = hydraIds().filter(id => id !== titanId
    && Object.values(loadTitan({ titanId: id }).state.cards).some(card => working({ card })))

  if (busy.length) {
    inform({
      reason: `A worker of Titan ${busy.join(', ')} already uses ${path}`,
      clear: 'Start without --in-place or --folder to use a separate copy',
    })
  }
}

// The slot's current branch, empty when detached, once its work is proved landed; undefined keeps it out of reuse.
async function landedSlotBranch({
  titanId,
  path,
  card,
  project,
  base,
  common,
}: {
  titanId: string
  path: string
  card: Card
  project: TitanProject
  base?: string
  common: string
}): Promise<string | undefined> {
  const branch = (await git({
    cwd: path,
    args: [
      'branch',
      '--show-current',
    ],
  })).out
  const released = releasedCopyOwner({
    path,
    branch,
  })

  if (!released?.card.copy) {
    const slotCommon = await commonDir({ cwd: path })

    // Projects with the same folder name share slot names; another repository's slot is that project's to settle.
    if (slotCommon && slotCommon !== common) {
      return undefined
    }

    const copy: TaskCopy = {
      path,
      project: project.path,
      via: 'worktree',
      state: 'active',
    }

    if (base) {
      copy.base = base
    }

    const check = await checkCopy({
      card,
      copy,
    })

    if (!('reason' in check)) {
      return branch
    }

    const key = createHash('sha256').update(`${path}\0${branch}\0${check.reason}`)
      .digest('hex')
    await withWriter({
      titanId,
      fn: ({ writer }) => applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          cardId: TITAN_CARD,
          meta: {
            id: `unrecorded-copy:${key}`,
            actor: 'othrys',
            at: new Date().toISOString(),
          },
          change: {
            type: 'titan.message',
            data: {
              action: 'send',
              text: `Unrecorded copy ${path} was kept: ${check.reason}. Inspect and land its work before reusing it.`,
              hydra: hydraConfig({
                state: writer.state,
                id: titanId,
              }).hydra.id,
            },
          },
        }),
      }),
    })

    return undefined
  }

  const check = await checkCopy({
    card: released.card,
    copy: released.card.copy,
  })

  if (!('reason' in check)) {
    return branch
  }

  await withWriter({
    titanId: released.titanId,
    fn: ({ writer }) => {
      const current = writer.state.cards[released.card.id]

      if (current?.copy?.state !== 'removed' || current.copy.branch !== branch
        || canonical({ path: current.copy.path }) !== path) {
        return
      }

      applyDecision({
        writer,
        decision: hydraEvent({
          state: writer.state,
          cardId: current.id,
          meta: {
            actor: 'othrys',
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

  return undefined
}

// The slot it returns stays claimed until the caller records it.
async function worktreeCopy({
  titanId,
  card,
  project,
}: {
  titanId: string
  card: Card
  project: TitanProject
}): Promise<TaskCopy> {
  await gitProject({ project })
  const pool = copiesDir()
  requireUnlinkedCopyFolder({ path: pool })
  mkdirSync(
    pool,
    { recursive: true },
  )

  const {
    base,
    start,
  } = await branchStart({ project })
  const state = loadTitan({ titanId }).state
  const branches = recordedBranches({
    titanId,
    state,
    project: project.path,
  })
  const previous = card.copy?.via === 'worktree' && sameProjectPath({
    left: card.copy.project,
    right: project.path,
  }) ? card.copy : undefined
  const previousBranch = previous?.branch
  const branch = previousBranch ?? await createTaskBranch({
    cwd: project.path,
    hydraName: branchTitanName({
      titanId,
      state,
    }),
    task: card.id,
    title: card.title,
    reserved: branches,
    start,
  })

  if (!branch) {
    throw new TitanError({
      code: 'COPY_FAILED',
      message: 'task branch allocation was cancelled',
    })
  }

  await clearDefaultUpstreams({
    cwd: project.path,
    branches,
  })
  const pooled = slots({
    project,
  })
  const previousPath = previous?.path
  const retainedEntry = previousPath ? lstatSync(
    previousPath,
    { throwIfNoEntry: false },
  ) : undefined
  const retainedPath = previousPath && retainedEntry?.isDirectory()
    ? realpathSync(previousPath)
    : undefined
  const candidates = retainedPath
    ? [
      retainedPath,
      ...pooled.filter(path => path !== retainedPath),
    ]
    : pooled
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
    throw new TitanError({
      message: `could not prune missing worktrees: ${pruned.err}`,
      code: 'COPY_FAILED',
    })
  }

  const exists = !previousBranch || await branchExists({
    cwd: project.path,
    branch,
  })
  // A deleted branch starts again from the current base, even when it keeps its old name.
  const copyBase = previousBranch && exists ? previous?.base : base

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
  for (const path of candidates) {
    if (!await take({
      titanId,
      card,
      path,
    })) {
      continue
    }

    let allocated = false

    try {
      const repository = await git({
        cwd: path,
        args: [
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-dir',
        ],
      })
      const [
        root,
        gitDirectory,
      ] = repository.out.split('\n')
      const ownRoot = canonical({ path: root }) === path
      const linked = canonical({ path: gitDirectory }) !== canonical({ path: common })

      if (!repository.ok || !ownRoot || !linked) {
        continue
      }

      const slotBranch = await landedSlotBranch({
        titanId,
        path,
        card,
        project,
        base,
        common,
      })

      if (slotBranch === undefined || !await reusable({
        path,
        common,
      })) {
        continue
      }

      if (slotBranch !== branch) {
        const checkedOut = await checkout({
          cwd: path,
          branch,
          start,
          exists,
        })

        if (!checkedOut.ok) {
          throw new TitanError({
            code: 'COPY_FAILED',
            message: `git could not switch the task's copy: ${checkedOut.err}`,
          })
        }
      }

      await verifyCopyBranch({
        path,
        branch,
      })
      allocated = true

      return made({ path })
    } finally {
      if (!allocated) {
        unclaim({ path })
      }
    }
  }

  const path = await freshSlot({
    titanId,
    task: card.id,
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
      throw new TitanError({
        message: `git could not make the task's copy: ${added.err}`,
        code: 'COPY_FAILED',
        help: ['Fix the project folder, or start with --in-place'],
      })
    }

    await verifyCopyBranch({
      path,
      branch,
    })
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
  titanId,
  card,
  project,
  command,
}: {
  titanId: string
  card: Card
  project: TitanProject
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
      OTHRYS_HOME: othrysHome(),
      OTHRYS_TITAN: titanId,
      OTHRYS_TASK: card.id,
      OTHRYS_TASK_TITLE: card.title,
      OTHRYS_PROJECT: project.path,
    },
  })
  const printed = run.stdout.trim().split('\n')
    .at(-1)
    ?.trim() ?? ''

  const path = run.status === 0 && isAbsolute(printed) && isFolder({ path: printed })
    ? realpathSync(printed) : undefined

  if (!path || path === project.path) {
    throw new TitanError({
      message: run.status !== 0 ? `the copy command of ${project.name} failed: ${run.stderr.trim().slice(-500)}` : `the copy command of ${project.name} must print the new folder's absolute path last, other than the project folder`,
      code: 'COPY_FAILED',
      help: ['Fix the project copy command in Settings.'],
    })
  }

  protectedCopiesFolder({
    titanId,
    root: path,
    preserveSurvivors: false,
  })

  return {
    path,
    project: project.path,
    via: 'command',
    state: 'active',
  }
}

export async function taskFolder({
  titanId,
  task,
  folder,
  inPlace,
  ownFolder,
  meta,
}: {
  titanId: string
  task: string
  folder?: string
  inPlace?: boolean
  ownFolder?: boolean
  meta: Meta
}): Promise<string | undefined> {
  const state = loadTitan({ titanId }).state

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
    throw new TitanError({
      message: 'use either --folder or --in-place',
      code: 'VALIDATION_ERROR',
    })
  }

  if (given) {
    if (projectsFor({ state }).some(p => !p.detached && matchesProject({
      project: p,
      ref: given,
    }))) {
      noteShared({
        titanId,
        path: given,
      })
    }

    return given
  }

  if (!project) {
    if (inPlace) {
      throw new TitanError({
        message: '--in-place needs a task with an attached project',
        code: 'VALIDATION_ERROR',
        help: [`Assign a project to ${card.id} in the UI.`],
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
      noteShared({
        titanId,
        path: project.path,
      })
    }

    return project.path
  }

  const live = liveCopy({ card })

  if (live) {
    const pool = copiesDir()

    if (live.via === 'worktree' && dirname(live.path) === pool) {
      requireUnlinkedCopyFolder({ path: pool })
    }

    requireUnlinkedCopyFolder({ path: live.path })
  }

  if (live && live.project !== project.path) {
    inform({
      task: card.id,
      reason: `Continuing in the existing copy of ${live.project} at ${live.path}`,
      clear: `After its work lands, remove the copy of ${card.id} in the UI to use the new project.`,
    })

    return live.path
  }

  const current = live && isFolder({ path: live.path }) ? live : undefined
  const ready = current
    ?? (project.copy ? await commandCopy({
      titanId,
      card,
      project,
      command: project.copy,
    }) : undefined)
  const copy = ready ?? await worktreeCopy({
    titanId,
    card,
    project,
  })

  try {
    return await withWriter({
      titanId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const now = findCard({
          state: writer.state,
          ref: card.id,
        })
        const selectedProject = taskProject({
          state: writer.state,
          card: now,
        })

        if (!sameProjectPath({
          left: selectedProject?.path,
          right: copy.project,
        })) {
          throw new TitanError({
            message: `the project of task ${card.id} changed while its copy was being prepared; start it again`,
            code: 'CONFLICT',
          })
        }

        // Another start may have won while this copy was prepared: it leaves its session and copy as they are.
        const startedMeanwhile = Boolean(now.sessionIds?.length)
        const copiedMeanwhile = now.copy?.state === 'active' && now.copy.path !== card.copy?.path
          && now.copy.path !== copy.path

        if (startedMeanwhile || copiedMeanwhile) {
          throw new TitanError({
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
    if (!ready && copy.via === 'worktree') {
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
