import { runProcess } from '#app/run-process.ts'

export const COPY_TIMEOUT_MS = 120_000

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
