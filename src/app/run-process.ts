import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { log } from './diagnostics.ts'

const execFileAsync = promisify(execFile)
// Flags whose next argument is a value, so `git -C <folder> fetch` is named after fetch.
const VALUE_FLAGS = new Set([
  '-C',
  '-c',
])
const SUBCOMMAND = /^[a-z][a-z-]*$/

// The tool and its first subcommand for the log line, never a path or value.
// ponytail: skips only -C and -c values; a value after another flag can be taken for the subcommand.
function runName({
  command,
  args,
}: {
  command: string
  args: string[]
}): string {
  const tool = basename(command)
  let takesValue = false

  for (const arg of args) {
    if (takesValue || arg.startsWith('-')) {
      takesValue = VALUE_FLAGS.has(arg)

      continue
    }

    return SUBCOMMAND.test(arg) ? `${tool} ${arg}` : tool
  }

  return tool
}

// What a finished child printed and how it ended: status is null when a signal or the timeout stopped it.
export type ProcessResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: NodeJS.ErrnoException
}

// spawnSync's answer without blocking the server: other clients keep being served while git, gh or a terminal works.
export function runProcess({
  command,
  args,
  cwd,
  env,
  input,
  timeout,
}: {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeout?: number
}): Promise<ProcessResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false

    const started = performance.now()

    const done = ({
      status,
      error,
    }: Pick<ProcessResult, 'status' | 'error'>) => {
      if (settled) {
        return
      }

      settled = true
      log({
        operation: 'exec',
        name: runName({
          command,
          args,
        }),
        exitCode: status ?? undefined,
        code: error?.code,
        ms: performance.now() - started,
      })
      const result: ProcessResult = {
        status,
        stdout,
        stderr,
      }

      if (error) {
        result.error = error
      }

      resolve(result)
    }

    const child = spawn(
      command,
      args,
      {
        cwd,
        env,
        timeout,
      },
    )
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
    child.on(
      'error',
      error => done({
        status: null,
        error,
      }),
    )
    child.on(
      'close',
      status => done({ status }),
    )
    child.stdin.on(
      'error',
      () => {},
    )
    child.stdin.end(input)
  })
}

// execFile's promise, which rejects on a failed exit, with the same log line as runProcess.
export async function runFile({
  command,
  args,
  options,
}: {
  command: string
  args: string[]
  options: ExecFileOptions
}): Promise<{
  stdout: string
  stderr: string
}> {
  const started = performance.now()
  let exitCode = 0
  let code: string | undefined

  try {
    return await execFileAsync(
      command,
      args,
      {
        ...options,
        encoding: 'utf8',
      },
    )
  } catch (error) {
    // A failed exit carries its status as a number; a child that never started, an error name.
    const reason = error instanceof Error && 'code' in error ? error.code : undefined
    exitCode = typeof reason === 'number' ? reason : 1
    code = typeof reason === 'string' ? reason : undefined

    throw error
  } finally {
    log({
      operation: 'exec',
      name: runName({
        command,
        args,
      }),
      exitCode,
      code,
      ms: performance.now() - started,
    })
  }
}
