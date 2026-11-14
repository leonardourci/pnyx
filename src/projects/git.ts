import { runProcess } from '#app/run-process.ts'
import { log } from '#app/diagnostics.ts'
import { HydraError } from '#store/errors.ts'
import type { HydraProject } from './model.ts'

export const COPY_TIMEOUT_MS = 120_000

export const taskBranch = ({
  hydraId,
  task,
}: {
  hydraId: string
  task: string
}) => `pnyx/${hydraId}-${task}`

export async function git({
  cwd,
  args,
}: {
  cwd: string
  args: string[]
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
    timeout: COPY_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    },
  })

  return {
    ok: run.status === 0,
    out: run.stdout.trim(),
    err: run.stderr.trim().slice(-500),
  }
}

async function originHead({ cwd }: { cwd: string }): Promise<string | undefined> {
  const head = await git({
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

export async function gitProject({ project }: { project: HydraProject }): Promise<void> {
  if (!(await git({
    cwd: project.path,
    args: [
      'rev-parse',
      '--show-toplevel',
    ],
  })).ok) {
    throw new HydraError({
      message: `project ${project.name} is not a git repository`,
      code: 'VALIDATION_ERROR',
      help: ['Set its copy command with `pnyx-axi project set <name> --copy <shell command>`, or start with --in-place'],
    })
  }
}

export async function branchStart({ project }: { project: HydraProject }): Promise<{
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
        throw new HydraError({
          message: `could not refresh the project's default branch: ${result.err}`,
          code: 'COPY_FAILED',
          help: ['Fix origin and try again; the existing copies were kept'],
        })
      }
    }

    const remote = await originHead({ cwd: project.path })

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
export async function clearDefaultUpstreams({ cwd }: { cwd: string }): Promise<void> {
  const head = await git({
    cwd,
    args: [
      'symbolic-ref',
      '--quiet',
      'refs/remotes/origin/HEAD',
    ],
  })
  const prefix = 'refs/remotes/origin/'

  if (!head.ok || !head.out.startsWith(prefix)) {
    return
  }

  const defaultMerge = `refs/heads/${head.out.slice(prefix.length)}`
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
    const match = /^branch\.(pnyx\/.+)\.(remote|merge) (.*)$/.exec(line)

    if (match) {
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
