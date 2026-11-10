import { Writable } from 'node:stream'
import { HydraError } from '#store/errors.ts'
import { nonblockingLocks } from '#store/storage.ts'
import { runCli } from '#cli/run.ts'
import { log } from './diagnostics.ts'
import { DEFAULT_HYDRA } from './home-migration.ts'
import { IDENTITY, requestExitCode, requestInvocation, runForClient } from './request-context.ts'

export type RunRequest = {
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

// The Hydra a command line runs on, for its log line: the one it names, or the default one; the command parses its own flags.
function namedHydra({
  argv,
  env,
}: Pick<RunRequest, 'argv' | 'env'>): string {
  const inline = argv.find(arg => arg.startsWith('--hydra='))

  if (inline) {
    return inline.slice('--hydra='.length) || DEFAULT_HYDRA
  }

  const flag = argv.indexOf('--hydra')

  return (flag < 0 ? env.PNYX_HYDRA : argv[flag + 1]) || DEFAULT_HYDRA
}

function request({ body }: { body: unknown }): RunRequest {
  const given = (body ?? {}) as Partial<Record<keyof RunRequest, unknown>>
  const env = (given.env ?? {}) as Record<string, unknown>

  if (!strings({ value: given.argv }) || typeof given.cwd !== 'string' || !given.cwd.startsWith('/')
    || (given.stdin !== undefined && typeof given.stdin !== 'string')
    || typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string')) {
    throw new HydraError({
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

// Runs a pnyx-axi command line for a client, in the client's identity and folder, and answers with exactly what it printed.
export async function runForRequest({ body }: { body: unknown }): Promise<RunAnswer> {
  const {
    argv,
    cwd,
    env,
    stdin,
  } = request({ body })
  let stdout = ''
  const sink = new Writable({
    // eslint-disable-next-line pnyx/object-params -- Node's Writable owns the write signature.
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
      const before = process.exitCode
      // Inside the server a held lock is refused at once, never waited on with the event loop blocked.
      await nonblockingLocks.run(
        true,
        () => runCli({
          argv,
          stdout: sink,
        }),
      )
      // The SDK also sets the process exit code for a refused command line; the server keeps its own, and the
      // request's status comes only from its own record.
      process.exitCode = before
      const exitCode = requestExitCode() ?? 0

      log({
        operation: 'command.cli',
        name: requestInvocation().name,
        // An unlabelled command line is the owner's terminal, as its events record it.
        actor: env.PNYX_ACTOR || 'cli',
        hydraId: namedHydra({
          argv,
          env,
        }),
        taskId: env.PNYX_TASK,
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
