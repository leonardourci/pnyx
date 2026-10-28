import { matchesProject } from './identity.ts'
import { COPY_TIMEOUT_MS, git } from './git.ts'
import { landedWork } from '../tasks/delivery/proof.ts'

import { workerQueue } from '../queue/state.ts'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Decision, HydraState } from '../app/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { decidePush } from '../tasks/push.ts'
import { findCard } from '../tasks/push-rules.ts'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../store/errors.ts'
import type { HydraProject, TaskCopy } from './model.ts'
import type { Card } from '../tasks/model.ts'
import { liveTask } from '../tasks/select.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { projectsFor } from './read.ts'
import { canonical } from '../store/paths.ts'
import { hydraDir, hydraIds } from '../app/home-migration.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter, type Writer } from '../app/writer.ts'
import { pnyxHome } from '../store/storage.ts'

// A claim older than the git steps it guards was left by a start that crashed.
const CLAIM_STALE_MS = 2 * COPY_TIMEOUT_MS
export const POOL_IDLE = 2

export function isFolder({ path }: { path: string }): boolean {
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

function gitProject({ project }: { project: HydraProject }): void {
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
}

const liveCopy = ({ card }: { card: Card }) => (card.copy?.state === 'removed' ? undefined : card.copy)

const quiet = ({ meta }: { meta: Meta }): Meta => ({
  ...meta,
  id: undefined,
  ifRevision: undefined,
})

function branchStart({ project }: { project: HydraProject }): {
  base?: string
  start: string
} {
  const origin = git({
    cwd: project.path,
    args: [
      'remote',
      'get-url',
      'origin',
    ],
  })

  if (origin.ok) {
    for (const args of [
      [
        'fetch',
        '--quiet',
        'origin',
      ],
      [
        'remote',
        'set-head',
        'origin',
        '--auto',
      ],
    ]) {
      const result = git({
        cwd: project.path,
        args,
      })

      if (!result.ok) {
        throw new HydraError({
          message: `could not refresh the project's default branch: ${result.err}`,
          code: 'COPY_FAILED',
          help: ['Fix origin and try again; the existing copies were kept'],
        })
      }
    }

    const remote = originHead({ cwd: project.path })

    if (!remote) {
      throw new HydraError({
        message: 'origin has no default branch',
        code: 'COPY_FAILED',
      })
    }

    return {
      base: remote.replace(
        /^origin\//,
        '',
      ),
      start: remote,
    }
  }

  const local = git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  }).out
  const base = local
  const start = git({
    cwd: project.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  }).out

  return {
    ...(base && base !== 'HEAD' ? { base } : {}),
    start,
  }
}

const commonDir = ({ cwd }: { cwd: string }) =>
  git({
    cwd,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
  }).out

const branchExists = ({
  cwd,
  branch,
}: {
  cwd: string
  branch: string
}) =>
  git({
    cwd,
    args: [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ],
  }).ok

const onBranch = ({ cwd }: { cwd: string }) =>
  Boolean(git({
    cwd,
    args: [
      'for-each-ref',
      '--contains',
      'HEAD',
      '--count=1',
      'refs/heads',
    ],
  }).out)

const copiesDir = ({ hydraId }: { hydraId: string }) => join(
  hydraDir({ hydraId }),
  'copies',
)

// Slots are named <project>-<n>, so one can pass from task to task.
function slots({
  hydraId,
  project,
}: {
  hydraId: string
  project: HydraProject
}): string[] {
  const dir = copiesDir({ hydraId })
  const prefix = `${project.name}-`

  if (!isFolder({ path: dir })) {
    return []
  }

  return readdirSync(dir)
    .filter(name => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map(name => join(
      dir,
      name,
    ))
    .filter(path => isFolder({ path }))
    .map(path => realpathSync(path))
}

const runsIn = ({
  state,
  path,
}: {
  state: HydraState
  path: string
}) =>
  Object.values(state.cards).some(c => c.sessionIds?.length && c.agent?.cwd === path)

const holds = ({
  state,
  path,
  except,
}: {
  state: HydraState
  path: string
  except?: string
}) =>
  Object.values(state.cards).some(c => c.id !== except && liveCopy({ card: c })?.path === path)

const idle = ({
  state,
  path,
  except,
}: {
  state: HydraState
  path: string
  except?: string
}) =>
  !runsIn({
    state,
    path,
  }) && !holds({
    state,
    path,
    except,
  })

// A clean checkout of this project whose commit some branch keeps, so moving it to another branch loses nothing.
function reusable({
  path,
  common,
}: {
  path: string
  common: string
}): boolean {
  const status = git({
    cwd: path,
    args: [
      'status',
      '--porcelain',
    ],
  })

  return status.ok && status.out === '' && commonDir({ cwd: path }) === common && onBranch({ cwd: path })
}

const checkout = ({
  cwd,
  branch,
  start,
}: {
  cwd: string
  branch: string
  start: string
}) =>
  branchExists({
    cwd,
    branch,
  })
    ? git({
      cwd,
      args: [
        'checkout',
        '--quiet',
        branch,
      ],
    })
    : git({
      cwd,
      args: [
        'checkout',
        '--quiet',
        '-b',
        branch,
        start,
      ],
    })

function claimIsStale({ file }: { file: string }): boolean {
  try {
    const pid = Number(readFileSync(
      file,
      'utf8',
    ))

    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(file).mtimeMs > CLAIM_STALE_MS
    }

    process.kill(
      pid,
      0,
    )

    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') {
        return true
      }

      if (error.code === 'EPERM') {
        return false
      }
    }

    throw error
  }
}

// Claim creation and dead-owner recovery share the writer lock; Git work stays outside it.
function claim({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}): boolean {
  return withWriter({
    hydraId,
    fn: () => {
      let fd: number

      try {
        fd = openSync(
          `${path}.claim`,
          'wx',
        )
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw error
        }

        if (!claimIsStale({ file: `${path}.claim` })) {
          return false
        }

        rmSync(
          `${path}.claim`,
          { force: true },
        )
        fd = openSync(
          `${path}.claim`,
          'wx',
        )
      }

      try {
        writeFileSync(
          fd,
          String(process.pid),
        )
      } finally {
        closeSync(fd)
      }

      return true
    },
  })
}

const unclaim = ({ path }: { path: string }) => rmSync(
  `${path}.claim`,
  { force: true },
)

// Claiming first means the idle check sees every record a competing start wrote before letting go.
function take({
  hydraId,
  card,
  path,
}: {
  hydraId: string
  card?: Card
  path: string
}): boolean {
  if (!claim({
    hydraId,
    path,
  })) {
    return false
  }

  if (idle({
    state: loadHydra({ hydraId }).state,
    path,
    except: card?.id,
  })) {
    return true
  }

  unclaim({ path })

  return false
}

function freshSlot({
  hydraId,
  project,
}: {
  hydraId: string
  project: HydraProject
}): string {
  for (let n = 1; ; n++) {
    const path = join(
      copiesDir({ hydraId }),
      `${project.name}-${n}`,
    )

    if (!existsSync(path) && claim({
      hydraId,
      path,
    })) {
      return path
    }
  }
}

function releasedCopyLanded({
  hydraId,
  path,
}: {
  hydraId: string
  path: string
}): boolean {
  const state = loadHydra({ hydraId }).state
  const branch = git({
    cwd: path,
    args: [
      'branch',
      '--show-current',
    ],
  }).out
  const previous = Object.values(state.cards).find(card => card.copy?.path === path
    && card.copy.state === 'removed' && card.copy.branch === branch)

  if (!previous?.copy) {
    return false
  }

  const check = checkCopy({
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

      apply({
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
function worktreeCopy({
  hydraId,
  card,
  project,
}: {
  hydraId: string
  card: Card
  project: HydraProject
}): TaskCopy {
  gitProject({ project })
  mkdirSync(
    copiesDir({ hydraId }),
    { recursive: true },
  )
  const branch = `pnyx/${hydraId}-${card.id}`
  const {
    base,
    start,
  } = branchStart({ project })
  const made = ({ path }: { path: string }): TaskCopy => ({
    path,
    project: project.path,
    via: 'worktree',
    branch,
    ...(base ? { base } : {}),
    state: 'active',
  })
  const pooled = slots({
    hydraId,
    project,
  })
  const head = ({ path }: { path: string }) => git({
    cwd: path,
    args: [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ],
  }).out

  const common = commonDir({ cwd: project.path })

  // A copy made before its record was written, or this task's own slot still in the pool, is picked up again.
  const own = pooled.find(path => commonDir({ cwd: path }) === common
    && head({ path }) === branch && take({
    hydraId,
    card,
    path,
  }))

  if (own) {
    return made({ path: own })
  }

  // Only registrations whose folders are gone are pruned, so a deleted copy does not block its branch.
  git({
    cwd: project.path,
    args: [
      'worktree',
      'prune',
    ],
  })

  // Ignored files such as installed dependencies stay with the slot; the clean check leaves nothing else to reset.
  for (const path of pooled) {
    if (take({
      hydraId,
      card,
      path,
    })) {
      if (releasedCopyLanded({
        hydraId,
        path,
      }) && reusable({
        path,
        common,
      }) && checkout({
        cwd: path,
        branch,
        start,
      }).ok) {
        return made({ path })
      }

      unclaim({ path })
    }
  }

  const path = freshSlot({
    hydraId,
    project,
  })
  const exists = branchExists({
    cwd: project.path,
    branch,
  })
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
        start,
      ]),
    ],
  })

  if (!added.ok) {
    unclaim({ path })
    throw new HydraError({
      message: `git could not make the task's copy: ${added.err}`,
      code: 'COPY_FAILED',
      help: ['Fix the project folder, or start with --in-place'],
    })
  }

  return made({ path: realpathSync(path) })
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
    ?? (project.copy ? commandCopy({
      hydraId,
      card,
      project,
      command: project.copy,
    }) : undefined)
  const copy = ready ?? worktreeCopy({
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
        const id = meta.id && !(`${meta.id}:copy` in writer.state.eventIds) ? `${meta.id}:copy` : undefined
        const recorded = {
          ...meta,
          id,
          ifRevision: undefined,
        }

        if (now.copy?.path !== copy.path || now.copy.state !== 'active') {
          const change = {
            type: 'task.copy' as const,
            data: {
              before: now.copy ?? null,
              after: copy,
            },
          }
          apply({
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

function pushFolder({
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
    apply({
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

  const {
    landed,
    refs,
    reason,
  } = landedWork({
    card,
    copy,
    head: head.out,
  })
  const currentHead = git({
    cwd: copy.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })
  const currentStatus = git({
    cwd: copy.path,
    args: [
      'status',
      '--porcelain',
    ],
  })

  const changed = currentHead.out !== head.out || currentStatus.out !== status.out

  if (!currentHead.ok || !currentStatus.ok || changed) {
    return {
      clean: false,
      landed: false,
      reason: 'its work changed during the landing check; its copy was kept',
    }
  }

  const clean = status.out === ''

  if (clean && landed) {
    return {
      clean,
      landed,
    }
  }

  return {
    clean,
    landed,
    reason: !clean ? 'it has uncommitted changes'
      : reason ?? `its work has not landed on ${refs.join(' or ') || 'the default branch'}`,
  }
}

function removeCopy({
  copy,
  force,
}: {
  copy: TaskCopy
  force: boolean
}): string | undefined {
  const common = commonDir({ cwd: copy.path })
  const gitDir = git({
    cwd: copy.path,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    ],
  })

  if (!common || !gitDir.ok || gitDir.out === common) {
    return 'it is not a git worktree Pnyx can remove'
  }

  if (!force && !onBranch({ cwd: copy.path })) {
    return 'its commit is on no branch'
  }

  const run = spawnSync(
    'git',
    [
      `--git-dir=${common}`,
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

function staysInPool({
  hydraId,
  state,
  copy,
}: {
  hydraId: string
  state: HydraState
  copy: TaskCopy
}): boolean {
  const project = projectsFor({ state }).find(p => !p.detached && matchesProject({
    project: p,
    ref: copy.project,
  }))
  const path = realpathSync(copy.path)
  const common = project && commonDir({ cwd: project.path })
  const pooled = project ? slots({
    hydraId,
    project,
  }) : []

  if (!common || !pooled.includes(path) || !reusable({
    path,
    common,
  })) {
    return false
  }

  const spare = pooled.filter(slot => slot !== path && idle({
    state,
    path: slot,
  }) && reusable({
    path: slot,
    common,
  }))

  return runsIn({
    state,
    path,
  }) || spare.length < POOL_IDLE
}

function releaseReason({
  copy,
  pooled,
  why,
}: {
  copy: TaskCopy
  pooled: boolean
  why: string
}): string {
  if (copy.via === 'command') {
    return `${why}; the folder stays for the project's copy tool`
  }

  return pooled ? `${why}; its folder went back to the pool` : why
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
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
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

  if (mode === 'safe' && copy.via === 'worktree' && (!check.clean || !check.landed)) {
    throw new HydraError({
      message: `the copy of ${card.id} has uncommitted changes or unproved work, so it is not safe to remove`,
      code: 'CONFLICT',
      help: ['Land the current work first; discarding it needs the owner'],
    })
  }

  let after: TaskCopy
  let pooled = false

  if (check.gone) {
    after = {
      ...copy,
      state: 'removed',
      reason: 'its folder was already gone',
    }
  } else if (mode === 'discard' || mode === 'safe' || !('reason' in check)) {
    const why = mode === 'discard' ? 'discarded with the owner’s confirmation' : mode === 'safe' ? 'confirmed safe' : 'its work landed'
    pooled = mode !== 'discard' && copy.via === 'worktree' && staysInPool({
      hydraId,
      state,
      copy,
    })
    // The project's copy tool owns the folders it makes, so Pnyx only lets them go.
    const failed = copy.via === 'command' || pooled ? undefined : removeCopy({
      copy,
      force: mode === 'discard',
    })
    after = failed
      ? {
        ...copy,
        state: 'flagged',
        reason: failed,
      }
      : {
        ...copy,
        state: 'removed',
        reason: releaseReason({
          copy,
          pooled,
          why,
        }),
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

      // A hook session in a pooled slot must not find this task by its old folder.
      if (pooled && now.folder === copy.path) {
        pushFolder({
          writer,
          card: now,
          folder: null,
          meta: quiet({ meta }),
        })
      }

      if (after.state === 'flagged') {
        const text = `The copy of task ${now.id} "${now.title}" at ${copy.path} was kept: ${after.reason}. `
          + `Prove its current work landed, then run \`pnyx-axi task copy ${now.id} remove --hydra ${hydraId}\`. `
          + `Discarding work that never landed needs the owner: \`pnyx-axi task copy ${now.id} remove --discard --hydra ${hydraId}\`.`
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: quiet({ meta }),
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

function trimPool({ hydraId }: { hydraId: string }): void {
  const state = loadHydra({ hydraId }).state

  for (const project of projectsFor({ state }).filter(p => !p.detached)) {
    const pooled = slots({
      hydraId,
      project,
    })

    if (!pooled.length) {
      continue
    }

    let kept = 0
    const common = commonDir({ cwd: project.path })

    for (const path of slots({
      hydraId,
      project,
    })) {
      if (!take({
        hydraId,
        path,
      })) {
        continue
      }

      try {
        const current = loadHydra({ hydraId }).state
        const branch = git({
          cwd: path,
          args: [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
          ],
        }).out
        const owner = Object.values(current.cards).find(c => c.copy?.path === path
          && c.copy.state === 'removed' && c.copy.project === project.path && c.copy.branch === branch)

        if (!owner?.copy || !reusable({
          path,
          common,
        }) || 'reason' in checkCopy({
          card: owner,
          copy: owner.copy,
        })) {
          continue
        }

        if (kept++ < POOL_IDLE) {
          continue
        }

        removeCopy({
          copy: owner.copy,
          force: false,
        })
      } finally {
        unclaim({ path })
      }
    }
  }
}

// A task in Done whose agent is still working keeps its copy until the agent stops.
// An investigation keeps its copy, so the worker that becomes its build resumes in the same folder.
export const settles = ({ card }: { card: Card }) => Boolean(card.doneAt) && card.copy?.state === 'active'
  && card.activity !== 'working' && card.kind !== 'investigation'

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

  const due = Object.values(state.cards).filter(card => settles({ card })
    && !workerQueue({
      state,
      session: card.sessionIds?.[0] ?? '',
    }).length)

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

  trimPool({ hydraId })

  return due.length
}
