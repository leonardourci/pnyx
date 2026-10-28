import { spawnSync } from 'node:child_process'

export const COPY_TIMEOUT_MS = 120_000

export function git({
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
