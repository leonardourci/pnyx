import { AsyncLocalStorage } from 'node:async_hooks'
import { HYDRA_ACTOR } from './actors.ts'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Who asked and from where, for a command the server runs for a client; a CLI run outside the server uses its own process.
type Request = {
  env: NodeJS.ProcessEnv
  cwd: string
  stdin?: string
  // The command being run (`task create`) and its focused help, for usage errors.
  invocation: {
    name?: string
    help?: string
  }
  exitCode?: number
}

const current = new AsyncLocalStorage<Request>()
const ownProcess: Pick<Request, 'invocation'> = { invocation: {} }

export const requestInvocation = (): Request['invocation'] => (current.getStore() ?? ownProcess).invocation

// What the formatted error asked the exit code to be, for a command run for a client.
export const recordExitCode = ({ code }: { code: number }) => {
  const request = current.getStore()

  if (request) {
    request.exitCode = code
  } else {
    process.exitCode = code
  }
}

export const requestExitCode = () => current.getStore()?.exitCode

// The variables a client sends with each command: who it is, and the terminal or task it runs in.
export const IDENTITY = [
  'PNYX_ACTOR',
  'PNYX_TASK',
  'PNYX_HYDRA',
  'PNYX_STEERING_WORKER',
  'PNYX_HOSTED',
  'TMUX_PANE',
  'HERDR_PANE_ID',
  'PASEO_TERMINAL_ID',
] as const

export const requestEnv = (): NodeJS.ProcessEnv => current.getStore()?.env ?? process.env

export const hydraActor = ({ actor }: { actor?: string }) =>
  actor === HYDRA_ACTOR || requestEnv().PNYX_ACTOR === HYDRA_ACTOR

export const requestCwd = (): string => current.getStore()?.cwd ?? process.cwd()

export function runForClient<T>({
  identity,
  cwd,
  stdin,
  run,
}: {
  identity: Partial<Record<(typeof IDENTITY)[number], string>>
  cwd: string
  stdin?: string
  run(): T
}): T {
  const env: NodeJS.ProcessEnv = { ...process.env }

  for (const name of IDENTITY) {
    delete env[name]

    if (typeof identity[name] === 'string') {
      env[name] = identity[name]
    }
  }

  return current.run(
    {
      env,
      cwd,
      stdin,
      invocation: {},
    },
    run,
  )
}

// A command's --file: `-` is the client's stdin, and a relative path is the client's.
export function readInput({ file }: { file: string }): string {
  if (file === '-') {
    const request = current.getStore()

    return request ? request.stdin ?? '' : readFileSync(
      0,
      'utf8',
    )
  }

  return readFileSync(
    isAbsolute(file) ? file : join(
      requestCwd(),
      file,
    ),
    'utf8',
  )
}
