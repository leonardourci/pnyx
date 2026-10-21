import { workerQueue } from '../queue/state.ts'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { decidePush, findCard, type Decision, type Meta } from '../core/decide.ts'
import { hydraConfig, hydraEvent } from '../core/hydra.ts'
import { HydraError, type Card, type HydraProject, type HydraState, type TaskCopy } from '../core/model.ts'
import { liveTask } from '../core/tasks.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { projectsFor } from '../projects/read.ts'
import { canonical } from '../store/paths.ts'
import { hydraDir, hydraIds, loadHydra, pnyxHome, withWriter, type Writer } from '../store/hydra-store.ts'

const COPY_TIMEOUT_MS = 120_000
// A claim older than the git steps it guards was left by a start that crashed.
const CLAIM_STALE_MS = 2 * COPY_TIMEOUT_MS
// ponytail: a fixed cap per project and Hydra; make it a project setting if one size stops fitting.
export const POOL_IDLE = 2

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
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
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

const taskBranch = ({
  hydraId,
  card,
}: {
  hydraId: string
  card: Card
}) => `pnyx/${hydraId}-${card.id}`

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
  const remote = originHead({ cwd: project.path })
  const local = git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  }).out
  const base = remote?.replace(
    /^origin\//,
    '',
  ) ?? local
  const start = remote ?? git({
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

// Best effort: a failed fetch still starts the branch from the last fetched base.
function fetchBase({ project }: { project: HydraProject }): void {
  const remote = originHead({ cwd: project.path })

  if (remote) {
    git({
      cwd: project.path,
      args: [
        'fetch',
        '--quiet',
        'origin',
        remote.replace(
          /^origin\//,
          '',
        ),
      ],
    })
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

// An O_EXCL file keeps two starts off one slot while git runs outside the writer lock.
function claim({ path }: { path: string }): boolean {
  const file = `${path}.claim`

  if (existsSync(file) && Date.now() - statSync(file).mtimeMs > CLAIM_STALE_MS) {
    rmSync(
      file,
      { force: true },
    )
  }

  try {
    closeSync(openSync(
      file,
      'wx',
    ))

    return true
  } catch {
    return false // Another start holds the slot.
  }
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
  card: Card
  path: string
}): boolean {
  if (!claim({ path })) {
    return false
  }

  if (idle({
    state: loadHydra({ hydraId }).state,
    path,
    except: card.id,
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

    if (!existsSync(path) && claim({ path })) {
      return path
    }
  }
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
  fetchBase({ project })
  mkdirSync(
    copiesDir({ hydraId }),
    { recursive: true },
  )
  const branch = taskBranch({
    hydraId,
    card,
  })
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

  // A copy made before its record was written, or this task's own slot still in the pool, is picked up again.
  const own = pooled.find(path => head({ path }) === branch && take({
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
  const common = commonDir({ cwd: project.path })

  // Ignored files such as installed dependencies stay with the slot; the clean check leaves nothing else to reset.
  for (const path of pooled) {
    if (take({
      hydraId,
      card,
      path,
    })) {
      if (reusable({
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

        if (now.copy?.path !== copy.path) {
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
  const project = projectsFor({ state }).find(p => !p.detached && p.path === copy.project)
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

  if (mode === 'safe' && !check.clean && copy.via === 'worktree') {
    throw new HydraError({
      message: `the copy of ${card.id} has uncommitted changes, so it is not safe to remove`,
      code: 'CONFLICT',
      help: ['Land or commit them first; discarding them needs the owner'],
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
          + `Land its work, then run \`pnyx-axi task copy ${now.id} remove --hydra ${hydraId}\`; if it is already merged or empty, confirm with \`--safe\`. `
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

  return due.length
}

function movable({
  old,
  copy,
  project,
}: {
  old: Card
  copy: TaskCopy
  project: HydraProject
}): boolean {
  if (copy.state === 'removed') {
    return reusable({
      path: copy.path,
      common: commonDir({ cwd: project.path }),
    })
  }

  return !('reason' in checkCopy({
    card: old,
    copy,
  }))
}

export function moveCopy({
  hydraId,
  from,
  to,
  meta,
}: {
  hydraId: string
  from: string
  to: string
  meta: Meta
}): TaskCopy | undefined {
  const state = loadHydra({ hydraId }).state
  const card = findCard({
    state,
    ref: to,
  })
  const cwd = card.agent?.cwd
  const prior = state.cards[from]
  // The worker may have passed through tasks without a copy since the one that holds its folder.
  const holder = Object.values(state.cards)
    .find(c => c.id !== card.id && liveCopy({ card: c })?.path === cwd)
  const old = holder ?? (prior?.copy?.path === cwd ? prior : undefined)
  const copy = old?.copy
  const project = taskProject({
    state,
    card,
  })
  const fits = old && copy?.via === 'worktree' && project?.path === copy.project
    && card.agent?.cwd === copy.path && !liveCopy({ card }) && isFolder({ path: copy.path })
    && !holds({
      state,
      path: copy.path,
      except: old.id,
    })

  if (!fits || !movable({
    old,
    copy,
    project,
  }) || !claim({ path: copy.path })) {
    return undefined
  }

  try {
    fetchBase({ project })
    const {
      base,
      start,
    } = branchStart({ project })
    const branch = taskBranch({
      hydraId,
      card,
    })

    if (!checkout({
      cwd: copy.path,
      branch,
      start,
    }).ok) {
      return undefined
    }

    const after: TaskCopy = {
      path: copy.path,
      project: copy.project,
      via: 'worktree',
      branch,
      ...(base ? { base } : {}),
      state: 'active',
    }

    return withWriter({
      hydraId,
      fn: ({ writer }) => {
        drainSpool({ writer })
        const now = findCard({
          state: writer.state,
          ref: card.id,
        })
        const was = writer.state.cards[old.id]
        const left = was && liveCopy({ card: was })

        if (!was || liveCopy({ card: now })) {
          return undefined
        }

        if (left?.path === copy.path) {
          const removed = {
            ...left,
            state: 'removed' as const,
            reason: `its worker took it to task ${now.id}`,
          }
          const change = {
            type: 'task.copy' as const,
            data: {
              before: left,
              after: removed,
            },
          }
          apply({
            writer,
            decision: hydraEvent({
              state: writer.state,
              meta: quiet({ meta }),
              cardId: was.id,
              change,
            }),
          })
        }

        if (was.folder === copy.path) {
          pushFolder({
            writer,
            card: was,
            folder: null,
            meta: quiet({ meta }),
          })
        }

        const change = {
          type: 'task.copy' as const,
          data: {
            before: now.copy ?? null,
            after,
          },
        }
        apply({
          writer,
          decision: hydraEvent({
            state: writer.state,
            meta: quiet({ meta }),
            cardId: now.id,
            change,
          }),
        })
        pushFolder({
          writer,
          card: findCard({
            state: writer.state,
            ref: now.id,
          }),
          folder: copy.path,
          meta: quiet({ meta }),
        })

        return after
      },
    })
  } finally {
    unclaim({ path: copy.path })
  }
}
