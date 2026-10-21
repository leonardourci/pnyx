import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { decidePush, findCard, type Decision, type Meta } from '../core/decide.ts'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { HydraError, type Card, type HydraProject, type HydraState, type TaskCopy } from '../core/model.ts'
import { liveTask } from '../core/tasks.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { projectsFor } from '../projects/read.ts'
import { canonical } from '../store/paths.ts'
import { hydraDir, hydraIds, loadHydra, pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'

const COPY_TIMEOUT_MS = 120_000

function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
}): {
  ok: boolean
  out: string
  err: string
} {
  const run = spawnSync(
    'git',
    [
      '-C',
      cwd,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: COPY_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  )

  return {
    ok: run.status === 0,
    out: (run.stdout ?? '').trim(),
    err: (run.stderr ?? '').trim().slice(-500),
  }
}

function isFolder({ path }: { path: string }): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function apply({
  writer,
  decision,
}: {
  writer: Writer
  decision: Decision
}): void {
  if ('event' in decision) {
    writer.append({ event: decision.event })
  }
}

function taskProject({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): HydraProject | undefined {
  return projectsFor({ state }).find(p => !p.detached && p.path === card.project)
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

function originHead({ cwd }: { cwd: string }): string | undefined {
  const head = git({
    cwd,
    args: [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ],
  })

  return head.ok && head.out ? head.out : undefined
}

function worktreeCopy({
  hydraId,
  card,
  project,
}: {
  hydraId: string
  card: Card
  project: HydraProject
}): TaskCopy {
  if (!git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  }).ok) {
    throw new HydraError({
      message: `project ${project.name} is not a git repository`,
      code: 'VALIDATION_ERROR',
      help: ['Set its copy command with `pnyx-axi project set <name> --copy <shell command>`, or start with --in-place'],
    })
  }

  const branch = `pnyx/${hydraId}-${card.id}`
  const remote = originHead({ cwd: project.path })
  const base = remote?.replace(
    /^origin\//,
    '',
  ) ?? git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  }).out
  const path = join(
    hydraDir({ hydraId }),
    'copies',
    `${card.id}-${project.name}`,
  )
  const made = {
    path,
    project: project.path,
    via: 'worktree' as const,
    branch,
    ...(base && base !== 'HEAD' ? { base } : {}),
    state: 'active' as const,
  }

  // A copy made before its record was written is picked up again.
  if (isFolder({ path }) && git({
    cwd: path,
    args: [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ],
  }).out === branch) {
    return {
      ...made,
      path: realpathSync(path),
    }
  }

  // Only registrations whose folders are gone are pruned, so a deleted copy does not block its branch.
  git({
    cwd: project.path,
    args: [
      'worktree',
      'prune',
    ],
  })
  const exists = git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ],
  }).ok
  mkdirSync(
    dirname(path),
    { recursive: true },
  )
  const added = git({
    cwd: project.path,
    args: [
      'worktree',
      'add',
      ...(exists ? [
        path,
        branch,
      ] : [
        '-b',
        branch,
        path,
        remote ?? 'HEAD',
      ]),
    ],
  })

  if (!added.ok) {
    throw new HydraError({
      message: `git could not make the task's copy: ${added.err}`,
      code: 'COPY_FAILED',
      help: ['Fix the project folder, or start with --in-place'],
    })
  }

  return {
    ...made,
    path: realpathSync(path),
  }
}

function commandCopy({
  hydraId,
  card,
  project,
  command,
}: {
  hydraId: string
  card: Card
  project: HydraProject
  command: string
}): TaskCopy {
  const run = spawnSync(
    '/bin/sh',
    [
      '-c',
      command,
    ],
    {
      cwd: project.path,
      encoding: 'utf8',
      timeout: COPY_TIMEOUT_MS,
      env: {
        ...process.env,
        PNYX_HOME: pnyxHome(),
        PNYX_HYDRA: hydraId,
        PNYX_TASK: card.id,
        PNYX_TASK_TITLE: card.title,
        PNYX_PROJECT: project.path,
      },
    },
  )
  const printed = (run.stdout ?? '').trim().split('\n')
    .at(-1)
    ?.trim() ?? ''

  const usable = isAbsolute(printed) && isFolder({ path: printed })
    && realpathSync(printed) !== project.path

  if (run.status !== 0 || !usable) {
    throw new HydraError({
      message: run.status !== 0 ? `the copy command of ${project.name} failed: ${(run.stderr ?? '').trim().slice(-500)}` : `the copy command of ${project.name} must print the new folder's absolute path last, other than the project folder`,
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
export function taskFolder({
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
}): string | undefined {
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
    if (projectsFor({ state }).some(p => !p.detached && p.path === given)) {
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

  if (card.copy && card.copy.state !== 'removed' && card.copy.project !== project.path) {
    throw new HydraError({
      message: `task ${card.id} still has a copy of ${card.copy.project} at ${card.copy.path}`,
      code: 'CONFLICT',
      help: [`Settle it first with \`pnyx-axi task copy ${card.id} remove --hydra ${hydraId}\``],
    })
  }

  const current = card.copy && card.copy.state !== 'removed' && isFolder({ path: card.copy.path }) ? card.copy : undefined
  const copy = current ?? (project.copy
    ? commandCopy({
      hydraId,
      card,
      project,
      command: project.copy,
    })
    : worktreeCopy({
      hydraId,
      card,
      project,
    }))

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const now = findCard({
        state: writer.state,
        ref: card.id,
      })
      const id = meta.id && !(`${meta.id}:copy` in writer.state.eventIds) ? `${meta.id}:copy` : undefined

      if (now.copy?.path !== copy.path) {
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id,
              ifRevision: undefined,
            },
            cardId: now.id,
            change: {
              type: 'task.copy',
              data: {
                before: now.copy ?? null,
                after: copy,
              },
            },
          }),
        })
      }

      if (now.folder !== copy.path) {
        apply({
          writer,
          decision: decidePush({
            state: writer.state,
            key: now.key,
            input: { folder: copy.path },
            meta: {
              ...meta,
              id: id && `${id}:folder`,
              ifRevision: undefined,
            },
          }),
        })
      }

      return copy.path
    },
  })
}

export type CopyCheck = {
  gone?: boolean
  clean: true
  landed: true
}
  | {
    gone?: undefined
    clean: boolean
    landed: boolean
    reason: string
  }

// Landed: on the default branch, or its linked pull request merged.
export function checkCopy({
  card,
  copy,
}: {
  card: Card
  copy: TaskCopy
}): CopyCheck {
  if (!isFolder({ path: copy.path })) {
    return {
      gone: true,
      clean: true,
      landed: true,
    }
  }

  const status = git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })
  const head = git({
    cwd: copy.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })

  if (!status.ok || !head.ok) {
    return {
      clean: false,
      landed: false,
      reason: 'it is not a git checkout Pnyx can read',
    }
  }

  const remote = originHead({ cwd: copy.path })
  const refs = [
    ...new Set([
      remote,
      remote?.replace(
        /^origin\//,
        '',
      ),
      copy.base,
    ].filter((r): r is string => Boolean(r))),
  ]
  const merged = refs.some(ref => git({
    cwd: copy.path,
    args: [
      'merge-base',
      '--is-ancestor',
      head.out,
      ref,
    ],
  }).ok)
  const pr = card.links.some(l => l.kind === 'github_pr' && l.state === 'merged')
  const clean = status.out === ''
  const landed = merged || pr

  if (clean && landed) {
    return {
      clean,
      landed,
    }
  }

  return {
    clean,
    landed,
    reason: !clean ? 'it has uncommitted changes' : `its work has not landed on ${refs.join(' or ') || 'the default branch'}`,
  }
}

function removeCopy({
  copy,
  force,
}: {
  copy: TaskCopy
  force: boolean
}): string | undefined {
  const common = git({
    cwd: copy.path,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
  })
  const own = git({
    cwd: copy.path,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    ],
  })

  if (!common.ok || !own.ok || own.out === common.out) {
    return 'it is not a git worktree Pnyx can remove'
  }

  if (!force && !git({
    cwd: copy.path,
    args: [
      'for-each-ref',
      '--contains',
      'HEAD',
      '--count=1',
      'refs/heads',
    ],
  }).out) {
    return 'its commit is on no branch'
  }

  const run = spawnSync(
    'git',
    [
      `--git-dir=${common.out}`,
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      copy.path,
    ],
    {
      encoding: 'utf8',
      timeout: COPY_TIMEOUT_MS,
    },
  )

  return run.status === 0 ? undefined : `git could not remove it: ${(run.stderr ?? '').trim().slice(-300)}`
}

export type Settle = 'check' | 'safe' | 'discard'

// Only the owner discards work that never landed; anything else unsafe is flagged for Hydra.
export function settleCopy({
  hydraId,
  ref,
  mode = 'check',
  meta,
}: {
  hydraId: string
  ref: string
  mode?: Settle
  meta: Meta
}): {
  copy: TaskCopy | null
  check?: CopyCheck
} {
  const card = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })
  const copy = card.copy

  if (!copy || copy.state === 'removed') {
    return { copy: copy ?? null }
  }

  const check = checkCopy({
    card,
    copy,
  })

  if (mode === 'safe' && !check.clean && copy.via === 'worktree') {
    throw new HydraError({
      message: `the copy of ${card.id} has uncommitted changes, so it is not safe to remove`,
      code: 'CONFLICT',
      help: ['Land or commit them first; discarding them needs the owner'],
    })
  }

  let after: TaskCopy

  if (check.gone) {
    after = {
      ...copy,
      state: 'removed',
      reason: 'its folder was already gone',
    }
  } else if (mode === 'discard' || mode === 'safe' || !('reason' in check)) {
    const why = mode === 'discard' ? 'discarded with the owner’s confirmation' : mode === 'safe' ? 'confirmed safe' : 'its work landed'
    // The project's copy tool owns the folders it makes, so Pnyx only lets them go.
    const failed = copy.via === 'command' ? undefined : removeCopy({
      copy,
      force: mode === 'discard',
    })
    after = failed ? {
      ...copy,
      state: 'flagged',
      reason: failed,
    }
      : {
        ...copy,
        state: 'removed',
        reason: copy.via === 'command' ? `${why}; the folder stays for the project's copy tool` : why,
      }
  } else {
    after = {
      ...copy,
      state: 'flagged',
      reason: check.reason,
    }
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const now = findCard({
        state: writer.state,
        ref: card.id,
      })

      if (now.copy?.path !== copy.path || now.copy.state === 'removed'
        || (now.copy.state === after.state && now.copy.reason === after.reason)) {
        return {
          copy: now.copy ?? null,
          check,
        }
      }

      apply({
        writer,
        decision: hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            ifRevision: undefined,
          },
          cardId: now.id,
          change: {
            type: 'task.copy',
            data: {
              before: now.copy,
              after,
            },
          },
        }),
      })

      if (after.state === 'flagged') {
        const text = `The copy of task ${now.id} "${now.title}" at ${copy.path} was kept: ${after.reason}. `
          + `Land its work, then run \`pnyx-axi task copy ${now.id} remove --hydra ${hydraId}\`; if it is already merged or empty, confirm with \`--safe\`. `
          + `Discarding work that never landed needs the owner: \`pnyx-axi task copy ${now.id} remove --discard --hydra ${hydraId}\`.`
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id: undefined,
              ifRevision: undefined,
            },
            cardId: now.id,
            change: {
              type: 'hydra.message',
              data: {
                task: now.id,
                action: 'send',
                text,
                hydra: hydraConfig({
                  state: writer.state,
                  id: hydraId,
                }).hydra.id,
              },
            },
          }),
        })
      }

      return {
        copy: after,
        check,
      }
    },
  })
}

// A task in Done whose agent is still working keeps its copy until the agent stops.
export const settles = ({ card }: { card: Card }) => Boolean(card.doneAt) && card.copy?.state === 'active' && card.activity !== 'working'

export function settleDone({
  hydraId,
  at = new Date().toISOString(),
}: {
  hydraId: string
  at?: string
}): number {
  const state = loadHydra({ hydraId }).state

  if (state.config?.hydra.kind === 'firstmate') {
    return 0
  }

  const due = Object.values(state.cards).filter(card => settles({ card }))

  for (const card of due) {
    settleCopy({
      hydraId,
      ref: card.id,
      meta: {
        actor: 'pnyx',
        at,
      },
    })
  }

  return due.length
}
