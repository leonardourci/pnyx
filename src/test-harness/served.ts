// A Pnyx server inside a unit test's own process, for tests that run the built pnyx-axi: the CLI forwards
// every command to the server of its PNYX_HOME. The server answers from this process, so run the CLI
// with `pnyxAxi`, never a sync exec, which would block the server it waits on.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { startServer } from '#app/server-daemon.ts'

export const BIN = join(
  import.meta.dirname,
  '..',
  '..',
  'dist',
  'cli',
  'pnyx-axi.js',
)
// No wake, stall or busy timer fires during a unit test.
const QUIET_MS = 3_600_000

// Starts the server for process.env.PNYX_HOME and closes it when the test ends. Without `t` the caller
// closes it, which must happen before the home is removed: a closing server saves its Hydras there.
export async function serve({ t }: { t?: TestContext } = {}) {
  const server = await startServer({
    wakeDelay: QUIET_MS,
    stallDelay: QUIET_MS,
    busyDelay: QUIET_MS,
  })
  t?.after(() => server.close())

  return server
}

// Runs the built pnyx-axi, or another executable with `command`, and resolves with its exit status and output.
export function pnyxAxi({
  args,
  env = process.env,
  input,
  cwd,
  command = process.execPath,
}: {
  args: string[]
  env?: NodeJS.ProcessEnv
  input?: string
  cwd?: string
  command?: string
}): Promise<{
  status: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(
    command,
    command === process.execPath ? [
      BIN,
      ...args,
    ] : args,
    {
      env,
      cwd,
    },
  )
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on(
    'data',
    (chunk: string) => {
      stdout += chunk
    },
  )
  child.stderr.setEncoding('utf8').on(
    'data',
    (chunk: string) => {
      stderr += chunk
    },
  )
  child.stdin.end(input ?? '')

  return new Promise((
    resolve,
    reject,
  ) => {
    child.once(
      'error',
      reject,
    )
    child.once(
      'close',
      status => resolve({
        status,
        stdout,
        stderr,
      }),
    )
  })
}
