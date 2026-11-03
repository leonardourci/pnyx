import { spawn } from 'node:child_process'

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

    const done = ({
      status,
      error,
    }: Pick<ProcessResult, 'status' | 'error'>) => {
      if (settled) {
        return
      }

      settled = true
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
