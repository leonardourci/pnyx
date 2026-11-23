import { Writable } from 'node:stream'
import { taskTitan } from './task-runtime.ts'
import { workerIdentity } from '#workers/worker-identity.ts'
import { TitanError } from '#store/errors.ts'
import { runCli } from '#cli/run.ts'
import { log } from './diagnostics.ts'
import { DEFAULT_TITAN } from './home-migration.ts'
import { IDENTITY, requestExitCode, requestInvocation, runForClient } from './request-context.ts'

type RunRequest = {
  argv: string[]
  cwd: string
  env: Partial<Record<(typeof IDENTITY)[number], string>>
  stdin?: string
}

export type RunAnswer = {
  stdout: string
  exitCode: number
}

const strings = ({ value }: { value: unknown }) => Array.isArray(value) && value.every(item => typeof item === 'string')

// The Titan a command line runs on, for its log line: the one it names, or the default one; the command parses its own flags.
function namedTitan({
  argv,
  env,
}: Pick<RunRequest, 'argv' | 'env'>): string {
  const inline = argv.find(arg => arg.startsWith('--titan='))

  if (inline) {
    return inline.slice('--titan='.length) || DEFAULT_TITAN
  }

  const flag = argv.indexOf('--titan')

  return (flag < 0 ? env.OTHRYS_TITAN : argv[flag + 1]) || DEFAULT_TITAN
}

function request({ body }: { body: unknown }): RunRequest {
  const given = (body ?? {}) as Partial<Record<keyof RunRequest, unknown>>
  const env = (given.env ?? {}) as Record<string, unknown>

  if (!strings({ value: given.argv }) || typeof given.cwd !== 'string' || !given.cwd.startsWith('/')
    || (given.stdin !== undefined && typeof given.stdin !== 'string')
    || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) {
    throw new TitanError({
      message: 'a run needs argv, an absolute cwd, string identity variables and optional stdin text',
      code: 'VALIDATION_ERROR',
    })
  }

  return {
    argv: given.argv as string[],
    cwd: given.cwd,
    env: Object.fromEntries(IDENTITY.flatMap(name => typeof env[name] === 'string' ? [
      [
        name,
        env[name],
      ],
    ] : [])),
    stdin: given.stdin as string | undefined,
  }
}

export async function runForRequest({ body }: { body: unknown }): Promise<RunAnswer> {
  const {
    argv,
    cwd,
    env,
    stdin,
  } = request({ body })
  const task = workerIdentity({ env })?.task
  const owner = task && taskTitan({ task })

  if (owner) {
    env.OTHRYS_TITAN = owner
  }

  let stdout = ''
  const sink = new Writable({
    // eslint-disable-next-line othrys/object-params -- Node's Writable owns the write signature.
    write(
      chunk,
      _encoding,
      done,
    ) {
      stdout += String(chunk)
      done()
    },
  })

  return runForClient({
    identity: env,
    cwd,
    stdin,
    run: async () => {
      const started = performance.now()
      await runCli({
        argv,
        stdout: sink,
        remote: true,
      })
      const exitCode = requestExitCode() ?? 0

      log({
        operation: 'command.cli',
        name: requestInvocation().name,
        // An unlabelled command line is the owner's terminal, as its events record it.
        actor: env.OTHRYS_ACTOR || 'cli',
        hydraId: namedTitan({
          argv,
          env,
        }),
        taskId: env.OTHRYS_TASK,
        exitCode,
        bytes: Buffer.byteLength(stdout),
        ms: performance.now() - started,
      })

      return {
        stdout,
        exitCode,
      }
    },
  })
}
