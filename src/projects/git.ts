import { runProcess } from '#app/run-process.ts'
import { log } from '#app/diagnostics.ts'
import { TitanError } from '#store/errors.ts'
import type { TitanProject } from './model.ts'

export const COPY_TIMEOUT_MS = 120_000

// Git's stderr ends up in refusals and queue notes, so only its last part is kept; hook output can be long.
const GIT_ERROR_LENGTH = 4000
const BRANCH_SLUG_LENGTH = 40
const BRANCH_CREATE_ATTEMPTS = 100
const ORIGIN_REFS = 'refs/remotes/origin/'
const FILLER_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'and',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
])

function branchSlug({ text }: { text: string }): string {
  const normalized = text.normalize('NFKD')
  const unaccented = normalized.replace(
    /\p{Mark}/gu,
    '',
  )
  const words = unaccented.toLowerCase().match(/[a-z0-9]+/g) ?? []
  let slug = ''

  for (const word of words) {
    if (FILLER_WORDS.has(word)) {
      continue
    }

    if (!slug) {
      slug = word.slice(
        0,
        BRANCH_SLUG_LENGTH,
      )
      continue
    }

    const candidate = `${slug}-${word}`

    if (candidate.length > BRANCH_SLUG_LENGTH) {
      break
    }

    slug = candidate
  }

  return slug
}

async function taskBranch({
  cwd,
  hydraName,
  task,
  title,
  reserved = [],
}: {
  cwd: string
  hydraName: string
  task: string
  title: string
  reserved?: string[]
}): Promise<string> {
  // Remote-tracking refs can block a later fetch, including origin/HEAD on macOS.
  const refs = await git({
    cwd,
    args: [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
      'refs/remotes',
    ],
  })

  if (!refs.ok) {
    throw new TitanError({
      code: 'COPY_FAILED',
      message: `could not read branches: ${refs.err}`,
    })
  }

  // A ref that differs only in case can still block creation on a case-insensitive filesystem.
  const existing = new Set(reserved.map(branch => branch.toLowerCase()))

  for (const ref of refs.out.split('\n').filter(Boolean)) {
    const branch = ref.replace(
      /^refs\/(heads|remotes\/[^/]+)\//,
      '',
    )
    existing.add(branch.toLowerCase())
  }

  const remotes = await git({
    cwd,
    args: ['remote'],
  })

  if (!remotes.ok) {
    throw new TitanError({
      code: 'COPY_FAILED',
      message: `could not read remotes: ${remotes.err}`,
    })
  }

  const remoteNames = remotes.out.split('\n').filter(Boolean)

  for (const remote of remoteNames) {
    const heads = await git({
      cwd,
      args: [
        'ls-remote',
        '--heads',
        '--',
        remote,
      ],
    })

    if (!heads.ok) {
      throw new TitanError({
        code: 'COPY_FAILED',
        message: `could not read branches on remote ${remote}: ${heads.err}`,
      })
    }

    for (const line of heads.out.split('\n').filter(Boolean)) {
      const prefix = '\trefs/heads/'
      const separator = line.indexOf(prefix)

      if (separator >= 0) {
        existing.add(line.slice(separator + prefix.length).toLowerCase())
      }
    }
  }

  const shortId = task.replace(
    /^task-/,
    '',
  ).split('-')[0]
  const hydraSlug = branchSlug({ text: hydraName }) || 'hydra'
  const titleSlug = branchSlug({ text: title }) || shortId
  let namespace = hydraSlug

  for (let suffix = 2; existing.has(namespace); suffix++) {
    namespace = `${hydraSlug}-${suffix}`
  }

  const base = `${namespace}/${titleSlug}`
  const occupied = new Set<string>()

  for (const name of existing) {
    const parts = name.split('/')
    const firstTwoParts = parts.slice(
      0,
      2,
    )
    occupied.add(firstTwoParts.join('/'))
  }

  let branch = base

  for (let suffix = 2; occupied.has(branch); suffix++) {
    branch = `${base}-${suffix}`
  }

  return branch
}

// Failed copy allocations keep their refs reserved, so retries never delete or reuse those names.
export async function createTaskBranch({
  start,
  active = () => true,
  prepare,
  ...naming
}: Parameters<typeof taskBranch>[0] & {
  start: string
  active?(): boolean
  prepare?({ branch }: { branch: string }): Promise<boolean>
}): Promise<string | undefined> {
  if (!active()) {
    return undefined
  }

  let branch = await taskBranch(naming)

  for (let attempt = 0; attempt < BRANCH_CREATE_ATTEMPTS; attempt++) {
    if (!active()) {
      return undefined
    }

    if (prepare && !await prepare({ branch })) {
      return undefined
    }

    if (!active()) {
      return undefined
    }

    const created = await git({
      cwd: naming.cwd,
      args: [
        'branch',
        '--no-track',
        branch,
        start,
      ],
    })

    if (created.ok) {
      return branch
    }

    if (!active()) {
      return undefined
    }

    if (attempt + 1 === BRANCH_CREATE_ATTEMPTS) {
      break
    }

    const nextBranch = await taskBranch(naming)

    if (nextBranch === branch) {
      throw new TitanError({
        code: 'COPY_FAILED',
        message: `could not create task branch: ${created.err}`,
      })
    }

    branch = nextBranch
  }

  throw new TitanError({
    code: 'COPY_FAILED',
    message: 'task branch allocation kept colliding; try again',
  })
}

export async function git({
  cwd,
  args,
  timeout = COPY_TIMEOUT_MS,
}: {
  cwd: string
  args: string[]
  timeout?: number
}): Promise<{
  ok: boolean
  out: string
  err: string
}> {
  const run = await runProcess({
    command: 'git',
    args: [
      '-C',
      cwd,
      ...args,
    ],
    timeout,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    },
  })

  return {
    ok: run.status === 0,
    out: run.stdout.trim(),
    err: run.stderr.trim().slice(-GIT_ERROR_LENGTH),
  }
}

async function originHead({ cwd }: { cwd: string }): Promise<string | undefined> {
  const head = await git({
    cwd,
    args: [
      'symbolic-ref',
      '--quiet',
      'refs/remotes/origin/HEAD',
    ],
  })

  return head.ok && head.out.startsWith(ORIGIN_REFS) ? head.out : undefined
}

export async function gitProject({ project }: { project: TitanProject }): Promise<void> {
  if (!(await git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  })).ok) {
    throw new TitanError({
      message: `project ${project.name} is not a git repository`,
      code: 'VALIDATION_ERROR',
      help: ['Set a copy command for the project in Settings.'],
    })
  }
}

export async function branchStart({ project }: { project: TitanProject }): Promise<{
  base?: string
  start: string
}> {
  const origin = await git({
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
      const result = await git({
        cwd: project.path,
        args,
      })

      if (!result.ok) {
        throw new TitanError({
          message: `could not refresh the project's default branch: ${result.err}`,
          code: 'COPY_FAILED',
          help: ['Fix origin and try again; the existing copies were kept'],
        })
      }
    }

    const remote = await originHead({ cwd: project.path })

    if (!remote) {
      throw new TitanError({
        message: 'origin has no default branch',
        code: 'COPY_FAILED',
      })
    }

    return {
      base: remote.slice(ORIGIN_REFS.length),
      start: remote,
    }
  }

  const local = (await git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ],
  })).out
  const base = local
  const start = (await git({
    cwd: project.path,
    args: [
      'rev-parse',
      'HEAD',
    ],
  })).out

  return {
    ...(base && base !== 'HEAD' ? { base } : {}),
    start,
  }
}

export const commonDir = async ({ cwd }: { cwd: string }) =>
  (await git({
    cwd,
    args: [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ],
  })).out

export const branchExists = async ({
  cwd,
  branch,
}: {
  cwd: string
  branch: string
}) =>
  (await git({
    cwd,
    args: [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ],
  })).ok

export const onBranch = async ({ cwd }: { cwd: string }) =>
  Boolean((await git({
    cwd,
    args: [
      'for-each-ref',
      '--contains',
      'HEAD',
      '--count=1',
      'refs/heads',
    ],
  })).out)

// Best effort, so another task's branch config never stops a start: older task branches still track the default branch.
export async function clearDefaultUpstreams({
  cwd,
  branches = [],
}: {
  cwd: string
  branches?: string[]
}): Promise<void> {
  const head = await originHead({ cwd })

  if (!head) {
    return
  }

  const defaultMerge = `refs/heads/${head.slice(ORIGIN_REFS.length)}`
  const config = await git({
    cwd,
    args: [
      'config',
      '--get-regexp',
      '^branch\\..*\\.(remote|merge)$',
    ],
  })

  if (!config.ok) {
    return
  }

  const tracked = new Map<string, {
    remote?: string
    merge?: string
  }>()

  for (const line of config.out.split('\n')) {
    const match = /^branch\.(.+)\.(remote|merge) (.*)$/.exec(line)

    if (match && (/^othrys\//.test(match[1]) || branches.includes(match[1]))) {
      const [
        ,
        branch,
        key,
        value,
      ] = match
      tracked.set(
        branch,
        {
          ...tracked.get(branch),
          [key]: value,
        },
      )
    }
  }

  for (const [
    branch,
    upstream,
  ] of tracked) {
    if (upstream.remote !== 'origin' || upstream.merge !== defaultMerge) {
      continue
    }

    const cleared = await git({
      cwd,
      args: [
        'branch',
        '--unset-upstream',
        branch,
      ],
    })

    if (!cleared.ok && !cleared.err.includes('has no upstream information')) {
      log({
        level: 'warn',
        operation: 'project.clear-upstream',
        error: new Error(`could not clear the upstream of ${branch}: ${cleared.err}`),
      })
    }
  }
}
